// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Extremo a extremo, con tres hubs reales (modo lan): al salir del equipo o al ser expulsado,
// nadie conserva copias de esa persona, y quien es expulsado no conserva las del equipo.
//   Ana funda; Carlos y Pedro entran invitados por Ana; los tres comparten el mismo proyecto.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeFixture } from '../fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const f = makeClaudeFixture();
const isFree = (port) => new Promise((resolve) => { const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1'); });
let base = 8000 + Math.floor(Math.random() * 90);
while (!((await isFree(base)) && (await isFree(base + 100)) && (await isFree(base + 200)))) base = 8000 + Math.floor(Math.random() * 90);
const shared = [{ path: f.project, name: 'demo-api' }];
const people = {
  ana: { port: base, dhtPort: 50000 + (base % 100), owner: { name: 'Ana', role: 'lead' }, projects: shared },
  carlos: { port: base + 100, dhtPort: 50100 + (base % 100), owner: { name: 'Carlos', role: 'backend' }, projects: shared },
  pedro: { port: base + 200, dhtPort: 50200 + (base % 100), owner: { name: 'Pedro', role: 'frontend' }, projects: shared },
};
const procs = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cfgFile = (who) => path.join(f.root, who, 'config.json');
const start = (who) => {
  fs.mkdirSync(path.join(f.root, who));
  fs.writeFileSync(cfgFile(who), JSON.stringify({ ...people[who], localToken: 't', network: 'lan', claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir }));
  procs[who] = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: cfgFile(who) }, stdio: 'ignore' });
};
const call = async (who, method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${people[who].port}${route}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};
async function until(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(500)) if (await fn().catch(() => false)) return;
  throw new Error(`No se cumplió a tiempo: ${what}`);
}
const step = (m) => console.log('✔', m);
const copiesOf = async (who, name) => (await call(who, 'GET', '/api/archive')).copies.owners.find((o) => o.name === name)?.sessions || 0;
const online = async (who, name) => (await call(who, 'GET', '/api/peers')).find((m) => m.name === name)?.online;

try {
  for (const who of Object.keys(people)) start(who);
  await until(async () => (await Promise.all(Object.keys(people).map((w) => call(w, 'GET', '/health')))).every((h) => h.ok), 15000, 'hubs arriba');
  await call('ana', 'POST', '/api/team/create', { name: 'e2e' });
  for (const who of ['carlos', 'pedro']) {
    await call(who, 'POST', '/api/team/join', { code: (await call('ana', 'POST', '/api/team/invite', {})).code });
    await until(async () => !(await call(who, 'GET', '/api/team')).team.pending, 30000, `admisión de ${who}`);
  }
  await until(async () => (await online('ana', 'Carlos')) && (await online('ana', 'Pedro')), 30000, 'Ana ve a los dos');
  step('equipo de tres listo');

  for (const who of ['ana', 'carlos']) await call(who, 'POST', '/api/archive/sync', {});
  assert.equal(await copiesOf('ana', 'Carlos'), 1);
  assert.equal(await copiesOf('ana', 'Pedro'), 1);
  assert.equal(await copiesOf('carlos', 'Ana'), 1);
  step('Ana tiene copias de Carlos y de Pedro; Carlos, de Ana');

  // ---- Ana expulsa a Carlos: ella borra sus copias de él, y él las del equipo ----
  const carlosId = (await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos').id;
  await call('ana', 'POST', '/api/members/revoke', { id: carlosId, reason: 'e2e' });
  assert.equal(await copiesOf('ana', 'Carlos'), 0, 'quien expulsa borra en el acto');
  assert.equal(await copiesOf('ana', 'Pedro'), 1, 'las de los demás siguen');
  await until(async () => (await copiesOf('carlos', 'Ana')) === 0, 15000, 'el expulsado borra las copias del equipo');
  step('Ana expulsó a Carlos: ella ya no tiene sus copias y él ya no tiene las del equipo');

  // ---- Pedro sale: Ana borra sus copias ----
  await call('pedro', 'POST', '/api/team/leave', {});
  await until(async () => (await copiesOf('ana', 'Pedro')) === 0, 15000, 'Ana borra las copias de quien salió');
  step('Pedro salió del equipo: Ana borró sus copias');

  // ---- al reiniciar no reaparece nada ----
  procs.ana.kill('SIGTERM');
  await wait(1000);
  procs.ana = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: cfgFile('ana') }, stdio: 'ignore' });
  await until(async () => (await call('ana', 'GET', '/health')).ok, 15000, 'Ana de vuelta');
  await call('ana', 'POST', '/api/archive/sync', {});
  assert.equal((await call('ana', 'GET', '/api/archive')).copies.owners.reduce((a, o) => a + (o.sessions || 0), 0), 0);
  step('tras reiniciar, Ana sigue sin copias de ninguno de los dos');
  console.log('\nE2E SALIDA DEL EQUIPO OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  for (const p of Object.values(procs)) p.kill('SIGTERM');
  await wait(500);
  fs.rmSync(f.root, { recursive: true, force: true });
}
