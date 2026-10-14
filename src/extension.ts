import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager, isCancel } from './connection';
import { blankSession, SessionEditor } from './editor';
import { exportJson, runImport } from './importers';
import { SFTP_SCHEME, SftpFileSystem } from './sftp';
import { Store } from './store';
import { GistSync } from './sync/gist';
import { TerminalRegistry } from './terminal';
import { Node, SessionTree, TunnelTree } from './tree';
import { ActiveTunnel, TunnelManager } from './tunnels';
import { Session } from './types';
import { cfg, errMsg, newId, sshTarget } from './util';
import { Vault } from './vault';

export function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('hTerm');
  const store = new Store(ctx);
  const vault = new Vault(ctx, store);
  const mgr = new ConnectionManager(store, vault, log);
  const tunnels = new TunnelManager(mgr, log);
  const terminals = new TerminalRegistry(mgr, tunnels);
  const sftp = new SftpFileSystem(mgr);
  const tree = new SessionTree(store, mgr);
  ctx.subscriptions.push(log, store, mgr, tunnels, terminals, sftp);

  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SFTP_SCHEME, sftp, { isCaseSensitive: true }),
    vscode.window.createTreeView('hterm.sessions', { treeDataProvider: tree, dragAndDropController: tree, canSelectMany: true, showCollapseAll: true }),
    vscode.window.createTreeView('hterm.tunnels', { treeDataProvider: new TunnelTree(tunnels) }),
    store.onDidChange(() => tree.refresh()),
    mgr.onDidChange(() => tree.refresh()),
  );

  // --- Sync provider -------------------------------------------------------
  let gist: GistSync | undefined;
  const applyProvider = () => {
    const provider = cfg<string>('sync.provider', 'settingsSync');
    store.setSyncedWithSettingsSync(provider === 'settingsSync');
    if (provider === 'githubGist' && !gist) gist = new GistSync(ctx, store, log);
    if (provider !== 'githubGist' && gist) {
      gist.dispose();
      gist = undefined;
    }
  };
  applyProvider();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('hterm.sync') && applyProvider()),
    { dispose: () => gist?.dispose() },
  );

  // --- Helpers -------------------------------------------------------------
  const sessionOf = async (arg?: Node | Session): Promise<Session | undefined> => {
    if (arg && 'kind' in arg) return arg.kind === 'session' ? store.getSession(arg.session.id) ?? arg.session : undefined;
    if (arg && 'host' in arg) return arg;
    const pick = await vscode.window.showQuickPick(
      store.sessions
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ label: s.name, description: sshTarget(s), detail: store.folderPath(s.folderId) || undefined, s })),
      { title: 'Choose a session', matchOnDescription: true, matchOnDetail: true },
    );
    return pick?.s;
  };
  const folderOf = (arg?: Node) => (arg?.kind === 'folder' ? arg.folder : undefined);
  const guard =
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (e) {
        if (!isCancel(e)) vscode.window.showErrorMessage(`hTerm: ${errMsg(e)}`);
      }
    };
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));

  const openSftp = async (s: Session) => {
    const home = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `SFTP: connecting to ${s.name}…` },
      () => sftp.home(s.id),
    );
    const uri = vscode.Uri.from({ scheme: SFTP_SCHEME, authority: s.id, path: home });
    const folders = vscode.workspace.workspaceFolders ?? [];
    const existing = folders.find((f) => f.uri.scheme === SFTP_SCHEME && f.uri.authority === s.id);
    if (existing) {
      await vscode.commands.executeCommand('workbench.view.explorer');
      return;
    }
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: `SFTP · ${s.name}` });
    await vscode.commands.executeCommand('workbench.view.explorer');
  };

  // --- Session commands ----------------------------------------------------
  reg('hterm.addSession', () => SessionEditor.open(store, vault, blankSession(), true));
  reg('hterm.addSessionHere', (n?: Node) => SessionEditor.open(store, vault, blankSession(folderOf(n)?.id), true));
  reg('hterm.editSession', async (n?: Node) => {
    const s = await sessionOf(n);
    if (s) await SessionEditor.open(store, vault, structuredClone(s), false);
  });
  reg('hterm.duplicateSession', async (n?: Node) => {
    const s = await sessionOf(n);
    if (!s) return;
    const copy: Session = { ...structuredClone(s), id: newId(), name: `${s.name} (copy)` };
    copy.forwards = copy.forwards.map((f) => ({ ...f, id: newId() }));
    await store.upsertSession(copy);
    await vault.copy(s.id, copy.id);
  });
  reg('hterm.deleteSession', async (n?: Node, all?: Node[]) => {
    const targets = (all?.length ? all : n ? [n] : []).filter((x) => x.kind === 'session') as { kind: 'session'; session: Session }[];
    if (!targets.length) {
      const s = await sessionOf();
      if (s) targets.push({ kind: 'session', session: s });
    }
    if (!targets.length) return;
    const names = targets.map((t) => t.session.name).join(', ');
    const ok = await vscode.window.showWarningMessage(`Delete ${names}?`, { modal: true, detail: 'It will be deleted on all your synced machines.' }, 'Delete');
    if (!ok) return;
    for (const t of targets) {
      tunnels.stopSession(t.session.id);
      mgr.disconnect(t.session.id);
      await store.deleteSession(t.session.id, false);
    }
    await store.save();
  });
  reg('hterm.copySshCommand', async (n?: Node) => {
    const s = await sessionOf(n);
    if (!s) return;
    const parts = ['ssh'];
    if (s.port && s.port !== 22) parts.push('-p', String(s.port));
    if (s.auth === 'key' && s.keyPath) parts.push('-i', JSON.stringify(s.keyPath));
    const jump = s.jumpId && store.getSession(s.jumpId);
    if (jump) parts.push('-J', sshTarget(jump));
    for (const f of s.forwards) {
      if (f.type === 'D') parts.push('-D', `${f.bindHost ? f.bindHost + ':' : ''}${f.bindPort}`);
      else parts.push(`-${f.type}`, `${f.bindHost ? f.bindHost + ':' : ''}${f.bindPort}:${f.destHost}:${f.destPort}`);
    }
    if (s.x11) parts.push('-X');
    parts.push(`${s.username ? s.username + '@' : ''}${s.host}`);
    await vscode.env.clipboard.writeText(parts.join(' '));
    vscode.window.setStatusBarMessage('$(check) ssh command copied', 3000);
  });

  // --- Folders -------------------------------------------------------------
  const newFolder = async (parentId?: string) => {
    const name = await vscode.window.showInputBox({ title: 'New Folder', prompt: 'Folder name' });
    if (name?.trim()) await store.upsertFolder({ id: newId(), name: name.trim(), parentId, updatedAt: 0 });
  };
  reg('hterm.addFolder', () => newFolder());
  reg('hterm.addFolderHere', (n?: Node) => newFolder(folderOf(n)?.id));
  reg('hterm.renameFolder', async (n?: Node) => {
    const f = folderOf(n);
    if (!f) return;
    const name = await vscode.window.showInputBox({ title: 'Rename Folder', value: f.name });
    if (name?.trim()) await store.upsertFolder({ ...f, name: name.trim() });
  });
  reg('hterm.deleteFolder', async (n?: Node) => {
    const f = folderOf(n);
    if (!f) return;
    const ok = await vscode.window.showWarningMessage(
      `Delete the folder "${f.name}" and everything in it?`,
      { modal: true, detail: 'The sessions it contains will also be deleted on all your machines.' },
      'Delete',
    );
    if (ok) await store.deleteFolder(f.id);
  });

  // --- Connect ---------------------------------------------------------------
  reg('hterm.connect', async (n?: Node) => {
    const s = await sessionOf(n);
    if (s) terminals.open(s);
  });
  reg('hterm.openSftp', async (n?: Node) => {
    const s = await sessionOf(n);
    if (s) await openSftp(s);
  });
  reg('hterm.startTunnels', async (n?: Node) => {
    const s = await sessionOf(n);
    if (!s) return;
    if (!s.forwards.length) {
      const edit = await vscode.window.showInformationMessage(`${s.name} has no tunnels configured.`, 'Edit Session');
      if (edit) await SessionEditor.open(store, vault, structuredClone(s), false);
      return;
    }
    await tunnels.startAll(s);
    await vscode.commands.executeCommand('hterm.tunnels.focus');
  });
  reg('hterm.stopTunnel', (t: ActiveTunnel) => t?.stop());
  reg('hterm.disconnect', async (n?: Node) => {
    const id = n
      ? (await sessionOf(n))?.id
      : (
          await vscode.window.showQuickPick(
            mgr.connectedIds.map((cid) => ({ label: mgr.session(cid)?.name ?? cid, id: cid })),
            { title: 'Disconnect' },
          )
        )?.id;
    if (!id) return;
    tunnels.stopSession(id);
    sftp.close(id);
    mgr.disconnect(id);
  });

  reg('hterm.quickConnect', async () => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { s?: Session }>();
    qp.title = 'hTerm: Quick Connect';
    qp.placeholder = 'Search for a session or type user@host[:port]';
    qp.matchOnDescription = true;
    const base = store.sessions
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ label: s.name, description: sshTarget(s), s }));
    qp.items = base;
    qp.onDidChangeValue((v) => {
      const m = v.trim().match(/^(?:([^@\s]+)@)?([^@\s:]+)(?::(\d+))?$/);
      qp.items = m ? [{ label: `$(plug) Connect to ${v.trim()}`, description: 'temporary, not saved', alwaysShow: true }, ...base] : base;
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      if (item?.s) return terminals.open(item.s);
      const m = qp.value.trim().match(/^(?:([^@\s]+)@)?([^@\s:]+)(?::(\d+))?$/);
      if (!m) return;
      const s: Session = {
        ...blankSession(),
        name: qp.value.trim(),
        host: m[2],
        port: Number(m[3]) || 22,
        username: m[1] ?? os.userInfo().username,
        auth: 'interactive',
      };
      mgr.addTransient(s);
      terminals.open(s);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });

  reg('hterm.multiExec', () => terminals.pickMultiExec());
  reg('hterm.stopMultiExec', () => terminals.stopMultiExec());

  // --- Explorer (SFTP) context menu ----------------------------------------
  reg('hterm.sftp.download', async (uri: vscode.Uri) => {
    if (!uri) return;
    const stat = await vscode.workspace.fs.stat(uri);
    const name = path.posix.basename(uri.path);
    let target: vscode.Uri | undefined;
    if (stat.type & vscode.FileType.Directory) {
      const dir = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Download Here' });
      target = dir?.[0] && vscode.Uri.joinPath(dir[0], name);
    } else {
      target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', name)) });
    }
    if (!target) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${name}…` }, () =>
      vscode.workspace.fs.copy(uri, target!, { overwrite: true }),
    );
    vscode.window.setStatusBarMessage(`$(check) ${name} downloaded`, 4000);
  });
  reg('hterm.sftp.upload', async (uri: vscode.Uri) => {
    if (!uri) return;
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: 'Upload' });
    if (!files?.length) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading ${files.length} file(s)…` }, async () => {
      for (const f of files) await vscode.workspace.fs.copy(f, vscode.Uri.joinPath(uri, path.basename(f.fsPath)), { overwrite: true });
    });
    vscode.window.setStatusBarMessage('$(check) Upload complete', 4000);
  });
  reg('hterm.sftp.terminalHere', (uri: vscode.Uri) => {
    const s = uri && mgr.session(uri.authority);
    if (s) terminals.open(s, uri.path);
  });

  // --- Sync, import/export, vault -------------------------------------------
  reg('hterm.refresh', () => {
    store.checkExternal();
    tree.refresh();
  });
  reg('hterm.syncNow', async () => {
    const provider = cfg<string>('sync.provider', 'settingsSync');
    if (provider === 'githubGist') {
      applyProvider();
      return gist?.sync(true);
    }
    if (provider === 'none') {
      const pick = await vscode.window.showInformationMessage('Sync is turned off.', 'Configure');
      if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'hterm.sync');
      return;
    }
    store.checkExternal();
    try {
      await vscode.commands.executeCommand('workbench.userDataSync.actions.syncNow');
    } catch {
      const pick = await vscode.window.showInformationMessage(
        'Turn on Settings Sync (Accounts icon → "Backup and Sync Settings") with the same account on all your machines.',
        'Turn On Settings Sync',
      );
      if (pick) vscode.commands.executeCommand('workbench.userDataSync.actions.turnOn');
    }
  });
  reg('hterm.import', () => runImport(store));
  reg('hterm.export', async () => {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'hterm-sessions.json')),
      filters: { JSON: ['json'] },
    });
    if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(exportJson(store), 'utf8'));
  });
  reg('hterm.vault.setMasterPassword', async () => {
    if (!vault.synced) {
      const pick = await vscode.window.showInformationMessage(
        'Secret sync is turned off; the local keychain is used and no master password is needed.',
        'Turn It On',
      );
      if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'hterm.sync.secrets');
      return;
    }
    await vault.changeMasterPassword();
  });
  reg('hterm.vault.lock', async () => {
    await vault.lock();
    vscode.window.showInformationMessage('hTerm: vault locked on this machine. You will be asked for the master password the next time it is used.');
  });
  reg('hterm.forgetHostKey', async () => {
    const hosts = Object.entries(store.data.knownHosts);
    if (!hosts.length) return vscode.window.showInformationMessage('No saved fingerprints.');
    const pick = await vscode.window.showQuickPick(
      hosts.map(([id, h]) => ({ label: id, description: h.fp })),
      { title: 'Forget Host Fingerprint', canPickMany: true },
    );
    for (const p of pick ?? []) await store.setKnownHost(p.label, undefined);
  });

  log.appendLine(`hTerm active. Sync: ${cfg<string>('sync.provider', 'settingsSync')}`);
}

export function deactivate() {}
