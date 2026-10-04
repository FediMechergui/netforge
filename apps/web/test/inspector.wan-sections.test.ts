// [S19] PPP and [S18]/[C13] Tunnel sections of the port inspector (ARCHITECTURE-P3 §5.9 "Port inspector": "[S19] PPP
// and [S18] Tunnel sections (the Tunnel section shows [C13] protection, the SA state and the IP MTU)", §6, §3.9, §3.10,
// §3.13; §7 W3 web-inspector): read from the `ppp`, `tunnels` and `ipsec-sa` rows, the protection line of the running
// configuration and the gre StateView's counters; nothing for a port without its row.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceSnapshot, IpsecSaRow, PppRow, StateView, TableSnapshot, TunnelRow } from '@netforge/engine';
import { PppSection, magicText, pppAuthText, pppRailText, pppRowOf } from '../src/inspector/PppSection';
import {
  TunnelSection,
  ipsecSaText,
  spiText,
  tunnelCountersOf,
  tunnelFacts,
  tunnelProtectionProfile,
  tunnelStateText,
} from '../src/inspector/TunnelSection';

const S = 1_000_000_000;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function table(name: string, rows: object[]): TableSnapshot {
  return { name: name as TableSnapshot['name'], title: name, columns: [], rows: rows as Record<string, unknown>[] };
}

type WanDevice = Pick<DeviceSnapshot, 'tables' | 'processes' | 'runningConfig'>;

function dev(tables: TableSnapshot[], processes: StateView[] = [], runningConfig = ''): WanDevice {
  return { tables: { cam: [], arp: [], rib: [], extra: tables }, processes, runningConfig };
}

// ── PPP ─────────────────────────────────────────────────────────────────────

function pppRow(over: Partial<PppRow> = {}): PppRow {
  return {
    key: 'Serial0/0/0',
    updatedAt: 0,
    port: 'Serial0/0/0',
    phase: 'network',
    lcp: 'opened',
    authLocal: 'chap',
    authLocalState: 'success',
    authPeer: 'chap',
    authPeerState: 'success',
    peerName: 'R2',
    ipcp: 'opened',
    peerAddress: '10.1.1.2',
    magic: 0x1a2b3c4d,
    peerMagic: 0x0badf00d,
    failures: 0,
    since: 50 * S,
    ...over,
  };
}

describe('[S19] the PPP section', () => {
  it('words: the rail, both authentication directions, the magic numbers', () => {
    expect(pppRailText(pppRow())).toBe('D✓·E✓·A✓·N✓');
    expect(pppRailText(pppRow({ phase: 'authenticate', ipcp: 'initial', authLocalState: 'pending' }))).toBe('D✓·E✓·A▶·N');
    expect(pppRailText(pppRow({ phase: 'establish', ipcp: 'initial', authLocal: 'none', authPeer: 'none', authLocalState: undefined, authPeerState: undefined }))).toBe('D✓·E▶·A–·N');
    expect(pppRailText(pppRow({ phase: 'dead', ipcp: 'initial', authLocalState: 'failed' }))).toBe('D▶·E·A✗·N');
    expect(pppAuthText('chap', 'success', 'local')).toBe('this end requires CHAP of its peer: ✓ succeeded');
    expect(pppAuthText('pap', 'failed', 'peer')).toBe('the peer requires PAP of this end: ✗ failed');
    expect(pppAuthText('chap', undefined, 'local')).toBe('this end requires CHAP of its peer: not started');
    expect(pppAuthText('none', undefined, 'peer')).toBe('the peer requires no authentication');
    expect(magicText(0x1a2b3c4d)).toBe('0x1a2b3c4d');
    expect(magicText(undefined)).toBe('—');
  });

  it('an open CHAP link (§3.9 step 5)', () => {
    const d = dev([table('ppp', [pppRow()])]);
    expect(pppRowOf(d, 'Serial0/0/0')?.peerAddress).toBe('10.1.1.2');
    const html = renderToStaticMarkup(createElement(PppSection, { device: d, port: { id: 'Serial0/0/0' } }));
    const t = text(html);
    expect(html).toContain('aria-label="PPP"');
    expect(t).toContain('Network (network protocols)');
    expect(t).toContain('PPP open, peer 10.1.1.2');
    expect(t).toContain('Link control LCP Opened');
    expect(t).toContain('this end requires CHAP of its peer: ✓ succeeded');
    expect(t).toContain('the peer requires CHAP of this end: ✓ succeeded');
    expect(t).toContain('the peer calls itself R2');
    expect(t).toContain('IPv4 (IPCP) Opened · peer 10.1.1.2');
    expect(t).toContain('this end 0x1a2b3c4d · peer 0x0badf00d');
    expect(t).not.toContain('IPV6CP');
  });

  it('a wrong password (§3.9 step 6): the failure, its reason and the count', () => {
    const row = pppRow({
      phase: 'dead',
      lcp: 'stopped',
      authLocalState: 'failed',
      authPeerState: undefined,
      ipcp: 'initial',
      peerAddress: undefined,
      failures: 2,
      lastFailure: 'the response does not match',
      ipv6cp: 'initial',
    });
    const t = text(renderToStaticMarkup(createElement(PppSection, { device: dev([table('ppp', [row])]), port: { id: 'Serial0/0/0' } })));
    expect(t).toContain('Dead (no link yet)');
    expect(t).toContain('PPP authentication failed');
    expect(t).toContain('this end requires CHAP of its peer: ✗ failed');
    expect(t).toContain('Failures 2 last: the response does not match');
    expect(t).toContain('IPv6 (IPV6CP) Initial');
  });

  it('renders nothing for a port without a ppp row', () => {
    expect(renderToStaticMarkup(createElement(PppSection, { device: dev([table('ppp', [pppRow()])]), port: { id: 'Serial0/0/1' } }))).toBe('');
  });
});

// ── tunnels ─────────────────────────────────────────────────────────────────

function tunnelRow(over: Partial<TunnelRow> = {}): TunnelRow {
  return {
    key: 'Tunnel0',
    updatedAt: 0,
    port: 'Tunnel0',
    mode: 'gre',
    source: '209.165.200.225',
    sourceIface: 'Serial0/0/0',
    destination: '209.165.200.230',
    state: 'up',
    transportMtu: 1500,
    ipMtu: 1476,
    since: 60 * S,
    ...over,
  };
}

function saRow(over: Partial<IpsecSaRow> = {}): IpsecSaRow {
  return {
    key: 'Tunnel0',
    updatedAt: 0,
    port: 'Tunnel0',
    local: '209.165.200.225',
    peer: '209.165.200.230',
    profile: 'VPN',
    role: 'initiator',
    state: 'established',
    ikeSpiI: '0123456789abcdef',
    ikeSpiR: 'fedcba9876543210',
    espSpiIn: 0x1001,
    espSpiOut: 0x2002,
    proposal: 'aes-cbc-256 sha256 group14',
    since: 61 * S,
    ...over,
  };
}

const IPSEC_CONFIG = [
  'crypto ipsec profile VPN',
  ' set ikev2-profile PROF',
  'interface Tunnel0',
  ' ip address 172.16.0.1 255.255.255.252',
  ' tunnel source Serial0/0/0',
  ' tunnel destination 209.165.200.230',
  ' tunnel mode ipsec ipv4',
  ' tunnel protection ipsec profile VPN',
  'interface Tunnel1',
  ' tunnel protection ipsec profile OTHER',
].join('\n');

const GRE_STATE: StateView = {
  process: 'gre',
  state: { tunnels: [{ port: 'Tunnel0', mode: 'ipsec', state: 'up', encaps: 12, decaps: 11, mtuDrops: 1, mssClamped: 0, seqOut: 12, lastSeqIn: 11, noSa: 0 }] },
};

describe('[S18]/[C13] the Tunnel section', () => {
  it('reads the protection line of the tunnel interface only', () => {
    expect(tunnelProtectionProfile(IPSEC_CONFIG, 'Tunnel0')).toBe('VPN');
    expect(tunnelProtectionProfile(IPSEC_CONFIG, 'Tunnel1')).toBe('OTHER');
    expect(tunnelProtectionProfile(IPSEC_CONFIG, 'Tunnel2')).toBeUndefined();
    expect(tunnelProtectionProfile('', 'Tunnel0')).toBeUndefined();
  });

  it('words: the state with its reason, the SA, an SPI', () => {
    expect(tunnelStateText({ state: 'up' })).toBe('● up');
    expect(tunnelStateText({ state: 'down', reason: 'no-route' })).toBe('▲ down: no route to the tunnel destination');
    expect(tunnelStateText({ state: 'down' })).toBe('▲ down');
    expect(ipsecSaText({ state: 'established' })).toBe('● established');
    expect(ipsecSaText({ state: 'failed', reason: 'ike-failed' })).toBe('✗ failed: key negotiation failed');
    expect(ipsecSaText({ state: 'negotiating' })).toBe('◔ negotiating');
    expect(spiText(0x1001)).toBe('0x00001001');
  });

  it('the gre StateView counters, and the facts of a GRE tunnel without an SA', () => {
    expect(tunnelCountersOf({ processes: [GRE_STATE] }, 'Tunnel0')).toEqual({ encaps: 12, decaps: 11, mtuDrops: 1, noSa: 0 });
    expect(tunnelCountersOf({ processes: [GRE_STATE] }, 'Tunnel9')).toBeUndefined();
    expect(tunnelCountersOf({ processes: [] }, 'Tunnel0')).toBeUndefined();
    const f = tunnelFacts(dev([table('tunnels', [tunnelRow()])]), 'Tunnel0');
    expect(f?.tunnel.mode).toBe('gre');
    expect(f?.sa).toBeUndefined();
    expect(f?.profile).toBeUndefined();
    expect(tunnelFacts(dev([]), 'Tunnel0')).toBeUndefined();
  });

  it('a GRE tunnel (§3.10): mode, ends, state, MTUs; no IPsec lines', () => {
    const t = text(renderToStaticMarkup(createElement(TunnelSection, { device: dev([table('tunnels', [tunnelRow()])]), port: { id: 'Tunnel0' } })));
    expect(t).toContain('Mode GRE over IPv4 (tunnel mode gre ip)');
    expect(t).toContain('Source 209.165.200.225 (Serial0/0/0)');
    expect(t).toContain('Destination 209.165.200.230');
    expect(t).toContain('State ● up');
    expect(t).toContain('IP MTU 1476 bytes · transport 1500 bytes');
    expect(t).not.toContain('Protection');
    expect(t).not.toContain('Security association');
  });

  it('a GRE tunnel down without a route says why', () => {
    const row = tunnelRow({ state: 'down', reason: 'no-route' });
    const t = text(renderToStaticMarkup(createElement(TunnelSection, { device: dev([table('tunnels', [row])]), port: { id: 'Tunnel0' } })));
    expect(t).toContain('▲ down: no route to the tunnel destination');
  });

  it('[C13] an IPsec VTI (§3.13): the profile, the established SA, the IP MTU 1456 and the counters', () => {
    const d = dev([table('tunnels', [tunnelRow({ mode: 'ipsec', ipMtu: 1456 })]), table('ipsec-sa', [saRow()])], [GRE_STATE], IPSEC_CONFIG);
    const html = renderToStaticMarkup(createElement(TunnelSection, { device: d, port: { id: 'Tunnel0' } }));
    const t = text(html);
    expect(html).toContain('aria-label="Tunnel"');
    expect(t).toContain('Mode IPsec virtual tunnel interface (tunnel mode ipsec ipv4)');
    expect(t).toContain('IP MTU 1456 bytes · transport 1500 bytes');
    expect(t).toContain('Protection IPsec profile VPN');
    expect(t).toContain('Security association ● established');
    expect(t).toContain('this router started the exchange (initiator)');
    expect(t).toContain('aes-cbc-256 sha256 group14');
    expect(t).toContain('ESP SPI in 0x00001001 · out 0x00002002');
    expect(t).toContain('12 encrypted and sent · 11 received and decrypted');
    expect(t).toContain('1 too big for the tunnel');
  });

  it('[C13] a failed key exchange (§3.13 step 10): the tunnel and the SA say why; the profile comes from the line', () => {
    const d = dev(
      [table('tunnels', [tunnelRow({ mode: 'ipsec', ipMtu: 1456, state: 'down', reason: 'ike-failed' })]), table('ipsec-sa', [saRow({ state: 'failed', reason: 'ike-failed', role: 'responder', profile: 'VPN' })])],
      [],
      IPSEC_CONFIG,
    );
    const t = text(renderToStaticMarkup(createElement(TunnelSection, { device: d, port: { id: 'Tunnel0' } })));
    expect(t).toContain('State ▲ down: key negotiation failed');
    expect(t).toContain('Security association ✗ failed: key negotiation failed');
    expect(t).toContain('the peer started the exchange (responder)');
    // before ike writes a row, the profile is read from the interface's protection line
    const early = dev([table('tunnels', [tunnelRow({ mode: 'ipsec', ipMtu: 1456, state: 'down', reason: 'ike-negotiating' })])], [], IPSEC_CONFIG);
    const t2 = text(renderToStaticMarkup(createElement(TunnelSection, { device: early, port: { id: 'Tunnel0' } })));
    expect(t2).toContain('Protection IPsec profile VPN');
    expect(t2).toContain('Security association none yet');
    expect(t2).toContain('▲ down: negotiating keys');
  });

  it('renders nothing for a port without a tunnels row', () => {
    expect(renderToStaticMarkup(createElement(TunnelSection, { device: dev([table('tunnels', [tunnelRow()])]), port: { id: 'Tunnel1' } }))).toBe('');
  });
});
