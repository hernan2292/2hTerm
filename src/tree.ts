import * as vscode from 'vscode';
import { ConnectionManager } from './connection';
import { Store } from './store';
import { ActiveTunnel, describeForward, TunnelManager } from './tunnels';
import { Folder, Session } from './types';
import { sshTarget } from './util';

export type Node = { kind: 'folder'; folder: Folder } | { kind: 'session'; session: Session };

const MIME = 'application/vnd.code.tree.2hterm.sessions';

export class SessionTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(
    private readonly store: Store,
    private readonly mgr: ConnectionManager,
  ) {}

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'f:' + node.folder.id;
      item.contextValue = 'folder';
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const s = node.session;
    const connected = this.mgr.isConnected(s.id);
    const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
    item.id = 's:' + s.id;
    item.description = sshTarget(s);
    item.contextValue = connected ? 'session.connected' : 'session';
    item.iconPath = new vscode.ThemeIcon(
      connected ? 'vm-running' : 'vm',
      s.color ? new vscode.ThemeColor(s.color) : connected ? new vscode.ThemeColor('testing.iconPassed') : undefined,
    );
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${s.name}**\n\n`);
    tip.appendText(`${sshTarget(s)} · auth: ${s.auth}`);
    if (s.jumpId) tip.appendText(`\nvia ${this.store.getSession(s.jumpId)?.name ?? '?'}`);
    if (s.forwards.length) tip.appendText(`\nTunnels: ${s.forwards.map(describeForward).join(', ')}`);
    if (s.notes) tip.appendText(`\n\n${s.notes}`);
    item.tooltip = tip;
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === 'session') return [];
    const parentId = node?.kind === 'folder' ? node.folder.id : undefined;
    const folderExists = (id?: string) => !!id && !!this.store.getFolder(id);
    const folders = this.store.folders
      .filter((f) => (parentId ? f.parentId === parentId : !folderExists(f.parentId)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder): Node => ({ kind: 'folder', folder }));
    const sessions = this.store.sessions
      .filter((s) => (parentId ? s.folderId === parentId : !folderExists(s.folderId)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((session): Node => ({ kind: 'session', session }));
    return [...folders, ...sessions];
  }

  getParent(node: Node): Node | undefined {
    const pid = node.kind === 'folder' ? node.folder.parentId : node.session.folderId;
    const folder = pid ? this.store.getFolder(pid) : undefined;
    return folder ? { kind: 'folder', folder } : undefined;
  }

  handleDrag(source: readonly Node[], data: vscode.DataTransfer) {
    data.set(MIME, new vscode.DataTransferItem(source));
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer) {
    const nodes = data.get(MIME)?.value as Node[] | undefined;
    if (!nodes?.length) return;
    const folderId =
      target?.kind === 'folder' ? target.folder.id : target?.kind === 'session' ? target.session.folderId : undefined;
    for (const n of nodes) {
      if (n.kind === 'session') {
        const s = this.store.getSession(n.session.id);
        if (s && s.folderId !== folderId) await this.store.upsertSession({ ...s, folderId });
      } else {
        // Refuse to drop a folder inside itself or one of its descendants.
        let p = folderId;
        let cyclic = false;
        while (p) {
          if (p === n.folder.id) cyclic = true;
          p = this.store.getFolder(p)?.parentId;
        }
        const f = this.store.getFolder(n.folder.id);
        if (f && !cyclic && f.parentId !== folderId) await this.store.upsertFolder({ ...f, parentId: folderId });
      }
    }
  }
}

export class TunnelTree implements vscode.TreeDataProvider<ActiveTunnel> {
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(private readonly tunnels: TunnelManager) {
    this.onDidChangeTreeData = tunnels.onDidChange;
  }

  getTreeItem(t: ActiveTunnel): vscode.TreeItem {
    const item = new vscode.TreeItem(describeForward(t.forward));
    item.description = `${t.sessionName} · ${t.connections} connection(s)`;
    item.iconPath = new vscode.ThemeIcon(t.forward.type === 'D' ? 'globe' : 'arrow-swap');
    item.contextValue = 'tunnel';
    return item;
  }

  getChildren(): ActiveTunnel[] {
    return this.tunnels.list;
  }
}
