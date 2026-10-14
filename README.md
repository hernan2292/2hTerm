# hTerm

A MobaXterm-style SSH session manager for VS Code, with your connections synced across all your machines.

## Installation

Search for **hTerm** in the VS Code Extensions view, or download the `.vsix` from the [releases](https://github.com/hernan2292/2hTerm/releases) page and use *Extensions → … → Install from VSIX*.

## Features

| | |
|---|---|
| **SSH sessions** | Tree with folders and subfolders, drag and drop, colors, notes. Terminals open as editor tabs (or in the panel). Press `R` to reconnect. |
| **Authentication** | Password, private key (with passphrase), SSH agent (Windows OpenSSH, `ssh-agent`, Pageant) and keyboard-interactive (2FA/OTP). |
| **Jump host** | A session can hop through another one (equivalent to `ProxyJump`), and hops can be chained. |
| **SFTP** | "Open SFTP" mounts the server in the VS Code Explorer: browse, edit, search, drag files in and out, download and upload (right-click). |
| **Tunnels** | Local `-L`, remote `-R` and dynamic SOCKS5 `-D`, with an *Active Tunnels* view and optional auto-start. |
| **MultiExec** | What you type in one terminal is sent to several at once (📡 icon in the view). |
| **X11** | X11 forwarding to a local X server (VcXsrv / X410 with access control disabled, `-ac`). |
| **Security** | Host fingerprint verification (TOFU) with a warning if it changes. Fingerprints are synced too. |
| **Import** | From `~/.ssh/config`, `MobaXterm.ini` / `.mxtsessions` and hTerm JSON backups. |

## Syncing across machines

Configured with `hterm.sync.provider`:

- **`settingsSync`** (default): uses VS Code Settings Sync. Sign in with the **same Microsoft or GitHub account** on each PC (Accounts icon → *Backup and Sync Settings*) and keep **Extensions** and **UI State** checked. Sessions show up on their own.
- **`githubGist`**: stores the data in a **private** Gist in your GitHub account. It merges session by session, so nothing is lost if you edit on two PCs at the same time. Uses the GitHub sign-in built into VS Code.
- **`none`**: everything stays on this machine only.

### Passwords and keys

With `hterm.sync.secrets` = `true` (default), saved passwords, passphrases and private keys are encrypted with **AES-256-GCM** using a key derived with **scrypt** from your **master password**. Only the ciphertext is synced. Each machine asks for the master password once and stores the derived key in the system keychain (Windows Credential Manager / Keychain / libsecret).

Private key paths differ between machines. That's why the session editor lets you check **"Store the key in the vault"**, which makes the key available on all your machines.

With `hterm.sync.secrets` = `false`, secrets are stored only in the local keychain and are not synced.

> The master password cannot be recovered. If you forget it, you'll have to re-enter your sessions' passwords.

## Development

```bash
npm install
npm run build        # builds dist/extension.js
npm run watch        # rebuilds on save
npm run typecheck
npm run package      # builds hterm-x.y.z.vsix
```

Press **F5** in VS Code to open a test window with the extension loaded.

### Releasing a version

1. Bump `version` in `package.json` and note the changes in `CHANGELOG.md`.
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`
3. The [release.yml](.github/workflows/release.yml) workflow builds, publishes to the Marketplace (using the `VSCE_PAT` secret) and attaches the `.vsix` to the GitHub release.

### Structure

```
src/
  extension.ts   commands and activation
  store.ts       synced document (sessions, folders, fingerprints, vault) + merge
  vault.ts       encrypted secrets / local keychain
  connection.ts  shared ssh2 connections, auth, jump host, fingerprints, X11
  terminal.ts    SSH terminal (Pseudoterminal) and MultiExec
  sftp.ts        hterm-sftp:// FileSystemProvider
  tunnels.ts     -L / -R / -D (SOCKS5) tunnels
  tree.ts        sessions and tunnels views
  editor.ts      session form (webview)
  importers.ts   ~/.ssh/config, MobaXterm, JSON
  sync/gist.ts   GitHub Gist sync provider
```

## Roadmap / ideas

RDP and VNC (launching `mstsc` or a viewer), serial port, Telnet and Mosh, session recording, macros, a `known_hosts` editor and a built-in X server.

Bugs or ideas? Open an [issue](https://github.com/hernan2292/2hTerm/issues).

## License

[GPL-3.0](LICENSE)
