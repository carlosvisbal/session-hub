// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Orquestador local: responde a mi IA y a mi panel juntando mis sesiones y las de mis compañeros.
// Cada compañero se consulta por su conexión cifrada y responde solo con lo suyo (no hay recursión).
// Toda consulta termina: responde, falla o vence; un compañero lento no bloquea a los demás.
import { fingerprint } from './identity.js';

const ME = new Set(['yo', 'me', 'mi', 'mío', 'mio', 'self']);
const ALL = new Set(['todos', 'all', '*']);
const PAGE = 100;

export function createTeam(cfg, hub, transport, teamState) {
  const self = () => ({ ...hub.whoami(), fingerprint: fingerprint(teamState.me()), self: true, online: true });

  const members = () => [self(), ...transport.list()];
  const label = (m) => `${m.name}${m.role ? ' (' + m.role + ')' : ''}`;

  // peer vacío = compañeros en línea (no yo); "yo" = solo yo; "todos" = todos; si no, por nombre, huella o id.
  function resolve(peer) {
    const online = members().filter((m) => m.online);
    if (!peer) return online.filter((m) => !m.self);
    const q = peer.trim().toLowerCase();
    if (ME.has(q)) return [self()];
    if (ALL.has(q)) return online;
    const found = members().filter((m) => m.id === q || m.name.toLowerCase() === q || m.fingerprint.toLowerCase() === q);
    if (!found.length) throw new Error(`No conozco a "${peer}". Equipo: ${members().map(label).join(', ')}`);
    return found;
  }

  // origin = { via: 'mcp' | 'panel', client: 'Cursor' | 'VS Code' | … }; el compañero lo ve en su auditoría.
  function ask(member, local, op, args, origin = {}) {
    if (member.self) return Promise.resolve().then(local);
    if (!member.online) return Promise.reject(new Error('no está conectado ahora'));
    return transport.request(member.id, op, { ...args, origin });
  }

  function fanOut(peer, fn) {
    return Promise.all(
      resolve(peer).map(async (m) => {
        try {
          return { member: label(m), memberId: m.id, data: await fn(m) };
        } catch (err) {
          return { member: label(m), memberId: m.id, error: err.message };
        }
      }),
    );
  }

  // Lee una sesión entera en páginas; cada página vence por separado y el total se comprueba.
  async function readFull(m, id, origin, from = 0) {
    if (m.self) return from ? hub.getSession(id, { offset: from, limit: Infinity, maxChars: 1e9 }) : hub.getSession(id, { lastMessages: Infinity, maxChars: 1e9 });
    const first = await ask(m, null, 'session', { id, offset: from, limit: PAGE, full: true }, origin);
    const conversation = [...first.conversation];
    const expected = first.total - first.offset;
    while (conversation.length < expected) {
      const page = await ask(m, null, 'session', { id, offset: first.offset + conversation.length, limit: PAGE, full: true }, origin);
      if (!page.conversation.length) break;
      conversation.push(...page.conversation);
    }
    if (conversation.length !== expected) throw new Error(`La sesión llegó incompleta (${conversation.length} de ${expected} mensajes); vuelve a intentarlo.`);
    return { ...first, omittedMessages: first.offset, conversation };
  }

  const api = {
    members,
    resolve,
    networkStatus: () => {
      const s = transport.status();
      return { activa: s.running, modo: s.network, conectados: s.connected, error: s.lastError, pendiente: teamState.pending() };
    },

    peersInfo() {
      const roster = new Map(teamState.roster().map((r) => [r.id, r]));
      const nameOf = (id) => (id === teamState.me() ? 'ti' : members().find((m) => m.id === id)?.name || teamState.profileOf(id)?.name || (id ? fingerprint(id) : null));
      return members().map((m) => {
        const r = roster.get(m.id) || {};
        return {
          id: m.id,
          fingerprint: m.fingerprint,
          name: m.name,
          role: m.role,
          paused: !!m.paused,
          projects: m.projects,
          self: !!m.self,
          online: m.online,
          founder: !!r.founder,
          invitedBy: r.invitedBy || null,
          invitedByName: r.invitedBy ? nameOf(r.invitedBy) : null,
          canRevoke: !!r.canRevoke,
          blocked: !!r.blocked,
        };
      });
    },

    whatChanged({ peer, since, project }, origin) {
      return fanOut(peer, (m) => ask(m, () => hub.whatChanged({ since, project }), 'changes', { since, project }, origin));
    },

    async listSessions({ peer, ...q }, origin) {
      const res = await fanOut(peer, (m) => ask(m, () => hub.listSessions(q), 'sessions', q, origin));
      return res.flatMap((r) => (r.error ? [{ member: r.member, error: r.error }] : r.data)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },

    // Se pregunta a todos en paralelo y gana la primera respuesta válida.
    // full = sesión completa y sin recortes, pedida por páginas y verificada al reensamblar.
    async getSession(id, { peer, lastMessages, full = false, from = 0 }, origin) {
      const targets = resolve(peer || 'todos');
      const errors = [];
      const read = (m) => (full ? readFull(m, id, origin, from) : ask(m, () => hub.getSession(id, { lastMessages }), 'session', { id, last: lastMessages }, origin));
      try {
        return await Promise.any(
          targets.map((m) =>
            read(m).catch((err) => {
              errors.push(`${label(m)}: ${err.message}`);
              throw err;
            }),
          ),
        );
      } catch {
        throw new Error(`Sesión ${id} no encontrada. ${errors.join(' | ')}`);
      }
    },

    // Una página con texto íntegro (sin recortes), para leer la sesión completa por partes.
    async getSessionPage(id, { peer, offset = 0, limit = 1e9 }, origin) {
      const targets = resolve(peer || 'todos');
      const errors = [];
      try {
        return await Promise.any(
          targets.map((m) =>
            ask(m, () => hub.getSession(id, { offset, limit, maxChars: 1e9 }), 'session', { id, offset, limit: Math.min(limit, PAGE * 5), full: true }, origin).catch((err) => {
              errors.push(`${label(m)}: ${err.message}`);
              throw err;
            }),
          ),
        );
      } catch {
        throw new Error(`Sesión ${id} no encontrada. ${errors.join(' | ')}`);
      }
    },

    async search(query, { peer, ...q }, origin) {
      const res = await fanOut(peer, (m) => ask(m, () => hub.search(query, q), 'search', { q: query, ...q }, origin));
      return res.flatMap((r) => (r.error ? [{ member: r.member, error: r.error }] : r.data));
    },

    // Para el panel: una operación contra una persona concreta.
    async proxy(peer, op, args, origin) {
      const [m] = resolve(peer);
      const local = {
        sessions: () => hub.listSessions(args),
        session: () => hub.getSession(args.id, { lastMessages: args.last }),
        changes: () => hub.whatChanged(args),
        search: () => hub.search(args.q || '', args),
        projects: () => hub.projects(),
      }[op];
      if (!local) throw new Error(`Operación desconocida: ${op}`);
      return ask(m, local, op, args, origin);
    },
  };
  return api;
}
