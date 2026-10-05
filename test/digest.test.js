// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, CACHE_MS } from '../src/digest.js';
import { createHub } from '../src/hub.js';
import { LONG_TEXT, makeClaudeFixture } from './fixtures.js';

const msg = (role, text, actions = [], at = '2026-01-01T00:00:00.000Z') => ({ role, at, text, actions });
const header = (extra = {}) => ({ id: 'claude:x', title: 't', project: 'p', branch: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', filesChanged: ['a.js'], ...extra });

test('extracto: objetivo, últimas peticiones y respuestas acotadas', () => {
  const messages = [];
  for (let i = 0; i < 20; i++) messages.push(msg('user', `petición ${i}`), msg('assistant', `respuesta ${i}`));
  const d = buildDigest(header(), messages);
  assert.equal(d.objetivo, 'petición 0');
  assert.deepEqual(d.ultimasPeticiones.map((x) => x.text), ['petición 15', 'petición 16', 'petición 17', 'petición 18', 'petición 19']);
  assert.equal(d.ultimasRespuestas.length, 3);
  assert.equal(d.ultimasRespuestas.at(-1).text, 'respuesta 19');
  assert.equal(d.mensajesTotales, 40);
});

test('extracto: caché vencida según la inactividad', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(buildDigest(header(), [msg('user', 'hola')], { now: now + CACHE_MS + 1 }).cacheVencida, true);
  assert.equal(buildDigest(header(), [msg('user', 'hola')], { now: now + 60_000 }).cacheVencida, false);
  assert.equal(buildDigest(header({ updatedAt: null }), [msg('user', 'hola')]).cacheVencida, null);
});

test('extracto: los textos largos se recortan y el total es pequeño', () => {
  const d = buildDigest(header(), [msg('user', LONG_TEXT), msg('assistant', LONG_TEXT)]);
  assert.ok(d.objetivo.length <= 1300);
  assert.ok(d.tokensAprox < 4000, `tokensAprox=${d.tokensAprox}`);
});

test('continueSession del hub: sale redactado y viene de una sesión real del fixture', () => {
  const f = makeClaudeFixture();
  const hub = createHub({ ...f, id: 'c'.repeat(64), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [] });
  const d = hub.continueSession('claude:s1');
  assert.equal(d.id, 'claude:s1');
  assert.ok(d.mensajesTotales > 0);
  assert.ok(!JSON.stringify(d).includes('API_KEY=sk'), 'sin secretos');
  assert.throws(() => hub.continueSession('claude:no-existe'), /no encontrada/);
});

test('extracto: las peticiones triviales («continue», «hola») no ocupan el lugar de las útiles', () => {
  const d = buildDigest(header(), [msg('user', 'arregla el login con Google en la pantalla de registro'), msg('assistant', 'listo'), msg('user', 'continue'), msg('user', 'hola'), msg('user', 'ahora sube la versión a las tiendas')]);
  assert.deepEqual(d.ultimasPeticiones.map((x) => x.text), ['arregla el login con Google en la pantalla de registro', 'ahora sube la versión a las tiendas']);
  assert.equal(buildDigest(header(), [msg('user', 'hola')]).ultimasPeticiones.length, 1, 'si todas son cortas, se dejan');
});

test('mapa: cada petición útil con su número de mensaje, y acotado en sesiones enormes', () => {
  const small = buildDigest(header(), [msg('user', 'primera petición larga'), msg('assistant', 'ok'), msg('user', 'continue'), msg('user', 'segunda petición larga')]);
  assert.deepEqual(small.mapa.map((x) => x.mensaje), [0, 3], 'el número es el offset de get_session');
  const many = [];
  for (let i = 0; i < 300; i++) many.push(msg('user', `petición número ${i}`), msg('assistant', `r${i}`));
  const d = buildDigest(header(), many);
  assert.equal(d.mapa.length, 120);
  assert.equal(d.mapaOmitidas, 180);
  assert.equal(d.mapa[0].mensaje, 0);
  assert.equal(d.mapa.at(-1).mensaje, 598);
  assert.ok(d.tokensAprox < 9000, `tokensAprox=${d.tokensAprox}`);
});

test('archivos: primero los del proyecto, los de fuera después y los temporales no cuentan', () => {
  const d = buildDigest(header({ filesChanged: ['/home/u/.claude/memory/x.md', '/tmp/scratch/a.py', 'src/a.js', 'docs/b.md'] }), [msg('user', 'hola')]);
  assert.deepEqual(d.archivosCambiados, ['src/a.js', 'docs/b.md', '/home/u/.claude/memory/x.md']);
});
