#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// session-hub-hook: lo ejecutan Claude Code (hook "Stop") y Cursor (hook "stop") al terminar cada turno
// del agente. Si la sesión está en una conversación automática de Session Hub y llegó la respuesta del
// compañero, se la devuelve al agente para que siga solo; si no, no hace nada.
//
// También lo ejecutan al abrir una sesión nueva (Claude Code "SessionStart", Cursor "sessionStart"): le
// da a la IA un contexto corto (proyecto actual, mensajes esperando, compañeros conectados) armado solo
// con datos locales. Al hub solo se le envía el cliente, el id de la sesión y las carpetas; nunca el
// correo ni otros datos de la entrada.
//
// Nunca bloquea al agente: ante cualquier error, hub apagado o tiempo agotado, responde {} (el agente se
// detiene como siempre). Solo habla con el hub local (127.0.0.1) con el token de ~/.session-hub/hook.json.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG = process.env.SESSION_HUB_HOOK_CONFIG || path.join(os.homedir(), '.session-hub', 'hook.json');
const BUDGET_MS = Number(process.env.SESSION_HUB_HOOK_BUDGET_MS) || 110_000; // por debajo del timeout del hook (150 s)
const START_MS = 3000; // inicio de sesión: si el hub no responde en 3 s, la sesión arranca sin contexto
const MAX_FOLDERS = 10;
const started = Date.now();

function done(out) {
  process.stdout.write(JSON.stringify(out || {}));
  process.exit(0);
}
const guard = setTimeout(() => done({}), BUDGET_MS + 5000); // pase lo que pase, termina
guard.unref?.();

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// Quién llama y qué sesión terminó su turno.
//   Claude Code: { session_id, transcript_path, cwd, hook_event_name: "Stop", stop_hook_active }
//   Cursor:      { conversation_id, generation_id, status, loop_count, hook_event_name: "stop", workspace_roots }
function identify(input) {
  if (!input || typeof input !== 'object') return null; // "null", un número, una lista…
  if (input.conversation_id && (input.loop_count !== undefined || input.generation_id !== undefined || /^stop$/.test(input.hook_event_name || ''))) {
    return { tool: 'Cursor', session: `cursor:${input.conversation_id}` };
  }
  if (input.session_id) return { tool: 'Claude Code', session: `claude:${input.session_id}` };
  return null;
}

// Inicio de sesión. Cursor también importa los hooks de Claude Code (~/.claude/settings.json), así que el
// mismo evento puede llegar dos veces y con cualquiera de los dos nombres: se reconoce a Cursor por sus
// campos (cursor_version, workspace_roots, conversation_id), no por el nombre del evento.
//   Claude Code: { session_id, transcript_path, cwd, source, hook_event_name: "SessionStart" }
//   Cursor:      { conversation_id, session_id, workspace_roots, cursor_version, hook_event_name: "sessionStart", … }
// Cursor no lanza "sessionStart" si se sigue escribiendo en un chat que ya existía: "beforeSubmitPrompt"
// (antes de cada mensaje) pide el mismo contexto como respaldo, y el hub lo da una sola vez por conversación.
function identifyStart(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const ev = String(input.hook_event_name || '');
  const prompt = /^beforesubmitprompt$/i.test(ev);
  if (!prompt && !/^sessionstart$/i.test(ev)) return null;
  const folders = (list) => (Array.isArray(list) ? list : [list]).filter((f) => typeof f === 'string' && f && f.length < 4096).slice(0, MAX_FOLDERS);
  const cursor = input.cursor_version !== undefined || Array.isArray(input.workspace_roots) || typeof input.conversation_id === 'string';
  const id = cursor ? input.conversation_id || input.session_id : input.session_id;
  if (typeof id !== 'string' || !id || id.length > 200) return null;
  if (prompt && !cursor) return null; // solo Cursor usa este respaldo
  const who = cursor ? { client: 'cursor', session: `cursor:${id}`, folders: folders(input.workspace_roots) } : { client: 'claude-code', session: `claude:${id}`, folders: folders(input.cwd) };
  return prompt ? { ...who, once: true } : who;
}

// Cada cliente lee su propio formato.
function startOutput(client, text, once = false) {
  // Antes de enviar un mensaje (Cursor), la respuesta siempre deja pasar el mensaje.
  if (once) return typeof text === 'string' && text ? { continue: true, additional_context: text.slice(0, 10_000) } : { continue: true };
  if (typeof text !== 'string' || !text) return {};
  if (client === 'cursor') return { additional_context: text.slice(0, 10_000) };
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

async function start(cfg, who) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/hook/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(who), // solo cliente, sesión y carpetas
    signal: AbortSignal.timeout(START_MS),
  });
  const r = res.ok ? await res.json() : {};
  return startOutput(who.client, r && typeof r === 'object' ? r.context : '', !!who.once);
}

async function ask(cfg, who, wait) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/hook/stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...who, wait }),
    signal: AbortSignal.timeout(wait + 5000),
  });
  return res.ok ? res.json() : {};
}

(async () => {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {}
  let cfg;
  const readCfg = () => {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
      return true;
    } catch {
      return false; // Session Hub no configuró el hook en este equipo
    }
  };
  const begin = identifyStart(input);
  if (begin) {
    const fallback = begin.once ? { continue: true } : {}; // ante cualquier error, el mensaje sigue su curso
    setTimeout(() => done(fallback), START_MS + 1000).unref?.(); // el inicio de sesión nunca espera más
    if (!readCfg()) return done(fallback);
    try {
      return done(await start(cfg, begin));
    } catch {
      return done(fallback);
    }
  }
  // Cualquier otro evento que no sea de fin de turno (p. ej. un SessionStart sin id): nada que hacer.
  const ev = input && typeof input === 'object' ? String(input.hook_event_name || '') : '';
  if (ev && !/stop$/i.test(ev)) return done({});
  const who = identify(input);
  if (!who) return done({});
  if (!readCfg()) return done({});
  try {
    // Pregunta al hub; si estamos esperando la respuesta del otro, sigue esperando en tramos de 25 s.
    for (;;) {
      const left = BUDGET_MS - (Date.now() - started);
      const r = await ask(cfg, who, Math.max(0, Math.min(25_000, left - 1000)));
      if (!r || typeof r !== 'object') return done({});
      if (typeof r.text === 'string' && r.text) {
        // Los dos formatos a la vez: Claude Code lee decision/reason; Cursor, followup_message.
        return done({ decision: 'block', reason: r.text, followup_message: r.text });
      }
      if (!r.wait || r.busy || BUDGET_MS - (Date.now() - started) < 2000) return done({});
    }
  } catch {
    return done({});
  }
})().catch(() => done({})); // cualquier error inesperado: {} y el agente se detiene como siempre
