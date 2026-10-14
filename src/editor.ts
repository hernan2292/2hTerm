import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { Store } from './store';
import { Forward, Session } from './types';
import { errMsg, expandHome, newId } from './util';
import { Vault } from './vault';

interface SavePayload {
  session: Session;
  password: string;
  clearPassword: boolean;
  passphrase: string;
  clearPassphrase: boolean;
  embedKey: boolean;
  clearEmbeddedKey: boolean;
}

const COLORS = ['', 'terminal.ansiRed', 'terminal.ansiGreen', 'terminal.ansiYellow', 'terminal.ansiBlue', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiWhite'];

export function blankSession(folderId?: string): Session {
  return { id: newId(), name: '', folderId, host: '', port: 22, username: '', auth: 'password', forwards: [], updatedAt: 0 };
}

export class SessionEditor {
  private static readonly panels = new Map<string, vscode.WebviewPanel>();

  static async open(store: Store, vault: Vault, session: Session, isNew: boolean) {
    const existing = this.panels.get(session.id);
    if (existing) return existing.reveal();

    const panel = vscode.window.createWebviewPanel('hterm.editor', isNew ? 'New Session' : `Edit: ${session.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.iconPath = new vscode.ThemeIcon('vm');
    this.panels.set(session.id, panel);
    panel.onDidDispose(() => this.panels.delete(session.id));

    const init = {
      session,
      isNew,
      folders: store.folders.map((f) => ({ id: f.id, path: store.folderPath(f.id) })).sort((a, b) => a.path.localeCompare(b.path)),
      jumps: store.sessions.filter((s) => s.id !== session.id).map((s) => ({ id: s.id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name)),
      hasPassword: await vault.has(session.id, 'password'),
      hasPassphrase: await vault.has(session.id, 'passphrase'),
      hasEmbeddedKey: await vault.has(session.id, 'privateKey'),
      syncSecrets: vault.synced,
      colors: COLORS,
    };
    panel.webview.html = html(panel.webview, init);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'cancel') return panel.dispose();
      if (msg.type === 'browseKey') {
        const pick = await vscode.window.showOpenDialog({ title: 'Private Key', canSelectMany: false, openLabel: 'Use This Key' });
        if (pick?.[0]) panel.webview.postMessage({ type: 'keyPath', path: pick[0].fsPath });
        return;
      }
      if (msg.type === 'save') {
        try {
          await save(store, vault, msg as SavePayload);
          panel.dispose();
        } catch (e) {
          vscode.window.showErrorMessage(`hTerm: ${errMsg(e)}`);
        }
      }
    });
  }
}

async function save(store: Store, vault: Vault, p: SavePayload) {
  const s = p.session;
  s.name = s.name.trim() || `${s.username ? s.username + '@' : ''}${s.host}`;
  s.port = Number(s.port) || 22;
  s.forwards = (s.forwards ?? [])
    .map((f: Forward) => ({ ...f, id: f.id || newId(), bindPort: Number(f.bindPort), destPort: f.destPort ? Number(f.destPort) : undefined }))
    .filter((f) => f.bindPort > 0 && (f.type === 'D' || (f.destHost && f.destPort)));
  for (const k of Object.keys(s) as (keyof Session)[]) if (s[k] === '') delete s[k];

  let secretsSaved = true;
  const put = async (kind: 'password' | 'passphrase' | 'privateKey', clear: boolean, value: string | undefined) => {
    if (clear) await vault.set(s.id, kind, undefined);
    else if (value) secretsSaved = (await vault.set(s.id, kind, value)) && secretsSaved;
  };
  await put('password', p.clearPassword, p.password);
  await put('passphrase', p.clearPassphrase, p.passphrase);
  await put('privateKey', p.clearEmbeddedKey, p.embedKey && s.keyPath ? fs.readFileSync(expandHome(s.keyPath), 'utf8') : undefined);

  await store.upsertSession(s);
  if (!secretsSaved) vscode.window.showWarningMessage('hTerm: the session was saved, but the secrets were not (the vault was not unlocked).');
}

function html(webview: vscode.Webview, init: unknown): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const data = JSON.stringify(init).replace(/</g, '\\u003c');
  return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 24px 40px; max-width: 760px; }
  h1 { font-size: 1.4em; font-weight: 600; }
  fieldset { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; padding: 12px 16px 16px; margin: 0 0 16px; }
  legend { padding: 0 6px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 170px 1fr; gap: 8px 12px; align-items: center; }
  label { color: var(--vscode-descriptionForeground); }
  input, select, textarea { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; border-radius: 2px; box-sizing: border-box; width: 100%; }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input[type=checkbox] { width: auto; }
  .row { display: flex; gap: 8px; align-items: center; }
  .hint { font-size: 0.9em; color: var(--vscode-descriptionForeground); grid-column: 2; margin-top: -4px; }
  button { font: inherit; padding: 5px 14px; border: none; border-radius: 2px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.icon { padding: 3px 8px; }
  .actions { display: flex; gap: 8px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 3px 4px 3px 0; }
  .hidden { display: none !important; }
  .badge { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
</style></head>
<body>
<h1 id="title"></h1>
<form id="f">
<fieldset><legend>General</legend><div class="grid">
  <label for="name">Name</label><input id="name" placeholder="(defaults to user@host)">
  <label for="host">Host *</label><input id="host" required placeholder="server.example.com or 10.0.0.5">
  <label for="port">Port</label><input id="port" type="number" min="1" max="65535">
  <label for="username">Username</label><input id="username">
  <label for="folderId">Folder</label><select id="folderId"></select>
  <label for="color">Color</label><select id="color"></select>
</div></fieldset>

<fieldset><legend>Authentication</legend><div class="grid">
  <label for="auth">Method</label>
  <select id="auth">
    <option value="password">Password</option>
    <option value="key">Private key</option>
    <option value="agent">SSH agent (OpenSSH / Pageant)</option>
    <option value="interactive">Keyboard-interactive (2FA / OTP)</option>
  </select>
  <label for="password" class="pw">Password</label>
  <div class="row pw"><input id="password" type="password" autocomplete="new-password"><label class="row"><input id="clearPassword" type="checkbox">forget</label></div>
  <div class="hint pw" id="pwHint"></div>
  <label for="keyPath" class="key">Private key</label>
  <div class="row key"><input id="keyPath" placeholder="~/.ssh/id_ed25519"><button type="button" class="secondary icon" id="browse">…</button></div>
  <label class="key"></label>
  <div class="key"><label class="row"><input id="embedKey" type="checkbox"><span id="embedLabel"></span></label><label class="row" id="clearKeyRow"><input id="clearEmbeddedKey" type="checkbox">remove the key stored in the vault</label></div>
  <label for="passphrase" class="key">Passphrase</label>
  <div class="row key"><input id="passphrase" type="password" autocomplete="new-password" placeholder="(optional)"><label class="row"><input id="clearPassphrase" type="checkbox">forget</label></div>
</div></fieldset>

<fieldset><legend>Advanced</legend><div class="grid">
  <label for="jumpId">Jump host</label><select id="jumpId"></select>
  <label for="startupCommand">Startup command</label><input id="startupCommand" placeholder="e.g. cd /var/www && ls">
  <label for="x11">X11 forwarding</label><label class="row"><input id="x11" type="checkbox">Forward X11 (requires a local X server, e.g. VcXsrv with -ac)</label>
  <label for="notes">Notes</label><textarea id="notes" rows="3"></textarea>
</div></fieldset>

<fieldset><legend>Tunnels</legend>
  <table><tbody id="fw"></tbody></table>
  <div class="row" style="margin-top:8px"><button type="button" class="secondary" id="addFw">+ Add tunnel</button>
  <label class="row" style="margin-left:auto"><input id="autoTunnels" type="checkbox">Start when the terminal opens</label></div>
</fieldset>

<div class="actions"><button type="submit">Save</button><button type="button" class="secondary" id="cancel">Cancel</button></div>
</form>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const init = ${data};
const s = init.session;
const $ = (id) => document.getElementById(id);
$('title').textContent = init.isNew ? 'New SSH Session' : 'Edit Session';

const opt = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
$('folderId').append(opt('', '(root)'), ...init.folders.map(f => opt(f.id, f.path)));
$('jumpId').append(opt('', '(none)'), ...init.jumps.map(j => opt(j.id, j.name)));
$('color').append(...init.colors.map(c => opt(c, c ? c.replace('terminal.ansi', '') : '(default)')));

for (const k of ['name','host','port','username','folderId','color','auth','keyPath','jumpId','startupCommand','notes']) $(k).value = s[k] ?? '';
$('x11').checked = !!s.x11;
$('autoTunnels').checked = !!s.autoTunnels;

const where = init.syncSecrets ? 'synced encrypted vault' : 'local keychain of this machine';
$('pwHint').textContent = (init.hasPassword ? 'A password is saved; leave empty to keep it. ' : 'Leave empty to be asked when connecting. ') + 'It is stored in the ' + where + '.';
$('embedLabel').textContent = init.syncSecrets ? 'Store the key in the vault (available on all your machines)' : 'Store the key in the local keychain';
if (init.hasEmbeddedKey) $('embedLabel').textContent += ' — already stored';
$('clearKeyRow').classList.toggle('hidden', !init.hasEmbeddedKey);
if (init.hasPassphrase) $('passphrase').placeholder = '(saved; empty = keep)';

function syncAuth() {
  const a = $('auth').value;
  document.querySelectorAll('.pw').forEach(e => e.classList.toggle('hidden', a !== 'password' && a !== 'interactive'));
  document.querySelectorAll('.key').forEach(e => e.classList.toggle('hidden', a !== 'key'));
}
$('auth').addEventListener('change', syncAuth); syncAuth();

const fwBody = $('fw');
function addForward(f) {
  const tr = document.createElement('tr');
  tr.dataset.id = f.id || '';
  tr.innerHTML = '<td style="width:120px"><select data-k="type"><option value="L">Local (-L)</option><option value="R">Remote (-R)</option><option value="D">SOCKS (-D)</option></select></td>' +
    '<td><input data-k="bindHost" placeholder="127.0.0.1"></td><td style="width:90px"><input data-k="bindPort" type="number" placeholder="port"></td>' +
    '<td class="dest">→</td><td class="dest"><input data-k="destHost" placeholder="destination"></td><td class="dest" style="width:90px"><input data-k="destPort" type="number" placeholder="port"></td>' +
    '<td style="width:30px"><button type="button" class="secondary icon" title="Remove">✕</button></td>';
  for (const el of tr.querySelectorAll('[data-k]')) el.value = f[el.dataset.k] ?? '';
  const sel = tr.querySelector('select');
  const upd = () => tr.querySelectorAll('.dest').forEach(td => td.style.visibility = sel.value === 'D' ? 'hidden' : 'visible');
  sel.addEventListener('change', upd); upd();
  tr.querySelector('button').addEventListener('click', () => tr.remove());
  fwBody.append(tr);
}
(s.forwards || []).forEach(addForward);
$('addFw').addEventListener('click', () => addForward({ type: 'L', bindHost: '127.0.0.1' }));

$('browse').addEventListener('click', () => vscode.postMessage({ type: 'browseKey' }));
window.addEventListener('message', e => { if (e.data.type === 'keyPath') $('keyPath').value = e.data.path; });
$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

$('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const session = { ...s };
  for (const k of ['name','host','port','username','folderId','color','auth','keyPath','jumpId','startupCommand','notes']) session[k] = $(k).value.trim();
  session.x11 = $('x11').checked;
  session.autoTunnels = $('autoTunnels').checked;
  session.forwards = [...fwBody.querySelectorAll('tr')].map(tr => {
    const f = { id: tr.dataset.id };
    for (const el of tr.querySelectorAll('[data-k]')) f[el.dataset.k] = el.value.trim();
    return f;
  });
  vscode.postMessage({
    type: 'save', session,
    password: $('password').value, clearPassword: $('clearPassword').checked,
    passphrase: $('passphrase').value, clearPassphrase: $('clearPassphrase').checked,
    embedKey: $('embedKey').checked, clearEmbeddedKey: $('clearEmbeddedKey').checked,
  });
});
$('host').focus();
</script>
</body></html>`;
}
