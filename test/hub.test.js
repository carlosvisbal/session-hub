// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccessDenied, createHub } from '../src/hub.js';
import { setExtraPatterns } from '../src/redact.js';
import { LONG_TEXT, makeClaudeFixture } from './fixtures.js';

const ANA = { id: 'a'.repeat(64), name: 'Ana' };
const PEDRO = { id: 'b'.repeat(64), name: 'Pedro' };

function setup(extra = {}) {
  const f = makeClaudeFixture();
  const cfg = { ...f, id: 'c'.repeat(64), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [], ...extra };
  return { cfg, hub: createHub(cfg) };
}

test('lectura completa: todos los mensajes y sin recortes', () => {
  const { hub } = setup();
  const s = hub.getSession('claude:s1', { lastMessages: Infinity, maxChars: 1e9, viewer: ANA });
  assert.equal(s.total, 4);
  assert.equal(s.omittedMessages, 0);
  assert.ok(s.conversation[3].text.startsWith(LONG_TEXT), 'el mensaje largo llega entero');
  assert.ok(!s.conversation.some((m) => m.truncated));
  assert.match(s.conversation[3].text, /API_KEY=\[REDACTED\]/, 'los secretos siguen ocultos');
});

test('lectura por páginas en orden', () => {
  const { hub } = setup();
  const pages = [0, 2].map((offset) => hub.getSession('claude:s1', { offset, limit: 2, maxChars: 1e9 }).conversation);
  const full = hub.getSession('claude:s1', { lastMessages: Infinity, maxChars: 1e9 }).conversation;
  assert.deepEqual(pages.flat(), full);
});

test('vista recortada marca lo recortado', () => {
  const { hub } = setup();
  const s = hub.getSession('claude:s1', { lastMessages: 1 });
  assert.equal(s.omittedMessages, 3);
  assert.ok(s.conversation[0].truncated);
});

test('permisos por clave: solo quien está en la lista', () => {
  const { cfg, hub } = setup();
  cfg.projects[0].allow = [ANA.id];
  assert.equal(hub.listSessions({ viewer: ANA }).length, 1);
  assert.equal(hub.listSessions({ viewer: PEDRO }).length, 0);
  assert.equal(hub.listSessions({ viewer: { id: 'x'.repeat(64), name: 'Ana' } }).length, 0, 'el nombre no da acceso');
  assert.throws(() => hub.getSession('claude:s1', { viewer: PEDRO }), AccessDenied);
});

test('sesión oculta y pausa', () => {
  const { cfg, hub } = setup();
  cfg.excludedSessions = ['claude:s1'];
  assert.equal(hub.listSessions({ viewer: ANA }).length, 0);
  assert.equal(hub.listSessions()[0].hidden, true, 'el dueño la ve marcada');
  cfg.excludedSessions = [];
  cfg.paused = true;
  assert.equal(hub.listSessions({ viewer: ANA }).length, 0);
  assert.equal(hub.whoami(ANA).paused, true);
});

test('qué hay nuevo sin recortes', () => {
  const { hub } = setup();
  const [s] = hub.whatChanged({ since: 'all', viewer: ANA }).sessions;
  assert.deepEqual(s.requests, ['Haz que attachments acepte una lista 📎', 'Ahora documenta el cambio']);
  assert.deepEqual(s.filesChanged, ['app/serializers.py']);
  assert.ok(s.lastAssistantMessage.length > 4000);
});

// Igual con y sin índice (SQLite FTS5): mismos permisos, mismos resultados. Sin `searchIndexFile`
// (el resto de este archivo) se prueba el barrido de siempre; aquí, las dos rutas una junto a otra.
for (const withIndex of [false, true]) {
  test(`buscar (${withIndex ? 'con índice' : 'barrido de siempre'}): encuentra, redacta y respeta permisos`, () => {
    const extra = withIndex ? { searchIndexFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-si-')), 'search.sqlite') } : {};
    const { cfg, hub } = setup(extra);
    if (withIndex) hub.syncArchive(); // indexa las sesiones en vivo (independiente del respaldo, que aquí no está configurado)

    let hits = hub.search('attachments');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, 'claude:s1');
    assert.equal(hits[0].owner, 'Carlos');
    assert.equal(hits[0].project, 'demo-api');
    assert.match(hits[0].snippet, /attachments/);

    assert.match(hub.search('API_KEY')[0].snippet, /API_KEY=\[REDACTED\]/, 'el resultado llega redactado, aunque el texto guardado no lo esté');
    if (withIndex) assert.equal(hub.search('explicacion').length, 1, 'sin tilde encuentra "Explicación" (solo el índice ignora tildes; el barrido de siempre no)');

    assert.equal(hub.search('nada-de-esto-existe-en-la-sesion').length, 0);

    // permisos: como allSessions()/getSession() — el proyecto compartido con quién, y las ocultas
    cfg.projects[0].allow = [ANA.id];
    assert.equal(hub.search('attachments', { viewer: ANA }).length, 1);
    assert.equal(hub.search('attachments', { viewer: PEDRO }).length, 0, 'proyecto no compartido con él');
    cfg.projects[0].allow = ['*'];

    cfg.excludedSessions = ['claude:s1'];
    assert.equal(hub.search('attachments', { viewer: ANA }).length, 0, 'sesión oculta para el equipo');
    assert.equal(hub.search('attachments').length, 1, 'el dueño la sigue viendo (sin viewer)');
    cfg.excludedSessions = [];

    assert.throws(() => hub.search('attachments', { project: 'no-existe', viewer: ANA }), /no compartido/);
  });
}

test('sesiones abiertas: Claude Code vivo en un proyecto compartido, respetando pausa y ocultas', () => {
  const { cfg, hub } = setup();
  const dir = path.join(path.dirname(cfg.claudeDir), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const write = (pid, sessionId, cwd, status) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, name: 'demo-api-1', status, updatedAt: Date.now() }));
  write(process.pid, 's1', cfg.project, 'busy'); // este proceso: vivo
  write(2 ** 22 + 12345, 's2', cfg.project, 'idle'); // proceso inexistente
  write(process.ppid, 's3', '/otra/carpeta', 'idle'); // vivo, pero fuera de lo compartido
  fs.writeFileSync(path.join(dir, `${process.pid}.abc.key`), 'secreto'); // nunca se lee
  const live = hub.liveAgents(ANA);
  assert.equal(live.length, 1);
  assert.deepEqual({ session: live[0].session, tool: live[0].tool, status: live[0].status, project: live[0].project, title: live[0].title }, { session: 'claude:s1', tool: 'Claude Code', status: 'busy', project: 'demo-api', title: 'Adjuntos múltiples en contactos' });
  cfg.excludedSessions.push('claude:s1');
  assert.equal(hub.liveAgents(ANA).length, 0, 'oculta al equipo');
  assert.equal(hub.liveAgents().length, 1, 'el dueño la sigue viendo');
  cfg.excludedSessions.length = 0;
  cfg.paused = true;
  assert.equal(hub.liveAgents(ANA).length, 0, 'en pausa no se ve nada');
});

// Buscar no debe servir para adivinar un secreto: ni el índice ni el barrido miran el texto sin redactar.
for (const withIndex of [false, true]) {
  test(`buscar (${withIndex ? 'con índice' : 'barrido'}): no encuentra secretos ni corta el fragmento antes de redactar`, () => {
    const extra = withIndex ? { searchIndexFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-si-')), 'search.sqlite') } : {};
    const { hub } = setup(extra);
    if (withIndex) hub.syncArchive();
    assert.deepEqual(hub.search('sk-abcdefghijklmnop1234', { viewer: ANA }), [], 'el valor de la clave no da resultados');
    assert.deepEqual(hub.search('abcdefghijklmnop', { viewer: ANA }), [], 'ni un trozo');
    for (const h of hub.search('probar', { viewer: ANA })) assert.ok(!/sk-abcdef/.test(h.snippet), h.snippet);
    if (withIndex) assert.ok(!fs.readFileSync(extra.searchIndexFile).includes('sk-abcdefghijklmnop1234'), 'el índice guarda texto ya redactado');
  });
}

test('buscar con índice: reglas extra nuevas se aplican enseguida y el índice se rehace', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-si-')), 'search.sqlite');
  const { cfg, hub } = setup({ searchIndexFile: file });
  hub.syncArchive();
  assert.equal(hub.search('attachments').length, 1);
  cfg.redactExtra = ['attachments'];
  setExtraPatterns(cfg.redactExtra); // como la recarga en caliente de server.js
  assert.equal(hub.search('attachments').length, 0, 'antes de reindexar ya no se encuentra (barrido)');
  hub.syncArchive();
  assert.equal(hub.search('attachments').length, 0, 'tras reindexar tampoco');
  assert.ok(!fs.readFileSync(file).includes('attachments acepte'), 'el texto viejo salió del índice');
  setExtraPatterns([]);
});

test('buscar con índice: una sesión que ya no existe no se devuelve y sale del índice', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-si-')), 'search.sqlite');
  const { cfg, hub } = setup({ searchIndexFile: file });
  hub.syncArchive();
  assert.equal(hub.search('attachments').length, 1);
  const dir = path.join(cfg.claudeDir, cfg.project.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.rmSync(path.join(dir, 's1.jsonl'));
  assert.equal(hub.search('attachments').length, 0, 'antes de sincronizar: se comprueba que exista');
  hub.syncArchive();
  assert.deepEqual(hub.searchIndex.ids('own', cfg.id), [], 'después: fuera del índice');
});

test('buscar con índice: las ocultas no ocupan el lugar de las visibles (filtro antes del LIMIT)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-si-')), 'search.sqlite');
  const { cfg, hub } = setup({ searchIndexFile: file });
  const dir = path.join(cfg.claudeDir, cfg.project.replace(/[^a-zA-Z0-9]/g, '-'));
  for (let i = 0; i < 20; i++) {
    const line = { cwd: cfg.project, sessionId: `h${i}`, type: 'user', timestamp: new Date(Date.UTC(2026, 8, 23, 11, i)).toISOString(), message: { role: 'user', content: 'attachments attachments attachments' } };
    fs.writeFileSync(path.join(dir, `h${i}.jsonl`), JSON.stringify(line) + '\n');
    cfg.excludedSessions.push(`claude:h${i}`);
  }
  hub.syncArchive();
  const hits = hub.search('attachments', { viewer: ANA, limit: 1 });
  assert.deepEqual(hits.map((h) => h.sessionId), ['claude:s1']);
});

test('sesiones abiertas: una subcarpeta no hereda el acceso del proyecto padre, y el nombre se redacta', () => {
  const { cfg, hub } = setup();
  const sub = path.join(cfg.project, 'privado');
  fs.mkdirSync(sub);
  cfg.projects.push({ path: sub, name: 'privado', allow: [PEDRO.id] });
  const dir = path.join(path.dirname(cfg.claudeDir), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sub1', cwd: sub, name: 'x', status: 'idle' }));
  fs.writeFileSync(path.join(dir, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: 's1', cwd: cfg.project, name: 'token=abc123secreto', status: 'idle' }));
  const live = hub.liveAgents(ANA);
  assert.deepEqual(live.map((a) => a.session), ['claude:s1'], 'la de la subcarpeta no aparece para Ana');
  assert.equal(live[0].name, 'token=[REDACTED]');
  assert.deepEqual(hub.liveAgents(PEDRO).map((a) => [a.session, a.project]).sort(), [['claude:s1', 'demo-api'], ['claude:sub1', 'privado']], 'cada una en su proyecto exacto');
});

test('archivos y rama pasan por redact() en el resumen y en qué hay nuevo', () => {
  const { cfg, hub } = setup({ redactExtra: ['serializers', 'adjuntos'] });
  setExtraPatterns(cfg.redactExtra);
  try {
    const [s] = hub.listSessions();
    assert.deepEqual(s.filesChanged, ['app/[REDACTED].py']);
    assert.equal(s.branch, 'feature/[REDACTED]');
    const [w] = hub.whatChanged({ since: 'all' }).sessions;
    assert.deepEqual(w.filesChanged, ['app/[REDACTED].py']);
    assert.equal(w.branch, 'feature/[REDACTED]');
  } finally {
    setExtraPatterns([]);
  }
});
