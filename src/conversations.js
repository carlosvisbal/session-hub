// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Conversaciones automáticas entre dos sesiones de IA (mía y de un compañero).
//
// Solo existen si LAS DOS personas las aceptan. Mientras están activas, los mensajes entre esas dos
// sesiones se entregan solos, y los hooks de Claude Code / Cursor (session-hub-hook) se los pasan a
// cada agente al terminar su turno para que responda sin que nadie pulse Enviar.
// Límites: un número de vueltas (ida y vuelta) y un tiempo; al llegar, o si se repiten o se vacían los
// mensajes, la conversación termina para los dos.
//
// Las órdenes entre hubs (invitar, aceptar, rechazar, terminar) viajan firmadas, como los mensajes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signDoc, verifyDoc } from './identity.js';

export const DEFAULTS = { turns: 6, minutes: 10 };
export const MAX = { turns: 20, minutes: 60 };
const INVITE_MINUTES = 30; // una invitación sin respuesta vence
const CLOCK_SKEW_MS = 5 * 60_000;
const KEEP_DAYS = 30;
const ACTIONS = new Set(['invite', 'accept', 'decline', 'end']);

const err = (message, code = 'invalid') => Object.assign(new Error(message), { code });
const clampInt = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.parseInt(v, 10) || d));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

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
    list = list.filter((c) => c.status !== 'ended' || Date.parse(c.endedAt || c.createdAt) > cutoff).slice(-200);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ list }, null, 1), { mode: 0o600 });
  };
  const iso = () => new Date(now()).toISOString();
  const find = (id) => list.find((c) => c.id === id) || null;

  // Vence lo que pasó su tiempo (invitaciones sin respuesta, conversaciones activas).
  function expire() {
    let changed = false;
    for (const c of list) {
      if (c.status === 'active' && c.expiresAt && Date.parse(c.expiresAt) < now()) Object.assign(c, { status: 'ended', endedAt: iso(), endReason: 'time' }), (changed = true);
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
    create({ peer, peerName, mine, theirs, text, turns, minutes, confirm = false }) {
      const team = teamState.team();
      if (!team || team.pending) throw err('Necesitas ser miembro confirmado del equipo.');
      if (!text || !String(text).trim()) throw err('Escribe el primer mensaje de la conversación.');
      const c = {
        id: crypto.randomUUID(),
        role: 'initiator',
        peer,
        peerName,
        mine: mine || null,
        theirs: theirs || null,
        text: String(text).trim().slice(0, 20_000),
        turns: clampInt(turns, 1, MAX.turns, DEFAULTS.turns),
        minutes: clampInt(minutes, 1, MAX.minutes, DEFAULTS.minutes),
        status: confirm ? 'confirm' : 'inviting',
        sent: 0,
        received: 0,
        awaiting: false,
        createdAt: iso(),
      };
      list.push(c);
      save();
      return c;
    },

    inviteDoc: (c) => sign(c, 'invite', { text: c.text }),
    controlDoc: (c, action, extra) => sign(c, action, extra),

    confirmLocal(id) {
      const c = find(id);
      if (!c || c.status !== 'confirm') throw err('No hay nada que confirmar en esa conversación.');
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
      let c = find(b.id);
      if (b.action === 'invite') {
        if (c) return { status: c.status };
        c = {
          id: String(b.id),
          role: 'invitee',
          peer: peer.id,
          peerName: peer.name,
          mine: b.theirs || null, // la sesión mía que pidió
          theirs: b.mine || null,
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
      if (b.action === 'accept' && c.status === 'inviting') Object.assign(c, { status: 'active', theirs: b.mine || c.theirs, startedAt: iso(), expiresAt: new Date(now() + c.minutes * 60_000).toISOString() });
      if (b.action === 'decline' && c.status !== 'ended') Object.assign(c, { status: 'ended', endedAt: iso(), endReason: 'declined' });
      if (b.action === 'end' && c.status !== 'ended') Object.assign(c, { status: 'ended', endedAt: iso(), endReason: b.reason || 'peer' });
      save();
      return { status: c.status };
    },

    accept(id, mine) {
      const c = find(id);
      if (!c || c.status !== 'invited') throw err('Esa invitación ya no está pendiente.');
      Object.assign(c, { status: 'active', mine: mine || c.mine || null, startedAt: iso(), expiresAt: new Date(now() + c.minutes * 60_000).toISOString() });
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

    // Conversación activa con esa persona (si hay una sola, o la indicada).
    activeWith(peerId, id) {
      expire();
      const act = list.filter((c) => c.status === 'active' && c.peer === peerId);
      if (id) return act.find((c) => c.id === id) || null;
      return act.length === 1 ? act[0] : null;
    },

    // La conversación de una sesión mía; si alguna activa no tiene sesión todavía, se enlaza a la primera
    // que termine un turno dentro de los 5 minutos siguientes a empezar.
    forSession(session) {
      expire();
      const act = list.filter((c) => c.status === 'active');
      const bound = act.find((c) => c.mine === session);
      if (bound) return bound;
      const unbound = act.find((c) => !c.mine && now() - Date.parse(c.startedAt || c.createdAt) < 5 * 60_000);
      if (!unbound) return null;
      unbound.mine = session;
      save();
      return unbound;
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
