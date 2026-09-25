// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// El runtime del editor no carga los módulos nativos (VS Code como Snap en Ubuntu: glibc 2.31 y
// sodium-native pide 2.33). Se simula con un preload que falla solo con ELECTRON_RUN_AS_NODE=1:
//  1. hay un Node del sistema que sirve → el hub arranca con él y con las variables originales
//     (X_VSCODE_SNAP_ORIG), no las del Snap;
//  2. no hay ninguno (SHUB_RUNTIME_NO_SYSTEM=1; con SHUB_REAL_FAILURE=1 dentro de Ubuntu 20.04,
//     el fallo es el real) → aviso con la solución.
//   node test/extension/runtime.mjs   (corre los dos casos)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeClaudeFixture } from '../fixtures.js';
import { createEditor, ok, tmpdir, until, wait } from './harness.mjs';

// Sin elegir caso, corre los dos, cada uno en su propio proceso (el preload va por NODE_OPTIONS).
if (process.env.SHUB_RUNTIME_NO_SYSTEM === undefined) {
  for (const mode of ['0', '1']) {
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], { stdio: 'inherit', env: { ...process.env, SHUB_RUNTIME_NO_SYSTEM: mode } });
    if (r.status) process.exit(r.status);
  }
  process.exit(0);
}
const noSystem = process.env.SHUB_RUNTIME_NO_SYSTEM === '1';
const f = makeClaudeFixture();
const dir = tmpdir('shub-rt-');
const marker = path.join(dir, 'hub-env.json');
const preload = path.join(dir, 'broken-editor.cjs');
// Solo simula el fallo si nadie más lo provoca de verdad (dentro de Ubuntu 20.04 ya falla solo).
fs.writeFileSync(
  preload,
  `if (process.env.ELECTRON_RUN_AS_NODE === '1' && !process.env.SHUB_REAL_FAILURE) { const e = new Error("sodium-native.node: version \`GLIBC_2.33' not found"); throw e; }
if (process.argv.some((a) => a.endsWith('server.js'))) require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ electron: process.env.ELECTRON_RUN_AS_NODE || null, gtk: process.env.GTK_PATH || null, gio: process.env.GIO_MODULE_DIR || null }));
`,
);
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require ${preload}`.trim();
// Lo que hace el Snap de VS Code: cambia variables y guarda las originales.
process.env.GTK_PATH = '/snap/code/current/usr/lib/gtk-3.0';
process.env.GTK_PATH_VSCODE_SNAP_ORIG = '/usr/lib/gtk-3.0';
process.env.GIO_MODULE_DIR = '/snap/code/current/usr/lib/gio';
process.env.GIO_MODULE_DIR_VSCODE_SNAP_ORIG = '';
if (noSystem) process.env.PATH = '/nonexistent';

let win;
try {
  const port = 7690 + Math.floor(Math.random() * 9);
  const storage = path.join(f.root, 'gs');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, 'config.json'), JSON.stringify({ port, dhtPort: 49690 + (port % 10), localToken: 't', network: 'lan', owner: { name: 'Carlos' }, claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir }));
  const editor = createEditor({ storage, settings: { port, autoStart: true } });
  const t0 = Date.now();
  win = await editor.openWindow();
  assert.ok(Date.now() - t0 < 3000, 'abrir la ventana no espera a la comprobación del runtime');
  ok('la comprobación del runtime no bloquea la extensión');

  if (!noSystem) {
    const whoami = async () => (await fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: { authorization: 'Bearer t' } })).json();
    await until(async () => (await whoami()).pid, 25000, 'hub arriba con el Node del sistema');
    const env = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(env.electron, null, 'el hub no corre con el runtime del editor');
    ok('el runtime del editor falla → el hub arranca con el Node del sistema');
    assert.equal(env.gtk, '/usr/lib/gtk-3.0');
    assert.equal(env.gio, null);
    ok('el Node del sistema recibe las variables originales, no las del Snap');
    assert.equal(editor.shared.notices.filter((n) => n.kind === 'error').length, 0, 'sin avisos de error');
  } else {
    await until(async () => editor.shared.notices.some((n) => n.kind === 'error' && /no puede arrancar/.test(n.m)), 25000, 'aviso con la solución');
    const n = editor.shared.notices.find((x) => x.kind === 'error' && /no puede arrancar/.test(x.m));
    assert.match(n.m, /GLIBC_2\.33/);
    assert.match(n.m, /Node\.js 22\.5/);
    assert.ok(n.buttons.includes('Cómo arreglarlo'));
    ok('sin un Node que sirva → aviso con la causa (GLIBC_2.33) y la solución');
  }
  console.log('\nRUNTIME OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  win?.close();
  await wait(500);
  fs.rmSync(f.root, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit();
}
