import { describe, expect, it } from 'vitest';
import type { TransceiverSpec } from '../src/contracts/catalog.js';
import { MEDIA } from '../src/contracts/link.js';
import type { MediaType } from '../src/contracts/link.js';
import type { PortKind } from '../src/contracts/port.js';
import {
  autoMediaForKind,
  cableEndOf,
  checkCable,
  copperFor,
  isMediaType,
  maxLengthFor,
  mediaLabel,
  phyOverheadBytes,
  portKindLabel,
  resolveMedia,
  validateCable,
  wiringOfEnd,
  type PortSpecLike,
} from '../src/link/cabling.js';
import { testPortSpec } from './port.fixtures.js';

// Wiring comes from the port (§9.2): PC/router MDI, switch ports and hub repeater ports MDI-X.
const pc = (over: Partial<PortSpecLike> = {}): PortSpecLike => ({ kind: 'ethernet', wiring: 'MDI', hostTerminal: true, label: 'PC1 GigabitEthernet0', ...over });
const router = (over: Partial<PortSpecLike> = {}): PortSpecLike => ({ kind: 'ethernet', wiring: 'MDI', label: 'R1 GigabitEthernet0/0', ...over });
const sw = (over: Partial<PortSpecLike> = {}): PortSpecLike => ({ kind: 'ethernet', wiring: 'MDI-X', autoMdix: true, label: 'S1 FastEthernet0/1', ...over });
const swNoMdix = (over: Partial<PortSpecLike> = {}): PortSpecLike => ({ kind: 'ethernet', wiring: 'MDI-X', autoMdix: false, label: 'S2 FastEthernet0/1', ...over });
const hub = (): PortSpecLike => ({ kind: 'ethernet', role: 'repeater', label: 'H1 Ethernet1' });
const serial = (label = 'R1 Serial0/0/0'): PortSpecLike => ({ kind: 'serial', label });
const console_ = (label = 'R1 Console'): PortSpecLike => ({ kind: 'console', label });

describe('link/cabling wiring helpers', () => {
  it('hosts and routers are MDI, switch and hub repeater ports are MDI-X (per-port wiring)', () => {
    expect(wiringOfEnd(pc())).toBe('MDI');
    expect(wiringOfEnd(router())).toBe('MDI');
    expect(wiringOfEnd(swNoMdix())).toBe('MDI-X');
    // no explicit wiring: the role's wiring trait decides
    expect(wiringOfEnd(hub())).toBe('MDI-X');
    expect(wiringOfEnd({ kind: 'ethernet', role: 'routed' })).toBe('MDI');
    // explicit wiring wins over the role trait
    expect(wiringOfEnd({ kind: 'ethernet', role: 'switched', wiring: 'MDI' })).toBe('MDI');
    // the P0 device-kind rule (switch/hub MDI-X, others MDI) now comes from the default port roles (§9.2)
    expect(wiringOfEnd({ kind: 'ethernet', role: 'switched' })).toBe('MDI-X');
    expect(wiringOfEnd({ kind: 'ethernet', role: 'repeater' })).toBe('MDI-X');
    expect(wiringOfEnd({ kind: 'ethernet', role: 'routed' })).toBe('MDI');
    // no wiring data at all (a non-copper role): MDI
    expect(wiringOfEnd({ kind: 'ethernet', role: 'console' })).toBe('MDI');
  });

  it('cableEndOf takes wiring from the spec default role; a role flip never changes it', () => {
    const end = cableEndOf(testPortSpec({ name: 'GigabitEthernet1/0/24', short: 'Gi1/0/24', kind: 'ethernet', speedBps: 1e9, role: 'switched' }), { role: 'routed', label: 'L3 Gi1/0/24' });
    expect(end.wiring).toBe('MDI-X');
    expect(end.role).toBe('routed');
    expect(end.speedBps).toBe(1e9);
    expect(end.label).toBe('L3 Gi1/0/24');
    // a hand-built spec carries its default role (routed, MDI) and connector since the P0.5 exit gate
    const plain = cableEndOf(testPortSpec({ name: 'GigabitEthernet0', short: 'Gi0', kind: 'ethernet', speedBps: 1e9 }));
    expect(plain.wiring).toBe('MDI');
    expect(Object.keys(plain).sort()).toEqual(['connector', 'kind', 'role', 'speedBps', 'wiring']);
    // a port without a copper wiring trait carries no wiring
    const consoleEnd = cableEndOf(testPortSpec({ name: 'Console', short: 'Con', kind: 'console', speedBps: 9600 }, ['routing']));
    expect(consoleEnd.wiring).toBeUndefined();
  });

  it('copperFor picks straight across wirings and crossover within one wiring', () => {
    expect(copperFor(pc(), swNoMdix())).toBe('copper-straight');
    expect(copperFor(pc(), pc())).toBe('copper-crossover');
    expect(copperFor(router(), pc())).toBe('copper-crossover');
    expect(copperFor(swNoMdix(), hub())).toBe('copper-crossover');
    expect(copperFor(pc(), sw())).toBe('copper-straight');
    expect(copperFor(sw(), sw())).toBe('copper-straight');
  });

  it('isMediaType / autoMediaForKind', () => {
    for (const m of Object.keys(MEDIA)) expect(isMediaType(m)).toBe(true);
    // 'coax' became a real media in P0.5; any other unknown name must still be refused.
    expect(isMediaType('twinax')).toBe(false);
    expect(isMediaType('toString')).toBe(false);
    expect(autoMediaForKind('ethernet')).toBe('copper-straight');
    expect(autoMediaForKind('serial')).toBe('serial');
    expect(autoMediaForKind('console')).toBe('console');
    expect(autoMediaForKind('usb')).toBe('usb-console');
    expect(autoMediaForKind('coax')).toBe('coax');
    expect(autoMediaForKind('phone')).toBe('phone');
    expect(autoMediaForKind('fiber-pon')).toBe('fiber-pon');
    expect(autoMediaForKind('radio')).toBe('radio');
  });

  it('every media and port kind has original wording with a correct article', () => {
    for (const m of Object.keys(MEDIA) as MediaType[]) {
      // never the raw hyphenated id fallback ("copper-straight cable")
      expect(mediaLabel(m)).not.toBe(`${m} cable`.includes('-') ? `${m} cable` : '');
    }
    expect(mediaLabel('twinax' as MediaType)).toBe('twinax cable');
    const kinds: PortKind[] = ['ethernet', 'serial', 'console', 'usb', 'coax', 'phone', 'fiber-pon', 'wlan', 'radio', 'cellular', 'virtual'];
    for (const k of kinds) {
      const label = portKindLabel(k);
      expect(label).toMatch(/^(a|an) \S/);
      expect(label).not.toMatch(/^a [aeio]/);
    }
    expect(portKindLabel('ethernet')).toBe('an ethernet port');
    expect(portKindLabel('usb')).toBe('a USB port');
  });

  it('media helpers: per-speed length limits and PHY overhead', () => {
    expect(maxLengthFor('fiber-mm')).toBe(550);
    expect(maxLengthFor('fiber-mm', 100_000_000)).toBe(550);
    expect(maxLengthFor('fiber-mm', 1_000_000_000)).toBe(550);
    expect(maxLengthFor('fiber-mm', 10_000_000_000)).toBe(300);
    expect(maxLengthFor('fiber-mm', 40_000_000_000)).toBe(300);
    expect(maxLengthFor('copper-straight', 10_000_000_000)).toBe(100);
    expect(phyOverheadBytes('copper-straight')).toBe(20);
    expect(phyOverheadBytes('serial')).toBe(2);
    expect(phyOverheadBytes('serial-dce')).toBe(2);
    expect(phyOverheadBytes('serial-dte')).toBe(2);
  });
});

describe('link/cabling validateCable matrix', () => {
  it('pc ↔ switch with a straight-through cable is fine', () => {
    const v = validateCable(pc(), swNoMdix(), 'copper-straight', 3);
    expect(v).toEqual({ ok: true, resolvedMedia: 'copper-straight' });
  });

  it('pc ↔ pc with a straight-through cable is rejected with an explanation naming both ends and the right cable', () => {
    const v = validateCable(pc(), pc({ label: 'PC2 GigabitEthernet0' }), 'copper-straight', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('straight-through copper cable cannot link PC1 GigabitEthernet0 to PC2 GigabitEthernet0');
    expect(v.reason).toContain('both ends are MDI ports');
    expect(v.reason).toContain('use a crossover copper cable instead');
    // resolvedMedia is the cable actually specified; the correct one is named in the reason
    expect(v.resolvedMedia).toBe('copper-straight');
  });

  it('pc ↔ router straight is rejected, crossover is accepted', () => {
    const bad = validateCable(pc(), router(), 'copper-straight', 5);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('cannot link PC1 GigabitEthernet0 to R1 GigabitEthernet0/0');
    const good = validateCable(pc(), router(), 'copper-crossover', 5);
    expect(good).toEqual({ ok: true, resolvedMedia: 'copper-crossover' });
  });

  it('pc ↔ switch (no auto-MDIX) with a crossover is rejected and points at the straight cable', () => {
    const v = validateCable(pc(), swNoMdix(), 'copper-crossover', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('crossover copper cable cannot link PC1 GigabitEthernet0 to S2 FastEthernet0/1');
    expect(v.reason).toContain('PC1 GigabitEthernet0 is MDI and S2 FastEthernet0/1 is MDI-X');
    expect(v.reason).toContain('use a straight-through copper cable instead');
  });

  it('a switch with auto-MDIX accepts either copper cable', () => {
    expect(validateCable(pc(), sw(), 'copper-straight', 3).ok).toBe(true);
    expect(validateCable(pc(), sw(), 'copper-crossover', 3).ok).toBe(true);
    expect(validateCable(sw(), sw(), 'copper-straight', 3).ok).toBe(true);
    expect(validateCable(sw(), swNoMdix(), 'copper-straight', 3).ok).toBe(true);
    // auto-MDIX on the far side is enough as well
    expect(validateCable(pc({ autoMdix: true }), pc(), 'copper-straight', 3).ok).toBe(true);
  });

  it('switch ↔ switch / hub ↔ switch without auto-MDIX need a crossover', () => {
    expect(validateCable(swNoMdix(), swNoMdix(), 'copper-straight', 3).ok).toBe(false);
    expect(validateCable(swNoMdix(), swNoMdix(), 'copper-crossover', 3).ok).toBe(true);
    const v = validateCable(hub(), swNoMdix(), 'copper-straight', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('cannot link H1 Ethernet1 to S2 FastEthernet0/1');
    expect(v.reason).toContain('both ends are MDI-X ports');
  });

  it('role-derived wiring gives the P0 device-kind verdicts (the kind rule was removed at the P0.5 exit gate)', () => {
    const oldPc = (label: string): PortSpecLike => ({ kind: 'ethernet', role: 'routed', label });
    const oldSw: PortSpecLike = { kind: 'ethernet', role: 'switched', label: 'S9 Fa0/1' };
    const old = validateCable(oldPc('A'), oldPc('B'), 'copper-straight', 3);
    expect(old.ok).toBe(false);
    expect(old.reason).toContain('cannot link A to B: both ends are MDI ports');
    expect(validateCable(oldPc('A'), { ...oldSw, autoMdix: false }, 'copper-crossover', 3).reason).toContain('A to S9 Fa0/1');
    expect(validateCable(oldPc('A'), oldSw, 'copper-straight', 3).ok).toBe(true);
    expect(validateCable(oldPc('A'), oldPc('B'), 'auto', 3).resolvedMedia).toBe('copper-crossover');
  });

  it('console cable: a device console line to a computer, never console ↔ console or to a non-computer', () => {
    // rollover from a router console to a PC's ethernet (terminal) port
    expect(validateCable(console_(), pc(), 'console', 2)).toEqual({ ok: true, resolvedMedia: 'console' });
    expect(validateCable(pc(), console_(), 'console', 2).ok).toBe(true);
    // 'auto' on pc ↔ console picks the rollover cable
    expect(validateCable(pc(), console_(), 'auto', 2)).toEqual({ ok: true, resolvedMedia: 'console' });
    // a computer is recognised by its host shell (hostTerminal), never by its device kind
    expect(validateCable(console_(), { kind: 'ethernet', role: 'routed', hostTerminal: true, label: 'L1 Gi0' }, 'console', 2).ok).toBe(true);
    expect(validateCable(console_(), { kind: 'ethernet', role: 'routed', label: 'L1 Gi0' }, 'console', 2).ok).toBe(false);
    // console ↔ a switch port is refused: the switch is not a computer
    const toSwitch = checkCable(console_(), sw(), 'console', 2);
    expect(toSwitch.code).toBe('media-mismatch');
    expect(toSwitch.reason).toContain('only fits a device console line');
    expect(toSwitch.reason).toContain('S1 FastEthernet0/1 is an ethernet port on a device that is not a computer');
    expect(validateCable(console_(), router(), 'console', 2).ok).toBe(false);
    // two computers: no console line at all
    expect(checkCable(pc(), pc({ label: 'PC2 GigabitEthernet0' }), 'console', 2).reason).toContain('neither PC1 GigabitEthernet0 nor PC2 GigabitEthernet0 is a console line');
    // a serial port is still outside the console cable's port kinds
    expect(validateCable(console_(), serial(), 'console', 2).reason).toContain('only fits console or ethernet ports');
    // and a copper cable does not fit a console port
    const w = validateCable(pc(), console_(), 'copper-straight', 2);
    expect(w.ok).toBe(false);
    expect(w.reason).toContain('only fits ethernet ports');
    expect(w.reason).toContain('R1 Console is a console port');
    // console ↔ console is refused, with either media
    const both = validateCable(console_(), console_('R2 Console'), 'console', 2);
    expect(both.ok).toBe(false);
    expect(both.reason).toContain('cannot link R1 Console to R2 Console: both ends are device console lines');
    const bothAuto = checkCable(console_(), console_('R2 Console'), 'auto', 2);
    expect(bothAuto).toMatchObject({ ok: false, code: 'media-mismatch', resolvedMedia: 'console' });
    expect(bothAuto.reason).toContain('both ends are device console lines');
  });

  it('serial cable fits serial ports only', () => {
    expect(validateCable(serial(), serial('R2 Serial0/0/0'), 'serial', 3).ok).toBe(true);
    const v = validateCable(serial(), router(), 'serial', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('serial cable only fits serial ports');
    expect(validateCable(serial(), serial('R2 Serial0/0/0'), 'serial-dce', 3)).toEqual({ ok: true, resolvedMedia: 'serial-dce' });
    expect(validateCable(serial(), serial('R2 Serial0/0/0'), 'serial-dte', 3)).toEqual({ ok: true, resolvedMedia: 'serial-dte' });
  });

  it('fibre fits ethernet ports regardless of wiring', () => {
    expect(validateCable(pc(), pc(), 'fiber-mm', 200).ok).toBe(true);
    expect(validateCable(swNoMdix(), swNoMdix(), 'fiber-sm', 5000).ok).toBe(true);
  });

  it('length beyond the media limit is rejected with the limit named', () => {
    const v = validateCable(pc(), swNoMdix(), 'copper-straight', 150);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('exceeds the 100 m limit for copper-straight');
    expect(v.resolvedMedia).toBe('copper-straight');
    expect(validateCable(pc(), swNoMdix(), 'copper-straight', 100).ok).toBe(true);
    const f = validateCable(pc(), pc(), 'fiber-mm', 551);
    expect(f.reason).toContain('exceeds the 550 m limit for fiber-mm');
    const s = validateCable(serial(), serial('R2 Serial0/0/0'), 'serial', 16);
    expect(s.reason).toContain('exceeds the 15 m limit for serial');
  });

  it('auto with a serial pair uses the serial limit, not the copper one', () => {
    const v = validateCable(serial(), serial('R2 Serial0/0/0'), 'auto', 20);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('exceeds the 15 m limit for serial');
  });

  it('bad lengths and unknown media are rejected, never thrown', () => {
    expect(validateCable(pc(), sw(), 'copper-straight', -1).ok).toBe(false);
    expect(validateCable(pc(), sw(), 'copper-straight', Number.NaN).ok).toBe(false);
    expect(validateCable(pc(), sw(), 'copper-straight', Number.POSITIVE_INFINITY).ok).toBe(false);
    // 'coax' is a real media since P0.5; keep testing a name that is not in MEDIA.
    const v = validateCable(pc(), sw(), 'twinax' as MediaType, 1);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('not a cable type');
  });

  it('auto resolves to the correct concrete cable', () => {
    expect(validateCable(pc(), swNoMdix(), 'auto', 3)).toEqual({ ok: true, resolvedMedia: 'copper-straight' });
    expect(validateCable(pc(), pc(), 'auto', 3)).toEqual({ ok: true, resolvedMedia: 'copper-crossover' });
    expect(validateCable(router(), router(), 'auto', 3)).toEqual({ ok: true, resolvedMedia: 'copper-crossover' });
    expect(validateCable(pc(), sw(), 'auto', 3)).toEqual({ ok: true, resolvedMedia: 'copper-straight' });
    expect(validateCable(serial(), serial('R2 Serial0/0/0'), 'auto', 3)).toEqual({ ok: true, resolvedMedia: 'serial' });
    expect(validateCable(console_(), pc(), 'auto', 3)).toEqual({ ok: true, resolvedMedia: 'console' });
  });

  it('auto cannot join different port kinds', () => {
    const v = validateCable(sw(), console_(), 'auto', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('No cable joins an ethernet port (S1 FastEthernet0/1) to a console port (R1 Console)');
    expect(v.resolvedMedia).toBe('copper-straight');
  });

  it('both ends on the same device are flagged', () => {
    const v = validateCable(pc({ device: 'd_1' }), pc({ device: 'd_1', label: 'PC1 GigabitEthernet1' }), 'copper-crossover', 3);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('both ends are on the same device');
    expect(v.resolvedMedia).toBe('copper-crossover');
    expect(validateCable(pc({ device: 'd_1' }), pc({ device: 'd_2' }), 'copper-crossover', 3).ok).toBe(true);
  });

  it('checkCable exposes the problem class and validateCable strips it', () => {
    expect(checkCable(pc(), pc(), 'copper-straight', 3).code).toBe('media-mismatch');
    expect(checkCable(pc(), swNoMdix(), 'copper-straight', 101).code).toBe('too-long');
    expect(checkCable(pc(), sw(), 'nope' as MediaType, 1).code).toBe('unknown-media');
    expect(checkCable(pc(), sw(), 'auto', -3).code).toBe('bad-length');
    expect(checkCable(pc({ device: 'x' }), pc({ device: 'x' }), 'auto', 3).code).toBe('same-device');
    expect(checkCable(pc(), sw(), 'auto', 3).code).toBeUndefined();
    expect(Object.keys(validateCable(pc(), pc(), 'copper-straight', 3)).sort()).toEqual(['ok', 'reason', 'resolvedMedia']);
    expect(Object.keys(validateCable(pc(), sw(), 'auto', 3)).sort()).toEqual(['ok', 'resolvedMedia']);
  });

  it('resolveMedia leaves concrete media alone', () => {
    expect(resolveMedia(pc(), pc(), 'fiber-sm')).toBe('fiber-sm');
    expect(resolveMedia(pc(), pc(), 'auto')).toBe('copper-crossover');
  });

  it('explanations never mention vendor names', () => {
    const all = [
      validateCable(pc(), pc(), 'copper-straight', 3),
      validateCable(console_(), pc(), 'console', 3),
      validateCable(pc(), sw(), 'copper-straight', 500),
      validateCable(pc(), console_(), 'auto', 3),
    ];
    for (const v of all) {
      expect(v.reason ?? '').not.toMatch(/cisco|ios/i);
    }
  });
});

// ── v2: ports that take no cable, radio links, connectors, optics, per-speed limits ──

const SX: TransceiverSpec = { connector: 'lc', mode: 'mm', speedBps: 1_000_000_000, maxLengthM: 550, wavelengthNm: 850 };
const LX: TransceiverSpec = { connector: 'lc', mode: 'sm', speedBps: 1_000_000_000, maxLengthM: 10_000, wavelengthNm: 1310 };
const SR: TransceiverSpec = { connector: 'lc', mode: 'mm', speedBps: 10_000_000_000, maxLengthM: 300, wavelengthNm: 850 };
const cage = (label: string, over: Partial<PortSpecLike> = {}): PortSpecLike => ({ kind: 'ethernet', connector: 'sfp', role: 'routed', label, ...over });
const rj45 = (label: string, over: Partial<PortSpecLike> = {}): PortSpecLike => ({ kind: 'ethernet', connector: 'rj45', wiring: 'MDI', label, ...over });
const radioPort = (label: string, over: Partial<PortSpecLike> = {}): PortSpecLike => ({ kind: 'radio', role: 'radio-ptp', connector: 'antenna', label, ...over });

describe('link/cabling v2 — ports that cannot take a cable', () => {
  it('Wi-Fi radios, cellular radios and virtual interfaces are not cable ports', () => {
    const wl = checkCable({ kind: 'wlan', role: 'wireless-client', label: 'L1 Wlan0' }, pc(), 'auto', 3);
    expect(wl.code).toBe('not-a-cable-port');
    expect(wl.reason).toContain('L1 Wlan0 is a Wi-Fi radio');
    const ce = checkCable(pc(), { kind: 'cellular', role: 'cellular', label: 'P1 Cellular0' }, 'copper-straight', 3);
    expect(ce.code).toBe('not-a-cable-port');
    expect(ce.reason).toContain('P1 Cellular0 is a cellular radio');
    const vl = checkCable({ kind: 'virtual', role: 'svi', label: 'S1 Vlan1' }, pc(), 'auto', 3);
    expect(vl.code).toBe('not-a-cable-port');
    expect(vl.reason).toContain('virtual interface');
    // a non-linkable role on a cable kind is refused too
    const role = checkCable({ kind: 'ethernet', role: 'svi', label: 'X Gi0' }, pc(), 'auto', 3);
    expect(role.code).toBe('not-a-cable-port');
    // same-device is reported before the port rule
    expect(checkCable({ kind: 'wlan', device: 'd', label: 'W' }, pc({ device: 'd' }), 'auto', 3).code).toBe('same-device');
  });
});

describe('link/cabling v2 — point-to-point radio links', () => {
  it('two radio bridge ports pair with auto or radio media', () => {
    expect(validateCable(radioPort('B1 Radio0'), radioPort('B2 Radio0'), 'auto', 10_000)).toEqual({ ok: true, resolvedMedia: 'radio' });
    expect(checkCable(radioPort('B1 Radio0'), radioPort('B2 Radio0'), 'radio', 10_000, { kind: 'radio' })).toEqual({ ok: true, resolvedMedia: 'radio' });
    expect(checkCable(radioPort('B1 Radio0'), radioPort('B2 Radio0'), 'radio', 100_001).code).toBe('too-long');
  });

  it('a radio link needs radio ports at both ends', () => {
    const v = checkCable(radioPort('B1 Radio0'), pc(), 'radio', 10);
    expect(v.code).toBe('radio-needs-radio-port');
    expect(v.reason).toContain('PC1 GigabitEthernet0 is an ethernet port');
    expect(v.resolvedMedia).toBe('radio');
    expect(checkCable(pc(), sw(), 'copper-straight', 10, { kind: 'radio' }).code).toBe('radio-needs-radio-port');
  });

  it('link kind and media must agree; a copper cable does not fit a radio port', () => {
    const kindCable = checkCable(radioPort('B1 Radio0'), radioPort('B2 Radio0'), 'radio', 10, { kind: 'cable' });
    expect(kindCable.code).toBe('media-mismatch');
    expect(kindCable.reason).toContain('not a cable');
    const copper = checkCable(radioPort('B1 Radio0'), radioPort('B2 Radio0'), 'copper-straight', 10);
    expect(copper.code).toBe('media-mismatch');
    expect(copper.reason).toContain('B1 Radio0 is a point-to-point radio port');
  });
});

describe('link/cabling v2 — connectors and optics', () => {
  it('a copper cable into an SFP cage is a connector mismatch', () => {
    const v = checkCable(rj45('R1 Gi0/0/0'), cage('R2 Gi0/0/2'), 'copper-crossover', 3);
    expect(v.code).toBe('connector-mismatch');
    expect(v.reason).toContain('R2 Gi0/0/2 has an SFP cage');
    // P0 ports without connector data keep P0 behaviour
    expect(checkCable(pc(), pc(), 'copper-crossover', 3).ok).toBe(true);
  });

  it('a fibre cable needs a cage or a fibre socket, not an RJ-45 socket', () => {
    const v = checkCable(rj45('R1 Gi0/0/0'), cage('R2 Gi0/0/2', { transceiver: SX }), 'fiber-mm', 3);
    expect(v.code).toBe('connector-mismatch');
    expect(v.reason).toContain('R1 Gi0/0/0 has an RJ-45 socket');
    expect(checkCable({ kind: 'ethernet', connector: 'lc', label: 'A' }, { kind: 'ethernet', connector: 'lc', label: 'B' }, 'fiber-mm', 100).ok).toBe(true);
  });

  it('an empty SFP cage has no transceiver; the connector check comes first', () => {
    const v = checkCable(cage('R1 Gi0/0/2', { transceiver: SX }), cage('R2 Gi0/0/2'), 'fiber-mm', 3);
    expect(v.code).toBe('no-transceiver');
    expect(v.reason).toContain('R2 Gi0/0/2 is an empty SFP cage');
    expect(checkCable(rj45('R1 Gi0/0/0'), cage('R2 Gi0/0/2'), 'fiber-mm', 3).code).toBe('connector-mismatch');
  });

  it('transceiver mode must match the cable, and both ends must share a wavelength', () => {
    const mode = checkCable(cage('A', { transceiver: SX }), cage('B', { transceiver: SX }), 'fiber-sm', 3);
    expect(mode.code).toBe('sfp-mismatch');
    expect(mode.reason).toContain('A holds a multimode transceiver');
    const wave = checkCable(cage('A', { transceiver: SX }), cage('B', { transceiver: { ...SX, wavelengthNm: 1310 } }), 'fiber-mm', 3);
    expect(wave.code).toBe('sfp-mismatch');
    expect(wave.reason).toContain('850 nm');
    expect(wave.reason).toContain('1310 nm');
    expect(checkCable(cage('A', { transceiver: SX }), cage('B', { transceiver: SX }), 'fiber-mm', 500)).toEqual({ ok: true, resolvedMedia: 'fiber-mm' });
  });

  it('auto picks fibre between two cages by transceiver mode', () => {
    expect(resolveMedia(cage('A', { transceiver: LX }), cage('B', { transceiver: LX }), 'auto')).toBe('fiber-sm');
    expect(resolveMedia(cage('A', { transceiver: SX }), cage('B', { transceiver: SX }), 'auto')).toBe('fiber-mm');
    expect(resolveMedia(cage('A'), cage('B'), 'auto')).toBe('fiber-mm');
    // an auto cable between an SFP cage and an RJ-45 port resolves to copper and fails the connector check
    expect(checkCable(rj45('R1 Gi0/0/0'), cage('R2 Gi0/0/2', { transceiver: SX }), 'auto', 3).code).toBe('connector-mismatch');
    // mismatched modes under auto: the cable follows end A, end B's module is refused
    expect(checkCable(cage('A', { transceiver: LX }), cage('B', { transceiver: SX }), 'auto', 3).code).toBe('sfp-mismatch');
  });

  it('media with connector pairings: coax, phone, fibre PON and USB console', () => {
    const coax = (label: string, connector: 'bnc' | 'f-type' | 'rj11'): PortSpecLike => ({ kind: 'coax', connector, label });
    expect(checkCable(coax('H1 Cx0', 'bnc'), coax('H2 Cx0', 'bnc'), 'auto', 150)).toEqual({ ok: true, resolvedMedia: 'coax' });
    const mate = checkCable(coax('H1 Cx0', 'bnc'), coax('M1 Cx0', 'f-type'), 'coax', 10);
    expect(mate.code).toBe('connector-mismatch');
    expect(mate.reason).toContain('do not mate');
    const alien = checkCable(coax('H1 Cx0', 'bnc'), coax('X Cx0', 'rj11'), 'coax', 10);
    expect(alien.code).toBe('connector-mismatch');
    expect(alien.reason).toContain('X Cx0 has an RJ-11 socket');
    // kind defaults supply the connector when a port declares none
    expect(checkCable({ kind: 'phone', label: 'M Ph0' }, { kind: 'phone', label: 'I Ph0' }, 'auto', 4000)).toEqual({ ok: true, resolvedMedia: 'phone' });
    expect(checkCable({ kind: 'fiber-pon', label: 'O Fb0' }, { kind: 'fiber-pon', label: 'I Fb0' }, 'auto', 20_000)).toEqual({ ok: true, resolvedMedia: 'fiber-pon' });
    // USB console: a USB host port to a console port with a mini-USB socket
    const usbHost: PortSpecLike = { kind: 'usb', connector: 'usb', label: 'L1 Usb0' };
    const miniConsole: PortSpecLike = { kind: 'console', connector: 'usb-mini', label: 'R1 Console' };
    expect(validateCable(usbHost, miniConsole, 'auto', 2)).toEqual({ ok: true, resolvedMedia: 'usb-console' });
    // a USB-to-RJ-45 console cable: computer USB plug to an RJ-45 console socket
    expect(checkCable(usbHost, console_(), 'usb-console', 2)).toEqual({ ok: true, resolvedMedia: 'usb-console' });
    expect(checkCable({ ...usbHost, hostTerminal: true }, console_(), 'auto', 2)).toEqual({ ok: true, resolvedMedia: 'usb-console' });
    // the RJ-45 socket is only a device end: two RJ-45 console sockets never mate, and two console lines are refused first
    expect(checkCable(console_(), console_('R2 Console'), 'usb-console', 2).reason).toContain('both ends are device console lines');
    // a USB port of a computer must still reach a USB-type or console socket
    const usbToUsb = checkCable(usbHost, { ...usbHost, label: 'L2 Usb0' }, 'usb-console', 2);
    expect(usbToUsb.code).toBe('media-mismatch');
    expect(usbToUsb.reason).toContain('neither L1 Usb0 nor L2 Usb0 is a console line');
    // thin coax (BNC ↔ BNC) is one 10BASE2 segment: 185 m; the F-type cable plant keeps 500 m
    const thin = checkCable(coax('H1 Cx0', 'bnc'), coax('H2 Cx0', 'bnc'), 'coax', 400);
    expect(thin.code).toBe('too-long');
    expect(thin.reason).toContain('185 m');
    expect(checkCable(coax('H1 Cx0', 'bnc'), coax('H2 Cx0', 'bnc'), 'coax', 185).ok).toBe(true);
    expect(checkCable({ kind: 'coax', label: 'H1 Cx0' }, { kind: 'coax', label: 'H2 Cx0' }, 'auto', 186).code).toBe('too-long');
    expect(checkCable(coax('M1 Cx0', 'f-type'), coax('T1 Cx0', 'f-type'), 'coax', 400).ok).toBe(true);
    expect(checkCable(coax('M1 Cx0', 'f-type'), coax('T1 Cx0', 'f-type'), 'coax', 501).code).toBe('too-long');
  });

  it('length limits follow the negotiated speed and the transceiver reach', () => {
    const at10g = checkCable(cage('A', { transceiver: SR }), cage('B', { transceiver: SR }), 'fiber-mm', 400);
    expect(at10g.code).toBe('too-long');
    expect(at10g.reason).toContain('exceeds the 300 m limit for fiber-mm at 10 Gb/s');
    expect(checkCable(pc(), pc(), 'fiber-mm', 400, { negotiatedBps: 10_000_000_000 }).code).toBe('too-long');
    expect(checkCable(pc(), pc(), 'fiber-mm', 400, { negotiatedBps: 1_000_000_000 }).ok).toBe(true);
    expect(checkCable(pc({ speedBps: 1_000_000_000 }), pc({ speedBps: 10_000_000_000 }), 'fiber-mm', 400).ok).toBe(true);
    const reach = checkCable(cage('A', { transceiver: SX }), cage('B', { transceiver: { ...SX, maxLengthM: 220 } }), 'fiber-mm', 300);
    expect(reach.code).toBe('too-long');
    expect(reach.reason).toContain('exceeds the 220 m reach of the transceiver in B');
  });

  it('v2 explanations stay original', () => {
    const reasons = [
      checkCable({ kind: 'wlan', label: 'W' }, pc(), 'auto', 3),
      checkCable(radioPort('R'), pc(), 'radio', 3),
      checkCable(rj45('A'), cage('B'), 'copper-straight', 3),
      checkCable(cage('A', { transceiver: SX }), cage('B'), 'fiber-mm', 3),
      checkCable(cage('A', { transceiver: SX }), cage('B', { transceiver: LX }), 'fiber-mm', 3),
    ].map((v) => v.reason ?? '');
    for (const r of reasons) {
      expect(r.length).toBeGreaterThan(0);
      expect(r).not.toMatch(/cisco|ios\b|juniper|aruba/i);
    }
  });
});

describe('console cables through the simulation (catalog models, host-shell terminal ends)', () => {
  it('joins a router console to a PC ethernet port or a laptop USB port, never to a switch or another console', async () => {
    const { createSimulation } = await import('../src/sim/simulation.js');
    const { device, topology } = await import('./accept.p05.harness.js');
    const sim = createSimulation({ seed: 1 });
    sim.loadTopology(
      topology(
        [
          device('pc1', 'pc.nfpc', 'PC1', 0, 0),
          device('lap1', 'laptop.nflaptop', 'L1', 10, 0),
          device('r1', 'router.nf2911', 'R1', 20, 0),
          device('r2', 'router.nf2911', 'R2', 30, 0),
          device('s1', 'switch.nfc2960', 'S1', 40, 0),
        ],
        [],
      ),
    );
    const at = (d: string, p: string) => ({ device: d, port: p });
    expect(sim.validateLink({ a: at('r1', 'Console'), b: at('pc1', 'GigabitEthernet0'), media: 'console', lengthM: 2 })).toEqual({ ok: true, resolvedMedia: 'console' });
    expect(sim.validateLink({ a: at('pc1', 'GigabitEthernet0'), b: at('r1', 'Console'), lengthM: 2 })).toEqual({ ok: true, resolvedMedia: 'console' });
    expect(sim.validateLink({ a: at('lap1', 'Usb0'), b: at('r1', 'Console'), media: 'usb-console', lengthM: 2 })).toEqual({ ok: true, resolvedMedia: 'usb-console' });
    expect(sim.validateLink({ a: at('lap1', 'Usb0'), b: at('r1', 'Console'), lengthM: 2 })).toEqual({ ok: true, resolvedMedia: 'usb-console' });
    const both = sim.validateLink({ a: at('r1', 'Console'), b: at('r2', 'Console'), media: 'console', lengthM: 2 });
    expect(both.ok).toBe(false);
    expect(both.reason).toContain('both ends are device console lines');
    expect(sim.validateLink({ a: at('r1', 'Console'), b: at('s1', 'FastEthernet0/1'), media: 'console', lengthM: 2 }).ok).toBe(false);
  });
});
