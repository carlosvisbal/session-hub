// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Sesiones de Cursor con una state.vscdb sintética (misma estructura que la real, nunca datos reales).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createHub } from '../src/hub.js';

function makeCursorFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-cursor-'));
  const project = path.join(root, 'web-app');
  fs.mkdirSync(project);
  const user = path.join(root, 'Cursor', 'User');
  fs.mkdirSync(path.join(user, 'workspaceStorage', 'ws1'), { recursive: true });
  // Como la escribe Cursor: una URL (en Windows, "file:///c%3A/…").
  fs.writeFileSync(path.join(user, 'workspaceStorage', 'ws1', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(project).href.replace(/^file:\/\/\/([A-Za-z]):/, (m, d) => `file:///${d.toLowerCase()}%3A`) }));
  fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
  const file = path.join(user, 'globalStorage', 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, value TEXT, isSubagent INTEGER, workspaceId TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const t = (m) => Date.UTC(2026, 8, 24, 10, m);
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
  const addComposer = (id, name, ws = 'ws1') => {
    db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, ?)').run(id, t(0), t(3), JSON.stringify({ name, totalLinesAdded: 12, totalLinesRemoved: 3 }), ws);
    const bubbles = [
      { bubbleId: 'b1', type: 1, text: 'Agrega validación al formulario' },
      { bubbleId: 'b2', type: 2, text: 'Hecho.', toolFormerData: { name: 'edit_file_v2', params: JSON.stringify({ relativeWorkspacePath: 'src/form.tsx' }) } },
      { bubbleId: 'b3', type: 2, text: '', toolFormerData: { name: 'run_terminal_command_v2', params: JSON.stringify({ command: 'npm test' }) } },
    ];
    put(`composerData:${id}`, { fullConversationHeadersOnly: bubbles.map((b, i) => ({ bubbleId: b.bubbleId, createdAt: new Date(t(i)).toISOString() })) });
    for (const b of bubbles) put(`bubbleId:${id}:${b.bubbleId}`, b);
  };
  addComposer('c1', 'Validación del formulario');
  addComposer('c2', 'De otra carpeta', 'ws-otra');
  // Registros mal formados en otra carpeta (mal-app): no deben tumbar el listado.
  const malProject = path.join(root, 'mal-app');
  fs.mkdirSync(malProject);
  fs.mkdirSync(path.join(user, 'workspaceStorage', 'ws-mal'), { recursive: true });
  fs.writeFileSync(path.join(user, 'workspaceStorage', 'ws-mal', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(malProject).href }));
  const addRaw = (id, name, data, bubbles) => {
    db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, ?)').run(id, t(0), t(3), JSON.stringify({ name }), 'ws-mal');
    put(`composerData:${id}`, data);
    for (const b of bubbles) put(`bubbleId:${id}:${b.bubbleId}`, b);
  };
  addRaw('m1', 'orden que no es lista', { fullConversationHeadersOnly: { b1: true } }, []);
  addRaw('m2', 'entradas raras', { fullConversationHeadersOnly: [null, 5, { bubbleId: 'n' }, { bubbleId: 'x' }, { bubbleId: 'ok' }, { bubbleId: 'r' }] }, [
    { bubbleId: 'x', type: 1, text: { no: 'texto' } },
    { bubbleId: 'ok', type: 1, text: 'pedido válido' },
    { bubbleId: 'r', type: 2, text: 12, toolFormerData: { name: 'edit_file_v2', params: JSON.stringify({ relativeWorkspacePath: 7 }) } },
  ]);
  put('bubbleId:m2:n', null);

  // Subagentes (sub-app): p1 lanza ch1 con task_v2. La cabecera de ch1 tiene isSubagent = 0 (como se
  // vio en Cursor real): se reconoce porque p1 lo nombra en subagentComposerIds. ch2 sí trae la marca.
  const subProject = path.join(root, 'sub-app');
  fs.mkdirSync(subProject);
  fs.mkdirSync(path.join(user, 'workspaceStorage', 'ws-sub'), { recursive: true });
  fs.writeFileSync(path.join(user, 'workspaceStorage', 'ws-sub', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(subProject).href }));
  const header = (id, name, sub = 0) => db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?)').run(id, t(0), t(5), JSON.stringify({ name }), sub, 'ws-sub');
  const conv = (id, data, bubbles) => {
    put(`composerData:${id}`, { ...data, fullConversationHeadersOnly: bubbles.map((b, i) => ({ bubbleId: b.bubbleId, createdAt: new Date(t(i)).toISOString() })) });
    for (const b of bubbles) put(`bubbleId:${id}:${b.bubbleId}`, b);
  };
  header('p1', 'Con subagente');
  conv('p1', { subagentComposerIds: ['ch1'], subComposerIds: [] }, [
    { bubbleId: 'u', type: 1, text: 'Revisa el login' },
    { bubbleId: 'a', type: 2, text: 'Lanzo un subagente.', toolFormerData: { name: 'task_v2', toolCallId: 'call-1', params: JSON.stringify({ description: 'Explorar login', subagentType: 'explore', prompt: 'mira' }) } },
  ]);
  header('ch1', 'Explorar login');
  conv('ch1', { subagentInfo: { toolCallId: 'call-1', parentComposerId: 'p1' } }, [
    { bubbleId: 'u', type: 1, text: 'Explora el login' },
    { bubbleId: 'a', type: 2, text: 'Revisado; marcador capibara.', toolFormerData: { name: 'edit_file_v2', params: JSON.stringify({ relativeWorkspacePath: 'src/login.ts' }) } },
  ]);
  header('ch2', 'Huérfano', 1);
  conv('ch2', {}, [{ bubbleId: 'u', type: 1, text: 'subagente sin padre a la vista' }]);
  // Sin cabecera (Cursor rehace composerHeaders al arrancar), pero con sus datos en la base.
  conv('ghost', { name: 'Sin cabecera', createdAt: t(0) }, [{ bubbleId: 'u', type: 1, text: 'conversación sin cabecera' }]);
  db.close();

  // Transcripciones .jsonl de sub-app: p1 (ya en la base: no se repite), ghost (se lee de la base),
  // jonly (solo en .jsonl).
  const cursorProjectsDir = path.join(root, 'cursor-projects');
  const tdir = path.join(cursorProjectsDir, subProject.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, ''), 'agent-transcripts');
  const transcript = (id, text) => {
    fs.mkdirSync(path.join(tdir, id), { recursive: true });
    fs.writeFileSync(path.join(tdir, id, `${id}.jsonl`), [{ role: 'user', message: { content: [{ type: 'text', text: `<user_query>${text}</user_query>` }] } }, { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }].map((l) => JSON.stringify(l)).join('\n'));
  };
  transcript('p1', 'copia en jsonl de p1');
  transcript('ch1', 'copia en jsonl de ch1');
  transcript('ghost', 'copia en jsonl de ghost');
  transcript('jonly', 'solo en jsonl');
  return { root, project, malProject, subProject, cursorProjectsDir, cursorUserDir: user, claudeDir: path.join(root, 'no-claude'), dbFile: file };
}

test('Cursor: número de mensajes, archivos y comandos correctos (su campo "stats" no se confunde con el del respaldo)', () => {
  const f = makeCursorFixture();
  const cfg = { ...f, id: 'c'.repeat(64), owner: { name: 'Carlos' }, projects: [{ path: f.project, name: 'web-app', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [], archiveDir: path.join(f.root, 'archive') };
  const hub = createHub(cfg);
  const list = hub.listSessions();
  assert.equal(list.length, 1, 'solo la de esta carpeta');
  const [s] = list;
  assert.equal(s.id, 'cursor:c1');
  assert.equal(s.messages, 2, 'usuario + respuesta de la IA');
  assert.deepEqual(s.filesChanged, ['src/form.tsx']);
  assert.equal(s.commandsRun, 1);
  assert.equal(s.archived, undefined);
  const full = hub.getSession('cursor:c1', { lastMessages: Infinity, maxChars: 1e9 });
  assert.deepEqual(full.conversation[1].actions.map((a) => a.kind), ['edit', 'command']);

  // Respaldo: si el chat se borra en Cursor, sigue disponible con las mismas cifras.
  hub.syncArchive();
  assert.equal(hub.archiveStatus().sessions, 1);
  const db = new DatabaseSync(f.dbFile);
  db.exec("DELETE FROM composerHeaders WHERE composerId = 'c1'");
  db.close();
  hub.syncArchive();
  const [gone] = hub.listSessions();
  assert.equal(gone.archived, true);
  assert.equal(gone.messages, 2);
  assert.deepEqual(gone.filesChanged, ['src/form.tsx']);
  assert.equal(gone.commandsRun, 1);
  assert.equal(hub.archiveList()[0].goneSince != null, true);
});

test('rutas: misma carpeta según el sistema (Windows no distingue mayúsculas)', async () => {
  const { samePath, isInside } = await import('../src/util.js');
  const base = path.resolve(os.tmpdir(), 'Proyecto');
  assert.ok(samePath(base, base + path.sep + '.'));
  assert.ok(isInside(path.join(base, 'src'), base));
  assert.ok(!isInside(base + '-otro', base), 'prefijo de nombre no es "dentro"');
  if (process.platform === 'win32') assert.ok(samePath(base.toUpperCase(), base.toLowerCase()));
  else assert.ok(!samePath(base.toUpperCase(), base.toLowerCase()));
});

test('Cursor: registros mal formados se saltan sin tumbar el listado', async () => {
  const f = makeCursorFixture();
  const { listCursorSessions } = await import('../src/sources/cursor.js');
  const list = listCursorSessions(f, f.malProject);
  assert.deepEqual(list.map((s) => s.id), ['cursor:m2'], 'm1 queda sin mensajes; m2 conserva lo válido');
  assert.deepEqual(list[0].messages.map((m) => [m.role, m.text, m.actions.length]), [['user', 'pedido válido', 0], ['assistant', '', 0]]);
});

test('Cursor: los subagentes van dentro de su conversación, nunca como conversación aparte', async () => {
  const f = makeCursorFixture();
  const { listCursorSessions } = await import('../src/sources/cursor.js');
  const list = listCursorSessions(f, f.subProject);
  assert.deepEqual(list.map((s) => s.id).sort(), ['cursor:ghost', 'cursor:jonly', 'cursor:p1'], 'ni ch1 (sin marca) ni ch2 (con marca); p1 no se repite por su .jsonl');
  const p1 = list.find((s) => s.id === 'cursor:p1');
  assert.deepEqual(p1.subagents.map((x) => [x.id, x.type, x.description, x.messages.length]), [['ch1', 'explore', 'Explorar login', 2]]);
  assert.deepEqual(p1.messages[1].actions, [{ kind: 'agent', target: 'Explorar login', ref: 'ch1' }], 'enlazado por toolCallId');
  assert.equal(list.find((s) => s.id === 'cursor:ghost').messages[0].text, 'conversación sin cabecera', 'leída de la base, no del .jsonl');
  assert.equal(list.find((s) => s.id === 'cursor:jonly').messages[0].text, 'solo en jsonl');

  const cfg = { ...f, id: 'c'.repeat(64), owner: { name: 'Carlos' }, projects: [{ path: f.subProject, name: 'sub-app', allow: ['*'] }], excludedSessions: ['cursor:p1'], paused: false, redactExtra: [] };
  const hub = createHub(cfg);
  const owner = hub.listSessions().find((s) => s.id === 'cursor:p1');
  assert.deepEqual(owner.filesChanged, ['src/login.ts'], 'la edición del subagente cuenta para su conversación');
  assert.deepEqual(owner.subagents, [{ id: 'cursor:p1/sub:ch1', type: 'explore', description: 'Explorar login', messageCount: 2 }]);
  assert.equal(hub.getSession('cursor:p1/sub:ch1').total, 2);
  const viewer = { id: 'a'.repeat(64), name: 'Ana' };
  assert.throws(() => hub.getSession('cursor:p1/sub:ch1', { viewer }), (err) => err.code === 'denied', 'conversación oculta: su subagente también');
  assert.throws(() => hub.getSession('cursor:ch1', { viewer }), /no encontrada/, 'el subagente no existe como sesión propia');
});

// Base propia: comandos de terminal que cambian archivos y un subagente con varios pasos.
test('Cursor (base): archivos cambiados con run_terminal_command y subagente partido en pasos', async () => {
  const { listCursorSessions } = await import('../src/sources/cursor.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-cursor-shell-'));
  const project = path.join(root, 'shell-app');
  const user = path.join(root, 'Cursor', 'User');
  fs.mkdirSync(path.join(user, 'workspaceStorage', 'ws'), { recursive: true });
  fs.writeFileSync(path.join(user, 'workspaceStorage', 'ws', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(project).href }));
  fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
  const t = (m) => Date.UTC(2026, 8, 25, 10, m);
  const touch = (rel, at) => {
    const file = path.join(project, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at / 1000, at / 1000);
  };
  touch('src/x.ts', t(1) + 3000);
  touch('src/stale.ts', t(1) - 600_000);
  touch('src/y.ts', t(2) + 3000);
  touch('src/z.ts', t(4) + 3000);
  const db = new DatabaseSync(path.join(user, 'globalStorage', 'state.vscdb'));
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, value TEXT, isSubagent INTEGER, workspaceId TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
  const conv = (id, data, bubbles) => {
    put(`composerData:${id}`, { ...data, fullConversationHeadersOnly: bubbles.map((b, i) => ({ bubbleId: b.bubbleId, createdAt: new Date(t(i)).toISOString() })) });
    for (const b of bubbles) put(`bubbleId:${id}:${b.bubbleId}`, b);
  };
  const cmd = (bubbleId, text, command) => ({ bubbleId, type: 2, text, toolFormerData: { name: 'run_terminal_command_v2', params: JSON.stringify({ command }) } });
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, ?)').run('s1', t(0), t(5), JSON.stringify({ name: 'Con terminal' }), 'ws');
  conv('s1', { subagentComposerIds: ['k1'] }, [
    { bubbleId: 'u', type: 1, text: 'Cambia los tipos' },
    cmd('a', 'Con sed.', "sed -i 's/a/b/' src/x.ts src/stale.ts && rm -f src/borrado.ts && grep -n b src > /dev/null"),
    { bubbleId: 'b', type: 2, text: '', toolFormerData: { name: 'edit_file_v2', params: JSON.stringify({ relativeWorkspacePath: 'src/y.ts' }) } },
    cmd('c', '', 'cp src/x.ts src/y.ts'),
    { bubbleId: 'd', type: 2, text: 'Lanzo un subagente.', toolFormerData: { name: 'task_v2', toolCallId: 'call-k1', params: JSON.stringify({ description: 'Revisar', subagentType: 'explore' }) } },
  ]);
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, ?)').run('k1', t(0), t(5), JSON.stringify({ name: 'Revisar' }), 'ws');
  conv('k1', { subagentInfo: { toolCallId: 'call-k1', parentComposerId: 's1' } }, [
    { bubbleId: 'u', type: 1, text: 'Revisa los tipos' },
    { bubbleId: 'a', type: 2, text: 'Paso uno.' },
    cmd('b', '', 'npx tsc --noEmit'),
    { bubbleId: 'c', type: 2, text: 'Paso dos.' },
    cmd('e', '', "node -e \"require('fs').writeFileSync('src/z.ts', 'x')\""),
  ]);
  db.close();

  const f = { cursorUserDir: user, claudeDir: path.join(root, 'no-claude') };
  const [s] = listCursorSessions(f, project);
  assert.equal(s.messages.length, 2, 'la conversación principal no se parte');
  assert.deepEqual(s.messages[1].actions.filter((a) => a.kind === 'edit').map((a) => [path.relative(project, path.resolve(project, a.target)).split(path.sep).join('/'), a.via || null]), [
    ['src/x.ts', 'shell'],
    ['src/borrado.ts', 'shell'],
    ['src/y.ts', null],
  ], 'stale.ts tiene fecha anterior; y.ts una sola vez (de edit_file_v2)');
  assert.deepEqual(s.subagents[0].messages.map((m) => [m.text, m.actions.length]), [['Revisa los tipos', 0], ['Paso uno.', 1], ['Paso dos.', 2]]);

  const hub = createHub({ ...f, id: 'c'.repeat(64), owner: { name: 'Carlos' }, projects: [{ path: project, name: 'shell-app', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [] });
  const [sum] = hub.listSessions();
  assert.deepEqual(sum.filesChanged, ['src/borrado.ts', 'src/x.ts', 'src/y.ts', 'src/z.ts']);
  assert.deepEqual(sum.filesByShell, ['src/borrado.ts', 'src/x.ts', 'src/z.ts']);
  assert.equal(sum.subagents[0].messageCount, 3);
  const sub = hub.getSession('cursor:s1/sub:k1', { lastMessages: Infinity });
  assert.deepEqual(sub.filesByShell, ['src/z.ts']);
  assert.deepEqual(sub.conversation[2].actions.find((a) => a.kind === 'edit'), { kind: 'edit', target: 'src/z.ts', via: 'shell' });
});
