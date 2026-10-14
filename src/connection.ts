import * as fs from 'fs';
import * as net from 'net';
import { Client, ClientChannel, ConnectConfig, utils } from 'ssh2';
import * as vscode from 'vscode';
import { Store } from './store';
import { Session } from './types';
import { cfg, errMsg, expandHome, sshTarget } from './util';
import { Vault } from './vault';

export interface Lease {
  client: Client;
  release(): void;
}

interface Entry {
  ready: Promise<Client>;
  client?: Client;
  refs: number;
  releaseJump?: () => void;
}

class AuthCancelled extends Error {
  constructor() {
    super('Conexión cancelada');
  }
}

/**
 * One SSH connection per session, shared by terminals, SFTP and tunnels and
 * closed when the last user releases it.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  /** Sessions that are not stored (quick connect). */
  private readonly transient = new Map<string, Session>();
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with the session id whenever it connects or disconnects. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly log: vscode.OutputChannel,
  ) {}

  dispose() {
    for (const id of [...this.entries.keys()]) this.disconnect(id);
    this.emitter.dispose();
  }

  addTransient(s: Session) {
    this.transient.set(s.id, s);
  }

  session(id: string): Session | undefined {
    return this.store.getSession(id) ?? this.transient.get(id);
  }

  isConnected(id: string): boolean {
    return !!this.entries.get(id)?.client;
  }

  get connectedIds(): string[] {
    return [...this.entries.entries()].filter(([, e]) => e.client).map(([id]) => id);
  }

  disconnect(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    e.client?.end();
    e.releaseJump?.();
    this.emitter.fire(id);
  }

  async acquire(sessionId: string, depth = 0): Promise<Lease> {
    const session = this.session(sessionId);
    if (!session) throw new Error('La sesión ya no existe');
    if (depth > 5) throw new Error('Cadena de jump hosts demasiado larga (¿hay un ciclo?)');

    let entry = this.entries.get(sessionId);
    if (!entry) {
      const fresh: Entry = { refs: 0, ready: Promise.resolve(undefined as unknown as Client) };
      fresh.ready = this.open(session, fresh, depth).then(
        (client) => {
          fresh.client = client;
          this.emitter.fire(sessionId);
          return client;
        },
        (err) => {
          if (this.entries.get(sessionId) === fresh) this.entries.delete(sessionId);
          fresh.releaseJump?.();
          throw err;
        },
      );
      this.entries.set(sessionId, fresh);
      entry = fresh;
    }
    entry.refs++;
    const owner = entry;
    let client: Client;
    try {
      client = await owner.ready;
    } catch (err) {
      owner.refs--;
      throw err;
    }
    let released = false;
    return {
      client,
      release: () => {
        if (released) return;
        released = true;
        owner.refs--;
        if (owner.refs <= 0 && this.entries.get(sessionId) === owner) this.disconnect(sessionId);
      },
    };
  }

  private async open(session: Session, entry: Entry, depth: number): Promise<Client> {
    let typedPassword: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.connectOnce(session, entry, depth, attempt > 0, (pw) => (typedPassword = pw));
        if (typedPassword !== undefined && this.store.getSession(session.id) && !(await this.vault.has(session.id, 'password'))) {
          const pw = typedPassword;
          vscode.window
            .showInformationMessage(`¿Guardar la contraseña de ${session.name}?`, 'Guardar')
            .then((a) => a && this.vault.set(session.id, 'password', pw));
        }
        return client;
      } catch (err) {
        entry.releaseJump?.();
        entry.releaseJump = undefined;
        const level = (err as { level?: string }).level;
        if (level === 'client-authentication' && attempt < 2 && (session.auth === 'password' || session.auth === 'interactive')) {
          vscode.window.showWarningMessage(`${session.name}: autenticación fallida.`);
          continue;
        }
        throw err;
      }
    }
  }

  private async connectOnce(
    session: Session,
    entry: Entry,
    depth: number,
    forcePrompt: boolean,
    onTypedPassword: (pw: string) => void,
  ): Promise<Client> {
    const keepalive = cfg('ssh.keepaliveSeconds', 30);
    const config: ConnectConfig = {
      host: session.host,
      port: session.port || 22,
      username: session.username,
      readyTimeout: cfg('ssh.readyTimeoutSeconds', 20) * 1000,
      keepaliveInterval: keepalive > 0 ? keepalive * 1000 : 0,
      tryKeyboard: true,
      hostHash: 'sha256',
      hostVerifier: ((fp: string, verify: (ok: boolean) => void) => {
        this.verifyHost(session, fp).then(verify, () => verify(false));
      }) as unknown as ConnectConfig['hostVerifier'],
    };

    if (session.jumpId) {
      const jump = await this.acquire(session.jumpId, depth + 1);
      entry.releaseJump = jump.release;
      config.sock = await new Promise<ClientChannel>((resolve, reject) =>
        jump.client.forwardOut('127.0.0.1', 0, session.host, session.port || 22, (err, ch) => (err ? reject(err) : resolve(ch))),
      );
    }

    let password: string | undefined;
    const askPassword = async (prompt?: string) => {
      const pw = await vscode.window.showInputBox({
        title: `2hTerm: ${session.name}`,
        prompt: prompt ?? `Contraseña de ${sshTarget(session)}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (pw === undefined) throw new AuthCancelled();
      onTypedPassword(pw);
      return pw;
    };

    switch (session.auth) {
      case 'password':
        password = (!forcePrompt && (await this.vault.get(session.id, 'password'))) || (await askPassword());
        config.password = password;
        break;
      case 'key': {
        let key = await this.vault.get(session.id, 'privateKey');
        if (!key) {
          if (!session.keyPath) throw new Error('La sesión no tiene clave privada configurada');
          key = fs.readFileSync(expandHome(session.keyPath), 'utf8');
        }
        config.privateKey = key;
        const parsed = utils.parseKey(key);
        if (parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message)) {
          let pass = await this.vault.get(session.id, 'passphrase');
          if (!pass || utils.parseKey(key, pass) instanceof Error) {
            pass = await vscode.window.showInputBox({
              title: `2hTerm: ${session.name}`,
              prompt: 'Frase de paso de la clave privada',
              password: true,
              ignoreFocusOut: true,
            });
            if (pass === undefined) throw new AuthCancelled();
          }
          config.passphrase = pass;
        }
        break;
      }
      case 'agent':
        config.agent = cfg('ssh.agent', '') || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK);
        break;
      case 'interactive':
        password = forcePrompt ? undefined : await this.vault.get(session.id, 'password');
        break;
    }

    const client = new Client();
    let usedStoredPassword = false;
    client.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
      (async () => {
        if (prompts.length === 1 && !prompts[0].echo && password && !usedStoredPassword) {
          usedStoredPassword = true;
          return [password];
        }
        const answers: string[] = [];
        for (const p of prompts) {
          const a = await vscode.window.showInputBox({
            title: `2hTerm: ${session.name}`,
            prompt: [instructions, p.prompt].filter(Boolean).join(' — '),
            password: !p.echo,
            ignoreFocusOut: true,
          });
          if (a === undefined) throw new AuthCancelled();
          if (!p.echo && prompts.length === 1) onTypedPassword(a);
          answers.push(a);
        }
        return answers;
      })().then(finish, () => {
        finish([]);
        client.end();
      });
    });

    if (session.x11) {
      client.on('x11', (_info, accept, reject) => {
        const [host, display] = cfg('x11.display', 'localhost:0').split(':');
        const sock = net.connect(6000 + (parseInt(display, 10) || 0), host || 'localhost');
        sock.once('connect', () => {
          const ch = accept();
          sock.pipe(ch).pipe(sock);
        });
        sock.once('error', (e) => {
          this.log.appendLine(`[x11] ${errMsg(e)}`);
          reject();
        });
      });
    }

    return new Promise<Client>((resolve, reject) => {
      let ready = false;
      client.once('ready', () => {
        ready = true;
        this.log.appendLine(`[${session.name}] conectado a ${sshTarget(session)}`);
        resolve(client);
      });
      client.on('error', (err) => {
        this.log.appendLine(`[${session.name}] error: ${errMsg(err)}`);
        if (!ready) reject(err);
      });
      client.on('close', () => {
        if (!ready) return reject(new Error('La conexión se cerró durante el inicio de sesión'));
        if (this.entries.get(session.id) === entry) this.disconnect(session.id);
      });
      client.connect(config);
    });
  }

  private async verifyHost(session: Session, fpHex: string): Promise<boolean> {
    const hostId = `[${session.host}]:${session.port || 22}`;
    const fp = 'SHA256:' + Buffer.from(fpHex, 'hex').toString('base64').replace(/=+$/, '');
    const known = this.store.knownHost(hostId);
    if (known?.fp === fp) return true;
    if (!known) {
      const pick = await vscode.window.showWarningMessage(
        `Host desconocido ${hostId}`,
        { modal: true, detail: `Huella de la clave del servidor:\n${fp}\n\nComprueba que coincide antes de continuar.` },
        'Confiar y guardar',
        'Solo esta vez',
      );
      if (pick === 'Confiar y guardar') await this.store.setKnownHost(hostId, fp);
      return !!pick;
    }
    const pick = await vscode.window.showErrorMessage(
      `¡La huella de ${hostId} ha CAMBIADO!`,
      {
        modal: true,
        detail: `Guardada: ${known.fp}\nRecibida: ${fp}\n\nPuede ser una reinstalación del servidor o un ataque man-in-the-middle.`,
      },
      'Aceptar la nueva huella',
    );
    if (pick) await this.store.setKnownHost(hostId, fp);
    return !!pick;
  }
}

export function isCancel(err: unknown): boolean {
  return err instanceof AuthCancelled;
}
