import * as path from 'path';
import { SFTPWrapper, Stats } from 'ssh2';
import * as vscode from 'vscode';
import { ConnectionManager, Lease } from './connection';
import { call } from './util';

export const SFTP_SCHEME = 'hterm-sftp';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function typeOf(mode: number): vscode.FileType {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return vscode.FileType.Directory;
  if (t === S_IFLNK) return vscode.FileType.SymbolicLink;
  return vscode.FileType.File;
}

function mapError(err: unknown, uri: vscode.Uri): Error {
  const code = (err as { code?: number }).code;
  if (code === 2) return vscode.FileSystemError.FileNotFound(uri);
  if (code === 3) return vscode.FileSystemError.NoPermissions(uri);
  return err instanceof Error ? err : new Error(String(err));
}

interface Conn {
  sftp: Promise<SFTPWrapper>;
  lease?: Lease;
}

/**
 * Exposes remote hosts as a VS Code file system: hterm-sftp://<sessionId>/<absolute path>.
 * Once added as a workspace folder, files can be browsed, edited, dragged in/out and searched.
 */
export class SftpFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly conns = new Map<string, Conn>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly mgr: ConnectionManager) {}

  dispose() {
    for (const id of [...this.conns.keys()]) this.close(id);
    this.emitter.dispose();
  }

  close(sessionId: string) {
    const c = this.conns.get(sessionId);
    if (!c) return;
    this.conns.delete(sessionId);
    c.sftp.then((s) => s.end(), () => undefined);
    c.lease?.release();
  }

  async sftp(sessionId: string): Promise<SFTPWrapper> {
    let c = this.conns.get(sessionId);
    if (!c) {
      const conn: Conn = { sftp: Promise.resolve(undefined as unknown as SFTPWrapper) };
      conn.sftp = (async () => {
        const lease = await this.mgr.acquire(sessionId);
        conn.lease = lease;
        try {
          const sftp = await call<SFTPWrapper>((cb) => lease.client.sftp(cb));
          sftp.on('close', () => {
            if (this.conns.get(sessionId) === conn) {
              this.conns.delete(sessionId);
              lease.release();
            }
          });
          return sftp;
        } catch (e) {
          lease.release();
          throw e;
        }
      })();
      conn.sftp.catch(() => this.conns.get(sessionId) === conn && this.conns.delete(sessionId));
      this.conns.set(sessionId, conn);
      c = conn;
    }
    return c.sftp;
  }

  async home(sessionId: string): Promise<string> {
    const sftp = await this.sftp(sessionId);
    return call<string>((cb) => sftp.realpath('.', cb));
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const sftp = await this.sftp(uri.authority);
    try {
      const lst = await call<Stats>((cb) => sftp.lstat(uri.path, cb));
      let st = lst;
      let type = typeOf(lst.mode);
      if (type === vscode.FileType.SymbolicLink) {
        try {
          st = await call<Stats>((cb) => sftp.stat(uri.path, cb));
          type = typeOf(st.mode) | vscode.FileType.SymbolicLink;
        } catch {
          /* dangling link */
        }
      }
      return {
        type,
        ctime: st.mtime * 1000,
        mtime: st.mtime * 1000,
        size: st.size,
        permissions: st.mode & 0o200 ? undefined : vscode.FilePermission.Readonly,
      };
    } catch (e) {
      throw mapError(e, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const sftp = await this.sftp(uri.authority);
    try {
      const list = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(uri.path, cb));
      return Promise.all(
        list
          .filter((e) => e.filename !== '.' && e.filename !== '..')
          .map(async (e): Promise<[string, vscode.FileType]> => {
            let type = typeOf(e.attrs.mode);
            if (type === vscode.FileType.SymbolicLink) {
              try {
                const st = await call<Stats>((cb) => sftp.stat(path.posix.join(uri.path, e.filename), cb));
                type = typeOf(st.mode) | vscode.FileType.SymbolicLink;
              } catch {
                /* dangling link */
              }
            }
            return [e.filename, type];
          }),
      );
    } catch (e) {
      throw mapError(e, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const sftp = await this.sftp(uri.authority);
    try {
      return await call<Buffer>((cb) => sftp.readFile(uri.path, cb));
    } catch (e) {
      throw mapError(e, uri);
    }
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await this.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }) {
    const exists = await this.exists(uri);
    if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (exists && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    const sftp = await this.sftp(uri.authority);
    try {
      await call<void>((cb) => sftp.writeFile(uri.path, Buffer.from(content), (err) => cb(err, undefined)));
    } catch (e) {
      throw mapError(e, uri);
    }
    this.emitter.fire([{ type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  async createDirectory(uri: vscode.Uri) {
    const sftp = await this.sftp(uri.authority);
    try {
      await call<void>((cb) => sftp.mkdir(uri.path, (err) => cb(err, undefined)));
    } catch (e) {
      throw mapError(e, uri);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }) {
    const sftp = await this.sftp(uri.authority);
    const rm = async (u: vscode.Uri) => {
      const st = await this.stat(u);
      if (st.type === vscode.FileType.Directory) {
        if (!options.recursive) throw vscode.FileSystemError.NoPermissions('The directory is not empty');
        for (const [name] of await this.readDirectory(u)) await rm(vscode.Uri.joinPath(u, name));
        await call<void>((cb) => sftp.rmdir(u.path, (err) => cb(err, undefined)));
      } else {
        await call<void>((cb) => sftp.unlink(u.path, (err) => cb(err, undefined)));
      }
    };
    try {
      await rm(uri);
    } catch (e) {
      throw mapError(e, uri);
    }
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }) {
    if (await this.exists(newUri)) {
      if (!options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
      await this.delete(newUri, { recursive: true });
    }
    const sftp = await this.sftp(oldUri.authority);
    try {
      await call<void>((cb) => sftp.rename(oldUri.path, newUri.path, (err) => cb(err, undefined)));
    } catch (e) {
      throw mapError(e, oldUri);
    }
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }
}
