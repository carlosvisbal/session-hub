// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Cliente del panel. Recibe el estado de la extensión y pide sesiones por postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let state = null;
  let ui = { tab: saved.tab || 'team', filter: '', person: saved.person || '', selected: null, detail: null, loading: false, error: null };

  const $app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ago = (iso) => {
    if (!iso) return '';
    const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.round(min / 60)} h`;
    return `hace ${Math.round(min / 1440)} d`;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const persist = () => vscode.setState({ tab: ui.tab, person: ui.person });
  const cmd = (command, label, cls = '', args) =>
    `<button class="${cls}" data-cmd="${command}"${args ? ` data-args="${esc(JSON.stringify(args))}"` : ''}>${label}</button>`;
  const srcLabel = (s) => (s.source === 'cursor' ? 'Cursor' : 'Claude Code');
  const me = () => state.members.find((m) => m.self) || {};

  // Misma frase que la notificación: quién, qué, de qué proyecto y desde dónde.
  function readSentence(r) {
    const who = `<b>${esc(r.who)}</b>${r.role ? ` <span class="muted">(${esc(r.role)})</span>` : ''}`;
    const from = r.via === 'api' ? '<span class="err">acceso directo sin identificarse</span>' : `${r.via === 'mcp' ? 'desde su IA' : 'desde su panel'}${r.client ? ' en ' + esc(r.client) : ''}`;
    if (r.what === 'session') return `${who} leyó <b>${esc(r.title)}</b> de <b>${esc(r.project)}</b> · ${from}`;
    if (r.what === 'changes') return `${who} revisó tus novedades (${esc(r.since)})${r.project ? ' de <b>' + esc(r.project) + '</b>' : ''} · ${from}`;
    if (r.what === 'search') return `${who} buscó <b>“${esc(r.query)}”</b> en tus sesiones · ${from}`;
    if (r.what === 'rejected') return `<span class="err">⛔</span> Conexión rechazada de <b>${esc(r.who.replace('Clave desconocida ', ''))}</b>: ${esc(r.reason)}`;
    if (r.what === 'denied') return `<span class="err">⛔</span> ${who} intentó leer <b>${esc(r.title)}</b> de <b>${esc(r.project)}</b> <span class="err">sin permiso</span> · ${from}`;
    return `${who} ${esc(r.what)}`;
  }

  const readersOf = (sessionId) => {
    const names = new Map();
    for (const r of state.access.reads) if (r.sessionId === sessionId && r.what === 'session' && !names.has(r.whoId)) names.set(r.whoId, r);
    return [...names.values()];
  };

  const isFollowed = (s) => state.follows.sessions.includes(s.id) || state.follows.people.includes(s.ownerId);

  function sessionsForTab() {
    let list =
      ui.tab === 'mine' ? state.mine : ui.tab === 'following' ? state.team.filter(isFollowed) : state.team.filter((s) => !ui.person || s.ownerId === ui.person);
    const q = ui.filter.trim().toLowerCase();
    if (q) list = list.filter((s) => [s.title, s.project, s.owner, s.branch, ...(s.filesChanged || [])].join(' ').toLowerCase().includes(q));
    return list;
  }

  // ---------- pantallas ----------

  function welcomeHtml() {
    return `<div class="welcome">
      <h1>Session Hub</h1>
      <p>Comparte con tu equipo, en la red local, lo que haces con Claude Code y Cursor: quién pidió qué, qué archivos cambiaron y en qué quedó. Tu IA también puede consultarlo.</p>
      <ol>
        <li><b>Crea un equipo</b> o <b>únete</b> con la invitación de un compañero.</li>
        <li><b>Comparte un proyecto</b> y elige quién lo ve.</li>
        <li>Mira las sesiones del equipo aquí o pregúntale a tu IA: <i>“¿qué cambió hoy en el backend?”</i>.</li>
      </ol>
      <div class="actions">${cmd('sessionHub.createTeam', 'Crear equipo', 'primary')}${cmd('sessionHub.joinTeam', 'Unirme con una invitación')}</div>
      <p class="muted small">Nada se comparte hasta que tú lo eliges. Puedes ocultar sesiones o pausar en cualquier momento.</p>
    </div>`;
  }

  function render() {
    if (!state) return;
    if (!state.running) return ($app.innerHTML = `<div class="welcome"><h1>Session Hub</h1><p class="err">El hub está detenido.</p><div class="actions">${cmd('sessionHub.start', 'Iniciar', 'primary')}${cmd('sessionHub.doctor', 'Diagnóstico')}</div></div>`);
    if (state.starting) return ($app.innerHTML = '<div class="welcome"><h1>Session Hub</h1><p class="muted">Iniciando el hub…</p></div>');
    if (!state.hasTeam) return ($app.innerHTML = welcomeHtml());
    const t = state.teamInfo.team;
    const others = state.members.filter((m) => !m.self);
    const online = others.filter((m) => m.online).length;
    const m0 = me();
    const paused = state.sharing.paused;

    $app.innerHTML = `
      <header>
        <h1>Session Hub</h1>
        <span class="me"><span class="dot ${state.running ? 'on' : ''}"></span>${esc(m0.name || '—')}${m0.role ? ' · ' + esc(m0.role) : ''}</span>
        <span class="pill" title="Huella del fundador: ${esc(t.fingerprint)}">equipo ${esc(t.name)}</span>
        <span class="muted small" title="Tu huella: compárala de palabra si alguien duda de que eres tú">huella ${esc(state.teamInfo.me.fingerprint)}</span>
        <span class="muted small">${online} compañero(s) en línea</span>
        <span class="spacer"></span>
        ${cmd('sessionHub.whatChanged', '¿Qué hay nuevo?', 'primary')}
        ${cmd('sessionHub.togglePause', paused ? '▶ Reanudar' : '⏸ Pausar', paused ? 'warn' : '')}
        ${cmd('sessionHub.copyInvite', 'Invitar', '', undefined)}
        <button data-act="refresh" title="Refrescar">⟳</button>
        ${cmd('sessionHub.openSource', 'AGPL-3.0', 'icon')}
      </header>
      ${state.running ? '' : `<p class="banner err">El hub está detenido. ${cmd('sessionHub.start', 'Iniciar')}</p>`}
      ${t.pending ? `<p class="banner warnbg">⏳ Tu entrada está pendiente: quien te invitó (${esc(t.invitedBy)}) debe tener Session Hub abierto para confirmarla. Se completa sola.</p>` : ''}
      ${paused ? `<p class="banner warnbg">⏸ Estás en pausa: nadie del equipo ve tus sesiones. ${cmd('sessionHub.togglePause', 'Reanudar')}</p>` : ''}
      <main>
        <section>
          ${sharingHtml()}
          <h3>Personas del equipo</h3>
          ${state.members.map(personHtml).join('') || '<p class="empty">Nadie más en la red todavía.</p>'}
          <h3>Quién ha leído lo mío</h3>
          ${
            state.access.reads.length
              ? state.access.reads
                  .slice(0, 40)
                  .map((r) => `<div class="read ${Date.now() - Date.parse(r.at) < 600000 ? 'fresh' : ''} ${r.what === 'denied' ? 'denied' : ''}">${readSentence(r)}<div class="muted small">${ago(r.at)}</div></div>`)
                  .join('')
              : '<p class="empty small">Nadie ha leído tus sesiones todavía.</p>'
          }
          ${checksHtml()}
        </section>
        <section>
          <div class="tabs">
            ${tabBtn('team', 'Equipo', state.team.length)}
            ${tabBtn('following', 'Siguiendo', state.team.filter(isFollowed).length)}
            ${tabBtn('mine', 'Mis sesiones', state.mine.length)}
          </div>
          <div class="filters">
            <input id="filter" placeholder="Filtrar por título, proyecto, archivo…" value="${esc(ui.filter)}">
            ${
              ui.tab === 'team'
                ? `<select id="person"><option value="">Todos</option>${others.map((m) => `<option value="${esc(m.id)}" ${ui.person === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
                : ''
            }
          </div>
          ${ui.tab === 'mine' && state.mine.length ? `<p class="hint">${state.mine.some((s) => s.hidden) ? 'Las sesiones atenuadas están ocultas al equipo.' : 'Quien tenga acceso al proyecto ve estas sesiones.'} Usa 👁 para mostrar u ocultar.</p>` : ''}
          ${state.teamErrors.map((e) => `<p class="pad err small">${esc(e.member)}: ${esc(e.error)}</p>`).join('')}
          <div id="list">${listHtml()}</div>
        </section>
        <section class="detail" id="detail">${detailHtml()}</section>
      </main>`;
  }

  function sharingHtml() {
    const ws = state.workspace;
    const projects = state.sharing.projects;
    const offer = ws && !ws.shared ? `<div class="offer">¿Compartes <b>${esc(ws.name)}</b>?<br>${cmd('sessionHub.shareWorkspace', 'Compartir este proyecto', 'primary')}</div>` : '';
    const list = projects
      .map(
        (p) => `<div class="share ${state.sharing.paused ? 'dim' : ''}">
          <div><b>${esc(p.name)}</b> <span class="muted small" title="${esc(p.path)}">${p.sessions} ${p.sessions === 1 ? 'sesión' : 'sesiones'}${p.hidden ? ` · ${p.hidden} ${p.hidden === 1 ? 'oculta' : 'ocultas'}` : ''}</span></div>
          <div class="small">Lo ve: <b>${esc(p.audience)}</b></div>
          <div class="actions">${cmd('sessionHub.editProjectAccess', 'Quién lo ve', '', [p.path])}${cmd('sessionHub.unshareProject', 'Dejar de compartir', 'link', [p.path])}</div>
        </div>`,
      )
      .join('');
    const empty = !projects.length && !offer ? '<p class="empty small">No compartes ningún proyecto. Abre una carpeta y usa “Compartir este proyecto”.</p>' : '';
    return `<h3>Lo que comparto</h3>${offer}${list}${empty}`;
  }

  function checksHtml() {
    if (!state.checks.length) return '';
    const bad = state.checks.filter((c) => c.status !== 'ok').length;
    const icon = { ok: '✔', warn: '!', error: '✖' };
    return `<h3>Estado ${bad ? `<span class="warn-txt">· ${bad} por revisar</span>` : '<span class="ok-txt">· todo en orden</span>'}</h3>
      <details class="checks" ${bad ? 'open' : ''}><summary class="small muted">Ver detalle</summary>
      ${state.checks.map((c) => `<div class="check ${c.status}"><span class="ic">${icon[c.status]}</span><div>${esc(c.label)}${c.hint ? `<div class="muted small">${esc(c.hint)}</div>` : ''}</div></div>`).join('')}
      <div class="actions pad" style="padding-top:6px">${cmd('sessionHub.doctor', 'Diagnóstico completo')}${cmd('sessionHub.copyClaudeCommand', 'Conectar Claude Code')}</div>
      </details>`;
  }

  const tabBtn = (id, label, n) => `<button class="tab ${ui.tab === id ? 'sel' : ''}" data-tab="${id}">${label} <span class="muted">${n}</span></button>`;

  function personHtml(m) {
    const viewer = state.access.viewers.find((v) => v.id === m.id);
    const followed = state.follows.people.includes(m.id);
    return `<div class="person ${m.self ? '' : 'clickable'}" data-person="${m.self ? '' : esc(m.id)}">
      <span class="dot ${m.online ? 'on' : ''}"></span>
      <span><span class="name">${esc(m.name)}</span>${m.self ? ' <span class="muted">(tú)</span>' : ''} <span class="muted small">${esc(m.role || '')}</span>${m.founder ? ' <span class="chip">fundador</span>' : ''}</span>
      ${m.self ? '<span></span>' : `<button class="icon ${followed ? 'on' : ''}" data-follow="person" data-id="${esc(m.id)}" title="${followed ? 'Dejar de seguir' : 'Seguir'}">${followed ? '★' : '☆'}</button>`}
      <div class="sub">
        <div class="chips">${(m.projects || []).map((p) => `<span class="chip">${esc(p)}</span>`).join('') || '<span class="muted small">no comparte proyectos contigo</span>'}</div>
        <div class="muted small" title="Huella de su clave">${esc(m.fingerprint || '')}${m.invitedByName ? ` · lo invitó ${esc(m.invitedByName)}` : ''}</div>
        ${m.paused && !m.self ? '<div class="muted small">⏸ en pausa</div>' : ''}
        ${m.blocked ? '<div class="small warn-txt">🚫 bloqueado por ti</div>' : ''}
        ${m.self ? '' : `<div class="actions person-actions">${cmd('sessionHub.blockMember', m.blocked ? 'Desbloquear' : 'Bloquear (solo para mí)', 'link', [m.id])}${m.canRevoke ? cmd('sessionHub.revokeMember', 'Expulsar del equipo', 'link danger', [m.id]) : ''}</div>`}
        ${viewer && viewer.reads ? `<div class="muted small seen">👁 te leyó ${ago(viewer.lastSeen)}${viewer.lastClient ? ' · ' + esc(viewer.lastClient) : ''}</div>` : ''}
        ${m.online ? '' : '<div class="muted small">desconectado</div>'}
      </div>
    </div>`;
  }

  function listHtml() {
    const list = sessionsForTab();
    if (!list.length) {
      const msg = {
        mine: state.sharing.projects.length ? 'No tienes sesiones en tus proyectos compartidos en este rango.' : 'Comparte un proyecto para que tus sesiones aparezcan aquí.',
        following: 'Sigue a una persona o sesión con ☆ para verla aquí.',
        team: state.members.some((m) => !m.self && m.online) ? 'Tus compañeros no tienen sesiones compartidas contigo en este rango.' : 'No hay compañeros en línea. Revisa “Estado” a la izquierda.',
      };
      return `<p class="empty">${msg[ui.tab]}</p>`;
    }
    return list
      .map((s) => {
        const mine = ui.tab === 'mine';
        const readers = mine ? readersOf(s.id) : [];
        const followed = isFollowed(s);
        const action = mine
          ? `<button class="icon ${s.hidden ? '' : 'on'}" data-cmd="sessionHub.toggleSessionVisibility" data-args="${esc(JSON.stringify([s.id]))}" title="${s.hidden ? 'Oculta al equipo: clic para mostrar' : 'Visible para el equipo: clic para ocultar'}">${s.hidden ? '🚫' : '👁'}</button>`
          : `<button class="icon ${state.follows.sessions.includes(s.id) ? 'on' : ''}" data-follow="session" data-id="${esc(s.id)}" title="Seguir sesión">${followed ? '★' : '☆'}</button>`;
        return `<div class="card ${ui.selected === s.id ? 'sel' : ''} ${s.hidden ? 'dim' : ''}" data-open="${esc(s.id)}" data-peer="${esc(s.ownerId)}">
          <span class="t" title="${esc(s.title)}">${esc(s.title)}</span>
          ${action}
          <span class="meta muted small">
            ${mine ? '' : `<b>${esc(s.owner)}</b> · `}<span class="src ${esc(s.source)}">${srcLabel(s)}</span>
            ${esc(s.project)} · ${ago(s.updatedAt)} · ${s.filesChanged.length} archivos${s.hidden ? ' · <b>oculta al equipo</b>' : ''}
            ${readers.length ? `<br><span class="seen">👁 ${readers.map((r) => esc(r.who)).join(', ')}</span>` : ''}
          </span>
        </div>`;
      })
      .join('');
  }

  function detailHtml() {
    if (ui.loading) return '<p class="muted">Cargando sesión…</p>';
    if (ui.error) return `<p class="err">${esc(ui.error)}</p>`;
    const s = ui.detail;
    if (!s) return '<p class="empty">Selecciona una sesión para ver la conversación.</p>';
    const mine = s.ownerId === me().id;
    const hidden = mine && state.mine.find((x) => x.id === s.id)?.hidden;
    const readers = mine ? readersOf(s.id) : [];
    const followed = state.follows.sessions.includes(s.id);
    return `<h2>${esc(s.title)}</h2>
      <div class="muted small"><b>${esc(s.owner)}</b> · <span class="src ${esc(s.source)}">${srcLabel(s)}</span>
        ${esc(s.project)}${s.branch ? ' · rama <code>' + esc(s.branch) + '</code>' : ''} · ${s.messages} mensajes · actualizada ${when(s.updatedAt)}</div>
      <div class="actions">
        ${
          mine
            ? cmd('sessionHub.toggleSessionVisibility', hidden ? '👁 Mostrar al equipo' : '🚫 Ocultar al equipo', hidden ? 'primary' : '', [s.id])
            : `<button data-follow="session" data-id="${esc(s.id)}">${followed ? '★ Siguiendo' : '☆ Seguir esta sesión'}</button>`
        }
        <button data-open="${esc(s.id)}" data-peer="${esc(s.ownerId)}">⟳ Recargar</button>
      </div>
      ${hidden ? '<p class="small warn-txt">Esta sesión está oculta: nadie del equipo la ve.</p>' : ''}
      ${readers.length ? `<p class="small seen">👁 Leída por: ${readers.map((r) => `${esc(r.who)} (${ago(r.at)}${r.client ? ', ' + esc(r.client) : ''})`).join(' · ')}</p>` : ''}
      ${s.filesChanged.length ? `<details><summary>Archivos modificados (${s.filesChanged.length})</summary><pre>${s.filesChanged.map(esc).join('\n')}</pre></details>` : ''}
      ${s.omittedMessages ? `<p class="muted small">(${s.omittedMessages} mensajes anteriores omitidos)</p>` : ''}
      ${s.conversation
        .map(
          (m) => `<div class="msg ${m.role}"><div class="muted small">${m.role === 'user' ? esc(s.owner) : 'IA'} · ${when(m.at)}</div>${esc(m.text)}${
            m.actions.length ? '<div class="acts">' + m.actions.map((a) => (a.kind === 'edit' ? '✎ ' : '$ ') + esc(a.target)).join('<br>') + '</div>' : ''
          }</div>`,
        )
        .join('')}`;
  }

  function open(id, peer) {
    ui.selected = id;
    ui.loading = true;
    ui.error = null;
    document.getElementById('detail').innerHTML = detailHtml();
    document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c.dataset.open === id));
    vscode.postMessage({ type: 'open', id, peer });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-follow],[data-cmd],[data-act],[data-tab],[data-open],[data-person]');
    if (!t) return;
    if (t.dataset.follow) {
      e.stopPropagation();
      return vscode.postMessage({ type: 'follow', kind: t.dataset.follow, id: t.dataset.id });
    }
    if (t.dataset.cmd) {
      e.stopPropagation();
      return vscode.postMessage({ type: 'command', command: t.dataset.cmd, args: t.dataset.args ? JSON.parse(t.dataset.args) : [] });
    }
    if (t.dataset.act === 'refresh') return vscode.postMessage({ type: 'refresh' });
    if (t.dataset.tab) {
      ui.tab = t.dataset.tab;
      persist();
      return render();
    }
    if (t.dataset.open) return open(t.dataset.open, t.dataset.peer);
    if (t.dataset.person) {
      ui.tab = 'team';
      ui.person = t.dataset.person;
      persist();
      render();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'filter') {
      ui.filter = e.target.value;
      document.getElementById('list').innerHTML = listHtml();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'person') {
      ui.person = e.target.value;
      persist();
      document.getElementById('list').innerHTML = listHtml();
    }
  });

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') {
      const focused = document.activeElement?.id === 'filter';
      state = m.state;
      render();
      if (focused) {
        const f = document.getElementById('filter');
        f.focus();
        f.setSelectionRange(f.value.length, f.value.length);
      }
    }
    if (m.type === 'session') {
      ui.loading = false;
      ui.detail = m.data;
      document.getElementById('detail').innerHTML = detailHtml();
    }
    if (m.type === 'error' && m.context === 'open') {
      ui.loading = false;
      ui.error = m.error;
      document.getElementById('detail').innerHTML = detailHtml();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
