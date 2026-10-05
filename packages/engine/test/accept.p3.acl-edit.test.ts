/**
 * P3 acceptance — editing access lists (ARCHITECTURE-P3 §10.1 `accept.p3.acl-edit`; D12 "Sequence numbers" and "One
 * list per direction", §5 rule-table changes (`sequenced`, the per-direction `ip access-group` slot, the numbered
 * section), §5.2, §5.8; §7 W4 qa).
 *
 * A real world on `staged.world` at stage P3 with every approved P3 daemon registered (the catalog flip is a later,
 * separate step; after it the overlay is a no-op): PC1 192.168.10.10 ── Gi0/0 R1 Gi0/1 ── SRV 192.168.20.100
 * (`ip http server`). Everything is typed on R1's console:
 *   • in a list section `15 permit …` inserts by number, `no 20` removes by number, `ip access-list resequence`
 *     renumbers; `show access-lists` shows the numbers and the running configuration never does; the `acl` rows follow
 *     the numbers;
 *   • export, reload and the lab clone replay the text, so they renumber 10, 20, … (proved in the clone by `acl`
 *     assertions in a connectivity check's `then`, against a live check that sees the live numbers);
 *   • `ip access-group` keeps one list per direction: a second list in the same direction replaces the first, the
 *     other direction is kept;
 *   • `ip access-list extended 101` is stored as a numbered section (P2's storage) and joins the global
 *     `access-list 101` lines, global lines first once replayed.
 */
import { describe, expect, it } from 'vitest';
import type { SessionId } from '../src/contracts/ids.js';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { aclKey } from '../src/contracts/tables.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { GI0, GI1, MASK24, PC_PORT, aclRows, aclWorld, hostConfig, privileged, routedPort, routerConfig, show } from './accept.p3.acl.harness.js';

const PC1 = '192.168.10.10';
const SRV = '192.168.20.100';

const ICMP_PC1 = 'permit icmp host 192.168.10.10 any';
const NO_TELNET = 'deny tcp any any eq telnet';
const ANY = 'permit ip any any';
const WEB = 'permit tcp any any eq www';
const DNS = 'permit udp any any eq domain';
const ICMP_ANY = 'permit icmp any any';

/** PC1 ── R1 ── SRV, booted and settled. */
function world(seed: number): Simulation {
  const sim = aclWorld(seed);
  sim.addDevice({ id: 'pc1', type: 'pc.nfpc', name: 'PC1', startupConfig: hostConfig('PC1', PC1, '192.168.10.1') });
  sim.addDevice({ id: 'srv', type: 'server.nfserver', name: 'SRV', startupConfig: hostConfig('SRV', SRV, '192.168.20.1', ['ip http server']) });
  sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1', startupConfig: routerConfig('R1', [routedPort(GI0, '192.168.10.1', MASK24), routedPort(GI1, '192.168.20.1', MASK24)]) });
  sim.addLink({ a: { device: 'pc1', port: PC_PORT }, b: { device: 'r1', port: GI0 } });
  sim.addLink({ a: { device: 'r1', port: GI1 }, b: { device: 'srv', port: PC_PORT } });
  sim.runFor(60 * SEC);
  sim.runToIdle();
  return sim;
}

/** Type `lines` on `session`; every line must be accepted. Returns the outputs. */
function typed(sim: Simulation, session: SessionId, lines: readonly string[]): string[] {
  return lines.map((line) => {
    const r = sim.cli.exec(session, line);
    if (r.error !== undefined) throw new Error(`"${line}": ${r.output}`);
    return r.output;
  });
}

/** The world reloaded from its export into a fresh simulation (the same seed and catalog), booted and settled. */
function reloaded(sim: Simulation, seed: number): Simulation {
  const topo = sim.exportTopology();
  const fresh = aclWorld(seed);
  fresh.loadTopology(topo);
  fresh.runFor(60 * SEC);
  fresh.runToIdle();
  return fresh;
}

/** A lab whose single task carries `assertions`; the verdicts, `undefined` for a pass, else the detail. */
function grade(sim: Simulation, assertions: readonly LabAssertion[]): (string | undefined)[] {
  const lab: ScenarioInfo = {
    name: 'acl-edit-accept',
    title: 'Editing access lists',
    description: 'A lab built by the test',
    category: 'ccna2-lab',
    build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
    tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
  };
  return evaluateLab(sim, lab).results[0]!.assertions.map((r) => (r.pass ? undefined : (r.detail ?? '(no detail)')));
}

/** The `ip access-list extended EDIT` section of a running configuration, as its text. */
function sectionText(running: string, header: string): string {
  const at = running.indexOf(`${header}\n`);
  if (at < 0) return '';
  const end = running.indexOf('!', at);
  return running.slice(at, end < 0 ? undefined : end);
}

describe('accept P3: editing access lists by sequence number', () => {
  it('insert 15 and no 20; the running configuration has no numbers; export, reload and the clone renumber 10, 20 …; resequence', () => {
    const sim = world(71);
    const s = privileged(sim, 'r1');
    typed(sim, s, ['configure terminal', 'ip access-list extended EDIT', ICMP_PC1, NO_TELNET, ANY]);
    // a number places the entry; `no <n>` removes one by its number
    typed(sim, s, [`15 ${WEB}`, 'no 20', 'exit', `interface ${GI0}`, 'ip access-group EDIT in', 'end']);
    expect(show(sim, s, 'show access-lists')).toEqual(['Extended access list EDIT', `    10 ${ICMP_PC1}`, `    15 ${WEB}`, `    30 ${ANY}`]);
    // the running configuration shows the entries in sequence order, without their numbers
    const running = show(sim, s, 'show running-config').join('\n');
    expect(sectionText(running, 'ip access-list extended EDIT')).toBe(`ip access-list extended EDIT\n ${ICMP_PC1}\n ${WEB}\n ${ANY}\n`);
    expect(running).not.toContain(NO_TELNET);
    // the rows follow the live numbers
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.entry])).toEqual([
      [aclKey(4, 'EDIT', 10), ICMP_PC1],
      [aclKey(4, 'EDIT', 15), WEB],
      [aclKey(4, 'EDIT', 30), ANY],
      [aclKey(4, 'EDIT', 'implicit'), 'deny ip any any'],
    ]);

    // export and reload: the text is replayed, so the entries are numbered 10, 20, 30 again
    const exported = sim.exportTopology();
    // the unsaved changes travel as the running configuration (the startup configuration is the boot one)
    const cfgText = exported.devices.find((d) => d.id === 'r1')!.runningConfig ?? '';
    expect(sectionText(cfgText, 'ip access-list extended EDIT')).toBe(`ip access-list extended EDIT\n ${ICMP_PC1}\n ${WEB}\n ${ANY}\n`);
    const again = reloaded(sim, 71);
    const s2 = privileged(again, 'r1');
    expect(show(again, s2, 'show access-lists')).toEqual(['Extended access list EDIT', `    10 ${ICMP_PC1}`, `    20 ${WEB}`, `    30 ${ANY}`]);
    expect(aclRows(again, 'r1').map((r) => r.key)).toEqual([aclKey(4, 'EDIT', 10), aclKey(4, 'EDIT', 20), aclKey(4, 'EDIT', 30), aclKey(4, 'EDIT', 'implicit')]);
    expect(sectionText(show(again, s2, 'show running-config').join('\n'), 'ip access-list extended EDIT')).toBe(sectionText(running, 'ip access-list extended EDIT'));

    // the lab clone replays the export too: there the web entry is 20 and counts the probe's SYN; live it is 15
    expect(
      grade(sim, [
        { kind: 'acl', device: 'R1', list: 'EDIT', entry: 15 },
        { kind: 'acl', device: 'R1', list: 'EDIT', entry: 20 },
        {
          kind: 'connectivity',
          from: 'PC1',
          to: 'SRV',
          proto: 'tcp',
          port: 80,
          expect: 'success',
          then: [{ kind: 'acl', device: 'R1', list: 'EDIT', entry: 20, minMatches: 1 }],
        },
        { kind: 'connectivity', from: 'PC1', to: 'SRV', proto: 'tcp', port: 80, expect: 'success', then: [{ kind: 'acl', device: 'R1', list: 'EDIT', entry: 15 }] },
      ]),
    ).toEqual([
      undefined,
      'Access list EDIT on R1 has no entry 20.',
      undefined,
      `After the TCP probe from PC1: Access list EDIT on R1 has no entry 15.`,
    ]);

    // resequence renumbers the live list from a start by a step; the rows move to the new numbers
    typed(sim, s, ['configure terminal', 'ip access-list resequence EDIT 100 5', 'end']);
    expect(show(sim, s, 'show access-lists')).toEqual(['Extended access list EDIT', `    100 ${ICMP_PC1}`, `    105 ${WEB}`, `    110 ${ANY}`]);
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.entry])).toEqual([
      [aclKey(4, 'EDIT', 100), ICMP_PC1],
      [aclKey(4, 'EDIT', 105), WEB],
      [aclKey(4, 'EDIT', 110), ANY],
      [aclKey(4, 'EDIT', 'implicit'), 'deny ip any any'],
    ]);
    // still no number in the running configuration, and a reload numbers 10, 20, 30 again
    expect(sectionText(show(sim, s, 'show running-config').join('\n'), 'ip access-list extended EDIT')).toBe(`ip access-list extended EDIT\n ${ICMP_PC1}\n ${WEB}\n ${ANY}\n`);
    const third = reloaded(sim, 71);
    expect(show(third, privileged(third, 'r1'), 'show access-lists')).toEqual(['Extended access list EDIT', `    10 ${ICMP_PC1}`, `    20 ${WEB}`, `    30 ${ANY}`]);
  });
});

describe('accept P3: one list per direction', () => {
  it('a second list in the same direction replaces the first; the other direction is kept; the rows follow the bindings', () => {
    const sim = world(73);
    const s = privileged(sim, 'r1');
    typed(sim, s, [
      'configure terminal',
      'ip access-list extended EDIT',
      ANY,
      'exit',
      'access-list 101 permit tcp any any eq www',
      `interface ${GI0}`,
      'ip access-group EDIT in',
      'ip access-group EDIT out',
      'end',
    ]);
    const ifaceText = (): string => sectionText(show(sim, s, 'show running-config').join('\n'), `interface ${GI0}`);
    expect(ifaceText()).toContain(' ip access-group EDIT in\n');
    expect(ifaceText()).toContain(' ip access-group EDIT out\n');
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.applied])).toEqual([
      [aclKey(4, 'EDIT', 10), `${GI0} in, ${GI0} out`],
      [aclKey(4, 'EDIT', 'implicit'), `${GI0} in, ${GI0} out`],
    ]);
    // the same direction again: 101 replaces EDIT inbound; EDIT stays outbound
    typed(sim, s, ['configure terminal', `interface ${GI0}`, 'ip access-group 101 in', 'end']);
    const text = ifaceText();
    expect(text).toContain(' ip access-group 101 in\n');
    expect(text).toContain(' ip access-group EDIT out\n');
    expect(text).not.toContain('ip access-group EDIT in');
    expect(text.split('\n').filter((l) => l.startsWith(' ip access-group'))).toHaveLength(2);
    expect(aclRows(sim, 'r1').map((r) => [r.key, r.applied])).toEqual([
      [aclKey(4, '101', 10), `${GI0} in`],
      [aclKey(4, '101', 'implicit'), `${GI0} in`],
      [aclKey(4, 'EDIT', 10), `${GI0} out`],
      [aclKey(4, 'EDIT', 'implicit'), `${GI0} out`],
    ]);
    // `no ip access-group … in` removes only that direction; the rows of a list no longer applied are deleted
    typed(sim, s, ['configure terminal', `interface ${GI0}`, 'no ip access-group 101 in', 'end']);
    expect(ifaceText()).not.toContain('ip access-group 101');
    expect(ifaceText()).toContain(' ip access-group EDIT out\n');
    expect(aclRows(sim, 'r1').map((r) => r.key)).toEqual([aclKey(4, 'EDIT', 10), aclKey(4, 'EDIT', 'implicit')]);
    // the binding survives export and reload exactly
    const again = reloaded(sim, 73);
    expect(aclRows(again, 'r1').map((r) => [r.key, r.applied])).toEqual([
      [aclKey(4, 'EDIT', 10), `${GI0} out`],
      [aclKey(4, 'EDIT', 'implicit'), `${GI0} out`],
    ]);
  });
});

describe('accept P3: a numbered extended section (P2’s storage)', () => {
  it('ip access-list extended 101 is stored as a numbered section and joins the global access-list 101 lines, global lines first', () => {
    const sim = world(75);
    const s = privileged(sim, 'r1');
    typed(sim, s, ['configure terminal', `access-list 101 ${WEB}`, 'ip access-list extended 101', `5 ${ICMP_ANY}`, DNS, 'exit', `interface ${GI0}`, 'ip access-group 101 in', 'end']);
    // live: one list, entries in sequence order (the section's 5 first, the global 10, the section's next number after it)
    expect(show(sim, s, 'show access-lists')).toEqual(['Extended access list 101', `    5 ${ICMP_ANY}`, `    10 ${WEB}`, `    20 ${DNS}`]);
    // stored as P2 stores a numbered section: the global line and a section named by the number
    const running = show(sim, s, 'show running-config').join('\n');
    expect(running).toContain(`access-list 101 ${WEB}\n`);
    expect(sectionText(running, 'ip access-list extended 101')).toBe(`ip access-list extended 101\n ${ICMP_ANY}\n ${DNS}\n`);
    expect(aclRows(sim, 'r1').map((r) => r.key)).toEqual([aclKey(4, '101', 10), aclKey(4, '101', 20), aclKey(4, '101', 5), aclKey(4, '101', 'implicit')]);
    // replayed: the global lines first, then the section, numbered 10, 20, … over the whole list
    const again = reloaded(sim, 75);
    const s2 = privileged(again, 'r1');
    expect(show(again, s2, 'show access-lists')).toEqual(['Extended access list 101', `    10 ${WEB}`, `    20 ${ICMP_ANY}`, `    30 ${DNS}`]);
    const running2 = show(again, s2, 'show running-config').join('\n');
    expect(running2).toContain(`access-list 101 ${WEB}\n`);
    expect(sectionText(running2, 'ip access-list extended 101')).toBe(sectionText(running, 'ip access-list extended 101'));
    // the clone replays the same way: there the list's evaluation order is global first
    expect(
      grade(sim, [
        { kind: 'acl', device: 'R1', list: '101', entries: [ICMP_ANY, WEB, DNS] },
        { kind: 'connectivity', from: 'PC1', to: 'SRV', expect: 'success', then: [{ kind: 'acl', device: 'R1', list: '101', type: 'extended', entries: [WEB, ICMP_ANY, DNS], entry: 20, minMatches: 1 }] },
      ]),
    ).toEqual([undefined, undefined]);
  });
});
