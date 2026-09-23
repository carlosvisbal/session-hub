// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Oculta credenciales antes de que cualquier texto salga de esta máquina.
const R = '[REDACTED]';

const rules = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${R}`],
  // usuario:clave@host en URLs de conexión
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, `$1${R}$3`],
  // FOO_SECRET=valor, "password": "valor", api_key: valor ...
  [
    // El valor debe parecer credencial (con dígitos o símbolos) para no tapar prosa como "token: expira".
    /\b([A-Za-z0-9_]*(?:secret|password|passwd|pwd|token|api[_-]?key|private[_-]?key|access[_-]?key|credentials?)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)((?=[^\s"'`,;]*[0-9_+/=.!@#$%*-])[^\s"'`,;]{4,})\3/gi,
    `$1$2$3${R}$3`,
  ],
];

let extra = [];

export function setExtraPatterns(patterns = []) {
  extra = patterns.map((p) => [new RegExp(p, 'g'), R]);
}

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const [re, rep] of [...rules, ...extra]) out = out.replace(re, rep);
  return out;
}
