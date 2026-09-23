// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Extensión Session Hub para VS Code y Cursor.
// Arranca el hub local como proceso hijo, muestra al equipo en un panel lateral
// y registra el servidor MCP en el editor para que la IA pueda consultar las sesiones.
const vscode = require('vscode');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderSession, renderChanges } = require('./render.cjs');
const { Dashboard } = require('./dashboard.cjs');
const { createTranslator, resolveLanguage } = require('../media/i18n.js');
const EN = require('../locales/en.json');

// Idioma: sessionHub.language, o el del editor si es "auto".
const translate = createTranslator(EN);
const lang = () => resolveLanguage(vscode.workspace.getConfiguration('sessionHub').get('language'), vscode.env.language);
const t = (text, vars) => translate(lang(), text, vars);
const tLabel = (l) => (l ? l.replace(/^(\$\([\w-]+\)\s*)?([\s\S]*)$/, (m, icon = '', rest) => icon + t(rest)) : l);

// Avisos, preguntas y selectores traducidos. Los botones se muestran traducidos, pero se
// devuelve siempre la opción original: la lógica compara contra el texto en español.
const say = (fn) => async (msg, ...rest) => {
  const opts = rest.length && rest[0] && typeof rest[0] === 'object' ? [rest.shift()] : [];
  const labels = rest.map((x) => t(x));
  const r = await fn(t(msg), ...opts, ...labels);
  const i = labels.indexOf(r);
  return i >= 0 ? rest[i] : r;
};
const info = say((...a) => vscode.window.showInformationMessage(...a));
const warn = say((...a) => vscode.window.showWarningMessage(...a));
const error = say((...a) => vscode.window.showErrorMessage(...a));
const input = (o) =>
  vscode.window.showInputBox({
    ...o,
    title: t(o.title),
    prompt: t(o.prompt),
    placeHolder: t(o.placeHolder),
    validateInput: o.validateInput && ((v) => t(o.validateInput(v))),
  });
async function pick(items, o = {}) {
  const list = await items;
  const shown = list.map((it) => (typeof it === 'string' ? t(it) : { ...it, label: tLabel(it.label), description: t(it.description), _orig: it }));
  const r = await vscode.window.showQuickPick(shown, { ...o, title: t(o.title), placeHolder: t(o.placeHolder) });
  if (r == null) return r;
  const back = (x) => (typeof x === 'string' ? list[shown.indexOf(x)] : x._orig);
  return Array.isArray(r) ? r.map(back) : back(r);
}
const progress = (o, fn) => vscode.window.withProgress({ ...o, title: t(o.title) }, fn);

const MCP_NAME = 'session-hub';
const TOKEN_KEY = 'sessionHub.token';
const POLL_MS = 10000;
const READ_NOTIFY_COOLDOWN_MS = 10 * 60000; // no repetir el mismo aviso de lectura antes de esto

let ctx;
let hubProc = null;
let token = '';
let output;
let statusItem;
let tree;
let pollTimer;
let dashboard;
const mcpChanged = new vscode.EventEmitter();

const cfg = () => vscode.workspace.getConfiguration('sessionHub');
const port = () => cfg().get('port');
const base = () => `http://127.0.0.1:${port()}`;
const editorName = () => (/cursor/i.test(vscode.env.appName) ? 'Cursor' : /visual studio code|vscode/i.test(vscode.env.appName) ? 'VS Code' : vscode.env.appName);
const follows = () => ctx.globalState.get('follows', { people: [], sessions: [] });

async function activate(context) {
  ctx = context;
  output = vscode.window.createOutputChannel('Session Hub');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'sessionHub.openDashboard';
  tree = new TeamTree();
  dashboard = new Dashboard(context, {
    getState: buildState,
    openSession: (id, peer) => api(`/api/sessions/${encodeURIComponent(id)}?peer=${encodeURIComponent(peer)}&full=1`, { timeout: 60000 }),
    toggleFollow,
    lang,
  });
  // Token solo para la API local de esta máquina (el equipo se identifica con claves, no con tokens).
  token = (await ctx.secrets.get(TOKEN_KEY)) || '';
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    await ctx.secrets.store(TOKEN_KEY, token);
  }

  const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('sessionHub.start', startHub);
  reg('sessionHub.stop', stopHub);
  reg('sessionHub.createTeam', createTeam);
  reg('sessionHub.joinTeam', joinTeam);
  reg('sessionHub.leaveTeam', leaveTeam);
  reg('sessionHub.copyInvite', copyInvite);
  reg('sessionHub.blockMember', blockMember);
  reg('sessionHub.revokeMember', revokeMember);
  reg('sessionHub.shareWorkspace', shareWorkspace);
  reg('sessionHub.unshareProject', unshareProject);
  reg('sessionHub.refresh', () => tree.refresh());
  reg('sessionHub.openSession', openSession);
  reg('sessionHub.whatChanged', whatChanged);
  reg('sessionHub.copyClaudeCommand', copyClaudeCommand);
  reg('sessionHub.openDashboard', () => dashboard.show());
  reg('sessionHub.togglePause', togglePause);
  reg('sessionHub.toggleSessionVisibility', toggleSessionVisibility);
  reg('sessionHub.editProjectAccess', editProjectAccess);
  reg('sessionHub.doctor', runDoctor);
  reg('sessionHub.copyNetReport', copyNetReport);
  reg('sessionHub.setLanguage', setLanguage);
  reg('sessionHub.openSource', () => vscode.env.openExternal(vscode.Uri.parse(`${base()}/source`)));
  reg('sessionHub.openWebViewer', () => vscode.env.openExternal(vscode.Uri.parse(`${base()}/?token=${encodeURIComponent(token)}`)));

  ctx.subscriptions.push(
    output,
    statusItem,
    vscode.window.registerTreeDataProvider('sessionHub.team', tree),
    vscode.workspace.onDidChangeConfiguration(onConfigChanged),
  );
  registerMcp();
  updateStatus();
  const migration = migrateLegacyStorage();

  if (migration?.restored) info(t('Recuperé tu equipo "{v1}" de la versión anterior de la extensión.', { v1: migration.restored }));
  if (migration?.ask) migration.ask();
  if (cfg().get('autoStart')) {
    startHub();
    // Primera vez: ofrecer crear o unirse.
    setTimeout(async () => {
      const t = await api('/api/team').catch(() => null);
      if (t && !t.hasTeam && !attached) { // solo en la ventana que lanzó el hub, no en cada ventana
        const pick = await info('Session Hub: crea un equipo o únete con una invitación para compartir sesiones de IA.', 'Crear equipo', 'Unirme');
        if (pick === 'Crear equipo') createTeam();
        if (pick === 'Unirme') joinTeam();
      }
    }, 3000);
  }
}

function deactivate() {
  stopHub();
}

// Hasta 0.6.1 la extensión se publicaba como "energiasolar.session-hub"; el editor la trata como
// otra extensión, con otra carpeta de datos. Si ahí hay un equipo, se trae (identidad incluida).
const LEGACY_IDS = ['energiasolar.session-hub'];
const readTeam = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).team || null;
  } catch {
    return null;
  }
};

function migrateLegacyStorage() {
  const dir = ctx.globalStorageUri.fsPath;
  const current = readTeam(path.join(dir, 'team.json'));
  for (const id of LEGACY_IDS) {
    const legacyDir = path.join(path.dirname(dir), id);
    const legacy = readTeam(path.join(legacyDir, 'team.json'));
    if (!legacy || fs.existsSync(path.join(dir, `.migrated-from-${id}`))) continue;
    const copy = () => {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, 'team.json');
      if (fs.existsSync(target)) fs.copyFileSync(target, path.join(dir, `team.json.${Date.now()}.bak`));
      for (const f of ['team.json', 'audit.jsonl']) if (fs.existsSync(path.join(legacyDir, f))) fs.copyFileSync(path.join(legacyDir, f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, `.migrated-from-${id}`), new Date().toISOString());
      output.appendLine(t('[hub] equipo "{v1}" recuperado de la versión anterior de la extensión.', { v1: legacy.name }));
    };
    if (!current) {
      copy(); // sin equipo en la versión nueva: se recupera el anterior sin preguntar
      return { restored: legacy.name };
    }
    if (current.id === legacy.id) continue;
    // Ya hay otro equipo: se pregunta, y el actual queda respaldado.
    return {
      ask: async () => {
        const pick = await warn(t('Encontré tu equipo "{v1}" de la versión anterior de Session Hub. Ahora estás en "{v2}". ¿Recuperar "{v1}"? (el actual queda respaldado)', { v1: legacy.name, v2: current.name }), 'Recuperar equipo anterior', 'Mantener el actual');
        if (pick === 'Recuperar equipo anterior') {
          stopHub();
          copy();
          setTimeout(startHub, 800);
          info(t('Equipo "{v1}" recuperado, con tu identidad anterior.', { v1: legacy.name }));
        } else if (pick === 'Mantener el actual') fs.writeFileSync(path.join(dir, `.migrated-from-${id}`), 'kept-current');
      },
    };
  }
  return null;
}

// Solo el puerto de la API o el runtime requieren reiniciar el hub; lo demás se recarga en caliente
// (nombre, rol, red, compartir, pausar, ocultar).
const RESTART_KEYS = ['port', 'nodePath'];
function onConfigChanged(e) {
  if (e.affectsConfiguration('sessionHub.language')) {
    tree.refresh();
    updateStatus();
    if (dashboard.visible) buildState().then((s) => dashboard.update(s));
  }
  if (!e.affectsConfiguration('sessionHub') || !hubUp()) return;
  if (RESTART_KEYS.some((k) => e.affectsConfiguration(`sessionHub.${k}`))) return restartHub();
  writeHubConfig();
  setTimeout(() => pollUpdates(), 1500); // el hub revisa el archivo cada segundo
}

// ---------- hub (proceso hijo) ----------

function writeHubConfig() {
  const c = cfg();
  const file = path.join(ctx.globalStorageUri.fsPath, 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = {
    owner: { name: c.get('name') || os.userInfo().username, role: c.get('role') },
    port: port(),
    localToken: token,
    network: c.get('network'),
    dhtPort: c.get('dhtPort'),
    bootstrap: c.get('bootstrap'),
    relay: c.get('relay'),
    language: lang(),
    peers: c.get('peers'),
    projects: c.get('sharedProjects'),
    paused: c.get('paused'),
    excludedSessions: c.get('excludedSessions'),
    redactExtra: c.get('redactExtra'),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  return file;
}

// Por defecto el hub corre con el runtime del propio editor (Cursor y VS Code traen Node 24,
// con node:sqlite y los módulos de red). sessionHub.nodePath permite usar otro Node.
function pickNode() {
  const custom = cfg().get('nodePath');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (!custom && (maj > 22 || (maj === 22 && min >= 5))) return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, label: t('runtime del editor (Node {v1})', { v1: process.versions.node }) };
  const candidate = custom || 'node';
  try {
    const v = cp.execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    return { cmd: candidate, env: {}, label: `${candidate} ${v}` };
  } catch {
    output.appendLine(t(`No encontré "${candidate}"; uso el runtime del editor.`));
    return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, label: t('runtime del editor (Node {v1})', { v1: process.versions.node }) };
  }
}

// Un solo hub por usuario, compartido por todas las ventanas del editor: si ya hay uno mío
// corriendo, esta ventana se conecta a él; si no, lo lanza. Si la ventana dueña se cierra,
// otra toma el relevo (ver checkHealth).
let attached = false;
const hubUp = () => !!hubProc || attached;

// ¿Quién responde en el puerto? 'mine' (mi hub, acepta mi token) · 'other' (otro Session Hub u otro programa) · 'free'
async function probePort() {
  try {
    const r = await fetch(`${base()}/api/whoami`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    return r.ok ? 'mine' : 'other';
  } catch (err) {
    return err.name === 'TimeoutError' ? 'other' : 'free';
  }
}

let starting = null;
function startHub() {
  if (hubUp()) return Promise.resolve();
  starting ||= (async () => {
    try {
      const who = await probePort();
      if (who === 'mine') return attach();
      if (who === 'other') {
        output.appendLine(t(`[hub] el puerto ${port()} lo usa otro programa.`));
        error(`El puerto ${port()} lo está usando otro programa u otro Session Hub (con otra identidad). Cambia "sessionHub.port" o cierra ese programa.`, 'Abrir ajustes').then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'sessionHub.port'));
        return;
      }
      spawnHub();
    } finally {
      starting = null;
    }
  })();
  return starting;
}

function attach() {
  attached = true;
  output.appendLine(t(`[hub] esta ventana usa el hub que ya está abierto en otra ventana (puerto ${port()}).`));
  afterStart();
}

function spawnHub() {
  const configFile = writeHubConfig();
  const { cmd, env, label } = pickNode();
  const server = path.join(ctx.extensionPath, 'src', 'server.js');
  const proc = cp.spawn(cmd, ['--disable-warning=ExperimentalWarning', server], {
    env: { ...process.env, ...env, SESSION_HUB_CONFIG: configFile, SESSION_HUB_EDITOR: editorName() },
  });
  hubProc = proc;
  proc.stdout.on('data', (d) => output.append(d.toString().replace(/token=[^\s]+/g, 'token=***')));
  proc.stderr.on('data', (d) => output.append(d.toString()));
  proc.on('exit', async (code) => {
    output.appendLine(t(`[hub] terminó (código ${code})`));
    if (hubProc !== proc) return; // era el proceso anterior a un reinicio
    hubProc = null;
    // Código 2 = puerto ocupado: otra ventana lo lanzó a la vez; me conecto a ese.
    if (code === 2 && (await probePort()) === 'mine') return attach();
    updateStatus();
    mcpChanged.fire();
    if (dashboard?.visible) buildState().then((s) => dashboard.update(s));
    if (code) error('Session Hub se detuvo. Revisa la salida "Session Hub".', 'Ver salida', 'Reiniciar').then((p) => (p === 'Ver salida' ? output.show() : p && startHub()));
  });
  output.appendLine(t(`[hub] iniciando con ${label}`));
  afterStart();
}

function afterStart() {
  lastReadAt = new Date().toISOString(); // no avisar de lecturas guardadas antes de este arranque
  waitForHub().then((up) => {
    if (!up && hubUp()) output.appendLine(t('[hub] no respondió en 15 s; revisa la salida.'));
    updateStatus();
    tree.refresh();
    mcpChanged.fire();
    registerCursorMcp();
    pollUpdates();
  });
  clearInterval(pollTimer);
  pollTimer = setInterval(pollUpdates, POLL_MS);
}

// Espera a que el hub responda /health, con límite: nunca queda esperando para siempre.
async function waitForHub(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end && hubUp()) {
    try {
      const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Detiene el hub si lo lanzó esta ventana; si solo estaba conectada, se desconecta sin apagarlo.
function stopHub() {
  clearInterval(pollTimer);
  if (hubProc) hubProc.kill();
  hubProc = null;
  attached = false;
  updateStatus();
  mcpChanged.fire();
  if (dashboard?.visible) buildState().then((s) => dashboard.update(s));
}

let restartTimer;
function restartHub() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    stopHub();
    setTimeout(startHub, 500);
  }, 800);
}

// Toda llamada al hub tiene tiempo límite y un mensaje claro si el hub no está.
async function api(pathAndQuery, { method = 'GET', body, timeout = 15000 } = {}) {
  if (!hubUp()) throw new Error('El hub está detenido.');
  let res;
  try {
    res = await fetch(base() + pathAndQuery, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? `El hub no respondió en ${timeout / 1000} s.` : 'No pude conectar con el hub local.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const post = (route, body, timeout) => api(route, { method: 'POST', body, timeout });

// ---------- equipo ----------

async function askIdentity(step) {
  const name = await input({ title: step, prompt: 'Tu nombre visible para el equipo', value: cfg().get('name') || os.userInfo().username, ignoreFocusOut: true });
  if (!name) return false;
  const role = await input({ title: step, prompt: 'Tu rol (backend, frontend, QA…)', value: cfg().get('role'), ignoreFocusOut: true });
  if (role === undefined) return false;
  await cfg().update('name', name, vscode.ConfigurationTarget.Global);
  await cfg().update('role', role || '', vscode.ConfigurationTarget.Global);
  return true;
}

async function ensureHub() {
  if (!hubUp()) await startHub();
  if (!(await waitForHub())) throw new Error('El hub no arrancó. Revisa la salida "Session Hub".');
}

async function createTeam() {
  const team = await input({ title: 'Crear equipo (1/2)', prompt: 'Nombre del equipo', ignoreFocusOut: true });
  if (!team || !(await askIdentity('Crear equipo (2/2)'))) return;
  try {
    await ensureHub();
    writeHubConfig();
    await post('/api/team/create', { name: team }, 30000);
  } catch (err) {
    return error(`No se pudo crear el equipo: ${err.message}`);
  }
  pollUpdates();
  const pick = await info(`Equipo "${team}" creado. Invita a cada persona con su propia invitación.`, 'Copiar invitación', 'Compartir este proyecto');
  if (pick === 'Copiar invitación') copyInvite();
  if (pick === 'Compartir este proyecto') shareWorkspace();
}

// Validación rápida en el editor; la verificación criptográfica completa la hace el hub.
function looksLikeInvite(text) {
  const code = (String(text).match(/SH2-[A-Za-z0-9_-]+/) || [])[0];
  if (!code) return null;
  try {
    const d = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString('utf8'));
    return d.v === 2 && d.team?.id ? { code, team: d.team.name, expires: d.invite?.cert?.body?.expires } : null;
  } catch {
    return null;
  }
}

async function joinTeam() {
  const text = await input({
    title: 'Unirme a un equipo (1/2)',
    prompt: 'Pega la invitación que te pasó tu compañero (empieza por SH2-)',
    placeHolder: 'SH2-…',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v) return null;
      const inv = looksLikeInvite(v);
      if (!inv) return /SH1-/.test(v) ? 'Es una invitación de una versión anterior. Pide una nueva.' : 'No parece una invitación válida.';
      if (inv.expires && Date.parse(inv.expires) < Date.now()) return 'Esta invitación ya venció. Pide una nueva.';
      return null;
    },
  });
  const inv = text && looksLikeInvite(text);
  if (!inv || !(await askIdentity('Unirme a un equipo (2/2)'))) return;
  try {
    await ensureHub();
    writeHubConfig();
    await post('/api/team/join', { code: inv.code }, 30000);
  } catch (err) {
    return error(`No se pudo unir: ${err.message}`);
  }
  verifyJoin(inv.team);
}

// Espera la confirmación de quien invitó (máx. 60 s) y dice claramente qué pasó.
async function verifyJoin(team) {
  let info = null;
  await progress({ location: vscode.ProgressLocation.Notification, title: `Esperando que tu compañero confirme tu entrada a "${team}"…`, cancellable: true }, async (_p, cancel) => {
    const end = Date.now() + 60000;
    while (Date.now() < end && !cancel.isCancellationRequested) {
      info = await api('/api/team').catch(() => null);
      if (info?.team && !info.team.pending) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  });
  pollUpdates();
  if (info?.team && !info.team.pending) {
    const online = (await api('/api/peers').catch(() => [])).filter((m) => !m.self && m.online);
    const msg = t('Ya eres miembro de "{v1}".', { v1: team }) + (online.length ? ' ' + t('En línea: {v1}.', { v1: online.map((m) => m.name).join(', ') }) : '');
    const pick = await info(msg, 'Abrir panel');
    if (pick) dashboard.show();
  } else {
    const pick = await warn(
      `Tu entrada a "${team}" está pendiente: quien te invitó debe tener Session Hub abierto para confirmarla. Se completará sola en cuanto esté en línea.`,
      'Diagnosticar',
      'Abrir panel',
    );
    if (pick === 'Diagnosticar') runDoctor();
    if (pick === 'Abrir panel') dashboard.show();
  }
}

async function copyInvite() {
  try {
    const r = await post('/api/team/invite', {});
    const t = await api('/api/team');
    await vscode.env.clipboard.writeText(`Te invito a mi equipo de Session Hub "${t.team.name}".\nEn VS Code o Cursor: Session Hub → Unirme a un equipo → pega este código.\nSirve para UNA persona y vence el ${new Date(r.expires).toLocaleString()}.\n\n${r.code}`);
    info('Invitación copiada: sirve para una sola persona y vence en 48 h. Pásala por un canal privado. Mantén Session Hub abierto para confirmar su entrada.');
  } catch (err) {
    warn(err.message);
  }
}

async function leaveTeam() {
  const ok = await warn('¿Salir del equipo? Dejarás de ver a tus compañeros y ellos a ti. Para volver necesitarás otra invitación.', { modal: true }, 'Salir del equipo');
  if (!ok) return;
  await post('/api/team/leave', {}).catch((err) => error(err.message));
  pollUpdates();
}

// Bloqueo personal: solo para mí; el resto del equipo sigue viendo a esa persona.
async function blockMember(id, name = 'esta persona') {
  const peers = await api('/api/peers').catch(() => []);
  const m = peers.find((p) => p.id === id);
  const blocked = !m?.blocked;
  if (blocked) {
    const ok = await warn(`¿Bloquear a ${m?.name || name} solo para ti? No podrá ver tus sesiones ni tú las suyas. El resto del equipo no se ve afectado.`, { modal: true }, 'Bloquear');
    if (!ok) return;
  }
  await post('/api/members/block', { id, blocked }).catch((err) => error(err.message));
  pollUpdates();
}

// Expulsar del equipo: solo si estoy por encima de esa persona en su cadena de invitaciones.
async function revokeMember(id) {
  const peers = await api('/api/peers').catch(() => []);
  const m = peers.find((p) => p.id === id);
  if (!m?.canRevoke) return warn('Solo puede expulsar a alguien quien lo invitó (o quien está por encima en su cadena).');
  const ok = await warn(`¿Expulsar a ${m.name} del equipo? Nadie podrá volver a conectarse con esa persona, ni con quienes ella haya invitado.`, { modal: true }, 'Expulsar');
  if (!ok) return;
  await post('/api/members/revoke', { id, reason: 'expulsado desde el panel' }).catch((err) => error(err.message));
  pollUpdates();
}

// ---------- lo que comparto ----------

const sharedList = () => cfg().get('sharedProjects');
const isShared = (fsPath) => sharedList().some((p) => p.path === fsPath);
const saveShared = (list) => cfg().update('sharedProjects', list, vscode.ConfigurationTarget.Global);

async function shareWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return warn('Abre una carpeta de proyecto primero.');
  const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: t('Qué carpeta compartir') });
  if (!folder) return;
  const name = await input({ title: 'Compartir proyecto (1/2)', prompt: 'Nombre con el que el equipo verá este proyecto', value: folder.name, ignoreFocusOut: true });
  if (!name) return;
  const allow = await pickAudience(['*']);
  if (!allow) return;
  await saveShared([...sharedList().filter((p) => p.path !== folder.uri.fsPath), { path: folder.uri.fsPath, name, allow }]);
  info(`Compartiendo "${name}" con ${audienceLabel(allow, await teamMembers())}. Puedes ocultar sesiones concretas o pausar desde el panel.`, 'Abrir panel').then((p) => p && dashboard.show());
}

async function unshareProject(fsPath) {
  const list = sharedList();
  let target = typeof fsPath === 'string' ? fsPath : null;
  if (!target) {
    const pick = await pick(list.map((p) => ({ label: p.name, description: p.path })), { placeHolder: 'Dejar de compartir' });
    target = pick?.description;
  }
  const proj = list.find((p) => p.path === target);
  if (!proj) return;
  const ok = await warn(`¿Dejar de compartir "${proj.name}"? El equipo dejará de ver sus sesiones.`, { modal: true }, 'Dejar de compartir');
  if (ok) await saveShared(list.filter((p) => p.path !== target));
}

async function editProjectAccess(fsPath) {
  const list = sharedList();
  const proj = list.find((p) => p.path === fsPath) || (await pickProject(list));
  if (!proj) return;
  const allow = await pickAudience(proj.allow || ['*'], proj.name);
  if (!allow) return;
  await saveShared(list.map((p) => (p.path === proj.path ? { ...p, allow } : p)));
  info(`"${proj.name}" ahora lo ve: ${audienceLabel(allow, await teamMembers())}.`);
}

async function pickProject(list) {
  const pick = await pick(list.map((p) => ({ label: p.name, description: p.path, p })), { placeHolder: 'Elige el proyecto' });
  return pick?.p;
}

// Selector de audiencia: todo el equipo o personas concretas (incluye a quien esté desconectado pero ya tenía acceso).
async function pickAudience(current, projectName) {
  let members = [];
  try {
    members = (await api('/api/peers')).filter((m) => !m.self);
  } catch {}
  const known = new Map(members.map((m) => [m.id, m]));
  for (const id of current) if (id !== '*' && !known.has(id)) known.set(id, { id, name: id, role: '', online: false });
  const everyone = { label: '$(organization) Todo el equipo', description: 'incluye a quien se una después', id: '*', picked: current.includes('*') };
  const people = [...known.values()].map((m) => ({
    label: `$(person) ${m.name}`,
    description: [m.role, m.online ? '' : 'desconectado'].filter(Boolean).join(' · '),
    id: m.id,
    picked: !current.includes('*') && current.includes(m.id),
  }));
  const picks = await pick([everyone, ...people], {
    canPickMany: true,
    title: projectName ? `Quién puede ver "${projectName}"` : 'Compartir proyecto (2/2): quién puede verlo',
    placeHolder: people.length ? 'Marca "Todo el equipo" o personas concretas' : 'Aún no hay compañeros conectados: se compartirá con todo el equipo',
    ignoreFocusOut: true,
  });
  if (!picks) return null;
  if (!picks.length) {
    warn('Elige al menos una opción. Para no compartir, usa "Dejar de compartir".');
    return null;
  }
  return picks.some((p) => p.id === '*') ? ['*'] : picks.map((p) => p.id);
}

const teamMembers = () => api('/api/peers').catch(() => []);

function audienceLabel(allow, members = []) {
  if (!allow || allow.includes('*')) return t('todo el equipo');
  return allow.map((id) => members.find((m) => m.id === id)?.name || id.split('@')[0]).join(', ');
}

async function togglePause() {
  const paused = !cfg().get('paused');
  await cfg().update('paused', paused, vscode.ConfigurationTarget.Global);
  info(paused ? 'Compartir en pausa: nadie del equipo ve tus sesiones hasta que reanudes.' : 'Compartir reanudado.');
  updateStatus();
}

async function toggleSessionVisibility(sessionId) {
  if (!sessionId) return;
  const list = cfg().get('excludedSessions');
  const next = list.includes(sessionId) ? list.filter((x) => x !== sessionId) : [...list, sessionId];
  await cfg().update('excludedSessions', next, vscode.ConfigurationTarget.Global);
}

async function toggleFollow(kind, id) {
  const f = follows();
  const key = kind === 'person' ? 'people' : 'sessions';
  f[key] = f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id];
  await ctx.globalState.update('follows', f);
}

async function buildState() {
  const offline = { running: false, hasTeam: false, teamInfo: null, members: [], mine: [], team: [], teamErrors: [], access: { viewers: [], reads: [] }, sharing: { paused: cfg().get('paused'), projects: [] }, checks: [] };
  const base = { follows: follows(), workspace: currentWorkspace() };
  if (!hubUp()) return { ...offline, ...base };
  const teamInfo = await api('/api/team').catch(() => null);
  if (!teamInfo) return { ...offline, ...base, running: true, starting: true };
  if (!teamInfo.hasTeam) return { ...offline, ...base, running: true, teamInfo };
  const since = cfg().get('listSince');
  // Cada dato por separado: si uno falla o tarda, el panel muestra el resto (y el error).
  const [members, mine, team, access, sharing, diag] = await Promise.allSettled([
    api('/api/peers'),
    api(`/api/sessions?since=${since}`),
    api(`/api/team/sessions?since=${since}`, { timeout: 25000 }),
    api('/api/access'),
    api('/api/sharing'),
    api('/api/diagnostics'),
  ]);
  const val = (r, dflt) => (r.status === 'fulfilled' ? r.value : dflt);
  const m = val(members, []);
  const sh = val(sharing, offline.sharing);
  const t = val(team, []);
  const loadErrors = [members, mine, team, access, sharing, diag].filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  return {
    ...base,
    running: true,
    hasTeam: true,
    teamInfo,
    members: m,
    mine: val(mine, []),
    team: t.filter((x) => x.id),
    teamErrors: [...t.filter((x) => x.error), ...[...new Set(loadErrors)].map((error) => ({ member: t('Panel'), error: t(error) }))],
    access: val(access, offline.access),
    sharing: { ...sh, projects: sh.projects.map((p) => ({ ...p, audience: audienceLabel(p.allow, m) })) },
    checks: diag.status === 'fulfilled' ? healthChecks(diag.value) : [{ status: 'error', label: 'No pude leer el estado del hub', hint: diag.reason.message }],
    networkIssues: diag.status === 'fulfilled' ? diag.value.networkIssues || [] : [],
  };
}

// Carpeta abierta y si ya está compartida, para ofrecer "Compartir este proyecto" en el panel.
function currentWorkspace() {
  const f = vscode.workspace.workspaceFolders?.[0];
  return f ? { name: f.name, path: f.uri.fsPath, shared: isShared(f.uri.fsPath) } : null;
}

// Comprobaciones con estado ok / warn / error y qué hacer en cada caso.
function healthChecks(d) {
  const out = [];
  const add = (status, label, hint = '') => out.push({ status, label: t(label), hint: t(hint) });
  const net = d.network;
  add(d.runtime.sqlite ? 'ok' : 'warn', t(d.runtime.electron ? 'Hub activo · Node {v1} (runtime del editor)' : 'Hub activo · Node {v1}', { v1: d.runtime.node }), d.runtime.sqlite ? '' : 'Sin SQLite: no se leerán sesiones de Cursor. Ajusta sessionHub.nodePath a un Node 22.5 o superior.');
  add('ok', `API local en 127.0.0.1:${d.api.port}`, 'Solo esta máquina puede usarla; tu IA se conecta aquí por MCP.');
  if (d.team.team?.pending) add('warn', 'Tu entrada al equipo está pendiente', `Quien te invitó (${d.team.team.invitedBy}) debe tener Session Hub abierto para confirmarla.`);
  if (!net.running) add('error', 'La conexión con el equipo no está activa', net.lastError || 'Reinicia el hub.');
  else {
    const where = net.network === 'lan' ? `red local, puerto UDP ${net.udpPort}` : net.network === 'private' ? `nodos propios (${net.bootstrap.join(', ') || 'sin configurar'})` : 'red pública';
    add(net.lastError ? 'warn' : 'ok', `Conexión cifrada con el equipo · ${where}`, net.lastError || '');
  }
  if (d.team.peersOnline) add('ok', `${d.team.peersOnline} de ${d.team.members} compañero(s) en línea`);
  else if (d.team.members) add('warn', `Ninguno de tus ${d.team.members} compañero(s) está en línea`, net.network === 'lan' ? `Si están en la oficina, revisa que el firewall permita UDP ${net.udpPort}. Tus direcciones: ${net.myAddrs.join(', ')}.` : 'Revisa la conexión a internet o los nodos de arranque.');
  else add('warn', 'Aún no hay más miembros', 'Invita a tus compañeros con "Invitar" (una invitación por persona).');
  if (net.rejections?.length) add('warn', `${net.rejections.length} conexión(es) rechazada(s) recientemente`, net.rejections.slice(0, 3).map((r) => `${r.fingerprint}: ${r.reason}`).join(' · '));
  if (!d.sharing.projects.length) add('warn', 'No compartes ningún proyecto', 'Tu equipo no ve nada tuyo. Usa "Compartir este proyecto".');
  for (const p of d.sharing.projects) {
    if (!p.exists) {
      add('error', `${p.name}: la carpeta no existe`, p.path);
      continue;
    }
    const total = (p.claude.sessions || 0) + (p.cursor.sessions || 0);
    const err = [p.claude.ok ? '' : `Claude Code: ${p.claude.error}`, p.cursor.ok ? '' : `Cursor: ${p.cursor.error}`].filter(Boolean).join(' · ');
    add(err ? 'warn' : 'ok', `${p.name}: ${p.claude.sessions || 0} de Claude Code, ${p.cursor.sessions || 0} de Cursor`, err || (total ? '' : 'Todavía no hay sesiones de IA en esta carpeta.'));
  }
  for (const x of d.networkIssues || []) add(x.severity === 'error' ? 'error' : 'warn', x.title, `${x.cause} ${x.fix}`);
  if (d.sharing.staleAllow?.length) add('warn', `Permisos de una versión anterior en: ${d.sharing.staleAllow.join(', ')}`, 'Vuelve a elegir "Quién lo ve": ahora los permisos van por persona verificada.');
  if (d.sharing.paused) add('warn', 'Compartir está en pausa', 'Nadie del equipo ve tus sesiones. Reanuda desde el panel.');
  add('ok', `Auditoría: ${d.audit.entries} registros (${d.audit.retentionDays} días)`, d.audit.file);
  return out;
}

async function runDoctor() {
  if (!hubUp()) {
    const pick = await warn('El hub está detenido.', 'Iniciar');
    if (pick === 'Iniciar') startHub();
    return;
  }
  try {
    const checks = healthChecks(await api('/api/diagnostics'));
    output.appendLine(`\n== ${t('Diagnóstico de Session Hub')} ==`);
    for (const c of checks) output.appendLine(`${{ ok: '✔', warn: '!', error: '✖' }[c.status]} ${c.label}${c.hint ? '\n    ' + c.hint : ''}`);
    output.appendLine(`MCP: ${t(vscode.cursor?.mcp ? 'registrado en Cursor' : vscode.lm?.registerMcpServerDefinitionProvider ? 'disponible en VS Code' : 'usa "Conectar Claude Code"')}`);
    const bad = checks.filter((c) => c.status !== 'ok');
    dashboard.show();
    const msg = bad.length ? `Diagnóstico: ${bad.length} punto(s) a revisar. Detalle en el panel y en la salida "Session Hub".` : 'Diagnóstico: todo en orden.';
    (bad.length ? warn : info)(msg, 'Ver salida').then((p) => p && output.show());
  } catch (err) {
    error(`No pude consultar el hub: ${err.message}`);
  }
}

function readMessage(r) {
  const who = `${r.who}${r.role ? ' (' + r.role + ')' : ''}`;
  const from =
    r.via === 'api' ? t('acceso directo sin identificarse') : r.client ? t(r.via === 'mcp' ? 'desde su IA en {v1}' : 'desde su panel en {v1}', { v1: r.client }) : t(r.via === 'mcp' ? 'desde su IA' : 'desde su panel');
  if (r.what === 'session') return t('👁 {v1} está leyendo tu sesión "{v2}" de {v3} — {v4}', { v1: who, v2: r.title, v3: r.project, v4: from });
  if (r.what === 'changes') return r.project ? t('👁 {v1} revisó tus novedades ({v2}) de {v3} — {v4}', { v1: who, v2: r.since, v3: r.project, v4: from }) : t('👁 {v1} revisó tus novedades ({v2}) — {v3}', { v1: who, v2: r.since, v3: from });
  if (r.what === 'search') return t('👁 {v1} buscó "{v2}" en tus sesiones — {v3}', { v1: who, v2: r.query, v3: from });
  if (r.what === 'denied') return t('⛔ {v1} intentó leer "{v2}" de {v3}, sin permiso — {v4}', { v1: who, v2: r.title, v3: r.project, v4: from });
  return t('👁 {v1} consultó tus sesiones — {v2}', { v1: who, v2: from });
}

let lastSeen = null; // sesiones del equipo: id -> updatedAt
let lastReadAt = ''; // fecha del último acceso ya avisado
const readNotified = new Map(); // quién+qué -> último aviso

// Cambiar de idioma: desde el panel (botón ES / EN) o con el comando. Con un argumento, lo aplica directo.
async function setLanguage(value) {
  const choice =
    typeof value === 'string'
      ? value
      : (
          await pick(
            [
              { label: 'Español', value: 'es' },
              { label: 'English', value: 'en' },
              { label: 'Idioma del editor', value: 'auto' },
            ],
            { placeHolder: 'Idioma de Session Hub' },
          )
        )?.value;
  if (choice) await cfg().update('language', choice, vscode.ConfigurationTarget.Global);
}

// Copia el informe de conexión: qué falla, por qué y qué pedirle a TI.
async function copyNetReport() {
  try {
    const r = await api('/api/netreport');
    await vscode.env.clipboard.writeText(r.text);
    info(r.issues.length ? 'Informe de conexión copiado. Pégalo en el chat o correo a TI o a tu equipo.' : 'Informe copiado: no se detectan problemas de red.');
  } catch (err) {
    error(`No pude generar el informe: ${err.message}`);
  }
}

const notifiedIssues = new Set();
function notifyNetworkIssues(checksSource) {
  for (const x of checksSource || []) {
    if (notifiedIssues.has(x.code)) continue;
    notifiedIssues.add(x.code);
    const show = x.severity === 'error' ? error : warn;
    show(`Session Hub: ${x.title}. ${x.cause}`, 'Copiar informe para TI', 'Ver detalle').then((p) => {
      if (p === 'Copiar informe para TI') copyNetReport();
      if (p === 'Ver detalle') dashboard.show();
    });
  }
}

let polling = false;
let healthFailures = 0;
let offeredRestart = false;

// Un solo sondeo a la vez: si uno tarda, el siguiente se salta en vez de acumularse.
async function pollUpdates() {
  if (polling) return;
  polling = true;
  try {
    await checkHealth();
    const state = await buildState();
    notifyTeamUpdates(state);
    notifyNetworkIssues(state.networkIssues);
    notifyReads(state.access.reads);
    if (dashboard.visible) dashboard.update(state);
    tree.refresh();
    updateStatus();
  } catch {
    updateStatus(); // refleja "sin respuesta" en la barra
  } finally {
    polling = false;
  }
}

// Vigilante: el proceso puede seguir vivo pero sin responder. Tras 3 fallos seguidos, se avisa.
async function checkHealth() {
  if (!hubUp()) return;
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    healthFailures = 0;
    offeredRestart = false;
  } catch (err) {
    // Estaba usando el hub de otra ventana y esa ventana se cerró: esta toma el relevo.
    if (attached && err.name !== 'TimeoutError') {
      attached = false;
      output.appendLine(t('[hub] la ventana que tenía el hub se cerró; esta ventana lo inicia.'));
      await startHub();
      throw new Error('relevo del hub');
    }
    healthFailures++;
    if (healthFailures >= 3 && !offeredRestart) {
      offeredRestart = true;
      const pick = await error('Session Hub no responde desde hace 30 s.', 'Reiniciar', 'Ver salida');
      if (pick === 'Reiniciar') restartHub();
      if (pick === 'Ver salida') output.show();
    }
    throw new Error('hub sin respuesta');
  }
}

// Avisa cuando un compañero avanza en una sesión. Si sigues a alguien, solo de lo que sigues.
function notifyTeamUpdates(state) {
  const f = state.follows;
  const now = new Map(state.team.map((s) => [s.id, s]));
  if (lastSeen && cfg().get('notifyUpdates')) {
    const following = f.people.length || f.sessions.length;
    const changed = [...now.values()].filter(
      (s) => lastSeen.get(s.id) !== s.updatedAt && (!following || f.people.includes(s.ownerId) || f.sessions.includes(s.id)),
    );
    if (changed.length) {
      const s = changed[0];
      const more = changed.length > 1 ? ` (+${changed.length - 1})` : '';
      info(`${s.owner} avanzó en "${s.title}" (${s.project})${more}`, 'Ver').then((p) => p && openSession({ session: s }));
    }
  }
  lastSeen = new Map([...now.values()].map((s) => [s.id, s.updatedAt]));
}

// Avisa cuando alguien del equipo lee mis sesiones.
function notifyReads(reads) {
  const fresh = reads.filter((r) => r.at > lastReadAt);
  if (fresh.length) lastReadAt = fresh[0].at;
  if (!cfg().get('notifyReads')) return;
  for (const r of fresh.reverse()) {
    const key = `${r.whoId}|${r.what}|${r.sessionId || r.query || r.since || ''}`;
    if (Date.now() - (readNotified.get(key) || 0) < READ_NOTIFY_COOLDOWN_MS) continue;
    readNotified.set(key, Date.now());
    (r.what === 'denied' ? warn : info)(readMessage(r), 'Abrir panel').then((p) => p && dashboard.show());
  }
}

async function updateStatus() {
  if (!hubUp()) {
    statusItem.text = '$(debug-disconnect) Session Hub';
    statusItem.tooltip = t('Detenido');
    statusItem.backgroundColor = undefined;
  } else if (healthFailures >= 3) {
    statusItem.text = `$(error) ${t('Session Hub sin respuesta')}`;
    statusItem.tooltip = t('El hub no responde. Clic para abrir el panel.');
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    let n = 0;
    try {
      n = (await api('/api/peers')).filter((m) => !m.self && m.online).length;
    } catch {}
    const shared = sharedList().length;
    const paused = cfg().get('paused');
    statusItem.text = paused ? `$(debug-pause) ${t('Session Hub en pausa')} · ${n}` : `$(broadcast) Session Hub · ${n} · ${t(shared === 1 ? '{v1} compartido' : '{v1} compartidos', { v1: shared })}`;
    statusItem.backgroundColor = paused ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    statusItem.tooltip = [t('{v1} compañero(s) en línea', { v1: n }), paused ? t('En pausa: nadie ve tus sesiones') : t('Compartes {v1} proyecto(s)', { v1: shared }), t('Clic para abrir el panel')].join('\n');
  }
  statusItem.show();
}

// ---------- panel lateral ----------

class TeamTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() {
    this.emitter.fire();
  }
  getTreeItem(el) {
    return el.item;
  }
  async getChildren(el) {
    if (!hubUp()) return [];
    try {
      if (!el) {
        const members = await api('/api/peers');
        return members.map((m) => {
          const item = new vscode.TreeItem(m.self ? `${m.name} (${t('tú')})` : m.name, vscode.TreeItemCollapsibleState[m.self ? 'Collapsed' : 'Expanded']);
          item.description = [m.role, m.online ? '' : t('desconectado')].filter(Boolean).join(' · ');
          item.tooltip = `${t('Proyectos')}: ${m.projects.join(', ') || t('ninguno')}`;
          item.iconPath = new vscode.ThemeIcon(m.self ? 'account' : m.online ? 'person' : 'circle-slash');
          item.contextValue = 'member';
          return { item, member: m };
        });
      }
      if (el.member) {
        const since = cfg().get('listSince');
        const sessions = await api(`/api/sessions?peer=${encodeURIComponent(el.member.id)}&since=${since}&limit=40`);
        if (!sessions.length) return [{ item: new vscode.TreeItem(t('Sin sesiones en {v1}', { v1: since })) }];
        return sessions.map((s) => {
          const item = new vscode.TreeItem(s.title);
          item.description = `${s.project} · ${ago(s.updatedAt)}${s.hidden ? ` · ${t('oculta al equipo')}` : ''}`;
          item.tooltip = new vscode.MarkdownString(
            `**${s.title}**\n\n${s.source} · ${s.project}${s.branch ? ' · `' + s.branch + '`' : ''}\n\n${s.messages} mensajes · ${s.filesChanged.length} archivos`,
          );
          item.iconPath = new vscode.ThemeIcon(s.source === 'cursor' ? 'symbol-event' : 'terminal');
          item.command = { command: 'sessionHub.openSession', title: 'Abrir', arguments: [{ session: s, member: el.member }] };
          return { item, session: s };
        });
      }
    } catch (err) {
      return [{ item: new vscode.TreeItem(`Error: ${t(err.message)}`) }];
    }
    return [];
  }
}

function ago(isoDate) {
  const min = Math.round((Date.now() - Date.parse(isoDate)) / 60000);
  if (min < 60) return t('hace {v1} min', { v1: min });
  if (min < 1440) return t('hace {v1} h', { v1: Math.round(min / 60) });
  return t('hace {v1} d', { v1: Math.round(min / 1440) });
}

async function openSession(arg) {
  const s = arg?.session;
  if (!s) return;
  const panel = vscode.window.createWebviewPanel('sessionHub.session', `${s.owner}: ${s.title}`, vscode.ViewColumn.Active, {});
  const load = async () => {
    const peer = s.ownerId || arg.member?.id || s.owner;
    panel.webview.html = renderSession(t, await api(`/api/sessions/${encodeURIComponent(s.id)}?peer=${encodeURIComponent(peer)}&full=1`, { timeout: 60000 }));
  };
  try {
    await load();
  } catch (err) {
    panel.webview.html = `<p>Error: ${err.message}</p>`;
  }
}

async function whatChanged(el) {
  const member = el?.member;
  const since = await pick(['2h', '24h', '3d', '7d'], { placeHolder: 'Desde cuándo' });
  if (!since) return;
  const who = member ? member.name : 'el equipo';
  const panel = vscode.window.createWebviewPanel('sessionHub.changes', t('Novedades de {v1}', { v1: t(who) }), vscode.ViewColumn.Active, {});
  try {
    const q = member ? `peer=${encodeURIComponent(member.id)}&` : '';
    const data = member ? [await api(`/api/changes?${q}since=${since}`)] : await teamChanges(since);
    panel.webview.html = renderChanges(t, data, t(who));
  } catch (err) {
    panel.webview.html = `<p>Error: ${err.message}</p>`;
  }
}

async function teamChanges(since) {
  const res = await api(`/api/team/changes?since=${since}`);
  return res.map((r) => r.data || { owner: r.member, error: r.error, sessions: [] });
}

// ---------- MCP ----------

function registerMcp() {
  // VS Code (Copilot/agent mode)
  if (vscode.lm?.registerMcpServerDefinitionProvider && vscode.McpHttpServerDefinition) {
    ctx.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('sessionHub.mcp', {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        provideMcpServerDefinitions: () =>
          hubUp() && token
            ? [new vscode.McpHttpServerDefinition('Session Hub', vscode.Uri.parse(`${base()}/mcp`), { Authorization: `Bearer ${token}` }, '0.2.0')]
            : [],
      }),
    );
  }
  ctx.subscriptions.push({ dispose: () => vscode.cursor?.mcp?.unregisterServer?.(MCP_NAME) });
}

// Cursor
function registerCursorMcp() {
  const api = vscode.cursor?.mcp;
  if (!api?.registerServer || !hubUp()) return;
  try {
    api.unregisterServer?.(MCP_NAME);
  } catch {}
  api.registerServer({ name: MCP_NAME, server: { url: `${base()}/mcp`, headers: { Authorization: `Bearer ${token}` } } });
  output.appendLine(t('[mcp] registrado en Cursor como "session-hub"'));
}

async function copyClaudeCommand() {
  const cmd = `claude mcp add --transport http --scope user ${MCP_NAME} ${base()}/mcp --header "Authorization: Bearer ${token}"`;
  await vscode.env.clipboard.writeText(cmd);
  info('Comando para Claude Code copiado. Pégalo en una terminal.');
}

module.exports = { activate, deactivate };
