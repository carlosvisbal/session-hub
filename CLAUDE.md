# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Session Hub is a VS Code / Cursor extension plus a Node.js "hub" process that shares Claude Code and Cursor sessions peer-to-peer (Hyperswarm + Noise) between team members, with an MCP server built in. There is no central server and no build step: plain ESM in `src/`, CommonJS in `extension/` and `media/`.

`docs/ARCHITECTURE.md` is the authoritative technical reference (module table, wire protocol, storage files, timeouts, security invariants). Read it before touching networking, identity, backup, or conversations, and keep it updated when behavior changes.

## Commands

Requires Node >= 22.5 (uses `node:sqlite`; CI runs Node 22 on Linux, macOS, Windows).

```bash
npm ci
npm test                                   # unit tests: node --test test/*.test.js
node --test test/hub.test.js               # one test file
node --test --test-name-pattern="<regex>" test/hub.test.js   # one test by name
npm run test:e2e                           # real hubs on this machine (two-hubs, relay, backup, conversation)
npm run test:ext                           # panel in jsdom + real extension against a simulated `vscode`
node test/extension/flows.mjs              # any single e2e/ext script runs on its own
npm run licenses                           # regenerates THIRD_PARTY_NOTICES.md; fails on AGPL-incompatible deps (run in CI)
npm start                                  # run a hub from the terminal (config via SESSION_HUB_CONFIG, default ./config.json)
npm run setup -- --name Ana --role frontend /path/to/project=my-api
npm run setup -- team create "dev-team"    # or: team join SH2-…
npm run infra -- --host 203.0.113.10       # bootstrap nodes + blind relay for private/remote mode
npm run package                            # vsce package -> .vsix
```

The e2e suite includes an upgrade test that starts a real hub from an older git tag, so it needs tags fetched (`fetch-depth: 0` in CI).

## Architecture in brief

- **Layers inside the hub** (`src/server.js` entry): local HTTP API + MCP on 127.0.0.1 only (token-protected) → `team.js` orchestrator (fans out to teammates in parallel, merges and labels results) → `hub.js` (owner's data, ACLs, exclusions, pause, paging, search) → `sources/claude.js` and `sources/cursor.js` (read-only readers of `~/.claude/projects/*.jsonl` and Cursor's `state.vscdb`). Peer traffic goes through `transport/swarm.js` (connections, handshake, gossip) and `transport/rpc.js` (line-delimited JSON RPC).
- **Remote requests are always answered by the owner's hub with the owner's rules**, evaluated against the verified peer key from the Noise connection. Everything leaving the hub passes through `redact()`.
- **Identity** (`identity.js`, `teamstate.js`): Ed25519 keys; team membership is a signed certificate chain rooted at the founder (invite → member → admit). Signatures cover canonical JSON with sorted keys.
- **Project identity** (`projectkey.js`): two results are the same project only when their `projectKey` matches (hash of normalized git origin). A Claude Code session belongs to its `cwd`, not the encoded history folder name.
- **Search index** (`searchindex.js`, SQLite FTS5) is only an accelerator. Permissions and redaction are applied after querying it.
- **Extension** (`extension/extension.cjs`, the large file): spawns or attaches to the hub, registers MCP, drives the tree view and the dashboard webview (`media/dashboard.js`). Since 0.10 there is **one hub per computer** shared by all editors, with data in `~/.session-hub/hub/` (override with `SESSION_HUB_DATA_DIR`); `extension/machine.cjs` handles discovery, locking, and migration from older per-editor storage. A hub is only replaced by a newer extension version.
- The hub runs on the editor's own Electron runtime (`ELECTRON_RUN_AS_NODE`) and falls back to the system Node when native modules can't load there.
- **Automatic conversations** rely on `extension/hook/session-hub-hook.cjs`, installed as a Claude Code `Stop` hook and a Cursor `stop` hook. It long-polls `POST /api/hook/stop` on the local hub and must return `{}` on any error so the agent simply stops.
- **Invariant: nothing waits without a deadline.** Every RPC, handshake, and HTTP call has a timeout (see the table in ARCHITECTURE.md).

## Internationalization

- Source strings are written **in Spanish**. `locales/en.json` maps each Spanish string or template (`{v1}`, `{v2}` placeholders) to English, and `media/i18n.js` is the shared translator for hub, extension, and panel.
- `test/i18n.test.js` tokenizes the listed source files with acorn and fails if any user-visible Spanish string lacks an English entry. Add the translation to `locales/en.json` whenever you add or change UI, notification, MCP, or log text.
- Extension manifest strings live in `package.nls.json` (English) and `package.nls.es.json`. In-app help is in `locales/help.json` (both languages). User docs come in pairs (`README.md`/`README.es.md`, `docs/*.md`/`docs/*.es.md`) and should be kept in sync.

## Conventions

- Code comments and UI text in Spanish; identifiers in English. Match the surrounding style.
- Every new file starts with:
  ```js
  // SPDX-License-Identifier: AGPL-3.0-or-later
  // Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
  ```
- Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`), written in Spanish, signed off with DCO (`git commit -s`).
- Changes go into `CHANGELOG.md` (Spanish, Keep a Changelog format).
- Never use real Cursor or Claude Code histories as test data; tests use synthetic fixtures from `test/fixtures.js`.
- Data files the hub writes (`config.json`, `team.json`, `inbox.json`, archives, etc.) are mode 0600 with atomic writes; preserve that when adding new ones.
