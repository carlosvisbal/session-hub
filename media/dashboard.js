// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Cliente del panel. Recibe el estado de la extensión y pide sesiones por postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let state = null;
  const VIEWS = ['sessions', 'messages', 'team', 'privacy', 'backup', 'status'];
  let ui = { view: VIEWS.includes(saved.view) ? saved.view : 'sessions', tab: saved.tab || 'team', filter: '', q: {}, peopleFilter: 'all', backupFilter: 'all', copyOwner: '', person: saved.person || '', group: ['project', 'person', 'none'].includes(saved.group) ? saved.group : 'project', collapsed: new Set(saved.collapsed || []), expanded: new Set(), selected: null, detail: null, loading: false, error: null, page: { reads: 0, team: 0, following: 0, mine: 0, inbox: 0 } };
  const PAGE_SIZE = { ownbackup: 10, copieslist: 10, reads: 15, team: 15, following: 15, mine: 15, inbox: 10, sent: 10, people: 12, shares: 8, checks: 20, copyowners: 8, groups: 10 };
  const BOXES = {}; // listas con buscador: clave -> { items, render, text, empty, wrap }

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

  // Lista con buscador (aparece cuando la lista pasa de una página, o si ya hay algo escrito) y paginación.
  function listBox(key, items, { render, text, empty, placeholder, wrap = '', alwaysSearch = false }) {
    BOXES[key] = { items, render, text, empty, wrap };
    const size = PAGE_SIZE[key] || 10;
    const q = ui.q[key] || '';
    const search = alwaysSearch || items.length > size || q ? `<input class="lsearch" type="search" data-search="${key}" placeholder="${esc(placeholder || T('Buscar…'))}" aria-label="${esc(placeholder || T('Buscar…'))}" value="${esc(q)}">` : '';
    return `<div class="lbox">${search}<div id="lb-${key}">${boxBody(key)}</div></div>`;
  }
  function boxBody(key) {
    const box = BOXES[key];
    if (!box.items.length) return box.empty || '';
    const q = (ui.q[key] || '').trim().toLowerCase();
    const list = q ? box.items.filter((x) => box.text(x).toLowerCase().includes(q)) : box.items;
    if (!list.length) return `<p class="empty small">${T('Nada coincide con “{v1}”.', { v1: esc(ui.q[key]) })}</p>`;
    const { items, pager } = paginate(list, key);
    return `${box.wrap ? `<div class="${box.wrap}">` : ''}${items.map(box.render).join('')}${box.wrap ? '</div>' : ''}${pager}`;
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
  const persist = () => vscode.setState({ view: ui.view, tab: ui.tab, person: ui.person, group: ui.group, collapsed: [...ui.collapsed] });
  const GROUP_PREVIEW = 5; // sesiones visibles por grupo antes de "Ver más"
  const cmd = (command, label, cls = '', args) =>
    `<button class="${cls}" data-cmd="${command}"${args ? ` data-args="${esc(JSON.stringify(args))}"` : ''}>${label}</button>`;
  // Abrir los ajustes con un enlace command: del propio webview. No se pide a la extensión: si ella
  // ejecuta workbench.action.openSettings, el editor devuelve el panel de ajustes entero y serializarlo
  // congela (y puede tumbar) la ventana.
  const settingsLink = (query, label) => `<a class="link" href="command:workbench.action.openSettings?${esc(encodeURIComponent(JSON.stringify([query])))}">${label}</a>`;
  const srcLabel = (s) => (s.source === 'cursor' ? 'Cursor' : 'Claude Code');
  const me = () => state.members.find((m) => m.self) || {};
  const b = (x) => `<b>${esc(x)}</b>`;
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  const AGENT_STATUS = { busy: 'ocupada', idle: 'libre', recent: 'activa hace poco' };
  const MSG_STATUS = { held: 'esperando tu aprobación', delivered: 'visible para tu IA', read: 'leído', dismissed: 'descartado' };
  const SENT_STATUS = { queued: 'en cola: se entrega cuando se conecte', held: 'entregado, espera su aprobación', delivered: 'entregado', read: 'leído', dismissed: 'descartado', refused: 'rechazado', failed: 'no se pudo entregar', expired: 'venció en la cola' };

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
    if (r.what === 'copy') return `💾 ${T('{v1} guardó una copia de {v2} de {v3}', { v1: who, v2: b(r.title), v3: b(r.project) })}`;
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
    const m0 = me();
    const paused = state.sharing.paused;

    $app.innerHTML = `
      <header>
        <h1>Session Hub</h1>
        <span class="me"><span class="dot ${state.running ? 'on' : ''}"></span>${esc(m0.name || '—')}${m0.role ? ' · ' + esc(m0.role) : ''}</span>
        <span class="pill" title="${T('Huella del fundador: {v1}', { v1: esc(t.fingerprint) })}">${T('equipo {v1}', { v1: esc(t.name) })}</span>
        <span class="muted small" title="${T('Tu huella: compárala de palabra si alguien duda de que eres tú')}">${T('huella {v1}', { v1: esc(state.teamInfo.me.fingerprint) })}</span>
        <span class="spacer"></span>
        ${cmd('sessionHub.whatChanged', T('¿Qué hay nuevo?'), 'primary')}
        ${cmd('sessionHub.sendMessage', `✉ ${T('Escribir')}`)}
        ${cmd('sessionHub.togglePause', paused ? `▶ ${T('Reanudar')}` : `⏸ ${T('Pausar')}`, paused ? 'warn' : '')}
        ${cmd('sessionHub.copyInvite', T('Invitar'))}
        <button data-act="refresh" title="${T('Refrescar')}" aria-label="${T('Refrescar')}">⟳</button>
        ${langSwitch()}
        ${cmd('sessionHub.openSource', 'AGPL-3.0', 'icon')}
      </header>
      ${t.pending ? `<p class="banner warnbg">⏳ ${T('Tu entrada está pendiente: quien te invitó ({v1}) debe tener Session Hub abierto para confirmarla. Se completa sola.', { v1: esc(t.invitedBy) })}</p>` : ''}
      ${paused ? `<p class="banner warnbg">⏸ ${T('Estás en pausa: nadie del equipo ve tus sesiones.')} ${cmd('sessionHub.togglePause', T('Reanudar'))}</p>` : ''}
      <nav class="views" role="tablist" aria-label="Session Hub">${viewTabs()}</nav>
      <div class="view view-${ui.view}" role="tabpanel" id="panel-${ui.view}" aria-labelledby="tab-${ui.view}">${VIEW_HTML[ui.view]()}</div>`;
  }

  // Pestañas principales, con un contador que dice si hay algo que mirar.
  function viewTabs() {
    const others = state.members.filter((m) => !m.self);
    const online = others.filter((m) => m.online).length;
    const unread = state.inbox?.unread || 0;
    const fresh = state.access.reads.filter((r) => Date.now() - Date.parse(r.at) < 600000).length;
    const bad = state.checks.filter((c) => c.status !== 'ok');
    const tabs = [
      { id: 'sessions', label: T('Sesiones'), badge: state.team.length + state.mine.length || '', cls: 'muted-badge', title: '' },
      { id: 'messages', label: T('Mensajes'), badge: unread || '', cls: '', title: unread ? T('{v1} mensaje(s) sin revisar', { v1: unread }) : '' },
      { id: 'team', label: T('Equipo'), badge: others.length ? `${online}/${others.length}` : '', cls: 'muted-badge', title: T('{v1} compañero(s) en línea', { v1: online }) },
      { id: 'privacy', label: T('Privacidad'), badge: fresh || '', cls: '', title: fresh ? T('{v1} lectura(s) en los últimos 10 min', { v1: fresh }) : '' },
      { id: 'backup', label: T('Respaldo'), badge: state.archive ? (state.archive.own.list || []).length + (state.archive.copies.list || []).length || '' : '', cls: 'muted-badge', title: state.archive?.own?.onlyInBackup ? T('{v1} solo en el respaldo', { v1: state.archive.own.onlyInBackup }) : '' },
      { id: 'status', label: T('Estado'), badge: bad.length || '', cls: bad.some((c) => c.status === 'error') ? 'err-badge' : 'warn-badge', title: bad.length ? T('{v1} por revisar', { v1: bad.length }) : T('todo en orden') },
    ];
    return tabs
      .map((x) => {
        const sel = ui.view === x.id;
        return `<button class="view-tab ${sel ? 'sel' : ''}" role="tab" id="tab-${x.id}" aria-controls="panel-${x.id}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}" data-view="${x.id}"${x.title ? ` title="${esc(x.title)}"` : ''}>${x.label}${x.badge !== '' ? ` <span class="badge ${x.cls}">${esc(x.badge)}</span>` : ''}</button>`;
      })
      .join('');
  }

  const pageHead = (title, sub, actions = '') => `<div class="page-head"><div><h2>${title}</h2>${sub ? `<p class="muted small">${sub}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;

  // Sesiones: la lista (del equipo, seguidas o mías) y la conversación elegida al lado.
  function sessionsView() {
    const others = state.members.filter((m) => !m.self);
    return `<div class="split">
      <section class="list-pane">
        <div class="tabs" role="tablist" aria-label="${T('Sesiones')}">
          ${tabBtn('team', T('Del equipo'), state.team.length)}
          ${tabBtn('following', T('Siguiendo'), state.team.filter(isFollowed).length)}
          ${tabBtn('mine', T('Mis sesiones'), state.mine.length)}
        </div>
        <div class="filters">
          <input id="filter" placeholder="${T('Filtrar por título, proyecto, archivo…')}" value="${esc(ui.filter)}" aria-label="${T('Filtrar por título, proyecto, archivo…')}">
          ${
            ui.tab === 'team'
              ? `<select id="person" aria-label="${T('Persona')}"><option value="">${T('Todos')}</option>${others.map((m) => `<option value="${esc(m.id)}" ${ui.person === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`
              : ''
          }
          <select id="group" aria-label="${T('Agrupar sesiones')}" title="${T('Agrupar sesiones')}">${[['project', 'Por proyecto'], ['person', 'Por persona'], ['none', 'Sin agrupar']]
            .filter(([v]) => v !== 'person' || ui.tab !== 'mine')
            .map(([v, l]) => `<option value="${v}" ${groupMode() === v ? 'selected' : ''}>${T(l)}</option>`)
            .join('')}</select>
        </div>
        ${ui.tab === 'mine' && state.mine.length ? `<p class="hint">${T(state.mine.some((s) => s.hidden) ? 'Las sesiones atenuadas están ocultas al equipo. Usa 👁 para mostrar u ocultar.' : 'Quien tenga acceso al proyecto ve estas sesiones. Usa 👁 para mostrar u ocultar.')}</p>` : ''}
        ${state.teamErrors.map((e) => `<p class="pad err small">${esc(e.member)}: ${esc(T(e.error))}</p>`).join('')}
        <div id="list">${listHtml()}</div>
      </section>
      <section class="detail" id="detail">${detailHtml()}</section>
    </div>`;
  }

  const POLICY_TEXT = {
    hold: 'Los mensajes que recibes esperan a que los apruebes o los pases a tu IA.',
    accept: 'Tu IA puede leer los mensajes apenas llegan (check_inbox).',
    refuse: 'No estás recibiendo mensajes (ajuste sessionHub.inboundMessages).',
  };

  function messagesView() {
    const box = state.inbox || { received: [], sent: [], unread: 0, policy: 'hold' };
    const actions = cmd('sessionHub.sendMessage', `✉ ${T('Escribir a un compañero')}`, 'primary') + settingsLink('sessionHub.inboundMessages', T('Cómo recibo mensajes'));
    return `<div class="page">
      ${pageHead(T('Mensajes'), T(POLICY_TEXT[box.policy] || POLICY_TEXT.hold), actions)}
      <h3>${T('Recibidos')}${box.unread ? ` <span class="badge">${box.unread}</span>` : ''}</h3>
      <div id="messages">${receivedHtml()}</div>
      <h3>${T('Enviados ({v1})', { v1: box.sent.length })}</h3>
      ${sentHtml()}
    </div>`;
  }

  function teamView() {
    const others = state.members.filter((m) => !m.self);
    const online = others.filter((m) => m.online).length;
    const actions = cmd('sessionHub.copyInvite', T('Invitar'), 'primary') + cmd('sessionHub.sendMessage', `✉ ${T('Escribir')}`) + cmd('sessionHub.leaveTeam', T('Salir del equipo'), 'link danger');
    // Filtros rápidos; tú primero, luego quien está en línea, y por nombre.
    const filters = {
      all: () => true,
      online: (m) => m.self || m.online,
      offline: (m) => !m.self && !m.online,
      following: (m) => state.follows.people.includes(m.id),
    };
    const count = (k) => state.members.filter((m) => !m.self && filters[k](m)).length;
    const list = state.members
      .filter(filters[ui.peopleFilter] || filters.all)
      .sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));
    const chip = (k, label) => `<button class="fchip ${ui.peopleFilter === k ? 'on' : ''}" data-pfilter="${k}" aria-pressed="${ui.peopleFilter === k}">${label} <span class="n">${count(k)}</span></button>`;
    return `<div class="page">
      ${pageHead(T('Personas del equipo'), T('{v1} compañero(s) en línea', { v1: online }) + ` · ${T('equipo {v1}', { v1: esc(state.teamInfo.team.name) })}`, actions)}
      <div class="fchips">${chip('all', T('Todos'))}${chip('online', T('En línea'))}${chip('offline', T('Desconectados'))}${chip('following', T('Siguiendo'))}</div>
      ${listBox('people', list, {
        render: personHtml,
        text: (m) => [m.name, m.role, ...(m.projects || []), m.fingerprint, m.invitedByName].join(' '),
        empty: `<p class="empty">${T(ui.peopleFilter === 'all' ? 'Nadie más en la red todavía.' : 'Nadie en este filtro.')}</p>`,
        placeholder: T('Buscar por nombre, rol o proyecto…'),
        wrap: 'people',
        alwaysSearch: true,
      })}
    </div>`;
  }

  function privacyView() {
    const paused = state.sharing.paused;
    return `<div class="page">
      <div class="cols">
        <section>
          ${pageHead(T('Lo que comparto'), T('Nada se comparte hasta que tú lo eliges. Puedes ocultar sesiones o pausar en cualquier momento.'))}
          <div class="share pause-box ${paused ? 'warnbg' : ''}">
            <div>${paused ? `⏸ <b>${T('Estás en pausa: nadie del equipo ve tus sesiones.')}</b>` : T('Compartir activo: tu equipo ve lo que compartes.')}</div>
            <div class="actions">${cmd('sessionHub.togglePause', paused ? `▶ ${T('Reanudar')}` : `⏸ ${T('Pausar')}`, paused ? 'warn' : '')}</div>
          </div>
          ${sharingHtml()}
          <p class="hint">${T('Para ocultar una sesión concreta: Sesiones → Mis sesiones → 👁.')}</p>
        </section>
        <section>
          ${pageHead(T('Quién ha leído lo mío'), T('Quién, qué, cuándo y con qué herramienta, durante 90 días.'))}
          <div id="reads">${readsHtml()}</div>
        </section>
      </div>
      <p class="hint">🗄 ${T('El respaldo de tus sesiones y las copias de tu equipo se administran en la pestaña')} <button class="link" data-view="backup">${T('Respaldo')}</button>.</p>
    </div>`;
  }

  const mb = (bytes) => (!bytes ? '0 KB' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  // ---------- pestaña Respaldo: mis sesiones respaldadas, copias de mi equipo y configuración ----------
  function backupView() {
    const a = state.archive;
    if (!a) return `<div class="page"><p class="empty">${T('Cargando…')}</p></div>`;
    const own = a.own;
    const cp = a.copies;
    const st = a.settings || {};
    const meId = me().id;
    const used = (own.bytes || 0) + (cp.bytes || 0);
    const max = (st.archiveMaxMB || 2048) * 1024 * 1024;
    const pct = Math.min(100, Math.round((used / max) * 100));
    const actions = cmd('sessionHub.syncBackup', `⟳ ${T('Actualizar ahora')}`, 'primary') + cmd('sessionHub.exportAll', T('Exportar todo…')) + settingsLink('sessionHub backup copies', T('Ajustes del respaldo'));

    // --- resumen ---
    // Un hub de otra versión (se está reemplazando) no trae el detalle: se muestran sus totales, no ceros.
    const stale = !own.list;
    const staleNote = stale ? `<p class="banner warnbg">⟳ ${T('El hub que está corriendo es de otra versión y no trae el detalle del respaldo. Cierra todas las ventanas del editor y vuelve a abrirlo para actualizarlo.')}</p>` : '';
    const summary = `${staleNote}<div class="bsum">
      <div class="bstat"><div class="bnum">${stale ? own.sessions || 0 : own.list.length}</div><div class="muted small">${T('mis sesiones respaldadas')}</div></div>
      <div class="bstat"><div class="bnum ${own.onlyInBackup ? 'warn-txt' : ''}">${own.onlyInBackup || 0}</div><div class="muted small">${T('solo en el respaldo')}</div></div>
      <div class="bstat"><div class="bnum">${stale ? (cp.owners || []).reduce((n, o) => n + (o.sessions || 0), 0) : (cp.list || []).length}</div><div class="muted small">${T('copias de mi equipo')}</div></div>
      <div class="bstat grow"><div class="small">${T('Espacio: {v1} de {v2}', { v1: mb(used), v2: mb(max) })}</div><div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
        <div class="muted small">${own.lastSync ? T('Actualizado {v1}', { v1: ago(own.lastSync) }) : T('Aún no se ha actualizado.')}${own.lastError ? ` · <span class="err">${esc(T(own.lastError))}</span>` : ''}</div></div>
    </div>`;

    // --- mis sesiones respaldadas ---
    const ownFilters = { all: () => true, gone: (x) => !!x.goneSince, live: (x) => !x.goneSince };
    const ownAll = (own.list || []).slice().sort((x, y) => (y.goneSince ? 1 : 0) - (x.goneSince ? 1 : 0) || (y.updatedAt || '').localeCompare(x.updatedAt || ''));
    const ownList = ownAll.filter(ownFilters[ui.backupFilter] || ownFilters.all);
    const ownCount = (k) => ownAll.filter(ownFilters[k]).length;
    const ochip = (k, label) => `<button class="fchip ${ui.backupFilter === k ? 'on' : ''}" data-bfilter="${k}" aria-pressed="${ui.backupFilter === k}">${label} <span class="n">${ownCount(k)}</span></button>`;
    const ownRow = (x) => `<div class="brow">
        <div class="bmain">
          <div class="btitle" title="${esc(x.title)}">${esc(x.title || x.id)}</div>
          <div class="muted small">${esc(x.project)} · ${x.source === 'cursor' ? 'Cursor' : 'Claude Code'} · ${T('{v1} mensajes', { v1: x.messages })} · ${mb(x.bytes)} · ${T('actualizada {v1}', { v1: ago(x.updatedAt) })}</div>
          <div class="small">${x.goneSince ? `<span class="tag archived">🗄 ${T('solo en respaldo desde {v1}', { v1: ago(x.goneSince) })}</span>` : `<span class="tag ok">✓ ${T('el original sigue en {v1}', { v1: x.source === 'cursor' ? 'Cursor' : 'Claude Code' })}</span>`}${x.shared ? '' : ` <span class="tag">${T('proyecto ya no compartido')}</span>`}${x.hasPrev ? ` <span class="tag" title="${T('Se acortó (p. ej. al restaurar en Cursor) y se guardó la versión anterior')}">${T('con versión anterior')}</span>` : ''}</div>
        </div>
        <div class="bacts">
          <button class="small-btn" data-openin="${esc(x.id)}" data-peer="${esc(meId)}">${T('Ver')}</button>
          ${cmd('sessionHub.useSessionInAi', `🤖 ${T('Usar en mi IA')}`, 'small-btn', [x.id, 'yo', x.title, x.goneSince ? 'archived' : ''])}
          ${cmd('sessionHub.exportSession', `⤓ ${T('Exportar')}`, 'small-btn', [x.id, meId])}
          ${x.goneSince ? cmd('sessionHub.removeFromBackup', T('Borrar'), 'link danger small', [x.id, null, x.title]) : ''}
        </div>
      </div>`;
    const ownSection = !st.archive
      ? `<div class="share dim">${T('El respaldo de tus sesiones está desactivado.')} ${cmd('sessionHub.setBackupOption', T('Activar'), 'link', ['archive', true])}</div>`
      : `<div class="fchips">${ochip('all', T('Todas'))}${ochip('gone', T('Solo en respaldo'))}${ochip('live', T('Con original'))}</div>
        ${listBox('ownbackup', ownList, {
          render: ownRow,
          text: (x) => [x.title, x.project, x.source].join(' '),
          empty: `<p class="empty small">${T(ui.backupFilter === 'gone' ? 'Ninguna sesión existe solo en el respaldo: Claude Code y Cursor todavía tienen todas.' : 'Todavía no hay sesiones respaldadas. Se respaldan las de los proyectos que compartes (o que marcas “Solo yo”).')}</p>`,
          placeholder: T('Buscar en mis sesiones respaldadas…'),
          alwaysSearch: ownAll.length > 0,
        })}
        ${own.onlyInBackup ? `<div class="actions">${cmd('sessionHub.purgeOwnBackup', T('Borrar todo lo que ya no existe'), 'link danger')}</div>` : ''}`;

    // --- copias de mi equipo ---
    const owners = cp.owners || [];
    const copyAll = (cp.list || []).slice().sort((x, y) => (y.syncedAt || '').localeCompare(x.syncedAt || ''));
    const copyList = copyAll.filter((x) => !ui.copyOwner || x.ownerId === ui.copyOwner);
    const COPY_STATUS = { ok: 'al día', gone: 'ya no existe en origen', unverified: 'sin confirmar con su dueño' };
    const copyRow = (x) => `<div class="brow">
        <div class="bmain">
          <div class="btitle" title="${esc(x.title)}">${esc(x.title || x.id)}</div>
          <div class="muted small"><b>${esc(x.owner || '')}</b> · ${esc(x.project || '')} · ${x.source === 'cursor' ? 'Cursor' : 'Claude Code'} · ${T('{v1} mensajes', { v1: x.messages })} · ${mb(x.bytes)}</div>
          <div class="small"><span class="tag copy">💾 ${T('copiada {v1}', { v1: ago(x.syncedAt) })}</span> <span class="tag ${x.status === 'ok' ? 'ok' : 'archived'}">${T(COPY_STATUS[x.status] || x.status)}</span></div>
        </div>
        <div class="bacts">
          <button class="small-btn" data-openin="${esc(x.id)}" data-peer="${esc(x.ownerId)}">${T('Ver')}</button>
          ${cmd('sessionHub.useSessionInAi', `🤖 ${T('Usar en mi IA')}`, 'small-btn', [x.id, x.owner, x.title, 'copy'])}
          ${cmd('sessionHub.exportSession', `⤓ ${T('Exportar')}`, 'small-btn', [x.id, x.ownerId])}
          ${cmd('sessionHub.removeFromBackup', T('Borrar copia'), 'link danger small', [x.id, x.ownerId, x.title])}
        </div>
      </div>`;
    const ownerChips = owners.length
      ? `<div class="fchips"><button class="fchip ${!ui.copyOwner ? 'on' : ''}" data-cowner="">${T('Todos')} <span class="n">${copyAll.length}</span></button>${owners
          .map((o) => `<button class="fchip ${ui.copyOwner === o.id ? 'on' : ''}" data-cowner="${esc(o.id)}" title="${o.lastSync ? T('al día {v1}', { v1: ago(o.lastSync) }) : ''}">${esc(o.name || o.id.slice(0, 8))} <span class="n">${o.sessions}</span>${o.paused ? ' ⏸' : ''}</button>`)
          .join('')}</div>`
      : '';
    const sel = owners.find((o) => o.id === ui.copyOwner);
    const copySection = !st.teamCopies
      ? `<div class="share dim">${T('No guardas copias de tu equipo.')} ${cmd('sessionHub.setBackupOption', T('Activar'), 'link', ['teamCopies', true])}</div>`
      : `${ownerChips}
        ${listBox('copieslist', copyList, {
          render: copyRow,
          text: (x) => [x.title, x.owner, x.project].join(' '),
          empty: `<p class="empty small">${T('Todavía no hay copias. Se guardan solas de lo que tus compañeros comparten contigo mientras están conectados.')}</p>`,
          placeholder: T('Buscar en las copias…'),
          alwaysSearch: copyAll.length > 0,
        })}
        ${owners.length ? `<div class="actions">${sel ? cmd('sessionHub.purgeCopies', T('Borrar las copias de {v1}', { v1: esc(sel.name || '') }), 'link danger', [sel.id, sel.name]) : ''}${cmd('sessionHub.purgeCopies', T('Borrar todas las copias'), 'link danger')}</div>` : ''}`;

    // --- configuración ---
    const toggle = (key, on, label, hint) => `<div class="bset"><div><div>${label}</div><div class="muted small">${hint}</div></div>${cmd('sessionHub.setBackupOption', on ? `✓ ${T('Activado')}` : T('Desactivado'), on ? 'primary small-btn' : 'small-btn', [key, !on])}</div>`;
    const number = (key, value, label, unit) => `<div class="bset"><div><div>${label}</div><div class="muted small">${value === 0 ? T('sin límite') : `${value} ${unit}`}</div></div>${cmd('sessionHub.editBackupNumber', T('Cambiar'), 'small-btn', [key])}</div>`;
    const settings = `<div class="bsettings">
      ${toggle('archive', st.archive, T('Respaldar mis sesiones'), T('Siguen disponibles aunque Claude Code o Cursor las borren.'))}
      ${toggle('teamCopies', st.teamCopies, T('Guardar copias de mi equipo'), T('Para leer sus sesiones cuando estén desconectados.'))}
      ${toggle('allowCopies', st.allowCopies, T('Permitir que mi equipo copie lo mío'), T('Si lo desactivas, sus copias se borran en el siguiente contacto.'))}
      ${number('archiveRetentionDays', st.archiveRetentionDays, T('Conservar lo que solo está en el respaldo'), T('días'))}
      ${number('copiesRetentionDays', st.copiesRetentionDays, T('Conservar copias sin confirmar'), T('días'))}
      ${number('archiveMaxMB', st.archiveMaxMB, T('Espacio máximo'), 'MB')}
    </div>`;

    return `<div class="page">
      ${pageHead(T('Respaldo'), T('Todo se guarda solo en este equipo, comprimido y sin secretos al compartir.'), actions)}
      ${summary}
      <h3>${T('Mis sesiones respaldadas')}</h3>${ownSection}
      <h3>${T('Copias de mi equipo')}</h3>${copySection}
      <h3>${T('Configuración')}</h3>${settings}
    </div>`;
  }

  function statusView() {
    return `<div class="page">${checksHtml()}</div>`;
  }

  const VIEW_HTML = { sessions: sessionsView, messages: messagesView, team: teamView, privacy: privacyView, backup: backupView, status: statusView };

  function setView(view, focus) {
    if (!VIEWS.includes(view)) return;
    ui.view = view;
    persist();
    render();
    if (focus) document.getElementById(`tab-${view}`)?.focus();
  }

  function readsHtml() {
    return listBox('reads', state.access.reads, {
      render: (r) => `<div class="read ${Date.now() - Date.parse(r.at) < 600000 ? 'fresh' : ''} ${r.what === 'denied' || r.what === 'rejected' ? 'denied' : ''}">${readSentence(r)}<div class="muted small">${ago(r.at)}</div></div>`,
      text: (r) => [r.who, r.role, r.title, r.project, r.query, r.client].join(' '),
      empty: `<p class="empty small">${T('Nadie ha leído tus sesiones todavía.')}</p>`,
      placeholder: T('Buscar por persona, sesión o proyecto…'),
    });
  }

  // Mensajes de compañeros (firmados). Retenido = mi IA no lo ve hasta que lo apruebe o lo pase al chat.
  function receivedHtml() {
    const visible = (state.inbox?.received || []).filter((m) => m.status !== 'dismissed');
    return listBox('inbox', visible, {
      render: messageHtml,
      text: (m) => [m.fromName, m.fromRole, m.text].join(' '),
      empty: `<p class="empty small">${T('Sin mensajes. Tus compañeros pueden escribirte desde su panel o pidiéndoselo a su IA.')}</p>`,
      placeholder: T('Buscar en los mensajes…'),
    });
  }

  function sentHtml() {
    return listBox('sent', state.inbox?.sent || [], {
      render: (m) => `<div class="read small">${T('Para {v1}', { v1: b(m.toName) })}: ${esc(clip(m.text, 160))}<div class="muted">${T(SENT_STATUS[m.status] || m.status)}${m.error ? ' · ' + esc(T(m.error)) : ''} · ${ago(m.updatedAt || m.at)}</div></div>`,
      text: (m) => [m.toName, m.text].join(' '),
      empty: `<p class="empty small">${T('Todavía no has enviado mensajes.')}</p>`,
      placeholder: T('Buscar en los enviados…'),
      wrap: 'sent',
    });
  }

  const sessionName = (id) => state.mine.find((s) => s.id === id)?.title || id;

  function messageHtml(m) {
    const pending = m.status === 'held' || m.status === 'delivered';
    const long = m.text.length > 280;
    const notes = [T(MSG_STATUS[m.status] || m.status), m.toSession ? T('para tu sesión {v1}', { v1: b(clip(sessionName(m.toSession), 50)) }) : '', m.replyTo ? T('es una respuesta') : '', m.repliedAt ? T('respondido') : ''].filter(Boolean);
    return `<div class="read msgbox ${pending ? 'fresh' : 'dim'}">
      <div><b>${esc(m.fromName)}</b>${m.fromRole ? ` <span class="muted">(${esc(m.fromRole)})</span>` : ''} <span class="muted small" title="${T('Huella de su clave')}: ${esc(m.fingerprint)}">· ${ago(m.receivedAt)}</span></div>
      <div class="text">${esc(long ? clip(m.text, 280) : m.text)}</div>
      ${long ? `<details><summary class="small muted">${T('Ver completo')}</summary><div class="text">${esc(m.text)}</div></details>` : ''}
      <div class="muted small">${notes.join(' · ')}</div>
      <div class="actions person-actions">
        ${cmd('sessionHub.handoffMessage', T('Pasar a mi IA'), 'link', [m.id])}
        ${m.status === 'held' ? cmd('sessionHub.approveMessage', T('Permitir que mi IA lo lea'), 'link', [m.id]) : ''}
        ${cmd('sessionHub.replyMessage', T('Responder'), 'link', [m.id])}
        ${cmd('sessionHub.dismissMessage', T('Descartar'), 'link', [m.id])}
      </div>
    </div>`;
  }

  function sharingHtml() {
    const ws = state.workspace;
    const projects = state.sharing.projects;
    const offer = ws && !ws.shared ? `<div class="offer">${T('¿Compartes {v1}?', { v1: b(ws.name) })}<br>${cmd('sessionHub.shareWorkspace', T('Compartir este proyecto'), 'primary')}</div>` : '';
    const list = listBox('shares', projects, {
      text: (p) => [p.name, p.path, p.audience].join(' '),
      placeholder: T('Buscar proyecto…'),
      render: (p) => `<div class="share ${state.sharing.paused ? 'dim' : ''}">
          <div><b>${esc(p.name)}</b> <span class="muted small" title="${esc(p.path)}">${T(p.sessions === 1 ? '{v1} sesión' : '{v1} sesiones', { v1: p.sessions })}${p.hidden ? ` · ${T(p.hidden === 1 ? '{v1} oculta' : '{v1} ocultas', { v1: p.hidden })}` : ''}</span></div>
          <div class="small">${T('Lo ve: {v1}', { v1: b(p.audience) })}</div>
          <div class="actions">${cmd('sessionHub.editProjectAccess', T('Quién lo ve'), '', [p.path])}${cmd('sessionHub.unshareProject', T('Dejar de compartir'), 'link', [p.path])}</div>
        </div>`,
    });
    const empty = !projects.length && !offer ? `<p class="empty small">${T('No compartes ningún proyecto. Abre una carpeta y usa “Compartir este proyecto”.')}</p>` : '';
    return `${offer}${list}${empty}`;
  }

  function checksHtml() {
    const bad = state.checks.filter((c) => c.status !== 'ok').length;
    const icon = { ok: '✔', warn: '!', error: '✖' };
    const sub = state.checks.length ? (bad ? `<span class="warn-txt">${T('{v1} por revisar', { v1: bad })}</span>` : `<span class="ok-txt">${T('todo en orden')}</span>`) : '';
    const actions = cmd('sessionHub.doctor', T('Diagnóstico completo'), 'primary') + cmd('sessionHub.copyNetReport', T('Copiar informe de conexión')) + cmd('sessionHub.copyClaudeCommand', T('Conectar Claude Code'));
    const order = { error: 0, warn: 1, ok: 2 };
    const list = [...state.checks].sort((a, b) => order[a.status] - order[b.status]);
    return `${pageHead(T('Estado'), sub, actions)}
      ${listBox('checks', list, {
        render: (c) => `<div class="check ${c.status}"><span class="ic" aria-hidden="true">${icon[c.status]}</span><div>${esc(c.label)}${c.hint ? `<div class="muted small">${esc(c.hint)}</div>` : ''}</div></div>`,
        text: (c) => `${c.label} ${c.hint || ''}`,
        empty: `<p class="empty">${T('Cargando…')}</p>`,
        placeholder: T('Buscar en el estado…'),
        wrap: 'checks',
      })}`;
  }

  const tabBtn = (id, label, n) => `<button class="tab ${ui.tab === id ? 'sel' : ''}" role="tab" aria-selected="${ui.tab === id}" data-tab="${id}">${label} <span class="muted">${n}</span></button>`;

  // Color estable por persona (a partir de su clave) e iniciales para el avatar.
  const hueOf = (key) => [...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
  const initials = (name) =>
    String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';

  function personHtml(m) {
    const viewer = state.access.viewers.find((v) => v.id === m.id);
    const followed = state.follows.people.includes(m.id);
    const live = (state.agents || []).filter((a) => a.ownerId === m.id);
    const status = m.self ? T('tú') : m.online ? T('en línea') : T('desconectado');
    const badges = [
      m.founder ? `<span class="badge-soft">${T('fundador')}</span>` : '',
      m.paused && !m.self ? `<span class="badge-soft warn">⏸ ${T('en pausa')}</span>` : '',
      m.blocked ? `<span class="badge-soft err">🚫 ${T('bloqueado por ti')}</span>` : '',
      viewer && viewer.reads ? `<span class="badge-soft seen" title="${esc(viewer.lastClient || '')}">👁 ${T('te leyó {v1}', { v1: ago(viewer.lastSeen) })}</span>` : '',
    ].join('');
    const liveHtml = live.length
      ? `<div class="pblock"><div class="plabel">${T('Sesiones abiertas')}</div>${live
          .map((a) => `<div class="prow" title="${esc(a.title || a.session)}"><span class="dot ${a.status === 'busy' ? 'busy' : 'on'}"></span><b>${esc(a.tool)}</b> · ${esc(a.project)} · ${T(AGENT_STATUS[a.status] || a.status)}${a.title ? `<div class="muted small ellipsis">${esc(a.title)}</div>` : ''}</div>`)
          .join('')}</div>`
      : '';
    const projects = (m.projects || []).length
      ? `<div class="chips">${m.projects.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div>`
      : `<span class="muted small">${T(m.self ? 'no compartes proyectos' : 'no comparte proyectos contigo')}</span>`;
    const footer = m.self
      ? ''
      : `<footer class="pfoot">
          ${m.blocked ? '' : cmd('sessionHub.sendMessage', `✉ ${T('Mensaje')}`, 'primary small-btn', [m.id])}
          <button class="small-btn" data-person="${esc(m.id)}">${T('Ver sesiones')} →</button>
          <span class="spacer"></span>
          ${cmd('sessionHub.blockMember', T(m.blocked ? 'Desbloquear' : 'Bloquear (solo para mí)'), 'link small', [m.id])}
          ${m.canRevoke ? cmd('sessionHub.revokeMember', T('Expulsar del equipo'), 'link danger small', [m.id]) : ''}
        </footer>`;
    return `<article class="pcard ${m.self ? 'self' : 'clickable'} ${m.online || m.self ? '' : 'offline'} ${m.blocked ? 'blocked' : ''}" data-person="${m.self ? '' : esc(m.id)}"${m.self ? '' : ` tabindex="0" role="button" aria-label="${T('Ver las sesiones de {v1}', { v1: esc(m.name) })}"`}>
      <header class="phead">
        <span class="avatar" style="--h:${hueOf(m.id)}" aria-hidden="true">${esc(initials(m.name))}<span class="presence ${m.online || m.self ? 'on' : ''}"></span></span>
        <div class="who">
          <div class="pname">${esc(m.name)}</div>
          <div class="muted small">${m.role ? `${esc(m.role)} · ` : ''}<span class="${m.online || m.self ? 'ok-txt' : ''}">${status}</span></div>
        </div>
        ${m.self ? '' : `<button class="icon star ${followed ? 'on' : ''}" data-follow="person" data-id="${esc(m.id)}" title="${T(followed ? 'Dejar de seguir' : 'Seguir')}" aria-label="${T(followed ? 'Dejar de seguir' : 'Seguir')}">${followed ? '★' : '☆'}</button>`}
      </header>
      ${badges ? `<div class="pbadges">${badges}</div>` : ''}
      ${liveHtml}
      <div class="pblock"><div class="plabel">${T(m.self ? 'Compartes' : 'Comparte contigo')}</div>${projects}</div>
      ${footer}
      <div class="pfp muted" title="${T('Huella de su clave')}">${esc(m.fingerprint || '')}${m.invitedByName ? ` · ${T('lo invitó {v1}', { v1: esc(m.invitedByName === 'ti' ? T('ti') : m.invitedByName) })}` : ''}</div>
    </article>`;
  }

  // En "Mis sesiones" no tiene sentido agrupar por persona: se agrupa por proyecto.
  const groupMode = () => (ui.tab === 'mine' && ui.group === 'person' ? 'project' : ui.group);

  function cardHtml(s) {
    const mine = ui.tab === 'mine';
    const readers = mine ? readersOf(s.id) : [];
    const followed = isFollowed(s);
    const action = mine
      ? `<button class="icon ${s.hidden ? '' : 'on'}" data-cmd="sessionHub.toggleSessionVisibility" data-args="${esc(JSON.stringify([s.id]))}" title="${T(s.hidden ? 'Oculta al equipo: clic para mostrar' : 'Visible para el equipo: clic para ocultar')}">${s.hidden ? '🚫' : '👁'}</button>`
      : `<button class="icon ${state.follows.sessions.includes(s.id) ? 'on' : ''}" data-follow="session" data-id="${esc(s.id)}" title="${T('Seguir sesión')}">${followed ? '★' : '☆'}</button>`;
    const inGroup = groupMode();
    const showOwner = !mine && inGroup !== 'person';
    const showProject = inGroup !== 'project';
    return `<div class="card ${ui.selected === s.id ? 'sel' : ''} ${s.hidden ? 'dim' : ''}" data-open="${esc(s.id)}" data-peer="${esc(s.ownerId)}">
          <span class="t" title="${esc(s.title)}">${esc(s.title)}</span>
          ${action}
          <span class="meta muted small">
            ${showOwner ? `<b>${esc(s.owner)}</b> · ` : ''}<span class="src ${esc(s.source)}">${srcLabel(s)}</span>
            ${showProject ? `${esc(s.project)} · ` : ''}${ago(s.updatedAt)} · ${T('{v1} archivos', { v1: s.filesChanged.length })}${s.hidden ? ` · <b>${T('oculta al equipo')}</b>` : ''}${originBadge(s)}
            ${readers.length ? `<br><span class="seen">👁 ${readers.map((r) => esc(r.who)).join(', ')}</span>` : ''}
          </span>
        </div>`;
  }

  // De dónde viene: el original ya no existe (respaldo del dueño) o es mi copia (el dueño no está).
  const originBadge = (s) =>
    s.copy ? ` · <span class="tag copy" title="${T('Copia local: {v1} no está conectado', { v1: esc(s.owner) })}">💾 ${T('copia de {v1}', { v1: ago(s.copy.syncedAt) })}</span>` : s.archived ? ` · <span class="tag archived" title="${T('El original ya no existe en {v1}', { v1: srcLabel(s) })}">🗄 ${T('solo en respaldo')}</span>` : '';

  // Grupos por proyecto o por persona, ordenados por la actividad más reciente.
  function groupsOf(list, mode) {
    const groups = new Map();
    for (const s of list) {
      // Mismo proyecto = misma projectKey (mismo repo git). Sin clave (hub anterior) no se mezcla con nadie.
      const key = mode === 'person' ? `person:${s.ownerId}` : `project:${s.projectKey || `${s.ownerId}:${s.project}`}`;
      if (!groups.has(key)) groups.set(key, { key, label: mode === 'person' ? s.owner : s.project, sessions: [], owners: new Set(), projects: new Set(), latest: '' });
      const g = groups.get(key);
      g.sessions.push(s);
      g.owners.add(s.owner);
      g.projects.add(s.project);
      if ((s.updatedAt || '') > g.latest) g.latest = s.updatedAt || '';
    }
    for (const g of groups.values()) g.sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const out = [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
    if (mode === 'project') {
      // Un mismo repo con nombres distintos se muestra "web-app / frontend"; dos proyectos distintos con
      // el mismo nombre se distinguen por su dueño: "web-app · Ana" y "web-app · Luis".
      for (const g of out) g.label = [...new Set(g.sessions.map((x) => x.project))].join(' / ');
      const count = new Map();
      for (const g of out) count.set(g.label, (count.get(g.label) || 0) + 1);
      for (const g of out) if (count.get(g.label) > 1) g.label += ` · ${[...g.owners].join(', ')}`;
    }
    return out;
  }

  function groupHtml(g, mode) {
    const open = !!ui.filter.trim() || !ui.collapsed.has(g.key); // al filtrar, se ven todos los resultados
    const all = ui.expanded.has(g.key);
    const shown = all ? g.sessions : g.sessions.slice(0, GROUP_PREVIEW);
    const rest = g.sessions.length - shown.length;
    const count = T(g.sessions.length === 1 ? '{v1} sesión' : '{v1} sesiones', { v1: g.sessions.length });
    const who = mode === 'person' ? [...g.projects].join(', ') : ui.tab === 'mine' ? '' : [...g.owners].join(', ');
    return `<section class="group">
      <button class="group-head" data-group="${esc(g.key)}" aria-expanded="${open}">
        <span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="g-name">${esc(g.label)}</span>
        <span class="muted small g-sub">${count}${who ? ` · ${esc(who)}` : ''} · ${ago(g.latest)}</span>
      </button>
      ${open ? shown.map(cardHtml).join('') + (rest > 0 ? `<button class="link more" data-more="${esc(g.key)}">${T('Ver {v1} más', { v1: rest })}</button>` : all && g.sessions.length > GROUP_PREVIEW ? `<button class="link more" data-more="${esc(g.key)}">${T('Ver menos')}</button>` : '') : ''}
    </section>`;
  }

  function listHtml() {
    const list = sessionsForTab();
    if (!list.length) {
      const msg = {
        mine: state.sharing.projects.length ? 'No tienes sesiones en tus proyectos compartidos en este rango.' : 'Comparte un proyecto para que tus sesiones aparezcan aquí.',
        following: 'Sigue a una persona o sesión con ☆ para verla aquí.',
        team: state.members.some((m) => !m.self && m.online) ? 'Tus compañeros no tienen sesiones compartidas contigo en este rango.' : 'No hay compañeros en línea. Revisa la pestaña “Estado”.',
      };
      return `<p class="empty">${T(msg[ui.tab])}</p>`;
    }
    const mode = groupMode();
    if (mode === 'none') {
      const { items, pager } = paginate(list, ui.tab);
      return items.map(cardHtml).join('') + pager;
    }
    const groups = groupsOf(list, mode);
    const allClosed = groups.every((g) => ui.collapsed.has(g.key));
    const tools = groups.length > 1 ? `<div class="group-tools"><button class="link" data-groups="${allClosed ? 'open' : 'close'}">${T(allClosed ? 'Abrir todos' : 'Cerrar todos')}</button></div>` : '';
    const { items: pageGroups, pager } = paginate(groups, 'groups');
    return tools + pageGroups.map((g) => groupHtml(g, mode)).join('') + pager;
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
        ${cmd('sessionHub.useSessionInAi', `🤖 ${T('Usar en mi IA')}`, 'primary', [s.id, mine ? 'yo' : s.owner, s.title, s.copy ? 'copy' : s.archived ? 'archived' : ''])}
        ${cmd('sessionHub.exportSession', `⤓ ${T('Exportar')}`, '', [s.id, s.ownerId])}
        ${(s.archived && mine) || s.copy ? cmd('sessionHub.removeFromBackup', T('Borrar del respaldo'), 'link danger', [s.id, mine ? null : s.ownerId, s.title]) : ''}
      </div>
      ${s.copy ? `<p class="banner-inline">💾 ${T('Copia local guardada {v1}: {v2} no está conectado. Puede no tener lo último.', { v1: ago(s.copy.syncedAt), v2: esc(s.owner) })}</p>` : ''}
      ${s.archived ? `<p class="banner-inline">🗄 ${T('El original ya no existe en {v1}; se muestra desde el respaldo de {v2}.', { v1: srcLabel(s), v2: esc(s.owner) })}</p>` : ''}
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
    const detail = document.getElementById('detail');
    if (detail) detail.innerHTML = detailHtml();
    document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', c.dataset.open === id));
    vscode.postMessage({ type: 'open', id, peer });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-page],[data-follow],[data-cmd],[data-act],[data-view],[data-bfilter],[data-cowner],[data-openin],[data-pfilter],[data-group],[data-more],[data-groups],[data-tab],[data-open],[data-person]');
    if (!t) return;
    if (t.dataset.group || t.dataset.more || t.dataset.groups) {
      if (t.dataset.group) ui.collapsed.has(t.dataset.group) ? ui.collapsed.delete(t.dataset.group) : ui.collapsed.add(t.dataset.group);
      if (t.dataset.more) ui.expanded.has(t.dataset.more) ? ui.expanded.delete(t.dataset.more) : ui.expanded.add(t.dataset.more);
      if (t.dataset.groups) for (const g of groupsOf(sessionsForTab(), groupMode())) t.dataset.groups === 'close' ? ui.collapsed.add(g.key) : ui.collapsed.delete(g.key);
      persist();
      const list = document.getElementById('list');
      if (list) list.innerHTML = listHtml();
      if (t.dataset.group) [...document.querySelectorAll('[data-group]')].find((x) => x.dataset.group === t.dataset.group)?.focus();
      return;
    }
    if (t.dataset.view) return setView(t.dataset.view);
    if (t.dataset.bfilter) {
      ui.backupFilter = t.dataset.bfilter;
      ui.page.ownbackup = 0;
      return render();
    }
    if (t.dataset.cowner != null && t.matches('[data-cowner]')) {
      ui.copyOwner = t.dataset.cowner;
      ui.page.copieslist = 0;
      return render();
    }
    if (t.dataset.openin) {
      setView('sessions');
      return open(t.dataset.openin, t.dataset.peer);
    }
    if (t.dataset.pfilter) {
      ui.peopleFilter = t.dataset.pfilter;
      ui.page.people = 0;
      return render();
    }
    if (t.dataset.page) {
      const [key, dir] = t.dataset.page.split(':');
      ui.page[key] = Math.max(0, (ui.page[key] || 0) + Number(dir));
      const box = BOXES[key] && document.getElementById(`lb-${key}`);
      if (box) box.innerHTML = boxBody(key);
      else {
        const list = document.getElementById('list');
        if (list) list.innerHTML = listHtml();
      }
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
      ui.view = 'sessions';
      ui.tab = 'team';
      ui.person = t.dataset.person;
      ui.page.team = 0;
      persist();
      render();
    }
  });

  // Teclado: flechas, Inicio y Fin entre pestañas (patrón ARIA "tabs"); Enter en una persona.
  document.addEventListener('keydown', (e) => {
    const tab = e.target.closest?.('[role="tab"][data-view]');
    if (tab) {
      const i = VIEWS.indexOf(tab.dataset.view);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: VIEWS.length - 1 }[e.key];
      if (next == null) return;
      e.preventDefault();
      return setView(VIEWS[(next + VIEWS.length) % VIEWS.length], true);
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.person) {
      e.preventDefault();
      e.target.click();
    }
  });

  document.addEventListener('input', (e) => {
    const k = e.target.dataset?.search;
    if (k && BOXES[k]) {
      ui.q[k] = e.target.value;
      ui.page[k] = 0;
      const box = document.getElementById(`lb-${k}`);
      if (box) box.innerHTML = boxBody(k);
      return;
    }
    if (e.target.id === 'filter') {
      ui.filter = e.target.value;
      ui.page[ui.tab] = 0;
      const list = document.getElementById('list');
      if (list) list.innerHTML = listHtml();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'group') {
      ui.group = e.target.value;
      ui.page[ui.tab] = 0;
      persist();
      const list = document.getElementById('list');
      if (list) list.innerHTML = listHtml();
      return;
    }
    if (e.target.id === 'person') {
      ui.person = e.target.value;
      ui.page.team = 0;
      persist();
      const list = document.getElementById('list');
      if (list) list.innerHTML = listHtml();
    }
  });

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') {
      const a = document.activeElement;
      const focus = a?.id === 'filter' ? '#filter' : a?.dataset?.search ? `[data-search="${a.dataset.search}"]` : null;
      state = m.state;
      render();
      const f = focus && document.querySelector(focus);
      if (f) {
        f.focus();
        f.setSelectionRange(f.value.length, f.value.length);
      }
    }
    if (m.type === 'view') setView(m.view);
    const detail = document.getElementById('detail');
    if (m.type === 'session') {
      ui.loading = false;
      ui.detail = m.data;
      if (detail) detail.innerHTML = detailHtml();
    }
    if (m.type === 'error' && m.context === 'open') {
      ui.loading = false;
      ui.error = m.error;
      if (detail) detail.innerHTML = detailHtml();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
