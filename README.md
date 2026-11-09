# gc-sync · Substack → gilcarrasquero.com

Mantiene la sección de ensayos de **gilcarrasquero.com** al día con el Substack de Gil, sin intervención.

## Qué hace

Cada dos horas, en GitHub:

1. Mira los últimos ensayos publicados en Substack.
2. Compara con los índices de la web (`/en/essays/` y `/es/ensayos/`).
3. Si hay uno nuevo, lo separa en sus dos versiones (inglés · español), genera las dos páginas con el mismo diseño del resto, descarga la imagen, y añade el ensayo arriba de los dos índices y en las tarjetas de la portada.
4. Publica en Netlify **solo esos archivos**, conservando todo lo demás de la web tal cual. El deploy anterior queda en Netlify para volver atrás con un clic.
5. Avisa por correo (vía GitHub):
   - **Publicado en la web: …** cuando todo salió bien.
   - **Revisar: no pude publicar «…»** si un ensayo no tiene la estructura esperada. En ese caso no publica nada de ese ensayo, ni a medias.
   - **La sincronización falló** si algo externo falla (Substack o Netlify caídos, clave caducada…). Ese aviso se abre una sola vez y se cierra solo cuando vuelve a funcionar.

Cada publicación queda anotada en `log/registro.md`.

## Qué espera de un ensayo en Substack

La estructura habitual:

- Título y subtítulo en la forma «English | Español».
- Primero la versión inglesa, con la nota «Para español, scroll hacia abajo.».
- Un separador (la línea horizontal).
- Después la versión española, empezando por su título y su subtítulo.

Si solo hay un idioma, se publica en ese idioma. Solo se publican los ensayos públicos, no los de pago.

## Instalación (una sola vez)

1. **Repositorio.** Un repositorio **privado** de GitHub, por ejemplo `gc-sync`, con estos archivos.
2. **Clave de Netlify.** En Netlify: *User settings → Applications → Personal access tokens → New access token*. Ponle de nombre `gc-sync` y caducidad *No expiration* (o la más larga posible). Copia la clave.
3. **Guardarla en GitHub.** En el repositorio: *Settings → Secrets and variables → Actions*.
   - Pestaña *Secrets → New repository secret*: nombre `NETLIFY_AUTH_TOKEN`, valor la clave del paso 2.
   - Pestaña *Variables → New repository variable*: nombre `NETLIFY_SITE_ID`, valor el *Site ID* que aparece en Netlify en *Site configuration → General*. Este paso es opcional: sin él, el proceso busca el sitio por el dominio.
4. **Primera prueba.** *Actions → Substack → web → Run workflow*, con modo `dry-run`. Debe terminar en verde con «La web ya estaba al día».
5. Listo. A partir de ahí corre solo.

## Uso

- **Normalmente: nada.** Publica en Substack como siempre. En un máximo de unas dos horas el ensayo está en la web y te llega el aviso.
- **Corregiste una errata en Substack después de publicar:** *Actions → Substack → web → Run workflow*, con modo `production` y en *refresh* el slug del post (por ejemplo `as-thyself-como-a-ti-mismo`). Regenera las dos páginas en la misma dirección.
- **Ver antes de publicar:** *Run workflow* con modo `draft`. Deja un borrador en Netlify con su enlace de vista previa, sin tocar la web.
- **Pausar:** *Actions → Substack → web → ⋯ → Disable workflow*. Para reanudar, *Enable workflow*.
- **Deshacer una publicación:** en Netlify, *Deploys* → elegir el anterior → *Publish deploy*.

## Límites conocidos

- Si borras un ensayo en Substack, no se borra solo de la web.
- Las correcciones hechas en Substack después de publicar no se reflejan solas: se usa *refresh*.
- En cada pasada mira los 12 ensayos más recientes; es más que suficiente para publicar uno por semana.

## Archivos

- `lib/generator.js`: convierte un post de Substack en las páginas de la web. Es el mismo código que se usó para la puesta al día manual de noviembre de 2026.
- `scripts/sync.js`: lee Substack y la web, genera y publica en Netlify.
- `scripts/report.js`: resumen, avisos y registro.
- `.github/workflows/sync.yml`: el horario (cada 2 horas) y el botón *Run workflow*.
- `test/`: pruebas (`npm test`).
