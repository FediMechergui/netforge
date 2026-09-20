import { describe, expect, it } from 'vitest';
import type { Dot11AssocRow } from '../src/contracts/tables.js';
import { MS, SEC } from '../src/contracts/time.js';
import { REASON_HANDSHAKE, REASON_LEAVING } from '../src/protocols/wlan-client.js';
import { echoLayers, modelOf, wifiWorld, withClientLimit } from './wifi.harness.js';
import type { WifiWorld } from './wifi.harness.js';

const R = 'd_r1';
const L = 'd_lap';
const meta = { born: 0, origin: 'd_x' };

type Lines = readonly (readonly [string, readonly string[]])[];

const wlan = (ssid: string, security?: string, passphrase?: string): Lines => {
  const out: [string, string[]][] = [['Wlan0', ['ssid', ssid]]];
  if (security !== undefined) out.push(['Wlan0', ['security', security]]);
  if (passphrase !== undefined) out.push(['Wlan0', ['passphrase', passphrase]]);
  return out;
};

/** Home router at the origin and a laptop 40 m away, booted, run to idle. */
function home(ap: Lines, sta: Lines, seed = 7): WifiWorld {
  const w = wifiWorld({ seed });
  w.addDevice(R, 'wrouter.nfhome', { x: 0, y: 0 }, { lines: ap });
  w.addDevice(L, 'laptop.nflaptop', { x: 160, y: 0 }, { lines: sta });
  w.boot();
  w.runToIdle();
  return w;
}

const states = (w: WifiWorld, device: string): string[] =>
  w.ofKind('assocState').filter((e) => e.station.device === device).map((e) => (e.reason === undefined ? e.state : `${e.state}:${e.reason}`));

const tags = (w: WifiWorld, prefix: string): string[] => w.ofKind('frameTx').map((e) => e.pdu.tag ?? '').filter((t) => t.startsWith(prefix));

const stationState = (w: WifiWorld, device: string): Record<string, unknown> =>
  (w.daemon(device, 'wlan-client').stateSnapshot().state.ports as Record<string, unknown>[])[0]!;

const apClients = (w: WifiWorld, device: string): unknown[] =>
  ((w.daemon(device, 'wlan-ap').stateSnapshot().state.radios as Record<string, unknown>[]).find((r) => r.port === 'Wlan0')!.clients as unknown[]);

describe('Wi-Fi association (wlan-client ↔ air ↔ wlan-ap)', () => {
  it('joins an open network: scan, open authentication, association, authorization without EAPOL', () => {
    const w = home(wlan('LAB'), wlan('LAB'));
    expect(states(w, L)).toEqual(['scanning', 'authenticating', 'associating', 'associated']);
    expect(tags(w, 'eapol')).toEqual([]);
    expect(tags(w, 'probe')).toEqual(['probe-req', 'probe-resp']);
    expect(w.port(L, 'Wlan0').operUp).toBe(true);
    expect(stationState(w, L)).toMatchObject({ state: 'associated', ssid: 'LAB', aid: 1 });
    expect(apClients(w, R)).toEqual([{ station: w.port(L, 'Wlan0').mac, state: 'associated', aid: 1 }]);
    const apRow = w.devices.get(R)!.tables.get!<Dot11AssocRow>('dot11-assoc')!.rows();
    const staRow = w.devices.get(L)!.tables.get!<Dot11AssocRow>('dot11-assoc')!.rows();
    expect(apRow.map((r) => [r.port, r.station, r.state, r.aid])).toEqual([['Wlan0', w.port(L, 'Wlan0').mac, 'associated', 1]]);
    expect(staRow.map((r) => [r.port, r.bssid, r.state, r.ssid])).toEqual([['Wlan0', w.air.radioPortView(w.ref(R, 'Wlan0'))!.bssid, 'associated', 'LAB']]);
    expect(staRow[0]!.rssiDbm).toBe(w.air.associationOf(w.ref(L, 'Wlan0'))!.rssiDbm);
  });

  it('joins a wpa2-psk network through the 4-way handshake and bridges data with rewrap provenance', () => {
    const w = home(wlan('LAB', 'wpa2-psk', 'lab-pass-2024'), wlan('LAB', 'wpa2-psk', 'lab-pass-2024'));
    expect(states(w, L)).toEqual(['scanning', 'authenticating', 'associating', 'handshake', 'associated']);
    expect(tags(w, 'eapol')).toEqual(['eapol-1', 'eapol-2', 'eapol-3', 'eapol-4']);
    const eapolTx = w.ofKind('frameTx').filter((e) => (e.pdu.tag ?? '').startsWith('eapol'));
    expect(eapolTx.map((e) => e.pdu.summary)).toEqual([1, 2, 3, 4].map((n) => `EAPOL key message ${n} of 4`));
    expect(eapolTx.map((e) => e.from.device)).toEqual([R, L, R, L]);
    expect(w.port(L, 'Wlan0').operUp).toBe(true);
    expect(w.received.every((s) => s.pdu.layers[0]!.proto === 'dot11')).toBe(true);
    expect(JSON.stringify(w.events).includes('lab-pass-2024')).toBe(false);

    const lapMac = w.port(L, 'Wlan0').mac;
    const lanMac = w.port(R, 'GigabitEthernet1').mac;
    const up = w.pdus.build(echoLayers(lanMac, lapMac), meta);
    expect(w.send(L, 'Wlan0', up)).toMatchObject({ ok: true });
    const down = w.pdus.build(echoLayers(lapMac, lanMac), meta);
    expect(w.send(R, 'Wlan0', down)).toMatchObject({ ok: true });
    w.runFor(10 * MS);
    const atRouter = w.delivered.find((s) => s.pdu.id === up.id)!;
    const atLaptop = w.delivered.find((s) => s.pdu.id === down.id)!;
    expect([atRouter.device, atLaptop.device]).toEqual([R, L]);
    expect(atRouter.pdu.provenance.map((m) => `${m.device}:${m.reason}:${m.field}`)).toEqual([
      `${L}:Decapsulate:ethernet`, `${L}:Encapsulate:llc`, `${L}:Encapsulate:dot11`,
      `${R}:Decapsulate:dot11`, `${R}:Decapsulate:llc`, `${R}:Encapsulate:ethernet`,
    ]);
    expect(atLaptop.pdu.provenance.map((m) => `${m.device}:${m.reason}:${m.field}`)).toEqual([
      `${R}:Decapsulate:ethernet`, `${R}:Encapsulate:llc`, `${R}:Encapsulate:dot11`,
      `${L}:Decapsulate:dot11`, `${L}:Decapsulate:llc`, `${L}:Encapsulate:ethernet`,
    ]);
  });

  it('fails with wrong-key on a wrong wpa2 passphrase: three attempts, deauth reason 15, no data, then stays failed', () => {
    const w = home(wlan('LAB', 'wpa2-psk', 'right-pass'), wlan('LAB', 'wpa2-psk', 'wrong-pass'));
    expect(stationState(w, L)).toMatchObject({ state: 'failed', reason: 'wrong-key', keyFailures: 3 });
    const deauths = w.ofKind('frameTx').filter((e) => e.pdu.tag === 'deauth');
    expect(deauths).toHaveLength(3);
    expect(tags(w, 'eapol')).toEqual(['eapol-1', 'eapol-2', 'eapol-1', 'eapol-2', 'eapol-1', 'eapol-2']);
    expect(states(w, L).filter((s) => s === 'failed:wrong-key')).toHaveLength(3);
    expect(states(w, L).at(-1)).toBe('failed:wrong-key');
    expect(w.port(L, 'Wlan0').operUp).toBe(false);
    expect(w.delivered).toHaveLength(0);
    expect(apClients(w, R)).toEqual([]);
    for (const tx of deauths) {
      const pdu = w.received.find((s) => s.pdu.id === tx.pdu.id)!.pdu;
      expect(pdu.get('dot11-mgmt.reasonCode')).toBe(REASON_HANDSHAKE);
    }
    const framesBefore = w.ofKind('frameTx').length;
    w.runFor(30 * SEC);
    expect(w.ofKind('frameTx')).toHaveLength(framesBefore);

    w.configure(L, 'Wlan0', ['passphrase', 'right-pass']);
    w.runToIdle();
    expect(stationState(w, L)).toMatchObject({ state: 'associated', keyFailures: 0 });
    expect(w.port(L, 'Wlan0').operUp).toBe(true);
  });

  it('joins a wpa3-sae network with commit and confirm in both directions, and rejects a wrong password at confirm', () => {
    const ok = home(wlan('SAE', 'wpa3-sae', 'dragonfly'), wlan('SAE', 'wpa3-sae', 'dragonfly'));
    expect(states(ok, L)).toEqual(['scanning', 'authenticating', 'associating', 'handshake', 'associated']);
    const sae = ok.ofKind('frameTx').filter((e) => (e.pdu.tag ?? '').startsWith('sae'));
    expect(sae.map((e) => [e.pdu.tag, e.from.device])).toEqual([
      ['sae-commit', L], ['sae-commit', R], ['sae-confirm', L], ['sae-confirm', R],
    ]);
    expect(tags(ok, 'eapol')).toHaveLength(4);

    const bad = home(wlan('SAE', 'wpa3-sae', 'dragonfly'), wlan('SAE', 'wpa3-sae', 'dragon'));
    expect(stationState(bad, L)).toMatchObject({ state: 'failed', reason: 'wrong-key', keyFailures: 3 });
    expect(tags(bad, 'eapol')).toEqual([]);
    const confirms = bad.received.filter((s) => s.device === L && s.pdu.meta.tag === 'sae-confirm');
    expect(confirms).toHaveLength(3);
    for (const c of confirms) expect(c.pdu.get('dot11-mgmt.statusCode')).toBe(1);
    expect(apClients(bad, R)).toEqual([]);
  });

  it('finds no BSS when the security of the network differs from the station configuration', () => {
    const w = home(wlan('LAB', 'wpa3-sae', 'x-pass'), wlan('LAB', 'wpa2-psk', 'x-pass'));
    expect(stationState(w, L)).toMatchObject({ state: 'failed', reason: 'no-bss' });
    expect(tags(w, 'auth')).toEqual([]);
  });

  it('reports no-bss with a periodic rescan, then joins at once when a matching BSS appears (bss-in-range)', () => {
    const w = home(wlan('OTHER'), wlan('LAB'));
    expect(stationState(w, L)).toMatchObject({ state: 'failed', reason: 'no-bss' });
    expect(w.scheduler.size).toBeGreaterThan(0);
    const scans = stationState(w, L).scans;
    w.configure(R, 'Wlan0', ['ssid', 'LAB']);
    expect(w.notifications.filter((n) => n.ev.kind === 'bss-in-range')).toHaveLength(1);
    w.runToIdle();
    expect(stationState(w, L)).toMatchObject({ state: 'associated', ssid: 'LAB' });
    expect(stationState(w, L).scans).toBe((scans as number) + 1);
  });

  it('answers status 17 when the access radio is full', () => {
    const w = wifiWorld({ seed: 3 });
    w.addDevice(R, 'wrouter.nfhome', { x: 0, y: 0 }, { lines: wlan('LAB'), model: withClientLimit(modelOf('wrouter.nfhome'), 'Wlan0', 1) });
    w.addDevice('d_l1', 'laptop.nflaptop', { x: 160, y: 0 }, { lines: wlan('LAB') });
    w.addDevice('d_l2', 'laptop.nflaptop', { x: 0, y: 160 }, { lines: wlan('LAB') });
    w.boot();
    w.runToIdle();
    const final = [stationState(w, 'd_l1'), stationState(w, 'd_l2')].map((s) => `${String(s.state)}:${String(s.reason ?? '')}`).sort();
    expect(final).toEqual(['associated:', 'failed:ap-full']);
    expect(apClients(w, R)).toHaveLength(1);
    const full = w.received.find((s) => s.pdu.meta.tag === 'assoc-resp' && s.pdu.get('dot11-mgmt.statusCode') === 17);
    expect(full).toBeDefined();
  });

  it('survives a short excursion, loses the association after the hold, and reassociates when moved back', () => {
    const w = home(wlan('LAB', 'wpa2-psk', 'walk-pass'), wlan('LAB', 'wpa2-psk', 'walk-pass'));
    expect(w.port(L, 'Wlan0').operUp).toBe(true);
    w.move(L, { x: 1000, y: 0 });
    w.runFor(RF_HOLD_MINUS);
    expect(w.port(L, 'Wlan0').operUp).toBe(true);
    w.runFor(500 * MS);
    expect(w.port(L, 'Wlan0').operUp).toBe(false);
    expect(apClients(w, R)).toEqual([]);
    w.runToIdle();
    expect(stationState(w, L)).toMatchObject({ state: 'failed', reason: 'out-of-range' });
    expect(states(w, L).slice(-2)).toEqual(['scanning:out-of-range', 'failed:out-of-range']);

    w.move(L, { x: 160, y: 0 });
    w.runToIdle();
    expect(stationState(w, L)).toMatchObject({ state: 'associated' });
    expect(w.port(L, 'Wlan0').operUp).toBe(true);
    expect(tags(w, 'eapol')).toHaveLength(8);
    expect(apClients(w, R)).toHaveLength(1);
  });

  it('leaves the network with a disassociation (reason 8) when the SSID is removed', () => {
    const w = home(wlan('LAB'), wlan('LAB'));
    w.configure(L, 'Wlan0', ['ssid'], true);
    w.runToIdle();
    const disassoc = w.received.filter((s) => s.pdu.meta.tag === 'disassoc');
    expect(disassoc.map((s) => [s.device, s.pdu.get('dot11-mgmt.reasonCode')])).toEqual([[R, REASON_LEAVING]]);
    expect(stationState(w, L)).toMatchObject({ state: 'idle' });
    expect(w.port(L, 'Wlan0').operUp).toBe(false);
    expect(apClients(w, R)).toEqual([]);
    expect(w.devices.get(L)!.tables.get!('dot11-assoc')!.size).toBe(0);
    expect(w.devices.get(R)!.tables.get!('dot11-assoc')!.size).toBe(0);
    expect(states(w, L).at(-1)).toBe('idle');
  });

  it('the AP deauthenticates its clients when its network settings change, and they join again', () => {
    const w = home(wlan('LAB', 'wpa2-psk', 'first-pass'), wlan('LAB', 'wpa2-psk', 'first-pass'));
    w.configure(R, 'Wlan0', ['passphrase', 'second-pass']);
    w.configure(L, 'Wlan0', ['passphrase', 'second-pass']);
    w.runToIdle();
    expect(stationState(w, L)).toMatchObject({ state: 'associated' });
    expect(w.ofKind('frameTx').filter((e) => e.pdu.tag === 'deauth' && e.from.device === R)).toHaveLength(1);
  });

  it('sends background beacons only with the beacons line (silence rule)', () => {
    const quiet = home(wlan('LAB'), wlan('LAB'));
    quiet.runFor(SEC);
    expect(quiet.ofKind('frameTx').filter((e) => e.pdu.tag === 'beacon')).toHaveLength(0);

    const w = home([...wlan('LAB'), ['Wlan0', ['beacons']]], wlan('LAB'));
    const start = w.ofKind('frameTx').filter((e) => e.pdu.tag === 'beacon').length;
    w.runFor(350 * MS);
    const beacons = w.ofKind('frameTx').filter((e) => e.pdu.tag === 'beacon').slice(start);
    expect(beacons.length).toBeGreaterThanOrEqual(3);
    expect(beacons.every((e) => e.background === true && e.to.device === L)).toBe(true);
    expect(w.runToIdle()).toBeLessThan(20);
  });

  it('is deterministic: the same seed gives byte-identical traces', () => {
    const run = (): string => {
      const w = home(wlan('LAB', 'wpa2-psk', 'same-pass'), wlan('LAB', 'wpa2-psk', 'same-pass'), 21);
      w.move(L, { x: 1000, y: 0 });
      w.runFor(4 * SEC);
      w.move(L, { x: 160, y: 0 });
      w.runToIdle();
      return JSON.stringify(w.events);
    };
    expect(run()).toBe(run());
  });
});

const RF_HOLD_MINUS = 1_900 * MS;
