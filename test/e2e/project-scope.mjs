// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Extremo a extremo: búsqueda por MCP entre dos hubs reales y el proyecto actual.
// - search_sessions encuentra en las sesiones del compañero y nunca sirve de oráculo de secretos.
// - Con "workspace", los resultados se limitan al proyecto actual (mismo repo git, aunque la carpeta
//   se llame distinto) y lo que se llama igual pero es otro repo se oculta o se marca.
//   node test/e2e/project-scope.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClaudeFixture } from '../fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const f = makeClaudeFixture();
const gitRepo = (dir, origin) => {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n`);
};
// El proyecto de Carlos es el repo acme/demo-api. Ana tiene el mismo repo en otra carpeta ("frontend-copy"),
// y otra carpeta que se llama igual ("demo-api") pero es OTRO repo.
gitRepo(f.project, 'git@github.com:acme/demo-api.git');
const anaSame = path.join(f.root, 'ana', 'frontend-copy');
const anaOther = path.join(f.root, 'ana-otro', 'demo-api');
gitRepo(anaSame, 'https://github.com/acme/demo-api');
gitRepo(anaOther, 'https://github.com/otra-empresa/demo-api.git');

// Puertos libres de verdad (en algunas máquinas hay servicios en 8080/8081): se prueba antes de usarlos.
const isFree = (port) => new Promise((resolve) => { const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1'); });
let base = 8000 + Math.floor(Math.random() * 100);
while (!((await isFree(base)) && (await isFree(base + 100)))) base = 8000 + Math.floor(Math.random() * 100);
const people = {
  carlos: { port: base, dhtPort: 50000 + (base % 100), owner: { name: 'Carlos', role: 'backend' }, projects: [{ path: f.project, name: 'demo-api' }] },
  ana: { port: base + 100, dhtPort: 50100 + (base % 100), owner: { name: 'Ana', role: 'frontend' }, projects: [] },
};
const procs = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log('✔', m);
const call = async (who, method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${people[who].port}${route}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};
const mcp = async (who, name, args = {}, ws = []) => {
  const qs = ws.map((w) => `ws=${encodeURIComponent(w)}`).join('&');
  const res = await fetch(`http://127.0.0.1:${people[who].port}/mcp${qs ? '?' + qs : ''}`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data.error || data.result?.isError) throw new Error(JSON.stringify(data.error || data.result.content));
  return JSON.parse(data.result.content[0].text);
};
async function until(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(500)) if (await fn().catch(() => false)) return;
  throw new Error(`No se cumplió a tiempo: ${what}`);
}

try {
  for (const [who, p] of Object.entries(people)) {
    const dir = path.join(f.root, `hub-${who}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...p, localToken: 't', network: 'lan', claudeDir: f.claudeDir, cursorUserDir: f.cursorUserDir }));
    procs[who] = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: path.join(dir, 'config.json') }, stdio: 'ignore' });
  }
  await until(async () => (await call('carlos', 'GET', '/health')).ok && (await call('ana', 'GET', '/health')).ok, 15000, 'hubs arriba');
  await call('carlos', 'POST', '/api/team/create', { name: 'e2e' });
  const { code } = await call('carlos', 'POST', '/api/team/invite', {});
  await call('ana', 'POST', '/api/team/join', { code });
  await until(async () => !(await call('ana', 'GET', '/api/team')).team.pending, 30000, 'admisión de Ana');
  await until(async () => (await call('ana', 'GET', '/api/peers')).find((m) => m.name === 'Carlos')?.online, 15000, 'Carlos en línea');
  step('dos hubs, mismo equipo');

  // Búsqueda: encuentra, y el fragmento sale redactado.
  const hits = await mcp('ana', 'search_sessions', { query: 'serializer', peer: 'Carlos' });
  assert.ok(Array.isArray(hits) && hits.length >= 1, 'encuentra en la sesión de Carlos');
  assert.equal(hits[0].sessionId, 'claude:s1');
  const keyHits = await mcp('ana', 'search_sessions', { query: 'documenta', peer: 'Carlos' });
  assert.ok(Array.isArray(keyHits) && keyHits.length >= 1);
  step(`search_sessions encuentra en las sesiones del compañero (${hits.length} resultado/s)`);

  const secret = await mcp('ana', 'search_sessions', { query: 'sk-abcdefghijklmnop1234', peer: 'Carlos' });
  const prefix = await mcp('ana', 'search_sessions', { query: 'abcdefghijklmnop', peer: 'Carlos' });
  for (const r of [secret, prefix]) assert.ok(Array.isArray(r) ? !r.length : !r.resultado?.length, 'un secreto redactado no se encuentra');
  const all = JSON.stringify(await mcp('ana', 'search_sessions', { query: 'API_KEY', peer: 'Carlos' }));
  assert.ok(!all.includes('sk-abcdefghijklmnop1234'), 'ningún fragmento trae el secreto');
  step('buscar un secreto (entero o por partes) no devuelve nada: la búsqueda no es un oráculo');

  // El mismo repo en otra carpeta = proyecto actual.
  const same = await mcp('ana', 'search_sessions', { query: 'serializer', peer: 'Carlos', workspace: anaSame });
  assert.equal(same.proyecto_actual[0].nombre, 'frontend-copy');
  assert.equal(same.resultado.length, hits.length);
  assert.equal(same.resultado[0].relacion, 'proyecto actual');
  step('mismo repo con otro nombre de carpeta: resultados marcados "proyecto actual"');

  // Misma carpeta "demo-api" pero otro repo: se oculta por defecto y se avisa.
  const other = await mcp('ana', 'search_sessions', { query: 'serializer', peer: 'Carlos', workspace: anaOther });
  assert.equal(other.resultado.length, 0);
  assert.match(other.nota, /1 con el mismo nombre/);
  const forced = await mcp('ana', 'search_sessions', { query: 'serializer', peer: 'Carlos', workspace: anaOther, project: 'todos' });
  assert.equal(forced.resultado[0].relacion, 'OTRO proyecto con el mismo nombre');
  assert.match(forced.nota, /OTRO proyecto que se llama igual/);
  step('mismo nombre pero otro repo: oculto por defecto; con project="todos" se ve marcado como OTRO proyecto');

  // La carpeta también puede venir del editor (?ws= en la dirección del MCP) y vale para list_sessions.
  const listed = await mcp('ana', 'list_sessions', { peer: 'Carlos' }, [anaSame]);
  assert.equal(listed.resultado[0].relacion, 'proyecto actual');
  const read = await mcp('ana', 'get_session', { id: 'claude:s1', peer: 'Carlos', limit: 2 }, [anaOther]);
  assert.match(read.aviso, /OTRO proyecto que se llama igual/);
  step('la carpeta del editor (?ws=) acota list_sessions y get_session avisa si la sesión es de otro proyecto');

  // Las carpetas locales de Ana nunca viajan a Carlos.
  const audit = JSON.stringify(await call('carlos', 'GET', '/api/access'));
  assert.ok(!audit.includes('frontend-copy') && !audit.includes('ana-otro'), 'la auditoría de Carlos no ve las carpetas de Ana');
  step('las carpetas de trabajo de Ana no salen de su máquina');

  // Atajos (prompts MCP): se listan y el de "ponerme al día" lleva la carpeta del editor.
  const rpc = async (method, params, ws = []) => {
    const qs = ws.map((w) => `ws=${encodeURIComponent(w)}`).join('&');
    const res = await fetch(`http://127.0.0.1:${people.ana.port}/mcp${qs ? '?' + qs : ''}`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
    return (await res.json()).result;
  };
  const prompts = (await rpc('prompts/list', {})).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ['catch_up', 'check_messages', 'search_team']);
  const catchUp = await rpc('prompts/get', { name: 'catch_up', arguments: { since: '3d' } }, [anaSame]);
  const text = catchUp.messages[0].content.text;
  assert.ok(text.includes('what_changed') && text.includes('3d') && text.includes(anaSame), 'el atajo arma el pedido con la carpeta actual');
  step('atajos MCP: catch_up, search_team y check_messages; el pedido lleva la carpeta del editor');

  // Sin carpeta conocida, la respuesta es la de siempre (compatibilidad).
  assert.ok(Array.isArray(await mcp('ana', 'list_sessions', { peer: 'Carlos' })));
  step('sin carpeta conocida, las herramientas responden como antes');

  const ws = await call('ana', 'GET', `/api/workspace?ws=${encodeURIComponent(anaSame + '\n' + anaOther)}`);
  assert.equal(ws.folders.length, 2);
  assert.ok(ws.folders.every((x) => x.git));
  step('API local /api/workspace: clave y estado git de las carpetas abiertas');

  console.log('\nE2E PROYECTO ACTUAL OK');
} finally {
  for (const p of Object.values(procs)) p.kill();
}
