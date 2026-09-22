/**
 * W1 l2 [S4] (ARCHITECTURE-P2 §5.1 `switchport voice vlan <v>`, §3.0 step 4 and `carries`): voice VLAN rules.
 * An access port carries its access VLAN untagged (the PC) and its voice VLAN tagged (the phone); a trunk ignores the
 * voice VLAN; the voice VLAN must exist like any other VLAN.
 */
import { describe, expect, it } from 'vitest';
import { configAstFromJson } from '../src/cli/config-ast.js';
import type { ConfigNode } from '../src/contracts/config.js';
import { DEFAULT_SWITCHPORT } from '../src/contracts/port.js';
import type { SwitchportConfig } from '../src/contracts/port.js';
import {
  acceptsVoiceTag,
  carries,
  carryCause,
  classify,
  normaliseForPort,
  vlanExistsIn,
  voiceVlanCarry,
  voiceVlanCause,
} from '../src/protocols/l2/membership.js';
import type { L2PortView } from '../src/protocols/l2/membership.js';
import { isMembershipLine, readSwitchport, readVoiceVlanTokens } from '../src/protocols/l2/switchport-config.js';

const FA1 = 'FastEthernet0/1';
const EXISTS = vlanExistsIn({ has: (k: string) => ['10', '150'].includes(k) });
const PHONE_PORT: SwitchportConfig = { ...DEFAULT_SWITCHPORT, mode: 'access', accessVlan: 10, voiceVlan: 150 };
const ACCESS: L2PortView = { port: FA1, config: PHONE_PORT, oper: 'access' };

function section(lines: readonly string[]) {
  const root: ConfigNode = {
    key: '', args: [], children: [{
      key: 'interface', args: [FA1], children: lines.map((l) => { const t = l.split(' '); return { key: t[0] as string, args: t.slice(1), children: [] }; }),
    }],
  };
  return configAstFromJson(root);
}

describe('[S4] reading `switchport voice vlan`', () => {
  it('reads the voice VLAN; absent means none', () => {
    expect(readSwitchport(section(['switchport mode access', 'switchport access vlan 10', 'switchport voice vlan 150']), FA1)).toEqual(PHONE_PORT);
    expect(readSwitchport(section(['switchport mode access']), FA1).voiceVlan).toBeUndefined();
    expect('voiceVlan' in readSwitchport(section(['switchport mode access']), FA1)).toBe(false);
  });

  it('ignores a voice line that does not name one VLAN', () => {
    expect(readSwitchport(section(['switchport voice vlan 0']), FA1)).toBe(DEFAULT_SWITCHPORT);
    expect(readSwitchport(section(['switchport voice vlan 4095']), FA1)).toBe(DEFAULT_SWITCHPORT);
    expect(readSwitchport(section(['switchport voice vlan none']), FA1)).toBe(DEFAULT_SWITCHPORT);
    expect(readVoiceVlanTokens(['150'])).toBe(150);
    expect(readVoiceVlanTokens(['150', 'extra'])).toBeUndefined();
    expect(readVoiceVlanTokens([])).toBeUndefined();
  });

  it('a voice line change is a membership change (CAM flush trigger)', () => {
    expect(isMembershipLine(['switchport', 'voice', 'vlan', '150'])).toBe(true);
  });
});

describe('[S4] membership of an access port with a voice VLAN', () => {
  it('carries: access VLAN untagged, voice VLAN tagged, nothing else', () => {
    expect(carries(ACCESS, 10, EXISTS)).toBe('untagged');
    expect(carries(ACCESS, 150, EXISTS)).toBe('tagged');
    expect(carries(ACCESS, 1, EXISTS)).toBeUndefined();
    expect(voiceVlanCarry(PHONE_PORT, 150)).toBe('tagged');
    expect(voiceVlanCarry(PHONE_PORT, 10)).toBeUndefined();
    expect(voiceVlanCarry(DEFAULT_SWITCHPORT, 150)).toBeUndefined();
  });

  it('classify: untagged → access VLAN; tagged voice VLAN accepted; another tag filtered', () => {
    expect(classify(ACCESS, undefined, EXISTS)).toEqual({ ok: true, vlan: 10 });
    expect(classify(ACCESS, 0, EXISTS)).toEqual({ ok: true, vlan: 10 });
    expect(classify(ACCESS, 150, EXISTS)).toEqual({ ok: true, vlan: 150 });
    expect(classify(ACCESS, 20, EXISTS)).toEqual({
      ok: false, reason: 'vlan-filtered', detail: 'tagged frame for VLAN 20 on an access port (access VLAN 10)',
    });
    expect(acceptsVoiceTag(PHONE_PORT, 150)).toBe(true);
    expect(acceptsVoiceTag(PHONE_PORT, 10)).toBe(false);
  });

  it('a voice VLAN that does not exist filters the phone traffic', () => {
    const missing: L2PortView = { ...ACCESS, config: { ...PHONE_PORT, voiceVlan: 151 } };
    expect(classify(missing, 151, EXISTS)).toEqual({ ok: false, reason: 'vlan-filtered', detail: 'VLAN 151 does not exist' });
  });

  it('normalisation toward the phone port: push the voice tag, cause `switchport voice vlan <V>`', () => {
    expect(normaliseForPort(ACCESS, 150, false, EXISTS)).toEqual({ want: 'tagged', change: 'push', cause: 'switchport voice vlan 150' });
    expect(normaliseForPort(ACCESS, 150, true, EXISTS)).toEqual({ want: 'tagged', change: 'none', cause: 'switchport voice vlan 150' });
    expect(normaliseForPort(ACCESS, 10, true, EXISTS)).toEqual({ want: 'untagged', change: 'pop', cause: 'switchport access vlan 10' });
    expect(carryCause(ACCESS, 150, 'tagged')).toBe(voiceVlanCause(150));
  });

  it('the voice VLAN equal to the access VLAN stays untagged', () => {
    const same: L2PortView = { ...ACCESS, config: { ...PHONE_PORT, voiceVlan: 10 } };
    expect(carries(same, 10, EXISTS)).toBe('untagged');
    expect(classify(same, 10, EXISTS)).toEqual({ ok: true, vlan: 10 });
  });
});

describe('[S4] a trunk ignores the voice VLAN', () => {
  it('neither carries nor classifies by it', () => {
    const trunk: L2PortView = { port: 'GigabitEthernet0/1', config: { ...PHONE_PORT, mode: 'trunk', allowed: '1,10' }, oper: 'trunk' };
    expect(carries(trunk, 150, EXISTS)).toBeUndefined();
    expect(classify(trunk, 150, EXISTS)).toEqual({ ok: false, reason: 'vlan-filtered', detail: 'VLAN 150 is not allowed on GigabitEthernet0/1' });
    // a dynamic port that negotiated a trunk behaves the same
    const negotiated: L2PortView = { ...trunk, config: { ...trunk.config, mode: 'dynamic-desirable' } };
    expect(carries(negotiated, 150, EXISTS)).toBeUndefined();
  });

  it('a dynamic port that is operationally access uses its voice VLAN', () => {
    const auto: L2PortView = { port: FA1, config: { ...PHONE_PORT, mode: 'dynamic-auto' }, oper: 'access' };
    expect(carries(auto, 150, EXISTS)).toBe('tagged');
    expect(classify(auto, 150, EXISTS)).toEqual({ ok: true, vlan: 150 });
  });
});
