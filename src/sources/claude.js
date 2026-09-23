// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Lector de sesiones de Claude Code: ~/.claude/projects/<ruta-codificada>/<sessionId>.jsonl
import fs from 'node:fs';
import path from 'node:path';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Bloques que el IDE/harness inyecta en los mensajes del usuario y no son parte de la petición.
const NOISE_TAGS = /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/\1>/g;

const cache = new Map(); // file -> { key, session }

export const encodeProject = (project) => project.replace(/[^a-zA-Z0-9]/g, '-');

export function listClaudeSessions(cfg, project) {
  const dir = path.join(cfg.claudeDir, encodeProject(project));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => readSession(path.join(dir, f), project))
    .filter((s) => s && s.messages.length);
}

function readSession(file, project) {
  const st = fs.statSync(file);
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.session;

  const session = {
    id: 'claude:' + path.basename(file, '.jsonl'),
    source: 'claude-code',
    project,
    title: null,
    branch: null,
    createdAt: null,
    updatedAt: null,
    messages: [],
  };
  let current = null; // mensaje del asistente en curso (llega partido en varias líneas)

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // línea a medio escribir mientras la sesión está activa
    }
    if (d.type === 'ai-title' || d.type === 'custom-title') session.title = d.aiTitle || d.customTitle || session.title;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    if (d.isSidechain || d.isMeta) continue;

    const at = Date.parse(d.timestamp) || null;
    if (at) {
      session.createdAt ??= at;
      session.updatedAt = at;
    }
    if (d.gitBranch) session.branch = d.gitBranch;
    const content = d.message?.content;

    if (d.type === 'user') {
      const text = userText(content);
      if (!text) continue; // resultados de herramientas, no son mensajes humanos
      current = null;
      session.messages.push({ role: 'user', at, text, actions: [] });
      continue;
    }

    if (!current) {
      current = { role: 'assistant', at, text: '', actions: [] };
      session.messages.push(current);
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'text' && b.text?.trim()) current.text += (current.text ? '\n\n' : '') + b.text.trim();
      if (b.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(b.name)) current.actions.push({ kind: 'edit', target: b.input?.file_path || b.input?.notebook_path });
      else if (b.name === 'Bash' && b.input?.command) current.actions.push({ kind: 'command', target: b.input.command });
    }
  }

  session.title ||= session.messages.find((m) => m.role === 'user')?.text.slice(0, 80) || '(sin título)';
  cache.set(file, { key, session });
  return session;
}

function userText(content) {
  const parts =
    typeof content === 'string'
      ? [content]
      : (Array.isArray(content) ? content : []).filter((b) => b.type === 'text').map((b) => b.text);
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
