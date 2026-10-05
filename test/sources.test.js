// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listClaudeSessions } from '../src/sources/claude.js';
import { createHub } from '../src/hub.js';
import { addClaudeShellSession, makeClaudeFixture } from './fixtures.js';

test('lector de Claude Code: mensajes, título, rama y acciones', () => {
  const f = makeClaudeFixture();
  const [s] = listClaudeSessions(f, f.project);
  assert.equal(s.id, 'claude:s1');
  assert.equal(s.title, 'Adjuntos múltiples en contactos');
  assert.equal(s.branch, 'feature/adjuntos');
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(s.messages[0].text, 'Haz que attachments acepte una lista 📎', 'sin el ruido del editor');
  assert.deepEqual(s.messages[1].actions.map((a) => a.kind), ['edit', 'command'], 'acciones de pasos consecutivos del asistente');
  assert.ok(!s.messages.some((m) => /subagente/.test(m.text)), 'los subagentes no se muestran');
});

test('lector de Claude Code: registros mal formados se saltan sin tumbar el listado', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const f = makeClaudeFixture();
  const dir = path.join(f.claudeDir, f.project.replace(/[^a-zA-Z0-9]/g, '-'));
  const base = { cwd: f.project, sessionId: 'bad', timestamp: '2026-09-23T12:00:00.000Z' };
  const lines = [
    'null',
    '42',
    JSON.stringify({ type: 'ai-title', aiTitle: { raro: true } }),
    JSON.stringify({ ...base, type: 'user', message: { content: [null, { type: 'text', text: 7 }, { type: 'text', text: 'pedido válido' }] } }),
    JSON.stringify({ ...base, type: 'assistant', message: { content: [null, 3, { type: 'text', text: { no: 'texto' } }, { type: 'text', text: 'respuesta' }, { type: 'tool_use', name: 'Edit', input: { file_path: 5 } }, { type: 'tool_use', name: 'Bash', input: { command: ['ls'] } }] } }),
  ];
  fs.writeFileSync(path.join(dir, 'bad.jsonl'), lines.join('\n') + '\n');
  const list = listClaudeSessions(f, f.project);
  const bad = list.find((s) => s.id === 'claude:bad');
  assert.ok(list.find((s) => s.id === 'claude:s1'), 'las demás siguen');
  assert.deepEqual(bad.messages.map((m) => m.text), ['pedido válido', 'respuesta']);
  assert.deepEqual(bad.messages[1].actions, [], 'acciones sin ruta o comando de texto: fuera');
  assert.equal(bad.title, 'pedido válido');
});

test('lector de Claude Code: archivos cambiados con comandos de terminal (via: shell)', () => {
  const f = addClaudeShellSession(makeClaudeFixture());
  const s = listClaudeSessions(f, f.project).find((x) => x.id === 'claude:s3');
  assert.equal(s.messages.length, 2, 'la sesión principal no se parte en pasos');
  const edits = s.messages[1].actions.filter((a) => a.kind === 'edit');
  const rel = (a) => path.relative(f.project, a.target).split(path.sep).join('/');
  assert.deepEqual(edits.map((a) => [rel(a), a.via || null]), [
    ['src/a.js', 'shell'],
    ['gone.js', 'shell'],
    ['src/b.js', null],
    ['src/nuevo.txt', 'shell'],
    ['src/py.js', 'shell'],
  ], 'old.js (fecha anterior), fuera del proyecto, node_modules y /dev/null no cuentan; b.js una sola vez, de Edit');
  assert.ok(edits.every((a) => path.isAbsolute(a.target)), 'rutas absolutas, como las de Edit');
  assert.equal(s.messages[1].actions.filter((a) => a.kind === 'command').length, 5, 'los comandos siguen contándose');

  const hub = createHub({ ...f, id: 'c'.repeat(64), owner: { name: 'Carlos', role: '' }, projects: [{ path: f.project, name: 'demo-api', allow: ['*'] }], excludedSessions: [], paused: false, redactExtra: [] });
  const sum = hub.listSessions().find((x) => x.id === 'claude:s3');
  assert.deepEqual(sum.filesChanged, ['gone.js', 'src/a.js', 'src/b.js', 'src/nuevo.txt', 'src/py.js']);
  assert.deepEqual(sum.filesByShell, ['gone.js', 'src/a.js', 'src/nuevo.txt', 'src/py.js'], 'solo los que no se editaron con una herramienta');
  assert.equal('filesByShell' in hub.listSessions().find((x) => x.id === 'claude:s1'), false, 'sin cambios por terminal, el campo no aparece');
  const full = hub.getSession('claude:s3', { lastMessages: Infinity, maxChars: 1e9 });
  assert.deepEqual(full.conversation[1].actions.filter((a) => a.kind === 'edit').slice(0, 3), [
    { kind: 'edit', target: 'src/a.js', via: 'shell' },
    { kind: 'edit', target: 'gone.js', via: 'shell' },
    { kind: 'edit', target: 'src/b.js' },
  ], 'getSession conserva via para que el panel las marque');
  const wc = hub.whatChanged({ since: '3650d' }).sessions.find((x) => x.id === 'claude:s3');
  assert.deepEqual(wc.filesChanged, ['gone.js', 'src/a.js', 'src/b.js', 'src/nuevo.txt', 'src/py.js']);
});
