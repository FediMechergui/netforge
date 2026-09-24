/**
 * W2 l2 (ARCHITECTURE-P2 §3.8 port security, §3.0 step 7 and the flush table, D12, §13 #12): the `port-security` row,
 * secure rows learned idempotently (a sticky learn followed by 10 frames from the same host: no violation, one
 * configChange, the secure row kept), the three violation modes, err-disable and automatic recovery.
 */
import { describe, expect, it } from 'vitest';
import { MAC_BROADCAST } from '../src/contracts/addr.js';
import type { Action } from '../src/contracts/process.js';
import { camKey, vlanKey } from '../src/contracts/tables.js';
import type { PortSecurityRow, VlanRow } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { createEthSwitch } from '../src/protocols/eth-switch.js';
import {
  PORT_SECURITY_DEBUG_CATEGORY,
  PORT_SECURITY_LOG_FACILITY,
  errdisableTimerKey,
  psecNotAllowedDetail,
  psecSecuredElsewhereDetail,
  stickyConfigLine,
} from '../src/protocols/l2/port-security.js';
import { FA1, FA2, FA3, MAC_A, MAC_B, MAC_X, p2SwitchHarness, sendsOf } from './l2.eth-switch.p2.harness.js';
import type { P2SwitchHarness } from './l2.eth-switch.p2.harness.js';

/** SW1 of §3.8: Fa0/1 access, port security, maximum 1, sticky (violation shutdown by default). */
function setup(extra: readonly string[] = ['switchport port-security mac-address sticky'], violation?: string) {
  const h = p2SwitchHarness();
  const sw = createEthSwitch();
  h.tables.get<VlanRow>('vlans')!.set({ key: vlanKey(10), vlan: 10, name: 'SALES', status: 'active', source: 'config', updatedAt: 0 });
  h.lines(sw, FA1, ['switchport mode access', 'switchport port-security', 'switchport port-security maximum 1', ...extra, ...(violation === undefined ? [] : [`switchport port-security violation ${violation}`])]);
  sw.init!(h.ctx);
  return { h, sw };
}

const psec = (h: P2SwitchHarness) => h.tables.get<PortSecurityRow>('port-security')!;
const configLines = (actions: readonly Action[]) => actions.filter((a) => a.type === 'configLine');
const drops = (actions: readonly Action[]) => actions.filter((a): a is Extract<Action, { type: 'drop' }> => a.type === 'drop');

describe('§3.8 step 1 — the port-security row', () => {
  it('`switchport port-security` writes the row with the defaults; the other lines update it; `no` removes it', () => {
    const h = p2SwitchHarness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.lines(sw, FA1, ['switchport mode access', 'switchport port-security']);
    expect(psec(h).get(FA1)).toMatchObject({ port: FA1, max: 1, count: 0, violation: 'shutdown', sticky: false, violations: 0, status: 'secure-up' });
    h.lines(sw, FA1, ['switchport port-security maximum 3', 'switchport port-security violation restrict', 'switchport port-security mac-address sticky']);
    expect(psec(h).get(FA1)).toMatchObject({ max: 3, violation: 'restrict', sticky: true, count: 0 });
    expect(psec(h).size).toBe(1);
    expect(h.debug.filter((d) => d.category === PORT_SECURITY_DEBUG_CATEGORY).map((d) => d.message)).toEqual([
      `port security enabled on ${FA1}: maximum 1, violation shutdown`,
    ]);
    h.lines(sw, FA1, ['no switchport port-security']);
    expect(psec(h).size).toBe(0);
  });

  it('a `mac-address <mac>` line installs a configured secure row before any frame; reload-style replay is idempotent', () => {
    const h = p2SwitchHarness();
    const sw = createEthSwitch();
    sw.init!(h.ctx);
    h.lines(sw, FA1, ['switchport mode access', 'switchport port-security', `switchport port-security mac-address ${MAC_A}`]);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ port: FA1, type: 'static', secure: 'configured' });
    expect(h.tables.cam.get(camKey(1, MAC_A))!.expiresAt).toBeUndefined();
    expect(psec(h).get(FA1)).toMatchObject({ count: 1 });
    const writes = h.kinds('tableWrite').length;
    // the same line again (a saved config replayed) changes nothing
    h.lines(sw, FA1, [`switchport port-security mac-address ${MAC_A}`, 'switchport port-security']);
    expect(h.kinds('tableWrite').length).toBe(writes);
    // the line removed: the row goes
    h.lines(sw, FA1, [`no switchport port-security mac-address ${MAC_A}`]);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toBeUndefined();
    expect(psec(h).get(FA1)).toMatchObject({ count: 0 });
  });

  it('the row status follows the link and stays secure-shutdown while err-disabled', () => {
    const { h, sw } = setup();
    sw.onLinkChange!(h.ctx, FA1, false);
    expect(psec(h).get(FA1)).toMatchObject({ status: 'secure-down' });
    sw.onLinkChange!(h.ctx, FA1, true);
    expect(psec(h).get(FA1)).toMatchObject({ status: 'secure-up' });
    const fsm = h.debug.filter((d) => d.data?.fsm !== undefined).map((d) => d.data!.fsm);
    expect(fsm).toEqual([
      expect.objectContaining({ machine: 'port-security', subject: FA1, from: 'secure-up', to: 'secure-down' }),
      expect.objectContaining({ machine: 'port-security', subject: FA1, from: 'secure-down', to: 'secure-up' }),
    ]);
  });
});

describe('§3.8 step 2 — sticky learning is idempotent', () => {
  it('the first frame learns a sticky secure row and writes exactly one sticky line; ten more frames change nothing', () => {
    const { h, sw } = setup();
    const first = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(configLines(first)).toEqual([stickyConfigLine(FA1, MAC_A)]);
    expect(sendsOf(first).length).toBeGreaterThan(0);
    const row = h.tables.cam.get(camKey(1, MAC_A));
    expect(row).toMatchObject({ port: FA1, vlan: 1, type: 'static', secure: 'sticky' });
    expect(row!.expiresAt).toBeUndefined();
    expect(psec(h).get(FA1)).toMatchObject({ count: 1, violations: 0, status: 'secure-up' });
    expect(h.debug.filter((d) => d.category === PORT_SECURITY_DEBUG_CATEGORY).map((d) => d.message)).toContain(`secured ${MAC_A} on ${FA1} (vlan 1, sticky)`);

    // the runtime applies the configLine and fans its onConfig out to eth-switch too (§3.8 step 2)
    const writesBefore = h.kinds('tableWrite').length;
    const onOwnLine = h.configure(sw, [['interface', FA1]], stickyConfigLine(FA1, MAC_A).line);
    expect(onOwnLine).toEqual([]);
    expect(h.kinds('tableWrite').length).toBe(writesBefore);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toBe(row);
    expect(psec(h).get(FA1)).toMatchObject({ count: 1 });

    let configChanges = 0;
    for (let i = 0; i < 10; i++) {
      const actions = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
      configChanges += configLines(actions).length;
      expect(drops(actions)).toEqual([]);
      expect(sendsOf(actions).length).toBeGreaterThan(0);
    }
    expect(configChanges).toBe(0);
    expect(psec(h).get(FA1)).toMatchObject({ count: 1, violations: 0, status: 'secure-up' });
    expect(h.tables.cam.get(camKey(1, MAC_A))).toBe(row);
    expect(h.kinds('tableWrite').length).toBe(writesBefore);
  });

  it('without sticky, the learned secure row is dynamic and no line is written; link-down removes it', () => {
    const { h, sw } = setup([]);
    const first = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(configLines(first)).toEqual([]);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ type: 'static', secure: 'dynamic' });
    expect(psec(h).get(FA1)).toMatchObject({ count: 1 });
    sw.onLinkChange!(h.ctx, FA1, false);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toBeUndefined();
    expect(psec(h).get(FA1)).toMatchObject({ count: 0, status: 'secure-down' });
  });

  it('turning sticky learning on pins the addresses the port already learned dynamically and writes their lines (W5 fix)', () => {
    const { h, sw } = setup([]);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ type: 'static', secure: 'dynamic' });
    const on = h.configure(sw, [['interface', FA1]], ['switchport', 'port-security', 'mac-address', 'sticky']);
    expect(configLines(on)).toEqual([stickyConfigLine(FA1, MAC_A)]);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ port: FA1, type: 'static', secure: 'sticky' });
    expect(psec(h).get(FA1)).toMatchObject({ count: 1, sticky: true });
    expect(h.debug.filter((d) => d.category === PORT_SECURITY_DEBUG_CATEGORY).map((d) => d.message)).toContain(
      `made ${MAC_A} on ${FA1} sticky (vlan 1): sticky learning is on`,
    );
    // the runtime applies the line; its own onConfig changes nothing more
    expect(h.configure(sw, [['interface', FA1]], stickyConfigLine(FA1, MAC_A).line)).toEqual([]);
    // a pinned address survives a link-down, which removes dynamic secure rows
    sw.onLinkChange!(h.ctx, FA1, false);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ secure: 'sticky' });
  });

  it('a sticky row survives link-down and a membership flush; a membership change re-keys it to the new VLAN', () => {
    const { h, sw } = setup();
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    h.configure(sw, [['interface', FA1]], stickyConfigLine(FA1, MAC_A).line);
    sw.onLinkChange!(h.ctx, FA1, false);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ secure: 'sticky' });
    sw.onLinkChange!(h.ctx, FA1, true);
    h.lines(sw, FA2, ['switchport mode access', 'switchport access vlan 10']);
    h.lines(sw, FA1, ['switchport access vlan 10']);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toBeUndefined();
    expect(h.tables.cam.get(camKey(10, MAC_A))).toMatchObject({ port: FA1, secure: 'sticky', type: 'static' });
    expect(psec(h).get(FA1)).toMatchObject({ count: 1 });
    // and the host keeps forwarding in its new VLAN, with no violation and no new sticky line
    const next = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    expect(drops(next)).toEqual([]);
    expect(configLines(next)).toEqual([]);
    expect(sendsOf(next).map((a) => a.port)).toEqual([FA2]);
  });

  it('a `switchport port-security …` line never flushes the CAM', () => {
    const { h, sw } = setup();
    h.lines(sw, FA2, ['switchport mode access']);
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), FA2);
    h.lines(sw, FA2, ['switchport port-security', 'switchport port-security maximum 2', 'switchport port-security mac-address sticky']);
    expect(h.tables.cam.get(camKey(1, MAC_B))).toMatchObject({ port: FA2, type: 'dynamic' });
  });
});

describe('§3.8 steps 3–6 — violations, err-disable and recovery', () => {
  it('protect: the violating frame drops with the detail and nothing else happens', () => {
    const { h, sw } = setup([], 'protect');
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    const actions = sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1);
    expect(actions).toEqual([{ type: 'drop', pdu: expect.anything(), reason: 'port-security', detail: psecNotAllowedDetail(MAC_X, FA1, 'protect'), port: FA1 }]);
    expect(psec(h).get(FA1)).toMatchObject({ violations: 0, status: 'secure-up', count: 1 });
    expect(h.tables.cam.get(camKey(1, MAC_X))).toBeUndefined();
  });

  it('restrict: the drop, violations + 1, one log per violation, the port stays up', () => {
    const { h, sw } = setup([], 'restrict');
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    for (let i = 1; i <= 3; i++) {
      const actions = sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1);
      expect(actions).toEqual([
        expect.objectContaining({ type: 'drop', reason: 'port-security', detail: psecNotAllowedDetail(MAC_X, FA1, 'restrict') }),
        { type: 'log', severity: 4, facility: PORT_SECURITY_LOG_FACILITY, message: `Port security on ${FA1} refused ${MAC_X}: the port allows 1 address.` },
      ]);
      expect(psec(h).get(FA1)).toMatchObject({ violations: i, status: 'secure-up', lastViolationMac: MAC_X });
    }
  });

  it('shutdown: the drop, violations + 1, secure-shutdown, an errDisable action and the FSM transition', () => {
    const { h, sw } = setup();
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    const actions = sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1);
    expect(actions).toEqual([
      expect.objectContaining({ type: 'drop', reason: 'port-security', detail: psecNotAllowedDetail(MAC_X, FA1, 'shutdown') }),
      { type: 'errDisable', port: FA1, cause: 'psecure-violation', detail: `port security refused ${MAC_X}: the port allows 1 address` },
    ]);
    expect(psec(h).get(FA1)).toMatchObject({ violations: 1, status: 'secure-shutdown', lastViolationMac: MAC_X, count: 1 });
    const fsm = h.debug.filter((d) => d.data?.fsm !== undefined).map((d) => d.data!.fsm);
    expect(fsm).toEqual([expect.objectContaining({ machine: 'port-security', subject: FA1, from: 'secure-up', to: 'secure-shutdown', cause: 'violation' })]);
    // the runtime err-disables the port and the link goes down: sticky rows stay, the status stays secure-shutdown
    h.setErrDisabled(FA1, 'psecure-violation');
    sw.onLinkChange!(h.ctx, FA1, false);
    expect(h.tables.cam.get(camKey(1, MAC_A))).toMatchObject({ secure: 'sticky' });
    expect(psec(h).get(FA1)).toMatchObject({ status: 'secure-shutdown' });
    // recovery by hand: shutdown clears errDisabled, no shutdown brings the link up
    h.setErrDisabled(FA1, undefined);
    sw.onLinkChange!(h.ctx, FA1, true);
    expect(psec(h).get(FA1)).toMatchObject({ status: 'secure-up' });
  });

  it('a MAC secured on another port of the same VLAN is a violation here (§3.8 step 4)', () => {
    const { h, sw } = setup();
    h.lines(sw, FA2, ['switchport mode access', 'switchport port-security', 'switchport port-security violation protect']);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    const actions = sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA2);
    expect(actions).toEqual([expect.objectContaining({ type: 'drop', reason: 'port-security', detail: psecSecuredElsewhereDetail(MAC_A, FA1, 'protect') })]);
    // a plain dynamic row elsewhere is not "secured": the address simply moves
    sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), FA3);
    expect(drops(sw.onPdu(h.ctx, h.frame(MAC_B, MAC_BROADCAST), FA2))).toEqual([]);
    expect(h.tables.cam.get(camKey(1, MAC_B))).toMatchObject({ port: FA2, secure: 'dynamic' });
  });

  it('automatic recovery: a periodic errdisable timer when configured, errRecover on expiry, nothing when not', () => {
    const { h, sw } = setup();
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    const noRecovery = sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1);
    expect(noRecovery.some((a) => a.type === 'timer')).toBe(false);
    h.setErrDisabled(FA1, 'psecure-violation');
    // the operator turns recovery on afterwards: the timer is armed at once
    h.configure(sw, [], ['errdisable', 'recovery', 'interval', '30']);
    const armed = h.configure(sw, [], ['errdisable', 'recovery', 'cause', 'psecure-violation']);
    expect(armed).toEqual([{ type: 'timer', key: errdisableTimerKey(FA1), delay: 30 * SEC, periodic: true }]);
    expect(h.configure(sw, [], ['errdisable', 'recovery', 'interval', '60'])).toEqual([]);
    h.setNow(30 * SEC);
    expect(sw.onTimer(h.ctx, errdisableTimerKey(FA1))).toEqual([{ type: 'errRecover', port: FA1, cause: 'psecure-violation' }]);
    // the runtime recovers the port; the violator is still there: the next frame err-disables again and re-arms
    h.setErrDisabled(FA1, undefined);
    sw.onLinkChange!(h.ctx, FA1, true);
    const again = sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1);
    expect(again.map((a) => a.type)).toEqual(['drop', 'errDisable', 'timer']);
    expect(again[2]).toEqual({ type: 'timer', key: errdisableTimerKey(FA1), delay: 60 * SEC, periodic: true });
    // a timer that fires on a port no longer err-disabled does nothing
    h.setErrDisabled(FA1, undefined);
    expect(sw.onTimer(h.ctx, errdisableTimerKey(FA1))).toEqual([]);
    // switching recovery off cancels an armed timer
    h.setErrDisabled(FA1, 'psecure-violation');
    sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1);
    expect(h.configure(sw, [], ['errdisable', 'recovery', 'cause', 'psecure-violation'], true)).toEqual([{ type: 'cancelTimer', key: errdisableTimerKey(FA1) }]);
  });

  it('`errdisable recovery cause all` also covers psecure-violation', () => {
    const { h, sw } = setup();
    h.configure(sw, [], ['errdisable', 'recovery', 'cause', 'all']);
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    const actions = sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1);
    expect(actions.at(-1)).toEqual({ type: 'timer', key: errdisableTimerKey(FA1), delay: 300 * SEC, periodic: true });
  });

  it('`no switchport port-security` removes the row and every secure address of the port', () => {
    const { h, sw } = setup();
    sw.onPdu(h.ctx, h.frame(MAC_A, MAC_BROADCAST), FA1);
    h.lines(sw, FA1, ['no switchport port-security']);
    expect(psec(h).get(FA1)).toBeUndefined();
    expect(h.tables.cam.get(camKey(1, MAC_A))).toBeUndefined();
    // the port is an ordinary port again
    expect(drops(sw.onPdu(h.ctx, h.frame(MAC_X, MAC_BROADCAST), FA1))).toEqual([]);
    expect(h.tables.cam.get(camKey(1, MAC_X))).toMatchObject({ type: 'dynamic' });
  });
});
