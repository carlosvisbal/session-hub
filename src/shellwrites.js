// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Archivos que un comando de terminal probablemente escribió o borró (sed -i, redirecciones, tee,
// cp/mv/rm, scripts de python/node en línea…). Solo se ANALIZA el texto del comando: nunca se
// ejecuta nada. El análisis es conservador: lo que depende de variables del shell, comodines o
// sustituciones ($x, *, $(…)) se descarta en lugar de adivinar.
//
//  - shellWrites(command)       -> [{ path, removed, dirBase? }] tal como aparecen en el comando
//                                  (relativas a un "cd" previo cuando es obvio).
//  - shellWriteTargets(command) -> solo las rutas (escritas y borradas), sin repetir.
//  - resolveShellWrites(...)    -> las que de verdad cambiaron dentro del proyecto (con stat).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_TARGETS = 20; // por comando: un comando enorme no dispara cientos de stat
const MAX_DEPTH = 3; // bash -c "…" anidados

// ---------- análisis léxico del shell ----------

// Divide el comando en comandos simples: { words: [{text, dyn}], redirs: [{op, fd, target, dyn}],
// heredocs: [cuerpo], sep }. dyn = la palabra depende de algo que no se conoce sin ejecutar.
function parse(cmd) {
  const cmds = [];
  let cur = newCmd();
  let word = null;
  let pendingRedir = null; // redirección esperando su destino
  let awaitingDelim = null; // "<<" esperando el delimitador
  const pendingDocs = []; // heredocs cuyo cuerpo empieza en la próxima línea
  const n = cmd.length;
  let i = 0;

  const startWord = () => (word ||= { text: '', dyn: false, quoted: false });
  const pushWord = () => {
    if (!word) return;
    if (awaitingDelim) {
      pendingDocs.push({ delim: word.text, strip: awaitingDelim.strip, cmd: cur });
      awaitingDelim = null;
    } else if (pendingRedir) {
      cur.redirs.push({ ...pendingRedir, target: word.text, dyn: word.dyn });
      pendingRedir = null;
    } else cur.words.push(word);
    word = null;
  };
  const endCmd = (sep) => {
    pushWord();
    pendingRedir = null;
    if (cur.words.length || cur.redirs.length || cur.heredocs.length) {
      cur.sep = sep;
      cmds.push(cur);
    }
    cur = newCmd();
  };
  // Salta un bloque entre paréntesis equilibrados ($(…), <(…)); devuelve el índice de cierre.
  const skipParens = (from) => {
    let depth = 0;
    for (let j = from; j < n; j++) {
      const c = cmd[j];
      if (c === '\\') j++;
      else if (c === "'") {
        const k = cmd.indexOf("'", j + 1);
        j = k < 0 ? n : k;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    return n;
  };
  // Lee los cuerpos de los heredocs pendientes a partir de la línea siguiente a `nl`.
  const readDocs = (nl) => {
    let pos = nl + 1;
    for (const d of pendingDocs.splice(0)) {
      const lines = [];
      while (pos <= n) {
        let end = cmd.indexOf('\n', pos);
        if (end < 0) end = n;
        const raw = cmd.slice(pos, end);
        pos = end + 1;
        if ((d.strip ? raw.replace(/^\t+/, '') : raw) === d.delim) break;
        lines.push(raw);
      }
      d.cmd.heredocs.push(lines.join('\n'));
    }
    return pos - 1; // el bucle principal sigue en el salto de línea final
  };

  for (; i < n; i++) {
    const c = cmd[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      pushWord();
    } else if (c === '\n') {
      pushWord();
      if (pendingDocs.length) i = readDocs(i);
      endCmd(';');
    } else if (c === '#' && !word) {
      while (i + 1 < n && cmd[i + 1] !== '\n') i++; // comentario
    } else if (c === "'") {
      startWord().quoted = true;
      const k = cmd.indexOf("'", i + 1);
      word.text += cmd.slice(i + 1, k < 0 ? n : k);
      i = k < 0 ? n : k;
    } else if (c === '"') {
      startWord().quoted = true;
      let j = i + 1;
      for (; j < n && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < n && '"\\$`\n'.includes(cmd[j + 1])) word.text += cmd[++j];
        else {
          if (cmd[j] === '$' || cmd[j] === '`') word.dyn = true;
          word.text += cmd[j];
        }
      }
      i = j;
    } else if (c === '\\') {
      if (cmd[i + 1] === '\n') i++; // continuación de línea
      else if (i + 1 < n) startWord().text += cmd[++i];
    } else if (c === '$') {
      startWord().dyn = true;
      if (cmd[i + 1] === '(') {
        const k = skipParens(i + 1);
        word.text += cmd.slice(i, k + 1);
        i = k;
      } else if (cmd[i + 1] === '{') {
        const k = cmd.indexOf('}', i);
        word.text += cmd.slice(i, k < 0 ? n : k + 1);
        i = k < 0 ? n : k;
      } else word.text += c;
    } else if (c === '`') {
      startWord().dyn = true;
      const k = cmd.indexOf('`', i + 1);
      i = k < 0 ? n : k;
    } else if (c === ';') {
      endCmd(';');
    } else if (c === '&') {
      if (cmd[i + 1] === '&') {
        endCmd('&&');
        i++;
      } else if (cmd[i + 1] === '>') {
        pushWord();
        const append = cmd[i + 2] === '>';
        pendingRedir = { op: append ? '>>' : '>', fd: null };
        i += append ? 2 : 1;
      } else endCmd('&');
    } else if (c === '|') {
      if (cmd[i + 1] === '|') {
        endCmd('||');
        i++;
      } else {
        if (cmd[i + 1] === '&') i++;
        endCmd('|');
      }
    } else if (c === '(' || c === ')') {
      endCmd(';');
    } else if (c === '<') {
      if (cmd.startsWith('<<<', i)) {
        pushWord();
        pendingRedir = { op: '<<<', fd: null };
        i += 2;
      } else if (cmd[i + 1] === '<') {
        pushWord();
        const strip = cmd[i + 2] === '-';
        awaitingDelim = { strip };
        i += strip ? 2 : 1;
      } else if (cmd[i + 1] === '(') {
        startWord().dyn = true;
        i = skipParens(i + 1);
      } else {
        pushWord();
        pendingRedir = { op: '<', fd: null };
        if (cmd[i + 1] === '&' || cmd[i + 1] === '>') i++;
      }
    } else if (c === '>') {
      // "2>" / "1>": el número pegado delante es el descriptor, no una palabra.
      let fd = null;
      if (word && !word.quoted && /^\d+$/.test(word.text)) {
        fd = Number(word.text);
        word = null;
      } else pushWord();
      if (cmd[i + 1] === '(') {
        startWord().dyn = true;
        i = skipParens(i + 1);
        continue;
      }
      let op = '>';
      if (cmd[i + 1] === '>') op = '>>';
      else if (cmd[i + 1] === '|') op = '>|';
      else if (cmd[i + 1] === '&') op = '>&'; // duplicar descriptor (2>&1, >&2)
      if (op !== '>') i++;
      pendingRedir = { op, fd };
    } else {
      if (!word && (c === '{' || c === '}') && /[\s;]/.test(cmd[i + 1] ?? ' ')) {
        endCmd(';'); // agrupación { …; }
        continue;
      }
      if (!word || !word.quoted) if (c === '*' || c === '?' || c === '[') startWord().dyn = true;
      startWord().text += c;
    }
  }
  if (pendingDocs.length) readDocs(n); // heredoc sin cerrar al final
  endCmd(';');
  return cmds;
}

const newCmd = () => ({ words: [], redirs: [], heredocs: [], sep: ';' });

// ---------- comandos conocidos ----------

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'command', 'exec', 'builtin', 'stdbuf']);
const INTERPRETERS = /^(python[\d.]*|pypy[\d.]*|node|nodejs|bun)$/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// Quita asignaciones (X=1 cmd) y envoltorios (sudo, env, time…) del principio.
function stripPrefixes(words) {
  let k = 0;
  while (k < words.length) {
    const t = words[k].text;
    if (/^[A-Za-z_]\w*=/.test(t)) k++;
    else if (WRAPPERS.has(t)) {
      k++;
      while (k < words.length && words[k].text.startsWith('-')) k++;
    } else if (t === 'timeout') {
      k++;
      while (k < words.length && words[k].text.startsWith('-')) k++;
      k++; // la duración
    } else break;
  }
  return words.slice(k);
}

// Argumentos posicionales, saltando opciones (y el valor de las que lo llevan aparte).
function positional(args, withValue = new Set()) {
  const out = [];
  let rest = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (rest || !t.startsWith('-') || t === '-') out.push(args[k]);
    else if (t === '--') rest = true;
    else if (withValue.has(t)) k++;
  }
  return out;
}

// sed -i / perl -i: los archivos tras el script (o los -e). Devuelve [] si no edita en el sitio.
function inPlaceFiles(args, tool) {
  let inPlace = false;
  let script = false;
  const files = [];
  let rest = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (rest || !t.startsWith('-') || t === '-') {
      if (!script) script = true;
      else files.push(args[k]);
      continue;
    }
    if (t === '--') {
      rest = true;
      continue;
    }
    if (t.startsWith('--')) {
      if (t.startsWith('--in-place')) inPlace = true;
      else if (t === '--expression' || t === '--file') (script = true), k++;
      else if (t.startsWith('--expression=') || t.startsWith('--file=')) script = true;
      continue;
    }
    const cluster = t.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j];
      if (ch === 'i') {
        inPlace = true;
        // El resto es el sufijo de respaldo (-i.bak). En macOS va aparte y vacío: sed -i '' …
        if (j === cluster.length - 1 && tool === 'sed' && args[k + 1]?.text === '' && args[k + 1].quoted) k++;
        break;
      }
      if (ch === 'e' || ch === 'f' || (tool === 'sed' && ch === 'l')) {
        if (ch !== 'l') script = true;
        if (j === cluster.length - 1) k++; // el valor va en el siguiente argumento
        break;
      }
      if (tool === 'perl' && /[IMmlx0CdDV]/.test(ch)) break; // opciones de perl con valor pegado
    }
  }
  return inPlace ? files : [];
}

// ---------- scripts de python / node en línea ----------

const LIT_RE = /^(?:[rRbBuU]{0,2}'([^'\\\n]*)'|[rRbBuU]{0,2}"([^"\\\n]*)"|`([^`$\\\n]*)`)$/;

// Divide los argumentos de una llamada que empieza en `open` (índice del "(").
function callArgs(code, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let j = open; j < code.length; j++) {
    const c = code[j];
    if (c === "'" || c === '"' || c === '`') {
      const k = code.indexOf(c, j + 1);
      if (k < 0) return args;
      j = k;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        args.push(code.slice(start, j).trim());
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(code.slice(start, j).trim());
      start = j + 1;
    } else if (c === '\n' && depth === 0) return args;
  }
  return args;
}

// Valores conocidos de una expresión: literal, variable con literal, Path('x'), os.path.join('a','b'),
// path.resolve('x'), o una lista de literales. [] si no se sabe.
function exprValues(expr, vars) {
  const e = String(expr || '').trim();
  if (!e) return [];
  const lit = LIT_RE.exec(e);
  if (lit) return [lit[1] ?? lit[2] ?? lit[3]];
  if (/^[A-Za-z_$][\w$]*$/.test(e)) return vars.get(e) || [];
  const call = /^(?:pathlib\.)?(?:Path|PurePath|os\.path\.join|path\.join|path\.resolve|os\.path\.abspath|os\.path\.realpath)\s*\(/.exec(e);
  if (call && e.endsWith(')')) {
    const parts = callArgs(e, call[0].length - 1).map((a) => exprValues(a, vars));
    if (!parts.length || parts.some((p) => p.length !== 1)) return [];
    return [parts.map((p) => p[0]).join('/')];
  }
  if ((e.startsWith('[') && e.endsWith(']')) || (e.startsWith('(') && e.endsWith(')'))) {
    const items = callArgs(e, 0).filter(Boolean).map((a) => exprValues(a, vars));
    return items.every((v) => v.length === 1) ? items.map((v) => v[0]) : [];
  }
  return [];
}

// Escrituras en el código: [{ path, removed }].
//   python: open(p, 'w'|'a'|'x'|'wb'|'r+'…), Path(p).write_text/write_bytes/touch/unlink,
//           os.remove/os.unlink, os.rename/os.replace/shutil.move, shutil.copy*
//   node:   fs.writeFileSync/appendFileSync/writeFile/appendFile/createWriteStream/openSync(p,'w'),
//           unlinkSync/rmSync, renameSync, copyFileSync
// Las variables (p = 'x', const f = "x", for p in ['a','b']:) se siguen en orden de aparición.
function scriptWrites(code) {
  const events = [];
  const add = (re, kind) => {
    re.lastIndex = 0;
    for (let m; (m = re.exec(code)); ) events.push({ at: m.index, kind, m });
  };
  add(/(?:^|[^\w$.=!<>])(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^\n;]*)/g, 'assign');
  add(/\bfor\s*\(?\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s+(?:in|of)\s+([^\n:]*?)\s*(?:\)\s*\{?|:)\s*(?:\n|$|[^\n])/g, 'loop');
  add(/(?:\bopen|\bopenSync)\s*\(/g, 'open');
  add(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|outputFileSync|outputFile)\s*\(/g, 'write0');
  add(/\b(?:unlinkSync|rmSync|os\.remove|os\.unlink)\s*\(/g, 'remove0');
  add(/\b(?:renameSync|os\.rename|os\.replace|shutil\.move)\s*\(/g, 'move');
  add(/\b(?:copyFileSync|cpSync|shutil\.copy2?|shutil\.copyfile)\s*\(/g, 'copy');
  add(/(\b(?:pathlib\.)?Path\s*\((?:[^()]|\([^()]*\))*\)|\b[A-Za-z_]\w*)\.(write_text|write_bytes|touch|unlink)\s*\(/g, 'pathm');
  events.sort((a, b) => a.at - b.at);

  const vars = new Map();
  const out = [];
  const push = (values, removed = false) => {
    for (const v of values) if (v) out.push({ path: v, removed });
  };
  for (const { kind, m } of events) {
    const parenAt = m.index + m[0].length - 1;
    if (kind === 'assign') {
      const values = exprValues(m[2].replace(/\s*(#|\/\/).*$/, '').replace(/[\s;]+$/, ''), vars);
      if (values.length) vars.set(m[1], values);
      else vars.delete(m[1]); // reasignada a algo desconocido
    } else if (kind === 'loop') {
      const values = exprValues(m[2], vars);
      if (values.length) vars.set(m[1], values);
      else vars.delete(m[1]);
    } else if (kind === 'open') {
      const args = callArgs(code, parenAt);
      const modeArg = args.find((a) => /^mode\s*=/.test(a))?.replace(/^mode\s*=\s*/, '') ?? (args[1] && !/^\w+\s*=/.test(args[1]) ? args[1] : null);
      const mode = modeArg ? exprValues(modeArg, vars)[0] : null;
      const fileArg = args.find((a) => /^file\s*=/.test(a))?.replace(/^file\s*=\s*/, '') ?? args[0];
      if (mode && /[wax+]/.test(mode)) push(exprValues(fileArg, vars));
    } else if (kind === 'write0') push(exprValues(callArgs(code, parenAt)[0], vars));
    else if (kind === 'remove0') push(exprValues(callArgs(code, parenAt)[0], vars), true);
    else if (kind === 'move') {
      const [a, b] = callArgs(code, parenAt);
      push(exprValues(a, vars), true);
      push(exprValues(b, vars));
    } else if (kind === 'copy') push(exprValues(callArgs(code, parenAt)[1], vars));
    else if (kind === 'pathm') push(exprValues(m[1], vars), m[2] === 'unlink');
  }
  return out;
}

// ---------- API ----------

// [{ path, removed, dirBase? }] en el orden del comando. dirBase: si `path` resulta ser una carpeta,
// el archivo es path/dirBase (cp a.js carpeta).
export function shellWrites(command, depth = 0) {
  if (typeof command !== 'string' || !command.trim() || depth > MAX_DEPTH) return [];
  const out = [];
  let dir = ''; // carpeta de un "cd" literal previo
  let lost = false; // hubo un cd a un sitio desconocido: lo relativo ya no se sabe dónde cae
  const add = (word, removed = false, dirBase) => {
    if (!word || word.dyn) return;
    let p = word.text;
    if (!p || p === '-' || /^\/(dev|proc|sys)(\/|$)/.test(p)) return;
    const absolute = p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p);
    if (!absolute) {
      if (lost) return;
      if (dir) p = dir.replace(/\/+$/, '') + '/' + p;
    }
    out.push({ path: p, removed, ...(dirBase ? { dirBase } : {}) });
  };
  const addScript = (code, removedToo = true) => {
    for (const w of scriptWrites(code)) if (removedToo || !w.removed) add({ text: w.path, dyn: false }, w.removed);
  };
  const base = (p) => p.replace(/\/+$/, '').split('/').pop();

  const cmds = parse(command);
  let carried = []; // heredocs de "cat <<EOF | python3"
  for (const c of cmds) {
    for (const r of c.redirs) if ((r.op === '>' || r.op === '>>' || r.op === '>|') && (r.fd == null || r.fd === 1)) add({ text: r.target, dyn: r.dyn });
    const words = stripPrefixes(c.words);
    const name = (words[0]?.text || '').split('/').pop();
    const args = words.slice(1);
    const docs = [...carried, ...c.heredocs];
    carried = [];

    if (name === 'cd') {
      const t = args[0];
      if (!t || t.dyn || t.text === '-' || t.text.startsWith('~')) lost = true;
      else if (t.text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t.text)) (dir = t.text), (lost = false);
      else if (!lost) dir = dir ? dir.replace(/\/+$/, '') + '/' + t.text : t.text;
    } else if (name === 'sed' || name === 'perl') {
      for (const f of inPlaceFiles(args, name)) add(f);
    } else if (name === 'tee') {
      for (const f of positional(args)) add(f);
    } else if (name === 'touch') {
      for (const f of positional(args, new Set(['-d', '-t', '-r']))) add(f);
    } else if (name === 'truncate') {
      for (const f of positional(args, new Set(['-s', '-r']))) add(f);
    } else if (name === 'rm' || name === 'unlink') {
      for (const f of positional(args)) add(f, true);
    } else if (name === 'cp' || name === 'mv' || name === 'install') {
      copyMove(name === 'mv', args, add, base);
    } else if (name === 'git' && (args[0]?.text === 'mv' || args[0]?.text === 'rm')) {
      if (args[0].text === 'rm') for (const f of positional(args.slice(1))) add(f, true);
      else copyMove(true, args.slice(1), add, base);
    } else if (name === 'dd') {
      for (const a of args) if (a.text.startsWith('of=')) add({ text: a.text.slice(3), dyn: a.dyn });
    } else if (INTERPRETERS.test(name)) {
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (['-c', '-e', '-p', '--eval', '--print'].includes(t) && args[k + 1]) addScript(args[++k].text);
      }
      for (const d of docs) addScript(d);
    } else if (SHELLS.has(name)) {
      const k = args.findIndex((a) => a.text === '-c');
      const inner = k >= 0 ? [args[k + 1]?.text] : docs;
      for (const code of inner) for (const w of shellWrites(code || '', depth + 1)) add({ text: w.path, dyn: false }, w.removed, w.dirBase);
    } else if (name === 'cat' && c.sep === '|' && c.heredocs.length && !c.redirs.some((r) => r.op === '>' || r.op === '>>')) {
      carried = c.heredocs; // el cuerpo va al siguiente comando de la tubería
    }
    if (out.length >= MAX_TARGETS) break;
  }
  return out.slice(0, MAX_TARGETS);
}

function copyMove(isMove, args, add, base) {
  const withValue = new Set(['-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']);
  let targetDir = null;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t === '-t' || t === '--target-directory') targetDir = args[k + 1];
    else if (t.startsWith('--target-directory=')) targetDir = { text: t.slice('--target-directory='.length), dyn: args[k].dyn };
  }
  const pos = positional(args, new Set([...withValue, '-t', '--target-directory'])).filter((a) => !a.text.startsWith('--target-directory='));
  const srcs = targetDir ? pos : pos.slice(0, -1);
  const dest = targetDir || pos[pos.length - 1];
  if (!dest || !srcs.length) return;
  if (isMove) for (const s of srcs) add(s, true);
  if (dest.dyn) return;
  if (targetDir || srcs.length > 1 || dest.text.endsWith('/')) {
    for (const s of srcs) if (!s.dyn) add({ text: dest.text.replace(/\/+$/, '') + '/' + base(s.text), dyn: false });
  } else add(dest, false, srcs[0].dyn ? undefined : base(srcs[0].text));
}

export function shellWriteTargets(command) {
  return [...new Set(shellWrites(command).map((w) => w.path))];
}

// Rutas absolutas que el comando de verdad cambió dentro del proyecto:
//  - dentro de `project`, fuera de node_modules y .git;
//  - escritas: existen y su fecha de modificación es >= la del comando − 2 s (sin fecha, basta que existan);
//  - borradas: ya no existen.
// cache: Map ruta -> stat (o null) compartido durante una lectura, para no repetir stat.
export function resolveShellWrites(command, { cwd, project, at = null, cache = new Map() } = {}) {
  if (!project) return [];
  const root = path.resolve(project);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const stat = (p) => {
    if (!cache.has(p)) {
      let st = null;
      try {
        st = fs.statSync(p, { throwIfNoEntry: false }) || null;
      } catch {}
      cache.set(p, st && { file: st.isFile(), dir: st.isDirectory(), mtimeMs: st.mtimeMs });
    }
    return cache.get(p);
  };
  const out = [];
  const seen = new Set();
  for (const w of shellWrites(command)) {
    let p = w.path;
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    else if (p.startsWith('~')) continue; // ~otro_usuario
    let abs = path.resolve(cwd || root, p);
    let st = stat(abs);
    if (st?.dir && w.dirBase) {
      abs = path.join(abs, w.dirBase);
      st = stat(abs);
    }
    if (!norm(abs).startsWith(norm(root + path.sep))) continue;
    const rel = abs.slice(root.length + 1).split(path.sep);
    if (rel.includes('node_modules') || rel.includes('.git')) continue;
    const ok = w.removed ? !st : st?.file && (!at || st.mtimeMs >= at - 2000);
    if (!ok || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
