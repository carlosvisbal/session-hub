// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const INSTRUCTIONS = `Este servidor expone, en solo lectura, las sesiones de IA (Claude Code y Cursor) de los compañeros del equipo en la red local.
Cada resultado indica de quién es (owner / member). Si el usuario pregunta por alguien concreto, pasa su nombre en "peer".
Para ponerte al día usa list_peers y luego what_changed; get_session da el detalle de una sesión.
Los secretos vienen como [REDACTED]. Los paths son relativos a la raíz de cada proyecto.`;

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// Una lista vacía no dice si "no hay nada" o "no hay nadie": se explica para que la IA no adivine.
const explain = (result, peer) =>
  Array.isArray(result) && !result.length
    ? { resultado: [], nota: peer ? `Sin resultados de ${peer}.` : 'No hay compañeros en línea en este momento (usa list_peers para ver quién está conectado), o no tienen nada compartido contigo.' }
    : result;
const peer = z
  .string()
  .optional()
  .describe('De quién leer: nombre del compañero (ver list_peers), "yo" para mis sesiones o "todos". Vacío = todos los compañeros menos yo');
const since = z.string().optional().describe('Desde cuándo: ISO 8601 o relativo como "30m", "2h", "3d"');
const project = z.string().optional().describe('Nombre del proyecto tal como lo comparte ese compañero (ver list_peers)');

export function createMcpServer(team, software, origin = { via: 'mcp' }) {
  const notice = `\nSession Hub ${software.version} es software libre (${software.license}); código fuente: ${software.source}`;
  const server = new McpServer({ name: 'session-hub', version: software.version }, { instructions: INSTRUCTIONS + notice });

  server.registerTool(
    'list_peers',
    {
      title: 'Equipo',
      description: 'Lista al equipo (nombre, rol, huella, quién está en línea, qué comparte contigo) y el estado de la conexión. Úsalo primero si una consulta vuelve vacía.',
      inputSchema: {},
    },
    async () => json({ equipo: team.peersInfo(), red: team.networkStatus() }),
  );

  server.registerTool(
    'what_changed',
    {
      title: 'Qué hay nuevo',
      description:
        'Resumen por compañero de lo trabajado desde una fecha: peticiones a la IA, archivos modificados, comandos y el último mensaje de la IA por sesión.',
      inputSchema: { peer, since: since.default('24h'), project },
    },
    async (args) => json(explain(await team.whatChanged(args, origin), args.peer)),
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'Listar sesiones',
      description: 'Lista sesiones de Claude Code y Cursor, las más recientes primero, indicando de quién es cada una.',
      inputSchema: {
        peer,
        project,
        source: z.enum(['claude-code', 'cursor']).optional(),
        since,
        limit: z.number().int().min(0).default(0).describe('0 = todas'),
      },
    },
    async (args) => json(explain(await team.listSessions(args, origin), args.peer)),
  );

  server.registerTool(
    'get_session',
    {
      title: 'Leer sesión completa',
      description:
        'Lee una sesión COMPLETA: todos los mensajes, en orden y sin recortar ninguno. ' +
        'Opcional: offset y limit para leerla por partes (si la respuesta trae siguiente_offset, sigue desde ahí).',
      inputSchema: {
        id: z.string().describe('Id de la sesión, p.ej. "claude:…" o "cursor:…"'),
        peer: peer.describe('Dueño de la sesión, si lo sabes (acelera la búsqueda)'),
        offset: z.number().int().min(0).default(0).describe('Primer mensaje (0 = el inicio)'),
        limit: z.number().int().min(0).default(0).describe('0 = hasta el final, sin límite'),
      },
    },
    async ({ id, peer, offset, limit }) => {
      // Sin límite: desde offset hasta el final, entero. Con limit: solo esa parte.
      const s = !limit ? await team.getSession(id, { peer, full: true, from: offset }, origin) : await team.getSessionPage(id, { peer, offset, limit }, origin);
      const end = s.offset + s.conversation.length;
      const more = end < s.total;
      return json({
        mensajes: `${s.offset + 1}–${end} de ${s.total}`,
        completa: !more && s.offset === 0,
        hay_mas: more,
        ...(more ? { siguiente_offset: end, nota: `Faltan ${s.total - end} mensajes: llama de nuevo con offset=${end}.` } : {}),
        ...s,
      });
    },
  );

  server.registerTool(
    'search_sessions',
    {
      title: 'Buscar en sesiones',
      description: 'Busca un texto (endpoint, modelo, archivo…) en las conversaciones del equipo.',
      inputSchema: { query: z.string().min(2), peer, project, limit: z.number().int().min(0).default(0).describe('0 = todos los resultados') },
    },
    async ({ query, ...q }) => json(explain(await team.search(query, q, origin), q.peer)),
  );

  return server;
}
