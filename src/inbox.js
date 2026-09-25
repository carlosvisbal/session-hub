// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Mensajes entre personas del equipo: bandeja de entrada y de salida.
//
// Cada mensaje va firmado con la clave de quien lo envía y se verifica al llegar: la firma,
// que el remitente sea la clave de la conexión, que el destinatario sea yo y que sea de mi equipo.
// Un mensaje es texto para una persona; nunca se ejecuta nada. Por defecto queda retenido hasta
// que esa persona lo apruebe o lo pase a su IA (política "hold"); también puede aceptarlos
// siempre ("accept") o no recibirlos ("refuse").
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint, signDoc, verifyDoc } from './identity.js';

export const MAX_TEXT = 20_000; // caracteres por mensaje
export const RATE = { max: 10, ms: 60_000 }; // por remitente
export const QUEUE_HOURS = 24; // un mensaje a alguien desconectado espera hasta esto
const KEEP_DAYS = 30;
const MAX_KEPT = 500;
const CLOCK_SKEW_MS = 5 * 60_000;
export const POLICIES = ['hold', 'accept', 'refuse'];
const RECEIPTS = new Set(['held', 'delivered', 'read', 'dismissed']);

const err = (message, code) => Object.assign(new Error(message), { code });

export function createInbox({ file, teamState, policy = () => 'hold', now = Date.now }) {
  let state = { received: [], sent: [] };
  if (file && fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { received: saved.received || [], sent: saved.sent || [] };
    } catch {
      // archivo dañado: se empieza de cero
    }
  }
  const recent = new Map(); // remitente -> marcas de tiempo, para el límite de frecuencia

  function save() {
    const cutoff = new Date(now() - KEEP_DAYS * 86400e3).toISOString();
    for (const k of ['received', 'sent']) state[k] = state[k].filter((m) => m.at >= cutoff).slice(-MAX_KEPT);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 });
  }
  save();

  const cleanText = (text) => {
    const s = String(text ?? '').trim();
    if (!s) throw err('El mensaje está vacío.', 'invalid');
    if (s.length > MAX_TEXT) throw err(`El mensaje es demasiado largo (${s.length} caracteres; máximo ${MAX_TEXT}).`, 'invalid');
    return s;
  };
  const optId = (v) => (v == null || v === '' ? null : String(v).slice(0, 200));
  const find = (id) => state.received.find((m) => m.id === id);

  return {
    // Arma y firma un mensaje mío. No lo envía.
    compose({ to, text, toSession, aboutSession, replyTo, conv }) {
      const team = teamState.team();
      if (!team || team.pending) throw err('Necesitas ser miembro confirmado del equipo para enviar mensajes.', 'invalid');
      return signDoc(teamState.keyPair(), {
        kind: 'message',
        v: 1,
        id: crypto.randomUUID(),
        team: team.id,
        from: teamState.me(),
        to,
        text: cleanText(text),
        toSession: optId(toSession),
        aboutSession: optId(aboutSession),
        replyTo: optId(replyTo),
        ...(conv ? { conv: String(conv) } : {}), // conversación automática a la que pertenece
        at: new Date(now()).toISOString(),
      });
    },

    recordSent(doc, toName) {
      const b = doc.body;
      state.sent.push({ id: b.id, doc, to: b.to, toName, text: b.text, toSession: b.toSession, aboutSession: b.aboutSession, replyTo: b.replyTo, conv: b.conv || null, at: b.at, status: 'queued' });
      save();
      return state.sent.at(-1);
    },

    markSent(id, status, error = null) {
      const m = state.sent.find((x) => x.id === id);
      if (!m) return;
      Object.assign(m, { status, error, updatedAt: new Date(now()).toISOString() });
      if (status !== 'queued') delete m.doc; // entregado o rechazado: ya no hace falta reenviarlo
      save();
    },

    // Mensajes en cola para alguien que acaba de conectarse (los vencidos se marcan como tales).
    queuedFor(pub) {
      const limit = new Date(now() - QUEUE_HOURS * 3600e3).toISOString();
      const out = [];
      for (const m of state.sent) {
        if (m.to !== pub || m.status !== 'queued') continue;
        if (m.at < limit) this.markSent(m.id, 'expired');
        else out.push(m.doc);
      }
      return out;
    },

    // Llega un mensaje por el canal cifrado; `peer` es la identidad ya verificada de la conexión.
    // autoDeliver(body) → true si pertenece a una conversación automática aceptada: se entrega solo.
    receive(doc, peer, { autoDeliver = () => false } = {}) {
      const b = doc?.body;
      const team = teamState.team();
      if (!b || b.kind !== 'message' || b.v !== 1) throw err('Mensaje con formato desconocido.', 'invalid');
      if (b.from !== peer.id || !verifyDoc(peer.id, doc)) throw err('La firma del mensaje no corresponde al remitente.', 'invalid');
      if (b.to !== teamState.me() || !team || b.team !== team.id) throw err('Este mensaje no es para mí.', 'invalid');
      const at = Date.parse(b.at);
      if (!at || at > now() + CLOCK_SKEW_MS || at < now() - QUEUE_HOURS * 3600e3 - CLOCK_SKEW_MS) throw err('Mensaje fuera de plazo.', 'invalid');
      const text = cleanText(b.text);
      const dup = find(b.id);
      if (dup) return { status: dup.status }; // reintento del mismo mensaje
      const auto = !!b.conv && autoDeliver(b);
      const p = auto ? 'accept' : policy();
      if (p === 'refuse') throw err('Esta persona no está recibiendo mensajes.', 'refused');
      const times = (recent.get(peer.id) || []).filter((t) => t > now() - RATE.ms);
      if (times.length >= RATE.max) throw err('Demasiados mensajes seguidos; espera un minuto.', 'rate');
      recent.set(peer.id, [...times, now()]);
      const m = {
        id: b.id,
        from: peer.id,
        fromName: peer.name,
        fromRole: peer.role || '',
        fingerprint: fingerprint(peer.id),
        text,
        toSession: optId(b.toSession),
        aboutSession: optId(b.aboutSession),
        replyTo: optId(b.replyTo),
        conv: auto ? String(b.conv) : null,
        at: b.at,
        receivedAt: new Date(now()).toISOString(),
        status: p === 'accept' ? 'delivered' : 'held',
      };
      state.received.push(m);
      save();
      return { status: m.status };
    },

    // Acuse del destinatario (por el canal ya autenticado): solo vale para mensajes que le envié a él.
    receipt(from, id, status) {
      const m = state.sent.find((x) => x.id === id && x.to === from);
      if (!m || !RECEIPTS.has(status)) return false;
      this.markSent(id, status);
      return true;
    },

    // Cambia el estado de un mensaje recibido. Devuelve el mensaje (para avisar al remitente) o null.
    setStatus(id, status) {
      const m = find(id);
      if (!m || !RECEIPTS.has(status) || m.status === status) return null;
      m.status = status;
      m.updatedAt = new Date(now()).toISOString();
      save();
      return m;
    },

    markReplied(id) {
      const m = find(id);
      if (m) (m.repliedAt = new Date(now()).toISOString()), save();
    },

    // Mensajes de una conversación automática listos para pasarle al agente (se marcan como leídos).
    takeConv(convId) {
      const out = state.received.filter((m) => m.conv === convId && m.status === 'delivered');
      for (const m of out) m.status = 'read';
      if (out.length) save();
      return out;
    },

    // Para la IA: los mensajes aprobados que aún no leyó. Se marcan como leídos.
    takeForAi() {
      const out = state.received.filter((m) => m.status === 'delivered');
      for (const m of out) m.status = 'read';
      if (out.length) save();
      return { messages: out, held: state.received.filter((m) => m.status === 'held').length };
    },

    get(id) {
      return find(id) || null;
    },

    list() {
      const received = [...state.received].reverse();
      return {
        policy: policy(),
        held: received.filter((m) => m.status === 'held').length,
        unread: received.filter((m) => m.status === 'held' || m.status === 'delivered').length,
        received,
        sent: [...state.sent].reverse().map(({ doc, ...m }) => m),
      };
    },

    clear() {
      state = { received: [], sent: [] };
      save();
    },
  };
}
