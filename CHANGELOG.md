# Cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con [SemVer](https://semver.org/lang/es/).

## [0.9.2] — 2026-09-25

### Documentación
- Instalación desde el **Marketplace de VS Code** y **Open VSX** (Cursor) en el README y el manual, con badges; el `.vsix` de GitHub queda como alternativa.
- GIF de demostración arriba del README (panel real con datos de ejemplo).

### Corregido
- En inglés, «Hooks installed in Claude Code **y** Cursor»: la «y» que une las herramientas ahora se traduce (panel, *Estado* y avisos).

## [0.9.1] — 2026-09-25

### Documentación
- Guía **[Trabajar desde redes distintas](docs/REMOTE.es.md)** (y en inglés): modos `lan`/`public`/`private`, servidor propio con `npm run infra`, relay, qué pasa al conectar, avisos de *Estado* y qué pedirle a TI. Enlazada desde el manual, el README y la arquitectura.
- Ayuda de la extensión: nuevas secciones **Recorrido del panel**, **Hooks** (qué instala «Instalar hooks», qué hace en cada turno y cómo quitarlo), **Ajustes** (todos los `sessionHub.*`) y una sección de red ampliada.

### Corregido
- `npm run package` ya no depende de un `vsce` instalado globalmente: `@vscode/vsce` es dependencia de desarrollo.

## [0.9.0] — 2026-09-25

### Añadido
- **Conversaciones automáticas:** tu IA y la de un compañero conversan solas, sin que nadie pulse Enviar.
  - Funciona con los **hooks** de Claude Code (`Stop`) y de Cursor (`stop`): al terminar cada turno, `session-hub-hook` le entrega al agente la respuesta del otro para que siga.
  - **Consentimiento de los dos:** invitación firmada que el otro acepta o rechaza. Si la pide la IA por MCP (`start_conversation`), el usuario la confirma en el editor antes de que salga.
  - **Límites:** vueltas (6) y minutos (10) configurables, detector de bucles (mensajes repetidos o vacíos), y **■ Detener** para los dos. Cada mensaje llega enmarcado como información de otra sesión; el agente conserva sus permisos.
  - El hook nunca cuelga al agente: ante un error o con el hub cerrado, no hace nada. Una sola espera por conversación, aunque Cursor también importe el hook de Claude Code.
  - Instalación de los hooks **con permiso**: conserva tus hooks, guarda una copia de tus archivos, no toca un archivo que no puede leer, y se quitan con un clic. Se renuevan solos al abrir el editor.
  - Panel: sección *Conversaciones automáticas* en *Mensajes* (invitaciones, en marcha con vueltas y minutos, terminadas), **🤝 Conversar** en *Equipo*, avisos y estado de los hooks en *Estado*.
- **Pestaña Ayuda:** instrucciones y explicaciones de cada parte de la herramienta, con buscador, en español e inglés.
- Pruebas: conversación de extremo a extremo con el hook real y los datos de Claude Code y Cursor; la extensión instalando y quitando hooks sin pisar ajustes; el módulo de conversaciones; y el verificador de traducciones ahora también revisa los textos dentro de plantillas anidadas.

## [0.8.2] — 2026-09-24

### Añadido
- **Pestaña Respaldo:** resumen y espacio usado; tus sesiones respaldadas y las copias de tu equipo, con buscador, filtros (*Todas · Solo en respaldo · Con original*; por persona) y paginación. En cada una: **Ver**, **🤖 Usar en mi IA**, **Exportar** y **Borrar** (solo lo que ya no existe en el original). Configuración ahí mismo: respaldar, guardar copias, permitir que tu equipo copie lo tuyo, retención y espacio máximo.
- **🤖 Usar en mi IA** en cualquier sesión (en vivo, respaldada o copia): deja escrito en Claude Code, Copilot o Cursor el pedido de leerla con `get_session`; solo agregas tu pregunta.
- MCP: `list_sessions` con `origen: "respaldo"` lista solo lo que viene del respaldo o de copias.
- Descripción y alcance actualizados: ver, hablar, guardar y usar.
- Análisis y plan para usar **Cursor y VS Code en la misma computadora** y que sus chats se hablen, incluso de forma automática mediante hooks: [docs/SAME-MACHINE.es.md](docs/SAME-MACHINE.es.md).

### Cambiado
- **Personas del equipo, rediseñado:** buscador siempre visible, filtros rápidos (*Todos · En línea · Desconectados · Siguiendo*) y tarjetas con avatar y presencia, insignias (fundador, en pausa, bloqueado, "te leyó"), sesiones abiertas, lo que comparte contigo y los botones **Mensaje** y **Ver sesiones**. Tú primero, luego quien está en línea.

### Corregido
- **Al actualizar, la extensión nueva seguía usando el hub de la versión anterior** si había quedado corriendo (por ejemplo, tras un cierre inesperado del editor), y el panel mostraba el respaldo en cero. Ahora compara versiones y reemplaza el hub: se lo pide (`/api/shutdown`) o, si es anterior y no sabe cerrarse, termina su proceso tras comprobar que es un hub. *Estado* avisa si las versiones no coinciden, y el panel muestra los totales en vez de ceros. Probado con el hub real de 0.8.1.
- **Traducción completa:** los registros de la salida "Session Hub", las descripciones de parámetros del MCP y el detalle de la conexión en *Estado* ahora respetan el idioma. Nueva prueba que falla si aparece un texto visible sin traducir.
- **Windows: las sesiones de Cursor no aparecían** (Cursor guarda la carpeta como URL `file:///c%3A/…` y se comparaba con la ruta), y las de Claude Code podían descartarse por mayúsculas en la letra de unidad (`C:` frente a `c:`). Ahora las rutas se comparan según el sistema. Lo detectó la integración continua en Windows.
- **Las sesiones de Cursor mostraban `undefined` mensajes, sin archivos ni comandos** (desde 0.8.1): su campo propio `stats` se confundía con las cifras del respaldo. Nueva prueba con una base de Cursor sintética.
- El tamaño de un respaldo vacío se mostraba como "1 KB".
- **Cursor se congelaba (y podía cerrarse) al abrir "Cómo recibo mensajes" o "Ajustes del respaldo".** La extensión abría los ajustes con `workbench.action.openSettings`, y ese comando devuelve el editor de ajustes completo: la ventana intentaba serializarlo para enviarlo a la extensión y se quedaba sin memoria. Ahora el panel abre los ajustes con un enlace del propio webview, solo puede pedir comandos de Session Hub, y el error de puerto ocupado pide el puerto directamente.

## [0.8.1] — 2026-09-24

### Añadido
- **Respaldo local en dos capas.**
  - **Tus sesiones:** tu hub guarda una copia de las sesiones que compartes. Si Claude Code (que borra a los 30 días) o Cursor las borran, siguen disponibles para ti y para quien las compartes, marcadas "solo en respaldo". Mientras el original existe, el respaldo es un espejo exacto; si se acorta (restaurar en Cursor) se guarda la versión anterior; si una fuente falla, nada se marca como borrado.
  - **Copias de tu equipo:** copias de lectura de las sesiones de tus compañeros, para leerlas aunque estén desconectados (marcadas "copia de hace…"). Se ponen al día solo con lo nuevo. Solo mientras tengas acceso: si el dueño las oculta, deja de compartirlas o desactiva las copias (`sessionHub.allowTeamCopies`), se borran en el siguiente contacto. El dueño ve en su auditoría "guardó una copia", una vez y sin avisos.
  - Borrar del respaldo (una sesión o todo), **exportar** una sesión a Markdown o JSON y **exportar todo** a una carpeta. **"Solo yo (respaldo)"** en *Quién lo ve* respalda un proyecto sin compartirlo.
  - Escritura atómica y comprimida (0600), retención y tamaño máximo configurables, purga al salir del equipo o al expulsar a alguien.
- Pruebas de la extensión y del panel dentro del repositorio (`npm run test:ext`), también en la integración continua.
- **Buscador y paginación en todas las listas del panel:** personas, mensajes, enviados, lecturas, proyectos, estado, copias y grupos de sesiones.

### Seguridad
- **Una carpeta no compartida podía verse.** Claude Code guarda el historial en una carpeta con la ruta "codificada" (todo lo que no es letra o número pasa a `-`), así que `/x/my.app` y `/x/my-app` comparten carpeta. Si compartías una, tu equipo veía también las sesiones de la otra. Ahora cada sesión se asigna por la carpeta real donde empezó.

### Corregido
- **El MCP de Cursor se cortaba con varias ventanas abiertas:** cada ventana anulaba y volvía a registrar el servidor, y cortaba la conexión que abría la otra; al cerrar una ventana se anulaba para todas. Ahora hay un solo registro, que solo se renueva si cambia la URL.
- **El token local podía cambiar** si el llavero del sistema no respondía al arrancar, y eso rompía la conexión de Claude Code. Ahora se reutiliza el de la configuración. *Estado* avisa si Claude Code quedó desactualizado, y **Conectar Claude Code** lo registra directamente con su línea de comandos.
- `list_sessions` y `search_sessions` con "yo" devolvían vacío o un solo resultado: el MCP usa `limit: 0` para decir "todos".
- **Proyectos con el mismo nombre ya no se mezclan.** Cada proyecto tiene una clave (`projectKey`). Si es un repositorio git, sale del remoto `origin` normalizado; solo viaja un hash, nunca la URL. El mismo repo coincide aunque cada persona lo llame distinto, y dos proyectos distintos con el mismo nombre quedan separados en el panel ("web-app · Ana" y "web-app · Luis") y en el MCP, que le indica a la IA no combinarlos. Dos carpetas tuyas con el mismo nombre se distinguen: "api (pagos)".
- **El MCP nunca conectaba en Cursor** (en ninguna versión): Cursor descarta las cabeceras de los servidores MCP que registran las extensiones y solo conserva la URL, así que el token no llegaba y el hub respondía 401. Ahora el token va también en la URL. VS Code y Claude Code no cambian, porque sí respetan las cabeceras.

### Cambiado
- **"Pasar a mi IA" deja el mensaje escrito en el chat**, sin enviarlo, también en Cursor (antes solo lo copiaba) y en **Claude Code**: en la sesión a la que iba el mensaje o en tu sesión más reciente de ese proyecto. En modo automático elige el chat de la pestaña activa, el único abierto o el último que usaste; si hay varios, pregunta una vez. Ajuste `sessionHub.aiChat`.
- **Panel organizado en pestañas:** *Sesiones*, *Mensajes*, *Equipo*, *Privacidad* y *Estado*, cada una con un contador que avisa si hay algo que mirar. No se quitó nada: solo se reorganizó.
  - Aspecto de las pestañas del panel de VS Code, colores del tema (también en alto contraste), navegación con teclado (flechas, Inicio y Fin) y roles ARIA. Respeta "reducir movimiento".
  - Los avisos abren la pestaña que corresponde. El panel recuerda la última pestaña.
  - En ventanas estrechas, la conversación pasa debajo de la lista.
- **Sesiones agrupadas por proyecto** (o por persona, o sin agrupar). Cada grupo se abre y cierra, dice cuántas sesiones tiene, de quién son y cuándo fue la última actividad, y muestra las 5 más recientes con *Ver más*. Al filtrar, los grupos se abren solos. El panel recuerda cómo lo dejaste.

## [0.8.0] — 2026-09-23

### Añadido
- **Mensajes entre compañeros.** Escríbele a una persona del equipo (o a una de sus sesiones de IA abiertas) desde el panel o pidiéndoselo a tu IA.
  - Van **firmados** con tu clave y el hub del destinatario los verifica contra la conexión.
  - Por defecto quedan **retenidos** hasta que el destinatario los aprueba. Con **Pasar a mi IA** se abre el chat de su IA con el mensaje enmarcado como "de un compañero, no una orden tuya". Nada se ejecuta solo.
  - Si la persona está desconectada, **cola** de hasta 24 h. Acuses de *retenido / entregado / leído / descartado*. Respuestas enlazadas al mensaje original.
  - Ajustes `sessionHub.inboundMessages` (retener / aceptar / rechazar) y `sessionHub.notifyMessages`. Límites de 20 000 caracteres y 10 mensajes por minuto por remitente.
- **Sesiones abiertas:** el panel muestra, por persona, sus sesiones de IA abiertas (*Claude Code · api · ocupada*, *Cursor · web · activa hace poco*), solo en los proyectos que comparte contigo.
- Herramientas MCP **`list_agents`**, **`send_message`** y **`check_inbox`**.
- **Comprobación del MCP:** la extensión prueba el MCP como lo haría la IA (una conexión real). Si falla, aparece en *Estado* y en el diagnóstico, y avisa una vez con **Reiniciar**.
- **Instrucciones del MCP más claras:** si preguntan por "el doc", "la sesión" o "la conversación" de un compañero, la IA busca primero en Session Hub, aunque no se nombre, en vez de irse a otros conectores de documentos.
- Pruebas: bandeja de mensajes (5), sesiones abiertas, y el extremo a extremo ahora cubre MCP, mensajes, acuses, respuesta y entrega de la cola al reconectar.

### Corregido
- **El MCP fallaba en 0.7.x** con *"Cannot access 't' before initialization"*: una variable local tapaba la función de traducción. Tu IA volvía a no poder consultar Session Hub; ya funciona, y la prueba extremo a extremo ahora lo cubre.
- Al unirse a un equipo no aparecía el aviso *"Ya eres miembro"*.
- *Dejar de compartir* y *Quién lo ve*, elegidos desde el menú (sin proyecto), fallaban.
- El panel dejaba de cargar si alguna consulta al hub fallaba.

## [0.7.2] — 2026-09-23

### Añadido
- **Salir del equipo** e **Invitar** a mano en el panel, en *Personas del equipo* (antes solo desde la paleta de comandos). Pide confirmación antes de salir.

## [0.7.1] — 2026-09-23

### Corregido
- **Se recupera el equipo de la versión anterior.** Al cambiar el publisher (`energiasolar` → `carlosvisbal`), el editor trató la extensión como nueva y pedía crear otro equipo. Ahora, al abrirla:
  - si no tienes equipo, recupera sola el anterior, con tu identidad (huella) y tu historial de lecturas;
  - si ya creaste otro, pregunta si quieres recuperar el anterior y deja una copia del actual.

### Añadido
- Botón **ES / EN** en la cabecera del panel y comando **Session Hub: Cambiar idioma** (antes solo desde el ajuste `sessionHub.language`).

## [0.7.0] — 2026-09-23

### Añadido
- **Trabajo remoto completo:** relay ciego de respaldo cuando la conexión directa no es posible; marcado directo también en los modos `public` y `private`; detección y anuncio automático de direcciones VPN (WireGuard, Tailscale, tun/tap…).
- **`npm run infra`:** levanta 3 nodos de arranque y un relay con clave estable, e imprime los ajustes para el equipo.
- **Diagnóstico de red con causa:** UDP bloqueado, arranque inalcanzable, NAT estricto, fallo de perforación, relay caído, modo de red distinto… con aviso y **"Copiar informe de conexión"** listo para enviar a TI.
- **Paginación** en "Quién ha leído lo mío", Equipo, Siguiendo y Mis sesiones.
- **Interfaz en español e inglés** (panel, avisos, diagnóstico, informe, hub y MCP), según el idioma del editor o `sessionHub.language`; comandos y ajustes con `package.nls`.
- Pruebas: diagnóstico de red (11) y extremo a extremo con relay e infraestructura propia.

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
