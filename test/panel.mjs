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
    archive: {
      own: { enabled: true, sessions: 14, onlyInBackup: 3, bytes: 3456789, lastSync: ago(1), list: Array.from({ length: 14 }, (_, i) => ({ id: `claude:b${i}`, title: i === 4 ? 'Firma y anulación de documentos' : `Respaldada ${i}`, project: 'api', projectKey: 'git:111', shared: i !== 5, source: i % 2 ? 'cursor' : 'claude-code', messages: 10 + i, bytes: 20000 * (i + 1), updatedAt: ago(i * 60), syncedAt: ago(1), goneSince: i < 3 ? ago(60 * 24) : null, hasPrev: i === 7 })) },
      copies: { enabled: true, allowOthers: true, bytes: 999999, owners: [{ id: id(0), name: 'Persona 0', sessions: 8, bytes: 5000, lastSync: ago(2) }, { id: id(3), name: 'Persona 3', sessions: 5, bytes: 3000, lastSync: ago(9), paused: true }], list: Array.from({ length: 13 }, (_, i) => ({ id: `cursor:k${i}`, ownerId: i < 8 ? id(0) : id(3), owner: i < 8 ? 'Persona 0' : 'Persona 3', title: `Copia ${i}`, project: 'web-app', source: 'cursor', messages: 4, bytes: 3000, syncedAt: ago(i), status: i === 2 ? 'gone' : 'ok' })) },
      settings: { archive: true, teamCopies: true, allowCopies: true, archiveRetentionDays: 365, copiesRetentionDays: 180, archiveMaxMB: 2048 },
    },
    hooks: { claude: true, cursor: false, any: true },
    conversations: [
      { id: 'k1', peerName: 'Persona 0', status: 'invited', turns: 6, minutes: 10, sent: 0, received: 0, text: 'Revisemos el endpoint' },
      { id: 'k2', peerName: 'Persona 3', status: 'active', turns: 6, minutes: 10, sent: 2, received: 1, text: 'Coordinemos adjuntos', expiresAt: new Date(Date.now() + 7 * 60000).toISOString() },
      { id: 'k3', peerName: 'Persona 6', status: 'confirm', turns: 6, minutes: 10, sent: 0, received: 0, text: 'Pedida por la IA' },
      { id: 'k4', peerName: 'Persona 9', status: 'ended', endReason: 'limit', turns: 6, minutes: 10, sent: 6, received: 6, text: 'Terminada' },
    ],
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
  w.SESSION_HUB_HELP = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/help.json'), 'utf8'));
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
for (const v of ['sessions', 'messages', 'team', 'privacy', 'backup', 'status', 'help']) {
  p.view(v);
  seen();
  if (v === 'sessions') for (const tab of ['following', 'mine']) p.d.querySelector(`[data-tab="${tab}"]`).click(), seen();
}
const expected = ['whatChanged', 'sendMessage', 'togglePause', 'copyInvite', 'setLanguage', 'openSource', 'handoffMessage', 'approveMessage', 'replyMessage', 'dismissMessage', 'leaveTeam', 'blockMember', 'revokeMember', 'shareWorkspace', 'editProjectAccess', 'unshareProject', 'toggleSessionVisibility', 'doctor', 'copyNetReport', 'copyClaudeCommand', 'syncBackup', 'exportAll', 'purgeCopies', 'purgeOwnBackup', 'exportSession', 'removeFromBackup', 'setBackupOption', 'editBackupNumber', 'useSessionInAi', 'startConversation', 'acceptConversation', 'declineConversation', 'confirmConversation', 'endConversation', 'removeHooks'].map((c) => `sessionHub.${c}`);
assert.deepEqual(expected.filter((c) => !commands.has(c)), [], 'faltan acciones en el panel');
assert.ok(![...commands].some((c) => !c.startsWith('sessionHub.')), 'el panel solo pide comandos de Session Hub');
p.view('messages');
const link = p.d.querySelector('a[href^="command:workbench.action.openSettings"]');
assert.ok(link, 'los ajustes se abren con un enlace command: del webview');
assert.deepEqual(JSON.parse(decodeURIComponent(link.getAttribute('href').split('?')[1])), ['sessionHub.inboundMessages']);
ok(`las 7 pestañas reúnen las ${expected.length} acciones del panel; los ajustes se abren sin pasar por la extensión`);

// ---------- buscadores y paginación ----------
p.view('team');
assert.equal(p.pager('people'), '1–12 de 31');
assert.equal(p.d.querySelector('.people .pcard .pname').textContent, 'Carlos', 'tú primero');
assert.match(p.d.querySelectorAll('.people .pcard')[1].textContent, /en línea/, 'luego quien está en línea');
p.search('people', 'valentina');
assert.equal(p.count('.people .pcard'), 1);
p.search('people', 'zzz');
assert.match(p.d.getElementById('lb-people').textContent, /Nada coincide/);
p.search('people', '');
p.d.querySelector('[data-pfilter="offline"]').click();
assert.ok(p.count('.people .pcard') > 0 && [...p.d.querySelectorAll('.people .pcard')].every((c) => c.classList.contains('offline')), 'filtro "Desconectados"');
assert.ok(p.d.querySelector('[data-search="people"]'), 'el buscador de personas está siempre visible');
p.d.querySelector('[data-pfilter="all"]').click();
const card = p.d.querySelectorAll('.people .pcard')[1];
assert.ok(card.querySelector('.avatar') && card.querySelector('[data-cmd="sessionHub.sendMessage"]') && card.querySelector('button[data-person]'), 'avatar, Mensaje y Ver sesiones');
card.querySelector('button[data-person]').click();
assert.equal(p.d.querySelector('[role=tab][aria-selected=true]').id, 'tab-sessions', '"Ver sesiones" lleva a sus sesiones');
p.view('team');
p.view('messages');
assert.equal(p.pager('inbox'), '1–10 de 23');
p.search('inbox', 'firmas');
assert.equal(p.count('#lb-inbox .msgbox'), 1);
p.d.querySelector('[data-page="sent:1"]').click();
assert.equal(p.pager('sent'), '11–14 de 14');
p.view('privacy');
assert.deepEqual([p.pager('shares'), p.pager('reads')], ['1–8 de 12', '1–15 de 40']);
assert.match(p.text(), /guardó una copia/);
assert.ok(p.d.querySelector('.hint [data-view="backup"]'), 'Privacidad remite a la pestaña Respaldo');
p.view('status');
p.search('checks', 'mcp');
p.d.querySelector('[data-search="checks"]').focus();
p.w.dispatchEvent(new p.w.MessageEvent('message', { data: { type: 'state', state: p.state } }));
assert.equal(p.d.activeElement?.dataset?.search, 'checks', 'el buscador conserva el foco al refrescar');
assert.equal(p.count('#lb-checks .check'), 1);
ok('buscador y paginación en equipo, mensajes, enviados, proyectos, lecturas y estado (conserva el foco)');

// ---------- conversaciones automáticas ----------
p.view('messages');
const convRows = [...p.d.querySelectorAll('.brow.conv')].map((r) => r.textContent.replace(/\s+/g, ' '));
assert.equal(convRows.length, 4);
assert.ok(p.d.querySelector('.brow.conv.invited [data-cmd="sessionHub.acceptConversation"]'), 'invitación: Aceptar');
assert.ok(p.d.querySelector('.brow.conv.confirm [data-cmd="sessionHub.confirmConversation"]'), 'pedida por la IA: Confirmar');
assert.ok(p.d.querySelector('.brow.conv.active [data-cmd="sessionHub.endConversation"]'), 'en marcha: Detener');
assert.match(convRows.find((r) => r.includes('Persona 3')), /2 enviadas · 1 recibidas · máximo 6.*quedan \d+ min/);
assert.match(convRows.find((r) => r.includes('Persona 9')), /llegó al límite de vueltas/);
assert.match(p.d.getElementById('tab-messages').textContent, /4/, 'el contador suma invitaciones y confirmaciones pendientes');
assert.match(p.text(), /Hooks instalados en Claude Code/);
p.view('team');
assert.ok(p.d.querySelector('.pcard [data-cmd="sessionHub.startConversation"]'), '🤝 Conversar en la tarjeta de quien está en línea');
ok('conversaciones: invitación, confirmación, en marcha (vueltas y minutos) y terminada; Conversar en Equipo; estado de los hooks');

// ---------- Ayuda ----------
p.view('messages');
p.d.querySelector('[data-helpsec="conv"]').click();
assert.equal(p.d.querySelector('[role=tab][aria-selected=true]').id, 'tab-help', '"¿Cómo funciona?" abre la Ayuda');
assert.ok(p.d.getElementById('help-conv').open, 'en la sección de conversaciones');
const help = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/help.json'), 'utf8'));
assert.deepEqual(help.es.map((x) => x.id), help.en.map((x) => x.id), 'mismas secciones en los dos idiomas');
assert.equal(p.count('.hsec'), help.es.length);
const hq = p.d.getElementById('helpq');
hq.value = 'hooks';
hq.dispatchEvent(new p.w.Event('input', { bubbles: true }));
assert.ok(p.count('.hsec') >= 1 && p.count('.hsec') < help.es.length, 'el buscador filtra las secciones');
assert.ok([...p.d.querySelectorAll('.hsec')].every((d) => d.open), 'y las abre');
hq.value = '';
hq.dispatchEvent(new p.w.Event('input', { bubbles: true }));
ok(`Ayuda: ${help.es.length} secciones en español e inglés, buscador, y "¿Cómo funciona?" lleva a la sección`);

// ---------- pestaña Respaldo ----------
p.view('backup');
assert.match(p.d.querySelector('.bsum').textContent.replace(/\s+/g, ' '), /14\s*mis sesiones respaldadas 3\s*solo en el respaldo 13\s*copias de mi equipo Espacio: 4\.3 MB de 2\.0 GB/);
assert.equal(p.pager('ownbackup'), '1–10 de 14');
assert.match(p.d.querySelector('#lb-ownbackup .brow').textContent, /solo en respaldo desde/, 'primero las que solo están en el respaldo');
p.d.querySelector('[data-bfilter="gone"]').click();
assert.equal(p.count('#lb-ownbackup .brow'), 3);
assert.equal(p.count('#lb-ownbackup [data-cmd="sessionHub.removeFromBackup"]'), 3, 'se pueden borrar las que ya no existen');
p.d.querySelector('[data-bfilter="live"]').click();
assert.equal(p.count('#lb-ownbackup [data-cmd="sessionHub.removeFromBackup"]'), 0, 'las que tienen original no se borran desde aquí');
p.d.querySelector('[data-bfilter="all"]').click();
p.search('ownbackup', 'firma');
assert.equal(p.count('#lb-ownbackup .brow'), 1);
assert.equal(p.pager('copieslist'), '1–10 de 13');
p.d.querySelector(`[data-cowner="${id(3)}"]`).click();
assert.equal(p.count('#lb-copieslist .brow'), 5, 'filtro por persona');
assert.ok(p.d.querySelector('[data-cmd="sessionHub.purgeCopies"][data-args*="Persona 3"]'), 'borrar las copias de esa persona');
const toggles = [...p.d.querySelectorAll('[data-cmd="sessionHub.setBackupOption"]')].map((b) => JSON.parse(b.dataset.args));
assert.deepEqual(toggles, [['archive', false], ['teamCopies', false], ['allowCopies', false]], 'interruptores con su valor contrario');
assert.equal(p.count('[data-cmd="sessionHub.editBackupNumber"]'), 3);
p.d.querySelector('#lb-copieslist [data-openin]').click();
assert.equal(p.d.querySelector('[role=tab][aria-selected=true]').id, 'tab-sessions', '"Ver" abre la sesión en Sesiones');
assert.equal(JSON.stringify(p.posted.filter((m) => m.type === 'open').at(-1)), JSON.stringify({ type: 'open', id: 'cursor:k8', peer: id(3) }));
const staleState = JSON.parse(JSON.stringify(p.state));
delete staleState.archive.own.list;
delete staleState.archive.copies.list;
p.w.dispatchEvent(new p.w.MessageEvent('message', { data: { type: 'state', state: staleState } }));
p.view('backup');
assert.match(p.d.querySelector('.bsum').textContent.replace(/\s+/g, ' '), /14\s*mis sesiones respaldadas/, 'con un hub de otra versión muestra sus totales, no ceros');
assert.match(p.text(), /es de otra versión/);
p.w.dispatchEvent(new p.w.MessageEvent('message', { data: { type: 'state', state: p.state } }));
ok('pestaña Respaldo: resumen, filtros, búsqueda, paginación, Ver, borrar (solo lo que ya no existe), copias por persona y configuración');

// ---------- sesiones agrupadas por proyecto (projectKey) ----------
p.view('sessions');
p.d.querySelector('[data-tab="team"]').click();
const who = p.d.getElementById('person');
assert.notEqual(who.value, '', '"Ver sesiones" dejó elegida a esa persona');
who.value = '';
who.dispatchEvent(new p.w.Event('change', { bubbles: true }));
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
for (const v of ['sessions', 'messages', 'team', 'privacy', 'backup', 'status', 'help']) en.view(v);
assert.match(en.text(), /Automatic conversations/);
assert.ok(en.d.querySelector('.hsec summary').textContent.includes('Getting started'), 'Ayuda en inglés');
en.view('backup');
assert.match(en.text(), /My backed-up sessions/);
assert.match(en.text(), /My team's copies/);
assert.match(en.text(), /Let my team copy mine/);
assert.deepEqual(en.errors, []);
ok('flechas entre pestañas, sin errores de JavaScript, en español y en inglés');
console.log('\nPANEL OK');
