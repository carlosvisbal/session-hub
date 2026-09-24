// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Actualizar la extensión con un hub viejo todavía corriendo (p. ej. tras un cierre inesperado del
// editor): la extensión nueva debe detectar la otra versión, cerrarlo y arrancar el suyo.
// Usa el hub real de la etiqueta v0.8.1 (no sabe cerrarse solo: se termina por su proceso).
//   node test/extension/upgrade.mjs
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeClaudeFixture } from '../fixtures.js';
import { createEditor, ok, ROOT, tmpdir, until, wait } from './harness.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const f = makeClaudeFixture();
const oldRoot = path.join(tmpdir('shub-old-'), 'session-hub-0.8.1');
let old;
let win;
try {
  try {
    fs.mkdirSync(oldRoot, { recursive: true });
    execSync(`git -C "${ROOT}" archive v0.8.1 | tar -x -C "${oldRoot}"`, { stdio: 'ignore' });
  } catch {
    console.log('— sin la etiqueta v0.8.1 en este clon; se omite');
    process.exit(0);
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(oldRoot, 'node_modules'));
  const port = 7680 + Math.floor(Math.random() * 9);
  const storage = path.join(f.root, 'gs');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, 'config.json'), JSON.stringify({ port, dhtPort: 49680 + (port % 10), localToken: 't', network: 'lan', owner: { name: 'Carlos' }, claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir }));
  old = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(oldRoot, 'src', 'server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: path.join(storage, 'config.json') }, stdio: 'ignore' });
  const whoami = async () => (await fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: { authorization: 'Bearer t' } })).json();
  await until(async () => (await whoami()).software.version === '0.8.1', 15000, 'hub viejo arriba');
  const oldPid = old.pid;
  ok(`hub viejo corriendo: versión 0.8.1 (pid ${oldPid})`);

  const editor = createEditor({ appName: 'Cursor', storage, settings: { port } });
  win = await editor.openWindow();
  await until(async () => (await whoami()).software.version === VERSION, 20000, 'hub nuevo');
  const w = await whoami();
  assert.notEqual(w.pid, oldPid);
  assert.equal(old.exitCode !== null || old.signalCode !== null, true, 'el hub viejo terminó');
  ok(`la extensión ${VERSION} cerró el hub 0.8.1 y arrancó el suyo (pid ${w.pid})`);

  const arch = await (await fetch(`http://127.0.0.1:${port}/api/archive?detail=1`, { headers: { authorization: 'Bearer t' } })).json();
  assert.ok(Array.isArray(arch.own.list), 'el panel recibe el detalle del respaldo');
  ok('el respaldo vuelve a mostrarse con su detalle');

  const second = await editor.openWindow(); // otra ventana, misma versión: se conecta, no reemplaza
  assert.equal((await whoami()).pid, w.pid);
  second.close();
  ok('otra ventana con la misma versión se conecta al hub sin reemplazarlo');
  console.log('\nACTUALIZACIÓN OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  win?.close();
  try {
    old?.kill('SIGTERM');
  } catch {}
  await wait(500);
  fs.rmSync(f.root, { recursive: true, force: true });
  fs.rmSync(path.dirname(oldRoot), { recursive: true, force: true });
  process.exit();
}
