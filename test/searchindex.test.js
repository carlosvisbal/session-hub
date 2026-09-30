// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Índice de búsqueda (SQLite FTS5): indexar, no repetir trabajo si nada cambió, encontrar sin
// tildes ni mayúsculas, no explotar con puntuación o palabras reservadas de FTS5, y separar bien
// varios dueños (uno con pocos mensajes no debe perderse entre los de otro con muchos).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchIndex } from '../src/searchindex.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-si-')), 'search.sqlite');
const msg = (text, extra = {}) => ({ role: 'user', text, at: '2026-01-01T00:00:00.000Z', ...extra });

test('sin archivo: desactivado, sin lanzar', () => {
  assert.equal(createSearchIndex({}), null);
  assert.equal(createSearchIndex({ file: '' }), null);
});

test('crea el archivo con permisos 0600', () => {
  const file = tmp();
  const idx = createSearchIndex({ file });
  assert.equal(idx.available, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  idx.close();
});

test('indexar, buscar, y no reindexar si el contenido no cambió', () => {
  const idx = createSearchIndex({ file: tmp() });
  const s = { id: 's1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 'Firmas', updatedAt: '2026-01-02', messages: [msg('el endpoint de firmas cambió de formato')] };
  assert.equal(idx.indexSession(s), true, 'primera vez: indexa');
  assert.equal(idx.indexSession(s), false, 'mismos mensajes: no hace nada');
  assert.equal(idx.search('firmas').length, 1);
  assert.equal(idx.indexSession({ ...s, messages: [msg('otro texto totalmente distinto')] }), true, 'mensajes nuevos: reindexa');
  assert.deepEqual(idx.search('firmas'), [], 'lo anterior ya no está');
  assert.equal(idx.search('distinto').length, 1);
  idx.close();
});

test('ignora tildes y mayúsculas (unicode61 remove_diacritics)', () => {
  const idx = createSearchIndex({ file: tmp() });
  idx.indexSession({ id: 's1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('Explicación detallada con tildes y eñes')] });
  assert.equal(idx.search('explicacion').length, 1, 'sin tilde encuentra con tilde');
  assert.equal(idx.search('EXPLICACIÓN').length, 1, 'mayúsculas no importan');
  idx.close();
});

test('busca por prefijo (como el substring de antes, para lo más común: el final de la palabra)', () => {
  const idx = createSearchIndex({ file: tmp() });
  idx.indexSession({ id: 's1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('revisa el endpoint de pagos')] });
  assert.equal(idx.search('endp').length, 1);
  idx.close();
});

test('puntuación y palabras reservadas de FTS5 no rompen la búsqueda', () => {
  const idx = createSearchIndex({ file: tmp() });
  idx.indexSession({ id: 's1', scope: 'own', ownerId: 'me', source: 'cursor', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('cambia user-service.py y api.md, revisa (x) -- y')] });
  for (const q of ['user-service.py', 'api.md', 'OR NOT NEAR(', '"comillas" sueltas', '*', '()--']) assert.doesNotThrow(() => idx.search(q), q);
  assert.equal(idx.search('user-service.py').length, 1);
  idx.close();
});

test('consultas cortas o vacías: sin resultados, sin error', () => {
  const idx = createSearchIndex({ file: tmp() });
  idx.indexSession({ id: 's1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('algo')] });
  assert.deepEqual(idx.search(''), []);
  assert.deepEqual(idx.search('a'), [], 'un solo carácter no busca (igual que search_sessions, min 2)');
  idx.close();
});

test('quitar una sesión: deja de encontrarse', () => {
  const idx = createSearchIndex({ file: tmp() });
  idx.indexSession({ id: 's1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('el secreto del proyecto')] });
  assert.equal(idx.search('secreto').length, 1);
  idx.removeSession('s1');
  assert.deepEqual(idx.search('secreto'), []);
  idx.close();
});

test('exists(): descarta resultados sin borrar nada del índice', () => {
  const idx = createSearchIndex({ file: tmp() });
  idx.indexSession({ id: 's1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('el endpoint de firmas')] });
  assert.deepEqual(idx.search('endpoint', { exists: () => false }), []);
  assert.equal(idx.search('endpoint', { exists: () => true }).length, 1, 'sigue en el índice');
  idx.close();
});

test('scope/ownerId filtran en la propia consulta, no solo después (varios dueños)', () => {
  const idx = createSearchIndex({ file: tmp() });
  for (let i = 0; i < 60; i++) {
    idx.indexSession({ id: `ruido${i}`, scope: 'copy', ownerId: 'ruidoso', source: 'cursor', project: '/x', title: 't', updatedAt: '2026-01-01', messages: [msg('palabra-clave-compartida '.repeat(4))] });
  }
  idx.indexSession({ id: 'target', scope: 'copy', ownerId: 'poquito', source: 'cursor', project: '/y', title: 't', updatedAt: '2026-01-01', messages: [msg('una sola mención de palabra-clave-compartida')] });
  idx.indexSession({ id: 'own1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/z', title: 't', updatedAt: '2026-01-01', messages: [msg('palabra-clave-compartida en lo mío')] });

  const forPoquito = idx.search('palabra-clave-compartida', { scope: 'copy', ownerId: 'poquito', limit: 10 });
  assert.equal(forPoquito.length, 1, 'no se pierde entre las 60 de "ruidoso"');
  assert.equal(forPoquito[0].sessionId, 'target');

  const forOwn = idx.search('palabra-clave-compartida', { scope: 'own', ownerId: 'me' });
  assert.equal(forOwn.length, 1);
  assert.equal(forOwn[0].sessionId, 'own1');
  idx.close();
});

test('resultados ordenados por relevancia (BM25), no por orden de inserción', () => {
  const idx = createSearchIndex({ file: tmp() });
  idx.indexSession({ id: 'poco', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('un texto largo donde aparece firma una sola vez entre mucho relleno que no aporta nada '.repeat(6))] });
  idx.indexSession({ id: 'mucho', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('firma firma firma')] });
  const r = idx.search('firma');
  assert.equal(r.length, 2);
  assert.equal(r[0].sessionId, 'mucho', 'el texto corto y denso en el término va primero');
  idx.close();
});

test('vuelve a abrir el mismo archivo y sigue ahí (persistencia real, no en memoria)', () => {
  const file = tmp();
  createSearchIndex({ file }).indexSession({ id: 's1', scope: 'own', ownerId: 'me', source: 'claude-code', project: '/p', title: 't', updatedAt: '2026-01-01', messages: [msg('persistente')] });
  const idx2 = createSearchIndex({ file });
  assert.equal(idx2.search('persistente').length, 1);
  idx2.close();
});
