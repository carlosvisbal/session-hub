// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Entradas hostiles de un remoto: nunca tumban el hub ni desplazan el estado de otros.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { generateKeyPair, signDoc, verifyChain } from '../src/identity.js';
import { createRpc } from '../src/transport/rpc.js';
import { createConversations } from '../src/conversations.js';
import { createInbox } from '../src/inbox.js';
import { openTeamState } from '../src/teamstate.js';

const TEAM = 'f'.repeat(64);
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-hard-')), name);

// Un canal de prueba: lo que "llega del remoto" se empuja con feed().
function channel() {
  const d = new Duplex({ read() {}, write(chunk, enc, cb) { cb(); } });
  d.on('error', () => {});
  return { stream: d, feed: (s) => d.push(Buffer.from(s)) };
}

test('RPC: null, números o listas de un remoto cierran esa conexión, no el proceso', async () => {
  for (const frame of ['null\n', '42\n', '[1,2]\n', '"x"\n']) {
    const { stream, feed } = channel();
    createRpc(stream, { onRequest: () => ({}), onMessage: () => {} });
    feed(frame);
    await new Promise((r) => setImmediate(r));
    assert.ok(stream.destroyed, `cerrado tras ${frame.trim()}`);
  }
});

test('RPC: un error al atender un mensaje cierra la conexión', async () => {
  const { stream, feed } = channel();
  createRpc(stream, { onRequest: () => ({}), onMessage: () => { throw new TypeError('boom'); } });
  feed('{"t":"hello"}\n');
  await new Promise((r) => setImmediate(r));
  assert.ok(stream.destroyed);
});

test('cadena con eslabones nulos o que no son objetos: inválida, sin lanzar', () => {
  for (const chain of [[null], [1], ['x'], [{ body: {} }, null, null]]) assert.equal(verifyChain(TEAM, chain).ok, false);
});

test('team.json se escribe de forma atómica y uno dañado no se pisa', () => {
  const file = tmp('team.json');
  const ts = openTeamState(file);
  ts.createTeam('e');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).team.name, 'e');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['team.json'], 'sin temporales sueltos');
  fs.writeFileSync(file, '{"keyPair": {"publicKey": "ab'); // cortado a mitad
  assert.throws(() => openTeamState(file), /dañado/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"keyPair": {"publicKey": "ab', 'no se sobrescribe');
});

test('bandeja: otra persona no puede reutilizar el id de un mensaje ajeno', () => {
  const mk = (name) => {
    const kp = generateKeyPair();
    const teamState = { keyPair: () => kp, me: () => kp.publicKey, team: () => ({ id: TEAM, name: 'e' }) };
    return { kp, peer: { id: kp.publicKey, name }, inbox: createInbox({ file: tmp('inbox.json'), teamState, policy: () => 'hold' }) };
  };
  const [ana, carlos, eva] = [mk('Ana'), mk('Carlos'), mk('Eva')];
  const doc = carlos.inbox.compose({ to: ana.kp.publicKey, text: 'hola' });
  ana.inbox.receive(doc, carlos.peer);
  const copy = signDoc(eva.kp, { ...doc.body, from: eva.kp.publicKey });
  assert.throws(() => ana.inbox.receive(copy, eva.peer), { code: 'invalid' });
  assert.deepEqual(ana.inbox.receive(doc, carlos.peer), { status: 'held' }, 'el reintento del dueño sigue siendo idempotente');
});

test('conversaciones: tope de invitaciones por persona y razones de fin acotadas', () => {
  const me = generateKeyPair();
  const peerKp = generateKeyPair();
  const teamState = { keyPair: () => me, me: () => me.publicKey, team: () => ({ id: TEAM, name: 'e' }) };
  const convs = createConversations({ file: tmp('conversations.json'), teamState });
  const peer = { id: peerKp.publicKey, name: 'Eva' };
  const order = (extra) => signDoc(peerKp, { kind: 'conv', v: 1, team: TEAM, from: peerKp.publicKey, to: me.publicKey, at: new Date().toISOString(), turns: 3, minutes: 5, mine: null, theirs: null, ...extra });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    assert.equal(convs.receive(order({ id, action: 'invite', text: 'hola' }), peer).status, 'invited');
  }
  assert.throws(() => convs.receive(order({ id: crypto.randomUUID(), action: 'invite', text: 'otra' }), peer), /sin responder/);
  // El otro termina una con una razón inventada: se guarda como "la terminó él".
  convs.receive(order({ id: ids[0], action: 'end', reason: '<button data-cmd="x">' }), peer);
  assert.equal(convs.get(ids[0]).endReason, 'peer');
  convs.receive(order({ id: ids[1], action: 'end', reason: 'loop' }), peer);
  assert.equal(convs.get(ids[1]).endReason, 'loop');
});
