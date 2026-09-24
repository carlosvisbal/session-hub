// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Orquestador local: responde a mi IA y a mi panel juntando mis sesiones y las de mis compañeros.
// Cada compañero se consulta por su conexión cifrada y responde solo con lo suyo (no hay recursión).
// Toda consulta termina: responde, falla o vence; un compañero lento no bloquea a los demás.
import { fingerprint } from './identity.js';
import { parseSince } from './util.js';

const ME = new Set(['yo', 'me', 'mi', 'mío', 'mio', 'self']);
const ALL = new Set(['todos', 'all', '*']);
const PAGE = 100;
// En el MCP y la API, limit 0 o vacío = todos. Para mis sesiones y las copias se convierte aquí
// (a los compañeros les llega tal cual y su hub hace lo mismo).
const allIfZero = (q) => ({ ...q, limit: !q.limit || Number(q.limit) <= 0 ? Infinity : Number(q.limit) });

export function createTeam(cfg, hub, transport, teamState, t = (s) => s, inbox = null, copies = null, log = () => {}) {
  const self = () => ({ ...hub.whoami(), fingerprint: fingerprint(teamState.me()), self: true, online: true });

  const members = () => [self(), ...transport.list()];
  const label = (m) => `${m.name}${m.role ? ' (' + m.role + ')' : ''}`;

  // Copias locales de un compañero (capa 2): solo si las guardo, él las permite, no está en pausa y no lo bloqueé.
  const copiesOn = () => !!copies && cfg.teamCopies !== false;
  function copyUsable(m) {
    if (!copiesOn() || m.self || teamState.isBlocked(m.id) || teamState.isRevoked?.(m.id)) return false;
    const o = copies.owner(m.id);
    return !!o && copies.has(m.id) && o.allowCopies !== false && !o.paused;
  }

  // peer vacío = compañeros en línea (y los desconectados de los que tengo copia); "yo" = solo yo;
  // "todos" = todos; si no, por nombre, huella o id.
  function resolve(peer) {
    const reachable = members().filter((m) => m.online || copyUsable(m));
    if (!peer) return reachable.filter((m) => !m.self);
    const q = peer.trim().toLowerCase();
    if (ME.has(q)) return [self()];
    if (ALL.has(q)) return reachable;
    const found = members().filter((m) => m.id === q || m.name.toLowerCase() === q || m.fingerprint.toLowerCase() === q);
    if (!found.length) throw new Error(t('No conozco a "{v1}". Equipo: {v2}', { v1: peer, v2: members().map(label).join(', ') }));
    return found;
  }

  // origin = { via: 'mcp' | 'panel', client: 'Cursor' | 'VS Code' | … }; el compañero lo ve en su auditoría.
  function ask(member, local, op, args, origin = {}) {
    if (member.self) return Promise.resolve().then(local);
    if (!member.online) return Promise.reject(new Error('no está conectado ahora'));
    return transport.request(member.id, op, { ...args, origin });
  }

  // Consulta en vivo; si el compañero no está conectado (o no responde), desde mis copias de sus sesiones.
  async function liveOrCopy(m, live, fromCopy) {
    if (m.self || m.online)
      try {
        return await live();
      } catch (err) {
        if (m.self || !copyUsable(m) || !['offline', 'closed', 'timeout'].includes(err.code)) throw err;
      }
    if (copyUsable(m)) return fromCopy();
    throw Object.assign(new Error('no está conectado ahora'), { code: 'offline' });
  }

  function fanOut(peer, fn) {
    return Promise.all(
      resolve(peer).map(async (m) => {
        try {
          return { member: label(m), memberId: m.id, data: await fn(m) };
        } catch (err) {
          return { member: label(m), memberId: m.id, error: t(err.message) };
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

  // Entrega un mensaje ya firmado. Si la persona no está, queda en cola y sale cuando se conecte.
  async function deliver(pub, doc) {
    try {
      const r = await transport.request(pub, 'message', { doc });
      inbox.markSent(doc.body.id, r.status);
      return r.status;
    } catch (err) {
      if (['offline', 'closed', 'timeout'].includes(err.code)) return 'queued';
      // Hub de una versión sin mensajes: responde "Operación desconocida".
      const msg = /Operación desconocida/.test(err.message) ? 'Su Session Hub es de una versión sin mensajes; debe actualizarlo.' : err.message;
      inbox.markSent(doc.body.id, err.code === 'refused' ? 'refused' : 'failed', msg);
      throw Object.assign(new Error(msg), { code: err.code });
    }
  }

  // Una sesión desde mis copias (de cualquiera de los compañeros indicados).
  function fromCopies(id, targets, { offset, limit = Infinity, lastMessages } = {}) {
    if (!copiesOn()) return null;
    for (const m of targets) {
      if (m.self || !copyUsable(m) || !copies.meta(m.id, id)) continue;
      const all = copies.getSession(m.id, id);
      if (!all) continue;
      if (offset != null) return copies.getSession(m.id, id, { offset, limit });
      const start = lastMessages && lastMessages !== Infinity ? Math.max(0, all.total - lastMessages) : 0;
      return copies.getSession(m.id, id, { offset: start });
    }
    return null;
  }

  // ---------- sincronización de copias (capa 2) ----------
  const BACKUP = { via: 'backup', client: 'Session Hub' };
  let syncing = null;

  const same = (a, b) => !!a && !!b && a.role === b.role && a.at === b.at && a.text === b.text;

  // Trae solo lo nuevo: desde el penúltimo mensaje que ya tengo, comprobando que siga igual.
  // Si cambió (restauración, edición) o hay menos mensajes que antes, se trae entera. Solo se
  // guarda una copia completa y verificada: un corte a mitad no deja nada a medias.
  async function copySession(m, remote) {
    const meta = copies.meta(m.id, remote.id);
    let conversation;
    let head;
    if (meta && remote.messages >= meta.count && meta.count >= 2) {
      const from = meta.count - 2;
      const local = copies.get(m.id, remote.id);
      const page = await readFull(m, remote.id, BACKUP, from);
      if (local && same(local.conversation[from], page.conversation[0]) && same(local.conversation[from + 1], page.conversation[1] || local.conversation[from + 1])) {
        conversation = [...local.conversation.slice(0, from), ...page.conversation];
        head = page;
      }
    }
    if (!conversation) {
      head = await readFull(m, remote.id, BACKUP, 0);
      conversation = head.conversation;
    }
    if (conversation.length !== head.total) throw new Error(`copia incompleta de ${remote.id}`);
    const { conversation: _c, offset: _o, omittedMessages: _m, total: _t, ...summary } = head;
    copies.put(m.id, { ...summary, messages: conversation.length }, conversation);
  }

  async function syncPeer(m) {
    const o = copies.owner(m.id);
    const info = { name: m.name, role: m.role, fingerprint: m.fingerprint, paused: !!m.paused, allowCopies: m.allowCopies !== false, lastContact: new Date().toISOString() };
    if (m.allowCopies === false) {
      if (o) copies.purgeOwner(m.id, 'el dueño no permite copias');
      return;
    }
    copies.setOwner(m.id, info);
    if (m.paused) return; // en pausa: no veo nada ahora; lo que tengo queda oculto hasta que reanude
    const remote = await ask(m, null, 'sessions', {}, BACKUP);
    const ids = new Set(remote.map((s) => s.id));
    let copied = 0;
    for (const s of remote) {
      if (!copiesOn() || !transport.list().find((x) => x.id === m.id && x.online)) break; // se apagó o se desconectó
      if (copies.isIgnored(m.id, s.id)) continue;
      const c = copies.meta(m.id, s.id);
      if (c && c.remoteUpdatedAt === s.updatedAt && c.count === s.messages && c.summary?.title === s.title) {
        copies.touch(m.id, s.id, { verifiedAt: new Date().toISOString(), status: 'ok', summary: { ...c.summary, ...s } });
        continue;
      }
      try {
        await copySession(m, s);
        copied++;
      } catch (err) {
        copies.touch(m.id, s.id, { lastError: err.message });
        log(`[copias] ${m.name}: no pude copiar "${s.title}": ${err.message}`);
      }
    }
    // Las que ya no aparecen: se pregunta al dueño qué pasó con cada una.
    const missing = copies.list(m.id).filter((c) => !ids.has(c.id));
    if (missing.length) {
      let st = null;
      try {
        st = await ask(m, null, 'copystatus', { ids: missing.map((c) => c.id) }, BACKUP);
      } catch {
        // hub anterior o sin respuesta: no se puede confirmar; se conservan
      }
      for (const c of missing) {
        const v = st?.[c.id];
        if (v === 'withdrawn') copies.remove(m.id, c.id, { save: false });
        else copies.touch(m.id, c.id, { status: v === 'gone' ? 'gone' : 'unverified', ...(v === 'gone' ? { verifiedAt: new Date().toISOString() } : {}) });
      }
    }
    copies.setOwner(m.id, { lastSync: new Date().toISOString(), lastError: null });
    if (copied) log(`[copias] ${m.name}: ${copied} sesión(es) actualizada(s)`);
  }

  async function syncCopies() {
    if (!copiesOn() || syncing) return syncing;
    syncing = (async () => {
      try {
        for (const m of transport.list().filter((x) => x.online && !teamState.isBlocked(x.id))) {
          try {
            await syncPeer(m);
          } catch (err) {
            copies.setOwner(m.id, { lastError: err.message });
          }
        }
        copies.prune(cfg.copiesRetentionDays);
        copies.trimTo(Math.max(50, cfg.archiveMaxMB || 2048) * 1024 * 1024);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  const api = {
    members,
    syncCopies,
    copyUsable,
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
          projectKeys: m.projectKeys || {},
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
      return fanOut(peer, (m) => liveOrCopy(m, () => ask(m, () => hub.whatChanged({ since, project }), 'changes', { since, project }, origin), () => copies.whatChanged(m.id, { since, project }, parseSince)));
    },

    async listSessions({ peer, ...q }, origin) {
      const local = allIfZero(q);
      const res = await fanOut(peer, (m) => liveOrCopy(m, () => ask(m, () => hub.listSessions(local), 'sessions', q, origin), () => copies.listSessions(m.id, local)));
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
          targets
            .filter((m) => m.self || m.online)
            .map((m) =>
              read(m).catch((err) => {
                errors.push(`${label(m)}: ${err.message}`);
                throw err;
              }),
            ),
        );
      } catch {
        const c = fromCopies(id, targets, { offset: full ? from : undefined, lastMessages });
        if (c) return c;
        throw new Error(`Sesión ${id} no encontrada. ${errors.join(' | ')}`);
      }
    },

    // Una página con texto íntegro (sin recortes), para leer la sesión completa por partes.
    async getSessionPage(id, { peer, offset = 0, limit = 1e9 }, origin) {
      const targets = resolve(peer || 'todos');
      const errors = [];
      try {
        return await Promise.any(
          targets
            .filter((m) => m.self || m.online)
            .map((m) =>
              ask(m, () => hub.getSession(id, { offset, limit, maxChars: 1e9 }), 'session', { id, offset, limit: Math.min(limit, PAGE * 5), full: true }, origin).catch((err) => {
                errors.push(`${label(m)}: ${err.message}`);
                throw err;
              }),
            ),
        );
      } catch {
        const c = fromCopies(id, targets, { offset, limit });
        if (c) return c;
        throw new Error(t('Sesión {v1} no encontrada. {v2}', { v1: id, v2: errors.map(t).join(' | ') }));
      }
    },

    async search(query, { peer, ...q }, origin) {
      const local = allIfZero(q);
      const res = await fanOut(peer, (m) => liveOrCopy(m, () => ask(m, () => hub.search(query, local), 'search', { q: query, ...q }, origin), () => copies.search(m.id, query, local)));
      return res.flatMap((r) => (r.error ? [{ member: r.member, error: r.error }] : r.data));
    },

    // Sesiones de IA abiertas ahora, por compañero (o "yo").
    async listAgents({ peer } = {}, origin) {
      const res = await fanOut(peer, (m) => ask(m, () => hub.liveAgents(), 'agents', {}, origin));
      return res.flatMap((r) => (r.error ? [{ member: r.member, error: r.error }] : r.data));
    },

    // Mensaje de texto a una persona. replyTo sin "to" responde a quien escribió ese mensaje.
    async sendMessage({ to, text, toSession, aboutSession, replyTo }, origin = {}) {
      if (!inbox) throw new Error('Mensajes no disponibles.');
      const original = replyTo ? inbox.get(replyTo) : null;
      if (replyTo && !original) throw new Error(t('No encuentro el mensaje {v1} en tu bandeja.', { v1: replyTo }));
      if (!to && !original) throw new Error(t('Indica a quién va el mensaje ("to"): nombre, huella o id. Equipo: {v1}', { v1: members().filter((m) => !m.self).map(label).join(', ') || '—' }));
      const targets = original ? members().filter((m) => m.id === original.from) : resolve(to).filter((m) => !m.self);
      if (targets.length !== 1) throw new Error(t('El mensaje va a una sola persona. Equipo: {v1}', { v1: members().filter((m) => !m.self).map(label).join(', ') || '—' }));
      const m = targets[0];
      const doc = inbox.compose({ to: m.id, text, toSession, aboutSession, replyTo });
      inbox.recordSent(doc, m.name);
      if (original) inbox.markReplied(original.id);
      const status = m.online ? await deliver(m.id, doc) : 'queued';
      return { id: doc.body.id, to: label(m), status, via: origin.via };
    },

    // Para mi IA: los mensajes aprobados que no leyó; se marcan como leídos y se avisa a cada remitente.
    checkInbox() {
      const r = inbox.takeForAi();
      for (const m of r.messages) api.notifySender(m);
      return r;
    },

    // Reintenta lo que estaba en cola para alguien que acaba de conectarse.
    async flushQueue(pub) {
      for (const doc of inbox?.queuedFor(pub) || []) await deliver(pub, doc).catch(() => {});
    },

    // Aviso al remitente de qué pasó con su mensaje (retenido, entregado, leído, descartado).
    notifySender(m) {
      if (m) transport.send(m.from, { t: 'receipt', id: m.id, status: m.status });
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
      const fromCopy = {
        sessions: () => copies.listSessions(m.id, args),
        session: () => fromCopies(args.id, [m], { lastMessages: args.last }) || Promise.reject(new Error(`Sesión ${args.id} no encontrada.`)),
        changes: () => copies.whatChanged(m.id, args, parseSince),
        search: () => copies.search(m.id, args.q || '', args),
        projects: () => [],
      }[op];
      return liveOrCopy(m, () => ask(m, local, op, args, origin), fromCopy);
    },
  };
  return api;
}
