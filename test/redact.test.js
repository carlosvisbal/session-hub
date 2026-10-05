// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.js';

test('oculta credenciales conocidas', () => {
  const cases = {
    'DATABASE_URL=postgres://admin:SuperClave123@db:5432/x': 'postgres://admin:[REDACTED]@db',
    'export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234': 'OPENAI_API_KEY=[REDACTED]',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu': 'Bearer [REDACTED]',
    '"password": "hunter22"': '"password": "[REDACTED]"',
    'token ghp_1234567890abcdefghijABCDEFGHIJ12': '[REDACTED]',
    'KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----': '[REDACTED]',
  };
  for (const [input, expected] of Object.entries(cases)) assert.ok(redact(input).includes(expected), `${input} → ${redact(input)}`);
});

test('no toca prosa normal', () => {
  for (const t of ['texto sin secretos: token de sesión expira', 'el token: se renueva', 'la contraseña debe tener 8 caracteres']) assert.equal(redact(t), t);
});

// Cada caso: texto → lo que debe quedar y lo que nunca debe sobrevivir.
test('tabla de credenciales: proveedores, bloques y URLs', () => {
  const cases = [
    ['STRIPE=sk_live_51HabcDEF1234567890xyz', 'sk_live_51HabcDEF1234567890xyz'],
    ['rk_live_51HabcDEF1234567890xyz en el panel', 'rk_live_51HabcDEF1234567890xyz'],
    ['prueba con ' + ['sk_test_', '4eC39HqLyjWDarjtT1zdp7dc'].join(''), ['sk_test_', '4eC39HqLyjWDarjtT1zdp7dc'].join('')],
    ['STRIPE_KEY=abcd1234efgh', 'abcd1234efgh'],
    ['key=a1b2c3d4e5f6', 'a1b2c3d4e5f6'],
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF0\n-----END PGP PRIVATE KEY BLOCK-----', 'lQOYBF0'],
    ['pegué esto: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nAAAA (cortado)', 'b3BlbnNzaC1rZXktdjEAAAA'],
    ['aws ASIAIOSFODNN7EXAMPLE temporal', 'ASIAIOSFODNN7EXAMPLE'],
    ['aws AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['https://' + ['hooks.slack.com/services/', 'T00000000/B00000000/', 'XXXXXXXXXXXXXXXXXXXXXXXX'].join(''), ['T00000000/B00000000/', 'XXXXXXXXXXXXXXXXXXXXXXXX'].join('')],
    [['xoxe.xoxp-', '1-Mi0yLTEyMzQ1Njc4OTAx'].join(''), 'Mi0yLTEyMzQ1Njc4OTAx'],
    [['xoxe-', '1-My0xLTEyMzQ1Njc4OTAxMjM'].join(''), 'My0xLTEyMzQ1Njc4OTAxMjM'],
    ['xoxb-123456789012-abcdefghijkl', 'xoxb-123456789012-abcdefghijkl'],
    ['//registry.npmjs.org/:_authToken npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['glpat-abcdefghij1234567890', 'glpat-abcdefghij1234567890'],
    [['hf_', 'abcdefghijklmnopqrstuvwxyzABCDEFGH'].join(''), ['hf_', 'abcdefghijklmnopqrstuvwxyzABCDEFGH'].join('')],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['curl -H "Authorization: Basic YWRtaW46c2VjcmV0"', 'YWRtaW46c2VjcmV0'],
    ['postgres://admin:p@ss@word1@db.example.com:5432/app', 'p@ss@word1'],
    ['mysql://root:clave@db/app', 'clave'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['sk-proj-abcdefghijklmnop1234', 'sk-proj-abcdefghijklmnop1234'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstu', 'AIzaSyA1234567890abcdefghijklmnopqrstu'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
  ];
  for (const [input, secret] of cases) {
    const out = redact(input);
    assert.ok(out.includes('[REDACTED]'), `${input} → ${out}`);
    assert.ok(!out.includes(secret), `"${secret}" sobrevivió: ${out}`);
  }
  assert.equal(redact('postgres://admin:p@ss@db.example.com/app'), 'postgres://admin:[REDACTED]@db.example.com/app', 'el host queda a la vista');
});

test('tabla de prosa que no se toca', () => {
  for (const t of [
    'el monkey=bueno y turkey: 2024 no son claves',
    'Basic configuration of the server',
    'la key del objeto es el id',
    'escribe a ana@example.com o visita https://example.com/ruta',
    'hooks de Slack y webhooks en general',
    'ver la sección BEGIN de la guía',
  ])
    assert.equal(redact(t), t);
});
