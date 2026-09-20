/**
 * cli/parser.ts — tokenizer and `matchCommand`: abbreviations, ambiguity,
 * incomplete lines, invalid-arg columns, `no`/`do` prefixes, output filters,
 * device-kind and mode filtering (spec §7.2, §7.3).
 */
import { describe, expect, it } from 'vitest';
import type { CliMode, PrivilegeLevel } from '../src/contracts/cli.js';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar.js';
import { MSG_INCOMPLETE, MSG_UNRECOGNIZED, matchCommand, tokenize, type MatchContext } from '../src/cli/parser.js';
import { cliProfile, DEFAULT_IFACE, modelPortView, type P0CliKind } from './cli.parser.fixture.js';

const PORTS: Record<string, string> = {
  'g0/0': 'GigabitEthernet0/0',
  'gi0/0': 'GigabitEthernet0/0',
  'gigabitethernet0/0': 'GigabitEthernet0/0',
  'g0/1': 'GigabitEthernet0/1',
  'gigabitethernet0/1': 'GigabitEthernet0/1',
  'fa0/1': 'FastEthernet0/1',
  'fastethernet0/1': 'FastEthernet0/1',
};

/** Session context of a P0 device: grammar and capabilities derived from its model; config-if selects its first data port. */
function ctx(mode: CliMode, kind: P0CliKind = 'router', privilege: PrivilegeLevel = mode === 'user-exec' && kind !== 'pc' ? 1 : 15): MatchContext {
  const c: MatchContext = {
    mode,
    privilege,
    ...cliProfile(kind),
    resolveInterface: (name) => PORTS[name.toLowerCase()],
    listInterfaces: () => ['GigabitEthernet0/0', 'GigabitEthernet0/1'],
  };
  if (mode === 'config-if') c.iface = modelPortView(kind, DEFAULT_IFACE[kind]);
  return c;
}

const priv = ctx('priv-exec');
const user = ctx('user-exec');
const conf = ctx('config');
const confIf = ctx('config-if');
const pc = ctx('user-exec', 'pc', 15);
const sw = ctx('priv-exec', 'switch');

function ok(line: string, c: MatchContext = priv) {
  const r = matchCommand(GRAMMAR, c, line);
  if (!r.ok) throw new Error(`expected "${line}" to match, got ${r.kind}: ${r.error.message}`);
  return r;
}

function fail(line: string, c: MatchContext = priv) {
  const r = matchCommand(GRAMMAR, c, line);
  if (r.ok) throw new Error(`expected "${line}" to fail, matched ${r.spec.handler}`);
  return r;
}

describe('tokenize', () => {
  it('splits on whitespace and keeps 0-based columns', () => {
    expect(tokenize('  show   ip int  ')).toEqual([
      { text: 'show', column: 2 },
      { text: 'ip', column: 9 },
      { text: 'int', column: 12 },
    ]);
  });

  it('always emits the pipe as its own token', () => {
    expect(tokenize('show run|sec int').map((t) => t.text)).toEqual(['show', 'run', '|', 'sec', 'int']);
    expect(tokenize('show run | inc ip').map((t) => t.column)).toEqual([0, 5, 9, 11, 15]);
  });

  it('returns nothing for an empty or blank line', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' \t ')).toEqual([]);
  });
});

describe('abbreviations', () => {
  it('matches keywords by unambiguous prefix', () => {
    expect(ok('conf t').spec.handler).toBe(HANDLERS.execConfigure);
    expect(ok('sh ip int br').spec.handler).toBe(HANDLERS.showIpIntBrief);
    expect(ok('sh run').spec.handler).toBe(HANDLERS.showRunning);
    expect(ok('sh ver').spec.handler).toBe(HANDLERS.showVersion);
    expect(ok('en', user).spec.handler).toBe(HANDLERS.execEnable);
    expect(ok('int g0/0', conf)).toMatchObject({ spec: { handler: HANDLERS.configInterface }, args: { iface: 'GigabitEthernet0/0' } });
  });

  it('is case-insensitive for keywords', () => {
    expect(ok('SHOW Version').spec.handler).toBe(HANDLERS.showVersion);
  });

  it('prefers an exact keyword over longer keywords it prefixes', () => {
    expect(ok('write').spec.path).toEqual(['write']);
    expect(ok('write mem').spec.path).toEqual(['write', 'memory']);
    expect(ok('wr').spec.path).toEqual(['write']);
  });

  it('reports the matched spec with entersMode for mode changes', () => {
    expect(ok('configure terminal').spec.entersMode).toBe('config');
    expect(ok('end', conf).spec.entersMode).toBe('priv-exec');
    expect(ok('disable').spec.entersMode).toBe('user-exec');
  });
});

describe('ambiguity', () => {
  it("'e' in priv-exec is ambiguous between enable, erase and exit", () => {
    const r = fail('e');
    expect(r.kind).toBe('ambiguous');
    expect(r.error.column).toBe(0);
    expect(r.error.message).toContain('"e"');
    expect(r.error.message).toContain('enable');
    expect(r.error.message).toContain('erase');
    expect(r.error.message).toContain('exit');
  });

  it("'show i' is ambiguous between ip and interfaces, with the column of the token", () => {
    const r = fail('show i');
    expect(r.kind).toBe('ambiguous');
    expect(r.error.column).toBe(5);
    expect(r.error.message).toMatch(/interfaces/);
    expect(r.error.message).toMatch(/\bip\b/);
  });

  it("'e' in config mode is ambiguous between enable, end and exit", () => {
    const r = fail('e', conf);
    expect(r.kind).toBe('ambiguous');
    expect(r.error.message).toContain('end');
    expect(r.error.message).toContain('enable');
  });

  it('does not use vendor wording', () => {
    const r = fail('e');
    expect(r.error.message).not.toMatch(/Ambiguous command:/);
  });
});

describe('incomplete', () => {
  it('reports a missing required token with no column', () => {
    for (const line of ['ping', 'conf', 'copy running-config', 'show ip', 'clear', 'debug ip', 'show']) {
      const r = fail(line);
      expect(r.kind, line).toBe('incomplete');
      expect(r.error.column, line).toBeUndefined();
      expect(r.error.message, line).toBe(MSG_INCOMPLETE);
    }
  });

  it('reports missing args in config modes', () => {
    expect(fail('interface', conf).kind).toBe('incomplete');
    expect(fail('ip route 10.0.0.0 255.0.0.0', conf).kind).toBe('incomplete');
    expect(fail('ip address 10.0.0.1', confIf).kind).toBe('incomplete');
    expect(fail('duplex', confIf).kind).toBe('incomplete');
  });

  it("a bare 'no' or 'do' is incomplete", () => {
    expect(fail('no', confIf).kind).toBe('incomplete');
    expect(fail('do', conf).kind).toBe('incomplete');
  });

  it('an empty line is incomplete', () => {
    expect(fail('').kind).toBe('incomplete');
  });

  it('a rest arg may not be empty', () => {
    expect(fail('banner motd', conf).kind).toBe('incomplete');
    expect(fail('description', confIf).kind).toBe('incomplete');
  });
});

describe('invalid args and extra tokens', () => {
  it('points at a malformed IPv4 address', () => {
    const r = fail('ping 10.0.0');
    expect(r.kind).toBe('invalid-arg');
    expect(r.error.column).toBe(5);
    expect(r.error.message).toMatch(/IPv4 address/);
    expect(fail('ping 300.1.1.1').kind).toBe('invalid-arg');
  });

  it('points at a non-contiguous mask', () => {
    const r = fail('ip address 10.0.0.1 255.255.0.255', confIf);
    expect(r.kind).toBe('invalid-arg');
    expect(r.error.column).toBe(20);
    expect(r.error.message).toMatch(/mask/);
  });

  it('points at an unknown interface', () => {
    const r = fail('interface Serial9/9', conf);
    expect(r.kind).toBe('invalid-arg');
    expect(r.error.column).toBe(10);
    expect(r.error.message).toMatch(/interface/i);
  });

  it('points at a bad choice and a bad MAC', () => {
    expect(fail('duplex quarter', confIf)).toMatchObject({ kind: 'invalid-arg', error: { column: 7 } });
    expect(fail('speed 1', confIf).kind).toBe('invalid-arg');
    expect(fail('mac-address 00:11', confIf)).toMatchObject({ kind: 'invalid-arg', error: { column: 12 } });
  });

  it('points at extra text after a complete command', () => {
    const r = fail('show version now');
    expect(r.kind).toBe('unrecognized');
    expect(r.error.column).toBe(13);
    expect(r.error.message).toBe(MSG_UNRECOGNIZED);
  });

  it('points at an unknown keyword in the middle of a line', () => {
    const r = fail('show ip foo');
    expect(r.kind).toBe('unrecognized');
    expect(r.error.column).toBe(8);
  });

  it('points at the first token of an unknown command', () => {
    const r = fail('frobnicate');
    expect(r.kind).toBe('unrecognized');
    expect(r.error.column).toBe(0);
  });
});

describe('arg validation and normalization', () => {
  it('normalizes MAC notations to canonical lowercase colon form', () => {
    expect(ok('mac-address 001A.2B3C.4D5E', confIf).args.mac).toBe('00:1a:2b:3c:4d:5e');
    expect(ok('mac-address 00-1A-2B-3C-4D-5E', confIf).args.mac).toBe('00:1a:2b:3c:4d:5e');
    expect(ok('mac-address 00:1a:2b:3c:4d:5e', confIf).args.mac).toBe('00:1a:2b:3c:4d:5e');
  });

  it('resolves interfaces to canonical ids and completes choices by prefix', () => {
    expect(ok('show interfaces fa0/1').args.iface).toBe('FastEthernet0/1');
    expect(ok('duplex fu', confIf).args.mode).toBe('full');
    expect(ok('speed 10', confIf).args.rate).toBe('10');
    expect(ok('speed 1000', confIf).args.rate).toBe('1000');
  });

  it('rest args keep the remainder of the line verbatim, including pipes', () => {
    expect(ok('banner motd  Authorized | staff only  ', conf).args.text).toBe('Authorized | staff only');
    expect(ok('description Uplink to core', confIf).args.text).toBe('Uplink to core');
  });

  it('optional args may be omitted', () => {
    const r = ok('show interfaces');
    expect(r.spec.handler).toBe(HANDLERS.showInterfaces);
    expect(r.args.iface).toBeUndefined();
  });

  it('merges fixedArgs (debug category) into args', () => {
    expect(ok('debug ip icmp').args).toEqual({ category: 'ip icmp' });
    expect(ok('debug ethernet switching', sw).args).toEqual({ category: 'ethernet switching' });
    expect(ok('debug arp').args).toEqual({ category: 'arp' });
    expect(ok('debug ip routing').args).toEqual({ category: 'ip routing' });
    expect(ok('debug ip packet').args).toEqual({ category: 'ip packet' });
  });

  it('ip route takes network, mask and next hop', () => {
    const r = ok('ip route 192.168.2.0 255.255.255.0 10.0.0.2', conf);
    expect(r.spec.handler).toBe(HANDLERS.configIpRoute);
    expect(r.args).toEqual({ network: '192.168.2.0', mask: '255.255.255.0', nexthop: '10.0.0.2' });
  });
});

describe("'no' handling", () => {
  it('negates commands that allow it and relaxes their args', () => {
    expect(ok('no shutdown', confIf)).toMatchObject({ negated: true, spec: { handler: HANDLERS.ifShutdown } });
    expect(ok('no ip address', confIf)).toMatchObject({ negated: true, spec: { handler: HANDLERS.ifIpAddress }, args: {} });
    expect(ok('no ip address 10.0.0.1 255.255.255.0', confIf).args).toEqual({ address: '10.0.0.1', mask: '255.255.255.0' });
    expect(ok('no ip route 10.0.0.0 255.0.0.0 10.1.1.1', conf).negated).toBe(true);
    expect(ok('no hostname', conf).negated).toBe(true);
    expect(ok('no debug all')).toMatchObject({ negated: true, args: { category: 'all' } });
    expect(ok('no description', confIf).negated).toBe(true);
  });

  it("'no' may itself be abbreviated", () => {
    expect(ok('n shut', confIf)).toMatchObject({ negated: true, spec: { handler: HANDLERS.ifShutdown } });
  });

  it('positive commands are not negated', () => {
    expect(ok('shutdown', confIf).negated).toBe(false);
  });

  it("rejects 'no' for commands without a no form", () => {
    const r = fail('no enable');
    expect(r.kind).toBe('unrecognized');
    expect(r.error.column).toBe(3);
    expect(r.error.message).toMatch(/no/);
    expect(fail('no ping 10.0.0.1').ok).toBe(false);
    expect(fail('no interface g0/0', conf).ok).toBe(false);
  });

  it("'no ip route' still requires the route args", () => {
    expect(fail('no ip route', conf).kind).toBe('incomplete');
  });
});

describe("'do' prefix", () => {
  it('runs privileged-exec commands from config modes', () => {
    const r = ok('do show ip int br', conf);
    expect(r.doPrefix).toBe(true);
    expect(r.spec.handler).toBe(HANDLERS.showIpIntBrief);
    const r2 = ok('do sh run | sec interface', confIf);
    expect(r2.doPrefix).toBe(true);
    expect(r2.filter).toEqual({ kind: 'section', pattern: 'interface' });
  });

  it("'do' combines with 'no' for exec commands", () => {
    expect(ok('do no debug all', conf)).toMatchObject({ doPrefix: true, negated: true });
  });

  it("'do' is not accepted in exec modes and config commands are not reachable through it", () => {
    expect(fail('do show version').kind).toBe('unrecognized');
    expect(fail('do hostname R2', conf).ok).toBe(false);
  });

  it("mode/privilege-changing exec commands are not reachable through 'do'", () => {
    for (const line of ['do exit', 'do logout', 'do disable', 'do enable', 'do end', 'do configure terminal']) {
      expect(fail(line, conf).kind).toBe('unrecognized');
      expect(fail(line, confIf).ok).toBe(false);
    }
    expect(ok('do show running-config', conf).spec.handler).toBe(HANDLERS.showRunning);
    expect(ok('exit', conf).spec.handler).toBe(HANDLERS.execExit);
  });

  it('normal matches carry no doPrefix flag', () => {
    expect(ok('hostname R2', conf).doPrefix).toBeUndefined();
  });
});

describe('output filters', () => {
  it('parses | section|include|exclude|begin <pattern> on filterable commands', () => {
    expect(ok('show running-config | section interface').filter).toEqual({ kind: 'section', pattern: 'interface' });
    expect(ok('sh run | inc ip address').filter).toEqual({ kind: 'include', pattern: 'ip address' });
    expect(ok('sh run | ex !').filter).toEqual({ kind: 'exclude', pattern: '!' });
    expect(ok('sh start | b interface').filter).toEqual({ kind: 'begin', pattern: 'interface' });
    expect(ok('sh run|sec int').filter).toEqual({ kind: 'section', pattern: 'int' });
  });

  it('works when optional args are skipped', () => {
    expect(ok('show interfaces | include packets').filter).toEqual({ kind: 'include', pattern: 'packets' });
    expect(ok('show interfaces g0/0 | include packets')).toMatchObject({ args: { iface: 'GigabitEthernet0/0' }, filter: { kind: 'include' } });
  });

  it('rejects a filter on non-filterable commands and incomplete filters', () => {
    const r = fail('ping 10.0.0.1 | include x');
    expect(r.kind).toBe('unrecognized');
    expect(r.error.column).toBe(14);
    expect(fail('show run |').kind).toBe('incomplete');
    expect(fail('show run | section').kind).toBe('incomplete');
    const bad = fail('show run | grep x');
    expect(bad.kind).toBe('invalid-arg');
    expect(bad.error.column).toBe(11);
  });

  it('has no filter when none was typed', () => {
    expect(ok('show running-config').filter).toBeUndefined();
  });
});

describe('device kinds', () => {
  it('a PC cannot enable, configure or logout', () => {
    for (const line of ['enable', 'configure terminal', 'logout', 'traceroute 10.0.0.1']) {
      const r = fail(line, pc);
      expect(r.kind, line).toBe('unrecognized');
      expect(r.error.column, line).toBe(0);
    }
    // `show` exists on a PC, so the caret lands on the unknown sub-keyword.
    for (const [line, col] of [['show startup-config', 5], ['show ip arp', 8], ['show mac address-table', 5]] as const) {
      const r = fail(line, pc);
      expect(r.kind, line).toBe('unrecognized');
      expect(r.error.column, line).toBe(col);
    }
  });

  it('the PC host shell accepts its reduced grammar at user-exec', () => {
    expect(ok('ip address 10.0.0.1 255.255.255.0', pc)).toMatchObject({
      spec: { handler: HANDLERS.pcIpAddress },
      args: { address: '10.0.0.1', mask: '255.255.255.0' },
    });
    expect(ok('ip address 10.0.0.1 255.255.255.0 10.0.0.254', pc).args.gateway).toBe('10.0.0.254');
    expect(ok('no ip address', pc)).toMatchObject({ negated: true, args: {} });
    expect(ok('ipconfig', pc).spec.handler).toBe(HANDLERS.pcIpconfig);
    expect(ok('arp -a', pc).spec.handler).toBe(HANDLERS.pcArp);
    expect(ok('ping 10.0.0.2', pc).spec.handler).toBe(HANDLERS.execPing);
    expect(ok('exit', pc).spec.handler).toBe(HANDLERS.execExit);
    for (const [line, handler] of [
      ['show arp', HANDLERS.showArp],
      ['show ip interface brief', HANDLERS.showIpIntBrief],
      ['show interfaces', HANDLERS.showInterfaces],
      ['show running-config', HANDLERS.showRunning],
      ['show version', HANDLERS.showVersion],
      ['show history', HANDLERS.showHistory],
    ] as const) {
      expect(ok(line, pc).spec.handler, line).toBe(handler);
    }
  });

  it('PC-only commands do not exist on routers', () => {
    expect(fail('ipconfig', user).kind).toBe('unrecognized');
    expect(fail('arp -a', priv).kind).toBe('unrecognized');
    expect(fail('ip address 10.0.0.1 255.255.255.0', user).kind).toBe('unrecognized');
  });

  it('switch-only and router-only commands', () => {
    expect(ok('show mac address-table', sw).spec.handler).toBe(HANDLERS.showMac);
    expect(ok('clear mac address-table dynamic', sw).spec.handler).toBe(HANDLERS.execClearMac);
    expect(fail('show mac address-table', priv).kind).toBe('unrecognized');
    expect(fail('show ip route', sw).kind).toBe('unrecognized');
    expect(ok('show ip route').spec.handler).toBe(HANDLERS.showIpRoute);
    expect(fail('ip route 10.0.0.0 255.0.0.0 10.1.1.1', ctx('config', 'switch')).kind).toBe('unrecognized');
    // §9.2 (P1): `ip address` no longer requires the routing capability, so a switched port answers with the
    // portRequires mismatch that names the way out instead of hiding the command.
    const switched = fail('ip address 10.0.0.1 255.255.255.0', ctx('config-if', 'switch'));
    expect(switched.kind).toBe('port-unsupported');
    expect(switched.error.message).toBe(CLI_MESSAGES.switchedPort);
    expect(ok('shutdown', ctx('config-if', 'switch')).spec.handler).toBe(HANDLERS.ifShutdown);
  });
});

describe('modes and privilege', () => {
  it('config-if commands are invisible in exec modes', () => {
    for (const line of ['shutdown', 'ip address 10.0.0.1 255.255.255.0', 'description x', 'duplex full']) {
      expect(fail(line, priv).kind, line).toBe('unrecognized');
      expect(fail(line, user).kind, line).toBe('unrecognized');
    }
  });

  it('privileged commands are invisible at privilege 1', () => {
    for (const line of ['configure terminal', 'reload', 'debug arp', 'write', 'clear arp-cache', 'copy running-config startup-config']) {
      expect(fail(line, user).kind, line).toBe('unrecognized');
    }
    expect(ok('show version', user).spec.privilege).toBe(1);
    expect(ok('exit', user).spec.handler).toBe(HANDLERS.execExit);
    expect(ok('logout', user).spec.handler).toBe(HANDLERS.execLogout);
  });

  it('exec commands are not available in config modes without do', () => {
    expect(fail('show version', conf).kind).toBe('unrecognized');
    expect(fail('ping 10.0.0.1', confIf).kind).toBe('unrecognized');
  });

  it('config commands are only in their mode', () => {
    expect(fail('hostname R1', confIf).kind).toBe('unrecognized');
    expect(fail('interface g0/0', confIf).kind).toBe('unrecognized');
    expect(ok('exit', confIf).spec.handler).toBe(HANDLERS.execExit);
    expect(ok('end', confIf).spec.handler).toBe(HANDLERS.execEnd);
  });
});
