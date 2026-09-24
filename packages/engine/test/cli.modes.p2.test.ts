/**
 * cli/modes.ts P2 (ARCHITECTURE-P2 §2.11; §7 W1 cli): the modes wave 0 registered (`config-if-range`,
 * `config-dhcpv6`, `config-std-nacl`, `config-wlan`, `config-wlc-if`) and the refinement that decides between modes
 * sharing the `interface` context key — a subinterface entry belongs to `config-subif`, an `interface range …` entry
 * to `config-if-range`. The W2 cli item entered both (and `config-vlan`) and dropped their `reserved` flags (§9.2 W2
 * item 12b); every other `interface` entry still maps to `config-if` exactly as in P1.
 */
import { describe, expect, it } from 'vitest';
import { MODES } from '../src/contracts/cli.js';
import {
  contextDepth,
  contextKeyOf,
  exitTarget,
  INTERFACE_RANGE_KEYWORD,
  isSubinterfaceName,
  modeForContext,
  modeForContextEntry,
  modePromptSuffix,
  modesOfClass,
  parentMode,
} from '../src/cli/modes.js';

describe('the P2 modes', () => {
  it('carries the prompts, parents and context keys of §2.11', () => {
    const table: [string, string, string | undefined][] = [
      ['config-if-range', '(config-if-range)#', 'interface'],
      ['config-dhcpv6', '(config-dhcpv6)#', 'ipv6 dhcp pool'],
      ['config-std-nacl', '(config-std-nacl)#', 'ip access-list standard'],
      ['config-wlan', '(config-wlan)#', 'wlan'],
      ['config-wlc-if', '(config-wlc-if)#', 'wlc-interface'],
    ];
    for (const [mode, prompt, key] of table) {
      expect(modePromptSuffix(mode), mode).toBe(prompt);
      expect(parentMode(mode), mode).toBe('config');
      expect(MODES[mode]?.contextKey, mode).toBe(key);
      expect(contextDepth(mode), mode).toBe(1);
      expect(exitTarget(mode, [['interface', 'GigabitEthernet0/1']]), mode).toEqual({ close: false, mode: 'config', context: [] });
    }
    // W2 cli entered config-subif, config-vlan and config-if-range (§9.2 W2 item 12b); W3 cli entered config-dhcpv6
    // and config-std-nacl; W5 cli entered config-wlan and config-wlc-if
    expect(modesOfClass('config')).toEqual(['config', 'config-if', 'config-line', 'dhcp-config', 'config-subif', 'config-vlan', 'config-if-range', 'config-dhcpv6', 'config-std-nacl', 'config-wlan', 'config-wlc-if']);
  });

  it('maps a sub-mode context entry to its mode', () => {
    expect(contextKeyOf(['ipv6', 'dhcp', 'pool', 'LAB6'])).toBe('ipv6 dhcp pool');
    expect(modeForContext([['ipv6', 'dhcp', 'pool', 'LAB6']])).toBe('config-dhcpv6');
    expect(modeForContext([['ip', 'access-list', 'standard', 'LAB']])).toBe('config-std-nacl');
    expect(modeForContext([['wlan', '1', 'CORP', 'corp-net']])).toBe('config-wlan');
    expect(modeForContext([['wlc-interface', 'management']])).toBe('config-wlc-if');
    expect(modeForContext([['vlan', '10']])).toBe('config-vlan');
    // the P1 mappings are untouched
    expect(modeForContext([['interface', 'GigabitEthernet0/0']])).toBe('config-if');
    expect(modeForContext([['ip', 'dhcp', 'pool', 'LAN']])).toBe('dhcp-config');
    expect(modeForContext([])).toBe('config');
  });

  it('recognises subinterface and interface-range entries', () => {
    expect(isSubinterfaceName('GigabitEthernet0/0.10')).toBe(true);
    expect(isSubinterfaceName('g0/0.10')).toBe(true);
    expect(isSubinterfaceName('Port-channel1.5')).toBe(true);
    expect(isSubinterfaceName('GigabitEthernet0/0')).toBe(false);
    expect(isSubinterfaceName('Vlan10')).toBe(false);
    expect(INTERFACE_RANGE_KEYWORD).toBe('range');
    // entered by the W2 cli item: a subinterface entry and a range entry map to their own modes
    expect(modeForContextEntry(['interface', 'GigabitEthernet0/0.10'])).toBe('config-subif');
    expect(modeForContextEntry(['interface', INTERFACE_RANGE_KEYWORD, 'FastEthernet0/1'])).toBe('config-if-range');
    expect(modeForContextEntry(['interface', 'GigabitEthernet0/0'])).toBe('config-if');
    expect(modeForContextEntry(['crypto', 'pki'])).toBeUndefined();
  });
});
