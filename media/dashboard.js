// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Cliente del panel. Recibe el estado de la extensión y pide sesiones por postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let state = null;
  let ui = { tab: saved.tab || 'team', filter: '', person: saved.person || '', selected: null, detail: null, loading: false, error: null, page: { reads: 0, team: 0, following: 0, mine: 0 } };
  const PAGE_SIZE = { reads: 10, team: 15, following: 15, mine: 15 };

  // Traducción (media/i18n.js + diccionario que inyecta la extensión). El idioma llega con el estado.
  const translate = window.SessionHubI18n ? window.SessionHubI18n.createTranslator(window.SESSION_HUB_DICT || {}) : (l, s) => s;
  const T = (text, vars) => translate(state?.lang || 'es', text, vars);

  // Una página de la lista y sus controles ("1–15 de 39 · Anterior · Siguiente").
  function paginate(list, key) {
    const size = PAGE_SIZE[key];
    const pages = Math.max(1, Math.ceil(list.length / size));
    ui.page[key] = Math.min(ui.page[key] || 0, pages - 1);
    const start = ui.page[key] * size;
    const items = list.slice(start, start + size);
    const pager =
      list.length > size
        ? `<div class="pager"><button class="link" data-page="${key}:-1" ${ui.page[key] === 0 ? 'disabled' : ''}>‹ ${T('Anterior')}</button><span class="muted small">${T('{v1}–{v2} de {v3}', { v1: start + 1, v2: start + items.length, v3: list.length })}</span><button class="link" data-page="${key}:1" ${ui.page[key] >= pages - 1 ? 'disabled' : ''}>${T('Siguiente')} ›</button></div>`
        : '';
    return { items, pager };
  }

  const $app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ago = (iso) => {
    if (!iso) return '';
    const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (min < 1) return T('ahora');
    if (min < 60) return T('hace {v1} min', { v1: min });
    if (min < 1440) return T('hace {v1} h', { v1: Math.round(min / 60) });
    return T('hace {v1} d', { v1: Math.round(min / 1440) });
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString(state?.lang === 'en' ? 'en' : 'es') : '');
  const persist = () => vscode.setState({ tab: ui.tab, person: ui.person });
  const cmd = (command, label, cls = '', args) =>
    `<button class="${cls}" data-cmd="${command}"${args ? ` data-args="${esc(JSON.stringify(args))}"` : ''}>${label}</button>`;
  const srcLabel = (s) => (s.source === 'cursor' ? 'Cursor' : 'Claude Code');
  const me = () => state.members.find((m) => m.self) || {};
  const b = (x) => `<b>${esc(x)}</b>`;

  // Misma frase que la notificación: quién, qué, de qué proyecto y desde dónde.
  function readSentence(r) {
    const who = `<b>${esc(r.who)}</b>${r.role ? ` <span class="muted">(${esc(r.role)})</span>` : ''}`;
    const from =
      r.via === 'api'
        ? `<span class="err">${T('acceso directo sin identificarse')}</span>`
        : r.client
          ? T(r.via === 'mcp' ? 'desde su IA en {v1}' : 'desde su panel en {v1}', { v1: esc(r.client) })
          : T(r.via === 'mcp' ? 'desde su IA' : 'desde su panel');
    if (r.what === 'session') return `${T('{v1} leyó {v2} de {v3}', { v1: who, v2: b(r.title), v3: b(r.project) })} · ${from}`;
    if (r.what === 'changes') return `${r.project ? T('{v1} revisó tus novedades ({v2}) de {v3}', { v1: who, v2: esc(r.since), v3: b(r.project) }) : T('{v1} revisó tus novedades ({v2})', { v1: who, v2: esc(r.since) })} · ${from}`;
    if (r.what === 'search') return `${T('{v1} buscó {v2} en tus sesiones', { v1: who, v2: `<b>“${esc(r.query)}”</b>` })} · ${from}`;
    if (r.what === 'rejected') return `<span class="err">⛔</span> ${T('Conexión rechazada de {v1}: {v2}', { v1: b(r.who.replace('Clave desconocida ', '')), v2: esc(T(r.reason)) })}`;
    if (r.what === 'denied') return `<span class="err">⛔</span> ${T('{v1} intentó leer {v2} de {v3} sin permiso', { v1: who, v2: b(r.title), v3: b(r.project) })} · ${from}`;
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

  const langSwitch = () =>
    `<span class="lang" title="${T('Idioma de Session Hub')}">${cmd('sessionHub.setLanguage', 'ES', state.lang === 'es' ? 'icon on' : 'icon', ['es'])}${cmd('sessionHub.setLanguage', 'EN', state.lang === 'en' ? 'icon on' : 'icon', ['en'])}</span>`;

  function welcomeHtml() {
    return `<div class="welcome">
      <div style="float:right">${langSwitch()}</div>
      <h1>Session Hub</h1>
      <p>${T('Comparte con tu equipo lo que haces con Claude Code y Cursor: quién pidió qué, qué archivos cambiaron y en qué quedó. Tu IA también puede consultarlo.')}</p>
      <ol>
        <li>${T('<b>Crea un equipo</b> o <b>únete</b> con la invitación de un compañero.')}</li>
        <li>${T('<b>Comparte un proyecto</b> y elige quién lo ve.')}</li>
        <li>${T('Mira las sesiones del equipo aquí o pregúntale a tu IA: <i>“¿qué cambió hoy en el backend?”</i>.')}</li>
      </ol>
      <div class="actions">${cmd('sessionHub.createTeam', T('Crear equipo'), 'primary')}${cmd('sessionHub.joinTeam', T('Unirme con una invitación'))}</div>
      <p class="muted small">${T('Nada se comparte hasta que tú lo eliges. Puedes ocultar sesiones o pausar en cualquier momento.')}</p>
    </div>`;
  }

  function render() {
    if (!state) return;
    document.documentElement.lang = state.lang || 'es';
    if (!state.running) return ($app.innerHTML = `<div class="welcome"><h1>Session Hub</h1><p class="err">${T('El hub está detenido.')}</p><div class="actions">${cmd('sessionHub.start', T('Iniciar'), 'primary')}${cmd('sessionHub.doctor', T('Diagnóstico'))}</div></div>`);
    if (state.starting) return ($app.innerHTML = `<div class="welcome"><h1>Session Hub</h1><p class="muted">${T('Iniciando el hub…')}</p></div>`);
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
        <span class="pill" title="${T('Huella del fundador: {v1}', { v1: esc(t.fingerprint) })}">${T('equipo {v1}', { v1: esc(t.name) })}</span>
        <span class="muted small" title="${T('Tu huella: compárala de palabra si alguien duda de que eres tú')}">${T('huella {v1}', { v1: esc(state.teamInfo.me.fingerprint) })}</span>
        <span class="muted small">${T('{v1} compañero(s) en línea', { v1: online })}</span>
        <span class="spacer"></span>
        ${cmd('sessionHub.whatChanged', T('¿Qué hay nuevo?'), 'primary')}
        ${cmd('sessionHub.togglePause', paused ? `▶ ${T('Reanudar')}` : `⏸ ${T('Pausar')}`, paused ? 'warn' : '')}
        ${cmd('sessionHub.copyInvite', T('Invitar'))}
        <button data-act="refresh" title="${T('Refrescar')}">⟳</button>
        ${langSwitch()}
        ${cmd('sessionHub.openSource', 'AGPL-3.0', 'icon')}
      </header>
      ${t.pending ? `<p class="banner warnbg">⏳ ${T('Tu entrada está pendiente: quien te invitó ({v1}) debe tener Session Hub abierto para confirmarla. Se completa sola.', { v1: esc(t.invitedBy) })}</p>` : ''}
      ${paused ? `<p class="banner warnbg">⏸ ${T('Estás en pausa: nadie del equipo ve tus sesiones.')} ${cmd('sessionHub.togglePause', T('Reanudar'))}</p>` : ''}
      <main>
        <section>
          ${sharingHtml()}
          <h3>${T('Personas del equipo')}</h3>
          ${state.members.map(personHtml).join('') || `<p class="empty">${T('Nadie más en la red todavía.')}</p>`}
          <h3>${T('Quién ha leído lo mío')}</h3>
          <div id="reads">${readsHtml()}</div>
          ${checksHtml()}
        </section>
        <section>
          <div class="tabs">
            ${tabBtn('team', T('Equipo'), state.team.length)}
            ${tabBtn('following', T('Siguiendo'), state.team.filter(isFollowed).length)}
            ${tabBtn('mine', T('Mis sesiones'), state.mine.length)}
          </div>
          <div class="filters">
            <input id="filter" placeholder="${T('Filtrar por título, proyecto, archivo…')}" value="${esc(ui.filter)}">
            ${
              ui.tab === 'team'
                ? `<select id="person"><option value="">${T('Todos')}</option>${others.map((m) => `<option value="${esc(m.id)}" ${ui.person === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
                : ''
            }
          </div>
          ${ui.tab === 'mine' && state.mine.length ? `<p class="hint">${T(state.mine.some((s) => s.hidden) ? 'Las sesiones atenuadas están ocultas al equipo. Usa 👁 para mostrar u ocultar.' : 'Quien tenga acceso al proyecto ve estas sesiones. Usa 👁 para mostrar u ocultar.')}</p>` : ''}
          ${state.teamErrors.map((e) => `<p class="pad err small">${esc(e.member)}: ${esc(T(e.error))}</p>`).join('')}
          <div id="list">${listHtml()}</div>
        </section>
        <section class="detail" id="detail">${detailHtml()}</section>
      </main>`;
  }

  function readsHtml() {
    if (!state.access.reads.length) return `<p class="empty small">${T('Nadie ha leído tus sesiones todavía.')}</p>`;
    const { items, pager } = paginate(state.access.reads, 'reads');
    return (
      items.map((r) => `<div class="read ${Date.now() - Date.parse(r.at) < 600000 ? 'fresh' : ''} ${r.what === 'denied' || r.what === 'rejected' ? 'denied' : ''}">${readSentence(r)}<div class="muted small">${ago(r.at)}</div></div>`).join('') + pager
    );
  }

  function sharingHtml() {
    const ws = state.workspace;
    const projects = state.sharing.projects;
    const offer = ws && !ws.shared ? `<div class="offer">${T('¿Compartes {v1}?', { v1: b(ws.name) })}<br>${cmd('sessionHub.shareWorkspace', T('Compartir este proyecto'), 'primary')}</div>` : '';
    const list = projects
      .map(
        (p) => `<div class="share ${state.sharing.paused ? 'dim' : ''}">
          <div><b>${esc(p.name)}</b> <span class="muted small" title="${esc(p.path)}">${T(p.sessions === 1 ? '{v1} sesión' : '{v1} sesiones', { v1: p.sessions })}${p.hidden ? ` · ${T(p.hidden === 1 ? '{v1} oculta' : '{v1} ocultas', { v1: p.hidden })}` : ''}</span></div>
          <div class="small">${T('Lo ve: {v1}', { v1: b(p.audience) })}</div>
          <div class="actions">${cmd('sessionHub.editProjectAccess', T('Quién lo ve'), '', [p.path])}${cmd('sessionHub.unshareProject', T('Dejar de compartir'), 'link', [p.path])}</div>
        </div>`,
      )
      .join('');
    const empty = !projects.length && !offer ? `<p class="empty small">${T('No compartes ningún proyecto. Abre una carpeta y usa “Compartir este proyecto”.')}</p>` : '';
    return `<h3>${T('Lo que comparto')}</h3>${offer}${list}${empty}`;
  }

  function checksHtml() {
    if (!state.checks.length) return '';
    const bad = state.checks.filter((c) => c.status !== 'ok').length;
    const icon = { ok: '✔', warn: '!', error: '✖' };
    return `<h3>${T('Estado')} ${bad ? `<span class="warn-txt">· ${T('{v1} por revisar', { v1: bad })}</span>` : `<span class="ok-txt">· ${T('todo en orden')}</span>`}</h3>
      <details class="checks" ${bad ? 'open' : ''}><summary class="small muted">${T('Ver detalle')}</summary>
      ${state.checks.map((c) => `<div class="check ${c.status}"><span class="ic">${icon[c.status]}</span><div>${esc(c.label)}${c.hint ? `<div class="muted small">${esc(c.hint)}</div>` : ''}</div></div>`).join('')}
      <div class="actions pad" style="padding-top:6px">${cmd('sessionHub.doctor', T('Diagnóstico completo'))}${cmd('sessionHub.copyNetReport', T('Copiar informe de conexión'))}${cmd('sessionHub.copyClaudeCommand', T('Conectar Claude Code'))}</div>
      </details>`;
  }

  const tabBtn = (id, label, n) => `<button class="tab ${ui.tab === id ? 'sel' : ''}" data-tab="${id}">${label} <span class="muted">${n}</span></button>`;

  function personHtml(m) {
    const viewer = state.access.viewers.find((v) => v.id === m.id);
    const followed = state.follows.people.includes(m.id);
    return `<div class="person ${m.self ? '' : 'clickable'}" data-person="${m.self ? '' : esc(m.id)}">
      <span class="dot ${m.online ? 'on' : ''}"></span>
      <span><span class="name">${esc(m.name)}</span>${m.self ? ` <span class="muted">(${T('tú')})</span>` : ''} <span class="muted small">${esc(m.role || '')}</span>${m.founder ? ` <span class="chip">${T('fundador')}</span>` : ''}</span>
      ${m.self ? '<span></span>' : `<button class="icon ${followed ? 'on' : ''}" data-follow="person" data-id="${esc(m.id)}" title="${T(followed ? 'Dejar de seguir' : 'Seguir')}">${followed ? '★' : '☆'}</button>`}
      <div class="sub">
        <div class="chips">${(m.projects || []).map((p) => `<span class="chip">${esc(p)}</span>`).join('') || `<span class="muted small">${T('no comparte proyectos contigo')}</span>`}</div>
        <div class="muted small" title="${T('Huella de su clave')}">${esc(m.fingerprint || '')}${m.invitedByName ? ` · ${T('lo invitó {v1}', { v1: esc(m.invitedByName === 'ti' ? T('ti') : m.invitedByName) })}` : ''}</div>
        ${m.paused && !m.self ? `<div class="muted small">⏸ ${T('en pausa')}</div>` : ''}
        ${m.blocked ? `<div class="small warn-txt">🚫 ${T('bloqueado por ti')}</div>` : ''}
        ${m.self ? '' : `<div class="actions person-actions">${cmd('sessionHub.blockMember', T(m.blocked ? 'Desbloquear' : 'Bloquear (solo para mí)'), 'link', [m.id])}${m.canRevoke ? cmd('sessionHub.revokeMember', T('Expulsar del equipo'), 'link danger', [m.id]) : ''}</div>`}
        ${viewer && viewer.reads ? `<div class="muted small seen">👁 ${T('te leyó {v1}', { v1: ago(viewer.lastSeen) })}${viewer.lastClient ? ' · ' + esc(viewer.lastClient) : ''}</div>` : ''}
        ${m.online ? '' : `<div class="muted small">${T('desconectado')}</div>`}
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
      return `<p class="empty">${T(msg[ui.tab])}</p>`;
    }
    const { items, pager } = paginate(list, ui.tab);
    return (
      items
        .map((s) => {
          const mine = ui.tab === 'mine';
          const readers = mine ? readersOf(s.id) : [];
          const followed = isFollowed(s);
          const action = mine
            ? `<button class="icon ${s.hidden ? '' : 'on'}" data-cmd="sessionHub.toggleSessionVisibility" data-args="${esc(JSON.stringify([s.id]))}" title="${T(s.hidden ? 'Oculta al equipo: clic para mostrar' : 'Visible para el equipo: clic para ocultar')}">${s.hidden ? '🚫' : '👁'}</button>`
            : `<button class="icon ${state.follows.sessions.includes(s.id) ? 'on' : ''}" data-follow="session" data-id="${esc(s.id)}" title="${T('Seguir sesión')}">${followed ? '★' : '☆'}</button>`;
          return `<div class="card ${ui.selected === s.id ? 'sel' : ''} ${s.hidden ? 'dim' : ''}" data-open="${esc(s.id)}" data-peer="${esc(s.ownerId)}">
          <span class="t" title="${esc(s.title)}">${esc(s.title)}</span>
          ${action}
          <span class="meta muted small">
            ${mine ? '' : `<b>${esc(s.owner)}</b> · `}<span class="src ${esc(s.source)}">${srcLabel(s)}</span>
            ${esc(s.project)} · ${ago(s.updatedAt)} · ${T('{v1} archivos', { v1: s.filesChanged.length })}${s.hidden ? ` · <b>${T('oculta al equipo')}</b>` : ''}
            ${readers.length ? `<br><span class="seen">👁 ${readers.map((r) => esc(r.who)).join(', ')}</span>` : ''}
          </span>
        </div>`;
        })
        .join('') + pager
    );
  }

  function detailHtml() {
    if (ui.loading) return `<p class="muted">${T('Cargando sesión…')}</p>`;
    if (ui.error) return `<p class="err">${esc(T(ui.error))}</p>`;
    const s = ui.detail;
    if (!s) return `<p class="empty">${T('Selecciona una sesión para ver la conversación.')}</p>`;
    const mine = s.ownerId === me().id;
    const hidden = mine && state.mine.find((x) => x.id === s.id)?.hidden;
    const readers = mine ? readersOf(s.id) : [];
    const followed = state.follows.sessions.includes(s.id);
    return `<h2>${esc(s.title)}</h2>
      <div class="muted small"><b>${esc(s.owner)}</b> · <span class="src ${esc(s.source)}">${srcLabel(s)}</span>
        ${esc(s.project)}${s.branch ? ` · ${T('rama')} <code>${esc(s.branch)}</code>` : ''} · ${T('{v1} mensajes', { v1: s.messages })} · ${T('actualizada {v1}', { v1: when(s.updatedAt) })}</div>
      <div class="actions">
        ${
          mine
            ? cmd('sessionHub.toggleSessionVisibility', hidden ? `👁 ${T('Mostrar al equipo')}` : `🚫 ${T('Ocultar al equipo')}`, hidden ? 'primary' : '', [s.id])
            : `<button data-follow="session" data-id="${esc(s.id)}">${followed ? `★ ${T('Siguiendo')}` : `☆ ${T('Seguir esta sesión')}`}</button>`
        }
        <button data-open="${esc(s.id)}" data-peer="${esc(s.ownerId)}">⟳ ${T('Recargar')}</button>
      </div>
      ${hidden ? `<p class="small warn-txt">${T('Esta sesión está oculta: nadie del equipo la ve.')}</p>` : ''}
      ${readers.length ? `<p class="small seen">👁 ${T('Leída por: {v1}', { v1: readers.map((r) => `${esc(r.who)} (${ago(r.at)}${r.client ? ', ' + esc(r.client) : ''})`).join(' · ') })}</p>` : ''}
      ${s.filesChanged.length ? `<details><summary>${T('Archivos modificados ({v1})', { v1: s.filesChanged.length })}</summary><pre>${s.filesChanged.map(esc).join('\n')}</pre></details>` : ''}
      ${s.omittedMessages ? `<p class="muted small">${T('({v1} mensajes anteriores omitidos)', { v1: s.omittedMessages })}</p>` : ''}
      ${s.conversation
        .map(
          (m) => `<div class="msg ${m.role}"><div class="muted small">${m.role === 'user' ? esc(s.owner) : T('IA')} · ${when(m.at)}</div>${esc(m.text)}${
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
    const t = e.target.closest('[data-page],[data-follow],[data-cmd],[data-act],[data-tab],[data-open],[data-person]');
    if (!t) return;
    if (t.dataset.page) {
      const [key, dir] = t.dataset.page.split(':');
      ui.page[key] = Math.max(0, (ui.page[key] || 0) + Number(dir));
      if (key === 'reads') document.getElementById('reads').innerHTML = readsHtml();
      else document.getElementById('list').innerHTML = listHtml();
      return;
    }
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
      ui.page[ui.tab] = 0;
      document.getElementById('list').innerHTML = listHtml();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'person') {
      ui.person = e.target.value;
      ui.page.team = 0;
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
