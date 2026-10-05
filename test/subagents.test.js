// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Subagentes de Claude Code y Cursor: se leen dentro de su sesión y con sus mismos permisos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listClaudeSessions } from '../src/sources/claude.js';
import { encodeCursorProject, listCursorSessions, parseStamp } from '../src/sources/cursor.js';
import { AccessDenied, createHub } from '../src/hub.js';
import { addClaudeSubagents, makeClaudeFixture, makeCursorTranscriptsFixture } from './fixtures.js';

const ANA = { id: 'a'.repeat(64), name: 'Ana' };

function setup(extra = {}) {
  const f = addClaudeSubagents(makeClaudeFixture());
  const cfg = { ...f, id: 'c'.repeat(64), owner: { name: 'Carlos', role: '' }, projects: [{ path: f.project, name: 'demo-api', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [], ...extra };
  return { f, cfg, hub: createHub(cfg) };
}

test('Claude Code: subagentes leídos de <sesión>/subagents y enlazados con la llamada que los lanzó', () => {
  const f = addClaudeSubagents(makeClaudeFixture());
  const list = listClaudeSessions(f, f.project);
  const s1 = list.find((s) => s.id === 'claude:s1');
  assert.equal(s1.subagents, undefined, 'sin subagentes, la sesión queda igual que antes');
  const s = list.find((s) => s.id === 'claude:s2');
  assert.equal(s.messages.length, 2, 'los mensajes del subagente no se mezclan con la conversación');
  assert.deepEqual(s.subagents.map((x) => [x.id, x.type, x.description, x.messages.length]), [
    ['a1b2', 'general-purpose', 'Auditar pagos', 2],
    ['zz9', 'Explore', 'Buscar usos', 2],
  ]);
  assert.deepEqual(s.messages[1].actions, [
    { kind: 'agent', target: 'Auditar pagos', ref: 'a1b2' },
    { kind: 'agent', target: 'Buscar usos', ref: 'zz9' },
  ], 'por el toolUseId del meta (a1b2) y por el agentId del resultado (zz9, herramienta "Task")');
  assert.ok(!s.subagents[0].messages.some((m) => /meta/.test(m.text)), 'líneas isMeta fuera');
  assert.equal(list.length, 2, 'los archivos de subagentes nunca salen como sesión aparte');
});

test('hub: resumen con subagentes, archivos y comandos incluidos, y lectura por "<id>/sub:<subagente>"', () => {
  const { hub } = setup();
  const s1 = hub.listSessions().find((s) => s.id === 'claude:s1');
  assert.equal('subagents' in s1, false, 'sin subagentes no aparece el campo');
  const s = hub.listSessions().find((x) => x.id === 'claude:s2');
  assert.equal(s.messages, 2);
  assert.deepEqual(s.filesChanged, ['pagos/checkout.py'], 'lo que editó el subagente cuenta para la sesión');
  assert.equal(s.commandsRun, 1);
  assert.deepEqual(s.subagents, [
    { id: 'claude:s2/sub:a1b2', type: 'general-purpose', description: 'Auditar pagos', messageCount: 2 },
    { id: 'claude:s2/sub:zz9', type: 'Explore', description: 'Buscar usos', messageCount: 2 },
  ]);

  const parent = hub.getSession('claude:s2', { lastMessages: Infinity, maxChars: 1e9, viewer: ANA });
  assert.deepEqual(parent.conversation[1].actions, [
    { kind: 'agent', target: 'Auditar pagos', subagent: 'claude:s2/sub:a1b2' },
    { kind: 'agent', target: 'Buscar usos', subagent: 'claude:s2/sub:zz9' },
  ]);

  const sub = hub.getSession('claude:s2/sub:a1b2', { lastMessages: Infinity, maxChars: 1e9, viewer: ANA });
  assert.equal(sub.id, 'claude:s2/sub:a1b2');
  assert.equal(sub.parentId, 'claude:s2');
  assert.equal(sub.title, 'Auditar pagos');
  assert.equal(sub.subagentType, 'general-purpose');
  assert.equal(sub.total, 2);
  assert.equal(sub.project, 'demo-api');
  assert.deepEqual(sub.filesChanged, ['pagos/checkout.py']);
  assert.equal(sub.subagents, undefined);
  assert.match(sub.conversation[1].text, /\[REDACTED\]/, 'el texto del subagente también pasa por redact()');
  assert.ok(!JSON.stringify(sub).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  // Paginado igual que una sesión.
  const pages = [0, 1].map((offset) => hub.getSession('claude:s2/sub:a1b2', { offset, limit: 1, maxChars: 1e9 }).conversation).flat();
  assert.deepEqual(pages, sub.conversation);
  assert.throws(() => hub.getSession('claude:s2/sub:nada', { viewer: ANA }), /no encontrada/);
});

test('hub: el subagente hereda los permisos de su sesión (oculta, pausa, proyecto no compartido)', () => {
  const { cfg, hub } = setup();
  cfg.excludedSessions = ['claude:s2'];
  assert.throws(() => hub.getSession('claude:s2/sub:a1b2', { viewer: ANA }), AccessDenied);
  assert.ok(hub.getSession('claude:s2/sub:a1b2').hidden, 'el dueño la ve, marcada como oculta');
  cfg.excludedSessions = [];
  cfg.paused = true;
  assert.throws(() => hub.getSession('claude:s2/sub:a1b2', { viewer: ANA }), AccessDenied);
  cfg.paused = false;
  cfg.projects[0].allow = ['me'];
  assert.throws(() => hub.getSession('claude:s2/sub:a1b2', { viewer: ANA }), AccessDenied);
  assert.throws(() => hub.getSession('claude:otra/sub:a1b2', { viewer: ANA }), /no encontrada/);
});

for (const withIndex of [false, true]) {
  test(`hub: buscar encuentra texto de un subagente y lleva a su sesión (${withIndex ? 'con' : 'sin'} índice)`, () => {
    const extra = withIndex ? { searchIndexFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-si-')), 'search.sqlite') } : {};
    const { cfg, hub } = setup(extra);
    if (withIndex) hub.syncArchive();
    const hits = hub.search('ornitorrinco', { viewer: ANA });
    assert.deepEqual(hits.map((h) => h.sessionId), ['claude:s2']);
    assert.ok(!hits[0].snippet.includes('ghp_abcdefghij'), 'fragmento redactado');
    assert.equal(hub.search('ghp_abcdefghijklmnop', { viewer: ANA }).length, 0, 'buscar no revela secretos tapados');
    cfg.excludedSessions = ['claude:s2'];
    assert.equal(hub.search('ornitorrinco', { viewer: ANA }).length, 0, 'sesión oculta: tampoco por sus subagentes');
  });
}

test('hub: "qué cambió" incluye lo que hicieron los subagentes', () => {
  const { hub } = setup();
  const r = hub.whatChanged({ since: '2026-09-01T00:00:00Z' });
  const s = r.sessions.find((x) => x.id === 'claude:s2');
  assert.deepEqual(s.filesChanged, ['pagos/checkout.py']);
  assert.deepEqual(s.commands, ['pytest pagos']);
  assert.deepEqual(s.requests, ['Revisa la seguridad del módulo de pagos'], 'los pedidos son solo los de la persona');
});

test('respaldo: los subagentes se guardan con su sesión y siguen legibles si el original desaparece', () => {
  const { f, hub } = setup({ archiveDir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-arch-')), 'archive') });
  hub.syncArchive();
  const dir = path.join(f.claudeDir, f.project.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.rmSync(path.join(dir, 's2.jsonl'));
  fs.rmSync(path.join(dir, 's2'), { recursive: true });
  hub.syncArchive();
  const s = hub.listSessions().find((x) => x.id === 'claude:s2');
  assert.equal(s.archived, true);
  assert.deepEqual(s.filesChanged, ['pagos/checkout.py']);
  assert.deepEqual(s.subagents.map((x) => [x.id, x.messageCount]), [['claude:s2/sub:a1b2', 2], ['claude:s2/sub:zz9', 2]]);
  const sub = hub.getSession('claude:s2/sub:zz9', { lastMessages: Infinity, viewer: ANA });
  assert.equal(sub.archived, true);
  assert.deepEqual(sub.conversation.map((m) => m.text), ['Busca usos de charge()', 'Hay 3 usos.']);
  const s1 = hub.listSessions().find((x) => x.id === 'claude:s1');
  assert.equal('subagents' in s1, false);
});

test('Cursor (.jsonl): carpeta codificada, fecha del <timestamp> y texto de <user_query>', () => {
  assert.equal(encodeCursorProject('/home/ck/Documentos/GitHub/E-commerce'), 'home-ck-Documentos-GitHub-E-commerce');
  assert.equal(encodeCursorProject('/tmp/claude-1000/-home-ck-x/cursor-probe2'), 'tmp-claude-1000-home-ck-x-cursor-probe2');
  assert.equal(new Date(parseStamp('<timestamp>Sunday, Oct 4, 2026, 8:00 PM (UTC-5)</timestamp>')).toISOString(), '2026-10-05T01:00:00.000Z');
  assert.equal(new Date(parseStamp('<timestamp>Monday, Oct 5, 2026, 12:05 AM (UTC+2)</timestamp>')).toISOString(), '2026-10-04T22:05:00.000Z');
  assert.equal(parseStamp('sin fecha'), null);

  const f = makeCursorTranscriptsFixture();
  const [s, ...rest] = listCursorSessions(f, f.project);
  assert.equal(rest.length, 0);
  assert.equal(s.id, 'cursor:k1');
  assert.equal(s.title, 'Arregla el carrito');
  assert.equal(s.createdAt, Date.parse('2026-10-05T01:00:00Z'));
  assert.deepEqual(s.messages.map((m) => [m.role, m.text]), [['user', 'Arregla el carrito'], ['assistant', 'Reviso.\n\nListo.']]);
  assert.deepEqual(s.messages[1].actions, [
    { kind: 'agent', target: 'Explorar carrito', ref: 'k1sub' },
    { kind: 'edit', target: path.join(f.project, 'cart.js') },
    { kind: 'command', target: 'npm test' },
  ], 'Read no es una edición; Task enlaza con el único subagente');
  assert.deepEqual(s.subagents.map((x) => [x.id, x.type, x.description, x.messages.length]), [['k1sub', 'explore', 'Explorar carrito', 2]]);
  assert.equal(s.subagents[0].messages[0].text, 'Explora el carrito');
});

test('Cursor (.jsonl) en el hub: resumen, subagente legible y sin base de Cursor', () => {
  const f = makeCursorTranscriptsFixture();
  const cfg = { ...f, id: 'c'.repeat(64), owner: { name: 'Carlos' }, projects: [{ path: f.project, name: 'tienda', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [] };
  const hub = createHub(cfg);
  const [s] = hub.listSessions({ viewer: ANA });
  assert.equal(s.id, 'cursor:k1');
  assert.deepEqual(s.filesChanged, ['cart.js', 'notes.md']);
  assert.equal(s.commandsRun, 1);
  assert.deepEqual(s.subagents, [{ id: 'cursor:k1/sub:k1sub', type: 'explore', description: 'Explorar carrito', messageCount: 2 }]);
  const sub = hub.getSession('cursor:k1/sub:k1sub', { lastMessages: Infinity, viewer: ANA });
  assert.equal(sub.total, 2);
  assert.deepEqual(sub.filesChanged, ['notes.md']);
  assert.deepEqual(hub.search('quetzal', { viewer: ANA }).map((h) => h.sessionId), ['cursor:k1']);
});

// Subagente con varios pasos: texto, herramientas, texto… (lo normal en uno real).
function addSteppedSubagent(f) {
  const dir = path.join(f.claudeDir, f.project.replace(/[^a-zA-Z0-9]/g, '-'));
  const t = (i) => new Date(Date.UTC(2026, 8, 23, 13, i)).toISOString();
  const base = { cwd: f.project, sessionId: 's4', isSidechain: false };
  const said = (extra, i, content) => ({ ...extra, type: 'assistant', timestamp: t(i), message: { role: 'assistant', content } });
  const text = (x) => ({ type: 'text', text: x });
  const tool = (name, input) => ({ type: 'tool_use', id: name + Math.random(), name, input });
  // La sesión principal con el mismo patrón: sigue siendo UN mensaje del asistente.
  const main = [
    { ...base, type: 'user', timestamp: t(0), message: { role: 'user', content: 'Investiga el caché' } },
    said(base, 1, [text('Primero miro.')]),
    said(base, 1, [tool('Read', { file_path: 'x' })]),
    said(base, 2, [text('Ahora lanzo un subagente.')]),
    said(base, 2, [tool('Agent', { description: 'Caché', subagent_type: 'Explore' })]),
    said(base, 9, [text('Listo.')]),
  ];
  fs.writeFileSync(path.join(dir, 's4.jsonl'), main.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const subDir = path.join(dir, 's4', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sb = { ...base, isSidechain: true, agentId: 'st1' };
  const sub = [
    { ...sb, type: 'user', timestamp: t(3), message: { role: 'user', content: 'Mira el caché' } },
    said(sb, 3, [text('Paso uno.')]),
    said(sb, 3, [tool('Grep', { pattern: 'cache' })]),
    said(sb, 4, [text('Paso dos.')]),
    said(sb, 4, [tool('Bash', { command: 'ls' })]),
    said(sb, 4, [tool('Read', { file_path: 'y' })]),
    said(sb, 5, [text('Paso tres con herramienta en la misma línea.'), tool('Bash', { command: 'pwd' })]),
    said(sb, 6, [tool('Bash', { command: 'true' })]),
    said(sb, 7, [text('Conclusión.')]),
  ];
  fs.writeFileSync(path.join(subDir, 'agent-st1.jsonl'), sub.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('Claude Code: un subagente se parte en pasos (texto + sus acciones); la sesión principal no', () => {
  const f = addSteppedSubagent(makeClaudeFixture());
  const s = listClaudeSessions(f, f.project).find((x) => x.id === 'claude:s4');
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant'], 'la principal sigue igual');
  const [sub] = s.subagents;
  assert.deepEqual(sub.messages.map((m) => [m.role, m.text, m.actions.length]), [
    ['user', 'Mira el caché', 0],
    ['assistant', 'Paso uno.', 0],
    ['assistant', 'Paso dos.', 1],
    ['assistant', 'Paso tres con herramienta en la misma línea.', 2],
    ['assistant', 'Conclusión.', 0],
  ]);
  const hub = createHub({ ...f, id: 'c'.repeat(64), owner: { name: 'Carlos', role: '' }, projects: [{ path: f.project, name: 'demo-api', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [] });
  const sum = hub.listSessions().find((x) => x.id === 'claude:s4');
  assert.equal(sum.messages, 2);
  assert.equal(sum.subagents[0].messageCount, 5, 'messageCount cuenta los pasos');
  assert.equal(hub.getSession('claude:s4/sub:st1').total, 5);
});

test('Cursor (.jsonl): subagente en pasos y archivos cambiados con Shell', () => {
  const f = makeCursorTranscriptsFixture();
  const dir = path.join(f.cursorProjectsDir, f.encoded, 'agent-transcripts', 'k2');
  const write = (file, lines) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const stamp = Date.UTC(2026, 9, 5, 1, 0); // "Oct 4, 2026, 8:00 PM (UTC-5)"
  const touch = (rel, at) => {
    const file = path.join(f.project, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at / 1000, at / 1000);
  };
  touch('src/precio.js', stamp + 30_000);
  touch('src/viejo.js', stamp - 3600_000);
  touch('src/editado.js', stamp + 30_000);
  const user = (q) => ({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Sunday, Oct 4, 2026, 8:00 PM (UTC-5)</timestamp>\n<user_query>${q}</user_query>` }] } });
  const shell = (command) => ({ type: 'tool_use', name: 'Shell', input: { command } });
  write(path.join(dir, 'k2.jsonl'), [
    user('Sube los precios'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Uso sed.' }, shell(`cd '${f.project}' && sed -i 's/1/2/' src/precio.js src/viejo.js`)] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'StrReplace', input: { path: path.join(f.project, 'src/editado.js') } }, shell("perl -pi -e 's/a/b/' src/editado.js")] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Listo.' }] } },
  ]);
  write(path.join(dir, 'subagents', 'k2sub.jsonl'), [
    user('Revisa precios'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Uno.' }, shell('ls')] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Dos.' }] } },
    { role: 'assistant', message: { content: [shell('echo hola > src/precio.js')] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Tres.' }] } },
  ]);
  const s = listCursorSessions(f, f.project).find((x) => x.id === 'cursor:k2');
  assert.equal(s.messages.length, 2, 'la conversación principal no se parte');
  assert.deepEqual(s.messages[1].actions.filter((a) => a.kind === 'edit').map((a) => [path.relative(f.project, a.target).split(path.sep).join('/'), a.via || null]), [
    ['src/precio.js', 'shell'],
    ['src/editado.js', null],
  ], 'viejo.js tiene fecha anterior; editado.js ya venía de StrReplace');
  assert.deepEqual(s.subagents[0].messages.map((m) => m.text), ['Revisa precios', 'Uno.', 'Dos.', 'Tres.']);
  assert.equal(s.subagents[0].messages[2].actions.filter((a) => a.via === 'shell').length, 1);

  const hub = createHub({ ...f, id: 'c'.repeat(64), owner: { name: 'Carlos', role: '' }, projects: [{ path: f.project, name: 'tienda', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [] });
  const sum = hub.listSessions().find((x) => x.id === 'cursor:k2');
  assert.deepEqual(sum.filesChanged, ['src/editado.js', 'src/precio.js']);
  assert.deepEqual(sum.filesByShell, ['src/precio.js']);
  assert.equal(sum.subagents[0].messageCount, 4);
});
