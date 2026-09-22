/**
 * [S7] `ip proxy-arp` / `no ip proxy-arp` (ARCHITECTURE-P2 §5.2, D2; §7 W2 cli [S7]): a stored negation on a routed
 * interface of a routing device — only `no ip proxy-arp` is stored, `ip proxy-arp` clears the slot, and the arp
 * daemon takes the profile default when no line is stored.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import { BUILTIN_GRAMMAR, P2_HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_NO_INTERFACE_SELECTED } from '../src/cli/handlers/common.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';

const ROUTER = catalogModel('router.nf2911');
const MLS = catalogModel('mlswitch.nfc3650-24');
const GI0 = 'GigabitEthernet0/0';

function run(rec: RecordingCtx, args: Record<string, string> = {}, negate = false): CommandOutcome {
  return (HANDLER_REGISTRY[P2_HANDLERS.ifIpProxyArp] as CommandHandler)(rec.ctx, args, negate);
}

describe('[S7] ip proxy-arp', () => {
  it('stores only the negation; the positive form clears the slot', () => {
    const r = commandCtxFor(ROUTER, { iface: GI0 });
    expect(run(r, {}, true)).toEqual({});
    expect(r.configCalls).toEqual([{ line: ['ip', 'proxy-arp'], negate: true, context: undefined }]);
    expect(r.running.render()).toContain(`interface ${GI0}\n no ip proxy-arp`);
    expect(run(r)).toEqual({});
    expect(r.running.render()).not.toContain('proxy-arp');
    expect(run(r)).toEqual({});
    expect(r.running.render()).not.toContain('proxy-arp');
    expect(run(commandCtxFor(ROUTER, { mode: 'config' })).error).toBe(MSG_NO_INTERFACE_SELECTED);
  });

  it('exists on routed interfaces of routing devices', () => {
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'config-if', { iface: GI0 }), 'ip proxy-arp')).toMatchObject({ ok: true, spec: { handler: P2_HANDLERS.ifIpProxyArp } });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(ROUTER, 'config-if', { iface: GI0 }), 'no ip proxy-arp')).toMatchObject({ ok: true, negated: true });
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(MLS, 'config-if', { iface: 'Vlan1' }), 'ip proxy-arp').ok).toBe(true);
    // a switched port of the multilayer switch holds no address, an L2 switch does not route
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(MLS, 'config-if', { iface: 'GigabitEthernet1/0/1' }), 'ip proxy-arp').ok).toBe(false);
    expect(matchCommand(BUILTIN_GRAMMAR, matchContextFor(catalogModel('switch.nfc2960'), 'config-if', { iface: 'Vlan1' }), 'ip proxy-arp').ok).toBe(false);
  });
});
