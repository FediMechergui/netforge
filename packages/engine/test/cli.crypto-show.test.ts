/**
 * cli.crypto-show — [C13] `show crypto ikev2 sa` (the §5.8 example byte for byte) and `show crypto ipsec sa [interface
 * <if>]` (SPIs from the `ipsec-sa` row, packet counters from the gre StateView, §2.17), and the `crypto ikev2` debug
 * category (ARCHITECTURE-P3 §2.17, §3.13, §5.8; §7 W3 cli, approved items) — against a fake `ipsec-sa` table and a
 * fake gre StateView.
 */
import { describe, expect, it } from 'vitest';
import type { CommandCtx } from '../src/contracts/cli.js';
import type { IpsecSaRow } from '../src/contracts/tables.js';
import { CRYPTO_DEBUG_CATEGORIES, CRYPTO_GRAMMAR, CRYPTO_HANDLERS as C } from '../src/cli/grammar/crypto.js';
import { ipsecTunnelCounters, MSG_NO_IKE_SA, MSG_NO_IPSEC_SA } from '../src/cli/handlers/crypto.js';
import { approvedCtx, handlerOf, parse, routerPortsWithTunnel, runOn, showCtx, showLines } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const SEC = 1_000_000_000;

/** R1's SA of §3.13 step 5. */
const R1_SA: IpsecSaRow = {
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
  espSpiOut: 0xc0de2002,
  proposal: 'aes-cbc-256 sha256 group14',
  since: 3 * SEC,
};

function ctxOf(rows: readonly IpsecSaRow[], gre?: Record<string, unknown>): CommandCtx {
  const ports = routerPortsWithTunnel();
  ports.set('Tunnel1', { ...ports.get('Tunnel0')!, id: 'Tunnel1' });
  const rec = approvedCtx(R, { mode: 'priv-exec', ports });
  return showCtx(rec, { now: 75 * SEC, rows: { 'ipsec-sa': rows }, ...(gre === undefined ? {} : { states: { gre } }) });
}

describe('cli.crypto-show grammar', () => {
  it('parses the two shows on a router, at user and privileged exec', () => {
    expect(handlerOf(R, 'user-exec', 'show crypto ikev2 sa')).toBe(C.showCryptoIkev2Sa);
    expect(handlerOf(R, 'priv-exec', 'show crypto ipsec sa')).toBe(C.showCryptoIpsecSa);
    const one = parse(R, 'priv-exec', 'show crypto ipsec sa interface Tunnel0', { ports: routerPortsWithTunnel() });
    expect(one.ok && one.args).toMatchObject({ iface: 'Tunnel0' });
    expect(parse('switch.nfc2960', 'priv-exec', 'show crypto ikev2 sa').ok).toBe(false);
  });

  it('registers crypto ikev2, offered on routing devices (the ike row of §2.1)', () => {
    expect(CRYPTO_DEBUG_CATEGORIES.map((d) => [d.category, d.requiresAny])).toEqual([['crypto ikev2', ['routing']]]);
    expect(CRYPTO_GRAMMAR.find((s) => s.path.join(' ') === 'debug crypto ikev2')?.fixedArgs).toEqual({ category: 'crypto ikev2' });
    expect(handlerOf(R, 'priv-exec', 'debug crypto ikev2')).toBe('exec.debug');
    expect(parse('switch.nfc2960', 'priv-exec', 'debug crypto ikev2').ok).toBe(false);
  });
});

describe('show crypto ikev2 sa', () => {
  it('prints the §5.8 example exactly', () => {
    expect(showLines(ctxOf([R1_SA]), C.showCryptoIkev2Sa)).toEqual([
      'Tunnel    Local            Remote           Role       State        Proposal',
      'Tunnel0   209.165.200.225  209.165.200.230  initiator  established  aes-cbc-256 sha256 group14',
    ]);
  });

  it('lists tunnels in port order, a failed exchange with its reason and retry, and says when there is none', () => {
    const failed: IpsecSaRow = { ...R1_SA, key: 'Tunnel1', port: 'Tunnel1', role: 'responder', state: 'failed', reason: 'ike-failed', proposal: undefined } as IpsecSaRow;
    expect(showLines(ctxOf([failed, R1_SA]), C.showCryptoIkev2Sa)).toEqual([
      'Tunnel    Local            Remote           Role       State        Proposal',
      'Tunnel0   209.165.200.225  209.165.200.230  initiator  established  aes-cbc-256 sha256 group14',
      'Tunnel1   209.165.200.225  209.165.200.230  responder  failed       -',
      'Tunnel1: IKE authentication failed; the exchange is retried every 10 s',
    ]);
    expect(showLines(ctxOf([]), C.showCryptoIkev2Sa)).toEqual([MSG_NO_IKE_SA]);
  });
});

describe('show crypto ipsec sa', () => {
  const GRE = { tunnels: [{ port: 'Tunnel0', mode: 'ipsec', state: 'up', encaps: 5, decaps: 4, mtuDrops: 0, mssClamped: 0, seqOut: 5, lastSeqIn: 4, noSa: 1 }] };

  it('prints the SA with its SPIs and the tunnel owner counters', () => {
    expect(showLines(ctxOf([R1_SA], GRE), C.showCryptoIpsecSa)).toEqual([
      'Interface Tunnel0, profile VPN',
      '  Local 209.165.200.225, peer 209.165.200.230, traffic selectors 0.0.0.0/0 both ways',
      '  State established, initiator, for 00:01:12',
      '  Inbound ESP SA: SPI 0x00001001',
      '  Outbound ESP SA: SPI 0xc0de2002',
      '  Packets encapsulated 5, decapsulated 4',
      '  Outbound sequence 5, last inbound sequence 4, dropped for no SA 1',
    ]);
  });

  it('reads zeros without a gre StateView, shows a negotiating SA, and filters one interface', () => {
    const negotiating: IpsecSaRow = { key: 'Tunnel1', updatedAt: 0, port: 'Tunnel1', local: '10.0.0.1', peer: '10.0.0.2', profile: 'P2', role: 'initiator', state: 'negotiating', since: 75 * SEC };
    expect(showLines(ctxOf([R1_SA, negotiating]), C.showCryptoIpsecSa, { iface: 'Tunnel1' })).toEqual([
      'Interface Tunnel1, profile P2',
      '  Local 10.0.0.1, peer 10.0.0.2, traffic selectors 0.0.0.0/0 both ways',
      '  State negotiating, initiator, for 00:00:00',
      '  Inbound ESP SA: SPI none yet',
      '  Outbound ESP SA: SPI none yet',
      '  Packets encapsulated 0, decapsulated 0',
      '  Outbound sequence 0, last inbound sequence 0, dropped for no SA 0',
    ]);
    const failed: IpsecSaRow = { ...negotiating, state: 'failed', reason: 'ike-no-response' };
    expect(showLines(ctxOf([failed]), C.showCryptoIpsecSa)[2]).toBe('  State failed (the peer does not answer IKE), initiator, for 00:00:00');
    expect(showLines(ctxOf([R1_SA]), C.showCryptoIpsecSa, { iface: 'Tunnel1' })).toEqual(['No IPsec security association exists on Tunnel1.']);
    expect(showLines(ctxOf([]), C.showCryptoIpsecSa)).toEqual([MSG_NO_IPSEC_SA]);
    expect(runOn(ctxOf([]), C.showCryptoIpsecSa, { iface: 'Tunnel9' })).toEqual({ error: '% No interface named "Tunnel9" exists on this device.' });
  });

  it('reads the gre counters defensively: a missing or malformed entry counts nothing', () => {
    expect(ipsecTunnelCounters(ctxOf([], { tunnels: 'nope' }), 'Tunnel0')).toEqual({});
    expect(ipsecTunnelCounters(ctxOf([], { tunnels: [{ port: 'Tunnel0', encaps: '5', decaps: 2 }] }), 'Tunnel0')).toEqual({ decaps: 2 });
    expect(ipsecTunnelCounters(ctxOf([]), 'Tunnel0')).toEqual({});
  });
});
