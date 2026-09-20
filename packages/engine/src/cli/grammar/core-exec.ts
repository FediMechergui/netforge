/**
 * cli/grammar/core-exec.ts — EXEC-level commands every network OS or host shell shares (spec §7.1–§7.3;
 * ARCHITECTURE "P0 CLI surface", ARCHITECTURE-P1 §3.13), plus the small spec-building helpers the other grammar
 * fragments reuse (arg builders, grammar lists, port-role sets, the debug category helper).
 *
 * Scoping is data (D2): `grammars` picks the shell (nfos or host), `requires`/`requiresAny` read the device's
 * effective capabilities, and mode class selectors (`@exec`, `@config`) replace the P0 mode lists. No spec names a
 * device kind. Specs that change session state declare `entersMode` or `sessionEffect`, so `do` refuses them.
 *
 * Every help string is original wording (spec §1.6, D13).
 */
import type { ArgSpec, CommandSpec, DebugCategoryDef, PortRequirement } from '../../contracts/cli.js';
import { CLI_MESSAGES } from '../../contracts/cli.js';
import type { ProcessName } from '../../contracts/ids.js';
import {
  BRIDGING_CAPABILITIES,
  CAPABILITIES,
  CAPABILITY_PROCESSES,
  L3_ROLES,
  PORT_FAMILIES,
  PORT_ROLES,
  ROLE_TRAITS,
  type Capability,
  type CliGrammar,
  type PortRole,
} from '../../contracts/catalog.js';

// ── shared vocabulary for grammar fragments ─────────────────────────────────

/** Specs that exist only in the network OS grammar. */
export const NFOS_ONLY: readonly CliGrammar[] = Object.freeze(['nfos']);
/** Specs that exist only in the host shell grammar. */
export const HOST_ONLY: readonly CliGrammar[] = Object.freeze(['host']);

/** Roles whose ports render an `interface` section and accept interface configuration. */
export const CONFIGURABLE_ROLES: readonly PortRole[] = Object.freeze(PORT_ROLES.filter((r) => ROLE_TRAITS[r].configurable));

/** Capabilities of devices that carry radios (Wi-Fi, point-to-point radio, cellular). */
export const RADIO_CAPABILITIES: readonly Capability[] = Object.freeze([
  'wifi-ap',
  'wifi-client',
  'radio-bridge',
  'cellular-cell',
  'cellular-client',
]);

/** Arg name used by the parser for the `fixedArgs` debug category. */
export const DEBUG_CATEGORY_ARG = 'category';

/**
 * Capabilities whose derived daemon list holds any of `processes` (`CAPABILITY_PROCESSES`), in CAPABILITIES order.
 * A command that only makes sense where a daemon runs scopes itself with this instead of naming a device kind:
 * `requiresAny: capabilitiesRunning('dhcp-server')` is exactly "devices whose capabilities bring the DHCP server".
 */
export function capabilitiesRunning(...processes: readonly ProcessName[]): readonly Capability[] {
  const wanted = new Set<ProcessName>(processes);
  return Object.freeze(CAPABILITIES.filter((c) => (CAPABILITY_PROCESSES[c] ?? []).some((p) => wanted.has(p.process))));
}

/** Capabilities that bring the IPv6 stack (ipv6 / nd / icmpv6). */
export const IPV6_CAPABILITIES: readonly Capability[] = capabilitiesRunning('ipv6');

/** `trace.start` mode of the router form (`traceroute`, UDP probes) and of the host form (`tracert`, echo probes). */
export const TRACE_MODE_UDP = 'udp';
export const TRACE_MODE_ICMP = 'icmp';
/** Arg name the traceroute handler reads the probe mode from (`fixedArgs`). */
export const TRACE_MODE_ARG = 'mode';

/**
 * Port requirement of every interface line that configures an L3 address: a port whose effective role holds one.
 * A switched port of a switch or multilayer switch prints `CLI_MESSAGES.switchedPort`, which names the way out.
 */
export const L3_PORT: PortRequirement = Object.freeze({ roles: L3_ROLES, mismatch: CLI_MESSAGES.switchedPort });

/** An IPv4 address argument. */
export function ipv4Arg(help: string, optional = false): ArgSpec {
  return optional ? { type: 'ipv4', help, optional } : { type: 'ipv4', help };
}

/** A dotted subnet mask argument. */
export function maskArg(help: string): ArgSpec {
  return { type: 'ipv4-mask', help };
}

/** A single-token argument with optional length and form constraints. */
export function wordArg(help: string, extra: Partial<Pick<ArgSpec, 'optional' | 'maxLength' | 'pattern' | 'completion'>> = {}): ArgSpec {
  return { type: 'word', help, ...extra };
}

/** A free-text argument that takes the rest of the line. */
export function restArg(help: string, maxLength?: number): ArgSpec {
  return maxLength === undefined ? { type: 'rest', help } : { type: 'rest', help, maxLength };
}

/** An interface argument, optionally optional and restricted by a port filter. */
export function ifaceArg(help: string, extra: Partial<Pick<ArgSpec, 'optional' | 'portFilter' | 'pattern' | 'completion'>> = {}): ArgSpec {
  return { type: 'interface', help, ...extra };
}

/** One of a fixed set of words. */
export function choiceArg(help: string, choices: readonly string[], optional = false): ArgSpec {
  return optional ? { type: 'choice', help, choices, optional } : { type: 'choice', help, choices };
}

/** An IPv6 address argument (RFC 5952 canonical form). */
export function ipv6Arg(help: string, optional = false): ArgSpec {
  return optional ? { type: 'ipv6', help, optional } : { type: 'ipv6', help };
}

/** An IPv6 prefix argument (`X:X:X:X::X/nn`). */
export function prefix6Arg(help: string, optional = false): ArgSpec {
  return optional ? { type: 'ipv6-prefix', help, optional } : { type: 'ipv6-prefix', help };
}

/** An IPv4 address, IPv6 address or DNS name argument (ping, tracert, nslookup). */
export function hostArg(help: string, optional = false): ArgSpec {
  return optional ? { type: 'host', help, optional } : { type: 'host', help };
}

/** An IPv4 or IPv6 address argument. */
export function ipArg(help: string, optional = false): ArgSpec {
  return optional ? { type: 'ip', help, optional } : { type: 'ip', help };
}

/** A DNS name argument. */
export function nameArg(help: string, optional = false): ArgSpec {
  return optional ? { type: 'hostname', help, optional } : { type: 'hostname', help };
}

/** A secret argument; as the last path element it takes the rest of the line, so a passphrase may hold spaces. */
export function secretArg(help: string, maxLength = 63): ArgSpec {
  return { type: 'secret', help, maxLength };
}

/** A whole number in `[min, max]`. */
export function intArg(help: string, min: number, max: number, optional = false): ArgSpec {
  return optional ? { type: 'int', help, min, max, optional } : { type: 'int', help, min, max };
}

/** Port requirement: the selected interface is of one of these port kinds. */
export function kindsPort(kinds: PortRequirement['kinds'], mismatch?: string): PortRequirement {
  return mismatch === undefined ? { kinds } : { kinds, mismatch };
}

/** Alternation source matching every typed prefix of a word, case-insensitively, longest first. */
function prefixAlternatives(word: string): string[] {
  const out: string[] = [];
  for (let n = word.length; n >= 1; n--) {
    let src = '';
    for (const ch of word.slice(0, n)) {
      const lo = ch.toLowerCase();
      const up = ch.toUpperCase();
      src += lo === up ? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : `[${lo}${up}]`;
    }
    out.push(src);
  }
  return out;
}

/**
 * RegExp source (no anchors, no flags) matching a typed virtual interface name such as `Vlan10`, `vl10`, `lo0` or
 * `Loopback0`: a prefix of a virtual PORT_FAMILIES long name (or its short name) followed by a decimal number.
 */
export const VIRTUAL_NAME_PATTERN: string = (() => {
  const alts: string[] = [];
  for (const fam of PORT_FAMILIES) {
    if (fam.kind !== 'virtual') continue;
    for (const alt of [...prefixAlternatives(fam.long), ...prefixAlternatives(fam.short)]) {
      if (!alts.includes(alt)) alts.push(alt);
    }
  }
  alts.sort((a, b) => b.length - a.length);
  return `(?:${alts.join('|')})[0-9]+`;
})();

/** RegExp source matching any typed interface name that is NOT a virtual interface name. */
export const PHYSICAL_NAME_PATTERN = `(?!${VIRTUAL_NAME_PATTERN}$)[\\s\\S]+`;

/** A debug category as the grammar ships it: the contract definition plus whether `?` lists it. */
export interface GrammarDebugCategory extends DebugCategoryDef {
  /** Executable but not listed in `?` (keeps the P0 help lists of the P0 models unchanged in P0.5). */
  readonly hidden?: boolean;
}

/** One `debug <category>` literal path per category (multi-word categories become several literals). */
export function debugSpecs(defs: readonly GrammarDebugCategory[], objectives: Readonly<Record<string, readonly string[]>>): CommandSpec[] {
  return defs.map((def) => {
    const spec: CommandSpec = {
      path: ['debug', ...def.category.split(' ')],
      mode: 'priv-exec',
      privilege: 15,
      help: def.help,
      handler: CORE_EXEC_HANDLERS.execDebug,
      allowNo: true,
      fixedArgs: { [DEBUG_CATEGORY_ARG]: def.category },
      grammars: NFOS_ONLY,
      objectives: objectives[def.category] ?? ['CCNA1.10.4'],
    };
    if (def.requiresAny !== undefined) spec.requiresAny = def.requiresAny;
    if (def.since !== undefined) spec.since = def.since;
    if (def.hidden === true) spec.hidden = true;
    return spec;
  });
}

// ── core EXEC ───────────────────────────────────────────────────────────────

/** Handler ids of the core EXEC commands. Shared with the runtime and handler owners — never rename. */
export const CORE_EXEC_HANDLERS = {
  execEnable: 'exec.enable',
  execDisable: 'exec.disable',
  execExit: 'exec.exit',
  execLogout: 'exec.logout',
  execEnd: 'exec.end',
  execConfigure: 'exec.configure',
  execPing: 'exec.ping',
  execTraceroute: 'exec.traceroute',
  execCopyRunStart: 'exec.copy-run-start',
  execWrite: 'exec.write',
  execEraseStartup: 'exec.erase-startup',
  execReload: 'exec.reload',
  execClearArp: 'exec.clear-arp',
  execClearMac: 'exec.clear-mac',
  execDebug: 'exec.debug',
  execUndebugAll: 'exec.undebug-all',
  execDo: 'exec.do',
} as const;

/** Debug categories of the P0 daemons plus the shared-segment category (P0.5). */
export const CORE_DEBUG_CATEGORIES: readonly GrammarDebugCategory[] = Object.freeze([
  { category: 'arp', help: 'Trace ARP requests, replies and cache changes', since: 'P0' },
  { category: 'ip icmp', help: 'Trace ICMP messages sent and received', since: 'P0' },
  { category: 'ip packet', help: 'Trace IPv4 packets received, forwarded and dropped', since: 'P0' },
  { category: 'ip routing', help: 'Trace routing table changes and lookups', since: 'P0' },
  { category: 'ethernet switching', help: 'Trace MAC learning, forwarding and flooding', since: 'P0' },
  { category: 'segment', help: 'Trace carrier sensing, collisions and backoff on shared segments', since: 'P0.5', hidden: true },
]);

const CORE_DEBUG_OBJECTIVES: Readonly<Record<string, readonly string[]>> = {
  arp: ['CCNA1.9.2'],
  'ip icmp': ['CCNA1.10.4'],
  'ip packet': ['CCNA1.8.1'],
  'ip routing': ['CCNA2.1.1'],
  'ethernet switching': ['CCNA1.7.2'],
  segment: ['CCNA1.6.2'],
};

const H = CORE_EXEC_HANDLERS;

/** The core EXEC command table (mode navigation, ping, persistence, clearing, debugging, `do`). */
export const CORE_EXEC_GRAMMAR: readonly CommandSpec[] = Object.freeze<CommandSpec[]>([
  {
    path: ['enable'],
    mode: '@exec',
    privilege: 1,
    help: 'Enter privileged mode',
    handler: H.execEnable,
    entersMode: 'priv-exec',
    sessionEffect: 'privilege',
    interactive: true,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.1'],
  },
  {
    path: ['disable'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Leave privileged mode',
    handler: H.execDisable,
    entersMode: 'user-exec',
    sessionEffect: 'privilege',
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.1'],
  },
  {
    path: ['exit'],
    mode: ['@exec', '@config'],
    privilege: 1,
    help: 'Leave the current mode (closes the session at the top level)',
    handler: H.execExit,
    sessionEffect: 'close',
    objectives: ['CCNA1.2.1'],
  },
  {
    path: ['logout'],
    mode: '@exec',
    privilege: 1,
    help: 'Close this session',
    handler: H.execLogout,
    sessionEffect: 'close',
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.1'],
  },
  {
    path: ['end'],
    mode: '@config',
    privilege: 15,
    help: 'Return to privileged mode',
    handler: H.execEnd,
    entersMode: 'priv-exec',
    sessionEffect: 'enter-mode',
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.2'],
  },
  {
    path: ['configure', 'terminal'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Configure from this terminal',
    handler: H.execConfigure,
    entersMode: 'config',
    sessionEffect: 'enter-mode',
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.2'],
  },
  {
    path: ['ping', '<target>'],
    mode: '@exec',
    privilege: 1,
    help: 'Send echo requests to a host',
    args: { target: ipv4Arg('IPv4 address of the host to reach') },
    handler: H.execPing,
    job: true,
    objectives: ['CCNA1.10.4'],
  },
  {
    path: ['traceroute', '<target>'],
    mode: '@exec',
    privilege: 1,
    help: 'Trace the path to a host',
    args: { target: hostArg('Address or name of the host to reach') },
    handler: H.execTraceroute,
    job: true,
    fixedArgs: { mode: TRACE_MODE_UDP },
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.10.4'],
  },
  {
    path: ['copy', 'running-config', 'startup-config'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Save the active configuration as the startup configuration',
    handler: H.execCopyRunStart,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['write'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Save the active configuration',
    handler: H.execWrite,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['write', 'memory'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Save the active configuration to non-volatile storage',
    handler: H.execWrite,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['erase', 'startup-config'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Delete the saved startup configuration',
    handler: H.execEraseStartup,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['reload'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Restart the device',
    handler: H.execReload,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.4'],
  },
  {
    path: ['clear', 'arp-cache'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Remove every dynamic entry from the ARP cache',
    handler: H.execClearArp,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.9.2'],
  },
  {
    path: ['clear', 'mac', 'address-table', 'dynamic'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Remove every dynamically learned MAC address',
    handler: H.execClearMac,
    grammars: NFOS_ONLY,
    requiresAny: BRIDGING_CAPABILITIES,
    objectives: ['CCNA1.7.2'],
  },
  ...debugSpecs(CORE_DEBUG_CATEGORIES, CORE_DEBUG_OBJECTIVES),
  {
    path: ['debug', 'all'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Trace every category (use with care)',
    handler: H.execDebug,
    allowNo: true,
    fixedArgs: { [DEBUG_CATEGORY_ARG]: 'all' },
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.10.4'],
  },
  {
    path: ['undebug', 'all'],
    mode: 'priv-exec',
    privilege: 15,
    help: 'Turn off every diagnostic trace',
    handler: H.execUndebugAll,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.10.4'],
  },
  {
    path: ['do', '<command>'],
    mode: '@config',
    privilege: 15,
    help: 'Run a privileged command from configuration mode',
    args: { command: restArg('The privileged command to run') },
    handler: H.execDo,
    grammars: NFOS_ONLY,
    objectives: ['CCNA1.2.2'],
  },
]);
