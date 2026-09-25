// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.SESSION_HUB_CONFIG || path.join(ROOT, 'config.json');

const defaults = {
  // Idioma de los mensajes: 'auto' (el del sistema), 'es' o 'en'.
  language: 'auto',
  // Cómo me ven mis compañeros (va firmado con mi clave).
  owner: { name: os.userInfo().username, role: '' },
  // API local (extensión, MCP, visor): solo en esta máquina, protegida con este token.
  port: 7420,
  localToken: '',
  // Red entre hubs: 'lan' (el equipo es la red), 'private' (nodos de arranque propios) o 'public'.
  network: 'lan',
  dhtPort: 49737, // UDP; en modo lan cada hub es un nodo de la red del equipo
  bootstrap: [], // modo private: ["host:puerto", …]
  peers: [], // direcciones extra "host:puerto" de compañeros, por si la red no los encuentra sola
  relay: '', // clave pública (hex) de un relay ciego, para cuando la conexión directa no es posible
  forceRelay: false, // usar siempre el relay (pruebas o redes muy restrictivas)
  // Proyectos que se comparten: { path, name, allow }. Nada fuera de esta lista se expone.
  // allow: ["*"] = todo el equipo, o claves públicas de personas concretas.
  projects: [],
  // Pausa global: mientras esté activa, nadie ve nada.
  paused: false,
  // Sesiones que no se muestran al equipo aunque su proyecto esté compartido.
  excludedSessions: [],
  // Mensajes de compañeros: 'hold' (esperan a que los apruebe), 'accept' (mi IA los ve enseguida) o 'refuse'.
  inbound: 'hold',
  // Respaldo local. archive: mis sesiones compartidas (siguen disponibles aunque Claude Code o Cursor
  // las borren). teamCopies: copias de lectura de las de mis compañeros, mientras tenga acceso.
  // allowCopies: si mis compañeros pueden guardar copia de mis sesiones.
  archive: true,
  archiveRetentionDays: 365, // lo que ya solo existe en el respaldo; 0 = sin límite
  teamCopies: true,
  copiesRetentionDays: 180, // copias que el dueño no confirma en este plazo se borran
  allowCopies: true,
  archiveMaxMB: 2048,
  // Archivos junto a la configuración si se dejan vacíos.
  stateFile: '', // claves, equipo, miembros, expulsiones (team.json)
  auditFile: '', // quién leyó qué (audit.jsonl)
  inboxFile: '', // mensajes recibidos y enviados (inbox.json)
  convFile: '', // conversaciones automáticas (conversations.json)
  archiveDir: '', // respaldo local (carpeta archive/)
  auditRetentionDays: 90,
  claudeDir: path.join(os.homedir(), '.claude', 'projects'),
  claudeSessionsDir: '', // sesiones de Claude Code abiertas; vacío = ~/.claude/sessions
  cursorUserDir: path.join(os.homedir(), '.config', 'Cursor', 'User'),
  // URL pública del repositorio (AGPL §13). Vacío = el hub sirve su propio código en /source.
  sourceUrl: '',
  // Regex adicionales (como string) a ocultar, p.ej. nombres de clientes.
  redactExtra: [],
};

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No existe ${CONFIG_PATH}. Ejecuta primero: npm run setup -- --name "Tu nombre"`);
  }
  return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

export function normalizeConfig(raw) {
  const cfg = { ...defaults, ...raw, owner: { ...defaults.owner, ...raw.owner } };
  cfg.localToken ||= raw.token || ''; // configuraciones anteriores a 0.6
  cfg.host = '127.0.0.1'; // la API nunca se expone a la red; entre hubs se habla por el canal cifrado
  if (!['lan', 'private', 'public'].includes(cfg.network)) cfg.network = 'lan';
  cfg.projects = cfg.projects.map((p) => {
    const { path: p0, name, allow } = typeof p === 'string' ? { path: p } : p;
    const abs = path.resolve(p0);
    return { path: abs, name: name || path.basename(abs), allow: Array.isArray(allow) && allow.length ? allow : ['*'] };
  });
  // Dos carpetas con el mismo nombre visible se distinguen ("api (clientes)"), para no confundirlas.
  const seen = new Set();
  for (const p of cfg.projects) {
    let name = p.name;
    if (seen.has(name)) name = `${p.name} (${path.basename(path.dirname(p.path))})`;
    for (let i = 2; seen.has(name); i++) name = `${p.name} (${i})`;
    seen.add((p.name = name));
  }
  const dir = path.dirname(CONFIG_PATH);
  cfg.stateFile ||= path.join(dir, 'team.json');
  cfg.auditFile ||= path.join(dir, 'audit.jsonl');
  cfg.inboxFile ||= path.join(dir, 'inbox.json');
  cfg.convFile ||= path.join(dir, 'conversations.json');
  cfg.archiveDir ||= path.join(dir, 'archive');
  if (!['hold', 'accept', 'refuse'].includes(cfg.inbound)) cfg.inbound = 'hold';
  if (!cfg.localToken) throw new Error('La configuración no tiene localToken. Ejecuta npm run setup.');
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// Se recarga en caliente al cambiar el archivo. Las claves de red reinician solo la conexión entre hubs.
export const HOT_RELOAD_KEYS = ['language', 'owner', 'projects', 'paused', 'excludedSessions', 'inbound', 'archive', 'archiveRetentionDays', 'teamCopies', 'copiesRetentionDays', 'allowCopies', 'archiveMaxMB', 'redactExtra', 'peers', 'auditRetentionDays', 'network', 'dhtPort', 'bootstrap', 'relay', 'forceRelay'];
export const NETWORK_KEYS = ['network', 'dhtPort', 'bootstrap', 'relay', 'forceRelay'];

export { defaults };
