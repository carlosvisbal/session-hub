# Cómo contribuir

Gracias por querer mejorar Session Hub. Este proyecto es software libre bajo **AGPL-3.0-or-later**: todo aporte se publica bajo esa misma licencia.

## Certificado de Origen del Desarrollador (DCO)

No pedimos ceder derechos de autor. Cada commit debe llevar la firma del [DCO 1.1](https://developercertificate.org/), con la que declaras que tienes derecho a aportar ese código bajo la licencia del proyecto:

```bash
git commit -s -m "feat(cursor): leer conversaciones archivadas"
# añade: Signed-off-by: Tu Nombre <tu@correo>
```

Los pull requests sin `Signed-off-by` no se pueden fusionar. En tu primer aporte, añade tu nombre a `AUTHORS`.

## Antes de abrir un pull request

1. Abre primero un issue para cambios grandes, para acordar el enfoque.
2. Cada archivo nuevo empieza con la cabecera de licencia:
   ```js
   // SPDX-License-Identifier: AGPL-3.0-or-later
   // Copyright (C) 2026 Los autores de Session Hub (ver AUTHORS)
   ```
3. Si añades una dependencia, ejecuta `npm run licenses`. Falla si su licencia no es compatible con AGPL-3.0.
4. No subas historiales reales de Cursor o Claude Code como datos de prueba. Usa datos anonimizados.
5. Los cambios que afectan seguridad o privacidad (lectores, redacción, red, identidad) necesitan la revisión de un segundo mantenedor.

## Estilo

- Mensajes de commit con [Conventional Commits](https://www.conventionalcommits.org/es/): `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
- Comentarios y textos de la interfaz en español; los nombres en el código, en inglés.
- El código nuevo se parece al que lo rodea: mismos nombres, mismo nivel de comentarios.

## Reportar vulnerabilidades

No abras un issue público. Sigue [SECURITY.md](SECURITY.md).
