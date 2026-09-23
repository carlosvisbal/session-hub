// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Registro de quién del equipo ha consultado mis sesiones.
// Se guarda en un archivo JSONL (una lectura por línea) y sobrevive a reinicios;
// al arrancar se descartan las entradas más viejas que la retención configurada.
import fs from 'node:fs';
import path from 'node:path';

const MAX_IN_MEMORY = 500;

// Nombre legible del cliente MCP a partir de su clientInfo.name.
export function friendlyClient(name = '') {
  if (/cursor/i.test(name)) return 'Cursor';
  if (/claude[- ]?code/i.test(name)) return 'Claude Code';
  if (/claude/i.test(name)) return 'Claude';
  if (/visual studio code|vscode|copilot/i.test(name)) return 'VS Code';
  return name || null;
}

export function createAccessLog({ file, retentionDays = 90 } = {}) {
  const reads = []; // más reciente primero
  const viewers = new Map(); // id -> { id, name, role, lastSeen, reads }

  const touchViewer = (c, at) => {
    const v = viewers.get(c.id) || { id: c.id, name: c.name, role: c.role, reads: 0 };
    Object.assign(v, { name: c.name, role: c.role, lastSeen: at, lastVia: c.via, lastClient: c.client });
    viewers.set(c.id, v);
    return v;
  };

  // Carga lo guardado, poda lo vencido y reescribe el archivo ya podado.
  if (file && fs.existsSync(file)) {
    const cutoff = new Date(Date.now() - retentionDays * 86400e3).toISOString();
    const kept = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      try {
        const r = JSON.parse(line);
        if (r.at >= cutoff) kept.push(r);
      } catch {
        // línea incompleta o corrupta: se descarta
      }
    }
    fs.writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
    for (const r of kept) {
      touchViewer({ id: r.whoId, name: r.who, role: r.role, via: r.via, client: r.client }, r.at).reads++;
      reads.unshift(r);
    }
    reads.length = Math.min(reads.length, MAX_IN_MEMORY);
  }

  return {
    record(caller, what, detail = {}) {
      if (!caller?.id) return;
      const at = new Date().toISOString();
      const v = touchViewer(caller, at);
      if (!what) return; // solo presencia (listados, sondeos)
      v.reads++;
      const entry = { at, who: caller.name, whoId: caller.id, role: caller.role, via: caller.via, client: caller.client, what, ...detail };
      reads.unshift(entry);
      reads.length = Math.min(reads.length, MAX_IN_MEMORY);
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      }
    },
    snapshot() {
      return { viewers: [...viewers.values()].sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '')), reads, file, retentionDays };
    },
  };
}
