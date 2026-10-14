import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Store } from './store';
import { SecretKind, VaultEntry } from './types';
import { cfg } from './util';

const CHECK_TEXT = 'hterm-vault-check';
const LOCAL_KEY = 'hterm.vaultKey';

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, Buffer.from(salt, 'base64'), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

function encrypt(key: Buffer, vid: string, text: string): VaultEntry {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return {
    vid,
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    updatedAt: Date.now(),
  };
}

function decrypt(key: Buffer, e: VaultEntry): string {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}

/**
 * Secrets storage. In synced mode, secrets are AES-256-GCM encrypted with a key derived
 * (scrypt) from a master password and stored in the synced document; the derived key is
 * cached only in this machine's OS keychain (SecretStorage). In local mode, secrets go
 * straight to SecretStorage and never leave the machine.
 */
export class Vault {
  private key?: Buffer;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
  ) {}

  get synced(): boolean {
    return cfg('sync.secrets', true);
  }

  private localName(sessionId: string, kind: SecretKind) {
    return `hterm/${sessionId}/${kind}`;
  }

  async get(sessionId: string, kind: SecretKind): Promise<string | undefined> {
    const entry = this.store.data.secrets[`${sessionId}/${kind}`];
    if (this.synced && entry) {
      const key = await this.unlock(false);
      if (key && entry.vid === this.store.data.vault?.salt) {
        try {
          return decrypt(key, entry);
        } catch {
          /* fall through to local */
        }
      }
    }
    return this.ctx.secrets.get(this.localName(sessionId, kind));
  }

  async has(sessionId: string, kind: SecretKind): Promise<boolean> {
    return !!this.store.data.secrets[`${sessionId}/${kind}`] || !!(await this.ctx.secrets.get(this.localName(sessionId, kind)));
  }

  /** Stores (or with undefined, removes) a secret. Returns false if the user cancelled unlocking. */
  async set(sessionId: string, kind: SecretKind, value: string | undefined): Promise<boolean> {
    const name = `${sessionId}/${kind}`;
    if (value === undefined) {
      await this.ctx.secrets.delete(this.localName(sessionId, kind));
      if (this.store.data.secrets[name]) {
        delete this.store.data.secrets[name];
        this.store.data.tombstones['k:' + name] = Date.now();
        await this.store.save();
      }
      return true;
    }
    if (!this.synced) {
      await this.ctx.secrets.store(this.localName(sessionId, kind), value);
      return true;
    }
    const key = await this.unlock(true);
    if (!key || !this.store.data.vault) return false;
    this.store.data.secrets[name] = encrypt(key, this.store.data.vault.salt, value);
    delete this.store.data.tombstones['k:' + name];
    await this.store.save();
    await this.ctx.secrets.delete(this.localName(sessionId, kind));
    return true;
  }

  /** Copies all secrets of one session to another (used when duplicating). */
  async copy(fromId: string, toId: string) {
    for (const kind of ['password', 'passphrase', 'privateKey'] as SecretKind[]) {
      const v = await this.get(fromId, kind);
      if (v !== undefined) await this.set(toId, kind, v);
    }
  }

  async lock() {
    this.key = undefined;
    await this.ctx.secrets.delete(LOCAL_KEY);
  }

  /** Returns the vault key, prompting for the master password when needed. */
  async unlock(createIfMissing: boolean): Promise<Buffer | undefined> {
    const meta = this.store.data.vault;
    if (!meta) {
      if (!createIfMissing) return undefined;
      return this.create();
    }
    if (this.key && this.verify(this.key)) return this.key;
    const cached = await this.ctx.secrets.get(LOCAL_KEY);
    if (cached) {
      const k = Buffer.from(cached, 'base64');
      if (this.verify(k)) return (this.key = k);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const pw = await vscode.window.showInputBox({
        title: 'hTerm: Unlock Vault',
        prompt: attempt ? 'Wrong password, try again' : 'Master password (the same on all your machines)',
        password: true,
        ignoreFocusOut: true,
      });
      if (pw === undefined) return undefined;
      const k = await derive(pw, meta.salt);
      if (this.verify(k)) {
        this.key = k;
        await this.ctx.secrets.store(LOCAL_KEY, k.toString('base64'));
        return k;
      }
    }
    vscode.window.showErrorMessage('hTerm: could not unlock the vault.');
    return undefined;
  }

  private verify(key: Buffer): boolean {
    const meta = this.store.data.vault;
    if (!meta) return false;
    try {
      return decrypt(key, meta.check) === CHECK_TEXT;
    } catch {
      return false;
    }
  }

  private async askNewPassword(title: string): Promise<string | undefined> {
    const pw = await vscode.window.showInputBox({
      title,
      prompt: 'New master password. It encrypts your synced passwords and keys; it cannot be recovered.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.length < 8 ? 'At least 8 characters' : undefined),
    });
    if (pw === undefined) return undefined;
    const again = await vscode.window.showInputBox({ title, prompt: 'Repeat the master password', password: true, ignoreFocusOut: true });
    if (again !== pw) {
      vscode.window.showErrorMessage('hTerm: the passwords do not match.');
      return undefined;
    }
    return pw;
  }

  private async create(): Promise<Buffer | undefined> {
    const pw = await this.askNewPassword('hTerm: Create Synced Vault');
    if (pw === undefined) return undefined;
    const salt = crypto.randomBytes(16).toString('base64');
    const key = await derive(pw, salt);
    this.store.data.vault = { salt, check: encrypt(key, salt, CHECK_TEXT), createdAt: Date.now() };
    await this.store.save();
    this.key = key;
    await this.ctx.secrets.store(LOCAL_KEY, key.toString('base64'));
    return key;
  }

  /** Creates the vault, or re-encrypts every secret with a new master password. */
  async changeMasterPassword() {
    if (!this.store.data.vault) {
      if (await this.create()) vscode.window.showInformationMessage('hTerm: vault created.');
      return;
    }
    const oldKey = await this.unlock(false);
    if (!oldKey) return;
    const pw = await this.askNewPassword('hTerm: Change Master Password');
    if (pw === undefined) return;
    const oldVid = this.store.data.vault.salt;
    const plain: [string, string][] = [];
    for (const [name, e] of Object.entries(this.store.data.secrets)) {
      if (e.vid !== oldVid) continue;
      try {
        plain.push([name, decrypt(oldKey, e)]);
      } catch {
        /* skip corrupt entry */
      }
    }
    const salt = crypto.randomBytes(16).toString('base64');
    const key = await derive(pw, salt);
    // createdAt is kept so this vault keeps winning merges against stale copies elsewhere.
    this.store.data.vault = {
      salt,
      check: encrypt(key, salt, CHECK_TEXT),
      createdAt: this.store.data.vault.createdAt,
      changedAt: Date.now(),
    };
    this.store.data.secrets = Object.fromEntries(plain.map(([n, v]) => [n, encrypt(key, salt, v)]));
    await this.store.save();
    this.key = key;
    await this.ctx.secrets.store(LOCAL_KEY, key.toString('base64'));
    vscode.window.showInformationMessage('hTerm: master password updated. Your other machines will ask for it again.');
  }
}
