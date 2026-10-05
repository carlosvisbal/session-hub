// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Configuración: una lista de acceso vacía o inválida nunca abre un proyecto a todo el equipo, y
// la carpeta de Cursor depende del sistema.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cursorUserDirFor, normalizeAllow, normalizeConfig } from '../src/config.js';

test('allow: solo si falta se comparte con todos; vacío o inválido = solo yo', () => {
  assert.deepEqual(normalizeAllow(undefined), ['*']);
  assert.deepEqual(normalizeAllow(null), ['*']);
  assert.deepEqual(normalizeAllow([]), ['me']);
  assert.deepEqual(normalizeAllow('*'), ['me'], 'un texto suelto no es una lista');
  assert.deepEqual(normalizeAllow({}), ['me']);
  assert.deepEqual(normalizeAllow([null, 3, '']), ['me']);
  assert.deepEqual(normalizeAllow(['a'.repeat(64), 7]), ['a'.repeat(64)]);
  const cfg = normalizeConfig({ localToken: 'x', projects: [{ path: '/tmp/a', allow: [] }, { path: '/tmp/b' }, '/tmp/c'] });
  assert.deepEqual(cfg.projects.map((p) => p.allow), [['me'], ['*'], ['*']]);
});

test('carpeta de Cursor según el sistema', () => {
  assert.equal(cursorUserDirFor('linux'), path.join(os.homedir(), '.config', 'Cursor', 'User'));
  assert.equal(cursorUserDirFor('darwin'), path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User'));
  assert.match(cursorUserDirFor('win32'), /Cursor[\\/]User$/);
  assert.equal(normalizeConfig({ localToken: 'x', cursorUserDir: '/otra' }).cursorUserDir, '/otra', 'lo configurado manda');
});
