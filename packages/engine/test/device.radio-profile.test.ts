/**
 * W4 device (ARCHITECTURE-P2 §2.4, §2.12, §3.12 step 4): the `radio-profile` action, the controller-profile overlay
 * of `DeviceRuntime.radioSettings` and `ProcessCtx.radioSettings`. A radio without a controller profile renders
 * exactly what it rendered before (the P0.5 wifi goldens and the P1-profile digests must not move); a stored profile
 * overlays the BSS members (ssid, security, passphrase, `bss`), reports the pushing controller's name (`controller`,
 * §2.12) when the action carries one, and leaves the radio-level lines local; the profile is RAM; a port that is not
 * a radio is ignored with a runtime debug line. The daemons are fakes: capwap-wtp (the only issuer of the action)
 * arrives in W5.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceModel, DeviceRuntime, DeviceSpec } from '../src/contracts/device.js';
import type { PortRef, ProcessName } from '../src/contracts/ids.js';
import type { Action } from '../src/contracts/process.js';
import type { BssSettings, RadioSettings } from '../src/contracts/rf.js';
import type { SimTime } from '../src/contracts/time.js';
import type { TraceEvent } from '../src/contracts/trace.js';
import { createConfigAst } from '../src/cli/config-ast.js';
import { createRng } from '../src/core/prng.js';
import { createScheduler } from '../src/core/scheduler.js';
import { createTable } from '../src/core/table.js';
import { defineModel } from '../src/device/catalog/define.js';
import { NF_AP_1832_INPUT } from '../src/device/catalog/wireless.js';
import { copyRadioProfile, createDevice, overlayRadioProfile } from '../src/device/device.js';
import { createProcessCtx, type ProcessHost } from '../src/device/process-ctx.js';
import { createPduFactory } from '../src/pdu/factory.js';
import { fakeProcess, type FakeProcess } from './device.harness.js';
import { handCatalog } from './device.p2.harness.js';

/**
 * The lightweight AP as model DATA (`defineModel` is pure: no catalog validation, no dependence on the W4/W6 catalog
 * flips), behind a hand catalog: two `wireless-bss` radios (Wlan0 2.4 GHz, Wlan1 5 GHz) and a wired uplink.
 */
const LAP_MODEL: DeviceModel = defineModel(NF_AP_1832_INPUT, 'P1');
const WLAN0 = 'Wlan0';
const WLAN1 = 'Wlan1';
const UPLINK = 'GigabitEthernet0';
const ISSUER: ProcessName = 'capwap-wtp';

/** The local radio lines of Wlan0 (Wlan1 keeps the catalog defaults). */
const STARTUP = ['interface Wlan0', ' ssid LocalNet', ' security wpa2-psk', ' passphrase local secret', ' channel 6', ' tx-power 17'].join('\n');

/** What the P0.5 renderer gives for Wlan0 from STARTUP: pinned key by key (`toStrictEqual`), no `bss`, no `controller`. */
const LOCAL_WLAN0: RadioSettings = { band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 17, security: 'wpa2-psk', ssid: 'LocalNet', passphrase: 'local secret' };
/** Wlan1 has no lines: the catalog defaults of the 5 GHz radio. */
const LOCAL_WLAN1: RadioSettings = { band: '5', channel: 36, widthMhz: 20, txPowerDbm: 20, security: 'open' };

/** The WLAN a controller pushes (§3.12 step 4): a key tag, never a passphrase. */
const LABNET: BssSettings = { index: 0, ssid: 'LabNet', security: 'wpa2-psk', keyTag: 0x1234abcd, vlan: 20, switching: 'central', wlanId: 1 };

function profileAction(port: string, bss: readonly BssSettings[] | null, controller?: string): Action {
  return controller === undefined ? { type: 'radio-profile', port, bss } : { type: 'radio-profile', port, bss, controller };
}

/** The device under test with its recording dependencies. */
interface Lap {
  readonly device: DeviceRuntime;
  readonly events: TraceEvent[];
  /** Every `deps.onPortPhyConfig` call. */
  readonly phyCalls: { ref: PortRef; now: SimTime }[];
  kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[];
  /** Dispatch every pending boot/timer event. */
  run(): void;
}

/** A booted lightweight AP with a fake wlan-ap that keeps its ctx (`null` = no saved configuration). */
function lap(startupConfig: string | null = STARTUP): { h: Lap; ap: FakeProcess; at: SimTime } {
  const ap = fakeProcess('wlan-ap');
  const events: TraceEvent[] = [];
  const phyCalls: Lap['phyCalls'] = [];
  const scheduler = createScheduler();
  const spec: DeviceSpec = {
    id: 'd_1', type: LAP_MODEL.type, name: 'LAP1', position: { x: 0, y: 0 }, power: true, modules: [], macSalt: 0,
    ...(startupConfig !== null ? { startupConfig } : {}),
  };
  const device = createDevice(
    spec,
    {
      scheduler,
      trace: { emit: (ev) => events.push(ev) },
      rng: createRng(42).split(`device:${spec.id}`),
      pdus: createPduFactory(),
      catalog: handCatalog([LAP_MODEL], { 'wlan-ap': ap.factory }),
      tables: createTable,
      transmit: (_from, _pdu, now) => ({ ok: true, link: 'l_1', txStart: now, txEnd: now + 1000, arrive: now + 2000 }),
      onPortAdmin: () => undefined,
      onPortPhyConfig: (ref, now) => phyCalls.push({ ref, now }),
      mediumOp: () => undefined,
      airView: () => ({ visibleBss: () => [], link: () => undefined }),
      cliSink: { output: () => undefined, done: () => undefined },
    },
    0,
  );
  const h: Lap = {
    device,
    events,
    phyCalls,
    kinds<K extends TraceEvent['kind']>(kind: K): Extract<TraceEvent, { kind: K }>[] {
      return events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
    },
    run(): void {
      for (;;) {
        const ev = scheduler.next();
        if (ev === undefined) return;
        if (ev.kind === 'boot') device.onBoot(ev.at);
        else if (ev.kind === 'timer') device.onTimer(ev.process, ev.key, ev.at);
      }
    },
  };
  h.run();
  return { h, ap, at: device.bootedAt! };
}

describe('radioSettings without a controller profile (the P0.5 renderer, unchanged)', () => {
  it('renders the local lines exactly as before: no bss, no controller', () => {
    const { h } = lap();
    const wlan0 = h.device.radioSettings(WLAN0);
    expect(wlan0).toStrictEqual(LOCAL_WLAN0);
    expect(wlan0 !== undefined && 'bss' in wlan0).toBe(false);
    expect(wlan0 !== undefined && 'controller' in wlan0).toBe(false);
    expect(h.device.radioSettings(WLAN1)).toStrictEqual(LOCAL_WLAN1);
    expect(h.device.radioSettings(UPLINK)).toBeUndefined();
    expect(h.device.radioSettings('Wlan9')).toBeUndefined();
  });

  it('ctx.radioSettings is the runtime renderer: same bytes for every port', () => {
    const { h, ap } = lap();
    const ctx = ap.ctx!;
    expect(ctx.radioSettings).toBeDefined();
    expect(ctx.radioSettings!(WLAN0)).toStrictEqual(h.device.radioSettings(WLAN0));
    expect(ctx.radioSettings!(WLAN0)).toStrictEqual(LOCAL_WLAN0);
    expect(ctx.radioSettings!(WLAN1)).toStrictEqual(LOCAL_WLAN1);
    expect(ctx.radioSettings!(UPLINK)).toBeUndefined();
    expect(ctx.radioSettings!('Wlan9')).toBeUndefined();
  });

  it('a render is a fresh object each time (a caller cannot change the next render)', () => {
    const { h } = lap();
    const first = h.device.radioSettings(WLAN0)!;
    first.ssid = 'Changed';
    expect(h.device.radioSettings(WLAN0)).toStrictEqual(LOCAL_WLAN0);
  });
});

describe('the radio-profile action', () => {
  it('stores the profile, overlays BSS 0 on the local lines and notifies the link model once', () => {
    const { h, ap, at } = lap();
    const eventsBefore = h.events.length;
    const configChangesBefore = h.kinds('configChange').length; // the boot replay of STARTUP
    const phyBefore = h.phyCalls.length;
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET])], at);

    expect(h.phyCalls.length).toBe(phyBefore + 1);
    expect(h.phyCalls[phyBefore]).toStrictEqual({ ref: { device: 'd_1', port: WLAN0 }, now: at });
    // the BSS members come from the profile (the local passphrase is not the WLAN's secret), the radio lines stay local
    const expected: RadioSettings = { band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 17, security: 'wpa2-psk', ssid: 'LabNet', bss: [LABNET] };
    expect(h.device.radioSettings(WLAN0)).toStrictEqual(expected);
    expect(ap.ctx!.radioSettings!(WLAN0)).toStrictEqual(expected);
    // the other radio is untouched
    expect(h.device.radioSettings(WLAN1)).toStrictEqual(LOCAL_WLAN1);
    // silent: no trace event, no config change (the running-config still says LocalNet)
    expect(h.events.length).toBe(eventsBefore);
    expect(h.kinds('configChange')).toHaveLength(configChangesBefore);
  });

  it('a profile BSS with a passphrase supplies it; the local one is used only without a profile', () => {
    const { h, at } = lap();
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [{ index: 0, ssid: 'Home', security: 'wpa3-sae', passphrase: 'pushed secret', switching: 'local' }])], at);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual({
      band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 17, security: 'wpa3-sae', ssid: 'Home', passphrase: 'pushed secret',
      bss: [{ index: 0, ssid: 'Home', security: 'wpa3-sae', passphrase: 'pushed secret', switching: 'local' }],
    });
  });

  it('null clears the profile: the local render returns byte for byte, and the link model is told again', () => {
    const { h, at } = lap();
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET])], at);
    const phyBefore = h.phyCalls.length;
    h.device.applyActions(ISSUER, [profileAction(WLAN0, null)], at + 5);
    expect(h.phyCalls.length).toBe(phyBefore + 1);
    expect(h.phyCalls[phyBefore]).toStrictEqual({ ref: { device: 'd_1', port: WLAN0 }, now: at + 5 });
    expect(h.device.radioSettings(WLAN0)).toStrictEqual(LOCAL_WLAN0);
    // clearing a radio that has no profile is still a (harmless) link-model call, as the contract says
    h.device.applyActions(ISSUER, [profileAction(WLAN1, null)], at + 6);
    expect(h.phyCalls.length).toBe(phyBefore + 2);
    expect(h.device.radioSettings(WLAN1)).toStrictEqual(LOCAL_WLAN1);
  });

  it('an empty profile, or one without BSS 0, leaves the radio idle: no ssid, open, no passphrase', () => {
    const { h, at } = lap();
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [])], at);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual({ band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 17, security: 'open', bss: [] });

    const guest: BssSettings = { index: 1, ssid: 'Guest', security: 'open', switching: 'local' };
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [guest])], at + 1);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual({ band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 17, security: 'open', bss: [guest] });
  });

  it('the stored profile is a frozen copy ordered by index; the issuer keeps no handle on it', () => {
    const { h, at } = lap();
    const guest: BssSettings = { index: 1, ssid: 'Guest', security: 'open', vlan: 30, switching: 'central', wlanId: 2 };
    const given: BssSettings[] = [{ ...guest }, { ...LABNET }];
    h.device.applyActions(ISSUER, [profileAction(WLAN0, given)], at);
    // mutating what was handed over changes nothing
    given[0]!.ssid = 'Hacked';
    given.push({ index: 2, ssid: 'Late', security: 'open', switching: 'local' });
    const settings = h.device.radioSettings(WLAN0)!;
    expect(settings.bss).toStrictEqual([LABNET, guest]);
    expect(settings.ssid).toBe('LabNet');
    expect(Object.isFrozen(settings.bss)).toBe(true);
    expect(Object.isFrozen(settings.bss![0])).toBe(true);
    // only the members that were set are copied: no `passphrase: undefined` key
    expect('passphrase' in settings.bss![0]!).toBe(false);
    // and every render hands out the same stored list (no per-call copy of the profile)
    expect(h.device.radioSettings(WLAN0)!.bss).toBe(settings.bss);
  });

  it('a profile for a port that is not a radio, or does not exist, is ignored with a runtime debug line', () => {
    const { h, at } = lap();
    const phyBefore = h.phyCalls.length;
    h.device.applyActions(ISSUER, [profileAction(UPLINK, [LABNET]), profileAction('Wlan9', [LABNET])], at);
    expect(h.phyCalls.length).toBe(phyBefore);
    expect(h.device.radioSettings(UPLINK)).toBeUndefined();
    expect(h.device.radioSettings(WLAN0)).toStrictEqual(LOCAL_WLAN0);
    const debugs = h.kinds('debug').filter((e) => e.kind === 'debug' && e.event.process === ISSUER);
    expect(debugs.map((e) => (e.kind === 'debug' ? [e.event.category, e.event.message] : []))).toStrictEqual([
      ['runtime', `radio profile for ${UPLINK} ignored: not a radio`],
      ['runtime', 'radio profile for Wlan9 ignored: not a radio'],
    ]);
    expect(h.device.recentDebug().filter((e) => e.process === ISSUER)).toHaveLength(2);
  });

  it('the profile survives local line changes and wins over a typed ssid; the local render returns when cleared', () => {
    const { h, at } = lap();
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET])], at);
    expect(h.device.applyConfigLine([['interface', WLAN0]], ['channel', '11'], false)).toStrictEqual({ ok: true });
    expect(h.device.applyConfigLine([['interface', WLAN0]], ['ssid', 'Typed'], false)).toStrictEqual({ ok: true });
    expect(h.device.radioSettings(WLAN0)).toStrictEqual({ band: '2.4', channel: 11, widthMhz: 20, txPowerDbm: 17, security: 'wpa2-psk', ssid: 'LabNet', bss: [LABNET] });
    h.device.applyActions(ISSUER, [profileAction(WLAN0, null)], at + 1);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual({ ...LOCAL_WLAN0, channel: 11, ssid: 'Typed' });
  });

  it('the controller named by the action is reported as RadioSettings.controller; a profile without one, or a clear, leaves none', () => {
    const { h, ap, at } = lap();
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET], 'WLC1')], at);
    const named: RadioSettings = { band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 17, security: 'wpa2-psk', ssid: 'LabNet', bss: [LABNET], controller: 'WLC1' };
    expect(h.device.radioSettings(WLAN0)).toStrictEqual(named);
    expect(ap.ctx!.radioSettings!(WLAN0)).toStrictEqual(named);
    // display only: the other radio and the link-model call are as for any profile
    expect(h.device.radioSettings(WLAN1)).toStrictEqual(LOCAL_WLAN1);
    // a new profile replaces the old one whole, name included
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET])], at + 1);
    const unnamed = h.device.radioSettings(WLAN0)!;
    expect(unnamed).toStrictEqual({ band: '2.4', channel: 6, widthMhz: 20, txPowerDbm: 17, security: 'wpa2-psk', ssid: 'LabNet', bss: [LABNET] });
    expect('controller' in unnamed).toBe(false);
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET], 'WLC2')], at + 2);
    expect(h.device.radioSettings(WLAN0)!.controller).toBe('WLC2');
    // clearing the profile clears the name: the local render is back byte for byte
    h.device.applyActions(ISSUER, [profileAction(WLAN0, null)], at + 3);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual(LOCAL_WLAN0);
    // and so does power-off (RAM)
    h.device.applyActions(ISSUER, [profileAction(WLAN1, [LABNET], 'WLC1')], at + 4);
    expect(h.device.radioSettings(WLAN1)!.controller).toBe('WLC1');
    h.device.setPower(false, at + 10);
    h.device.setPower(true, at + 11);
    h.run();
    expect(h.device.radioSettings(WLAN1)).toStrictEqual(LOCAL_WLAN1);
  });

  it('a profile is RAM: power-off forgets it and the next boot renders the saved local lines', () => {
    const { h, at } = lap();
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET])], at);
    h.device.setPower(false, at + 10);
    h.device.setPower(true, at + 11);
    h.run();
    expect(h.device.bootedAt).toBeGreaterThan(at + 11);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual(LOCAL_WLAN0);
    expect(h.device.radioSettings(WLAN1)).toStrictEqual(LOCAL_WLAN1);
  });

  it('a radio of a fresh device with no lines at all renders the catalog defaults, profile or not', () => {
    const { h, at } = lap(null);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual({ band: '2.4', channel: 1, widthMhz: 20, txPowerDbm: 20, security: 'open' });
    h.device.applyActions(ISSUER, [profileAction(WLAN0, [LABNET])], at);
    expect(h.device.radioSettings(WLAN0)).toStrictEqual({ band: '2.4', channel: 1, widthMhz: 20, txPowerDbm: 20, security: 'wpa2-psk', ssid: 'LabNet', bss: [LABNET] });
  });
});

describe('the pure helpers', () => {
  it('copyRadioProfile copies set members only, freezes, and orders by index (stable)', () => {
    const a: BssSettings = { index: 1, ssid: 'A', security: 'open', switching: 'local' };
    const b: BssSettings = { index: 0, ssid: 'B', security: 'wpa2-psk', keyTag: 7, vlan: 2, switching: 'central', wlanId: 3 };
    const c: BssSettings = { index: 1, ssid: 'C', security: 'wpa3-sae', passphrase: 'p', switching: 'local' };
    const copy = copyRadioProfile([a, b, c]);
    expect(copy).toStrictEqual([b, a, c]);
    expect(copy[0]).not.toBe(b);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(copy.every((e) => Object.isFrozen(e))).toBe(true);
    expect(copyRadioProfile([])).toStrictEqual([]);
  });

  it('overlayRadioProfile changes only ssid, security, passphrase and bss', () => {
    const local: RadioSettings = { band: '5', channel: 'auto', widthMhz: 40, txPowerDbm: 12, security: 'wpa2-psk', ssid: 'L', passphrase: 'x', emitBeacons: true, peerKey: 'k' };
    const profile = copyRadioProfile([LABNET]);
    const out = overlayRadioProfile({ ...local }, profile);
    expect(out).toStrictEqual({ band: '5', channel: 'auto', widthMhz: 40, txPowerDbm: 12, security: 'wpa2-psk', ssid: 'LabNet', emitBeacons: true, peerKey: 'k', bss: profile });
    expect(overlayRadioProfile({ ...local }, [])).toStrictEqual({ band: '5', channel: 'auto', widthMhz: 40, txPowerDbm: 12, security: 'open', emitBeacons: true, peerKey: 'k', bss: [] });
  });

  it('overlayRadioProfile sets controller when a name is given and leaves it out otherwise', () => {
    const local: RadioSettings = { band: '2.4', channel: 1, widthMhz: 20, txPowerDbm: 20, security: 'open' };
    const profile = copyRadioProfile([LABNET]);
    expect(overlayRadioProfile({ ...local }, profile, 'WLC1')).toStrictEqual({ band: '2.4', channel: 1, widthMhz: 20, txPowerDbm: 20, security: 'wpa2-psk', ssid: 'LabNet', bss: profile, controller: 'WLC1' });
    const unnamed = overlayRadioProfile({ ...local, controller: 'stale' }, profile);
    expect('controller' in unnamed).toBe(false);
  });
});

describe('ProcessCtx.radioSettings on a hand-built host', () => {
  /** The minimum a ProcessHost needs, with the runtime's tables borrowed from a real device. */
  function hostOf(extra: Partial<ProcessHost>): ProcessHost {
    const { h } = lap();
    return {
      id: 'd_9',
      hostname: 'HAND',
      model: LAP_MODEL,
      now: 0,
      ports: new Map(),
      tables: h.device.tables,
      running: createConfigAst(),
      trace: { emit: () => undefined },
      pdus: createPduFactory(),
      capabilities: [],
      air: undefined,
      recordDebug: () => undefined,
      ...extra,
    };
  }

  it('is absent when the host offers no renderer (optional by meaning: a daemon may fall back to its own reader)', () => {
    const ctx = createProcessCtx(hostOf({}), 'wlan-ap', createRng(1).split('process:wlan-ap'));
    expect(ctx.radioSettings).toBeUndefined();
    expect('radioSettings' in ctx).toBe(false);
  });

  it('delegates to the host renderer with the host as `this`', () => {
    const host = hostOf({
      radioSettings(this: ProcessHost, port) {
        return port === WLAN0 ? { ...LOCAL_WLAN1, ssid: this.hostname } : undefined;
      },
    });
    const ctx = createProcessCtx(host, 'wlan-ap', createRng(1).split('process:wlan-ap'));
    expect(ctx.radioSettings!(WLAN0)).toStrictEqual({ ...LOCAL_WLAN1, ssid: 'HAND' });
    expect(ctx.radioSettings!(WLAN1)).toBeUndefined();
  });
});
