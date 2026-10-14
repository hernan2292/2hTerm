import * as net from 'net';
import { Client, ClientChannel, TcpConnectionDetails } from 'ssh2';
import * as vscode from 'vscode';
import { ConnectionManager, Lease } from './connection';
import { Forward, Session } from './types';
import { errMsg } from './util';

export interface ActiveTunnel {
  key: string;
  sessionId: string;
  sessionName: string;
  forward: Forward;
  connections: number;
  stop(): void;
}

export function describeForward(f: Forward): string {
  const bind = `${f.bindHost || 'localhost'}:${f.bindPort}`;
  if (f.type === 'D') return `SOCKS ${bind}`;
  const dest = `${f.destHost}:${f.destPort}`;
  return f.type === 'L' ? `L ${bind} → ${dest}` : `R remote ${bind} → ${dest}`;
}

function forwardOut(client: Client, src: net.Socket, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) =>
    client.forwardOut(src.remoteAddress ?? '127.0.0.1', src.remotePort ?? 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch))),
  );
}

function listen(server: net.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host || '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Minimal SOCKS5 (no auth, CONNECT only) handshake; resolves with the requested destination. */
function socks5Handshake(sock: net.Socket): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail('only SOCKS5 is supported');
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n);
        sock.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 1) {
          sock.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
          return fail('unsupported SOCKS command');
        }
        const atyp = buf[3];
        let host: string;
        let off: number;
        if (atyp === 1) {
          if (buf.length < 10) return;
          host = [...buf.subarray(4, 8)].join('.');
          off = 8;
        } else if (atyp === 3) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString();
          off = 5 + len;
        } else if (atyp === 4) {
          if (buf.length < 22) return;
          const h = buf.subarray(4, 20).toString('hex');
          host = h.match(/.{4}/g)!.join(':');
          off = 20;
        } else {
          return fail('unknown SOCKS address type');
        }
        const port = buf.readUInt16BE(off);
        sock.off('data', onData);
        // Without a data listener a flowing socket drops bytes; pause until pipe() takes over.
        sock.pause();
        const rest = buf.subarray(off + 2);
        if (rest.length) sock.unshift(rest);
        resolve({ host, port });
      }
    };
    const fail = (m: string) => {
      sock.off('data', onData);
      reject(new Error(m));
    };
    sock.on('data', onData);
  });
}

export class TunnelManager implements vscode.Disposable {
  private readonly active = new Map<string, ActiveTunnel>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly mgr: ConnectionManager,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose() {
    for (const t of [...this.active.values()]) t.stop();
    this.emitter.dispose();
  }

  get list(): ActiveTunnel[] {
    return [...this.active.values()];
  }

  async startAll(session: Session) {
    const errors: string[] = [];
    for (const f of session.forwards) {
      try {
        await this.start(session, f);
      } catch (e) {
        errors.push(`${describeForward(f)}: ${errMsg(e)}`);
      }
    }
    if (errors.length) vscode.window.showErrorMessage(`hTerm: ${errors.join(' · ')}`);
  }

  stopSession(sessionId: string) {
    for (const t of this.list) if (t.sessionId === sessionId) t.stop();
  }

  async start(session: Session, f: Forward) {
    const key = `${session.id}/${f.id}`;
    if (this.active.has(key)) return;
    const lease = await this.mgr.acquire(session.id);
    const tunnel: ActiveTunnel = {
      key,
      sessionId: session.id,
      sessionName: session.name,
      forward: { ...f },
      connections: 0,
      stop: () => undefined,
    };
    try {
      tunnel.stop = f.type === 'R' ? await this.startRemote(lease, f, tunnel) : await this.startLocal(lease, f, tunnel);
    } catch (e) {
      lease.release();
      throw e;
    }
    const stop = tunnel.stop;
    const onClose = () => tunnel.stop();
    lease.client.once('close', onClose);
    tunnel.stop = () => {
      if (!this.active.delete(key)) return;
      lease.client.off('close', onClose);
      stop();
      lease.release();
      this.emitter.fire();
    };
    this.active.set(key, tunnel);
    this.log.appendLine(`[${session.name}] tunnel started: ${describeForward(f)}`);
    this.emitter.fire();
  }

  private track(tunnel: ActiveTunnel, a: net.Socket, b: ClientChannel) {
    tunnel.connections++;
    this.emitter.fire();
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      tunnel.connections--;
      this.emitter.fire();
    };
    a.on('close', end);
    a.on('error', () => undefined);
    b.on('close', end);
    a.pipe(b).pipe(a);
  }

  private async startLocal(lease: Lease, f: Forward, tunnel: ActiveTunnel): Promise<() => void> {
    const server = net.createServer(async (sock) => {
      sock.on('error', () => undefined);
      try {
        let host = f.destHost!;
        let port = f.destPort!;
        if (f.type === 'D') {
          ({ host, port } = await socks5Handshake(sock));
        }
        const ch = await forwardOut(lease.client, sock, host, port);
        if (f.type === 'D') sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        this.track(tunnel, sock, ch);
      } catch (e) {
        if (f.type === 'D' && !sock.destroyed) sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        else sock.destroy();
        this.log.appendLine(`[tunnel ${describeForward(f)}] ${errMsg(e)}`);
      }
    });
    await listen(server, f.bindHost, f.bindPort);
    return () => server.close();
  }

  private async startRemote(lease: Lease, f: Forward, tunnel: ActiveTunnel): Promise<() => void> {
    const bindHost = f.bindHost || 'localhost';
    const port = await new Promise<number>((resolve, reject) =>
      lease.client.forwardIn(bindHost, f.bindPort, (err, p) => (err ? reject(err) : resolve(p || f.bindPort))),
    );
    const onConn = (info: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => {
      if (info.destPort !== port) return;
      const sock = net.connect(f.destPort!, f.destHost!);
      sock.once('connect', () => this.track(tunnel, sock, accept()));
      sock.once('error', (e) => {
        this.log.appendLine(`[tunnel ${describeForward(f)}] ${errMsg(e)}`);
        reject();
      });
    };
    lease.client.on('tcp connection', onConn);
    return () => {
      lease.client.off('tcp connection', onConn);
      lease.client.unforwardIn(bindHost, port);
    };
  }
}
