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
const procs = [];
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
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: path.join(dir, 'config.json') }, stdio: 'ignore' });
    procs.push(child);
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
  console.log('\nE2E OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill('SIGTERM');
  await wait(500);
  fs.rmSync(f.root, { recursive: true, force: true });
}
