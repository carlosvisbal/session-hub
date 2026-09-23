// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseNetwork, networkReport } from '../src/netdiag.js';

const base = { running: true, network: 'public', bootstrapped: true, dhtNodes: 40, connected: 1, knownMembers: 1, connIssues: [], nat: { firewalled: true, randomized: false } };
const codes = (st) => diagnoseNetwork({ ...base, ...st }).map((i) => i.code);
const now = new Date().toISOString();

test('red sana: sin problemas', () => assert.deepEqual(codes({}), []));
test('UDP bloqueado por la red', () => assert.deepEqual(codes({ dhtNodes: 0 }), ['UDP_BLOCKED']));
test('arranque propio inalcanzable', () => assert.deepEqual(codes({ network: 'private', dhtNodes: 0 }), ['BOOTSTRAP_UNREACHABLE']));
test('NAT que impide la conexión directa', () => assert.ok(codes({ connIssues: [{ at: now, peer: 'Ana', code: 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS' }] }).includes('HOLEPUNCH_FAILED')));
test('NAT estricto sin relay', () => assert.deepEqual(codes({ nat: { randomized: true } }), ['STRICT_NAT']));
test('con relay configurado no se advierte el NAT estricto', () => assert.deepEqual(codes({ nat: { randomized: true }, relay: 'ABCD' }), []));
test('relay caído', () => assert.ok(codes({ connIssues: [{ at: now, peer: 'Ana', code: 'RELAY_ABORTED' }] }).includes('RELAY_UNREACHABLE')));
test('red local sin conexión con quien se conoce', () => assert.deepEqual(codes({ network: 'lan', connected: 0, dialedWithAddrs: 1 }), ['LAN_UNREACHABLE']));
test('modo de red distinto al del equipo', () => assert.deepEqual(codes({ teamNetwork: 'lan' }), ['MODE_MISMATCH']));
test('errores viejos no cuentan', () => assert.deepEqual(codes({ connIssues: [{ at: '2020-01-01T00:00:00Z', peer: 'Ana', code: 'CANNOT_HOLEPUNCH' }] }), []));

test('el informe explica qué, por qué y qué pedir a TI', () => {
  const st = { ...base, dhtNodes: 0 };
  const text = networkReport({ st, issues: diagnoseNetwork(st), me: { name: 'Ana', fingerprint: 'AAAA-BBBB-CCCC' }, team: 'dev', version: '0.7.0' });
  for (const s of ['INFORME DE CONEXIÓN', 'Por qué:', 'Para TI:', 'UDP', 'DETALLES TÉCNICOS']) assert.ok(text.includes(s), s);
});
