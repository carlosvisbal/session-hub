// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import os from 'node:os';

// IPs de la red local, sin las interfaces virtuales de Docker/VPN.
export function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr|tun|tap|wg|lo)/.test(name))
    .flatMap(([, list]) => list)
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// Direcciones donde me pueden encontrar; sin red local (VM, CI), la propia máquina.
export const reachableAddresses = () => (lanAddresses().length ? lanAddresses() : ['127.0.0.1']);

// "host:puerto" → { host, port }
export function parseAddr(a) {
  const m = /^([\w.-]+):(\d{1,5})$/.exec(String(a).trim());
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

// Promesa con tiempo límite: nada de esperas infinitas.
export function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'timeout' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
