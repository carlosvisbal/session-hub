// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCopies, createOwnArchive } from '../src/archive.js';
import { createHub } from '../src/hub.js';
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
