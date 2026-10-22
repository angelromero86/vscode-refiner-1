# Refiner

Extensión de VSCode con hilos de comentarios inline que Claude Code lee y responde — sobre el código, y sobre la interfaz de tu app en el navegador.

## Instalación

Necesitas las dos mitades: la **extensión** (la UI) y las **skills** (el lado de Claude Code).

### 1. La extensión

Genera el `.vsix`:

```sh
npm install
npm run package     # -> refiner-0.0.1.vsix
```

Instálalo:

```sh
code --install-extension refiner-0.0.1.vsix
```

O en VSCode: panel **Extensions** → menú `…` → **Install from VSIX…**

### 2. Las skills

Paleta de comandos → **Refiner: Install Claude Code Skills**.

Copia `/refine-review`, `/refine-resolve` y `/refine-web` a `~/.claude/skills/` (van dentro del `.vsix`, no hay que descargar nada más), y junto a `refine-web` deja en `scripts/` el código del navegador que `/refine-resolve` usa para re-fotografiar un elemento. Reinicia la sesión de Claude Code después: las skills se descubren al arrancar.

## Uso

### 1. Deja un comentario

Pasa el ratón por el margen izquierdo de cualquier línea → aparece un **`+`** → clic, escribe y envía.

![Paso 1 — el hilo en el panel Comments (1), la línea comentada (2), el comentario (3) y /refine-resolve listo en Claude Code (4)](docs/step-1-comment.png)

### 2. Claude lo aplica

Lanza `/refine-resolve`: lee tus comentarios abiertos, hace los cambios y responde en cada hilo. Nunca resuelve — el ✓ lo das tú cuando lo has verificado.

![Paso 2 — la respuesta de Claude aparece inline en el hilo (1) y el resumen en el panel de Claude Code (2)](docs/step-2-result.png)

### 3. Cierras el hilo

**Responder**, **Resolver / Reabrir**, **Editar / Borrar**: botones en el propio hilo.

En sentido inverso, `/refine-review` hace que Claude revise el diff actual y deje él los hilos, que aparecen inline igual.

Todo se guarda en `.refiner/comments.json`.

## Review de la interfaz

El mismo ciclo, pero sobre la app en marcha: dejas los hilos **pegados a elementos de la interfaz**, estilo Figma, y Claude los resuelve.

```
Refiner: Review UI in Browser…   → Chrome se abre sobre tu app con el overlay
  C · click en un elemento         → hilo anclado a ese elemento, con captura
  … navegas, recargas …            → los pins siguen ahí, en cada página
/refine-resolve                    → Claude lee la captura, cambia el código,
                                     re-fotografía el elemento y te contesta
                                     → el pin se pone verde en el navegador
```

### 1. Abre la sesión

Paleta de comandos → **Refiner: Review UI in Browser…** → la URL de tu app (`localhost:4200`). También desde el botón del panel **Refiner › UI Threads** o con `/refine-web <url>` en Claude Code.

Se abre Chrome (o Chromium, Brave, Edge; el setting `refiner.chromePath` manda) con un **perfil propio por repo** en `~/.config/refiner/chrome/` — tu Chrome de siempre no se toca, y como el perfil persiste, haces login en tu app una vez. **No hay extensión de navegador**: el overlay se inyecta por el protocolo de DevTools en un *mundo aislado*, así que sobrevive a cualquier navegación (recargas, rutas de SPA, pestañas nuevas), la página no lo ve y su CSP no le afecta. Mientras la sesión está abierta hay un item en la barra de estado (`Refiner: localhost:4200`); al cerrar la ventana de Chrome se acaba.

En la página:

| Tecla | |
|-------|-|
| `C` | modo comentario: click en un elemento; `↑`/`↓` sube al padre / vuelve; `enter` elige el resaltado |
| `shift+C` | panel con **todos** los hilos, agrupados por página; click en uno te lleva |
| `esc` | cancela / cierra |
| `⌘↵` | publica el comentario o la respuesta |

Los pins son morados; verde cuando Claude ya ha respondido y te toca a ti; gris los resueltos. La tarjeta de un hilo es la misma conversación que en el editor — markdown, respuestas, ✓ Resolve, Delete.

### 2. Los hilos en VSCode

Los hilos de la interfaz van a **`.refiner/web-comments.json`** y se ven en dos sitios:

- **Panel Refiner › UI Threads** — todos, agrupados por página y numerados como los pins. Click en uno abre su código fuente (o su captura si no lo hay). En cada hilo: **Go to Source**, **Show in Browser** (abre la página con la tarjeta en Chrome; si no hay sesión, te ofrece abrirla), **Open Screenshot**, **Reply…**, **Resolve / Reopen**, **Delete**.
- **Inline, en el código del elemento**, cuando la app corre en modo desarrollo: Refiner pregunta al framework de quién es el elemento — Angular (`ng.getOwningComponent` → la clase por `git grep` → su `templateUrl`, con la línea del elemento), React (fiber → componente y `_debugSource`), Vue (`__file`), Svelte (`__svelte_meta`) o atributos de plugins tipo *code inspector* (`data-insp-path`…) — y el hilo aparece como una burbuja más en esa línea, con la cabecera `UI · /settings · <button> “Save changes”`. Responder, resolver, editar: igual que un hilo de código.

Cada hilo guarda además una captura del elemento con un recuadro, en `.refiner/shots/` (fuera de git: se autoignora), para que Claude *vea* lo que tú viste.

### 3. Claude lo aplica y lo comprueba

`/refine-resolve` lee los dos ficheros. Para un hilo de la interfaz mira la captura, abre el fichero que apunta `web.source`, cambia el código y **re-fotografía el elemento** con `node ~/.claude/skills/refine-web/scripts/cli.js shot <id>` (o `refiner web shot <id>` si tienes la CLI de refiner): reabre la página en tu mismo Chrome (mismas cookies), re-encuentra el elemento y compara antes y después antes de contestarte. Si la página no carga lo dice, en vez de dejar que un `lost` parezca "tu cambio borró el elemento".

**Las páginas son rutas, no URLs.** Un hilo en `/users/42/edit` aparece también en `/users/7/edit`: los ids (números, UUIDs, hex largo) se colapsan a `:id`, y el host y la query se ignoran, para que el mismo hilo valga en `localhost:4200` hoy y en `:4201` mañana.

**Los hilos siguen al elemento.** Lo que se guarda no es "el elemento" sino una huella (test id, id, texto, nombre accesible, clases estables, ruta CSS, posición); en cada carga se vota entre candidatos: `exact`, `moved` (pin con borde discontinuo) o `lost` (el hilo queda en el panel, sin pin, y no se pierde).

El fichero es **el mismo que usa `refiner web`** (la TUI): mismo esquema, misma carpeta de perfil de Chrome, así que da igual quién abra la sesión y quién haga la foto.

## Ignorar `.refiner/` en todos tus repos

Los comentarios son tuyos, no del proyecto: no tienen por qué acabar en el repo de nadie. En vez de tocar el `.gitignore` de cada uno, ignóralo una sola vez para todo tu ordenador con el **gitignore global**.

Git ya lee `~/.config/git/ignore` por defecto (desde la 2.32), así que basta con añadir la línea:

```sh
mkdir -p ~/.config/git
echo '**/.refiner/' >> ~/.config/git/ignore
```

Compruébalo desde cualquier repo con comentarios:

```sh
git check-ignore -v .refiner/comments.json
# ~/.config/git/ignore:1:**/.refiner/    .refiner/comments.json
```

Si no imprime nada, no se está aplicando. Mira si tienes un `core.excludesFile` apuntando a otro sitio y añade la línea allí:

```sh
git config --global core.excludesFile     # vacío = se usa ~/.config/git/ignore
```

Dos avisos:

- El gitignore global **solo afecta a tu máquina**. Tus compañeros no lo heredan — si en tu equipo nadie quiere versionar los comentarios, que cada uno haga lo mismo, o añadid `.refiner/` al `.gitignore` del repo.
- Git no ignora lo que ya está trackeado. Si algún `.refiner/comments.json` ya está commiteado, sácalo primero con `git rm --cached -r .refiner/`.

> Si prefieres lo contrario — compartir los comentarios con tu equipo — no ignores nada y commitea `.refiner/comments.json` como un archivo más. El formato es JSON estable y legible en un diff.

## Desarrollo

```sh
npm install
```

Abre la carpeta en VSCode y pulsa **F5**. Se abre una segunda ventana ("Extension Development Host") con Refiner cargado. Busca `[Refiner] activated for …` en la Debug Console.

Hay dos configuraciones de lanzamiento:
- **Run Refiner Extension** — el flujo normal, con Claude Code disponible.
- **Run Refiner (isolated — no Claude Code)** — solo para depurar; desactiva el resto de extensiones, así que no sirve para probar el ciclo de comentarios.

Para las skills, symlink en vez de copiarlas, así los cambios aplican al momento:

```sh
ln -sfn "$PWD/skills/refine-review"  ~/.claude/skills/refine-review
ln -sfn "$PWD/skills/refine-resolve" ~/.claude/skills/refine-resolve
ln -sfn "$PWD/skills/refine-web"     ~/.claude/skills/refine-web
```

Con el symlink `refine-web` no tiene `scripts/` (eso lo copia el comando **Install Claude Code Skills** desde `out/web` y `media/`); para que `/refine-resolve` pueda hacer fotos usa la CLI de refiner o `node out/web/cli.js shot <id>` desde este repo.

`npm: watch` recompila solo al pulsar F5. O `npm run compile` a mano.

```sh
npm test    # compila y pasa test/web.test.js; la parte de navegador usa un Chrome headless real y se salta si no hay ninguno
```

## Desinstalar

```sh
code --uninstall-extension refiner-dev.refiner
rm -r ~/.claude/skills/refine-review ~/.claude/skills/refine-resolve ~/.claude/skills/refine-web
rm -r ~/.config/refiner/chrome    # los perfiles de Chrome de las sesiones de review, si no usas la TUI
```

## Configuración

- `refiner.authorName` — nombre con el que se firman tus comentarios (por defecto, tu usuario del sistema).
- `refiner.chromePath` — binario del navegador para **Review UI in Browser** (Chrome, Chromium, Brave o Edge). Vacío = se busca en las rutas habituales; la variable de entorno `REFINER_CHROME` también vale.

### Quitar el scrollbar de los comentarios largos

VSCode limita cada cuerpo de comentario a `20em` de alto (unas 20 líneas): lo que sobra queda dentro de una barra de scroll vertical en la propia burbuja. Con Refiner te lo encuentras más que de costumbre, porque las skills piden cuerpos bien formateados: párrafos separados, bloques de código, listas. Ese formato pasa de 20em enseguida.

El tope se desactiva con un setting de **VSCode**, no de Refiner (fíjate en que no lleva el prefijo `refiner.`). En tus settings de usuario o los del workspace:

```json
{
  "comments.maxHeight": false
}
```

Es un booleano, por defecto `true`, disponible desde VSCode 1.78 (abril de 2023).

## Contrato de `.refiner/comments.json`

Para que Claude Code participe:

1. **Leer**: cada `thread` está anclado a un `file` y a un `range` de líneas (1-based). Un hilo te espera si su `status` es `"open"` y su último comentario tiene `role: "user"`.
2. **Responder**: añade un comentario al array `comments` del hilo con `"role": "assistant"`. La extensión lo muestra inline al instante.
3. **Resolver** (opcional): pon `"status": "resolved"`.

```json
{
  "id": "c-<unique>",
  "author": "Claude Code",
  "role": "assistant",
  "body": "Respuesta en Markdown.",
  "createdAt": "2026-07-17T12:00:00.000Z"
}
```

- `role`: `"user"` para humanos, `"assistant"` para Claude Code.
- **No escribas el campo `anchor`.** Lo añade la extensión para seguir el comentario cuando el código se mueve. Si el código anclado desaparece, el hilo se marca **"Outdated · code changed"** en vez de apuntar a una línea equivocada. **Refiner: Re-anchor Comments to Current Code** fuerza una pasada.

`.refiner/web-comments.json` tiene exactamente la misma forma, salvo que `file` es la página (`/users/:id/edit`), `range` es un relleno (`1–1`) y el destino real va en `web` (URL, huella del elemento, `source` con fichero y línea, `shot` con la captura). Tampoco se escribe `web`: el navegador re-encuentra el elemento a partir de él. El detalle está en `skills/refine-resolve/SKILL.md`.

## Estructura

| Ruta | Para qué |
| --- | --- |
| `src/extension.ts` | Activación, CommentController, comandos, re-anclaje. |
| `src/store.ts` | Lee/escribe/vigila `.refiner/comments.json` y `.refiner/web-comments.json`. |
| `src/anchor.ts` | Anclaje por contenido (captura + relocalización). |
| `src/types.ts` | Modelo de datos en disco (el contrato compartido). |
| `src/browser.ts` | La sesión de review en el navegador dentro de VSCode: arrancar/parar, barra de estado, log. |
| `src/tree.ts` | La vista **UI Threads**. |
| `src/web/` | El motor del navegador, sin VSCode: `session.ts` (Chrome + overlay + store), `cdp.ts`/`ws.ts` (DevTools Protocol), `chrome.ts` (binario y perfil), `page.ts` (rutas), `source.ts` (del elemento al fichero), `cli.ts` (`shot`/`list` para Claude). |
| `media/overlay.js` | El overlay que se inyecta en la página; copia literal del de la TUI de refiner. |
| `test/web.test.js` | Tests del motor (`npm test`), con un Chrome headless real. |
| `skills/refine-review/`, `skills/refine-resolve/`, `skills/refine-web/` | Las skills de Claude Code. |
