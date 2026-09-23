// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Hub local: API para la extensión, el MCP y el visor (solo 127.0.0.1) + conexión cifrada con el equipo.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CONFIG_PATH, HOT_RELOAD_KEYS, NETWORK_KEYS, ROOT, loadConfig } from './config.js';
import { AccessDenied, createHub } from './hub.js';
import { createMcpServer } from './mcp.js';
import { createTeam } from './team.js';
import { createAccessLog, friendlyClient } from './access.js';
import { createInbox } from './inbox.js';
import { handleSource, sourceInfo } from './source.js';
import { setExtraPatterns } from './redact.js';
import { cursorUnavailable } from './sources/cursor.js';
import { fingerprint } from './identity.js';
import { openTeamState } from './teamstate.js';
import { createSwarmTransport } from './transport/swarm.js';
import { reachableAddresses } from './net.js';
import { diagnoseNetwork, networkReport } from './netdiag.js';
import { makeT } from './i18n.js';

const POLL_MS = 5000;
const MAX_BODY = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000; // ninguna petición HTTP queda colgada más de esto
const clamp = (n, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number(n) || dflt));
const FULL_TEXT = 1e9; // lectura completa: sin recortar mensajes
// Sin límite por defecto; 0 o "all" también significan "todo".
const lim = (v) => (v == null || v === '' || v === 'all' || Number(v) === 0 ? Infinity : Math.max(1, Number(v) || Infinity));
const PAGE = 100; // mensajes por página al leer una sesión completa por el canal cifrado
// Opciones de lectura de una sesión: página (offset/limit) o últimos N; texto completo o recortado.
const readOpts = (a) => ({
  ...(a.offset != null ? { offset: clamp(a.offset, 0, 1e9, 0), limit: clamp(a.limit, 1, 500, PAGE) } : { lastMessages: lim(a.last) }),
  maxChars: a.full === true || a.full === '1' ? FULL_TEXT : 4000,
});

export function startServer(cfg, { log = console.log } = {}) {
  const t = makeT(cfg); // idioma de los mensajes (sigue a cfg.language en caliente)
  const teamState = openTeamState(cfg.stateFile);
  cfg.id = teamState.me(); // mi identidad es mi clave pública
  const hub = createHub(cfg);
  const access = createAccessLog({ file: cfg.auditFile, retentionDays: cfg.auditRetentionDays });
  const inbox = createInbox({ file: cfg.inboxFile, teamState, policy: () => cfg.inbound });
  const transport = createSwarmTransport({ cfg, teamState, onRequest: serveRemote, onEvent, log });
  const team = createTeam(cfg, hub, transport, teamState, t, inbox);
  const panelOrigin = { via: 'panel', client: process.env.SESSION_HUB_EDITOR || 'visor web' };
  const mcpClients = new Map(); // en modo sin estado, clientInfo solo llega en "initialize"
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
  const sseClients = new Set();

  // ---------- lo que me piden mis compañeros (identidad ya verificada por el canal) ----------

  function serveRemote(op, args, peer) {
    const viewer = { id: peer.id, name: peer.name, role: peer.role, via: args.origin?.via, client: args.origin?.client };
    const q = { project: args.project, source: args.source, since: args.since, limit: lim(args.limit), viewer };
    switch (op) {
      case 'whoami':
        if (args.origin?.via !== 'hub') access.record(viewer);
        return hub.whoami(viewer);
      case 'projects':
        return hub.projects(viewer);
      case 'sessions':
        access.record(viewer);
        return hub.listSessions(q);
      case 'session':
        try {
          const s = hub.getSession(String(args.id), { ...readOpts(args), viewer });
          if (!s.offset) access.record(viewer, 'session', { sessionId: s.id, title: s.title, project: s.project }); // una vez por lectura, no por página
          return s;
        } catch (err) {
          if (err instanceof AccessDenied) access.record(viewer, 'denied', { sessionId: err.session.id, title: err.session.title, project: err.session.project });
          throw err;
        }
      case 'changes':
        access.record(viewer, 'changes', { since: args.since || '24h', project: args.project });
        return hub.whatChanged({ since: args.since, project: args.project, viewer });
      case 'search':
        access.record(viewer, 'search', { query: String(args.q || '').slice(0, 200) });
        return hub.search(String(args.q || ''), { project: args.project, limit: lim(args.limit), viewer });
      case 'agents':
        access.record(viewer); // solo presencia
        return hub.liveAgents(viewer);
      case 'message': {
        const r = inbox.receive(args.doc, peer);
        log(`[mensajes] ${peer.name} te escribió (${r.status === 'held' ? 'retenido hasta que lo apruebes' : 'visible para tu IA'})`);
        return r;
      }
      default:
        throw new Error(`Operación desconocida: ${op}`);
    }
  }

  function onEvent(type, data) {
    if (type === 'rejected') access.record({ id: `key:${data.id}`, name: `Clave desconocida ${data.fingerprint}`, via: 'red' }, 'rejected', { reason: data.reason });
    if (type === 'conn-issue') log(`[red] no se pudo conectar con ${data.peer}: ${data.code}`);
    if (type === 'joined') team.flushQueue(data.id).catch(() => {});
    if (type === 'receipt') inbox.receipt(data.from, data.id, data.status);
    if (type === 'revoked') log(`[equipo] ${fingerprint(data.member)} fue expulsado por ${fingerprint(data.by)}`);
  }

  function messageStatus(id, status) {
    const m = inbox.get(String(id));
    if (!m) throw new Error('Mensaje no encontrado.');
    team.notifySender(inbox.setStatus(m.id, status));
    return inbox.get(m.id);
  }

  // ---------- estado del equipo para el panel ----------

  function teamInfo() {
    const t = teamState.team();
    return {
      hasTeam: !!t,
      team: t ? { id: t.id, name: t.name, fingerprint: fingerprint(t.id), pending: !!t.pending, invitedBy: t.invitedBy ? fingerprint(t.invitedBy) : null } : null,
      me: { id: teamState.me(), fingerprint: fingerprint(teamState.me()), name: cfg.owner.name, role: cfg.owner.role },
      network: transport.status(),
    };
  }

  function diagnostics() {
    const peersInfo = team.peersInfo();
    return {
      runtime: { node: process.versions.node, electron: process.versions.electron || null, sqlite: !cursorUnavailable, sqliteError: cursorUnavailable },
      api: { port: cfg.port, host: cfg.host },
      network: transport.status(),
      networkIssues: diagnoseNetwork(transport.status()).map((i) => ({ ...i, title: t(i.title), cause: t(i.cause), fix: t(i.fix), it: i.it && t(i.it) })),
      team: { ...teamInfo(), peersOnline: peersInfo.filter((m) => !m.self && m.online).length, members: peersInfo.length - 1 },
      sharing: { paused: !!cfg.paused, projects: hub.diagnostics(), staleAllow: cfg.projects.filter((p) => p.allow.some((a) => a !== '*' && !/^[0-9a-f]{64}$/.test(a))).map((p) => p.name) },
      audit: { file: cfg.auditFile, retentionDays: cfg.auditRetentionDays, entries: access.snapshot().reads.length },
    };
  }

  // ---------- HTTP local ----------

  const authorized = (req, url) => {
    const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(cfg.localToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const send = (res, status, data) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  // Rutas que el panel puede dirigir a una persona con ?peer= (van por el canal cifrado).
  const OPS = { '/api/sessions': 'sessions', '/api/changes': 'changes', '/api/search': 'search', '/api/projects': 'projects' };

  const routes = {
    'GET /api/whoami': () => ({ ...hub.whoami(), fingerprint: fingerprint(teamState.me()), software: sourceInfo(cfg) }),
    'GET /api/team': () => teamInfo(),
    'GET /api/peers': () => team.peersInfo(),
    'GET /api/access': () => access.snapshot(),
    'GET /api/sharing': () => hub.sharing(),
    'GET /api/diagnostics': () => diagnostics(),
    'GET /api/netreport': () => {
      const st = transport.status();
      const issues = diagnoseNetwork(st);
      const me = { name: cfg.owner.name, role: cfg.owner.role, fingerprint: fingerprint(teamState.me()) };
      return { issues: issues.map((i) => ({ ...i, title: t(i.title), cause: t(i.cause), fix: t(i.fix), it: i.it && t(i.it) })), text: networkReport({ st, issues, me, team: teamState.team()?.name, version: sourceInfo(cfg).version, t }) };
    },
    'GET /api/team/sessions': (q) => team.listSessions({ ...q, limit: lim(q.limit) }, panelOrigin),
    'GET /api/team/changes': (q) => team.whatChanged(q, panelOrigin),
    'GET /api/team/agents': (q) => team.listAgents(q, panelOrigin),
    'GET /api/agents': () => hub.liveAgents(),

    'GET /api/inbox': () => inbox.list(),
    'POST /api/messages/send': (q, body) => team.sendMessage(body, panelOrigin),
    // Permitir que mi IA lo lea (check_inbox), pasarlo al chat de mi IA (leído) o descartarlo.
    'POST /api/inbox/approve': (q, body) => messageStatus(body.id, 'delivered'),
    'POST /api/inbox/handoff': (q, body) => messageStatus(body.id, 'read'),
    'POST /api/inbox/dismiss': (q, body) => messageStatus(body.id, 'dismissed'),

    'POST /api/team/create': async (q, body) => {
      if (teamState.hasTeam()) throw new Error('Ya perteneces a un equipo. Sal de él antes de crear otro.');
      teamState.createTeam(String(body.name || '').trim() || 'equipo');
      await transport.restart();
      return teamInfo();
    },
    'POST /api/team/join': async (q, body) => {
      if (teamState.hasTeam()) throw new Error('Ya perteneces a un equipo. Sal de él antes de unirte a otro.');
      const r = teamState.join(String(body.code || ''));
      if (r.network && r.network !== cfg.network) log(`[equipo] la invitación usa la red "${r.network}"; esta instalación usa "${cfg.network}"`);
      await transport.restart();
      return { ...teamInfo(), inviteNetwork: r.network };
    },
    'POST /api/team/invite': (q, body) =>
      teamState.makeInvite({ hours: clamp(body.hours, 1, 168, 48), network: cfg.network, bootstrap: cfg.network === 'private' ? cfg.bootstrap : reachableAddresses().map((ip) => `${ip}:${cfg.dhtPort}`) }),
    'POST /api/team/leave': async () => {
      await transport.stop();
      teamState.leave();
      inbox.clear();
      return teamInfo();
    },
    'POST /api/members/block': (q, body) => {
      teamState.setBlocked(String(body.id), !!body.blocked);
      if (body.blocked) transport.disconnect(String(body.id));
      return { ok: true };
    },
    'POST /api/members/revoke': (q, body) => {
      const doc = teamState.revoke(String(body.id), body.reason);
      transport.broadcast({ t: 'revoke', doc });
      transport.disconnect(String(body.id));
      return { ok: true };
    },
  };

  async function handleApi(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    delete q.token;
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) return send(res, 200, await routes[key](q, req.method === 'POST' ? (await readJson(req)) || {} : {}));

    // ?peer=<nombre|huella|id> → la misma consulta a esa persona, por el canal cifrado
    const isSession = url.pathname.startsWith('/api/sessions/');
    const op = isSession ? 'session' : OPS[url.pathname];
    if (q.peer && op) {
      const peer = q.peer;
      delete q.peer;
      if (isSession) {
        const id = decodeURIComponent(url.pathname.slice(14));
        if (q.full === '1') return send(res, 200, await team.getSession(id, { peer, full: true }, panelOrigin));
        Object.assign(q, { id, last: q.last });
      }
      return send(res, 200, await team.proxy(peer, op, q, panelOrigin));
    }
    // Mis propias sesiones (soy el dueño: veo todo, con marcas de oculto)
    if (url.pathname === '/api/projects') return send(res, 200, hub.projects());
    if (url.pathname === '/api/sessions') return send(res, 200, hub.listSessions({ ...q, limit: lim(q.limit) }));
    if (isSession) return send(res, 200, hub.getSession(decodeURIComponent(url.pathname.slice(14)), q.full === '1' ? { lastMessages: Infinity, maxChars: FULL_TEXT } : readOpts(q)));
    if (url.pathname === '/api/changes') return send(res, 200, hub.whatChanged(q));
    if (url.pathname === '/api/search') return send(res, 200, hub.search(q.q || '', { ...q, limit: lim(q.limit) }));
    if (url.pathname === '/api/events') return openEvents(req, res);
    send(res, 404, { error: 'No encontrado' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (url.pathname === '/health') return send(res, 200, { ok: true, team: teamState.hasTeam(), network: transport.status().running });
      if (req.method === 'GET' && handleSource(req, res, url, cfg)) return; // AGPL §13, sin token
      if (!authorized(req, url)) return send(res, 401, { error: 'Token inválido' });
      if (url.pathname === '/mcp') return await handleMcp(req, res);
      await handleApi(req, res, url);
    } catch (err) {
      send(res, err.code === 'offline' ? 503 : err.code === 'timeout' ? 504 : 400, { error: t(err.message), code: err.code });
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 10_000;

  // MCP sin estado: un servidor por petición; no hay sesiones que limpiar.
  async function handleMcp(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    const body = await readJson(req);
    const key = `${req.socket.remoteAddress}|${req.headers['user-agent'] || ''}`;
    if (body?.method === 'initialize') mcpClients.set(key, friendlyClient(body.params?.clientInfo?.name));
    const software = { ...sourceInfo(cfg), source: cfg.sourceUrl || `http://127.0.0.1:${cfg.port}/source` };
    const mcp = createMcpServer(team, software, { via: 'mcp', client: mcpClients.get(key) || friendlyClient(req.headers['user-agent']) }, t);
    const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      mcpTransport.close();
      mcp.close();
    });
    await mcp.connect(mcpTransport);
    await mcpTransport.handleRequest(req, res, body);
    if (body?.method === 'tools/call') log(`[mcp] ${body.params?.name}`);
  }

  function openEvents(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 5000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  // Avisa al visor web de sesiones nuevas o actualizadas.
  let lastSeen = new Map(hub.listSessions({ limit: 200 }).map((s) => [s.id, s.updatedAt]));
  const timer = setInterval(() => {
    if (!sseClients.size) return;
    const now = hub.listSessions({ limit: 200 });
    const changed = now.filter((s) => lastSeen.get(s.id) !== s.updatedAt);
    lastSeen = new Map(now.map((s) => [s.id, s.updatedAt]));
    if (changed.length) for (const c of sseClients) c.write(`event: sessions\ndata: ${JSON.stringify(changed)}\n\n`);
  }, POLL_MS);

  // Recarga en caliente: compartir, pausar, ocultar, nombre. Cambios de red reinician solo la conexión.
  fs.watchFile(CONFIG_PATH, { interval: 1000 }, async () => {
    try {
      const next = loadConfig();
      const netChanged = NETWORK_KEYS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(next[k]));
      const ownerChanged = JSON.stringify(cfg.owner) !== JSON.stringify(next.owner);
      for (const k of HOT_RELOAD_KEYS) cfg[k] = next[k];
      setExtraPatterns(cfg.redactExtra);
      if (netChanged) await transport.restart();
      else if (ownerChanged) transport.announceProfile();
      log(`[config] recargada${cfg.paused ? ' · EN PAUSA' : ''}${netChanged ? ' · red reiniciada' : ''}`);
    } catch (err) {
      log(`[config] no se pudo recargar: ${err.message}`);
    }
  });

  server.on('error', (err) => {
    log(err.code === 'EADDRINUSE' ? `El puerto ${cfg.port} ya está en uso: ¿hay otro Session Hub abierto?` : `Error del servidor: ${err.message}`);
    process.exitCode = 2;
    shutdown().finally(() => process.exit(2));
  });

  server.listen(cfg.port, cfg.host, async () => {
    log(`session-hub ${sourceInfo(cfg).version} · API local http://127.0.0.1:${cfg.port} · MCP http://127.0.0.1:${cfg.port}/mcp`);
    log(`  Yo: ${cfg.owner.name}${cfg.owner.role ? ' · ' + cfg.owner.role : ''} · huella ${fingerprint(teamState.me())}`);
    log(`  ${teamState.hasTeam() ? `Equipo: ${teamState.team().name}` : 'Sin equipo todavía: créalo o únete con una invitación'}`);
    log(`  Proyectos compartidos: ${cfg.projects.map((p) => p.name).join(', ') || '(ninguno)'}`);
    await transport.start();
  });

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    fs.unwatchFile(CONFIG_PATH);
    for (const c of sseClients) c.end();
    server.close();
    await transport.stop();
  }
  server.shutdown = shutdown;
  return server;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) {
        reject(new Error('Petición demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const srv = startServer(loadConfig());
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => srv.shutdown().finally(() => process.exit(0)));
}
