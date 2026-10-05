// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Panel principal (webview): mis sesiones, las del equipo, lo que sigo, personas y quién me ha leído.
const vscode = require('vscode');
const crypto = require('node:crypto');
const EN = require('../locales/en.json');
const HELP = require('../locales/help.json');

// Comandos que el panel puede pedir (los que emite media/dashboard.js) y cómo validar sus argumentos.
// Defensa en profundidad: aunque se colara HTML de un compañero en el panel, no podría ejecutar
// comandos arbitrarios ni actuar sobre ids que el panel no está mostrando.
const ids = (list, key = 'id') => new Set((list || []).map((x) => x && x[key]).filter((x) => typeof x === 'string'));
const known = (pick) => (args, st) => args.length >= 1 && typeof args[0] === 'string' && pick(st).has(args[0]);
const optional = (pick) => (args, st) => args.length === 0 || args[0] == null || known(pick)(args, st);
const none = (args) => args.length === 0;
const memberIds = (st) => ids((st.members || []).filter((m) => !m.self));
const convIds = (st) => ids(st.conversations);
const msgIds = (st) => ids(st.inbox?.received);
// Una sesión que el panel muestra: mías, del equipo, del respaldo, copias o la abierta en el detalle.
const sessionIds = (st, detail) => new Set([...ids(st.mine), ...ids(st.team), ...ids(st.archive?.own?.list), ...ids(st.archive?.copies?.list), ...(detail?.id ? [detail.id] : [])]);
const BACKUP_TOGGLES = ['archive', 'teamCopies', 'allowCopies'];
const BACKUP_NUMBERS = ['archiveRetentionDays', 'copiesRetentionDays', 'archiveMaxMB'];
const PANEL_COMMANDS = {
  ...Object.fromEntries(
    ['whatChanged', 'togglePause', 'copyInvite', 'openSource', 'leaveTeam', 'shareWorkspace', 'doctor', 'copyNetReport', 'copyClaudeCommand', 'syncBackup', 'exportAll', 'purgeOwnBackup', 'restoreIgnoredBackup', 'installHooks', 'removeHooks', 'createTeam', 'joinTeam', 'start'].map((c) => [c, none]),
  ),
  setLanguage: (args) => args.length === 1 && ['es', 'en'].includes(args[0]),
  sendMessage: optional(memberIds),
  startConversation: optional(memberIds),
  blockMember: known(memberIds),
  revokeMember: known(memberIds),
  confirmConversation: known(convIds),
  acceptConversation: known(convIds),
  declineConversation: known(convIds),
  endConversation: known(convIds),
  handoffMessage: known(msgIds),
  approveMessage: known(msgIds),
  replyMessage: known(msgIds),
  dismissMessage: known(msgIds),
  toggleSessionVisibility: known((st) => ids(st.mine)),
  editProjectAccess: known((st) => ids(st.sharing?.projects, 'path')),
  unshareProject: known((st) => ids(st.sharing?.projects, 'path')),
  setBackupOption: (args) => args.length === 2 && BACKUP_TOGGLES.includes(args[0]) && typeof args[1] === 'boolean',
  editBackupNumber: (args) => args.length === 1 && BACKUP_NUMBERS.includes(args[0]),
  purgeCopies: (args, st) => args.length === 0 || (typeof args[0] === 'string' && ids(st.archive?.copies?.owners).has(args[0])),
  exportSession: (args, st, detail) => typeof args[0] === 'string' && sessionIds(st, detail).has(args[0]),
  // [id, dueño, título, origen, projectKey, proyecto, rama]: todo texto (lo de proyecto solo se muestra y compara).
  useSessionInAi: (args, st, detail) => typeof args[0] === 'string' && sessionIds(st, detail).has(args[0]) && args.every((a) => a == null || typeof a === 'string'),
  // [id]: solo sesiones mías.
  continueSessionInAi: known((st) => ids(st.mine)),
  removeFromBackup: (args, st, detail) => typeof args[0] === 'string' && sessionIds(st, detail).has(args[0]),
};

// ¿Puede el panel pedir este comando con estos argumentos? (exportado para las pruebas)
function allowedCommand(command, args, state, detail) {
  if (typeof command !== 'string' || !command.startsWith('sessionHub.')) return false;
  const check = Object.hasOwn(PANEL_COMMANDS, command.slice('sessionHub.'.length)) && PANEL_COMMANDS[command.slice('sessionHub.'.length)];
  if (!check || !Array.isArray(args) || args.length > 7) return false;
  return !!check(args, state || {}, detail);
}

class Dashboard {
  constructor(ctx, handlers) {
    this.ctx = ctx;
    this.handlers = handlers; // { getState, openSession, toggleFollow, lang }
    this.panel = null;
    this.state = null; // último estado enviado al panel (para validar sus pedidos)
    this.detail = null; // última sesión abierta en el detalle
  }

  get visible() {
    return !!this.panel;
  }

  // view: 'sessions' | 'messages' | 'team' | 'privacy' | 'status' (opcional)
  async show(view) {
    if (this.panel) {
      this.panel.reveal();
      if (view) this.post({ type: 'view', view });
      return;
    }
    this.pendingView = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('sessionHub.dashboard', 'Session Hub', vscode.ViewColumn.Active, {
      enableScripts: true,
      enableCommandUris: ['workbench.action.openSettings'], // solo los enlaces a ajustes (ver dashboard.js)
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'logo.svg');
    this.panel.onDidDispose(() => (this.panel = null));
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.webview.html = this.html(media);
  }

  async onMessage(m) {
    try {
      if (m.type === 'ready' || m.type === 'refresh') {
        this.update(await this.handlers.getState());
        if (m.type === 'ready' && this.pendingView) this.post({ type: 'view', view: this.pendingView });
        this.pendingView = null;
        return;
      }
      if (m.type === 'open') {
        this.detail = await this.handlers.openSession(m.id, m.peer);
        return this.post({ type: 'session', data: this.detail });
      }
      if (m.type === 'follow') {
        if (!['session', 'person'].includes(m.kind) || typeof m.id !== 'string') return;
        await this.handlers.toggleFollow(m.kind, m.id);
        return this.update(await this.handlers.getState());
      }
      // El panel solo puede pedir los comandos de Session Hub que muestra, con ids que conoce; los del
      // editor que devuelven objetos grandes (p. ej. abrir ajustes) congelarían la ventana al serializar.
      if (m.type === 'command') {
        const args = m.args || [];
        if (!allowedCommand(m.command, args, this.state, this.detail)) return;
        return vscode.commands.executeCommand(m.command, ...args);
      }
    } catch (err) {
      this.post({ type: 'error', error: err.message, context: m.type });
    }
  }

  update(state) {
    this.state = state;
    this.post({ type: 'state', state: { ...state, lang: this.handlers.lang() } });
  }

  post(msg) {
    this.panel?.webview.postMessage(msg);
  }

  html(media) {
    const w = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => w.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('dashboard.css')}"><title>Session Hub</title></head>
<body><div id="app"></div>
<script nonce="${nonce}">window.SESSION_HUB_DICT = ${JSON.stringify(EN).replace(/</g, '\\u003c')};</script>
<script nonce="${nonce}">window.SESSION_HUB_HELP = ${JSON.stringify(HELP).replace(/<\//g, '<\\/')};</script>
<script nonce="${nonce}" src="${uri('i18n.js')}"></script>
<script nonce="${nonce}" src="${uri('dashboard.js')}"></script></body></html>`;
  }
}

module.exports = { Dashboard, allowedCommand };
