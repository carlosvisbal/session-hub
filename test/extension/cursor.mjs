// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Cursor con varias ventanas: un solo registro MCP (Cursor descarta las cabeceras, el token va en la URL),
// sin carreras entre ventanas, y aviso + reparación cuando Claude Code quedó con un token viejo.
//   node test/extension/cursor.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeClaudeFixture } from '../fixtures.js';
import { createEditor, ok, startHubs, tmpdir } from './harness.mjs';

const home = tmpdir('shub-home-');
process.env.HOME = home; // ~/.claude.json de prueba (nunca el real)
const f = makeClaudeFixture();
const port = 7690 + Math.floor(Math.random() * 9);
let hubs;
const wins = [];
try {
  hubs = await startHubs(f, { carlos: { port, dhtPort: 49690 + (port % 10), owner: { name: 'Carlos' } } });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'session-hub': { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer token-viejo' } } } }));

  const editor = createEditor({ appName: 'Cursor', storage: path.join(f.root, 'gs'), settings: { port } });
  const S = editor.shared;
  for (let i = 0; i < 3; i++) wins.push(await editor.openWindow());
  assert.equal(S.cursorRegistry.size, 1);
  assert.match(S.cursorRegistry.get('session-hub'), /\/mcp\?token=t$/);
  assert.equal(S.cursorCalls.filter((c) => c === 'unregister').length, 1, 'solo se anula cuando la URL es nueva');
  ok(`3 ventanas de Cursor: un solo registro, con el token en la URL (${S.cursorCalls.join(', ')})`);

  const r = await fetch(S.cursorRegistry.get('session-hub'), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cursor', version: '3' } } }) });
  assert.equal(r.status, 200);
  ok('la URL registrada conecta sin cabeceras (como la usa Cursor)');

  wins.shift().close();
  assert.equal(S.cursorRegistry.size, 1);
  ok('cerrar una ventana no quita el MCP a las demás');

  assert.ok(S.notices.some((n) => /Claude Code quedó desactualizada/.test(n.m)));
  ok('avisa que Claude Code quedó con un token viejo');
  let hasCli = true;
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 8000 });
  } catch {
    hasCli = false;
  }
  await wins[0].cmds['sessionHub.copyClaudeCommand']();
  if (hasCli) {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.mcpServers['session-hub'].headers.Authorization, 'Bearer t');
    ok('"Conectar Claude Code" lo actualizó con la CLI de Claude');
  } else {
    assert.match(S.clipboard, /claude mcp add --transport http --scope user session-hub/);
    ok('sin la CLI de Claude, "Conectar Claude Code" copia el comando');
  }
  console.log('\nCURSOR OK');
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  wins.forEach((w) => w.close());
  hubs?.stop();
  await new Promise((r) => setTimeout(r, 400));
  fs.rmSync(f.root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  process.exit();
}
