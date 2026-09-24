// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Todo texto visible en español (panel, avisos, estado, MCP, registros de la salida "Session Hub")
// debe tener su traducción al inglés en locales/en.json, exacta o por plantilla con {v1}, {v2}…
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tokenizer, tokTypes as tt } from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createTranslator } = require(path.join(ROOT, 'media/i18n.js'));
const translate = createTranslator(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8')));

// src/config.js y src/setup.js hablan antes de saber el idioma (arranque por terminal): se excluyen.
const FILES = ['extension/extension.cjs', 'extension/dashboard.cjs', 'extension/render.cjs', 'media/dashboard.js', 'src/server.js', 'src/team.js', 'src/hub.js', 'src/mcp.js', 'src/inbox.js', 'src/netdiag.js', 'src/archive.js', 'src/teamstate.js', 'src/identity.js', 'src/transport/swarm.js', 'src/transport/rpc.js', 'src/util.js'];
const SPANISH = /[áéíóúñ¿¡]|\b(de|la|el|los|las|que|con|para|una?|sin|tu|tus|sus?|ya|no|se|es|en)\b/i;

// Cadenas de un archivo JavaScript, leídas con un analizador real (acorn): '…', "…" y `…`.
// Las plantillas con ${…} se prueban con valores de ejemplo, igual que las traduce el traductor.
function strings(code) {
  const out = [];
  const tokens = [...tokenizer(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true })];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.type === tt.string) out.push({ line: tk.loc.start.line, s: tk.value });
    if (tk.type !== tt.backQuote) continue;
    const line = tk.loc.start.line;
    let s = '';
    let n = 0;
    for (i++; i < tokens.length && tokens[i].type !== tt.backQuote; i++) {
      if (tokens[i].type === tt.template || tokens[i].type === tt.invalidTemplate) s += tokens[i].value ?? '';
      if (tokens[i].type === tt.dollarBraceL) {
        s += `Valor${++n}`;
        let depth = 1;
        while (depth && ++i < tokens.length) {
          const x = tokens[i].type;
          if (x === tt.dollarBraceL || x === tt.braceL) depth++;
          if (x === tt.braceR) depth--;
          if (x === tt.backQuote) { // plantilla anidada: se salta entera
            for (i++; i < tokens.length && tokens[i].type !== tt.backQuote; i++);
          }
        }
      }
    }
    out.push({ line, s });
  }
  return out;
}

function visibleSpanishStrings(file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/'\s*\+\s*\n\s*'/g, ''); // 'a ' +\n 'b' → 'a b'
  return strings(code)
    .map(({ line, s }) => ({ line, s: s.replace(/^\$\([\w-]+\)\s*/, '') })) // "$(icono) texto": se traduce el texto
    .filter(({ s }) => s.length >= 4 && /\s/.test(s) && SPANISH.test(s) && !/^[\w.:/@-]+$/.test(s) && !/^(GET|POST) \//.test(s) && !/<\/?[a-z]/i.test(s) && !/^\[session-hub\]/.test(s));
}

test('todo texto visible en español tiene su traducción al inglés', () => {
  const missing = [];
  for (const f of FILES) for (const { line, s } of visibleSpanishStrings(f)) if (translate('en', s) === s) missing.push(`${f}:${line} → ${s.slice(0, 100)}`);
  assert.deepEqual(missing, [], `Textos sin traducir:\n${missing.join('\n')}`);
});

test('las traducciones conservan sus marcadores {v1}, {v2}…', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en.json'), 'utf8'));
  const marks = (s) => (s.match(/\{v\d+\}/g) || []).sort().join(',');
  const broken = Object.entries(dict).filter(([es, en]) => marks(es) !== marks(en)).map(([es]) => es);
  assert.deepEqual(broken, []);
});
