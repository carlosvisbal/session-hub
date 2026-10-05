// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Un solo Session Hub por computadora, compartido por todos los editores (Cursor, VS Code…).
//
// Hasta 0.9 cada editor guardaba su identidad, token, equipo, respaldo y bandeja en su propia
// carpeta (globalStorage): con dos editores eran dos personas y el segundo chocaba con el puerto.
// Desde 0.10 todo vive en una carpeta común (~/.session-hub/hub). El primer editor que abre lanza
// el hub y los demás se conectan a él con el mismo token. Los ajustes que definen a la persona y lo
// que comparte (SHARED_SETTINGS) se sincronizan entre editores a través de settings.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXT_ID = 'carlosvisbal.session-hub';
const EDITOR_APPS = ['Cursor', 'Code', 'Code - Insiders', 'VSCodium', 'Windsurf'];

// Ajustes comunes a todos los editores. Los demás (idioma, avisos, chat preferido, arranque,
// runtime) siguen siendo de cada editor.
const SHARED_SETTINGS = [
  'name',
  'role',
  'port',
  'sharedProjects',
  'paused',
  'excludedSessions',
  'redactExtra',
  'network',
  'dhtPort',
  'bootstrap',
  'relay',
  'peers',
  'inboundMessages',
  'backupOwnSessions',
  'backupRetentionDays',
  'keepTeamCopies',
  'teamCopiesRetentionDays',
  'allowTeamCopies',
  'backupMaxMB',
  'conversationTurns',
  'startContext',
];

// SESSION_HUB_DATA_DIR permite otra carpeta (pruebas, o varias personas en una misma cuenta).
const dataDir = (env = process.env) => env.SESSION_HUB_DATA_DIR || path.join(os.homedir(), '.session-hub', 'hub');

// La carpeta de datos solo la puede abrir su dueño. Si quedó legible para otros (0755), se cierra.
function sealDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return;
    if (fs.statSync(dir).mode & 0o077) fs.chmodSync(dir, 0o700);
  } catch {
    // si no se puede cerrar, el hub sigue; los archivos de dentro ya son 0600
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Escribe completo o nada (otro editor puede estar leyendo). En Windows, si un antivirus o el otro
// editor tiene el archivo abierto un instante, renombrar falla: se escribe directamente.
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.rmSync(tmp, { force: true });
  }
}

// Nombre del editor a partir de su carpeta (…/<App>/User/globalStorage/<id>).
const editorOf = (dir) => {
  const app = path.basename(path.resolve(dir, '..', '..', '..'));
  return app === 'Code' ? 'VS Code' : app;
};

// En Windows las rutas no distinguen mayúsculas.
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => norm(a) === norm(b);

// Dónde guardan sus datos los editores en cada sistema (<base>/<Editor>/User/globalStorage).
// Además de la carpeta vecina del propio editor, se miran las conocidas: un VS Code Flatpak y un
// Cursor normal no comparten carpeta base.
function editorBases(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return [env.APPDATA || path.join(home, 'AppData', 'Roaming')];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support')];
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [xdg, ...['com.visualstudio.code', 'com.vscodium.codium', 'com.cursor.Cursor'].map((id) => path.join(home, '.var', 'app', id, 'config'))];
}

// Carpetas de datos de Session Hub de los editores de esta cuenta (la propia primero).
function candidateDirs(ownStorage, bases = editorBases()) {
  const sibling = path.resolve(ownStorage, '..', '..', '..', '..');
  const dirs = [ownStorage];
  for (const base of [sibling, ...bases]) for (const a of EDITOR_APPS) dirs.push(path.join(base, a, 'User', 'globalStorage', EXT_ID));
  const seen = new Set();
  return dirs
    .filter((d) => !seen.has(norm(d)) && seen.add(norm(d)))
    .filter((d) => fs.existsSync(path.join(d, 'config.json')) || fs.existsSync(path.join(d, 'team.json')));
}

// Qué hay en una carpeta de datos: identidad, equipo, nombre y cuándo se usó por última vez.
function describe(dir) {
  const state = readJson(path.join(dir, 'team.json')) || {};
  const conf = readJson(path.join(dir, 'config.json')) || {};
  const mtime = Math.max(...['team.json', 'config.json', 'audit.jsonl', 'inbox.json'].map((f) => fs.statSync(path.join(dir, f), { throwIfNoEntry: false })?.mtimeMs || 0));
  return { dir, editor: editorOf(dir), pub: state.keyPair?.publicKey || null, team: state.team ? { id: state.team.id, name: state.team.name } : null, owner: conf.owner?.name || '', token: conf.localToken || '', mtime };
}

// Qué identidad usar al crear la carpeta común:
//  - una sola persona con equipo (aunque esté en varios editores) → esa, la usada más recientemente;
//  - varias personas distintas con equipo → hay que preguntar (ask);
//  - nadie con equipo → la carpeta del propio editor, si existe (conserva su token y su respaldo).
// others: identidades con equipo que no se usarán (se conservan en su carpeta).
function plan(cands, ownStorage) {
  const withTeam = cands.filter((c) => c.team && c.pub).sort((a, b) => b.mtime - a.mtime);
  const byPub = []; // la más reciente de cada identidad (withTeam ya va de más a menos reciente)
  for (const c of withTeam) if (!byPub.some((x) => x.pub === c.pub)) byPub.push(c);
  if (byPub.length > 1) return { ask: byPub };
  if (byPub.length === 1) return { use: byPub[0], others: [] };
  const own = cands.find((c) => samePath(c.dir, ownStorage));
  return { use: own || cands.sort((a, b) => b.mtime - a.mtime)[0] || null, others: [] };
}

// Copia (no mueve) una carpeta de datos a la común: la original queda como respaldo y un editor
// que aún no se actualizó puede seguir usándola.
async function copyData(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (name.startsWith('.migrat') || name.endsWith('.tmp')) continue;
    await fs.promises.cp(path.join(src, name), path.join(dest, name), { recursive: true, force: false, errorOnExist: false });
  }
}

// Trae de `src` los archivos más recientes que en `dest` (lo que un hub anterior siguió escribiendo
// en la carpeta vieja). No toca config.json (la configuración común la escribe la extensión).
// Devuelve cuántos archivos copió.
async function catchUp(src, dest) {
  let n = 0;
  const walk = async (rel) => {
    for (const ent of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = path.join(rel, ent.name);
      if (!rel && (ent.name === 'config.json' || ent.name.startsWith('.') || ent.name.endsWith('.tmp'))) continue;
      if (ent.isDirectory()) {
        await walk(r);
        continue;
      }
      const from = path.join(src, r);
      const to = path.join(dest, r);
      const a = fs.statSync(from).mtimeMs;
      const b = fs.statSync(to, { throwIfNoEntry: false })?.mtimeMs || 0;
      if (a <= b + 1) continue; // al copiar la fecha se pierden fracciones de milisegundo
      fs.mkdirSync(path.dirname(to), { recursive: true });
      await fs.promises.copyFile(from, to);
      fs.utimesSync(to, new Date(), new Date(a));
      n++;
    }
  };
  if (fs.existsSync(src)) await walk('');
  return n;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // existe, pero es de otro usuario
  }
};

// Crea la carpeta común una sola vez, aunque dos editores abran a la vez, y nunca a medias:
// `fill(stage)` llena una carpeta temporal que al final se renombra a `dir` (todo o nada).
// El candado es un archivo junto a `dir` con el pid de quien migra; si ese proceso ya no existe
// (el editor se cerró a mitad de la copia) o lleva demasiado sin renovarse, se libera. Quien migra
// lo renueva mientras copia, así una copia larga (un respaldo grande) no se toma por abandonada. Quien espera nunca sigue
// con la carpeta vacía mientras otro migra: espera a que esté lista.
// Devuelve 'done' (la creó este proceso), 'ready' (ya estaba o la creó otro) o 'timeout'.
async function createOnce(dir, fill, { waitMs = 10 * 60000, staleMs = 10 * 60000 } = {}) {
  const ready = () => fs.existsSync(path.join(dir, 'config.json'));
  if (ready()) return 'ready';
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lock = `${dir}.lock`;
  for (const end = Date.now() + waitMs; ; ) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      const st = fs.statSync(lock, { throwIfNoEntry: false });
      let pid = 0;
      try {
        pid = parseInt(fs.readFileSync(lock, 'utf8'), 10) || 0;
      } catch {}
      if (!st || !alive(pid) || Date.now() - st.mtimeMs > staleMs) fs.rmSync(lock, { force: true });
      else if (ready()) return 'ready';
      else if (Date.now() > end) return 'timeout';
      else await new Promise((r) => setTimeout(r, 300));
    }
  }
  const stage = `${dir}.nuevo-${process.pid}`;
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lock, now, now);
    } catch {}
  }, Math.max(50, Math.min(30000, Math.floor(staleMs / 4))));
  heartbeat.unref?.();
  try {
    if (ready()) return 'ready'; // otro editor terminó mientras esperaba
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    await fill(stage);
    // Restos de un intento anterior sin terminar (sin config.json): se apartan, no se borran.
    if (fs.existsSync(dir)) fs.renameSync(dir, `${dir}.incompleto-${Date.now()}`);
    fs.renameSync(stage, dir);
    return 'done';
  } finally {
    clearInterval(heartbeat);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(lock, { force: true });
  }
}

// Ajustes comunes: { values: { clave: valor }, removed: { clave: fecha }, updatedAt, by }.
// `removed` son las claves que algún editor restableció: los demás también las restablecen en vez
// de volver a agregar su valor viejo.
const settingsFile = (dir) => path.join(dir, 'settings.json');
const readSettings = (dir) => readJson(settingsFile(dir));
const writeSettings = (dir, values, by, removed = {}) => writeJsonAtomic(settingsFile(dir), { values, removed, updatedAt: new Date().toISOString(), by });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Compara versiones "x.y.z": <0 si a es anterior a b.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

module.exports = { EXT_ID, SHARED_SETTINGS, dataDir, sealDir, samePath, editorBases, settingsFile, readJson, writeJsonAtomic, candidateDirs, describe, plan, copyData, catchUp, createOnce, readSettings, writeSettings, same, compareVersions, editorOf };
