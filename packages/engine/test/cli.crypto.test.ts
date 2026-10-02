/**
 * cli.crypto — [C13] the IKEv2 keyring, IKEv2 profile and IPsec profile sections and the tunnel protection line
 * (ARCHITECTURE-P3 §2.17, §5.7, D27; §7 W2 cli, approved items): the four crypto modes (prompts, parents, not
 * reserved, §9.2 item 22), the canonical stored sections, the protection refusal on a GRE tunnel and the note for a
 * profile that does not exist yet, and the mode walk through the runtime.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, MODES } from '../src/contracts/cli.js';
import { AUTH_SIDE_ARG, CRYPTO_HANDLERS as H, CRYPTO_MODES } from '../src/cli/grammar/crypto.js';
import { TUNNEL_MODE_ARG, WAN_HANDLERS } from '../src/cli/grammar/wan.js';
import { MSG_NO_IKEV2_PROFILE, MSG_NO_KEYRING } from '../src/cli/handlers/crypto.js';
import { modeForContext } from '../src/cli/modes.js';
import { CONFIG_SECRET_MASK } from '../src/cli/config-rules.js';
import { approvedCtx, approvedHarness, body, handlerOf, parse, routerPortsWithTunnel, run } from './cli.p3-approved.fixture.js';

const R = 'router.nf2911';
const KEYRING = ['crypto', 'ikev2', 'keyring', 'KR'];
const PEER = ['peer', 'R2'];
const PROFILE = ['crypto', 'ikev2', 'profile', 'PROF'];
const IPSEC = ['crypto', 'ipsec', 'profile', 'VPN'];

describe('cli.crypto modes and grammar', () => {
  it('registers the four crypto modes with their prompts and parents, none reserved', () => {
    expect(MODES[CRYPTO_MODES.keyring]).toMatchObject({ prompt: '(config-ikev2-keyring)#', parent: 'config' });
    expect(MODES[CRYPTO_MODES.peer]).toMatchObject({ prompt: '(config-ikev2-keyring-peer)#', parent: CRYPTO_MODES.keyring });
    expect(MODES[CRYPTO_MODES.ikev2Profile]).toMatchObject({ prompt: '(config-ikev2-profile)#', parent: 'config' });
    expect(MODES[CRYPTO_MODES.ipsecProfile]).toMatchObject({ prompt: '(ipsec-profile)#', parent: 'config' });
    for (const m of Object.values(CRYPTO_MODES)) expect(MODES[m]?.reserved, m).toBeUndefined();
    expect(modeForContext([KEYRING])).toBe(CRYPTO_MODES.keyring);
    expect(modeForContext([KEYRING, PEER])).toBe(CRYPTO_MODES.peer);
    expect(modeForContext([PROFILE])).toBe(CRYPTO_MODES.ikev2Profile);
    expect(modeForContext([IPSEC])).toBe(CRYPTO_MODES.ipsecProfile);
  });

  it('parses each line in its own mode, on routing devices only', () => {
    expect(handlerOf(R, 'config', 'crypto ikev2 keyring KR')).toBe(H.configCryptoIkev2Keyring);
    expect(handlerOf(R, CRYPTO_MODES.keyring, 'peer R2')).toBe(H.keyringPeer);
    expect(handlerOf(R, CRYPTO_MODES.peer, 'address 209.165.200.230')).toBe(H.keyringPeerAddress);
    expect(handlerOf(R, CRYPTO_MODES.peer, 'pre-shared-key lab key')).toBe(H.keyringPeerPreSharedKey);
    expect(handlerOf(R, 'config', 'crypto ikev2 profile PROF')).toBe(H.configCryptoIkev2Profile);
    expect(handlerOf(R, CRYPTO_MODES.ikev2Profile, 'match identity remote address 209.165.200.230 255.255.255.255')).toBe(H.ikev2ProfileMatchIdentity);
    expect(handlerOf(R, CRYPTO_MODES.ikev2Profile, 'authentication local pre-share')).toBe(H.ikev2ProfileAuthentication);
    expect(handlerOf(R, CRYPTO_MODES.ikev2Profile, 'authentication remote pre-share')).toBe(H.ikev2ProfileAuthentication);
    expect(handlerOf(R, CRYPTO_MODES.ikev2Profile, 'keyring local KR')).toBe(H.ikev2ProfileKeyring);
    expect(handlerOf(R, 'config', 'crypto ipsec profile VPN')).toBe(H.configCryptoIpsecProfile);
    expect(handlerOf(R, CRYPTO_MODES.ipsecProfile, 'set ikev2-profile PROF')).toBe(H.ipsecProfileSetIkev2Profile);
    expect(parse('switch.nfc2960', 'config', 'crypto ikev2 keyring KR').ok).toBe(false);
    // the pre-shared key is a secret: its column is reported so the runtime masks it in history
    const m = parse(R, CRYPTO_MODES.peer, 'pre-shared-key lab key');
    expect(m.ok && m.secretSpans).toEqual([{ column: 15, end: 22 }]);
  });
});

describe('cli.crypto handlers', () => {
  it('builds the three sections in their canonical form', () => {
    const g = approvedCtx(R);
    expect(run(g, H.configCryptoIkev2Keyring, { name: 'KR' })).toEqual({});
    expect(g.enterModeCalls.at(-1)).toEqual({ mode: CRYPTO_MODES.keyring, opts: { context: [KEYRING] } });
    const k = approvedCtx(R, { mode: CRYPTO_MODES.keyring, context: [KEYRING], running: g.running });
    expect(run(k, H.keyringPeer, { name: 'R2' })).toEqual({});
    expect(k.enterModeCalls.at(-1)).toEqual({ mode: CRYPTO_MODES.peer, opts: { context: [KEYRING, PEER] } });
    const p = approvedCtx(R, { mode: CRYPTO_MODES.peer, context: [KEYRING, PEER], running: g.running });
    expect(run(p, H.keyringPeerPreSharedKey, { secret: 'lab key' })).toEqual({});
    expect(run(p, H.keyringPeerAddress, { address: '209.165.200.230' })).toEqual({});
    run(g, H.configCryptoIkev2Profile, { name: 'PROF' });
    const f = approvedCtx(R, { mode: CRYPTO_MODES.ikev2Profile, context: [PROFILE], running: g.running });
    expect(run(f, H.ikev2ProfileKeyring, { name: 'KR' })).toEqual({});
    expect(run(f, H.ikev2ProfileAuthentication, { [AUTH_SIDE_ARG]: 'remote' })).toEqual({});
    expect(run(f, H.ikev2ProfileAuthentication, { [AUTH_SIDE_ARG]: 'local' })).toEqual({});
    expect(run(f, H.ikev2ProfileMatchIdentity, { address: '209.165.200.230' })).toEqual({});
    run(g, H.configCryptoIpsecProfile, { name: 'VPN' });
    const v = approvedCtx(R, { mode: CRYPTO_MODES.ipsecProfile, context: [IPSEC], running: g.running });
    expect(run(v, H.ipsecProfileSetIkev2Profile, { name: 'PROF' })).toEqual({});
    expect(body(g)).toEqual([
      'crypto ikev2 keyring KR',
      ' peer R2',
      '  address 209.165.200.230',
      '  pre-shared-key lab key',
      'crypto ikev2 profile PROF',
      ' match identity remote address 209.165.200.230 255.255.255.255',
      ' authentication remote pre-share',
      ' authentication local pre-share',
      ' keyring local KR',
      'crypto ipsec profile VPN',
      ' set ikev2-profile PROF',
    ]);
    // `no` forms
    run(f, H.ikev2ProfileMatchIdentity, {}, true);
    run(f, H.ikev2ProfileAuthentication, { [AUTH_SIDE_ARG]: 'remote' }, true);
    run(p, H.keyringPeerAddress, {}, true);
    run(k, H.keyringPeer, { name: 'R2' }, true);
    run(g, H.configCryptoIpsecProfile, { name: 'VPN' }, true);
    expect(body(g)).toEqual([
      'crypto ikev2 keyring KR',
      'crypto ikev2 profile PROF',
      ' authentication local pre-share',
      ' keyring local KR',
    ]);
  });

  it('refuses section lines typed outside their section', () => {
    expect(run(approvedCtx(R), H.keyringPeer, { name: 'R2' })).toEqual({ error: MSG_NO_KEYRING });
    expect(run(approvedCtx(R), H.ikev2ProfileKeyring, { name: 'KR' })).toEqual({ error: MSG_NO_IKEV2_PROFILE });
  });

  it('tunnel protection needs the IPsec mode, and notes a profile that does not exist yet', () => {
    const r = approvedCtx(R, { ports: routerPortsWithTunnel(), iface: 'Tunnel0' });
    expect(run(r, WAN_HANDLERS.ifTunnelProtection, { name: 'VPN' })).toEqual({ error: CLI_MESSAGES.ipsecProtectionVtiOnly });
    run(r, WAN_HANDLERS.ifTunnelMode, { [TUNNEL_MODE_ARG]: 'ipsec' });
    expect(run(r, WAN_HANDLERS.ifTunnelProtection, { name: 'VPN' })).toEqual({ output: '% There is no IPsec profile named VPN.' });
    expect(r.running.render()).toContain(' tunnel mode ipsec ipv4\n tunnel protection ipsec profile VPN');
    r.ctx.config(['crypto', 'ipsec', 'profile', 'VPN2'], false, []);
    expect(run(r, WAN_HANDLERS.ifTunnelProtection, { name: 'VPN2' })).toEqual({});
    expect(run(r, WAN_HANDLERS.ifTunnelProtection, {}, true)).toEqual({});
    expect(r.running.render()).not.toContain('tunnel protection');
  });
});

describe('cli.crypto through the runtime', () => {
  it('walks keyring → peer → back, with the prompts of §2.11, and masks the key in history', () => {
    const h = approvedHarness();
    h.add('d_1', 'router', 'R1');
    const s = h.cli.open('d_1', 'console');
    for (const line of ['enable', 'configure terminal']) h.cli.exec(s, line);
    expect(h.cli.exec(s, 'crypto ikev2 keyring KR').prompt).toBe('R1(config-ikev2-keyring)#');
    expect(h.cli.exec(s, 'peer R2').prompt).toBe('R1(config-ikev2-keyring-peer)#');
    expect(h.cli.exec(s, 'pre-shared-key lab key').error).toBeUndefined();
    expect(h.cli.session(s)?.history.at(-1)).toBe(`pre-shared-key ${CONFIG_SECRET_MASK}`);
    expect(h.cli.exec(s, 'exit').prompt).toBe('R1(config-ikev2-keyring)#');
    expect(h.cli.exec(s, 'crypto ipsec profile VPN').prompt).toBe('R1(ipsec-profile)#');
    expect(h.devices.get('d_1')?.running.render()).toContain('crypto ikev2 keyring KR\n peer R2\n  pre-shared-key lab key');
  });
});
