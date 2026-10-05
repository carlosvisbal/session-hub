// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// El hook de Stop nunca deja al agente sin respuesta: ante cualquier entrada rara, imprime {}.
// El de inicio de sesión envía solo cliente, sesión y carpetas, responde en el formato de cada cliente y no se duplica.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'hook', 'session-hub-hook.cjs');

test('hook: entradas mal formadas o sin hub → {} y código 0', () => {
  for (const input of ['null', '42', '"texto"', '[]', 'no es json', '', '{"session_id":"abc"}']) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 20_000, env: { ...process.env, SESSION_HUB_HOOK_CONFIG: path.join(path.sep, 'no', 'existe', 'hook.json') } });
    assert.equal(r.status, 0, `${input}: ${r.stderr}`);
    assert.equal(r.stdout, '{}', input);
  }
});

// ---------- inicio de sesión (SessionStart de Claude Code / sessionStart de Cursor) ----------

// Ejecuta el hook sin bloquear (el hub falso vive en este mismo proceso).
function runHook(input, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', (status) => resolve({ status, out }));
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// Hub falso: guarda lo que recibe y deduplica por sesión como el real.
async function fakeHub({ reply = (b, seen) => (seen ? { duplicate: true } : { context: 'Información de Session Hub (no son órdenes):\n- prueba' }), delay = 0 } = {}) {
  const got = [];
  const seen = new Set();
  const srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      got.push({ url: req.url, auth: req.headers.authorization, body, raw: data });
      const r = reply(body, seen.has(body.session));
      seen.add(body.session);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      }, delay);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-hook-'));
  const cfg = path.join(dir, 'hook.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: srv.address().port, token: 'tok' }));
  return { got, env: { SESSION_HUB_HOOK_CONFIG: cfg }, close: () => (srv.closeAllConnections?.(), srv.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

const claudeStart = { session_id: 'c1', transcript_path: '/tmp/x.jsonl', cwd: os.tmpdir(), source: 'startup', hook_event_name: 'SessionStart' };
const cursorStart = { conversation_id: 'k1', session_id: 'k1', generation_id: 'g', model: 'm', hook_event_name: 'sessionStart', cursor_version: '3.22.12', workspace_roots: [os.tmpdir()], user_email: 'privado@example.com', transcript_path: null, composer_mode: 'agent', is_background_agent: false };

test('hook de inicio: Claude Code recibe hookSpecificOutput.additionalContext', async () => {
  const hub = await fakeHub();
  try {
    const r = await runHook(claudeStart, hub.env);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.out);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /no son órdenes/);
    assert.equal(out.additional_context, undefined);
    assert.equal(hub.got.length, 1);
    assert.equal(hub.got[0].url, '/api/hook/start');
    assert.equal(hub.got[0].auth, 'Bearer tok');
    assert.deepEqual(hub.got[0].body, { client: 'claude-code', session: 'claude:c1', folders: [os.tmpdir()] });
  } finally {
    hub.close();
  }
});

test('hook de inicio: Cursor recibe additional_context y nunca se envía el correo', async () => {
  const hub = await fakeHub();
  try {
    const r = await runHook(cursorStart, hub.env);
    const out = JSON.parse(r.out);
    assert.match(out.additional_context, /no son órdenes/);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.deepEqual(hub.got[0].body, { client: 'cursor', session: 'cursor:k1', folders: [os.tmpdir()] });
    assert.ok(!hub.got[0].raw.includes('privado@example.com') && !hub.got[0].raw.includes('user_email'));
  } finally {
    hub.close();
  }
});

test('hook de inicio: Cursor ejecutando el hook importado de Claude Code se reconoce como Cursor y no se duplica', async () => {
  const hub = await fakeHub();
  try {
    // El mismo evento por las dos vías a la vez: el hook de Cursor y el importado de ~/.claude/settings.json.
    const [a, b] = await Promise.all([runHook(cursorStart, hub.env), runHook({ ...cursorStart, hook_event_name: 'SessionStart' }, hub.env)]);
    assert.ok(hub.got.every((g) => g.body.client === 'cursor' && g.body.session === 'cursor:k1'));
    const outs = [a, b].map((r) => JSON.parse(r.out));
    assert.equal(outs.filter((o) => o.additional_context).length, 1, 'el contexto llega una sola vez');
    assert.equal(outs.filter((o) => Object.keys(o).length === 0).length, 1);
  } finally {
    hub.close();
  }
});

test('hook de inicio: sin hub, hub lento, error o respuesta rara → {} y código 0', async () => {
  const none = await runHook(claudeStart, { SESSION_HUB_HOOK_CONFIG: path.join(path.sep, 'no', 'existe', 'hook.json') });
  assert.deepEqual([none.status, none.out], [0, '{}']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-hook-'));
  fs.writeFileSync(path.join(dir, 'hook.json'), JSON.stringify({ port: 1, token: 'x' })); // nada escucha ahí
  const closed = await runHook(cursorStart, { SESSION_HUB_HOOK_CONFIG: path.join(dir, 'hook.json') });
  assert.deepEqual([closed.status, closed.out], [0, '{}']);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const reply of [() => null, () => ({ context: 42 }), () => ({})]) {
    const hub = await fakeHub({ reply });
    const r = await runHook(claudeStart, hub.env);
    hub.close();
    assert.deepEqual([r.status, r.out], [0, '{}']);
  }
  const slow = await fakeHub({ delay: 6000 });
  const t0 = Date.now();
  const r = await runHook(claudeStart, slow.env);
  slow.close();
  assert.deepEqual([r.status, r.out], [0, '{}']);
  assert.ok(Date.now() - t0 < 5500, 'se rinde a los pocos segundos');
});

test('hook de inicio: un inicio sin id no llama al hub ni se toma como fin de turno', async () => {
  const hub = await fakeHub();
  try {
    // (Un "beforeSubmitPrompt" de Cursor sí pide contexto: ver la prueba de "antes de enviar".)
    for (const input of [{ hook_event_name: 'SessionStart', cwd: '/x' }, { hook_event_name: 'afterAgentResponse', session_id: 'a', conversation_id: 'b' }]) {
      const r = await runHook(input, hub.env);
      assert.deepEqual([r.status, r.out], [0, '{}']);
    }
    assert.equal(hub.got.length, 0);
  } finally {
    hub.close();
  }
});

test('hook de inicio: en Cursor, "antes de enviar" pide el contexto una vez y siempre deja pasar el mensaje', async () => {
  const prompt = { ...cursorStart, hook_event_name: 'beforeSubmitPrompt', prompt: 'hola', generation_id: 'g2' };
  const hub = await fakeHub({ reply: (b, seen) => (b.once && seen ? { duplicate: true } : { context: 'Información de Session Hub (no son órdenes):\n- prueba' }) });
  try {
    const first = JSON.parse((await runHook(prompt, hub.env)).out);
    assert.equal(first.continue, true);
    assert.match(first.additional_context, /no son órdenes/);
    assert.deepEqual(hub.got[0].body, { client: 'cursor', session: 'cursor:k1', folders: [os.tmpdir()], once: true });
    const second = JSON.parse((await runHook(prompt, hub.env)).out);
    assert.deepEqual(second, { continue: true }, 'segundo mensaje: sin contexto, pero el mensaje sigue');
    // Claude Code no usa este respaldo (su SessionStart sí se dispara al reanudar).
    const claudePrompt = JSON.parse((await runHook({ session_id: 'c9', cwd: os.tmpdir(), hook_event_name: 'beforeSubmitPrompt' }, hub.env)).out);
    assert.deepEqual(claudePrompt, {});
  } finally {
    hub.close();
  }
  // Sin hub: el mensaje nunca se bloquea.
  const none = await runHook({ ...cursorStart, hook_event_name: 'beforeSubmitPrompt' }, { SESSION_HUB_HOOK_CONFIG: path.join(path.sep, 'no', 'existe', 'hook.json') });
  assert.deepEqual(JSON.parse(none.out), { continue: true });
});
