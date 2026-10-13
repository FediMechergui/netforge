/**
 * staged.world P3 parity (ARCHITECTURE-P3 §0 rule 13, §7 W4 step 2 and W6 [S32], rulings R47): since the W4 catalog
 * flip and the W6 flip ([S32], alone) the test-only P3 data `test/staged.world.ts` carried before them equals the real
 * contract, and a P3-stage world built on `staged.world` is the real P3 catalog, model for model:
 *   - `STAGED_PROCESS_ORDER` is `PROCESS_ORDER` (the W6 flip inserted [S32] `script-host` last);
 *   - `P3_CAPABILITY_PROCESS_ROWS` are the `since: 'P3'` rows of `CAPABILITY_PROCESSES`, capability by capability,
 *     [S32] `programmable`'s `script-host` included (the W6 flip's row; no `tftp`, which is [S29]);
 *   - `P3_PROCESS_TABLES` are the `PROCESS_TABLES` rows of the P3 daemons (`script-host`'s `script-runs` from W6);
 *   - `P3_STAGED_PROCESS_TABLES` equals `STAGED_PROCESS_TABLES`;
 *   - the staged derivations (`deriveStagedProcesses`, `deriveStagedTables`) equal the real ones (`deriveProcesses`,
 *     `deriveTables`) at stage P3 for every real model, and `createStagedCatalog({stage: 'P3'})` holds every real model
 *     unchanged and nothing else — including (R47) `profileConfig.P3`, the two [S24] `service timestamps` lines of
 *     routers, managed switches and the controller; the W0–W5 test-only NF-DEVHOST is the real `pc.nfdevhost` now.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_PROCESSES, PROCESS_ORDER, type CapabilityProcess } from '../src/contracts/catalog.js';
import type { ProcessName } from '../src/contracts/ids.js';
import { PROCESS_TABLES, STAGED_PROCESS_TABLES } from '../src/contracts/tables.js';
import { ALL_MODELS, CATALOG_STAGE } from '../src/device/catalog/index.js';
import { NF_DEVHOST_MODEL_INPUT } from '../src/device/catalog/computers.js';
import { TIMESTAMPS_PROFILE_LINES, deriveProcesses, deriveTables } from '../src/device/catalog/define.js';
import { PROCESS_FACTORIES } from '../src/protocols/index.js';
import { createScriptHost } from '../src/protocols/script-host.js';
import {
  NF_DEVHOST_TYPE,
  P3_CAPABILITY_PROCESS_ROWS,
  P3_DAEMONS,
  P3_PROCESS_TABLES,
  P3_STAGED_PROCESS_TABLES,
  STAGED_PROCESS_ORDER,
  createStagedCatalog,
  createStagedSimulation,
  deriveStagedProcesses,
  deriveStagedTables,
  nfDevhostTestInput,
  stagedModelInputs,
  stagedRegistry,
} from './staged.world.js';

/** [S32]'s daemon: in the test-only data since W0, in the contract since the W6 flip. */
const W6_DAEMON: ProcessName = 'script-host';

describe('staged.world P3 test-only data equals the contract (the W4 and W6 flips)', () => {
  it('the flips have landed: the real catalog is at stage P3 and holds NF-DEVHOST', () => {
    expect(CATALOG_STAGE).toBe('P3');
    expect(ALL_MODELS.filter((m) => m.type === NF_DEVHOST_TYPE).map((m) => m.model)).toEqual(['NF-DEVHOST']);
  });

  it('STAGED_PROCESS_ORDER is PROCESS_ORDER, the W6 script-host last', () => {
    expect(STAGED_PROCESS_ORDER).toEqual(PROCESS_ORDER);
    expect(PROCESS_ORDER.at(-1)).toBe(W6_DAEMON);
    expect(STAGED_PROCESS_ORDER.at(-1)).toBe(W6_DAEMON);
  });

  it('P3_DAEMONS are the registered daemons of the two flips', () => {
    expect(P3_DAEMONS).toHaveLength(16);
    for (const n of P3_DAEMONS) expect([n, Object.prototype.hasOwnProperty.call(PROCESS_FACTORIES, n)]).toEqual([n, true]);
    expect(PROCESS_FACTORIES[W6_DAEMON]).toBe(createScriptHost);
    // the default staged registry is the real one: an overlay of the flip daemons is redundant
    expect(stagedRegistry()).toEqual(PROCESS_FACTORIES);
  });

  it('P3_CAPABILITY_PROCESS_ROWS are the P3 rows of CAPABILITY_PROCESSES, capability by capability, programmable included', () => {
    const real = (cap: (typeof CAPABILITIES)[number]): readonly CapabilityProcess[] => CAPABILITY_PROCESSES[cap].filter((r) => r.since === 'P3');
    for (const cap of CAPABILITIES) {
      const staged = P3_CAPABILITY_PROCESS_ROWS[cap] ?? [];
      expect([cap, real(cap)]).toEqual([cap, staged]);
    }
    expect(P3_CAPABILITY_PROCESS_ROWS.programmable).toEqual([{ process: W6_DAEMON, since: 'P3' }]);
    expect(CAPABILITY_PROCESSES.programmable).toEqual([{ process: W6_DAEMON, since: 'P3' }]);
  });

  it('P3_PROCESS_TABLES are the PROCESS_TABLES rows of the P3 daemons (script-host: script-runs), and the staged rows match', () => {
    for (const [daemon, tables] of Object.entries(P3_PROCESS_TABLES)) expect([daemon, PROCESS_TABLES[daemon]]).toEqual([daemon, tables]);
    for (const daemon of P3_DAEMONS) expect([daemon, PROCESS_TABLES[daemon]]).toEqual([daemon, P3_PROCESS_TABLES[daemon]]);
    expect(PROCESS_TABLES[W6_DAEMON]).toEqual(['script-runs']);
    expect(P3_STAGED_PROCESS_TABLES).toEqual(STAGED_PROCESS_TABLES);
  });

  it('the staged derivations equal the real ones at stage P3 for every real model', () => {
    for (const m of ALL_MODELS) {
      const caps = m.capabilities ?? [];
      expect([m.type, deriveStagedProcesses(caps, 'P3')]).toEqual([m.type, deriveProcesses(caps, 'P3')]);
      expect([m.type, deriveStagedTables(m.processes, caps, 'P3')]).toEqual([m.type, deriveTables(m.processes, caps, 'P3')]);
      expect([m.type, deriveTables(m.processes, caps, 'P3')]).toEqual([m.type, m.tables]);
    }
  });

  it('createStagedCatalog at stage P3 holds every real model unchanged, profileConfig.P3 included (R47), and nothing else', () => {
    const staged = createStagedCatalog({ stage: 'P3' });
    for (const m of ALL_MODELS) expect([m.type, staged.get(m.type)]).toEqual([m.type, m]);
    expect(staged.list().map((m) => m.type)).toEqual(ALL_MODELS.map((m) => m.type));
    // the W0–W5 test-only NF-DEVHOST is reduced to the real input (no extra model, no stage-dependent input list)
    expect(stagedModelInputs('P3')).toEqual(stagedModelInputs('P2'));
    expect(nfDevhostTestInput()).toEqual(NF_DEVHOST_MODEL_INPUT);
    // R47: the two [S24] lines on routers, managed switches and the controller, and on no other model
    const withLines = staged.list().filter((m) => m.profileConfig?.P3 !== undefined);
    expect(withLines.map((m) => m.type)).toEqual(ALL_MODELS.filter((m) => m.profileConfig?.P3 !== undefined).map((m) => m.type));
    expect(withLines.length).toBeGreaterThan(0);
    for (const m of withLines) {
      expect([m.type, m.profileConfig?.P3]).toEqual([m.type, ['service timestamps debug datetime msec', 'service timestamps log datetime msec']]);
      expect(m.profileConfig?.P3).toEqual([...TIMESTAMPS_PROFILE_LINES]);
      expect([m.type, m.cdpDefault]).toEqual([m.type, true]);
    }
    for (const type of ['router.nf2911', 'switch.nfc2960', 'mlswitch.nfc3650-24', 'wlc.nfwlc9800']) expect(withLines.map((m) => m.type)).toContain(type);
    expect(withLines.map((m) => m.type)).not.toContain(NF_DEVHOST_TYPE);
    // every factory of the staged catalog is the real registry's
    for (const name of PROCESS_ORDER) expect([name, staged.process(name)]).toEqual([name, PROCESS_FACTORIES[name]]);
  });

  it('a staged P3 world replays the two lines on a router and boots no P3 daemon the real world lacks', () => {
    const sim = createStagedSimulation({ seed: 7, stage: 'P3' });
    sim.addDevice({ id: 'r1', type: 'router.nf2911', name: 'R1' });
    sim.addDevice({ id: 'dev1', type: NF_DEVHOST_TYPE, name: 'DEV1' });
    sim.runFor(60_000_000_000);
    const running = sim.device('r1')!.running.render();
    for (const line of TIMESTAMPS_PROFILE_LINES) expect(running).toContain(line);
    expect([...sim.device('r1')!.processes.keys()]).toEqual(ALL_MODELS.find((m) => m.type === 'router.nf2911')!.processes);
    expect([...sim.device('dev1')!.processes.keys()]).toEqual(ALL_MODELS.find((m) => m.type === NF_DEVHOST_TYPE)!.processes);
    expect(sim.device('dev1')!.processes.has(W6_DAEMON)).toBe(true);
  });
});
