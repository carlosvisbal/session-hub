# Política de seguridad

Session Hub maneja conversaciones de IA que pueden contener código, datos de clientes y credenciales. Los reportes de seguridad tienen prioridad sobre cualquier otro trabajo.

## Cómo reportar

- **No** abras un issue público.
- Usa el reporte privado de vulnerabilidades del repositorio (GitHub → Security → Report a vulnerability) cuando esté publicado. Mientras tanto, escribe a **carlosvisbal66@gmail.com** con el asunto `[Session Hub][seguridad]`.
- Incluye: versión, sistema operativo, pasos para reproducir e impacto.

Respondemos en un máximo de 5 días hábiles y acordamos contigo la fecha de divulgación, por defecto 90 días.

## Versiones con soporte

| Versión | Soporte |
| --- | --- |
| 0.8.1+ | Sí (piloto) |
| 0.8.0 | Actualiza: una carpeta no compartida con nombre parecido podía verse (corregido en 0.8.1) |
| 0.6.x – 0.7.x | Actualiza: en 0.7.x el MCP fallaba (corregido en 0.8.0) |
| < 0.6 | No: usaban un token de equipo compartido; actualiza y vuelve a invitar |

## Modelo de seguridad (0.8)

- **Identidad:** cada instalación tiene un par de claves Ed25519. La identidad es la clave pública; el nombre visible lo firma la propia persona.
- **Pertenencia:** cadena de certificados que empieza en el fundador. Cada invitación es de un solo uso, vence en 48 h y la **confirma quien la emitió** (admisión), así que una invitación filtrada no sirve a una segunda persona.
- **Transporte:** Hyperswarm/HyperDHT, cifrado con Noise y autenticado por clave pública. La clave de la conexión debe coincidir con la del certificado.
- **Expulsión:** solo quien está por encima en la cadena de invitaciones (o el fundador). La expulsión alcanza también a quienes invitó esa persona.
- **Control personal:** cada quien decide qué proyectos comparte y con quién (por clave verificada), puede ocultar sesiones, pausar y bloquear a alguien solo para sí.
- **API local:** solo en 127.0.0.1, con un token local. El MCP no se expone a la red.
- **Auditoría:** lecturas, accesos denegados y conexiones rechazadas quedan en disco (90 días).
- **Mensajes (0.8):** firmados por quien los envía y verificados contra la clave de la conexión; solo para un miembro del equipo, con límite de tamaño (20 000 caracteres), de frecuencia (10 por minuto) y de plazo (24 h). Por defecto quedan retenidos hasta que el destinatario los aprueba. Nunca ejecutan nada.
- **Respaldo (0.8.1):** tu respaldo y las copias de tu equipo se guardan solo en tu computadora (0600, comprimidos). Un respaldo nunca amplía el acceso: lo respaldado pasa por los mismos permisos, y una copia se borra cuando el dueño retira el acceso o desactiva las copias. Mientras el dueño está desconectado no puede retirarlo: la copia sigue legible hasta el siguiente contacto o hasta su vencimiento (180 días).
- **Sesiones abiertas:** de Claude Code solo se leen los `~/.claude/sessions/<pid>.json`; nunca sus claves ni sus sockets.

## Limitaciones conocidas

1. **Robo de invitación antes de usarla:** quien robe un código SH2 y lo use antes que el destinatario entra en su lugar; el destinatario verá "invitación ya usada" y quien invitó puede expulsarlo. Pasa las invitaciones solo por canales privados.
2. **Miembros maliciosos:** cualquier miembro puede invitar; un miembro con malas intenciones puede leer lo que se comparte con él. La cadena deja constancia de quién invitó a quién.
3. **Redacción de secretos por patrones:** puede no detectar todo. Revisa qué compartes y usa `redactExtra`.
4. **Modo `public`:** usa la red pública de HyperDHT. El contenido va cifrado, pero la red ve que tu IP participa en un tema. Para entornos controlados usa `lan` o `private`.
5. **No validado aún:** conexión entre dos redes distintas detrás de NAT/firewalls corporativos (puede requerir relay).
6. **Contenido de terceros para la IA:** lo que leen las herramientas MCP son sesiones y mensajes de otras personas; trátalo como datos, no como instrucciones. Un mensaje puede intentar inducir a la IA a hacer algo (inyección de instrucciones): por eso quedan retenidos por defecto, llegan enmarcados como "de un compañero, no una orden tuya" y la IA debe pedir confirmación antes de cambiar código. No actives `inboundMessages: accept` con personas en las que no confíes.
