// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Lector de conversaciones de Cursor (agente/composer).
//  - workspaceStorage/<hash>/workspace.json  -> carpeta del proyecto
//  - globalStorage/state.vscdb, tabla composerHeaders -> conversaciones por workspace
//  - cursorDiskKV 'composerData:<id>' -> orden de mensajes; 'bubbleId:<id>:<bubble>' -> cada mensaje
//  - ~/.cursor/projects/<carpeta>/agent-transcripts/ -> complemento en .jsonl (ver listCursorSessions)
// La base se abre SIEMPRE en solo lectura.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { samePath } from '../util.js';
import { resolveShellWrites } from '../shellwrites.js';

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
const AGENT_TOOLS = new Set(['task_v2', 'task']); // lanza un subagente

let db = null;
let dbFile = null;
const cache = new Map(); // "<base>|<composerId>" -> { key, session, childIds }

function openDb(cfg) {
  const file = path.join(cfg.cursorUserDir, 'globalStorage', 'state.vscdb');
  if (db && dbFile === file) return db;
  if (!DatabaseSync) throw new Error(cursorUnavailable);
  if (!fs.existsSync(file)) return null;
  if (db) {
    try {
      db.close(); // otra carpeta de Cursor (pruebas o configuración cambiada)
    } catch {}
  }
  db = new DatabaseSync(file, { readOnly: true });
  dbFile = file;
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

// Dos orígenes, sin repetir nunca una conversación:
//  1. state.vscdb (lo de siempre, el más completo).
//  2. ~/.cursor/projects/<carpeta codificada>/agent-transcripts/<id>/<id>.jsonl, como complemento:
//     conversaciones que la base no lista (Cursor rehace composerHeaders al arrancar y a veces
//     faltan las viejas) o todas, si la base no se puede abrir (sin node:sqlite).
// Los subagentes nunca salen como conversación aparte: van dentro de la que los lanzó (`subagents`).
// Si la base falla, el error lleva lo leído de los .jsonl en `err.sessions` (el hub lo usa sin dar
// por borrado lo que no pudo leer).
export function listCursorSessions(cfg, project) {
  let conn = null;
  let fromDb = [];
  const known = new Set(); // ids (sin prefijo) ya cubiertos por la base, incluidos los subagentes
  let dbError = null;
  try {
    conn = openDb(cfg);
    if (conn) fromDb = listFromDb(conn, cfg, project, known);
  } catch (err) {
    dbError = err;
    conn = null;
  }
  const fromFiles = listFromTranscripts(cfg, project, known, conn);
  if (dbError && !cursorUnavailable) {
    dbError.sessions = fromFiles;
    throw dbError;
  }
  return [...fromDb, ...fromFiles];
}

function listFromDb(conn, cfg, project, known) {
  const ids = workspaceIdsFor(cfg, project);
  if (!ids.length) return [];
  const rows = conn
    .prepare(
      `SELECT composerId, createdAt, lastUpdatedAt, value, isSubagent FROM composerHeaders
       WHERE workspaceId IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids);
  // Un subagente se reconoce por su propia cabecera (isSubagent, subagentInfo) o porque otra
  // conversación lo nombra en subagentComposerIds (la marca no siempre está puesta).
  const children = new Set();
  const parents = [];
  for (const r of rows) {
    const header = safeJson(r.value) || {};
    if (r.isSubagent || header.subagentInfo) children.add(r.composerId);
    else parents.push({ row: r, header });
  }
  const sessions = parents.map(({ row, header }) => {
    const s = readSession(conn, row, header, project);
    for (const c of s?.childIds || []) children.add(c);
    return s;
  });
  for (const r of rows) known.add(r.composerId);
  for (const c of children) known.add(c);
  return sessions.filter((s) => s && !children.has(s.composerId) && s.session.messages.length).map((s) => s.session);
}

// Conversación de la base (con sus subagentes). Devuelve { session, composerId, childIds }.
function readSession(conn, row, header, project) {
  const updatedAt = row.lastUpdatedAt || header.lastUpdatedAt || row.createdAt;
  const ck = `${dbFile}|${row.composerId}`;
  const hit = cache.get(ck);
  // Un subagente avanza en sus propias burbujas: cuántas tiene cada uno también cuenta para la caché.
  const keyOf = (childIds) => [String(updatedAt), ...childIds.map((c) => `${c}:${countBubbles(conn, c)}`)].join('|');
  if (hit && hit.key === keyOf(hit.childIds)) return hit;

  const data = safeJson(getValue(conn, `composerData:${row.composerId}`));
  const spawned = new Map(); // toolCallId -> acción 'agent'
  const statCache = new Map(); // stat de los archivos que tocaron los comandos, una vez por ruta
  const session = {
    id: 'cursor:' + row.composerId,
    source: 'cursor',
    project,
    title: str(header.name) || str(data?.name) || '(sin título)',
    branch: header.trackedGitRepos?.[0]?.branches?.[0]?.branchName || null,
    createdAt: row.createdAt,
    updatedAt,
    stats: { linesAdded: header.totalLinesAdded, linesRemoved: header.totalLinesRemoved },
    messages: readBubbles(conn, row.composerId, data, spawned, { project, statCache }),
  };

  const childIds = (Array.isArray(data?.subagentComposerIds) ? data.subagentComposerIds : []).filter((c) => typeof c === 'string' && c && c !== row.composerId);
  const subagents = [];
  for (const c of childIds) {
    const cdata = safeJson(getValue(conn, `composerData:${c}`));
    const crow = conn.prepare('SELECT * FROM composerHeaders WHERE composerId = ?').get(c); // subagentTypeName no existe en versiones viejas
    const cheader = safeJson(crow?.value) || {};
    const info = (cdata?.subagentInfo && typeof cdata.subagentInfo === 'object' ? cdata.subagentInfo : null) || cheader.subagentInfo || {};
    const messages = readBubbles(conn, c, cdata, null, { project, statCache, steps: true });
    if (!messages.length) continue;
    // Enlace con la llamada task_v2 del padre por su toolCallId.
    const action = spawned.get(str(info.toolCallId));
    if (action) action.ref = c;
    const at = messages.map((m) => m.at).filter(Boolean);
    subagents.push({
      id: c,
      type: str(crow?.subagentTypeName) || str(info.subagentTypeName) || action?.subagentType || null,
      description: action?.description || str(cheader.name) || str(cdata?.name) || null,
      startedAt: crow?.createdAt || cdata?.createdAt || at[0] || null,
      updatedAt: crow?.lastUpdatedAt || at[at.length - 1] || null,
      messages,
    });
  }
  for (const a of spawned.values()) delete a.subagentType, delete a.description; // solo servían para enlazar
  if (subagents.length) session.subagents = subagents;

  const out = { key: keyOf(childIds), session, composerId: row.composerId, childIds };
  cache.set(ck, out);
  return out;
}

// Mensajes de una conversación a partir de sus burbujas. spawned: toolCallId -> acción 'agent'.
// steps (subagentes): cada texto del asistente con las acciones que le siguen es un mensaje aparte,
// en lugar de juntar todo lo que hay entre dos mensajes humanos.
function readBubbles(conn, composerId, data, spawned, { project = null, statCache = new Map(), steps = false } = {}) {
  const order = Array.isArray(data?.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  const prefix = `bubbleId:${composerId}:`;
  const bubbles = new Map(
    conn
      .prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?')
      .all(prefix, prefix + '￿')
      .map((b) => [b.key.slice(prefix.length), b.value]),
  );
  const messages = [];
  let current = null;
  for (const h of order) {
    if (!h || typeof h !== 'object') continue; // entrada mal formada: se salta, no tumba el listado
    const b = safeJson(bubbles.get(h.bubbleId));
    if (!b || typeof b !== 'object') continue;
    const at = Date.parse(h.createdAt || b.createdAt) || null;
    const text = str(b.text).trim();

    if (b.type === 1) {
      if (!text) continue;
      current = null;
      messages.push({ role: 'user', at, text, actions: [] });
      continue;
    }
    if (current && steps && text && (current.text || current.actions.length)) current = null;
    if (!current) {
      current = { role: 'assistant', at, text: '', actions: [] };
      messages.push(current);
    }
    if (text) current.text += (current.text ? '\n\n' : '') + text;
    const tool = b.toolFormerData;
    if (!tool?.name) continue;
    const params = safeJson(tool.params) || {};
    if (EDIT_TOOLS.has(tool.name)) {
      const target = str(params.relativeWorkspacePath) || str(params.target_file) || str(params.file_path) || str(params.path);
      if (target) addEdit(current, target, project);
    } else if (CMD_TOOLS.has(tool.name) && str(params.command)) {
      current.actions.push({ kind: 'command', target: params.command });
      addShellEdits(current, params.command, project, at, statCache, str(params.cwd) || str(params.working_directory) || null);
    } else if (AGENT_TOOLS.has(tool.name)) {
      const type = str(params.subagentType) || str(params.subagent_type);
      const description = str(params.description);
      const action = { kind: 'agent', target: description || type || 'subagente' };
      current.actions.push(action);
      if (spawned && str(tool.toolCallId)) spawned.set(tool.toolCallId, Object.assign(action, { subagentType: type || null, description: description || null }));
    }
  }
  return messages;
}

// Una edición por archivo y mensaje: la de una herramienta de edición manda sobre la deducida de un
// comando (via: 'shell'). Las rutas de Cursor pueden venir relativas al proyecto.
function addEdit(msg, target, project, via = null) {
  const abs = (t) => (project ? path.resolve(project, t) : path.resolve(t));
  const prev = msg.actions.find((a) => a.kind === 'edit' && abs(a.target) === abs(target));
  if (prev) {
    if (!via && prev.via) delete prev.via;
    return;
  }
  msg.actions.push(via ? { kind: 'edit', target, via } : { kind: 'edit', target });
}

// Archivos cambiados por un comando de terminal (sed -i, >, cp, python…), con las mismas
// comprobaciones que en Claude Code (ver shellwrites.js). Cursor corre los comandos en el proyecto.
function addShellEdits(msg, command, project, at, statCache, cwd = null) {
  if (!project) return;
  for (const target of resolveShellWrites(command, { cwd: cwd ? path.resolve(project, cwd) : project, project, at, cache: statCache })) addEdit(msg, target, project, 'shell');
}

function countBubbles(conn, composerId) {
  const prefix = `bubbleId:${composerId}:`;
  return conn.prepare('SELECT count(*) AS n FROM cursorDiskKV WHERE key >= ? AND key < ?').get(prefix, prefix + '￿')?.n || 0;
}

// ---------- transcripciones .jsonl (complemento de la base) ----------

// Cursor nombra la carpeta con la ruta absoluta: cada tramo de caracteres que no son letra o número
// pasa a un solo "-", sin guiones al principio ni al final (/home/ana/mi.app -> home-ana-mi-app).
export const encodeCursorProject = (project) => project.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const TRANSCRIPT_EDIT_TOOLS = new Set(['StrReplace', 'Write', 'Delete', 'EditNotebook', 'MultiEdit', 'Edit']);
const TRANSCRIPT_CMD_TOOLS = new Set(['Shell']);
const TRANSCRIPT_AGENT_TOOLS = new Set(['Task']);
const transcriptCache = new Map(); // carpeta -> { key, session }

function listFromTranscripts(cfg, project, known, conn) {
  const base = cfg.cursorProjectsDir;
  if (!base) return [];
  const dir = path.join(base, encodeCursorProject(project), 'agent-transcripts');
  let ids;
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return []; // sin transcripciones para esta carpeta
  }
  const out = [];
  for (const id of ids) {
    if (known.has(id)) continue; // ya viene de la base (como conversación o como subagente)
    // Con cabecera en otra carpeta: es de allá, no se repite aquí.
    if (conn && conn.prepare('SELECT 1 AS x FROM composerHeaders WHERE composerId = ?').get(id)) continue;
    const file = path.join(dir, id, `${id}.jsonl`);
    if (!fs.existsSync(file)) continue;
    // La base tiene la conversación aunque falte su cabecera: se lee de ahí (más completa).
    const data = conn ? safeJson(getValue(conn, `composerData:${id}`)) : null;
    if (data && !data.subagentInfo) {
      const st = fs.statSync(file);
      const s = readSession(conn, { composerId: id, createdAt: data.createdAt || st.mtimeMs, lastUpdatedAt: data.lastUpdatedAt || st.mtimeMs, value: null }, {}, project);
      if (s?.session.messages.length) out.push(s.session);
      continue;
    }
    if (data) continue; // es un subagente de otra conversación
    const s = safeRead(() => readTranscriptSession(file, id, project));
    if (s?.messages.length) out.push(s);
  }
  return out;
}

function safeRead(fn) {
  try {
    return fn();
  } catch {
    return null; // borrada entre listar y leer
  }
}

function readTranscriptSession(file, id, project) {
  const subDir = path.join(path.dirname(file), 'subagents');
  let subNames = [];
  try {
    subNames = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {}
  const st = fs.statSync(file);
  st.mtimeMs = Math.floor(st.mtimeMs);
  const subs = subNames.map((f) => ({ id: f.slice(0, -'.jsonl'.length), file: path.join(subDir, f), st: fs.statSync(path.join(subDir, f)) }));
  const key = [`${st.mtimeMs}:${st.size}`, ...subs.map((x) => `${x.id}:${x.st.mtimeMs}:${x.st.size}`)].join('|');
  const hit = transcriptCache.get(file);
  if (hit?.key === key) return hit.session;

  const spawned = [];
  const statCache = new Map(); // stat de los archivos que tocaron los comandos, una vez por ruta
  const messages = readTranscript(file, st.mtimeMs, spawned, { project, statCache });
  const session = {
    id: 'cursor:' + id,
    source: 'cursor',
    project,
    title: messages.find((m) => m.role === 'user')?.text.slice(0, 80) || '(sin título)',
    branch: null,
    createdAt: messages[0]?.at || st.birthtimeMs || st.mtimeMs,
    updatedAt: st.mtimeMs,
    messages,
  };
  // Las transcripciones no dicen qué llamada lanzó cada subagente: se enlazan por orden (de creación)
  // solo si hay tantas llamadas Task como subagentes; si no, se listan sin enlazar.
  const ordered = subs.sort((a, b) => (a.st.birthtimeMs || a.st.mtimeMs) - (b.st.birthtimeMs || b.st.mtimeMs));
  const link = ordered.length === spawned.length;
  const subagents = [];
  ordered.forEach((x, i) => {
    const msgs = readTranscript(x.file, Math.floor(x.st.mtimeMs), null, { project, statCache, steps: true });
    if (!msgs.length) return;
    const action = link ? spawned[i] : null;
    if (action) action.ref = x.id;
    subagents.push({ id: x.id, type: action?.subagentType || null, description: action?.description || null, startedAt: msgs[0].at, updatedAt: Math.floor(x.st.mtimeMs), messages: msgs });
  });
  for (const a of spawned) delete a.subagentType, delete a.description;
  if (subagents.length) {
    session.subagents = subagents;
    session.updatedAt = Math.max(session.updatedAt, ...subagents.map((x) => x.updatedAt || 0));
  }
  transcriptCache.set(file, { key, session });
  return session;
}

// Líneas {role, message:{content:[…]}} y {type:'turn_ended'}; sin fechas por línea. El mensaje del
// usuario lleva "<timestamp>…</timestamp> <user_query>…</user_query>": de ahí sale la fecha (hasta
// el minuto); lo que no tiene fecha toma la del mensaje anterior o, si no hay, la del archivo.
// steps: como en readBubbles (subagentes partidos en pasos).
function readTranscript(file, mtimeMs, spawned, { project = null, statCache = new Map(), steps = false } = {}) {
  const messages = [];
  let current = null;
  let lastAt = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a medio escribir
    }
    if (!d || typeof d !== 'object') continue;
    if (d.type === 'turn_ended') {
      current = null;
      continue;
    }
    const content = Array.isArray(d.message?.content) ? d.message.content : typeof d.message?.content === 'string' ? [{ type: 'text', text: d.message.content }] : [];
    if (d.role === 'user') {
      const raw = content.filter((b) => b?.type === 'text').map((b) => str(b.text)).join('\n');
      const at = parseStamp(raw) || lastAt;
      lastAt = at;
      const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw);
      const text = (query ? query[1] : raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')).trim();
      if (!text) continue;
      current = null;
      messages.push({ role: 'user', at, text, actions: [] });
      continue;
    }
    if (d.role !== 'assistant') continue;
    const hasText = content.some((b) => b?.type === 'text' && str(b.text).trim());
    if (current && steps && hasText && (current.text || current.actions.length)) current = null;
    if (!current) {
      current = { role: 'assistant', at: lastAt, text: '', actions: [] };
      messages.push(current);
    }
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && str(b.text).trim()) current.text += (current.text ? '\n\n' : '') + str(b.text).trim();
      if (b.type !== 'tool_use') continue;
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      if (TRANSCRIPT_EDIT_TOOLS.has(b.name)) {
        const target = str(input.path) || str(input.file_path) || str(input.target_file) || str(input.target_notebook) || str(input.notebook_path);
        if (target) addEdit(current, target, project);
      } else if (TRANSCRIPT_CMD_TOOLS.has(b.name) && str(input.command)) {
        current.actions.push({ kind: 'command', target: str(input.command) });
        // La fecha es la del último mensaje del usuario (al minuto, nunca posterior al comando).
        addShellEdits(current, str(input.command), project, lastAt, statCache, str(input.working_directory) || str(input.cwd) || null);
      } else if (TRANSCRIPT_AGENT_TOOLS.has(b.name)) {
        const type = str(input.subagent_type);
        const description = str(input.description);
        const action = { kind: 'agent', target: description || type || 'subagente' };
        current.actions.push(action);
        if (spawned) spawned.push(Object.assign(action, { subagentType: type || null, description: description || null }));
      }
    }
  }
  // Sin ninguna fecha legible: todo a la del archivo (mejor que dejarlo fuera de "qué cambió").
  for (const m of messages) m.at ??= mtimeMs;
  return messages;
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "Sunday, Oct 4, 2026, 8:00 PM (UTC-5)" -> milisegundos. null si no se reconoce.
export function parseStamp(text) {
  const m = /<timestamp>[^<]*?\b([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)?[^<(]*(?:\((?:UTC|GMT)([+-]\d{1,2})(?::?(\d{2}))?\))?[^<]*<\/timestamp>/.exec(text);
  if (!m || !(m[1] in MONTHS)) return null;
  let hour = Number(m[4]) % (m[7] ? 12 : 24);
  if (m[7] === 'PM') hour += 12;
  const offsetMin = m[8] ? Number(m[8]) * 60 + Math.sign(Number(m[8]) || 1) * Number(m[9] || 0) : 0;
  const at = Date.UTC(Number(m[3]), MONTHS[m[1]], Number(m[2]), hour, Number(m[5]), Number(m[6] || 0)) - offsetMin * 60_000;
  return Number.isFinite(at) ? at : null;
}

// Solo texto: un campo con otro tipo (registro dañado o de otra versión) cuenta como vacío.
const str = (v) => (typeof v === 'string' ? v : '');

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
