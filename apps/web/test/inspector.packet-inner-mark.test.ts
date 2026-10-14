// A TLS or SSH segment carried through an IPsec VTI keeps its own mark (ARCHITECTURE-P3 §9.2 W8 item 47, rulings R58(a),
// R61(a)): the engine's `ProcessCtx.protect` keeps the inner mark in `PduMeta.innerProtectedBy` while ESP wraps the packet
// and restores it at the tunnel's tail. NetScope's frame detail (`frameProtection`) and the Packet inspector's hop view
// (`hopProtection`) then show TLS or SSH on both LANs and ESP between the routers — whether the packet has been delivered
// (its own mark again) or is still inside the tunnel (its 'esp' mark, the inner one read on the LAN legs).
//
// The world is lab 25's (the reference solution typed after boot) with SW2 (Vlan1 192.168.2.2, RESTCONF over 443 and
// SSH-only vty lines) placed between R2 and PC2, since a host serves neither HTTPS nor SSH; PC1 then sends an HTTPS GET
// and logs in over SSH to SW2. Frames come from a real engine capture on every wire of the path.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCENARIOS, SEC, createSimulation } from '@netforge/engine';
import type { CaptureId, CaptureRecordDetail, PduJson, PduMeta, SessionId, Simulation, TraceEvent } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: {}, fmtSimTime: (t: number) => `${t / 1_000_000_000} s` }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {
    catalog: [],
    snapshot: null,
    snapshotIndex: undefined,
    epoch: 0,
    events: [],
    selection: null,
    select(sel: unknown) {
      state.selection = sel;
    },
  };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});
// Provenance opens a device's configuration through the device inspector, whose terminal needs a browser.
vi.mock('../src/inspector/DeviceInspector', () => ({ openDeviceTab: () => undefined }));

import { store } from '../src/store/store';
import { PROTECTED_LAYER_MARK, PacketInspector, hopProtection, inspectPduAtHop, protectedBannerTitle, rewindToHop } from '../src/inspector/PacketInspector';
import { DetailTree, frameNeedsMark, frameProtection } from '../src/netscope/DetailTree';

type FrameTx = Extract<TraceEvent, { kind: 'frameTx' }>;

const state = (store as unknown as { getState(): Record<string, unknown> }).getState();

/** Wall-clock budget of a test that boots the lab world. */
const WORLD_TEST_TIMEOUT_MS = 60_000;
const SW2 = '192.168.2.2';
const PASSWORD = 'Lab-Pass1';
const LAB = 'ccna3-ipsec-site-to-site';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which layer sections (NetScope) or cards (inspector) carry the simulated-plaintext mark. */
function marks(html: string): boolean[] {
  return html
    .split('class="pk-layer ')
    .slice(1)
    .map((c) => c.includes(PROTECTED_LAYER_MARK));
}

function tree(detail: CaptureRecordDetail, protection: ReturnType<typeof frameProtection>): string {
  return renderToStaticMarkup(
    createElement(DetailTree, { detail, selectedLayer: null, onSelectLayer: () => undefined, hot: null, onHot: () => undefined, note: 'pick one', protection }),
  );
}

function typed(sim: Simulation, device: string, lines: readonly string[]): void {
  const r = sim.configure(device, lines);
  expect(r.lines.filter((l) => !l.ok).map((l) => `${l.line}: ${l.error?.message ?? l.output}`), device).toEqual([]);
}

/** SW2, the LAN 2 server: Vlan1, RESTCONF over 443 and SSH-only vty lines with a local privilege-15 user. */
const SW2_LINES: readonly string[] = [
  'hostname SW2',
  'interface Vlan1',
  `ip address ${SW2} 255.255.255.0`,
  'no shutdown',
  'exit',
  'ip default-gateway 192.168.2.1',
  `username admin privilege 15 secret ${PASSWORD}`,
  'ip http secure-server',
  'ip http authentication local',
  'restconf',
  'ip domain-name lab.nf',
  'crypto key generate rsa modulus 1024',
  'line vty 0 4',
  'login local',
  'transport input ssh',
  'exit',
];

/** Lab 25 with SW2 between R2 and PC2, booted, configured and solved (the SA up); a capture on every wire of the path. */
function vtiWorld(): { sim: Simulation; cap: CaptureId } {
  const lab = SCENARIOS.find((s) => s.name === LAB);
  if (lab === undefined) throw new Error('lab 25 missing');
  const sim = createSimulation({ seed: lab.seed ?? 1 });
  sim.loadTopology(lab.build());
  sim.removeLink('l_r2_pc2');
  sim.addDevice({ id: 'sw2', type: 'switch.nfc2960', name: 'SW2' });
  sim.addLink({ a: { device: 'r2', port: 'GigabitEthernet0/0' }, b: { device: 'sw2', port: 'GigabitEthernet0/1' } });
  sim.addLink({ a: { device: 'sw2', port: 'FastEthernet0/1' }, b: { device: 'pc2', port: 'GigabitEthernet0' } });
  sim.runFor(90 * SEC);
  expect(sim.runToIdle().stopped).toBeUndefined();
  typed(sim, 'sw2', SW2_LINES);
  for (const [name, lines] of Object.entries(lab.solution ?? {})) typed(sim, name === 'R1' ? 'r1' : 'r2', lines);
  expect(sim.runToIdle().stopped).toBeUndefined();
  const cap = sim.startCapture({
    ports: [
      { device: 'pc1', port: 'GigabitEthernet0' },
      { device: 'r1', port: 'GigabitEthernet0/0' },
      { device: 'r1', port: 'Serial0/0/0' },
      { device: 'isp', port: 'Serial0/0/0' },
      { device: 'isp', port: 'Serial0/0/1' },
      { device: 'r2', port: 'Serial0/0/0' },
      { device: 'r2', port: 'GigabitEthernet0/0' },
      { device: 'sw2', port: 'GigabitEthernet0/1' },
    ],
    dir: 'tx',
  });
  return { sim, cap };
}

/** A marked TCP segment between PC1 and SW2: its legs, and its meta copied while it was inside the tunnel. */
interface Segment {
  readonly id: number;
  readonly by: 'tls' | 'ssh';
  readonly legs: FrameTx[];
  readonly inside: PduMeta;
}

/**
 * Run `fn`; collect every segment PC1 or SW2 created marked by `by` that crossed the whole path, with its meta as the
 * engine held it when the head router sent it into the provider (read synchronously at that leg's frameTx).
 */
function segments(sim: Simulation, by: 'tls' | 'ssh', fn: () => void): Segment[] {
  const born = new Set<number>();
  const legs = new Map<number, FrameTx[]>();
  const inside = new Map<number, PduMeta>();
  const off = sim.onTrace((e) => {
    if (e.kind === 'pduCreated' && e.process === 'tcp' && (e.device === 'pc1' || e.device === 'sw2')) {
      if (sim.pdu(e.pdu.id)?.meta.protectedBy === by) born.add(e.pdu.id);
    } else if (e.kind === 'frameTx' && born.has(e.pdu.id)) {
      legs.set(e.pdu.id, [...(legs.get(e.pdu.id) ?? []), e]);
      if (e.pdu.tunnel === 'ipsec' && !inside.has(e.pdu.id)) inside.set(e.pdu.id, { ...sim.pdu(e.pdu.id)!.meta });
    }
  });
  try {
    fn();
  } finally {
    off();
  }
  return [...born].flatMap((id) => {
    const l = legs.get(id) ?? [];
    const meta = inside.get(id);
    return l.length === 4 && meta !== undefined ? [{ id, by, legs: l, inside: meta }] : [];
  });
}

/** What the capture recorded of a leg (its sender's tx record). */
function recorded(sim: Simulation, cap: CaptureId, leg: FrameTx): CaptureRecordDetail {
  const info = sim.captures().find((c) => c.id === cap);
  const iface = info?.interfaces.find((i) => i.ref?.device === leg.from.device && i.ref.port === leg.from.port);
  const row = sim.queryCapture(cap, { from: 0, limit: 5000 }).rows.find((r) => r.pdu === leg.pdu.id && r.dir === 'tx' && r.iface === iface?.index && r.t === leg.txStart);
  if (row === undefined) throw new Error(`no record of #${leg.pdu.id} leaving ${leg.from.device}/${leg.from.port}`);
  const d = sim.captureRecord(cap, row.index);
  if (d === undefined) throw new Error('record gone');
  return d;
}

/** PC1's HTTPS GET to SW2 (the host-shell `rest` job), run until the job ends; the TLS data segments it produced. */
function httpsGet(sim: Simulation): Segment[] {
  const s: SessionId = sim.cli.open('pc1', 'console');
  let output = '';
  const segs = segments(sim, 'tls', () => {
    const cursor = sim.trace(0).next;
    sim.cli.exec(s, `rest GET https://${SW2}/restconf/data/nf-native:native/hostname -u admin:${PASSWORD}`);
    for (let i = 0; i < 400; i++) {
      sim.runFor(SEC / 20);
      if (sim.trace(cursor).events.some((e) => e.kind === 'cliPrompt' && e.session === s && !e.busy)) break;
    }
    output = sim.trace(cursor).events.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : [])).join('');
  });
  expect(output.split('\n')[0]).toBe('HTTP/1.1 200 OK');
  return segs;
}

/** PC1 logs in to SW2 over SSH; the SSH-protected segments of the session. */
function sshLogin(sim: Simulation): Segment[] {
  const s: SessionId = sim.cli.open('pc1', 'console');
  const segs = segments(sim, 'ssh', () => {
    sim.cli.exec(s, `ssh -l admin ${SW2}`);
    sim.runFor(1 * SEC);
    sim.cli.exec(s, PASSWORD);
    sim.runFor(3 * SEC);
  });
  expect(sim.cli.session(s)).toMatchObject({ remote: 'SW2 via SSH', busy: false });
  return segs;
}

/** The hop names of a segment's legs, and whether each leg is a LAN leg (no ESP header). */
const hopsOf = (g: Segment): string[] => g.legs.map((l) => `${l.from.device}>${l.to.device}`);
const PATHS = [
  ['pc1>r1', 'r1>isp', 'isp>r2', 'r2>sw2'],
  ['sw2>r2', 'r2>isp', 'isp>r1', 'r1>pc1'],
];

/** NetScope and the hop view agree on every leg of `g`: its own mark on both LANs, ESP between the routers. */
function expectEveryLeg(sim: Simulation, cap: CaptureId, g: Segment): void {
  expect(PATHS).toContainEqual(hopsOf(g));
  const now = sim.pdu(g.id)!.toJSON();
  // delivered: the segment's own mark again (the tunnel's tail restored it), nothing inside
  expect(now.meta).toMatchObject({ protected: true, protectedBy: g.by });
  expect(now.meta.innerProtectedBy).toBeUndefined();
  // inside the tunnel: ESP, with the segment's own mark kept inside it
  expect(g.inside).toMatchObject({ protected: true, protectedBy: 'esp', innerProtectedBy: g.by });
  const expected = [g.by, 'esp', 'esp', g.by];
  // NetScope: the captured frame of each leg, with the mark as the engine holds it now and as it held it in the tunnel
  const frames = g.legs.map((leg) => recorded(sim, cap, leg));
  expect(frames.map((d) => d.layers.some((l) => l.proto === 'esp'))).toEqual([false, true, true, false]);
  expect(frames.map((d) => frameProtection(d.layers, now.meta))).toEqual(expected);
  expect(frames.map((d) => frameProtection(d.layers, g.inside))).toEqual(expected);
  expect(frames.map((d) => frameNeedsMark(d.layers))).toEqual([true, false, false, true]);
  // the hop view: each leg rebuilt from the newest image, with today's mark and with the mark inside the tunnel
  const rebuilt = g.legs.map((leg) => rewindToHop(now, leg));
  expect(rebuilt.map((at) => hopProtection(at.layers, now.meta))).toEqual(expected);
  expect(rebuilt.map((at) => hopProtection(at.layers, g.inside))).toEqual(expected);
}

describe('the inner mark, read on a leg outside the tunnel (pure)', () => {
  const lan = [{ proto: 'ethernet' }, { proto: 'ipv4' }, { proto: 'tcp' }, { proto: 'http' }] as const;
  const provider = [{ proto: 'hdlc' }, { proto: 'ipv4' }, { proto: 'esp' }, { proto: 'ipv4' }, { proto: 'tcp' }, { proto: 'http' }] as const;
  const inTunnel = (inner?: PduMeta['innerProtectedBy']): PduMeta =>
    inner === undefined ? { born: 0, origin: 'pc1', protected: true, protectedBy: 'esp' } : { born: 0, origin: 'pc1', protected: true, protectedBy: 'esp', innerProtectedBy: inner };

  it('NetScope: TLS, SSH and IKE inside a tunnel show on a LAN frame; DTLS keeps its P2 view; nothing inside, no banner', () => {
    for (const by of ['tls', 'ssh', 'ike'] as const) {
      expect(frameProtection(lan, inTunnel(by))).toBe(by);
      expect(frameProtection(provider, inTunnel(by))).toBe('esp');
    }
    expect(frameProtection(lan, inTunnel('dtls'))).toBeUndefined();
    expect(frameProtection(lan, inTunnel('esp'))).toBeUndefined();
    expect(frameProtection(lan, inTunnel())).toBeUndefined();
    // an inner mark without the 'esp' mark around it is not read: the PDU's own mark decides
    const own: PduMeta = { born: 0, origin: 'pc1', protected: true, protectedBy: 'tls', innerProtectedBy: 'ssh' };
    expect(frameProtection(lan, own)).toBe('tls');
  });

  it('the hop view: the inner mark on a leg without an ESP header, DTLS included; ESP inside ESP is not shown outside', () => {
    for (const by of ['tls', 'ssh', 'ike', 'dtls'] as const) {
      expect(hopProtection(lan, inTunnel(by))).toBe(by);
      expect(hopProtection(provider, inTunnel(by))).toBe('esp');
    }
    expect(hopProtection(lan, inTunnel('esp'))).toBeUndefined();
    expect(hopProtection(lan, inTunnel())).toBeUndefined();
  });
});

describe('an HTTPS GET through lab 25\'s VTI (W8 item 47, R58(a))', () => {
  it('NetScope and the hop view show TLS on both LANs and ESP between the routers, delivered or still in the tunnel', () => {
    const { sim, cap } = vtiWorld();
    const segs = httpsGet(sim);
    // data segments in both directions crossed the whole path
    expect(new Set(segs.map((g) => hopsOf(g)[0]))).toEqual(new Set(['pc1>r1', 'sw2>r2']));
    for (const g of segs) expectEveryLeg(sim, cap, g);
  }, WORLD_TEST_TIMEOUT_MS);

  it('the frame detail and the inspector render the TLS banner on a LAN leg and the ESP banner on a provider leg', () => {
    const { sim, cap } = vtiWorld();
    const g = httpsGet(sim).find((x) => hopsOf(x)[0] === 'pc1>r1');
    if (g === undefined) throw new Error('no request segment');
    const now: PduJson = sim.pdu(g.id)!.toJSON();
    // NetScope, LAN 1 and LAN 2: the TLS banner over the HTTP request
    for (const leg of [g.legs[0]!, g.legs[3]!]) {
      const d = recorded(sim, cap, leg);
      const html = tree(d, frameProtection(d.layers, now.meta));
      expect(html).toContain(`role="note" aria-label="${protectedBannerTitle('tls')}"`);
      expect(text(html)).toContain('This web request travels inside an encrypted TLS session');
      expect(marks(html)).toEqual(d.layers.map((l) => l.proto === 'http'));
    }
    // NetScope, the provider: the ESP banner over the whole inner packet
    const isp = recorded(sim, cap, g.legs[2]!);
    const espHtml = tree(isp, frameProtection(isp.layers, now.meta));
    expect(espHtml).toContain(`role="note" aria-label="${protectedBannerTitle('esp')}"`);
    expect(text(espHtml)).not.toContain('Protected (TLS, simulated)');

    // the inspector opened from each leg: TLS, ESP, ESP, TLS
    const titles: string[] = [];
    for (const leg of g.legs) {
      inspectPduAtHop(leg);
      const t = text(renderToStaticMarkup(createElement(PacketInspector, { pdu: now })));
      expect(t).toContain(`As sent from ${leg.from.device} ${leg.from.port} to ${leg.to.device} ${leg.to.port}`);
      titles.push(['Protected (TLS, simulated)', 'Encrypted (ESP, simulated)'].find((x) => t.includes(x)) ?? 'none');
    }
    expect(titles).toEqual(['Protected (TLS, simulated)', 'Encrypted (ESP, simulated)', 'Encrypted (ESP, simulated)', 'Protected (TLS, simulated)']);
    // selected any other way: today's view, the packet as delivered (TLS)
    (store as unknown as { getState(): { select(s: unknown): void } }).getState().select({ kind: 'pdu', id: now.id });
    const today = text(renderToStaticMarkup(createElement(PacketInspector, { pdu: now })));
    expect(today).toContain('Protected (TLS, simulated)');
    expect(today).not.toContain('As sent from');
    state.selection = null;
  }, WORLD_TEST_TIMEOUT_MS);
});

describe('an SSH login through lab 25\'s VTI (W8 item 47, R58(a))', () => {
  it('NetScope and the hop view show SSH on both LANs and ESP between the routers, delivered or still in the tunnel', () => {
    const { sim, cap } = vtiWorld();
    const segs = sshLogin(sim);
    expect(new Set(segs.map((g) => hopsOf(g)[0]))).toEqual(new Set(['pc1>r1', 'sw2>r2']));
    for (const g of segs) expectEveryLeg(sim, cap, g);
    // a LAN frame of the login renders the SSH banner over the decoded payload
    const g = segs.find((x) => hopsOf(x)[0] === 'pc1>r1')!;
    const d = recorded(sim, cap, g.legs[3]!);
    const html = tree(d, frameProtection(d.layers, sim.pdu(g.id)!.meta));
    expect(html).toContain(`role="note" aria-label="${protectedBannerTitle('ssh')}"`);
    expect(marks(html)).toEqual(d.layers.map((l) => l.proto === 'ssh'));
  }, WORLD_TEST_TIMEOUT_MS);
});
