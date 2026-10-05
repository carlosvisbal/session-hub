// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, signDoc, verifyDoc } from '../src/identity.js';
import { openTeamState } from '../src/teamstate.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-'));
let n = 0;
const state = (name) => openTeamState(path.join(tmp, `${name}-${n++}.json`));

// Unirse = pegar el código + que quien invitó confirme al verte conectado.
function joinVia(inviter, joiner, code = inviter.makeInvite().code) {
  joiner.join(code);
  const r = inviter.admit(joiner.myChain(), joiner.me());
  if (r.admission) joiner.receiveAdmission(r.admission, inviter.me());
  return r;
}

// Carlos funda; Ana entra invitada por Carlos; Pedro entra invitado por Ana.
function team() {
  const carlos = state('carlos'), ana = state('ana'), pedro = state('pedro');
  carlos.createTeam('desarrollo');
  joinVia(carlos, ana);
  joinVia(ana, pedro);
  return { carlos, ana, pedro };
}

test('firma y verificación', () => {
  const kp = generateKeyPair();
  const doc = signDoc(kp, { a: 1, b: { c: [2, 3] } });
  assert.ok(verifyDoc(kp.publicKey, doc));
  assert.ok(verifyDoc(kp.publicKey, { body: { b: { c: [2, 3] }, a: 1 }, sig: doc.sig }), 'el orden de las claves no importa');
  assert.ok(!verifyDoc(kp.publicKey, { ...doc, body: { ...doc.body, a: 2 } }), 'contenido alterado');
  assert.ok(!verifyDoc(generateKeyPair().publicKey, doc), 'otra clave');
});

test('cualquier miembro invita y queda registrado quién', () => {
  const { carlos, ana, pedro } = team();
  assert.ok(!pedro.pending(), 'Pedro quedó admitido');
  const v = carlos.admit(pedro.myChain(), pedro.me());
  assert.ok(v.ok, v.error);
  assert.equal(v.invitedBy, ana.me());
  assert.deepEqual(v.ancestors, [carlos.me(), ana.me()]);
});

test('pendiente: solo quien emitió la invitación puede admitir', () => {
  const carlos = state('c'); carlos.createTeam('desarrollo');
  const ana = state('a'); joinVia(carlos, ana);
  const pedro = state('p');
  pedro.join(ana.makeInvite().code); // invitado por Ana, aún sin admisión
  const r = carlos.admit(pedro.myChain(), pedro.me());
  assert.equal(r.ok, false);
  assert.ok(r.pending, 'Carlos no puede admitir una invitación de Ana');
  assert.throws(() => pedro.makeInvite(), /Aún no puedes invitar/);
});

test('suplantación: cadena ajena presentada con otra clave', () => {
  const { carlos, ana } = team();
  const r = carlos.admit(ana.myChain(), generateKeyPair().publicKey);
  assert.equal(r.ok, false);
  assert.match(r.error, /suplantación/);
});

test('certificado inventado o alterado', () => {
  const { carlos, ana } = team();
  const chain = structuredClone(ana.myChain());
  chain[2].body.member = generateKeyPair().publicKey;
  assert.equal(carlos.admit(chain).ok, false);
  const mallory = state('mallory');
  mallory.createTeam('desarrollo'); // su propio "equipo" con el mismo nombre
  assert.match(carlos.admit(mallory.myChain(), mallory.me()).error, /fundador/);
});

test('invitación filtrada: la segunda persona no entra, llegue a quien llegue primero', () => {
  const carlos = state('c'); carlos.createTeam('desarrollo');
  const ana = state('a'); joinVia(carlos, ana);
  const code = ana.makeInvite().code;
  const pedro = state('p'), mallory = state('m');
  pedro.join(code);
  mallory.join(code);
  // Mallory llega primero... pero solo a Carlos, que no puede admitir invitaciones de Ana
  assert.ok(carlos.admit(mallory.myChain(), mallory.me()).pending);
  // Ana admite a quien vea primero (Pedro); después Mallory queda fuera en todas partes
  assert.ok(ana.admit(pedro.myChain(), pedro.me()).admission);
  assert.match(ana.admit(mallory.myChain(), mallory.me()).error, /ya usada/);
});

test('invitación vencida: la rechaza quien la emitió, con su propio reloj', () => {
  const carlos = state('c'); carlos.createTeam('desarrollo');
  const pedro = state('p');
  pedro.join(carlos.makeInvite({ hours: 1 }).code);
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600e3;
  try {
    assert.match(carlos.admit(pedro.myChain(), pedro.me()).error, /vencida/);
  } finally {
    Date.now = realNow;
  }
});

test('expulsión: solo quien está por encima en la cadena', () => {
  const { carlos, ana, pedro } = team();
  for (const s of [carlos, ana, pedro]) for (const o of [carlos, ana, pedro]) s.admit(o.myChain(), o.me());
  assert.ok(!pedro.canRevoke(ana.me()), 'Pedro no puede expulsar a quien lo invitó');
  assert.ok(ana.canRevoke(pedro.me()), 'Ana sí a Pedro');
  assert.ok(carlos.canRevoke(pedro.me()), 'el fundador a cualquiera');
  assert.throws(() => pedro.revoke(ana.me()));
  const doc = ana.revoke(pedro.me(), 'salió del proyecto');
  assert.ok(carlos.applyRevocation(doc), 'Carlos acepta la expulsión firmada por Ana');
  assert.match(carlos.admit(pedro.myChain(), pedro.me()).error, /expulsado/);
  const fake = structuredClone(doc); fake.body.member = ana.me();
  assert.ok(!pedro.applyRevocation(fake), 'una expulsión falsificada no se acepta');
});

test('si expulsan a quien invitó, sus invitados también quedan fuera', () => {
  const { carlos, ana, pedro } = team();
  carlos.admit(ana.myChain(), ana.me());
  carlos.admit(pedro.myChain(), pedro.me());
  carlos.revoke(ana.me());
  assert.match(carlos.admit(pedro.myChain(), pedro.me()).error, /invitó alguien que fue expulsado/);
});

test('bloqueo personal no afecta al resto', () => {
  const { carlos, ana, pedro } = team();
  carlos.setBlocked(ana.me(), true);
  assert.ok(carlos.isBlocked(ana.me()));
  assert.ok(!pedro.isBlocked(ana.me()));
  assert.ok(pedro.admit(ana.myChain(), ana.me()).ok);
});

test('la invitación manipulada se rechaza al unirse', () => {
  const carlos = state('c'); carlos.createTeam('desarrollo');
  const { code } = carlos.makeInvite();
  const data = JSON.parse(Buffer.from(code.slice(4), 'base64url'));
  data.chain[0].body.teamName = 'otro';
  const bad = 'SH2-' + Buffer.from(JSON.stringify(data)).toString('base64url');
  assert.throws(() => state('x').join(bad), /no es auténtica/);
});

test('salir y entrar a otro equipo: misma identidad, nada del equipo anterior', () => {
  const { carlos, ana } = team();
  const huella = ana.me();
  ana.leave();
  assert.equal(ana.hasTeam(), false);
  assert.deepEqual(ana.roster(), []);
  const otro = state('otro'); otro.createTeam('otro-equipo');
  joinVia(otro, ana);
  assert.equal(ana.me(), huella, 'conserva su clave');
  assert.equal(ana.team().name, 'otro-equipo');
  assert.ok(!ana.roster().some((m) => m.id === carlos.me()), 'ya no conoce a los del equipo anterior');
  assert.equal(carlos.admit(ana.myChain(), ana.me()).ok, false, 'el equipo anterior ya no la acepta con la cadena nueva');
});

test('fuera del equipo (isCutOff): el expulsado, sus invitados y yo si me expulsan', () => {
  const { carlos, ana, pedro } = team();
  for (const s of [carlos, ana, pedro]) for (const o of [carlos, ana, pedro]) s.admit(o.myChain(), o.me());
  assert.ok(!carlos.isCutOff(pedro.me()));
  const doc = carlos.revoke(ana.me());
  assert.ok(carlos.isCutOff(ana.me()), 'la expulsada');
  assert.ok(carlos.isCutOff(pedro.me()), 'a quien ella invitó');
  assert.ok(!carlos.isCutOff(carlos.me()));
  assert.ok(pedro.applyRevocation(doc));
  assert.ok(pedro.isCutOff(pedro.me()), 'Pedro sabe que quedó fuera');
});

test('salida: aviso firmado por quien se va, se acepta una vez y viaja por chisme', () => {
  const { carlos, ana, pedro } = team();
  for (const s of [carlos, ana, pedro]) for (const o of [carlos, ana, pedro]) s.admit(o.myChain(), o.me());
  const doc = pedro.departure();
  assert.ok(carlos.applyDeparture(doc));
  assert.ok(carlos.hasLeft(pedro.me()));
  assert.ok(!carlos.applyDeparture(doc), 'la segunda vez no cuenta');
  assert.ok(!carlos.isCutOff(pedro.me()), 'salir no es una expulsión');
  assert.ok(carlos.gossip().departures.length === 1);
  assert.ok(ana.applyDeparture(carlos.gossip().departures[0]), 'llega a quien no estaba conectado');

  const fake = structuredClone(doc); fake.body.member = ana.me();
  assert.ok(!carlos.applyDeparture(fake), 'nadie puede anunciar la salida de otro');
  const otro = state('otro'); otro.createTeam('otro');
  assert.ok(!otro.applyDeparture(doc), 'de otro equipo: no aplica');
  assert.ok(!pedro.applyDeparture(doc), 'mi propio aviso no me afecta');
});

test('salida: si vuelve a entrar con otra invitación, el aviso viejo ya no cuenta', async () => {
  const { carlos, ana, pedro } = team();
  carlos.admit(pedro.myChain(), pedro.me());
  const doc = pedro.departure();
  pedro.leave();
  assert.ok(carlos.applyDeparture(doc));
  await new Promise((r) => setTimeout(r, 5)); // otra marca de tiempo
  joinVia(carlos, pedro);
  carlos.admit(pedro.myChain(), pedro.me());
  assert.ok(!carlos.hasLeft(pedro.me()), 'volvió');
  assert.ok(ana.applyDeparture(doc), 'Ana solo conoce la cadena vieja: para ella salió');
  ana.admit(pedro.myChain(), pedro.me());
  assert.equal(ana.hasLeft(pedro.me()), false, 'al conocer la cadena nueva, ya no');
});
