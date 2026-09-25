#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// session-hub-hook: lo ejecutan Claude Code (hook "Stop") y Cursor (hook "stop") al terminar cada turno
// del agente. Si la sesión está en una conversación automática de Session Hub y llegó la respuesta del
// compañero, se la devuelve al agente para que siga solo; si no, no hace nada.
//
// Nunca bloquea al agente: ante cualquier error, hub apagado o tiempo agotado, responde {} (el agente se
// detiene como siempre). Solo habla con el hub local (127.0.0.1) con el token de ~/.session-hub/hook.json.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG = process.env.SESSION_HUB_HOOK_CONFIG || path.join(os.homedir(), '.session-hub', 'hook.json');
const BUDGET_MS = Number(process.env.SESSION_HUB_HOOK_BUDGET_MS) || 110_000; // por debajo del timeout del hook (150 s)
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
  if (input.conversation_id && (input.loop_count !== undefined || input.generation_id !== undefined || /^stop$/.test(input.hook_event_name || ''))) {
    return { tool: 'Cursor', session: `cursor:${input.conversation_id}` };
  }
  if (input.session_id) return { tool: 'Claude Code', session: `claude:${input.session_id}` };
  return null;
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
  const who = identify(input);
  if (!who) return done({});
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return done({}); // Session Hub no configuró el hook en este equipo
  }
  try {
    // Pregunta al hub; si estamos esperando la respuesta del otro, sigue esperando en tramos de 25 s.
    for (;;) {
      const left = BUDGET_MS - (Date.now() - started);
      const r = await ask(cfg, who, Math.max(0, Math.min(25_000, left - 1000)));
      if (r.text) {
        // Los dos formatos a la vez: Claude Code lee decision/reason; Cursor, followup_message.
        return done({ decision: 'block', reason: r.text, followup_message: r.text });
      }
      if (!r.wait || r.busy || BUDGET_MS - (Date.now() - started) < 2000) return done({});
    }
  } catch {
    return done({});
  }
})();
