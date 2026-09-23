// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Extremo a extremo: dos hubs reales en esta máquina (modo lan).
// Carlos crea el equipo, invita a Ana, y Ana lee la sesión de Carlos completa por el canal cifrado.
//   npm run test:e2e
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeFixture } from '../fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const f = makeClaudeFixture();
const base = 7800 + Math.floor(Math.random() * 100);
const people = {
  carlos: { port: base, dhtPort: 49800 + (base % 100), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api' }] },
  ana: { port: base + 100, dhtPort: 49900 + (base % 100), owner: { name: 'Ana', role: 'frontend' }, projects: [] },
};
const procs = {};
const startHub = (who) => {
  const dir = path.join(f.root, who);
  procs[who] = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: path.join(dir, 'config.json') }, stdio: 'ignore' });
};
// Llamada MCP como la haría la IA (JSON-RPC por HTTP).
const mcp = async (who, name, args = {}) => {
  const res = await fetch(`http://127.0.0.1:${people[who].port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data.error || data.result?.isError) throw new Error(JSON.stringify(data.error || data.result.content));
  return JSON.parse(data.result.content[0].text);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (who, method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${people[who].port}${route}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};
async function until(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(500)) if (await fn().catch(() => false)) return;
  throw new Error(`No se cumplió a tiempo: ${what}`);
}
const step = (m) => console.log('✔', m);

try {
  for (const [who, p] of Object.entries(people)) {
    const dir = path.join(f.root, who);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...p, localToken: 't', network: 'lan', claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir }));
    startHub(who);
  }
  await until(async () => (await call('carlos', 'GET', '/health')).ok && (await call('ana', 'GET', '/health')).ok, 15000, 'hubs arriba');
  step('dos hubs arriba');

  await call('carlos', 'POST', '/api/team/create', { name: 'e2e' });
  const { code } = await call('carlos', 'POST', '/api/team/invite', {});
  await call('ana', 'POST', '/api/team/join', { code });
  await until(async () => !(await call('ana', 'GET', '/api/team')).team.pending, 30000, 'admisión de Ana');
  step('Ana admitida por Carlos');

  const carlos = (await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos');
  assert.ok(carlos?.online, 'Ana ve a Carlos en línea');
  const local = await call('carlos', 'GET', '/api/sessions/claude%3As1?full=1');
  const remote = await call('ana', 'GET', `/api/sessions/claude%3As1?peer=${carlos.id}&full=1`);
  assert.deepEqual(remote.conversation, local.conversation);
  assert.equal(remote.conversation.length, local.total);
  step(`lectura completa por el canal cifrado: ${remote.conversation.length}/${local.total} mensajes, idéntica`);

  const audit = await call('carlos', 'GET', '/api/access');
  assert.ok(audit.reads.some((r) => r.what === 'session' && r.who === 'Ana'));
  step('la lectura de Ana quedó en la auditoría de Carlos');

  // Sesión de Claude Code "abierta" en el proyecto de Carlos (el pid de esta prueba está vivo).
  const liveDir = path.join(f.root, 'sessions');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: f.project, name: 'demo-api-1', status: 'busy' }));
  const agents = await mcp('ana', 'list_agents', { peer: 'Carlos' });
  assert.equal(agents[0]?.session, 'claude:s1');
  assert.equal(agents[0].status, 'busy');
  step(`Ana (por MCP) ve la sesión abierta de Carlos: ${agents[0].tool} · ${agents[0].project} · ocupada`);

  const sent = await mcp('ana', 'send_message', { to: 'Carlos', text: '¿attachments acepta también null?', to_session: 'claude:s1' });
  assert.equal(sent.status, 'held');
  let box = await call('carlos', 'GET', '/api/inbox');
  assert.equal(box.held, 1);
  assert.equal(box.received[0].fromName, 'Ana');
  assert.equal((await mcp('carlos', 'check_inbox')).mensajes.length, 0, 'retenido: la IA de Carlos aún no lo ve');
  step('mensaje firmado de Ana → bandeja de Carlos, retenido hasta aprobarlo');

  await call('carlos', 'POST', '/api/inbox/approve', { id: sent.id });
  await until(async () => (await call('ana', 'GET', '/api/inbox')).sent[0].status === 'delivered', 10000, 'acuse "entregado"');
  const forAi = await mcp('carlos', 'check_inbox');
  assert.equal(forAi.mensajes[0].texto, '¿attachments acepta también null?');
  assert.equal(forAi.mensajes[0].para_sesion, 'claude:s1');
  await until(async () => (await call('ana', 'GET', '/api/inbox')).sent[0].status === 'read', 10000, 'acuse "leído"');
  step('Carlos lo aprueba, su IA lo lee con check_inbox y Ana ve "leído"');

  const reply = await mcp('carlos', 'send_message', { reply_to: sent.id, text: 'Sí, null equivale a lista vacía.' });
  assert.equal(reply.to, 'Ana (frontend)');
  await until(async () => (await call('ana', 'GET', '/api/inbox')).received[0]?.replyTo === sent.id, 10000, 'respuesta en la bandeja de Ana');
  step('la respuesta de Carlos llega a Ana enlazada al mensaje original');

  procs.ana.kill('SIGTERM');
  await until(async () => !(await call('carlos', 'GET', '/api/peers')).find((m) => m.name === 'Ana').online, 15000, 'Ana desconectada');
  const queued = await call('carlos', 'POST', '/api/messages/send', { to: 'Ana', text: 'Te dejo esto para cuando vuelvas.' });
  assert.equal(queued.status, 'queued');
  startHub('ana');
  await until(async () => (await call('ana', 'GET', '/api/inbox')).received.some((m) => m.id === queued.id), 45000, 'entrega de la cola al reconectar');
  step('con Ana desconectada el mensaje queda en cola y se entrega al volver');
  console.log('\nE2E OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  for (const p of Object.values(procs)) p.kill('SIGTERM');
  await wait(500);
  fs.rmSync(f.root, { recursive: true, force: true });
}
