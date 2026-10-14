# 2hTerm

Gestor de sesiones SSH para VS Code al estilo MobaXterm, con tus conexiones sincronizadas entre todos tus equipos.

## Instalación

Busca **2hTerm** en la vista de Extensiones de VS Code, o descarga el `.vsix` de las [releases](https://github.com/hernan2292/2hTerm/releases) y usa *Extensiones → … → Instalar desde VSIX*.

## Funciones

| | |
|---|---|
| **Sesiones SSH** | Árbol con carpetas y subcarpetas, arrastrar y soltar, colores, notas. Terminales como pestañas del editor (o en el panel). Reconexión con la tecla `R`. |
| **Autenticación** | Contraseña, clave privada (con frase de paso), agente SSH (OpenSSH de Windows, `ssh-agent`, Pageant) y keyboard-interactive (2FA/OTP). |
| **Jump host** | Una sesión puede saltar a través de otra (equivale a `ProxyJump`), y se pueden encadenar. |
| **SFTP** | «Abrir SFTP» monta el servidor en el Explorer de VS Code: navegar, editar, buscar, arrastrar archivos, descargar y subir (clic derecho). |
| **Túneles** | Local `-L`, remoto `-R` y SOCKS5 dinámico `-D`, con la vista *Túneles activos* y arranque automático opcional. |
| **MultiExec** | Lo que escribes en una terminal se envía a varias a la vez (icono 📡 en la vista). |
| **X11** | Reenvío X11 hacia un servidor X local (VcXsrv / X410 con control de acceso desactivado, `-ac`). |
| **Seguridad** | Verificación de la huella del host (TOFU) con aviso si cambia. Las huellas también se sincronizan. |
| **Importar** | Desde `~/.ssh/config`, `MobaXterm.ini` / `.mxtsessions` y copias JSON de 2hTerm. |

## Sincronización entre equipos

Se configura en `2hterm.sync.provider`:

- **`settingsSync`** (por defecto): usa la Sincronización de configuración de VS Code. Inicia sesión con la **misma cuenta Microsoft o GitHub** en cada PC (icono de cuenta → *Activar sincronización de configuración*) y deja marcadas **Extensiones** y **Estado de la interfaz**. Las sesiones llegan solas.
- **`githubGist`**: guarda los datos en un Gist **privado** de tu cuenta de GitHub. Fusiona sesión por sesión, así que si editas en dos PCs a la vez no se pierde nada. Usa el inicio de sesión de GitHub integrado en VS Code.
- **`none`**: todo queda solo en este equipo.

### Contraseñas y claves

Con `2hterm.sync.secrets` = `true` (por defecto), las contraseñas, las frases de paso y las claves privadas guardadas se cifran con **AES-256-GCM** y una clave derivada con **scrypt** de tu **contraseña maestra**. Solo viaja el texto cifrado. Cada equipo pide la contraseña maestra una vez y guarda la clave derivada en el llavero del sistema (Windows Credential Manager / Keychain / libsecret).

Las rutas de las claves privadas cambian entre equipos. Por eso, en el editor de sesión puedes marcar **«Guardar la clave en la bóveda»** y la clave queda disponible en todos tus equipos.

Con `2hterm.sync.secrets` = `false`, los secretos se guardan solo en el llavero local y no se sincronizan.

> La contraseña maestra no se puede recuperar. Si la olvidas, tendrás que volver a introducir las contraseñas de tus sesiones.

## Desarrollo

```bash
npm install
npm run build        # genera dist/extension.js
npm run watch        # recompila al guardar
npm run typecheck
npm run package      # genera 2hterm-x.y.z.vsix
```

Pulsa **F5** en VS Code para abrir una ventana de pruebas con la extensión cargada.

### Publicar una versión

1. Sube `version` en `package.json` y anota los cambios en `CHANGELOG.md`.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`
3. El workflow [release.yml](.github/workflows/release.yml) compila, publica en el Marketplace (con el secreto `VSCE_PAT`) y adjunta el `.vsix` a la release de GitHub.

### Estructura

```
src/
  extension.ts   comandos y arranque
  store.ts       documento sincronizado (sesiones, carpetas, huellas, bóveda) + merge
  vault.ts       secretos cifrados / llavero local
  connection.ts  conexiones ssh2 compartidas, auth, jump host, huellas, X11
  terminal.ts    terminal SSH (Pseudoterminal) y MultiExec
  sftp.ts        FileSystemProvider sftp2h://
  tunnels.ts     túneles -L / -R / -D (SOCKS5)
  tree.ts        vistas de sesiones y túneles
  editor.ts      formulario de sesión (webview)
  importers.ts   ~/.ssh/config, MobaXterm, JSON
  sync/gist.ts   proveedor de sincronización por GitHub Gist
```

## Pendiente / ideas

RDP y VNC (lanzando `mstsc` o un visor), puerto serie, Telnet y Mosh, grabación de sesiones, macros, editor de `known_hosts` y un servidor X propio.

¿Bugs o ideas? Abre un [issue](https://github.com/hernan2292/2hTerm/issues).

## Licencia

[GPL-3.0](LICENSE)
