import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('hterm').get<T>(key, fallback);
}

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p.replace(/%USERPROFILE%/gi, os.homedir()).replace(/\$HOME/g, os.homedir());
}

/** Wraps a node-style callback API into a promise. */
export function call<T>(fn: (cb: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sshTarget(s: { username: string; host: string; port: number }): string {
  return `${s.username ? s.username + '@' : ''}${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}`;
}

export function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
