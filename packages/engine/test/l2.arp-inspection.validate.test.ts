/**
 * W2a l2 [S14] (ARCHITECTURE-P3C §3.7, §4.3, §2.6 `ArpInspectionRow`, RC5 (g); §7 W2a l2): the DAI order with
 * `ip arp inspection validate` and the VLAN's ARP ACL wired into `decideArpInspection`, and through eth-switch step 7c
 * on a real world.
 *  - the IOS order: (1) rate limit, (2) trusted port, (3) validate, (4) the ARP ACL, (5) bindings — each pinned by a
 *    case where the earlier step decides although a later one would decide otherwise;
 *  - explicit permit forwards without a binding; explicit deny drops a bound host; no match falls through to the
 *    bindings, or with `static` is the implicit deny;
 *  - the refused ARPs share the VLAN's log bound (five lines per second);
 *  - the row: `aclPermitted`, `droppedSrcMac`, `droppedDstMac`, `droppedIp` and `droppedAcl`, the optional ones only
 *    once nonzero;
 *  - without the ACL configuration (or with neither line) every verdict is the P3a one;
 *  - on a real world (staged P3c): an ACL admits a static host, `static` blocks a bound host absent from the list,
 *    `validate src-mac` drops a forged sender MAC with its rule, counter, log and debug line; with neither line the row
 *    carries no new counter.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigAst, ConfigNode } from '../src/contracts/config.js';
import { ARP_OP_REPLY, ARP_OP_REQUEST } from '../src/contracts/pdu.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { ArpInspectionRow, DhcpSnoopingRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { readArpAclInspection } from '../src/protocols/l2/arp-acl.js';
import type { ArpAclInspectionConfig } from '../src/protocols/l2/arp-acl.js';
import {
  ARP_INSPECTION_DEBUG_CATEGORY,
  applyArpInspectionVerdict,
  arpInspectionRowOf,
  daiRefusedLogMessage,
  decideArpInspection,
  readArpInspection,
} from '../src/protocols/l2/arp-inspection.js';
import type { ArpInspectView, ArpInspectionCheck, ArpInspectionConfig, ArpInspectionVerdict } from '../src/protocols/l2/arp-inspection.js';
import type { RateWindow } from '../src/protocols/l2/rate-window.js';
import { INJECTED_TAG, INJECTOR_HOST_TYPE, arpFrame, injectFrames, withInjector } from './inject.js';
import { ofKind, ping } from './sim.harness.js';
import { P3_DAEMONS, createStagedSimulation, type StagedFactoryOverlay } from './staged.world.js';

const FA1 = 'FastEthernet0/1';
const FA2 = 'FastEthernet0/2';
const FA5 = 'FastEthernet0/5';
const GI1 = 'GigabitEthernet0/1';
const PC1 = '00:50:79:66:68:00';
const ATTACKER = '00:50:79:66:68:05';
const OTHER = '00:50:79:66:68:0e';
const R1 = '02:4e:11:00:00:01';
const ZERO = '00:00:00:00:00:00';
const BCAST = 'ff:ff:ff:ff:ff:ff';

// ── pure: decideArpInspection with steps 3–4 ────────────────────────────────────────────────────────────────

function lineNode(text: string): ConfigNode {
  const t = text.split(' ');
  return t[0] === 'no' ? { key: 'no', args: t.slice(1), children: [] } : { key: t[0] as string, args: t.slice(1), children: [] };
}
function cfg(globals: readonly string[], sections: Readonly<Record<string, readonly string[]>> = {}, acls: Readonly<Record<string, readonly string[]>> = {}): ConfigAst {
  const root: ConfigNode = { key: '', args: [], children: globals.map(lineNode) };
  for (const [port, lines] of Object.entries(sections)) root.children.push({ key: 'interface', args: [port], children: lines.map(lineNode) });
  for (const [name, lines] of Object.entries(acls)) root.children.push({ key: 'arp', args: ['access-list', name], children: lines.map(lineNode) });
  return configAstFromJson(root);
}

const BASE = ['ip dhcp snooping', 'ip dhcp snooping vlan 10', 'ip arp inspection vlan 10'];
const TRUNK = { [GI1]: ['ip dhcp snooping trust', 'ip arp inspection trust'] };
const DAI = (): ArpInspectionConfig => readArpInspection(cfg(BASE, TRUNK));
/** The ACL configuration: list SRV permits .9 from any MAC and denies a claim of the gateway; `extra` global lines. */
const ACL = (extra: readonly string[] = []): ArpAclInspectionConfig => readArpAclInspection(cfg(
  [...BASE, ...extra], TRUNK,
  { SRV: ['permit ip host 192.168.10.9 mac any', 'deny ip host 192.168.10.1 mac any'] },
));

const ATTACKER_BINDING: DhcpSnoopingRow = { key: `10|${ATTACKER}`, mac: ATTACKER, ip: '192.168.10.12', vlan: 10, port: FA5, kind: 'learned', leaseS: 86400, expiresAt: 86400 * SEC, updatedAt: 0 };
const req = (sha: string, spa: string, tpa = '192.168.10.1'): ArpInspectView => ({ op: ARP_OP_REQUEST, sha, spa, tha: ZERO, tpa });
const reply = (sha: string, spa: string, tha: string, tpa: string): ArpInspectView => ({ op: ARP_OP_REPLY, sha, spa, tha, tpa });

function check(over: Partial<ArpInspectionCheck> & Pick<ArpInspectionCheck, 'arp'>): ArpInspectionCheck {
  return { config: DAI(), port: FA5, vlan: 10, now: 300 * SEC, eth: { src: over.arp.sha, dst: BCAST }, ...over };
}

describe('decideArpInspection: the IOS order (rate limit, trusted, validate, ACL, bindings)', () => {
  it('(1) before (3): the rate limit err-disables even an ARP that validate would refuse', () => {
    const window: RateWindow = { start: 300 * SEC, count: 15 };
    const v = decideArpInspection(check({ arp: req(ATTACKER, '0.0.0.0'), window, acl: ACL(['ip arp inspection validate ip']) }));
    expect(v.kind).toBe('err-disable');
  });

  it('(2) before (3)–(4): a trusted port is neither validated nor filtered', () => {
    const acl = ACL(['ip arp inspection filter SRV vlan 10 static', 'ip arp inspection validate src-mac']);
    const v = decideArpInspection(check({ port: GI1, arp: req(R1, '192.168.10.1'), eth: { src: OTHER, dst: BCAST }, acl }));
    expect(v).toEqual({ kind: 'forward', inspected: false });
    expect(applyArpInspectionVerdict(undefined, 10, v, 300 * SEC)).toBeUndefined();
  });

  it('(3) before (4): validate refuses an ARP the ACL would permit', () => {
    const acl = ACL(['ip arp inspection filter SRV vlan 10', 'ip arp inspection validate src-mac']);
    const v = decideArpInspection(check({ arp: req(ATTACKER, '192.168.10.9'), eth: { src: OTHER, dst: BCAST }, acl }));
    expect(v.kind).toBe('refused');
    const r = v as Extract<ArpInspectionVerdict, { kind: 'refused' }>;
    expect(r.outcome.cause).toBe('src-mac');
    expect(r.detail).toBe(`ARP request on ${FA5} (vlan 10): sender MAC ${ATTACKER} differs from the Ethernet source ${OTHER}`);
    expect(r.rule).toEqual({
      kind: 'arp-inspection',
      text: 'with "validate src-mac" an ARP whose sender MAC differs from its Ethernet source is dropped',
      iface: FA5,
      config: { context: [], line: ['ip', 'arp', 'inspection', 'validate', 'src-mac'] },
    });
    expect(r.log).toEqual({
      severity: 4, facility: 'DAI',
      message: `Refused an ARP request on ${FA5}, vlan 10: ${ATTACKER} claims 192.168.10.9, and it fails the src-mac validation.`,
    });
    expect(applyArpInspectionVerdict(undefined, 10, v, 300 * SEC)).toEqual({ ...arpInspectionRowOf(10, 300 * SEC), dropped: 1, droppedSrcMac: 1 });
  });

  it('validate dst-mac and ip: a reply to another MAC, a sender of 0.0.0.0', () => {
    const acl = ACL(['ip arp inspection validate dst-mac ip']);
    const dst = decideArpInspection(check({ arp: reply(ATTACKER, '192.168.10.12', PC1, '192.168.10.11'), eth: { src: ATTACKER, dst: OTHER }, acl }));
    expect(dst.kind === 'refused' && dst.outcome.cause).toBe('dst-mac');
    expect(applyArpInspectionVerdict(undefined, 10, dst, 0)).toMatchObject({ dropped: 1, droppedDstMac: 1 });
    const ip = decideArpInspection(check({ arp: req(ATTACKER, '0.0.0.0'), acl }));
    expect(ip.kind === 'refused' && ip.outcome.cause).toBe('ip');
    expect(applyArpInspectionVerdict(undefined, 10, ip, 0)).toMatchObject({ dropped: 1, droppedIp: 1 });
    // a valid reply passes on to the bindings
    const ok = decideArpInspection(check({ arp: reply(ATTACKER, '192.168.10.12', PC1, '192.168.10.11'), eth: { src: ATTACKER, dst: PC1 }, acl, binding: ATTACKER_BINDING }));
    expect(ok).toEqual({ kind: 'forward', inspected: true, window: { start: 300 * SEC, count: 1 } });
  });

  it('(4) before (5): an explicit permit forwards without a binding; an explicit deny drops even a bound sender', () => {
    const acl = ACL(['ip arp inspection filter SRV vlan 10']);
    const permit = decideArpInspection(check({ arp: req(OTHER, '192.168.10.9'), acl }));
    expect(permit.kind).toBe('forward');
    const p = permit as Extract<ArpInspectionVerdict, { kind: 'forward' }>;
    expect(p.inspected).toBe(true);
    expect(p.permit?.acl).toBe('SRV');
    expect(p.permit?.debug).toBe(`permitted ARP request from ${OTHER} claiming 192.168.10.9 on ${FA5} (vlan 10) by ARP access list SRV`);
    expect(applyArpInspectionVerdict(undefined, 10, permit, 0)).toEqual({ ...arpInspectionRowOf(10, 0), forwarded: 1, aclPermitted: 1 });

    const bound: DhcpSnoopingRow = { ...ATTACKER_BINDING, ip: '192.168.10.1' };
    const deny = decideArpInspection(check({ arp: req(ATTACKER, '192.168.10.1'), acl, binding: bound }));
    expect(deny.kind === 'refused' && deny.outcome.cause).toBe('acl-deny');
    expect(deny.kind === 'refused' && deny.rule).toEqual({
      kind: 'arp-inspection',
      text: 'denied by ARP access list SRV entry 2 (deny ip host 192.168.10.1 mac any), applied to vlan 10',
      iface: FA5,
      list: 'SRV',
      config: { context: [['arp', 'access-list', 'SRV']], line: ['deny', 'ip', 'host', '192.168.10.1', 'mac', 'any'] },
    });
    expect(applyArpInspectionVerdict(undefined, 10, deny, 0)).toEqual({ ...arpInspectionRowOf(10, 0), dropped: 1, droppedAcl: 1 });
  });

  it('(5): no match falls through to the bindings; with "static" no match is the implicit deny, even for a bound sender', () => {
    const through = ACL(['ip arp inspection filter SRV vlan 10']);
    expect(decideArpInspection(check({ arp: req(ATTACKER, '192.168.10.12'), acl: through, binding: ATTACKER_BINDING }))).toEqual({ kind: 'forward', inspected: true, window: { start: 300 * SEC, count: 1 } });
    const unbound = decideArpInspection(check({ arp: req(ATTACKER, '192.168.10.77'), acl: through, binding: ATTACKER_BINDING }));
    expect(unbound.kind).toBe('drop');

    const isStatic = ACL(['ip arp inspection filter SRV vlan 10 static']);
    const v = decideArpInspection(check({ arp: req(ATTACKER, '192.168.10.12'), acl: isStatic, binding: ATTACKER_BINDING }));
    expect(v.kind === 'refused' && v.outcome.cause).toBe('acl-static');
    expect(v.kind === 'refused' && v.log?.message).toBe(
      `Refused an ARP request on ${FA5}, vlan 10: ${ATTACKER} claims 192.168.10.12, and no entry of the static ARP access list permits it.`,
    );
    expect(applyArpInspectionVerdict(undefined, 10, v, 0)).toMatchObject({ dropped: 1, droppedAcl: 1 });
  });

  it('refused ARPs share the VLAN\'s log bound: the sixth in one second logs nothing', () => {
    const acl = ACL(['ip arp inspection validate ip']);
    const v = decideArpInspection(check({ arp: req(ATTACKER, '0.0.0.0'), acl, logWindow: { start: 300 * SEC, count: 5 } }));
    expect(v.kind).toBe('refused');
    expect(v.kind === 'refused' && v.log).toBeUndefined();
    expect(v.kind === 'refused' && v.logWindow).toEqual({ start: 300 * SEC, count: 6 });
    const m = decideArpInspection(check({ arp: req(ATTACKER, '0.0.0.0'), acl, logWindow: { start: 299 * SEC, count: 5 } }));
    expect(m.kind === 'refused' && m.log?.message).toBe(daiRefusedLogMessage((m as Extract<ArpInspectionVerdict, { kind: 'refused' }>).outcome, req(ATTACKER, '0.0.0.0'), FA5, 10));
  });

  it('without the ACL configuration, or with neither line, every verdict is the P3a one', () => {
    const empty = readArpAclInspection(cfg(BASE, TRUNK));
    const cases: ArpInspectionCheck[] = [
      check({ arp: req(ATTACKER, '192.168.10.12'), binding: ATTACKER_BINDING }),
      check({ arp: req(ATTACKER, '192.168.10.1'), binding: ATTACKER_BINDING }),
      check({ arp: req(ATTACKER, '192.168.10.1'), logWindow: { start: 300 * SEC, count: 5 } }),
      check({ arp: req(ATTACKER, '192.168.10.12'), window: { start: 300 * SEC, count: 15 } }),
      check({ port: GI1, arp: req(R1, '192.168.10.1') }),
    ];
    for (const c of cases) {
      const { acl: _a, eth: _e, ...p3a } = c;
      const before = decideArpInspection(p3a);
      expect(decideArpInspection({ ...c, acl: empty })).toEqual(before);
      expect(decideArpInspection(c)).toEqual(before);
      expect(applyArpInspectionVerdict(undefined, 10, decideArpInspection({ ...c, acl: empty }), 300 * SEC)).toEqual(applyArpInspectionVerdict(undefined, 10, before, 300 * SEC));
    }
  });
});

// ── through eth-switch step 7c (a real world) ──────────────────────────────────────────────────────────────

const PC_PORT = 'GigabitEthernet0';
const INJ_PORT = 'GigabitEthernet0';
const A = '02:4e:66:00:00:05';
const B = '02:4e:66:00:00:0b';

function noP3(): StagedFactoryOverlay {
  const out: Record<string, ProcessFactory | undefined> = {};
  for (const p of P3_DAEMONS) out[p] = undefined;
  return out;
}

function configText(sections: readonly (readonly string[])[]): string {
  return [...sections.flatMap((s) => [...s, '!']), 'end', ''].join('\n');
}

/** SW1 of P3a §3.4 step 6 (snooping and DAI on VLAN 10, ATTACKER bound to .12 on Fa0/5) with `extra` sections. */
function sw1Config(extra: readonly (readonly string[])[] = []): string {
  const access = (port: string): string[] => [`interface ${port}`, ' switchport mode access', ' switchport access vlan 10', ' spanning-tree portfast'];
  return configText([
    ['hostname SW1'],
    ['vlan 10'],
    access(FA1),
    access(FA2),
    access(FA5),
    [`interface ${GI1}`, ' switchport mode trunk', ' ip dhcp snooping trust', ' ip arp inspection trust'],
    ['ip dhcp snooping', 'ip dhcp snooping vlan 10', `ip source binding ${A} vlan 10 192.168.10.12 interface ${FA5}`, 'ip arp inspection vlan 10'],
    ...extra,
  ]);
}

const R1_LINES: readonly string[] = [
  'interface GigabitEthernet0/0', 'no shutdown', 'exit',
  'interface GigabitEthernet0/0.10', 'encapsulation dot1q 10', 'ip address 192.168.10.1 255.255.255.0', 'exit',
  'ip dhcp excluded-address 192.168.10.1 192.168.10.10',
  'ip dhcp pool V10', 'network 192.168.10.0 255.255.255.0', 'default-router 192.168.10.1', 'exit',
];

function configured(sim: Simulation, dev: string, lines: readonly string[]): void {
  const r = sim.configure(dev, lines);
  if (!r.ok) throw new Error(`${dev} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** Booted; R1 serving the pool; PC1 leased on Fa0/1 (or refused, under `static`); PC2 static .50 on Fa0/2. */
function world(sw: string, seed = 5): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3c', factories: withInjector(noP3()) });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: sw });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1' });
  sim.addDevice({
    id: 'pc2', type: 'pc.nfpc', name: 'PC2',
    startupConfig: configText([['hostname PC2'], ['interface GigabitEthernet0', ' ip address 192.168.10.50 255.255.255.0'], ['ip default-gateway 192.168.10.1']]),
  });
  sim.addDevice({ id: 'attacker', type: INJECTOR_HOST_TYPE, name: 'ATTACKER' });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: PC_PORT }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: PC_PORT }, b: { device: 'sw1', port: FA2 } });
  sim.addLink({ id: 'l_att', a: { device: 'attacker', port: INJ_PORT }, b: { device: 'sw1', port: FA5 } });
  sim.addLink({ id: 'l_r1', a: { device: 'sw1', port: GI1 }, b: { device: 'r1', port: 'GigabitEthernet0/0' } });
  sim.runFor(120 * SEC);
  configured(sim, 'r1', R1_LINES);
  sim.runToIdle();
  configured(sim, 'pc1', ['ip address dhcp']);
  sim.runToIdle();
  return sim;
}

const daiRow = (sim: Simulation): ArpInspectionRow | undefined => sim.device('sw1')!.tables.get<ArpInspectionRow>('arp-inspection')!.get('10');
const daiDrops = (evs: readonly TraceEvent[]): Extract<TraceEvent, { kind: 'drop' }>[] => ofKind(evs, 'drop').filter((e) => e.reason === 'arp-inspection');
const daiLogs = (evs: readonly TraceEvent[]): string[] => ofKind(evs, 'log').filter((e) => e.device === 'sw1' && e.facility === 'DAI').map((e) => e.message);
const daiDebug = (evs: readonly TraceEvent[]): string[] =>
  ofKind(evs, 'debug').filter((e) => e.event.category === ARP_INSPECTION_DEBUG_CATEGORY).map((e) => e.event.message);

describe('eth-switch step 7c with validate and ARP ACLs (a real world)', () => {
  it('an ARP ACL admits the static host PC2: its ping works, counted as aclPermitted', () => {
    const sim = world(sw1Config([['arp access-list STATIC-HOSTS', ' permit ip host 192.168.10.50 mac any'], ['ip arp inspection filter STATIC-HOSTS vlan 10']]));
    const before = daiRow(sim)!;
    const t0 = sim.trace(0).next;
    expect(ping(sim, 'pc2', '192.168.10.1').text).toMatch(/!!!/);
    const evs = sim.trace(t0).events;
    expect(daiDrops(evs)).toEqual([]);
    const permits = daiDebug(evs).filter((m) => m.startsWith('permitted ARP'));
    expect(permits.length).toBeGreaterThan(0);
    expect(permits[0]).toBe(`permitted ARP request from ${sim.device('pc2')!.port(PC_PORT)!.mac} claiming 192.168.10.50 on ${FA2} (vlan 10) by ARP access list STATIC-HOSTS`);
    const after = daiRow(sim)!;
    expect((after.aclPermitted ?? 0) - (before.aclPermitted ?? 0)).toBe(permits.length);
    expect(after.forwarded - before.forwarded).toBeGreaterThanOrEqual(permits.length);
    // PC1 (bound, absent from the list) still passes by its binding
    expect(ping(sim, 'pc1', '192.168.10.1').text).toMatch(/!!!!!/);
  });

  it('"static" blocks a bound host absent from the list (the implicit deny), with its rule', () => {
    const sim = world(sw1Config([['arp access-list STATIC-HOSTS', ' permit ip host 192.168.10.50 mac any'], ['ip arp inspection filter STATIC-HOSTS vlan 10 static']]));
    const t0 = sim.trace(0).next;
    injectFrames(sim, { from: 'attacker', port: INJ_PORT, frames: [arpFrame({ sha: A, spa: '192.168.10.12' })], spacingNs: 0 });
    sim.runToIdle();
    const d = daiDrops(sim.trace(t0).events);
    expect(d).toHaveLength(1);
    expect(d[0]!.detail).toBe(`ARP request from ${A} claiming 192.168.10.12 on ${FA5} (vlan 10) matches no entry of ARP access list STATIC-HOSTS, which is applied as static`);
    expect(d[0]!.rule).toEqual({
      kind: 'arp-inspection',
      text: 'ARP access list STATIC-HOSTS is applied to vlan 10 with "static": an ARP no entry permits is dropped, and DHCP snooping bindings are not consulted',
      iface: FA5,
      list: 'STATIC-HOSTS',
      config: { context: [], line: ['ip', 'arp', 'inspection', 'filter', 'STATIC-HOSTS', 'vlan', '10', 'static'] },
    });
    expect(d[0]!.pdu.tag).toBe(INJECTED_TAG);
    expect(daiRow(sim)!.droppedAcl).toBeGreaterThanOrEqual(1);
  });

  it('validate src-mac drops a forged sender MAC with its counter, log and debug line; the honest ARP passes', () => {
    const sim = world(sw1Config([['ip arp inspection validate src-mac']]));
    const before = daiRow(sim)!;
    const t0 = sim.trace(0).next;
    injectFrames(sim, {
      from: 'attacker', port: INJ_PORT, spacingNs: 10 * MS,
      frames: [arpFrame({ sha: A, spa: '192.168.10.12', srcMac: B }), arpFrame({ sha: A, spa: '192.168.10.12' })],
    });
    sim.runToIdle();
    const evs = sim.trace(t0).events;
    const d = daiDrops(evs);
    expect(d.map((e) => e.detail)).toEqual([`ARP request on ${FA5} (vlan 10): sender MAC ${A} differs from the Ethernet source ${B}`]);
    expect(d[0]!.rule).toEqual({
      kind: 'arp-inspection',
      text: 'with "validate src-mac" an ARP whose sender MAC differs from its Ethernet source is dropped',
      iface: FA5,
      config: { context: [], line: ['ip', 'arp', 'inspection', 'validate', 'src-mac'] },
    });
    expect(daiLogs(evs)).toEqual([`Refused an ARP request on ${FA5}, vlan 10: ${A} claims 192.168.10.12, and it fails the src-mac validation.`]);
    expect(daiDebug(evs)).toEqual([`dropped ARP request from ${A} on ${FA5} (vlan 10): validate src-mac failed`]);
    const after = daiRow(sim)!;
    expect([after.forwarded - before.forwarded, after.dropped - before.dropped, after.droppedSrcMac]).toEqual([1, 1, 1]);
    expect(after.droppedNoBinding).toBe(before.droppedNoBinding);
  });

  it('with neither line the row carries none of the new counters', () => {
    const sim = world(sw1Config());
    ping(sim, 'pc2', '192.168.10.1'); // refused: no binding (the P3a gotcha)
    const row = daiRow(sim)!;
    expect(row.dropped).toBeGreaterThan(0);
    expect(Object.keys(row).sort()).toEqual(['dropped', 'droppedAcl', 'droppedNoBinding', 'forwarded', 'key', 'updatedAt', 'vlan']);
    expect(row.droppedAcl).toBe(0);
  });

  it('two runs with one seed are byte-identical', () => {
    const run = (): string => {
      const sim = world(sw1Config([['arp access-list STATIC-HOSTS', ' permit ip host 192.168.10.50 mac any'], ['ip arp inspection filter STATIC-HOSTS vlan 10'], ['ip arp inspection validate src-mac ip']]), 13);
      ping(sim, 'pc2', '192.168.10.1');
      injectFrames(sim, { from: 'attacker', port: INJ_PORT, spacingNs: 10 * MS, count: 6, frames: [arpFrame({ sha: A, spa: '192.168.10.12', srcMac: B }), arpFrame({ sha: A, spa: '0.0.0.0' })] });
      sim.runToIdle();
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    expect(run()).toBe(run());
  });
});
