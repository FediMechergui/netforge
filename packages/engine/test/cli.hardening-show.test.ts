/**
 * cli/handlers/hardening.ts, the W3 shows (ARCHITECTURE-P3 §5.8, D13; §7 W3 cli part 2; rule 20): `show ip dhcp
 * snooping` (state, VLANs, address check, binding count, trusted and rate-limited ports) and `… binding` (the §5.8
 * shape exactly: the lease left from `expiresAt`, `infinite` for a static binding, the count line); `show ip arp
 * inspection [vlan <list> | interfaces | statistics]` (the §5.8 shape exactly; the trusted ports that carry each VLAN;
 * the effective limits). Against fake `dhcp-snooping` / `arp-inspection` rows and the configuration the eth-switch
 * readers read; one parse case per new path; never offered on a router (D13).
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import type { ArpInspectionRow, DhcpSnoopingRow, Table, TableRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createTable } from '../src/core/table.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HARDENING_SHOW_ARG } from '../src/cli/grammar/hardening.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_DAI_NO_VLAN, MSG_DAI_NONE } from '../src/cli/handlers/hardening.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';

const SWITCH = catalogModel('switch.nfc2960');
const ROUTER = catalogModel('router.nf2911');
const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA3 = 'FastEthernet0/3';
const GI1 = 'GigabitEthernet0/1';
const NOW = 1000 * SEC;

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, false);
}

function attach<R extends TableRow>(rec: RecordingCtx, name: string): Table<R> {
  const t = createTable<R>({ name, device: 'd_1', sink: { emit: () => undefined }, now: () => 0 });
  rec.extra.set(name as never, t as unknown as Table<TableRow>);
  return t;
}

const lines = (o: CommandOutcome): string[] => (o.output ?? '').split('\n');

const LEARNED: DhcpSnoopingRow = {
  key: '10|00:50:79:66:68:00', mac: '00:50:79:66:68:00', ip: '192.168.10.11', vlan: 10, port: FA1, kind: 'learned', leaseS: 86400,
  expiresAt: NOW + 86385 * SEC, updatedAt: NOW - 15 * SEC,
};
const STATIC: DhcpSnoopingRow = { key: '10|00:50:79:66:68:01', mac: '00:50:79:66:68:01', ip: '192.168.10.12', vlan: 10, port: FA2, kind: 'static', updatedAt: 0 };

/** SW1: snooping on VLANs 10 and 20, DAI on VLAN 10, the uplink Gi0/1 a trusted trunk, Fa0/1 an access port in VLAN 10. */
function sw1(): RecordingCtx {
  const r = commandCtxFor(SWITCH, { mode: 'priv-exec', hostname: 'SW1' });
  (r.ctx as { now: number }).now = NOW;
  r.running.set([], ['ip', 'dhcp', 'snooping']);
  r.running.set([], ['ip', 'dhcp', 'snooping', 'vlan', '10']);
  r.running.set([], ['ip', 'dhcp', 'snooping', 'vlan', '20']);
  r.running.set([], ['ip', 'arp', 'inspection', 'vlan', '10']);
  r.running.set([['interface', GI1]], ['switchport', 'mode', 'trunk']);
  r.running.set([['interface', GI1]], ['ip', 'dhcp', 'snooping', 'trust']);
  r.running.set([['interface', GI1]], ['ip', 'arp', 'inspection', 'trust']);
  r.running.set([['interface', FA1]], ['switchport', 'mode', 'access']);
  r.running.set([['interface', FA1]], ['switchport', 'access', 'vlan', '10']);
  r.running.set([['interface', FA1]], ['ip', 'dhcp', 'snooping', 'limit', 'rate', '10']);
  r.running.set([['interface', FA2]], ['ip', 'arp', 'inspection', 'limit', 'rate', '30', 'burst', 'interval', '2']);
  r.running.set([['interface', FA3]], ['ip', 'arp', 'inspection', 'limit', 'none']);
  return r;
}

describe('parsing and scope', () => {
  it('parses the snooping and DAI shows on a managed switch, and none of them on a router (D13)', () => {
    const user = matchContextFor(SWITCH, 'user-exec');
    const cases: [string, string, Record<string, string>][] = [
      ['show ip dhcp snooping', HANDLERS.showIpDhcpSnooping, {}],
      ['show ip dhcp snooping binding', HANDLERS.showIpDhcpSnooping, { [HARDENING_SHOW_ARG]: 'binding' }],
      ['show ip arp inspection', HANDLERS.showIpArpInspection, {}],
      ['show ip arp inspection vlan 10,20-22', HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'vlan', vlans: '10,20-22' }],
      ['sh ip arp insp int', HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'interfaces' }],
      ['show ip arp inspection statistics', HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'statistics' }],
    ];
    for (const [line, handler, args] of cases) {
      const m = matchCommand(GRAMMAR, user, line);
      expect(m.ok, line).toBe(true);
      if (!m.ok) continue;
      expect(m.spec.handler, line).toBe(handler);
      expect({ ...m.args }, line).toEqual(args);
      expect(matchCommand(GRAMMAR, matchContextFor(ROUTER, 'priv-exec'), line).ok, `${line} on a router`).toBe(false);
    }
    // the P1 DHCP server show keeps its own path
    const p1 = matchCommand(GRAMMAR, matchContextFor(ROUTER, 'priv-exec'), 'show ip dhcp binding');
    expect(p1.ok && p1.spec.handler).toBe(HANDLERS.showDhcpBinding);
  });
});

describe('show ip dhcp snooping binding', () => {
  it('prints the §5.8 shape exactly: the lease left in seconds, the kind, then the count', () => {
    const r = sw1();
    attach<DhcpSnoopingRow>(r, 'dhcp-snooping').set(LEARNED);
    expect(lines(run(r, HANDLERS.showIpDhcpSnooping, { [HARDENING_SHOW_ARG]: 'binding' }))).toEqual([
      'MAC address        IP address       Lease (s)  Kind     VLAN  Interface',
      '00:50:79:66:68:00  192.168.10.11    86385      learned  10    FastEthernet0/1',
      '1 binding',
    ]);
  });

  it('a static binding never runs out; rows sort by VLAN then MAC; none is a zero count', () => {
    const r = sw1();
    const t = attach<DhcpSnoopingRow>(r, 'dhcp-snooping');
    t.set(STATIC);
    t.set({ ...LEARNED, key: '5|00:50:79:66:68:09', mac: '00:50:79:66:68:09', vlan: 5, expiresAt: NOW - SEC });
    t.set(LEARNED);
    expect(lines(run(r, HANDLERS.showIpDhcpSnooping, { [HARDENING_SHOW_ARG]: 'binding' })).slice(1)).toEqual([
      '00:50:79:66:68:09  192.168.10.11    0          learned  5     FastEthernet0/1',
      '00:50:79:66:68:00  192.168.10.11    86385      learned  10    FastEthernet0/1',
      '00:50:79:66:68:01  192.168.10.12    infinite   static   10    FastEthernet0/2',
      '3 bindings',
    ]);
    // the table is stage-filtered (§2.6): a model without it reads as empty
    expect(lines(run(sw1(), HANDLERS.showIpDhcpSnooping, { [HARDENING_SHOW_ARG]: 'binding' })).slice(1)).toEqual(['0 bindings']);
  });
});

describe('show ip dhcp snooping', () => {
  it('the state, the VLANs, the address check, the bindings and the trusted or limited ports in port order', () => {
    const r = sw1();
    const t = attach<DhcpSnoopingRow>(r, 'dhcp-snooping');
    t.set(LEARNED);
    t.set(STATIC);
    expect(lines(run(r, HANDLERS.showIpDhcpSnooping))).toEqual([
      'DHCP snooping: on',
      '  VLANs listed: 10,20',
      '  Client hardware address check: on',
      '  Bindings: 2 (1 learned, 1 static)',
      '',
      'Interface           Trusted  Rate limit (pps)',
      'FastEthernet0/1     no       10',
      'GigabitEthernet0/1  yes      none',
    ]);
  });

  it('off without the global line (the VLAN lines wait for it); the stored negation turns the address check off', () => {
    const r = commandCtxFor(SWITCH, { mode: 'priv-exec' });
    r.running.set([], ['ip', 'dhcp', 'snooping', 'vlan', '10']);
    r.running.set([], ['no', 'ip', 'dhcp', 'snooping', 'verify', 'mac-address']);
    expect(lines(run(r, HANDLERS.showIpDhcpSnooping))).toEqual([
      'DHCP snooping: off',
      '  VLANs listed: 10 (not checked until "ip dhcp snooping" is configured)',
      '  Client hardware address check: off',
      '  Bindings: 0 (0 learned, 0 static)',
      '  No port is trusted or rate-limited.',
    ]);
  });
});

describe('show ip arp inspection', () => {
  const COUNTERS: ArpInspectionRow = { key: '10', vlan: 10, forwarded: 42, dropped: 3, droppedNoBinding: 3, droppedAcl: 0, updatedAt: 0 };

  it('vlan <list>: the §5.8 shape exactly, the trusted ports that carry the VLAN', () => {
    const r = sw1();
    attach<ArpInspectionRow>(r, 'arp-inspection').set(COUNTERS);
    expect(lines(run(r, HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'vlan', vlans: '10' }))).toEqual([
      'VLAN  Inspection  Forwarded  Dropped  No binding  Filter denied  Trusted ports',
      '10    on          42         3        3           0              GigabitEthernet0/1',
    ]);
    expect(run(r, HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'vlan', vlans: '40-50' })).toEqual({ output: MSG_DAI_NO_VLAN });
    expect(run(r, HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'vlan', vlans: 'x' }).error).toBeDefined();
  });

  it('without a view: every inspected VLAN and every VLAN with counters; an access port carries only its VLAN', () => {
    const r = sw1();
    // Fa0/1 (access VLAN 10) trusted too: it carries VLAN 10, not VLAN 30
    r.running.set([['interface', FA1]], ['ip', 'arp', 'inspection', 'trust']);
    const t = attach<ArpInspectionRow>(r, 'arp-inspection');
    t.set(COUNTERS);
    t.set({ key: '30', vlan: 30, forwarded: 5, dropped: 0, droppedNoBinding: 0, droppedAcl: 0, updatedAt: 0 });
    expect(lines(run(r, HANDLERS.showIpArpInspection))).toEqual([
      'VLAN  Inspection  Forwarded  Dropped  No binding  Filter denied  Trusted ports',
      '10    on          42         3        3           0              FastEthernet0/1, GigabitEthernet0/1',
      '30    off         5          0        0           0              GigabitEthernet0/1',
    ]);
    expect(lines(run(r, HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'statistics' }))).toEqual([
      'VLAN  Forwarded  Dropped  No binding  Filter denied',
      '10    42         3        3           0',
      '30    5          0        0           0',
    ]);
    expect(run(commandCtxFor(SWITCH, { mode: 'priv-exec' }), HANDLERS.showIpArpInspection)).toEqual({ output: MSG_DAI_NONE });
  });

  it('interfaces: every switched port with its trust and effective limit (15 pps untrusted, none trusted)', () => {
    const out = lines(run(sw1(), HANDLERS.showIpArpInspection, { [HARDENING_SHOW_ARG]: 'interfaces' }));
    expect(out[0]).toBe('Interface           Trust      Rate (pps)  Burst (s)');
    expect(out).toContain('FastEthernet0/1     untrusted  15          1');
    expect(out).toContain('FastEthernet0/2     untrusted  30          2');
    expect(out).toContain('FastEthernet0/3     untrusted  none        -');
    expect(out).toContain('GigabitEthernet0/1  trusted    none        -');
    // one row per switched port of the model, in canonical port order
    expect(out.length - 1).toBe([...sw1().ports.values()].filter((p) => (p.role ?? p.spec.role) === 'switched').length);
  });
});
