// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Un solo Session Hub por computadora (extension/machine.cjs): dónde buscar las identidades de cada
// editor en cada sistema, cuál usar, copiar sin tocar el origen, y no migrar dos veces a la vez.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const m = createRequire(import.meta.url)('../extension/machine.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shub-m-'));
const storage = (base, app) => {
  const d = path.join(base, app, 'User', 'globalStorage', m.EXT_ID);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const identity = (dir, { pub, team, owner = 'Carlos', token = 't', mtime }) => {
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ keyPair: pub ? { publicKey: pub } : null, team: team ? { id: team, name: team } : null }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ owner: { name: owner }, localToken: token }));
  if (mtime) for (const f of ['team.json', 'config.json']) fs.utimesSync(path.join(dir, f), mtime / 1000, mtime / 1000);
};

test('dónde guarda sus datos cada editor en Linux, Flatpak, macOS y Windows', () => {
  assert.deepEqual(m.editorBases({}, 'darwin', '/Users/ana'), [path.join('/Users/ana', 'Library', 'Application Support')]);
  assert.deepEqual(m.editorBases({ APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ana'), ['C:\\Users\\ana\\AppData\\Roaming']);
  const linux = m.editorBases({}, 'linux', '/home/ana');
  assert.equal(linux[0], path.join('/home/ana', '.config'));
  assert.ok(linux.includes(path.join('/home/ana', '.var', 'app', 'com.visualstudio.code', 'config')), 'VS Code Flatpak');
  assert.equal(m.editorBases({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/ana')[0], '/x', 'respeta XDG_CONFIG_HOME');
});

test('encuentra las carpetas de Session Hub de todos los editores, sin repetir', () => {
  const base = tmp();
  const cursor = storage(base, 'Cursor');
  const code = storage(base, 'Code');
  storage(base, 'VSCodium'); // instalado pero sin usar Session Hub: no cuenta
  identity(cursor, { pub: 'a', team: 'x' });
  identity(code, { pub: 'b', team: 'y' });
  const flat = tmp(); // otra base (p. ej. Flatpak), vista desde la lista de bases conocidas
  const insiders = storage(flat, 'Code - Insiders');
  identity(insiders, { pub: 'c' });
  const found = m.candidateDirs(cursor, [base, flat]);
  assert.equal(found[0], cursor, 'la propia primero');
  assert.deepEqual(new Set(found), new Set([cursor, code, insiders]));
  assert.equal(m.describe(code).editor, 'VS Code');
  assert.equal(m.describe(insiders).editor, 'Code - Insiders');
});

test('qué identidad usar al pasar a un solo hub', () => {
  const c = (dir, pub, team, mtime) => ({ dir, pub, team: team && { id: team, name: team }, mtime, owner: 'x' });
  // Una sola persona con equipo, en dos editores: la más reciente, sin preguntar.
  let p = m.plan([c('/a', 'P', 'T', 1), c('/b', 'P', 'T', 5)], '/a');
  assert.equal(p.use.dir, '/b');
  assert.equal(p.ask, undefined);
  // Dos personas distintas con equipo: se pregunta, la más reciente primero.
  p = m.plan([c('/a', 'P', 'T', 9), c('/b', 'Q', 'U', 5)], '/a');
  assert.deepEqual(p.ask.map((x) => x.dir), ['/a', '/b']);
  // Equipo solo en otro editor: esa.
  p = m.plan([c('/own', 'P', null, 9), c('/b', 'Q', 'U', 1)], '/own');
  assert.equal(p.use.dir, '/b');
  // Nadie con equipo: la propia (conserva su token y su respaldo).
  p = m.plan([c('/b', 'Q', null, 9), c('/own', 'P', null, 1)], '/own');
  assert.equal(p.use.dir, '/own');
  // Nada: carpeta nueva.
  assert.equal(m.plan([], '/own').use, null);
});

test('copia la identidad a la carpeta común sin tocar el origen', async () => {
  const src = tmp();
  identity(src, { pub: 'a', team: 'x', token: 'tok' });
  fs.mkdirSync(path.join(src, 'archive', 'own'), { recursive: true });
  fs.writeFileSync(path.join(src, 'archive', 'own', 's.json'), '{"respaldo":1}');
  fs.writeFileSync(path.join(src, '.migrated-from-x'), 'viejo');
  const dest = path.join(tmp(), 'hub');
  await m.copyData(src, dest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'config.json'), 'utf8')).localToken, 'tok');
  assert.equal(fs.readFileSync(path.join(dest, 'archive', 'own', 's.json'), 'utf8'), '{"respaldo":1}', 'el respaldo viaja con la identidad');
  assert.ok(!fs.existsSync(path.join(dest, '.migrated-from-x')), 'las marcas internas no se copian');
  assert.ok(fs.existsSync(path.join(src, 'team.json')), 'el origen queda intacto');
});

const writeConf = (stage) => fs.writeFileSync(path.join(stage, 'config.json'), '{"localToken":"t"}');

test('dos editores que abren a la vez: migra uno solo y el otro espera a que esté lista', async () => {
  const dir = path.join(tmp(), 'hub');
  let runs = 0;
  const job = () =>
    m.createOnce(dir, async (stage) => {
      runs++;
      await new Promise((r) => setTimeout(r, 300));
      writeConf(stage);
    });
  const results = await Promise.all([job(), job(), job()]);
  assert.equal(runs, 1);
  assert.deepEqual(results.sort(), ['done', 'ready', 'ready']);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'quien esperó la encuentra completa, nunca vacía');
  assert.ok(!fs.existsSync(`${dir}.lock`), 'el candado se libera');
  assert.equal(await job(), 'ready', 'ya lista: no se vuelve a migrar');
});

test('una copia interrumpida no deja datos a medias', async () => {
  const dir = path.join(tmp(), 'hub');
  await assert.rejects(
    m.createOnce(dir, async (stage) => {
      fs.writeFileSync(path.join(stage, 'parcial.txt'), 'x');
      throw new Error('el editor se cerró');
    }),
  );
  assert.ok(!fs.existsSync(dir), 'la carpeta común no existe a medias');
  assert.ok(!fs.existsSync(`${dir}.lock`));
  assert.deepEqual(fs.readdirSync(path.dirname(dir)), [], 'ni restos temporales');
  assert.equal(await m.createOnce(dir, async (stage) => writeConf(stage)), 'done', 'el siguiente intento funciona');
});

test('el candado de un editor que ya no existe se libera enseguida', async () => {
  const dir = path.join(tmp(), 'hub');
  fs.writeFileSync(`${dir}.lock`, '2147483646'); // pid que no existe; el candado es reciente
  const t0 = Date.now();
  assert.equal(await m.createOnce(dir, async (stage) => writeConf(stage)), 'done');
  assert.ok(Date.now() - t0 < 3000);
});

test('restos de un intento anterior sin terminar se apartan, no se borran', async () => {
  const dir = path.join(tmp(), 'hub');
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true }); // como quedó en la prueba real
  fs.writeFileSync(path.join(dir, 'archive', 'a.gz'), 'x');
  assert.equal(await m.createOnce(dir, async (stage) => writeConf(stage)), 'done');
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  const aside = fs.readdirSync(path.dirname(dir)).find((n) => n.startsWith('hub.incompleto-'));
  assert.ok(aside && fs.existsSync(path.join(path.dirname(dir), aside, 'archive', 'a.gz')));
});

test('una copia larga renueva el candado: el otro editor no la toma por abandonada', async () => {
  const dir = path.join(tmp(), 'hub');
  let runs = 0;
  const job = (ms) =>
    m.createOnce(
      dir,
      async (stage) => {
        runs++;
        await new Promise((r) => setTimeout(r, ms));
        writeConf(stage);
      },
      { staleMs: 400 },
    );
  const first = job(1500); // dura casi 4 veces lo que se considera abandonado
  await new Promise((r) => setTimeout(r, 100));
  const results = await Promise.all([first, job(0)]);
  assert.equal(runs, 1, 'solo migra uno');
  assert.deepEqual(results, ['done', 'ready']);
});

test('mientras otro editor vivo migra, no se le quita el candado', async () => {
  const dir = path.join(tmp(), 'hub');
  fs.writeFileSync(`${dir}.lock`, String(process.pid)); // vivo
  assert.equal(await m.createOnce(dir, async () => assert.fail('no debe migrar'), { waitMs: 800 }), 'timeout');
  fs.rmSync(`${dir}.lock`);
});

test('trae lo que un hub anterior siguió escribiendo en la carpeta vieja', async () => {
  const src = tmp();
  const dest = tmp();
  identity(src, { pub: 'a', team: 'x' });
  await m.copyData(src, dest);
  const past = (Date.now() - 60000) / 1000;
  for (const f of ['team.json', 'config.json']) fs.utimesSync(path.join(dest, f), past, past);
  fs.writeFileSync(path.join(src, 'inbox.json'), '{"nuevo":1}'); // el hub viejo escribió después
  fs.mkdirSync(path.join(src, 'archive', 'own'), { recursive: true });
  fs.writeFileSync(path.join(src, 'archive', 'own', 'b.gz'), 'b');
  fs.writeFileSync(path.join(src, 'config.json'), '{"localToken":"viejo"}');
  const n = await m.catchUp(src, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'inbox.json'), 'utf8'), '{"nuevo":1}');
  assert.equal(fs.readFileSync(path.join(dest, 'archive', 'own', 'b.gz'), 'utf8'), 'b');
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dest, 'config.json'), 'utf8')).localToken, 'viejo', 'config.json no se toca');
  assert.ok(n >= 2);
  assert.equal(await m.catchUp(src, dest), 0, 'una segunda vez no copia nada');
});

test('ajustes comunes y comparación de versiones', () => {
  const dir = tmp();
  assert.equal(m.readSettings(dir), null);
  m.writeSettings(dir, { paused: true, sharedProjects: [{ path: '/p' }] }, 'Cursor');
  const s = m.readSettings(dir);
  assert.equal(s.values.paused, true);
  assert.equal(s.by, 'Cursor');
  assert.ok(m.same([{ path: '/p' }], s.values.sharedProjects));
  assert.deepEqual(s.removed, {}, 'sin claves restablecidas');
  m.writeSettings(dir, { paused: true }, 'Code', { sharedProjects: '2026-01-01T00:00:00.000Z' });
  assert.equal(m.readSettings(dir).removed.sharedProjects, '2026-01-01T00:00:00.000Z', 'se guardan las claves restablecidas');
  assert.ok(!m.same(undefined, false));
  assert.ok(m.SHARED_SETTINGS.includes('port') && !m.SHARED_SETTINGS.includes('language'), 'el idioma es de cada editor');
  assert.ok(m.compareVersions('0.9.3', '0.10.0') < 0);
  assert.ok(m.compareVersions('0.10.0', '0.9.3') > 0);
  assert.equal(m.compareVersions('0.10.0', '0.10.0'), 0);
  assert.ok(m.compareVersions('?', '0.10.0') < 0, 'un hub sin versión se considera viejo');
});

test('rutas de Windows: mismas carpetas aunque cambien las mayúsculas', { skip: process.platform !== 'win32' }, () => {
  assert.ok(m.samePath('C:\\Users\\Ana\\x', 'c:\\users\\ana\\X'));
});
