// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Extracto para continuar una sesión antigua en una sesión nueva. Retomar una sesión cuya caché del
// prompt venció obliga a la IA a reprocesar toda la conversación (cientos de miles de tokens);
// con este extracto (unos pocos miles) la sesión nueva sigue sabiendo dónde quedó el trabajo.
import { truncate } from './util.js';

// Pasado este tiempo sin escribir, la caché del prompt de Claude suele haber vencido (dura cerca de
// una hora). Es una estimación: el plazo lo pone Anthropic y puede cambiar.
export const CACHE_MS = 60 * 60_000;
const REQUESTS = 5; // últimos mensajes del usuario
const REPLIES = 3; // últimas respuestas de la IA
const COMMANDS = 8;
const FILES = 60;
const MAP = 120; // líneas del mapa como máximo
const MAP_LINE = 110; // caracteres por línea

// «continue», «hola», «ok»…: no dicen en qué quedó el trabajo y ocupan el lugar de peticiones que sí.
const trivial = (text) => text.trim().length < 15;

// Mapa de toda la sesión: cada petición del usuario en una línea, con el número de mensaje (`desde` de
// get_session). Así la IA sabe qué hubo en cada tramo y lee solo el que necesita. Si hay más de MAP
// peticiones, se conservan las primeras y las últimas (lo del medio se pide por tramos).
function sessionMap(messages) {
  const all = messages.flatMap((m, i) => (m.role === 'user' && m.text && !trivial(m.text) ? [{ mensaje: i, text: truncate(m.text.replace(/\s+/g, ' '), MAP_LINE) }] : []));
  if (all.length <= MAP) return { mapa: all };
  const head = Math.ceil(MAP / 3);
  return { mapa: [...all.slice(0, head), ...all.slice(-(MAP - head))], mapaOmitidas: all.length - MAP };
}

const approxTokens = (v) => Math.ceil(JSON.stringify(v).length / 4);

// `header` es el resumen ya redactado de la sesión (summary de hub.js) y `messages` sus mensajes ya
// redactados (formatMessage): aquí no se lee nada de disco ni se redacta de nuevo.
export function buildDigest(header, messages, { now = Date.now() } = {}) {
  const users = messages.filter((m) => m.role === 'user' && m.text);
  const replies = messages.filter((m) => m.role === 'assistant' && m.text);
  const commands = messages.flatMap((m) => m.actions.filter((a) => a.kind === 'command').map((a) => truncate(a.target, 200)));
  // Primero los del proyecto (rutas relativas); los de fuera (memoria, /tmp…) van al final y los temporales no cuentan.
  const all = (header.filesChanged || []).filter((f) => !f.startsWith('/tmp/'));
  const files = [...all.filter((f) => !f.startsWith('/')), ...all.filter((f) => f.startsWith('/'))];
  const idleMs = header.updatedAt ? Math.max(0, now - Date.parse(header.updatedAt)) : null;
  const digest = {
    id: header.id,
    title: header.title,
    project: header.project,
    branch: header.branch,
    startedAt: header.createdAt,
    updatedAt: header.updatedAt,
    inactivaMin: idleMs == null ? null : Math.round(idleMs / 60_000),
    cacheVencida: idleMs == null ? null : idleMs > CACHE_MS,
    mensajesTotales: messages.length,
    objetivo: users[0] ? truncate(users[0].text, 1200) : null,
    ...sessionMap(messages),
    ultimasPeticiones: (users.filter((m) => !trivial(m.text)).length ? users.filter((m) => !trivial(m.text)) : users).slice(-REQUESTS).map((m) => ({ at: m.at, text: truncate(m.text, 600) })),
    ultimasRespuestas: replies.slice(-REPLIES).map((m) => ({ at: m.at, text: truncate(m.text, 1500) })),
    archivosCambiados: files.slice(0, FILES),
    ...(files.length > FILES ? { archivosOmitidos: files.length - FILES } : {}),
    ultimosComandos: commands.slice(-COMMANDS),
    nota:
      'Esto es un extracto de la sesión, no la sesión completa. Úsalo para seguir el trabajo donde quedó. ' +
      'El mapa lista cada petición con su número de mensaje: antes de suponer un detalle o una decisión de otro tramo, ' +
      'léelo con get_session (offset = ese número, limit = unos 10 mensajes) en vez de pedir la sesión entera.',
  };
  return { ...digest, tokensAprox: approxTokens(digest) };
}
