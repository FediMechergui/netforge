// P2 GUI command builders (ARCHITECTURE-P2 §5.1, §5.2, §5.5; W3 web-inspector): the port inspector's access-port
// quick action, the Desktop IP configuration app's IPv6 choice (DHCPv6 / router advertisements) and [S4] the IP
// phone's Voice VLAN line, with the field spans that map a refused line back to its input.
import { describe, expect, it } from 'vitest';
import {
  IPV6_ADDRESS_MODES,
  IPV6_MODE_FIELD,
  PANEL_CONFIGURE_OPTIONS,
  VOICE_VLAN_FIELD,
  ipv6ModeCommands,
  isEmptyPlan,
  switchportAccessCommands,
  voiceVlanCommands,
} from '../src/gui/commands.js';
import { fieldAt, mapConfigureResult } from '../src/gui/forms.js';
import type { ConfigureResult } from '@netforge/engine';

describe('switchport quick action', () => {
  it('writes mode access then the access VLAN inside the interface section', () => {
    const p = switchportAccessCommands('GigabitEthernet0/1', 10);
    expect(p.grammar).toBe('nfos');
    expect(p.commands).toEqual(['interface GigabitEthernet0/1', ' switchport mode access', ' switchport access vlan 10']);
    expect(p.options).toBe(PANEL_CONFIGURE_OPTIONS.nfos);
    expect(switchportAccessCommands('Fa0/1', ' 20 ').commands).toEqual(['interface Fa0/1', ' switchport mode access', ' switchport access vlan 20']);
  });

  it('attributes the mode line to `mode` and the VLAN line to `accessVlan`', () => {
    const p = switchportAccessCommands('Fa0/1', 10);
    expect(p.lines[1]!.spans.every((s) => s.field === 'mode')).toBe(true);
    expect(p.lines[2]!.spans.every((s) => s.field === 'accessVlan')).toBe(true);
    expect(p.lines[2]!.spans.map((s) => [s.start, s.end])).toEqual([[1, 11], [12, 18], [19, 23], [24, 26]]);
    expect(fieldAt(p, 2, 24)).toBe('accessVlan');
    expect(fieldAt(p, 0, 0)).toBeNull();
  });

  it('maps a refused VLAN back to the accessVlan field', () => {
    const p = switchportAccessCommands('Fa0/1', 5000);
    const result: ConfigureResult = {
      ok: false,
      applied: 0,
      reverted: true,
      finalMode: 'config-if',
      lines: [
        { index: 0, line: p.commands[0]!, ok: true, output: '', mode: 'config-if' },
        { index: 1, line: p.commands[1]!, ok: true, output: '', mode: 'config-if' },
        { index: 2, line: p.commands[2]!, ok: false, output: '', mode: 'config-if', error: { message: '% VLAN id out of range', column: 24 } },
      ],
    };
    expect(mapConfigureResult(p, result).fieldErrors).toEqual({ accessVlan: 'VLAN id out of range' });
  });
});

describe('IPv6 automatic addressing', () => {
  it('lists the three choices in display order', () => {
    expect(IPV6_ADDRESS_MODES).toEqual(['none', 'autoconfig', 'dhcp']);
    expect(IPV6_MODE_FIELD).toBe('ipv6');
  });

  it('writes the nfos interface lines, removing the mode left before adding the one chosen', () => {
    expect(ipv6ModeCommands('nfos', 'GigabitEthernet0/0', 'dhcp').commands).toEqual(['interface GigabitEthernet0/0', ' ipv6 address dhcp']);
    expect(ipv6ModeCommands('nfos', 'GigabitEthernet0/0', 'dhcp', 'none').commands).toEqual(['interface GigabitEthernet0/0', ' ipv6 address dhcp']);
    expect(ipv6ModeCommands('nfos', 'Gi0/0', 'autoconfig', 'dhcp').commands).toEqual(['interface Gi0/0', ' no ipv6 address dhcp', ' ipv6 address autoconfig']);
    expect(ipv6ModeCommands('nfos', 'Gi0/0', 'none', 'autoconfig').commands).toEqual(['interface Gi0/0', ' no ipv6 address autoconfig']);
    expect(ipv6ModeCommands('nfos', 'Gi0/0', 'dhcp', 'autoconfig').commands).toEqual(['interface Gi0/0', ' no ipv6 address autoconfig', ' ipv6 address dhcp']);
  });

  it('writes the flat host-shell forms, naming the adapter only when it is not the default one', () => {
    expect(ipv6ModeCommands('host', 'GigabitEthernet0', 'dhcp', 'none', 'GigabitEthernet0').commands).toEqual(['ipv6 address dhcp']);
    expect(ipv6ModeCommands('host', 'Wlan0', 'dhcp', 'none', 'GigabitEthernet0').commands).toEqual(['ipv6 address dhcp Wlan0']);
    expect(ipv6ModeCommands('host', 'GigabitEthernet0', 'autoconfig', undefined, 'GigabitEthernet0').commands).toEqual(['ipv6 autoconfig']);
    expect(ipv6ModeCommands('host', 'Wlan0', 'none', 'dhcp', 'GigabitEthernet0').commands).toEqual(['no ipv6 address dhcp Wlan0']);
    expect(ipv6ModeCommands('host', 'GigabitEthernet0', 'dhcp', 'autoconfig', 'GigabitEthernet0').commands).toEqual(['no ipv6 autoconfig', 'ipv6 address dhcp']);
    const p = ipv6ModeCommands('host', 'GigabitEthernet0', 'dhcp', 'none', 'GigabitEthernet0');
    expect(p.options).toBe(PANEL_CONFIGURE_OPTIONS.host);
    expect(p.lines[0]!.indent).toBe(0);
  });

  it('sends nothing when the choice is unchanged or none is chosen without a baseline', () => {
    expect(isEmptyPlan(ipv6ModeCommands('nfos', 'Gi0/0', 'dhcp', 'dhcp'))).toBe(true);
    expect(isEmptyPlan(ipv6ModeCommands('host', 'Gi0', 'none'))).toBe(true);
    expect(isEmptyPlan(ipv6ModeCommands('host', 'Gi0', 'none', 'none'))).toBe(true);
  });

  it('attributes every token to the ipv6 field so a refused line lands on the choice', () => {
    const p = ipv6ModeCommands('nfos', 'Gi0/0', 'dhcp', 'autoconfig');
    for (const line of p.lines.slice(1)) expect(line.spans.every((s) => s.field === 'ipv6')).toBe(true);
    expect(fieldAt(p, 2, 6)).toBe('ipv6');
    const result: ConfigureResult = {
      ok: false,
      applied: 0,
      reverted: true,
      finalMode: 'config-if',
      lines: [
        { index: 0, line: p.commands[0]!, ok: true, output: '', mode: 'config-if' },
        { index: 1, line: p.commands[1]!, ok: true, output: '', mode: 'config-if' },
        { index: 2, line: p.commands[2]!, ok: false, output: '% This interface does not run IPv6', mode: 'config-if' },
      ],
    };
    expect(mapConfigureResult(p, result).fieldErrors).toEqual({ ipv6: 'This interface does not run IPv6' });
  });
});

describe('voice VLAN [S4]', () => {
  it('writes voice vlan <v>, its no form when cleared, and nothing when unchanged', () => {
    expect(VOICE_VLAN_FIELD).toBe('voiceVlan');
    expect(voiceVlanCommands('host', '150').commands).toEqual(['voice vlan 150']);
    expect(voiceVlanCommands('host', ' 150 ', '').commands).toEqual(['voice vlan 150']);
    expect(voiceVlanCommands('host', '', '150').commands).toEqual(['no voice vlan']);
    expect(voiceVlanCommands('nfos', '160', '150').commands).toEqual(['voice vlan 160']);
    expect(isEmptyPlan(voiceVlanCommands('host', '150', '150'))).toBe(true);
    expect(isEmptyPlan(voiceVlanCommands('host', '', ''))).toBe(true);
    expect(isEmptyPlan(voiceVlanCommands('host', ''))).toBe(true);
  });

  it('attributes the line to the voiceVlan field', () => {
    const p = voiceVlanCommands('host', '150');
    expect(p.lines[0]!.spans.map((s) => [s.start, s.end, s.field])).toEqual([[0, 5, 'voiceVlan'], [6, 10, 'voiceVlan'], [11, 14, 'voiceVlan']]);
    expect(fieldAt(p, 0, 11)).toBe('voiceVlan');
  });
});
