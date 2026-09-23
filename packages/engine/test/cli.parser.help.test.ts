/**
 * cli/parser.ts — `?` help and tab completion: candidate lists, placeholders,
 * interface listing, the `<cr>` flag, `insert`, and errors for unparseable
 * partial lines (spec §7.2).
 */
import { describe, expect, it } from 'vitest';
import type { CliCompletion, CliMode, PrivilegeLevel } from '../src/contracts/cli.js';
import { GRAMMAR } from '../src/cli/grammar.js';
import { complete, help, type MatchContext } from '../src/cli/parser.js';
import { cliProfile, DEFAULT_IFACE, modelPortView, type P0CliKind } from './cli.parser.fixture.js';

const PORT_NAMES = ['GigabitEthernet0/0', 'GigabitEthernet0/1'];

/** Session context of a P0 device: grammar and capabilities derived from its model; config-if selects its first data port. */
function ctx(mode: CliMode, kind: P0CliKind = 'router', privilege: PrivilegeLevel = mode === 'user-exec' && kind !== 'pc' ? 1 : 15, withList = true): MatchContext {
  const c: MatchContext = {
    mode,
    privilege,
    ...cliProfile(kind),
    resolveInterface: (name) => {
      const n = name.toLowerCase().replace(/^gi(?:gabitethernet)?/, 'gigabitethernet');
      return PORT_NAMES.find((p) => p.toLowerCase() === n);
    },
  };
  if (withList) c.listInterfaces = () => PORT_NAMES.slice();
  if (mode === 'config-if') c.iface = modelPortView(kind, DEFAULT_IFACE[kind]);
  return c;
}

const priv = ctx('priv-exec');
const user = ctx('user-exec');
const conf = ctx('config');
const confIf = ctx('config-if');
const pc = ctx('user-exec', 'pc', 15);
const sw = ctx('priv-exec', 'switch');

const tokens = (c: CliCompletion): string[] => c.items.map((i) => i.token);
const literals = (c: CliCompletion): string[] => c.items.filter((i) => !i.isArg).map((i) => i.token);

describe('help lists', () => {
  it("'' at user-exec lists the user commands sorted, with help text", () => {
    const h = help(GRAMMAR, user, '');
    expect(tokens(h)).toEqual(['enable', 'exit', 'logout', 'nslookup', 'ping', 'show', 'traceroute']);
    expect(h.cr).toBeUndefined();
    expect(h.error).toBeUndefined();
    for (const i of h.items) expect(i.help.length, i.token).toBeGreaterThan(0);
    expect(h.items.find((i) => i.token === 'enable')?.help).toBe('Enter privileged mode');
    expect(h.items.find((i) => i.token === 'show')?.help).toBe('Display device information');
  });

  it("'' at priv-exec includes the privileged commands", () => {
    const t = tokens(help(GRAMMAR, priv, ''));
    expect(t).toEqual([...t].sort());
    for (const w of ['configure', 'copy', 'clear', 'debug', 'disable', 'erase', 'no', 'reload', 'undebug', 'write']) expect(t, w).toContain(w);
    expect(t).not.toContain('do');
    expect(t).not.toContain('hostname');
  });

  it("'' in config mode offers do and no plus the config commands", () => {
    // ARCHITECTURE-P2 §9.2 W4 items 12 and 18 (the P2 fragments folded into GRAMMAR): a router's config mode gains
    // `access-list`, its routed Ethernet port `encapsulation` and `standby`
    const t = tokens(help(GRAMMAR, conf, ''));
    expect(t).toEqual(['access-list', 'banner', 'do', 'enable', 'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'no', 'service', 'username']);
    const tIf = tokens(help(GRAMMAR, confIf, ''));
    expect(tIf).toEqual(['description', 'do', 'duplex', 'encapsulation', 'end', 'exit', 'ip', 'ipv6', 'mac-address', 'no', 'shutdown', 'speed', 'standby']);
  });

  it("'sh' lists only show", () => {
    const h = help(GRAMMAR, priv, 'sh');
    expect(tokens(h)).toEqual(['show']);
    expect(h.cr).toBeUndefined();
  });

  it("'show ' lists the show subtree for the device kind", () => {
    // ARCHITECTURE-P2 §9.2 W4 item 18: a router's show subtree gains `access-lists` and `standby`
    expect(tokens(help(GRAMMAR, priv, 'show '))).toEqual(['access-lists', 'arp', 'history', 'hosts', 'interfaces', 'ip', 'ipv6', 'running-config', 'standby', 'startup-config', 'version']);
    expect(tokens(help(GRAMMAR, sw, 'show '))).toContain('mac');
    expect(tokens(help(GRAMMAR, pc, 'show '))).toEqual(['arp', 'history', 'hosts', 'interfaces', 'ip', 'running-config', 'version']);
  });

  it("'show ip ' lists interface, arp and (routers only) route", () => {
    const h = help(GRAMMAR, priv, 'show ip ');
    // ARCHITECTURE-P2 §9.2 W4 item 18: `show ip nat …` joins on a router
    expect(tokens(h)).toEqual(['arp', 'dhcp', 'interface', 'nat', 'route', 'sockets']);
    expect(h.cr).toBeUndefined();
    expect(h.items.find((i) => i.token === 'interface')?.help).toBe('Interface status and settings');
    expect(h.items.find((i) => i.token === 'route')?.help).toBe('The IPv4 routing table');
    expect(tokens(help(GRAMMAR, sw, 'show ip '))).toEqual(['arp', 'interface']);
    expect(tokens(help(GRAMMAR, pc, 'show ip '))).toEqual(['interface']);
  });

  it("'ping ' shows the address placeholder as a non-completable arg", () => {
    const h = help(GRAMMAR, priv, 'ping ');
    // P1: the IPv6 form of `ping` is a second spec and the name form (ARCHITECTURE-P1 §10.2 `ping www.lab.nf`) a
    // third, so all three placeholders are offered under the one keyword wherever the resolver runs.
    expect(h.items).toEqual([
      { token: 'A.B.C.D', help: 'IPv4 address of the host to reach', isArg: true },
      { token: 'NAME', help: 'Name of the host to reach', isArg: true },
      { token: 'X:X:X:X::X', help: 'IPv6 address of the host to reach', isArg: true },
    ]);
    expect(h.cr).toBeUndefined();
    // a device with no resolver (the L2 switch) keeps the address forms only
    expect(help(GRAMMAR, sw, 'ping ').items.map((i) => i.token)).toEqual(['A.B.C.D']);
  });

  it("'interface ' lists the device's ports when a lister is provided", () => {
    const h = help(GRAMMAR, conf, 'interface ');
    expect(tokens(h)).toEqual(PORT_NAMES);
    expect(h.items.every((i) => !i.isArg)).toBe(true);
    expect(h.cr).toBeUndefined();
    const noList = help(GRAMMAR, ctx('config', 'router', 15, false), 'interface ');
    expect(noList.items).toEqual([{ token: 'INTERFACE', help: 'Interface name, e.g. GigabitEthernet0/0 or g0/0', isArg: true }]);
  });

  it("'show interfaces ' lists ports, the filter pipe and <cr>", () => {
    const h = help(GRAMMAR, priv, 'show interfaces ');
    expect(tokens(h)).toEqual([...PORT_NAMES, '|']);
    expect(h.cr).toBe(true);
  });

  it('choice args list their choices', () => {
    expect(tokens(help(GRAMMAR, confIf, 'duplex '))).toEqual(['auto', 'full', 'half']);
    expect(tokens(help(GRAMMAR, confIf, 'speed 10'))).toEqual(['10', '100', '1000']);
  });

  it('rest args show LINE', () => {
    const h = help(GRAMMAR, conf, 'banner motd ');
    expect(h.items).toEqual([{ token: 'LINE', help: 'Banner text', isArg: true }]);
    expect(h.cr).toBeUndefined();
  });

  it("'debug ' and 'debug ip ' list the categories", () => {
    // ARCHITECTURE-P2 §9.2 W4 item 18: the routing row's hsrp and nat add `standby` and `ip nat` through the registry
    expect(tokens(help(GRAMMAR, priv, 'debug '))).toEqual(['all', 'arp', 'dhcp', 'dns', 'ethernet', 'ip', 'ipv6', 'standby', 'tcp', 'traceroute', 'udp']);
    expect(tokens(help(GRAMMAR, priv, 'debug ip '))).toEqual(['icmp', 'nat', 'packet', 'routing']);
    expect(tokens(help(GRAMMAR, priv, 'debug ip i'))).toEqual(['icmp']);
  });

  it('marks extensions as non-standard in help', () => {
    const h = help(GRAMMAR, confIf, 'mac');
    expect(h.items[0]?.help).toMatch(/non-standard/);
  });

  it("'no ' lists only commands with a no form; 'do ' lists priv-exec commands", () => {
    // ARCHITECTURE-P2 §9.2 W4 item 18: `encapsulation` and `standby` have a no form
    expect(tokens(help(GRAMMAR, confIf, 'no '))).toEqual(['description', 'duplex', 'encapsulation', 'ip', 'ipv6', 'mac-address', 'shutdown', 'speed', 'standby']);
    const d = tokens(help(GRAMMAR, conf, 'do '));
    expect(d).toContain('show');
    expect(d).toContain('reload');
    expect(d).not.toContain('do');
    expect(d).not.toContain('hostname');
  });

  it('filter help after the pipe', () => {
    expect(tokens(help(GRAMMAR, priv, 'show run | '))).toEqual(['begin', 'exclude', 'include', 'section']);
    expect(tokens(help(GRAMMAR, priv, 'show run | s'))).toEqual(['section']);
    const p = help(GRAMMAR, priv, 'show run | section ');
    expect(p.items).toEqual([{ token: 'LINE', help: 'Pattern to match', isArg: true }]);
    expect(p.cr).toBeUndefined();
  });
});

describe('cr flag', () => {
  it('is set when the line so far is executable', () => {
    expect(help(GRAMMAR, priv, 'show version ').cr).toBe(true);
    expect(help(GRAMMAR, priv, 'show ver').cr).toBe(true);
    expect(help(GRAMMAR, priv, 'show running-config ').cr).toBe(true);
    expect(help(GRAMMAR, confIf, 'no ip address ').cr).toBe(true);
    expect(help(GRAMMAR, pc, 'ip address 10.0.0.1 255.255.255.0 ').cr).toBe(true);
    expect(help(GRAMMAR, priv, 'show run | section interface ').cr).toBe(true);
  });

  it('is unset while tokens are still required', () => {
    expect(help(GRAMMAR, priv, 'show ').cr).toBeUndefined();
    expect(help(GRAMMAR, priv, 'ping ').cr).toBeUndefined();
    expect(help(GRAMMAR, priv, 'conf').cr).toBeUndefined();
    expect(help(GRAMMAR, confIf, 'ip address ').cr).toBeUndefined();
    expect(help(GRAMMAR, pc, 'ip address 10.0.0.1 ').cr).toBeUndefined();
    expect(help(GRAMMAR, confIf, 'no ').cr).toBeUndefined();
  });

  it("'show running-config ' offers the pipe and <cr>", () => {
    const h = help(GRAMMAR, priv, 'show running-config ');
    expect(tokens(h)).toEqual(['|']);
    expect(h.cr).toBe(true);
  });
});

describe('help errors', () => {
  it('reports an unrecognized completed token with its column', () => {
    const h = help(GRAMMAR, priv, 'show bogus ');
    expect(h.items).toEqual([]);
    expect(h.error).toEqual({ message: expect.stringContaining('Unrecognized'), column: 5 });
  });

  it('reports an ambiguous completed token', () => {
    const h = help(GRAMMAR, priv, 'e ');
    expect(h.items).toEqual([]);
    expect(h.error?.column).toBe(0);
    expect(h.error?.message).toMatch(/enable/);
  });

  it('reports a partial token that matches nothing', () => {
    const h = help(GRAMMAR, priv, 'show zz');
    expect(h.items).toEqual([]);
    expect(h.error?.column).toBe(5);
  });

  it('respects kinds and modes', () => {
    expect(help(GRAMMAR, pc, 'enable').error?.column).toBe(0);
    expect(help(GRAMMAR, priv, 'shutdown').error?.column).toBe(0);
    // §9.2: the P1 host shell list gains tracert, nslookup, netstat, ipv6config and the now-listed adapter.
    expect(tokens(help(GRAMMAR, pc, ''))).toEqual([
      'adapter', 'arp', 'exit', 'ip', 'ipconfig', 'ipv6', 'ipv6config', 'netstat', 'no', 'nslookup', 'ping', 'show', 'tracert',
    ]);
  });

  it('does not use vendor wording', () => {
    const h = help(GRAMMAR, priv, 'show bogus ');
    expect(h.error?.message).not.toMatch(/Invalid input detected/);
  });
});

describe('completion', () => {
  it('inserts the rest of a unique keyword plus a space', () => {
    expect(complete(GRAMMAR, priv, 'sh')).toMatchObject({ insert: 'ow ' });
    expect(complete(GRAMMAR, priv, 'show ru')).toMatchObject({ insert: 'nning-config ' });
    expect(complete(GRAMMAR, priv, 'conf')).toMatchObject({ insert: 'igure ' });
  });

  it('inserts the common prefix when several keywords match', () => {
    const c = complete(GRAMMAR, priv, 'show in');
    expect(literals(c)).toEqual(['interfaces']);
    expect(c.insert).toBe('terfaces ');
    const e = complete(GRAMMAR, priv, 'e');
    expect(literals(e)).toEqual(['enable', 'erase', 'exit']);
    expect(e.insert).toBeUndefined();
    const s = complete(GRAMMAR, priv, 'show run | s');
    expect(s.insert).toBe('ection ');
  });

  it('completes interface names keeping their casing', () => {
    const c = complete(GRAMMAR, conf, 'interface g');
    expect(literals(c)).toEqual(PORT_NAMES);
    expect(c.insert).toBe('igabitEthernet0/');
    const one = complete(GRAMMAR, conf, 'interface GigabitEthernet0/1');
    expect(one.insert).toBe(' ');
  });

  it('completes choices', () => {
    expect(complete(GRAMMAR, confIf, 'duplex f')).toMatchObject({ insert: 'ull ' });
  });

  it('offers nothing to insert for arg placeholders', () => {
    const c = complete(GRAMMAR, priv, 'ping ');
    expect(c.insert).toBeUndefined();
    expect(c.items[0]?.isArg).toBe(true);
  });

  it('returns errors like help does', () => {
    expect(complete(GRAMMAR, priv, 'show bogus ').error?.column).toBe(5);
    expect(complete(GRAMMAR, pc, 'enable').error?.column).toBe(0);
  });
});
