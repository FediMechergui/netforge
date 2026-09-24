/**
 * Mode registry helpers (cli/modes.ts), rule lookup (cli/config-rules.ts) and the indentation
 * walker (cli/config-text.ts) — ARCHITECTURE-P1 §3.12, §3.13, §6.
 */
import { describe, expect, it } from 'vitest';
import {
  contextDepth,
  contextKeyOf,
  endTarget,
  exitTarget,
  isConfigClassMode,
  isDoBlocked,
  isExecMode,
  isSubConfigMode,
  modeForContext,
  modePromptSuffix,
  modesOfClass,
  parentMode,
  specModeAllows,
} from '../src/cli/modes.js';
import {
  CONFIG_LINE_RULES,
  CONFIG_SECRET_MASK,
  DEFAULT_CONFIG_RULES,
  maskSecretTokens,
  normalizeConfigLine,
  ruleContextKey,
} from '../src/cli/config-rules.js';
import { tokenizeConfigLine, walkConfigText } from '../src/cli/config-text.js';

describe('modes', () => {
  it('classifies registered and unregistered modes', () => {
    expect(isExecMode('user-exec')).toBe(true);
    expect(isExecMode('priv-exec')).toBe(true);
    expect(isConfigClassMode('config')).toBe(true);
    expect(isSubConfigMode('config')).toBe(false);
    expect(isSubConfigMode('config-if')).toBe(true);
    expect(isSubConfigMode('dhcp-config')).toBe(true);
    expect(isConfigClassMode('login')).toBe(false);
    // unregistered: a config sub-mode (P0 semantics)
    expect(isSubConfigMode('config-something')).toBe(true);
    expect(parentMode('config-something')).toBe('config');
    expect(parentMode('config-line')).toBe('config');
    expect(parentMode('config')).toBe('priv-exec');
  });

  it('derives prompts with the P0 fallback', () => {
    expect(modePromptSuffix('user-exec')).toBe('>');
    expect(modePromptSuffix('config-if')).toBe('(config-if)#');
    expect(modePromptSuffix('dhcp-config')).toBe('(dhcp-config)#');
    expect(modePromptSuffix('config-x')).toBe('(config-x)#');
  });

  it('expands class selectors in spec modes', () => {
    expect(specModeAllows('@config', 'dhcp-config')).toBe(true);
    expect(specModeAllows('@config', 'priv-exec')).toBe(false);
    expect(specModeAllows('@exec', 'priv-exec')).toBe(true);
    expect(specModeAllows('@all', 'login')).toBe(true);
    expect(specModeAllows(['user-exec', '@auth'], 'login')).toBe(true);
    expect(specModeAllows(['config', 'config-if'], 'config-line')).toBe(false);
    expect(modesOfClass('exec')).toEqual(['user-exec', 'priv-exec']);
    // ARCHITECTURE-P2 §9.2 W2 item 12b: the W2 cli item entered config-subif, config-vlan and config-if-range;
    // the W3 cli item entered config-dhcpv6 and config-std-nacl; the W5 cli item config-wlan and config-wlc-if
    // (declaration order)
    expect(modesOfClass('config')).toEqual(['config', 'config-if', 'config-line', 'dhcp-config', 'config-subif', 'config-vlan', 'config-if-range', 'config-dhcpv6', 'config-std-nacl', 'config-wlan', 'config-wlc-if']);
    expect(modesOfClass('exec', { grammar: 'host' })).toEqual(['user-exec']);
  });

  it('maps contexts to keys, modes and depths', () => {
    expect(contextKeyOf(['ip', 'dhcp', 'pool', 'LAN'])).toBe('ip dhcp pool');
    expect(contextKeyOf(['interface', 'Gi0/0'])).toBe('interface');
    expect(contextKeyOf(['crypto', 'pki'])).toBe('crypto');
    expect(modeForContext([])).toBe('config');
    expect(modeForContext([['interface', 'Gi0/0']])).toBe('config-if');
    expect(modeForContext([['ip', 'dhcp', 'pool', 'LAN']])).toBe('dhcp-config');
    expect(contextDepth('config')).toBe(0);
    expect(contextDepth('config-if')).toBe(1);
  });

  it('computes exit/end targets and do blocking', () => {
    expect(exitTarget('config-if', [['interface', 'Gi0/0']])).toEqual({ close: false, mode: 'config', context: [] });
    expect(exitTarget('config', [])).toEqual({ close: false, mode: 'priv-exec', context: [] });
    expect(exitTarget('priv-exec', [])).toEqual({ close: true });
    expect(exitTarget('user-exec', [])).toEqual({ close: true });
    expect(endTarget()).toEqual({ mode: 'priv-exec', context: [] });
    expect(isDoBlocked({ entersMode: 'config' })).toBe(true);
    expect(isDoBlocked({ sessionEffect: 'close' })).toBe(true);
    expect(isDoBlocked({})).toBe(false);
  });
});

describe('config rules', () => {
  const rf = DEFAULT_CONFIG_RULES.ruleFor;

  it('every rule is well formed', () => {
    for (const r of CONFIG_LINE_RULES) {
      expect(r.identity).toBeGreaterThanOrEqual(1);
      expect(r.contexts.length).toBeGreaterThan(0);
      if (r.section !== undefined) expect(r.group).toBeUndefined();
      if (r.freeTextFrom !== undefined) expect(r.pattern[r.freeTextFrom]).toBe('<rest>');
    }
  });

  it('picks the most specific rule per context', () => {
    expect(rf([], ['ip', 'dhcp', 'pool', 'LAN'])?.section?.mode).toBe('dhcp-config');
    expect(rf([], ['ip', 'dhcp', 'excluded-address', '10.0.0.1'])?.identity).toBe(3);
    expect(rf([], ['ip', 'route', '0.0.0.0', '0.0.0.0', '10.0.0.1'])?.renderSlot).toBe('ip-post');
    expect(rf([], ['ip', 'domain-lookup'])?.renderSlot).toBe('ip-pre');
    expect(rf([], ['ip', 'something', 'else'])?.pattern).toEqual(['ip', '<setting>', '<rest>']);
    expect(rf([['interface', 'Gi0/0']], ['switchport'])?.storeNegation).toBe(true);
    expect(rf([['interface', 'Gi0/0']], ['ip', 'address', '10.0.0.1', '255.0.0.0'])?.cardinality).toBe('single');
    expect(rf([['ip', 'dhcp', 'pool', 'LAN']], ['network', '10.0.0.0', '255.0.0.0'])?.cardinality).toBe('single');
    expect(rf([], ['switchport'])).toBeUndefined();
    expect(rf([], ['logging', 'buffered'])).toBeUndefined();
    expect(ruleContextKey([['line', 'vty', '0', '4']])).toBe('line');
  });

  it('normalizes free text and masks secrets', () => {
    const wl = [['interface', 'Wlan0']];
    expect(normalizeConfigLine(wl, ['ssid', 'Home', 'Net'])).toEqual(['ssid', 'Home Net']);
    expect(normalizeConfigLine([], ['banner', 'motd', '#Hi', 'there#'])).toEqual(['banner', 'motd', 'Hi there']);
    expect(maskSecretTokens(wl, ['passphrase', 'secret words'])).toEqual(['passphrase', CONFIG_SECRET_MASK]);
    expect(maskSecretTokens([], ['enable', 'secret', 'lab'])).toEqual(['enable', 'secret', CONFIG_SECRET_MASK]);
    expect(maskSecretTokens([], ['hostname', 'R1'])).toEqual(['hostname', 'R1']);
  });
});

describe('config text walker', () => {
  it('tokenizes banners as one text token', () => {
    expect(tokenizeConfigLine('banner motd ^C  two  spaces ^C')).toEqual(['banner', 'motd', '^C  two  spaces ^C']);
    expect(tokenizeConfigLine('ip  address 10.0.0.1   255.0.0.0')).toEqual(['ip', 'address', '10.0.0.1', '255.0.0.0']);
  });

  it('assigns contexts by indentation, marks negations and numbers source lines', () => {
    const text = [
      '! comment',
      'version 1.0',
      'hostname R1',
      'ip dhcp pool LAN',
      ' network 10.0.0.0 255.255.255.0',
      'interface GigabitEthernet0/0',
      '   no shutdown',
      ' description  core   link',
      'no ip domain-lookup',
      'end',
    ].join('\r\n');
    const lines = walkConfigText(text);
    expect(lines.map((l) => [l.lineNo, l.depth, l.context, l.tokens, l.negate])).toEqual([
      [3, 0, [], ['hostname', 'R1'], false],
      [4, 0, [], ['ip', 'dhcp', 'pool', 'LAN'], false],
      [5, 1, [['ip', 'dhcp', 'pool', 'LAN']], ['network', '10.0.0.0', '255.255.255.0'], false],
      [6, 0, [], ['interface', 'GigabitEthernet0/0'], false],
      [7, 3, [['interface', 'GigabitEthernet0/0']], ['shutdown'], true],
      [8, 1, [['interface', 'GigabitEthernet0/0']], ['description', 'core', 'link'], false],
      [9, 0, [], ['ip', 'domain-lookup'], true],
    ]);
  });

  it('nests by relative indentation of any width', () => {
    const text = ['interface Serial0/0/0', '  ip address 10.0.0.1 255.255.255.252', '  clock rate 64000', 'ip dhcp pool LAN', '    network 10.0.0.0 255.255.255.0', '    lease 1'].join('\n');
    expect(walkConfigText(text).map((l) => [l.context.map((e) => e[0]), l.tokens[0]])).toEqual([
      [[], 'interface'],
      [['interface'], 'ip'],
      [['interface'], 'clock'],
      [[], 'ip'],
      [['ip'], 'network'],
      [['ip'], 'lease'],
    ]);
  });
});
