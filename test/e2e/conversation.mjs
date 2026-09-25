// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Conversación automática de extremo a extremo: dos hubs reales y el hook real (session-hub-hook),
// alimentado con los mismos datos que le pasan Claude Code (Stop) y Cursor (stop).
//   node test/e2e/conversation.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeFixture } from '../fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'extension', 'hook', 'session-hub-hook.cjs');
const f = makeClaudeFixture();
const base = 8200 + Math.floor(Math.random() * 90);
const people = {
  carlos: { port: base, dhtPort: 50200 + (base % 100), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api' }] },
  ana: { port: base + 100, dhtPort: 50300 + (base % 100), owner: { name: 'Ana', role: 'frontend' }, projects: [] },
};
const procs = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (who, method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${people[who].port}${route}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};
const mcp = async (who, name, args = {}) => {
  const res = await fetch(`http://127.0.0.1:${people[who].port}/mcp?token=t`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  if (data.error || data.result?.isError) throw new Error(JSON.stringify(data.error || data.result.content));
  return JSON.parse(data.result.content[0].text);
};
async function until(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(300)) if (await fn().catch(() => false)) return;
  throw new Error(`No se cumplió a tiempo: ${what}`);
}
const step = (m) => console.log('✔', m);

// El hook real, con lo que le mandaría cada herramienta por stdin.
function runHook(who, input, budget = 30000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, SESSION_HUB_HOOK_CONFIG: path.join(f.root, who, 'hook.json'), SESSION_HUB_HOOK_BUDGET_MS: String(budget) } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(JSON.parse(out || '{}')));
    p.stdin.end(JSON.stringify(input));
  });
}
const claudeStop = (id) => ({ session_id: id, transcript_path: '/tmp/x.jsonl', cwd: f.project, hook_event_name: 'Stop', stop_hook_active: false });
const cursorStop = (id, loop = 0) => ({ conversation_id: id, generation_id: 'g' + loop, status: 'completed', loop_count: loop, hook_event_name: 'stop', workspace_roots: [f.project] });

try {
  for (const [who, p] of Object.entries(people)) {
    const dir = path.join(f.root, who);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...p, localToken: 't', network: 'lan', language: 'es', claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir }));
    fs.writeFileSync(path.join(dir, 'hook.json'), JSON.stringify({ port: p.port, token: 't' }));
    procs.push(spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: path.join(dir, 'config.json') }, stdio: 'ignore' }));
  }
  await until(async () => (await call('carlos', 'GET', '/health')).ok && (await call('ana', 'GET', '/health')).ok, 15000, 'hubs');
  await call('carlos', 'POST', '/api/team/create', { name: 'e2e' });
  await call('ana', 'POST', '/api/team/join', { code: (await call('carlos', 'POST', '/api/team/invite', {})).code });
  await until(async () => !(await call('ana', 'GET', '/api/team')).team.pending, 30000, 'admisión');
  await until(async () => (await call('carlos', 'GET', '/api/peers')).find((m) => m.name === 'Ana')?.online, 15000, 'Ana en línea');
  step('equipo listo');

  // Sin conversación, el hook no hace nada (y no espera).
  let t0 = Date.now();
  assert.deepEqual(await runHook('carlos', claudeStop('c1')), {});
  assert.ok(Date.now() - t0 < 5000);
  step('sin conversación activa el hook responde vacío al instante (el agente se detiene como siempre)');

  // Carlos (Claude Code, sesión c1) invita a Ana (Cursor, conversación a1): 3 vueltas.
  const conv = await call('carlos', 'POST', '/api/conv/start', { to: 'Ana', text: '¿Cómo envía el formulario los adjuntos?', mine: 'claude:c1', theirs: 'cursor:a1', turns: 3, minutes: 5 });
  await until(async () => (await call('ana', 'GET', '/api/conv'))[0]?.status === 'invited', 10000, 'invitación');
  assert.deepEqual(await runHook('ana', cursorStop('a1')), {}, 'invitada pero sin aceptar: nada llega solo');
  await call('ana', 'POST', '/api/conv/accept', { id: conv.id, mine: 'cursor:a1' });
  await until(async () => (await call('carlos', 'GET', '/api/conv'))[0]?.status === 'active', 10000, 'aceptada');
  step('invitación firmada → Ana la acepta → activa en los dos lados');

  // El primer mensaje de Carlos llega solo a la sesión de Ana: su hook de Cursor se lo pasa al agente.
  await until(async () => (await call('ana', 'GET', '/api/inbox')).received.some((m) => m.conv === conv.id && m.status === 'delivered'), 10000, 'primer mensaje');
  const a1 = await runHook('ana', cursorStop('a1', 1));
  assert.match(a1.followup_message, /Conversación automática con Carlos · vuelta 1 de 3/);
  assert.match(a1.followup_message, /¿Cómo envía el formulario los adjuntos\?/);
  assert.match(a1.followup_message, /send_message/);
  assert.equal(a1.decision, 'block', 'también en el formato de Claude Code');
  step('hook de Cursor (stop) → followup_message con la pregunta de Carlos, enmarcada');

  // Carlos terminó su turno y espera: su hook de Claude Code queda esperando la respuesta de Ana.
  const carlosWaiting = runHook('carlos', claudeStop('c1'));
  await wait(1500);
  const busy = await runHook('carlos', claudeStop('c1'), 5000);
  assert.deepEqual(busy, {}, 'una segunda copia del hook sale al instante (una sola espera por conversación)');
  const sent = await mcp('ana', 'send_message', { to: 'Carlos', text: 'Con FormData: un campo attachments por archivo.' });
  assert.equal(sent.conversation.turn, 1);
  const c1 = await carlosWaiting;
  assert.match(c1.reason, /Con FormData/);
  assert.match(c1.reason, /vuelta 1 de 3/);
  step('hook de Claude Code (Stop) esperó y entregó la respuesta de Ana (decision: block) — sin que nadie pulse Enviar');

  // Siguen solos hasta el límite de 3 vueltas.
  for (let i = 2; i <= 3; i++) {
    const anaWaits = runHook('ana', cursorStop('a1', i));
    await mcp('carlos', 'send_message', { to: 'Ana', text: `Pregunta ${i} de Carlos` });
    assert.match((await anaWaits).followup_message, new RegExp(`Pregunta ${i} de Carlos`));
    const carlosWaits = runHook('carlos', claudeStop('c1'));
    await mcp('ana', 'send_message', { to: 'Carlos', text: `Respuesta ${i} de Ana` });
    const r = (await carlosWaits).reason;
    assert.match(r, new RegExp(`Respuesta ${i} de Ana`));
    if (i === 3) assert.match(r, /última vuelta/);
  }
  step('vueltas 2 y 3 automáticas en los dos sentidos; la última avisa que cierra');
  const extra = await mcp('carlos', 'send_message', { to: 'Ana', text: 'Una más fuera de límite' });
  assert.equal(extra.conversation, undefined, 'fuera del límite ya no es parte de la conversación');
  await until(async () => (await call('ana', 'GET', '/api/conv'))[0].status === 'ended', 10000, 'fin en Ana');
  assert.equal((await call('carlos', 'GET', '/api/conv'))[0].endReason, 'limit');
  assert.equal((await call('ana', 'GET', '/api/inbox')).received.find((m) => m.text === 'Una más fuera de límite').status, 'held', 'lo que sigue vuelve a retenerse');
  assert.deepEqual(await runHook('ana', cursorStop('a1', 9)), {});
  step('al pasar el límite termina para los dos; los mensajes siguientes vuelven a quedar retenidos');

  // Detector de bucles: el mismo mensaje dos veces seguidas corta la conversación.
  const conv2 = await call('ana', 'POST', '/api/conv/start', { to: 'Carlos', text: 'Hola', mine: 'cursor:a2', theirs: 'claude:c2', turns: 6 });
  await until(async () => (await call('carlos', 'GET', '/api/conv')).find((c) => c.id === conv2.id)?.status === 'invited', 10000, 'invitación 2');
  await call('carlos', 'POST', '/api/conv/accept', { id: conv2.id, mine: 'claude:c2' });
  await until(async () => (await call('carlos', 'GET', '/api/inbox')).received.some((m) => m.conv === conv2.id), 10000, 'primer mensaje 2');
  await mcp('carlos', 'send_message', { to: 'Ana', text: 'ok' });
  await mcp('carlos', 'send_message', { to: 'Ana', text: 'ok' });
  await until(async () => (await call('ana', 'GET', '/api/conv')).find((c) => c.id === conv2.id).status === 'ended', 10000, 'fin por bucle');
  assert.equal((await call('carlos', 'GET', '/api/conv')).find((c) => c.id === conv2.id).endReason, 'loop');
  step('detector de bucles: el mismo mensaje repetido termina la conversación');

  // Rechazar y terminar a mano.
  const conv3 = await call('carlos', 'POST', '/api/conv/start', { to: 'Ana', text: '¿Conversamos?', mine: 'claude:c3' });
  await until(async () => (await call('ana', 'GET', '/api/conv')).find((c) => c.id === conv3.id), 10000, 'invitación 3');
  await call('ana', 'POST', '/api/conv/decline', { id: conv3.id });
  await until(async () => (await call('carlos', 'GET', '/api/conv')).find((c) => c.id === conv3.id).endReason === 'declined', 10000, 'rechazo');
  const conv4 = await call('carlos', 'POST', '/api/conv/start', { to: 'Ana', text: 'Otra', mine: 'claude:c4' });
  await until(async () => (await call('ana', 'GET', '/api/conv')).find((c) => c.id === conv4.id), 10000, 'invitación 4');
  await call('ana', 'POST', '/api/conv/accept', { id: conv4.id, mine: 'cursor:a4' });
  await until(async () => (await call('carlos', 'GET', '/api/conv')).find((c) => c.id === conv4.id).status === 'active', 10000, 'activa 4');
  await call('carlos', 'POST', '/api/conv/end', { id: conv4.id });
  await until(async () => (await call('ana', 'GET', '/api/conv')).find((c) => c.id === conv4.id).status === 'ended', 10000, 'terminada 4');
  step('rechazar una invitación y terminar una conversación: se entera el otro lado');

  // Pedida por la IA (MCP): no sale hasta que la persona la confirma.
  const viaAi = await mcp('carlos', 'start_conversation', { to: 'Ana', text: 'Coordinemos el endpoint' });
  assert.match(viaAi.estado, /confirmarla/);
  await wait(1500);
  assert.ok(!(await call('ana', 'GET', '/api/conv')).some((c) => c.id === viaAi.id), 'sin confirmar, Ana no recibe nada');
  await call('carlos', 'POST', '/api/conv/confirm', { id: viaAi.id });
  await until(async () => (await call('ana', 'GET', '/api/conv')).some((c) => c.id === viaAi.id), 10000, 'invitación confirmada');
  step('start_conversation por MCP: la invitación solo sale cuando la persona la confirma');

  // Hub apagado o mal configurado: el hook no cuelga al agente.
  fs.writeFileSync(path.join(f.root, 'carlos', 'hook.json'), JSON.stringify({ port: 1, token: 'x' }));
  t0 = Date.now();
  assert.deepEqual(await runHook('carlos', claudeStop('c1')), {});
  assert.ok(Date.now() - t0 < 8000);
  step('con el hub apagado el hook responde vacío enseguida: nunca cuelga al agente');
  console.log('\nE2E CONVERSACIÓN OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill('SIGTERM');
  await wait(500);
  fs.rmSync(f.root, { recursive: true, force: true });
}
