// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Cursor y VS Code en la misma computadora: un solo Session Hub (extension/machine.cjs).
//  1. Instalación nueva en los dos: el segundo editor se conecta al hub del primero, sin choque de
//     puerto, con la misma identidad y el mismo equipo.
//  2. Un ajuste común cambiado en un editor llega al otro y al hub.
//  3. Al cerrar el editor que tenía el hub, el otro lo relanza con la misma identidad.
//  4. Actualizar desde 0.9, con una identidad distinta en cada editor: se pregunta con cuál seguir,
//     se usa esa (con su token) y la otra queda intacta en su carpeta.
//  5. Actualizar desde 0.9 con equipo solo en un editor: se usa esa sin preguntar.
//   node test/extension/machine.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEditor, ok, tmpdir, until, wait } from './harness.mjs';

const root = tmpdir('shub-pc-');
process.env.HOME = path.join(root, 'home'); // nunca la carpeta personal real
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });
const storageOf = (app, base = path.join(root, 'config')) => {
  const d = path.join(base, app, 'User', 'globalStorage', 'carlosvisbal.session-hub');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
let portSeq = 7700 + Math.floor(Math.random() * 50);
const call = async (port, token, method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status}`);
  return r.json();
};
const open = [];
const win = async (editor) => {
  const w = await editor.openWindow();
  open.push(w);
  return w;
};
const closeAll = async () => {
  while (open.length) open.pop().close();
  await wait(800);
};

try {
  // ---------- 1-3: instalación nueva en los dos editores ----------
  {
    const port = portSeq++;
    const dataDir = path.join(root, 'pc1', '.session-hub', 'hub');
    const settings = { port, dhtPort: 49800 + (port % 100), autoStart: true, name: 'Carlos', network: 'lan' };
    const cursor = createEditor({ appName: 'Cursor', storage: storageOf('Cursor', path.join(root, 'pc1')), token: 'tok-cursor', dataDir, settings: { ...settings } });
    const code = createEditor({ appName: 'Visual Studio Code', storage: storageOf('Code', path.join(root, 'pc1')), token: 'tok-code', dataDir, settings: { ...settings } });

    const wc = await win(cursor);
    const token = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).localToken;
    await until(async () => (await call(port, token, 'GET', '/api/whoami')).pid, 20000, 'hub de Cursor');
    await call(port, token, 'POST', '/api/team/create', { name: 'equipo-pc' });
    const w1 = await call(port, token, 'GET', '/api/whoami');

    const wv = await win(code);
    await wait(1500);
    assert.equal(code.shared.notices.filter((n) => n.kind === 'error').length, 0, `VS Code sin errores: ${JSON.stringify(code.shared.notices)}`);
    const w2 = await call(port, token, 'GET', '/api/whoami');
    assert.equal(w2.pid, w1.pid, 'VS Code usa el mismo hub');
    assert.equal(w2.fingerprint, w1.fingerprint, 'misma identidad');
    assert.equal((await call(port, token, 'GET', '/api/team')).team.name, 'equipo-pc');
    ok('Cursor y VS Code en la misma PC: un solo hub, una identidad, el mismo equipo, sin choque de puerto');

    // El panel cambia los ajustes con update(): se hace lo mismo desde VS Code.
    await wv.vscode.workspace.getConfiguration('sessionHub').update('paused', true);
    await until(async () => cursor.shared.settings.paused === true, 8000, 'la pausa llega a Cursor');
    await until(async () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).paused === true, 8000, 'la pausa llega al hub');
    ok('pausar en VS Code pausa también en Cursor y en el hub (ajustes comunes)');

    // Se cierra Cursor, que tenía el hub: VS Code lo relanza.
    open.splice(open.indexOf(wc), 1);
    wc.close();
    await until(async () => {
      const w = await call(port, token, 'GET', '/api/whoami');
      return w.pid !== w1.pid && w.fingerprint === w1.fingerprint;
    }, 40000, 'VS Code toma el relevo');
    ok('al cerrar Cursor, VS Code relanza el hub con la misma identidad');
    await closeAll();
  }

  // ---------- 4: desde 0.9 con una identidad distinta en cada editor ----------
  {
    const pc = path.join(root, 'pc2');
    const port = portSeq++;
    const settings = { port, dhtPort: 49800 + (port % 100), autoStart: true, network: 'lan' };
    const sCursor = storageOf('Cursor', pc);
    const sCode = storageOf('Code', pc);
    // Como en 0.9: cada editor con su carpeta propia y su equipo.
    for (const [app, storage, tok, team] of [['Cursor', sCursor, 'tok-c', 'equipo-cursor'], ['Visual Studio Code', sCode, 'tok-v', 'equipo-vscode']]) {
      const e = createEditor({ appName: app, storage, token: tok, settings: { ...settings } });
      await win(e);
      await until(async () => (await call(port, tok, 'GET', '/api/whoami')).pid, 20000, `hub 0.9 de ${app}`);
      await call(port, tok, 'POST', '/api/team/create', { name: team });
      await closeAll();
    }
    const vscodeTeamFile = fs.readFileSync(path.join(sCode, 'team.json'), 'utf8');
    const cursorTeamFile = fs.readFileSync(path.join(sCursor, 'team.json'), 'utf8');
    fs.utimesSync(path.join(sCursor, 'team.json'), new Date(), new Date(Date.now() + 5000)); // Cursor, la más reciente

    const dataDir = path.join(pc, '.session-hub', 'hub');
    const cursor = createEditor({ appName: 'Cursor', storage: sCursor, token: 'tok-c', dataDir, settings: { ...settings } });
    let offered = null;
    cursor.shared.quickPick = (items) => ((offered = items), items.find((i) => /equipo-vscode/.test(i.label)));
    await win(cursor);
    assert.ok(offered && offered.length === 2, 'se pregunta con qué identidad seguir');
    assert.match(offered[0].label, /equipo-cursor/, 'primero la usada más recientemente');
    const shared = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(shared.localToken, 'tok-v', 'se conserva el token de la identidad elegida (conexiones ya registradas)');
    await until(async () => (await call(port, 'tok-v', 'GET', '/api/team')).team?.name === 'equipo-vscode', 20000, 'hub con el equipo elegido');
    assert.ok(cursor.shared.notices.some((n) => /queda guardada/.test(n.m)), 'aviso de la identidad que queda guardada');
    assert.equal(fs.readFileSync(path.join(sCursor, 'team.json'), 'utf8'), cursorTeamFile, 'la otra identidad queda intacta');
    assert.equal(fs.readFileSync(path.join(sCode, 'team.json'), 'utf8'), vscodeTeamFile, 'la carpeta de origen no se toca');
    ok('desde 0.9 con dos identidades: se pregunta, se usa la elegida con su token y la otra queda guardada');

    const code = createEditor({ appName: 'Visual Studio Code', storage: sCode, token: 'tok-v', dataDir, settings: { ...settings } });
    code.shared.quickPick = () => {
      throw new Error('no debería volver a preguntar');
    };
    await win(code);
    await wait(1000);
    assert.equal(code.shared.notices.filter((n) => n.kind === 'error').length, 0);
    ok('el segundo editor ya no pregunta: se conecta al hub común');
    await closeAll();
  }

  // ---------- 5: desde 0.9 con equipo solo en VS Code ----------
  {
    const pc = path.join(root, 'pc3');
    const port = portSeq++;
    const settings = { port, dhtPort: 49800 + (port % 100), autoStart: true, network: 'lan' };
    const sCode = storageOf('Code', pc);
    storageOf('Cursor', pc); // Cursor instalado, sin Session Hub usado
    const old = createEditor({ appName: 'Visual Studio Code', storage: sCode, token: 'tok-solo', settings: { ...settings } });
    await win(old);
    await until(async () => (await call(port, 'tok-solo', 'GET', '/api/whoami')).pid, 20000, 'hub 0.9 de VS Code');
    await call(port, 'tok-solo', 'POST', '/api/team/create', { name: 'equipo-solo' });
    await closeAll();

    const dataDir = path.join(pc, '.session-hub', 'hub');
    const cursor = createEditor({ appName: 'Cursor', storage: storageOf('Cursor', pc), token: 'tok-nuevo', dataDir, settings: { ...settings } });
    cursor.shared.quickPick = () => {
      throw new Error('no debería preguntar');
    };
    await win(cursor);
    await until(async () => (await call(port, 'tok-solo', 'GET', '/api/team')).team?.name === 'equipo-solo', 20000, 'Cursor usa la identidad de VS Code');
    ok('desde 0.9 con equipo solo en VS Code: Cursor la usa sin preguntar y conserva su token');
    await closeAll();
  }
  // ---------- 6: una ventana sin recargar dejó un hub 0.9 escribiendo en la carpeta vieja ----------
  {
    const { execSync, spawn } = await import('node:child_process');
    const oldRoot = path.join(root, 'v093');
    let tagged = true;
    try {
      fs.mkdirSync(oldRoot, { recursive: true });
      execSync(`git -C "${path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')}" archive v0.9.3 | tar -x -C "${oldRoot}"`, { stdio: 'ignore' });
    } catch {
      tagged = false;
      console.log('— sin la etiqueta v0.9.3 en este clon; se omite el caso 6');
    }
    if (tagged) {
      const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(oldRoot, 'node_modules'));
      const pc = path.join(root, 'pc4');
      const port = portSeq++;
      const settings = { port, dhtPort: 49800 + (port % 100), autoStart: true, network: 'lan' };
      const sCode = storageOf('Code', pc);
      const e0 = createEditor({ appName: 'Visual Studio Code', storage: sCode, token: 'tok-old', settings: { ...settings } });
      await win(e0);
      await until(async () => (await call(port, 'tok-old', 'GET', '/api/whoami')).pid, 20000, 'hub 0.9 inicial');
      await call(port, 'tok-old', 'POST', '/api/team/create', { name: 'equipo-mixto' });
      await closeAll();
      const dataDir = path.join(pc, '.session-hub', 'hub');
      const first = createEditor({ appName: 'Cursor', storage: storageOf('Cursor', pc), token: 'x', dataDir, settings: { ...settings } });
      await win(first); // migra a la carpeta común
      await closeAll();
      // La ventana vieja sigue con 0.9.3, en la carpeta de VS Code, y escribe después de la migración.
      const old = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(oldRoot, 'src', 'server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: path.join(sCode, 'config.json') }, stdio: 'ignore' });
      try {
        await until(async () => (await call(port, 'tok-old', 'GET', '/api/whoami')).software.version === '0.9.3', 20000, 'hub 0.9.3 arriba');
        await wait(1100);
        const blockedId = 'ab'.repeat(32);
        await call(port, 'tok-old', 'POST', '/api/members/block', { id: blockedId, blocked: true }); // el hub viejo lo guarda en su carpeta
        const code = createEditor({ appName: 'Visual Studio Code', storage: sCode, token: 'tok-old', dataDir, settings: { ...settings } });
        await win(code);
        await until(async () => (await call(port, 'tok-old', 'GET', '/api/whoami')).software.version !== '0.9.3', 20000, 'hub 0.10 en su lugar');
        assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'team.json'), 'utf8')).blocked.includes(blockedId), 'el cambio hecho por el hub viejo llegó a la carpeta común');
        assert.ok((await call(port, 'tok-old', 'GET', '/api/whoami')).id, 'misma identidad');
        ok('al reemplazar un hub 0.9 de la misma identidad, se trae lo que siguió escribiendo en la carpeta vieja');
      } finally {
        old.kill();
      }
      await closeAll();
    }
  }
  console.log('\nMISMA COMPUTADORA OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  await closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit();
}
