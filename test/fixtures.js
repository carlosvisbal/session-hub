// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Historial sintético de Claude Code para las pruebas (nunca datos reales).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LONG_TEXT = 'Explicación detallada con tildes, eñes y emojis 📎✅. '.repeat(200); // > 4000 caracteres

export function makeClaudeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-fixture-'));
  const project = path.join(root, 'demo-api');
  fs.mkdirSync(project);
  const claudeDir = path.join(root, 'claude');
  const dir = path.join(claudeDir, project.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const t = (i) => new Date(Date.UTC(2026, 8, 23, 10, i)).toISOString();
  const base = { cwd: project, sessionId: 's1', gitBranch: 'feature/adjuntos', isSidechain: false };
  const lines = [
    { type: 'ai-title', aiTitle: 'Adjuntos múltiples en contactos', sessionId: 's1' },
    { ...base, type: 'user', timestamp: t(0), message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>ruido del editor</system-reminder><ide_opened_file>x</ide_opened_file>Haz que attachments acepte una lista 📎' }] } },
    { ...base, type: 'assistant', timestamp: t(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Cambio el serializer.' }, { type: 'tool_use', name: 'Edit', input: { file_path: path.join(project, 'app/serializers.py') } }] } },
    { ...base, type: 'user', timestamp: t(2), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { ...base, type: 'assistant', timestamp: t(3), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q tests/test_contacts.py' } }] } },
    { ...base, type: 'user', timestamp: t(4), isSidechain: true, message: { role: 'user', content: 'mensaje de un subagente (se ignora)' } },
    { ...base, type: 'user', timestamp: t(5), message: { role: 'user', content: 'Ahora documenta el cambio' } },
    { ...base, type: 'assistant', timestamp: t(6), message: { role: 'assistant', content: [{ type: 'text', text: LONG_TEXT + ' Usa API_KEY=sk-abcdefghijklmnop1234 para probar.' }] } },
  ];
  fs.writeFileSync(path.join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { root, project, claudeDir, cursorUserDir: path.join(root, 'no-cursor') };
}
