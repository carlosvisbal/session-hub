// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Lector de sesiones de Claude Code: ~/.claude/projects/<ruta-codificada>/<sessionId>.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from '../util.js';
import { resolveShellWrites } from '../shellwrites.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Herramienta que lanza un subagente ('Task' en versiones anteriores de Claude Code).
const AGENT_TOOLS = new Set(['Agent', 'Task']);
// Bloques que el IDE/harness inyecta en los mensajes del usuario y no son parte de la petición.
const NOISE_TAGS = /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/\1>/g;

const cache = new Map(); // file -> { key, session }

// Claude Code guarda el historial en una carpeta con la ruta "codificada": todo lo que no es letra o
// número pasa a "-". Por eso /x/my.app y /x/my-app comparten carpeta; cada sesión se asigna por su cwd real.
export const encodeProject = (project) => project.replace(/[^a-zA-Z0-9]/g, '-');

export function listClaudeSessions(cfg, project) {
  const dir = path.join(cfg.claudeDir, encodeProject(project));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => readSession(path.join(dir, f), project))
    .filter((s) => s && s.messages.length && (!s.cwd || samePath(s.cwd, project)));
}

function readSession(file, project) {
  const st = fs.statSync(file);
  // Los subagentes viven en <sessionId>/subagents/: si uno avanza, la sesión cambia aunque el
  // archivo principal no se toque, así que también cuentan para la caché.
  const subFiles = subagentFiles(file);
  const key = [`${st.mtimeMs}:${st.size}`, ...subFiles.map((f) => `${f.name}:${f.mtimeMs}:${f.size}`)].join('|');
  const hit = cache.get(file);
  if (hit?.key === key) return hit.session;

  const session = {
    id: 'claude:' + path.basename(file, '.jsonl'),
    source: 'claude-code',
    project,
    cwd: null, // carpeta donde empezó la sesión (la primera que registra Claude Code)
    title: null,
    branch: null,
    createdAt: null,
    updatedAt: null,
    messages: [],
  };
  const spawned = new Map(); // toolUseId -> acción 'agent' del mensaje que lanzó el subagente
  const agentOfTool = new Map(); // toolUseId -> agentId (del resultado de la herramienta)
  // stat de los archivos que tocaron los comandos: una vez por ruta en toda la lectura.
  const statCache = new Map();
  readLines(file, session, { sidechain: false, spawned, agentOfTool, project, statCache });

  // Subagentes (herramienta Agent/Task): cada uno en su archivo, con un .meta.json al lado.
  const subagents = [];
  for (const f of subFiles) {
    const agentId = f.name.slice('agent-'.length, -'.jsonl'.length);
    const meta = readMeta(f.file.slice(0, -'.jsonl'.length) + '.meta.json');
    const sub = { id: agentId, type: str(meta.agentType) || null, description: str(meta.description) || null, messages: [], createdAt: null, updatedAt: null };
    try {
      readLines(f.file, sub, { sidechain: true, project, statCache });
    } catch {
      continue; // borrado entre listar y leer
    }
    if (!sub.messages.length) continue;
    // Se enlaza con el mensaje del asistente que lo lanzó: por el toolUseId del meta o, si falta,
    // por el agentId que trae el resultado de la herramienta.
    const toolUseId = str(meta.toolUseId) || [...agentOfTool].find(([, a]) => a === agentId)?.[0];
    const action = toolUseId && spawned.get(toolUseId);
    if (action) {
      action.ref = agentId;
      sub.type ||= action.subagentType || null;
      sub.description ||= action.target || null;
    }
    subagents.push({ id: sub.id, type: sub.type, description: sub.description, startedAt: sub.createdAt, updatedAt: sub.updatedAt, messages: sub.messages });
  }
  for (const a of spawned.values()) delete a.subagentType; // solo servía para enlazar
  if (subagents.length) {
    subagents.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    session.subagents = subagents;
    // Un subagente trabajando es actividad de la sesión (el índice de búsqueda se guía por esto).
    session.updatedAt = Math.max(session.updatedAt || 0, ...subagents.map((x) => x.updatedAt || 0)) || session.updatedAt;
  }

  session.title ||= session.messages.find((m) => m.role === 'user')?.text.slice(0, 80) || '(sin título)';
  cache.set(file, { key, session });
  return session;
}

// Normaliza las líneas de un .jsonl en `into.messages`. El archivo principal salta las líneas de
// subagente (versiones viejas las mezclaban ahí); el de un subagente son todas de subagente.
// En la sesión principal, todo lo que el asistente hace entre dos mensajes humanos es UN mensaje.
// Un subagente casi no recibe mensajes humanos: se parte en pasos (cada texto con las acciones que
// le siguen), para que no parezca resumido en dos mensajes.
function readLines(file, into, { sidechain, spawned = null, agentOfTool = null, project = null, statCache = new Map() }) {
  let current = null; // mensaje del asistente en curso (llega partido en varias líneas)

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // línea a medio escribir mientras la sesión está activa
    }
    if (!d || typeof d !== 'object') continue; // "null", números…: registro mal formado, se salta
    if (!sidechain && (d.type === 'ai-title' || d.type === 'custom-title')) into.title = str(d.aiTitle) || str(d.customTitle) || into.title;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    if (!!d.isSidechain !== sidechain || d.isMeta) continue;

    const at = Date.parse(d.timestamp) || null;
    if (at) {
      into.createdAt ??= at;
      into.updatedAt = at;
    }
    if (!sidechain) {
      if (d.gitBranch) into.branch = d.gitBranch;
      if (d.cwd && !into.cwd) into.cwd = String(d.cwd);
    }
    const content = d.message?.content;

    if (d.type === 'user') {
      // El resultado de la herramienta Agent/Task dice qué subagente atendió cada llamada.
      if (agentOfTool && str(d.toolUseResult?.agentId))
        for (const b of Array.isArray(content) ? content : []) if (b?.type === 'tool_result' && str(b.tool_use_id)) agentOfTool.set(b.tool_use_id, d.toolUseResult.agentId);
      const text = userText(content);
      if (!text) continue; // resultados de herramientas, no son mensajes humanos
      current = null;
      into.messages.push({ role: 'user', at, text, actions: [] });
      continue;
    }

    const blocks = (Array.isArray(content) ? content : []).filter((b) => b && typeof b === 'object'); // bloque mal formado: se salta
    const hasText = blocks.some((b) => b.type === 'text' && str(b.text).trim());
    if (current && sidechain && hasText && (current.text || current.actions.length)) current = null; // nuevo paso del subagente
    if (!current) {
      current = { role: 'assistant', at, text: '', actions: [] };
      into.messages.push(current);
    }
    for (const b of blocks) {
      if (b.type === 'text' && str(b.text).trim()) current.text += (current.text ? '\n\n' : '') + str(b.text).trim();
      if (b.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(b.name)) {
        const target = str(b.input?.file_path) || str(b.input?.notebook_path);
        if (target) addEdit(current, target);
      } else if (b.name === 'Bash' && str(b.input?.command)) {
        const command = str(b.input.command);
        current.actions.push({ kind: 'command', target: command });
        // Archivos cambiados por el comando (sed -i, >, cp, python…): solo los que siguen ahí
        // con fecha posterior (o ya no están, si se borraron) y dentro del proyecto.
        const cwd = (d.cwd && String(d.cwd)) || into.cwd || project;
        for (const target of resolveShellWrites(command, { cwd, project, at, cache: statCache })) addEdit(current, target, 'shell');
      } else if (AGENT_TOOLS.has(b.name)) {
        const type = str(b.input?.subagent_type);
        const action = { kind: 'agent', target: str(b.input?.description) || type || 'subagente' };
        current.actions.push(action);
        if (spawned && str(b.id)) spawned.set(b.id, Object.assign(action, { subagentType: type || null }));
      }
    }
  }
}

// Una edición por archivo y mensaje: la de una herramienta de edición manda sobre la deducida de un
// comando (via: 'shell').
function addEdit(msg, target, via = null) {
  const same = (a) => a.kind === 'edit' && path.resolve(a.target) === path.resolve(target);
  const prev = msg.actions.find(same);
  if (prev) {
    if (!via && prev.via) delete prev.via;
    return;
  }
  msg.actions.push(via ? { kind: 'edit', target, via } : { kind: 'edit', target });
}

// agent-<agentId>.jsonl de una sesión, con su fecha y tamaño (para la caché).
function subagentFiles(file) {
  const dir = path.join(file.slice(0, -'.jsonl'.length), 'subagents');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // sin subagentes
  }
  const out = [];
  for (const name of names.sort()) {
    if (!/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ name, file: path.join(dir, name), mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // borrado entre listar y leer
    }
  }
  return out;
}

function readMeta(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

// Solo texto: un campo con otro tipo (registro dañado o de otra versión) cuenta como vacío.
const str = (v) => (typeof v === 'string' ? v : '');

function userText(content) {
  const parts =
    typeof content === 'string'
      ? [content]
      : (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  const text = parts.join('\n').replace(NOISE_TAGS, '').trim();
  if (!text || text.startsWith('<task-notification') || text.startsWith('[Request interrupted')) return '';
  return text;
}

// Sesiones de Claude Code abiertas ahora: cada una deja ~/.claude/sessions/<pid>.json con su carpeta,
// nombre y estado. Solo se leen esos .json (nunca las claves ni los sockets de Claude Code),
// y solo cuentan si el proceso sigue vivo.
export function listClaudeLive(cfg) {
  const dir = cfg.claudeSessionsDir || path.join(path.dirname(cfg.claudeDir), 'sessions');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue; // a medio escribir
    }
    if (!d?.sessionId || !d.cwd || !alive(d.pid)) continue;
    out.push({ sessionId: String(d.sessionId), cwd: String(d.cwd), name: d.name ? String(d.name) : null, status: d.status === 'busy' ? 'busy' : 'idle', statusAt: d.statusUpdatedAt || d.updatedAt || d.startedAt || null });
  }
  return out;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // existe, pero es de otro usuario
  }
}
