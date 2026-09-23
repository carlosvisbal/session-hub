# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con [SemVer](https://semver.org/lang/es/).

## [0.6.2] — 2026-09-23

### Corregido
- En Windows, las rutas de archivos modificados salían con `\`; ahora siempre con `/`, igual para todo el equipo (lo detectó la integración continua).

## [0.6.1] — 2026-09-23

### Corregido
- **Varias ventanas del editor:** ahora comparten un solo hub. Una ventana nueva se conecta al hub ya abierto en vez de fallar con "El puerto 7420 ya está en uso"; si se cierra la ventana dueña, otra toma el relevo sola, con la misma identidad.
- Si el puerto lo ocupa otro programa, se avisa con acceso directo al ajuste `sessionHub.port`.
- Al salir de un equipo se borran también las direcciones y nombres de sus miembros; se conservan tu identidad y tus bloqueos.

### Añadido
- README en inglés y español, manual para usuarios (`docs/MANUAL.md`, `docs/MANUAL.es.md`) e integración continua en Linux, macOS y Windows.
- Publisher `carlosvisbal` y repositorio `github.com/carlosvisbal/session-hub`.

## [0.6.0] — 2026-09-23

### Seguridad (rompe compatibilidad: hay que volver a invitar a todos)
- **Identidad firmada:** una clave Ed25519 por instalación; ya no hay token de equipo compartido.
- **Pertenencia con cadena de certificados:** cualquier miembro invita; cada invitación es de un solo uso, vence en 48 h y la confirma quien la emitió (admisión). Una invitación filtrada no sirve a una segunda persona.
- **Expulsión** por quien está por encima en la cadena, propagada a todo el equipo; **bloqueo personal** que solo afecta a quien lo aplica.
- **Transporte cifrado y autenticado** (Hyperswarm/Noise). La API local escucha solo en 127.0.0.1; se retiran el HTTP por la LAN y el anuncio UDP en claro.
- Permisos por proyecto por **clave verificada** (el nombre ya no identifica).

### Añadido
- Modos de red `lan` (el equipo es la red, sin internet), `private` (nodos propios) y `public`.
- Marcado directo a miembros conocidos: equipos de 2 personas conectan en segundos.
- Panel: huella de cada persona, quién la invitó, fundador, bloquear, expulsar, admisión pendiente, conexiones rechazadas.
- Vigilante del hub (aviso si no responde en 30 s), sondeo sin solapamientos, tiempos límite en toda acción.
- MCP: `list_peers` incluye el estado de la red; los resultados vacíos explican si no hay nadie en línea.
- CLI: `npm run setup -- team create|invite|join|status`. Pruebas: `npm test`.

- **Lectura completa sin límites:** las sesiones de otra persona llegan enteras, en orden y sin recortar ningún mensaje ni comando. Viajan por páginas por el canal cifrado y se verifica el total al reensamblar. Listados, búsquedas y "qué hay nuevo" tampoco tienen tope.

### Cambiado
- MCP `get_session` devuelve la sesión completa en una sola llamada; `offset`/`limit` son opcionales.
- El hub corre por defecto con el runtime del editor (Node 24 en Cursor y VS Code): ya no hace falta instalar Node.

## [0.5.0] — 2026-09-23

### Añadido
- **Quién ve cada proyecto:** todo el equipo o personas concretas. Los proyectos restringidos no se anuncian en la red.
- **Ocultar una sesión** al equipo desde el panel (👁), aunque su proyecto esté compartido.
- **Pausa global** para dejar de compartir con un clic; aviso visible en el panel y en la barra de estado.
- **Auditoría persistente** en disco (JSONL, 90 días por defecto), que incluye los intentos de lectura sin permiso, con aviso al dueño.
- **Invitación en un solo código** (`SH1-…`) con equipo, token y direcciones; al unirse se confirma si se encontró al equipo.
- **Diagnóstico** (panel y comando): Node y SQLite, puerto, compañeros en línea, sesiones por proyecto, pausa, auditoría y qué hacer en cada caso.
- Pantalla de bienvenida y oferta para compartir la carpeta abierta.

### Cambiado
- Compartir, ocultar y pausar se aplican en caliente, sin reiniciar el hub.
- El lector de Cursor se desactiva solo, sin detener el hub, si el runtime no trae `node:sqlite`.

## [0.4.1] — 2026-09-23

### Cambiado
- Licencia `AGPL-3.0-or-later` (versión 3 o, a elección, cualquier versión posterior).
- Titular de los derechos: Carlos Visbal, a título personal.

## [0.4.0] — 2026-09-23

### Añadido
- Licencia AGPL-3.0-only, cabeceras SPDX, `NOTICE`, `AUTHORS`, `CONTRIBUTING.md` (DCO), `SECURITY.md`, `CODE_OF_CONDUCT.md`.
- El hub ofrece su código fuente en `/source` (AGPL §13); enlace en el visor web, en el panel y en las instrucciones del MCP.
- `npm run licenses`: genera `THIRD_PARTY_NOTICES.md` y falla ante licencias no compatibles.

## [0.3.1] — 2026-09-23

### Seguridad
- MCP, vista de equipo y `?peer=` solo aceptan conexiones locales: un compañero ya no puede leer a un tercero haciéndose pasar por otro.
- Las lecturas sin identificarse se registran como «Desconocido (IP)» y se avisan.

## [0.3.0] — 2026-09-23

### Añadido
- Panel principal: personas, sesiones del equipo, seguidas y propias, y quién ha leído lo mío.
- Avisos de lectura con persona, sesión, proyecto y herramienta (Cursor, VS Code, Claude Code).

## [0.2.0] — 2026-09-23

### Añadido
- Equipos con nombre y rol por persona, alias de proyectos, descubrimiento UDP y consulta entre hubs.
- Extensión para VS Code y Cursor con registro automático del MCP.

## [0.1.0] — 2026-09-23

### Añadido
- Lectores de Claude Code y Cursor, redacción de secretos, API REST y servidor MCP.
