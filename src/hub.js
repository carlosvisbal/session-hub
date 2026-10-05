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
import { redact, rulesTag, setExtraPatterns } from './redact.js';
import { projectKey } from './projectkey.js';
import { createOwnArchive } from './archive.js';
import { createSearchIndex } from './searchindex.js';
import { iso, samePath, parseSince, relPath, truncate } from './util.js';

const TEXT = (v) => (typeof v === 'string' ? v : '');

const CURSOR_ACTIVE_MS = 10 * 60_000; // Cursor no deja registro de sesiones abiertas: cuenta la actividad reciente

// Un subagente se lee con el id de su sesión más "/sub:<id del subagente>" (p. ej. "claude:abc/sub:a1b2"),
// por el mismo getSession y con los mismos permisos que la sesión que lo lanzó.
const SUB = '/sub:';
export const subagentId = (sessionId, childId) => `${sessionId}${SUB}${childId}`;
function splitSubagentId(id) {
  const i = String(id).lastIndexOf(SUB);
  return i > 0 ? [id.slice(0, i), id.slice(i + SUB.length)] : [String(id), null];
}
// Mensajes de la sesión y de sus subagentes: para contar archivos y comandos, y para buscar.
const withSubagents = (s) => {
  const subs = s.subagents;
  return subs?.length ? [...s.messages, ...subs.flatMap((x) => x.messages || [])] : s.messages;
};

export class AccessDenied extends Error {
  constructor(session) {
    super('Sesión no encontrada (o su proyecto no está compartido contigo).');
    this.code = 'denied';
    this.session = session;
  }
}

export function createHub(cfg, { log = () => {} } = {}) {
  setExtraPatterns(cfg.redactExtra);
  // Índice de búsqueda (SQLite FTS5): acelera y mejora search(), nunca es la fuente de verdad.
  // Sin Node 22.5+ (node:sqlite) o sin carpeta configurada (pruebas), queda desactivado y search()
  // vuelve al barrido de siempre.
  const searchIndex = cfg.searchIndexFile ? createSearchIndex({ file: cfg.searchIndexFile, log }) : null;
  // Respaldo de mis sesiones (capa 1). Sin carpeta configurada (pruebas) no hay respaldo.
  const own = cfg.archiveDir ? createOwnArchive({ dir: cfg.archiveDir, log, searchIndex, ownerId: () => cfg.id }) : null;
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
  const keyOf = (projectPath) => projectKey(projectPath, cfg.id, cfg.projects.find((x) => x.path === projectPath)?.link);

  // Fuentes de un proyecto; ok=false si alguna falló (base de Cursor bloqueada, disco…).
  function listing(p, source) {
    let ok = true;
    const read = (fn) => {
      try {
        return fn();
      } catch (err) {
        ok = false;
        console.error('[session-hub] error leyendo fuente:', err.message);
        return err.sessions || []; // lo que sí se pudo leer (Cursor: sus .jsonl si la base falló)
      }
    };
    const sessions = [];
    if (!source || source === 'claude-code') sessions.push(...read(() => listClaudeSessions(cfg, p.path)));
    // Sin node:sqlite, Cursor aún puede leer sus transcripciones .jsonl.
    if (!source || source === 'cursor') sessions.push(...read(() => listCursorSessions(cfg, p.path)));
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

  // Índice de búsqueda de mis sesiones: siempre texto redactado, con la huella de las reglas.
  const indexOwn = (s, tag = rulesTag()) =>
    // Lo que dijeron sus subagentes se indexa con la sesión: encontrarlo lleva a la sesión que los lanzó.
    searchIndex.indexSession({ id: s.id, scope: 'own', ownerId: cfg.id, source: s.source, project: s.project, title: s.title, updatedAt: s.updatedAt, messages: withSubagents(s), transform: redact, tag });
  function freshenIndex(sessions) {
    const stamps = searchIndex.stamps('own', cfg.id);
    const tag = rulesTag();
    for (const s of sessions) if (stamps.get(s.id) !== String(s.updatedAt ?? '')) indexOwn(s, tag);
  }

  function allSessions({ project, source, viewer } = {}) {
    const projects = project ? [resolveProject(project, viewer)] : visibleProjects(viewer);
    const list = rawSessions(projects, source);
    return viewer ? list.filter((s) => !isExcluded(s)) : list;
  }

  // Archivos tocados y comandos de una lista de mensajes. shell: los archivos que solo cambiaron
  // por comandos de terminal (via: 'shell'), nunca con una herramienta de edición.
  function tally(messages, project) {
    const edits = new Set();
    const byTool = new Set();
    let commands = 0;
    for (const m of messages)
      for (const a of m.actions) {
        if (a.kind === 'edit' && a.target) {
          const rel = relPath(a.target, project);
          edits.add(rel);
          if (a.via !== 'shell') byTool.add(rel);
        }
        if (a.kind === 'command') commands++;
      }
    return { edits, commands, shell: new Set([...edits].filter((f) => !byTool.has(f))) };
  }
  // Campo filesByShell (redactado), solo si hay alguno.
  const shellField = (shell) => (shell?.size ? { filesByShell: [...shell].map(redact).sort() } : {});

  function summary(s) {
    // Las del respaldo traen sus cifras precalculadas (archived.stats); las de Cursor tienen su propio
    // campo "stats" (líneas agregadas y quitadas), que no es lo mismo: por eso se mira "archived".
    // Archivos y comandos incluyen lo que hicieron sus subagentes.
    const pre = s.archived ? s.stats : null;
    // (Del respaldo no se sabe cuáles fueron por terminal: sus cifras no lo guardan.)
    const { edits, commands, shell } = pre ? { edits: new Set(pre.edits || []), commands: pre.commands || 0, shell: null } : tally(withSubagents(s), s.project);
    const subs = pre ? pre.subagents : s.subagents;
    return {
      id: s.id,
      owner: owner.name,
      ownerId: owner.id,
      source: s.source,
      project: nameOf(s.project),
      projectKey: keyOf(s.project),
      title: redact(s.title),
      branch: redact(s.branch),
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
      messages: pre ? pre.count : s.messages.length,
      // Las rutas también pasan por redact(): un nombre de archivo o rama puede llevar un secreto.
      filesChanged: [...edits].map(redact).sort(),
      // Los que solo cambiaron con comandos de terminal (sed -i, >, cp…): subconjunto de filesChanged.
      ...shellField(shell),
      commandsRun: commands,
      // Subagentes que lanzó (cada uno se lee con getSession(id)); sin subagentes, el campo no aparece.
      ...(subs?.length
        ? {
            subagents: subs.map((x) => ({
              id: subagentId(s.id, x.id),
              type: x.type ? redact(x.type) : null,
              description: x.description ? redact(x.description) : null,
              messageCount: x.messages ? x.messages.length : x.count || 0,
            })),
          }
        : {}),
      ...(isExcluded(s) ? { hidden: true } : {}),
      // El original ya no está en Claude Code / Cursor: se sirve desde mi respaldo.
      ...(s.archived ? { archived: true, goneSince: s.goneSince } : {}),
    };
  }

  // Cabecera de un subagente leído por su id: la de su sesión (dueño, proyecto, permisos, oculta,
  // respaldo) con sus propias cifras.
  function subSummary(s, sub) {
    const { edits, commands, shell } = tally(sub.messages, s.project);
    const at = sub.messages.map((m) => m.at).filter(Boolean);
    const base = summary(s);
    delete base.subagents;
    delete base.filesByShell;
    return {
      ...base,
      id: subagentId(s.id, sub.id),
      parentId: s.id,
      subagentType: sub.type ? redact(sub.type) : null,
      title: redact(sub.description || sub.type || s.title),
      createdAt: iso(sub.startedAt || at[0] || null),
      updatedAt: iso(sub.updatedAt || at[at.length - 1] || null),
      messages: sub.messages.length,
      filesChanged: [...edits].map(redact).sort(),
      ...shellField(shell),
      commandsRun: commands,
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
          // Edición deducida de un comando de terminal: el panel la marca aparte.
          ...(a.via ? { via: a.via } : {}),
          // La llamada que lanzó un subagente apunta a él (se lee con getSession de ese id).
          ...(a.kind === 'agent' && a.ref ? { subagent: subagentId(s.id, a.ref) } : {}),
        })),
      ),
    };
  }

  return {
    // Para que createCopies() (fuera de este módulo) indexe las copias en el mismo archivo.
    searchIndex,
    // Clave de proyecto de una carpeta con mis reglas (git, vínculo manual o local), y mis proyectos:
    // para saber en qué proyecto trabajo ahora (ver workspace.js).
    keyOf,
    sharedProjects: () => cfg.projects,
    // ---------- respaldo (capa 1) ----------
    syncArchive() {
      if (archiveOn()) {
        own.sync(cfg.projects, (p) => listing(p), { retentionDays: cfg.archiveRetentionDays });
        own.trimTo(Math.max(50, cfg.archiveMaxMB || 2048) * 1024 * 1024);
      }
      // Independiente del respaldo: buscar debe funcionar aunque esté desactivado. Se indexa el
      // texto ya redactado (con la huella de las reglas: si cambian, se reindexa todo), para que
      // buscar nunca sirva para adivinar un secreto que redact() tapa.
      if (searchIndex) {
        const tag = rulesTag();
        const present = new Set();
        for (const s of rawSessions(cfg.projects)) {
          present.add(s.id);
          indexOwn(s, tag);
        }
        // Lo que ya no existe (ni en la fuente ni en el respaldo, o de un proyecto que dejé de compartir) sale del índice.
        for (const id of searchIndex.ids('own', cfg.id)) if (!present.has(id)) searchIndex.removeSession(id, { scope: 'own', ownerId: cfg.id });
      }
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
      // Igual que los listados: una sesión es del proyecto cuya carpeta es exactamente su cwd (una
      // subcarpeta compartida aparte no hereda la lista de acceso del proyecto padre, ni al revés).
      const projectOf = (cwd) => {
        const own = cfg.projects.find((p) => samePath(cwd, p.path));
        return own && projects.includes(own) ? own : null;
      };
      const out = [];
      for (const a of safe(() => listClaudeLive(cfg))) {
        const p = projectOf(a.cwd);
        const session = 'claude:' + a.sessionId;
        if (!p || (viewer && cfg.excludedSessions.includes(session))) continue;
        const s = safe(() => listClaudeSessions(cfg, p.path)).find((x) => x.id === session);
        out.push({ session, owner: owner.name, ownerId: owner.id, tool: 'Claude Code', name: a.name ? redact(a.name) : null, project: p.name, projectKey: keyOf(p.path), status: a.status, title: s ? redact(s.title) : null, since: iso(a.statusAt) });
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
    // Un subagente ("<sesión>/sub:<id>") se lee igual, con los permisos de su sesión: si la sesión
    // no se ve (proyecto no compartido, oculta, pausa), el subagente tampoco.
    getSession(id, { lastMessages = 40, maxChars = 4000, offset = null, limit = 100, viewer = null } = {}) {
      const [parentId, childId] = splitSubagentId(id);
      const s = allSessions({ viewer }).find((x) => x.id === parentId);
      if (!s) {
        // Existe pero no le corresponde: se niega con el mismo mensaje y se deja constancia.
        const hiddenOne = viewer && rawSessions(cfg.projects).find((x) => x.id === parentId);
        if (hiddenOne) throw new AccessDenied({ id: childId == null ? hiddenOne.id : id, title: redact(hiddenOne.title), project: nameOf(hiddenOne.project) });
        throw new Error(`Sesión ${id} no encontrada (o su proyecto no está compartido).`);
      }
      const sub = childId == null ? null : (s.subagents || []).find((x) => x.id === childId);
      if (childId != null && !sub) throw new Error(`Sesión ${id} no encontrada (o su proyecto no está compartido).`);
      const list = sub ? sub.messages : s.messages;
      const total = list.length;
      const start = offset == null ? Math.max(0, total - lastMessages) : Math.min(Math.max(0, offset), total);
      const msgs = offset == null ? list.slice(start) : list.slice(start, start + limit);
      return {
        ...(sub ? subSummary(s, sub) : summary(s)),
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
        // Archivos y comandos: también los de sus subagentes en ese plazo.
        for (const m of withSubagents(s).filter((x) => (x.at || 0) >= from))
          for (const a of m.actions) {
            if (a.kind === 'edit' && a.target) edited.add(redact(relPath(a.target, s.project)));
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
          branch: redact(s.branch),
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
      // Mismos permisos que allSessions(): proyecto pedido (o todos los visibles) y, para un
      // compañero, sin las sesiones ocultas. El índice no sabe nada de permisos por sí solo: se
      // filtra aquí, después de preguntarle, igual que antes se filtraba después del barrido.
      const projects = project ? [resolveProject(project, viewer)] : visibleProjects(viewer);
      // Con reglas de redacción recién cambiadas y el índice aún sin rehacer, no se usa el índice
      // (podría encontrar algo que las reglas nuevas tapan): barrido hasta la próxima sincronización.
      if (searchIndex?.available && searchIndex.isCurrent('own', cfg.id, rulesTag())) {
        const allowed = new Set(projects.map((p) => p.path));
        // Proyectos y ocultas se filtran en la propia consulta: lo que el visor no puede ver no
        // ocupa el lugar de lo que sí. `exists` comprueba además que la sesión siga existiendo
        // (en la fuente o en el respaldo): un índice viejo nunca devuelve una sesión que ya no está.
        // Antes de preguntar, se indexa lo que cambió desde la última sincronización (solo eso):
        // una sesión recién conversada se encuentra ya, no un minuto después, y al arrancar el hub
        // la búsqueda no vuelve vacía por tener el índice aún sin llenar.
        const sessions = rawSessions(projects);
        freshenIndex(sessions);
        const present = new Set(sessions.map((x) => x.id));
        const exists = (_scope, _owner, id) => present.has(id);
        const raw = searchIndex.search(query, {
          limit,
          scope: 'own',
          ownerId: cfg.id,
          projects: [...allowed],
          excludeIds: viewer ? cfg.excludedSessions : [],
          exists,
        });
        const hits = [];
        for (const r of raw) {
          if (!allowed.has(r.project) || (viewer && isExcluded({ id: r.sessionId }))) continue;
          hits.push({ sessionId: r.sessionId, owner: owner.name, ownerId: owner.id, title: redact(r.title), project: nameOf(r.project), projectKey: keyOf(r.project), source: r.source, role: r.role, at: iso(r.at), snippet: redact(r.snippet) });
          if (hits.length >= limit) break;
        }
        return hits;
      }
      // Sin índice (Node anterior a 22.5): el barrido de siempre, mensaje por mensaje, sobre el
      // texto ya redactado (buscar no debe revelar si un secreto aparece, ni cortar el fragmento
      // por la mitad de uno antes de taparlo).
      const q = query.toLowerCase();
      const hits = [];
      for (const s of rawSessions(projects)) {
        if (viewer && isExcluded(s)) continue;
        for (const m of withSubagents(s)) {
          const text = redact(TEXT(m.text));
          const idx = text ? text.toLowerCase().indexOf(q) : -1;
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
            snippet: text.slice(Math.max(0, idx - 150), idx + q.length + 150),
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
    const k = a.kind + a.target + (a.subagent || '');
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
