// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PUBLIC_RELAY, effectiveRelay, explicitRelay, loadHostedRelayKey, secureKeyFile } from '../src/default-relay.js';

test('en public sin clave propia se usa el relay incluido', () => {
  assert.equal(explicitRelay({ relay: '' }), '');
  assert.equal(explicitRelay({ relay: 'no-es-una-clave' }), '');
  assert.deepEqual(effectiveRelay({ network: 'public', relay: '' }), { key: DEFAULT_PUBLIC_RELAY, builtin: true });
  assert.deepEqual(effectiveRelay({ network: 'lan', relay: '' }), { key: '', builtin: false });
  assert.deepEqual(effectiveRelay({ network: 'private', relay: '' }), { key: '', builtin: false });
});

test('una clave propia gana al relay incluido', () => {
  const own = 'ab'.repeat(32);
  assert.deepEqual(effectiveRelay({ network: 'public', relay: own.toUpperCase() }), { key: own, builtin: false });
});

test('una clave que otros pueden leer se cierra; si no se puede, no se usa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-relay-'));
  fs.chmodSync(dir, 0o755);
  const file = path.join(dir, 'k.json');
  fs.writeFileSync(file, JSON.stringify({ publicKey: 'aa'.repeat(32), secretKey: 'bb'.repeat(64) }), { mode: 0o644 });
  const kp = secureKeyFile(file);
  assert.equal(kp.publicKey, 'aa'.repeat(32));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('solo hospeda quien tiene la clave privada que corresponde', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-relay-'));
  const file = path.join(dir, 'k.json');
  assert.equal(loadHostedRelayKey(file), null);
  fs.writeFileSync(file, JSON.stringify({ publicKey: 'aa'.repeat(32), secretKey: 'bb'.repeat(64) }));
  assert.equal(loadHostedRelayKey(file), null, 'otra clave pública no hospeda el relay incluido');
  const secret = 'cc'.repeat(64);
  fs.writeFileSync(file, JSON.stringify({ publicKey: DEFAULT_PUBLIC_RELAY, secretKey: secret }));
  assert.deepEqual(loadHostedRelayKey(file), { publicKey: DEFAULT_PUBLIC_RELAY, secretKey: secret });
  fs.rmSync(dir, { recursive: true, force: true });
});
