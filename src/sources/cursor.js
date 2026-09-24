// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Lector de conversaciones de Cursor (agente/composer).
//  - workspaceStorage/<hash>/workspace.json  -> carpeta del proyecto
//  - globalStorage/state.vscdb, tabla composerHeaders -> conversaciones por workspace
//  - cursorDiskKV 'composerData:<id>' -> orden de mensajes; 'bubbleId:<id>:<bubble>' -> cada mensaje
// La base se abre SIEMPRE en solo lectura.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { samePath } from '../util.js';

// node:sqlite existe desde Node 22.5. Si el runtime no lo trae, esta fuente queda
// desactivada y el resto del hub sigue funcionando.
let DatabaseSync = null;
export let cursorUnavailable = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  cursorUnavailable = `node:sqlite no disponible en Node ${process.versions.node} (se requiere 22.5 o superior)`;
}

const EDIT_TOOLS = new Set(['edit_file_v2', 'edit_file', 'search_replace', 'write', 'delete_file', 'apply_patch', 'multi_edit']);
const CMD_TOOLS = new Set(['run_terminal_command_v2', 'run_terminal_cmd']);

let db = null;
const cache = new Map(); // composerId -> { key, session }

function openDb(cfg) {
  if (db) return db;
  if (!DatabaseSync) throw new Error(cursorUnavailable);
  const file = path.join(cfg.cursorUserDir, 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(file)) return null;
  db = new DatabaseSync(file, { readOnly: true });
  return db;
}

function workspaceIdsFor(cfg, project) {
  const dir = path.join(cfg.cursorUserDir, 'workspaceStorage');
  if (!fs.existsSync(dir)) return [];
  const ids = [];
  for (const hash of fs.readdirSync(dir)) {
    try {
      const { folder } = JSON.parse(fs.readFileSync(path.join(dir, hash, 'workspace.json'), 'utf8'));
      // Cursor guarda una URL ("file:///c%3A/Users/…" en Windows): se convierte a ruta antes de comparar.
      if (folder?.startsWith('file:') && samePath(fileURLToPath(folder), project)) ids.push(hash);
    } catch {
      // workspace sin carpeta (ventana vacía) o remoto
    }
  }
  return ids;
}

export function listCursorSessions(cfg, project) {
  const conn = openDb(cfg);
  const ids = workspaceIdsFor(cfg, project);
  if (!conn || !ids.length) return [];
  const rows = conn
    .prepare(
      `SELECT composerId, createdAt, lastUpdatedAt, value FROM composerHeaders
       WHERE isSubagent = 0 AND workspaceId IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids);
  return rows.map((r) => readSession(conn, r, project)).filter((s) => s && s.messages.length);
}

function readSession(conn, row, project) {
  const header = safeJson(row.value) || {};
  const updatedAt = row.lastUpdatedAt || header.lastUpdatedAt || row.createdAt;
  const key = String(updatedAt);
  const hit = cache.get(row.composerId);
  if (hit?.key === key) return hit.session;

  const data = safeJson(getValue(conn, `composerData:${row.composerId}`));
  const order = data?.fullConversationHeadersOnly || [];
  const prefix = `bubbleId:${row.composerId}:`;
  const bubbles = new Map(
    conn
      .prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?')
      .all(prefix, prefix + '￿')
      .map((b) => [b.key.slice(prefix.length), b.value]),
  );

  const session = {
    id: 'cursor:' + row.composerId,
    source: 'cursor',
    project,
    title: header.name || data?.name || '(sin título)',
    branch: header.trackedGitRepos?.[0]?.branches?.[0]?.branchName || null,
    createdAt: row.createdAt,
    updatedAt,
    stats: { linesAdded: header.totalLinesAdded, linesRemoved: header.totalLinesRemoved },
    messages: [],
  };

  let current = null;
  for (const h of order) {
    const b = safeJson(bubbles.get(h.bubbleId));
    if (!b) continue;
    const at = Date.parse(h.createdAt || b.createdAt) || null;
    const text = (b.text || '').trim();

    if (b.type === 1) {
      if (!text) continue;
      current = null;
      session.messages.push({ role: 'user', at, text, actions: [] });
      continue;
    }
    if (!current) {
      current = { role: 'assistant', at, text: '', actions: [] };
      session.messages.push(current);
    }
    if (text) current.text += (current.text ? '\n\n' : '') + text;
    const tool = b.toolFormerData;
    if (!tool?.name) continue;
    const params = safeJson(tool.params) || {};
    if (EDIT_TOOLS.has(tool.name)) {
      current.actions.push({ kind: 'edit', target: params.relativeWorkspacePath || params.target_file || params.file_path || params.path });
    } else if (CMD_TOOLS.has(tool.name) && params.command) {
      current.actions.push({ kind: 'command', target: params.command });
    }
  }

  cache.set(row.composerId, { key, session });
  return session;
}

function getValue(conn, key) {
  return conn.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key)?.value;
}

function safeJson(v) {
  if (v == null) return null;
  try {
    return JSON.parse(typeof v === 'string' ? v : Buffer.from(v).toString('utf8'));
  } catch {
    return null;
  }
}
