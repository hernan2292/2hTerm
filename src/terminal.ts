import { StringDecoder } from 'string_decoder';
import { ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import { ConnectionManager, isCancel, Lease } from './connection';
import { TunnelManager } from './tunnels';
import { Session } from './types';
import { cfg, errMsg, sshTarget } from './util';

const DIM = '\x1b[90m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

class SshPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private stream?: ClientChannel;
  private lease?: Lease;
  private dims?: vscode.TerminalDimensions;
  private state: 'connecting' | 'open' | 'closed' = 'connecting';
  terminal?: vscode.Terminal;

  constructor(
    readonly sessionId: string,
    private readonly mgr: ConnectionManager,
    private readonly tunnels: TunnelManager,
    private readonly registry: TerminalRegistry,
    private readonly cwd?: string,
  ) {}

  get session(): Session | undefined {
    return this.mgr.session(this.sessionId);
  }

  open(dims: vscode.TerminalDimensions | undefined) {
    this.dims = dims;
    this.connect();
  }

  private write(text: string) {
    this.writeEmitter.fire(text);
  }

  private async connect() {
    const s = this.session;
    if (!s) {
      this.write(`${RED}The session no longer exists.${RESET}\r\n`);
      return this.closeEmitter.fire();
    }
    this.state = 'connecting';
    this.write(`${DIM}Connecting to ${sshTarget(s)}…${RESET}\r\n`);
    try {
      this.lease = await this.mgr.acquire(s.id);
      const stream = await new Promise<ClientChannel>((resolve, reject) =>
        this.lease!.client.shell(
          { term: 'xterm-256color', rows: this.dims?.rows ?? 24, cols: this.dims?.columns ?? 80 },
          s.x11 ? { x11: { single: false, screen: 0 } } : {},
          (err, ch) => (err ? reject(err) : resolve(ch)),
        ),
      );
      this.stream = stream;
      this.state = 'open';
      const out = new StringDecoder('utf8');
      const err = new StringDecoder('utf8');
      stream.on('data', (d: Buffer) => this.write(out.write(d)));
      stream.stderr.on('data', (d: Buffer) => this.write(err.write(d)));
      stream.on('close', () => this.onRemoteClose());
      if (this.cwd) stream.write(`cd ${shellQuote(this.cwd)}\n`);
      if (s.startupCommand) stream.write(s.startupCommand + '\n');
      if (s.autoTunnels && s.forwards.length) this.tunnels.startAll(s).catch(() => undefined);
    } catch (e) {
      this.lease?.release();
      this.lease = undefined;
      if (isCancel(e)) {
        this.state = 'closed';
        return this.closeEmitter.fire();
      }
      this.write(`${RED}Error: ${errMsg(e)}${RESET}\r\n`);
      this.showReconnectHint();
    }
  }

  private onRemoteClose() {
    if (this.state === 'closed') return;
    this.stream = undefined;
    this.lease?.release();
    this.lease = undefined;
    this.write(`\r\n${YELLOW}[Session closed]${RESET}`);
    this.showReconnectHint();
  }

  private showReconnectHint() {
    this.state = 'closed';
    this.write(` ${DIM}Press R to reconnect or any other key to close.${RESET}\r\n`);
  }

  handleInput(data: string) {
    if (this.state === 'closed') {
      if (data === 'r' || data === 'R') {
        this.write('\r\n');
        this.connect();
      } else {
        this.closeEmitter.fire();
      }
      return;
    }
    if (this.state === 'open') this.registry.input(this, data);
  }

  send(data: string) {
    this.stream?.write(data);
  }

  setDimensions(dims: vscode.TerminalDimensions) {
    this.dims = dims;
    this.stream?.setWindow(dims.rows, dims.columns, 0, 0);
  }

  close() {
    this.state = 'closed';
    this.stream?.close();
    this.stream = undefined;
    this.lease?.release();
    this.lease = undefined;
    this.registry.remove(this);
  }
}

/** Tracks open SSH terminals and implements MultiExec (broadcast typing). */
export class TerminalRegistry implements vscode.Disposable {
  private readonly ptys = new Set<SshPty>();
  private readonly broadcast = new Set<SshPty>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor(
    private readonly mgr: ConnectionManager,
    private readonly tunnels: TunnelManager,
  ) {
    this.status.command = '2hterm.stopMultiExec';
    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose() {
    this.status.dispose();
  }

  open(session: Session, cwd?: string) {
    const pty = new SshPty(session.id, this.mgr, this.tunnels, this, cwd);
    const terminal = vscode.window.createTerminal({
      name: session.name,
      pty,
      iconPath: new vscode.ThemeIcon('vm'),
      color: session.color ? new vscode.ThemeColor(session.color) : undefined,
      location: cfg('terminal.location', 'editor') === 'editor' ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel,
    });
    pty.terminal = terminal;
    this.ptys.add(pty);
    terminal.show();
  }

  input(from: SshPty, data: string) {
    if (this.broadcast.has(from)) {
      for (const p of this.broadcast) p.send(data);
    } else {
      from.send(data);
    }
  }

  remove(pty: SshPty) {
    this.ptys.delete(pty);
    if (this.broadcast.delete(pty)) this.updateStatus();
  }

  async pickMultiExec() {
    const items = [...this.ptys].map((p) => ({
      label: p.terminal?.name ?? p.sessionId,
      description: p.session ? sshTarget(p.session) : '',
      picked: this.broadcast.has(p),
      pty: p,
    }));
    if (items.length < 2) {
      vscode.window.showInformationMessage('2hTerm: open at least two SSH terminals to use MultiExec.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'MultiExec: whatever you type in one of these terminals is sent to all of them',
    });
    if (!picked) return;
    this.broadcast.clear();
    if (picked.length >= 2) picked.forEach((i) => this.broadcast.add(i.pty));
    this.updateStatus();
  }

  stopMultiExec() {
    this.broadcast.clear();
    this.updateStatus();
  }

  private updateStatus() {
    if (this.broadcast.size >= 2) {
      this.status.text = `$(broadcast) MultiExec (${this.broadcast.size})`;
      this.status.tooltip = 'Click to stop MultiExec';
      this.status.show();
    } else {
      this.broadcast.clear();
      this.status.hide();
    }
  }
}
