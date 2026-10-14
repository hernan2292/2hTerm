import * as vscode from 'vscode';
import { canonical, emptyDoc, mergeDocs, Store } from '../store';
import { SyncDoc } from '../types';
import { cfg, debounce, errMsg } from '../util';

const FILE = 'hterm-sync.json';
const DESCRIPTION = 'hTerm sync (do not edit by hand)';
const GIST_ID_KEY = 'hterm.gistId';

interface GistResponse {
  id: string;
  description: string;
  files: Record<string, { content?: string; truncated?: boolean; raw_url?: string } | undefined>;
}

/**
 * Syncs the document through a private Gist in the user's GitHub account,
 * merging per item (sessions, folders, secrets...) so edits made on two machines
 * at the same time are both kept.
 */
export class GistSync implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pushSoon = debounce(() => this.sync(false), 3000);

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly log: vscode.OutputChannel,
  ) {
    this.disposables.push(store.onDidChange((e) => !e.external && this.pushSoon()));
    const minutes = Math.max(1, cfg('sync.gistIntervalMinutes', 5));
    this.timer = setInterval(() => this.sync(false), minutes * 60_000);
    this.sync(false);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  /** Runs one pull-merge-push cycle. Interactive runs may ask the user to sign in to GitHub. */
  sync(interactive: boolean): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run(interactive)
      .catch((e) => {
        this.log.appendLine(`[gist] ${errMsg(e)}`);
        if (interactive) vscode.window.showErrorMessage(`hTerm: GitHub sync error: ${errMsg(e)}`);
      })
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(interactive: boolean) {
    const session = await vscode.authentication.getSession('github', ['gist'], interactive ? { createIfNone: true } : { silent: true });
    if (!session) return;
    const token = session.accessToken;

    const gist = await this.findGist(token);
    const remote = gist ? await this.readDoc(token, gist) : emptyDoc();
    const local = this.store.data;
    const merged = mergeDocs(local, remote);
    const mergedText = canonical(merged);

    if (mergedText !== canonical(local)) await this.store.replace(merged);
    if (!gist || mergedText !== canonical(remote)) {
      const body = JSON.stringify({ description: DESCRIPTION, files: { [FILE]: { content: JSON.stringify(merged) } } });
      if (gist) {
        await this.api(token, `/gists/${gist.id}`, { method: 'PATCH', body });
      } else {
        const created = (await this.api(token, '/gists', {
          method: 'POST',
          body: JSON.stringify({ description: DESCRIPTION, public: false, files: { [FILE]: { content: JSON.stringify(merged) } } }),
        })) as GistResponse;
        await this.ctx.globalState.update(GIST_ID_KEY, created.id);
      }
    }
    this.log.appendLine(`[gist] synced ${new Date().toLocaleTimeString()}`);
    if (interactive) vscode.window.setStatusBarMessage('$(check) hTerm synced with GitHub', 4000);
  }

  private async findGist(token: string): Promise<GistResponse | undefined> {
    const known = this.ctx.globalState.get<string>(GIST_ID_KEY);
    if (known) {
      try {
        return (await this.api(token, `/gists/${known}`)) as GistResponse;
      } catch {
        /* deleted or other account; search again */
      }
    }
    for (let page = 1; page <= 10; page++) {
      const list = (await this.api(token, `/gists?per_page=100&page=${page}`)) as GistResponse[];
      const hit = list.find((g) => g.files[FILE]);
      if (hit) {
        await this.ctx.globalState.update(GIST_ID_KEY, hit.id);
        return (await this.api(token, `/gists/${hit.id}`)) as GistResponse;
      }
      if (list.length < 100) break;
    }
    return undefined;
  }

  private async readDoc(token: string, gist: GistResponse): Promise<SyncDoc> {
    const file = gist.files[FILE];
    if (!file) return emptyDoc();
    let text = file.content ?? '';
    if (file.truncated && file.raw_url) {
      const res = await fetch(file.raw_url, { headers: { Authorization: `Bearer ${token}` } });
      text = await res.text();
    }
    return { ...emptyDoc(), ...(JSON.parse(text) as SyncDoc) };
  }

  private async api(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}
