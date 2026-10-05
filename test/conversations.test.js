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

test('cursor con cursor se ata igual que claude con cursor', () => {
  const { a, b } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'cursor:uno', theirs: 'cursor:dos', text: 'hola' });
  b.convs.receive(a.convs.inviteDoc(c), a.peer);
  b.convs.accept(c.id, 'cursor:dos');
  a.convs.receive(b.convs.controlDoc(b.convs.get(c.id), 'accept'), b.peer);
  assert.equal(a.convs.forSession('cursor:uno').id, c.id);
  assert.equal(b.convs.forSession('cursor:dos').id, c.id);
  assert.equal(a.convs.forSession('claude:otro'), null);
  assert.equal(b.convs.forSession('cursor:tres'), null);
});

test('rechaza órdenes falsificadas, ajenas o fuera de plazo', () => {
  const { a, b, tick } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'claude:c1', text: 'hola' });
  const doc = a.convs.inviteDoc(c);
  assert.throws(() => b.convs.receive({ ...doc, body: { ...doc.body, text: 'alterado' } }, a.peer), /firma/);
  assert.throws(() => b.convs.receive(doc, b.peer), /firma/, 'la conexión no es la del remitente');
  assert.throws(() => b.convs.receive(signDoc(a.kp, { ...doc.body, team: 'e'.repeat(64) }), a.peer), /no es para mí/);
  assert.throws(() => b.convs.receive(signDoc(a.kp, { ...doc.body, action: 'borrar-todo' }), a.peer), /formato/);
  tick(31 * 60_000);
  assert.throws(() => b.convs.receive(doc, a.peer), /plazo/);
  assert.throws(() => a.convs.receive(signDoc(b.kp, { ...doc.body, from: b.kp.publicKey, to: a.kp.publicKey, action: 'accept', id: 'otra', at: new Date(Date.UTC(2026, 8, 25, 10, 31)).toISOString() }), b.peer), /No conozco/);
});

test('límite de vueltas, bucles y mensajes vacíos; el reloj no la termina', () => {
  const { a, b, tick } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'claude:c1', text: 'hola', turns: 2, minutes: 5 });
  b.convs.receive(a.convs.inviteDoc(c), a.peer);
  b.convs.accept(c.id, 'cursor:a1');
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
  assert.equal(a.convs.get(c.id).status, 'active', 'pasar el tiempo no la termina');
  assert.equal(a.convs.get(c.id).expiresAt, undefined);
});

test('sin las dos sesiones no se activa, y otro chat no recibe la conversación', () => {
  const { a, b, tick } = pair();
  const c = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'claude:c1', text: 'hola' });
  tick(31 * 60_000);
  assert.equal(a.convs.get(c.id).endReason, 'unanswered');
  assert.throws(() => a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', text: 'sin sesión' }), /sesión tuya/);
  const pending = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', text: 'por la IA', confirm: true });
  assert.equal(pending.status, 'confirm');
  assert.throws(() => a.convs.confirmLocal(pending.id), /sesión tuya/);
  assert.throws(() => a.convs.confirmLocal(pending.id, 'no-es-sesion'), /sesión tuya/);
  a.convs.confirmLocal(pending.id, 'claude:c2');
  assert.equal(a.convs.get(pending.id).mine, 'claude:c2');
  assert.equal(a.convs.get(pending.id).status, 'inviting');

  const d = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'claude:c3', text: 'otra' });
  b.convs.receive(a.convs.inviteDoc(d), a.peer);
  assert.throws(() => b.convs.accept(d.id), /sesión tuya/);
  assert.throws(() => a.convs.receive(signDoc(b.kp, { kind: 'conv', v: 1, id: d.id, action: 'accept', team: TEAM, from: b.kp.publicKey, to: a.kp.publicKey, at: new Date(Date.UTC(2026, 8, 25, 10, 31)).toISOString(), turns: 6, minutes: 10, mine: null, theirs: 'claude:c3' }), b.peer), /dos sesiones/);
  assert.equal(a.convs.get(d.id).status, 'inviting', 'sin las dos sesiones sigue sin activarse');
  b.convs.accept(d.id, 'cursor:a3');
  a.convs.receive(b.convs.controlDoc(b.convs.get(d.id), 'accept'), b.peer);
  assert.equal(a.convs.get(d.id).status, 'active');
  assert.equal(a.convs.get(d.id).theirs, 'cursor:a3');
  assert.equal(a.convs.forSession('claude:c3').id, d.id);
  assert.equal(a.convs.forSession('claude:x'), null, 'otro chat no la recibe');
  assert.equal(b.convs.forSession('cursor:a3').id, d.id);
  assert.equal(b.convs.forSession('cursor:otro'), null);
  assert.throws(() => {
    const e = a.convs.create({ peer: b.kp.publicKey, peerName: 'Ana', mine: 'claude:c3', text: 'segunda' });
    b.convs.receive(a.convs.inviteDoc(e), a.peer);
    b.convs.accept(e.id, 'cursor:a9');
    a.convs.receive(b.convs.controlDoc(b.convs.get(e.id), 'accept'), b.peer);
  }, /otra conversación/);
});

test('dos sesiones de esta computadora quedan activas y el tercer chat no entra', () => {
  const { a } = pair();
  assert.throws(() => a.convs.create({ peer: a.kp.publicKey, peerName: 'Carlos', mine: 'claude:uno', theirs: 'claude:uno', text: 'hola', local: true }), /distintas/);
  assert.throws(() => a.convs.create({ peer: a.kp.publicKey, peerName: 'Carlos', mine: 'claude:uno', text: 'hola', local: true }), /dos sesiones/);
  const pending = a.convs.create({ peer: a.kp.publicKey, peerName: 'Carlos', text: 'entre las dos', confirm: true, local: true });
  assert.equal(pending.status, 'confirm');
  assert.throws(() => a.convs.confirmLocal(pending.id, 'claude:uno'), /dos sesiones/);
  const c = a.convs.confirmLocal(pending.id, 'claude:uno', 'claude:dos');
  assert.equal(c.status, 'active');
  assert.equal(c.local, true);
  assert.equal(a.convs.forSession('claude:uno').id, c.id);
  assert.equal(a.convs.forSession('claude:dos').id, c.id);
  assert.equal(a.convs.forSession('claude:tres'), null);
  assert.equal(a.convs.forSession('cursor:otra'), null);
  a.convs.noteAwaiting(c.id, 'claude:dos');
  assert.equal(a.convs.get(c.id).awaitingSession, 'claude:dos');
  assert.equal(a.convs.countSent(c.id, 'primer mensaje').ok, true);
  assert.equal(a.convs.countReceived(c.id, 'respuesta').ok, true);
  a.convs.relaxAwait(c.id);
  assert.equal(a.convs.get(c.id).awaiting, false);
  assert.throws(() => a.convs.create({ peer: a.kp.publicKey, peerName: 'Carlos', mine: 'claude:uno', theirs: 'cursor:x', text: 'otra', local: true }), /otra conversación/);
  assert.throws(() => a.convs.create({ peer: a.kp.publicKey, peerName: 'Carlos', mine: 'cursor:y', theirs: 'claude:dos', text: 'otra', local: true }), /otra conversación/);
});
