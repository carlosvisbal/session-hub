// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, signDoc } from '../src/identity.js';
import { createInbox, MAX_TEXT, RATE } from '../src/inbox.js';

const TEAM = 'f'.repeat(64);

// Dos personas del mismo equipo, cada una con su bandeja.
function pair({ policy = 'hold' } = {}) {
  const mk = (name, pol) => {
    const kp = generateKeyPair();
    const teamState = { keyPair: () => kp, me: () => kp.publicKey, team: () => ({ id: TEAM, name: 'e2e' }) };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shub-inbox-')), 'inbox.json');
    return { name, kp, file, peer: { id: kp.publicKey, name, role: 'dev' }, inbox: createInbox({ file, teamState, policy: () => pol }) };
  };
  return { carlos: mk('Carlos', 'hold'), ana: mk('Ana', policy) };
}

test('mensaje firmado: llega retenido y se entrega a la IA solo al aprobarlo', () => {
  const { carlos, ana } = pair();
  const doc = carlos.inbox.compose({ to: ana.kp.publicKey, text: 'Cambié /api/contacts: attachments ahora es lista', aboutSession: 'claude:s1' });
  carlos.inbox.recordSent(doc, 'Ana');
  assert.deepEqual(ana.inbox.receive(doc, carlos.peer), { status: 'held' });
  assert.equal(ana.inbox.takeForAi().messages.length, 0, 'retenido: la IA no lo ve');
  assert.equal(ana.inbox.list().held, 1);
  ana.inbox.setStatus(doc.body.id, 'delivered');
  const r = ana.inbox.takeForAi();
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].aboutSession, 'claude:s1');
  assert.equal(ana.inbox.takeForAi().messages.length, 0, 'leído una sola vez');
  assert.ok(carlos.inbox.receipt(ana.kp.publicKey, doc.body.id, 'read'));
  assert.equal(carlos.inbox.list().sent[0].status, 'read');
  assert.ok(!carlos.inbox.receipt(carlos.kp.publicKey, doc.body.id, 'read'), 'solo el destinatario puede acusar recibo');
});

test('política accept y refuse', () => {
  const a = pair({ policy: 'accept' });
  assert.equal(a.ana.inbox.receive(a.carlos.inbox.compose({ to: a.ana.kp.publicKey, text: 'hola' }), a.carlos.peer).status, 'delivered');
  const r = pair({ policy: 'refuse' });
  assert.throws(() => r.ana.inbox.receive(r.carlos.inbox.compose({ to: r.ana.kp.publicKey, text: 'hola' }), r.carlos.peer), { code: 'refused' });
});

test('se rechaza lo falsificado, ajeno o fuera de plazo', () => {
  const { carlos, ana } = pair();
  const doc = carlos.inbox.compose({ to: ana.kp.publicKey, text: 'original' });
  const tampered = { ...doc, body: { ...doc.body, text: 'alterado' } };
  assert.throws(() => ana.inbox.receive(tampered, carlos.peer), /firma/);
  assert.throws(() => ana.inbox.receive(doc, ana.peer), /firma/, 'la conexión no es la del remitente');
  const other = carlos.inbox.compose({ to: carlos.kp.publicKey, text: 'para otro' });
  assert.throws(() => ana.inbox.receive(other, carlos.peer), /no es para mí/);
  const old = signDoc(carlos.kp, { ...doc.body, id: 'x', at: new Date(Date.now() - 3 * 86400e3).toISOString() });
  assert.throws(() => ana.inbox.receive(old, carlos.peer), /plazo/);
  const foreign = signDoc(carlos.kp, { ...doc.body, id: 'y', team: 'e'.repeat(64) });
  assert.throws(() => ana.inbox.receive(foreign, carlos.peer), /no es para mí/);
  assert.throws(() => carlos.inbox.compose({ to: ana.kp.publicKey, text: 'x'.repeat(MAX_TEXT + 1) }), /demasiado largo/);
  assert.throws(() => carlos.inbox.compose({ to: ana.kp.publicKey, text: '   ' }), /vacío/);
});

test('reintentos idempotentes y límite de frecuencia', () => {
  const { carlos, ana } = pair();
  const doc = carlos.inbox.compose({ to: ana.kp.publicKey, text: 'uno' });
  ana.inbox.receive(doc, carlos.peer);
  ana.inbox.receive(doc, carlos.peer);
  assert.equal(ana.inbox.list().received.length, 1, 'el mismo mensaje no se duplica');
  for (let i = 1; i < RATE.max; i++) ana.inbox.receive(carlos.inbox.compose({ to: ana.kp.publicKey, text: `m${i}` }), carlos.peer);
  assert.throws(() => ana.inbox.receive(carlos.inbox.compose({ to: ana.kp.publicKey, text: 'uno de más' }), carlos.peer), { code: 'rate' });
});

test('cola para desconectados y persistencia en disco (0600)', () => {
  const { carlos, ana } = pair();
  const doc = carlos.inbox.compose({ to: ana.kp.publicKey, text: 'cuando vuelvas' });
  carlos.inbox.recordSent(doc, 'Ana');
  assert.equal(carlos.inbox.queuedFor(ana.kp.publicKey).length, 1);
  carlos.inbox.markSent(doc.body.id, 'held');
  assert.equal(carlos.inbox.queuedFor(ana.kp.publicKey).length, 0);
  ana.inbox.receive(doc, carlos.peer);
  const saved = JSON.parse(fs.readFileSync(ana.file, 'utf8'));
  assert.equal(saved.received[0].text, 'cuando vuelvas');
  if (process.platform !== 'win32') assert.equal(fs.statSync(ana.file).mode & 0o777, 0o600);
});
