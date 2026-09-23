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
