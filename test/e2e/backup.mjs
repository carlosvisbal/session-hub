// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Extremo a extremo del respaldo, con dos hubs reales (modo lan):
//   capa 1 — Carlos conserva sus sesiones aunque Claude Code las borre;
//   capa 2 — Ana guarda copia de las de Carlos, al día y solo mientras tenga acceso.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeFixture } from '../fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const f = makeClaudeFixture();
const base = 8000 + Math.floor(Math.random() * 100);
const people = {
  carlos: { port: base, dhtPort: 50000 + (base % 100), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api' }] },
  ana: { port: base + 100, dhtPort: 50100 + (base % 100), owner: { name: 'Ana', role: 'frontend' }, projects: [] },
};
const procs = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cfgFile = (who) => path.join(f.root, who, 'config.json');
const writeCfg = (who, extra = {}) => fs.writeFileSync(cfgFile(who), JSON.stringify({ ...people[who], localToken: 't', network: 'lan', claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir, ...extra }));
const start = (who) => (procs[who] = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: cfgFile(who) }, stdio: 'ignore' }));
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
  for (const end = Date.now() + ms; Date.now() < end; await wait(500)) if (await fn().catch(() => false)) return;
  throw new Error(`No se cumplió a tiempo: ${what}`);
}
const step = (m) => console.log('✔', m);
const copiesOf = async () => (await call('ana', 'GET', '/api/archive')).copies.owners.find((o) => o.name === 'Carlos');
const sessionFile = () => {
  const dir = path.join(f.claudeDir, fs.readdirSync(f.claudeDir)[0]);
  return path.join(dir, 's1.jsonl');
};

try {
  for (const who of Object.keys(people)) {
    fs.mkdirSync(path.join(f.root, who));
    writeCfg(who);
    start(who);
  }
  await until(async () => (await call('carlos', 'GET', '/health')).ok && (await call('ana', 'GET', '/health')).ok, 15000, 'hubs arriba');
  await call('carlos', 'POST', '/api/team/create', { name: 'e2e' });
  await call('ana', 'POST', '/api/team/join', { code: (await call('carlos', 'POST', '/api/team/invite', {})).code });
  await until(async () => !(await call('ana', 'GET', '/api/team')).team.pending, 30000, 'admisión de Ana');
  await until(async () => (await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos')?.online, 15000, 'Carlos en línea');
  step('equipo listo');

  // ---- capa 1 + capa 2: primera copia ----
  await call('carlos', 'POST', '/api/archive/sync', {});
  assert.equal((await call('carlos', 'GET', '/api/archive')).own.sessions, 1);
  await call('ana', 'POST', '/api/archive/sync', {});
  assert.equal((await copiesOf()).sessions, 1);
  step('Carlos respalda su sesión y Ana guarda una copia');

  // ---- la sesión crece: la copia se pone al día sin traerla entera ----
  const t = (i) => new Date(Date.UTC(2026, 8, 23, 11, i)).toISOString();
  const extra = [
    { type: 'user', cwd: f.project, sessionId: 's1', timestamp: t(0), message: { role: 'user', content: 'Agrega validación de tamaño máximo' } },
    { type: 'assistant', cwd: f.project, sessionId: 's1', timestamp: t(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Listo: máximo 10 MB por archivo.' }] } },
  ];
  fs.appendFileSync(sessionFile(), extra.map((l) => JSON.stringify(l)).join('\n') + '\n');
  await call('carlos', 'POST', '/api/archive/sync', {});
  await call('ana', 'POST', '/api/archive/sync', {});
  const local = await call('carlos', 'GET', '/api/sessions/claude%3As1?full=1');
  const carlosId = (await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos').id;
  const viaCopy = async () => {
    const r = await mcp('ana', 'get_session', { id: 'claude:s1', peer: 'Carlos' });
    return r;
  };
  assert.equal(local.total, 6);
  assert.equal((await copiesOf()).sessions, 1);
  step('la sesión creció a 6 mensajes y la copia se actualizó (incremental)');

  // ---- Claude Code borra el original (30 días): Carlos lo sigue sirviendo desde su respaldo ----
  fs.rmSync(sessionFile());
  await call('carlos', 'POST', '/api/archive/sync', {});
  const mine = await call('carlos', 'GET', '/api/sessions');
  assert.equal(mine[0].archived, true);
  const remote = await call('ana', 'GET', `/api/sessions/claude%3As1?peer=${carlosId}&full=1`);
  assert.equal(remote.archived, true);
  assert.deepEqual(remote.conversation, local.conversation, 'idéntica a la original');
  step('Claude Code borró el original: Carlos la sigue sirviendo desde su respaldo, idéntica');

  const audit = await call('carlos', 'GET', '/api/access');
  const copyRecords = audit.reads.filter((r) => r.what === 'copy' && r.who === 'Ana');
  assert.equal(copyRecords.length, 1, 'una sola constancia de copia, sin repetir');
  assert.equal(audit.reads.filter((r) => r.what === 'session' && r.who === 'Ana').length, 1, 'solo cuenta la lectura real desde el panel, no las copias');
  step('en la auditoría de Carlos: "Ana guardó una copia", una sola vez y sin avisos de lectura');

  // ---- Carlos se desconecta: Ana lee desde su copia ----
  procs.carlos.kill('SIGTERM');
  await until(async () => !(await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos').online, 20000, 'Carlos desconectado');
  const offline = await viaCopy();
  assert.equal(offline.total, 6);
  assert.ok(offline.copy?.syncedAt, 'marcada como copia, con su fecha');
  assert.deepEqual(offline.conversation, local.conversation);
  const listed = await mcp('ana', 'list_sessions', {});
  assert.ok(listed[0].copy, 'el listado sin conexión viene de la copia');
  step(`Carlos desconectado: Ana lee la sesión completa desde su copia (guardada ${offline.copy.syncedAt})`);

  // ---- Carlos vuelve y oculta la sesión: la copia de Ana se borra ----
  writeCfg('carlos', { excludedSessions: ['claude:s1'] });
  start('carlos');
  await until(async () => (await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos')?.online, 30000, 'Carlos de vuelta');
  await call('ana', 'POST', '/api/archive/sync', {});
  assert.equal((await copiesOf())?.sessions || 0, 0);
  step('Carlos ocultó la sesión: la copia de Ana se borró en el siguiente contacto');

  // ---- la vuelve a mostrar: se copia de nuevo; Ana la borra a mano: no se vuelve a copiar ----
  writeCfg('carlos', { excludedSessions: [] });
  await wait(2500);
  await call('ana', 'POST', '/api/archive/sync', {});
  assert.equal((await copiesOf()).sessions, 1);
  await call('ana', 'POST', '/api/archive/remove', { owner: carlosId, id: 'claude:s1' });
  await call('ana', 'POST', '/api/archive/sync', {});
  assert.equal((await copiesOf()).sessions, 0);
  assert.equal((await copiesOf()).ignored, 1);
  step('Ana borró su copia a mano y no se vuelve a copiar');

  // ---- Carlos no permite copias: se purgan ----
  await call('ana', 'POST', '/api/archive/purge', { owner: carlosId });
  await call('ana', 'POST', '/api/archive/sync', {});
  assert.equal((await copiesOf()).sessions, 1, 'purgar todo también limpia lo ignorado');
  writeCfg('carlos', { allowCopies: false });
  await wait(17000); // el hub de Ana se entera en su próximo "whoami" (cada 15 s)
  await call('ana', 'POST', '/api/archive/sync', {});
  assert.equal(await copiesOf(), undefined);
  step('Carlos desactivó las copias: las de Ana se borraron');

  // ---- Carlos borra del respaldo lo que ya no existe ----
  await call('carlos', 'POST', '/api/archive/remove', { id: 'claude:s1' });
  assert.equal((await call('carlos', 'GET', '/api/sessions')).length, 0);
  step('Carlos borró la sesión de su respaldo');
  console.log('\nE2E BACKUP OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  for (const p of Object.values(procs)) p.kill('SIGTERM');
  await wait(500);
  fs.rmSync(f.root, { recursive: true, force: true });
}
