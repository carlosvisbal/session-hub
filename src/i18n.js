// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Traducción para el hub (ver media/i18n.js).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './config.js';

const { createTranslator, resolveLanguage } = createRequire(import.meta.url)('../media/i18n.js');
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const translate = createTranslator(dict);

// Idioma del hub: el de la configuración, o el del sistema si es "auto".
export const hubLanguage = (cfg) => resolveLanguage(cfg.language, process.env.SESSION_HUB_LANG || process.env.LC_ALL || process.env.LANG);
export const makeT = (cfg) => (text, vars) => translate(hubLanguage(cfg), text, vars);
