/**
 * cli.wan-show — [S18]/[C13] the tunnel lines of `show interfaces` and `show interfaces tunnel [<n>]`, the Tunnel rows
 * of `show ip interface brief`; [S19] the PPP lines of `show interfaces`, the PPP line-protocol reasons and `show ppp
 * interface [<if>]`; the `tunnel` / `ppp negotiation` / `ppp authentication` debug categories and the approved
 * aggregate's category list (ARCHITECTURE-P3 §2.17, §3.9, §3.10, §3.13, §5.8; §7 W3 cli, approved items) — against fake
 * `tunnels` and `ppp` tables. Every P1/P2 port keeps its bytes (no tunnel role, no PPP framing).
 */
import { describe, expect, it } from 'vitest';
import type { CommandCtx } from '../src/contracts/cli.js';
import type { PortView } from '../src/contracts/port.js';
import type { PppRow, TunnelRow } from '../src/contracts/tables.js';
import { GRAMMAR } from '../src/cli/grammar/index.js';
import { SHOW_HANDLERS as S } from '../src/cli/grammar/show.js';
import { MSG_PPP_SHOW_PORT, WAN_DEBUG_CATEGORIES, WAN_GRAMMAR, WAN_HANDLERS as W } from '../src/cli/grammar/wan.js';
import {
  P3_APPROVED_DEBUG_CATEGORIES,
  P3_APPROVED_DEBUG_GRAMMAR,
  P3_APPROVED_DEBUG_OBJECTIVES,
  P3_APPROVED_GRAMMAR,
} from '../src/cli/grammar/p3-approved.js';
import { help } from '../src/cli/parser.js';
import { LINE_PROTOCOL_REASON_TEXT, renderInterface, TUNNEL_DOWN_REASON_TEXT } from '../src/cli/handlers/show.js';
import { MSG_NO_PPP, MSG_NO_TUNNEL } from '../src/cli/handlers/wan.js';
import { createGre } from '../src/protocols/gre.js';
import { catalogModel, matchContextFor } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';
import { approvedCtx, handlerOf, parse, routerPortsWithTunnel, runOn, showCtx, showLines } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const SEC = 1_000_000_000;
const SE0 = 'Serial0/0/0';

/** §3.10's R1 tunnel: down `no-route` until the default route exists. */
const GRE_ROW: TunnelRow = {
  key: 'Tunnel0',
  updatedAt: 0,
  port: 'Tunnel0',
  mode: 'gre',
  source: '209.165.200.225',
  sourceIface: SE0,
  destination: '209.165.200.230',
  state: 'down',
  reason: 'no-route',
  transportMtu: 1500,
  ipMtu: 1476,
  since: 0,
};

/** §3.9 step 5: R1's PPP link with CHAP, both NCPs' IPv4 half open. */
const PPP_ROW: PppRow = {
  key: SE0,
  updatedAt: 0,
  port: SE0,
  phase: 'network',
  lcp: 'opened',
  authLocal: 'chap',
  authLocalState: 'success',
  authPeer: 'none',
  peerName: 'R2',
  ipcp: 'opened',
  peerAddress: '10.1.1.2',
  magic: 42,
  peerMagic: 0xdeadbeef,
  failures: 0,
  since: 40 * SEC,
};

interface Setup {
  readonly tunnel?: Partial<PortView>;
  readonly serial?: Partial<PortView>;
  readonly tunnels?: readonly TunnelRow[];
  readonly ppp?: readonly PppRow[];
  readonly lines?: readonly (readonly string[])[];
}

/** R1 with Tunnel0 (172.16.0.1/30, down) and Se0/0/0 (10.1.1.1/30, PPP framing), and the given rows and tunnel lines. */
function r1(s: Setup = {}): CommandCtx {
  const ports = routerPortsWithTunnel();
  ports.set('Tunnel0', { ...ports.get('Tunnel0')!, operUp: false, l3: { ipv4: { address: '172.16.0.1', prefixLen: 30 } }, ...s.tunnel });
  ports.set(SE0, { ...ports.get(SE0)!, encap: 'ppp', l3: { ipv4: { address: '10.1.1.1', prefixLen: 30 } }, ...s.serial });
  const rec = approvedCtx(R, { mode: 'priv-exec', ports });
  for (const l of s.lines ?? [['tunnel', 'source', SE0], ['tunnel', 'destination', '209.165.200.230']]) rec.running.set([['interface', 'Tunnel0']], [...l]);
  return showCtx(rec, { now: 100 * SEC, rows: { tunnels: s.tunnels ?? [GRE_ROW], ppp: s.ppp ?? [PPP_ROW] } });
}

/** The common tail of every `show interfaces` block of these ports (no traffic). */
const TAIL = [
  '  Last input never, last output never',
  '  Last state change never',
  '  RX: 0 frames, 0 bytes, 0 broadcasts',
  '    errors: 0 runt, 0 oversize, 0 FCS, 0 total, 0 dropped',
  '  TX: 0 frames, 0 bytes',
  '    dropped: 0, collisions: 0',
  '  Transmit queue: 0 frames waiting',
];

describe('cli.wan-show grammar', () => {
  it('parses show ppp interface on serial ports and the hidden show interfaces tunnel', () => {
    const ports = routerPortsWithTunnel();
    expect(handlerOf(R, 'user-exec', 'show ppp interface')).toBe(W.showPppInterface);
    expect(handlerOf(R, 'priv-exec', 'show ppp interface Serial0/0/0')).toBe(W.showPppInterface);
    const eth = parse(R, 'priv-exec', 'show ppp interface GigabitEthernet0/0');
    expect(eth.ok).toBe(false);
    if (!eth.ok) expect(eth.error.message).toBe(MSG_PPP_SHOW_PORT);
    expect(handlerOf(R, 'priv-exec', 'show interfaces tunnel', { ports })).toBe(W.showInterfacesTunnel);
    const zero = parse(R, 'priv-exec', 'show interfaces tunnel 0', { ports });
    expect(zero.ok && zero.args).toMatchObject({ number: '0' });
    // the port form is untouched: Tunnel0 is still an interface name of `show interfaces`
    expect(handlerOf(R, 'priv-exec', 'show interfaces Tunnel0', { ports })).toBe(S.showInterfaces);
    expect(handlerOf(R, 'priv-exec', 'show interfaces tu0', { ports })).toBe(S.showInterfaces);
    expect(parse('switch.nfc2960', 'priv-exec', 'show ppp interface').ok).toBe(false);
  });

  it('keeps the router\'s `show interfaces ?` list: the tunnel keyword is hidden', () => {
    const items = help(GRAMMAR, matchContextFor(catalogModel(R), 'priv-exec'), 'show interfaces ').items.map((i) => i.token);
    expect(items).not.toContain('tunnel');
    expect(WAN_GRAMMAR.find((s) => s.handler === W.showInterfacesTunnel)?.hidden).toBe(true);
  });

  it('registers tunnel, ppp negotiation and ppp authentication, offered on routing devices (the gre and ppp rows)', () => {
    expect(WAN_DEBUG_CATEGORIES.map((d) => [d.category, d.requiresAny])).toEqual([
      ['tunnel', ['routing']],
      ['ppp negotiation', ['routing']],
      ['ppp authentication', ['routing']],
    ]);
    expect(handlerOf(R, 'priv-exec', 'debug ppp negotiation')).toBe('exec.debug');
    expect(handlerOf(R, 'priv-exec', 'debug tunnel')).toBe('exec.debug');
    expect(parse('switch.nfc2960', 'priv-exec', 'debug ppp authentication').ok).toBe(false);
  });

  it('lists the approved debug categories in the §5.8 order, each with exactly one debug spec in its fragment', () => {
    expect(P3_APPROVED_DEBUG_CATEGORIES.map((d) => d.category)).toEqual([
      'ip ssh', 'telnet', 'tunnel', 'ppp negotiation', 'ppp authentication', 'syslog', 'eigrp packets', 'eigrp fsm', 'crypto ikev2',
    ]);
    expect(P3_APPROVED_DEBUG_GRAMMAR.map((s) => s.fixedArgs?.['category']).sort()).toEqual(P3_APPROVED_DEBUG_CATEGORIES.map((d) => d.category).sort());
    for (const s of P3_APPROVED_DEBUG_GRAMMAR) {
      const def = P3_APPROVED_DEBUG_CATEGORIES.find((d) => d.category === s.fixedArgs?.['category'])!;
      expect(s.path, def.category).toEqual(['debug', ...def.category.split(' ')]);
      expect(s.mode).toBe('priv-exec');
      expect(s.allowNo).toBe(true);
      expect(s.since).toBe('P3');
      expect(s.requiresAny, def.category).toEqual(def.requiresAny);
      expect(P3_APPROVED_GRAMMAR).toContain(s);
      expect(GRAMMAR, def.category).toContain(s);
    }
    expect(P3_APPROVED_DEBUG_CATEGORIES.map((d) => d.requiresAny)).toEqual([
      ['routing', 'managed-switch'], ['routing', 'managed-switch'], ['routing'], ['routing'], ['routing'], ['server'], ['routing'], ['routing'], ['routing'],
    ]);
    for (const d of P3_APPROVED_DEBUG_CATEGORIES) expect(P3_APPROVED_DEBUG_OBJECTIVES[d.category]?.length, d.category).toBeGreaterThan(0);
  });
});

describe('show interfaces: the tunnel lines', () => {
  it('a GRE tunnel down for want of a route: the reason on the status line, then source, mode and MTUs', () => {
    expect(showLines(r1(), S.showInterfaces, { iface: 'Tunnel0' })).toEqual([
      'Tunnel0: admin up, link up, line protocol down (no route to the tunnel destination)',
      '  Tunnel interface, TUNNEL framing, no hardware address',
      '  IPv4 172.16.0.1/30',
      '  MTU 1500 bytes, bandwidth 100 kb/s',
      '  Duplex and speed not negotiated (no link)',
      '  Role: Tunnel interface',
      '  Tunnel source 209.165.200.225 (Serial0/0/0), destination 209.165.200.230',
      '  Tunnel protocol/transport GRE/IP',
      '  Tunnel transport MTU 1500 bytes, IP MTU 1476',
      ...TAIL,
    ]);
  });

  it('[C13] an IPsec tunnel shows its protection profile and the IPsec IP MTU (§2.17)', () => {
    const row: TunnelRow = { ...GRE_ROW, mode: 'ipsec', state: 'up', reason: undefined, ipMtu: 1456 } as TunnelRow;
    const lines = [
      ['tunnel', 'source', SE0],
      ['tunnel', 'destination', '209.165.200.230'],
      ['tunnel', 'mode', 'ipsec', 'ipv4'],
      ['tunnel', 'protection', 'ipsec', 'profile', 'VPN'],
      ['ip', 'tcp', 'adjust-mss', '1360'],
    ];
    const out = showLines(r1({ tunnels: [row], lines, tunnel: { operUp: true } }), S.showInterfaces, { iface: 'Tunnel0' });
    expect(out[0]).toBe('Tunnel0: admin up, link up');
    expect(out.slice(6, 11)).toEqual([
      '  Tunnel source 209.165.200.225 (Serial0/0/0), destination 209.165.200.230',
      '  Tunnel protocol/transport IPsec/IP',
      '  Tunnel protection via IPsec (profile VPN)',
      '  Tunnel transport MTU 1500 bytes, IP MTU 1456',
      '  TCP segments clamped to 1360 bytes (adjust-mss)',
    ]);
  });

  it('before the tunnel owner writes a row: the configured lines, an IPsec tunnel without protection, every reason', () => {
    const noRow = showLines(r1({ tunnels: [], lines: [['tunnel', 'source', SE0], ['tunnel', 'mode', 'ipsec', 'ipv4']] }), S.showInterfaces, { iface: 'Tunnel0' });
    expect(noRow[0]).toBe('Tunnel0: admin up, link up, line protocol down');
    expect(noRow.slice(6, 9)).toEqual([
      '  Tunnel source 10.1.1.1 (Serial0/0/0), destination not set',
      '  Tunnel protocol/transport IPsec/IP',
      '  Tunnel protection: none configured, so the tunnel stays down',
    ]);
    const byAddress = showLines(r1({ tunnels: [], lines: [['tunnel', 'source', '209.165.200.225']] }), S.showInterfaces, { iface: 'Tunnel0' });
    expect(byAddress[6]).toBe('  Tunnel source 209.165.200.225, destination not set');
    const noAddress = showLines(r1({ tunnels: [], lines: [['tunnel', 'source', 'GigabitEthernet0/1']] }), S.showInterfaces, { iface: 'Tunnel0' });
    expect(noAddress[6]).toBe('  Tunnel source GigabitEthernet0/1 (no address), destination not set');
    const admin = showLines(r1({ tunnel: { adminUp: false } }), S.showInterfaces, { iface: 'Tunnel0' });
    expect(admin[0]).toBe('Tunnel0: admin down, link down');
    expect(Object.keys(TUNNEL_DOWN_REASON_TEXT)).toEqual([
      'no-source', 'no-destination', 'no-route', 'recursive-routing', 'ike-negotiating', 'ike-failed', 'ike-no-proposal', 'ike-no-response',
    ]);
    for (const reason of Object.keys(TUNNEL_DOWN_REASON_TEXT) as (keyof typeof TUNNEL_DOWN_REASON_TEXT)[]) {
      const out = showLines(r1({ tunnels: [{ ...GRE_ROW, reason }] }), S.showInterfaces, { iface: 'Tunnel0' });
      expect(out[0], reason).toBe(`Tunnel0: admin up, link up, line protocol down (${TUNNEL_DOWN_REASON_TEXT[reason]})`);
    }
  });

  it('show interfaces tunnel [<n>] prints the tunnel blocks only', () => {
    const ctx = r1();
    const tunnel = renderInterface(ctx, ctx.ports.get('Tunnel0')!);
    expect(runOn(ctx, W.showInterfacesTunnel)).toEqual({ output: tunnel });
    expect(runOn(ctx, W.showInterfacesTunnel, { number: '0' })).toEqual({ output: tunnel });
    expect(runOn(ctx, W.showInterfacesTunnel, { number: '7' })).toEqual({ error: '% No interface named "Tunnel7" exists on this device.' });
    expect(runOn(showCtx(approvedCtx(R, { mode: 'priv-exec' })), W.showInterfacesTunnel)).toEqual({ output: MSG_NO_TUNNEL });
  });
});

describe('show ip interface brief: the Tunnel rows', () => {
  it('an administratively up tunnel is up; its Protocol column is the tunnel owner\'s verdict', () => {
    expect(showLines(r1(), S.showIpIntBrief)).toEqual([
      'Interface            IP address   Status   Protocol',
      'GigabitEthernet0/0   unassigned   up       up',
      'GigabitEthernet0/1   unassigned   up       up',
      'Serial0/0/0          10.1.1.1     up       up',
      'Serial0/0/1          unassigned   up       up',
      'Tunnel0              172.16.0.1   up       down',
    ]);
    expect(showLines(r1({ tunnel: { operUp: true } }), S.showIpIntBrief)[5]).toBe('Tunnel0              172.16.0.1   up       up');
    expect(showLines(r1({ tunnel: { adminUp: false } }), S.showIpIntBrief)[5]).toBe('Tunnel0              172.16.0.1   admin down   down');
  });
});

describe('show interfaces: the PPP lines', () => {
  it('an open PPP link: LCP, NCPs, authentication and the peer', () => {
    expect(showLines(r1(), S.showInterfaces, { iface: SE0 })).toEqual([
      'Serial0/0/0: admin up, link up',
      '  Serial port, PPP framing, no hardware address',
      '  IPv4 10.1.1.1/30',
      '  MTU 1500 bytes, bandwidth 2 Mb/s',
      '  Duplex and speed not negotiated (no link)',
      '  Role: WAN interface',
      '  PPP: LCP open, IPCP open',
      '  PPP authentication: CHAP required of the peer (succeeded); the peer requires nothing of this end',
      '  PPP peer: R2, address 10.1.1.2',
      ...TAIL,
    ]);
  });

  it('§3.9 step 6: the wrong password reads "line protocol down (authentication failed)", with the failures', () => {
    const failed: PppRow = {
      ...PPP_ROW, phase: 'dead', lcp: 'stopped', authLocalState: 'failed', ipcp: 'initial', peerAddress: undefined, failures: 2,
      lastFailure: 'the response does not match', ipv6cp: 'initial',
    } as PppRow;
    const serial: Partial<PortView> = { operUp: false, phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-auth-failed' } };
    const out = showLines(r1({ ppp: [failed], serial }), S.showInterfaces, { iface: SE0 });
    expect(out[0]).toBe('Serial0/0/0: admin up, link up, line protocol down (authentication failed)');
    expect(out.slice(6, 10)).toEqual([
      '  PPP: LCP stopped, IPCP initial, IPV6CP initial',
      '  PPP authentication: CHAP required of the peer (failed); the peer requires nothing of this end',
      '  PPP peer: R2',
      '  PPP failures: 2, the last: the response does not match',
    ]);
    const negotiating = showLines(r1({ ppp: [], serial: { operUp: false, phy: { carrier: true, lineProtocol: false, lineProtocolReason: 'ppp-negotiating' } } }), S.showInterfaces, { iface: SE0 });
    expect(negotiating[0]).toBe('Serial0/0/0: admin up, link up, line protocol down (PPP is still negotiating)');
    // no row yet: no PPP line
    expect(negotiating[6]).toBe(TAIL[0]);
    expect(LINE_PROTOCOL_REASON_TEXT['ppp-auth-failed']).toBe('authentication failed');
  });

  it('an HDLC serial line gains no PPP line, even beside a stale ppp row', () => {
    const out = showLines(r1({ serial: { encap: 'hdlc' } }), S.showInterfaces, { iface: SE0 });
    expect(out[1]).toBe('  Serial port, HDLC framing, no hardware address');
    expect(out.slice(6)).toEqual(TAIL);
  });
});

describe('show ppp interface', () => {
  it('one block per PPP line: phase, LCP magic numbers, authentication, peer, the NCPs and the failures', () => {
    expect(showLines(r1(), W.showPppInterface)).toEqual([
      'Serial0/0/0: PPP, phase network (the network protocols run), for 00:01:00',
      '  LCP open, magic 0x0000002a, peer magic 0xdeadbeef',
      '  Authentication: CHAP required of the peer (succeeded); the peer requires nothing of this end',
      '  Peer name: R2',
      '  IPCP open, peer address 10.1.1.2',
      '  IPV6CP not negotiated',
      '  Failures: 0',
    ]);
    const pap: PppRow = { ...PPP_ROW, authLocal: 'none', authLocalState: undefined, authPeer: 'pap', authPeerState: 'pending', ipv6cp: 'req-sent', failures: 1, lastFailure: 'the peer refused the password' } as PppRow;
    expect(showLines(r1({ ppp: [pap] }), W.showPppInterface, { iface: 'Se0/0/0' }).slice(2)).toEqual([
      '  Authentication: nothing required of the peer; the peer requires PAP (in progress)',
      '  Peer name: R2',
      '  IPCP open, peer address 10.1.1.2',
      '  IPV6CP request sent',
      '  Failures: 1, the last: the peer refused the password',
    ]);
  });

  it('a PPP line without a row, an HDLC line, a non-serial name and a device without PPP', () => {
    expect(showLines(r1({ ppp: [] }), W.showPppInterface)).toEqual(['Serial0/0/0: PPP has not started (the line is down)']);
    expect(showLines(r1(), W.showPppInterface, { iface: 'Serial0/0/1' })).toEqual(['Serial0/0/1 runs HDLC, not PPP.']);
    expect(runOn(r1(), W.showPppInterface, { iface: 'GigabitEthernet0/0' })).toEqual({ error: '% No serial interface named "GigabitEthernet0/0" exists on this device.' });
    expect(showLines(r1({ ppp: [], serial: { encap: 'hdlc' } }), W.showPppInterface)).toEqual([MSG_NO_PPP]);
  });
});

describe('on a real P3 world (the W2 gre daemon)', () => {
  it('a GRE tunnel between two routers: the Tunnel row, the tunnel lines, the debug category', () => {
    const sim = createStagedSimulation({ seed: 3, stage: 'P3', factories: { gre: createGre } });
    const cfg = (name: string, a: string, t: string, peer: string): string =>
      `hostname ${name}\n!\ninterface GigabitEthernet0/0\n ip address ${a} 255.255.255.0\n no shutdown\n!\ninterface Tunnel0\n ip address ${t} 255.255.255.252\n tunnel source GigabitEthernet0/0\n tunnel destination ${peer}\n!\nend\n`;
    sim.addDevice({ id: 'r1', type: R, name: 'R1', startupConfig: cfg('R1', '10.0.12.1', '172.16.0.1', '10.0.12.2') });
    sim.addDevice({ id: 'r2', type: R, name: 'R2', startupConfig: cfg('R2', '10.0.12.2', '172.16.0.2', '10.0.12.1') });
    sim.addLink({ a: { device: 'r1', port: 'GigabitEthernet0/0' }, b: { device: 'r2', port: 'GigabitEthernet0/0' } });
    sim.runFor(120 * SEC);
    const s = sim.cli.open('r1', 'console');
    sim.cli.exec(s, 'enable');
    expect(sim.cli.exec(s, 'show ip interface brief').output.split('\n')).toContain('Tunnel0              172.16.0.1   up           up');
    const block = sim.cli.exec(s, 'show interfaces tunnel').output.split('\n');
    expect(block[0]).toBe('Tunnel0: admin up, link up');
    expect(block[3]).toBe('  MTU 1500 bytes, bandwidth 100 kb/s');
    expect(block.slice(6, 9)).toEqual([
      '  Tunnel source 10.0.12.1 (GigabitEthernet0/0), destination 10.0.12.2',
      '  Tunnel protocol/transport GRE/IP',
      '  Tunnel transport MTU 1500 bytes, IP MTU 1476',
    ]);
    expect(sim.cli.exec(s, 'show interfaces tunnel 0').output).toBe(block.join('\n'));
    expect(sim.cli.exec(s, 'show ppp interface').output).toBe(MSG_NO_PPP);
    expect(sim.cli.exec(s, 'debug tunnel').output).toBe('Debugging enabled for tunnel.');
  });
});
