// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Estado del equipo de esta instalación, guardado en disco (0600):
//   mis claves · el equipo y mi cadena · miembros conocidos · invitaciones usadas ·
//   expulsiones · mis bloqueos personales · direcciones de arranque conocidas.
import fs from 'node:fs';
import path from 'node:path';
import {
  acceptInvite,
  createInvite,
  decodeInvite,
  encodeInvite,
  fingerprint,
  foundTeam,
  generateKeyPair,
  signAdmission,
  signRevocation,
  verifyChain,
  verifyRevocation,
} from './identity.js';

const empty = () => ({ v: 2, keyPair: null, team: null, members: {}, profiles: {}, usedInvites: {}, redeemed: {}, revocations: {}, blocked: [], addrs: [], memberAddrs: {} });

export function openTeamState(file) {
  let s = empty();
  if (fs.existsSync(file)) s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  };
  if (!s.keyPair) {
    s.keyPair = generateKeyPair();
    save();
  }

  const me = () => s.keyPair.publicKey;
  const isRevoked = (pub) => !!s.revocations[pub];

  // Registra un miembro verificado (propio o recibido por chisme de otro hub).
  function remember(v, chain) {
    s.members[v.member] = chain;
    if (v.invite) s.usedInvites[v.invite.invite] = v.member;
  }

  const api = {
    get state() {
      return s;
    },
    file,
    me,
    keyPair: () => s.keyPair,
    hasTeam: () => !!s.team,
    team: () => s.team,
    myChain: () => s.team?.chain || null,

    createTeam(name) {
      const chain = foundTeam(s.keyPair, name);
      s.team = { id: me(), name, chain, joined: new Date().toISOString() };
      s.members = { [me()]: chain };
      s.usedInvites = {};
      s.redeemed = {};
      s.revocations = {};
      save();
      return s.team;
    },

    // Crea un código SH2-… para una persona. Incluye mi cadena y dónde encontrarme.
    makeInvite({ bootstrap = [], network = 'lan', hours } = {}) {
      if (!s.team) throw new Error('Primero crea un equipo o únete a uno.');
      if (s.team.pending) throw new Error('Aún no puedes invitar: quien te invitó todavía no confirmó tu admisión (debe estar conectado).');
      const { inviteKp, cert } = createInvite(s.keyPair, s.team.id, hours);
      return {
        code: encodeInvite({ team: { id: s.team.id, name: s.team.name }, invite: { secretKey: inviteKp.secretKey, publicKey: inviteKp.publicKey, cert }, chain: s.team.chain, bootstrap, network }),
        expires: cert.body.expires,
      };
    },

    join(code) {
      const inv = decodeInvite(code);
      if (!inv) throw new Error('La invitación no es válida. Pide a tu compañero que genere una nueva.');
      if (Date.parse(inv.invite.cert.body.expires) < Date.now()) throw new Error('La invitación venció. Pide una nueva.');
      const inviter = verifyChain(inv.team.id, inv.chain);
      if (!inviter.ok) throw new Error(`La invitación no es auténtica: ${inviter.error}`);
      const memberCert = acceptInvite({ publicKey: inv.invite.publicKey, secretKey: inv.invite.secretKey }, inv.invite.cert, s.keyPair);
      const chain = [...inv.chain, inv.invite.cert, memberCert];
      const v = verifyChain(inv.team.id, chain);
      if (!v.pending || v.member !== me()) throw new Error(`No se pudo crear tu certificado: ${v.error}`);
      // Queda pendiente hasta que quien me invitó confirme la admisión al verme conectado.
      s.team = { id: inv.team.id, name: inv.team.name, chain, pending: true, invitedBy: inviter.member, network: inv.network || null, joined: new Date().toISOString() };
      s.members = { [inviter.member]: inv.chain };
      s.usedInvites = {};
      s.redeemed = {};
      s.revocations = {};
      s.addrs = [...new Set([...(inv.bootstrap || []), ...s.addrs])];
      s.memberAddrs = { [inviter.member]: inv.bootstrap || [] }; // para marcarle directo al entrar
      save();
      return { team: s.team, network: inv.network, invitedBy: inviter.member };
    },

    // Salir: se borra todo lo del equipo; se conservan mi clave (mi identidad) y mis bloqueos personales.
    leave() {
      s.team = null;
      s.members = {};
      s.profiles = {};
      s.usedInvites = {};
      s.redeemed = {};
      s.revocations = {};
      s.addrs = [];
      s.memberAddrs = {};
      save();
    },

    pending: () => !!s.team?.pending,

    // ¿Se acepta a quien presenta esta cadena por una conexión autenticada con `connPub`?
    // Si la cadena está pendiente y la invitación es mía, la confirmo aquí (una sola vez).
    admit(chain, connPub) {
      if (!s.team) return { ok: false, error: 'no tengo equipo' };
      let v = verifyChain(s.team.id, chain);
      let admission = null;
      if (v.pending && connPub && v.member === connPub && v.issuer === me() && !s.team.pending) {
        const inv = v.invite;
        const redeemedBy = s.redeemed[inv.invite];
        if (redeemedBy && redeemedBy !== v.member) return { ok: false, error: 'invitación ya usada por otra persona' };
        if (!redeemedBy && Date.parse(inv.expires) < Date.now()) return { ok: false, error: 'invitación vencida' };
        s.redeemed[inv.invite] = v.member;
        admission = signAdmission(s.keyPair, inv, v.member);
        chain = [...chain, admission];
        v = verifyChain(s.team.id, chain);
      }
      if (!v.ok) return v;
      if (connPub && v.member !== connPub) return { ok: false, error: 'la clave de la conexión no es la del certificado (suplantación)' };
      if (isRevoked(v.member)) return { ok: false, error: 'expulsado del equipo' };
      if (v.ancestors.some(isRevoked)) return { ok: false, error: 'lo invitó alguien que fue expulsado' };
      if (v.invite) {
        const used = s.usedInvites[v.invite.invite];
        if (used && used !== v.member) return { ok: false, error: 'invitación ya usada por otra persona' };
      }
      remember(v, chain);
      save();
      return { ...v, ok: true, admission };
    },

    // Quien me invitó confirmó mi admisión: completo mi cadena.
    receiveAdmission(doc, fromPub) {
      if (!s.team?.pending || fromPub !== s.team.invitedBy) return false;
      const chain = [...s.team.chain, doc];
      const v = verifyChain(s.team.id, chain);
      if (!v.ok || v.member !== me()) return false;
      s.team.chain = chain;
      s.team.pending = false;
      remember(v, chain);
      save();
      return true;
    },

    // Expulsar: solo si estoy por encima de esa persona en su cadena.
    canRevoke(pub) {
      if (!s.team || pub === me() || pub === s.team.id) return false;
      const chain = s.members[pub];
      if (!chain) return false;
      if (me() === s.team.id) return true;
      const v = verifyChain(s.team.id, chain);
      return v.ok && v.ancestors.includes(me());
    },

    revoke(pub, reason) {
      if (!api.canRevoke(pub)) throw new Error('Solo puede expulsar a alguien quien lo invitó (o quien está por encima en su cadena).');
      const doc = signRevocation(s.keyPair, s.team.id, pub, reason);
      s.revocations[pub] = doc;
      save();
      return doc;
    },

    // Expulsiones recibidas de otros hubs: se aceptan solo si son válidas.
    applyRevocation(doc) {
      const target = doc?.body?.member;
      if (!s.team || !target || s.revocations[target]) return false;
      if (!verifyRevocation(s.team.id, doc, s.members[target])) return false;
      s.revocations[target] = doc;
      save();
      return true;
    },

    // Bloqueo personal: solo afecta a mi hub; el resto del equipo no se entera.
    setBlocked(pub, blocked) {
      s.blocked = blocked ? [...new Set([...s.blocked, pub])] : s.blocked.filter((x) => x !== pub);
      save();
    },
    isBlocked: (pub) => s.blocked.includes(pub),

    // Último nombre y rol conocidos de cada miembro, para mostrarlo aunque esté desconectado.
    rememberProfile(pub, profile) {
      const prev = s.profiles[pub];
      if (prev && prev.updated >= profile.updated) return;
      s.profiles[pub] = { name: profile.name, role: profile.role, updated: profile.updated };
      save();
    },
    profileOf: (pub) => s.profiles[pub] || null,
    isRevoked,

    // Direcciones "host:puerto" conocidas: en general y por miembro (para marcarle directo).
    learnAddrs(addrs = [], pub = null) {
      const valid = addrs.filter((a) => /^[\w.-]+:\d+$/.test(a)).slice(0, 8);
      const next = [...new Set([...s.addrs, ...valid])].slice(-50);
      const perChanged = pub && JSON.stringify(s.memberAddrs[pub]) !== JSON.stringify(valid);
      if (perChanged) s.memberAddrs[pub] = valid;
      if (next.length !== s.addrs.length || perChanged) {
        s.addrs = next;
        save();
      }
    },
    addrsOf: (pub) => s.memberAddrs[pub] || [],

    // Miembros conocidos, con quién invitó a quién (para el panel).
    roster() {
      if (!s.team) return [];
      return Object.entries(s.members).map(([pub, chain]) => {
        const v = verifyChain(s.team.id, chain);
        return { id: pub, fingerprint: fingerprint(pub), ...(s.profiles[pub] || {}), invitedBy: v.invitedBy, founder: pub === s.team.id, revoked: isRevoked(pub), blocked: api.isBlocked(pub), canRevoke: api.canRevoke(pub) };
      });
    },

    gossip() {
      return { members: Object.values(s.members).slice(0, 300), revocations: Object.values(s.revocations) };
    },
  };
  return api;
}
