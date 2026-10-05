/**
 * protocols/vty.ts — [S13] the remote terminal server: telnet and simulated SSH over the P1 TCP stack
 * (ARCHITECTURE-P3 D14, D22, §2.4, §2.5, §2.6 `VtyLoginRow`, §3.14, §4.1, §4.2, §4.3, §5.2; §7 W3 svc).
 *
 * Listeners (hidden, D14). The daemon opens `tcp.listen {service: true}` — no `sockets` row, no debug line, no
 * `sock.opened`, not in the tcp StateView — and says nothing itself, so a P1/P2 router whose configuration holds `line
 * vty` keeps its bytes:
 *  • `vty#23` (telnet) while a `line vty …` section allows telnet (`transport input`; absent = `telnet ssh`);
 *  • `vty#22` (SSH) while an RSA key is stored (`crypto key generate rsa …`) and a `line vty …` section allows SSH.
 * A transport refusal never reaches the daemon (tcp answers the SYN with a RST) and writes no row. On a managed switch
 * nothing reaches a listener until a P3 line wakes the dormant transport (D22, protocols/ip-upper.ts).
 *
 * A connection is served by the first `line vty` section whose transport allows its protocol (that section's
 * `login`, `password` and `access-class`). Authentication: `login local` → the `username … secret|password` lines;
 * else a line `password` (vty lines log in by default); else the login is refused ("no password set").
 *  • telnet: the `access-class` check runs at once (`acl.check {family 4, list, tuple of the accepted SYN, token: the
 *    connection, owner 'vty'}`); then `Username: ` (login local) and `Password: ` (masked: `IAC WILL ECHO`) prompts;
 *    three failures close the connection.
 *  • SSH: version strings in clear (`VTY_SSH_VERSION`), then `ext.tcp.protect` marks every later segment of the
 *    connection `meta.protected` + `protectedBy 'ssh'`; protected packets (`length u32` + payload XORed with an FNV-1a
 *    keystream, `vtySshCrypt`) carry RFC 4252/4254 message numbers: USERAUTH_REQUEST 50 (`user \0 password`),
 *    FAILURE 51, SUCCESS 52, CHANNEL_DATA 94 (the terminal stream), DISCONNECT 1 (a reason text). The access-class
 *    check runs when the user name is known (the first USERAUTH_REQUEST), so a refused row names the user;
 *    `ip ssh authentication-retries` (default 3) failures disconnect.
 *  • A refusal by `access-class` is a TCP RST after the handshake (`tcp.abort`, listed deviation), a severity-5 log and a
 *    `refused` row; a wrong credential a `failed` row and a severity-5 log; a success a `success` row and the
 *    `remoteCli {op: 'open', conn, peer, proto, user?}` action (the Simulation opens a via-'vty' CLI session, D14).
 * The terminal stream (both protocols; inside SSH CHANNEL_DATA): server → client text with CR LF line ends, a prompt
 * followed by `IAC GA` (RFC 854 Go Ahead: the server waits for a line), `IAC WILL ECHO` before a masked prompt and
 * `IAC WONT ECHO` when the next prompt is plain again; client → server lines ending CR LF. Each line received on an
 * open connection is `remoteCli {op: 'line', text}`; the session's output returns as ProcessEvent `vty.output` and goes
 * back over the connection (`closed` closes it). The client closing its end is `remoteCli {op: 'close'}`. An interrupt
 * (`IAC IP`, or ^C in an SSH channel) is ignored: the remote CLI session has no interrupt seam (RemoteCliAction has no
 * such op).
 *
 * Gradeable logins (rule 20): the `vty-logins` table, key String(seq), seq from 1 for the life of the daemon, at most
 * VTY_LOGINS_LIMIT rows (the oldest deleted with reason 'replaced'), one row per login attempt that reached the daemon.
 *
 * Timers (never periodic, §4.2): `login:<conn>` — the login guard (telnet VTY_TELNET_LOGIN_TIMEOUT_NS; SSH `ip ssh
 * time-out`, default 120 s), cancelled at a successful login. An open session has no idle timer (`exec-timeout` is
 * stored, not enforced, as on the console). Debug categories (§5.8): `ip ssh` and `telnet`, only for connections.
 * Determinism: no rng; the SSH keystream is FNV-1a over the segment's endpoints (§4.1).
 *
 * stateSnapshot(): `{ process: 'vty', state: { listening: ('telnet' | 'ssh')[], connections: [{ id, proto, peer, phase,
 *   user?, since }], logins, failures, refusals } }` (display only; the gradeable record is the table). `since` (W4,
 *   ruling R43, additive) is the sim time the connection was accepted, so `show users` prints how long it has been
 *   connected.
 *
 * ponytail: IPv4 only; the number of vty lines is not a session limit; `ip ssh version 1` is not simulated (the server
 * always speaks 2.0); no idle timeout.
 */
import { macHash32, type IpAddress } from '../contracts/addr.js';
import type { ConfigDelta, ConfigNode } from '../contracts/config.js';
import type { ProcessName } from '../contracts/ids.js';
import { IPPROTO_TCP } from '../contracts/pdu.js';
import type { Action, DebugEvent, PacketTuple, Process, ProcessCtx, ProcessRequest, RemoteCliAction, StateView } from '../contracts/process.js';
import type { VtyLoginRow } from '../contracts/tables.js';
import { SEC, type SimTime } from '../contracts/time.js';
import type { AclVerdictEvent, ProcessEvent, SocketId, VtyOutputEvent } from '../contracts/transport.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { verifySecret } from '../cli/secrets.js';
import { fnv1aU32, readU32, writeU32 } from '../pdu/checksum.js';
import { tcpProtectRequest } from './tcp.js';

// ── names, ports, limits ────────────────────────────────────────────────────

/** @since P3 [S13] The server daemon's name (`PROCESS_ORDER`: after tcp, before vty-client, §2.1). */
export const VTY_DAEMON: ProcessName = 'vty';
/** @since P3 [S13] The two remote terminal protocols. */
export type VtyProto = 'telnet' | 'ssh';
/** @since P3 [S13] TCP port of telnet (RFC 854). */
export const VTY_TELNET_PORT = 23;
/** @since P3 [S13] TCP port of SSH (RFC 4253). */
export const VTY_SSH_PORT = 22;
/** @since P3 [S13] The hidden telnet listener's socket id. */
export const VTY_TELNET_SOCKET: SocketId = 'vty#23';
/** @since P3 [S13] The hidden SSH listener's socket id. */
export const VTY_SSH_SOCKET: SocketId = 'vty#22';
/** @since P3 [S13] Rows kept in the `vty-logins` table (the restconf-log rule, §2.6). */
export const VTY_LOGINS_LIMIT = 50;
/** @since P3 [S13] Telnet login guard: the connection closes when no login completes within it. */
export const VTY_TELNET_LOGIN_TIMEOUT_NS: SimTime = 30 * SEC;
/** @since P3 [S13] `ip ssh time-out` when the line is absent (seconds). */
export const VTY_SSH_TIMEOUT_DEFAULT_S = 120;
/** @since P3 [S13] `ip ssh authentication-retries` when the line is absent. */
export const VTY_SSH_RETRIES_DEFAULT = 3;
/** @since P3 [S13] Telnet login attempts before the connection closes. */
export const VTY_TELNET_ATTEMPTS = 3;
/** @since P3 [S13] Facility of the login logs. */
export const VTY_LOG_FACILITY = 'VTY';
/** @since P3 [S13] Severity of the refused and failed login logs (§3.14 step 3). */
export const VTY_LOG_SEVERITY = 5;
/** @since P3 [S13] Debug categories (§5.8): `debug ip ssh`, `debug telnet`. */
export const VTY_DEBUG_CATEGORY: Readonly<Record<VtyProto, string>> = Object.freeze({ ssh: 'ip ssh', telnet: 'telnet' });

// ── texts the server sends (original wording) ──────────────────────────────

/** @since P3 [S13] The user-name prompt of `login local`. */
export const VTY_PROMPT_USERNAME = 'Username: ';
/** @since P3 [S13] The password prompt (masked). */
export const VTY_PROMPT_PASSWORD = 'Password: ';
/** @since P3 [S13] A wrong telnet credential (the prompt follows again). */
export const VTY_MSG_LOGIN_FAILED = '% Login failed: unknown user name or wrong password.';
/** @since P3 [S13] The last failed telnet attempt. */
export const VTY_MSG_LOGIN_DENIED = '% Access denied after three failed logins. The connection is closed.';
/** @since P3 [S13] The SSH disconnect after `ip ssh authentication-retries` failures. */
export const VTY_MSG_SSH_DENIED = '% Too many failed logins. The connection is closed.';
/** @since P3 [S13] A vty line with neither `login local` nor a password. */
export const VTY_MSG_NO_PASSWORD = '% Remote login needs a password, but none is set on the vty lines.';
/** @since P3 [S13] The login guard expired. */
export const VTY_MSG_LOGIN_TIMEOUT = '% No login within the time allowed. The connection is closed.';
/** @since P3 [S13] A client that does not speak SSH 2.0 on port 22. */
export const VTY_MSG_PROTOCOL_MISMATCH = 'Protocol mismatch.';

// ── SSH framing (shared with protocols/vty-client.ts) ──────────────────────

/** @since P3 [S13] The identification line both ends send in clear (RFC 4253 §4.2; no '-' in the software version). */
export const VTY_SSH_VERSION = 'SSH-2.0-NFSSH_1.0';
/** @since P3 [S13] RFC 4253 SSH_MSG_DISCONNECT (payload: a reason text). */
export const SSH_MSG_DISCONNECT = 1;
/** @since P3 [S13] RFC 4252 SSH_MSG_USERAUTH_REQUEST (payload: user, a zero byte, the password). */
export const SSH_MSG_USERAUTH_REQUEST = 50;
/** @since P3 [S13] RFC 4252 SSH_MSG_USERAUTH_FAILURE. */
export const SSH_MSG_USERAUTH_FAILURE = 51;
/** @since P3 [S13] RFC 4252 SSH_MSG_USERAUTH_SUCCESS. */
export const SSH_MSG_USERAUTH_SUCCESS = 52;
/** @since P3 [S13] RFC 4254 SSH_MSG_CHANNEL_DATA (payload: the terminal stream). */
export const SSH_MSG_CHANNEL_DATA = 94;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

/** @since P3 [S13] UTF-8 bytes of `text`. */
export function vtyBytes(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/** @since P3 [S13] The text of UTF-8 `bytes` (malformed sequences replaced). */
export function vtyText(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

/**
 * @since P3 [S13] The keystream key of the protected packets one end sends: FNV-1a 32 (`macHash32`, §4.1) over the
 * segment's source and destination endpoints. Both ends derive it from the connection, so does the packet inspector.
 */
export function vtySshKey(src: IpAddress, srcPort: number, dst: IpAddress, dstPort: number): number {
  return macHash32(`ssh|${src}|${srcPort}|${dst}|${dstPort}`);
}

/**
 * @since P3 [S13] XOR `data` with the keystream of `key` (word i = `fnv1aU32(i, key)`, big-endian bytes). Its own
 * inverse; the keystream restarts with every packet, so any one packet decodes from its segment alone.
 */
export function vtySshCrypt(key: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let word = 0;
  for (let i = 0; i < data.length; i++) {
    if ((i & 3) === 0) word = fnv1aU32(i >>> 2, key);
    out[i] = (data[i] as number) ^ ((word >>> (24 - 8 * (i & 3))) & 0xff);
  }
  return out;
}

/** @since P3 [S13] One protected packet: `length u32` then `type` and `body` XORed with the keystream of `key`. */
export function vtySshPacket(key: number, type: number, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const plain = new Uint8Array(1 + body.length);
  plain[0] = type;
  plain.set(body, 1);
  const out = new Uint8Array(4 + plain.length);
  writeU32(out, 0, plain.length);
  out.set(vtySshCrypt(key, plain), 4);
  return out;
}

/**
 * @since P3 [S13] Split the complete protected packets off the front of `buf`: their plaintexts (type byte first) and
 * the bytes left for the next segment.
 */
export function vtySshUnpack(key: number, buf: Uint8Array): { packets: Uint8Array[]; rest: Uint8Array } {
  const packets: Uint8Array[] = [];
  let at = 0;
  while (buf.length - at >= 4) {
    const len = readU32(buf, at);
    if (buf.length - at - 4 < len) break;
    packets.push(vtySshCrypt(key, buf.subarray(at + 4, at + 4 + len)));
    at += 4 + len;
  }
  return { packets, rest: buf.slice(at) };
}

/**
 * @since P3 [S13] The identification line at the front of `buf` (without CR LF) and the bytes after it, or undefined
 * while its line end has not arrived.
 */
export function vtySshVersionLine(buf: Uint8Array): { line: string; rest: Uint8Array } | undefined {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return undefined;
  const end = nl > 0 && buf[nl - 1] === 0x0d ? nl - 1 : nl;
  return { line: UTF8_DECODER.decode(buf.subarray(0, end)), rest: buf.slice(nl + 1) };
}

/** @since P3 [S13] Does an identification line announce SSH 2.0 (or 1.99, compatible with 2.0)? */
export function vtySshVersionOk(line: string): boolean {
  return line.startsWith('SSH-2.0-') || line.startsWith('SSH-1.99-');
}

/** @since P3 [S13] Concatenate two byte arrays. */
export function vtyConcat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ── the terminal stream (telnet, and SSH CHANNEL_DATA) ─────────────────────

const IAC = 0xff;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const GA = 249;
const IP = 244;
const SE = 240;
const OPT_ECHO = 1;
const ETX = 0x03;
const CR = 0x0d;
const LF = 0x0a;
const NUL = 0x00;

/** @since P3 [S13] What a terminal stream reader found: a complete line, a prompt (`IAC GA`), an interrupt. */
export type VtyTermEvent = { kind: 'line'; text: string } | { kind: 'prompt'; text: string; masked: boolean } | { kind: 'interrupt' };

/** @since P3 [S13] An incremental reader of one direction of a terminal stream. */
export interface VtyTermReader {
  /** Consume bytes (any split, IAC sequences included) and return what they completed, in stream order. */
  feed(bytes: Uint8Array): VtyTermEvent[];
  /** The far end announced `WILL ECHO` (it echoes, so typed characters stay hidden: masked input). */
  readonly masked: boolean;
}

/**
 * @since P3 [S13] A terminal stream reader. Data bytes build the current line (CR and NUL are skipped, LF ends it);
 * `IAC GA` turns the current partial line into a prompt; `IAC WILL|WONT ECHO` sets `masked`; `IAC IP` and ^C (0x03)
 * are interrupts; a doubled IAC is one 0xff data byte; other commands and subnegotiations are skipped.
 */
export function createVtyTermReader(): VtyTermReader {
  let cur: number[] = [];
  let state: 'data' | 'iac' | 'opt' | 'sb' | 'sb-iac' = 'data';
  let verb = 0;
  let masked = false;
  const take = (): string => {
    const text = UTF8_DECODER.decode(Uint8Array.from(cur));
    cur = [];
    return text;
  };
  return {
    get masked() {
      return masked;
    },
    feed(bytes) {
      const out: VtyTermEvent[] = [];
      for (const b of bytes) {
        switch (state) {
          case 'data':
            if (b === IAC) state = 'iac';
            else if (b === LF) out.push({ kind: 'line', text: take() });
            else if (b === ETX) out.push({ kind: 'interrupt' });
            else if (b !== CR && b !== NUL) cur.push(b);
            break;
          case 'iac':
            state = 'data';
            if (b === IAC) cur.push(IAC);
            else if (b === WILL || b === WONT || b === DO || b === DONT) {
              verb = b;
              state = 'opt';
            } else if (b === SB) state = 'sb';
            else if (b === GA) out.push({ kind: 'prompt', text: take(), masked });
            else if (b === IP) out.push({ kind: 'interrupt' });
            break;
          case 'opt':
            state = 'data';
            if (b === OPT_ECHO && verb === WILL) masked = true;
            else if (b === OPT_ECHO && verb === WONT) masked = false;
            break;
          case 'sb':
            if (b === IAC) state = 'sb-iac';
            break;
          case 'sb-iac':
            state = b === SE ? 'data' : 'sb';
            break;
        }
      }
      return out;
    },
  };
}

/**
 * @since P3 [S13] Server output as terminal stream bytes: `text` (when not empty) with CR LF line ends and a final
 * CR LF; then, with a `prompt`, `IAC WILL ECHO` / `IAC WONT ECHO` when the masking changes (`echo.masked` is updated)
 * and the prompt followed by `IAC GA`.
 */
export function vtyTermOutput(out: { text: string; prompt?: string; secret?: boolean }, echo: { masked: boolean }): Uint8Array {
  const parts: number[] = [];
  if (out.text !== '') for (const b of UTF8_ENCODER.encode(`${out.text.replace(/\r?\n/g, '\r\n')}\r\n`)) parts.push(b);
  if (out.prompt !== undefined) {
    const secret = out.secret === true;
    if (secret !== echo.masked) {
      parts.push(IAC, secret ? WILL : WONT, OPT_ECHO);
      echo.masked = secret;
    }
    for (const b of UTF8_ENCODER.encode(out.prompt)) parts.push(b);
    parts.push(IAC, GA);
  }
  return Uint8Array.from(parts);
}

/** @since P3 [S13] A typed line as terminal stream bytes (CR LF ended). */
export function vtyTermLine(line: string): Uint8Array {
  return UTF8_ENCODER.encode(`${line}\r\n`);
}

// ── the configuration ───────────────────────────────────────────────────────

/** @since P3 [S13] One `line vty <first> [<last>]` section as the server reads it. */
export interface VtyLineConfig {
  /** 'vty 0 4'. */
  readonly name: string;
  /** The effective `transport input` ('telnet ssh' when the line is absent; [] for `none`). */
  readonly transport: readonly VtyProto[];
  /** `access-class <list> in`. */
  readonly accessClass?: string;
  /** `login local` → 'local'; a line password → 'line' (vty lines log in by default); neither → 'none'. */
  readonly login: 'local' | 'line' | 'none';
  /** The stored line password (as `verifySecret` reads it). */
  readonly password?: string;
}

/** @since P3 [S13] What the server reads from the configuration. */
export interface VtyConfig {
  /** The `line vty` sections in configuration order. */
  readonly lines: readonly VtyLineConfig[];
  /** A key is stored (`crypto key generate rsa …`). */
  readonly rsaKey: boolean;
  /** `ip ssh authentication-retries` (default VTY_SSH_RETRIES_DEFAULT). */
  readonly sshRetries: number;
  /** `ip ssh time-out` in seconds (default VTY_SSH_TIMEOUT_DEFAULT_S). */
  readonly sshTimeoutS: number;
}

/** The effective transport of a `transport input …` value. */
function transportOf(values: readonly string[] | undefined): VtyProto[] {
  if (values === undefined) return ['telnet', 'ssh'];
  if (values.includes('all')) return ['telnet', 'ssh'];
  const out: VtyProto[] = [];
  if (values.includes('telnet')) out.push('telnet');
  if (values.includes('ssh')) out.push('ssh');
  return out;
}

/** A positive integer token, or `fallback`. */
function positive(token: string | undefined, fallback: number): number {
  const n = Number(token);
  return token !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** @since P3 [S13] Read the server's configuration (stored lines only; negations never count). Pure. */
export function readVtyConfig(root: ConfigNode): VtyConfig {
  const sections = new Map<string, { transport?: string[]; accessClass?: string; local: boolean; password?: string }>();
  let rsaKey = false;
  let sshRetries = VTY_SSH_RETRIES_DEFAULT;
  let sshTimeoutS = VTY_SSH_TIMEOUT_DEFAULT_S;
  for (const l of configTextLinesOf(root)) {
    if (l.negate) continue;
    const t = l.tokens;
    if (l.context.length === 0) {
      if (t[0] === 'line' && t[1] === 'vty') sections.set(t.join(' '), sections.get(t.join(' ')) ?? { local: false });
      else if (t[0] === 'crypto' && t[1] === 'key' && t[2] === 'generate' && t[3] === 'rsa') rsaKey = true;
      else if (t[0] === 'ip' && t[1] === 'ssh' && t[2] === 'authentication-retries') sshRetries = positive(t[3], VTY_SSH_RETRIES_DEFAULT);
      else if (t[0] === 'ip' && t[1] === 'ssh' && t[2] === 'time-out') sshTimeoutS = positive(t[3], VTY_SSH_TIMEOUT_DEFAULT_S);
      continue;
    }
    const head = l.context[0];
    if (l.context.length !== 1 || head === undefined || head[0] !== 'line' || head[1] !== 'vty') continue;
    const key = head.join(' ');
    const s = sections.get(key) ?? { local: false };
    sections.set(key, s);
    if (t[0] === 'transport' && t[1] === 'input') s.transport = t.slice(2);
    else if (t[0] === 'access-class' && t[2] === 'in' && t[1] !== undefined) s.accessClass = t[1];
    else if (t[0] === 'login') s.local = t[1] === 'local';
    else if (t[0] === 'password' && t.length > 1) s.password = t.slice(1).join(' ');
  }
  const lines: VtyLineConfig[] = [];
  for (const [key, s] of sections) {
    const login: VtyLineConfig['login'] = s.local ? 'local' : s.password !== undefined ? 'line' : 'none';
    const line: { -readonly [K in keyof VtyLineConfig]: VtyLineConfig[K] } = { name: key.slice('line '.length), transport: transportOf(s.transport), login };
    if (s.accessClass !== undefined) line.accessClass = s.accessClass;
    if (s.password !== undefined) line.password = s.password;
    lines.push(line);
  }
  return { lines, rsaKey, sshRetries, sshTimeoutS };
}

/** @since P3 [S13] The stored secret of local user `name` (`username <name> [privilege <n>] secret|password <s>`). */
export function vtyUserSecret(root: ConfigNode, name: string): string | undefined {
  for (const node of root.children) {
    if (node.key !== 'username' || node.args[0] !== name) continue;
    const a = node.args;
    const at = a[1] === 'privilege' ? 3 : 1;
    if ((a[at] === 'secret' || a[at] === 'password') && a.length > at + 1) return a.slice(at + 1).join(' ');
  }
  return undefined;
}

// ── the daemon ──────────────────────────────────────────────────────────────

const NAME = VTY_DAEMON;
const DEBUG_RING = 256;
const NO_BYTES = new Uint8Array(0);

/** One accepted connection. */
interface VtyConn {
  readonly id: SocketId;
  readonly proto: VtyProto;
  readonly peer: IpAddress;
  readonly peerPort: number;
  readonly local: IpAddress;
  readonly localPort: number;
  /** When the connection was accepted (W4, R43: the `show users` "Connected for" column). */
  readonly since: SimTime;
  /** The `line vty` section serving it (read at accept). */
  readonly line: VtyLineConfig;
  phase: 'check' | 'version' | 'auth' | 'user' | 'password' | 'open' | 'closing';
  user?: string;
  failures: number;
  /** The access-class check passed (or there is none). */
  checked: boolean;
  /** SSH: the password of the USERAUTH_REQUEST waiting for the access-class verdict. */
  pending?: string;
  /** We announced `WILL ECHO` (masked input) and not yet `WONT ECHO`. */
  masked: boolean;
  /** A via-'vty' CLI session serves this connection (remoteCli open sent, not yet closed by either side). */
  cliOpen: boolean;
  readonly reader: VtyTermReader;
  /** SSH: received bytes not yet framed. */
  rx: Uint8Array;
  /** SSH: keystream keys of received (client → server) and sent packets. */
  readonly rxKey: number;
  readonly txKey: number;
}

/** @since P3 [S13] Create the remote terminal server (`name: 'vty'`, no frame selectors). One instance per device. */
export function createVty(): Process {
  const conns = new Map<SocketId, VtyConn>();
  const ring: DebugEvent[] = [];
  let cfg: VtyConfig = { lines: [], rsaKey: false, sshRetries: VTY_SSH_RETRIES_DEFAULT, sshTimeoutS: VTY_SSH_TIMEOUT_DEFAULT_S };
  const listening: Record<VtyProto, boolean> = { telnet: false, ssh: false };
  let seq = 0;
  let logins = 0;
  let failures = 0;
  let refusals = 0;

  function debug(ctx: ProcessCtx, proto: VtyProto, message: string, data?: Record<string, unknown>): void {
    const category = VTY_DEBUG_CATEGORY[proto];
    ctx.debug(category, message, data);
    const ev: DebugEvent = data
      ? { at: ctx.now, device: ctx.deviceId, process: NAME, category, message, data }
      : { at: ctx.now, device: ctx.deviceId, process: NAME, category, message };
    ring.push(ev);
    if (ring.length > DEBUG_RING) ring.splice(0, ring.length - DEBUG_RING);
  }

  const toTcp = (req: ProcessRequest): Action => ({ type: 'request', to: 'tcp', req });
  const remote = (act: RemoteCliAction): Action => act;
  const loginTimer = (c: VtyConn): string => `login:${c.id}`;

  /** Open or close the hidden listeners to match the configuration (silent: no debug, no row, D14). */
  function sync(ctx: ProcessCtx): Action[] {
    cfg = readVtyConfig(ctx.config.root);
    const out: Action[] = [];
    const want: Record<VtyProto, boolean> = {
      telnet: cfg.lines.some((l) => l.transport.includes('telnet')),
      ssh: cfg.rsaKey && cfg.lines.some((l) => l.transport.includes('ssh')),
    };
    for (const proto of ['telnet', 'ssh'] as const) {
      if (want[proto] === listening[proto]) continue;
      listening[proto] = want[proto];
      const socket = proto === 'ssh' ? VTY_SSH_SOCKET : VTY_TELNET_SOCKET;
      const localPort = proto === 'ssh' ? VTY_SSH_PORT : VTY_TELNET_PORT;
      out.push(toTcp(want[proto] ? { kind: 'tcp.listen', owner: NAME, socket, family: 4, localPort, service: true } : { kind: 'tcp.close', socket }));
    }
    return out;
  }

  /** One `vty-logins` row (the oldest deleted first when the table is full). */
  function loginRow(ctx: ProcessCtx, c: VtyConn, result: VtyLoginRow['result'], reason?: string): void {
    seq++;
    if (result === 'success') logins++;
    else if (result === 'failed') failures++;
    else refusals++;
    const table = ctx.tables.get<VtyLoginRow>('vty-logins');
    if (table === undefined) return;
    while (table.size >= VTY_LOGINS_LIMIT) {
      const oldest = table.rows()[0];
      if (oldest === undefined) break;
      table.delete(oldest.key, 'replaced');
    }
    const row: VtyLoginRow = { key: String(seq), seq, proto: c.proto, peer: c.peer, result, at: ctx.now, updatedAt: ctx.now };
    if (c.user !== undefined) row.user = c.user;
    if (reason !== undefined) row.reason = reason;
    table.set(row);
  }

  const protoName = (p: VtyProto): string => (p === 'ssh' ? 'SSH' : 'telnet');

  /** Terminal stream bytes to the client (inside a CHANNEL_DATA packet on SSH). */
  function send(c: VtyConn, bytes: Uint8Array): Action {
    const data = c.proto === 'ssh' ? vtySshPacket(c.txKey, SSH_MSG_CHANNEL_DATA, bytes) : bytes;
    return toTcp({ kind: 'tcp.send', socket: c.id, data });
  }

  const sendText = (c: VtyConn, text: string): Action => send(c, vtyTermOutput({ text }, c));
  const sendPrompt = (c: VtyConn, prompt: string, secret: boolean): Action => send(c, vtyTermOutput({ text: '', prompt, secret }, c));

  /** Close the connection gracefully (FIN after the queued data); the login guard stops. */
  function closeConn(c: VtyConn): Action[] {
    c.phase = 'closing';
    return [{ type: 'cancelTimer', key: loginTimer(c) }, toTcp({ kind: 'tcp.close', socket: c.id })];
  }

  /** End the CLI session of `c`, if one is open. */
  function closeCli(c: VtyConn): Action[] {
    if (!c.cliOpen) return [];
    c.cliOpen = false;
    return [remote({ type: 'remoteCli', op: 'close', conn: c.id })];
  }

  /** Forget a connection that tcp closed. */
  function forget(c: VtyConn): Action[] {
    conns.delete(c.id);
    return [...closeCli(c), { type: 'cancelTimer', key: loginTimer(c) }];
  }

  /** The access-class check of `c` (D14): the tuple of its accepted SYN. */
  function check(ctx: ProcessCtx, c: VtyConn, list: string): Action[] {
    c.phase = 'check';
    const tuple: PacketTuple = { family: 4, proto: IPPROTO_TCP, src: c.peer, dst: c.local, srcPort: c.peerPort, dstPort: c.localPort, tcpFlags: 0x02 };
    debug(ctx, c.proto, `${c.id}: checking ${c.peer} against access-class ${list}`, { conn: c.id, list });
    return [{ type: 'request', to: 'acl', req: { kind: 'acl.check', family: 4, list, tuple, token: c.id, owner: NAME } }];
  }

  /** Does `c` need an access-class check the device can run? */
  const needsCheck = (ctx: ProcessCtx, c: VtyConn): string | undefined =>
    !c.checked && c.line.accessClass !== undefined && ctx.model.processes.includes('acl') ? c.line.accessClass : undefined;

  /** access-class refused `c`: a RST after the handshake (listed deviation), a refused row and a log. */
  function refuse(ctx: ProcessCtx, c: VtyConn): Action[] {
    const list = c.line.accessClass ?? '?';
    loginRow(ctx, c, 'refused', `access-class ${list}`);
    debug(ctx, c.proto, `${c.id}: ${c.peer} refused by access-class ${list}`, { conn: c.id, list });
    conns.delete(c.id);
    const who = c.user !== undefined ? ` for user ${c.user}` : '';
    return [
      { type: 'cancelTimer', key: loginTimer(c) },
      toTcp({ kind: 'tcp.abort', socket: c.id }),
      { type: 'log', severity: VTY_LOG_SEVERITY, facility: VTY_LOG_FACILITY, message: `Remote ${protoName(c.proto)} login${who} from ${c.peer} refused by access-class ${list}` },
    ];
  }

  /** Check `password` (and `c.user` under `login local`): undefined when it is right, else the failure reason. */
  function verify(ctx: ProcessCtx, c: VtyConn, password: string): string | undefined {
    if (c.line.login === 'local') {
      const stored = c.user === undefined ? undefined : vtyUserSecret(ctx.config.root, c.user);
      if (stored === undefined) return 'unknown user';
      return verifySecret(ctx.deviceId, stored, password) ? undefined : 'bad password';
    }
    if (c.line.login === 'line' && c.line.password !== undefined) return verifySecret(ctx.deviceId, c.line.password, password) ? undefined : 'bad password';
    return 'no password set';
  }

  /** A successful login: the row, then the CLI session (D14). */
  function loginOk(ctx: ProcessCtx, c: VtyConn): Action[] {
    loginRow(ctx, c, 'success');
    c.phase = 'open';
    c.cliOpen = true;
    debug(ctx, c.proto, `${c.id}: ${c.user ?? 'login'} from ${c.peer} logged in`, { conn: c.id, user: c.user });
    const out: Action[] = [{ type: 'cancelTimer', key: loginTimer(c) }];
    if (c.proto === 'ssh') out.push(toTcp({ kind: 'tcp.send', socket: c.id, data: vtySshPacket(c.txKey, SSH_MSG_USERAUTH_SUCCESS) }));
    const act: RemoteCliAction = { type: 'remoteCli', op: 'open', conn: c.id, peer: c.peer, proto: c.proto };
    if (c.user !== undefined) act.user = c.user;
    out.push(remote(act));
    return out;
  }

  /** A failed login attempt: the row and the log, then another prompt or the end of the connection. */
  function loginFailed(ctx: ProcessCtx, c: VtyConn, reason: string): Action[] {
    loginRow(ctx, c, 'failed', reason);
    c.failures++;
    debug(ctx, c.proto, `${c.id}: login from ${c.peer} failed (${reason})`, { conn: c.id, reason });
    const who = c.user !== undefined ? ` for user ${c.user}` : '';
    const out: Action[] = [{ type: 'log', severity: VTY_LOG_SEVERITY, facility: VTY_LOG_FACILITY, message: `Remote ${protoName(c.proto)} login${who} from ${c.peer} failed (${reason})` }];
    if (reason === 'no password set') {
      if (c.proto === 'ssh') out.push(disconnect(c, VTY_MSG_NO_PASSWORD));
      else out.push(sendText(c, VTY_MSG_NO_PASSWORD));
      return [...out, ...closeConn(c)];
    }
    if (c.proto === 'ssh') {
      if (c.failures >= cfg.sshRetries) return [...out, disconnect(c, VTY_MSG_SSH_DENIED), ...closeConn(c)];
      c.phase = 'auth';
      return [...out, toTcp({ kind: 'tcp.send', socket: c.id, data: vtySshPacket(c.txKey, SSH_MSG_USERAUTH_FAILURE) })];
    }
    if (c.failures >= VTY_TELNET_ATTEMPTS) return [...out, sendText(c, VTY_MSG_LOGIN_DENIED), ...closeConn(c)];
    out.push(sendText(c, VTY_MSG_LOGIN_FAILED));
    return [...out, ...startLogin(ctx, c)];
  }

  /** SSH_MSG_DISCONNECT with a reason text. */
  const disconnect = (c: VtyConn, text: string): Action =>
    toTcp({ kind: 'tcp.send', socket: c.id, data: vtySshPacket(c.txKey, SSH_MSG_DISCONNECT, vtyBytes(text)) });

  /** Telnet: the first prompt of the login (or the refusal of a line without a password). */
  function startLogin(ctx: ProcessCtx, c: VtyConn): Action[] {
    if (c.line.login === 'local') {
      c.phase = 'user';
      delete c.user;
      return [sendPrompt(c, VTY_PROMPT_USERNAME, false)];
    }
    if (c.line.login === 'line') {
      c.phase = 'password';
      return [sendPrompt(c, VTY_PROMPT_PASSWORD, true)];
    }
    return loginFailed(ctx, c, 'no password set');
  }

  /** SSH: authenticate the USERAUTH_REQUEST password (the access-class check has passed). */
  function authenticate(ctx: ProcessCtx, c: VtyConn, password: string): Action[] {
    const reason = verify(ctx, c, password);
    return reason === undefined ? loginOk(ctx, c) : loginFailed(ctx, c, reason);
  }

  // ── receiving ──

  /** A line the client typed on `c`. */
  function onLine(ctx: ProcessCtx, c: VtyConn, text: string): Action[] {
    switch (c.phase) {
      case 'user': {
        const user = text.trim();
        if (user === '') return [sendPrompt(c, VTY_PROMPT_USERNAME, false)];
        c.user = user;
        c.phase = 'password';
        return [sendPrompt(c, VTY_PROMPT_PASSWORD, true)];
      }
      case 'password': {
        const reason = verify(ctx, c, text);
        return reason === undefined ? loginOk(ctx, c) : loginFailed(ctx, c, reason);
      }
      case 'open':
        return [remote({ type: 'remoteCli', op: 'line', conn: c.id, text })];
      default:
        return [];
    }
  }

  /** Terminal stream bytes from the client (telnet data, or SSH CHANNEL_DATA). */
  function onTerm(ctx: ProcessCtx, c: VtyConn, bytes: Uint8Array): Action[] {
    const out: Action[] = [];
    for (const ev of c.reader.feed(bytes)) {
      if (!conns.has(c.id) || c.phase === 'closing') break;
      if (ev.kind === 'line') out.push(...onLine(ctx, c, ev.text));
      else if (ev.kind === 'interrupt') debug(ctx, c.proto, `${c.id}: interrupt from ${c.peer} ignored`, { conn: c.id });
    }
    return out;
  }

  /** SSH bytes from the client: the identification line, then protected packets. */
  function onSsh(ctx: ProcessCtx, c: VtyConn, data: Uint8Array): Action[] {
    c.rx = vtyConcat(c.rx, data);
    const out: Action[] = [];
    if (c.phase === 'version') {
      const v = vtySshVersionLine(c.rx);
      if (v === undefined) return out;
      if (!vtySshVersionOk(v.line)) {
        debug(ctx, 'ssh', `${c.id}: ${c.peer} does not speak SSH 2.0 (protocol mismatch)`, { conn: c.id });
        return [toTcp({ kind: 'tcp.send', socket: c.id, data: vtyBytes(`${VTY_MSG_PROTOCOL_MISMATCH}\r\n`) }), ...closeConn(c)];
      }
      c.rx = v.rest;
      c.phase = 'auth';
    }
    const { packets, rest } = vtySshUnpack(c.rxKey, c.rx);
    c.rx = rest;
    for (const p of packets) {
      if (!conns.has(c.id) || c.phase === 'closing') break;
      const type = p[0];
      const body = p.subarray(1);
      if (type === SSH_MSG_USERAUTH_REQUEST && c.phase === 'auth') {
        const zero = body.indexOf(0);
        const user = UTF8_DECODER.decode(zero < 0 ? body : body.subarray(0, zero));
        const password = zero < 0 ? '' : UTF8_DECODER.decode(body.subarray(zero + 1));
        c.user = user;
        const list = needsCheck(ctx, c);
        if (list !== undefined) {
          c.pending = password;
          out.push(...check(ctx, c, list));
        } else out.push(...authenticate(ctx, c, password));
      } else if (type === SSH_MSG_CHANNEL_DATA && c.phase === 'open') {
        out.push(...onTerm(ctx, c, body));
      }
    }
    return out;
  }

  /** A connection reached ESTABLISHED on one of the listeners. */
  function accepted(ctx: ProcessCtx, ev: Extract<ProcessEvent, { kind: 'sock.accepted' }>): Action[] {
    const proto: VtyProto | undefined = ev.listener === VTY_SSH_SOCKET ? 'ssh' : ev.listener === VTY_TELNET_SOCKET ? 'telnet' : undefined;
    if (proto === undefined) return [];
    const line = cfg.lines.find((l) => l.transport.includes(proto));
    if (line === undefined) return [toTcp({ kind: 'tcp.abort', socket: ev.socket })];
    const c: VtyConn = {
      id: ev.socket, proto, peer: ev.remoteAddr, peerPort: ev.remotePort, local: ev.localAddr, localPort: ev.localPort, since: ctx.now, line,
      phase: proto === 'ssh' ? 'version' : 'check', failures: 0, checked: false, masked: false, cliOpen: false,
      reader: createVtyTermReader(), rx: NO_BYTES,
      rxKey: vtySshKey(ev.remoteAddr, ev.remotePort, ev.localAddr, ev.localPort),
      txKey: vtySshKey(ev.localAddr, ev.localPort, ev.remoteAddr, ev.remotePort),
    };
    conns.set(c.id, c);
    debug(ctx, proto, `${c.id}: ${protoName(proto)} connection from ${c.peer}:${c.peerPort} on vty ${line.name}`, { conn: c.id, peer: c.peer });
    const guard = proto === 'ssh' ? cfg.sshTimeoutS * SEC : VTY_TELNET_LOGIN_TIMEOUT_NS;
    const out: Action[] = [{ type: 'timer', key: loginTimer(c), delay: guard }];
    if (proto === 'ssh') {
      // the identification line in clear, then every later byte of the connection is protected
      out.push(toTcp({ kind: 'tcp.send', socket: c.id, data: vtyBytes(`${VTY_SSH_VERSION}\r\n`) }), toTcp(tcpProtectRequest(c.id, 'ssh')));
      return out;
    }
    const list = needsCheck(ctx, c);
    if (list !== undefined) return [...out, ...check(ctx, c, list)];
    c.checked = true;
    return [...out, ...startLogin(ctx, c)];
  }

  /** The access-class verdict for `c` (token = its id). */
  function verdict(ctx: ProcessCtx, ev: AclVerdictEvent): Action[] {
    const c = conns.get(ev.token);
    if (c === undefined || c.phase !== 'check') return [];
    if (ev.action === 'deny') return refuse(ctx, c);
    c.checked = true;
    debug(ctx, c.proto, `${c.id}: access-class ${c.line.accessClass ?? '?'} permits ${c.peer}`, { conn: c.id });
    if (c.proto === 'telnet') return startLogin(ctx, c);
    const password = c.pending ?? '';
    delete c.pending;
    c.phase = 'auth';
    return authenticate(ctx, c, password);
  }

  /** The output of `c`'s CLI session, back over the connection (D14). */
  function output(ev: VtyOutputEvent): Action[] {
    const c = conns.get(ev.conn);
    if (c === undefined || c.phase !== 'open') return [];
    const out: Action[] = [];
    const out0: { text: string; prompt?: string; secret?: boolean } = { text: ev.text };
    if (ev.prompt !== undefined) out0.prompt = ev.prompt;
    if (ev.input === 'secret') out0.secret = true;
    const bytes = vtyTermOutput(out0, c);
    if (bytes.length > 0) out.push(send(c, bytes));
    if (ev.closed === true) {
      c.cliOpen = false;
      out.push(...closeConn(c));
    }
    return out;
  }

  return {
    name: NAME,

    init(ctx): Action[] {
      return sync(ctx);
    },

    onPdu(): Action[] {
      return [];
    },

    onConfig(ctx, delta: ConfigDelta): Action[] {
      const head = delta.context[0];
      const l = delta.line;
      const relevant =
        (head !== undefined && head[0] === 'line') || l[0] === 'line' || l[0] === 'crypto' || (l[0] === 'ip' && l[1] === 'ssh');
      return relevant ? sync(ctx) : [];
    },

    onTimer(ctx, key): Action[] {
      if (!key.startsWith('login:')) return [];
      const c = conns.get(key.slice('login:'.length));
      if (c === undefined || c.phase === 'open' || c.phase === 'closing') return [];
      debug(ctx, c.proto, `${c.id}: no login from ${c.peer} in time`, { conn: c.id });
      if (c.proto === 'telnet') return [sendText(c, VTY_MSG_LOGIN_TIMEOUT), ...closeConn(c)];
      return c.phase === 'version' ? closeConn(c) : [disconnect(c, VTY_MSG_LOGIN_TIMEOUT), ...closeConn(c)];
    },

    onEvent(ctx, ev: ProcessEvent): Action[] {
      switch (ev.kind) {
        case 'sock.accepted':
          return accepted(ctx, ev);
        case 'acl.verdict':
          return verdict(ctx, ev);
        case 'vty.output':
          return output(ev);
        case 'sock.data': {
          const c = conns.get(ev.socket);
          if (c === undefined || c.phase === 'closing') return [];
          return c.proto === 'ssh' ? onSsh(ctx, c, ev.data) : onTerm(ctx, c, ev.data);
        }
        case 'sock.peerClosed': {
          const c = conns.get(ev.socket);
          if (c === undefined) return [];
          debug(ctx, c.proto, `${c.id}: ${c.peer} closed the connection`, { conn: c.id });
          if (c.phase === 'closing') return [];
          return [...closeCli(c), ...closeConn(c)];
        }
        case 'sock.closed':
        case 'sock.error': {
          const c = conns.get(ev.socket);
          return c === undefined ? [] : forget(c);
        }
        default:
          return [];
      }
    },

    onRequest(): Action[] {
      return [];
    },

    stateSnapshot(): StateView {
      return {
        process: NAME,
        state: {
          listening: (['telnet', 'ssh'] as const).filter((p) => listening[p]),
          connections: [...conns.values()].map((c) => ({
            id: c.id,
            proto: c.proto,
            peer: c.peer,
            phase: c.phase,
            ...(c.user !== undefined ? { user: c.user } : {}),
            since: c.since,
          })),
          logins,
          failures,
          refusals,
        },
      };
    },

    debugEvents(): readonly DebugEvent[] {
      return ring;
    },
  };
}
