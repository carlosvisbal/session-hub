// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Infraestructura propia para trabajar en remoto con control total (modo "private"):
//   - nodos de arranque (la "guía de direcciones" del equipo; mínimo 3 para que funcione bien)
//   - un relay ciego, para cuando dos routers no permiten la conexión directa
// El relay solo reenvía bytes cifrados de extremo a extremo: no puede leer nada.
//
//   npm run infra -- --host 203.0.113.10               (IP pública o de VPN del servidor)
//   npm run infra -- --host 203.0.113.10 --port 49737 --nodes 3
//   npm run infra -- --public                          (solo relay, sobre la red pública)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import DHT from 'hyperdht';
import { generateKeyPair } from './identity.js';
import { DEFAULT_PUBLIC_RELAY, DEFAULT_RELAY_KEY_FILE, listenRelay, secureKeyFile } from './default-relay.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true;
};

// Arranca nodos y relay. Devuelve lo que los hubs deben configurar y cómo apagarlo.
export async function startInfra({ host = '127.0.0.1', port = 49737, nodes = 3, relay = true, publicNet = false, keyFile = null, log = console.log } = {}) {
  const started = [];
  let bootstrap = [];

  if (!publicNet) {
    const first = DHT.bootstrapper(port, host);
    await first.ready();
    started.push(first);
    bootstrap = [{ host, port }];
    // Nodos persistentes extra: con uno solo, los anuncios no tienen dónde guardarse.
    for (let i = 1; i < nodes; i++) {
      const n = new DHT({ bootstrap, ephemeral: false, firewalled: false, host: '0.0.0.0', port: port + i });
      await n.fullyBootstrapped();
      started.push(n);
    }
    log(`✔ ${nodes} nodo(s) de arranque en ${host}:${port}${nodes > 1 ? `–${port + nodes - 1}` : ''} (UDP)`);
  }

  let relayKey = null;
  if (relay) {
    // Clave estable: la configuración de los hubs no cambia al reiniciar el servidor.
    let kp = null;
    if (keyFile && fs.existsSync(keyFile)) kp = secureKeyFile(keyFile);
    if (!kp) {
      kp = generateKeyPair();
      if (keyFile) {
        fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(keyFile, JSON.stringify(kp), { mode: 0o600 });
        secureKeyFile(keyFile);
      }
    }
    const node = new DHT(publicNet ? {} : { bootstrap, ephemeral: false, firewalled: false, host: '0.0.0.0', port: port + nodes });
    await node.fullyBootstrapped();
    const relay = await listenRelay(node, kp);
    started.push({ destroy: async () => (await relay.close(), await node.destroy()) });
    relayKey = relay.relayKey;
    log(`✔ relay ciego activo${publicNet ? ' en la red pública' : ` en UDP ${port + nodes}`} · clave ${relayKey.slice(0, 12)}…`);
    started.relayServer = relay.relayServer;
  }

  const settings = {
    'sessionHub.network': publicNet ? 'public' : 'private',
    ...(bootstrap.length ? { 'sessionHub.bootstrap': bootstrap.map((b) => `${b.host}:${b.port}`) } : {}),
    ...(relayKey ? { 'sessionHub.relay': relayKey } : {}),
  };
  return {
    settings,
    bootstrap: bootstrap.map((b) => `${b.host}:${b.port}`),
    relayKey,
    relayStats: () => started.relayServer?.stats,
    stop: () => Promise.allSettled(started.map((n) => n.destroy())),
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('infra.js')) {
  const publicNet = arg('public', false) === true;
  const host = arg('host', null);
  if (!publicNet && !host) {
    console.error('Indica la IP pública (o de VPN) de este servidor: npm run infra -- --host 203.0.113.10\nO solo un relay sobre la red pública: npm run infra -- --public');
    process.exit(1);
  }
  const port = Number(arg('port', 49737));
  const infra = await startInfra({
    host,
    port,
    nodes: Number(arg('nodes', 3)),
    relay: arg('no-relay', false) !== true,
    publicNet,
    keyFile: publicNet && fs.existsSync(DEFAULT_RELAY_KEY_FILE) ? DEFAULT_RELAY_KEY_FILE : path.join(os.homedir(), '.session-hub', 'relay-key.json'),
  });
  if (publicNet && infra.relayKey !== DEFAULT_PUBLIC_RELAY) {
    console.log(`\nEsta clave no es la que trae Session Hub (${DEFAULT_PUBLIC_RELAY.slice(0, 12)}…). Los hubs en modo public no la usarán solos: pégala en sessionHub.relay, o arranca aquí con la clave de ~/.session-hub/default-relay-key.json.`);
  }
  console.log('\nConfiguración para cada persona del equipo (Ajustes → settings.json):\n');
  console.log(JSON.stringify(infra.settings, null, 2));
  console.log(`\nAbre en el firewall de este servidor: UDP ${publicNet ? '(salida)' : `${port}–${port + Number(arg('nodes', 3))}`}.\nCtrl+C para detener.`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => infra.stop().then(() => process.exit(0)));
}
