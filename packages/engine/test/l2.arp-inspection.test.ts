/**
 * W1 l2 (ARCHITECTURE-P3 D13, §3.4 steps 6–8, §4.3, §4.5, §5.3): the pure dynamic ARP inspection decision of eth-switch
 * step 7c.
 *  - the configuration reader (VLAN lines, trust, `limit rate <pps> [burst interval <s>]`, `limit none`);
 *  - the effective limit (15 pps untrusted, none trusted, unless configured) and its window;
 *  - the decision: skip / forward / drop (no binding) / err-disable, the per-VLAN log bound (5 lines per second);
 *  - the `arp-inspection` row after each verdict (one write per ARP inspected on an untrusted port).
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import type { ArpInspectionRow, DhcpSnoopingRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { createPduFactory } from '../src/pdu/factory.js';
import {
  ARP_INSPECTION_DEBUG_CATEGORY,
  ARP_INSPECTION_DEFAULT_RATE_PPS,
  ARP_INSPECTION_LOG_FACILITY,
  applyArpInspectionVerdict,
  arpInspectViewOf,
  arpInspectionActive,
  arpInspectionLimit,
  arpInspectionPort,
  arpInspectionRowOf,
  bindingConfirms,
  decideArpInspection,
  readArpInspection,
} from '../src/protocols/l2/arp-inspection.js';
import type { ArpInspectView, ArpInspectionCheck, ArpInspectionConfig, ArpInspectionVerdict } from '../src/protocols/l2/arp-inspection.js';
import type { RateWindow } from '../src/protocols/l2/rate-window.js';

const FA1 = 'FastEthernet0/1';
const FA5 = 'FastEthernet0/5';
const GI1 = 'GigabitEthernet0/1';
const PC1 = '00:50:79:66:68:00';
const ATTACKER = '00:50:79:66:68:05';
const R1 = '02:4e:11:00:00:01';

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return t[0] === 'no' ? { key: 'no', args: t.slice(1), children: [] } : { key: t[0] as string, args: t.slice(1), children: [] };
}
function cfg(globals: readonly string[], sections: Readonly<Record<string, readonly string[]>> = {}): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: globals.map(lineNode) };
  for (const [port, lines] of Object.entries(sections)) root.children.push({ key: 'interface', args: [port], children: lines.map(lineNode) });
  return configAstFromJson(root);
}

/** SW1 of §3.4 step 6. */
const SW1 = (): ArpInspectionConfig => readArpInspection(cfg(['ip dhcp snooping', 'ip dhcp snooping vlan 10', 'ip arp inspection vlan 10'], {
  [GI1]: ['ip dhcp snooping trust', 'ip arp inspection trust'],
}));

/** ATTACKER's lease on .12 (binding Fa0/5, .12), and PC1's on .11. */
const ATTACKER_BINDING: DhcpSnoopingRow = { key: `10|${ATTACKER}`, mac: ATTACKER, ip: '192.168.10.12', vlan: 10, port: FA5, kind: 'learned', leaseS: 86400, expiresAt: 86400 * SEC, updatedAt: 0 };
const PC1_BINDING: DhcpSnoopingRow = { key: `10|${PC1}`, mac: PC1, ip: '192.168.10.11', vlan: 10, port: FA1, kind: 'learned', leaseS: 86400, expiresAt: 86400 * SEC, updatedAt: 0 };

function arp(op: number, sha: string, spa: string, tpa = spa): ArpInspectView {
  return { op, sha, spa, tha: op === ARP_OP_REQUEST ? '00:00:00:00:00:00' : R1, tpa };
}
const check = (over: Partial<ArpInspectionCheck> & Pick<ArpInspectionCheck, 'arp' | 'port'>): ArpInspectionCheck => ({ config: SW1(), vlan: 10, now: 300 * SEC, ...over });

describe('readArpInspection (§5.3)', () => {
  it('nothing is inspected in an empty configuration', () => {
    const c = readArpInspection(cfg([]));
    expect(c).toEqual({ vlanLines: [], ports: [] });
    expect(arpInspectionActive(c, 10)).toBe(false);
  });

  it('reads the §3.4 setup; inspection needs only the vlan line (§4.3)', () => {
    const c = SW1();
    expect(c.vlanLines).toEqual([{ ranges: [[10, 10]], line: ['ip', 'arp', 'inspection', 'vlan', '10'] }]);
    expect(c.ports).toEqual([{ port: GI1, trusted: true }]);
    expect(arpInspectionActive(c, 10)).toBe(true);
    expect(arpInspectionActive(c, 20)).toBe(false);
    expect(arpInspectionActive(readArpInspection(cfg(['ip arp inspection vlan 10-12,30'])), 11)).toBe(true);
    expect(arpInspectionPort(c, FA5)).toEqual({ port: FA5, trusted: false });
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('limit forms: rate, rate with a burst interval, none; bad forms and negations ignored', () => {
    const c = readArpInspection(cfg([], {
      [FA1]: ['ip arp inspection limit rate 100'],
      [FA5]: ['ip arp inspection limit rate 20 burst interval 3'],
      [GI1]: ['ip arp inspection trust', 'ip arp inspection limit none'],
      'FastEthernet0/6': ['ip arp inspection limit rate 2049', 'ip arp inspection limit rate 5 burst interval 16', 'ip arp inspection limit rate', 'no ip arp inspection trust'],
      'FastEthernet0/7': ['ip arp inspection limit rate 0'],
    }));
    expect(c.ports).toEqual([
      { port: FA1, trusted: false, limit: { pps: 100, burstS: 1 }, limitLine: ['ip', 'arp', 'inspection', 'limit', 'rate', '100'] },
      { port: FA5, trusted: false, limit: { pps: 20, burstS: 3 }, limitLine: ['ip', 'arp', 'inspection', 'limit', 'rate', '20', 'burst', 'interval', '3'] },
      { port: GI1, trusted: true, limit: 'none', limitLine: ['ip', 'arp', 'inspection', 'limit', 'none'] },
      { port: 'FastEthernet0/7', trusted: false, limit: { pps: 0, burstS: 1 }, limitLine: ['ip', 'arp', 'inspection', 'limit', 'rate', '0'] },
    ]);
  });
});

describe('arpInspectionLimit (D13: 15 pps by default on untrusted ports)', () => {
  it('defaults: untrusted 15 per 1 s window, trusted none', () => {
    const c = SW1();
    expect(arpInspectionLimit(c, FA5)).toEqual({ allowed: 15, pps: 15, burstS: 1, windowNs: SEC });
    expect(arpInspectionLimit(c, GI1)).toBeUndefined();
    expect(ARP_INSPECTION_DEFAULT_RATE_PPS).toBe(15);
  });

  it('configured: pps × burst interval in windows of the interval; none; a limit on a trusted port applies', () => {
    const c = readArpInspection(cfg(['ip arp inspection vlan 10'], {
      [FA1]: ['ip arp inspection limit rate 20 burst interval 3'],
      [FA5]: ['ip arp inspection limit none'],
      [GI1]: ['ip arp inspection trust', 'ip arp inspection limit rate 50'],
    }));
    expect(arpInspectionLimit(c, FA1)).toEqual({ allowed: 60, pps: 20, burstS: 3, windowNs: 3 * SEC, line: ['ip', 'arp', 'inspection', 'limit', 'rate', '20', 'burst', 'interval', '3'] });
    expect(arpInspectionLimit(c, FA5)).toBeUndefined();
    expect(arpInspectionLimit(c, GI1)).toMatchObject({ allowed: 50, windowNs: SEC });
  });
});

describe('arpInspectViewOf (real encoded frames)', () => {
  it('reads op, sender and target from an ARP frame; other frames give undefined', () => {
    const pdus = createPduFactory();
    const garp = pdus.build([
      { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: ATTACKER, type: ETHERTYPE_ARP } },
      { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: ATTACKER, spa: '192.168.10.1', tha: '00:00:00:00:00:00', tpa: '192.168.10.1' } },
    ], { born: 0, origin: 'd_test' });
    expect(arpInspectViewOf(garp)).toEqual({ op: 1, sha: ATTACKER, spa: '192.168.10.1', tha: '00:00:00:00:00:00', tpa: '192.168.10.1' });
    expect(arpInspectViewOf({ layers: [] })).toBeUndefined();
    const ip = pdus.build([
      { proto: 'ethernet', fields: { dst: R1, src: PC1, type: 0x0800 } },
      { proto: 'ipv4', fields: { src: '192.168.10.11', dst: '192.168.10.1', protocol: 1, ttl: 64 } },
      { proto: 'icmpv4', fields: { type: 8, code: 0, id: 1, seq: 1 } },
    ], { born: 0, origin: 'd_test' });
    expect(arpInspectViewOf(ip)).toBeUndefined();
  });
});

describe('decideArpInspection (§3.4 steps 6–8)', () => {
  it('skip: the VLAN is not inspected — nothing counted, nothing written', () => {
    const v = decideArpInspection(check({ port: FA5, vlan: 20, arp: arp(ARP_OP_REQUEST, ATTACKER, '192.168.10.1') }));
    expect(v).toEqual({ kind: 'skip' });
    expect(applyArpInspectionVerdict(undefined, 20, v, 0)).toBeUndefined();
  });

  it('step 6: the spoofed gratuitous ARP (sender .1, binding says .12) drops arp-inspection with the exact detail and rule', () => {
    const v = decideArpInspection(check({ port: FA5, arp: arp(ARP_OP_REQUEST, ATTACKER, '192.168.10.1'), binding: ATTACKER_BINDING }));
    expect(v).toEqual({
      kind: 'drop',
      window: { start: 300 * SEC, count: 1 },
      reason: 'arp-inspection',
      detail: `ARP request from ${ATTACKER} claiming 192.168.10.1 on FastEthernet0/5 (vlan 10) matches no DHCP snooping binding`,
      rule: {
        kind: 'arp-inspection',
        text: `on an untrusted port of an inspected VLAN an ARP needs a DHCP snooping binding for its sender (MAC ${ATTACKER}, address 192.168.10.1, this port); a host with a static address needs "ip source binding", or the port needs "ip arp inspection trust"`,
        table: 'dhcp-snooping',
        key: `10|${ATTACKER}`,
        iface: FA5,
      },
      noBinding: true,
      logWindow: { start: 300 * SEC, count: 1 },
      log: {
        severity: 4,
        facility: 'DAI',
        message: `Refused an ARP request on FastEthernet0/5, vlan 10: ${ATTACKER} claims 192.168.10.1, which no DHCP snooping binding confirms.`,
      },
      debug: `dropped ARP request from ${ATTACKER} claiming 192.168.10.1 on FastEthernet0/5 (vlan 10): no matching binding`,
    });
    expect(ARP_INSPECTION_LOG_FACILITY).toBe('DAI');
    // the VLAN row: dropped + 1, droppedNoBinding + 1
    expect(applyArpInspectionVerdict(undefined, 10, v, 300 * SEC)).toEqual({ key: '10', vlan: 10, forwarded: 0, dropped: 1, droppedNoBinding: 1, droppedAcl: 0, updatedAt: 300 * SEC });
  });

  it('step 7: trusted ports are not inspected; an ARP matching its binding is forwarded and counted', () => {
    const fromR1 = decideArpInspection(check({ port: GI1, arp: arp(ARP_OP_REPLY, R1, '192.168.10.1') }));
    expect(fromR1).toEqual({ kind: 'forward', inspected: false });
    expect(applyArpInspectionVerdict(undefined, 10, fromR1, 0)).toBeUndefined();
    const own = decideArpInspection(check({ port: FA1, arp: arp(ARP_OP_REQUEST, PC1, '192.168.10.11', '192.168.10.1'), binding: PC1_BINDING }));
    expect(own).toEqual({ kind: 'forward', window: { start: 300 * SEC, count: 1 }, inspected: true });
    const row: ArpInspectionRow = { key: '10', vlan: 10, forwarded: 41, dropped: 3, droppedNoBinding: 3, droppedAcl: 0, updatedAt: 0 };
    expect(applyArpInspectionVerdict(row, 10, own, 301 * SEC)).toEqual({ ...row, forwarded: 42, updatedAt: 301 * SEC });
  });

  it('a binding confirms only with the same VLAN, MAC, IP and port, unexpired (D13)', () => {
    const a = arp(ARP_OP_REQUEST, PC1, '192.168.10.11');
    expect(bindingConfirms(PC1_BINDING, a, 10, FA1, 0)).toBe(true);
    expect(bindingConfirms(undefined, a, 10, FA1, 0)).toBe(false);
    expect(bindingConfirms(PC1_BINDING, a, 10, FA5, 0)).toBe(false);
    expect(bindingConfirms(PC1_BINDING, a, 20, FA1, 0)).toBe(false);
    expect(bindingConfirms(PC1_BINDING, arp(ARP_OP_REQUEST, PC1, '192.168.10.99'), 10, FA1, 0)).toBe(false);
    expect(bindingConfirms(PC1_BINDING, arp(ARP_OP_REQUEST, ATTACKER, '192.168.10.11'), 10, FA1, 0)).toBe(false);
    expect(bindingConfirms(PC1_BINDING, a, 10, FA1, 86400 * SEC)).toBe(false);
    expect(bindingConfirms(PC1_BINDING, a, 10, FA1, 86400 * SEC - 1)).toBe(true);
    const stat: DhcpSnoopingRow = { key: `10|${PC1}`, mac: PC1, ip: '192.168.10.11', vlan: 10, port: FA1, kind: 'static', updatedAt: 0 };
    expect(bindingConfirms(stat, a, 10, FA1, 10 ** 15)).toBe(true);
    // the same ARP from the binding's MAC on another port drops (requiring the port is a listed deviation)
    expect(decideArpInspection(check({ port: FA5, arp: a, binding: PC1_BINDING }))).toMatchObject({ kind: 'drop', noBinding: true });
  });

  it('step 8: a static-address host on an untrusted port has every ARP dropped until a static binding confirms it', () => {
    const staticHost = arp(ARP_OP_REQUEST, '00:50:79:66:68:77', '192.168.10.77', '192.168.10.1');
    expect(decideArpInspection(check({ port: FA1, arp: staticHost })).kind).toBe('drop');
    const binding: DhcpSnoopingRow = { key: '10|00:50:79:66:68:77', mac: '00:50:79:66:68:77', ip: '192.168.10.77', vlan: 10, port: FA1, kind: 'static', updatedAt: 0 };
    expect(decideArpInspection(check({ port: FA1, arp: staticHost, binding })).kind).toBe('forward');
  });

  it('at most 5 invalid-ARP log lines per VLAN per second; every drop still counts', () => {
    let logWindow: RateWindow | undefined;
    let row: ArpInspectionRow | undefined;
    const logged: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const v = decideArpInspection(check({ port: FA5, arp: arp(ARP_OP_REQUEST, ATTACKER, '192.168.10.1'), logWindow, now: 300 * SEC + i * 100 * MS }));
      if (v.kind !== 'drop') throw new Error('drop expected');
      logWindow = v.logWindow;
      logged.push(v.log !== undefined);
      row = applyArpInspectionVerdict(row, 10, v, 300 * SEC + i * 100 * MS);
    }
    expect(logged).toEqual([true, true, true, true, true, false, false, false]);
    expect(row).toMatchObject({ dropped: 8, droppedNoBinding: 8, forwarded: 0 });
    // the next second logs again
    const next = decideArpInspection(check({ port: FA5, arp: arp(ARP_OP_REQUEST, ATTACKER, '192.168.10.1'), logWindow, now: 301 * SEC }));
    expect(next).toMatchObject({ kind: 'drop', logWindow: { start: 301 * SEC, count: 1 }, log: { severity: 4 } });
  });

  it('step 7: the 16th ARP in one sim-time second on an untrusted port err-disables it (arp-inspection)', () => {
    let window: RateWindow | undefined;
    let row: ArpInspectionRow | undefined;
    const base = 400 * SEC;
    for (let i = 0; i < 15; i++) {
      const v = decideArpInspection(check({ port: FA1, arp: arp(ARP_OP_REQUEST, PC1, '192.168.10.11'), binding: PC1_BINDING, window, now: base + i * 60 * MS }));
      expect([i, v.kind]).toEqual([i, 'forward']);
      window = (v as { window?: RateWindow }).window;
      row = applyArpInspectionVerdict(row, 10, v, base + i * 60 * MS);
    }
    const v = decideArpInspection(check({ port: FA1, arp: arp(ARP_OP_REQUEST, PC1, '192.168.10.11'), binding: PC1_BINDING, window, now: base + 999 * MS }));
    expect(v).toEqual({
      kind: 'err-disable',
      window: { start: base, count: 16 },
      inspected: true,
      reason: 'arp-inspection',
      detail: 'ARP rate limit exceeded on FastEthernet0/1: 16 packets in one second, the limit is 15',
      rule: {
        kind: 'arp-inspection',
        text: 'an untrusted port accepts at most 15 ARP packets per second by default; more than that shuts the port down (error-disabled) until it is recovered',
        iface: FA1,
      },
      errDisable: { cause: 'arp-inspection', detail: '16 ARP packets in one second, the limit is 15' },
      debug: 'FastEthernet0/1 (vlan 10): 16 ARP packets in one second exceed the limit of 15; error-disabling the port',
    });
    expect(applyArpInspectionVerdict(row, 10, v, base + 999 * MS)).toMatchObject({ forwarded: 15, dropped: 1, droppedNoBinding: 0 });
    // 15 in one window and 15 in the next never exceed (windows aligned to sim-time seconds)
    let w: RateWindow | undefined;
    for (let i = 0; i < 30; i++) {
      const x = decideArpInspection(check({ port: FA1, arp: arp(ARP_OP_REQUEST, PC1, '192.168.10.11'), binding: PC1_BINDING, window: w, now: base + 2 * SEC + 500 * MS + i * 34 * MS }));
      expect([i, x.kind]).toEqual([i, 'forward']);
      w = (x as { window?: RateWindow }).window;
    }
  });

  it('a configured limit: its line is the rule; a burst interval counts over its whole window; a trusted port with a limit is not inspected', () => {
    const c = readArpInspection(cfg(['ip arp inspection vlan 10'], {
      [FA5]: ['ip arp inspection limit rate 2 burst interval 2'],
      [GI1]: ['ip arp inspection trust', 'ip arp inspection limit rate 1'],
    }));
    let window: RateWindow | undefined;
    const kinds: string[] = [];
    for (const t of [0, 500, 1000, 1500, 1900]) {
      const v = decideArpInspection(check({ config: c, port: FA5, arp: arp(ARP_OP_REQUEST, ATTACKER, '192.168.10.12'), binding: ATTACKER_BINDING, window, now: 10 * SEC + t * MS }));
      kinds.push(v.kind);
      window = (v as { window?: RateWindow }).window;
      if (v.kind === 'err-disable') {
        expect(v.window).toEqual({ start: 10 * SEC, count: 5 });
        expect(v.detail).toBe('ARP rate limit exceeded on FastEthernet0/5: 5 packets in 2 seconds, the limit is 4');
        expect(v.rule).toEqual({
          kind: 'arp-inspection',
          text: 'FastEthernet0/5 accepts at most 4 ARP packets in 2 seconds; more than that shuts the port down (error-disabled) until it is recovered',
          iface: FA5,
          config: { context: [['interface', FA5]], line: ['ip', 'arp', 'inspection', 'limit', 'rate', '2', 'burst', 'interval', '2'] },
        });
        expect(v.errDisable).toEqual({ cause: 'arp-inspection', detail: '5 ARP packets in 2 seconds, the limit is 4' });
      }
    }
    expect(kinds).toEqual(['forward', 'forward', 'forward', 'forward', 'err-disable']);
    const t1 = decideArpInspection(check({ config: c, port: GI1, arp: arp(ARP_OP_REPLY, R1, '192.168.10.1'), now: SEC }));
    expect(t1).toEqual({ kind: 'forward', window: { start: SEC, count: 1 }, inspected: false });
    const t2 = decideArpInspection(check({ config: c, port: GI1, arp: arp(ARP_OP_REPLY, R1, '192.168.10.1'), window: (t1 as { window?: RateWindow }).window, now: SEC + 1 }));
    expect(t2).toMatchObject({ kind: 'err-disable', inspected: false });
    expect(applyArpInspectionVerdict(undefined, 10, t2, SEC)).toBeUndefined();
  });

  it('limit none: an untrusted port is never rate limited; ops other than request and reply are named by number', () => {
    const c = readArpInspection(cfg(['ip arp inspection vlan 10'], { [FA5]: ['ip arp inspection limit none'] }));
    for (let i = 0; i < 40; i++) {
      const v = decideArpInspection(check({ config: c, port: FA5, arp: arp(ARP_OP_REPLY, ATTACKER, '192.168.10.12'), binding: ATTACKER_BINDING, now: SEC + i }));
      expect(v).toEqual({ kind: 'forward', inspected: true });
    }
    expect(decideArpInspection(check({ config: c, port: FA5, arp: arp(ARP_OP_REPLY, ATTACKER, '192.168.10.1') }))).toMatchObject({
      detail: `ARP reply from ${ATTACKER} claiming 192.168.10.1 on FastEthernet0/5 (vlan 10) matches no DHCP snooping binding`,
    });
    expect(decideArpInspection(check({ config: c, port: FA5, arp: { ...arp(ARP_OP_REPLY, ATTACKER, '192.168.10.1'), op: 9 } }))).toMatchObject({
      detail: `ARP op 9 from ${ATTACKER} claiming 192.168.10.1 on FastEthernet0/5 (vlan 10) matches no DHCP snooping binding`,
    });
  });

  it('rows: a zeroed row per VLAN; debug category', () => {
    expect(arpInspectionRowOf(30, 7)).toEqual({ key: '30', vlan: 30, forwarded: 0, dropped: 0, droppedNoBinding: 0, droppedAcl: 0, updatedAt: 7 });
    expect(ARP_INSPECTION_DEBUG_CATEGORY).toBe('ip arp inspection');
    const skip: ArpInspectionVerdict = { kind: 'skip' };
    expect(applyArpInspectionVerdict(arpInspectionRowOf(10, 0), 10, skip, 5)).toBeUndefined();
  });
});
