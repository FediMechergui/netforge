/**
 * P3 acceptance — management traffic at scale (ARCHITECTURE-P3 D2, D18, D19, D22, §3.6, §3.7, §4.2, §7 W4 step 1,
 * §12.2 R3, §10.1 row `accept.p3.mgmt-scale`).
 *
 * 25 routers and switches in a P3 world (`test/p3-flip.world.ts`: the real catalog since the W4 flip, ruling R47),
 * all in 10.0.0.0/24:
 *   - 15 NF-C2960 in a two-level tree: SW2–SW15 each uplink Gi0/1 to SW1 Fa0/1–Fa0/14; Vlan1 10.0.0.<n>/24;
 *   - 10 NF-2911: R1–R10 on SW2–SW11 Fa0/1 through Gi0/0, 10.0.0.<100 + n>/24;
 *   - one time server, SRV1 (NF-SERVER, 10.0.0.250, `ntp master 1` — what `service ntp on` stores) on SW1 Gi0/1;
 *   - CDP on by the P3 default (no line), and `ntp server 10.0.0.250` on all 25 (on a switch it is also the line that
 *     wakes the dormant transport, D22). Spanning tree runs by the P2 defaults that P3 includes.
 *
 * Pinned: 10 minutes from power-on dispatch fewer events than the bound derived from the periodic senders' constants
 * (`derivedEventBound`); by then every device has its CDP neighbours and every one of the 25 is synchronised to SRV1
 * (stratum 2); and `runToIdle` then returns (not `maxEvents`) — nothing periodic holds it.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../src/contracts/ids.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { CdpNeighbourRow, ClockRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { CDP_DEFAULT_TIMER_S } from '../src/protocols/cdp.js';
import { NTP_POLL_S, NTP_RETRY_SCHEDULE_NS } from '../src/protocols/ntp.js';
import { STP_DEFAULT_TIMERS } from '../src/protocols/stp/vector.js';
import { LAB_CLONE_BOOT_EVENTS } from '../src/sim/lab-checks.js';
import { createP3Simulation, startupText } from './p3-flip.world.js';
import { ofKind } from './sim.harness.js';

const SWITCHES = 15;
const ROUTERS = 10;
const SERVER = '10.0.0.250';
const MASK = '255.255.255.0';
/** §10.1: ten minutes. */
const RUN_NS: SimTime = 600 * SEC;

const sw = (n: number): DeviceId => `sw${n}`;
const r = (n: number): DeviceId => `r${n}`;

/** The world, built from power-on; every trace event collected. */
function mgmtWorld(): { sim: Simulation; events: TraceEvent[] } {
  const sim = createP3Simulation({ seed: 25 });
  const events: TraceEvent[] = [];
  sim.onTrace((ev) => events.push(ev));
  sim.addDevice({
    id: 'srv1', type: 'server.nfserver', name: 'SRV1',
    startupConfig: startupText([['hostname SRV1'], ['interface GigabitEthernet0', ` ip address ${SERVER} ${MASK}`], ['ntp master 1']]),
  });
  for (let n = 1; n <= SWITCHES; n++) {
    sim.addDevice({
      id: sw(n), type: 'switch.nfc2960', name: `SW${n}`,
      startupConfig: startupText([[`hostname SW${n}`], ['interface Vlan1', ` ip address 10.0.0.${n} ${MASK}`, ' no shutdown'], [`ntp server ${SERVER}`]]),
    });
  }
  for (let n = 1; n <= ROUTERS; n++) {
    sim.addDevice({
      id: r(n), type: 'router.nf2911', name: `R${n}`,
      startupConfig: startupText([[`hostname R${n}`], ['interface GigabitEthernet0/0', ` ip address 10.0.0.${100 + n} ${MASK}`, ' no shutdown'], [`ntp server ${SERVER}`]]),
    });
  }
  sim.addLink({ id: 'l_srv1', a: { device: 'srv1', port: 'GigabitEthernet0' }, b: { device: sw(1), port: 'GigabitEthernet0/1' } });
  for (let n = 2; n <= SWITCHES; n++) sim.addLink({ id: `l_sw${n}`, a: { device: sw(n), port: 'GigabitEthernet0/1' }, b: { device: sw(1), port: `FastEthernet0/${n - 1}` } });
  for (let n = 1; n <= ROUTERS; n++) sim.addLink({ id: `l_r${n}`, a: { device: r(n), port: 'GigabitEthernet0/0' }, b: { device: sw(n + 1), port: 'FastEthernet0/1' } });
  return { sim, events };
}

/** Links: 14 switch–switch, 10 router–switch, 1 server–switch. */
const SWITCH_LINKS = SWITCHES - 1;
const LINKS = SWITCH_LINKS + ROUTERS + 1;
/** Periodic sends in `windowS` of a sender with period `periodS` (the first one at the start included). */
const sends = (windowS: number, periodS: number): number => Math.floor(windowS / periodS) + 1;
/**
 * Events one frame may cost per hop: the sender's timer or trigger, the transmission's end, the arrival at the
 * receiver, and one follow-up there (an ARP exchange, a table refresh). A quiet world measures under three.
 */
const EVENTS_PER_FRAME_HOP = 4;
/** The longest path of an NTP packet: client — its switch — SW1 — SRV1 (three hops). */
const NTP_HOPS = 3;

/**
 * The derived bound of 10 minutes from power-on, from the periodic senders' constants:
 *   - spanning tree: one BPDU per designated port per `STP_DEFAULT_TIMERS.helloS` (every link has exactly one
 *     designated end in a tree), one hop;
 *   - CDP: one frame per taking-part port per `CDP_DEFAULT_TIMER_S` plus the one at link-up (both ends of a switch or
 *     router link; the server runs none), one hop;
 *   - NTP: per client, the first poll, the six fast retries of `NTP_RETRY_SCHEDULE_NS` and one poll per `NTP_POLL_S`,
 *     each a request and a reply over at most `NTP_HOPS` hops, plus the ARP exchange that resolves the path once;
 *   - boot and link-up: a fixed allowance per device and per link (power-on, boot, link negotiation, port states).
 */
function derivedEventBound(windowS: number): number {
  const bpdus = LINKS * sends(windowS, STP_DEFAULT_TIMERS.helloS);
  const cdpPorts = SWITCH_LINKS * 2 + ROUTERS * 2 + 1;
  const cdp = cdpPorts * (sends(windowS, CDP_DEFAULT_TIMER_S) + 1);
  const clients = SWITCHES + ROUTERS;
  const ntp = clients * (1 + NTP_RETRY_SCHEDULE_NS.length + sends(windowS, NTP_POLL_S)) * 2 * NTP_HOPS + clients * 2 * NTP_HOPS;
  const startup = (SWITCHES + ROUTERS + 1) * 20 + LINKS * 20;
  return (bpdus + cdp + ntp) * EVENTS_PER_FRAME_HOP + startup;
}

describe('accept P3 mgmt-scale', () => {
  it('25 routers and switches, CDP on and NTP to one server: 10 minutes under the derived event bound; runToIdle returns', () => {
    const { sim, events } = mgmtWorld();
    expect(sim.profile).toBe('P3');
    const run = sim.runFor(RUN_NS);
    const bound = derivedEventBound(RUN_NS / SEC);
    expect(run.stopped).toBeUndefined();
    expect(run.events, `dispatched ${run.events}, bound ${bound}`).toBeLessThan(bound);
    // the world really carried the management traffic the bound accounts for
    expect(run.events).toBeGreaterThan(LINKS * sends(RUN_NS / SEC, STP_DEFAULT_TIMERS.helloS));
    expect(ofKind(events, 'drop').filter((e) => e.detail === 'action-budget')).toEqual([]);

    // CDP: every switch hears its tree neighbours and router, every router its switch
    const heard = (id: DeviceId): string[] => (sim.device(id)!.tables.get<CdpNeighbourRow>('cdp-neighbours')?.rows() ?? []).map((row) => row.deviceId).sort();
    expect(heard(sw(1))).toEqual(Array.from({ length: SWITCHES - 1 }, (_, k) => `SW${k + 2}`).sort());
    for (let n = 2; n <= SWITCHES; n++) expect(heard(sw(n)), sw(n)).toEqual(n <= ROUTERS + 1 ? [`R${n - 1}`, 'SW1'] : ['SW1']);
    for (let n = 1; n <= ROUTERS; n++) expect(heard(r(n)), r(n)).toEqual([`SW${n + 1}`]);

    // NTP: all 25 synchronised to SRV1 at stratum 2
    for (const id of [...Array.from({ length: SWITCHES }, (_, k) => sw(k + 1)), ...Array.from({ length: ROUTERS }, (_, k) => r(k + 1))]) {
      expect(sim.device(id)!.tables.get<ClockRow>('clock')?.get('clock'), id).toMatchObject({ source: 'ntp', stratum: 2, reference: SERVER });
    }

    // nothing periodic holds runToIdle
    const idle = sim.runToIdle(LAB_CLONE_BOOT_EVENTS);
    expect(idle.stopped, `runToIdle dispatched ${idle.events}`).toBeUndefined();
    expect(idle.events).toBeLessThan(LAB_CLONE_BOOT_EVENTS);
  }, 120_000);
});
