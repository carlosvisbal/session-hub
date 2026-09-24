// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import path from 'node:path';

// Acepta ISO ("2026-09-23T10:00"), relativo ("30m", "2h", "3d") o vacío (por defecto).
export function parseSince(since, fallback = '24h') {
  const v = String(since || fallback).trim();
  if (/^(all|todo|siempre)$/i.test(v)) return 0;
  const m = /^(\d+)\s*([mhdw])$/i.exec(v);
  if (m) {
    const mult = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2].toLowerCase()];
    return Date.now() - Number(m[1]) * mult;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Fecha inválida: "${since}". Usa ISO o 30m / 2h / 3d.`);
  return t;
}

// Ruta relativa al proyecto, siempre con "/" para que un equipo con Windows, macOS y Linux vea lo mismo.
export function relPath(file, project) {
  if (!file) return file;
  const rel = project && file.startsWith(project + path.sep) ? file.slice(project.length + 1) : file;
  return rel.split(path.sep).join('/');
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + ` … [+${text.length - max} caracteres]`;
}

// Misma carpeta: en Windows las rutas no distinguen mayúsculas (Claude Code guarda "C:\…" y el
// editor da "c:\…"); en macOS y Linux se comparan tal cual.
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
export const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);
export const isInside = (child, parent) => !!child && !!parent && (samePath(child, parent) || norm(child).startsWith(norm(parent) + path.sep));

export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
