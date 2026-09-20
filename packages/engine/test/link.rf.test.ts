import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCS_TABLES } from '../src/contracts/rf.js';
import { dbToMdb, divRound, mdbToDb, powerSumMdb, tenLog10Mdb, tenLog10Udb } from '../src/link/rf/log.js';
import {
  canvasDistanceMm,
  connectRssiMdb,
  mmToMetres,
  noiseFloorMdb,
  pairRssi,
  pathLossClassOf,
  pathLossMdb,
  rangeMetres,
  rssiMdb,
  sinrMdb,
} from '../src/link/rf/pathloss.js';
import {
  assessRfLink,
  belowDrop,
  commonGeneration,
  foldPerIntoLossPct,
  mcsRateBps,
  meetsConnect,
  perPermille,
  selectMcs,
  selectMcsWithHysteresis,
  signalBars,
} from '../src/link/rf/mcs.js';
import {
  autoChannel,
  channelScoreMdb,
  channelsOf,
  defaultWidthMhz,
  effectiveWidthMhz,
  interferenceMdb,
  interferersMdb,
  isValidChannel,
  isValidWidth,
  resolveChannel,
  sharesAirtime,
} from '../src/link/rf/channels.js';
import type { ChannelNeighbour } from '../src/link/rf/channels.js';

const AP = { txPowerDbm: 20, antennaGainDbi: 2 };
const STA = { txPowerDbm: 15, antennaGainDbi: 0 };
const N_TABLE = MCS_TABLES.n;

describe('link/rf/log', () => {
  it('pins 10·log10 goldens in milli-dB', () => {
    const cases: [number, number][] = [[1, 0], [2, 3010], [10, 10_000], [1000, 30_000], [12345, 40_915], [40_000, 46_021], [120_000, 50_792], [100_000_000, 80_000]];
    for (const [x, mdb] of cases) expect(tenLog10Mdb(x), `x=${x}`).toBe(mdb);
    expect(tenLog10Udb(2)).toBe(3_010_300);
    expect(tenLog10Udb(0)).toBe(0);
    expect(tenLog10Mdb(2 ** 33)).toBe(99_340);
  });

  it('stays within 0.2 mdB of the float logarithm', () => {
    for (let x = 1; x < 3_000_000; x += 997) {
      expect(Math.abs(tenLog10Udb(x) - 10 * Math.log10(x) * 1e6)).toBeLessThan(200);
    }
  });

  it('is monotone non-decreasing', () => {
    let prev = -1;
    for (let x = 1; x < 70_000; x++) {
      const v = tenLog10Udb(x);
      expect(v >= prev).toBe(true);
      prev = v;
    }
  });

  it('sums powers order-independently with goldens', () => {
    expect(powerSumMdb([-95_000, -95_000])).toBe(-91_990);
    expect(powerSumMdb([-95_000, -90_000])).toBe(-88_807);
    expect(powerSumMdb([-90_000, -95_000])).toBe(-88_807);
    expect(powerSumMdb([-95_000, -95_000, -95_000])).toBe(-90_229);
    expect(powerSumMdb([-60_000, -120_000])).toBe(-60_000);
    expect(powerSumMdb([-70_000])).toBe(-70_000);
    expect(() => powerSumMdb([])).toThrow(RangeError);
    for (let a = -100_000; a <= -40_000; a += 1_373) {
      const exact = 10 * Math.log10(10 ** (a / 10_000) + 10 ** (-90_000 / 10_000)) * 1000;
      expect(Math.abs(powerSumMdb([a, -90_000]) - exact)).toBeLessThanOrEqual(2);
    }
  });

  it('rounds between units', () => {
    expect(divRound(1500, 1000)).toBe(2);
    expect(divRound(-1500, 1000)).toBe(-1);
    expect(mdbToDb(-71_262)).toBe(-71);
    expect(mdbToDb(23_738)).toBe(24);
    expect(dbToMdb(-82)).toBe(-82_000);
  });
});

describe('link/rf/pathloss', () => {
  it('maps modes to path-loss classes', () => {
    expect(pathLossClassOf('ap')).toBe('wifi');
    expect(pathLossClassOf('station')).toBe('wifi');
    expect(pathLossClassOf('ptp')).toBe('ptp');
    expect(pathLossClassOf('tower')).toBe('cell');
    expect(pathLossClassOf('ue')).toBe('cell');
  });

  it('derives integer millimetre distances from canvas units', () => {
    expect(canvasDistanceMm(160, 0, 0.25)).toBe(40_000);
    expect(canvasDistanceMm(480, 0, 0.25)).toBe(120_000);
    expect(canvasDistanceMm(3, 4, 0.25)).toBe(1250);
    expect(canvasDistanceMm(3, 4, 0)).toBe(0);
    expect(mmToMetres(1250)).toBe(1);
    expect(mmToMetres(1500)).toBe(2);
  });

  it('pins path loss goldens per band and class', () => {
    expect(pathLossMdb('2.4', 40_000, 'wifi')).toBe(88_262);
    expect(pathLossMdb('2.4', 120_000, 'wifi')).toBe(102_575);
    expect(pathLossMdb('2.4', 500, 'wifi')).toBe(40_200);
    expect(pathLossMdb('5', 10_000, 'wifi')).toBe(77_300);
    expect(pathLossMdb('5', 10_000_000, 'ptp')).toBe(127_300);
    expect(pathLossMdb('60', 500_000, 'ptp')).toBe(129_479);
    expect(pathLossMdb('60', 1_500_000, 'ptp')).toBe(154_022);
    expect(pathLossMdb('cell', 2_000_000, 'cell')).toBe(153_136);
  });

  it('computes RSSI both ways and decides on the minimum', () => {
    expect(rssiMdb(AP, STA, 88_262)).toBe(-66_262);
    expect(pairRssi(AP, STA, '2.4', 40_000, 'wifi')).toEqual({ pathLossMdb: 88_262, aToBMdb: -66_262, bToAMdb: -71_262, rssiMdb: -71_262 });
  });

  it('selects the noise floor and folds interferers into SINR', () => {
    expect(noiseFloorMdb('2.4', 20)).toBe(-95_000);
    expect(noiseFloorMdb('5', 80)).toBe(-89_000);
    expect(noiseFloorMdb('60', 20)).toBe(-73_000);
    expect(noiseFloorMdb('cell', 160)).toBe(-96_000);
    expect(sinrMdb(-71_262, -95_000)).toBe(23_738);
    expect(sinrMdb(-71_262, -95_000, [-85_000])).toBe(13_324);
  });

  it('pins range goldens and respects the hard cut-off', () => {
    expect(connectRssiMdb('wifi', 5000)).toBe(-82_000);
    expect(connectRssiMdb('ptp', 5000)).toBe(-80_000);
    expect(connectRssiMdb('cell', MCS_TABLES.lte[0]!.minSinrMdb)).toBe(-102_000);
    const r24 = rangeMetres(AP, STA, '2.4', 'wifi', -82_000);
    expect(r24).toBe(91);
    expect(pairRssi(AP, STA, '2.4', 91_000, 'wifi').rssiMdb).toBeGreaterThanOrEqual(-82_000);
    expect(pairRssi(AP, STA, '2.4', 92_000, 'wifi').rssiMdb).toBeLessThan(-82_000);
    expect(rangeMetres(AP, STA, '5', 'wifi', -82_000)).toBe(52);
    const p60 = { txPowerDbm: 10, antennaGainDbi: 38 };
    expect(rangeMetres(p60, p60, '60', 'ptp', -80_000)).toBe(2102);
    expect(rangeMetres(p60, p60, '60', 'ptp', -80_000, 1000)).toBe(1000);
    expect(rangeMetres({ txPowerDbm: -50, antennaGainDbi: 0 }, STA, '2.4', 'wifi', -82_000)).toBe(0);
  });
});

describe('link/rf/mcs', () => {
  it('chooses the best common generation valid on the band', () => {
    expect(commonGeneration('2.4', ['n', 'ac', 'ax'], ['b', 'g', 'n'])).toBe('n');
    expect(commonGeneration('5', ['n', 'ac'], ['n', 'ac', 'ax'])).toBe('ac');
    expect(commonGeneration('2.4', ['ac'], ['ac'])).toBeUndefined();
    expect(commonGeneration('60', ['ad'], ['ad'])).toBe('ad');
    expect(commonGeneration('cell', ['lte'], ['lte'])).toBe('lte');
  });

  it('selects the highest MCS whose threshold is met', () => {
    expect(selectMcs(N_TABLE, 4999)).toBeUndefined();
    expect(selectMcs(N_TABLE, 5000)?.mcs).toBe(0);
    expect(selectMcs(N_TABLE, 23_738)?.mcs).toBe(6);
    expect(selectMcs(MCS_TABLES.lte, -6000)?.mcs).toBe(1);
  });

  it('applies +2 dB upgrade hysteresis and immediate downgrade', () => {
    expect(selectMcsWithHysteresis(N_TABLE, 22_500, 5)?.mcs).toBe(5);
    expect(selectMcsWithHysteresis(N_TABLE, 24_000, 5)?.mcs).toBe(6);
    expect(selectMcsWithHysteresis(N_TABLE, 19_000, 6)?.mcs).toBe(4);
    expect(selectMcsWithHysteresis(N_TABLE, 26_000, 1)?.mcs).toBe(6);
    expect(selectMcsWithHysteresis(N_TABLE, 27_500, 1)?.mcs).toBe(7);
    expect(selectMcsWithHysteresis(N_TABLE, 22_500, undefined)?.mcs).toBe(6);
    expect(selectMcsWithHysteresis(N_TABLE, 22_500, 42)?.mcs).toBe(6);
    expect(selectMcsWithHysteresis(N_TABLE, 1000, 3)).toBeUndefined();
  });

  it('computes rate, PER, bars and folded loss', () => {
    expect(mcsRateBps(N_TABLE[7]!, 40, 2)).toBe(269_100_000);
    expect(mcsRateBps(N_TABLE[0]!, 20, 0)).toBe(6_500_000);
    expect(mcsRateBps(MCS_TABLES.ad[7]!, 2160, 1)).toBe(4_620_000_000);
    const m6 = N_TABLE[6]!;
    expect(perPermille(m6, 22_000)).toBe(100);
    expect(perPermille(m6, 23_738)).toBe(40);
    expect(perPermille(m6, 24_999)).toBe(10);
    expect(perPermille(m6, 25_000)).toBe(0);
    expect(perPermille(undefined, 0)).toBe(1000);
    expect(signalBars(-55_000)).toBe(4);
    expect(signalBars(-55_001)).toBe(3);
    expect(signalBars(-67_000)).toBe(3);
    expect(signalBars(-75_000)).toBe(2);
    expect(signalBars(-82_000)).toBe(1);
    expect(signalBars(-82_001)).toBe(0);
    expect(foldPerIntoLossPct(10, 100)).toBe(19);
    expect(foldPerIntoLossPct(0, 0)).toBe(0);
    expect(foldPerIntoLossPct(0, 1000)).toBe(100);
  });

  it('separates connect and drop thresholds (hold band in between)', () => {
    expect(meetsConnect('wifi', -82_000, 5000, N_TABLE)).toBe(true);
    expect(meetsConnect('wifi', -82_001, 5000, N_TABLE)).toBe(false);
    expect(meetsConnect('wifi', -60_000, 4999, N_TABLE)).toBe(false);
    expect(meetsConnect('ptp', -80_000, 5000, MCS_TABLES.ac)).toBe(true);
    expect(meetsConnect('wifi', -60_000, 30_000, [])).toBe(false);
    expect(belowDrop('wifi', -86_000, 3000, N_TABLE)).toBe(false);
    expect(belowDrop('wifi', -86_001, 3000, N_TABLE)).toBe(true);
    expect(belowDrop('wifi', -70_000, 2999, N_TABLE)).toBe(true);
    expect(belowDrop('ptp', -84_001, 20_000, MCS_TABLES.ac)).toBe(true);
    expect(belowDrop('cell', -200_000, -8000, MCS_TABLES.lte)).toBe(false);
    expect(belowDrop('cell', -90_000, -8001, MCS_TABLES.lte)).toBe(true);
  });

  it('pins full link assessments (Wi-Fi 40 m / 120 m, PtP 5 GHz 10 km, 60 GHz 500 m)', () => {
    const ap = { ...AP, generations: ['n', 'ac', 'ax'] as const, streams: 2 };
    const sta = { ...STA, generations: ['b', 'g', 'n'] as const, streams: 1 };
    const near = assessRfLink({ band: '2.4', cls: 'wifi', widthMhz: 20, distanceMm: 40_000, a: ap, b: sta });
    expect(near).toMatchObject({ generation: 'n', pathLossMdb: 88_262, rssiMdb: -71_262, noiseMdb: -95_000, sinrMdb: 23_738, rateBps: 58_500_000, perPermille: 40, bars: 2, rssiDbm: -71, snrDb: 24, canConnect: true, belowDrop: false });
    expect(near.mcs?.mcs).toBe(6);
    const far = assessRfLink({ band: '2.4', cls: 'wifi', widthMhz: 20, distanceMm: 120_000, a: ap, b: sta, currentMcs: 6 });
    expect(far).toMatchObject({ rssiMdb: -85_575, sinrMdb: 9425, rateBps: 13_000_000, bars: 0, canConnect: false, belowDrop: false });
    expect(far.mcs?.mcs).toBe(1);
    const p5 = { txPowerDbm: 27, antennaGainDbi: 23, generations: ['n', 'ac'] as const, streams: 2 };
    const ptp5 = assessRfLink({ band: '5', cls: 'ptp', widthMhz: 80, distanceMm: 10_000_000, a: p5, b: p5 });
    expect(ptp5).toMatchObject({ generation: 'ac', rssiMdb: -54_300, sinrMdb: 34_700, rateBps: 780_300_000, perPermille: 0, bars: 4 });
    const p60 = { txPowerDbm: 10, antennaGainDbi: 38, generations: ['ad'] as const, streams: 1 };
    const ptp60 = assessRfLink({ band: '60', cls: 'ptp', widthMhz: 20, distanceMm: 500_000, a: p60, b: p60 });
    expect(ptp60).toMatchObject({ generation: 'ad', pathLossMdb: 129_479, rssiMdb: -43_479, noiseMdb: -73_000, sinrMdb: 29_521, rateBps: 4_620_000_000 });
    const none = assessRfLink({ band: '2.4', cls: 'wifi', widthMhz: 20, distanceMm: 1000, a: { ...ap, generations: ['ac'] }, b: { ...sta, generations: ['ac'] } });
    expect(none).toMatchObject({ generation: undefined, mcs: undefined, rateBps: 0, perPermille: 1000, canConnect: false, belowDrop: true });
  });
});

describe('link/rf/channels', () => {
  const n = (channel: number, rssi: number, loaded = true, band: ChannelNeighbour['band'] = '2.4'): ChannelNeighbour => ({ band, channel, rssiMdb: rssi, loaded });

  it('validates channels and widths per band', () => {
    expect(channelsOf('2.4')).toHaveLength(13);
    expect(channelsOf('cell')).toEqual([]);
    expect(isValidChannel('5', 36)).toBe(true);
    expect(isValidChannel('5', 37)).toBe(false);
    expect(isValidChannel('6', 233)).toBe(true);
    expect(isValidChannel('60', 5)).toBe(false);
    expect(defaultWidthMhz('60')).toBe(2160);
    expect(defaultWidthMhz('5')).toBe(20);
    expect(isValidWidth('2.4', 80)).toBe(false);
    expect(effectiveWidthMhz('2.4', 80)).toBe(20);
    expect(effectiveWidthMhz('5', 80)).toBe(80);
    expect(effectiveWidthMhz('60', 20)).toBe(2160);
  });

  it('distinguishes contention, co-channel interference and 2.4 GHz partial overlap', () => {
    expect(sharesAirtime('2.4', 6, n(6, -70_000))).toBe(true);
    expect(sharesAirtime('2.4', 6, n(6, -85_000))).toBe(false);
    expect(sharesAirtime('2.4', 6, n(7, -50_000))).toBe(false);
    expect(interferenceMdb('2.4', 6, n(6, -70_000))).toBeUndefined();
    expect(interferenceMdb('2.4', 6, n(6, -85_000, false))).toBe(-85_000);
    expect(interferenceMdb('2.4', 6, n(8, -60_000))).toBe(-67_000);
    expect(interferenceMdb('2.4', 6, n(10, -40_000))).toBe(-70_000);
    expect(interferenceMdb('2.4', 6, n(8, -60_000, false))).toBeUndefined();
    expect(interferenceMdb('2.4', 6, n(11, -40_000))).toBeUndefined();
    expect(interferenceMdb('5', 36, n(40, -40_000, true, '5'))).toBeUndefined();
    expect(interferenceMdb('5', 36, n(36, -40_000, true, '2.4'))).toBeUndefined();
    expect(interferersMdb('2.4', 6, [n(6, -70_000), n(7, -60_000), n(6, -90_000)])).toEqual([-63_000, -90_000]);
  });

  it('scores and picks the auto channel deterministically', () => {
    expect(autoChannel('2.4', [])).toBe(1);
    expect(autoChannel('5', [])).toBe(36);
    expect(autoChannel('cell', [])).toBeUndefined();
    const busy = [n(1, -60_000), n(6, -70_000), n(11, -65_000, false)];
    expect(autoChannel('2.4', busy)).toBe(12);
    expect(channelScoreMdb('2.4', 6, busy)).toBe(-70_000);
    expect(channelScoreMdb('2.4', 3, busy)).toBe(-66_932);
    expect(channelScoreMdb('2.4', 12, busy)).toBeUndefined();
    const every = channelsOf('2.4').map((c) => n(c, -50_000 - c * 1000));
    expect(autoChannel('2.4', every)).toBe(13);
    const tie = [n(36, -60_000, true, '5'), n(40, -60_000, true, '5')];
    expect(autoChannel('5', tie)).toBe(44);
    const tie5 = channelsOf('5').map((c) => n(c, -60_000, true, '5'));
    expect(autoChannel('5', tie5)).toBe(36);
  });

  it('resolves configured channels', () => {
    expect(resolveChannel('2.4', 'auto', 6, [])).toBe(1);
    expect(resolveChannel('2.4', 11, 6, [])).toBe(11);
    expect(resolveChannel('5', 37, 36, [])).toBe(36);
    expect(resolveChannel('5', 37, 1, [])).toBe(36);
    expect(resolveChannel('cell', 'auto', 0, [])).toBe(0);
    expect(resolveChannel('60', 'auto', 2, [])).toBe(1);
  });
});

describe('link/rf determinism discipline', () => {
  it('uses no banned non-deterministic maths or clocks', () => {
    const dir = fileURLToPath(new URL('../src/link/rf/', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['channels.ts', 'log.ts', 'mcs.ts', 'pathloss.ts']);
    for (const f of files) {
      const src = readFileSync(dir + f, 'utf8');
      expect(src, f).not.toMatch(/Math\.(log10|log2|log|pow|exp|random)\s*\(|Date\.now|performance\.now|new Date\(|setTimeout|[\w)\]]\s*\*\*\s*[\w(]/);
    }
  });
});
