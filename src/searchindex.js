// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Índice de búsqueda local (SQLite FTS5), para no volver a leer y recorrer mensaje por mensaje
// todas las sesiones en cada búsqueda. No guarda nada nuevo: lo mismo que ya está en el respaldo
// o en las sesiones en vivo (con los mismos permisos 0600), solo indexado y ya pasado por redact()
// (quien indexa da `transform`), para que buscar no sirva para adivinar un secreto. Como plus, ignora
// tildes/mayúsculas (unicode61 remove_diacritics) y ordena por relevancia (BM25) en vez de dar el
// primer resultado que aparezca.
//
// node:sqlite existe desde Node 22.5 (ya lo usa src/sources/cursor.js). Si el runtime no lo trae,
// el índice queda desactivado (`unavailable`) y quien llama debe volver al barrido lineal de
// siempre: la búsqueda nunca deja de funcionar por esto.
//
// Es un acelerador, no la fuente de verdad: si una sesión se borró del respaldo o de una copia sin
// pasar por removeSession(), search() la descarta al comprobarla con `exists` en vez de devolver
// una referencia muerta.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
export let searchIndexUnavailable = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  searchIndexUnavailable = `node:sqlite no disponible en Node ${process.versions.node} (se requiere 22.5 o superior)`;
}

// `tag` = huella de las reglas de redacción con que se preparó el texto: si cambian, se reindexa.
const hashOf = (messages, tag = '') => crypto.createHash('sha256').update(JSON.stringify([tag, messages])).digest('hex');

// Versión del esquema (PRAGMA user_version). Al cambiarla, el índice se borra y se rehace desde
// cero en la siguiente sincronización: es solo un acelerador. v2: clave (scope, owner_id, id), para
// que la copia de un compañero no pise mi sesión con el mismo id, y texto guardado ya redactado (las
// versiones anteriores guardaban el texto original, que se purga al actualizar).
const SCHEMA_VERSION = 2;

// Clave única de una sesión en el índice: el mismo id puede existir como mía y como copia de otros.
const keyOf = (scope, ownerId, id) => `${scope}\u0000${ownerId}\u0000${id}`;

// Frase literal segura para FTS5: sin esto, puntuación o palabras como "OR"/"NOT"/"NEAR" en lo que
// escribe la persona se interpretarían como sintaxis de consulta (y a veces ni siquiera es válida:
// un simple "user-service.py" sin comillas rompe la búsqueda). El "*" al final busca por prefijo en
// la última palabra ("endp" encuentra "endpoint"), lo más parecido al substring de antes.
const ftsPhrase = (q) => `"${String(q).replace(/"/g, '""')}"`;
const ftsQuery = (q) => `${ftsPhrase(q)}*`;

export function createSearchIndex({ file, log = () => {} } = {}) {
  if (!DatabaseSync || !file) return null;
  let db;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Se crea con 0600 antes de que SQLite lo abra: nunca existe, ni un instante, con otros permisos.
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    db = new DatabaseSync(file);
    // Lo borrado se sobrescribe con ceros: un texto quitado del índice no queda en páginas libres.
    db.exec('PRAGMA secure_delete = ON');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS messages;');
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('VACUUM'); // que el texto del esquema anterior no quede en el archivo
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,    -- scope + dueño + id (ver keyOf)
        id TEXT NOT NULL,
        scope TEXT NOT NULL,     -- 'own' (mis sesiones, en vivo o del respaldo) | 'copy' (de un compañero)
        owner_id TEXT NOT NULL,
        source TEXT,
        project TEXT,
        title TEXT,
        updated_at TEXT,
        tag TEXT NOT NULL,       -- reglas de redacción con que se preparó el texto (rulesTag)
        hash TEXT NOT NULL       -- de los mensajes ya indexados (y de las reglas de redacción); igual = nada que hacer
      );
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions (scope, owner_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        text,
        session_key UNINDEXED,
        role UNINDEXED,
        seq UNINDEXED,
        at UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    log(`[índice] no se pudo abrir ${file}: ${err.message}`);
    try {
      db?.close();
    } catch {}
    return null;
  }

  const stHash = db.prepare('SELECT hash FROM sessions WHERE key = ?');
  const stUpsert = db.prepare(
    'INSERT INTO sessions (key, id, scope, owner_id, source, project, title, updated_at, tag, hash) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET source=excluded.source, project=excluded.project, title=excluded.title, updated_at=excluded.updated_at, tag=excluded.tag, hash=excluded.hash',
  );
  const stDelMsgs = db.prepare('DELETE FROM messages WHERE session_key = ?');
  const stInsMsg = db.prepare('INSERT INTO messages (text, session_key, role, seq, at) VALUES (?,?,?,?,?)');
  const stDelSession = db.prepare('DELETE FROM sessions WHERE key = ?');
  const stStale = db.prepare('SELECT 1 FROM sessions WHERE scope = ? AND owner_id = ? AND tag <> ? LIMIT 1');
  const stIds = db.prepare('SELECT id FROM sessions WHERE scope = ? AND owner_id = ?');
  const stStamps = db.prepare('SELECT id, updated_at AS updatedAt FROM sessions WHERE scope = ? AND owner_id = ?');

  function remove(key) {
    db.exec('BEGIN');
    try {
      stDelSession.run(key);
      stDelMsgs.run(key);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    available: true,

    // Sin cambios desde la última vez (mismo hash de los mensajes y de `tag`): no hace nada.
    // Devuelve si indexó. `transform(text)` (p. ej. redact) se aplica antes de guardar: el índice
    // nunca guarda lo que no podría salir del hub; `tag` identifica esa transformación (si cambia,
    // se reindexa aunque los mensajes sean los mismos).
    indexSession({ id, scope, ownerId, source, project, title, updatedAt, messages, transform = null, tag = '' }) {
      const key = keyOf(scope, ownerId, id);
      const h = hashOf(messages, tag);
      const prev = stHash.get(key);
      if (prev && prev.hash === h) return false;
      const prep = (t) => (transform ? transform(t) : t);
      db.exec('BEGIN');
      try {
        stUpsert.run(key, id, scope, ownerId, source || null, project || null, title ? prep(String(title)) : null, updatedAt || null, tag || '', h);
        stDelMsgs.run(key);
        messages.forEach((m, seq) => {
          const text = typeof m?.text === 'string' && m.text ? prep(m.text) : '';
          if (text) stInsMsg.run(text, key, m.role || null, seq, m.at || null);
        });
        db.exec('COMMIT');
        return true;
      } catch (err) {
        db.exec('ROLLBACK');
        log(`[índice] no se pudo indexar ${id}: ${err.message}`);
        return false;
      }
    },

    // Sin `scope`/`ownerId` (compatibilidad): quita ese id de todos lados.
    removeSession(id, { scope, ownerId } = {}) {
      if (scope && ownerId) return remove(keyOf(scope, ownerId, id));
      for (const r of db.prepare('SELECT key FROM sessions WHERE id = ?').all(id)) remove(r.key);
    },

    // id → updatedAt de lo indexado de un dueño: para reindexar solo lo que cambió.
    stamps: (scope, ownerId) => new Map(stStamps.all(scope, ownerId).map((r) => [r.id, String(r.updatedAt ?? '')])),

    // Ids indexados de un dueño (para quitar los que ya no existen).
    ids: (scope, ownerId) => stIds.all(scope, ownerId).map((r) => r.id),

    // ¿Todo lo de este dueño se indexó con estas reglas (`tag`)? Si no, quien llama no debe fiarse
    // del índice hasta la siguiente sincronización (podría encontrar algo que las reglas nuevas tapan).
    isCurrent: (scope, ownerId, tag) => !stStale.get(scope, ownerId, tag || ''),

    // hits: [{ sessionId, scope, ownerId, source, project, title, updatedAt, role, at, snippet }],
    // ya ordenados por relevancia.
    //  - `scope`/`ownerId`: filtran en la propia consulta SQL (no solo después), para que un
    //    `ownerId` con pocos mensajes no quede fuera por el margen si otros tienen muchos.
    //  - `projects` (lista de rutas) y `excludeIds`: también en SQL, para que lo que el visor no
    //    puede ver no ocupe el lugar de lo que sí (el LIMIT se aplica después de filtrar).
    //  - `exists(scope, ownerId, sessionId)`, si se da, descarta lo que ya no esté donde debería
    //    (ver la nota de arriba) o no pase un filtro adicional.
    search(query, { limit = Infinity, scope, ownerId, projects, excludeIds, exists } = {}) {
      const q = String(query || '').trim();
      if (q.length < 2) return [];
      if (projects && !projects.length) return [];
      const where = ['messages MATCH ?'];
      const params = [ftsQuery(q)];
      if (scope) {
        where.push('s.scope = ?');
        params.push(scope);
      }
      if (ownerId) {
        where.push('s.owner_id = ?');
        params.push(ownerId);
      }
      if (projects) {
        where.push(`s.project IN (SELECT value FROM json_each(?))`);
        params.push(JSON.stringify(projects));
      }
      if (excludeIds?.length) {
        where.push(`s.id NOT IN (SELECT value FROM json_each(?))`);
        params.push(JSON.stringify(excludeIds));
      }
      // Margen sobre `limit`: algunos hits se pueden descartar al comprobarlos con `exists`.
      params.push(Math.min(Math.max(limit, 1) * 4, 2000));
      let rows;
      try {
        rows = db
          .prepare(
            `SELECT s.id AS sessionId, s.scope, s.owner_id AS ownerId, s.source, s.project, s.title, s.updated_at AS updatedAt,
                    m.role, m.at, snippet(messages, 0, '', '', '…', 30) AS snippet
             FROM messages m JOIN sessions s ON s.key = m.session_key
             WHERE ${where.join(' AND ')}
             ORDER BY bm25(messages), s.updated_at DESC
             LIMIT ?`,
          )
          .all(...params);
      } catch (err) {
        log(`[índice] búsqueda "${q}" falló: ${err.message}`);
        return [];
      }
      const out = [];
      for (const r of rows) {
        if (exists && !exists(r.scope, r.ownerId, r.sessionId)) continue;
        out.push(r);
        if (out.length >= limit) break;
      }
      return out;
    },

    close() {
      db.close();
    },
  };
}
