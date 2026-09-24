// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Junta las fuentes, aplica la lista de proyectos permitidos y el filtro de secretos.
// Todo lo que sale de aquí ya está redactado.
//
// `viewer` = quién pregunta. null = el dueño del hub (ve todo, con marcas de oculto);
// un compañero solo ve lo que la pausa, la lista de acceso y las exclusiones permiten.
import fs from 'node:fs';
import path from 'node:path';
import { encodeProject, listClaudeLive, listClaudeSessions } from './sources/claude.js';
import { cursorUnavailable, listCursorSessions } from './sources/cursor.js';
import { redact, setExtraPatterns } from './redact.js';
import { projectKey } from './projectkey.js';
import { createOwnArchive } from './archive.js';
import { isInside, iso, parseSince, relPath, truncate } from './util.js';

const CURSOR_ACTIVE_MS = 10 * 60_000; // Cursor no deja registro de sesiones abiertas: cuenta la actividad reciente

export class AccessDenied extends Error {
  constructor(session) {
    super('Sesión no encontrada (o su proyecto no está compartido contigo).');
    this.code = 'denied';
    this.session = session;
  }
}

export function createHub(cfg, { log = () => {} } = {}) {
  setExtraPatterns(cfg.redactExtra);
  // Respaldo de mis sesiones (capa 1). Sin carpeta configurada (pruebas) no hay respaldo.
  const own = cfg.archiveDir ? createOwnArchive({ dir: cfg.archiveDir, log }) : null;
  const archiveOn = () => !!own && cfg.archive !== false;

  // Dinámico: el nombre y el rol pueden cambiar en caliente.
  const owner = {
    get id() {
      return cfg.id;
    },
    get name() {
      return cfg.owner.name;
    },
    get role() {
      return cfg.owner.role;
    },
  };

  // ¿Puede este visor ver este proyecto?
  function canSee(project, viewer) {
    if (!viewer) return true;
    if (cfg.paused) return false;
    const allow = project.allow || ['*'];
    // Por clave pública verificada; el nombre lo elige cada quien y no identifica a nadie.
    return allow.includes('*') || allow.includes(viewer.id);
  }

  const visibleProjects = (viewer) => cfg.projects.filter((p) => canSee(p, viewer));
  const isExcluded = (s) => cfg.excludedSessions.includes(s.id);

  // Por nombre, carpeta o clave de proyecto (projectKey).
  function resolveProject(name, viewer) {
    const p = visibleProjects(viewer).find((x) => x.name === name || x.path === name || keyOf(x.path) === name);
    // Mismo mensaje exista o no: no se revela qué proyectos están restringidos.
    if (!p) throw new Error(`Proyecto "${name}" no compartido por ${owner.name}. Disponibles: ${visibleProjects(viewer).map((x) => x.name).join(', ') || 'ninguno'}`);
    return p;
  }

  const nameOf = (projectPath) => cfg.projects.find((x) => x.path === projectPath)?.name || path.basename(projectPath);
  const keyOf = (projectPath) => projectKey(projectPath, cfg.id);

  // Fuentes de un proyecto; ok=false si alguna falló (base de Cursor bloqueada, disco…).
  function listing(p, source) {
    let ok = true;
    const read = (fn) => {
      try {
        return fn();
      } catch (err) {
        ok = false;
        console.error('[session-hub] error leyendo fuente:', err.message);
        return [];
      }
    };
    const sessions = [];
    if (!source || source === 'claude-code') sessions.push(...read(() => listClaudeSessions(cfg, p.path)));
    if ((!source || source === 'cursor') && !cursorUnavailable) sessions.push(...read(() => listCursorSessions(cfg, p.path)));
    return { ok, sessions };
  }

  // Lo que hay en Claude Code y Cursor, más lo que ya solo existe en mi respaldo.
  function rawSessions(projects, source) {
    const out = [];
    for (const p of projects) {
      const { sessions } = listing(p, source);
      out.push(...sessions);
      if (archiveOn()) out.push(...own.goneFor(p.path, source, new Set(sessions.map((s) => s.id))));
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function allSessions({ project, source, viewer } = {}) {
    const projects = project ? [resolveProject(project, viewer)] : visibleProjects(viewer);
    const list = rawSessions(projects, source);
    return viewer ? list.filter((s) => !isExcluded(s)) : list;
  }

  function summary(s) {
    // Las del respaldo traen sus cifras precalculadas (archived.stats); las de Cursor tienen su propio
    // campo "stats" (líneas agregadas y quitadas), que no es lo mismo: por eso se mira "archived".
    const pre = s.archived ? s.stats : null;
    const edits = new Set(pre?.edits || []);
    let commands = pre?.commands || 0;
    if (!pre)
      for (const m of s.messages)
        for (const a of m.actions) {
          if (a.kind === 'edit' && a.target) edits.add(relPath(a.target, s.project));
          if (a.kind === 'command') commands++;
        }
    return {
      id: s.id,
      owner: owner.name,
      ownerId: owner.id,
      source: s.source,
      project: nameOf(s.project),
      projectKey: keyOf(s.project),
      title: redact(s.title),
      branch: s.branch,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
      messages: pre ? pre.count : s.messages.length,
      filesChanged: [...edits].sort(),
      commandsRun: commands,
      ...(isExcluded(s) ? { hidden: true } : {}),
      // El original ya no está en Claude Code / Cursor: se sirve desde mi respaldo.
      ...(s.archived ? { archived: true, goneSince: s.goneSince } : {}),
    };
  }

  function formatMessage(m, s, maxChars) {
    const text = redact(m.text);
    return {
      role: m.role,
      at: iso(m.at),
      text: truncate(text, maxChars),
      ...(text.length > maxChars ? { truncated: true } : {}),
      actions: dedupe(
        m.actions.map((a) => ({
          kind: a.kind,
          target: redact(a.kind === 'edit' ? relPath(a.target, s.project) : a.target),
        })),
      ),
    };
  }

  return {
    // ---------- respaldo (capa 1) ----------
    syncArchive() {
      if (!archiveOn()) return;
      own.sync(cfg.projects, (p) => listing(p), { retentionDays: cfg.archiveRetentionDays });
      own.trimTo(Math.max(50, cfg.archiveMaxMB || 2048) * 1024 * 1024);
    },
    archiveStatus: () => (own ? { enabled: archiveOn(), ...own.status() } : { enabled: false, sessions: 0, onlyInBackup: 0, bytes: 0 }),
    // Detalle para administrar el respaldo desde el panel (sin mensajes: solo lo que se lista).
    archiveList: () =>
      (own ? own.all() : []).map((m) => ({
        id: m.id,
        title: redact(m.title || ''),
        project: nameOf(m.project),
        projectKey: keyOf(m.project),
        shared: cfg.projects.some((p) => p.path === m.project),
        source: m.source,
        messages: m.stats?.count || 0,
        bytes: m.bytes || 0,
        updatedAt: iso(m.updatedAt),
        syncedAt: m.syncedAt,
        goneSince: m.goneSince,
        hasPrev: !!m.hasPrev,
      })),
    // Borrar del respaldo: solo lo que ya no existe en el original (lo demás se volvería a respaldar).
    removeArchived(id) {
      if (!own?.has(id)) throw new Error('Esa sesión no está en tu respaldo.');
      if (!own.isGone(id)) throw new Error('La sesión todavía existe en su herramienta; para que el equipo no la vea, ocúltala.');
      own.remove(id);
      return { ok: true };
    },
    purgeArchive: (onlyGone = true) => ({ removed: own ? own.purge({ onlyGone }) : 0 }),

    // Para las copias de un compañero: qué pasó con cada sesión que tiene copiada.
    //   ok (la sigue viendo) · withdrawn (existe, pero ya no es para él o no permito copias) · gone (ya no existe) · paused
    copyStatus(ids, viewer) {
      const list = [...new Set((ids || []).map(String))].slice(0, 500);
      if (cfg.paused) return Object.fromEntries(list.map((id) => [id, 'paused']));
      const visible = new Set(allSessions({ viewer }).map((s) => s.id));
      const exists = new Set(rawSessions(cfg.projects).map((s) => s.id));
      const allowed = cfg.allowCopies !== false;
      return Object.fromEntries(list.map((id) => [id, !allowed ? 'withdrawn' : visible.has(id) ? 'ok' : exists.has(id) ? 'withdrawn' : 'gone']));
    },

    whoami(viewer = null) {
      const visible = visibleProjects(viewer);
      return { ...owner, team: cfg.team, paused: !!cfg.paused, allowCopies: cfg.allowCopies !== false, projects: visible.map((p) => p.name), projectKeys: Object.fromEntries(visible.map((p) => [p.name, keyOf(p.path)])) };
    },

    projects(viewer = null) {
      return visibleProjects(viewer).map((p) => ({ name: p.name, projectKey: keyOf(p.path), owner: owner.name }));
    },

    // Para el panel del dueño: qué comparte, con quién y cuánto está oculto.
    sharing() {
      return {
        paused: !!cfg.paused,
        projects: cfg.projects.map((p) => {
          const sessions = rawSessions([p]);
          return {
            name: p.name,
            path: p.path,
            allow: p.allow,
            sessions: sessions.length,
            hidden: sessions.filter(isExcluded).length,
          };
        }),
      };
    },

    // Estado de cada fuente por proyecto, para el diagnóstico.
    diagnostics() {
      return cfg.projects.map((p) => {
        const claudeDir = path.join(cfg.claudeDir, encodeProject(p.path));
        const count = (fn) => {
          try {
            return { ok: true, sessions: fn().length };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        };
        return {
          name: p.name,
          path: p.path,
          exists: fs.existsSync(p.path),
          claude: fs.existsSync(claudeDir) ? count(() => listClaudeSessions(cfg, p.path)) : { ok: true, sessions: 0, note: 'Sin historial de Claude Code para esta carpeta' },
          cursor: cursorUnavailable ? { ok: false, error: cursorUnavailable } : count(() => listCursorSessions(cfg, p.path)),
        };
      });
    },

    // Sesiones de IA abiertas ahora en los proyectos que este visor puede ver.
    // Claude Code: su registro de sesiones vivas (con estado ocupada/libre). Cursor: actividad reciente.
    liveAgents(viewer = null) {
      const projects = visibleProjects(viewer);
      const projectOf = (cwd) => projects.find((p) => isInside(cwd, p.path));
      const out = [];
      for (const a of safe(() => listClaudeLive(cfg))) {
        const p = projectOf(a.cwd);
        const session = 'claude:' + a.sessionId;
        if (!p || (viewer && cfg.excludedSessions.includes(session))) continue;
        const s = safe(() => listClaudeSessions(cfg, p.path)).find((x) => x.id === session);
        out.push({ session, owner: owner.name, ownerId: owner.id, tool: 'Claude Code', name: a.name, project: p.name, projectKey: keyOf(p.path), status: a.status, title: s ? redact(s.title) : null, since: iso(a.statusAt) });
      }
      const recent = Date.now() - CURSOR_ACTIVE_MS;
      for (const s of rawSessions(projects, 'cursor')) {
        if ((s.updatedAt || 0) < recent) break;
        if (viewer && isExcluded(s)) continue;
        out.push({ session: s.id, owner: owner.name, ownerId: owner.id, tool: 'Cursor', name: null, project: nameOf(s.project), projectKey: keyOf(s.project), status: 'recent', title: redact(s.title), since: iso(s.updatedAt) });
      }
      return out;
    },

    listSessions({ project, source, since, limit = Infinity, viewer = null } = {}) {
      const from = since ? parseSince(since) : 0;
      return allSessions({ project, source, viewer })
        .filter((s) => (s.updatedAt || 0) >= from)
        .slice(0, limit)
        .map(summary);
    },

    // Últimos N mensajes, o una página (offset + limit) para leerla completa por partes.
    getSession(id, { lastMessages = 40, maxChars = 4000, offset = null, limit = 100, viewer = null } = {}) {
      const s = allSessions({ viewer }).find((x) => x.id === id);
      if (!s) {
        // Existe pero no le corresponde: se niega con el mismo mensaje y se deja constancia.
        const hiddenOne = viewer && rawSessions(cfg.projects).find((x) => x.id === id);
        if (hiddenOne) throw new AccessDenied({ id: hiddenOne.id, title: redact(hiddenOne.title), project: nameOf(hiddenOne.project) });
        throw new Error(`Sesión ${id} no encontrada (o su proyecto no está compartido).`);
      }
      const total = s.messages.length;
      const start = offset == null ? Math.max(0, total - lastMessages) : Math.min(Math.max(0, offset), total);
      const msgs = offset == null ? s.messages.slice(start) : s.messages.slice(start, start + limit);
      return {
        ...summary(s),
        total,
        offset: start,
        omittedMessages: total - msgs.length,
        conversation: msgs.map((m) => formatMessage(m, s, maxChars)),
      };
    },

    // Resumen para ponerse al día: qué se pidió, qué archivos se tocaron y en qué quedó cada sesión.
    whatChanged({ since = '24h', project, viewer = null } = {}) {
      const from = parseSince(since);
      const sessions = allSessions({ project, viewer }).filter((s) => (s.updatedAt || 0) >= from);
      const files = new Map();
      const result = sessions.map((s) => {
        const recent = s.messages.filter((m) => (m.at || 0) >= from);
        const edited = new Set();
        const commands = [];
        for (const m of recent)
          for (const a of m.actions) {
            if (a.kind === 'edit' && a.target) edited.add(relPath(a.target, s.project));
            if (a.kind === 'command') commands.push(redact(a.target));
          }
        for (const f of edited) files.set(f, [...(files.get(f) || []), s.id]);
        const lastAssistant = [...recent].reverse().find((m) => m.role === 'assistant' && m.text);
        return {
          id: s.id,
          owner: owner.name,
          ownerId: owner.id,
          source: s.source,
          project: nameOf(s.project),
          projectKey: keyOf(s.project),
          title: redact(s.title),
          branch: s.branch,
          updatedAt: iso(s.updatedAt),
          requests: recent.filter((m) => m.role === 'user').map((m) => redact(m.text)),
          filesChanged: [...edited].sort(),
          commands,
          lastAssistantMessage: lastAssistant ? redact(lastAssistant.text) : null,
        };
      });
      return {
        owner: owner.name,
        ownerId: owner.id,
        since: iso(from),
        sessions: result,
        filesChanged: [...files.entries()].map(([file, bySessions]) => ({ file, sessions: bySessions })).sort((a, b) => a.file.localeCompare(b.file)),
      };
    },

    search(query, { project, limit = Infinity, viewer = null } = {}) {
      const q = query.toLowerCase();
      const hits = [];
      for (const s of allSessions({ project, viewer })) {
        for (const m of s.messages) {
          const idx = m.text.toLowerCase().indexOf(q);
          if (idx < 0) continue;
          hits.push({
            sessionId: s.id,
            owner: owner.name,
            ownerId: owner.id,
            title: redact(s.title),
            project: nameOf(s.project),
            projectKey: keyOf(s.project),
            source: s.source,
            role: m.role,
            at: iso(m.at),
            snippet: redact(m.text.slice(Math.max(0, idx - 150), idx + q.length + 150)),
          });
          if (hits.length >= limit) return hits;
        }
      }
      return hits;
    },
  };
}

function dedupe(actions) {
  const seen = new Set();
  return actions.filter((a) => {
    const k = a.kind + a.target;
    return seen.has(k) ? false : seen.add(k);
  });
}

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    console.error('[session-hub] error leyendo fuente:', err.message);
    return [];
  }
}
