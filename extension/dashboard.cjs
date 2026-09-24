// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Panel principal (webview): mis sesiones, las del equipo, lo que sigo, personas y quién me ha leído.
const vscode = require('vscode');
const crypto = require('node:crypto');
const EN = require('../locales/en.json');

class Dashboard {
  constructor(ctx, handlers) {
    this.ctx = ctx;
    this.handlers = handlers; // { getState, openSession, toggleFollow, lang }
    this.panel = null;
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
      if (m.type === 'open') return this.post({ type: 'session', data: await this.handlers.openSession(m.id, m.peer) });
      if (m.type === 'follow') {
        await this.handlers.toggleFollow(m.kind, m.id);
        return this.update(await this.handlers.getState());
      }
      if (m.type === 'command') return vscode.commands.executeCommand(m.command, ...(m.args || []));
    } catch (err) {
      this.post({ type: 'error', error: err.message, context: m.type });
    }
  }

  update(state) {
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
<script nonce="${nonce}" src="${uri('i18n.js')}"></script>
<script nonce="${nonce}" src="${uri('dashboard.js')}"></script></body></html>`;
  }
}

module.exports = { Dashboard };
