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

// Sesión de Claude Code con subagentes (herramienta Agent): s2.jsonl y s2/subagents/agent-*.jsonl.
//  - a1b2: con .meta.json (enlazado por toolUseId), edita un archivo y corre un comando.
//  - zz9: sin .meta.json (enlazado por el agentId del resultado de la herramienta, llamada 'Task').
export function addClaudeSubagents(f) {
  const dir = path.join(f.claudeDir, f.project.replace(/[^a-zA-Z0-9]/g, '-'));
  const t = (i) => new Date(Date.UTC(2026, 8, 23, 11, i)).toISOString();
  const base = { cwd: f.project, sessionId: 's2', gitBranch: 'main', isSidechain: false };
  const lines = [
    { ...base, type: 'user', timestamp: t(0), message: { role: 'user', content: 'Revisa la seguridad del módulo de pagos' } },
    { ...base, type: 'assistant', timestamp: t(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Lanzo dos subagentes.' }, { type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'Auditar pagos', subagent_type: 'general-purpose', prompt: 'audita' } }, { type: 'tool_use', id: 'toolu_B', name: 'Task', input: { description: 'Buscar usos', subagent_type: 'Explore', prompt: 'busca' } }] } },
    { ...base, type: 'user', timestamp: t(8), toolUseResult: { agentId: 'a1b2', status: 'completed' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'listo' }] } },
    { ...base, type: 'user', timestamp: t(9), toolUseResult: { agentId: 'zz9', status: 'completed' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'listo' }] } },
    { ...base, type: 'assistant', timestamp: t(10), message: { role: 'assistant', content: [{ type: 'text', text: 'Revisión terminada.' }] } },
  ];
  fs.writeFileSync(path.join(dir, 's2.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const subDir = path.join(dir, 's2', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 's2', 'tool-results'), { recursive: true }); // se ignora
  const sub = (agentId) => ({ cwd: f.project, sessionId: 's2', isSidechain: true, agentId });
  const a = [
    { ...sub('a1b2'), type: 'user', timestamp: t(2), message: { role: 'user', content: 'Audita el módulo de pagos' } },
    { ...sub('a1b2'), type: 'user', timestamp: t(2), isMeta: true, message: { role: 'user', content: 'meta (se ignora)' } },
    { ...sub('a1b2'), type: 'assistant', timestamp: t(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Encontré token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 en un test; marcador ornitorrinco.' }, { type: 'tool_use', id: 'x1', name: 'Edit', input: { file_path: path.join(f.project, 'pagos/checkout.py') } }] } },
    { ...sub('a1b2'), type: 'assistant', timestamp: t(4), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x2', name: 'Bash', input: { command: 'pytest pagos' } }] } },
  ];
  fs.writeFileSync(path.join(subDir, 'agent-a1b2.jsonl'), a.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, 'agent-a1b2.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Auditar pagos', toolUseId: 'toolu_A', spawnDepth: 1 }));
  const z = [
    { ...sub('zz9'), type: 'user', timestamp: t(5), message: { role: 'user', content: 'Busca usos de charge()' } },
    { ...sub('zz9'), type: 'assistant', timestamp: t(6), message: { role: 'assistant', content: [{ type: 'text', text: 'Hay 3 usos.' }] } },
  ];
  fs.writeFileSync(path.join(subDir, 'agent-zz9.jsonl'), z.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

// Transcripciones .jsonl de Cursor (~/.cursor/projects/<carpeta>/agent-transcripts/), sin state.vscdb.
//  - k1: con un subagente (k1sub) lanzado con Task; edita, corre un comando.
export function makeCursorTranscriptsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-cursor-jsonl-'));
  const project = path.join(root, 'tienda.web');
  fs.mkdirSync(project);
  const cursorProjectsDir = path.join(root, 'cursor-projects');
  const enc = project.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const write = (file, lines) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  };
  const dir = path.join(cursorProjectsDir, enc, 'agent-transcripts', 'k1');
  const user = (stamp, q) => ({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>${stamp}</timestamp>\n<user_query>\n${q}\n</user_query>` }] } });
  write(path.join(dir, 'k1.jsonl'), [
    user('Sunday, Oct 4, 2026, 8:00 PM (UTC-5)', 'Arregla el carrito'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Reviso.' }, { type: 'tool_use', name: 'Read', input: { path: path.join(project, 'cart.js') } }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task', input: { description: 'Explorar carrito', subagent_type: 'explore', prompt: 'mira', model: 'x' } }] } },
    { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'StrReplace', input: { path: path.join(project, 'cart.js'), old_string: 'a', new_string: 'b' } }, { type: 'tool_use', name: 'Shell', input: { command: 'npm test', description: 'pruebas' } }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Listo.' }] } },
    { type: 'turn_ended', status: 'success' },
    'no es json',
  ]);
  fs.appendFileSync(path.join(dir, 'k1.jsonl'), '{a medio escribir\n');
  write(path.join(dir, 'subagents', 'k1sub.jsonl'), [
    user('Sunday, Oct 4, 2026, 8:01 PM (UTC-5)', 'Explora el carrito'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'El carrito usa localStorage; marcador quetzal.' }, { type: 'tool_use', name: 'Write', input: { path: path.join(project, 'notes.md'), contents: 'x' } }] } },
    { type: 'turn_ended', status: 'success' },
  ]);
  return { root, project, cursorProjectsDir, cursorUserDir: path.join(root, 'no-cursor'), claudeDir: path.join(root, 'no-claude'), encoded: enc };
}

// Sesión de Claude Code (s3) que cambia archivos con comandos de terminal, con archivos reales del
// proyecto y fechas controladas (utimesSync) para comprobar qué cuenta como cambiado:
//  - src/a.js: sed -i, modificado después del comando (cuenta) · src/old.js: sed -i, pero con fecha
//    anterior (no cuenta) · gone.js: rm -f y ya no existe (cuenta, borrado)
//  - ../afuera.txt (fuera del proyecto) y node_modules/x/index.js: nunca cuentan
//  - src/b.js: con Edit y con sed en el mismo mensaje (una sola edición, sin via)
//  - src/nuevo.txt: "cd src && cat > nuevo.txt <<EOF" · src/py.js: python con p='src/py.js'
export function addClaudeShellSession(f) {
  const dir = path.join(f.claudeDir, f.project.replace(/[^a-zA-Z0-9]/g, '-'));
  const ms = (i) => Date.UTC(2026, 8, 23, 12, i);
  const t = (i) => new Date(ms(i)).toISOString();
  const touch = (rel, at) => {
    const file = path.resolve(f.project, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at / 1000, at / 1000);
  };
  touch('src/a.js', ms(1) + 5000);
  touch('src/old.js', ms(1) - 60_000);
  touch('../afuera.txt', ms(1) + 5000);
  touch('node_modules/x/index.js', ms(1) + 5000);
  touch('src/b.js', ms(2) + 5000);
  touch('src/nuevo.txt', ms(2) + 5000);
  touch('src/py.js', ms(3) + 1000);
  const base = { cwd: f.project, sessionId: 's3', gitBranch: 'main', isSidechain: false };
  const bash = (i, command) => ({ ...base, type: 'assistant', timestamp: t(i), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const lines = [
    { ...base, type: 'user', timestamp: t(0), message: { role: 'user', content: 'Renombra la función en todo el proyecto' } },
    { ...base, type: 'assistant', timestamp: t(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Uso sed.' }] } },
    bash(1, "sed -i 's/viejo/nuevo/g' src/a.js src/old.js && rm -f gone.js && echo x > ../afuera.txt && echo y > node_modules/x/index.js 2>/dev/null"),
    { ...base, type: 'assistant', timestamp: t(2), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(f.project, 'src/b.js') } }] } },
    bash(2, "sed -i 's/a/b/' src/b.js"),
    bash(2, "cd src && cat > nuevo.txt <<'EOF'\nhola > nada.txt\nEOF"),
    bash(3, "python3 - <<'EOF'\np = 'src/py.js'\ns = open(p).read()\nopen(p, 'w').write(s.replace('a', 'b'))\nEOF"),
    bash(3, 'git diff > /dev/null && npm test 2>&1 | tail -3'),
  ];
  fs.writeFileSync(path.join(dir, 's3.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
