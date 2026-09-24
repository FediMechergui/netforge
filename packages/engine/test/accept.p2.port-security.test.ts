/**
 * P2 acceptance — port security: violation → err-disable → recovery (ARCHITECTURE-P2 §3.8, D12, §4.2, §10.1 row
 * `accept.p2.port-security`), on real P2-profile worlds of `test/p2.world.ts` (vlan, dtp, etherchannel and stp).
 *
 * §3.8 setup: SW1 Fa0/1 `switchport mode access`, `switchport port-security`, `… maximum 1`, `… mac-address sticky`
 * (violation `shutdown` by default); PC1 on Fa0/1, PC2 on Fa0/2 (the ping target). The two host ports are PortFast
 * so that a host's first frame meets a forwarding port.
 *  • sticky learning emits exactly one configChange `switchport port-security mac-address sticky <mac>` and a CAM
 *    row `secure: 'sticky'`; PC1's next five frames forward, `violations` stays 0 and the secure row stays;
 *  • `shutdown`: the violating frame drops `port-security`, the port has `errDisabled: 'psecure-violation'`, the
 *    link goes down, `show interfaces status err-disabled` lists it, and a lab connectivity assertion through the
 *    port fails in the grader's clone; recovery by `shutdown` / `no shutdown`;
 *  • `restrict`: `violations` equals the number of violating frames, the port stays up, one log per violation;
 *  • `protect`: `violations` unchanged, no log;
 *  • `errdisable recovery cause psecure-violation` + `interval 30` (`runFor`): up at T + 30 s ± 1 ms, err-disabled
 *    again by the violator's next frame; with the violator still attached `runToIdle` returns far below 10 000 events.
 */
import { describe, expect, it } from 'vitest';
import { deviceMacBase, portMac, type MacAddress } from '../src/contracts/addr.js';
import type { PortId } from '../src/contracts/ids.js';
import type { ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { camKey, type PortSecurityRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createDtp } from '../src/protocols/dtp.js';
import { createEtherchannel } from '../src/protocols/etherchannel.js';
import { PORT_SECURITY_LOG_FACILITY, psecNotAllowedDetail } from '../src/protocols/l2/port-security.js';
import { createStp } from '../src/protocols/stp.js';
import { createVlan } from '../src/protocols/vlan.js';
import { LAB_CLONE_BOOT_EVENTS, evaluateLab } from '../src/sim/lab-checks.js';
import { configText, section } from '../src/sim/scenarios/kit.js';
import { pcConfig } from '../src/sim/scenarios/templates.js';
import { createP2Simulation, type P2FactoryOverlay } from './p2.world.js';
import { ofKind, ping } from './sim.harness.js';

const L2: P2FactoryOverlay = { vlan: createVlan, dtp: createDtp, etherchannel: createEtherchannel, stp: createStp };
const SWITCH = 'switch.nfc2960';
const PC = 'pc.nfpc';
const FA1: PortId = 'FastEthernet0/1';
const FA2: PortId = 'FastEthernet0/2';
type Violation = PortSecurityRow['violation'];

interface PsecOptions {
  readonly seed?: number;
  /** The violation mode line (absent = the default, `shutdown`). */
  readonly violation?: Violation;
  /** Add `errdisable recovery cause psecure-violation` and `errdisable recovery interval 30`. */
  readonly recovery?: boolean;
}

/** The §3.8 world; link ids `l_pc1`, `l_pc2`. Nothing has run yet. */
function psecWorld(o: PsecOptions = {}): Simulation {
  const sim = createP2Simulation({ seed: o.seed ?? 7, profile: 'P2', factories: L2 });
  const globals: string[][] = o.recovery === true ? [['errdisable recovery cause psecure-violation'], ['errdisable recovery interval 30']] : [];
  sim.addDevice({
    id: 'sw1', type: SWITCH, name: 'SW1',
    startupConfig: configText([
      ['hostname SW1'],
      ...globals,
      section(`interface ${FA1}`, [
        'switchport mode access', 'spanning-tree portfast',
        'switchport port-security', 'switchport port-security maximum 1', 'switchport port-security mac-address sticky',
        ...(o.violation === undefined ? [] : [`switchport port-security violation ${o.violation}`]),
      ]),
      section(`interface ${FA2}`, ['switchport mode access', 'spanning-tree portfast']),
    ]),
  });
  sim.addDevice({ id: 'pc1', type: PC, name: 'PC1', startupConfig: pcConfig('PC1', '10.0.0.1', '255.255.255.0') });
  sim.addDevice({ id: 'pc2', type: PC, name: 'PC2', startupConfig: pcConfig('PC2', '10.0.0.2', '255.255.255.0') });
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA2 } });
  return sim;
}

const events = (sim: Simulation): TraceEvent[] => sim.trace(0).events;
const psec = (sim: Simulation): PortSecurityRow => sim.device('sw1')!.tables.get<PortSecurityRow>('port-security')!.get(FA1)!;
const pcMac = (id: string): MacAddress => portMac(deviceMacBase(id), 1);
const MAC1 = pcMac('pc1');
const MACX = pcMac('pcx');
const STICKY_LINE = `switchport port-security mac-address sticky ${MAC1}`;
const stickyChanges = (evs: readonly TraceEvent[]) => ofKind(evs, 'configChange').filter((e) => e.device === 'sw1' && e.line === STICKY_LINE && !e.negate);
const violationDrops = (evs: readonly TraceEvent[]) => ofKind(evs, 'drop').filter((e) => e.device === 'sw1' && e.port === FA1 && e.reason === 'port-security');
const psecLogs = (evs: readonly TraceEvent[]) => ofKind(evs, 'log').filter((e) => e.device === 'sw1' && e.facility === PORT_SECURITY_LOG_FACILITY);
const portStates = (evs: readonly TraceEvent[], reason: string) => ofKind(evs, 'portState').filter((e) => e.device === 'sw1' && e.port === FA1 && e.reason === reason);

/** Boot, let PC1 secure itself and ping PC2 once (5/5): the world of every violation case. */
function secured(o: PsecOptions = {}): Simulation {
  const sim = psecWorld(o);
  sim.runUntil(35 * SEC);
  expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
  expect(psec(sim)).toMatchObject({ count: 1, violations: 0, status: 'secure-up' });
  return sim;
}

/** PC-X (10.0.0.9) replaces PC1 on Fa0/1; returns once PC-X has booted and its link is up (or err-disabled). */
function replaceWithPcX(sim: Simulation): void {
  sim.removeLink('l_pc1');
  sim.addDevice({ id: 'pcx', type: PC, name: 'PCX', startupConfig: pcConfig('PCX', '10.0.0.9', '255.255.255.0') });
  sim.addLink({ id: 'l_pcx', a: { device: 'pcx', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
  sim.runFor(20 * SEC);
}

/** A one-task lab over the live world's export: PCX must reach PC2. */
function reachLab(sim: Simulation): ScenarioInfo {
  return {
    name: 'accept-p2-port-security', title: 'Port security', description: 'PCX reaches PC2', category: 'ccna2-lab',
    build: () => sim.exportTopology(),
    tasks: [{ id: 'reach', title: 'Reach PC2', description: 'PCX pings PC2', points: 1, assertions: [{ kind: 'connectivity', from: 'PCX', to: 'PC2', expect: 'success' }] }],
  };
}

describe('accept P2 port-security: sticky learning (§3.8 steps 1–2)', () => {
  it('one configChange with the sticky line, a sticky secure CAM row, and PC1\'s next five frames forward without a violation', () => {
    const sim = psecWorld();
    sim.runUntil(35 * SEC);
    expect(psec(sim)).toMatchObject({ port: FA1, max: 1, violation: 'shutdown', sticky: true, violations: 0, status: 'secure-up' });
    const cursor = sim.trace(0).next;
    const p = ping(sim, 'pc1', '10.0.0.2');
    expect(p.text).toContain('Sent 5, received 5, lost 0');
    const evs = events(sim);
    expect(stickyChanges(evs)).toHaveLength(1);
    expect(sim.device('sw1')!.running.render()).toContain(`\n ${STICKY_LINE}\n`);
    const cam = sim.device('sw1')!.tables.cam.get(camKey(1, MAC1))!;
    expect(cam).toMatchObject({ mac: MAC1, vlan: 1, port: FA1, type: 'static', secure: 'sticky' });
    expect(cam.expiresAt).toBeUndefined();
    expect(psec(sim)).toMatchObject({ count: 1, violations: 0, status: 'secure-up' });
    // the five echo requests of the ping all forwarded to PC2; nothing was refused
    const forwarded = ofKind(sim.trace(cursor).events, 'frameRx').filter((e) => e.device === 'pc2' && e.pdu.summary.includes('echo request'));
    expect(forwarded).toHaveLength(5);
    expect(violationDrops(evs)).toEqual([]);
    expect(psecLogs(evs)).toEqual([]);
    // a second ping changes nothing: still one sticky line, the same row
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
    expect(stickyChanges(events(sim))).toHaveLength(1);
    expect(sim.device('sw1')!.tables.cam.get(camKey(1, MAC1))).toMatchObject({ secure: 'sticky', port: FA1 });
    expect(psec(sim)).toMatchObject({ count: 1, violations: 0, status: 'secure-up' });
  });
});

describe('accept P2 port-security: violation modes (§3.8 steps 3–5)', () => {
  it('shutdown: the violating frame drops port-security, the port is err-disabled and its link down, the show command lists it, the grader\'s clone cannot ping through it; shutdown / no shutdown recovers', () => {
    const sim = secured();
    const cursor = sim.trace(0).next;
    replaceWithPcX(sim);
    const px = ping(sim, 'pcx', '10.0.0.2');
    expect(px.text).not.toContain('received 5');
    const evs = sim.trace(cursor).events;
    const drops = violationDrops(evs);
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0]!.detail).toBe(psecNotAllowedDetail(MACX, FA1, 'shutdown'));
    expect(sim.device('sw1')!.portView(FA1)).toMatchObject({ errDisabled: 'psecure-violation', operUp: false });
    expect(sim.link('l_pcx')!.up).toBe(false);
    expect(psec(sim)).toMatchObject({ violations: 1, status: 'secure-shutdown', lastViolationMac: MACX });
    expect(portStates(evs, 'err-disabled')).toHaveLength(1);
    expect(ofKind(evs, 'log').some((e) => e.device === 'sw1' && e.message.includes(FA1) && e.message.includes('error-disabled'))).toBe(true);
    const show = sim.cli.exec(sim.cli.open('sw1', 'console'), 'show interfaces status err-disabled');
    expect(show.error).toBeUndefined();
    expect(show.output).toMatch(new RegExp(`^${FA1}\\s+.*err-disabled`, 'm'));
    // the sticky row of PC1 survives the violation and the link-down
    expect(sim.device('sw1')!.tables.cam.get(camKey(1, MAC1))).toMatchObject({ secure: 'sticky', port: FA1 });
    // a lab connectivity assertion through the err-disabled port fails in the grader's clone: the real grader
    // (evaluateLab, which since W5 clones with the live world's catalog — here the P2-stage one) …
    const status = evaluateLab(sim, reachLab(sim));
    expect(status.results[0]!.assertions[0]!.pass).toBe(false);
    expect(status.score).toBe(0);
    // … and a clone built the grader's way on the P2-stage catalog of p2.world (lab-checks.ts createCloneHost)
    const clone = createP2Simulation({ seed: sim.seed, profile: 'P2', factories: L2 });
    clone.loadTopology(sim.exportTopology());
    expect(clone.runToIdle(LAB_CLONE_BOOT_EVENTS).stopped).toBeUndefined();
    const cloned = ping(clone, 'pcx', '10.0.0.2');
    expect(cloned.text).not.toMatch(/received [1-9]/);
    expect(ofKind(cloned.evs, 'frameRx').filter((e) => e.device === 'pc2' && e.pdu.summary.includes('echo request'))).toEqual([]);
    // the clone err-disabled the port the same way: PC-X's first frame violated the sticky address it inherited
    expect(clone.device('sw1')!.portView(FA1)!.errDisabled).toBe('psecure-violation');
    // recovery by hand: PC1 is back on the port, shutdown clears the err-disable and no shutdown brings it up
    sim.removeLink('l_pcx');
    sim.removeDevice('pcx');
    sim.addLink({ id: 'l_pc1b', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: 'sw1', port: FA1 } });
    sim.runFor(1 * SEC);
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBe('psecure-violation');
    expect(sim.configure('sw1', [`interface ${FA1}`, 'shutdown', 'no shutdown']).ok).toBe(true);
    sim.runFor(2 * SEC);
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBeUndefined();
    expect(sim.device('sw1')!.portView(FA1)!.operUp).toBe(true);
    expect(sim.link('l_pc1b')!.up).toBe(true);
    expect(psec(sim)).toMatchObject({ status: 'secure-up', count: 1 });
    expect(ping(sim, 'pc1', '10.0.0.2').text).toContain('Sent 5, received 5, lost 0');
    expect(psec(sim)).toMatchObject({ violations: 1, status: 'secure-up' });
  });

  it('restrict: violations counts every violating frame, the port stays up, one log per violation', () => {
    const sim = secured({ violation: 'restrict' });
    const cursor = sim.trace(0).next;
    replaceWithPcX(sim);
    expect(ping(sim, 'pcx', '10.0.0.2').text).toContain('received 0');
    const evs = sim.trace(cursor).events;
    const drops = violationDrops(evs);
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops.every((d) => d.detail === psecNotAllowedDetail(MACX, FA1, 'restrict'))).toBe(true);
    expect(psec(sim)).toMatchObject({ violations: drops.length, status: 'secure-up', lastViolationMac: MACX, violation: 'restrict' });
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBeUndefined();
    expect(sim.device('sw1')!.portView(FA1)!.operUp).toBe(true);
    expect(sim.link('l_pcx')!.up).toBe(true);
    const logs = psecLogs(evs);
    expect(logs).toHaveLength(drops.length);
    expect(logs.every((l) => l.message === `Port security on ${FA1} refused ${MACX}: the port allows 1 address.`)).toBe(true);
    expect(ofKind(evs, 'frameRx').filter((e) => e.device === 'pc2' && e.pdu.summary.includes('10.0.0.9'))).toEqual([]);
  });

  it('protect: the frames drop, violations stays 0 and nothing is logged', () => {
    const sim = secured({ violation: 'protect' });
    const cursor = sim.trace(0).next;
    replaceWithPcX(sim);
    expect(ping(sim, 'pcx', '10.0.0.2').text).toContain('received 0');
    const evs = sim.trace(cursor).events;
    const drops = violationDrops(evs);
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops.every((d) => d.detail === psecNotAllowedDetail(MACX, FA1, 'protect'))).toBe(true);
    expect(psec(sim)).toMatchObject({ violations: 0, status: 'secure-up', violation: 'protect' });
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBeUndefined();
    expect(sim.device('sw1')!.portView(FA1)!.operUp).toBe(true);
    expect(psecLogs(evs)).toEqual([]);
    expect(ofKind(evs, 'log').filter((e) => e.device === 'sw1' && e.t > evs[0]!.t && e.message.includes(FA1))).toEqual([]);
  });
});

describe('accept P2 port-security: automatic recovery (§3.8 step 6, §4.2)', () => {
  it('errdisable recovery interval 30: up at T + 30 s ± 1 ms, err-disabled again by the violator\'s next frame; runToIdle returns below 10 000 events', () => {
    const sim = secured({ recovery: true });
    const cursor = sim.trace(0).next;
    replaceWithPcX(sim);
    expect(ping(sim, 'pcx', '10.0.0.2').text).not.toContain('received 5');
    const disabled = portStates(sim.trace(cursor).events, 'err-disabled');
    expect(disabled).toHaveLength(1);
    const T = disabled[0]!.t;
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBe('psecure-violation');
    // the recovery timer is periodic: runToIdle does not wait for it, and returns far below the cap
    const idle = sim.runToIdle();
    expect(idle.stopped).toBeUndefined();
    expect(idle.events).toBeLessThan(10_000);
    expect(sim.now).toBeLessThan(T + 30 * SEC);
    sim.runUntil(T + 30 * SEC + 1 * MS);
    const recovered = portStates(sim.trace(cursor).events, 'err-recovered');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.t - T).toBeGreaterThanOrEqual(30 * SEC - 1 * MS);
    expect(recovered[0]!.t - T).toBeLessThanOrEqual(30 * SEC + 1 * MS);
    const linkUp = ofKind(sim.trace(cursor).events, 'linkState').filter((e) => e.link === 'l_pcx' && e.up && e.t > T);
    expect(linkUp.length).toBeGreaterThanOrEqual(1);
    expect(linkUp[0]!.t - T).toBeGreaterThanOrEqual(30 * SEC - 1 * MS);
    expect(linkUp[0]!.t - T).toBeLessThanOrEqual(30 * SEC + 1 * MS);
    expect(ofKind(sim.trace(cursor).events, 'log').some((e) => e.device === 'sw1' && e.message.includes('leaves the error-disabled state'))).toBe(true);
    // the violator is still attached: its next frame err-disables the port again
    if (sim.device('sw1')!.portView(FA1)!.errDisabled === undefined) {
      sim.cli.exec(sim.cli.open('pcx', 'console'), 'ping 10.0.0.2');
      sim.runFor(3 * SEC);
    }
    const again = portStates(sim.trace(cursor).events, 'err-disabled');
    expect(again).toHaveLength(2);
    expect(again[1]!.t).toBeGreaterThan(recovered[0]!.t);
    expect(sim.device('sw1')!.portView(FA1)!.errDisabled).toBe('psecure-violation');
    expect(psec(sim).violations).toBe(2);
    // and again runToIdle returns without waiting for the cycle
    const idle2 = sim.runToIdle();
    expect(idle2.stopped).toBeUndefined();
    expect(idle2.events).toBeLessThan(10_000);
  });
});
