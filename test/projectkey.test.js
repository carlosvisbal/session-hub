// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Que dos proyectos distintos nunca se mezclen y que el mismo repo se reconozca aunque cambie el nombre.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRemote, projectKey } from '../src/projectkey.js';
import { encodeProject, listClaudeSessions } from '../src/sources/claude.js';
import { normalizeConfig } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shub-key-'));
function repo(dir, url) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return dir;
}

test('el mismo repo por https, ssh o con credenciales es el mismo proyecto', () => {
  const forms = ['https://github.com/Org/Web-App.git', 'git@github.com:org/web-app.git', 'https://ana:tok3n@github.com/org/web-app', 'ssh://git@github.com:22/org/web-app.git'];
  assert.deepEqual(new Set(forms.map(normalizeRemote)), new Set(['github.com/org/web-app']));
  const root = tmp();
  const ana = repo(path.join(root, 'ana', 'frontend'), forms[0]);
  const luis = repo(path.join(root, 'luis', 'web'), forms[1]);
  assert.equal(projectKey(ana, 'a'.repeat(64)), projectKey(luis, 'b'.repeat(64)), 'misma clave aunque la carpeta y la persona cambien');
  assert.match(projectKey(ana, 'a'.repeat(64)), /^git:[0-9a-f]{12}$/);
  assert.ok(!projectKey(ana, 'a'.repeat(64)).includes('github'), 'la URL no viaja, solo un hash');
});

test('mismo nombre pero otro repo, o sin repo: proyectos distintos', () => {
  const root = tmp();
  const a = repo(path.join(root, 'a', 'web-app'), 'git@github.com:org/web-app.git');
  const b = repo(path.join(root, 'b', 'web-app'), 'git@gitlab.com:otra/web-app.git');
  const c = path.join(root, 'c', 'web-app');
  fs.mkdirSync(c, { recursive: true });
  assert.notEqual(projectKey(a, 'a'.repeat(64)), projectKey(b, 'b'.repeat(64)));
  assert.match(projectKey(c, 'c'.repeat(64)), /^local:/);
  assert.notEqual(projectKey(c, 'c'.repeat(64)), projectKey(c, 'd'.repeat(64)), 'sin repo, la clave es de cada persona');
});

test('Claude Code: una carpeta no compartida no se cuela por tener la misma ruta codificada', () => {
  const root = tmp();
  const shared = path.join(root, 'my.app');
  const other = path.join(root, 'my-app');
  assert.equal(encodeProject(shared), encodeProject(other), 'Claude Code las guarda en la misma carpeta');
  const dir = path.join(root, 'claude', encodeProject(shared));
  fs.mkdirSync(dir, { recursive: true });
  const line = (cwd, text) => JSON.stringify({ type: 'user', cwd, sessionId: 'x', timestamp: '2026-09-24T10:00:00Z', message: { role: 'user', content: text } });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), line(shared, 'de my.app') + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), line(other, 'de my-app') + '\n');
  const got = listClaudeSessions({ claudeDir: path.join(root, 'claude') }, shared).map((s) => s.messages[0].text);
  assert.deepEqual(got, ['de my.app']);
});

test('dos carpetas con el mismo nombre visible se distinguen', () => {
  const cfg = normalizeConfig({ localToken: 't', projects: [{ path: '/x/clientes/api', name: 'api' }, { path: '/x/pagos/api', name: 'api' }, { path: '/y/pagos/api' }] });
  assert.deepEqual(cfg.projects.map((p) => p.name), ['api', 'api (pagos)', 'api (2)']);
});
