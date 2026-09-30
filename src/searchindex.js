// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Índice de búsqueda local (SQLite FTS5), para no volver a leer y recorrer mensaje por mensaje
// todas las sesiones en cada búsqueda. No guarda nada nuevo: lo mismo que ya está en el respaldo
// o en las sesiones en vivo (con los mismos permisos 0600), solo indexado. Como plus, ignora
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

const hashOf = (messages) => crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');

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
    db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,     -- 'own' (mis sesiones, en vivo o del respaldo) | 'copy' (de un compañero)
        owner_id TEXT NOT NULL,
        source TEXT,
        project TEXT,
        title TEXT,
        updated_at TEXT,
        hash TEXT NOT NULL       -- de los mensajes ya indexados; igual = nada que hacer
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        text,
        session_id UNINDEXED,
        role UNINDEXED,
        seq UNINDEXED,
        at UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  } catch (err) {
    log(`[índice] no se pudo abrir ${file}: ${err.message}`);
    return null;
  }

  const stHash = db.prepare('SELECT hash FROM sessions WHERE id = ?');
  const stUpsert = db.prepare(
    'INSERT INTO sessions (id, scope, owner_id, source, project, title, updated_at, hash) VALUES (?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET scope=excluded.scope, owner_id=excluded.owner_id, source=excluded.source, project=excluded.project, title=excluded.title, updated_at=excluded.updated_at, hash=excluded.hash',
  );
  const stDelMsgs = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const stInsMsg = db.prepare('INSERT INTO messages (text, session_id, role, seq, at) VALUES (?,?,?,?,?)');
  const stDelSession = db.prepare('DELETE FROM sessions WHERE id = ?');

  return {
    available: true,

    // Sin cambios desde la última vez (mismo hash de los mensajes): no hace nada. Devuelve si indexó.
    indexSession({ id, scope, ownerId, source, project, title, updatedAt, messages }) {
      const h = hashOf(messages);
      const prev = stHash.get(id);
      if (prev && prev.hash === h) return false;
      db.exec('BEGIN');
      try {
        stUpsert.run(id, scope, ownerId, source || null, project || null, title || null, updatedAt || null, h);
        stDelMsgs.run(id);
        messages.forEach((m, seq) => {
          if (m.text) stInsMsg.run(m.text, id, m.role || null, seq, m.at || null);
        });
        db.exec('COMMIT');
        return true;
      } catch (err) {
        db.exec('ROLLBACK');
        log(`[índice] no se pudo indexar ${id}: ${err.message}`);
        return false;
      }
    },

    removeSession(id) {
      stDelSession.run(id);
      stDelMsgs.run(id);
    },

    // hits: [{ sessionId, scope, ownerId, source, project, title, updatedAt, role, at, snippet }],
    // ya ordenados por relevancia.
    //  - `scope`/`ownerId`: filtran en la propia consulta SQL (no solo después), para que un
    //    `ownerId` con pocos mensajes no quede fuera por el margen si otros tienen muchos.
    //  - `exists(scope, ownerId, sessionId)`, si se da, descarta lo que ya no esté donde debería
    //    (ver la nota de arriba) o no pase un filtro adicional (p. ej. de proyecto).
    search(query, { limit = Infinity, scope, ownerId, exists } = {}) {
      const q = String(query || '').trim();
      if (q.length < 2) return [];
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
      // Margen sobre `limit`: algunos hits se pueden descartar al comprobarlos con `exists`.
      params.push(Math.min(Math.max(limit, 1) * 4, 2000));
      let rows;
      try {
        rows = db
          .prepare(
            `SELECT s.id AS sessionId, s.scope, s.owner_id AS ownerId, s.source, s.project, s.title, s.updated_at AS updatedAt,
                    m.role, m.at, snippet(messages, 0, '', '', '…', 30) AS snippet
             FROM messages m JOIN sessions s ON s.id = m.session_id
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
