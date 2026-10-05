// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Relay ciego de respaldo para el modo public. La clave pública va en el programa: si
// sessionHub.relay está vacío, los hubs la usan solos cuando la conexión directa no sale.
// La clave privada no viaja con el programa. Quien la tiene en
// ~/.session-hub/default-relay-key.json lo deja encendido con `npm run infra -- --public`
// (un servicio aparte del editor). El relay solo reenvía bytes cifrados.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server as RelayServer } from 'blind-relay';
import { keyPairBuffers } from './identity.js';

export const DEFAULT_PUBLIC_RELAY = '592f0bb6696d1c71b78bcb0317cfbafb7ded87097dc308eb55e758e28b0280b8';
export const DEFAULT_RELAY_KEY_FILE = path.join(os.homedir(), '.session-hub', 'default-relay-key.json');

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

// Clave escrita en la configuración, si es una clave pública válida. Si no, vacío.
export function explicitRelay(cfg) {
  const key = String(cfg?.relay || '').trim().toLowerCase();
  return HEX64.test(key) ? key : '';
}

// La que se usa de verdad. En modo public, sin clave propia, es la incluida.
export function effectiveRelay(cfg) {
  const own = explicitRelay(cfg);
  if (own) return { key: own, builtin: false };
  if (cfg?.network === 'public') return { key: DEFAULT_PUBLIC_RELAY, builtin: true };
  return { key: '', builtin: false };
}

// La carpeta y el archivo de una clave privada quedan solo para su dueño (0700 y 0600).
// Si después de cerrarlos otros usuarios aún pueden leerlos, no se usa la clave.
function tighten(p, mode) {
  try {
    if (fs.statSync(p).mode & 0o077) fs.chmodSync(p, mode);
  } catch (err) {
    // En el servicio la carpeta va montada solo-lectura: si el archivo ya está cerrado, sigue.
    if (err.code !== 'EROFS' && err.code !== 'EPERM' && err.code !== 'ENOENT') throw err;
  }
}

export function secureKeyFile(file) {
  tighten(path.dirname(file), 0o700);
  tighten(file, 0o600);
  if (fs.statSync(file).mode & 0o077) {
    throw Object.assign(new Error('La clave del relay la pueden leer otros usuarios'), { code: 'EPERM' });
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Clave privada del relay incluido, solo si este equipo es quien lo hospeda.
export function loadHostedRelayKey(file = DEFAULT_RELAY_KEY_FILE, expected = DEFAULT_PUBLIC_RELAY) {
  try {
    const kp = secureKeyFile(file);
    if (kp.publicKey === expected && HEX128.test(kp.secretKey)) return { publicKey: kp.publicKey, secretKey: kp.secretKey };
  } catch {
    // no está, otros pueden leerla, o no es la clave incluida: este equipo no hospeda el relay
  }
  return null;
}

// Cuelga un relay ciego de un nodo DHT que ya está en la red. Lo cierra quien lo creó.
export async function listenRelay(node, kp) {
  const relayServer = new RelayServer({ createStream: (opts) => node.createRawStream({ ...opts, framed: true }) });
  const server = node.createServer((socket) => {
    socket.on('error', () => {});
    relayServer.accept(socket, { id: socket.remotePublicKey }).on('error', () => {});
  });
  await server.listen(keyPairBuffers(kp));
  return {
    relayKey: kp.publicKey,
    relayServer,
    close: async () => {
      await relayServer.close();
      await server.close();
    },
  };
}
