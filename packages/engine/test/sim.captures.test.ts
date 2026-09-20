/**
 * P1 W6 sim: the live capture methods of the Simulation facade (ARCHITECTURE-P1 §4.12; §10.2 rows
 * `netscope-filter` and `pcapng-export`; contracts/capture.ts).
 *
 * A real PC–router lab browses a real web server while a capture runs on PC1's NIC, so every record comes from the
 * link model's tap, not from a fixture. Checked: capture ids and interfaces, display-filter queries, record detail,
 * follow stream, the statistics hierarchy, pcapng and classic pcap exports (byte-identical over three separate
 * runs with the default `baseWallNs`), the mixed-link-type refusal, stop / remove and the refusals for unknown ids.
 */
import { describe, expect, it } from 'vitest';
import { PCAPNG_BYTE_ORDER_MAGIC, PCAPNG_SHB_TYPE, PCAP_MAGIC_NS, readCapture } from '../src/io/pcap.js';
import { PCAP_MIXED_LINKTYPE_MESSAGE } from '../src/contracts/capture.js';
import type { CaptureRow } from '../src/contracts/capture.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { pcRouterPc, serialPair, twoPcsAndSwitch } from '../src/sim/scenarios.js';
import { booted, ping } from './sim.harness.js';

/** R1 serves the page PC1 will fetch. */
const ROUTER_SERVICES: readonly string[] = ['ip http server'];

const PC1_NIC = { device: 'pc1', port: 'GigabitEthernet0' } as const;

function configured(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  if (!r.ok) throw new Error(`${device} setup failed: ${JSON.stringify(r.lines.filter((l) => !l.ok))}`);
}

/** A booted lab where PC1 has fetched R1's page with a capture running on its NIC. */
function browsed(seed = 5): { sim: Simulation; id: string } {
  const sim = booted(pcRouterPc(), seed);
  configured(sim, 'r1', ROUTER_SERVICES);
  sim.runToIdle();
  const id = sim.startCapture!({ ports: [PC1_NIC], name: 'PC1 NIC' });
  sim.hostRequest!('pc1', { app: 'http.get', url: 'http://10.0.0.254/' });
  sim.runToIdle();
  return { sim, id };
}

/** Every row of a capture that matches `filter`. */
function rows(sim: Simulation, id: string, filter?: string): CaptureRow[] {
  const out: CaptureRow[] = [];
  let from = 0;
  for (;;) {
    const page = sim.queryCapture!(id, filter === undefined ? { from, limit: 200 } : { filter, from, limit: 200 });
    expect(page.filterError).toBeUndefined();
    out.push(...page.rows);
    if (page.next === from || page.rows.length === 0) break;
    from = page.next;
    if (from >= sim.captures!().find((c) => c.id === id)!.head) break;
  }
  return out;
}

describe('captures: starting and listing', () => {
  it('numbers live captures c_<n> and types the interface from the port encapsulation', () => {
    const { sim, id } = browsed();
    expect(id).toBe('c_1');
    const info = sim.captures!();
    expect(info.length).toBe(1);
    expect(info[0]!.source).toBe('live');
    expect(info[0]!.running).toBe(true);
    expect(info[0]!.name).toBe('PC1 NIC');
    expect(info[0]!.interfaces[0]).toMatchObject({ index: 0, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 });
    expect(info[0]!.head).toBeGreaterThan(0);

    // A second capture gets the next id, and a whole-world capture takes every port.
    const all = sim.startCapture!({});
    expect(all).toBe('c_2');
    expect(sim.captures!().find((c) => c.id === all)!.interfaces.length).toBeGreaterThan(1);
  });

  it('refuses a capture point that does not exist', () => {
    const sim = booted(twoPcsAndSwitch(), 2);
    expect(() => sim.startCapture!({ ports: [{ device: 'pc1', port: 'GigabitEthernet9' }] })).toThrow(/GigabitEthernet9/);
    expect(() => sim.startCapture!({ links: ['l_nope'] })).toThrow(/l_nope/);
  });

  it('records both directions of the traffic that crossed the port', () => {
    const { sim, id } = browsed();
    const all = rows(sim, id);
    expect(all.some((r) => r.dir === 'tx')).toBe(true);
    expect(all.some((r) => r.dir === 'rx')).toBe(true);
    expect(all.every((r) => r.iface === 0)).toBe(true);
  });
});

describe('captures: display filters and detail', () => {
  it('tcp.flags.syn == 1 returns exactly the SYN and the SYN-ACK', () => {
    const { sim, id } = browsed();
    const syn = rows(sim, id, 'tcp.flags.syn == 1');
    expect(syn.length).toBe(2);
    expect(rows(sim, id, 'ip.addr == 10.0.0.254 && tcp.flags.syn == 1').length).toBe(2);
    expect(rows(sim, id, 'tcp').length).toBeGreaterThan(syn.length);
  });

  it('reports an invalid filter with its column instead of throwing', () => {
    const { sim, id } = browsed();
    const page = sim.queryCapture!(id, { filter: 'tcp.flags.syn ==', from: 0, limit: 10 });
    expect(page.rows).toEqual([]);
    expect(page.filterError?.message).toBeTruthy();
    expect(page.filterError?.column).toBeGreaterThanOrEqual(0);
  });

  it('captureRecord decodes one frame down to its bytes', () => {
    const { sim, id } = browsed();
    const first = rows(sim, id, 'tcp.flags.syn == 1')[0]!;
    const detail = sim.captureRecord!(id, first.index)!;
    expect(detail.row.index).toBe(first.index);
    expect(detail.bytes.length).toBeGreaterThan(0);
    expect(detail.layers.map((l) => l.proto)).toEqual(expect.arrayContaining(['ethernet', 'ipv4', 'tcp']));
    expect(sim.captureRecord!(id, 99_999)).toBeUndefined();
  });
});

describe('captures: follow stream and statistics', () => {
  it('follow stream reassembles the request and the response', () => {
    const { sim, id } = browsed();
    const key = rows(sim, id, 'tcp').find((r) => r.stream !== undefined)!.stream!;
    const follow = sim.followStream!(id, key);
    expect(follow.key).toBe(key);
    expect(follow.proto).toBe('tcp');
    const text = follow.chunks.map((c) => c.text).join('');
    expect(text).toContain('GET / HTTP/1.1');
    expect(text).toContain('HTTP/1.1 200');
    expect(follow.http?.map((m) => m.kind)).toEqual(['request', 'response']);
  });

  it('the statistics hierarchy walks ethernet → ipv4 → tcp → http', () => {
    const { sim, id } = browsed();
    const stats = sim.captureStats!(id);
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
    const paths = stats.hierarchy.map((h) => h.path);
    expect(paths).toContain('ethernet');
    expect(paths).toContain('ethernet/ipv4');
    expect(paths).toContain('ethernet/ipv4/tcp');
    expect(paths.some((p) => p.endsWith('/http'))).toBe(true);
    // A filter narrows the same computation.
    expect(sim.captureStats!(id, 'tcp.flags.syn == 1').total).toBe(2);
  });
});

describe('captures: export', () => {
  it('writes pcapng with the SHB magic, the byte-order magic and one EPB per record', () => {
    const { sim, id } = browsed();
    const bytes = sim.exportCapture!(id, { format: 'pcapng' });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(PCAPNG_SHB_TYPE);
    expect(view.getUint32(8, true)).toBe(PCAPNG_BYTE_ORDER_MAGIC);

    const back = readCapture(bytes);
    expect(back.interfaces[0]).toMatchObject({ linkType: 'ethernet', fcsLen: 4 });
    expect(back.records.length).toBe(sim.captures!()[0]!.head);
    // Re-importing and re-exporting gives the same bytes again.
    expect(Array.from(bytes)).toEqual(Array.from(sim.exportCapture!(id, { format: 'pcapng', baseWallNs: 0n })));
  });

  it('is byte-identical over three separate runs with the default wall-clock base', () => {
    const exports = [1, 2, 3].map(() => {
      const { sim, id } = browsed();
      return Array.from(sim.exportCapture!(id, { format: 'pcapng' }));
    });
    expect(exports[1]).toEqual(exports[0]);
    expect(exports[2]).toEqual(exports[0]);
    expect(exports[0]!.length).toBeGreaterThan(0);
  });

  it('classic pcap uses the nanosecond magic and refuses a mixed-link-type capture', () => {
    const { sim, id } = browsed();
    const bytes = sim.exportCapture!(id, { format: 'pcap' });
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)).toBe(PCAP_MAGIC_NS);

    const serial = booted(serialPair(), 4);
    const mixed = serial.startCapture!({ ports: [{ device: 'r1', port: 'GigabitEthernet0/0' }, { device: 'r1', port: 'Serial0/0/0' }] });
    expect(serial.captures!()[0]!.interfaces.map((i) => i.linkType)).toEqual(['ethernet', 'c_hdlc']);
    expect(() => serial.exportCapture!(mixed, { format: 'pcap' })).toThrow(PCAP_MIXED_LINKTYPE_MESSAGE);
    expect(serial.exportCapture!(mixed, { format: 'pcapng' }).length).toBeGreaterThan(0);
  });

  it('an export filter that does not compile is reported, not written', () => {
    const { sim, id } = browsed();
    expect(() => sim.exportCapture!(id, { format: 'pcapng', filter: 'tcp.flags.syn ==' })).toThrow(/not valid/);
  });
});

describe('captures: lifecycle', () => {
  it('stopCapture keeps the records but takes the port off the tap', () => {
    const sim = booted(pcRouterPc(), 6);
    const id = sim.startCapture!({ ports: [PC1_NIC] });
    ping(sim, 'pc1', '10.0.0.254');
    const recorded = sim.captures!()[0]!.head;
    expect(recorded).toBeGreaterThan(0);

    sim.stopCapture!(id);
    expect(sim.captures!()[0]!.running).toBe(false);
    ping(sim, 'pc1', '10.0.0.254');
    expect(sim.captures!()[0]!.head).toBe(recorded);
  });

  it('removeCapture forgets it, and every method refuses an unknown id', () => {
    const { sim, id } = browsed();
    sim.removeCapture!(id);
    expect(sim.captures!()).toEqual([]);
    expect(() => sim.queryCapture!(id, { from: 0, limit: 1 })).toThrow(/c_1/);
    expect(() => sim.captureRecord!(id, 0)).toThrow(/c_1/);
    expect(() => sim.followStream!(id, 'tcp:x')).toThrow(/c_1/);
    expect(() => sim.captureStats!(id)).toThrow(/c_1/);
    expect(() => sim.exportCapture!(id, { format: 'pcapng' })).toThrow(/c_1/);
    expect(() => sim.stopCapture!(id)).toThrow(/c_1/);
    expect(() => sim.removeCapture!(id)).toThrow(/c_1/);
  });

  it('captures die with the world, and the id counter keeps counting', () => {
    const { sim } = browsed();
    sim.loadTopology(twoPcsAndSwitch());
    expect(sim.captures!()).toEqual([]);
    expect(sim.startCapture!({ ports: [PC1_NIC] })).toBe('c_2');
  });
});
