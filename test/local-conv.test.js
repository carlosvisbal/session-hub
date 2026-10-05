// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Dos chats de esta computadora conversan solos: el mensaje va a la otra sesión y no sale a la red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair } from '../src/identity.js';
import { createConversations } from '../src/conversations.js';
import { createInbox } from '../src/inbox.js';
import { createTeam } from '../src/team.js';

function setup() {
  const kp = generateKeyPair();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-local-'));
  const teamState = {
    keyPair: () => kp,
    me: () => kp.publicKey,
    team: () => ({ id: 'ab'.repeat(32), name: 'local' }),
    isBlocked: () => false,
    roster: () => [],
    pending: () => null,
  };
  const dialed = [];
  const transport = {
    list: () => [],
    status: () => ({ running: true, network: 'lan', connected: 0 }),
    request: (...args) => {
      dialed.push(args);
      return Promise.resolve({ status: 'ok' });
    },
    send: () => {},
  };
  const inbox = createInbox({ file: path.join(dir, 'inbox.json'), teamState });
  const convs = createConversations({ file: path.join(dir, 'conversations.json'), teamState });
  const hub = { whoami: () => ({ id: kp.publicKey, name: 'Carlos', role: 'backend' }) };
  const team = createTeam({ owner: { name: 'Carlos', role: 'backend' } }, hub, transport, teamState, (s) => s, inbox, null, () => {}, convs);
  return { team, inbox, convs, dialed };
}

test('dos chats de esta computadora se pasan el mensaje y el tercero no lo ve', async () => {
  const { team, inbox, convs, dialed } = setup();
  const c = await team.startConversation({
    to: 'yo',
    text: 'Cambia el título del archivo a Hola',
    mine: 'claude:uno',
    theirs: 'claude:dos',
    turns: 1,
  });
  assert.equal(c.local, true);
  assert.equal(c.status, 'active');
  assert.equal(convs.forSession('claude:uno').id, c.id);
  assert.equal(convs.forSession('claude:dos').id, c.id);
  assert.equal(convs.forSession('claude:tres'), null);
  assert.equal(convs.forSession('cursor:otra'), null);

  const first = inbox.takeConv(c.id, 'claude:dos');
  assert.equal(first.length, 1);
  assert.equal(first[0].text, 'Cambia el título del archivo a Hola');
  assert.equal(inbox.takeConv(c.id, 'claude:uno').length, 0, 'quien acaba de hablar no recibe su propio texto');
  assert.equal(inbox.takeConv(c.id, 'claude:tres').length, 0);

  const back = await team.sendMessage({ to: 'yo', text: 'Listo: el título quedó en Hola', conversation: c.id });
  assert.equal(back.status, 'delivered');
  const forUno = inbox.takeConv(c.id, 'claude:uno');
  assert.equal(forUno.length, 1);
  assert.equal(forUno[0].text, 'Listo: el título quedó en Hola');
  assert.equal(inbox.takeConv(c.id, 'claude:dos').length, 0);

  assert.equal(convs.get(c.id).sent, 1);
  assert.equal(convs.get(c.id).received, 1);
  assert.equal(convs.get(c.id).status, 'active', 'con una vuelta de cada lado sigue abierta');
  assert.equal(dialed.length, 0, 'no se marca a nadie por la red');

  const over = await team.sendMessage({ text: 'una vuelta de más', conversation: c.id });
  assert.equal(over.status, 'ended');
  assert.equal(convs.get(c.id).status, 'ended');
  assert.equal(convs.get(c.id).endReason, 'limit');
  assert.equal(inbox.takeConv(c.id, 'claude:dos').length, 0, 'pasado el límite no se entrega');
});

test('la misma sesión dos veces no abre la conversación', async () => {
  const { team } = setup();
  await assert.rejects(
    () => team.startConversation({ to: 'yo', text: 'hola', mine: 'claude:uno', theirs: 'claude:uno' }),
    /distintas/,
  );
});
