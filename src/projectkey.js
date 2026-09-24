// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Identidad de un proyecto, para no mezclar dos proyectos que solo comparten el nombre.
//
// Si la carpeta es un repositorio git con remoto "origin", la clave sale de ese remoto normalizado
// (sin credenciales, protocolo ni ".git"): dos personas con el mismo repo tienen la misma clave
// aunque cada una lo llame distinto. Solo viaja un hash, nunca la URL.
// Si no hay remoto, la clave es propia de esa persona y esa carpeta: nunca coincide con la de otro.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const cache = new Map(); // carpeta -> { mtime, key }
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

export function normalizeRemote(url) {
  return String(url)
    .trim()
    .replace(/^git\+/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?/i, '') // https://usuario:clave@host/… → host/…
    .replace(/^[^@/]+@([^:/]+):/, '$1/') // git@host:org/repo → host/org/repo
    .replace(/:\d+\//, '/') // puerto
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// .git puede ser una carpeta o, en worktrees y submódulos, un archivo "gitdir: …".
function gitConfigFile(dir) {
  const dotGit = path.join(dir, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return path.join(dotGit, 'config');
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1].trim());
    const common = path.join(gitdir, 'commondir'); // worktree: la config está en el repo principal
    return fs.existsSync(common) ? path.join(path.resolve(gitdir, fs.readFileSync(common, 'utf8').trim()), 'config') : path.join(gitdir, 'config');
  } catch {
    return null;
  }
}

export function originOf(dir) {
  const file = gitConfigFile(dir);
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const section = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\s*\[|$)/.exec(text);
    const url = section && /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
    return url ? url[1].trim() : null;
  } catch {
    return null;
  }
}

export function projectKey(dir, ownerId) {
  const file = gitConfigFile(dir);
  const mtime = file && fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  const hit = cache.get(dir);
  if (hit && hit.mtime === mtime && hit.owner === ownerId) return hit.key;
  const origin = originOf(dir);
  const key = origin ? `git:${hash(normalizeRemote(origin))}` : `local:${hash(`${ownerId}\n${path.resolve(dir)}`)}`;
  cache.set(dir, { mtime, owner: ownerId, key });
  return key;
}
