// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Sesiones de Cursor con una state.vscdb sintética (misma estructura que la real, nunca datos reales).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHub } from '../src/hub.js';

function makeCursorFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-cursor-'));
  const project = path.join(root, 'web-app');
  fs.mkdirSync(project);
  const user = path.join(root, 'Cursor', 'User');
  fs.mkdirSync(path.join(user, 'workspaceStorage', 'ws1'), { recursive: true });
  fs.writeFileSync(path.join(user, 'workspaceStorage', 'ws1', 'workspace.json'), JSON.stringify({ folder: `file://${project}` }));
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
  db.close();
  return { root, project, cursorUserDir: user, claudeDir: path.join(root, 'no-claude'), dbFile: file };
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
