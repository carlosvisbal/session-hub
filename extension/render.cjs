// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// HTML de los paneles (webview). Usa las variables de tema del editor, así se ve bien en claro y oscuro.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const when = (s) => (s ? new Date(s).toLocaleString() : '');

const page = (body) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 20px 40px; line-height: 1.5 }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px }
  .msg { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 14px; margin: 10px 0; white-space: pre-wrap; word-break: break-word }
  .msg.user { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground) }
  .acts { margin-top: 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-descriptionForeground) }
  code, pre { font-family: var(--vscode-editor-font-family); font-size: 12px }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground) }
  h2 { margin-bottom: 4px } h3 { margin: 18px 0 4px }
  .err { color: var(--vscode-errorForeground) }
</style></head><body>${body}</body></html>`;

function renderSession(t, s) {
  return page(`<h2>${esc(s.title)}</h2>
    <p class="meta"><b>${esc(s.owner)}</b> · <span class="badge">${esc(s.source)}</span> ${esc(s.project)}
      ${s.branch ? ` · ${t('rama')} <code>${esc(s.branch)}</code>` : ''} · ${t('{v1} mensajes', { v1: s.messages })} · ${t('actualizada {v1}', { v1: when(s.updatedAt) })}</p>
    ${s.filesChanged.length ? `<details><summary>${t('Archivos modificados ({v1})', { v1: s.filesChanged.length })}</summary><pre>${s.filesChanged.map(esc).join('\n')}</pre></details>` : ''}
    ${s.omittedMessages ? `<p class="meta">${t('({v1} mensajes anteriores omitidos)', { v1: s.omittedMessages })}</p>` : ''}
    ${s.conversation
      .map(
        (m) => `<div class="msg ${m.role}"><div class="meta">${m.role === 'user' ? esc(s.owner) : t('IA')} · ${when(m.at)}</div>${esc(m.text)}${
          m.actions.length ? '<div class="acts">' + m.actions.map((a) => (a.kind === 'edit' ? '✎ ' : '$ ') + esc(a.target)).join('<br>') + '</div>' : ''
        }</div>`,
      )
      .join('')}`);
}

function renderChanges(t, list, who) {
  const blocks = list.map((c) => {
    if (c.error) return `<h3>${esc(c.owner)}</h3><p class="err">${esc(c.error)}</p>`;
    if (!c.sessions.length) return `<h3>${esc(c.owner)}</h3><p class="meta">${t('Nada nuevo.')}</p>`;
    return `<h3>${esc(c.owner)}</h3>` + c.sessions
      .map(
        (s) => `<div class="msg"><b>${esc(s.title)}</b> <span class="badge">${esc(s.source)}</span>
          <div class="meta">${esc(s.project)}${s.branch ? ' · <code>' + esc(s.branch) + '</code>' : ''} · ${when(s.updatedAt)}</div>
          ${s.requests.length ? `<p><b>${t('Se pidió:')}</b></p><ul>` + s.requests.map((r) => `<li>${esc(r)}</li>`).join('') + '</ul>' : ''}
          ${s.filesChanged.length ? `<p><b>${t('Archivos ({v1}):', { v1: s.filesChanged.length })}</b></p><pre>${s.filesChanged.map(esc).join('\n')}</pre>` : ''}
          ${s.lastAssistantMessage ? `<p><b>${t('Último estado según la IA:')}</b></p>${esc(s.lastAssistantMessage)}` : ''}
        </div>`,
      )
      .join('');
  });
  return page(`<h2>${t('Novedades de {v1}', { v1: esc(who) })}</h2>${blocks.join('') || `<p class="meta">${t('No hay compañeros en línea.')}</p>`}`);
}

module.exports = { renderSession, renderChanges };
