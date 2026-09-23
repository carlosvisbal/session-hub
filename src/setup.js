// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Configuración por línea de comandos (sin extensión).
//
//   npm run setup -- --name Carlos --role backend /ruta/proyecto=alias …
//   npm run setup -- team create "desarrollo"
//   npm run setup -- team invite            → imprime un código SH2-… para UNA persona (48 h)
//   npm run setup -- team join SH2-…
//   npm run setup -- team status
//
// Los comandos de equipo usan el hub si está corriendo; si no, trabajan sobre el archivo de estado.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_PATH, defaults, normalizeConfig, saveConfig } from './config.js';
import { fingerprint } from './identity.js';
import { reachableAddresses } from './net.js';
import { openTeamState } from './teamstate.js';

const raw = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : structuredClone(defaults);
raw.owner ||= { ...defaults.owner };
raw.projects ||= [];
raw.localToken ||= raw.token || crypto.randomBytes(24).toString('base64url');
delete raw.token;
delete raw.team;
delete raw.discoveryPort;

const args = process.argv.slice(2);

async function viaHub(method, route, body) {
  const cfg = normalizeConfig(raw);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${cfg.localToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null; // hub apagado: se trabaja sobre el archivo
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

async function teamCommand([cmd, value]) {
  saveConfig(raw);
  const cfg = normalizeConfig(raw);
  const offline = () => openTeamState(cfg.stateFile);
  if (cmd === 'create') {
    const r = (await viaHub('POST', '/api/team/create', { name: value })) || { team: offline().createTeam(value || 'equipo') };
    return console.log(`Equipo "${r.team.name}" creado. Invita con: npm run setup -- team invite`);
  }
  if (cmd === 'join') {
    const r = (await viaHub('POST', '/api/team/join', { code: value })) || offline().join(value);
    return console.log(`Te uniste al equipo "${r.team.name}". Si el hub estaba apagado, inícialo con: npm start`);
  }
  if (cmd === 'invite') {
    const bootstrap = cfg.network === 'private' ? cfg.bootstrap : reachableAddresses().map((ip) => `${ip}:${cfg.dhtPort}`);
    const r = (await viaHub('POST', '/api/team/invite', {})) || offline().makeInvite({ network: cfg.network, bootstrap });
    console.log(`Invitación para UNA persona, vence ${new Date(r.expires).toLocaleString()}. Pásala solo por un canal privado:\n`);
    return console.log(r.code);
  }
  if (cmd === 'status') {
    const s = offline();
    const t = s.team();
    console.log(`Yo: ${cfg.owner.name} · huella ${fingerprint(s.me())}`);
    console.log(t ? `Equipo: ${t.name} (fundador ${fingerprint(t.id)})` : 'Sin equipo');
    for (const m of s.roster()) console.log(`  ${m.fingerprint}  ${m.name || '?'}${m.founder ? ' · fundador' : ''}${m.revoked ? ' · EXPULSADO' : ''}${m.blocked ? ' · bloqueado por mí' : ''}`);
    return;
  }
  throw new Error('Comandos de equipo: create <nombre> | invite | join <código> | status');
}

if (args[0] === 'team') {
  teamCommand(args.slice(1)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '--name') raw.owner.name = next();
    else if (a === '--role') raw.owner.role = next();
    else if (a === '--port') raw.port = Number(next());
    else if (a === '--dht-port') raw.dhtPort = Number(next());
    else if (a === '--network') raw.network = next();
    else if (a === '--peer') raw.peers = [...new Set([...(raw.peers || []), next()])];
    else if (a === '--remove') {
      const target = path.resolve(next());
      raw.projects = raw.projects.filter((p) => path.resolve(p.path || p) !== target);
    } else {
      const [p, name] = a.split('=');
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) {
        console.error(`No existe: ${abs}`);
        process.exit(1);
      }
      raw.projects = raw.projects.filter((x) => path.resolve(x.path || x) !== abs);
      raw.projects.push({ path: abs, name: name || path.basename(abs), allow: ['*'] });
    }
  }
  saveConfig(raw);
  const cfg = normalizeConfig(raw);
  console.log(`Configuración guardada en ${CONFIG_PATH}`);
  console.log(`Yo: ${cfg.owner.name}${cfg.owner.role ? ' · ' + cfg.owner.role : ''} · red ${cfg.network}`);
  console.log(`Proyectos compartidos:\n${cfg.projects.map((p) => `  - ${p.name}  (${p.path})`).join('\n') || '  (ninguno)'}`);
  console.log('Siguiente paso: npm run setup -- team create "<nombre>"  ó  npm run setup -- team join SH2-…');
}
