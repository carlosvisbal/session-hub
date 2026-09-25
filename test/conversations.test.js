// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, signDoc } from '../src/identity.js';
import { createConversations } from '../src/conversations.js';

const TEAM = 'f'.repeat(64);
function pair() {
  let clock = Date.UTC(2026, 8, 25, 10, 0);
  const now = () => clock;
  const mk = (name) => {
    const kp = generateKeyPair();
    const teamState = { keyPair: () => kp, me: () => kp.publicKey, team: () => ({ id: TEAM, name: 'e2e' }) };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-conv-')), 'conversations.json');
    return { name, kp, peer: { id: kp.publicKey, name }, convs: createConversations({ file, teamState, now }), file };
  };
  return { a: mk('Carlos'), b: mk('Ana'), tick: (ms) => (clock += ms) };
}

test('invitar → aceptar → activa en los dos lados (y solo con consentimiento)', () => {
  const { a, b } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'claude:c1', theirs: 'cursor:a1', text: '¿Cómo envías el formulario?', turns: 3 });
  assert.equal(c.status, 'inviting');
  assert.deepEqual(b.convs.receive(a.convs.inviteDoc(c), a.peer), { status: 'invited' });
  const inv = b.convs.get(c.id);
  assert.equal(inv.mine, 'cursor:a1', 'la sesión que pidió queda como la mía');
  assert.equal(inv.theirs, 'claude:c1');
  assert.equal(b.convs.forSession('cursor:a1'), null, 'invitada no es activa: nada llega sola');
  b.convs.accept(c.id, 'cursor:a1');
  a.convs.receive(b.convs.controlDoc(b.convs.get(c.id), 'accept'), b.peer);
  assert.equal(a.convs.get(c.id).status, 'active');
  assert.equal(a.convs.forSession('claude:c1').id, c.id);
  assert.equal(b.convs.activeWith(a.kp.publicKey).id, c.id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
});

test('rechaza órdenes falsificadas, ajenas o fuera de plazo', () => {
  const { a, b, tick } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', text: 'hola' });
  const doc = a.convs.inviteDoc(c);
  assert.throws(() => b.convs.receive({ ...doc, body: { ...doc.body, text: 'alterado' } }, a.peer), /firma/);
  assert.throws(() => b.convs.receive(doc, b.peer), /firma/, 'la conexión no es la del remitente');
  assert.throws(() => b.convs.receive(signDoc(a.kp, { ...doc.body, team: 'e'.repeat(64) }), a.peer), /no es para mí/);
  assert.throws(() => b.convs.receive(signDoc(a.kp, { ...doc.body, action: 'borrar-todo' }), a.peer), /formato/);
  tick(31 * 60_000);
  assert.throws(() => b.convs.receive(doc, a.peer), /plazo/);
  assert.throws(() => a.convs.receive(signDoc(b.kp, { ...doc.body, from: b.kp.publicKey, to: a.kp.publicKey, action: 'accept', id: 'otra', at: new Date(Date.UTC(2026, 8, 25, 10, 31)).toISOString() }), b.peer), /No conozco/);
});

test('límite de vueltas, bucles, mensajes vacíos y tiempo', () => {
  const { a, b, tick } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'claude:c1', text: 'hola', turns: 2, minutes: 5 });
  b.convs.receive(a.convs.inviteDoc(c), a.peer);
  b.convs.accept(c.id);
  a.convs.receive(b.convs.controlDoc(b.convs.get(c.id), 'accept'), b.peer);
  assert.deepEqual(a.convs.countSent(c.id, 'uno'), { ok: true, turn: 1, of: 2 });
  assert.equal(a.convs.get(c.id).awaiting, true, 'queda esperando respuesta');
  assert.equal(a.convs.countReceived(c.id, 'respuesta').ok, true);
  assert.equal(a.convs.get(c.id).awaiting, false);
  assert.deepEqual(a.convs.countSent(c.id, '  UNO '), { ok: false, reason: 'loop' }, 'el mismo mensaje otra vez = bucle');
  assert.deepEqual(a.convs.countSent(c.id, ' '), { ok: false, reason: 'empty' });
  assert.equal(a.convs.countSent(c.id, 'dos').ok, true);
  assert.deepEqual(a.convs.countSent(c.id, 'tres'), { ok: false, reason: 'limit' });
  tick(6 * 60_000);
  assert.equal(a.convs.get(c.id).status, 'ended');
  assert.equal(a.convs.get(c.id).endReason, 'time');
});

test('invitación sin respuesta vence; la sesión se enlaza a la primera que termina un turno', () => {
  const { a, b, tick } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', text: 'hola' });
  tick(31 * 60_000);
  assert.equal(a.convs.get(c.id).endReason, 'unanswered');
  const d = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', text: 'otra' }); // sin sesión elegida
  b.convs.receive(a.convs.inviteDoc(d), a.peer);
  b.convs.accept(d.id);
  a.convs.receive(b.convs.controlDoc(b.convs.get(d.id), 'accept'), b.peer);
  assert.equal(a.convs.forSession('claude:x').id, d.id, 'la primera sesión que termina un turno queda enlazada');
  assert.equal(a.convs.forSession('claude:y'), null, 'otra sesión ya no');
  assert.equal(a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', text: 'x', confirm: true }).status, 'confirm', 'pedida por la IA: espera confirmación');
});
