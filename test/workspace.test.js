// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Proyecto actual: qué es "mi proyecto", qué es otro y qué se llama igual pero es otro.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectKey } from '../src/projectkey.js';
import { annotate, cleanFolders, relationOf, sameName, workspaceContext } from '../src/workspace.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shub-ws-'));
const repo = (dir, origin) => {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
  return dir;
};

test('vínculo manual: misma clave con el mismo nombre de vínculo, aunque no haya git', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'b-'));
  assert.notEqual(projectKey(a, 'ana'), projectKey(b, 'carlos'), 'sin vínculo: claves locales distintas');
  assert.equal(projectKey(a, 'ana', 'Acme API'), projectKey(b, 'carlos', ' acme-api '));
  assert.match(projectKey(a, 'ana', 'acme-api'), /^link:[0-9a-f]{12}$/);
  assert.notEqual(projectKey(a, 'ana', 'acme-api'), projectKey(a, 'ana', 'otro'));
});

test('carpetas: solo absolutas y existentes, sin repetir', () => {
  const d = tmp();
  assert.deepEqual(cleanFolders([d, d, 'relativa', '/no/existe/xyz', 42, null, '']), [d]);
});

test('relación: proyecto actual, otro con el mismo nombre, otro', () => {
  const root = tmp();
  const mine = repo(path.join(root, 'frontend-copy'), 'git@github.com:acme/demo-api.git');
  const keyOf = (dir) => projectKey(dir, 'ana');
  const ctx = workspaceContext([mine], { keyOf });
  assert.equal(ctx.folders[0].git, true);
  const sameRepo = { project: 'demo-api', projectKey: projectKey(repo(path.join(root, 'x', 'demo-api'), 'https://github.com/acme/demo-api'), 'carlos') };
  const otherRepoSameName = { project: 'Frontend_Copy', projectKey: 'git:000000000000' };
  const other = { project: 'pagos', projectKey: 'git:111111111111' };
  assert.equal(relationOf(sameRepo, ctx), 'current');
  assert.equal(relationOf(otherRepoSameName, ctx), 'same-name');
  assert.equal(relationOf(other, ctx), 'other');
  assert.equal(relationOf(other, workspaceContext([], { keyOf })), null, 'sin carpeta conocida no se marca nada');
  assert.equal(sameName('Mi-Ápp'), sameName('mi_app'));
});

test('annotate: marca en listas y objetos anidados, y filtra si se pide', () => {
  const root = tmp();
  const mine = repo(path.join(root, 'api'), 'git@github.com:acme/api.git');
  const ctx = workspaceContext([mine], { keyOf: (d) => projectKey(d, 'ana') });
  const cur = { project: 'api', projectKey: ctx.folders[0].projectKey };
  const data = [{ member: 'Carlos', data: { sessions: [cur, { project: 'api', projectKey: 'git:x' }, { project: 'web', projectKey: 'git:y' }] } }];
  const all = annotate(data, ctx);
  assert.deepEqual(all.value[0].data.sessions.map((s) => s.relacion), ['current', 'same-name', 'other']);
  assert.deepEqual(all.stats, { current: 1, 'same-name': 1, other: 1 });
  const only = annotate(data, ctx, { onlyCurrent: true });
  assert.equal(only.value[0].data.sessions.length, 1);
  assert.equal(only.value[0].member, 'Carlos', 'lo que no tiene projectKey se conserva');
});
