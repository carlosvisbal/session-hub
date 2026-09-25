// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Banco de pruebas de la extensión: un `vscode` simulado (lo justo que usa la extensión) y hubs reales.
// Cada "ventana" carga la extensión de cero; el registro MCP de Cursor y el globalState se comparten
// entre ventanas, como en el editor real.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const ok = (m) => console.log('✔', m);

export async function until(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(400)) if (await fn().catch(() => false)) return;
  throw new Error(`No se cumplió a tiempo: ${what}`);
}

// Hubs reales en este equipo (modo lan), con el historial sintético de las pruebas.
export async function startHubs(fixture, specs) {
  const procs = {};
  const people = {};
  for (const [who, p] of Object.entries(specs)) {
    const dir = path.join(fixture.root, who);
    fs.mkdirSync(dir, { recursive: true });
    people[who] = { ...p, dir, cfg: path.join(dir, 'config.json') };
    fs.writeFileSync(people[who].cfg, JSON.stringify({ localToken: 't', network: 'lan', language: 'es', claudeDir: fixture.claudeDir, cursorUserDir: fixture.cursorUserDir, ...p }));
    procs[who] = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src/server.js')], { env: { ...process.env, SESSION_HUB_CONFIG: people[who].cfg }, stdio: 'ignore' });
  }
  const call = async (who, method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${people[who].port}${route}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  };
  for (const who of Object.keys(people)) await until(async () => (await call(who, 'GET', '/health')).ok, 15000, `hub de ${who}`);
  return { procs, people, call, stop: () => Object.values(procs).forEach((p) => p.kill('SIGTERM')) };
}

export async function makeTeam(call, founder, joiner) {
  await call(founder, 'POST', '/api/team/create', { name: 'e2e' });
  await call(joiner, 'POST', '/api/team/join', { code: (await call(founder, 'POST', '/api/team/invite', {})).code });
  await until(async () => !(await call(joiner, 'GET', '/api/team')).team.pending, 30000, 'admisión');
}

// Estado compartido por todas las ventanas del "editor".
export function createEditor({ appName = 'Visual Studio Code', settings = {}, storage, token = 't' }) {
  const shared = {
    appName,
    token, // token local de este editor (cada editor guarda el suyo)
    settings: { autoStart: false, notifyUpdates: false, notifyReads: false, notifyMessages: true, listSince: 'all', inboundMessages: 'hold', language: 'es', peers: [], redactExtra: [], excludedSessions: [], sharedProjects: [], paused: false, aiChat: 'auto', ...settings },
    gstate: new Map(),
    notices: [], // { kind, m, buttons }
    executed: [], // comandos ejecutados { id, a }
    answer: null, // botón que "pulsa" la persona en el próximo aviso
    quickPick: (items) => items[0],
    inputValue: null,
    commands: ['workbench.action.chat.open'],
    tabs: [],
    save: null,
    open: null,
    clipboard: '',
    cursorRegistry: new Map(), // registro MCP de Cursor: uno para todas las ventanas
    cursorCalls: [],
  };
  const cursorMcp = {
    registerServer: async (c) => {
      shared.cursorCalls.push('register');
      if (!shared.cursorRegistry.has(c.name)) shared.cursorRegistry.set(c.name, c.server.url);
    },
    unregisterServer: async (name) => {
      shared.cursorCalls.push('unregister');
      await wait(30);
      shared.cursorRegistry.delete(name);
    },
  };

  function makeVscode(cmds) {
    class EventEmitter {
      constructor() {
        this.l = [];
        this.event = (fn) => (this.l.push(fn), { dispose() {} });
      }
      fire(...a) {
        this.l.forEach((fn) => fn(...a));
      }
    }
    const notify = (kind) => async (m, ...rest) => {
      const buttons = rest.filter((x) => typeof x === 'string');
      shared.notices.push({ kind, m, buttons });
      // "Pulsa" el botón indicado solo en el aviso que lo tiene (como haría una persona).
      const a = shared.answer;
      if (!a || !buttons.includes(a)) return undefined;
      shared.answer = null;
      return a;
    };
    const vscode = {
      EventEmitter,
      StatusBarAlignment: { Left: 1 },
      ConfigurationTarget: { Global: 1 },
      ViewColumn: { Active: 1 },
      ProgressLocation: { Notification: 15 },
      TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 },
      TreeItem: class {
        constructor(l) {
          this.label = l;
        }
      },
      ThemeIcon: class {},
      ThemeColor: class {},
      MarkdownString: class {},
      McpHttpServerDefinition: class {},
      Uri: { parse: (u) => ({ u }), file: (p) => ({ fsPath: p }), joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p) }) },
      lm: { registerMcpServerDefinitionProvider: () => ({ dispose() {} }) },
      window: {
        tabGroups: {
          get all() {
            return shared.tabs;
          },
        },
        createOutputChannel: () => (process.env.SHUB_TEST_OUTPUT ? { append: (x) => process.stderr.write(x), appendLine: (x) => process.stderr.write(x + '\n'), show() {}, dispose() {} } : { append() {}, appendLine() {}, show() {}, dispose() {} }), // SHUB_TEST_OUTPUT=1 muestra la salida
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
        registerTreeDataProvider: () => ({ dispose() {} }),
        showInformationMessage: notify('info'),
        showWarningMessage: notify('warn'),
        showErrorMessage: notify('error'),
        showQuickPick: async (items) => shared.quickPick(items),
        showInputBox: async () => shared.inputValue,
        showSaveDialog: async () => shared.save,
        showOpenDialog: async () => shared.open,
        withProgress: async (o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
        createWebviewPanel: () => ({ reveal() {}, onDidDispose() {}, webview: { onDidReceiveMessage() {}, postMessage() {}, asWebviewUri: (u) => u, cspSource: '' } }),
      },
      workspace: {
        getConfiguration: () => ({ get: (k) => shared.settings[k], update: async (k, v) => (shared.settings[k] = v) }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
      },
      commands: {
        registerCommand: (id, fn) => ((cmds[id] = fn), { dispose() {} }),
        getCommands: async () => shared.commands,
        executeCommand: async (id, ...a) => (shared.executed.push({ id, a }), cmds[id]?.(...a)),
      },
      env: {
        get appName() {
          return shared.appName;
        },
        language: 'es',
        clipboard: { writeText: async (s) => (shared.clipboard = s) },
        openExternal() {},
      },
    };
    if (/cursor/i.test(shared.appName)) vscode.cursor = { mcp: cursorMcp };
    return vscode;
  }

  const Module = require('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...a) {
    return req === 'vscode' ? 'vscode' : orig.call(this, req, ...a);
  };

  // Una ventana del editor: carga la extensión desde cero y la conecta al hub del puerto configurado.
  async function openWindow() {
    const cmds = {};
    require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: makeVscode(cmds) };
    for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'extension') + path.sep)) delete require.cache[k];
    const ext = require(path.join(ROOT, 'extension', 'extension.cjs'));
    const subscriptions = [];
    await ext.activate({
      subscriptions,
      extensionPath: ROOT,
      extensionUri: { fsPath: ROOT },
      globalStorageUri: { fsPath: storage },
      secrets: { get: async () => shared.token, store: async () => {} },
      globalState: { get: (k, d) => (shared.gstate.has(k) ? shared.gstate.get(k) : d), update: async (k, v) => shared.gstate.set(k, v) },
    });
    await cmds['sessionHub.start']();
    await wait(2500); // se conecta al hub y hace el primer sondeo
    return {
      cmds,
      close() {
        subscriptions.forEach((s) => s.dispose?.());
        ext.deactivate();
      },
    };
  }

  return { shared, openWindow };
}

export const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
