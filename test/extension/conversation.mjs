// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Conversaciones automáticas desde la extensión real (vscode simulado) con dos hubs reales:
// instalar/quitar hooks sin pisar lo que ya hay, invitar, aceptar, confirmar lo pedido por la IA y detener.
//   node test/extension/conversation.mjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeClaudeFixture } from '../fixtures.js';
import { createEditor, makeTeam, ok, startHubs, tmpdir, until } from './harness.mjs';

const home = tmpdir('shub-home-');
process.env.HOME = home; // ~/.claude y ~/.cursor de prueba (nunca los reales)
const claudeSettings = path.join(home, '.claude', 'settings.json');
const cursorHooks = path.join(home, '.cursor', 'hooks.json');
fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
fs.mkdirSync(path.dirname(cursorHooks), { recursive: true });
const mineClaude = { model: 'opus', permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mio' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] } };
const mineCursor = { version: 1, hooks: { stop: [{ command: './hooks/mio.sh' }], afterFileEdit: [{ command: './hooks/format.sh' }] } };
fs.writeFileSync(claudeSettings, JSON.stringify(mineClaude, null, 2));
fs.writeFileSync(cursorHooks, JSON.stringify(mineCursor, null, 2));

const f = makeClaudeFixture();
const base = 7500 + Math.floor(Math.random() * 90);
let hubs;
let win;
try {
  hubs = await startHubs(f, {
    carlos: { port: base, dhtPort: 49500 + (base % 100), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api' }] },
    ana: { port: base + 100, dhtPort: 49400 + (base % 100), owner: { name: 'Ana', role: 'frontend' }, projects: [] },
  });
  const { call } = hubs;
  await makeTeam(call, 'carlos', 'ana');
  await until(async () => (await call('carlos', 'GET', '/api/peers')).find((m) => m.name === 'Ana')?.online, 15000, 'Ana en línea');
  const editor = createEditor({ appName: 'Cursor', storage: path.join(f.root, 'gs'), settings: { port: base } });
  const S = editor.shared;
  win = await editor.openWindow();
  const cmds = win.cmds;
  ok('equipo listo y extensión conectada');

  // ---------- instalar hooks sin pisar lo que ya hay ----------
  fs.writeFileSync(claudeSettings, '{ esto no es json');
  S.answer = 'Instalar';
  await cmds['sessionHub.installHooks']();
  assert.equal(fs.readFileSync(claudeSettings, 'utf8'), '{ esto no es json', 'un archivo ilegible no se toca');
  assert.ok(S.notices.some((n) => n.kind === 'error' && /No modifiqué/.test(n.m)));
  S.notices.length = 0;
  fs.writeFileSync(claudeSettings, JSON.stringify(mineClaude, null, 2));
  S.answer = 'Instalar';
  await cmds['sessionHub.installHooks']();
  const c1 = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
  assert.equal(c1.model, 'opus');
  assert.deepEqual(c1.permissions, mineClaude.permissions);
  assert.deepEqual(c1.hooks.PreToolUse, mineClaude.hooks.PreToolUse);
  assert.equal(c1.hooks.Stop.length, 2, 'tu hook Stop se conserva y se agrega el de Session Hub');
  const ours = c1.hooks.Stop[1].hooks[0];
  assert.match(ours.command, /session-hub-hook\.cjs/);
  assert.equal(ours.timeout, 150);
  const k1 = JSON.parse(fs.readFileSync(cursorHooks, 'utf8'));
  assert.deepEqual(k1.hooks.afterFileEdit, mineCursor.hooks.afterFileEdit);
  assert.equal(k1.hooks.stop.length, 2);
  assert.equal(k1.hooks.stop[1].loop_limit, 50);
  assert.ok(fs.existsSync(`${claudeSettings}.session-hub.bak`) && fs.existsSync(`${cursorHooks}.session-hub.bak`), 'copia del original');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.session-hub', 'hook.json'), 'utf8'));
  assert.deepEqual(cfg, { port: base, token: 't' });
  // el comando instalado se ejecuta de verdad y, sin conversación, no hace nada
  const out = execSync(ours.command, { input: JSON.stringify({ session_id: 'nada', hook_event_name: 'Stop' }), shell: true, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(out, '{}');
  S.answer = 'Instalar';
  await cmds['sessionHub.installHooks']();
  assert.equal(JSON.parse(fs.readFileSync(claudeSettings, 'utf8')).hooks.Stop.length, 2, 'instalar dos veces no duplica');
  ok('hooks instalados en Claude Code y Cursor sin pisar tus ajustes ni tus hooks; el comando instalado funciona');

  // ---------- Carlos invita a Ana desde el editor ----------
  const anaId = (await call('carlos', 'GET', '/api/peers')).find((m) => m.name === 'Ana').id;
  S.quickPick = (items) => items[0];
  S.inputValue = '¿Cómo envía el formulario los adjuntos?';
  await cmds['sessionHub.startConversation'](anaId);
  await until(async () => (await call('ana', 'GET', '/api/conv')).some((c) => c.status === 'invited'), 10000, 'invitación en Ana');
  const conv1 = (await call('ana', 'GET', '/api/conv')).find((c) => c.status === 'invited');
  assert.equal(conv1.turns, 6);
  assert.equal(conv1.minutes, 10);
  await call('ana', 'POST', '/api/conv/accept', { id: conv1.id, mine: 'cursor:a1' });
  await until(async () => S.notices.some((n) => /Conversación automática con Ana en marcha/.test(n.m)), 20000, 'aviso "en marcha"');
  ok('invitar desde el editor (6 vueltas, 10 min) → Ana acepta → aviso "en marcha"');

  // ---------- Ana invita a Carlos: aviso con Aceptar ----------
  S.answer = 'Aceptar';
  await call('ana', 'POST', '/api/conv/start', { to: 'Carlos', text: 'Revisemos el contrato del endpoint', mine: 'cursor:a2' });
  await until(async () => (await call('ana', 'GET', '/api/conv')).some((c) => c.text === 'Revisemos el contrato del endpoint' && c.status === 'active'), 25000, 'aceptada desde el aviso');
  assert.ok(S.notices.some((n) => /Ana quiere que sus IA conversen solas/.test(n.m) && n.buttons.includes('Aceptar')));
  ok('aviso "🤝 Ana quiere que sus IA conversen solas" → Aceptar → activa en los dos');

  // ---------- pedida por la IA (MCP): se confirma en el editor ----------
  S.answer = 'Confirmar';
  const res = await fetch(`http://127.0.0.1:${base}/mcp?token=t`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_conversation', arguments: { to: 'Ana', text: 'Coordinemos la migración' } } }) });
  const viaAi = JSON.parse((await res.json()).result.content[0].text);
  await until(async () => (await call('ana', 'GET', '/api/conv')).some((c) => c.id === viaAi.id), 25000, 'invitación confirmada');
  assert.ok(S.notices.some((n) => /Tu IA quiere iniciar una conversación automática con Ana/.test(n.m)));
  ok('start_conversation por MCP → el editor pide confirmar → recién entonces sale la invitación');

  // ---------- detener ----------
  S.answer = 'Terminar';
  await cmds['sessionHub.endConversation'](conv1.id);
  await until(async () => (await call('ana', 'GET', '/api/conv')).find((c) => c.id === conv1.id).status === 'ended', 10000, 'terminada en Ana');
  ok('detener desde el editor la termina para los dos');

  // ---------- quitar hooks ----------
  S.answer = 'Quitar';
  await cmds['sessionHub.removeHooks']();
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeSettings, 'utf8')).hooks, mineClaude.hooks, 'quedan exactamente tus hooks de Claude Code');
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorHooks, 'utf8')).hooks, mineCursor.hooks, 'y los de Cursor');
  assert.ok(!fs.existsSync(path.join(home, '.session-hub', 'hook.json')));
  ok('quitar hooks deja tus archivos como estaban');

  const errors = S.notices.filter((x) => x.kind === 'error' && !/No modifiqué/.test(x.m));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('\nCONVERSACIONES (EXTENSIÓN) OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  win?.close();
  hubs?.stop();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(f.root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  process.exit();
}
