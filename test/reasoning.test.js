// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// El razonamiento interno del modelo (bloques "thinking" / "redacted_thinking" de Claude Code, campo
// "thinking" de Cursor) nunca sale del hub: ni en get_session, ni en continue_session, ni en la
// búsqueda. Además de ser privado, si llega al contexto de otra IA, Claude bloquea la conversación.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createHub } from '../src/hub.js';
import { makeClaudeFixture, makeCursorTranscriptsFixture } from './fixtures.js';

const SECRET = 'pensamientoocultoyacare';
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const hubFor = (f, name) => createHub({ ...f, id: 'c'.repeat(64), owner: { name: 'Carlos', role: '' }, projects: [{ path: f.project, name, allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [] });

function assertHidden(hub, id) {
  const full = hub.getSession(id, { lastMessages: Infinity, maxChars: 1e9 });
  assert.ok(full.conversation.length >= 2, 'la sesión se lee');
  assert.ok(!JSON.stringify(full).includes(SECRET), 'get_session sin razonamiento');
  assert.ok(!JSON.stringify(hub.continueSession(id)).includes(SECRET), 'continue_session sin razonamiento');
  assert.ok(hub.search('revisado').length > 0, 'la búsqueda sí encuentra el texto visible');
  assert.equal(hub.search(SECRET).length, 0, 'la búsqueda no lo encuentra');
}

test('razonamiento: Claude Code (thinking y redacted_thinking) no sale del hub', () => {
  const f = makeClaudeFixture();
  const dir = path.join(f.claudeDir, f.project.replace(/[^a-zA-Z0-9]/g, '-'));
  const base = { cwd: f.project, sessionId: 'th', isSidechain: false };
  const t = (i) => new Date(Date.UTC(2026, 9, 5, 10, i)).toISOString();
  fs.writeFileSync(path.join(dir, 'th.jsonl'), jsonl([
    { ...base, type: 'user', timestamp: t(0), message: { role: 'user', content: 'Revisa el login' } },
    { ...base, type: 'assistant', timestamp: t(1), message: { role: 'assistant', content: [{ type: 'thinking', thinking: `${SECRET} primero`, signature: 'x' }] } },
    { ...base, type: 'assistant', timestamp: t(2), message: { role: 'assistant', content: [{ type: 'redacted_thinking', data: SECRET }, { type: 'text', text: 'Login revisado.' }, { type: 'thinking', thinking: SECRET }] } },
  ]));
  const hub = hubFor(f, 'demo-api');
  assertHidden(hub, 'claude:th');
  const s = hub.getSession('claude:th', { lastMessages: Infinity, maxChars: 1e9 });
  assert.equal(s.conversation.at(-1).text, 'Login revisado.', 'el texto visible sí sale');
});

test('razonamiento: transcripciones .jsonl de Cursor no lo sacan', () => {
  const f = makeCursorTranscriptsFixture();
  const file = path.join(f.cursorProjectsDir, f.encoded, 'agent-transcripts', 'k1', 'k1.jsonl');
  fs.appendFileSync(file, jsonl([
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nY el pago\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'thinking', thinking: SECRET }, { type: 'text', text: 'Pago revisado.' }] } },
  ]));
  assertHidden(hubFor(f, 'tienda'), 'cursor:k1');
});

test('razonamiento: el campo thinking de las burbujas de state.vscdb no sale', () => {
  const f = makeCursorTranscriptsFixture();
  const user = path.join(f.root, 'Cursor', 'User');
  fs.mkdirSync(path.join(user, 'workspaceStorage', 'ws1'), { recursive: true });
  fs.writeFileSync(path.join(user, 'workspaceStorage', 'ws1', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(f.project).href }));
  fs.mkdirSync(path.join(user, 'globalStorage'), { recursive: true });
  const db = new DatabaseSync(path.join(user, 'globalStorage', 'state.vscdb'));
  db.exec('CREATE TABLE composerHeaders (composerId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, value TEXT, isSubagent INTEGER, workspaceId TEXT)');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const t = (m) => Date.UTC(2026, 9, 5, 10, m);
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, ?)').run('v1', t(0), t(2), JSON.stringify({ name: 'Con razonamiento' }), 'ws1');
  const bubbles = [
    { bubbleId: 'u', type: 1, text: 'Revisa el pago' },
    { bubbleId: 'a', type: 2, text: 'Pago revisado.', thinking: { text: SECRET, signature: 'x' } },
  ];
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(k, JSON.stringify(v));
  put('composerData:v1', { fullConversationHeadersOnly: bubbles.map((b, i) => ({ bubbleId: b.bubbleId, createdAt: new Date(t(i)).toISOString() })) });
  for (const b of bubbles) put(`bubbleId:v1:${b.bubbleId}`, b);
  db.close();
  assertHidden(hubFor({ ...f, cursorUserDir: user }, 'tienda'), 'cursor:v1');
});
