/**
 * protocols/l2/port-security.ts — the port-security decision (ARCHITECTURE-P2 D12, §3.0 step 7, §3.8, §5.1).
 *
 * eth-switch runs the check in its per-frame path before learning, only when a `port-security` row exists for the
 * logical port L. This module holds the pure pieces:
 *
 *  • `readPortSecurity(config, port)` — the port's `switchport port-security …` lines (undefined unless the enabling
 *    line `switchport port-security` is present): maximum (default 1), violation mode (default shutdown), sticky
 *    learning, configured addresses and sticky addresses, MACs canonicalised.
 *  • `decidePortSecurity(check)` — for a frame from `src`:
 *      src already secure on L                      → allow;
 *      src secure on another port of the same VLAN  → violation (as on real switches, §3.8 step 4);
 *      fewer secure addresses than the maximum      → learn (secure 'sticky' when sticky learning is on, else 'dynamic');
 *      otherwise                                    → violation.
 *    A violation always drops (`port-security`); protect does nothing else; restrict counts it and logs (severity 4);
 *    shutdown counts it, sets the row `secure-shutdown` and err-disables the port (`psecure-violation`).
 *  • row helpers (`portSecurityRow`, `applyPortSecurityVerdict`, `portSecurityStatus`), the sticky `configLine`
 *    action, and the shared err-disable recovery reader (`errdisableRecovery`, used by eth-switch, stp and
 *    etherchannel for their own causes, §3.8 step 6) with its timer key.
 *
 * Wording is original. Pure: no state, no I/O, no clock, no randomness.
 */
import { normalizeMac } from '../../contracts/addr.js';
import type { MacAddress } from '../../contracts/addr.js';
import type { ConfigAst, ConfigNode } from '../../contracts/config.js';
import type { PortId } from '../../contracts/ids.js';
import type { ErrDisableCause } from '../../contracts/port.js';
import type { Action } from '../../contracts/process.js';
import type { PortSecurityRow } from '../../contracts/tables.js';
import { SEC } from '../../contracts/time.js';
import type { SimTime } from '../../contracts/time.js';

/** Violation modes, in `switchport port-security violation` order. */
export type PortSecurityViolationMode = PortSecurityRow['violation'];
/** Default secure-address maximum. */
export const PORT_SECURITY_DEFAULT_MAX = 1;
/** Highest accepted maximum. */
export const PORT_SECURITY_MAX_LIMIT = 8192;
/** Default violation mode. */
export const PORT_SECURITY_DEFAULT_VIOLATION: PortSecurityViolationMode = 'shutdown';
/** Syslog facility of port-security messages (original). */
export const PORT_SECURITY_LOG_FACILITY = 'PORTSEC';
/** Debug category of eth-switch's new port-security messages (§5.4). */
export const PORT_SECURITY_DEBUG_CATEGORY = 'port-security';

/** The port-security lines of one port (only when `switchport port-security` is configured). */
export interface PortSecurityConfig {
  readonly max: number;
  readonly violation: PortSecurityViolationMode;
  /** `switchport port-security mac-address sticky`. */
  readonly sticky: boolean;
  /** `switchport port-security mac-address <mac>` lines, canonical, in config order, no duplicates. */
  readonly configured: readonly MacAddress[];
  /** `switchport port-security mac-address sticky <mac>` lines, canonical, in config order, no duplicates. */
  readonly stickyMacs: readonly MacAddress[];
}

/** A secure address derived from the running config (never flushed, D12). */
export interface ConfiguredSecureAddress {
  readonly mac: MacAddress;
  readonly secure: 'configured' | 'sticky';
}

/** Token lists of the lines of the `interface <port>` section (a stored `switchport` group flattened). */
function portLines(config: ConfigAst, port: PortId): string[][] | undefined {
  let node: ConfigNode | undefined;
  for (const c of config.root.children) {
    if (c.key === 'interface' && c.args.length === 1 && c.args[0] === port) {
      node = c;
      break;
    }
  }
  if (node === undefined) return undefined;
  const out: string[][] = [];
  for (const c of node.children) {
    if (c.key === 'switchport' && c.args.length === 0 && c.children.length > 0) {
      for (const leaf of c.children) out.push(['switchport', leaf.key, ...leaf.args]);
    } else {
      out.push([c.key, ...c.args]);
    }
  }
  return out;
}

/**
 * The port-security configuration of `port`, or undefined when the enabling line `switchport port-security` is absent
 * (other port-security lines alone configure nothing that runs). Lines that do not parse are ignored.
 */
export function readPortSecurity(config: ConfigAst, port: PortId): PortSecurityConfig | undefined {
  const lines = portLines(config, port);
  if (lines === undefined) return undefined;
  let enabled = false;
  let max = PORT_SECURITY_DEFAULT_MAX;
  let violation: PortSecurityViolationMode = PORT_SECURITY_DEFAULT_VIOLATION;
  let sticky = false;
  const configured: MacAddress[] = [];
  const stickyMacs: MacAddress[] = [];
  for (const t of lines) {
    if (t[0] !== 'switchport' || t[1] !== 'port-security') continue;
    const rest = t.slice(2);
    if (rest.length === 0) {
      enabled = true;
    } else if (rest[0] === 'maximum' && rest.length === 2) {
      const n = /^\d{1,5}$/.test(rest[1] as string) ? Number(rest[1]) : NaN;
      if (n >= 1 && n <= PORT_SECURITY_MAX_LIMIT) max = n;
    } else if (rest[0] === 'violation' && rest.length === 2) {
      const m = rest[1];
      if (m === 'protect' || m === 'restrict' || m === 'shutdown') violation = m;
    } else if (rest[0] === 'mac-address' && rest[1] === 'sticky') {
      if (rest.length === 2) {
        sticky = true;
      } else {
        const mac = normalizeMac(rest[2] as string);
        if (mac !== null && !stickyMacs.includes(mac)) stickyMacs.push(mac);
      }
    } else if (rest[0] === 'mac-address' && rest.length >= 2) {
      const mac = normalizeMac(rest[1] as string);
      if (mac !== null && !configured.includes(mac)) configured.push(mac);
    }
  }
  if (!enabled) return undefined;
  return Object.freeze({
    max,
    violation,
    sticky,
    configured: Object.freeze(configured),
    stickyMacs: Object.freeze(stickyMacs.filter((m) => !configured.includes(m))),
  });
}

/** The secure addresses a port's config installs (configured first, then sticky; §3.8 step 2: derived idempotently). */
export function configuredSecureAddresses(cfg: PortSecurityConfig): readonly ConfiguredSecureAddress[] {
  return [
    ...cfg.configured.map((mac) => ({ mac, secure: 'configured' as const })),
    ...cfg.stickyMacs.map((mac) => ({ mac, secure: 'sticky' as const })),
  ];
}

/** Inputs of one decision. */
export interface PortSecurityCheck {
  /** Logical port L the frame arrived on. */
  readonly port: PortId;
  readonly config: PortSecurityConfig;
  /** Unicast source of the frame (group sources never reach the check). */
  readonly src: MacAddress;
  /** Port on which `src` is already a secure address in the frame's VLAN (a secure CAM row), if any. */
  readonly securedOn?: PortId;
  /** Secure addresses currently on L (configured + sticky + dynamic secure rows). */
  readonly count: number;
}

/** Outcome of one decision. */
export type PortSecurityVerdict =
  | { readonly kind: 'allow' }
  /** Learn `src` as a secure address of L (count + 1); 'sticky' also writes the sticky line (`stickyConfigLine`). */
  | { readonly kind: 'learn'; readonly secure: 'dynamic' | 'sticky' }
  | {
      readonly kind: 'violation';
      readonly mode: PortSecurityViolationMode;
      /** Drop reason 'port-security' with this detail. */
      readonly detail: string;
      /** restrict and shutdown count the violation (row `violations + 1`). */
      readonly counts: boolean;
      /** restrict: one log line, severity 4. */
      readonly log?: { readonly severity: 4; readonly message: string };
      /** shutdown: `Action errDisable {port, cause: 'psecure-violation', detail}`. */
      readonly errDisable?: { readonly cause: ErrDisableCause; readonly detail: string };
    };

/** `N address` / `N addresses`. */
function addresses(n: number): string {
  return n === 1 ? '1 address' : `${n} addresses`;
}

/** Drop detail of a violation: `address <mac> is not allowed on <port> (<mode>)`. */
export function psecNotAllowedDetail(mac: MacAddress, port: PortId, mode: PortSecurityViolationMode): string {
  return `address ${mac} is not allowed on ${port} (${mode})`;
}

/** Drop detail when the address is already secure on another port: `address <mac> is secured on <other> (<mode>)`. */
export function psecSecuredElsewhereDetail(mac: MacAddress, other: PortId, mode: PortSecurityViolationMode): string {
  return `address ${mac} is secured on ${other} (${mode})`;
}

/** Decide what happens to a frame from `check.src` on `check.port` (§3.8). */
export function decidePortSecurity(check: PortSecurityCheck): PortSecurityVerdict {
  const { port, config, src } = check;
  if (check.securedOn === port) return { kind: 'allow' };
  if (check.securedOn === undefined && check.count < config.max) {
    return { kind: 'learn', secure: config.sticky ? 'sticky' : 'dynamic' };
  }
  const mode = config.violation;
  const elsewhere = check.securedOn !== undefined;
  const detail = elsewhere
    ? psecSecuredElsewhereDetail(src, check.securedOn as PortId, mode)
    : psecNotAllowedDetail(src, port, mode);
  const why = elsewhere
    ? `it is secured on ${check.securedOn as PortId}`
    : `the port allows ${addresses(config.max)}`;
  if (mode === 'protect') return { kind: 'violation', mode, detail, counts: false };
  if (mode === 'restrict') {
    return {
      kind: 'violation', mode, detail, counts: true,
      log: { severity: 4, message: `Port security on ${port} refused ${src}: ${why}.` },
    };
  }
  return {
    kind: 'violation', mode, detail, counts: true,
    errDisable: { cause: 'psecure-violation', detail: `port security refused ${src}: ${why}` },
  };
}

/** Status of a secured port: shut down by a violation, else up or down with the port. */
export function portSecurityStatus(operUp: boolean, errDisabled: string | undefined): PortSecurityRow['status'] {
  if (errDisabled === 'psecure-violation') return 'secure-shutdown';
  return operUp ? 'secure-up' : 'secure-down';
}

/**
 * The `port-security` row of `port` for `cfg` (key = port), keeping the counters of `prev` (count, violations, last
 * violating MAC) when there is one. `status` defaults to prev's status, else 'secure-up'.
 */
export function portSecurityRow(
  port: PortId,
  cfg: PortSecurityConfig,
  now: SimTime,
  prev?: PortSecurityRow,
  status?: PortSecurityRow['status'],
): PortSecurityRow {
  const row: PortSecurityRow = {
    key: port,
    port,
    max: cfg.max,
    count: prev?.count ?? 0,
    violation: cfg.violation,
    sticky: cfg.sticky,
    violations: prev?.violations ?? 0,
    status: status ?? prev?.status ?? 'secure-up',
    updatedAt: now,
  };
  if (prev?.lastViolationMac !== undefined) row.lastViolationMac = prev.lastViolationMac;
  return row;
}

/**
 * The row after `verdict` for a frame from `src`: learn → count + 1; a counted violation → violations + 1 and
 * lastViolationMac; shutdown → status 'secure-shutdown'; allow and protect leave the row unchanged (same object).
 */
export function applyPortSecurityVerdict(row: PortSecurityRow, verdict: PortSecurityVerdict, src: MacAddress, now: SimTime): PortSecurityRow {
  if (verdict.kind === 'allow') return row;
  if (verdict.kind === 'learn') return { ...row, count: row.count + 1, updatedAt: now };
  if (!verdict.counts) return row;
  return {
    ...row,
    violations: row.violations + 1,
    lastViolationMac: src,
    status: verdict.errDisable !== undefined ? 'secure-shutdown' : row.status,
    updatedAt: now,
  };
}

/** The sticky line eth-switch writes for a newly learned sticky address (§3.8 step 2), as a `configLine` action. */
export function stickyConfigLine(port: PortId, mac: MacAddress): Extract<Action, { type: 'configLine' }> {
  return {
    type: 'configLine',
    context: [['interface', port]],
    line: ['switchport', 'port-security', 'mac-address', 'sticky', mac],
    negate: false,
  };
}

/** True when `line` (tokens, without `no`) is a `switchport port-security …` line (never a CAM-flush trigger, D12). */
export function isPortSecurityLine(line: readonly string[]): boolean {
  return line[0] === 'switchport' && line[1] === 'port-security';
}

// ── err-disable recovery (shared by the three causes' daemons, §3.8 step 6, §5.1) ──

/** Default `errdisable recovery interval` (300 s). */
export const ERRDISABLE_RECOVERY_DEFAULT_NS: SimTime = 300 * SEC;

/** Timer key of a port's automatic recovery (periodic, §4.2): `errdisable:<port>`. */
export function errdisableTimerKey(port: PortId): string {
  return `errdisable:${port}`;
}

/** Recovery settings of one cause. */
export interface ErrdisableRecovery {
  /** `errdisable recovery cause <cause>` (or `… cause all`) is configured. */
  readonly enabled: boolean;
  /** `errdisable recovery interval <s>` (default 300 s), in SimTime. */
  readonly intervalNs: SimTime;
}

/** The global `errdisable recovery …` lines of `config` for `cause`. */
export function errdisableRecovery(config: ConfigAst, cause: ErrDisableCause): ErrdisableRecovery {
  let enabled = false;
  let intervalNs = ERRDISABLE_RECOVERY_DEFAULT_NS;
  for (const c of config.root.children) {
    if (c.key !== 'errdisable' || c.args[0] !== 'recovery') continue;
    if (c.args[1] === 'cause' && c.args.length === 3 && (c.args[2] === cause || c.args[2] === 'all')) enabled = true;
    if (c.args[1] === 'interval' && c.args.length === 3 && /^\d{1,5}$/.test(c.args[2] as string)) {
      const s = Number(c.args[2]);
      if (s >= 30 && s <= 86400) intervalNs = s * SEC;
    }
  }
  return { enabled, intervalNs };
}
