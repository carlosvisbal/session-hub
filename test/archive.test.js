// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCopies, createOwnArchive } from '../src/archive.js';
import { createHub } from '../src/hub.js';
import { createSearchIndex } from '../src/searchindex.js';
import { makeClaudeFixture } from './fixtures.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shub-arch-'));
const P = { path: '/x/api', name: 'api' };
const msg = (i, text = `mensaje ${i}`) => ({ role: i % 2 ? 'assistant' : 'user', at: 1000 + i, text, actions: [] });
const session = (n, extra = {}) => ({ id: 'claude:a', source: 'claude-code', project: P.path, title: 'Adjuntos', updatedAt: 5000 + n, messages: Array.from({ length: n }, (_, i) => msg(i)), ...extra });

test('espejo: respalda, sigue lo nuevo y conserva la versión previa si la sesión se acorta', () => {
  const dir = tmp();
  const a = createOwnArchive({ dir });
  a.sync([P], () => ({ ok: true, sessions: [session(3)] }));
  assert.equal(a.meta('claude:a').stats.count, 3);
  a.sync([P], () => ({ ok: true, sessions: [session(5)] }));
  assert.equal(a.meta('claude:a').stats.count, 5, 'mensajes nuevos');
  const edited = session(5);
  edited.messages[4] = msg(4, 'texto que la IA siguió escribiendo');
  a.sync([P], () => ({ ok: true, sessions: [edited] }));
  assert.equal(a.goneFor(P.path, null, new Set()).length, 1);
  assert.equal(a.goneFor(P.path, null, new Set())[0].messages[4].text, 'texto que la IA siguió escribiendo', 'el último mensaje se actualiza');
  a.sync([P], () => ({ ok: true, sessions: [session(2)] }));
  assert.equal(a.meta('claude:a').stats.count, 2, 'refleja la restauración');
  assert.ok(fs.existsSync(path.join(dir, 'own', 'claude_a.prev.json.gz')), 'guarda la versión anterior');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'own', a.meta('claude:a').file)).mode & 0o777, 0o600);
});

test('si una fuente falla no se marca nada como borrado; si desaparece de verdad, queda en el respaldo', () => {
  const a = createOwnArchive({ dir: tmp() });
  a.sync([P], () => ({ ok: true, sessions: [session(4)] }));
  a.sync([P], () => ({ ok: false, sessions: [] }));
  assert.equal(a.isGone('claude:a'), false, 'error de lectura ≠ borrado');
  a.sync([P], () => ({ ok: true, sessions: [] }));
  assert.equal(a.isGone('claude:a'), true);
  const [gone] = a.goneFor(P.path, null, new Set());
  assert.equal(gone.messages.length, 4, 'se sirve entera desde el respaldo');
  a.sync([P], () => ({ ok: true, sessions: [session(4)] }));
  assert.equal(a.isGone('claude:a'), false, 'si vuelve a aparecer, deja de estar "solo en respaldo"');
});

test('retención, límite de tamaño y archivo dañado', () => {
  const dir = tmp();
  const a = createOwnArchive({ dir });
  a.sync([P], () => ({ ok: true, sessions: [session(3, { updatedAt: Date.now() - 400 * 86400e3 })] }));
  a.sync([P], () => ({ ok: true, sessions: [] }));
  a.meta('claude:a').goneSince = new Date(Date.now() - 400 * 86400e3).toISOString();
  a.sync([P], () => ({ ok: true, sessions: [] }), { retentionDays: 365 });
  assert.equal(a.has('claude:a'), false, 'vencida: se borra');

  a.sync([P], () => ({ ok: true, sessions: [session(3), { ...session(2), id: 'claude:b' }] }));
  a.sync([P], () => ({ ok: true, sessions: [] }));
  assert.equal(a.trimTo(1), 2, 'por tamaño se borran primero las que solo están en el respaldo');

  a.sync([P], () => ({ ok: true, sessions: [session(3)] }));
  a.sync([P], () => ({ ok: true, sessions: [] }));
  fs.writeFileSync(path.join(dir, 'own', a.meta('claude:a').file), 'dañado');
  const b = createOwnArchive({ dir }); // al reabrir, sin caché
  assert.deepEqual(b.goneFor(P.path, null, new Set())[0].messages, [], 'un archivo dañado no rompe nada');
  assert.equal(b.has('claude:a'), false, 'se descarta para volver a respaldarlo');
});

test('el hub sirve lo que ya solo está en el respaldo, con los mismos permisos', () => {
  const f = makeClaudeFixture();
  const cfg = { ...f, id: 'c'.repeat(64), owner: { name: 'Carlos' }, projects: [{ path: f.project, name: 'demo-api', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [], archiveDir: path.join(f.root, 'archive') };
  const hub = createHub(cfg);
  hub.syncArchive();
  const file = fs.readdirSync(path.join(f.claudeDir, fs.readdirSync(f.claudeDir)[0]))[0];
  fs.rmSync(path.join(f.claudeDir, fs.readdirSync(f.claudeDir)[0], file)); // Claude Code la borró (30 días)
  hub.syncArchive();
  const ANA = { id: 'a'.repeat(64), name: 'Ana' };
  const [s] = hub.listSessions({ viewer: ANA });
  assert.equal(s.archived, true);
  assert.equal(s.messages, 4);
  assert.equal(hub.getSession('claude:s1', { lastMessages: Infinity, maxChars: 1e9, viewer: ANA }).conversation.length, 4);
  assert.match(hub.getSession('claude:s1', { lastMessages: Infinity, maxChars: 1e9, viewer: ANA }).conversation[3].text, /\[REDACTED\]/, 'redactado igual');
  cfg.excludedSessions.push('claude:s1');
  assert.equal(hub.listSessions({ viewer: ANA }).length, 0, 'oculta: tampoco desde el respaldo');
  assert.equal(hub.listSessions().length, 1, 'yo la sigo viendo');
  assert.deepEqual(hub.copyStatus(['claude:s1', 'claude:nada'], ANA), { 'claude:s1': 'withdrawn', 'claude:nada': 'gone' });
  cfg.excludedSessions.length = 0;
  cfg.projects[0].allow = ['me']; // "Solo yo": respaldo sin compartir
  assert.equal(hub.listSessions({ viewer: ANA }).length, 0);
  assert.equal(hub.listSessions().length, 1);
  assert.throws(() => hub.removeArchived('claude:otra'), /no está en tu respaldo/);
  hub.removeArchived('claude:s1');
  assert.equal(hub.listSessions().length, 0, 'borrada del respaldo a pedido');
});

test('índice de búsqueda: sigue una sesión que pasa de viva a solo-respaldo, y se borra si se borra del respaldo', () => {
  const f = makeClaudeFixture();
  const cfg = { ...f, id: 'c'.repeat(64), owner: { name: 'Carlos' }, projects: [{ path: f.project, name: 'demo-api', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [], archiveDir: path.join(f.root, 'archive'), searchIndexFile: path.join(f.root, 'search.sqlite') };
  const hub = createHub(cfg);
  hub.syncArchive(); // indexa la sesión en vivo
  assert.equal(hub.search('attachments').length, 1);

  const dirName = fs.readdirSync(f.claudeDir)[0];
  const file = fs.readdirSync(path.join(f.claudeDir, dirName))[0];
  fs.rmSync(path.join(f.claudeDir, dirName, file)); // Claude Code la borró
  hub.syncArchive(); // ahora solo está en el respaldo; el índice la debe seguir encontrando
  const hits = hub.search('attachments');
  assert.equal(hits.length, 1, 'se sigue encontrando cuando ya solo vive en el respaldo');
  assert.equal(hits[0].sessionId, 'claude:s1');

  hub.removeArchived('claude:s1');
  assert.deepEqual(hub.search('attachments'), [], 'al borrarla del respaldo, deja de aparecer en la búsqueda');
});

test('copias: guardar, leer por partes, borrar a mano (sin volver a copiar) y vencer', () => {
  const c = createCopies({ dir: tmp() });
  const O = 'b'.repeat(64);
  const conv = Array.from({ length: 5 }, (_, i) => ({ role: 'user', at: new Date(1e12 + i).toISOString(), text: `t${i} firma`, actions: [] }));
  c.setOwner(O, { name: 'Ana', allowCopies: true });
  c.put(O, { id: 'cursor:x', title: 'Login', project: 'web', projectKey: 'git:1', owner: 'Ana', ownerId: O, updatedAt: new Date().toISOString(), messages: 5 }, conv);
  assert.equal(c.listSessions(O)[0].copy.status, 'ok');
  assert.deepEqual(c.getSession(O, 'cursor:x', { offset: 3 }).conversation.map((x) => x.text), ['t3 firma', 't4 firma']);
  assert.equal(c.search(O, 'FIRMA').length, 5);
  assert.equal(c.listSessions(O, { project: 'git:1' }).length, 1, 'filtra también por projectKey');
  c.remove(O, 'cursor:x', { ignore: true });
  assert.equal(c.isIgnored(O, 'cursor:x'), true);
  c.put(O, { id: 'cursor:y', updatedAt: new Date().toISOString(), messages: 5 }, conv);
  c.touch(O, 'cursor:y', { verifiedAt: new Date(Date.now() - 200 * 86400e3).toISOString() });
  assert.equal(c.prune(180), 1, 'sin confirmación del dueño en el plazo: se borra');
  c.put(O, { id: 'cursor:z', updatedAt: new Date().toISOString(), messages: 5 }, conv);
  assert.equal(c.purgeOwner(O), 1);
  assert.equal(c.has(O), false);
});

test('copias con índice: mismo resultado que el barrido, sin mezclar compañeros, y limpio al borrar', () => {
  const searchIndex = createSearchIndex({ file: path.join(tmp(), 'search.sqlite') });
  const c = createCopies({ dir: tmp(), searchIndex });
  const ANA = 'a'.repeat(64);
  const LUIS = 'b'.repeat(64);
  const conv = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', at: new Date(1e12 + i).toISOString(), text: `t${i} firma-de-contratos`, actions: [] }));
  c.setOwner(ANA, { name: 'Ana', allowCopies: true });
  c.setOwner(LUIS, { name: 'Luis', allowCopies: true });
  c.put(ANA, { id: 'cursor:x', title: 'Login', project: 'web', projectKey: 'git:1', owner: 'Ana', ownerId: ANA, updatedAt: new Date().toISOString(), messages: 5 }, conv(5));
  // muchos mensajes de Luis con el mismo término: Ana no debe perderse entre ellos (ver searchindex.test.js)
  for (let i = 0; i < 40; i++) c.put(LUIS, { id: `cursor:luis${i}`, title: 'Ruido', project: 'otro', projectKey: 'git:2', owner: 'Luis', ownerId: LUIS, updatedAt: new Date().toISOString(), messages: 5 }, conv(5));

  const hits = c.search(ANA, 'FIRMA-DE-CONTRATOS');
  assert.equal(hits.length, 5, 'las 5 de Ana, ninguna de Luis');
  assert.ok(hits.every((h) => h.ownerId === ANA));
  assert.equal(c.search(ANA, 'firma-de-contratos', { project: 'git:1' }).length, 5, 'filtra por projectKey');
  assert.equal(c.search(ANA, 'firma-de-contratos', { project: 'no-existe' }).length, 0);
  assert.equal(c.search(LUIS, 'firma-de-contratos').length, 40 * 5);

  c.remove(ANA, 'cursor:x', { ignore: true });
  assert.deepEqual(c.search(ANA, 'firma-de-contratos'), [], 'borrada a mano: ya no aparece');

  assert.equal(c.purgeOwner(LUIS), 40);
  assert.deepEqual(c.search(LUIS, 'firma-de-contratos'), [], 'purgeOwner también limpia el índice');
  searchIndex.close();
});

test('respaldo dañado: también sale del índice de búsqueda (solo mi fila, no la copia de otro)', () => {
  const dir = tmp();
  const searchIndex = createSearchIndex({ file: path.join(tmp(), 'search.sqlite') });
  const ME = 'c'.repeat(64);
  const a = createOwnArchive({ dir, searchIndex, ownerId: () => ME });
  const P = { path: '/p' };
  const msgs = [{ role: 'user', at: 1, text: 'firma digital', actions: [] }];
  a.sync([P], () => ({ ok: true, sessions: [{ id: 'claude:a', source: 'claude-code', project: '/p', title: 't', updatedAt: 1, messages: msgs }] }));
  searchIndex.indexSession({ id: 'claude:a', scope: 'own', ownerId: ME, source: 'claude-code', project: '/p', title: 't', updatedAt: 1, messages: msgs });
  searchIndex.indexSession({ id: 'claude:a', scope: 'copy', ownerId: 'ana', source: 'claude-code', project: '/p', title: 't', updatedAt: 1, messages: msgs });
  fs.writeFileSync(path.join(dir, 'own', a.meta('claude:a').file), 'dañado');
  const b = createOwnArchive({ dir, searchIndex, ownerId: () => ME });
  assert.deepEqual(b.goneFor('/p', null, new Set())[0].messages, []);
  assert.deepEqual(searchIndex.ids('own', ME), [], 'mi fila salió del índice');
  assert.deepEqual(searchIndex.ids('copy', 'ana'), ['claude:a'], 'la copia de Ana sigue');
  searchIndex.close();
});
