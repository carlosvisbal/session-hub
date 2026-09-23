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

export function relPath(file, project) {
  if (!file) return file;
  if (project && file.startsWith(project + path.sep)) return file.slice(project.length + 1);
  return file;
}

export function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + ` … [+${text.length - max} caracteres]`;
}

export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
