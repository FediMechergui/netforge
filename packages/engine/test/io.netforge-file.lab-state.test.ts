/**
 * io — the lab state a save of a P3 lab world records (ARCHITECTURE-P3 ruling R58 (b); W7 integration finding #3):
 * `Topology.lab.pendingFaults` and `Topology.lab.errDisabled` travel through both save formats. `canonicalTopology`
 * writes them after the stamp's name and version (a fixed key order, empty lists dropped), and the 1.3 readers keep
 * them, checked by `parseSavedLabState` (`topologyFromJson`, `readNetforge`, and `writeNetforge`'s own re-validation).
 * The topology schema itself still does not read them: `parseTopology` strips them, a 1.0–1.2 document never carries
 * them, and a stamp without them keeps its bytes. (The end-to-end proof — a saved lab file grading as its export — is
 * `accept.p3.lab-document` part 4.)
 */
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TopologyLoadError } from '../src/contracts/simulation.js';
import { SEC } from '../src/contracts/time.js';
import { TOPOLOGY_SCHEMA_ID_1_2, TOPOLOGY_SCHEMA_ID_1_3, schemaIdFor, type Topology } from '../src/contracts/topology.js';
import { NETFORGE_ENTRY, canonicalTopology, readNetforge, topologyFromJson, topologyToJson, writeNetforge } from '../src/io/netforge-file.js';
import { parseTopology } from '../src/io/schema.js';

const manifest = { format: 1 as const, app: 'netforge/0.0.1', created: '2026-10-13T10:00:00.000Z', modified: '2026-10-13T10:00:00.000Z' };

const STAMP = { name: 'ccna3-troubleshoot-eigrp', version: 1 };

/** The recorded lab state, as `exportTopology` of a P3 lab world writes it. */
const PENDING = [
  { at: 50 * SEC, fault: { id: 'f-cut', kind: 'cable-cut' as const, target: { link: 'l1' } } },
  { at: 50 * SEC, fault: { id: 'f-err', kind: 'err-disable' as const, target: { device: 'sw1', port: 'FastEthernet0/1' }, params: { cause: 'bpduguard' } } },
];
const ERR_DISABLED = [{ device: 'sw1', port: 'FastEthernet0/5', cause: 'dhcp-rate-limit' as const }];

/** A small P3 lab save (schema 1.3): one PC, one switch, the lab stamp with its recorded state (`null`: no stamp). */
function p3Save(lab: Topology['lab'] | null = { ...STAMP, pendingFaults: PENDING, errDisabled: ERR_DISABLED }): Topology {
  const t: Topology = {
    schema: TOPOLOGY_SCHEMA_ID_1_3,
    seed: 7,
    devices: [
      { id: 'pc1', type: 'pc.nfpc', name: 'PC1', position: { logical: [1, 2] }, config: 'hostname PC1\n' },
      { id: 'sw1', type: 'switch.nfc2960', name: 'SW1', position: { logical: [3, 4] }, runningConfig: 'hostname SW1\n' },
    ],
    links: [{ id: 'l1', a: { device: 'pc1', port: 'FastEthernet0' }, b: { device: 'sw1', port: 'FastEthernet0/1' }, media: 'copper-straight' }],
    profile: 'P3',
  };
  if (lab !== null) t.lab = lab;
  expect(schemaIdFor(t)).toBe(TOPOLOGY_SCHEMA_ID_1_3);
  return t;
}

describe('io: a P3 lab save keeps its recorded lab state (R58 (b))', () => {
  it('canonicalTopology writes name, version, pendingFaults, errDisabled in that order, each entry in FaultSpec order', () => {
    // the input's keys in a scrambled order: the canonical form fixes them
    const scrambled = {
      errDisabled: [{ cause: 'dhcp-rate-limit' as const, port: 'FastEthernet0/5', device: 'sw1' }],
      pendingFaults: [{ fault: { params: { cause: 'bpduguard' }, target: { port: 'FastEthernet0/1', device: 'sw1' }, kind: 'err-disable' as const, id: 'f-err' }, at: 50 * SEC }],
      version: 1,
      name: STAMP.name,
    };
    const lab = canonicalTopology(p3Save(scrambled)).lab!;
    expect(Object.keys(lab)).toEqual(['name', 'version', 'pendingFaults', 'errDisabled']);
    expect(Object.keys(lab.pendingFaults![0]!)).toEqual(['at', 'fault']);
    expect(Object.keys(lab.pendingFaults![0]!.fault)).toEqual(['id', 'kind', 'target', 'params']);
    expect(Object.keys(lab.pendingFaults![0]!.fault.target)).toEqual(['device', 'port']);
    expect(Object.keys(lab.errDisabled![0]!)).toEqual(['device', 'port', 'cause']);
    expect(lab).toEqual({ ...STAMP, pendingFaults: [PENDING[1]], errDisabled: ERR_DISABLED });
    // a plain-data copy: the input is not shared
    const input = p3Save();
    const out = canonicalTopology(input);
    expect(out.lab!.pendingFaults![1]!.fault.params).not.toBe(input.lab!.pendingFaults![1]!.fault.params);
    expect(out.lab).toEqual(input.lab);
  });

  it('drops empty records and writes a stamp without them exactly as before (name and version only)', () => {
    expect(canonicalTopology(p3Save({ ...STAMP, pendingFaults: [], errDisabled: [] })).lab).toEqual(STAMP);
    expect(Object.keys(canonicalTopology(p3Save({ ...STAMP })).lab!)).toEqual(['name', 'version']);
    expect(topologyToJson(p3Save({ ...STAMP }))).toContain(`"lab": {\n    "name": "${STAMP.name}",\n    "version": 1\n  },`);
  });

  it('plain JSON: topologyToJson → topologyFromJson keeps the record (and parseTopology alone still strips it)', () => {
    const save = p3Save();
    const text = topologyToJson(save);
    expect(text).toContain('"pendingFaults"');
    expect(text).toContain('"errDisabled"');
    const back = topologyFromJson(text);
    expect(back.lab).toEqual(save.lab);
    expect(topologyToJson(back)).toBe(text);
    // the topology schema does not read the two members (loadTopology keeps only the name and version)
    expect(parseTopology(JSON.parse(text)).lab).toEqual(STAMP);
    // a 1.3 save without a stamp, or with a stamp and nothing recorded, reads as before
    expect(topologyFromJson(topologyToJson(p3Save(null))).lab).toBeUndefined();
    expect(topologyFromJson(topologyToJson(p3Save({ ...STAMP }))).lab).toEqual(STAMP);
  });

  it('.netforge: writeNetforge → readNetforge keeps the record inline in topology.json', () => {
    const save = p3Save();
    const bytes = writeNetforge({ manifest, topology: save, configs: {} });
    const topologyJson = JSON.parse(strFromU8(unzipSync(bytes)[NETFORGE_ENTRY.topology]!)) as Topology;
    expect(topologyJson.lab).toEqual(save.lab);
    const back = readNetforge(bytes).topology;
    expect(back.lab).toEqual(save.lab);
    expect(writeNetforge({ manifest, topology: back, configs: {} })).toEqual(bytes);
  });

  it('a 1.0–1.2 document never carries the record: its field set strips it', () => {
    const p2: Topology = { ...p3Save(), profile: 'P2', schema: TOPOLOGY_SCHEMA_ID_1_2 };
    expect(topologyFromJson(topologyToJson(p2)).lab).toEqual(STAMP);
    const archived = readNetforge(writeNetforge({ manifest, topology: p2, configs: {} })).topology;
    expect(archived.lab).toEqual(STAMP);
  });

  it('a malformed record in a 1.3 document is refused with its path, by both readers and by the writer', () => {
    const bad = p3Save({ ...STAMP, pendingFaults: [{ at: -1, fault: PENDING[0]!.fault }] });
    const text = topologyToJson(bad);
    expect(() => topologyFromJson(text)).toThrow(TopologyLoadError);
    expect(() => topologyFromJson(text)).toThrow('lab.pendingFaults[0].at: must be >= 0');
    expect(() => writeNetforge({ manifest, topology: bad, configs: {} })).toThrow('lab.pendingFaults[0].at: must be >= 0');
    const badCause = JSON.parse(topologyToJson(p3Save())) as { lab: { errDisabled: { cause: string }[] } };
    badCause.lab.errDisabled[0]!.cause = 'meltdown';
    expect(() => topologyFromJson(JSON.stringify(badCause))).toThrow('lab.errDisabled[0].cause');
  });
});
