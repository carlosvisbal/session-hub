// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Conexiones entre hubs con Hyperswarm: cifradas con Noise y autenticadas por clave pública.
//
// Al conectar, cada lado presenta su cadena de certificados. Si no verifica, o la clave de la
// conexión no es la del certificado, se corta y esa clave queda bloqueada un rato.
//
// Modos de red:
//   lan     — los propios hubs forman la red (DHT privada); no necesita internet.
//   private — nodos de arranque propios (`bootstrap`), para remoto o VPN controlados.
//   public  — red pública de HyperDHT, para remoto sin montar nada.
import crypto from 'node:crypto';
import Hyperswarm from 'hyperswarm';
import DHT from 'hyperdht';
import { fingerprint, keyPairBuffers, signProfile, toHex, verifyProfile } from '../identity.js';
import { parseAddr, reachableAddresses, withTimeout } from '../net.js';
import { createRpc } from './rpc.js';

const HELLO_TIMEOUT_MS = 10_000;
const REFRESH_MS = 30_000; // en redes chicas, entrar a la vez no basta: se vuelve a buscar
const WHOAMI_MS = 15_000;
const BAN_MS = 10 * 60_000;
const PENDING_RETRY_MS = 15_000; // quien espera su admisión reintenta pronto
const START_TIMEOUT_MS = 15_000;
const DIAL_MS = 15_000; // con pocos miembros la DHT no alcanza: se marca directo a los conocidos

export function createSwarmTransport({ cfg, teamState, onRequest, onEvent = () => {}, log = console.log }) {
  const peers = new Map(); // clave pública -> compañero conectado y verificado
  const bannedUntil = new Map();
  const rejections = [];
  let swarm = null;
  let dht = null;
  let discovery = null;
  let timers = [];
  let startedAt = null;
  let lastError = null;

  const myAddrs = () => reachableAddresses().map((ip) => `${ip}:${cfg.dhtPort}`);
  const profile = () => signProfile(teamState.keyPair(), { name: cfg.owner.name, role: cfg.owner.role });
  const topic = () => crypto.createHash('sha256').update('session-hub/v2/' + teamState.team().id).digest();

  function bootstrapList() {
    const mine = new Set(myAddrs());
    const addrs = cfg.network === 'private' ? cfg.bootstrap : [...cfg.peers, ...teamState.state.addrs];
    return [...new Set(addrs)].filter((a) => !mine.has(a)).map(parseAddr).filter(Boolean);
  }

  function makeDht(keyPair) {
    if (cfg.network === 'public') return new DHT({ keyPair });
    if (cfg.network === 'private') return new DHT({ keyPair, bootstrap: bootstrapList() });
    // lan: nodo persistente y alcanzable en la red local; el equipo es la red.
    return new DHT({ keyPair, ephemeral: false, firewalled: false, host: '0.0.0.0', port: cfg.dhtPort, bootstrap: bootstrapList() });
  }

  const dialing = new Set();

  // Marca directo a los miembros conocidos que no están conectados, usando su última dirección.
  function dialKnown() {
    if (!dht || cfg.network === 'public') return;
    for (const m of teamState.roster()) {
      const pub = m.id;
      const addrs = teamState.addrsOf(pub).map(parseAddr).filter(Boolean);
      if (pub === teamState.me() || peers.has(pub) || dialing.has(pub) || isBanned(pub) || !addrs.length) continue;
      dialing.add(pub);
      const sock = dht.connect(Buffer.from(pub, 'hex'), { keyPair: keyPairBuffers(teamState.keyPair()), relayAddresses: addrs });
      const done = () => dialing.delete(pub);
      sock.once('open', () => {
        done();
        onConnection(sock);
      });
      sock.once('error', done);
      sock.once('close', done);
      setTimeout(() => dialing.has(pub) && (sock.destroy(), done()), 10_000);
    }
  }

  // Si hay dos conexiones con la misma persona, gana siempre la que inició la clave menor.
  const preferred = (conn, pub) => (conn.isInitiator ? teamState.me() : pub) === [teamState.me(), pub].sort()[0];

  const isBanned = (pub) => (bannedUntil.get(pub) || 0) > Date.now() || teamState.isBlocked(pub) || teamState.isRevoked(pub);

  function reject(pub, reason, conn, { ms = BAN_MS, quiet = false } = {}) {
    const fresh = !((bannedUntil.get(pub) || 0) > Date.now());
    bannedUntil.set(pub, Date.now() + ms);
    conn?.destroy();
    if (!fresh || quiet) return;
    const r = { at: new Date().toISOString(), id: pub, fingerprint: fingerprint(pub), reason };
    rejections.unshift(r);
    rejections.length = Math.min(rejections.length, 50);
    log(`[red] conexión rechazada ${r.fingerprint}: ${reason}`);
    onEvent('rejected', r);
  }

  function info(p) {
    return { id: p.id, fingerprint: p.fingerprint, name: p.name, role: p.role, invitedBy: p.invitedBy, paused: !!p.paused, projects: p.projects || [], online: true, since: p.since };
  }

  function handleMessage(peer, msg) {
    if (msg.t === 'revoke' && teamState.applyRevocation(msg.doc)) {
      onEvent('revoked', msg.doc.body);
      peers.get(msg.doc.body.member)?.conn.destroy();
    }
    if (msg.t === 'admitted' && teamState.receiveAdmission(msg.doc, peer.id)) {
      log(`[equipo] ${peer.name} confirmó tu admisión: ya eres miembro de ${teamState.team().name}`);
      onEvent('admitted', { by: peer.id });
      bannedUntil.clear(); // que los demás vuelvan a intentarlo conmigo ya admitido
      discovery?.refresh().catch(() => {});
      setTimeout(dialKnown, 1000);
    }
    if (msg.t === 'profile') {
      const p = verifyProfile(peer.id, msg.profile);
      if (p) Object.assign(peer, { name: p.name, role: p.role }) && teamState.rememberProfile(peer.id, p);
    }
  }

  function onConnection(conn) {
    const pub = toHex(conn.remotePublicKey);
    conn.on('error', () => {});
    if (isBanned(pub)) return conn.destroy();
    let peer = null;

    const rpc = createRpc(conn, {
      label: fingerprint(pub),
      onRequest: (op, args) => {
        if (!peer) throw new Error('Primero preséntate');
        peer.lastSeen = Date.now();
        return onRequest(op, args, peer);
      },
      onMessage: (msg) => {
        if (msg.t === 'hello' && !peer) return onHello(msg);
        if (peer) handleMessage(peer, msg);
      },
    });

    const helloTimer = setTimeout(() => !peer && reject(pub, 'no se presentó a tiempo', conn), HELLO_TIMEOUT_MS);

    function onHello(msg) {
      clearTimeout(helloTimer);
      const r = teamState.admit(msg.chain, pub);
      // Pendiente de que lo confirme quien lo invitó: normal al unirse, se reintenta en breve.
      if (!r.ok && r.pending) return reject(pub, r.error, conn, { ms: PENDING_RETRY_MS, quiet: true });
      if (!r.ok) return reject(pub, r.error, conn);
      if (r.admission) {
        rpc.send({ t: 'admitted', doc: r.admission });
        log(`[equipo] admitiste a ${fingerprint(pub)} con tu invitación`);
      }
      // Chismes: miembros y expulsiones que el otro conoce (cada uno se verifica por separado).
      for (const chain of (msg.gossip?.members || []).slice(0, 300)) teamState.admit(chain, null);
      for (const doc of (msg.gossip?.revocations || []).slice(0, 300)) if (teamState.applyRevocation(doc)) onEvent('revoked', doc.body);
      if (teamState.isRevoked(pub)) return reject(pub, 'expulsado del equipo', conn);
      teamState.learnAddrs(msg.addrs || [], pub);
      const p = verifyProfile(pub, msg.profile) || { name: fingerprint(pub), role: '' };
      teamState.rememberProfile(pub, p);
      peer = { id: pub, fingerprint: fingerprint(pub), name: p.name, role: p.role, invitedBy: r.invitedBy, conn, rpc, since: new Date().toISOString(), lastSeen: Date.now() };
      const prev = peers.get(pub);
      if (prev && prev.conn !== conn && !preferred(conn, pub)) return conn.destroy(); // me quedo con la otra
      peers.set(pub, peer);
      if (prev && prev.conn !== conn) prev.conn.destroy();
      if (!prev) log(`[red] ${p.name}${p.role ? ' · ' + p.role : ''} conectado (${peer.fingerprint})`);
      onEvent('joined', info(peer));
      refreshWhoami(peer);
    }

    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (peer && peers.get(pub) === peer) {
        peers.delete(pub);
        log(`[red] ${peer.name} desconectado`);
        onEvent('left', { id: pub });
      }
    });

    rpc.send({ t: 'hello', v: 2, chain: teamState.myChain(), profile: profile(), addrs: myAddrs(), gossip: teamState.gossip() });
  }

  async function refreshWhoami(peer) {
    try {
      const w = await peer.rpc.call('whoami', { origin: { via: 'hub' } }, 8000);
      Object.assign(peer, { paused: !!w.paused, projects: w.projects || [] });
    } catch {
      // sin respuesta: se reintenta en el próximo ciclo
    }
  }

  const api = {
    async start() {
      if (swarm || !teamState.hasTeam()) return;
      lastError = null;
      try {
        const keyPair = keyPairBuffers(teamState.keyPair());
        dht = makeDht(keyPair);
        swarm = new Hyperswarm({ keyPair, dht, firewall: (remote) => isBanned(toHex(remote)) });
        swarm.on('connection', onConnection);
        discovery = swarm.join(topic(), { server: true, client: true });
        startedAt = new Date().toISOString();
        await withTimeout(discovery.flushed(), START_TIMEOUT_MS, 'La red tardó en responder; sigo intentando en segundo plano');
        log(`[red] modo ${cfg.network} · puerto UDP ${cfg.network === 'lan' ? cfg.dhtPort : 'automático'} · equipo ${teamState.team().name}`);
      } catch (err) {
        lastError = err.message;
        log(`[red] ${err.message}`);
      }
      dialKnown();
      timers.push(
        setInterval(dialKnown, DIAL_MS),
        setInterval(() => discovery?.refresh().catch(() => {}), REFRESH_MS),
        setInterval(() => peers.forEach(refreshWhoami), WHOAMI_MS),
      );
    },

    async stop() {
      timers.forEach(clearInterval);
      timers = [];
      const s = swarm;
      const d = dht;
      swarm = dht = discovery = null;
      peers.clear();
      await withTimeout(Promise.allSettled([s?.destroy(), d?.destroy()]), 5000, 'cierre lento').catch(() => {});
    },

    async restart() {
      await api.stop();
      await api.start();
    },

    // Pregunta a un compañero conectado. Siempre termina: responde, falla o vence.
    request(pub, op, args, timeoutMs) {
      const p = peers.get(pub);
      if (!p) return Promise.reject(Object.assign(new Error('No está conectado ahora'), { code: 'offline' }));
      return p.rpc.call(op, args, timeoutMs);
    },

    broadcast(msg) {
      for (const p of peers.values()) p.rpc.send(msg);
    },

    disconnect(pub) {
      peers.get(pub)?.conn.destroy();
    },

    announceProfile() {
      api.broadcast({ t: 'profile', profile: profile() });
    },

    // Conectados + miembros conocidos que no están en línea ahora.
    list() {
      const online = [...peers.values()].map(info);
      const ids = new Set(online.map((p) => p.id));
      const offline = teamState
        .roster()
        .filter((m) => !ids.has(m.id) && m.id !== teamState.me() && !m.revoked)
        .map((m) => ({ id: m.id, fingerprint: m.fingerprint, name: m.name || m.fingerprint, role: m.role || '', invitedBy: m.invitedBy, paused: false, projects: [], online: false }));
      return [...online, ...offline];
    },

    status() {
      return {
        running: !!swarm,
        network: cfg.network,
        udpPort: cfg.network === 'lan' ? cfg.dhtPort : null,
        startedAt,
        lastError,
        connected: peers.size,
        myAddrs: myAddrs(),
        bootstrap: bootstrapList().map((b) => `${b.host}:${b.port}`),
        rejections: rejections.slice(0, 10),
      };
    },
  };
  return api;
}
