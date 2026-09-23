// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import { listClaudeSessions } from '../src/sources/claude.js';
import { makeClaudeFixture } from './fixtures.js';

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
