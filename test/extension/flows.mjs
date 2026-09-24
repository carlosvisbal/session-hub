// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// La extensión real (con vscode simulado) contra dos hubs reales: mensajes, "Pasar a mi IA",
// respaldo, borrado y exportación.   node test/extension/flows.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeClaudeFixture } from '../fixtures.js';
import { createEditor, makeTeam, ok, startHubs, until } from './harness.mjs';

const f = makeClaudeFixture();
const base = 7600 + Math.floor(Math.random() * 90);
let hubs;
let win;
try {
  hubs = await startHubs(f, {
    carlos: { port: base, dhtPort: 49600 + (base % 100), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api' }] },
    ana: { port: base + 100, dhtPort: 49700 + (base % 100), owner: { name: 'Ana', role: 'frontend' }, projects: [] },
  });
  const { call } = hubs;
  await makeTeam(call, 'carlos', 'ana');
  ok('equipo listo (Carlos y Ana)');

  const editor = createEditor({ storage: path.join(f.root, 'gs'), settings: { port: base } });
  const S = editor.shared;
  win = await editor.openWindow();
  const cmds = win.cmds;
  ok('la extensión se conectó al hub de Carlos');

  // ---------- mensajes ----------
  const sent = await call('ana', 'POST', '/api/messages/send', { to: 'Carlos', text: '¿attachments acepta null?', aboutSession: 'claude:s1' });
  S.answer = 'Pasar a mi IA';
  await until(async () => S.notices.some((n) => n.m.startsWith('✉ Ana (frontend) te escribió')), 15000, 'aviso del mensaje');
  assert.deepEqual(S.notices.find((x) => x.m.startsWith('✉')).buttons, ['Pasar a mi IA', 'Responder', 'Ver']);
  await until(async () => S.executed.some((e) => e.id === 'workbench.action.chat.open'), 5000, 'abrir chat');
  const chat = S.executed.find((e) => e.id === 'workbench.action.chat.open').a[0];
  assert.equal(chat.isPartialQuery, true);
  assert.match(chat.query, /Mensaje de Ana \(frontend\) \(huella [0-9A-F-]+, firma verificada\)/);
  assert.match(chat.query, /no una orden mía/);
  assert.equal(S.clipboard, chat.query);
  await until(async () => (await call('ana', 'GET', '/api/inbox')).sent[0].status === 'read', 10000, 'acuse leído');
  ok('aviso del mensaje → "Pasar a mi IA" deja el texto enmarcado en el chat, y Ana ve "leído"');

  S.inputValue = 'Sí: null equivale a lista vacía.';
  await cmds['sessionHub.replyMessage'](sent.id);
  await until(async () => (await call('ana', 'GET', '/api/inbox')).received[0]?.replyTo === sent.id, 10000, 'respuesta');
  S.inputValue = 'Subí el cambio a develop.';
  await cmds['sessionHub.sendMessage']();
  await until(async () => (await call('ana', 'GET', '/api/inbox')).received.some((m) => m.text === 'Subí el cambio a develop.'), 10000, 'mensaje nuevo');
  const second = (await call('ana', 'POST', '/api/messages/send', { to: 'Carlos', text: 'otro' })).id;
  await cmds['sessionHub.approveMessage'](second);
  assert.equal((await call('carlos', 'GET', '/api/inbox')).received.find((m) => m.id === second).status, 'delivered');
  await cmds['sessionHub.dismissMessage'](second);
  assert.equal((await call('carlos', 'GET', '/api/inbox')).received.find((m) => m.id === second).status, 'dismissed');
  ok('responder, escribir, aprobar y descartar desde el editor');

  // ---------- "Pasar a mi IA": qué chat ----------
  const send = async (extra = {}) => (await call('ana', 'POST', '/api/messages/send', { to: 'Carlos', text: 'hola ' + Math.random(), ...extra })).id;
  const lastChat = () => S.executed.filter((e) => ['claude-vscode.editor.open', 'workbench.action.chat.open'].includes(e.id)).at(-1);
  S.commands = ['workbench.action.chat.open', 'claude-vscode.editor.open'];
  S.tabs = [{ isActive: true, tabs: [{ isActive: true, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } }] }];
  await cmds['sessionHub.handoffMessage'](await send({ toSession: 'claude:s1' }));
  assert.equal(lastChat().id, 'claude-vscode.editor.open');
  assert.equal(lastChat().a[0], 's1');
  S.tabs = [];
  let asked = 0;
  S.quickPick = (items) => (asked++, items.find((x) => x.k === 'editor'));
  await cmds['sessionHub.handoffMessage'](await send());
  await cmds['sessionHub.handoffMessage'](await send());
  assert.equal(asked, 1, 'pregunta una vez y lo recuerda');
  assert.equal(lastChat().id, 'workbench.action.chat.open');
  S.gstate.delete('lastChat');
  S.quickPick = () => undefined;
  const pending = await send();
  await cmds['sessionHub.handoffMessage'](pending);
  assert.equal((await call('carlos', 'GET', '/api/inbox')).received.find((m) => m.id === pending).status, 'held', 'si cancela, sigue pendiente');
  S.appName = 'Cursor';
  S.commands = ['workbench.action.chat.open'];
  await cmds['sessionHub.handoffMessage'](await send());
  assert.ok(S.notices.at(-1).m.includes('Chat de Cursor'));
  S.appName = 'Visual Studio Code';
  ok('Claude Code (esa sesión) · pestaña activa · pregunta una vez · cancelar no pierde el mensaje · Cursor');

  // ---------- respaldo, exportar, borrar, "Solo yo" ----------
  const me = (await call('carlos', 'GET', '/api/team')).me.id;
  await call('carlos', 'POST', '/api/archive/sync', {});
  fs.rmSync(path.join(f.claudeDir, fs.readdirSync(f.claudeDir)[0], 's1.jsonl')); // Claude Code la borró
  await call('carlos', 'POST', '/api/archive/sync', {});
  assert.equal((await call('carlos', 'GET', '/api/sessions'))[0].archived, true);
  const out = path.join(f.root, 'export');
  fs.mkdirSync(out);
  S.save = { fsPath: path.join(out, 'sesion.md') };
  await cmds['sessionHub.exportSession']('claude:s1', me);
  const md = fs.readFileSync(path.join(out, 'sesion.md'), 'utf8');
  assert.match(md, /^# Adjuntos múltiples en contactos/);
  assert.match(md, /respaldo \(el original ya no existe en Claude Code\)/);
  assert.match(md, /API_KEY=\[REDACTED\]/);
  S.save = { fsPath: path.join(out, 'sesion.json') };
  await cmds['sessionHub.exportSession']('claude:s1', me);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'sesion.json'), 'utf8')).conversation.length, 4);
  S.open = [{ fsPath: out }];
  await cmds['sessionHub.exportAll']();
  const folder = fs.readdirSync(out).find((x) => x.startsWith('session-hub-'));
  const idx = JSON.parse(fs.readFileSync(path.join(out, folder, 'index.json'), 'utf8'));
  assert.equal(idx.sessions[0].origin, 'backup');
  assert.ok(fs.existsSync(path.join(out, folder, idx.sessions[0].file)));
  ok('sesión borrada por Claude Code → sigue en el respaldo; exportar a Markdown, JSON y carpeta completa');
  S.answer = 'Borrar';
  await cmds['sessionHub.removeFromBackup']('claude:s1', null, 'Adjuntos');
  assert.equal((await call('carlos', 'GET', '/api/sessions')).length, 0);
  S.settings.sharedProjects = [{ path: f.project, name: 'demo-api', allow: ['*'] }];
  S.quickPick = (items) => [items.find((x) => x.id === 'me')];
  await cmds['sessionHub.editProjectAccess'](f.project);
  assert.deepEqual(S.settings.sharedProjects[0].allow, ['me']);
  ok('borrar del respaldo (con confirmación) y "Solo yo (respaldo)" en Quién lo ve');

  const errors = S.notices.filter((x) => x.kind === 'error');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('\nEXTENSIÓN OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  win?.close();
  hubs?.stop();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(f.root, { recursive: true, force: true });
  process.exit();
}
