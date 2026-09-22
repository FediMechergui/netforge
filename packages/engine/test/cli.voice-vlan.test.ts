/**
 * [S4] `switchport voice vlan <v>` (ARCHITECTURE-P2 §5.1, §7 W2 cli [S4]): stored as typed, a note when the VLAN
 * does not exist yet, refused on a port that is not switched, and shown by `show vlan` and `show interfaces
 * switchport`.
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES, type CommandHandler, type CommandOutcome } from '../src/contracts/cli.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_VOICE_VLAN_MISSING } from '../src/cli/handlers/switchport.js';
import { matchCommand } from '../src/cli/parser.js';
import { readSwitchport } from '../src/protocols/l2/switchport-config.js';
import { commandCtxFor, devicePortViews, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { p2Model } from './cli.p2.fixture.js';

const SW = p2Model('switch.nfc2960');
const MLS = p2Model('mlswitch.nfc3650-24');
const FA1 = 'FastEthernet0/1';

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h = HANDLER_REGISTRY[id] as CommandHandler;
  return h(rec.ctx, args, negate);
}

describe('[S4] switchport voice vlan', () => {
  it('stores the line, with a note while the VLAN does not exist', () => {
    const r = commandCtxFor(SW, { iface: FA1 });
    expect(run(r, P2_HANDLERS.ifSwitchportVoiceVlan, { vlan: '150' })).toEqual({ output: MSG_VOICE_VLAN_MISSING.replace('{vlan}', '150') });
    expect(r.configCalls).toEqual([{ line: ['switchport', 'voice', 'vlan', '150'], negate: false, context: undefined }]);
    expect(readSwitchport(r.running, FA1).voiceVlan).toBe(150);
    r.running.set([], ['vlan', '150']);
    expect(run(r, P2_HANDLERS.ifSwitchportVoiceVlan, { vlan: '150' })).toEqual({});
    expect(run(r, P2_HANDLERS.ifSwitchportVoiceVlan, {}, true)).toEqual({});
    expect(readSwitchport(r.running, FA1).voiceVlan).toBeUndefined();
    expect(run(r, P2_HANDLERS.ifSwitchportVoiceVlan, { vlan: '5000' }).error).toContain('between 1 and 4094');
  });

  it('is refused on a routed port', () => {
    const ports = devicePortViews(MLS, { patch: { 'GigabitEthernet1/0/24': { role: 'routed' } } });
    const r = commandCtxFor(MLS, { iface: 'GigabitEthernet1/0/24', ports });
    expect(run(r, P2_HANDLERS.ifSwitchportVoiceVlan, { vlan: '150' }).error).toBe(CLI_MESSAGES.notSwitchport.replace('{port}', 'GigabitEthernet1/0/24'));
  });

  it('shows in show vlan and show interfaces switchport', () => {
    const r = commandCtxFor(SW, { mode: 'priv-exec' });
    r.running.set([], ['vlan', '150']);
    r.running.set([['vlan', '150']], ['name', 'VOICE']);
    r.running.set([['interface', FA1]], ['switchport', 'mode', 'access']);
    r.running.set([['interface', FA1]], ['switchport', 'access', 'vlan', '10']);
    r.running.set([['interface', FA1]], ['switchport', 'voice', 'vlan', '150']);
    const vlan = run(r, P2_HANDLERS.showVlan, { form: 'id', vlan: '150' }).output ?? '';
    expect(vlan).toMatch(/\n\s*150\s+VOICE\s+active\s+Fa0\/1$/);
    const sp = run(r, P2_HANDLERS.showInterfacesSwitchport, { iface: FA1 }).output ?? '';
    expect(sp).toContain('Voice VLAN: 150 (VOICE)');
    expect(sp).toContain('Access VLAN: 10 (inactive: VLAN 10 does not exist)');
  });

  it('parses on a managed switch port', () => {
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW, 'config-if', { iface: FA1 }), 'switchport voice vlan 150')).toMatchObject({
      ok: true,
      spec: { handler: P2_HANDLERS.ifSwitchportVoiceVlan },
      args: { vlan: '150' },
    });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(SW, 'config-if', { iface: FA1 }), 'no switchport voice vlan')).toMatchObject({ ok: true, negated: true });
  });
});
