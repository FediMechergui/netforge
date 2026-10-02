/**
 * cli.wan — [S18] tunnel interface lines and [S19] PPP lines (ARCHITECTURE-P3 §5.7, D15, D17; §7 W2 cli, approved
 * items): grammar scope (tunnel role, serial kind), canonical stored lines, the PPP encapsulation now accepted
 * (§9.2 item 30), recoverable passwords for PPP, and the hidden `peer neighbor-route`.
 */
import { describe, expect, it } from 'vitest';
import { HANDLERS as P1_HANDLERS } from '../src/cli/grammar/index.js';
import { MSG_NOT_TUNNEL, MSG_PPP_PORT, TUNNEL_MODE_ARG, WAN_GRAMMAR, WAN_HANDLERS as H } from '../src/cli/grammar/wan.js';
import { MSG_PPP_AUTH_TWICE, MSG_TUNNEL_SOURCE_SELF } from '../src/cli/handlers/wan.js';
import { approvedCtx, body, handlerOf, parse, routerPortsWithTunnel, run } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const TU = { ports: routerPortsWithTunnel(), iface: 'Tunnel0' };

describe('cli.wan grammar', () => {
  it('parses the tunnel lines on a tunnel interface only', () => {
    expect(handlerOf(R, 'config-if', 'tunnel source GigabitEthernet0/0', TU)).toBe(H.ifTunnelSource);
    expect(handlerOf(R, 'config-if', 'tunnel source 209.165.200.225', TU)).toBe(H.ifTunnelSource);
    expect(handlerOf(R, 'config-if', 'tunnel destination 209.165.200.230', TU)).toBe(H.ifTunnelDestination);
    expect(handlerOf(R, 'config-if', 'tunnel mode gre ip', TU)).toBe(H.ifTunnelMode);
    expect(handlerOf(R, 'config-if', 'tunnel mode ipsec ipv4', TU)).toBe(H.ifTunnelMode);
    expect(handlerOf(R, 'config-if', 'tunnel protection ipsec profile VPN', TU)).toBe(H.ifTunnelProtection);
    expect(handlerOf(R, 'config-if', 'ip mtu 1400', TU)).toBe(H.ifIpMtu);
    expect(handlerOf(R, 'config-if', 'ip tcp adjust-mss 1360', TU)).toBe(H.ifIpTcpAdjustMss);
    const onEthernet = parse(R, 'config-if', 'tunnel destination 10.0.0.2', { iface: 'GigabitEthernet0/0' });
    expect(onEthernet.ok).toBe(false);
    if (!onEthernet.ok) expect(onEthernet.error.message).toBe(MSG_NOT_TUNNEL);
    expect(parse(R, 'config-if', 'ip tcp adjust-mss 400', TU).ok).toBe(false);
  });

  it('parses the PPP lines on serial WAN interfaces only, and keeps peer neighbor-route out of help', () => {
    const se = { iface: 'Serial0/0/0' };
    expect(handlerOf(R, 'config-if', 'encapsulation ppp', se)).toBe(P1_HANDLERS.ifEncapsulation);
    expect(handlerOf(R, 'config-if', 'ppp authentication chap', se)).toBe(H.ifPppAuthentication);
    expect(handlerOf(R, 'config-if', 'ppp authentication pap chap', se)).toBe(H.ifPppAuthentication);
    expect(handlerOf(R, 'config-if', 'ppp pap sent-username R1 password labpw', se)).toBe(H.ifPppPapSentUsername);
    expect(handlerOf(R, 'config-if', 'no peer neighbor-route', se)).toBe(H.ifPeerNeighborRoute);
    expect(handlerOf(R, 'config', 'username R2 password lab')).toBe(H.configUsernamePassword);
    const eth = parse(R, 'config-if', 'ppp authentication chap', { iface: 'GigabitEthernet0/0' });
    expect(eth.ok).toBe(false);
    if (!eth.ok) expect(eth.error.message).toBe(MSG_PPP_PORT);
    // a serial access line (NF-CSU-DSU, NF-INTERNET) stays HDLC-only (D17): no PPP line there (W2 fix, finding 3)
    for (const [type, iface] of [['csu.nfcsu', 'Serial0'], ['cloud.nfinternet', 'Serial0']] as const) {
      const line = parse(type, 'config-if', 'ppp authentication chap', { iface });
      expect(line.ok, type).toBe(false);
      if (!line.ok) expect(line.error.message, type).toBe(MSG_PPP_PORT);
    }
    expect(WAN_GRAMMAR.find((s) => s.handler === H.ifPeerNeighborRoute)?.hidden).toBe(true);
  });
});

describe('cli.wan handlers: tunnels', () => {
  it('stores source, destination, MTU and MSS; GRE is the unrendered default mode', () => {
    const r = approvedCtx(R, { ports: routerPortsWithTunnel(), iface: 'Tunnel0' });
    expect(run(r, H.ifTunnelSource, { iface: 'GigabitEthernet0/0' })).toEqual({});
    expect(run(r, H.ifTunnelSource, { iface: 'Tunnel0' })).toEqual({ error: MSG_TUNNEL_SOURCE_SELF });
    expect(run(r, H.ifTunnelDestination, { address: '209.165.200.230' })).toEqual({});
    expect(run(r, H.ifIpMtu, { bytes: '1400' })).toEqual({});
    expect(run(r, H.ifIpTcpAdjustMss, { bytes: '1360' })).toEqual({});
    expect(run(r, H.ifTunnelMode, { [TUNNEL_MODE_ARG]: 'gre' })).toEqual({});
    expect(r.running.render()).toContain(
      'interface Tunnel0\n ip mtu 1400\n ip tcp adjust-mss 1360\n tunnel source GigabitEthernet0/0\n tunnel destination 209.165.200.230',
    );
    expect(r.running.render()).not.toContain('tunnel mode');
    run(r, H.ifTunnelMode, { [TUNNEL_MODE_ARG]: 'ipsec' });
    expect(r.running.render()).toContain(' tunnel mode ipsec ipv4');
    // back to GRE: the stored mode goes
    run(r, H.ifTunnelMode, { [TUNNEL_MODE_ARG]: 'gre' });
    expect(r.running.render()).not.toContain('tunnel mode');
    for (const [id, args] of [
      [H.ifTunnelSource, {}],
      [H.ifTunnelDestination, {}],
      [H.ifIpMtu, {}],
      [H.ifIpTcpAdjustMss, {}],
    ] as const) {
      expect(run(r, id, args, true)).toEqual({});
    }
    expect(r.running.render()).toContain('interface Tunnel0\n!');
  });
});

describe('cli.wan handlers: PPP', () => {
  it('stores the PPP lines; one protocol twice is refused', () => {
    const r = approvedCtx(R, { iface: 'Serial0/0/0' });
    expect(run(r, P1_HANDLERS.ifEncapsulation, { framing: 'ppp' })).toEqual({});
    expect(run(r, H.ifPppAuthentication, { first: 'chap', second: 'chap' })).toEqual({ error: MSG_PPP_AUTH_TWICE });
    expect(run(r, H.ifPppAuthentication, { first: 'pap', second: 'chap' })).toEqual({});
    expect(run(r, H.ifPppPapSentUsername, { name: 'R1', secret: 'lab pw' })).toEqual({});
    expect(run(r, H.ifPeerNeighborRoute, {}, true)).toEqual({});
    expect(r.running.render()).toContain(
      'interface Serial0/0/0\n encapsulation ppp\n ppp authentication pap chap\n ppp pap sent-username R1 password lab pw\n no peer neighbor-route',
    );
    run(r, H.ifPeerNeighborRoute, {});
    run(r, H.ifPppAuthentication, {}, true);
    run(r, H.ifPppPapSentUsername, {}, true);
    expect(r.running.render()).toContain('interface Serial0/0/0\n encapsulation ppp\n!');
  });

  it('stores username passwords recoverably: in the clear, or nf7 under service password-encryption', () => {
    const r = approvedCtx(R);
    expect(run(r, H.configUsernamePassword, { name: 'R2', secret: 'lab' })).toEqual({});
    expect(body(r)).toEqual(['username R2 password lab']);
    r.ctx.config(['service', 'password-encryption'], false, []);
    run(r, H.configUsernamePassword, { name: 'R3', secret: 'lab' });
    expect(body(r).find((l) => l.startsWith('username R3'))).toMatch(/^username R3 password nf7 [0-9a-f]+$/);
    // one entry per user: the password form replaces the secret form, and `no username` removes either
    r.ctx.config(['username', 'R2', 'secret', 'nf1', 'abcd'], false, []);
    run(r, H.configUsernamePassword, { name: 'R2', secret: 'lab2' });
    expect(body(r).filter((l) => l.startsWith('username R2'))).toEqual([expect.stringMatching(/^username R2 password nf7 /)]);
    run(r, H.configUsernamePassword, { name: 'R2' }, true);
    expect(body(r).some((l) => l.startsWith('username R2'))).toBe(false);
  });
});
