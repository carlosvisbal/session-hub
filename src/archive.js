// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Respaldo local de sesiones, en dos capas:
//
//   own    — mis sesiones de los proyectos que comparto. Mientras el original existe, el respaldo es un
//            espejo exacto (mensajes nuevos, ediciones, restauraciones); cuando Claude Code o Cursor lo
//            borran, queda el último estado conocido y el hub lo sigue sirviendo, con mis mismos permisos.
//   copies — copias de lectura de las sesiones de mis compañeros, para leerlas sin conexión. Solo
//            mientras sigo teniendo acceso: si el dueño las oculta, deja de compartirlas o desactiva
//            las copias, se borran en el siguiente contacto.
//
// Todo se guarda comprimido, con permisos 0600 y escritura atómica (archivo temporal + renombrar):
// una caída a mitad de la escritura nunca deja un respaldo a medias.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { relPath } from './util.js';

const DAY = 86400e3;
const LRU_SIZE = 20; // sesiones del respaldo con mensajes cargados en memoria

const safeName = (id) => String(id).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180);
const hashOf = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const writeGz = (file, obj) => {
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  writeAtomic(file, buf);
  return buf.length;
};
const readGz = (file) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
}
const rm = (file) => fs.rmSync(file, { force: true });

// Datos que el listado necesita sin abrir cada respaldo.
function statsOf(messages, project) {
  const edits = new Set();
  let commands = 0;
  for (const m of messages)
    for (const a of m.actions || []) {
      if (a.kind === 'edit' && a.target) edits.add(relPath(a.target, project));
      if (a.kind === 'command') commands++;
    }
  return { count: messages.length, edits: [...edits].sort(), commands };
}

function lru() {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k, v) {
      map.set(k, v);
      if (map.size > LRU_SIZE) map.delete(map.keys().next().value);
    },
    delete: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

// ======================= capa 1: mis sesiones =======================

export function createOwnArchive({ dir, log = () => {} }) {
  const base = path.join(dir, 'own');
  const indexFile = path.join(base, 'index.json');
  let index = readJson(indexFile, {}); // id -> meta
  const lastRef = new Map(); // id -> objeto de sesión ya respaldado (las fuentes lo reutilizan si no cambió)
  const cache = lru();
  let lastSync = null;
  let lastError = null;
  const saveIndex = () => writeAtomic(indexFile, JSON.stringify(index));

  function load(id) {
    const m = index[id];
    if (!m) return null;
    const hit = cache.get(id);
    if (hit) return hit;
    try {
      const data = readGz(path.join(base, m.file));
      cache.set(id, data.messages);
      return data.messages;
    } catch (err) {
      // Dañado o borrado a mano: se descarta; si el original sigue existiendo se vuelve a respaldar.
      log(`[respaldo] no pude leer ${id}: ${err.message}`);
      delete index[id];
      saveIndex();
      return null;
    }
  }

  // Sesión del respaldo con la misma forma que las de las fuentes (mensajes bajo demanda).
  function asSession(m) {
    return {
      id: m.id,
      source: m.source,
      project: m.project,
      title: m.title,
      branch: m.branch,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      archived: true,
      goneSince: m.goneSince,
      stats: m.stats,
      get messages() {
        return load(m.id) || [];
      },
    };
  }

  return {
    // listing(project) → { ok, sessions }: ok=false si alguna fuente falló (entonces no se marca nada como borrado).
    sync(projects, listing, { retentionDays = 365 } = {}) {
      let changed = false;
      try {
        for (const p of projects) {
          const { ok, sessions } = listing(p);
          const present = new Set();
          for (const s of sessions) {
            present.add(s.id);
            const m = index[s.id];
            if (m && lastRef.get(s.id) === s && !m.goneSince) continue; // mismo objeto: nada cambió
            const h = hashOf(s.messages);
            if (m && m.hash === h && m.project === p.path) {
              if (m.goneSince) (m.goneSince = null), (changed = true); // volvió a aparecer
              if (m.title !== s.title || m.updatedAt !== s.updatedAt) Object.assign(m, { title: s.title, updatedAt: s.updatedAt }), (changed = true);
              lastRef.set(s.id, s);
              continue;
            }
            const file = `${safeName(s.id)}.json.gz`;
            // Se acortó (p. ej. restaurar un punto anterior en Cursor): se refleja, pero se guarda la versión previa.
            if (m && s.messages.length < m.stats.count && fs.existsSync(path.join(base, m.file))) {
              fs.copyFileSync(path.join(base, m.file), path.join(base, `${safeName(s.id)}.prev.json.gz`));
            }
            const bytes = writeGz(path.join(base, file), { v: 1, id: s.id, messages: s.messages });
            index[s.id] = {
              id: s.id,
              source: s.source,
              project: p.path,
              title: s.title,
              branch: s.branch,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              stats: statsOf(s.messages, p.path),
              hash: h,
              bytes,
              file,
              syncedAt: new Date().toISOString(),
              goneSince: null,
              revisions: (m?.revisions || 0) + (m ? 1 : 0),
              hasPrev: m ? s.messages.length < m.stats.count || !!m.hasPrev : false,
            };
            cache.delete(s.id);
            lastRef.set(s.id, s);
            changed = true;
          }
          if (!ok) continue; // una fuente falló: no se sabe qué falta de verdad
          for (const m of Object.values(index))
            if (m.project === p.path && !present.has(m.id) && !m.goneSince) {
              m.goneSince = new Date().toISOString();
              changed = true;
              log(`[respaldo] "${m.title}" ya no está en ${m.source}; se conserva en el respaldo`);
            }
        }
        // Retención: lo que solo existe en el respaldo y lleva más que el plazo, se borra.
        const limit = Date.now() - retentionDays * DAY;
        if (retentionDays > 0)
          for (const m of Object.values(index))
            if (m.goneSince && Date.parse(m.goneSince) < limit && (m.updatedAt || 0) < limit) this.remove(m.id, { save: false }), (changed = true);
        if (changed) saveIndex();
        lastSync = new Date().toISOString();
        lastError = null;
      } catch (err) {
        lastError = err.message;
        log(`[respaldo] error al sincronizar: ${err.message}`);
      }
    },

    // Sesiones que ya no están en la fuente, para servirlas desde el respaldo.
    goneFor(projectPath, source, presentIds) {
      return Object.values(index)
        .filter((m) => m.project === projectPath && (!source || m.source === source) && !presentIds.has(m.id))
        .map(asSession);
    },

    has: (id) => !!index[id],
    isGone: (id) => !!index[id]?.goneSince,
    meta: (id) => index[id] || null,

    remove(id, { save = true } = {}) {
      const m = index[id];
      if (!m) return false;
      rm(path.join(base, m.file));
      rm(path.join(base, `${safeName(id)}.prev.json.gz`));
      delete index[id];
      cache.delete(id);
      lastRef.delete(id);
      if (save) saveIndex();
      return true;
    },

    purge({ onlyGone = false } = {}) {
      let n = 0;
      for (const m of Object.values(index)) if (!onlyGone || m.goneSince) this.remove(m.id, { save: false }) && n++;
      saveIndex();
      return n;
    },

    // Por tamaño: se borran primero las más viejas que ya solo existen en el respaldo.
    trimTo(maxBytes) {
      let total = Object.values(index).reduce((a, m) => a + (m.bytes || 0), 0);
      const gone = Object.values(index)
        .filter((m) => m.goneSince)
        .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      let n = 0;
      while (total > maxBytes && gone.length) {
        const m = gone.shift();
        total -= m.bytes || 0;
        this.remove(m.id, { save: false });
        n++;
      }
      if (n) saveIndex();
      return n;
    },

    all: () => Object.values(index),
    bytes: () => Object.values(index).reduce((a, m) => a + (m.bytes || 0), 0),
    status: () => ({ sessions: Object.keys(index).length, onlyInBackup: Object.values(index).filter((m) => m.goneSince).length, bytes: Object.values(index).reduce((a, m) => a + (m.bytes || 0), 0), lastSync, lastError, dir: base }),
  };
}

// ======================= capa 2: copias de mis compañeros =======================
// Se guardan tal como llegan del compañero (ya sin secretos) y se sirven con la misma forma que su hub.

export function createCopies({ dir, log = () => {} }) {
  const base = path.join(dir, 'copies');
  const indexFile = path.join(base, 'index.json');
  let index = readJson(indexFile, { owners: {} });
  index.owners ||= {};
  const cache = lru();
  const saveIndex = () => writeAtomic(indexFile, JSON.stringify(index));
  const owner = (id) => (index.owners[id] ||= { id, sessions: {}, ignored: [] });
  const fileOf = (ownerId, id) => path.join(base, safeName(ownerId).slice(0, 16), `${safeName(id)}.json.gz`);

  function read(ownerId, id) {
    const key = `${ownerId}/${id}`;
    const hit = cache.get(key);
    if (hit) return hit;
    try {
      const data = readGz(fileOf(ownerId, id));
      cache.set(key, data);
      return data;
    } catch {
      delete index.owners[ownerId]?.sessions[id];
      saveIndex();
      return null;
    }
  }

  const api = {
    owners: () => Object.values(index.owners),
    owner: (id) => index.owners[id] || null,
    has: (ownerId) => Object.keys(index.owners[ownerId]?.sessions || {}).length > 0,
    meta: (ownerId, id) => index.owners[ownerId]?.sessions[id] || null,
    list: (ownerId) => Object.values(index.owners[ownerId]?.sessions || {}),
    isIgnored: (ownerId, id) => (index.owners[ownerId]?.ignored || []).includes(id),

    setOwner(ownerId, info) {
      Object.assign(owner(ownerId), info);
      saveIndex();
    },

    // Solo se guarda una copia completa (el llamador ya verificó el total de mensajes).
    put(ownerId, summary, conversation, extra = {}) {
      const o = owner(ownerId);
      const bytes = writeGz(fileOf(ownerId, summary.id), { v: 1, summary, conversation });
      const now = new Date().toISOString();
      o.sessions[summary.id] = { id: summary.id, summary, count: conversation.length, remoteUpdatedAt: summary.updatedAt, syncedAt: now, verifiedAt: now, status: 'ok', bytes, firstCopyAt: o.sessions[summary.id]?.firstCopyAt || now, ...extra };
      cache.delete(`${ownerId}/${summary.id}`);
      saveIndex();
    },

    touch(ownerId, id, fields) {
      const m = index.owners[ownerId]?.sessions[id];
      if (m) Object.assign(m, fields);
    },
    save: saveIndex,

    get: (ownerId, id) => (index.owners[ownerId]?.sessions[id] ? read(ownerId, id) : null),

    // ignore=true: la persona la borró a mano; no se vuelve a copiar.
    remove(ownerId, id, { ignore = false, save = true } = {}) {
      const o = index.owners[ownerId];
      if (!o) return false;
      rm(fileOf(ownerId, id));
      const had = !!o.sessions[id];
      delete o.sessions[id];
      cache.delete(`${ownerId}/${id}`);
      if (ignore && !o.ignored.includes(id)) o.ignored.push(id);
      if (save) saveIndex();
      return had;
    },

    purgeOwner(ownerId, reason = '') {
      const o = index.owners[ownerId];
      if (!o) return 0;
      const n = Object.keys(o.sessions).length;
      fs.rmSync(path.join(base, safeName(ownerId).slice(0, 16)), { recursive: true, force: true });
      delete index.owners[ownerId];
      cache.clear();
      saveIndex();
      if (n) log(`[copias] borradas ${n} copia(s) de ${o.name || ownerId.slice(0, 12)}${reason ? ` (${reason})` : ''}`);
      return n;
    },

    purgeAll() {
      const n = Object.values(index.owners).reduce((a, o) => a + Object.keys(o.sessions).length, 0);
      fs.rmSync(base, { recursive: true, force: true });
      index = { owners: {} };
      cache.clear();
      saveIndex();
      return n;
    },

    // Copias que nadie pudo confirmar en el plazo: se borran (no quedan datos viejos para siempre).
    prune(retentionDays) {
      if (!(retentionDays > 0)) return 0;
      const limit = Date.now() - retentionDays * DAY;
      let n = 0;
      for (const o of Object.values(index.owners))
        for (const m of Object.values(o.sessions)) if (Date.parse(m.verifiedAt || m.syncedAt) < limit) api.remove(o.id, m.id, { save: false }) && n++;
      if (n) saveIndex();
      return n;
    },

    trimTo(maxBytes) {
      const all = Object.values(index.owners).flatMap((o) => Object.values(o.sessions).map((m) => ({ o, m })));
      let total = all.reduce((a, x) => a + (x.m.bytes || 0), 0);
      all.sort((a, b) => (a.m.verifiedAt || '').localeCompare(b.m.verifiedAt || ''));
      let n = 0;
      while (total > maxBytes && all.length) {
        const { o, m } = all.shift();
        total -= m.bytes || 0;
        api.remove(o.id, m.id, { save: false });
        n++;
      }
      if (n) saveIndex();
      return n;
    },

    bytes: () => Object.values(index.owners).reduce((a, o) => a + Object.values(o.sessions).reduce((b, m) => b + (m.bytes || 0), 0), 0),

    // ---- lectura, con la misma forma que responde el hub del compañero ----
    copyInfo(ownerId, m) {
      const o = index.owners[ownerId] || {};
      return { syncedAt: m.syncedAt, verifiedAt: m.verifiedAt, status: m.status, ownerLastSeen: o.lastContact || null };
    },

    listSessions(ownerId, { project, source, since, limit = Infinity } = {}) {
      const from = since ? Date.parse(since) || 0 : 0;
      return api
        .list(ownerId)
        .map((m) => ({ ...m.summary, copy: api.copyInfo(ownerId, m) }))
        .filter((s) => (!project || s.project === project || s.projectKey === project) && (!source || s.source === source) && Date.parse(s.updatedAt || 0) >= from)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, limit);
    },

    getSession(ownerId, id, { offset = 0, limit = Infinity } = {}) {
      const m = api.meta(ownerId, id);
      const data = m && read(ownerId, id);
      if (!data) return null;
      const total = data.conversation.length;
      const start = Math.min(Math.max(0, offset), total);
      const conversation = data.conversation.slice(start, start + limit);
      return { ...data.summary, total, offset: start, omittedMessages: total - conversation.length, conversation, copy: api.copyInfo(ownerId, m) };
    },

    whatChanged(ownerId, { since = '24h', project } = {}, parseSince) {
      const from = parseSince(since);
      const sessions = api
        .list(ownerId)
        .filter((m) => Date.parse(m.summary.updatedAt || 0) >= from && (!project || m.summary.project === project || m.summary.projectKey === project))
        .map((m) => {
          const data = read(ownerId, m.id);
          const recent = (data?.conversation || []).filter((x) => Date.parse(x.at || 0) >= from);
          const last = [...recent].reverse().find((x) => x.role === 'assistant' && x.text);
          return {
            ...m.summary,
            requests: recent.filter((x) => x.role === 'user').map((x) => x.text),
            filesChanged: [...new Set(recent.flatMap((x) => (x.actions || []).filter((a) => a.kind === 'edit').map((a) => a.target)))].sort(),
            commands: recent.flatMap((x) => (x.actions || []).filter((a) => a.kind === 'command').map((a) => a.target)),
            lastAssistantMessage: last?.text || null,
            copy: api.copyInfo(ownerId, m),
          };
        });
      const o = index.owners[ownerId] || {};
      return { owner: o.name, ownerId, since: new Date(from).toISOString(), sessions, filesChanged: [], copy: true };
    },

    search(ownerId, query, { project, limit = Infinity } = {}) {
      const q = String(query).toLowerCase();
      const hits = [];
      for (const m of api.list(ownerId)) {
        if (project && m.summary.project !== project && m.summary.projectKey !== project) continue;
        const data = read(ownerId, m.id);
        for (const x of data?.conversation || []) {
          const idx = (x.text || '').toLowerCase().indexOf(q);
          if (idx < 0) continue;
          hits.push({ sessionId: m.id, owner: m.summary.owner, ownerId, title: m.summary.title, project: m.summary.project, projectKey: m.summary.projectKey, source: m.summary.source, role: x.role, at: x.at, snippet: x.text.slice(Math.max(0, idx - 150), idx + q.length + 150), copy: api.copyInfo(ownerId, m) });
          if (hits.length >= limit) return hits;
        }
      }
      return hits;
    },

    status() {
      return api.owners().map((o) => ({ id: o.id, name: o.name, role: o.role, sessions: Object.keys(o.sessions).length, bytes: Object.values(o.sessions).reduce((a, m) => a + (m.bytes || 0), 0), lastSync: o.lastSync || null, lastContact: o.lastContact || null, allowCopies: o.allowCopies !== false, paused: !!o.paused, ignored: o.ignored.length, gone: Object.values(o.sessions).filter((m) => m.status === 'gone').length, lastError: o.lastError || null }));
    },
  };
  return api;
}
