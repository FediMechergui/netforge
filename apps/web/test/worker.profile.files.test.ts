/**
 * §10.2 "learn.course-profile / worker.profile (from W7)", the file and template paths through the worker after the
 * course and profile flip (ARCHITECTURE-P3 D2, §8.5 P15, §10.3 W7 "File → New opens a P3 world"; W7 qa).
 *
 * `worker.profile.test.ts` (the course-flip change, §9.2 item 42) pins init, reset, `startupProfile` and
 * `useCurrentDefaults` on worlds the worker builds. This file adds the row's saved-file cases in a P3 session: File →
 * New takes the profile of the last lesson's course (P3 with none); a saved P2 file opens as a P2 world — no chip,
 * "Use current defaults" offered with the P3 notes, the file exported back unchanged — and moves to P3 on request; a
 * saved classic file and a built-in template open as classic worlds with the "Classic defaults" chip; a P3 file opens
 * with the move disabled. Files go through a JSON round trip, as File → Save and File → Open do.
 *
 * The worker module is imported with Comlink mocked and wall timers faked, as in worker.profile.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_DEFAULTS_PROFILE, schemaIdFor } from '@netforge/engine';
import type { DefaultsProfile, SimSnapshot, Topology } from '@netforge/engine';
import { classicDefaultsChip } from '../src/app/StatusBar';
import type { EngineApi } from '../src/bridge/protocol';
import { CURRENT_DEFAULTS_IN_USE, PROFILE_NOTES, currentDefaultsItem, profileForCourse, profileOfSnapshot } from '../src/learn/course-profile';
import { store } from '../src/store/store';

let exposed: EngineApi | undefined;

vi.mock('comlink', () => ({
  expose: (api: EngineApi) => {
    exposed = api;
  },
  proxy: <T>(x: T) => x,
  wrap: () => {
    throw new Error('no worker in a test');
  },
}));
// ARCHITECTURE-P3 ruling R28: the pure engine is evaluated once per file; only the worker's own modules are fresh.
vi.mock('@netforge/engine', async (importOriginal) => await importOriginal());

const WORKER = '../src/bridge/worker/index.ts';

async function freshWorker(init: { seed: number; profile?: DefaultsProfile }): Promise<EngineApi> {
  vi.resetModules();
  exposed = undefined;
  await import(WORKER);
  const api = exposed as unknown as EngineApi;
  await api.subscribe(() => undefined);
  await api.init(init);
  return api;
}

/** File → Save then File → Open: the document as text and back. */
function saved(t: Topology): Topology {
  return JSON.parse(JSON.stringify(t)) as Topology;
}

/** What the File menu and the status bar show for a world: its profile, the chip, the menu entry. */
function shown(snap: SimSnapshot) {
  return { profile: profileOfSnapshot(snap), chip: classicDefaultsChip(snap)?.label ?? null, item: currentDefaultsItem(profileOfSnapshot(snap)) };
}

const P3_HINT = `Keeps every device and setting. Adds: ${PROFILE_NOTES.P3.join('; ')}.`;
const FROM_P1_HINT = `Keeps every device and setting. Adds: ${[...PROFILE_NOTES.P2, ...PROFILE_NOTES.P3].join('; ')}.`;

/** A small world built in a worker of `profile`: a router, a switch and a PC, exported as a saved file. */
async function savedWorld(profile: DefaultsProfile | undefined): Promise<Topology> {
  const api = await freshWorker(profile === undefined ? { seed: 5 } : { seed: 5, profile });
  for (const [i, type] of ['router.nf2911', 'switch.nfc2960', 'pc.nfpc'].entries()) await api.addDevice({ type, position: { x: 100 * i, y: 0 } });
  return saved(await api.exportTopology());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  store.getState().setLastCourse(null);
});

describe('File → New after the flip (the profile of the last lesson’s course)', () => {
  it('opens a P3 world with no lesson and after a CCNA 3 lesson, P2 after CCNA 2, a classic world after CCNA 1', async () => {
    expect(LATEST_DEFAULTS_PROFILE).toBe('P3');
    const api = await freshWorker({ seed: 3, profile: profileForCourse(store.getState().learn.lastCourse) });
    const fileNew = async (): Promise<SimSnapshot> => api.reset(4, profileForCourse(store.getState().learn.lastCourse));
    expect(shown(await api.snapshot())).toEqual({ profile: 'P3', chip: null, item: { enabled: false, hint: CURRENT_DEFAULTS_IN_USE } });
    const cases: [string | null, DefaultsProfile, string | null][] = [
      [null, 'P3', null],
      ['ccna3', 'P3', null],
      ['ccna2', 'P2', null],
      ['ccna1', 'P1', 'Classic defaults'],
    ];
    for (const [course, profile, chip] of cases) {
      store.getState().setLastCourse(course);
      const snap = await fileNew();
      expect(snap.devices, String(course)).toEqual([]);
      expect(shown(snap), String(course)).toMatchObject({ profile, chip, item: { enabled: profile !== 'P3' } });
      expect((await api.exportTopology()).profile, String(course)).toBe(profile === 'P1' ? undefined : profile);
    }
  });
});

describe('a saved P2 file in a P3 session', () => {
  it('opens as a P2 world: no chip, "Use current defaults" offered with the P3 notes, and saves back unchanged', async () => {
    const file = await savedWorld('P2');
    expect(file.profile).toBe('P2');
    expect(file.schema).toBe('netforge.topology/1.2');
    const api = await freshWorker({ seed: 9, profile: 'P3' });
    const snap = await api.loadTopology(file);
    expect(snap.profile).toBe('P2');
    expect(shown(snap)).toEqual({ profile: 'P2', chip: null, item: { enabled: true, hint: P3_HINT } });
    // nothing was moved on load: the same profile, schema, devices and configuration lines come back out
    const again = saved(await api.exportTopology());
    expect(again.profile).toBe('P2');
    expect(again.schema).toBe(file.schema);
    expect(again.devices.map((d) => [d.name, d.type, d.runningConfig ?? d.config])).toEqual(file.devices.map((d) => [d.name, d.type, d.runningConfig ?? d.config]));
  });

  it('moves to P3 on "Use current defaults", every configuration kept, and the menu entry then says so', async () => {
    const file = await savedWorld('P2');
    const api = await freshWorker({ seed: 9, profile: 'P3' });
    await api.loadTopology(file);
    const after = await api.useCurrentDefaults();
    expect(shown(after)).toEqual({ profile: 'P3', chip: null, item: { enabled: false, hint: CURRENT_DEFAULTS_IN_USE } });
    const moved = await api.exportTopology();
    expect(moved.profile).toBe('P3');
    expect(moved.schema).toBe(schemaIdFor(moved));
    expect(moved.devices.map((d) => [d.name, d.runningConfig ?? d.config])).toEqual(file.devices.map((d) => [d.name, d.runningConfig ?? d.config]));
  });
});

describe('classic worlds in a P3 session', () => {
  it('a built-in template opens as a classic world: the "Classic defaults" chip, the move to P3 offered', async () => {
    const api = await freshWorker({ seed: 7, profile: 'P3' });
    await api.loadScenario('two-pcs-and-switch');
    const snap = await api.snapshot();
    expect(snap.devices.length).toBeGreaterThan(0);
    expect(shown(snap)).toEqual({ profile: 'P1', chip: 'Classic defaults', item: { enabled: true, hint: FROM_P1_HINT } });
    expect((await api.exportTopology()).profile).toBeUndefined();
  });

  it('a saved classic file opens as a classic world, and saves back without a profile', async () => {
    const file = await savedWorld(undefined);
    expect(file.profile).toBeUndefined();
    const api = await freshWorker({ seed: 9, profile: 'P3' });
    const snap = await api.loadTopology(file);
    expect(shown(snap)).toEqual({ profile: 'P1', chip: 'Classic defaults', item: { enabled: true, hint: FROM_P1_HINT } });
    const again = saved(await api.exportTopology());
    expect(again.profile).toBeUndefined();
    expect(again.schema).toBe(file.schema);
  });
});

describe('a saved P3 file', () => {
  it('opens as a P3 world with the move disabled, whatever world the session held before', async () => {
    const file = await savedWorld('P3');
    expect(file.profile).toBe('P3');
    expect(file.schema).toBe('netforge.topology/1.3');
    const api = await freshWorker({ seed: 9 }); // a classic session
    const snap = await api.loadTopology(file);
    expect(shown(snap)).toEqual({ profile: 'P3', chip: null, item: { enabled: false, hint: CURRENT_DEFAULTS_IN_USE } });
  });
});
