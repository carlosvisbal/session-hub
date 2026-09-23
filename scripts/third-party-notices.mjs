// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Genera THIRD_PARTY_NOTICES.md con la licencia de cada dependencia instalada.
// Falla si aparece una licencia que no esté en la lista de compatibles con AGPL-3.0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // fileURLToPath: correcto también en Windows
const NM = path.join(ROOT, 'node_modules');
const COMPATIBLE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);

const pkgs = [];
for (const d of fs.readdirSync(NM)) {
  if (d.startsWith('.')) continue;
  const names = d.startsWith('@') ? fs.readdirSync(path.join(NM, d)).map((x) => `${d}/${x}`) : [d];
  for (const name of names) {
    const dir = path.join(NM, name);
    const pj = path.join(dir, 'package.json');
    if (!fs.existsSync(pj)) continue;
    const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const license = typeof p.license === 'string' ? p.license : p.license?.type || 'DESCONOCIDA';
    const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    pkgs.push({ name, version: p.version, license, text: file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null });
  }
}
pkgs.sort((a, b) => a.name.localeCompare(b.name));

const bad = pkgs.filter((p) => !p.license.split(/\s+OR\s+|[()]/).some((l) => COMPATIBLE.has(l.trim())));
if (bad.length) {
  console.error('Licencias sin revisar:', bad.map((p) => `${p.name}@${p.version} (${p.license})`).join(', '));
  process.exit(1);
}

const out = [
  '# Avisos de terceros',
  '',
  `Session Hub incluye ${pkgs.length} paquetes de terceros. Todos usan licencias compatibles con AGPL-3.0.`,
  'Archivo generado con `npm run licenses`; no editar a mano.',
  '',
  '| Paquete | Versión | Licencia |',
  '| --- | --- | --- |',
  ...pkgs.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  '',
  ...pkgs.flatMap((p) => [`## ${p.name}@${p.version} — ${p.license}`, '', '```', p.text || '(el paquete no incluye archivo de licencia)', '```', '']),
];
fs.writeFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), out.join('\n'));
console.log(`THIRD_PARTY_NOTICES.md: ${pkgs.length} paquetes, todos compatibles.`);
