// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Oculta credenciales antes de que cualquier texto salga de esta máquina.
import crypto from 'node:crypto';

const R = '[REDACTED]';

// Súbelo al cambiar las reglas de abajo: el índice de búsqueda guarda texto ya redactado y se
// rehace entero cuando cambia (ver rulesTag()).
const RULES_VERSION = 2;

const rules = [
  // PEM/PGP: también un bloque cortado sin su END (se tapa hasta el final del texto).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, R],
  // OpenAI (sk-…, sk-proj-…) y Anthropic (sk-ant-…)
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, R],
  // Stripe: claves secretas y restringidas, en vivo o de prueba
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bwhsec_[A-Za-z0-9]{20,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, R],
  [/\bnpm_[A-Za-z0-9]{30,}/g, R],
  [/\bhf_[A-Za-z0-9]{30,}/g, R],
  // AWS: claves permanentes (AKIA) y temporales (ASIA)
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R],
  // Slack: tokens (xoxb-, xoxp-, xoxe-, xoxe.xoxp-…) y webhooks
  [/\bxox(?:e\.xox)?[abeprs]-[A-Za-z0-9-]{10,}/g, R],
  [/(\bhooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/gi, `$1${R}`],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, `$1${R}`],
  // Authorization: Basic <base64>; suelto, solo si parece base64 de verdad (no "Basic configuration")
  [/(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/]+={0,2}/gi, `$1${R}`],
  [/(\bBasic\s+)(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g, `$1${R}`],
  // usuario:clave@host en URLs de conexión; la clave puede llevar "@" (se corta en la última antes del host)
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/]+)(@)/gi, `$1${R}$3`],
  // FOO_SECRET=valor, "password": "valor", api_key: valor, STRIPE_KEY=valor ...
  // "key" solo como palabra o tras "_"/"-" (STRIPE_KEY, key=…), para no tocar "monkey" ni "turkey".
  [
    // El valor debe parecer credencial (con dígitos o símbolos) para no tapar prosa como "token: expira".
    /\b([A-Za-z0-9_]*(?:secret|password|passwd|pwd|token|api[_-]?key|private[_-]?key|access[_-]?key|(?<![A-Za-z])key|credentials?)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)(["']?)((?=[^\s"'`,;]*[0-9_+/=.!@#$%*-])[^\s"'`,;]{4,})\3/gi,
    `$1$2$3${R}$3`,
  ],
];

let extra = [];
let extraSources = [];

export function setExtraPatterns(patterns = []) {
  const list = Array.isArray(patterns) ? patterns : [];
  extra = list.map((p) => [new RegExp(p, 'g'), R]);
  extraSources = list.map(String);
}

// Huella de las reglas vigentes (las fijas y las de redactExtra): si cambia, lo que se redactó con
// las anteriores ya no vale (el índice de búsqueda lo usa para reindexar).
export function rulesTag() {
  return crypto.createHash('sha256').update(JSON.stringify([RULES_VERSION, extraSources])).digest('hex').slice(0, 16);
}

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const [re, rep] of [...rules, ...extra]) out = out.replace(re, rep);
  return out;
}
