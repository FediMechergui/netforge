/**
 * cli/grammar — the command table assembled from its fragments: handler ids, coverage of the whole ARCHITECTURE
 * "P0 CLI surface", structural sanity of every spec, capability/grammar/port scoping of the P0 entries
 * (ARCHITECTURE-P1 §9.2: kinds arrays became grammars/requires/portRequires) and the original-wording rule
 * (spec §1.6, §7.2).
 */
import { describe, expect, it } from 'vitest';
import { BRIDGING_CAPABILITIES, HARDWARE_MESSAGES, L3_ROLES } from '../src/contracts/catalog.js';
import { CLI_MESSAGES, type CliMode, type PrivilegeLevel } from '../src/contracts/cli.js';
import {
  DEBUG_CATEGORIES,
  DEBUG_CATEGORY_DEFS,
  GRAMMAR,
  GRAMMAR_FRAGMENTS,
  HANDLERS,
  LITERAL_HELP,
  PSEUDO_HELP,
} from '../src/cli/grammar.js';
import { isArgToken, matchCommand, type MatchContext } from '../src/cli/parser.js';
import { specModeAllows } from '../src/cli/modes.js';
import { findBannedWords } from '../src/device/catalog/validate.js';
import { NFOS_NAME } from '../src/cli/handlers/show.js';
import * as msgConfigGlobal from '../src/cli/grammar/config-global.js';
import * as msgSerialGrammar from '../src/cli/grammar/serial.js';
import * as msgWirelessGrammar from '../src/cli/grammar/wireless.js';
import * as msgCommon from '../src/cli/handlers/common.js';
import * as msgConfig from '../src/cli/handlers/config.js';
import * as msgExec from '../src/cli/handlers/exec.js';
import * as msgHost from '../src/cli/handlers/host.js';
import * as msgSerial from '../src/cli/handlers/serial.js';
import * as msgShow from '../src/cli/handlers/show.js';
import * as msgWireless from '../src/cli/handlers/wireless.js';
import * as msgParser from '../src/cli/parser.js';
import * as msgRuntime from '../src/cli/runtime.js';
import { cliProfile, DEFAULT_IFACE, modelPortView, type P0CliKind } from './cli.parser.fixture.js';

const MSG_MODULES: readonly Record<string, unknown>[] = [
  msgConfigGlobal, msgSerialGrammar, msgWirelessGrammar, msgCommon, msgConfig, msgExec, msgHost, msgSerial, msgShow,
  msgWireless, msgParser, msgRuntime,
];

/** Every handler id: the P0 ids plus the P0.5 fragments (serial, switchport, wireless, modules, host shell, show). */
const EXPECTED_IDS = [
  'exec.enable', 'exec.disable', 'exec.exit', 'exec.logout', 'exec.end', 'exec.configure', 'exec.ping', 'exec.traceroute',
  'exec.copy-run-start', 'exec.write', 'exec.erase-startup', 'exec.reload', 'exec.clear-arp', 'exec.clear-mac', 'exec.debug',
  'exec.undebug-all', 'exec.do', 'show.ip-int-brief', 'show.interfaces', 'show.arp', 'show.ip-arp', 'show.mac', 'show.ip-route',
  'show.version', 'show.running', 'show.startup', 'show.history', 'config.hostname', 'config.interface', 'config.ip-route',
  'config.banner', 'config.enable-secret', 'if.ip-address', 'if.shutdown', 'if.description', 'if.duplex', 'if.speed',
  'if.mac-address', 'pc.ip-address', 'pc.ipconfig', 'pc.arp',
  // P0.5
  'show.interfaces-status', 'config.default-gateway', 'if.switchport', 'if.clock-rate', 'if.encapsulation', 'if.bandwidth',
  'if.keepalive', 'show.controllers', 'if.ssid', 'if.security', 'if.passphrase', 'if.band', 'if.channel', 'if.channel-width',
  'if.tx-power', 'if.peer-key', 'if.beacons', 'show.wireless', 'show.inventory', 'host.wifi-list', 'host.wifi-connect',
  'host.wifi-disconnect', 'host.adapter',
  // P1 W5 (ARCHITECTURE-P1 §8.2): the IPv6, DHCP, DNS, service, transport, line-auth and host shell fragments
  'if.ipv6-enable', 'if.ipv6-address', 'if.ipv6-autoconfig', 'if.ipv6-nd-suppress-ra', 'config.ipv6-unicast-routing',
  'config.ipv6-route', 'show.ipv6-int-brief', 'show.ipv6-interface', 'show.ipv6-route', 'show.ipv6-neighbors', 'exec.ping6',
  'if.ip-address-dhcp', 'if.ip-helper-address', 'config.ip-dhcp-excluded', 'config.ip-dhcp-pool', 'dhcp.network',
  'dhcp.default-router', 'dhcp.dns-server', 'dhcp.domain-name', 'dhcp.lease', 'show.ip-dhcp-binding', 'show.ip-dhcp-pool',
  'config.ip-name-server', 'config.ip-domain-name', 'config.ip-domain-lookup', 'config.ip-host', 'config.ip-dns-server',
  'config.ip-dns-record', 'show.hosts', 'exec.nslookup', 'exec.ping-name',
  'config.ip-http-server', 'config.ip-http-page', 'host.service', 'show.sockets',
  'config.enable-password', 'config.service-password-encryption', 'config.username', 'config.line', 'line.password',
  'line.login', 'line.exec-timeout',
  'host.ip-address-dhcp', 'host.ip-dns', 'host.ipv6-address', 'host.ipv6-autoconfig', 'host.ipv6config',
  // ARCHITECTURE-P2 §5.5 host-shell expansions: `ipv6 address dhcp [<adapter>]` and [S4] `voice vlan <v>`
  'host.ipv6-address-dhcp', 'host.voice-vlan',
];

/** Test label of a context (the device kind is no longer part of MatchContext: scope is grammar and capabilities). */
const KIND_OF = new WeakMap<MatchContext, P0CliKind>();

/** Session context of a P0 device: grammar and capabilities derived from its model; config-if selects its first data port. */
function ctx(mode: CliMode, kind: P0CliKind, privilege: PrivilegeLevel): MatchContext {
  const c: MatchContext = {
    mode,
    privilege,
    ...cliProfile(kind),
    resolveInterface: (n) => (n.toLowerCase() === 'g0/0' ? 'GigabitEthernet0/0' : undefined),
  };
  if (mode === 'config-if') c.iface = modelPortView(kind, DEFAULT_IFACE[kind]);
  KIND_OF.set(c, kind);
  return c;
}

describe('HANDLERS', () => {
  it('contains exactly the union of the fragment handler ids', () => {
    expect([...Object.values(HANDLERS)].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('every grammar entry uses a known handler id and every id is used', () => {
    const ids = new Set<string>(Object.values(HANDLERS));
    const used = new Set<string>();
    for (const s of GRAMMAR) {
      expect(ids.has(s.handler), s.path.join(' ')).toBe(true);
      used.add(s.handler);
    }
    for (const id of ids) expect(used.has(id), id).toBe(true);
  });

  it('GRAMMAR is the concatenation of the fragments in order', () => {
    expect(GRAMMAR).toEqual(Object.values(GRAMMAR_FRAGMENTS).flat());
    expect(Object.keys(GRAMMAR_FRAGMENTS)).toEqual([
      'core-exec', 'show', 'config-global', 'config-if', 'svi', 'switchport', 'serial', 'wireless', 'modules',
      'ipv6', 'dhcp', 'dns', 'services', 'transport', 'traceroute', 'line-auth', 'host-shell',
    ]);
  });
});

describe('spec structure', () => {
  it('every <arg> in a path has an ArgSpec with help, and every ArgSpec is referenced', () => {
    for (const s of GRAMMAR) {
      const named = new Set<string>();
      for (const el of s.path) {
        if (!isArgToken(el)) {
          expect(el, s.path.join(' ')).toMatch(/^[a-z0-9|-]+$/);
          continue;
        }
        const name = el.slice(1, -1);
        named.add(name);
        const a = s.args?.[name];
        expect(a, `${s.path.join(' ')} <${name}>`).toBeDefined();
        expect(a!.help.length).toBeGreaterThan(0);
        if (a!.type === 'choice') expect(a!.choices!.length).toBeGreaterThan(0);
      }
      for (const k of Object.keys(s.args ?? {})) expect(named.has(k), `${s.path.join(' ')} unused arg ${k}`).toBe(true);
      expect(s.help.length, s.path.join(' ')).toBeGreaterThan(0);
      expect(s.objectives?.length ?? 0, s.path.join(' ')).toBeGreaterThan(0);
      expect(s.path.length).toBeGreaterThan(0);
      expect(isArgToken(s.path[0]!), s.path.join(' ')).toBe(false);
    }
  });

  it('host-shell commands are user-exec at privilege 15; other user-exec commands privilege 1; the rest privilege 15', () => {
    for (const s of GRAMMAR) {
      const hostOnly = s.grammars !== undefined && s.grammars.length === 1 && s.grammars[0] === 'host';
      if (hostOnly) {
        expect(s.privilege, s.path.join(' ')).toBe(15);
        expect(s.mode, s.path.join(' ')).toBe('user-exec');
      } else if (specModeAllows(s.mode, 'user-exec')) {
        expect(s.privilege, s.path.join(' ')).toBe(1);
      } else {
        expect(s.privilege, s.path.join(' ')).toBe(15);
      }
    }
  });

  it('debug categories come from the registry: the P0 five first, each with a literal path, fixedArgs and allowNo', () => {
    expect(DEBUG_CATEGORIES).toEqual(DEBUG_CATEGORY_DEFS.map((d) => d.category));
    expect(DEBUG_CATEGORIES.slice(0, 5)).toEqual(['arp', 'ip icmp', 'ip packet', 'ip routing', 'ethernet switching']);
    for (const cat of ['wireless', 'serial', 'segment']) expect(DEBUG_CATEGORIES, cat).toContain(cat);
    for (const cat of ['ipv6 nd', 'dhcp', 'dns', 'udp', 'tcp', 'traceroute']) expect(DEBUG_CATEGORIES, cat).toContain(cat);
    for (const def of DEBUG_CATEGORY_DEFS) {
      const s = GRAMMAR.find((g) => g.handler === HANDLERS.execDebug && g.fixedArgs?.category === def.category);
      expect(s, def.category).toBeDefined();
      expect(s!.path).toEqual(['debug', ...def.category.split(' ')]);
      expect(s!.allowNo).toBe(true);
      expect(s!.requiresAny).toEqual(def.requiresAny);
    }
  });

  it('show commands are filterable', () => {
    for (const s of GRAMMAR.filter((g) => g.path[0] === 'show')) expect(s.filterable, s.path.join(' ')).toBe(true);
  });

  it('no spec is scoped by device kind any more', () => {
    for (const s of GRAMMAR) expect('kinds' in s, s.path.join(' ')).toBe(false);
  });

  it('scoping is grammar, capability and port-role data as the brief requires', () => {
    const find = (h: string) => GRAMMAR.filter((g) => g.handler === h);
    expect(find(HANDLERS.showMac)[0]!.requiresAny).toEqual(BRIDGING_CAPABILITIES);
    expect(find(HANDLERS.execClearMac)[0]!.requiresAny).toEqual(BRIDGING_CAPABILITIES);
    expect(find(HANDLERS.showIpRoute)[0]!.requiresAny).toEqual(['routing']);
    expect(find(HANDLERS.configIpRoute)[0]!.requiresAny).toEqual(['routing']);
    // §9.2 (P1): `ip address` dropped `requiresAny: ['routing']`; the port role decides now, so a Vlan interface
    // on an L2 switch takes an address and a switched port is told to leave switching first.
    const ip = find(HANDLERS.ifIpAddress)[0]!;
    expect(ip.requiresAny).toBeUndefined();
    expect(ip.portRequires).toEqual({ roles: L3_ROLES, mismatch: CLI_MESSAGES.switchedPort });
    for (const h of [HANDLERS.ifIpv6Address, HANDLERS.ifIpAddressDhcp]) {
      expect(find(h)[0]!.portRequires, h).toEqual({ roles: L3_ROLES, mismatch: CLI_MESSAGES.switchedPort });
    }
    expect(find(HANDLERS.showSockets).map((s) => s.grammars)).toEqual([['host'], ['nfos']]);
    for (const h of [HANDLERS.pcIpAddress, HANDLERS.pcIpconfig, HANDLERS.pcArp]) expect(find(h)[0]!.grammars).toEqual(['host']);
    for (const h of [HANDLERS.execEnable, HANDLERS.execConfigure, HANDLERS.execLogout]) expect(find(h)[0]!.grammars).toEqual(['nfos']);
    for (const h of [HANDLERS.execExit, HANDLERS.execLogout, HANDLERS.execEnable, HANDLERS.execDisable]) {
      expect(find(h)[0]!.sessionEffect, h).toBeDefined();
    }
  });
});

describe('original wording', () => {
  const clean = (t: string, where: string) => expect(findBannedWords(t), where).toEqual([]);
  /** Every string leaf of a (possibly nested) message table; functions are skipped. */
  const leaves = (v: unknown, path: string, out: [string, string][]): [string, string][] => {
    if (typeof v === 'string') out.push([path, v]);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
    return out;
  };
  /** Exported MSG_* handler/grammar constants. */
  const msgConstants = (): [string, string][] =>
    MSG_MODULES.flatMap((m) =>
      Object.entries(m).filter(([k, v]) => k.startsWith('MSG_') && typeof v === 'string') as [string, string][],
    );

  it('keeps the shared banned list covering OS and analyser names', () => {
    expect(findBannedWords('junos')).toEqual(['junos']);
    for (const w of ['cisco', 'ios', 'nx-os', 'windows', 'macos', 'linux', 'android', 'wireshark', 'tcpdump']) {
      expect(findBannedWords(`the ${w} thing`), w).toEqual([w]);
    }
  });

  it('never mentions a vendor, OS or analyser product in help, messages or show headers', () => {
    const texts: [string, string][] = [];
    for (const s of GRAMMAR) {
      texts.push([s.path.join(' '), s.help]);
      for (const [k, a] of Object.entries(s.args ?? {})) texts.push([`${s.path.join(' ')} <${k}>`, a.help]);
    }
    for (const [k, h] of Object.entries(LITERAL_HELP)) texts.push([`LITERAL_HELP.${k}`, h]);
    for (const [k, h] of Object.entries(PSEUDO_HELP)) texts.push([`PSEUDO_HELP.${k}`, h]);
    for (const d of DEBUG_CATEGORY_DEFS) texts.push([`debug ${d.help}`, d.help]);
    texts.push(['NFOS_NAME', NFOS_NAME]);
    leaves(CLI_MESSAGES, 'CLI_MESSAGES', texts);
    leaves(HARDWARE_MESSAGES, 'HARDWARE_MESSAGES', texts);
    const msgs = msgConstants();
    expect(msgs.length).toBeGreaterThan(10);
    texts.push(...msgs);
    expect(texts.length).toBeGreaterThan(150);
    for (const [where, t] of texts) clean(t, where);
  });
});

describe('P0 CLI surface', () => {
  const R = (mode: CliMode, p: PrivilegeLevel = 15) => ctx(mode, 'router', p);
  const S = (mode: CliMode, p: PrivilegeLevel = 15) => ctx(mode, 'switch', p);
  const PC = ctx('user-exec', 'pc', 15);

  const table: [MatchContext, string, string][] = [
    [R('user-exec', 1), 'enable', HANDLERS.execEnable],
    [R('user-exec', 1), 'exit', HANDLERS.execExit],
    [R('user-exec', 1), 'logout', HANDLERS.execLogout],
    [R('user-exec', 1), 'ping 10.0.0.2', HANDLERS.execPing],
    [R('user-exec', 1), 'traceroute 10.0.0.2', HANDLERS.execTraceroute],
    [R('user-exec', 1), 'show ip interface brief', HANDLERS.showIpIntBrief],
    [R('user-exec', 1), 'show interfaces', HANDLERS.showInterfaces],
    [R('user-exec', 1), 'show interfaces g0/0', HANDLERS.showInterfaces],
    [R('user-exec', 1), 'show arp', HANDLERS.showArp],
    [R('user-exec', 1), 'show ip arp', HANDLERS.showIpArp],
    [S('user-exec', 1), 'show mac address-table', HANDLERS.showMac],
    [R('user-exec', 1), 'show ip route', HANDLERS.showIpRoute],
    [R('user-exec', 1), 'show version', HANDLERS.showVersion],
    [R('user-exec', 1), 'show running-config', HANDLERS.showRunning],
    [R('user-exec', 1), 'show startup-config', HANDLERS.showStartup],
    [R('user-exec', 1), 'show history', HANDLERS.showHistory],
    [R('priv-exec'), 'disable', HANDLERS.execDisable],
    [R('priv-exec'), 'configure terminal', HANDLERS.execConfigure],
    [R('priv-exec'), 'copy running-config startup-config', HANDLERS.execCopyRunStart],
    [R('priv-exec'), 'write', HANDLERS.execWrite],
    [R('priv-exec'), 'write memory', HANDLERS.execWrite],
    [R('priv-exec'), 'erase startup-config', HANDLERS.execEraseStartup],
    [R('priv-exec'), 'reload', HANDLERS.execReload],
    [R('priv-exec'), 'clear arp-cache', HANDLERS.execClearArp],
    [S('priv-exec'), 'clear mac address-table dynamic', HANDLERS.execClearMac],
    [R('priv-exec'), 'debug arp', HANDLERS.execDebug],
    [R('priv-exec'), 'debug ip icmp', HANDLERS.execDebug],
    [R('priv-exec'), 'debug ip packet', HANDLERS.execDebug],
    [R('priv-exec'), 'debug ip routing', HANDLERS.execDebug],
    [S('priv-exec'), 'debug ethernet switching', HANDLERS.execDebug],
    [R('priv-exec'), 'undebug all', HANDLERS.execUndebugAll],
    [R('priv-exec'), 'no debug all', HANDLERS.execDebug],
    [R('priv-exec'), 'show running-config | section interface', HANDLERS.showRunning],
    [R('priv-exec'), 'show running-config | include ip', HANDLERS.showRunning],
    [R('priv-exec'), 'show running-config | exclude ip', HANDLERS.showRunning],
    [R('priv-exec'), 'show running-config | begin interface', HANDLERS.showRunning],
    [R('config'), 'hostname R1', HANDLERS.configHostname],
    [R('config'), 'interface g0/0', HANDLERS.configInterface],
    [R('config'), 'ip route 0.0.0.0 0.0.0.0 10.0.0.1', HANDLERS.configIpRoute],
    [R('config'), 'ip route 10.1.0.0 255.255.0.0 GigabitEthernet0/1', HANDLERS.configIpRoute],
    [R('config'), 'no ip route 0.0.0.0 0.0.0.0 10.0.0.1', HANDLERS.configIpRoute],
    [R('config'), 'banner motd Welcome to the lab', HANDLERS.configBanner],
    [R('config'), 'enable secret hunter2', HANDLERS.configEnableSecret],
    [R('config'), 'end', HANDLERS.execEnd],
    [R('config'), 'exit', HANDLERS.execExit],
    [R('config'), 'do show ip route', HANDLERS.showIpRoute],
    [R('config-if'), 'ip address 10.0.0.1 255.255.255.0', HANDLERS.ifIpAddress],
    [R('config-if'), 'no ip address', HANDLERS.ifIpAddress],
    [R('config-if'), 'shutdown', HANDLERS.ifShutdown],
    [R('config-if'), 'no shutdown', HANDLERS.ifShutdown],
    [R('config-if'), 'description WAN uplink', HANDLERS.ifDescription],
    [R('config-if'), 'duplex auto', HANDLERS.ifDuplex],
    [R('config-if'), 'duplex full', HANDLERS.ifDuplex],
    [R('config-if'), 'duplex half', HANDLERS.ifDuplex],
    [R('config-if'), 'speed auto', HANDLERS.ifSpeed],
    [R('config-if'), 'speed 10', HANDLERS.ifSpeed],
    [R('config-if'), 'speed 100', HANDLERS.ifSpeed],
    [R('config-if'), 'speed 1000', HANDLERS.ifSpeed],
    [R('config-if'), 'mac-address 0000.1111.2222', HANDLERS.ifMacAddress],
    [R('config-if'), 'end', HANDLERS.execEnd],
    [R('config-if'), 'exit', HANDLERS.execExit],
    [PC, 'ip address 10.0.0.1 255.255.255.0', HANDLERS.pcIpAddress],
    [PC, 'ip address 10.0.0.1 255.255.255.0 10.0.0.254', HANDLERS.pcIpAddress],
    [PC, 'no ip address', HANDLERS.pcIpAddress],
    [PC, 'ipconfig', HANDLERS.pcIpconfig],
    [PC, 'ping 10.0.0.2', HANDLERS.execPing],
    [PC, 'arp -a', HANDLERS.pcArp],
    [PC, 'show arp', HANDLERS.showArp],
    [PC, 'show ip interface brief', HANDLERS.showIpIntBrief],
    [PC, 'show interfaces', HANDLERS.showInterfaces],
    [PC, 'show running-config', HANDLERS.showRunning],
    [PC, 'show version', HANDLERS.showVersion],
    [PC, 'show history', HANDLERS.showHistory],
    [PC, 'exit', HANDLERS.execExit],
  ];

  it.each(table.map(([c, line, h]) => [line, KIND_OF.get(c), c.mode, c, h]))('%s (%s %s)', (_line, _kind, _mode, c, h) => {
    const r = matchCommand(GRAMMAR, c as MatchContext, _line as string);
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (r.ok) expect(r.spec.handler).toBe(h);
  });
});
