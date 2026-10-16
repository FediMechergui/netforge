/**
 * P3c acceptance [C32] (ARCHITECTURE-P3C D11, §7 W0h "sim + web-shell", §9.2 W0h item 7, §10.1 row
 * `accept.p3c.demux-and-vlan-filter`):
 *   (b) `TraceFilter.vlans` selects exactly the events whose `PduSummary.vlan` is listed — on a live trunk world with
 *       two VLANs, through `matchesTraceFilter`, `Simulation.traceQuery` and a `stepToNext` breakpoint;
 *   (a) with `DemuxSelector.frame` deleted (the contract member and capwap-wtp's `handles` entry, in one change), the
 *       P2 worlds that run capwap-wtp — the WLC lab `ccna2-wlc-wlan` and the P2 sandbox (NF-AP-1832 + NF-WLC-9800) —
 *       still equal test/goldens/p2-profile-digests.json exactly (the same check as their digest shard,
 *       `accept.p3.p2-digests-labs-b`); and capwap-wtp's selector is the key-less radio selector.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TraceFilter } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createCapwapWtp } from '../src/protocols/capwap-wtp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { matchesTraceFilter } from '../src/trace/filter.js';
import { freshRun, p2Worlds } from './p2-digests.harness.js';
import { createP2Simulation } from './p2.world.js';
import { ping } from './sim.harness.js';

const TRUNK = 'GigabitEthernet0/1';
const ACCESS10 = 'FastEthernet0/1';
const ACCESS20 = 'FastEthernet0/2';

const switchConfig = (hostname: string): string =>
  configText([
    [`hostname ${hostname}`],
    ['vlan 10'],
    ['vlan 20'],
    section(`interface ${ACCESS10}`, ['switchport mode access', 'switchport access vlan 10']),
    section(`interface ${ACCESS20}`, ['switchport mode access', 'switchport access vlan 20']),
    section(`interface ${TRUNK}`, ['switchport mode trunk']),
  ]);

/** Two managed switches on a static trunk, a PC pair in VLAN 10 and one in VLAN 20; a ping in each VLAN. */
function trunkWorld() {
  const sim = createP2Simulation({ seed: 32, profile: 'P1', factories: { vlan: createVlan, dtp: undefined } });
  sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: switchConfig('SW1') });
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: switchConfig('SW2') });
  const pcs: [string, string, string, string][] = [
    ['pc1', 'PC1', '10.0.10.1', 'sw1'],
    ['pc2', 'PC2', '10.0.10.2', 'sw2'],
    ['pc3', 'PC3', '10.0.20.1', 'sw1'],
    ['pc4', 'PC4', '10.0.20.2', 'sw2'],
  ];
  for (const [id, name, addr, sw] of pcs) {
    sim.addDevice({ id, type: 'pc.nfpc', name, startupConfig: pcConfig(name, addr, '255.255.255.0') });
    sim.addLink({ a: { device: id, port: 'GigabitEthernet0' }, b: { device: sw, port: addr.startsWith('10.0.10.') ? ACCESS10 : ACCESS20 } });
  }
  sim.addLink({ a: { device: 'sw1', port: TRUNK }, b: { device: 'sw2', port: TRUNK } });
  sim.runFor(60 * SEC);
  const head = sim.trace(0).next;
  const p10 = ping(sim, 'pc1', '10.0.10.2');
  const p20 = ping(sim, 'pc3', '10.0.20.2');
  return { sim, head, p10, p20 };
}

/** The VID an event's PduSummary carries, if any (independent of trace/filter.ts). */
function vlanOf(ev: TraceEvent): number | undefined {
  const pdu = (ev as { pdu?: unknown }).pdu;
  return typeof pdu === 'object' && pdu !== null ? (pdu as { vlan?: number }).vlan : undefined;
}

const isBackground = (ev: TraceEvent): boolean => (ev.kind === 'frameTx' || ev.kind === 'drop') && ev.background === true;

describe('accept P3c [C32]: TraceFilter.vlans and the DemuxSelector.frame deletion', () => {
  it('(b) TraceFilter.vlans selects exactly the events whose PduSummary.vlan is listed', () => {
    const { sim, head, p10, p20 } = trunkWorld();
    expect(p10.text).toContain('Sent 5, received 5, lost 0');
    expect(p20.text).toContain('Sent 5, received 5, lost 0');

    const all = sim.trace(0).events;
    const tagged = all.filter((e) => vlanOf(e) !== undefined);
    // both VLANs crossed the trunk tagged
    expect(tagged.filter((e) => vlanOf(e) === 10).length).toBeGreaterThanOrEqual(10);
    expect(tagged.filter((e) => vlanOf(e) === 20).length).toBeGreaterThanOrEqual(10);

    for (const vlans of [[10], [20], [10, 20], [30], []] as number[][]) {
      const f: TraceFilter = { vlans, includeBackground: true };
      const want = all.filter((e) => {
        const v = vlanOf(e);
        return v !== undefined && vlans.includes(v);
      });
      expect(all.filter((e) => matchesTraceFilter(f, e)), `vlans ${vlans.join(',')}`).toEqual(want);
      // the engine's paged query applies the same predicate
      const q = sim.traceQuery({ from: 0, filter: f, limit: all.length + 1 });
      expect(q.events.map((r) => r.event), `traceQuery vlans ${vlans.join(',')}`).toEqual(want);
      // without includeBackground the background frames leave, as for every key
      const fg = all.filter((e) => matchesTraceFilter({ vlans }, e));
      expect(fg).toEqual(want.filter((e) => !isBackground(e)));
    }

    // the ICMP frames tagged 10 are exactly VLAN 10's echoes crossing the trunk
    const echo10 = sim.traceQuery({ from: head, filter: { vlans: [10], kinds: ['frameTx'], protos: ['icmpv4'] }, limit: 1000 });
    expect(echo10.events.length).toBeGreaterThanOrEqual(10);
    for (const r of echo10.events) {
      const ev = r.event as Extract<TraceEvent, { kind: 'frameTx' }>;
      expect(ev.from.port).toBe(TRUNK);
      expect(ev.pdu.vlan).toBe(10);
    }
  });

  it('(b) a breakpoint on a VLAN stops at the first frame tagged with it', () => {
    const sim = createP2Simulation({ seed: 32, profile: 'P1', factories: { vlan: createVlan, dtp: undefined } });
    sim.addDevice({ id: 'sw1', type: 'switch.nfc2960', name: 'SW1', startupConfig: switchConfig('SW1') });
    sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2', startupConfig: switchConfig('SW2') });
    sim.addDevice({ id: 'pc3', type: 'pc.nfpc', name: 'PC3', startupConfig: pcConfig('PC3', '10.0.20.1', '255.255.255.0') });
    sim.addDevice({ id: 'pc4', type: 'pc.nfpc', name: 'PC4', startupConfig: pcConfig('PC4', '10.0.20.2', '255.255.255.0') });
    sim.addLink({ a: { device: 'pc3', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: ACCESS20 } });
    sim.addLink({ a: { device: 'pc4', port: 'GigabitEthernet0' }, b: { device: 'sw2', port: ACCESS20 } });
    sim.addLink({ a: { device: 'sw1', port: TRUNK }, b: { device: 'sw2', port: TRUNK } });
    sim.runFor(60 * SEC);
    const from = sim.trace(0).next;
    const session = sim.cli.open('pc3', 'console');
    sim.cli.exec(session, 'ping 10.0.20.2');
    const stats = sim.stepToNext({ vlans: [20], kinds: ['frameTx'] }, { until: sim.now + 10 * SEC });
    expect(stats.stopped).toBe('breakpoint');
    const ev = stats.stopEvent as Extract<TraceEvent, { kind: 'frameTx' }>;
    expect(ev.kind).toBe('frameTx');
    expect(ev.pdu.vlan).toBe(20);
    expect(ev.from.port).toBe(TRUNK);
    // it is the first frame tagged 20 sent since the ping started (the boot's gratuitous ARPs crossed the trunk earlier)
    expect(stats.stopCursor).toBeDefined();
    const before = sim.trace(from).events.slice(0, stats.stopCursor! - from);
    expect(before.filter((e) => e.kind === 'frameTx' && vlanOf(e) === 20)).toEqual([]);
  });

  it('(a) capwap-wtp claims 802.11 frames on its radios with the key-less selector (no `frame` key)', () => {
    expect(createCapwapWtp().handles).toEqual([{ layer: 'dot11', roles: ['wireless-bss'] }]);
  });

  const golden = JSON.parse(readFileSync(fileURLToPath(new URL('./goldens/p2-profile-digests.json', import.meta.url)), 'utf8')) as {
    worlds: Record<string, unknown>;
  };
  for (const name of ['ccna2-wlc-wlan', 'p2-sandbox-add-device']) {
    it(`(a) ${name}: the P2 digests are unchanged with DemuxSelector.frame removed`, () => {
      const w = p2Worlds().find((x) => x.name === name);
      expect(w, name).toBeDefined();
      const run = freshRun(w!);
      expect(run.refused).toEqual([]);
      expect(run.dropped).toBe(0);
      // the world really runs capwap-wtp (so the deletion is exercised, not skipped)
      expect(run.events.some((e) => (e.kind === 'pduCreated' && e.process === 'capwap-wtp') || (e.kind === 'debug' && e.event.process === 'capwap-wtp'))).toBe(true);
      expect(golden.worlds[name], name).toBeDefined();
      expect(run.entry).toEqual(golden.worlds[name]);
    }, 180_000);
  }
});
