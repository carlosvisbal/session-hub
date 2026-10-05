// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Proyecto actual: las carpetas en las que trabaja la persona (o su IA) ahora mismo.
// Sirve para no mezclar proyectos por error: lo de otro proyecto se marca, y con el mismo nombre
// pero otra clave se avisa. Todo se calcula en esta máquina; solo se comparan claves (hashes).
import fs from 'node:fs';
import path from 'node:path';
import { originOf } from './projectkey.js';

const MAX_FOLDERS = 10;

// Nombre comparable: sin mayúsculas, tildes ni separadores ("My-App" ≈ "my_app" ≈ "myapp").
export const sameName = (a) =>
  String(a || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// Solo carpetas absolutas que existen; nada de rutas relativas ni archivos.
export function cleanFolders(list) {
  const out = [];
  for (const raw of [list].flat()) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const abs = path.resolve(raw.trim());
    if (!path.isAbsolute(raw.trim()) || out.includes(abs)) continue;
    try {
      if (fs.statSync(abs).isDirectory()) out.push(abs);
    } catch {
      // no existe: se ignora
    }
    if (out.length >= MAX_FOLDERS) break;
  }
  return out;
}

// keyOf(carpeta) → projectKey con las mismas reglas que el hub (incluye vínculos manuales).
// projects: los proyectos que comparto, para usar su nombre y su vínculo si la carpeta es uno de ellos.
export function workspaceContext(folders, { keyOf, projects = [] }) {
  const list = cleanFolders(folders).map((dir) => {
    const shared = projects.find((p) => p.path === dir);
    const projectKey = keyOf(dir);
    return {
      path: dir,
      name: shared?.name || path.basename(dir),
      projectKey,
      git: !!originOf(dir),
      linked: projectKey.startsWith('link:'),
      shared: !!shared,
    };
  });
  return { folders: list, keys: new Set(list.map((f) => f.projectKey)), names: new Set(list.map((f) => sameName(f.name)).filter(Boolean)) };
}

// current: del proyecto actual · same-name: se llama igual pero es OTRO proyecto · other: otro proyecto.
export function relationOf(item, ctx) {
  if (!ctx?.folders.length || !item || typeof item.projectKey !== 'string') return null;
  if (ctx.keys.has(item.projectKey)) return 'current';
  return ctx.names.has(sameName(item.project)) ? 'same-name' : 'other';
}

// Recorre un resultado (listas, objetos anidados) y marca cada cosa que tenga projectKey.
// Con onlyCurrent, además quita de las listas lo que no es del proyecto actual.
export function annotate(value, ctx, { onlyCurrent = false, label = (r) => r } = {}) {
  const stats = { current: 0, 'same-name': 0, other: 0 };
  const walk = (v) => {
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        const r = x && typeof x === 'object' ? relationOf(x, ctx) : null;
        if (r) stats[r]++;
        if (onlyCurrent && r && r !== 'current') continue;
        out.push(walk(x));
      }
      return out;
    }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      const r = relationOf(v, ctx);
      if (r) o.relacion = label(r);
      return o;
    }
    return v;
  };
  return { value: walk(value), stats };
}
