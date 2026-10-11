/**
 * sim — the approved clone kinds of ARCHITECTURE-P3 §2.10 (§7 W5 sim): [S13] `service` (sim/lab-checks/service.ts),
 * [S18] `path` with [C13] `tunnelAt` (path.ts) and [S20] `traffic` (traffic.ts), each graded through `CloneHost.run`
 * on the REAL catalog (the flipped one, CATALOG_STAGE 'P3') in P3-profile worlds written with the scenario kit, as the
 * CCNA 3 labs write theirs. Every kind and every member has a right answer that passes and a wrong one that fails with
 * its original detail; authoring mistakes (an unknown device, a bad member) fail before any clone is built.
 *
 * Worlds (test/approved-kinds.world.ts; all `topology(…, {profile: 'P3'})`, loaded, booted, settled):
 *   • ssh (§3.14): PC1 192.168.10.10 and PC2 .11 on SW1 → R1 Gi0/0 192.168.10.1, SSH only, `login local`,
 *     `access-class 10 in` admitting PC1 only;
 *   • gre (§3.10): PC1 — R1 — ISP — R2 — PC2 with a GRE Tunnel0 (static route through 172.16.0.2), and a bystander
 *     PC3 on R1 Gi0/1; the ISP has no private route;
 *   • ipsec (§3.13): the same sites over a protected VTI, optionally with a wrong key on R2;
 *   • ipv6: PC1 — R1 — PC2, SLAAC on both LANs;
 *   • qos (§3.5, §3.11): PC-V and PC-D on SW1 → R1 — 128 kb/s serial — R2 → PC-S, R1 marking voice EF at the LAN
 *     edge, with or without the LLQ policy on the serial port.
 * Ruling R44: the traffic kind runs its continuous flows under `runFor` (the clone never waits on `runToIdle` for them).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LabAssertion, ScenarioInfo } from '../src/contracts/scenario.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { evaluateLab } from '../src/sim/lab-checks.js';
import { LAB_SERVICE_TIMEOUT_MS } from '../src/sim/lab-checks/service.js';
import { LAB_TRAFFIC_DRAIN_NS, checkTraffic } from '../src/sim/lab-checks/traffic.js';
import { PASS, type CloneHost } from '../src/sim/lab-checks/core.js';
import { CHECKERS } from '../src/sim/lab-checks/registry.js';
import { KEY, PASSWORD, boot, ipv6World, qosWorld, sshWorld, tunnelWorld } from './approved-kinds.world.js';

/** Wall-clock budget of a world's boot in a `beforeAll`. */
const BOOT_TIMEOUT_MS = 60_000;

/** One task per assertion, graded in one `evaluateLab` call (so they share the clone, in order). */
function lab(assertions: readonly LabAssertion[]): ScenarioInfo {
  return {
    name: 'approved-kinds',
    title: 'Approved kinds',
    description: '',
    category: 'ccna3-lab',
    build: () => {
      throw new Error('not built');
    },
    tasks: assertions.map((a, i) => ({ id: `t${i}`, title: `t${i}`, description: '', points: 1, assertions: [a] })),
  };
}

/** The detail of each assertion: undefined when it passes. */
function details(sim: Simulation, assertions: readonly LabAssertion[]): (string | undefined)[] {
  return evaluateLab(sim, lab(assertions)).results.map((r) => (r.pass ? undefined : (r.assertions[0]?.detail ?? '(no detail)')));
}

/** The detail of one assertion graded alone (its own clone). */
const one = (sim: Simulation, a: LabAssertion): string | undefined => details(sim, [a])[0];

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('the registry runs the approved clone kinds (a reviewed edit of registry.ts)', () => {
  it('service, path and traffic have checkers; inside connectivity.then each is refused, as a second ping is', () => {
    for (const k of ['service', 'path', 'traffic'] as const) expect(typeof CHECKERS[k]).toBe('function');
    const sim = boot(sshWorld());
    const then = (inner: LabAssertion): LabAssertion => ({ kind: 'connectivity', from: 'PC1', to: 'R1', expect: 'success', then: [inner] });
    expect(
      details(sim, [
        then({ kind: 'service', from: 'PC1', to: 'R1', service: 'ssh', expect: 'success' }),
        then({ kind: 'path', from: 'PC1', to: 'R1' }),
        then({ kind: 'traffic', flows: [{ from: 'PC1', to: 'R1', dst: '192.168.10.1', pps: 1, sizeBytes: 100 }], runMs: 1000, expect: [{ receiver: 'R1', flow: 'f1' }] }),
      ]),
    ).toEqual([
      'After the ping from PC1: A follow-up check reads state; it cannot open a remote login.',
      'After the ping from PC1: A follow-up check reads state; it cannot send a probe.',
      'After the ping from PC1: A follow-up check reads state; it cannot start traffic.',
    ]);
  });
});

// ── [S13] service ────────────────────────────────────────────────────────────────────────────────────────────────

describe('[S13] service: a real login in the clone (§3.14)', () => {
  let sim: Simulation;
  beforeAll(() => {
    sim = boot(sshWorld());
  }, BOOT_TIMEOUT_MS);
  const ssh = (over: Partial<Extract<LabAssertion, { kind: 'service' }>> = {}): LabAssertion => ({
    kind: 'service',
    from: 'PC1',
    to: 'R1',
    service: 'ssh',
    user: 'admin',
    password: PASSWORD,
    expect: 'success',
    ...over,
  });

  it('expect success: PC1 logs in over SSH; the same login expected refused or failed is a wrong answer', () => {
    expect(details(sim, [ssh(), ssh({ expect: 'refused' }), ssh({ expect: 'fail' })])).toEqual([
      undefined,
      "PC1's SSH login to R1 (192.168.10.1) succeeded; this task expects it to be refused.",
      "PC1's SSH login to R1 (192.168.10.1) succeeded; this task expects it to fail on its credentials.",
    ]);
  });

  it('password and user: a wrong password fails the login (expect fail passes, expect success does not); so does an unknown user', () => {
    const got = details(sim, [ssh({ password: 'nope', expect: 'fail' }), ssh({ password: 'nope' }), ssh({ user: 'guest', expect: 'fail' }), ssh({ user: 'guest' })]);
    expect(got[0]).toBeUndefined();
    expect(got[1]).toMatch(/^PC1's SSH login to R1 \(192\.168\.10\.1\) failed on the user name or password( \(.+\))?; this task expects it to succeed\.$/);
    expect(got[2]).toBeUndefined();
    expect(got[3]).toMatch(/^PC1's SSH login to R1 \(192\.168\.10\.1\) failed on the user name or password/);
    // no credentials at all is a wrong credential, never a wait for a console line
    expect(one(sim, ssh({ user: undefined, password: undefined, expect: 'fail' }))).toBeUndefined();
  });

  it('from: the access-class refuses PC2 (expect refused passes; expect success fails with the row reason)', () => {
    expect(details(sim, [ssh({ from: 'PC2', expect: 'refused' }), ssh({ from: 'PC2' })])).toEqual([
      undefined,
      "PC2's SSH login to R1 (192.168.10.1) was refused (access-class 10); this task expects it to succeed.",
    ]);
  });

  it('service: telnet is refused by `transport input ssh` with a reset and no login row', () => {
    expect(details(sim, [ssh({ service: 'telnet', expect: 'refused' }), ssh({ service: 'telnet' })])).toEqual([
      undefined,
      "PC1's Telnet login to R1 (192.168.10.1) was refused with a reset before any login: R1 does not accept Telnet there; this task expects it to succeed.",
    ]);
  });

  it('after: a configuration fault that lets telnet in turns the refusal into a login', () => {
    const open: LabAssertion = ssh({ service: 'telnet', after: [{ config: { device: 'R1', lines: ['line vty 0 4', ' transport input telnet ssh'] } }] });
    expect(details(sim, [open, { ...open, expect: 'refused' } as LabAssertion])).toEqual([
      undefined,
      "PC1's Telnet login to R1 (192.168.10.1) succeeded; this task expects it to be refused.",
    ]);
  });

  it('telnet with no credentials to login local: the client gives up at the repeated prompt, quickly (W5 l2 report)', () => {
    const telnetOpen = [{ config: { device: 'R1', lines: ['line vty 0 4', ' transport input telnet ssh'] } }] as const;
    const bare: LabAssertion = ssh({ service: 'telnet', user: undefined, password: undefined, after: telnetOpen });
    const started = sim.now;
    const got = details(sim, [{ ...bare, expect: 'fail' } as LabAssertion, bare]);
    expect(sim.now).toBe(started);
    expect(got[0]).toBeUndefined();
    expect(got[1]).toMatch(/^PC1's Telnet login to R1 \(192\.168\.10\.1\) failed on the user name or password \(the far end asked for the user name again\); this task expects it to succeed\.$/);
  });

  it('timeoutMs: one millisecond is too short for any login; the default is long enough', () => {
    expect(LAB_SERVICE_TIMEOUT_MS).toBe(20_000);
    expect(details(sim, [ssh({ timeoutMs: 1 }), ssh({ timeoutMs: LAB_SERVICE_TIMEOUT_MS })])).toEqual([
      "PC1's SSH login to R1 (192.168.10.1) came to nothing: nothing came of it within 1 ms; this task expects it to succeed.",
      undefined,
    ]);
  });

  it('to: a device with no address to log in to, and authoring mistakes, fail before any clone is built', () => {
    expect(one(sim, ssh({ to: 'SW1' }))).toBe('SW1 has no IPv4 address to log in to.');
    expect(one(sim, ssh({ to: 'R9' }))).toBe('There is no device called R9 in this topology.');
    expect(one(sim, ssh({ from: 'PC9' }))).toBe('There is no device called PC9 in this topology.');
    expect(one(sim, ssh({ service: 'rdp' as never }))).toBe('"rdp" is not a remote login service; use telnet or ssh.');
    expect(one(sim, ssh({ expect: 'maybe' as never }))).toBe('A remote login check expects success, fail or refused, not "maybe".');
    expect(one(sim, ssh({ after: [{ powerOff: 'R9' }] }))).toBe('There is no device called R9 in this topology.');
  });

  it('grades without touching the live world, and the same way twice (the memo answers the second time)', () => {
    const now = sim.now;
    const head = sim.trace(0).next;
    const assertions = [ssh(), ssh({ from: 'PC2', expect: 'refused' }), ssh({ service: 'telnet', expect: 'refused' })];
    const first = evaluateLab(sim, lab(assertions));
    expect(evaluateLab(sim, lab(assertions))).toEqual(first);
    expect(first.score).toBe(3);
    expect(sim.now).toBe(now);
    expect(sim.trace(0).next).toBe(head);
    expect(sim.device('r1')!.tables.get('vty-logins')?.rows() ?? []).toEqual([]);
  });
});

// ── [S18] path, [C13] tunnelAt ───────────────────────────────────────────────────────────────────────────────────

describe('[S18] path: the way the probe really goes, read from the clone trace (§3.10)', () => {
  let gre: Simulation;
  beforeAll(() => {
    gre = boot(tunnelWorld('gre'));
  }, BOOT_TIMEOUT_MS);
  const path = (over: Partial<Extract<LabAssertion, { kind: 'path' }>> = {}): LabAssertion => ({ kind: 'path', from: 'PC1', to: 'PC2', ...over });

  it('via: the devices in order (gaps allowed); the same devices out of order are a wrong answer', () => {
    expect(details(gre, [path(), path({ via: ['R1', 'ISP', 'R2'] }), path({ via: ['R1', 'R2'] }), path({ via: ['R2', 'R1'] })])).toEqual([
      undefined,
      undefined,
      undefined,
      "PC1's probe to PC2 (192.168.2.10) went PC1 → R1 → ISP → R2 → PC2, not through R2, then R1.",
    ]);
  });

  it('notVia: a bystander is not on the path; the provider is', () => {
    expect(details(gre, [path({ notVia: ['PC3'] }), path({ notVia: ['ISP'] })])).toEqual([
      undefined,
      "PC1's probe to PC2 (192.168.2.10) went PC1 → R1 → ISP → R2 → PC2, through ISP, which this task rules out.",
    ]);
  });

  it('toIface and toAddress: an interface or an address of the target; one it lacks is a wrong answer', () => {
    expect(
      details(gre, [
        path({ to: 'R2', toIface: 'Gi0/0', via: ['R1', 'ISP'] }),
        path({ to: 'R2', toAddress: '172.16.0.2', via: ['R1', 'ISP'] }),
        path({ to: 'R2', toIface: 'GigabitEthernet0/1' }),
        path({ to: 'R2', toAddress: '10.9.9.9' }),
      ]),
    ).toEqual([undefined, undefined, 'R2 GigabitEthernet0/1 has no IPv4 address to be reached at.', 'R2 does not hold 10.9.9.9.']);
    expect(one(gre, path({ to: 'R2', toIface: 'Gi9/9' }))).toBe('R2 has no interface called Gi9/9.');
    expect(one(gre, path({ to: 'R2', toAddress: 'not-an-address' }))).toBe('not-an-address is not an IPv4 address.');
  });

  it('tunnelAt: every frame of the probe the ISP receives is a GRE leg; ipsec is the wrong answer here', () => {
    expect(details(gre, [path({ tunnelAt: { device: 'ISP', tunnel: 'gre' } }), path({ tunnelAt: { device: 'ISP', tunnel: 'ipsec' } }), path({ tunnelAt: { device: 'PC3', tunnel: 'gre' } })])).toEqual([
      undefined,
      "ISP received 2 of 2 frames of PC1's probe to PC2 (192.168.2.10) inside a GRE tunnel, not inside an IPsec (ESP) tunnel.",
      "No frame of PC1's probe to PC2 (192.168.2.10) reached PC3, so nothing shows it crossed there inside a GRE tunnel.",
    ]);
  });

  it('after: a harmless fault keeps the path; a tunnel without a destination sends the probe to the ISP, which drops it', () => {
    expect(
      details(gre, [
        path({ via: ['ISP'], after: [{ shutdown: { device: 'R1', port: 'GigabitEthernet0/1' } }] }),
        path({ after: [{ config: { device: 'R1', lines: ['interface Tunnel0', ' no tunnel destination'] } }] }),
        path({ after: [{ cut: { a: 'R1', b: 'ISP' } }] }),
      ]),
    ).toEqual([
      undefined,
      "PC1's probe to PC2 (192.168.2.10) never reached PC2: it was dropped at ISP (no-route).",
      "PC1's probe to PC2 (192.168.2.10) never reached PC2: it was dropped at R1 (no-route).",
    ]);
  });

  it('family: an IPv4-only world has no IPv6 target; a dual-stack world has one', () => {
    expect(one(gre, path({ family: 6 }))).toBe('PC2 has no IPv6 address to be reached at.');
    const v6 = boot(ipv6World());
    expect(details(v6, [path({ family: 6, via: ['R1'] }), path({ family: 6, notVia: ['R1'] })])).toEqual([
      undefined,
      expect.stringMatching(/^PC1's probe to PC2 \(2001:db8:2:[0-9a-f:]+\) went PC1 → R1 → PC2, through R1, which this task rules out\.$/),
    ]);
  });

  it('authoring mistakes fail before any clone is built', () => {
    expect(one(gre, path({ via: ['R9'] }))).toBe('There is no device called R9 in this topology.');
    expect(one(gre, path({ notVia: ['R9'] }))).toBe('There is no device called R9 in this topology.');
    expect(one(gre, path({ tunnelAt: { device: 'R9', tunnel: 'gre' } }))).toBe('There is no device called R9 in this topology.');
    expect(one(gre, path({ tunnelAt: { device: 'ISP', tunnel: 'l2tp' as never } }))).toBe('"l2tp" is not a tunnel a path check knows; use gre or ipsec.');
    expect(one(gre, path({ family: 5 as never }))).toBe('A path check is for IPv4 or IPv6 (family 4 or 6), not 5.');
    expect(one(gre, path({ from: 'PC9' }))).toBe('There is no device called PC9 in this topology.');
  });
});

describe('[C13] path.tunnelAt: only ESP crosses the provider (§3.13 step 12)', () => {
  const tunnelAt = { device: 'ISP', tunnel: 'ipsec' } as const;

  it('the VTI carries every frame of the probe at the ISP as ESP; gre is the wrong answer', () => {
    const sim = boot(tunnelWorld('ipsec'));
    expect(details(sim, [{ kind: 'path', from: 'PC1', to: 'PC2', tunnelAt }, { kind: 'path', from: 'PC1', to: 'PC2', tunnelAt: { device: 'ISP', tunnel: 'gre' } }])).toEqual([
      undefined,
      "ISP received 2 of 2 frames of PC1's probe to PC2 (192.168.2.10) inside an IPsec (ESP) tunnel, not inside a GRE tunnel.",
    ]);
  });

  it('settleMs: with a wrong key the probe follows the default route and dies at the ISP; the fixed key needs the next IKE retry', () => {
    const sim = boot(tunnelWorld('ipsec', 'Nf-Other-Key-99'));
    const fix = [{ config: { device: 'R2', lines: ['crypto ikev2 keyring KR', ' peer R1', `  pre-shared-key ${KEY}`] } }] as const;
    expect(
      details(sim, [
        { kind: 'path', from: 'PC1', to: 'PC2', tunnelAt },
        { kind: 'path', from: 'PC1', to: 'PC2', tunnelAt, after: fix, settleMs: 0 },
        { kind: 'path', from: 'PC1', to: 'PC2', tunnelAt, after: fix, settleMs: 20_000 },
      ]),
    ).toEqual([
      "PC1's probe to PC2 (192.168.2.10) never reached PC2: it was dropped at ISP (no-route).",
      "PC1's probe to PC2 (192.168.2.10) never reached PC2: it was dropped at ISP (no-route).",
      undefined,
    ]);
  });
});

// ── [S20] traffic ────────────────────────────────────────────────────────────────────────────────────────────────

describe('[S20] traffic: generated flows under runFor in the clone, graded from the receiver rows (§3.5, §3.11, R44)', () => {
  let llq: Simulation;
  let fifo: Simulation;
  beforeAll(() => {
    llq = boot(qosWorld(true));
    fifo = boot(qosWorld(false));
  }, BOOT_TIMEOUT_MS);
  const voice = { from: 'PC-V', to: 'PC-S', dst: '192.168.2.10', pps: 50, sizeBytes: 60, dstPort: 16384 } as const;
  const bulk = { from: 'PC-D', to: 'PC-S', dst: '192.168.2.10', rateKbps: 200, sizeBytes: 1000 } as const;
  const traffic = (over: Partial<Extract<LabAssertion, { kind: 'traffic' }>> = {}): LabAssertion => ({
    kind: 'traffic',
    flows: [voice, bulk],
    runMs: 5_000,
    expect: [{ receiver: 'PC-S', flow: 'f1', maxLossPct: 0, maxDelayMs: 100 }],
    ...over,
  });
  /** Wall-clock budget of one traffic case (a few seconds of a congested 128 kb/s line per check). */
  const SLOW = 180_000;

  it('maxDelayMs and maxLossPct: LLQ keeps voice whole and fast; the FIFO link does not (the wrong answer)', () => {
    expect(one(llq, traffic())).toBeUndefined();
    expect(one(fifo, traffic())).toMatch(/^Flow f1 from PC-V took up to \d+(\.\d)? ms to reach PC-S, more than 100 ms\.$/);
  }, SLOW);

  it('two traffic checks of one clone: a row the first left is never read by the second (whose flow went nowhere)', () => {
    expect(details(llq, [traffic(), traffic({ flows: [{ ...voice, dst: '10.99.99.99' }] })])).toEqual([undefined, 'No datagram of flow f1 from PC-V reached PC-S.']);
  }, SLOW);

  it('maxLossPct: the bulk flow loses datagrams on the congested line even with LLQ', () => {
    const bulkLoss = (maxLossPct: number): LabAssertion => traffic({ runMs: 10_000, expect: [{ receiver: 'PC-S', flow: 'f2', maxLossPct }] });
    expect(details(llq, [bulkLoss(90), bulkLoss(0)])).toEqual([undefined, expect.stringMatching(/^PC-S lost \d+ of \d+ datagrams of flow f2 from PC-D \(\d+(\.\d)? %\), more than 0 %\.$/)]);
  }, SLOW);

  it('maxJitterMs: voice alone crosses the idle line without jitter; behind the bulk flow on FIFO it jitters', () => {
    const jitter = (flows: Extract<LabAssertion, { kind: 'traffic' }>['flows']): LabAssertion => traffic({ flows, runMs: 3_000, expect: [{ receiver: 'PC-S', flow: 'f1', maxJitterMs: 1 }] });
    expect(details(fifo, [jitter([voice]), jitter([voice, bulk])])).toEqual([undefined, expect.stringMatching(/^Flow f1 from PC-V reached PC-S with \d+(\.\d)? ms of jitter, more than 1 ms\.$/)]);
  }, SLOW);

  it('runMs: a short run ends before the FIFO queue grows; a longer one does not; out of range is refused', () => {
    const delay = (runMs: number): LabAssertion => traffic({ runMs, expect: [{ receiver: 'PC-S', flow: 'f1', maxDelayMs: 300 }] });
    expect(one(fifo, delay(200))).toBeUndefined();
    expect(one(fifo, delay(5_000))).toMatch(/^Flow f1 from PC-V took up to \d+(\.\d)? ms to reach PC-S, more than 300 ms\.$/);
    expect(one(fifo, delay(0))).toBe('A traffic check runs its flows for 1 to 300000 ms; 0 is not in that range.');
    expect(one(fifo, delay(300_001))).toBe('A traffic check runs its flows for 1 to 300000 ms; 300001 is not in that range.');
    expect(one(fifo, delay(1.5))).toBe('A traffic check runs its flows for 1 to 300000 ms; 1.5 is not in that range.');
  }, SLOW);

  it('flows and expect: ids by position or given; a refused flow, a wrong receiver or id are wrong answers', () => {
    const short = (over: Partial<Extract<LabAssertion, { kind: 'traffic' }>>): LabAssertion => traffic({ runMs: 2_000, ...over });
    expect(
      details(llq, [
        short({ flows: [{ ...voice, id: 'voice' }, bulk], expect: [{ receiver: 'PC-S', flow: 'voice', maxLossPct: 0, maxDelayMs: 100 }] }),
        short({ flows: [bulk, voice], expect: [{ receiver: 'PC-S', flow: 'f2', maxLossPct: 0, maxDelayMs: 100 }] }),
        short({ flows: [{ ...voice, pps: 5000 }] }),
        short({ expect: [{ receiver: 'PC-D', flow: 'f1' }] }),
      ]),
    ).toEqual([
      undefined,
      undefined,
      'PC-V refused flow f1: A flow sends at most 2000 kb/s and 1000 packets per second.',
      'No datagram of flow f1 from PC-V reached PC-D.',
    ]);
    expect(one(llq, traffic({ expect: [{ receiver: 'PC-S', flow: 'f9' }] }))).toBe('This traffic check starts no flow called f9.');
    expect(one(llq, traffic({ flows: [{ ...voice, from: 'PC-9' }] }))).toBe('There is no device called PC-9 in this topology.');
    expect(one(llq, traffic({ expect: [{ receiver: 'PC-9', flow: 'f1' }] }))).toBe('There is no device called PC-9 in this topology.');
    expect(one(llq, traffic({ flows: [] }))).toBe('A traffic check needs at least one flow.');
    expect(one(llq, traffic({ expect: [] }))).toBe('A traffic check needs at least one expectation to grade.');
    expect(one(llq, traffic({ expect: [{ receiver: 'PC-S', flow: 'f1', maxLossPct: -1 }] }))).toBe('maxLossPct of flow f1 must be a number of at least 0.');
  }, SLOW);

  it('a check that fails after starting a flow stops it first: the next check of the clone grades as it would alone (W5 fix #25)', () => {
    const good: LabAssertion = traffic({ flows: [bulk], runMs: 1_000, expect: [{ receiver: 'PC-S', flow: 'f1' }] });
    const refusedSecond: LabAssertion = traffic({ flows: [bulk, { ...voice, pps: 5000 }] });
    expect(one(fifo, good)).toBeUndefined();
    expect(details(fifo, [refusedSecond, good])).toEqual(['PC-V refused flow f2: A flow sends at most 2000 kb/s and 1000 packets per second.', undefined]);
  }, SLOW);

  /** A clone host that runs every check in `clone` itself, in order (the base clone one evaluation shares). */
  const sharedClone = (clone: Simulation): CloneHost => {
    let n = 0;
    return { run: (_faults, _settle, _key, check) => check({ clone }, () => `lab-check:${++n}`) };
  };
  /** The flows of `name`'s traffic daemon that still run or start. */
  const liveFlows = (sim: Simulation, name: string): string[] => {
    const dev = sim.devices().find((d) => d.spec.name === name)!;
    const flows = dev.processes.get('traffic')?.stateSnapshot().state['flows'];
    return (Array.isArray(flows) ? (flows as { id: string; state: string }[]) : []).filter((f) => f.state === 'running' || f.state === 'starting').map((f) => f.id);
  };
  /** Voice alone on the idle line: whole, fast and even (it passes on a fresh clone). */
  const voiceStrict = traffic({ flows: [voice], runMs: 3_000, expect: [{ receiver: 'PC-S', flow: 'f1', maxLossPct: 0, maxDelayMs: 40, maxJitterMs: 1 }] }) as Extract<LabAssertion, { kind: 'traffic' }>;

  it('a check that stops at the event limit cleans up with a fresh budget: the next strict voice check grades as it would alone (W5 integration, fix #25 recheck)', () => {
    const alone = boot(qosWorld(false));
    expect(checkTraffic(alone, sharedClone(alone), voiceStrict)).toEqual(PASS);
    // both flows for five minutes on the FIFO line, under a limit the run reaches after a few seconds of congestion:
    // before, the clean-up drained with what the run left (nothing), so the bulk queue was still there for the voice
    const clone = boot(qosWorld(false));
    const host = sharedClone(clone);
    const heavy = traffic({ runMs: 300_000, expect: [{ receiver: 'PC-S', flow: 'f1' }] }) as Extract<LabAssertion, { kind: 'traffic' }>;
    const limited = checkTraffic(clone, host, heavy, 60_000);
    expect(limited).toEqual({ pass: false, detail: "The flows of this traffic check stopped at the grader's limit of 60000 events before 300000 ms had passed." });
    expect([liveFlows(clone, 'PC-V'), liveFlows(clone, 'PC-D')]).toEqual([[], []]);
    expect(checkTraffic(clone, host, voiceStrict)).toEqual(PASS);
  }, SLOW);

  it('a throw after a flow started stops that flow and drains before the error leaves the check (W5 fix #25, throw path)', () => {
    const clone = boot(qosWorld(false));
    const pcV = clone.devices().find((d) => d.spec.name === 'PC-V')!.id;
    const throwing = new Proxy(clone, {
      get(target, p) {
        if (p === 'device') {
          return (id: Parameters<Simulation['device']>[0]) => {
            const d = target.device(id);
            if (id !== pcV || d === undefined) return d;
            return new Proxy(d, {
              get(dt, q) {
                if (q === 'applyActions') return () => { throw new Error('boom'); };
                const v = Reflect.get(dt, q, dt) as unknown;
                return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(dt) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, p, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    });
    const a = traffic({ flows: [bulk, voice], runMs: 1_000, expect: [{ receiver: 'PC-S', flow: 'f1' }] }) as Extract<LabAssertion, { kind: 'traffic' }>;
    const at = clone.now;
    expect(() => checkTraffic(clone, sharedClone(throwing), a)).toThrow('boom');
    // PC-D's bulk flow had started: it was stopped, and the clone ran on to drain it
    expect(liveFlows(clone, 'PC-D')).toEqual([]);
    expect(clone.now).toBeGreaterThan(at);
  }, SLOW);

  it('grades without touching the live world; the drain ends once the line is quiet', () => {
    expect(LAB_TRAFFIC_DRAIN_NS).toBe(30 * SEC);
    const now = llq.now;
    const head = llq.trace(0).next;
    expect(one(llq, traffic({ runMs: 2_000 }))).toBeUndefined();
    expect(llq.now).toBe(now);
    expect(llq.trace(0).next).toBe(head);
    expect(llq.device('pcs')!.tables.get('flows')?.rows() ?? []).toEqual([]);
  }, SLOW);
});
