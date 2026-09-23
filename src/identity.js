// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Identidad y pertenencia al equipo. Código puro: solo criptografía de Node, sin red ni disco.
//
// - Cada instalación tiene un par de claves Ed25519. Su identidad ES su clave pública.
// - El equipo se identifica con la clave pública de quien lo fundó.
// - Pertenecer al equipo = tener una cadena de certificados que empieza en el fundador.
//   Por cada invitación hay tres eslabones:
//
//     invitación  (la firma quien invita)
//     miembro     (lo firma el invitado con la clave de un solo uso de la invitación)
//     admisión    (la firma quien invitó, UNA sola vez, al ver al invitado por primera vez)
//
//   La admisión hace que una invitación filtrada no sirva a una segunda persona: solo su
//   emisor puede confirmarla y lo hace una vez, con su propio reloj (no se puede falsear la fecha).
//   Cualquier miembro puede invitar; solo quien está por encima de alguien en su cadena puede expulsarlo.
import crypto from 'node:crypto';
import DHT from 'hyperdht';

export const MAX_CHAIN = 49; // fundador + 16 invitaciones encadenadas (3 eslabones cada una)
export const INVITE_HOURS = 48;

export const toHex = (b) => Buffer.from(b).toString('hex');
export const fingerprint = (pub) => pub.slice(0, 12).toUpperCase().match(/.{4}/g).join('-');

// Formato sodium de HyperDHT: secretKey = semilla (32 bytes) + pública (32 bytes).
export function generateKeyPair() {
  const kp = DHT.keyPair();
  return { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.secretKey) };
}

export const keyPairBuffers = (kp) => ({ publicKey: Buffer.from(kp.publicKey, 'hex'), secretKey: Buffer.from(kp.secretKey, 'hex') });

const privateKey = (kp) =>
  crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(kp.secretKey, 'hex').subarray(0, 32).toString('base64url'), x: Buffer.from(kp.publicKey, 'hex').toString('base64url') },
    format: 'jwk',
  });

const publicKey = (pub) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub, 'hex').toString('base64url') }, format: 'jwk' });

// JSON canónico (claves ordenadas en todos los niveles): lo firmado no depende del orden.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function signDoc(kp, body) {
  return { body, sig: crypto.sign(null, Buffer.from(canonical(body)), privateKey(kp)).toString('base64url') };
}

export function verifyDoc(pub, doc) {
  try {
    return typeof pub === 'string' && /^[0-9a-f]{64}$/.test(pub) && crypto.verify(null, Buffer.from(canonical(doc.body)), publicKey(pub), Buffer.from(doc.sig, 'base64url'));
  } catch {
    return false;
  }
}

const now = () => new Date().toISOString();

// ---------- certificados ----------

export function foundTeam(kp, teamName) {
  return [signDoc(kp, { type: 'member', team: kp.publicKey, member: kp.publicKey, via: null, teamName, issued: now() })];
}

// Invitación de un solo uso: una clave nueva que el invitado usará para firmar su certificado.
export function createInvite(memberKp, teamId, hours = INVITE_HOURS) {
  const inviteKp = generateKeyPair();
  const cert = signDoc(memberKp, {
    type: 'invite',
    team: teamId,
    issuer: memberKp.publicKey,
    invite: inviteKp.publicKey,
    expires: new Date(Date.now() + hours * 3600e3).toISOString(),
    issued: now(),
  });
  return { inviteKp, cert };
}

export function acceptInvite(inviteKp, inviteCert, myKp) {
  return signDoc(inviteKp, { type: 'member', team: inviteCert.body.team, member: myKp.publicKey, via: inviteCert.body.invite, issued: now() });
}

// La firma quien emitió la invitación, una sola vez, dentro de su vigencia.
export const signAdmission = (issuerKp, inviteBody, member) =>
  signDoc(issuerKp, { type: 'admit', team: inviteBody.team, invite: inviteBody.invite, member, at: now() });

// Verifica la cadena completa. Si solo falta la admisión del último eslabón, devuelve
// { ok: false, pending: true } con quién debe confirmarla.
export function verifyChain(teamId, chain) {
  if (!Array.isArray(chain) || !chain.length || chain.length > MAX_CHAIN) return { ok: false, error: 'cadena de certificados con forma inválida' };
  const [root, ...rest] = chain;
  const r = root.body || {};
  if (r.type !== 'member' || r.team !== teamId || r.member !== teamId || r.via !== null || !verifyDoc(teamId, root)) return { ok: false, error: 'la cadena no empieza en el fundador de este equipo' };
  if (rest.length % 3 === 1) return { ok: false, error: 'cadena de certificados incompleta' };

  const ancestors = [];
  let prev = teamId;
  let lastInvite = null;
  for (let i = 0; i < rest.length; i += 3) {
    const inv = rest[i].body || {};
    const mem = rest[i + 1].body || {};
    if (inv.type !== 'invite' || inv.team !== teamId || inv.issuer !== prev || !verifyDoc(prev, rest[i])) return { ok: false, error: 'invitación no firmada por un miembro del equipo' };
    if (mem.type !== 'member' || mem.team !== teamId || mem.via !== inv.invite || !verifyDoc(inv.invite, rest[i + 1])) return { ok: false, error: 'certificado de miembro no firmado con su invitación' };
    const adm = rest[i + 2];
    if (!adm) {
      if (i + 2 < rest.length - 1) return { ok: false, error: 'falta una admisión en medio de la cadena' };
      return { ok: false, pending: true, member: mem.member, issuer: inv.issuer, invite: inv, ancestors: [...ancestors, prev], error: 'pendiente: su invitación aún no la confirmó quien la emitió' };
    }
    const a = adm.body || {};
    if (a.type !== 'admit' || a.team !== teamId || a.invite !== inv.invite || a.member !== mem.member || !verifyDoc(inv.issuer, adm)) return { ok: false, error: 'admisión no firmada por quien emitió la invitación' };
    ancestors.push(prev);
    prev = mem.member;
    lastInvite = inv;
  }
  return { ok: true, member: prev, ancestors, invitedBy: ancestors.at(-1) || null, invite: lastInvite, teamName: r.teamName };
}

// ---------- perfil y revocación ----------

// Nombre y rol visibles. Los firma la propia persona: cambiar de nombre no requiere otro certificado.
export const signProfile = (kp, { name, role }) => signDoc(kp, { type: 'profile', member: kp.publicKey, name: String(name || '').slice(0, 60), role: String(role || '').slice(0, 40), updated: now() });

export function verifyProfile(pub, doc) {
  return doc?.body?.type === 'profile' && doc.body.member === pub && verifyDoc(pub, doc) ? doc.body : null;
}

export const signRevocation = (kp, teamId, member, reason = '') => signDoc(kp, { type: 'revoke', team: teamId, member, by: kp.publicKey, reason: String(reason).slice(0, 200), at: now() });

// Válida si la firma quien está por encima del expulsado en su cadena (o el fundador).
export function verifyRevocation(teamId, doc, targetChain) {
  const b = doc?.body || {};
  if (b.type !== 'revoke' || b.team !== teamId || !verifyDoc(b.by, doc)) return false;
  if (b.by === teamId && b.member !== teamId) return true;
  const v = verifyChain(teamId, targetChain);
  return v.ok && v.member === b.member && v.ancestors.includes(b.by);
}

// ---------- código de invitación ----------

export const INVITE_PREFIX = 'SH2-';

export function encodeInvite(data) {
  return INVITE_PREFIX + Buffer.from(JSON.stringify({ v: 2, ...data })).toString('base64url');
}

export function decodeInvite(text) {
  const code = (String(text).match(/SH2-[A-Za-z0-9_-]+/) || [])[0];
  if (!code) return null;
  try {
    const d = JSON.parse(Buffer.from(code.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
    if (d.v !== 2 || !d.team?.id || !d.invite?.secretKey || !d.invite?.cert || !Array.isArray(d.chain)) return null;
    return d;
  } catch {
    return null;
  }
}
