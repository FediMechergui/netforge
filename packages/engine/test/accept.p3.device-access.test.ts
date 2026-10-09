/**
 * accept.p3.device-access — W4 qa acceptance row (ARCHITECTURE-P3 §10.1; D14, D22, §3.14, §5.2, §5.8, §2.10): SSH-only
 * device access, typed by a learner, on a router (NF-2911) and on a switch (NF-C2960).
 *
 * On `staged.world` at stage P3 with every approved P3 daemon (test/hardening.world.ts: the worlds equal the flipped
 * catalog; the flip itself is a later, separate step, rule 14). Every line is typed on a real console (`sim.cli`).
 *
 * World: Router1 (NF-2911, a freshly placed device keeps its default hostname) Gi0/0 192.168.10.1/24 → Switch1
 * (NF-C2960, default hostname) Gi0/1; Switch1 Vlan1 192.168.10.2/24, gateway .1; PC1 192.168.10.10 on Fa0/1 and PC2
 * 192.168.10.11 on Fa0/2 (gateway .1). Only the addressing is in the startup configurations.
 *
 * Pinned, on both devices:
 *   • `crypto key generate rsa` is refused while the hostname is the model's default (with or without a domain name)
 *     and, with a hostname, while there is no `ip domain-name` — the exact messages; with both the key is created
 *     (exact message);
 *   • `show ip ssh` reports SSH on, version 2 and the key size (1024 bits on the router, 2048 on the switch), exactly;
 *   • `username admin privilege 15 secret …` works with `login local`: PC1 logs in over SSH and lands in privileged
 *     EXEC (`R1#`, `SW1#`); PC2, which list 10 does not permit, is refused — on the switch by the list defined on the
 *     switch (its acl rows carry `vty in`);
 *   • `transport input ssh`, `login local` and `access-class 10 in` round-trip through export, reload and the grader
 *     clone: the vty section and the whole running configuration are unchanged, the facts read the same values, and in
 *     the clone a TCP probe to port 22 opens while one to port 23 is refused (SSH only);
 *   • the `ssh.*` and `vty.*` facts read them (live, reloaded, cloned);
 *   • three runs with one seed are byte-identical (trace and snapshot JSON).
 */
import { describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../src/contracts/cli.js';
import type { CliResult } from '../src/contracts/cli.js';
import type { SessionId } from '../src/contracts/ids.js';
import type { LabAssertion, LabFactName, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import type { AclRow, VtyLoginRow } from '../src/contracts/tables.js';
import { SEC, type SimTime } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID } from '../src/contracts/topology.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { isDefaultHostname } from '../src/cli/handlers/ssh.js';
import { VTY_PROMPT_PASSWORD } from '../src/protocols/vty.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { runCheck } from '../src/sim/lab-checks/registry.js';
import { configText, gradingClone } from './hardening.world.js';
import { createStagedSimulation } from './staged.world.js';

const R1_ADDR = '192.168.10.1';
const SW1_ADDR = '192.168.10.2';
const PC1_ADDR = '192.168.10.10';
const PC2_ADDR = '192.168.10.11';
const MASK = '255.255.255.0';
const ADMIN_PASSWORD = 'Lab-Pass1';
const DOMAIN = 'lab.nf';
/** Boot, links up and spanning tree forwarding on the switch's ports before anything is typed. */
const BOOT_NS = 100 * SEC;

/** One device of the row: its default name, the hostname the learner gives it, the key size, its address. */
interface Subject {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly bits: number;
  readonly address: string;
}
const ROUTER: Subject = { id: 'r1', name: 'Router1', hostname: 'R1', bits: 1024, address: R1_ADDR };
const SWITCH: Subject = { id: 'sw1', name: 'Switch1', hostname: 'SW1', bits: 2048, address: SW1_ADDR };

/** The world of the file header, booted; nothing about device access is configured yet. */
function world(seed = 31): Simulation {
  const sim = createStagedSimulation({ seed, stage: 'P3' });
  sim.addDevice({
    id: ROUTER.id, type: 'router.nf2911', name: ROUTER.name,
    startupConfig: configText([['interface GigabitEthernet0/0', ` ip address ${R1_ADDR} ${MASK}`, ' no shutdown']]),
  });
  sim.addDevice({
    id: SWITCH.id, type: 'switch.nfc2960', name: SWITCH.name,
    startupConfig: configText([['interface Vlan1', ` ip address ${SW1_ADDR} ${MASK}`, ' no shutdown'], [`ip default-gateway ${R1_ADDR}`]]),
  });
  for (const [id, name, ip] of [['pc1', 'PC1', PC1_ADDR], ['pc2', 'PC2', PC2_ADDR]] as const) {
    sim.addDevice({ id, type: 'pc.nfpc', name, startupConfig: configText([[`hostname ${name}`], ['interface GigabitEthernet0', ` ip address ${ip} ${MASK}`], [`ip default-gateway ${R1_ADDR}`]]) });
  }
  sim.addLink({ id: 'l_pc1', a: { device: 'pc1', port: 'GigabitEthernet0' }, b: { device: SWITCH.id, port: 'FastEthernet0/1' } });
  sim.addLink({ id: 'l_pc2', a: { device: 'pc2', port: 'GigabitEthernet0' }, b: { device: SWITCH.id, port: 'FastEthernet0/2' } });
  sim.addLink({ id: 'l_r1', a: { device: ROUTER.id, port: 'GigabitEthernet0/0' }, b: { device: SWITCH.id, port: 'GigabitEthernet0/1' } });
  sim.runFor(BOOT_NS);
  return sim;
}

/** Type `line`; it must be accepted. */
function ok(sim: Simulation, s: SessionId, line: string): CliResult {
  const r = sim.cli.exec(s, line);
  if (r.error !== undefined) throw new Error(`"${line}" was refused: ${r.output}`);
  return r;
}

/** The device-access lines of the row, typed in global configuration after the key exists. */
function accessLines(): string[] {
  return [
    'ip ssh version 2',
    `username admin privilege 15 secret ${ADMIN_PASSWORD}`,
    `access-list 10 permit host ${PC1_ADDR}`,
    'line vty 0 4',
    'login local',
    'transport input ssh',
    'access-class 10 in',
    'end',
  ];
}

/** The prerequisites, then the key (each refusal's exact message), then the access lines; returns what was printed. */
function configureAccess(sim: Simulation, d: Subject): { refusals: string[]; created: string; showIpSsh: string } {
  const s = sim.cli.open(d.id, 'console');
  ok(sim, s, 'enable');
  ok(sim, s, 'configure terminal');
  const key = `crypto key generate rsa modulus ${d.bits}`;
  const refusals: string[] = [];
  const refused = (): void => {
    const r = sim.cli.exec(s, key);
    expect(r.error, `${d.name}: ${key}`).toBeDefined();
    refusals.push(r.output);
  };
  refused(); // the default hostname, no domain name
  ok(sim, s, `ip domain-name ${DOMAIN}`);
  refused(); // the default hostname, a domain name
  ok(sim, s, `hostname ${d.hostname}`);
  ok(sim, s, 'no ip domain-name');
  refused(); // a hostname, no domain name
  ok(sim, s, `ip domain-name ${DOMAIN}`);
  const created = ok(sim, s, key).output;
  for (const line of accessLines()) ok(sim, s, line);
  const showIpSsh = ok(sim, s, 'show ip ssh').output;
  sim.cli.close(s);
  return { refusals, created, showIpSsh };
}

/** Both devices configured as the row says. */
function configuredWorld(seed?: number): Simulation {
  const sim = world(seed);
  configureAccess(sim, ROUTER);
  configureAccess(sim, SWITCH);
  sim.runToIdle();
  return sim;
}

/** What a privileged console of `device` prints for `line`. */
function shown(sim: Simulation, device: string, line: string): string {
  const s = sim.cli.open(device, 'console');
  ok(sim, s, 'enable');
  const out = ok(sim, s, line).output;
  sim.cli.close(s);
  return out;
}

/** The `line vty …` section of a running configuration, as text. */
function vtySection(running: string): string {
  const lines = running.split('\n');
  const at = lines.findIndex((l) => l.startsWith('line vty'));
  if (at < 0) return '';
  const out = [lines[at]!];
  for (let i = at + 1; i < lines.length && lines[i]!.startsWith(' '); i++) out.push(lines[i]!);
  return out.join('\n');
}

const fact = (device: string, f: LabFactName, equals: string | number | boolean): LabAssertion => ({ kind: 'fact', device, fact: f, equals });

/** The six facts of the row with their expected values on `d`. */
function accessFacts(d: Subject): LabAssertion[] {
  return [
    fact(d.name, 'ssh.enabled', true),
    fact(d.name, 'ssh.version', 2),
    fact(d.name, 'ssh.keyBits', d.bits),
    fact(d.name, 'vty.transport', 'ssh'),
    fact(d.name, 'vty.loginLocal', true),
    fact(d.name, 'vty.accessClass', '10'),
  ];
}

/** The detail of each assertion (undefined = it passed), read in `sim` (live, never a clone of it). */
function details(sim: Simulation, assertions: readonly LabAssertion[]): (string | undefined)[] {
  return assertions.map((a) => {
    const r = runCheck({ sim, host: undefined }, a);
    return r.pass ? undefined : (r.detail ?? '(no detail)');
  });
}

type PromptEvent = Extract<TraceEvent, { kind: 'cliPrompt' }>;

/** Type `line` on console session `s` and run `runNs`; the session's output and its last prompt. */
function typed(sim: Simulation, s: SessionId, line: string, runNs: SimTime = 3 * SEC): { text: string[]; prompt: PromptEvent | undefined } {
  const cursor = sim.trace(0).next;
  sim.cli.exec(s, line);
  sim.runFor(runNs);
  const evs = sim.trace(cursor).events;
  return {
    text: evs.flatMap((e) => (e.kind === 'cliOutput' && e.session === s ? [e.text] : [])),
    prompt: evs.filter((e): e is PromptEvent => e.kind === 'cliPrompt' && e.session === s).at(-1),
  };
}

const logins = (sim: Simulation, device: string): VtyLoginRow[] => sim.device(device)!.tables.get<VtyLoginRow>('vty-logins')?.rows() ?? [];

describe('accept.p3.device-access: the key prerequisites and show ip ssh (on a router and on a switch)', () => {
  it('refuses the key without a hostname or a domain name (exact messages); with both, show ip ssh reports version 2 and the key size', () => {
    const sim = world();
    for (const d of [ROUTER, SWITCH]) {
      // a freshly placed device keeps the model's default hostname (D14)
      const dev = sim.device(d.id)!;
      expect(isDefaultHostname({ hostname: d.name, model: dev.model })).toBe(true);
      const { refusals, created, showIpSsh } = configureAccess(sim, d);
      expect(refusals, d.name).toEqual([CLI_MESSAGES.sshNeedsHostname, CLI_MESSAGES.sshNeedsHostname, CLI_MESSAGES.sshNeedsDomain]);
      expect(created).toBe(`The RSA key pair ${d.hostname}.${DOMAIN} was created (${d.bits} bits). SSH can now be used.`);
      expect(showIpSsh.split('\n')).toEqual([
        'SSH: on',
        '  Version 2',
        `  RSA key: ${d.bits} bits, named ${d.hostname}.${DOMAIN}`,
        '  Login time-out 120 s; failed logins allowed 3',
        '  line vty 0 4: accepts ssh; access class 10 in; login local',
      ]);
    }
  });
});

describe('accept.p3.device-access: username … privilege 15 with login local, and the switch\'s own list', () => {
  it('PC1 logs in over SSH to the router and to the switch at privileged EXEC; PC2 is refused by access-class 10', () => {
    const sim = configuredWorld();
    // the list is defined on the switch itself, and its acl rows carry the vty binding
    for (const d of [ROUTER, SWITCH]) {
      const rows = sim.device(d.id)!.tables.get<AclRow>('acl')!.rows();
      expect(rows.map((r) => [r.key, r.applied]), d.name).toEqual([['4|10|10', 'vty in'], ['4|10|implicit', 'vty in']]);
    }
    for (const d of [ROUTER, SWITCH]) {
      const pc1 = sim.cli.open('pc1', 'console');
      const ask = typed(sim, pc1, `ssh -l admin ${d.address}`, 1 * SEC);
      expect(ask.prompt, d.name).toMatchObject({ prompt: VTY_PROMPT_PASSWORD, input: { kind: 'secret' } });
      const t = typed(sim, pc1, ADMIN_PASSWORD, 5 * SEC);
      expect(t.text).toEqual([`Connecting to ${d.address} port 22 ...`]);
      expect(t.prompt, d.name).toMatchObject({ prompt: `${d.hostname}#`, busy: false });
      expect(sim.cli.session(pc1)).toMatchObject({ prompt: `${d.hostname}#`, remote: `${d.hostname} via SSH` });
      const remote = sim.cli.sessions().filter((v) => v.via === 'vty' && v.device === d.id);
      expect(remote.map((v) => [v.mode, v.privilege])).toEqual([['priv-exec', 15]]);
      typed(sim, pc1, 'exit');
      sim.cli.close(pc1);

      const pc2 = sim.cli.open('pc2', 'console');
      typed(sim, pc2, `ssh -l admin ${d.address}`, 1 * SEC);
      const refused = typed(sim, pc2, ADMIN_PASSWORD, 5 * SEC);
      expect(refused.text, d.name).toEqual([`Connecting to ${d.address} port 22 ...`, `% Connection refused by ${d.address}`]);
      expect(refused.prompt).toMatchObject({ prompt: 'PC2>', busy: false });
      sim.cli.close(pc2);
      expect(logins(sim, d.id).map((r) => [r.proto, r.peer, r.user, r.result, r.reason])).toEqual([
        ['ssh', PC1_ADDR, 'admin', 'success', undefined],
        ['ssh', PC2_ADDR, 'admin', 'refused', 'access-class 10'],
      ]);
      // the refusal is counted on the implicit entry of the device's own list 10, as a vty check
      expect(sim.device(d.id)!.tables.get<AclRow>('acl')!.get('4|10|implicit')).toMatchObject({ matches: 1, lastIface: 'vty' });
    }
  });
});

describe('accept.p3.device-access: the lines round-trip through export, reload and the clone; the facts read them', () => {
  /** A lab whose one task carries `assertions` (evaluated in the live world and its grader clone). */
  function labWith(assertions: readonly LabAssertion[]): ScenarioInfo {
    return {
      name: 'device-access-demo',
      title: 'Device access demo',
      description: 'A lab built by the test',
      category: 'ccna3-lab',
      build: () => ({ schema: TOPOLOGY_SCHEMA_ID, seed: 1, devices: [], links: [] }),
      tasks: [{ id: 'only', title: 'Only task', description: 'One task', points: 10, assertions }],
    };
  }

  it('the facts read the configuration live', () => {
    const sim = configuredWorld();
    for (const d of [ROUTER, SWITCH]) expect(details(sim, accessFacts(d)), d.name).toEqual(accessFacts(d).map(() => undefined));
    // a wrong answer fails with its original detail
    expect(details(sim, [fact(SWITCH.name, 'vty.transport', 'ssh telnet'), fact(ROUTER.name, 'ssh.keyBits', 2048)])).toEqual([
      `${SWITCH.name} vty.transport is ssh, expected ssh telnet.`,
      `${ROUTER.name} ssh.keyBits is 1024, expected 2048.`,
    ]);
  });

  it('export and reload keep every line; the reloaded world reads the same facts', () => {
    const sim = configuredWorld();
    const topo = sim.exportTopology();
    expect(topo.profile).toBe('P3');
    const reloaded = createStagedSimulation({ seed: 31, stage: 'P3' });
    reloaded.loadTopology(topo);
    reloaded.runFor(BOOT_NS);
    for (const d of [ROUTER, SWITCH]) {
      const live = shown(sim, d.id, 'show running-config');
      const vty = vtySection(live);
      for (const line of [' login local', ' transport input ssh', ' access-class 10 in']) expect(vty.split('\n'), d.name).toContain(line);
      const exported = topo.devices.find((x) => x.id === d.id)!.runningConfig ?? '';
      expect(vtySection(exported), d.name).toBe(vty);
      expect(shown(reloaded, d.id, 'show running-config'), d.name).toBe(live);
      expect(details(reloaded, accessFacts(d)), d.name).toEqual(accessFacts(d).map(() => undefined));
      expect(shown(reloaded, d.id, 'show ip ssh'), d.name).toBe(shown(sim, d.id, 'show ip ssh'));
    }
  });

  it('the grader clone keeps them: the facts read the same values there, and only SSH is offered (22 opens, 23 is refused)', () => {
    const sim = configuredWorld();
    const clone = gradingClone(sim);
    for (const d of [ROUTER, SWITCH]) {
      expect(vtySection(shown(clone, d.id, 'show running-config')), d.name).toBe(vtySection(shown(sim, d.id, 'show running-config')));
      expect(details(clone, accessFacts(d)), d.name).toEqual(accessFacts(d).map(() => undefined));
    }
    // the same, through the grader itself: TCP probes run in its clone
    const conn = (to: string, port: number, expectWhat: 'success' | 'fail'): LabAssertion => ({ kind: 'connectivity', from: 'PC1', to, proto: 'tcp', port, expect: expectWhat });
    const before = JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology() });
    const status = evaluateLab(sim, labWith([
      conn(ROUTER.name, 22, 'success'),
      conn(ROUTER.name, 23, 'fail'),
      conn(SWITCH.name, 22, 'success'),
      conn(SWITCH.name, 23, 'fail'),
      ...accessFacts(ROUTER),
      ...accessFacts(SWITCH),
    ]));
    expect(status.results[0]!.assertions.map((a) => (a.pass ? undefined : a.detail))).toEqual(Array(16).fill(undefined));
    expect(status.results[0]!.pass).toBe(true);
    // grading is read-only
    expect(JSON.stringify({ now: sim.now, head: sim.trace(0).next, topo: sim.exportTopology() })).toBe(before);
  });
});

describe('accept.p3.device-access: determinism', () => {
  it('three runs with one seed (configuration, SSH logins, a refusal) are byte-identical', () => {
    const run = (): string => {
      const sim = configuredWorld(17);
      for (const [pc, d] of [['pc1', SWITCH], ['pc2', ROUTER]] as const) {
        const s = sim.cli.open(pc, 'console');
        typed(sim, s, `ssh -l admin ${d.address}`, 1 * SEC);
        typed(sim, s, ADMIN_PASSWORD, 5 * SEC);
        sim.cli.close(s);
      }
      sim.runToIdle();
      return JSON.stringify([sim.trace(0).events, sim.snapshot()]);
    };
    const first = run();
    expect(run()).toBe(first);
    expect(run()).toBe(first);
  });
});
