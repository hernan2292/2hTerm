export type AuthMethod = 'password' | 'key' | 'agent' | 'interactive';

/** L = local (-L), R = remote (-R), D = dynamic SOCKS5 (-D) */
export type ForwardType = 'L' | 'R' | 'D';

export interface Forward {
  id: string;
  type: ForwardType;
  bindHost: string;
  bindPort: number;
  destHost?: string;
  destPort?: number;
}

export interface Session {
  id: string;
  name: string;
  folderId?: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  /** Path of the private key on disk; may differ per machine, so the key can also live in the vault. */
  keyPath?: string;
  /** Another session used as jump host (ProxyJump). */
  jumpId?: string;
  startupCommand?: string;
  x11?: boolean;
  forwards: Forward[];
  /** Start this session's tunnels when a terminal connects. */
  autoTunnels?: boolean;
  /** ThemeColor id, e.g. terminal.ansiGreen */
  color?: string;
  notes?: string;
  updatedAt: number;
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string;
  updatedAt: number;
}

export type SecretKind = 'password' | 'passphrase' | 'privateKey';

export interface VaultEntry {
  /** Salt of the vault the entry was encrypted with. */
  vid: string;
  iv: string;
  data: string;
  tag: string;
  updatedAt: number;
}

export interface VaultMeta {
  salt: string;
  check: VaultEntry;
  createdAt: number;
  /** Set when the master password changes; breaks ties between copies of the same vault. */
  changedAt?: number;
}

export interface KnownHost {
  fp: string;
  updatedAt: number;
}

/** Everything that is synchronized between machines. */
export interface SyncDoc {
  v: 1;
  sessions: Record<string, Session>;
  folders: Record<string, Folder>;
  knownHosts: Record<string, KnownHost>;
  secrets: Record<string, VaultEntry>;
  vault?: VaultMeta;
  /** Deletion markers: "s:<id>", "f:<id>", "k:<secretKey>", "h:<host>" -> deletion time. */
  tombstones: Record<string, number>;
}
