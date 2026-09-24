// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// El panel (media/dashboard.js) en un navegador simulado: pestañas, que no falte ninguna acción,
// buscadores y paginación, agrupación por proyecto, respaldo e idioma.   node test/panel.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = (m) => console.log('✔', m);
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const ME = 'c'.repeat(64);
const id = (i) => String(i).padStart(64, '0');

function demoState(lang) {
  const people = Array.from({ length: 30 }, (_, i) => ({ id: id(i), name: i === 7 ? 'Valentina' : `Persona ${i}`, role: i % 2 ? 'frontend' : 'backend', online: i % 3 === 0, fingerprint: `F${i}`, projects: [`p${i % 4}`], canRevoke: i === 1, invitedByName: 'ti' }));
  const team = [];
  const add = (owner, ownerId, project, projectKey, n, base) => {
    for (let i = 0; i < n; i++) team.push({ id: `${owner}${project}${i}`, ownerId, owner, source: i % 3 ? 'cursor' : 'claude-code', project, projectKey, title: `Sesión ${project} ${i}`, updatedAt: ago(base + i * 70), filesChanged: ['a'], messages: 5 });
  };
  add('Persona 0', id(0), 'web-app', 'git:aaa', 9, 0); // mismo nombre que la de Persona 3, otro repo
  add('Persona 3', id(3), 'web-app', 'git:bbb', 5, 40);
  add('Persona 6', id(6), 'qa-e2e', 'git:ddd', 6, 80); // mismo repo que "mobile" con otro nombre
  add('Persona 3', id(3), 'mobile', 'git:ddd', 7, 120);
  team.push({ id: 'cursor:copy', ownerId: id(9), owner: 'Persona 9', source: 'cursor', project: 'docs', projectKey: 'git:eee', title: 'Copia sin conexión', updatedAt: ago(500), filesChanged: [], messages: 4, copy: { syncedAt: ago(30), status: 'ok' } });
  return {
    lang,
    running: true,
    hasTeam: true,
    follows: { people: [], sessions: [] },
    workspace: { name: 'web', path: '/w', shared: false },
    teamInfo: { team: { name: 'Dev', fingerprint: 'F', pending: false }, me: { fingerprint: 'F' } },
    members: [{ id: ME, name: 'Carlos', self: true, online: true, founder: true, fingerprint: 'F', projects: ['api'] }, ...people],
    mine: [{ id: 'claude:gone', ownerId: ME, owner: 'Carlos', source: 'claude-code', project: 'api', projectKey: 'git:111', title: 'Sesión borrada por Claude', updatedAt: ago(60 * 24 * 40), filesChanged: [], messages: 9, archived: true }],
    team,
    teamErrors: [],
    access: { viewers: [], reads: Array.from({ length: 40 }, (_, i) => ({ at: ago(i * 7), who: i === 5 ? 'Valentina' : `Persona ${i}`, whoId: 'x', via: 'mcp', client: 'Cursor', what: i === 0 ? 'copy' : i === 2 ? 'denied' : 'session', title: `Sesión ${i}`, project: 'api', sessionId: `s${i}` })) },
    sharing: { paused: false, projects: Array.from({ length: 12 }, (_, i) => ({ name: `proyecto-${i}`, path: `/p/${i}`, sessions: i, hidden: 0, audience: 'todo el equipo' })) },
    checks: Array.from({ length: 25 }, (_, i) => ({ status: i < 2 ? 'warn' : 'ok', label: i === 9 ? 'Tu IA puede consultar Session Hub (MCP)' : `Comprobación ${i}` })),
    inbox: { policy: 'hold', held: 1, unread: 2, received: Array.from({ length: 23 }, (_, i) => ({ id: `m${i}`, from: 'x', fromName: `Persona ${i}`, fingerprint: 'F', text: i === 11 ? 'el endpoint de firmas cambió' : `hola ${i}`, at: ago(i), receivedAt: ago(i), status: i ? 'read' : 'held' })), sent: Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, toName: `Persona ${i}`, text: `enviado ${i}`, status: 'read', at: ago(i) })) },
    agents: [{ session: 'cursor:z', ownerId: id(0), tool: 'Cursor', project: 'web-app', status: 'recent', title: 'Login' }],
    archive: { own: { enabled: true, sessions: 12, onlyInBackup: 1, bytes: 3456789, lastSync: ago(1) }, copies: { enabled: true, allowOthers: true, bytes: 999999, owners: Array.from({ length: 11 }, (_, i) => ({ id: id(i), name: `Persona ${i}`, sessions: i + 1, bytes: 1000 * i, lastSync: ago(i), paused: i === 2, gone: 0, ignored: 0 })) } },
  };
}

function mount(lang) {
  const dom = new JSDOM('<div id="app"></div>', { runScripts: 'outside-only' });
  const w = dom.window;
  const errors = [];
  const posted = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.eval(fs.readFileSync(path.join(ROOT, 'media/i18n.js'), 'utf8'));
  w.SESSION_HUB_DICT = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8'));
  const state = demoState(lang);
  w.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage: (m) => (posted.push(m), m.type === 'ready' && w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', state } }))) });
  w.eval(fs.readFileSync(path.join(ROOT, 'media/dashboard.js'), 'utf8'));
  const d = w.document;
  return {
    w, d, state, errors, posted,
    view: (v) => d.querySelector(`[data-view="${v}"]`).click(),
    search: (key, text) => {
      const i = d.querySelector(`[data-search="${key}"]`);
      i.value = text;
      i.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    count: (sel) => d.querySelectorAll(sel).length,
    pager: (key) => d.querySelector(`#lb-${key} .pager span`)?.textContent,
    text: () => d.body.textContent.replace(/\s+/g, ' '),
  };
}

// ---------- ninguna acción se pierde entre pestañas ----------
const p = mount('es');
const commands = new Set();
const seen = () => p.d.querySelectorAll('[data-cmd]').forEach((e) => commands.add(e.dataset.cmd));
for (const v of ['sessions', 'messages', 'team', 'privacy', 'status']) {
  p.view(v);
  seen();
  if (v === 'sessions') for (const tab of ['following', 'mine']) p.d.querySelector(`[data-tab="${tab}"]`).click(), seen();
}
const expected = ['whatChanged', 'sendMessage', 'togglePause', 'copyInvite', 'setLanguage', 'openSource', 'handoffMessage', 'approveMessage', 'replyMessage', 'dismissMessage', 'leaveTeam', 'blockMember', 'revokeMember', 'shareWorkspace', 'editProjectAccess', 'unshareProject', 'toggleSessionVisibility', 'doctor', 'copyNetReport', 'copyClaudeCommand', 'syncBackup', 'exportAll', 'purgeCopies', 'purgeOwnBackup'].map((c) => `sessionHub.${c}`);
assert.deepEqual(expected.filter((c) => !commands.has(c)), [], 'faltan acciones en el panel');
ok(`las 5 pestañas reúnen las ${expected.length} acciones del panel`);

// ---------- buscadores y paginación ----------
p.view('team');
assert.equal(p.pager('people'), '1–12 de 31');
p.search('people', 'valentina');
assert.equal(p.count('.people .person'), 1);
p.search('people', 'zzz');
assert.match(p.d.getElementById('lb-people').textContent, /Nada coincide/);
p.view('messages');
assert.equal(p.pager('inbox'), '1–10 de 23');
p.search('inbox', 'firmas');
assert.equal(p.count('#lb-inbox .msgbox'), 1);
p.d.querySelector('[data-page="sent:1"]').click();
assert.equal(p.pager('sent'), '11–14 de 14');
p.view('privacy');
assert.deepEqual([p.pager('shares'), p.pager('reads'), p.pager('copyowners')], ['1–8 de 12', '1–15 de 40', '1–8 de 11']);
assert.match(p.text(), /guardó una copia/);
assert.match(p.text(), /12 respaldada\(s\) · 1 solo en el respaldo/);
p.view('status');
p.search('checks', 'mcp');
p.d.querySelector('[data-search="checks"]').focus();
p.w.dispatchEvent(new p.w.MessageEvent('message', { data: { type: 'state', state: p.state } }));
assert.equal(p.d.activeElement?.dataset?.search, 'checks', 'el buscador conserva el foco al refrescar');
assert.equal(p.count('#lb-checks .check'), 1);
ok('buscador y paginación en equipo, mensajes, enviados, proyectos, lecturas, copias y estado (conserva el foco)');

// ---------- sesiones agrupadas por proyecto (projectKey) ----------
p.view('sessions');
p.d.querySelector('[data-tab="team"]').click();
const heads = [...p.d.querySelectorAll('.group-head .g-name')].map((x) => x.textContent);
assert.ok(heads.includes('web-app · Persona 0') && heads.includes('web-app · Persona 3'), 'dos "web-app" de repos distintos no se mezclan');
assert.ok(heads.includes('qa-e2e / mobile') || heads.includes('mobile / qa-e2e'), 'el mismo repo con dos nombres va junto');
assert.match(p.d.getElementById('list').textContent, /💾 copia de hace 30 min/);
p.d.querySelector('[data-tab="mine"]').click();
assert.match(p.d.getElementById('list').textContent, /🗄 solo en respaldo/);
ok(`grupos: ${heads.join(' | ')} · marcas de copia y de respaldo`);

// ---------- teclado e idioma ----------
p.view('sessions');
const tab = p.d.getElementById('tab-sessions');
tab.focus();
tab.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
assert.equal(p.d.activeElement.id, 'tab-messages');
assert.deepEqual(p.errors, []);
const en = mount('en');
for (const v of ['sessions', 'messages', 'team', 'privacy', 'status']) en.view(v);
en.view('privacy');
assert.match(en.text(), /Backup/);
assert.match(en.text(), /My team's copies/);
assert.deepEqual(en.errors, []);
ok('flechas entre pestañas, sin errores de JavaScript, en español y en inglés');
console.log('\nPANEL OK');
