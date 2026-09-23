// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AccessDenied, createHub } from '../src/hub.js';
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
