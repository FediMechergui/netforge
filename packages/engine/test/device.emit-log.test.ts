/**
 * device.emit-log — [S24] the one log path (ARCHITECTURE-P3 D20, §2.5, §2.7, §2.9; §7 W1 device): every runtime log
 * site (boot "not available", the `log` action, err-disable and recovery, the startup "unknown interface", the admin
 * state, the SVI "VLAN missing" and "VLAN unsupported" lines) emits exactly the P2 `log` trace event, key for key; a
 * `mnemonic` appears only when a P3 caller passes one; and `log.record` reaches a stub `logger` only when the model
 * runs `logger` — for the `log` action depth-first inside the issuer's call, and never back to the logger itself.
 */
import { describe, expect, it } from 'vitest';
import type { Severity } from '../src/contracts/process.js';
import { SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import type { LogRecordEvent } from '../src/contracts/transport.js';
import { ALL_MODEL_INPUTS } from '../src/device/catalog.js';
import { defineModel } from '../src/device/catalog/define.js';
import { errDisabledMessage, errRecoveredMessage, systemStartedMessage } from '../src/device/device.js';
import { vlanMissingMessage, vlanUnsupportedMessage } from '../src/device/ports.js';
import { boot, harness } from './device.harness.js';
import { bootP3, modelCatalog, p3Harness, stubDaemon } from './device.p3.harness.js';
import { createStagedCatalog } from './staged.world.js';

type LogEvent = Extract<TraceEvent, { kind: 'log' }>;

/** The P2 bytes of a log event: exactly these keys in this order, and these values. */
function p2Log(t: number, severity: Severity, facility: string, message: string, device = 'd_1'): string {
  return JSON.stringify({ t, kind: 'log', device, severity, facility, message });
}

const logs = (events: readonly TraceEvent[]): LogEvent[] => events.filter((e): e is LogEvent => e.kind === 'log');

/**
 * §9.2 item 30c (W2 device [S25]): the one log a P3 world's router writes at boot, the extended-logging start line
 * (`%SYS-5-BOOTED`), as its trace bytes and as the `log.record` the logger receives.
 */
const bootLine = (t: number): string =>
  JSON.stringify({ t, kind: 'log', device: 'd_1', severity: 5, facility: 'SYS', message: systemStartedMessage('NF-2911'), mnemonic: 'BOOTED' });
const bootRecord = (at: number): LogRecordEvent => ({ kind: 'log.record', at, severity: 5, facility: 'SYS', message: systemStartedMessage('NF-2911'), mnemonic: 'BOOTED' });

describe('every runtime log site keeps its P2 trace bytes (D20)', () => {
  it('boot: a daemon without a factory', () => {
    const h = harness({ type: 'pc.nfpc', name: 'PC1', processes: {} });
    boot(h);
    const t = h.device.bootedAt as number;
    const got = logs(h.events);
    expect(got.length).toBe(h.device.model.processes.length);
    expect(got.map((e) => JSON.stringify(e))).toEqual(h.device.model.processes.map((p) => p2Log(t, 3, 'SYS', `Process ${p} is not available on this platform`)));
  });

  it('the log action, err-disable and recovery, and the admin state', () => {
    const h = harness({ type: 'router.nf2911', name: 'R1', processes: {} });
    boot(h);
    const from = h.events.length;
    const t = 100 * SEC;
    h.device.applyActions('ipv4', [{ type: 'log', severity: 6, facility: 'TEST', message: 'a daemon line' }], t);
    h.device.applyActions('eth-switch', [{ type: 'errDisable', port: 'GigabitEthernet0/0', cause: 'bpduguard', detail: 'a BPDU arrived' }], t + 1);
    h.device.applyActions('eth-switch', [{ type: 'errRecover', port: 'GigabitEthernet0/0', cause: 'bpduguard' }], t + 2);
    h.device.setPortAdmin('GigabitEthernet0/1', true, t + 3);
    h.device.setPortAdmin('GigabitEthernet0/1', false, t + 4);
    expect(logs(h.events.slice(from)).map((e) => JSON.stringify(e))).toEqual([
      p2Log(t, 6, 'TEST', 'a daemon line'),
      p2Log(t + 1, 4, 'LINK', errDisabledMessage('GigabitEthernet0/0', 'bpduguard', 'a BPDU arrived')),
      p2Log(t + 2, 5, 'LINK', errRecoveredMessage('GigabitEthernet0/0', 'bpduguard')),
      p2Log(t + 3, 3, 'LINK', 'Interface GigabitEthernet0/1 administratively enabled'),
      p2Log(t + 4, 3, 'LINK', 'Interface GigabitEthernet0/1 administratively down'),
    ]);
  });

  it('startup configuration naming an interface the device cannot have', () => {
    const h = harness({ type: 'pc.nfpc', name: 'PC1', processes: {}, startupConfig: 'interface Vlan99\n description x\n' });
    boot(h);
    const t = h.device.bootedAt as number;
    const got = logs(h.events).filter((e) => e.facility === 'SYS' && e.severity === 4);
    expect(got.map((e) => JSON.stringify(e))).toEqual([p2Log(t, 4, 'SYS', 'Startup configuration refers to an unknown interface Vlan99')]);
  });

  it('an SVI whose VLAN does not exist (VLAN-aware switch) and one whose VLAN is unsupported (P1 rule)', () => {
    const sw = harness({ type: 'switch.nfc2960', name: 'SW1', processes: {} });
    boot(sw);
    expect(sw.device.applyConfigLine([], ['interface', 'Vlan10'], false).ok).toBe(true);
    let from = sw.events.length;
    const t = 200 * SEC;
    sw.device.setPortAdmin('Vlan10', true, t);
    expect(logs(sw.events.slice(from)).map((e) => JSON.stringify(e))).toEqual([
      p2Log(t, 3, 'LINK', 'Interface Vlan10 administratively enabled'),
      p2Log(t, 4, 'SYS', vlanMissingMessage('Vlan10', 10)),
    ]);
    // a multilayer switch defined at stage P1 runs no vlan daemon: the P1 wording
    const input = ALL_MODEL_INPUTS.find((i) => i.type === 'mlswitch.nfc3650-24')!;
    const p1 = defineModel(input, 'P1');
    const ml = p3Harness({ catalog: modelCatalog([p1]), type: p1.type, name: 'ML1' });
    bootP3(ml);
    expect(ml.device.applyConfigLine([], ['interface', 'Vlan10'], false).ok).toBe(true);
    from = ml.events.length;
    ml.device.setPortAdmin('Vlan10', true, t);
    expect(logs(ml.events.slice(from)).map((e) => JSON.stringify(e))).toEqual([
      p2Log(t, 3, 'LINK', 'Interface Vlan10 administratively enabled'),
      p2Log(t, 4, 'SYS', vlanUnsupportedMessage('Vlan10')),
    ]);
  });
});

describe('log.record reaches the logger only when the model runs it ([S24])', () => {
  it('emitLog: the trace event (mnemonic last, only when given), then log.record to the stub logger', () => {
    const logger = stubDaemon('logger');
    const h = p3Harness({ catalog: createStagedCatalog({ stage: 'P3', factories: { logger: logger.factory } }), type: 'router.nf2911', profile: 'P3' });
    bootP3(h);
    expect(h.device.model.processes).toContain('logger');
    // every daemon is available: nothing logged at boot but the P3 world's extended-logging start line (§9.2 item 30c)
    const booted = h.device.bootedAt as number;
    expect(logs(h.events).map((e) => JSON.stringify(e))).toEqual([bootLine(booted)]);
    expect(logger.received).toEqual([bootRecord(booted)]);
    const afterBoot = h.events.length;
    const t = 400 * SEC;
    h.device.emitLog(3, 'LINK', 'Interface GigabitEthernet0/2 changed state to down', t, 'UPDOWN');
    h.device.emitLog(5, 'SYS', 'no mnemonic here', t + 1);
    expect(logs(h.events.slice(afterBoot)).map((e) => JSON.stringify(e))).toEqual([
      JSON.stringify({ t, kind: 'log', device: 'd_1', severity: 3, facility: 'LINK', message: 'Interface GigabitEthernet0/2 changed state to down', mnemonic: 'UPDOWN' }),
      p2Log(t + 1, 5, 'SYS', 'no mnemonic here'),
    ]);
    const expected: LogRecordEvent[] = [
      { kind: 'log.record', at: t, severity: 3, facility: 'LINK', message: 'Interface GigabitEthernet0/2 changed state to down', mnemonic: 'UPDOWN' },
      { kind: 'log.record', at: t + 1, severity: 5, facility: 'SYS', message: 'no mnemonic here' },
    ];
    expect(logger.received.slice(1)).toEqual(expected);
    expect(Object.keys(logger.received[2]!)).toEqual(['kind', 'at', 'severity', 'facility', 'message']);
    // the runtime's own sites go through the same path, with their P2 bytes
    const from = h.events.length;
    h.device.setPortAdmin('GigabitEthernet0/0', true, t + 2);
    expect(logs(h.events.slice(from)).map((e) => JSON.stringify(e))).toEqual([p2Log(t + 2, 3, 'LINK', 'Interface GigabitEthernet0/0 administratively enabled')]);
    expect(logger.received.at(-1)).toEqual({ kind: 'log.record', at: t + 2, severity: 3, facility: 'LINK', message: 'Interface GigabitEthernet0/0 administratively enabled' });
  });

  it("the log action: the logger's reaction runs depth-first before the issuer's next action, and is never fed back", () => {
    const logger = stubDaemon('logger', {
      onEvent: (_ctx, ev) => (ev.kind === 'log.record' ? [{ type: 'log', severity: 7, facility: 'LOGGER', message: `seen: ${ev.message}` }] : []),
    });
    const h = p3Harness({ catalog: createStagedCatalog({ stage: 'P3', factories: { logger: logger.factory } }), type: 'router.nf2911', profile: 'P3' });
    bootP3(h);
    // §9.2 item 30c: the boot start line (W2 device [S25]) and the logger's own reaction to it come first
    const boot = systemStartedMessage('NF-2911');
    expect(logs(h.events).map((e) => e.message)).toEqual([boot, `seen: ${boot}`]);
    const afterBoot = h.events.length;
    const t = 500 * SEC;
    h.device.applyActions('ipv4', [
      { type: 'log', severity: 6, facility: 'IP', message: 'first' },
      { type: 'log', severity: 6, facility: 'IP', message: 'second' },
    ], t);
    expect(logs(h.events.slice(afterBoot)).map((e) => e.message)).toEqual(['first', 'seen: first', 'second', 'seen: second']);
    expect(logger.received.map((e) => (e as LogRecordEvent).message)).toEqual([boot, 'first', 'second']);
    // a log line of the logger itself is traced and not handed back
    h.device.applyActions('logger', [{ type: 'log', severity: 4, facility: 'LOGGER', message: 'own line' }], t + 1);
    expect(logs(h.events).at(-1)!.message).toBe('own line');
    expect(logger.received).toHaveLength(3);
  });

  it('a model without logger delivers nothing, even with a logger factory registered', () => {
    const logger = stubDaemon('logger');
    // stage P2: the router runs no logger (the real catalog until the P3 catalog flip; since the flip, ARCHITECTURE-P3
    // §9.2 W4, the stage-P2 catalog of `staged.world`, the real P2-stage models, with the logger factory registered)
    const h = p3Harness({ catalog: createStagedCatalog({ stage: 'P2', factories: { logger: logger.factory } }), type: 'router.nf2911', name: 'R1' });
    bootP3(h);
    h.device.emitLog(3, 'LINK', 'x', 60 * SEC, 'UPDOWN');
    h.device.applyActions('ipv4', [{ type: 'log', severity: 6, facility: 'IP', message: 'y' }], 60 * SEC);
    expect(logger.received).toEqual([]);
    expect(logger.ctx).toBeUndefined();
    // stage P3 with no logger factory: the staged model leaves logger out (since the flip registered the logger, the
    // overlay removes it: staged.world's documented way to model a daemon without a factory)
    const p3 = p3Harness({ catalog: createStagedCatalog({ stage: 'P3', factories: { logger: undefined } }), type: 'router.nf2911', profile: 'P3' });
    bootP3(p3);
    expect(p3.device.model.processes).not.toContain('logger');
    p3.device.emitLog(3, 'LINK', 'z', 60 * SEC);
    // §9.2 item 30c: the P3 world's boot start line is traced too (no logger to receive it), then the emitted line
    expect(logs(p3.events).map((e) => JSON.stringify(e))).toEqual([bootLine(p3.device.bootedAt as number), p2Log(60 * SEC, 3, 'LINK', 'z')]);
  });
});
