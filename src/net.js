// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import os from 'node:os';

// Interfaces virtuales que no sirven para hablar con compañeros (contenedores, puentes).
const IGNORED = /^(docker|br-|veth|virbr|lo|vmnet|vboxnet|podman|cni|flannel)/i;
// Interfaces de VPN: sí sirven (VPN de la empresa, WireGuard, Tailscale, ZeroTier…).
const VPN = /^(tun|tap|wg|tailscale|utun|ppp|zt|ipsec|nordlynx|proton)/i;

function ipv4(filter) {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !IGNORED.test(name) && filter(name))
    .flatMap(([, list]) => list)
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// IPs de la red local (sin VPN).
export const lanAddresses = () => ipv4((name) => !VPN.test(name));
// IPs de VPN.
export const vpnAddresses = () => ipv4((name) => VPN.test(name));

// Direcciones donde me pueden encontrar: red local y VPN; sin ninguna (VM, CI), la propia máquina.
export function reachableAddresses() {
  const all = [...new Set([...lanAddresses(), ...vpnAddresses()])];
  return all.length ? all : ['127.0.0.1'];
}

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
