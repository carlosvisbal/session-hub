// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Archivos que escribe o borra un comando de terminal: solo se analiza el texto, nunca se ejecuta.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveShellWrites, shellWrites, shellWriteTargets } from '../src/shellwrites.js';

const CASES = [
  // sed -i
  ["sed -i 's/a/b/' src/a.js src/b.js", ['src/a.js', 'src/b.js']],
  ["sed -i.bak -e 's/a/b/' -e 's/c/d/' x.txt", ['x.txt']],
  ["sed -i '' 's/a/b/' mac.txt", ['mac.txt']],
  ["sed -Ei 's/a+/b/' e.txt", ['e.txt']],
  ["sed --in-place=.orig 's/a/b/' g.txt", ['g.txt']],
  ["perl -pi -e 's/a/b/' p.txt", ['p.txt']],
  // redirecciones
  ['echo hola > out.txt', ['out.txt']],
  ['printf x >> log.txt', ['log.txt']],
  ['ls &> list.txt', ['list.txt']],
  ['make 1> build.log 2> err.log', ['build.log']],
  [': > cleared.txt', ['cleared.txt']],
  ['echo x >| forced.txt', ['forced.txt']],
  ["cat > file.md <<'EOF'\n# título > no.txt\nEOF", ['file.md']],
  ["cat <<EOF > doc.txt\nhola\nEOF\necho fin > fin.txt", ['doc.txt', 'fin.txt']],
  ['tee -a a.log b.log < entrada', ['a.log', 'b.log']],
  ['npm test | tee salida.txt', ['salida.txt']],
  // cp, mv, rm, touch, truncate
  ['cp a.js b.js', ['b.js']],
  ['cp a.js b.js dir/', ['dir/a.js', 'dir/b.js']],
  ['mv old.js new.js', ['old.js', 'new.js']],
  ['cp -t dest a.js', ['dest/a.js']],
  ['rm -f gone.js other.js', ['gone.js', 'other.js']],
  ['unlink u.txt', ['u.txt']],
  ['git mv a.js b.js && git rm c.js', ['a.js', 'b.js', 'c.js']],
  ['touch new.txt && truncate -s 0 empty.txt', ['new.txt', 'empty.txt']],
  ['dd if=/dev/zero of=img.bin bs=1 count=1', ['img.bin']],
  // cd previo, envoltorios, encadenados
  ["cd src && sed -i 's/x/y/' util.js", ['src/util.js']],
  ["cd /abs/dir; echo > a.txt", ['/abs/dir/a.txt']],
  ["cd $TMP && echo > a.txt", []],
  ['sudo tee /etc/hosts', ['/etc/hosts']],
  ['FOO=1 env BAR=2 cp a b', ['b']],
  ["(cd web && npm run build > build.log)", ['web/build.log']],
  ["bash -c 'echo x > inner.txt'", ['inner.txt']],
  // python / node en línea
  ["python3 - <<'EOF'\np='src/x.js'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF", ['src/x.js']],
  ["python3 <<'EOF'\nfor p in ['a.py', 'b.py']:\n    s = open(p).read()\n    open(p, 'w').write(s)\nEOF", ['a.py', 'b.py']],
  ["python3 -c \"open('a.txt','w').write('x'); from pathlib import Path; Path('b.txt').write_text('y')\"", ['a.txt', 'b.txt']],
  ["python3 -c \"import os; open(os.path.join('src','j.py'), mode='a').write('x')\"", ['src/j.py']],
  ["python - <<'EOF'\nfrom pathlib import Path\nf = Path('src/m.py')\nf.write_text(f.read_text().upper())\nEOF", ['src/m.py']],
  ["python3 -c \"import os, shutil; os.remove('r.txt'); shutil.copy('a', 'c.txt')\"", ['r.txt', 'c.txt']],
  ["node -e \"const fs=require('fs'); fs.writeFileSync('c.json', '{}'); const f = 'd.js'; fs.appendFileSync(f, 'x')\"", ['c.json', 'd.js']],
  ["node <<'EOF'\nconst fs = require('fs');\nfor (const f of ['e.js', 'g.js']) fs.writeFileSync(f, fs.readFileSync(f, 'utf8'));\nEOF", ['e.js', 'g.js']],
  ["cat <<'EOF' | python3\nopen('piped.txt', 'w')\nEOF", ['piped.txt']],
  // negativos
  ["sed -n '1,20p' src/a.js", []],
  ["sed 's/a/b/' src/a.js", []],
  ['grep -r foo src > /dev/null 2>&1', []],
  ['npm test 2>&1 | tail -5', []],
  ['npm test 2> /tmp/err.log', []],
  ['echo texto', []],
  ["echo 'a > b'", []],
  ['echo "x" >&2', []],
  ['git diff', []],
  ['git status && git log --oneline -5', []],
  ['cat src/a.js | head', []],
  ['for f in *.js; do sed -i "s/a/b/" "$f"; done', []],
  ['echo x > "$OUT"', []],
  ['echo x > $(mktemp)', []],
  ["python3 -c \"print(open('a.txt').read())\"", []],
  ["python3 -c \"p = input(); open(p, 'w')\"", []],
  ["node -e \"require('fs').readFileSync('a.js')\"", []],
  ['diff <(sort a) <(sort b)', []],
  ['', []],
];

test('shellWriteTargets: patrones habituales y negativos', () => {
  for (const [cmd, expected] of CASES) assert.deepEqual(shellWriteTargets(cmd), expected, cmd);
});

test('shellWrites: borrados y destino de cp/mv a una carpeta', () => {
  assert.deepEqual(shellWrites('mv a.js lib && rm b.js'), [
    { path: 'a.js', removed: true },
    { path: 'lib', removed: false, dirBase: 'a.js' },
    { path: 'b.js', removed: true },
  ]);
  assert.equal(shellWrites(Array.from({ length: 50 }, (_, i) => `touch f${i}`).join(' && ')).length, 20, 'como mucho 20 por comando');
  assert.deepEqual(shellWrites(null), []);
});

test('resolveShellWrites: dentro del proyecto, fuera de node_modules/.git, con fecha posterior o borrado', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shub-shell-'));
  const project = path.join(root, 'app');
  const at = Date.UTC(2026, 8, 1, 12, 0);
  const touch = (rel, mtime) => {
    const file = path.join(project, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  };
  const fresh = touch('src/a.js', at + 1000);
  const borderline = touch('src/b.js', at - 1500); // reloj de grano grueso: 2 s de margen
  touch('src/old.js', at - 60_000);
  touch('node_modules/m/i.js', at + 1000);
  touch('.git/config', at + 1000);
  touch('../fuera.txt', at + 1000);
  fs.mkdirSync(path.join(project, 'lib'));
  const moved = touch('lib/c.js', at + 1000);
  const cmd = [
    "sed -i 's/a/b/' src/a.js src/b.js src/old.js",
    'echo > node_modules/m/i.js',
    'echo > .git/config',
    'echo > ../fuera.txt',
    'echo > /tmp/x.txt',
    'rm -f src/borrado.js',
    'rm -f src/a.js', // existe: no se borró de verdad
    'mv c.js lib',
    'echo > src/no-existe.js',
  ].join(' && ');
  const cache = new Map();
  assert.deepEqual(resolveShellWrites(cmd, { cwd: project, project, at, cache }), [fresh, borderline, path.join(project, 'src/borrado.js'), path.join(project, 'c.js'), moved]);
  assert.ok(cache.size > 0, 'los stat se guardan para la misma lectura');
  assert.deepEqual(resolveShellWrites("sed -i 's/a/b/' src/old.js", { cwd: project, project }), [path.join(project, 'src/old.js')], 'sin fecha, basta que exista');
  assert.deepEqual(resolveShellWrites('cd src && touch a.js', { cwd: project, project, at }), [fresh]);
  assert.deepEqual(resolveShellWrites('touch a.js', { cwd: path.join(project, 'src'), project, at }), [fresh], 'relativo al cwd de la sesión');
  assert.deepEqual(resolveShellWrites('echo > x', { cwd: project, project: null }), []);
});
