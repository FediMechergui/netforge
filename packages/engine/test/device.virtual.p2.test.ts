/**
 * W2 device (ARCHITECTURE-P2 §3.0 "Virtual oper state", D6, D15): the lookups the runtime injects into the virtual
 * oper rule — on a VLAN-aware device (`isVlanAware`) an SVI needs its VLAN (implicit or a `vlans` row) and one up
 * bridged port that is not a non-individual bundle member, carries the VLAN (`readSwitchport` + `carries`, the dtp
 * row for dynamic ports) and forwards in it when an `stp-bridge` row exists; a Port-channel needs a bundled member
 * that is up (`etherchannel` rows) — plus the new recompute sites (every applied `switchport`, `vlan`,
 * `channel-group`, `encapsulation` or `spanning-tree` line), the `vlan-missing` log, the P1 rule on a device that is
 * not VLAN-aware, and the `setPortL3` merge of `virtual4` with its `isLocalDestination` consumer. The daemons are
 * recording fakes on the P2-stage NF-C2960 carrying `managed-switch` (no catalog model runs `vlan` before W4).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId, ProcessName } from '../src/contracts/ids.js';
import type { PortState, VirtualIpv4 } from '../src/contracts/port.js';
import type { Action, DebugEvent, Process, ProcessCtx, StateView } from '../src/contracts/process.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import { stpKey, vlanKey, type DtpRow, type EtherchannelRow, type StpBridgeRow, type StpPortRow, type VlanRow } from '../src/contracts/tables.js';
import { defineModel } from '../src/device/catalog/define.js';
import { VIRTUAL_RECOMPUTE_KEYS } from '../src/device/device.js';
import { NF_C2960_INPUT } from './device.catalog.p0-inputs.js';
import { p2Harness, type P2Harness } from './device.p2.harness.js';

const FA1: PortId = 'FastEthernet0/1';
const FA2: PortId = 'FastEthernet0/2';
const FA3: PortId = 'FastEthernet0/3';
const FA5: PortId = 'FastEthernet0/5';
const GI1: PortId = 'GigabitEthernet0/1';
const PO1: PortId = 'Port-channel1';
const L2: readonly ProcessName[] = ['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp'];

/** The P2-stage managed switch: VLANs 1–4094 and Port-channels as virtual families. */
const MANAGED = defineModel({ ...NF_C2960_INPUT, capabilities: ['switching', 'managed-switch'] }, 'P2');
const modelWith = (processes: readonly ProcessName[]): DeviceModel => ({ ...MANAGED, processes: [...processes] });

interface FakeScript {
  onConfig?: (ctx: ProcessCtx, delta: ConfigDelta) => Action[];
}

function fake(name: ProcessName, script: FakeScript = {}): { factory: () => Process; ctx: () => ProcessCtx | undefined } {
  let seen: ProcessCtx | undefined;
  const proc: Process = {
    name,
    init(ctx) {
      seen = ctx;
      return [];
    },
    onPdu: () => [],
    onTimer: () => [],
    onConfig(ctx, delta) {
      seen = ctx;
      return script.onConfig ? script.onConfig(ctx, delta) : [];
    },
    onEvent: () => [],
    onLinkChange: () => [],
    stateSnapshot: (): StateView => ({ process: name, state: {} }),
    debugEvents: (): readonly DebugEvent[] => [],
  };
  return { factory: () => proc, ctx: () => seen };
}

/** Boot a managed switch whose daemons are fakes; `scripts` customise a fake's onConfig. */
function sw(processes: readonly ProcessName[] = L2, scripts: Partial<Record<ProcessName, FakeScript>> = {}) {
  const fakes = new Map(processes.map((n) => [n, fake(n, scripts[n])]));
  const factories: Record<ProcessName, () => Process> = {};
  for (const [n, f] of fakes) factories[n] = f.factory;
  const h = p2Harness({ model: modelWith(processes), processes: factories });
  h.run();
  const at = (h.device.bootedAt as number) + 1;
  h.events.length = 0;
  return { h, at, ctx: (n: ProcessName) => fakes.get(n)?.ctx() };
}

const cfg = (h: P2Harness, context: string[][], line: string, negate = false) => h.device.applyConfigLine(context, line.split(' '), negate);
const portStates = (h: P2Harness) => h.kinds('portState').map((e) => [e.port, e.operUp, e.reason]);
const logs = (h: P2Harness) => h.kinds('log').map((e) => e.message);

/** Bring a physical port up as the link model would (write operUp, then tell the runtime). */
function linkUp(h: P2Harness, port: PortId, at: number, up = true): void {
  (h.device.port(port) as PortState).operUp = up;
  h.device.onPortOper(port, up, at);
}

/** Enable an SVI (`interface VlanN` + `no shutdown`). */
function svi(h: P2Harness, vlan: number): PortState {
  cfg(h, [['interface', `Vlan${vlan}`]], 'shutdown', true);
  return h.device.port(`Vlan${vlan}`) as PortState;
}

const vlanRow = (vlan: number, at: number): VlanRow => ({ key: vlanKey(vlan), vlan, name: `VLAN${vlan}`, status: 'active', source: 'config', updatedAt: at });
const memberRow = (port: PortId, state: EtherchannelRow['state'], at: number): EtherchannelRow => ({
  key: port, port, group: 1, bundle: PO1, protocol: 'lacp', mode: 'active', state, updatedAt: at,
});
const bridgeRow = (vlan: number, at: number): StpBridgeRow => ({
  key: vlanKey(vlan), vlan, mode: 'pvst', bridgeId: `${32768 + vlan}/02:00:00:00:00:01`, rootId: `${32768 + vlan}/02:00:00:00:00:01`, isRoot: true,
  rootCost: 0, helloS: 2, maxAgeS: 20, forwardDelayS: 15, topologyChanges: 0, updatedAt: at,
});
const stpRow = (vlan: number, port: PortId, state: StpPortRow['state'], at: number): StpPortRow => ({
  key: stpKey(vlan, port), vlan, port, role: 'designated', state, protocol: 'stp', cost: 19, portId: '128.1',
  designatedBridge: `${32768 + vlan}/02:00:00:00:00:01`, designatedPort: '128.1', edge: false, stateSince: at, updatedAt: at,
});
const dtpRow = (port: PortId, oper: DtpRow['oper'], at: number): DtpRow => ({ key: port, port, admin: 'dynamic-auto', oper, status: 'negotiated', updatedAt: at });

const l2Changed = (h: P2Harness, from: ProcessName, what: 'vlans' | 'trunk' | 'channel' | 'stp', at: number, port?: PortId, vlan?: number) =>
  h.device.applyActions(from, [{ type: 'l2Changed', what, ...(port !== undefined ? { port } : {}), ...(vlan !== undefined ? { vlan } : {}) }], at);

describe('the VLAN-aware SVI rule (§3.0)', () => {
  it('needs the VLAN to exist: Vlan10 stays down with vlan-missing and logs why; Vlan1 is implicit', () => {
    const { h, at } = sw();
    const vlan10 = svi(h, 10);
    expect(vlan10.adminUp).toBe(true);
    expect(vlan10.operUp).toBe(false);
    expect(logs(h)).toEqual(['Interface Vlan10 administratively enabled', 'Interface Vlan10 stays down: VLAN 10 does not exist.']);
    h.events.length = 0;
    const vlan1 = svi(h, 1);
    expect(logs(h)).toEqual(['Interface Vlan1 administratively enabled']);
    linkUp(h, FA1, at);
    expect(vlan1.operUp).toBe(true);
    expect(vlan10.operUp).toBe(false);
    expect(portStates(h)).toEqual([['Vlan1', false, 'admin-up'], ['Vlan1', true, undefined]]);
  });

  it('comes up with a vlans row and an up access port in the VLAN, and reports no-bridged-port-up once the carrier leaves', () => {
    const { h, at } = sw();
    const vlan10 = svi(h, 10);
    linkUp(h, FA2, at);
    h.device.tables.get<VlanRow>('vlans')?.set(vlanRow(10, at));
    h.events.length = 0;
    // the config line itself is a recompute site (no l2Changed from the fakes)
    expect(cfg(h, [['interface', FA2]], 'switchport access vlan 10')).toEqual({ ok: true });
    expect(vlan10.operUp).toBe(true);
    expect(h.events.map((e) => e.kind)).toEqual(['configChange', 'portState']);
    expect(portStates(h)).toEqual([['Vlan10', true, undefined]]);

    h.events.length = 0;
    cfg(h, [['interface', FA2]], 'switchport access vlan 20');
    expect(vlan10.operUp).toBe(false);
    expect(portStates(h)).toEqual([['Vlan10', false, 'no-bridged-port-up']]);

    cfg(h, [['interface', FA2]], 'switchport access vlan 10');
    expect(vlan10.operUp).toBe(true);
    h.events.length = 0;
    h.device.tables.get('vlans')?.delete(vlanKey(10));
    l2Changed(h, 'vlan', 'vlans', at + 1, undefined, 10);
    expect(vlan10.operUp).toBe(false);
    expect(portStates(h)).toEqual([['Vlan10', false, 'vlan-missing']]);
  });

  it('sees a row the vlan daemon wrote while handling the `vlan 10` line, right after that line', () => {
    const { h, at } = sw(L2, {
      vlan: {
        onConfig: (ctx, delta) => {
          if (delta.op === 'set' && delta.context.length === 0 && delta.line[0] === 'vlan') ctx.tables.get<VlanRow>('vlans')?.set(vlanRow(Number(delta.line[1]), ctx.now));
          return [];
        },
      },
    });
    const vlan10 = svi(h, 10);
    linkUp(h, FA2, at);
    cfg(h, [['interface', FA2]], 'switchport access vlan 10');
    expect(vlan10.operUp).toBe(false);
    h.events.length = 0;
    expect(cfg(h, [], 'vlan 10')).toEqual({ ok: true });
    expect(vlan10.operUp).toBe(true);
    expect(h.events.map((e) => e.kind)).toEqual(['tableWrite', 'configChange', 'portState']);
    expect(VIRTUAL_RECOMPUTE_KEYS).toEqual(['switchport', 'vlan', 'channel-group', 'encapsulation', 'spanning-tree']);
  });

  it('a trunk carries the VLANs it allows; a dynamic port carries them once its dtp row says trunk', () => {
    const { h, at } = sw();
    const vlan10 = svi(h, 10);
    h.device.tables.get<VlanRow>('vlans')?.set(vlanRow(10, at));
    linkUp(h, FA3, at);
    cfg(h, [['interface', FA3]], 'switchport mode trunk');
    expect(vlan10.operUp).toBe(true); // every VLAN allowed by default
    cfg(h, [['interface', FA3]], 'switchport trunk allowed vlan 20,30');
    expect(vlan10.operUp).toBe(false);
    cfg(h, [['interface', FA3]], 'switchport trunk allowed vlan 10,20');
    expect(vlan10.operUp).toBe(true);
    cfg(h, [['interface', FA3]], 'switchport mode access');
    expect(vlan10.operUp).toBe(false); // access VLAN 1

    // Gi0/1 stays dynamic auto: access until DTP negotiated a trunk
    linkUp(h, GI1, at + 1);
    expect(vlan10.operUp).toBe(false);
    h.device.tables.get<DtpRow>('dtp')?.set(dtpRow(GI1, 'trunk', at + 1));
    l2Changed(h, 'dtp', 'trunk', at + 1, GI1);
    expect(vlan10.operUp).toBe(true);
    h.device.tables.get<DtpRow>('dtp')?.set(dtpRow(GI1, 'access', at + 2));
    l2Changed(h, 'dtp', 'trunk', at + 2, GI1);
    expect(vlan10.operUp).toBe(false);
  });

  it('with spanning tree running for the VLAN the carrier must be forwarding', () => {
    const { h, at } = sw();
    const vlan10 = svi(h, 10);
    h.device.tables.get<VlanRow>('vlans')?.set(vlanRow(10, at));
    linkUp(h, FA2, at);
    cfg(h, [['interface', FA2]], 'switchport access vlan 10');
    expect(vlan10.operUp).toBe(true);

    h.device.tables.get<StpBridgeRow>('stp-bridge')?.set(bridgeRow(10, at));
    h.device.tables.get<StpPortRow>('stp')?.set(stpRow(10, FA2, 'learning', at));
    h.events.length = 0;
    l2Changed(h, 'stp', 'stp', at + 1, FA2, 10);
    expect(vlan10.operUp).toBe(false);
    expect(portStates(h)).toEqual([['Vlan10', false, 'no-bridged-port-up']]);

    h.device.tables.get<StpPortRow>('stp')?.set(stpRow(10, FA2, 'forwarding', at + 2));
    l2Changed(h, 'stp', 'stp', at + 2, FA2, 10);
    expect(vlan10.operUp).toBe(true);

    // no stp row at all for a VLAN with an instance: not a spanning-tree port
    h.device.tables.get('stp')?.delete(stpKey(10, FA2));
    l2Changed(h, 'stp', 'stp', at + 3, FA2, 10);
    expect(vlan10.operUp).toBe(false);
    // the `spanning-tree` line is a recompute site too
    h.device.tables.get<StpPortRow>('stp')?.set(stpRow(10, FA2, 'forwarding', at + 4));
    expect(cfg(h, [['interface', FA2]], 'spanning-tree portfast')).toEqual({ ok: true });
    expect(vlan10.operUp).toBe(true);
  });
});

describe('Port-channels and bundle members (§3.0, §3.7)', () => {
  it('a Port-channel is up while a bundled member is up; its members never count as SVI carriers themselves', () => {
    const { h, at } = sw();
    expect(cfg(h, [], `interface ${PO1}`)).toEqual({ ok: true });
    const po1 = h.device.port(PO1) as PortState;
    expect(po1.role).toBe('channel');
    expect(po1.adminUp).toBe(true);
    expect(po1.operUp).toBe(false);
    const vlan1 = svi(h, 1);
    linkUp(h, FA5, at);
    expect(vlan1.operUp).toBe(true); // Fa0/5 is an ordinary access port so far
    h.device.tables.get<EtherchannelRow>('etherchannel')?.set(memberRow(FA5, 'bundled', at));
    h.events.length = 0;
    l2Changed(h, 'etherchannel', 'channel', at + 1, FA5);
    expect(po1.operUp).toBe(true);
    expect(vlan1.operUp).toBe(true); // now through Port-channel1 (a bridged port that carries VLAN 1)
    expect(portStates(h)).toEqual([[PO1, true, undefined]]);

    // the bundle's own configuration decides what it carries
    cfg(h, [['interface', PO1]], 'switchport mode trunk');
    cfg(h, [['interface', PO1]], 'switchport trunk allowed vlan 10');
    expect(vlan1.operUp).toBe(false);
    cfg(h, [['interface', PO1]], 'switchport trunk allowed vlan 1,10');
    expect(vlan1.operUp).toBe(true);

    // a suspended member neither bundles nor carries; an individual one carries on its own
    h.device.tables.get<EtherchannelRow>('etherchannel')?.set(memberRow(FA5, 'suspended', at + 2));
    h.events.length = 0;
    l2Changed(h, 'etherchannel', 'channel', at + 2, FA5);
    expect(po1.operUp).toBe(false);
    expect(vlan1.operUp).toBe(false);
    // net changes are reported in Map order (Vlan family before Port-channel family), with no flap in between
    expect(portStates(h)).toEqual([['Vlan1', false, 'no-bridged-port-up'], [PO1, false, 'no-bundled-member']]);
    h.device.tables.get<EtherchannelRow>('etherchannel')?.set(memberRow(FA5, 'individual', at + 3));
    l2Changed(h, 'etherchannel', 'channel', at + 3, FA5);
    expect(po1.operUp).toBe(false);
    expect(vlan1.operUp).toBe(true);

    // the `channel-group` line is a recompute site: the member comes back bundled
    h.device.tables.get<EtherchannelRow>('etherchannel')?.set(memberRow(FA5, 'bundled', at + 4));
    expect(cfg(h, [['interface', FA5]], 'channel-group 1 mode active')).toEqual({ ok: true });
    expect(po1.operUp).toBe(true);
    linkUp(h, FA5, at + 5, false);
    expect(po1.operUp).toBe(false);
  });
});

describe('devices that are not VLAN-aware keep the P1 rule', () => {
  it('Vlan10 reports vlan-unsupported with the P1 wording, Vlan1 follows any bridged port', () => {
    const { h, at } = sw(['eth-switch']);
    const vlan10 = svi(h, 10);
    expect(vlan10.operUp).toBe(false);
    expect(logs(h)).toEqual(['Interface Vlan10 administratively enabled', 'Interface Vlan10 stays down: only VLAN 1 is available in this release.']);
    const vlan1 = svi(h, 1);
    linkUp(h, FA1, at);
    expect(vlan1.operUp).toBe(true);
    expect(vlan10.operUp).toBe(false);
    // a Port-channel without etherchannel rows has no bundled member anywhere
    cfg(h, [], `interface ${PO1}`);
    expect(h.device.port(PO1)?.operUp).toBe(false);
  });
});

describe('setPortL3 virtual4 (D15)', () => {
  const VIP: VirtualIpv4 = { address: '192.168.1.1', mac: '00:00:0c:9f:f0:01', owner: 'hsrp', local: true };
  const POOL: VirtualIpv4 = { address: '203.0.113.20', mac: '02:00:00:00:00:01', owner: 'nat', local: false };

  it('merges like the other members: a value replaces with a copy, undefined keeps, null clears', () => {
    const { h, at } = sw(['eth-switch']);
    const port = h.device.port(FA1) as PortState;
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, ipv4: { address: '10.0.0.1', prefixLen: 24 } }], at);
    const given = [VIP, POOL];
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, virtual4: given }], at);
    expect(port.l3).toEqual({ ipv4: { address: '10.0.0.1', prefixLen: 24 }, virtual4: [VIP, POOL] });
    expect(port.l3.virtual4).not.toBe(given);
    expect(port.l3.virtual4?.[0]).not.toBe(VIP);
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, ipv6Enabled: true }], at);
    expect(port.l3.virtual4).toEqual([VIP, POOL]);
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, virtual4: [VIP] }], at);
    expect(port.l3.virtual4).toEqual([VIP]);
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, virtual4: null }], at);
    expect(port.l3).toEqual({ ipv4: { address: '10.0.0.1', prefixLen: 24 }, ipv6Enabled: true });
  });

  it('isLocalDestination accepts a local virtual address on an up port, never an ARP-only one', () => {
    const { h, at, ctx } = sw(['eth-switch']);
    const c = ctx('eth-switch') as ProcessCtx;
    const port = h.device.port(FA1) as PortState;
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, ipv4: { address: '192.168.1.2', prefixLen: 24 }, virtual4: [VIP, POOL] }], at);
    expect(c.isLocalDestination(VIP.address)).toBe(false); // the port is down
    linkUp(h, FA1, at);
    expect(c.isLocalDestination(VIP.address)).toBe(true);
    expect(c.isLocalDestination(VIP.address, FA1)).toBe(true);
    expect(c.isLocalDestination(POOL.address)).toBe(false);
    expect(c.ownAddress(VIP.address)).toBeUndefined();
    port.operUp = false;
    expect(c.isLocalDestination(VIP.address)).toBe(false);
  });
});
