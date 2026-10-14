import * as vscode from 'vscode';
import { Folder, KnownHost, Session, SyncDoc } from './types';

export const DOC_KEY = '2hterm.doc';
const TOMBSTONE_TTL = 1000 * 60 * 60 * 24 * 180;

export function emptyDoc(): SyncDoc {
  return { v: 1, sessions: {}, folders: {}, knownHosts: {}, secrets: {}, tombstones: {} };
}

function normalize(raw: unknown): SyncDoc {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncDoc>;
  return {
    v: 1,
    sessions: d.sessions ?? {},
    folders: d.folders ?? {},
    knownHosts: d.knownHosts ?? {},
    secrets: d.secrets ?? {},
    vault: d.vault,
    tombstones: d.tombstones ?? {},
  };
}

function mergeMap<T extends { updatedAt: number }>(
  a: Record<string, T>,
  b: Record<string, T>,
  prefix: string,
  tombstones: Record<string, number>,
  keep: (v: T) => boolean = () => true,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key];
    const y = b[key];
    const winner = !x ? y : !y ? x : y.updatedAt > x.updatedAt ? y : x;
    const deletedAt = tombstones[prefix + key];
    if (deletedAt !== undefined && deletedAt >= winner.updatedAt) continue;
    if (!keep(winner)) continue;
    out[key] = winner;
  }
  return out;
}

/** Item-level last-writer-wins merge of two documents. Used by the Gist provider. */
export function mergeDocs(local: SyncDoc, remote: SyncDoc): SyncDoc {
  const now = Date.now();
  const tombstones: Record<string, number> = {};
  for (const [k, t] of [...Object.entries(local.tombstones), ...Object.entries(remote.tombstones)]) {
    if (now - t > TOMBSTONE_TTL) continue;
    tombstones[k] = Math.max(tombstones[k] ?? 0, t);
  }
  // The oldest vault wins (latest password change on ties); secrets encrypted with another vault are dropped.
  let vault = local.vault ?? remote.vault;
  if (local.vault && remote.vault) {
    const l = local.vault;
    const r = remote.vault;
    if (r.createdAt < l.createdAt || (r.createdAt === l.createdAt && (r.changedAt ?? 0) > (l.changedAt ?? 0))) vault = r;
  }
  return {
    v: 1,
    sessions: mergeMap(local.sessions, remote.sessions, 's:', tombstones),
    folders: mergeMap(local.folders, remote.folders, 'f:', tombstones),
    knownHosts: mergeMap(local.knownHosts, remote.knownHosts, 'h:', tombstones),
    secrets: mergeMap(local.secrets, remote.secrets, 'k:', tombstones, (e) => !!vault && e.vid === vault.salt),
    vault,
    tombstones,
  };
}

/** Stable serialization so two equal docs compare equal regardless of key order. */
export function canonical(doc: SyncDoc): string {
  return JSON.stringify(doc, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

/**
 * Holds all synchronized data in a single globalState key. When the provider is
 * Settings Sync, the key is registered with setKeysForSync so VS Code carries it
 * to every machine signed in with the same account.
 */
export class Store implements vscode.Disposable {
  private doc: SyncDoc;
  private snapshot: string;
  private readonly emitter = new vscode.EventEmitter<{ external: boolean }>();
  readonly onDidChange = this.emitter.event;
  private readonly timer: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.doc = normalize(ctx.globalState.get(DOC_KEY));
    this.snapshot = canonical(this.doc);
    // Settings Sync updates globalState silently; poll for changes coming from other machines.
    this.timer = setInterval(() => this.checkExternal(), 10_000);
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => s.focused && this.checkExternal()),
    );
  }

  dispose() {
    clearInterval(this.timer);
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }

  setSyncedWithSettingsSync(enabled: boolean) {
    this.ctx.globalState.setKeysForSync(enabled ? [DOC_KEY] : []);
  }

  checkExternal() {
    const raw = normalize(this.ctx.globalState.get(DOC_KEY));
    const snap = canonical(raw);
    if (snap !== this.snapshot) {
      this.doc = raw;
      this.snapshot = snap;
      this.emitter.fire({ external: true });
    }
  }

  get data(): SyncDoc {
    return this.doc;
  }

  get sessions(): Session[] {
    return Object.values(this.doc.sessions);
  }

  get folders(): Folder[] {
    return Object.values(this.doc.folders);
  }

  getSession(id: string): Session | undefined {
    return this.doc.sessions[id];
  }

  getFolder(id: string): Folder | undefined {
    return this.doc.folders[id];
  }

  folderPath(id: string | undefined): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const f = this.doc.folders[id];
      if (!f) break;
      parts.unshift(f.name);
      id = f.parentId;
    }
    return parts.join(' / ');
  }

  async upsertSession(s: Session) {
    s.updatedAt = Date.now();
    this.doc.sessions[s.id] = s;
    delete this.doc.tombstones['s:' + s.id];
    await this.save();
  }

  async upsertSessions(list: Session[]) {
    const now = Date.now();
    for (const s of list) {
      s.updatedAt = now;
      this.doc.sessions[s.id] = s;
    }
    await this.save();
  }

  async deleteSession(id: string, save = true) {
    const now = Date.now();
    delete this.doc.sessions[id];
    this.doc.tombstones['s:' + id] = now;
    for (const key of Object.keys(this.doc.secrets)) {
      if (key.startsWith(id + '/')) {
        delete this.doc.secrets[key];
        this.doc.tombstones['k:' + key] = now;
      }
    }
    if (save) await this.save();
  }

  async upsertFolder(f: Folder) {
    f.updatedAt = Date.now();
    this.doc.folders[f.id] = f;
    delete this.doc.tombstones['f:' + f.id];
    await this.save();
  }

  /** Deletes a folder together with its subfolders and sessions. */
  async deleteFolder(id: string) {
    const now = Date.now();
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.folders) {
        if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
          doomed.add(f.id);
          grew = true;
        }
      }
    }
    for (const s of this.sessions) {
      if (s.folderId && doomed.has(s.folderId)) await this.deleteSession(s.id, false);
    }
    for (const fid of doomed) {
      delete this.doc.folders[fid];
      this.doc.tombstones['f:' + fid] = now;
    }
    await this.save();
  }

  knownHost(hostId: string): KnownHost | undefined {
    return this.doc.knownHosts[hostId];
  }

  async setKnownHost(hostId: string, fp: string | undefined) {
    if (fp) {
      this.doc.knownHosts[hostId] = { fp, updatedAt: Date.now() };
      delete this.doc.tombstones['h:' + hostId];
    } else {
      delete this.doc.knownHosts[hostId];
      this.doc.tombstones['h:' + hostId] = Date.now();
    }
    await this.save();
  }

  /** Replaces the whole document (after a merge with a remote copy). */
  async replace(doc: SyncDoc) {
    this.doc = normalize(doc);
    await this.save(true);
  }

  async save(external = false) {
    this.snapshot = canonical(this.doc);
    await this.ctx.globalState.update(DOC_KEY, this.doc);
    this.emitter.fire({ external });
  }
}
