// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Traducción español ↔ inglés, compartida por el hub, la extensión y el panel.
//
// Los textos se escriben en español (el idioma del código). El diccionario en inglés
// (locales/en.json) tiene una entrada por texto; las plantillas usan {v1}, {v2}…:
//   "Equipo \"{v1}\" creado."  →  "Team \"{v1}\" created."
// Un texto ya armado (con los datos adentro) también se traduce, reconociendo su plantilla.
(function (root) {
  const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function createTranslator(dict = {}) {
    // Plantillas con marcadores, de la más específica (más larga) a la más general.
    const templates = Object.keys(dict)
      .filter((k) => /\{\w+\}/.test(k))
      .sort((a, b) => b.length - a.length)
      .map((k) => {
        const names = [];
        const pattern = k
          .split(/(\{\w+\})/)
          .map((part) => {
            const m = /^\{(\w+)\}$/.exec(part);
            if (!m) return escape(part);
            names.push(m[1]);
            return '([\\s\\S]*?)';
          })
          .join('');
        return { re: new RegExp(`^${pattern}$`), names, en: dict[k] };
      });

    return function translate(lang, text, vars) {
      if (text == null) return text;
      const s = String(text);
      if (lang !== 'en') return fill(s, vars);
      if (dict[s] != null) return fill(dict[s], vars);
      const filled = vars ? fill(s, vars) : s;
      for (const t of templates) {
        const m = t.re.exec(filled);
        if (m) return fill(t.en, Object.fromEntries(t.names.map((n, i) => [n, m[i + 1]])));
      }
      return filled;
    };
  }

  // 'auto' → idioma del entorno (editor o sistema); cualquier variante de español → 'es'; el resto → 'en'.
  function resolveLanguage(pref, envLang) {
    if (pref === 'es' || pref === 'en') return pref;
    return /^es\b|^es[-_]/i.test(envLang || '') ? 'es' : 'en';
  }

  const api = { createTranslator, resolveLanguage };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionHubI18n = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
