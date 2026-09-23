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
import { iso, parseSince, relPath, truncate } from './util.js';

const CURSOR_ACTIVE_MS = 10 * 60_000; // Cursor no deja registro de sesiones abiertas: cuenta la actividad reciente

export class AccessDenied extends Error {
  constructor(session) {
    super('Sesión no encontrada (o su proyecto no está compartido contigo).');
    this.code = 'denied';
    this.session = session;
  }
}

export function createHub(cfg) {
  setExtraPatterns(cfg.redactExtra);

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

  function resolveProject(name, viewer) {
    const p = visibleProjects(viewer).find((x) => x.name === name || x.path === name);
    // Mismo mensaje exista o no: no se revela qué proyectos están restringidos.
    if (!p) throw new Error(`Proyecto "${name}" no compartido por ${owner.name}. Disponibles: ${visibleProjects(viewer).map((x) => x.name).join(', ') || 'ninguno'}`);
    return p;
  }

  const nameOf = (projectPath) => cfg.projects.find((x) => x.path === projectPath)?.name || path.basename(projectPath);

  function rawSessions(projects, source) {
    const out = [];
    for (const p of projects) {
      if (!source || source === 'claude-code') out.push(...safe(() => listClaudeSessions(cfg, p.path)));
      if (!source || source === 'cursor') out.push(...safe(() => listCursorSessions(cfg, p.path)));
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function allSessions({ project, source, viewer } = {}) {
    const projects = project ? [resolveProject(project, viewer)] : visibleProjects(viewer);
    const list = rawSessions(projects, source);
    return viewer ? list.filter((s) => !isExcluded(s)) : list;
  }

  function summary(s) {
    const edits = new Set();
    let commands = 0;
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
      title: redact(s.title),
      branch: s.branch,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
      messages: s.messages.length,
      filesChanged: [...edits].sort(),
      commandsRun: commands,
      ...(isExcluded(s) ? { hidden: true } : {}),
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
    whoami(viewer = null) {
      return { ...owner, team: cfg.team, paused: !!cfg.paused, projects: visibleProjects(viewer).map((p) => p.name) };
    },

    projects(viewer = null) {
      return visibleProjects(viewer).map((p) => ({ name: p.name, owner: owner.name }));
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
      const projectOf = (cwd) => projects.find((p) => cwd === p.path || cwd.startsWith(p.path + path.sep));
      const out = [];
      for (const a of safe(() => listClaudeLive(cfg))) {
        const p = projectOf(a.cwd);
        const session = 'claude:' + a.sessionId;
        if (!p || (viewer && cfg.excludedSessions.includes(session))) continue;
        const s = safe(() => listClaudeSessions(cfg, p.path)).find((x) => x.id === session);
        out.push({ session, owner: owner.name, ownerId: owner.id, tool: 'Claude Code', name: a.name, project: p.name, status: a.status, title: s ? redact(s.title) : null, since: iso(a.statusAt) });
      }
      const recent = Date.now() - CURSOR_ACTIVE_MS;
      for (const s of rawSessions(projects, 'cursor')) {
        if ((s.updatedAt || 0) < recent) break;
        if (viewer && isExcluded(s)) continue;
        out.push({ session: s.id, owner: owner.name, ownerId: owner.id, tool: 'Cursor', name: null, project: nameOf(s.project), status: 'recent', title: redact(s.title), since: iso(s.updatedAt) });
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
