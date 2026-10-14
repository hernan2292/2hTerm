# Changelog

## 0.1.1

- Renamed from 2hTerm to hTerm, now published as `HernanHerrera.hterm`. Command IDs, settings (`hterm.*`) and the SFTP scheme (`hterm-sftp://`) were renamed accordingly; sessions from the old extension can be moved over with Export / Import.
- The whole interface, README and Marketplace listing are now in English.

## 0.1.0

First release.

- SSH sessions with folders, colors, notes and drag and drop.
- Terminals in editor tabs or in the panel, with reconnect.
- Authentication by password, private key, SSH agent (OpenSSH / Pageant) and keyboard-interactive (2FA).
- Chainable jump hosts (ProxyJump).
- SFTP integrated into the Explorer: edit, download and upload.
- Local (-L), remote (-R) and SOCKS5 (-D) tunnels.
- MultiExec to type into several terminals at once.
- X11 forwarding.
- Host fingerprint verification.
- Sync across machines with Settings Sync or a private GitHub Gist.
- Encrypted vault (AES-256-GCM + scrypt) for passwords and keys.
- Import from `~/.ssh/config`, MobaXterm and JSON.
