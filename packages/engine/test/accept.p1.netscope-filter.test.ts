/**
 * P1 acceptance — NetScope display filters on a live capture (ARCHITECTURE-P1 §10.2 `accept.p1.netscope-filter`;
 * §4.12, §7; contracts/capture.ts).
 *
 * One real lab: PC1 takes a lease from R1 (192.168.1.80), which is also the lab's name server and web server. A
 * capture runs on PC1's NIC while PC1 browses `http://www.lab.nf/`, so every record below came off the link model's
 * tap — no hand-built frames anywhere.
 *
 * Checked on that capture: `tcp.flags.syn == 1` returns exactly the SYN and the SYN-ACK; adding
 * `ip.addr == 192.168.1.80` returns the same two; an unfinished filter is reported with the column it broke at
 * instead of throwing; completion after a `tcp.fl` prefix offers the `tcp.flags.*` fields; follow stream shows the
 * request and the response as text; and the statistics hierarchy walks ethernet → ipv4 → tcp → http.
 *
 * ponytail: the browse is driven by `hostRequest`, the same entry point the GUI uses, so the capture holds exactly
 * what a student would see after clicking Go — the DHCP exchange is over before the capture starts.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureRow } from '../src/contracts/capture.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { TOPOLOGY_SCHEMA_ID, type Topology } from '../src/contracts/topology.js';
import { completeDisplayFilter } from '../src/capture/filter/complete.js';
import { lookupDisplayField } from '../src/capture/filter/fields.js';
import { createSimulation } from '../src/sim/simulation.js';
import { BOOT_NS } from './sim.harness.js';
import { MASK24, cable, configText, device, section } from './accept.p05.harness.js';

const SEED = 5;
const PC1_NIC = { device: 'pc1', port: 'GigabitEthernet0' } as const;
/** The lab server: gateway, DHCP server, name server and web server in one. */
const SERVER_IP = '192.168.1.80';
const SITE = 'www.lab.nf';
const PAGE = 'The lab web page of this exercise.';

/** R1 hands out the LAN, answers for the lab zone and serves one page. */
const ROUTER_SERVICES: readonly string[] = [
  'ip dhcp excluded-address 192.168.1.80 192.168.1.99',
  'ip dhcp pool LAN',
  `network 192.168.1.0 ${MASK24}`,
  `default-router ${SERVER_IP}`,
  `dns-server ${SERVER_IP}`,
  'domain-name lab.nf',
  'exit',
  'ip dns server',
  `ip host ${SITE} ${SERVER_IP}`,
  'ip http server',
  `ip http page / ${PAGE}`,
];

/** PC1 (DHCP client) cabled straight to R1 Gi0/0 (192.168.1.80/24). */
function lanTopology(): Topology {
  return {
    schema: TOPOLOGY_SCHEMA_ID,
    seed: 1,
    devices: [
      device('pc1', 'pc.nfpc', 'PC1', 100, 300, configText([['hostname PC1']])),
      device(
        'r1',
        'router.nf2911',
        'R1',
        300,
        300,
        configText([['hostname R1'], section('interface GigabitEthernet0/0', [`ip address ${SERVER_IP} ${MASK24}`, 'no shutdown'])]),
      ),
    ],
    links: [cable('l_pc1_r1', 'pc1', 'GigabitEthernet0', 'r1', 'GigabitEthernet0/0')],
  };
}

/** A booted lab in which PC1 holds a lease, a capture runs on its NIC, and it has browsed the lab site. */
function browsed(seed = SEED): { sim: Simulation; id: string } {
  const sim = createSimulation({ seed });
  sim.loadTopology(lanTopology());
  sim.runFor(BOOT_NS);
  const r = sim.configure('r1', ROUTER_SERVICES);
  expect(r.lines.filter((l) => !l.ok)).toEqual([]);
  const session = sim.cli.open('pc1', 'console');
  expect(sim.cli.exec(session, 'ip address dhcp').error).toBeUndefined();
  sim.runToIdle();
  expect(sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4?.origin).toBe('dhcp');

  // Only the browse is captured: the lease is already in place.
  const id = sim.startCapture!({ ports: [PC1_NIC], name: 'PC1 NIC' });
  sim.hostRequest!('pc1', { app: 'http.get', url: `http://${SITE}/` });
  sim.runToIdle();
  return { sim, id };
}

/** Every row of a capture that matches `filter`, paged the way the list pane pages. */
function rows(sim: Simulation, id: string, filter?: string): CaptureRow[] {
  const head = sim.captures!().find((c) => c.id === id)!.head;
  const out: CaptureRow[] = [];
  for (let from = 0; from < head; ) {
    const page = sim.queryCapture!(id, filter === undefined ? { from, limit: 100 } : { filter, from, limit: 100 });
    expect(page.filterError, filter).toBeUndefined();
    out.push(...page.rows);
    if (page.next <= from) break;
    from = page.next;
  }
  return out;
}

/** `<proto> <info>` of each row, for readable failures. */
const describeRows = (list: readonly CaptureRow[]): string[] => list.map((r) => `${r.proto} ${r.info}`);

describe('accept P1: NetScope on a live capture of a browse', () => {
  it('captured the whole browse on PC1 Gi0, in both directions', () => {
    const { sim, id } = browsed();
    const info = sim.captures!().find((c) => c.id === id)!;
    expect(info.interfaces).toEqual([{ index: 0, ref: PC1_NIC, name: 'PC1 Gi0', linkType: 'ethernet', fcsLen: 4 }]);
    const all = rows(sim, id);
    expect(all.length).toBe(info.head);
    expect(all.some((r) => r.dir === 'tx')).toBe(true);
    expect(all.some((r) => r.dir === 'rx')).toBe(true);
    // A browse by name: the resolver asked first, then the page was fetched.
    expect(describeRows(all).some((s) => s.startsWith('dns'))).toBe(true);
    expect(describeRows(all).some((s) => s.startsWith('http'))).toBe(true);
  });

  it('tcp.flags.syn == 1 returns exactly the SYN and the SYN-ACK', () => {
    const { sim, id } = browsed();
    const syn = rows(sim, id, 'tcp.flags.syn == 1');
    expect(describeRows(syn).length).toBe(2);
    // The first is PC1's SYN, the second the server's SYN-ACK; the ACK of the handshake is not among them.
    expect(syn.map((r) => r.dir)).toEqual(['tx', 'rx']);
    expect(syn.map((r) => r.proto)).toEqual(['tcp', 'tcp']);
    expect(syn[0]!.src).toContain(sim.device('pc1')!.port('GigabitEthernet0')!.l3.ipv4!.address);
    expect(syn[1]!.src).toContain(SERVER_IP);
    expect(syn[0]!.index).toBeLessThan(syn[1]!.index);
    expect(rows(sim, id, 'tcp').length).toBeGreaterThan(2);
  });

  it(`ip.addr == ${SERVER_IP} && tcp.flags.syn == 1 returns the same two frames`, () => {
    const { sim, id } = browsed();
    const syn = rows(sim, id, 'tcp.flags.syn == 1');
    const both = rows(sim, id, `ip.addr == ${SERVER_IP} && tcp.flags.syn == 1`);
    expect(both.map((r) => r.index)).toEqual(syn.map((r) => r.index));
    // The conjunction really narrows: the address alone matches more than the handshake.
    expect(rows(sim, id, `ip.addr == ${SERVER_IP}`).length).toBeGreaterThan(both.length);
  });

  it('reports an invalid filter with the column it broke at, and matches nothing', () => {
    const { sim, id } = browsed();
    const text = 'ip.addr == 192.168.1.80 && tcp.flags.syn ==';
    const page = sim.queryCapture!(id, { filter: text, from: 0, limit: 50 });
    expect(page.rows).toEqual([]);
    expect(page.matched).toBe(0);
    const error = page.filterError!;
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.column).toBe(text.length);
    expect(error.length).toBeGreaterThanOrEqual(0);
    // A second broken filter points at its own mistake, not at the end of the text.
    const other = sim.queryCapture!(id, { filter: 'tcp.flags.syn == && ip', from: 0, limit: 50 }).filterError!;
    expect(other.column).toBeLessThan(text.length);
  });

  it('completion offers the tcp.flags.* fields for a prefix, and replaces the typed word', () => {
    const typed = `ip.addr == ${SERVER_IP} && tcp.fl`;
    const c = completeDisplayFilter(typed);
    expect(c.from).toBe(typed.length - 'tcp.fl'.length);
    expect(c.to).toBe(typed.length);
    const labels = c.items.map((i) => i.label);
    for (const f of ['tcp.flags', 'tcp.flags.syn', 'tcp.flags.ack', 'tcp.flags.fin', 'tcp.flags.rst']) expect(labels).toContain(f);
    expect(labels.every((l) => l.startsWith('tcp.fl'))).toBe(true);
    expect(c.items.every((i) => i.kind === 'field' && i.help.length > 0)).toBe(true);

    // Every offered label is a real display field, and the flag fields the capture accepts are the boolean ones.
    const { sim, id } = browsed();
    for (const label of labels) {
      const def = lookupDisplayField(label);
      expect(def, label).toBeDefined();
      const filter = def!.type === 'bool' ? `${label} == 1` : `${label} contains "S"`;
      expect(sim.queryCapture!(id, { filter, from: 0, limit: 1 }).filterError, filter).toBeUndefined();
    }
    expect(rows(sim, id, 'tcp.flags.syn == 1').length).toBe(2);
  });

  it('follow stream shows the request and the response text of the browse', () => {
    const { sim, id } = browsed();
    const key = rows(sim, id, 'tcp').find((r) => r.stream !== undefined)!.stream!;
    const follow = sim.followStream!(id, key);
    expect(follow.key).toBe(key);
    expect(follow.proto).toBe('tcp');
    expect(follow.endpoints.some((e) => e.includes(SERVER_IP))).toBe(true);
    const text = follow.chunks.map((c) => c.text).join('');
    expect(text).toContain(`GET / HTTP/1.1`);
    expect(text).toContain(`Host: ${SITE}`);
    expect(text).toContain('HTTP/1.1 200');
    expect(text).toContain(PAGE);
    // Both directions are present and in order: the client chunk comes before the server's.
    expect(follow.chunks.map((c) => c.from)).toContain(0);
    expect(follow.chunks.map((c) => c.from)).toContain(1);
    expect(follow.http?.map((m) => m.kind)).toEqual(['request', 'response']);
    expect(follow.http![0]!.startLine).toBe('GET / HTTP/1.1');
    expect(follow.http![1]!.body).toContain(PAGE);
  });

  it('the statistics hierarchy includes ethernet, ipv4, tcp and http', () => {
    const { sim, id } = browsed();
    const stats = sim.captureStats!(id);
    expect(stats.total).toBe(sim.captures!().find((c) => c.id === id)!.head);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.durationNs).toBeGreaterThan(0);
    const paths = stats.hierarchy.map((h) => h.path);
    expect(paths).toContain('ethernet');
    expect(paths).toContain('ethernet/ipv4');
    expect(paths).toContain('ethernet/ipv4/tcp');
    expect(paths).toContain('ethernet/ipv4/tcp/http');
    // Every level counts at least the frames of the level below it.
    const frames = (path: string): number => stats.hierarchy.find((h) => h.path === path)!.frames;
    expect(frames('ethernet')).toBeGreaterThanOrEqual(frames('ethernet/ipv4'));
    expect(frames('ethernet/ipv4')).toBeGreaterThanOrEqual(frames('ethernet/ipv4/tcp'));
    expect(frames('ethernet/ipv4/tcp')).toBeGreaterThanOrEqual(frames('ethernet/ipv4/tcp/http'));
    // The same computation under a filter counts only the handshake.
    expect(sim.captureStats!(id, 'tcp.flags.syn == 1').total).toBe(2);
    // The browse is one conversation between PC1 and the server.
    expect(stats.conversations.some((c) => c.proto === 'tcp' && [c.a, c.b].some((e) => e.includes(SERVER_IP)))).toBe(true);
  });
});
