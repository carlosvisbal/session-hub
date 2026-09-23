// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Extremo a extremo del modo remoto "private":
//   1) infraestructura propia (3 nodos de arranque + relay ciego)
//   2) dos hubs obligados a pasar por el relay: admisión y lectura completa idéntica
//   3) un hub con el arranque inalcanzable: el informe explica por qué falla
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeFixture } from '../fixtures.js';
import { startInfra } from '../../src/infra.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const f = makeClaudeFixture();
const r = Math.floor(Math.random() * 80);
const infra = await startInfra({ host: '127.0.0.1', port: 48100 + r * 5, nodes: 3, relay: true, log: () => {} });
const net = { network: 'private', bootstrap: infra.bootstrap, relay: infra.relayKey, forceRelay: true };
const people = {
  carlos: { port: 7700 + r, owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api' }], ...net },
  ana: { port: 7800 + r, owner: { name: 'Ana', role: 'frontend' }, projects: [], ...net },
  aislada: { port: 7900 + r, owner: { name: 'Aislada', role: '' }, projects: [], network: 'private', bootstrap: ['127.0.0.1:9'] },
};
const procs = [];
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const call = async (who, method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${people[who].port}${route}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(40000) });
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
  step(`infraestructura: 3 nodos de arranque ${infra.bootstrap.join(', ')} + relay ${infra.relayKey.slice(0, 12)}…`);
  for (const [who, p] of Object.entries(people)) {
    const dir = path.join(f.root, who);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...p, localToken: 't', claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir }));
    procs.push(spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: path.join(dir, 'config.json') }, stdio: 'ignore' }));
  }
  await until(async () => (await Promise.all(Object.keys(people).map((w) => call(w, 'GET', '/health')))).every((h) => h.ok), 20000, 'hubs arriba');

  await call('carlos', 'POST', '/api/team/create', { name: 'remoto' });
  const { code } = await call('carlos', 'POST', '/api/team/invite', {});
  await call('ana', 'POST', '/api/team/join', { code });
  await until(async () => !(await call('ana', 'GET', '/api/team')).team.pending, 60000, 'admisión de Ana por el relay');
  step('Ana admitida por Carlos, en modo private y a través del relay');

  const carlos = (await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos');
  const local = await call('carlos', 'GET', '/api/sessions/claude%3As1?full=1');
  const remote = await call('ana', 'GET', `/api/sessions/claude%3As1?peer=${carlos.id}&full=1`);
  assert.deepEqual(remote.conversation, local.conversation);
  step(`lectura completa por el relay: ${remote.conversation.length}/${local.total} mensajes, idéntica`);
  const stats = infra.relayStats();
  assert.ok(stats.pairings.matched > 0, 'el relay emparejó conexiones');
  step(`el relay emparejó ${stats.pairings.matched} conexión(es) y no puede leerlas (cifrado de extremo a extremo)`);

  // 3) arranque inalcanzable → diagnóstico explicado
  await call('aislada', 'POST', '/api/team/create', { name: 'sola' });
  await until(async () => (await call('aislada', 'GET', '/api/netreport')).issues.some((i) => i.code === 'BOOTSTRAP_UNREACHABLE'), 40000, 'diagnóstico de arranque inalcanzable');
  const rep = await call('aislada', 'GET', '/api/netreport');
  step(`red bloqueada detectada: "${rep.issues[0].title}"`);
  console.log('\n----- informe que se comparte -----\n' + rep.text.split('\n').slice(0, 12).join('\n') + '\n  …');
  console.log('\nE2E RELAY OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill('SIGTERM');
  await wait(500);
  await infra.stop();
  fs.rmSync(f.root, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
