// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Conversaciones automáticas entre dos sesiones de IA (mía y de un compañero).
//
// Solo existen si LAS DOS personas las aceptan y las DOS sesiones quedan escritas (la mía y la suya).
// En esta misma computadora también: dos chats distintos (dos de Claude Code, dos de Cursor, o uno
// de cada editor), con una sola confirmación, porque quien confirma es los dos lados.
// Mientras están activas, los mensajes se entregan solos solo al chat que firmó, y los hooks de
// Claude Code / Cursor (session-hub-hook) se los pasan a ese agente al terminar su turno.
// Límite: un número de vueltas (ida y vuelta). No hay reloj: no se corta por minutos. Si se repiten o
// se vacían los mensajes, o alguien la detiene, termina para los dos.
//
// Las órdenes entre hubs (invitar, aceptar, rechazar, terminar) viajan firmadas, como los mensajes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signDoc, verifyDoc } from './identity.js';

export const DEFAULTS = { turns: 100, minutes: 10 };
export const MAX = { turns: 100, minutes: 60 };
const INVITE_MINUTES = 30; // una invitación sin respuesta vence
const CLOCK_SKEW_MS = 5 * 60_000;
const KEEP_DAYS = 30;
const ACTIONS = new Set(['invite', 'accept', 'decline', 'end']);
// Razones de fin que se aceptan de un compañero; cualquier otra cosa se muestra como "la terminó él".
const PEER_END_REASONS = new Set(['limit', 'time', 'loop', 'empty']);
const MAX_PENDING_PER_PEER = 3; // invitaciones sin responder de una misma persona
const MAX_INVITES_PER_HOUR = 20; // invitaciones de una misma persona por hora

const err = (message, code = 'invalid') => Object.assign(new Error(message), { code });
const clampInt = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
// claude:<id> o cursor:<id>. Cualquier otra cosa no ata un chat.
const SESSION_ID = /^(claude|cursor):[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
export function sessionId(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return SESSION_ID.test(s) ? s : '';
}

export function createConversations({ file, teamState, now = Date.now }) {
  let list = [];
  if (file && fs.existsSync(file)) {
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8')).list || [];
    } catch {
      list = [];
    }
  }
  const save = () => {
    const cutoff = now() - KEEP_DAYS * 86400e3;
    list = list.filter((c) => c.status !== 'ended' || Date.parse(c.endedAt || c.createdAt) > cutoff);
    // Tope de 200: se descartan primero las terminadas; nunca una activa por exceso de invitaciones.
    while (list.length > 200) {
      let i = list.findIndex((c) => c.status === 'ended');
      if (i < 0) i = list.findIndex((c) => c.status !== 'active');
      if (i < 0) break;
      list.splice(i, 1);
    }
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ list }, null, 1), { mode: 0o600 });
  };
  const iso = () => new Date(now()).toISOString();
  const find = (id) => list.find((c) => c.id === id) || null;
  // Una sesión no entra en dos conversaciones a la vez: el hook no sabría a cuál entregar.
  // En una local, las dos sesiones ocupan el hook.
  const occupies = (c, session) => c.mine === session || (c.local && c.theirs === session);
  const busy = (session, except) => list.some((c) => c.status === 'active' && occupies(c, session) && c.id !== except);

  // Vence lo que pasó su tiempo (invitaciones sin respuesta, conversaciones activas).
  function expire() {
    let changed = false;
    for (const c of list) {
      // Una conversación activa no vence por tiempo. expiresAt de versiones anteriores se ignora.
      if ((c.status === 'inviting' || c.status === 'invited' || c.status === 'confirm') && Date.parse(c.createdAt) + INVITE_MINUTES * 60_000 < now()) Object.assign(c, { status: 'ended', endedAt: iso(), endReason: 'unanswered' }), (changed = true);
    }
    if (changed) save();
  }

  function sign(c, action, extra = {}) {
    const team = teamState.team();
    return signDoc(teamState.keyPair(), {
      kind: 'conv',
      v: 1,
      id: c.id,
      action,
      team: team.id,
      from: teamState.me(),
      to: c.peer,
      at: iso(),
      turns: c.turns,
      minutes: c.minutes,
      mine: c.mine || null, // mi sesión (para el otro, "theirs")
      theirs: c.theirs || null, // la sesión suya a la que quiero hablarle
      ...extra,
    });
  }

  const api = {
    DEFAULTS,
    list() {
      expire();
      return [...list].reverse();
    },
    get: (id) => (expire(), find(id)),

    // Crea una conversación mía. confirm=true: la pidió la IA por MCP y falta que yo la confirme.
    create({ peer, peerName, mine, theirs, text, turns, minutes, confirm = false, local = false }) {
      const team = teamState.team();
      if (!team || team.pending) throw err('Necesitas ser miembro confirmado del equipo.');
      if (!text || !String(text).trim()) throw err('Escribe el primer mensaje de la conversación.');
      const own = sessionId(mine);
      const other = sessionId(theirs);
      // La invitación no sale sin la sesión de quien la inicia. Si la pide la IA, la sesión se elige al confirmar.
      // Una local exige las dos sesiones de esta computadora, distintas, antes de quedar activa.
      if (local) {
        if (own && other && own === other) throw err('Elige dos sesiones distintas.');
        if (!confirm && (!own || !other)) throw err('Elige las dos sesiones de esta computadora.');
        if (own && busy(own)) throw err('Esa sesión ya está en otra conversación automática.');
        if (other && other !== own && busy(other)) throw err('Esa sesión ya está en otra conversación automática.');
      } else if (!confirm && !own) throw err('Elige la sesión tuya que participa.');
      const activeNow = !!local && !confirm;
      const c = {
        id: crypto.randomUUID(),
        role: 'initiator',
        local: !!local,
        peer,
        peerName,
        mine: own || null,
        theirs: other || null,
        text: String(text).trim().slice(0, 20_000),
        turns: clampInt(turns, 1, MAX.turns, DEFAULTS.turns),
        minutes: clampInt(minutes, 1, MAX.minutes, DEFAULTS.minutes),
        status: confirm ? 'confirm' : activeNow ? 'active' : 'inviting',
        sent: 0,
        received: 0,
        awaiting: false,
        awaitingSession: null,
        createdAt: iso(),
        ...(activeNow ? { startedAt: iso() } : {}),
      };
      list.push(c);
      save();
      return c;
    },

    inviteDoc: (c) => sign(c, 'invite', { text: c.text }),
    controlDoc: (c, action, extra) => sign(c, action, extra),

    confirmLocal(id, mine, theirs) {
      const c = find(id);
      if (!c || c.status !== 'confirm') throw err('No hay nada que confirmar en esa conversación.');
      const own = sessionId(mine) || sessionId(c.mine);
      if (c.local) {
        const other = sessionId(theirs) || sessionId(c.theirs);
        if (!own || !other) throw err('Elige las dos sesiones de esta computadora.');
        if (own === other) throw err('Elige dos sesiones distintas.');
        if (busy(own, c.id) || busy(other, c.id)) throw err('Esa sesión ya está en otra conversación automática.');
        Object.assign(c, { status: 'active', mine: own, theirs: other, startedAt: iso() });
        save();
        return c;
      }
      if (!own) throw err('Elige la sesión tuya que participa.');
      c.mine = own;
      c.theirs = sessionId(c.theirs) || null;
      c.status = 'inviting';
      save();
      return c;
    },

    // Llega una orden firmada de un compañero (identidad ya verificada por el canal).
    receive(doc, peer) {
      const b = doc?.body;
      const team = teamState.team();
      if (!b || b.kind !== 'conv' || b.v !== 1 || !ACTIONS.has(b.action)) throw err('Orden de conversación con formato desconocido.');
      if (b.from !== peer.id || !verifyDoc(peer.id, doc)) throw err('La firma no corresponde al remitente.');
      if (b.to !== teamState.me() || !team || b.team !== team.id) throw err('Esta orden no es para mí.');
      const at = Date.parse(b.at);
      if (!at || at > now() + CLOCK_SKEW_MS || at < now() - INVITE_MINUTES * 60_000) throw err('Orden fuera de plazo.');
      expire(); // una invitación vencida no se puede aceptar
      let c = find(b.id);
      if (b.action === 'invite') {
        if (c && c.peer !== peer.id) throw err('Orden de conversación con formato desconocido.');
        if (c) return { status: c.status };
        const fromPeer = list.filter((x) => x.peer === peer.id && x.role === 'invitee');
        if (fromPeer.filter((x) => x.status === 'invited').length >= MAX_PENDING_PER_PEER) throw err('Ya tienes invitaciones sin responder de esta persona.');
        if (fromPeer.filter((x) => Date.parse(x.createdAt) > now() - 3600e3).length >= MAX_INVITES_PER_HOUR) throw err('Demasiadas invitaciones seguidas; espera un rato.');
        c = {
          id: String(b.id),
          role: 'invitee',
          peer: peer.id,
          peerName: peer.name,
          mine: sessionId(b.theirs) || null, // la sesión mía que pidió
          theirs: sessionId(b.mine) || null,
          text: String(b.text || '').slice(0, 20_000),
          turns: clampInt(b.turns, 1, MAX.turns, DEFAULTS.turns),
          minutes: clampInt(b.minutes, 1, MAX.minutes, DEFAULTS.minutes),
          status: 'invited',
          sent: 0,
          received: 0,
          awaiting: false,
          createdAt: iso(),
        };
        list.push(c);
        save();
        return { status: 'invited' };
      }
      if (!c || c.peer !== peer.id) throw err('No conozco esa conversación.');
      if (b.action === 'accept' && c.status === 'inviting') {
        const own = sessionId(c.mine);
        const theirs = sessionId(b.mine);
        if (!own || !theirs) throw err('La aceptación no trae las dos sesiones.');
        if (busy(own, c.id)) throw err('Esa sesión ya está en otra conversación automática.');
        Object.assign(c, { status: 'active', mine: own, theirs, startedAt: iso() });
      }
      if (b.action === 'decline' && c.status !== 'ended') Object.assign(c, { status: 'ended', endedAt: iso(), endReason: 'declined' });
      if (b.action === 'end' && c.status !== 'ended') Object.assign(c, { status: 'ended', endedAt: iso(), endReason: PEER_END_REASONS.has(b.reason) ? b.reason : 'peer' });
      save();
      return { status: c.status };
    },

    accept(id, mine) {
      const c = find(id);
      if (!c || c.status !== 'invited') throw err('Esa invitación ya no está pendiente.');
      const own = sessionId(mine) || sessionId(c.mine);
      if (!own) throw err('Elige la sesión tuya que participa.');
      if (!sessionId(c.theirs)) throw err('La invitación no dice qué sesión del otro participa.');
      if (busy(own, c.id)) throw err('Esa sesión ya está en otra conversación automática.');
      Object.assign(c, { status: 'active', mine: own, theirs: sessionId(c.theirs), startedAt: iso() });
      save();
      return c;
    },

    // No se pudo avisar la aceptación (el otro se desconectó): vuelve a quedar pendiente, para
    // reintentarla, en vez de quedar "en marcha" solo de mi lado.
    unaccept(id) {
      const c = find(id);
      if (!c || c.status !== 'active' || c.sent || c.received) return null;
      Object.assign(c, { status: 'invited', startedAt: null });
      save();
      return c;
    },

    end(id, reason = 'me') {
      const c = find(id);
      if (!c || c.status === 'ended') return null;
      Object.assign(c, { status: 'ended', endedAt: iso(), endReason: reason });
      save();
      return c;
    },

    // Termina todo lo no terminado con esa persona (invitaciones incluidas). Devuelve cuántas.
    endWith(peerId, reason) {
      let n = 0;
      for (const c of list) if (!c.local && c.peer === peerId && c.status !== 'ended') Object.assign(c, { status: 'ended', endedAt: iso(), endReason: reason }), n++;
      if (n) save();
      return n;
    },

    // Conversación activa con esa persona (si hay una sola, o la indicada).
    activeWith(peerId, id) {
      expire();
      const act = list.filter((c) => c.status === 'active' && c.peer === peerId);
      if (id) return act.find((c) => c.id === id) || null;
      return act.length === 1 ? act[0] : null;
    },

    // Solo la conversación activa cuya sesión firmada es exactamente esta. No se reasigna.
    forSession(session) {
      expire();
      const id = sessionId(session);
      if (!id) return null;
      return list.find((c) => c.status === 'active' && (c.mine === id || (c.local && c.theirs === id))) || null;
    },

    // La próxima sesión que debe hablar (la que acaba de recibir el mensaje).
    noteAwaiting(id, session) {
      const c = find(id);
      if (!c || c.status !== 'active') return;
      Object.assign(c, { awaiting: true, awaitingSession: sessionId(session) || null });
      save();
    },

    // El mensaje ya se entregó a esa sesión: no hace falta que su hook siga esperando.
    relaxAwait(id) {
      const c = find(id);
      if (!c) return;
      c.awaiting = false;
      save();
    },

    // Cuenta un mensaje. Devuelve { ok } o { ok:false, reason } si se pasó del límite o hay un bucle.
    countSent(id, text) {
      const c = find(id);
      if (!c || c.status !== 'active') return { ok: false, reason: 'inactive' };
      const t = norm(text);
      if (t.length < 2) return { ok: false, reason: 'empty' };
      if (c.lastSent && c.lastSent === t) return { ok: false, reason: 'loop' };
      if (c.sent >= c.turns) return { ok: false, reason: 'limit' };
      Object.assign(c, { sent: c.sent + 1, lastSent: t, awaiting: true });
      save();
      return { ok: true, turn: c.sent, of: c.turns };
    },

    countReceived(id, text) {
      const c = find(id);
      if (!c || c.status !== 'active') return { ok: false, reason: 'inactive' };
      const t = norm(text);
      if (c.lastReceived && c.lastReceived === t) return { ok: false, reason: 'loop' };
      if (c.received >= c.turns) return { ok: false, reason: 'limit' };
      Object.assign(c, { received: c.received + 1, lastReceived: t, awaiting: false });
      save();
      return { ok: true, turn: c.received, of: c.turns };
    },

    // ¿Terminó por límite? (los dos lados ya hablaron todas sus vueltas)
    done: (id) => {
      const c = find(id);
      return !!c && c.sent >= c.turns && c.received >= c.turns;
    },

    clear() {
      list = [];
      save();
    },
  };
  return api;
}
