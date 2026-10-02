/**
 * cli/grammar/discovery.ts and cli/handlers/discovery.ts (ARCHITECTURE-P3 §5.5, D2, D18; §7 W2 cli part 1): the CDP
 * and LLDP lines, their scope (CDP on routers, managed switches and the controller; LLDP on routers and managed
 * switches; interface lines on Ethernet ports only, D18) and their storage through the W1 config rules (`cdp run` and
 * `cdp enable` keep both forms, D2; `no cdp advertise-v2`, `no lldp transmit|receive` are stored negations; the timers
 * are single slots whose no form restores the default), and one console session on a real P3-stage switch.
 */
import { describe, expect, it } from 'vitest';
import type { CommandHandler, CommandOutcome } from '../src/contracts/cli.js';
import { SEC } from '../src/contracts/time.js';
import { GRAMMAR, HANDLERS } from '../src/cli/grammar/index.js';
import { HANDLER_REGISTRY } from '../src/cli/handlers/index.js';
import { MSG_NO_INTERFACE_SELECTED } from '../src/cli/handlers/common.js';
import { matchCommand } from '../src/cli/parser.js';
import { catalogModel, commandCtxFor, matchContextFor, type RecordingCtx } from './cli.p05.fixture.js';
import { createStagedSimulation } from './staged.world.js';

const ROUTER = catalogModel('router.nf2911');
const SWITCH = catalogModel('switch.nfc2960');
const WLC = catalogModel('wlc.nfwlc9800');
const PC = catalogModel('pc.nfpc');
const GI0 = 'GigabitEthernet0/0';

function run(rec: RecordingCtx, id: string, args: Record<string, string> = {}, negate = false): CommandOutcome {
  const h: CommandHandler | undefined = HANDLER_REGISTRY[id];
  if (h === undefined) throw new Error(`no handler ${id}`);
  return h(rec.ctx, args, negate);
}

const ok = (ctx: ReturnType<typeof matchContextFor>, line: string) => matchCommand(GRAMMAR, ctx, line);

/** Run a typed line through the grammar and its handler on `rec`. */
function typed(rec: RecordingCtx, mode: Parameters<typeof matchContextFor>[1], line: string, iface?: string): CommandOutcome {
  const m = ok(matchContextFor(rec.ctx.model, mode, iface === undefined ? {} : { iface }), line);
  if (!m.ok) throw new Error(`${line}: ${m.error.message}`);
  return run(rec, m.spec.handler, { ...m.args }, m.negated);
}

describe('parsing and scope', () => {
  it('parses every §5.5 discovery line on a router and a switch', () => {
    for (const model of [ROUTER, SWITCH]) {
      const cfg = matchContextFor(model, 'config');
      expect(ok(cfg, 'cdp run')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configCdp }, args: { form: 'run' } });
      expect(ok(cfg, 'no cdp run')).toMatchObject({ ok: true, negated: true });
      expect(ok(cfg, 'cdp timer 30')).toMatchObject({ ok: true, args: { form: 'timer', seconds: '30' } });
      expect(ok(cfg, 'cdp timer 4')).toMatchObject({ ok: false, kind: 'invalid-arg' });
      expect(ok(cfg, 'cdp holdtime 120')).toMatchObject({ ok: true, args: { form: 'holdtime', seconds: '120' } });
      expect(ok(cfg, 'cdp holdtime 9')).toMatchObject({ ok: false, kind: 'invalid-arg' });
      expect(ok(cfg, 'no cdp advertise-v2')).toMatchObject({ ok: true, negated: true, args: { form: 'advertise-v2' } });
      expect(ok(cfg, 'lldp run')).toMatchObject({ ok: true, spec: { handler: HANDLERS.configLldp }, args: { form: 'run' } });
      expect(ok(cfg, 'lldp timer 10')).toMatchObject({ ok: true, args: { form: 'timer', seconds: '10' } });
      expect(ok(cfg, 'lldp holdtime 0')).toMatchObject({ ok: true, args: { form: 'holdtime', seconds: '0' } });
      expect(ok(cfg, 'lldp reinit 6')).toMatchObject({ ok: false, kind: 'invalid-arg' });
      expect(ok(cfg, 'lldp reinit 3')).toMatchObject({ ok: true, args: { form: 'reinit' } });
    }
    const ifc = matchContextFor(ROUTER, 'config-if', { iface: GI0 });
    expect(ok(ifc, 'cdp enable')).toMatchObject({ ok: true, spec: { handler: HANDLERS.ifCdpEnable } });
    expect(ok(ifc, 'no cdp enable')).toMatchObject({ ok: true, negated: true });
    expect(ok(ifc, 'no lldp transmit')).toMatchObject({ ok: true, negated: true, spec: { handler: HANDLERS.ifLldp }, args: { form: 'transmit' } });
    expect(ok(ifc, 'no lldp receive')).toMatchObject({ ok: true, args: { form: 'receive' } });
    expect(ok(matchContextFor(SWITCH, 'config-if', { iface: 'FastEthernet0/1' }), 'no cdp enable').ok).toBe(true);
  });

  it('runs on Ethernet only (D18), CDP also on the controller, neither on a host', () => {
    const serial = matchContextFor(ROUTER, 'config-if', { iface: 'Serial0/0/0' });
    expect(ok(serial, 'cdp enable')).toMatchObject({ ok: false, kind: 'port-unsupported' });
    expect(ok(serial, 'no lldp transmit')).toMatchObject({ ok: false, kind: 'port-unsupported' });
    expect(ok(matchContextFor(WLC, 'config'), 'cdp run').ok).toBe(true);
    expect(ok(matchContextFor(WLC, 'config'), 'lldp run').ok).toBe(false);
    expect(ok(matchContextFor(PC, 'user-exec'), 'cdp run').ok).toBe(false);
  });
});

describe('storage', () => {
  it('cdp run keeps both forms (D2); the timers restore their default with no', () => {
    const r = commandCtxFor(ROUTER, { mode: 'config' });
    expect(typed(r, 'config', 'no cdp run')).toEqual({});
    expect(r.running.render()).toContain('\nno cdp run\n');
    expect(typed(r, 'config', 'cdp run')).toEqual({});
    expect(r.running.render()).toContain('\ncdp run\n');
    expect(r.running.render()).not.toContain('no cdp run');
    typed(r, 'config', 'cdp timer 30');
    typed(r, 'config', 'cdp holdtime 90');
    typed(r, 'config', 'cdp timer 20');
    expect(r.running.render()).toContain('cdp timer 20\ncdp holdtime 90\n');
    expect(r.running.render()).not.toContain('cdp timer 30');
    typed(r, 'config', 'no cdp timer');
    typed(r, 'config', 'no cdp holdtime');
    expect(r.running.render()).not.toMatch(/cdp (timer|holdtime)/);
  });

  it('no cdp advertise-v2 is a stored negation; the positive form removes it', () => {
    const r = commandCtxFor(ROUTER, { mode: 'config' });
    typed(r, 'config', 'cdp advertise-v2');
    expect(r.running.render()).not.toContain('advertise-v2');
    typed(r, 'config', 'no cdp advertise-v2');
    expect(r.running.render()).toContain('\nno cdp advertise-v2\n');
    typed(r, 'config', 'cdp advertise-v2');
    expect(r.running.render()).not.toContain('advertise-v2');
  });

  it('cdp enable keeps both forms on an interface; no lldp transmit|receive are stored negations', () => {
    const r = commandCtxFor(ROUTER, { iface: GI0 });
    expect(typed(r, 'config-if', 'no cdp enable', GI0)).toEqual({});
    expect(typed(r, 'config-if', 'no lldp transmit', GI0)).toEqual({});
    expect(typed(r, 'config-if', 'no lldp receive', GI0)).toEqual({});
    expect(r.running.render()).toContain(`interface ${GI0}\n no cdp enable\n no lldp transmit\n no lldp receive\n`);
    typed(r, 'config-if', 'cdp enable', GI0);
    typed(r, 'config-if', 'lldp transmit', GI0);
    expect(r.running.render()).toContain(`interface ${GI0}\n cdp enable\n no lldp receive\n`);
    expect(run(commandCtxFor(ROUTER, { mode: 'config' }), HANDLERS.ifCdpEnable, {})).toEqual({ error: MSG_NO_INTERFACE_SELECTED });
  });

  it('lldp run, timer, holdtime and reinit', () => {
    const r = commandCtxFor(SWITCH, { mode: 'config' });
    for (const l of ['lldp run', 'lldp timer 10', 'lldp holdtime 40', 'lldp reinit 3']) expect(typed(r, 'config', l), l).toEqual({});
    const text = r.running.render();
    for (const l of ['lldp run', 'lldp timer 10', 'lldp holdtime 40', 'lldp reinit 3']) expect(text, l).toContain(`\n${l}\n`);
    for (const l of ['no lldp run', 'no lldp timer', 'no lldp holdtime', 'no lldp reinit']) expect(typed(r, 'config', l), l).toEqual({});
    expect(r.running.render()).not.toContain('lldp');
  });
});

describe('a console session on a P3-stage switch', () => {
  it('stores the lines and shows them in the running configuration', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    const sw = sim.addDevice({ type: 'switch.nfc2960', name: 'SW1' });
    sim.runFor(60 * SEC);
    const s = sim.cli.open(sw, 'console');
    for (const line of ['enable', 'configure terminal', 'cdp timer 30', 'lldp run', 'interface fa0/1', 'no cdp enable', 'no lldp transmit', 'end']) {
      expect(sim.cli.exec(s, line).error, line).toBeUndefined();
    }
    const text = sim.cli.exec(s, 'show running-config').output;
    expect(text).toContain('cdp timer 30\n');
    expect(text).toContain('lldp run\n');
    expect(text).toContain('interface FastEthernet0/1\n no cdp enable\n no lldp transmit\n');
  });
});
