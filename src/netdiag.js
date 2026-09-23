// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Diagnóstico de red: a partir del estado de la conexión, explica POR QUÉ algo no conecta
// (casi siempre una política de red) y arma un informe para compartir con TI.

const HOLEPUNCH = new Set(['HOLEPUNCH_DOUBLE_RANDOMIZED_NATS', 'CANNOT_HOLEPUNCH', 'REMOTE_NOT_HOLEPUNCHABLE', 'HOLEPUNCH_ABORTED', 'HOLEPUNCH_PROBE_TIMEOUT', 'HOLEPUNCH_INVALID']);
const RECENT_MS = 15 * 60_000;

// Catálogo: qué pasa, por qué (en palabras simples) y qué pedirle a TI.
const CATALOG = {
  UDP_BLOCKED: {
    severity: 'error',
    title: 'La red no deja salir el tráfico UDP',
    cause: 'Session Hub no pudo contactar a ningún nodo de la red. Suele ser una política del firewall o del proxy de la empresa, o una red de invitados, que solo permite navegar por la web.',
    fix: 'Conéctate a la VPN de la empresa o a otra red, o pide a TI que permita el tráfico descrito abajo.',
    it: 'Permitir tráfico UDP saliente desde este equipo (Session Hub usa HyperDHT/Hyperswarm, cifrado con Noise). Si prefieren acotarlo: UDP hacia los nodos de arranque indicados en los detalles.',
  },
  BOOTSTRAP_UNREACHABLE: {
    severity: 'error',
    title: 'No se alcanza el servidor de arranque del equipo',
    cause: 'El modo "private" usa un servidor de arranque propio y no responde. Puede estar apagado, o la red bloquea el acceso a su puerto UDP.',
    fix: 'Confirma que el servidor esté encendido (npm run infra) y que la dirección configurada sea la correcta.',
    it: 'Permitir tráfico UDP desde este equipo hacia los nodos de arranque indicados en los detalles (host:puerto).',
  },
  HOLEPUNCH_FAILED: {
    severity: 'error',
    title: 'Los routers no permiten la conexión directa',
    cause: 'Tu red y la de tu compañero bloquean que dos equipos se conecten directo (NAT estricto o "simétrico"). Pasa en redes corporativas, de datos móviles y en algunos routers domésticos.',
    fix: 'Usa un relay: un nodo intermedio que solo reenvía datos cifrados, sin poder leerlos. Configúralo en sessionHub.relay (se levanta con npm run infra).',
    it: 'Alternativas: (1) permitir UDP saliente sin reescritura aleatoria de puertos (NAT "endpoint-independent"), o (2) permitir UDP hacia el relay de Session Hub indicado en los detalles.',
  },
  RELAY_UNREACHABLE: {
    severity: 'error',
    title: 'El relay configurado no responde',
    cause: 'La conexión directa no fue posible y el relay tampoco se pudo usar: está apagado o la red bloquea el acceso a él.',
    fix: 'Revisa que el relay esté encendido y que la clave en sessionHub.relay sea la correcta.',
    it: 'Permitir tráfico UDP desde este equipo hacia el relay de Session Hub (ver detalles).',
  },
  STRICT_NAT: {
    severity: 'warn',
    title: 'Tu red cambia los puertos al azar (NAT estricto)',
    cause: 'Con este tipo de red, las conexiones directas con compañeros que están fuera suelen fallar.',
    fix: 'Configura un relay (sessionHub.relay) para tener respaldo.',
    it: 'Si es posible, usar NAT "endpoint-independent" para UDP en esta red.',
  },
  LAN_UNREACHABLE: {
    severity: 'warn',
    title: 'Conoces a compañeros, pero no se logra conectar en la red local',
    cause: 'O el firewall de alguno bloquea el puerto UDP de Session Hub, o no están en la misma red (por ejemplo, una persona trabaja desde casa sin VPN).',
    fix: 'Si alguien está fuera de la oficina, usen VPN o el modo "public"/"private". Si todos están en la oficina, revisen el firewall de cada equipo.',
    it: 'Permitir UDP entrante y saliente en el puerto indicado en los detalles entre los equipos de la red interna.',
  },
  PEER_NOT_FOUND: {
    severity: 'warn',
    title: 'No se encuentra a un compañero en la red',
    cause: 'Puede estar desconectado, o usar otro modo de red (lan / private / public).',
    fix: 'Confirma que tenga el editor abierto y que todos usen el mismo modo de red.',
    it: null,
  },
  MODE_MISMATCH: {
    severity: 'warn',
    title: 'Usas un modo de red distinto al de quien te invitó',
    cause: 'Para encontrarse, todos los del equipo deben usar el mismo modo de red.',
    fix: 'Cambia sessionHub.network al modo de tu equipo (ver detalles).',
    it: null,
  },
  START_FAILED: {
    severity: 'error',
    title: 'La conexión con el equipo no arrancó',
    cause: 'Hubo un error al iniciar la red de Session Hub.',
    fix: 'Revisa el detalle técnico; si el puerto UDP está ocupado, cambia sessionHub.dhtPort.',
    it: null,
  },
};

// Devuelve la lista de problemas detectados, cada uno con su explicación.
export function diagnoseNetwork(st, { now = Date.now() } = {}) {
  const issues = [];
  const add = (code, extra = {}) => issues.push({ code, ...CATALOG[code], ...extra });
  const recent = (st.connIssues || []).filter((i) => now - Date.parse(i.at) < RECENT_MS);
  const codes = new Set(recent.map((i) => i.code));

  if (st.lastError && !/tardó en responder/.test(st.lastError)) add('START_FAILED', { detail: st.lastError });
  if (st.running && st.network !== 'lan' && st.bootstrapped && st.dhtNodes === 0) add(st.network === 'private' ? 'BOOTSTRAP_UNREACHABLE' : 'UDP_BLOCKED');
  if ([...codes].some((c) => HOLEPUNCH.has(c))) {
    const who = [...new Set(recent.filter((i) => HOLEPUNCH.has(i.code)).map((i) => i.peer))];
    add('HOLEPUNCH_FAILED', { peers: who });
  }
  if (codes.has('RELAY_ABORTED')) add('RELAY_UNREACHABLE');
  if (st.nat?.randomized && !st.relay && st.network !== 'lan') add('STRICT_NAT');
  if (st.network === 'lan' && st.knownMembers > 0 && st.connected === 0 && st.dialedWithAddrs > 0) add('LAN_UNREACHABLE');
  if (codes.has('PEER_NOT_FOUND')) add('PEER_NOT_FOUND', { peers: [...new Set(recent.filter((i) => i.code === 'PEER_NOT_FOUND').map((i) => i.peer))] });
  if (st.teamNetwork && st.teamNetwork !== st.network) add('MODE_MISMATCH', { detail: `Equipo: "${st.teamNetwork}" · esta instalación: "${st.network}"` });
  return issues;
}

// Informe en texto para pegar en un chat o correo a TI o al equipo.
export function networkReport({ st, issues, me, team, version, when = new Date(), t = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m) : s) }) {
  const lines = [];
  lines.push(t('INFORME DE CONEXIÓN · SESSION HUB'));
  lines.push(t('Fecha: {v1}', { v1: when.toLocaleString() }));
  lines.push(t('Persona: {v1} · huella {v2}', { v1: `${me.name}${me.role ? ' (' + me.role + ')' : ''}`, v2: me.fingerprint }) + (team ? ` · ${t('equipo "{v1}"', { v1: team })}` : ''));
  lines.push('');
  if (!issues.length) lines.push(t('Estado: sin problemas de red detectados.'));
  for (const [i, x] of issues.entries()) {
    lines.push(`${i + 1}. ${x.severity === 'error' ? t('[ERROR]') : t('[AVISO]')} ${t(x.title)}`);
    lines.push(`   ${t('Por qué:')} ${t(x.cause)}`);
    if (x.peers?.length) lines.push(`   ${t('Con:')} ${x.peers.join(', ')}`);
    if (x.detail) lines.push(`   ${t('Detalle:')} ${t(x.detail)}`);
    lines.push(`   ${t('Qué hacer:')} ${t(x.fix)}`);
    if (x.it) lines.push(`   ${t('Para TI:')} ${t(x.it)}`);
    lines.push('');
  }
  const yes = (v) => t(v ? 'sí' : 'no');
  lines.push(t('DETALLES TÉCNICOS'));
  lines.push(`- ${t('Modo de red:')} ${st.network}${st.network === 'lan' ? ` · ${t('puerto UDP local {v1}', { v1: st.udpPort })}` : ''}`);
  if (st.network === 'private' || st.bootstrap?.length) lines.push(`- ${t('Nodos de arranque:')} ${st.bootstrap?.join(', ') || t('(ninguno configurado)')}`);
  lines.push(`- ${t('Nodos de la red alcanzados:')} ${st.dhtNodes ?? '?'}`);
  if (st.nat) lines.push(`- NAT: ${t(st.nat.firewalled ? 'detrás de firewall' : 'accesible')} · ${t('puertos aleatorios:')} ${st.nat.randomized ? t('sí (estricto)') : yes(false)}${st.nat.host ? ` · ${t('IP pública vista:')} ${st.nat.host}` : ''}`);
  lines.push(`- Relay: ${st.relay ? t('configurado ({v1})', { v1: st.relay }) : t('no configurado')}`);
  lines.push(`- ${t('Direcciones locales:')} ${st.lanAddrs?.join(', ') || t('(ninguna)')} · VPN: ${st.vpnAddrs?.join(', ') || t('(ninguna)')}`);
  lines.push(`- ${t('Compañeros conocidos: {v1} · conectados: {v2}', { v1: st.knownMembers, v2: st.connected })}`);
  const recent = (st.connIssues || []).slice(0, 8);
  if (recent.length) lines.push(`- ${t('Errores recientes:')} ${recent.map((r) => `${r.code} ${t('con')} ${r.peer} (${new Date(r.at).toLocaleTimeString()})`).join('; ')}`);
  lines.push(`- Software: Session Hub ${version} · Noise, HyperDHT/Hyperswarm · https://github.com/carlosvisbal/session-hub`);
  lines.push('');
  lines.push(t('Nota: el contenido viaja cifrado de extremo a extremo; un relay solo reenvía bytes cifrados y no puede leerlos.'));
  return lines.join('\n');
}
