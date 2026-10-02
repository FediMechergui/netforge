/**
 * link.ppp-link — [S19] the `ppp-link` medium op and the `serial-line` medium event in the link facade
 * (ARCHITECTURE-P3 D17, §2.7, §3.9 steps 1, 2, 4 and 6; §7 W2 media; link/link.ts, contracts/medium.ts).
 *
 * On a serial cable whose ends both use `ppp`, each end's line protocol is its ppp daemon's last `ppp-link` report:
 * negotiating until it reports up, then up, or down with the reported reason. The facade keeps a report only for a
 * `ppp` end of a READY line (carrier, clock, one encapsulation), recomputes only when the report changes what the
 * evaluation reads, and forgets the reports when the line stops being ready, so a line that comes back negotiates
 * again. `serial-line {ready}` goes to both ends whenever readiness changes on a link with a `ppp` end, after the
 * `carrier` notifications of the same recompute; an HDLC-only link never sees one. The P2P gate lets PPP control
 * frames leave a `ppp` port that is down only by PPP (`serialControlExempt`), and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId, PortId, PortRef } from '../src/contracts/ids.js';
import { portKey } from '../src/contracts/ids.js';
import type { LinkModelDeps, LinkSpec, PortPhySettings } from '../src/contracts/link.js';
import { NO_IMPAIRMENTS } from '../src/contracts/link.js';
import type { MediumEvent } from '../src/contracts/medium.js';
import type { LayerSpec, Pdu } from '../src/contracts/pdu.js';
import { HDLC_PROTO_KEEPALIVE, PPP_PROTO } from '../src/contracts/pdu.js';
import { emptyCounters } from '../src/contracts/port.js';
import type { PortState } from '../src/contracts/port.js';
import type { PortEncap } from '../src/contracts/catalog.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createLinkModel } from '../src/link/link.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { meta } from './link.segment.harness.js';
import { INERT_LINK_DEPS, testPortSpec } from './port.fixtures.js';

const SERIAL: PortId = 'Serial0/0/0';
const AUTO: PortPhySettings = { speed: 'auto', duplex: 'auto' };
const CLOCKED: PortPhySettings = { ...AUTO, clockRateBps: 64_000 };

/** A link facade over two hand-built routers with one serial port each (R1 is the DCE end). */
function world(encapA: PortEncap = 'ppp', encapB: PortEncap = 'ppp', clocked = true) {
  const ports = new Map<string, PortState>();
  const up = new Map<DeviceId, boolean>();
  const events: TraceEvent[] = [];
  const notes: { ref: PortRef; ev: MediumEvent; t: number }[] = [];
  const settings = new Map<string, PortPhySettings>();
  const scheduler = createScheduler();
  const pdus = createPduFactory();
  const deps: LinkModelDeps = {
    ...INERT_LINK_DEPS,
    scheduler,
    trace: { emit: (ev) => events.push(ev) },
    rng: createRng(4).split('links'),
    port: (ref) => ports.get(portKey(ref)),
    deviceUp: (id) => up.get(id) ?? false,
    pdus,
    portSettings: (ref) => settings.get(portKey(ref)),
    notify: (ref, ev, t) => notes.push({ ref: { device: ref.device, port: ref.port }, ev, t }),
  };
  const model = createLinkModel(deps);
  const add = (device: DeviceId, encap: PortEncap, mac: string): PortRef => {
    const state: PortState = {
      id: SERIAL,
      spec: testPortSpec({ name: SERIAL, short: 'Se0/0/0', kind: 'serial', speedBps: 2_000_000, role: 'wan' }),
      mac,
      adminUp: true,
      operUp: false,
      mtu: 1500,
      counters: emptyCounters(),
      l3: {},
      tx: { busyUntil: 0, queue: 0 },
      role: 'wan',
      ordinal: 1,
      encap,
    };
    const ref: PortRef = { device, port: SERIAL };
    ports.set(portKey(ref), state);
    up.set(device, true);
    return ref;
  };
  const r1 = add('d_r1', encapA, '02:00:00:00:00:01');
  const r2 = add('d_r2', encapB, '02:00:00:00:00:02');
  settings.set(portKey(r1), clocked ? { ...CLOCKED } : { ...AUTO });
  settings.set(portKey(r2), { ...AUTO });
  const port = (ref: PortRef): PortState => ports.get(portKey(ref))!;
  const connect = (over: Partial<LinkSpec> = {}) =>
    model.add({ id: 'l_s', a: r1, b: r2, media: 'serial-dce', lengthM: 2, impairments: { ...NO_IMPAIRMENTS }, ...over }, scheduler.now);
  const clear = (): void => {
    events.length = 0;
    notes.length = 0;
  };
  /** A frame of `layers` built from scratch (a fresh PDU id each call). */
  const frame = (layers: LayerSpec[]): Pdu => pdus.build(layers, meta());
  return { model, scheduler, events, notes, settings, r1, r2, port, connect, clear, frame };
}

/** The notifications as `[port key, kind, value]` triples. */
const noteList = (notes: readonly { ref: PortRef; ev: MediumEvent }[]): [string, string, boolean | undefined][] =>
  notes.map((n) => [portKey(n.ref), n.ev.kind, n.ev.kind === 'carrier' ? n.ev.up : n.ev.kind === 'serial-line' ? n.ev.ready : undefined]);

const R1 = 'd_r1/Serial0/0/0';
const R2 = 'd_r2/Serial0/0/0';

const LCP_REQUEST: LayerSpec[] = [{ proto: 'ppp', fields: { protocol: PPP_PROTO.lcp } }, { proto: 'lcp', fields: { code: 1, id: 1, magic: 0x1234abcd } }];
const IPV4_OVER_PPP: LayerSpec[] = [
  { proto: 'ppp', fields: { protocol: PPP_PROTO.ipv4 } },
  { proto: 'ipv4', fields: { src: '10.1.1.1', dst: '10.1.1.2', protocol: 17, ttl: 64 } },
  { proto: 'udp', fields: { srcPort: 5000, dstPort: 9 } },
  { proto: 'payload', fields: { data: new Uint8Array(8) } },
];

describe('ppp-link: each ppp end follows its daemon', () => {
  it('a clocked ppp line comes up ready and negotiating, with serial-line {ready: true} to both ends after carrier', () => {
    const h = world();
    const link = h.connect();
    expect(link).toMatchObject({ up: false, carrier: true, downReason: 'ppp-negotiating', negotiatedBps: 64_000, resolvedDceEnd: 'a' });
    expect(h.port(h.r1).phy).toEqual({ carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-negotiating', dce: true, medium: 'cable' });
    expect(h.port(h.r2).phy).toEqual({ carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-negotiating', dce: false, medium: 'cable' });
    expect(noteList(h.notes)).toEqual([
      [R1, 'carrier', true],
      [R2, 'carrier', true],
      [R1, 'serial-line', true],
      [R2, 'serial-line', true],
    ]);
    expect(h.events).toEqual([
      { t: 0, kind: 'portState', device: 'd_r1', port: SERIAL, adminUp: true, operUp: false, reason: 'cable-connected', carrier: true },
      { t: 0, kind: 'portState', device: 'd_r2', port: SERIAL, adminUp: true, operUp: false, reason: 'cable-connected', carrier: true },
    ]);
  });

  it('up reports bring each end up alone, then the link; a repeated or equivalent report recomputes nothing', () => {
    const h = world();
    h.connect();
    h.clear();
    expect(h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 10)).toEqual([{ port: h.r1, operUp: true }]);
    expect(h.port(h.r1).operUp).toBe(true);
    expect(h.port(h.r2).operUp).toBe(false);
    expect(h.model.get('l_s')).toMatchObject({ up: false, carrier: true, downReason: 'ppp-negotiating' });
    // the P1 recompute rule: a port event carries the link's down reason while the link is down (R2 still negotiates)
    expect(h.events).toEqual([{ t: 10, kind: 'portState', device: 'd_r1', port: SERIAL, adminUp: true, operUp: true, reason: 'ppp-negotiating' }]);

    h.clear();
    expect(h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 11)).toEqual([]);
    expect(h.model.mediumOp(h.r2, { op: 'ppp-link', up: false }, 11)).toEqual([]); // no report = negotiating already
    expect(h.model.mediumOp(h.r2, { op: 'ppp-link', up: false, reason: 'ppp-negotiating' }, 11)).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.notes).toEqual([]);

    expect(h.model.mediumOp(h.r2, { op: 'ppp-link', up: true }, 12)).toEqual([{ port: h.r2, operUp: true }]);
    const link = h.model.get('l_s')!;
    expect(link).toMatchObject({ up: true, negotiatedBps: 64_000 });
    expect(link.downReason).toBeUndefined();
    expect(link.carrier).toBeUndefined();
    expect(h.events).toEqual([
      { t: 12, kind: 'linkState', link: 'l_s', up: true },
      { t: 12, kind: 'portState', device: 'd_r2', port: SERIAL, adminUp: true, operUp: true },
    ]);
    expect(h.notes).toEqual([]); // readiness did not change
  });

  it('a failed authentication downs the reporting end with its reason; the link takes the most telling one', () => {
    const h = world();
    h.connect();
    h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 5);
    h.model.mediumOp(h.r2, { op: 'ppp-link', up: true }, 5);
    h.clear();
    expect(h.model.mediumOp(h.r2, { op: 'ppp-link', up: false, reason: 'ppp-auth-failed' }, 20)).toEqual([{ port: h.r2, operUp: false }]);
    expect(h.port(h.r2).phy).toMatchObject({ carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-auth-failed' });
    expect(h.model.get('l_s')).toMatchObject({ up: false, carrier: true, downReason: 'ppp-auth-failed' });
    expect(h.events).toEqual([
      { t: 20, kind: 'linkState', link: 'l_s', up: false, reason: 'ppp-auth-failed' },
      { t: 20, kind: 'portState', device: 'd_r2', port: SERIAL, adminUp: true, operUp: false, reason: 'ppp-auth-failed', carrier: true },
    ]);
    // R1 reports its missed echoes: auth failure still wins at the link level
    expect(h.model.mediumOp(h.r1, { op: 'ppp-link', up: false, reason: 'keepalive-missed' }, 21)).toEqual([{ port: h.r1, operUp: false }]);
    expect(h.port(h.r1).phy?.lineProtocolReason).toBe('keepalive-missed');
    expect(h.model.get('l_s')!.downReason).toBe('ppp-auth-failed');
  });

  it('ignores a report from a non-ppp end, from a port without a cable and from a line that is not ready', () => {
    const mixed = world('ppp', 'hdlc');
    mixed.connect();
    expect(mixed.model.get('l_s')!.downReason).toBe('encapsulation-mismatch');
    mixed.clear();
    expect(mixed.model.mediumOp(mixed.r1, { op: 'ppp-link', up: true }, 1)).toEqual([]); // the line is not ready
    expect(mixed.model.mediumOp(mixed.r2, { op: 'ppp-link', up: true }, 1)).toEqual([]); // an hdlc end
    expect(mixed.events).toEqual([]);

    const unclocked = world('ppp', 'ppp', false);
    unclocked.connect();
    expect(unclocked.model.get('l_s')!.downReason).toBe('no-clock');
    expect(unclocked.model.mediumOp(unclocked.r1, { op: 'ppp-link', up: true }, 1)).toEqual([]);
    // clocked later: the line becomes ready and both ends negotiate (the ignored report was not kept)
    unclocked.settings.set(portKey(unclocked.r1), { ...CLOCKED });
    unclocked.clear();
    expect(unclocked.model.onPortChanged(unclocked.r1, 2)).toEqual([]);
    expect(unclocked.model.get('l_s')!.downReason).toBe('ppp-negotiating');
    expect(noteList(unclocked.notes)).toEqual([
      [R1, 'serial-line', true],
      [R2, 'serial-line', true],
    ]);

    const loose = world();
    expect(loose.model.mediumOp(loose.r1, { op: 'ppp-link', up: true }, 1)).toEqual([]); // no cable at all
    expect(loose.events).toEqual([]);
  });

  it('forgets the reports when the line stops being ready: clock removed, then back, negotiates from scratch', () => {
    const h = world();
    h.connect();
    h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 5);
    h.model.mediumOp(h.r2, { op: 'ppp-link', up: true }, 5);
    expect(h.model.get('l_s')!.up).toBe(true);

    h.clear();
    h.settings.set(portKey(h.r1), { ...AUTO });
    expect(h.model.onPortChanged(h.r1, 30)).toEqual([{ port: h.r1, operUp: false }, { port: h.r2, operUp: false }]);
    expect(h.model.get('l_s')).toMatchObject({ up: false, carrier: true, downReason: 'no-clock' });
    expect(noteList(h.notes)).toEqual([
      [R1, 'serial-line', false],
      [R2, 'serial-line', false],
    ]);

    h.clear();
    h.settings.set(portKey(h.r1), { ...CLOCKED });
    expect(h.model.onPortChanged(h.r1, 40)).toEqual([]);
    expect(h.model.get('l_s')).toMatchObject({ up: false, carrier: true, downReason: 'ppp-negotiating' });
    expect(h.port(h.r1).phy?.lineProtocolReason).toBe('ppp-negotiating');
    expect(h.port(h.r2).phy?.lineProtocolReason).toBe('ppp-negotiating');
    expect(noteList(h.notes)).toEqual([
      [R1, 'serial-line', true],
      [R2, 'serial-line', true],
    ]);
  });

  it('an end that leaves ppp makes a mismatch (serial-line false to both); coming back starts negotiating', () => {
    // §3.9 steps 1 and 2: R1 ppp and R2 hdlc mismatch; R2's `encapsulation ppp` makes the line ready for both daemons
    const h = world('ppp', 'hdlc');
    h.connect();
    expect(noteList(h.notes)).toEqual([
      [R1, 'carrier', true],
      [R2, 'carrier', true],
    ]);
    h.clear();
    h.port(h.r2).encap = 'ppp';
    expect(h.model.onPortChanged(h.r2, 5)).toEqual([]);
    expect(h.model.get('l_s')!.downReason).toBe('ppp-negotiating');
    expect(noteList(h.notes)).toEqual([
      [R1, 'serial-line', true],
      [R2, 'serial-line', true],
    ]);
    h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 6);
    h.model.mediumOp(h.r2, { op: 'ppp-link', up: true }, 6);
    expect(h.model.get('l_s')!.up).toBe(true);

    h.clear();
    h.port(h.r2).encap = 'hdlc';
    expect(h.model.onPortChanged(h.r2, 7)).toEqual([{ port: h.r1, operUp: false }, { port: h.r2, operUp: false }]);
    expect(h.model.get('l_s')!.downReason).toBe('encapsulation-mismatch');
    expect(noteList(h.notes)).toEqual([
      [R1, 'serial-line', false],
      [R2, 'serial-line', false],
    ]);

    h.clear();
    h.port(h.r2).encap = 'ppp';
    expect(h.model.onPortChanged(h.r2, 8)).toEqual([]);
    expect(h.model.get('l_s')!.downReason).toBe('ppp-negotiating');
    expect(h.port(h.r1).operUp).toBe(false); // R1's old "up" was forgotten with the mismatch
  });

  it('a cut and a cable removal end the ready line: serial-line false after the carrier notifications', () => {
    const h = world();
    h.connect();
    h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 1);
    h.clear();
    h.model.cut('l_s', true, 2);
    expect(noteList(h.notes)).toEqual([
      [R1, 'carrier', false],
      [R2, 'carrier', false],
      [R1, 'serial-line', false],
      [R2, 'serial-line', false],
    ]);
    h.clear();
    h.model.cut('l_s', false, 3);
    expect(h.port(h.r1).operUp).toBe(false); // negotiating again
    expect(noteList(h.notes).filter((n) => n[1] === 'serial-line')).toEqual([
      [R1, 'serial-line', true],
      [R2, 'serial-line', true],
    ]);

    h.clear();
    h.model.remove('l_s', 4);
    expect(noteList(h.notes)).toEqual([
      [R1, 'carrier', false],
      [R2, 'carrier', false],
      [R1, 'serial-line', false],
      [R2, 'serial-line', false],
    ]);
    expect(h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 5)).toEqual([]);
  });

  it('an HDLC link never sees serial-line, and a ppp-link op on it changes nothing', () => {
    const h = world('hdlc', 'hdlc');
    h.connect();
    expect(h.model.get('l_s')!.up).toBe(true);
    h.settings.set(portKey(h.r1), { ...AUTO });
    h.model.onPortChanged(h.r1, 1);
    h.settings.set(portKey(h.r1), { ...CLOCKED });
    h.model.onPortChanged(h.r1, 2);
    h.model.cut('l_s', true, 3);
    h.model.cut('l_s', false, 4);
    expect(h.notes.some((n) => n.ev.kind === 'serial-line')).toBe(false);
    h.clear();
    expect(h.model.mediumOp(h.r1, { op: 'ppp-link', up: false, reason: 'ppp-auth-failed' }, 5)).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.model.get('l_s')!.up).toBe(true);
  });
});

describe('ppp-link: the transmit gate (serialControlExempt)', () => {
  it('while negotiating, PPP control frames leave and data does not; once up, data leaves', () => {
    const h = world();
    h.connect();
    const lcp = h.model.transmit(h.r1, h.frame(LCP_REQUEST), 0);
    expect(lcp.ok).toBe(true);
    expect(h.model.transmit(h.r1, h.frame(IPV4_OVER_PPP), 0)).toEqual({ ok: false, reason: 'link-down' });
    const drop = h.events.find((e) => e.kind === 'drop');
    expect(drop).toMatchObject({ kind: 'drop', device: 'd_r1', port: SERIAL, reason: 'link-down', detail: 'ppp-negotiating' });

    h.model.mediumOp(h.r1, { op: 'ppp-link', up: true }, 1);
    expect(h.model.transmit(h.r1, h.frame(IPV4_OVER_PPP), 1).ok).toBe(true);
  });

  it('an auth failure still lets control frames through (the retry), a missed clock blocks everything', () => {
    const h = world();
    h.connect();
    h.model.mediumOp(h.r2, { op: 'ppp-link', up: false, reason: 'ppp-auth-failed' }, 1);
    expect(h.model.transmit(h.r2, h.frame(LCP_REQUEST), 1).ok).toBe(true);
    expect(h.model.transmit(h.r2, h.frame(IPV4_OVER_PPP), 1).ok).toBe(false);

    h.settings.set(portKey(h.r1), { ...AUTO });
    h.model.onPortChanged(h.r1, 2);
    expect(h.model.transmit(h.r1, h.frame(LCP_REQUEST), 2)).toEqual({ ok: false, reason: 'link-down' });
  });

  it('an HDLC keepalive on an HDLC end down only by its latch still leaves, exactly as before', () => {
    const h = world('hdlc', 'hdlc');
    h.connect();
    h.model.mediumOp(h.r2, { op: 'line-protocol', up: false }, 1);
    const keepalive = h.frame([{ proto: 'hdlc', fields: { address: 0x8f, control: 0, protocol: HDLC_PROTO_KEEPALIVE } }, { proto: 'payload', fields: { data: new Uint8Array(14) } }]);
    expect(h.model.transmit(h.r2, keepalive, 1).ok).toBe(true);
    expect(h.model.transmit(h.r2, h.frame(LCP_REQUEST), 1)).toEqual({ ok: false, reason: 'link-down' }); // not a ppp port
  });
});
