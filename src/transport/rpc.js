// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
// Mensajes JSON por línea sobre un canal ya cifrado y autenticado.
// Toda petición tiene tiempo límite y toda respuesta pendiente se libera si el canal se cierra.
import { StringDecoder } from 'node:string_decoder';

export const MAX_FRAME = 64 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;

export function createRpc(stream, { onRequest, onMessage, label = 'compañero' }) {
  const decoder = new StringDecoder('utf8'); // no parte caracteres multibyte entre trozos
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  let closed = false;

  const send = (msg) => {
    if (closed || stream.destroyed) return false;
    stream.write(JSON.stringify(msg) + '\n');
    return true;
  };

  function dispatch(msg) {
    if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      return msg.ok ? p.resolve(msg.data) : p.reject(Object.assign(new Error(msg.error || 'error remoto'), { code: msg.code }));
    }
    if (msg.t === 'req') {
      return Promise.resolve()
        .then(() => onRequest(msg.op, msg.args || {}))
        .then(
          (data) => send({ t: 'res', id: msg.id, ok: true, data }),
          (err) => send({ t: 'res', id: msg.id, ok: false, error: err.message, code: err.code }),
        );
    }
    onMessage?.(msg);
  }

  stream.on('data', (chunk) => {
    buf += decoder.write(chunk);
    if (buf.length > MAX_FRAME) return stream.destroy(new Error('mensaje demasiado grande'));
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return stream.destroy(new Error('mensaje mal formado'));
      }
      dispatch(msg);
    }
  });

  const failAll = () => {
    closed = true;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(`Se cortó la conexión con ${label}`), { code: 'closed' }));
      pending.delete(id);
    }
  };
  stream.on('close', failAll);
  stream.on('error', failAll);

  return {
    send,
    call(op, args, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (closed) return Promise.reject(Object.assign(new Error(`No hay conexión con ${label}`), { code: 'closed' }));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error(`${label} no respondió en ${timeoutMs / 1000} s`), { code: 'timeout' }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ t: 'req', id, op, args });
      });
    },
    get pending() {
      return pending.size;
    },
  };
}
