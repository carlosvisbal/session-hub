// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// AGPL-3.0 §13: quien usa el hub por la red tiene derecho a su código fuente.
// Este módulo sirve, en solo lectura, el código que está corriendo.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const ALLOWED_DIRS = ['src', 'extension', 'media', 'public', 'scripts'];
const ALLOWED_FILES = ['package.json', 'package-lock.json', 'LICENSE', 'LICENSE.txt', 'NOTICE', 'AUTHORS', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function listFiles() {
  const out = ALLOWED_FILES.filter((f) => fs.existsSync(path.join(ROOT, f)));
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  for (const d of ALLOWED_DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  return out;
}

export function sourceInfo(cfg) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return { name: pkg.name, version: pkg.version, license: pkg.license, source: cfg.sourceUrl || '/source' };
}

// Devuelve true si atendió la petición.
export function handleSource(req, res, url, cfg) {
  if (url.pathname !== '/source' && !url.pathname.startsWith('/source/')) return false;
  const rel = decodeURIComponent(url.pathname.slice('/source/'.length));
  const files = listFiles();

  if (!rel) {
    const info = sourceInfo(cfg);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Código fuente de Session Hub</title>
<body style="font:14px/1.5 system-ui;max-width:760px;margin:24px auto;padding:0 16px">
<h1>Session Hub ${esc(info.version)}</h1>
<p>Software libre bajo la licencia <a href="/source/${files.includes('LICENSE') ? 'LICENSE' : 'LICENSE.txt'}">${esc(info.license)}</a>. Este es el código que está corriendo en este hub.
${cfg.sourceUrl ? `Repositorio: <a href="${esc(cfg.sourceUrl)}">${esc(cfg.sourceUrl)}</a>.` : ''}</p>
<ul>${files.map((f) => `<li><a href="/source/${esc(f)}">${esc(f)}</a></li>`).join('')}</ul></body>`);
    return true;
  }
  // Solo archivos de la lista; nada de rutas relativas ni fuera de ROOT.
  if (!files.includes(rel)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
    return true;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  fs.createReadStream(path.join(ROOT, rel)).pipe(res);
  return true;
}
