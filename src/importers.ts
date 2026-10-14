import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Store } from './store';
import { Folder, Forward, Session } from './types';
import { errMsg, newId } from './util';

async function ensureFolderPath(store: Store, parts: string[]): Promise<string | undefined> {
  let parentId: string | undefined;
  for (const name of parts.filter(Boolean)) {
    let f = store.folders.find((x) => x.name === name && x.parentId === parentId);
    if (!f) {
      f = { id: newId(), name, parentId, updatedAt: 0 } as Folder;
      await store.upsertFolder(f);
    }
    parentId = f.id;
  }
  return parentId;
}

function isDuplicate(store: Store, s: Session) {
  return store.sessions.some((x) => x.host === s.host && x.port === s.port && x.username === s.username && x.name === s.name);
}

/** Imports Host blocks from an OpenSSH config file (wildcard patterns are skipped). */
export async function importSshConfig(store: Store, file = path.join(os.homedir(), '.ssh', 'config')): Promise<number> {
  const text = fs.readFileSync(file, 'utf8');
  type Block = { alias: string; opts: Record<string, string[]> };
  const blocks: Block[] = [];
  let cur: Block | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)\s*[=\s]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = undefined;
      for (const alias of value.split(/\s+/)) {
        if (/[*?!]/.test(alias)) continue;
        cur = { alias, opts: {} };
        blocks.push(cur);
        break;
      }
    } else if (key === 'match') {
      cur = undefined;
    } else if (cur) {
      (cur.opts[key] ??= []).push(value);
    }
  }

  const folderId = await ensureFolderPath(store, ['ssh_config']);
  const byAlias = new Map<string, Session>();
  for (const b of blocks) {
    const o = (k: string) => b.opts[k]?.[0];
    const forwards: Forward[] = (b.opts['localforward'] ?? []).flatMap((v) => {
      const m = v.match(/^(?:(\S+):)?(\d+)\s+(\S+):(\d+)$/);
      return m ? [{ id: newId(), type: 'L' as const, bindHost: m[1] ?? '127.0.0.1', bindPort: +m[2], destHost: m[3], destPort: +m[4] }] : [];
    });
    for (const v of b.opts['dynamicforward'] ?? []) {
      const m = v.match(/^(?:(\S+):)?(\d+)$/);
      if (m) forwards.push({ id: newId(), type: 'D', bindHost: m[1] ?? '127.0.0.1', bindPort: +m[2] });
    }
    const s: Session = {
      id: newId(),
      name: b.alias,
      folderId,
      host: o('hostname') ?? b.alias,
      port: Number(o('port')) || 22,
      username: o('user') ?? os.userInfo().username,
      auth: o('identityfile') ? 'key' : 'agent',
      keyPath: o('identityfile'),
      forwards,
      x11: o('forwardx11')?.toLowerCase() === 'yes' || undefined,
      updatedAt: 0,
    };
    byAlias.set(b.alias, s);
  }
  for (const b of blocks) {
    const jump = b.opts['proxyjump']?.[0]?.split(',')[0];
    const target = jump && byAlias.get(jump.replace(/^.*@/, '').replace(/:\d+$/, ''));
    if (target) byAlias.get(b.alias)!.jumpId = target.id;
  }
  const fresh = [...byAlias.values()].filter((s) => !isDuplicate(store, s));
  await store.upsertSessions(fresh);
  return fresh.length;
}

/**
 * Imports SSH bookmarks from MobaXterm.ini (or an exported .mxtsessions file).
 * Bookmark lines look like: name=#109#0%host%port%user%...  where 109 = SSH.
 */
export async function importMobaXterm(store: Store, file: string): Promise<number> {
  const text = fs.readFileSync(file, 'latin1');
  const out: Session[] = [];
  let folderParts: string[] = [];
  let inBookmarks = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inBookmarks = /^Bookmarks/i.test(section[1]);
      folderParts = [];
      continue;
    }
    if (!inBookmarks || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'SubRep') {
      folderParts = value ? value.split('\\') : [];
      continue;
    }
    const m = value.match(/^#109#(.*)$/);
    if (!m) continue;
    const fields = m[1].split('#')[0].split('%');
    const host = fields[1];
    if (!host) continue;
    const keyField = fields.find((f) => /(_ProfileDir_|\.ssh|id_\w+|\.ppk$|\.pem$)/i.test(f));
    const keyPath = keyField?.replace(/_ProfileDir_/gi, os.homedir()).replace(/_CurrentDrive_:/gi, 'C:');
    const s: Session = {
      id: newId(),
      name: key,
      folderId: await ensureFolderPath(store, ['MobaXterm', ...folderParts]),
      host,
      port: Number(fields[2]) || 22,
      username: fields[3] ?? '',
      auth: keyPath ? 'key' : 'password',
      keyPath,
      forwards: [],
      updatedAt: 0,
    };
    if (!isDuplicate(store, s)) out.push(s);
  }
  await store.upsertSessions(out);
  return out.length;
}

/** JSON backup without secrets. */
export function exportJson(store: Store): string {
  return JSON.stringify({ app: '2hterm', v: 1, folders: store.folders, sessions: store.sessions }, null, 2);
}

export async function importJson(store: Store, file: string): Promise<number> {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { folders?: Folder[]; sessions?: Session[] };
  for (const f of data.folders ?? []) if (!store.getFolder(f.id)) await store.upsertFolder(f);
  const fresh = (data.sessions ?? []).filter((s) => !store.getSession(s.id)).map((s) => ({ ...s, forwards: s.forwards ?? [] }));
  await store.upsertSessions(fresh);
  return fresh.length;
}

export async function runImport(store: Store) {
  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(file-code) ~/.ssh/config', id: 'ssh' },
      { label: '$(terminal) MobaXterm (MobaXterm.ini / .mxtsessions)', id: 'moba' },
      { label: '$(json) Copia de seguridad JSON de 2hTerm', id: 'json' },
    ],
    { title: 'Importar sesiones desde…' },
  );
  if (!kind) return;
  try {
    let n: number;
    if (kind.id === 'ssh') {
      n = await importSshConfig(store);
    } else {
      const defaultUri =
        kind.id === 'moba' ? vscode.Uri.file(path.join(os.homedir(), 'Documents', 'MobaXterm')) : undefined;
      const pick = await vscode.window.showOpenDialog({
        defaultUri,
        canSelectMany: false,
        filters: kind.id === 'moba' ? { MobaXterm: ['ini', 'mxtsessions'] } : { JSON: ['json'] },
      });
      if (!pick?.[0]) return;
      n = kind.id === 'moba' ? await importMobaXterm(store, pick[0].fsPath) : await importJson(store, pick[0].fsPath);
    }
    vscode.window.showInformationMessage(`2hTerm: ${n} sesión(es) importada(s).`);
  } catch (e) {
    vscode.window.showErrorMessage(`2hTerm: no se pudo importar: ${errMsg(e)}`);
  }
}
