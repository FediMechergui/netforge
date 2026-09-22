/**
 * W1 device (ARCHITECTURE-P2 §2.4, §3.0, §3.8, D6, D12, D19): the runtime side of the P2 actions — `l2Changed`
 * fan-out in L2_PROCESSES order (depth-first, inside the caller's budget, then the virtual oper recompute),
 * `errDisable` / `errRecover` / `errDisablePort`, `shutdown` clearing an err-disable cause, `configLine`, and the
 * two P2 ProcessCtx members (`profile`, `transition`). The daemons are fakes on a hand-built model: no catalog model
 * runs vlan/dtp/etherchannel/stp before the W4 flip.
 */
import { describe, expect, it } from 'vitest';
import { L2_PROCESSES } from '../src/contracts/catalog.js';
import type { DeviceModel } from '../src/contracts/device.js';
import type { PortId, ProcessName } from '../src/contracts/ids.js';
import type { Action, DebugEvent, FsmTransition, Process, ProcessCtx, StateView } from '../src/contracts/process.js';
import type { ProcessEvent } from '../src/contracts/transport.js';
import type { ConfigDelta } from '../src/contracts/config.js';
import { ARP_OP_REQUEST, ETHERTYPE_ARP } from '../src/contracts/pdu.js';
import { NF_C2960 } from '../src/device/catalog.js';
import { ACTION_BUDGET, errDisabledMessage, errRecoveredMessage } from '../src/device/device.js';
import { p2Harness, type P2Harness } from './device.p2.harness.js';

/** One recorded call of an L2 fake. */
interface L2Call {
  readonly process: ProcessName;
  readonly kind: 'onEvent' | 'onConfig' | 'init';
  readonly ev?: ProcessEvent;
  readonly delta?: ConfigDelta;
  /** Trace length when the call happened (orders calls against emitted events). */
  readonly traceAt: number;
}

interface L2Script {
  onEvent?: (ctx: ProcessCtx, ev: ProcessEvent) => Action[];
  init?: (ctx: ProcessCtx) => Action[];
}

/** A fake daemon that implements `onEvent` and records every call into the shared `log`. */
function l2Fake(name: ProcessName, log: L2Call[], h: () => P2Harness | undefined, script: L2Script = {}): { factory: () => Process; ctx: () => ProcessCtx | undefined } {
  let seen: ProcessCtx | undefined;
  const proc: Process = {
    name,
    init(ctx) {
      seen = ctx;
      log.push({ process: name, kind: 'init', traceAt: h()?.events.length ?? 0 });
      return script.init ? script.init(ctx) : [];
    },
    onPdu: () => [],
    onTimer: () => [],
    onConfig(ctx, delta) {
      seen = ctx;
      log.push({ process: name, kind: 'onConfig', delta, traceAt: h()?.events.length ?? 0 });
      return [];
    },
    onEvent(ctx, ev) {
      seen = ctx;
      log.push({ process: name, kind: 'onEvent', ev, traceAt: h()?.events.length ?? 0 });
      return script.onEvent ? script.onEvent(ctx, ev) : [];
    },
    stateSnapshot(): StateView {
      return { process: name, state: {} };
    },
    debugEvents(): readonly DebugEvent[] {
      return [];
    },
  };
  return { factory: () => proc, ctx: () => seen };
}

const L2_MODEL_PROCESSES: readonly ProcessName[] = ['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp', 'arp', 'ipv4', 'host'];

/** NF-C2960 with the P2 L2 daemons listed (a hand-built model: the catalog adds them only in W4). */
function l2Model(processes: readonly ProcessName[] = L2_MODEL_PROCESSES): DeviceModel {
  return { ...NF_C2960, processes: [...processes] };
}

/** Boot a hand-built L2 switch whose daemons are all recording fakes. */
function bootL2(opts: { processes?: readonly ProcessName[]; scripts?: Partial<Record<ProcessName, L2Script>> } = {}) {
  const log: L2Call[] = [];
  let harness: P2Harness | undefined;
  const names = opts.processes ?? L2_MODEL_PROCESSES;
  const fakes = new Map(names.map((n) => [n, l2Fake(n, log, () => harness, opts.scripts?.[n])]));
  const factories: Record<ProcessName, () => Process> = {};
  for (const [n, f] of fakes) factories[n] = f.factory;
  harness = p2Harness({ model: l2Model(names), processes: factories });
  harness.run();
  const at = harness.device.bootedAt as number;
  log.length = 0;
  harness.events.length = 0;
  harness.adminCalls.length = 0;
  return { h: harness, log, at, ctx: (n: ProcessName) => fakes.get(n)?.ctx() };
}

const FA1: PortId = 'FastEthernet0/1';

describe('l2Changed: fan-out in L2_PROCESSES order (D6)', () => {
  it('delivers l2.changed to every other L2 daemon present, in L2_PROCESSES order, never to the issuer', () => {
    const { h, log, at } = bootL2();
    h.device.applyActions('vlan', [{ type: 'l2Changed', what: 'vlans', vlan: 10 }], at);
    const events = log.filter((c) => c.kind === 'onEvent');
    expect(events.map((c) => c.process)).toEqual(['eth-switch', 'dtp', 'etherchannel', 'stp']);
    expect(events.map((c) => c.ev)).toEqual([
      { kind: 'l2.changed', what: 'vlans', from: 'vlan', vlan: 10 },
      { kind: 'l2.changed', what: 'vlans', from: 'vlan', vlan: 10 },
      { kind: 'l2.changed', what: 'vlans', from: 'vlan', vlan: 10 },
      { kind: 'l2.changed', what: 'vlans', from: 'vlan', vlan: 10 },
    ]);
    // non-L2 daemons (arp, ipv4, host) never see it
    expect(log.some((c) => ['arp', 'ipv4', 'host'].includes(c.process))).toBe(false);
    expect(L2_PROCESSES).toEqual(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp']);
  });

  it('carries port and vlan only when given, and names a non-L2 issuer as `from`', () => {
    const { h, log, at } = bootL2();
    h.device.applyActions('host', [{ type: 'l2Changed', what: 'trunk', port: FA1 }], at);
    const events = log.filter((c) => c.kind === 'onEvent');
    expect(events.map((c) => c.process)).toEqual(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp']);
    expect(events[0]?.ev).toEqual({ kind: 'l2.changed', what: 'trunk', from: 'host', port: FA1 });
    expect(Object.keys(events[0]?.ev ?? {})).not.toContain('vlan');
  });

  it('skips L2 daemons the model does not run', () => {
    const { h, log, at } = bootL2({ processes: ['eth-switch', 'stp', 'arp', 'ipv4'] });
    h.device.applyActions('stp', [{ type: 'l2Changed', what: 'stp', port: FA1, vlan: 1 }], at);
    expect(log.filter((c) => c.kind === 'onEvent').map((c) => c.process)).toEqual(['eth-switch']);
  });

  it('is depth-first: a target\'s actions are applied before the next target is called', () => {
    const { h, log, at } = bootL2({
      scripts: {
        'eth-switch': { onEvent: () => [{ type: 'log', severity: 6, facility: 'TEST', message: 'eth-switch handled the change' }] },
        dtp: { onEvent: () => [{ type: 'log', severity: 6, facility: 'TEST', message: 'dtp handled the change' }] },
      },
    });
    h.device.applyActions('stp', [{ type: 'l2Changed', what: 'stp', port: FA1, vlan: 1 }], at);
    const calls = log.filter((c) => c.kind === 'onEvent');
    expect(calls.map((c) => [c.process, c.traceAt])).toEqual([
      ['eth-switch', 0],
      ['vlan', 1], // eth-switch's log line was already emitted
      ['dtp', 1],
      ['etherchannel', 2], // …and dtp's
    ]);
    expect(h.kinds('log').map((e) => e.message)).toEqual(['eth-switch handled the change', 'dtp handled the change']);
  });

  it('recomputes virtual oper state after the fan-out', () => {
    const { h, log, at } = bootL2();
    const vlan1 = h.device.port('Vlan1')!;
    vlan1.adminUp = true;
    // a bridged port comes up without the runtime being told: only a recompute can see it
    h.device.port(FA1)!.operUp = true;
    expect(vlan1.operUp).toBe(false);
    h.device.applyActions('vlan', [{ type: 'l2Changed', what: 'vlans', vlan: 1 }], at);
    expect(vlan1.operUp).toBe(true);
    const ps = h.kinds('portState');
    expect(ps).toEqual([{ t: at, kind: 'portState', device: 'd_1', port: 'Vlan1', adminUp: true, operUp: true }]);
    // the recompute ran after every target (its onLinkChange fan-out is not an onEvent)
    const last = log.filter((c) => c.kind === 'onEvent').at(-1)!;
    expect(last.process).toBe('stp');
    expect(last.traceAt).toBe(0);
  });

  it('shares the caller\'s action budget: two daemons re-signalling each other stop at ACTION_BUDGET', () => {
    const { h, log, at } = bootL2({
      processes: ['eth-switch', 'stp'],
      scripts: {
        'eth-switch': { onEvent: () => [{ type: 'l2Changed', what: 'trunk', port: FA1 }] },
        stp: { onEvent: () => [{ type: 'l2Changed', what: 'stp', port: FA1, vlan: 1 }] },
      },
    });
    h.device.applyActions('stp', [{ type: 'l2Changed', what: 'stp', port: FA1, vlan: 1 }], at);
    const n = log.filter((c) => c.kind === 'onEvent').length;
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(ACTION_BUDGET);
  });
});

describe('errDisable / errRecover / errDisablePort (D12, §3.8)', () => {
  it('errDisable sets the cause, emits portState err-disabled and a severity-4 log, and asks the link model to recompute', () => {
    const { h, at } = bootL2();
    const port = h.device.port(FA1)!;
    port.operUp = true;
    const detail = 'address 02:00:00:00:00:99 is not allowed on FastEthernet0/1 (shutdown)';
    h.device.applyActions('eth-switch', [{ type: 'errDisable', port: FA1, cause: 'psecure-violation', detail }], at);
    expect(port.errDisabled).toBe('psecure-violation');
    expect(h.events).toEqual([
      { t: at, kind: 'portState', device: 'd_1', port: FA1, adminUp: true, operUp: true, reason: 'err-disabled' },
      { t: at, kind: 'log', device: 'd_1', severity: 4, facility: 'LINK', message: errDisabledMessage(FA1, 'psecure-violation', detail) },
    ]);
    expect(errDisabledMessage(FA1, 'psecure-violation', detail)).toBe(
      'Interface FastEthernet0/1 is error-disabled by a port security violation: address 02:00:00:00:00:99 is not allowed on FastEthernet0/1 (shutdown).',
    );
    expect(h.adminCalls).toEqual([{ ref: { device: 'd_1', port: FA1 }, adminUp: true, now: at }]);

    // a second errDisable is a no-op
    h.device.applyActions('stp', [{ type: 'errDisable', port: FA1, cause: 'bpduguard' }], at);
    expect(port.errDisabled).toBe('psecure-violation');
    expect(h.events).toHaveLength(2);
    expect(h.adminCalls).toHaveLength(1);

    // the pipeline now refuses frames on the port (step 5)
    const frame = h.pdus.build(
      [
        { proto: 'ethernet', fields: { dst: 'ff:ff:ff:ff:ff:ff', src: '02:00:00:00:00:99', type: ETHERTYPE_ARP } },
        { proto: 'arp', fields: { op: ARP_OP_REQUEST, sha: '02:00:00:00:00:99', spa: '10.0.0.1', tha: '00:00:00:00:00:00', tpa: '10.0.0.2' } },
      ],
      { born: at, origin: 'd_peer' },
    );
    h.device.onFrameArrival(FA1, frame, false, at);
    expect(h.kinds('drop').at(-1)).toMatchObject({ reason: 'port-err-disabled', detail: 'psecure-violation', port: FA1 });
  });

  it('errRecover clears only its own cause, with portState err-recovered and a severity-5 log', () => {
    const { h, at } = bootL2();
    const port = h.device.port(FA1)!;
    h.device.applyActions('eth-switch', [{ type: 'errDisable', port: FA1, cause: 'psecure-violation' }], at);
    h.events.length = 0;
    h.adminCalls.length = 0;
    h.device.applyActions('stp', [{ type: 'errRecover', port: FA1, cause: 'bpduguard' }], at + 1);
    expect(port.errDisabled).toBe('psecure-violation');
    expect(h.events).toEqual([]);
    h.device.applyActions('eth-switch', [{ type: 'errRecover', port: FA1, cause: 'psecure-violation' }], at + 2);
    expect(port.errDisabled).toBeUndefined();
    expect(h.events).toEqual([
      { t: at + 2, kind: 'portState', device: 'd_1', port: FA1, adminUp: true, operUp: false, reason: 'err-recovered' },
      { t: at + 2, kind: 'log', device: 'd_1', severity: 5, facility: 'LINK', message: errRecoveredMessage(FA1, 'psecure-violation') },
    ]);
    expect(errRecoveredMessage(FA1, 'psecure-violation')).toBe(
      'Interface FastEthernet0/1 leaves the error-disabled state (a port security violation) and may come up again.',
    );
    expect(h.adminCalls).toEqual([{ ref: { device: 'd_1', port: FA1 }, adminUp: true, now: at + 2 }]);
    // recovering a port that is not err-disabled does nothing
    h.device.applyActions('eth-switch', [{ type: 'errRecover', port: FA1, cause: 'psecure-violation' }], at + 3);
    expect(h.events).toHaveLength(2);
  });

  it('errDisablePort is the fault path with the same effects; unknown ports are ignored', () => {
    const { h, at } = bootL2();
    h.device.errDisablePort(FA1, 'fault', at + 5);
    expect(h.device.port(FA1)!.errDisabled).toBe('fault');
    expect(h.events).toEqual([
      { t: at + 5, kind: 'portState', device: 'd_1', port: FA1, adminUp: true, operUp: false, reason: 'err-disabled' },
      { t: at + 5, kind: 'log', device: 'd_1', severity: 4, facility: 'LINK', message: 'Interface FastEthernet0/1 is error-disabled by an injected fault.' },
    ]);
    expect(h.adminCalls).toEqual([{ ref: { device: 'd_1', port: FA1 }, adminUp: true, now: at + 5 }]);
    h.device.errDisablePort('FastEthernet0/99', 'fault', at + 6);
    h.device.applyActions('eth-switch', [{ type: 'errDisable', port: 'FastEthernet0/99', cause: 'fault' }], at + 6);
    expect(h.events).toHaveLength(2);
  });

  it('an err-disabled virtual port goes down with reason err-disabled and never reaches the link model', () => {
    const { h, at } = bootL2();
    const vlan1 = h.device.port('Vlan1')!;
    vlan1.adminUp = true;
    h.device.port(FA1)!.operUp = true;
    h.device.applyActions('vlan', [{ type: 'l2Changed', what: 'vlans' }], at);
    expect(vlan1.operUp).toBe(true);
    h.events.length = 0;
    h.device.applyActions('eth-switch', [{ type: 'errDisable', port: 'Vlan1', cause: 'fault' }], at + 1);
    expect(vlan1.operUp).toBe(false);
    expect(h.kinds('portState')).toEqual([
      { t: at + 1, kind: 'portState', device: 'd_1', port: 'Vlan1', adminUp: true, operUp: true, reason: 'err-disabled' },
      { t: at + 1, kind: 'portState', device: 'd_1', port: 'Vlan1', adminUp: true, operUp: false, reason: 'err-disabled' },
    ]);
    expect(h.adminCalls).toEqual([]);
  });

  it('shutdown clears the err-disable cause (so no shutdown recovers the port by hand, §3.8 step 5)', () => {
    const { h, at } = bootL2();
    const port = h.device.port(FA1)!;
    h.device.applyActions('eth-switch', [{ type: 'errDisable', port: FA1, cause: 'psecure-violation' }], at);
    h.device.setPortAdmin(FA1, false, at + 1);
    expect(port.errDisabled).toBeUndefined();
    expect(port.adminUp).toBe(false);
    h.device.setPortAdmin(FA1, true, at + 2);
    expect(port.adminUp).toBe(true);
    expect(h.adminCalls.map((c) => c.adminUp)).toEqual([true, false, true]);

    // already administratively down: `shutdown` still clears a cause set meanwhile
    h.device.setPortAdmin(FA1, false, at + 3);
    h.device.errDisablePort(FA1, 'fault', at + 4);
    expect(port.errDisabled).toBe('fault');
    expect(h.device.applyConfigLine([['interface', FA1]], ['shutdown'], false)).toEqual({ ok: true });
    expect(port.errDisabled).toBeUndefined();
    // `no shutdown` does not clear one
    h.device.errDisablePort(FA1, 'fault', at + 5);
    h.device.setPortAdmin(FA1, true, at + 6);
    expect(port.errDisabled).toBe('fault');
  });
});

describe('configLine (D12 sticky addresses)', () => {
  const STICKY = ['switchport', 'port-security', 'mac-address', 'sticky', '0200.0000.0099'];

  it('applies the line like a typed one: running config, configChange trace, onConfig to every daemon including the issuer', () => {
    const { h, log, at } = bootL2();
    h.device.applyActions('eth-switch', [{ type: 'configLine', context: [['interface', FA1]], line: STICKY, negate: false }], at);
    expect(h.device.running.render()).toContain(`interface ${FA1}\n switchport port-security mac-address sticky 0200.0000.0099`);
    expect(h.kinds('configChange')).toEqual([
      { t: at, kind: 'configChange', device: 'd_1', line: STICKY.join(' '), negate: false, context: [['interface', FA1]] },
    ]);
    const configured = log.filter((c) => c.kind === 'onConfig');
    expect(configured.map((c) => c.process)).toEqual(L2_MODEL_PROCESSES);
    expect(configured[0]?.delta).toMatchObject({ op: 'set', context: [['interface', FA1]] });

    // the same line again changes nothing (no second configChange, no fan-out)
    log.length = 0;
    h.device.applyActions('eth-switch', [{ type: 'configLine', context: [['interface', FA1]], line: STICKY, negate: false }], at + 1);
    expect(h.kinds('configChange')).toHaveLength(1);
    expect(log).toEqual([]);

    // negate removes it
    h.device.applyActions('eth-switch', [{ type: 'configLine', context: [['interface', FA1]], line: STICKY, negate: true }], at + 2);
    expect(h.device.running.render()).not.toContain('mac-address sticky 0200.0000.0099');
    expect(h.kinds('configChange').at(-1)).toMatchObject({ negate: true, line: STICKY.join(' ') });
  });

  it('a refused line leaves a runtime debug line and changes nothing', () => {
    const { h, at } = bootL2();
    h.device.applyActions('eth-switch', [{ type: 'configLine', context: [['interface', 'FastEthernet0/99']], line: STICKY, negate: false }], at);
    expect(h.kinds('configChange')).toEqual([]);
    const debug = h.kinds('debug').map((e) => e.event);
    expect(debug).toEqual([
      { at, device: 'd_1', process: 'eth-switch', category: 'runtime', message: `config line "${STICKY.join(' ')}" refused: Unknown interface FastEthernet0/99` },
    ]);
  });
});

// [S2] ── setPortL3 groups4 (W2 device; ARCHITECTURE-P2 §2.2, §2.4, D15) ─────────────────────────────────────────
describe('[S2] setPortL3 groups4', () => {
  it('merges the joined IPv4 groups like the other members, and isLocalDestination accepts a joined group on the ingress port', () => {
    const { h, at, ctx } = bootL2();
    const port = h.device.port(FA1)!;
    const given = ['224.0.0.102'];
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, groups4: given }], at);
    expect(port.l3).toEqual({ groups4: ['224.0.0.102'] });
    expect(port.l3.groups4).not.toBe(given); // a copy
    // undefined keeps, a value replaces, null clears; the other members are untouched
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, ipv4: { address: '10.0.0.1', prefixLen: 24 } }], at);
    expect(port.l3).toEqual({ ipv4: { address: '10.0.0.1', prefixLen: 24 }, groups4: ['224.0.0.102'] });
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, groups4: ['224.0.0.2', '224.0.0.102'] }], at);
    expect(port.l3.groups4).toEqual(['224.0.0.2', '224.0.0.102']);

    const c = ctx('stp')!;
    expect(c.isLocalDestination('224.0.0.102', FA1)).toBe(true);
    expect(c.isLocalDestination('224.0.0.102', 'FastEthernet0/2')).toBe(false);
    expect(c.isLocalDestination('224.0.0.102')).toBe(true); // any port when the ingress port is not given
    expect(c.isLocalDestination('224.0.0.5', FA1)).toBe(false);

    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: FA1, groups4: null }], at);
    expect(port.l3).toEqual({ ipv4: { address: '10.0.0.1', prefixLen: 24 } });
    expect(c.isLocalDestination('224.0.0.102', FA1)).toBe(false);
    // an unknown port is ignored
    h.device.applyActions('ipv4', [{ type: 'setPortL3', port: 'FastEthernet0/99', groups4: ['224.0.0.2'] }], at);
    expect(h.kinds('drop')).toEqual([]);
  });
});
// [/S2] ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('ProcessCtx P2 members (D2, D19)', () => {
  it('profile follows DeviceSpec.profile (absent = P1); DeviceRuntime.profile agrees', () => {
    const p1 = bootL2();
    expect(p1.ctx('stp')?.profile).toBe('P1');
    expect(p1.h.device.profile).toBe('P1');
    const log: L2Call[] = [];
    const fake = l2Fake('stp', log, () => undefined);
    const p2 = p2Harness({ model: l2Model(['eth-switch', 'stp']), processes: { stp: fake.factory }, profile: 'P2' });
    p2.run();
    expect(fake.ctx()?.profile).toBe('P2');
    expect(p2.device.profile).toBe('P2');
  });

  it('transition emits exactly one debug event carrying the FsmTransition, recorded like ctx.debug', () => {
    const { h, at, ctx } = bootL2();
    const stp = ctx('stp')!;
    const fsm: FsmTransition = {
      machine: 'stp-port',
      subject: 'VLAN0001 FastEthernet0/1',
      port: FA1,
      instance: 1,
      from: 'listening',
      to: 'learning',
      cause: 'forward delay expired',
    };
    stp.transition('spanning-tree events', 'VLAN0001 FastEthernet0/1: listening -> learning', fsm);
    stp.transition('spanning-tree events', 'VLAN0001 FastEthernet0/1: learning -> forwarding', { ...fsm, from: 'learning', to: 'forwarding' }, { cost: 19 });
    const debug = h.kinds('debug');
    expect(debug).toEqual([
      {
        t: at,
        kind: 'debug',
        event: { at, device: 'd_1', process: 'stp', category: 'spanning-tree events', message: 'VLAN0001 FastEthernet0/1: listening -> learning', fsm },
      },
      {
        t: at,
        kind: 'debug',
        event: {
          at,
          device: 'd_1',
          process: 'stp',
          category: 'spanning-tree events',
          message: 'VLAN0001 FastEthernet0/1: learning -> forwarding',
          data: { cost: 19 },
          fsm: { ...fsm, from: 'learning', to: 'forwarding' },
        },
      },
    ]);
    expect(Object.keys(debug[0]!.event)).not.toContain('data');
    // the event holds a copy: the daemon's object can change afterwards without rewriting history
    (fsm as { to: string }).to = 'blocking';
    expect(debug[0]!.event.fsm?.to).toBe('learning');
    expect(h.device.recentDebug(5).map((e) => e.fsm?.to)).toEqual(['learning', 'forwarding']);
  });
});
