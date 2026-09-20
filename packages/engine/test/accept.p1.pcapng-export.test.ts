/**
 * P1 acceptance — saving a live capture (ARCHITECTURE-P1 §10.2 `accept.p1.pcapng-export`; §4.12, §7;
 * contracts/capture.ts, io/pcap.ts).
 *
 * The file a student hands in must be a real capture file and must not change between two runs of the same lab.
 * A capture of PC1 browsing R1's page is exported and taken apart block by block: the section header with its magic
 * and byte-order mark, one interface block per interface carrying link type 1 and nanosecond timestamp resolution,
 * and one enhanced packet block per record. The same export is produced three times from three separate worlds and
 * compared byte for byte, then read back in and re-exported to show that the file is a fixed point: the rows the
 * imported capture shows are the rows the live one showed, and the bytes are the same bytes.
 *
 * Classic pcap is checked for its nanosecond magic and for the refusal a mixed-link-type capture gets, since the
 * format carries exactly one link type.
 *
 * ponytail: the imported capture is compared through the shared analyser (capture/store.ts), the same object the
 * live capture answers from, so "identical rows" means identical to what the list pane would show.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureRow } from '../src/contracts/capture.js';
import { PCAP_MIXED_LINKTYPE_MESSAGE } from '../src/contracts/capture.js';
import type { Simulation } from '../src/contracts/simulation.js';
import { createCaptureStore } from '../src/capture/store.js';
import {
  PCAPNG_BYTE_ORDER_MAGIC,
  PCAPNG_EPB_TYPE,
  PCAPNG_IDB_TYPE,
  PCAPNG_SHB_TYPE,
  PCAP_MAGIC_NS,
  readCapture,
  writeCapture,
} from '../src/io/pcap.js';
import { pcRouterPc, serialPair } from '../src/sim/scenarios.js';
import { booted } from './sim.harness.js';

const SEED = 5;
const PC1_NIC = { device: 'pc1', port: 'GigabitEthernet0' } as const;
const SERVER_IP = '10.0.0.254';
/** pcapng option code of `if_tsresol` (the interface's timestamp resolution). */
const OPT_IF_TSRESOL = 9;
/** Exponent that means nanoseconds: 10^-9. */
const NANOSECOND_RESOLUTION = 9;

/** A booted PC–router lab where PC1 has browsed R1's page with a capture running on its NIC. */
function browsed(seed = SEED): { sim: Simulation; id: string } {
  const sim = booted(pcRouterPc(), seed);
  const r = sim.configure('r1', ['ip http server']);
  expect(r.lines.filter((l) => !l.ok)).toEqual([]);
  sim.runToIdle();
  const id = sim.startCapture!({ ports: [PC1_NIC], name: 'PC1 NIC' });
  sim.hostRequest!('pc1', { app: 'http.get', url: `http://${SERVER_IP}/` });
  sim.runToIdle();
  expect(sim.captures!().find((c) => c.id === id)!.head).toBeGreaterThan(0);
  return { sim, id };
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Walk the little-endian pcapng blocks of `bytes` as `[type, offset, length]`. */
function blocks(bytes: Uint8Array): [number, number, number][] {
  const v = view(bytes);
  const out: [number, number, number][] = [];
  for (let off = 0; off < bytes.length; ) {
    const len = v.getUint32(off + 4, true);
    expect(len, `block at ${off}`).toBeGreaterThanOrEqual(12);
    out.push([v.getUint32(off, true), off, len]);
    off += len;
  }
  return out;
}

/** The options of the block at `[off, off + len)`, whose body starts `bodyOffset` bytes in. */
function options(bytes: Uint8Array, off: number, len: number, bodyOffset: number): Record<number, number[]> {
  const v = view(bytes);
  const out: Record<number, number[]> = {};
  for (let o = off + bodyOffset; o < off + len - 4; ) {
    const code = v.getUint16(o, true);
    const size = v.getUint16(o + 2, true);
    if (code === 0) break;
    out[code] = [...bytes.subarray(o + 4, o + 4 + size)];
    o += 4 + ((size + 3) & ~3);
  }
  return out;
}

/** Every row of a store, paged the way the list pane pages. */
function rowsOf(query: (from: number) => { rows: CaptureRow[]; next: number }, head: number): CaptureRow[] {
  const out: CaptureRow[] = [];
  for (let from = 0; from < head; ) {
    const page = query(from);
    out.push(...page.rows);
    if (page.next <= from) break;
    from = page.next;
  }
  return out;
}

/** A row without the live-only PDU id, which an imported capture cannot carry. */
function offline(row: CaptureRow): Omit<CaptureRow, 'pdu'> {
  const { pdu: _pdu, ...rest } = row;
  return rest;
}

describe('accept P1: pcapng export of a live capture', () => {
  it('writes a section header with the block magic and the byte-order mark', () => {
    const { sim, id } = browsed();
    const bytes = sim.exportCapture!(id, { format: 'pcapng' });
    const v = view(bytes);
    expect(v.getUint32(0, true)).toBe(PCAPNG_SHB_TYPE);
    expect(PCAPNG_SHB_TYPE).toBe(0x0a0d0d0a);
    expect(v.getUint32(8, true)).toBe(PCAPNG_BYTE_ORDER_MAGIC);
    expect(PCAPNG_BYTE_ORDER_MAGIC).toBe(0x1a2b3c4d);
    // Every block is 4-byte aligned and repeats its length at its end.
    for (const [, off, len] of blocks(bytes)) {
      expect(len % 4).toBe(0);
      expect(v.getUint32(off + len - 4, true)).toBe(len);
    }
  });

  it('writes one interface block of link type 1 with nanosecond timestamp resolution', () => {
    const { sim, id } = browsed();
    const bytes = sim.exportCapture!(id, { format: 'pcapng' });
    const info = sim.captures!().find((c) => c.id === id)!;
    const idbs = blocks(bytes).filter(([t]) => t === PCAPNG_IDB_TYPE);
    expect(idbs.length).toBe(info.interfaces.length);

    const [, off, len] = idbs[0]!;
    expect(view(bytes).getUint16(off + 8, true)).toBe(1); // LINKTYPE_ETHERNET
    const opts = options(bytes, off, len, 16);
    expect(opts[OPT_IF_TSRESOL]).toEqual([NANOSECOND_RESOLUTION]);
    expect(new TextDecoder().decode(Uint8Array.from(opts[2] ?? []))).toBe('PC1 Gi0');
  });

  it('writes one enhanced packet block per record', () => {
    const { sim, id } = browsed();
    const bytes = sim.exportCapture!(id, { format: 'pcapng' });
    const records = sim.captures!().find((c) => c.id === id)!.head;
    expect(blocks(bytes).filter(([t]) => t === PCAPNG_EPB_TYPE).length).toBe(records);
    // The blocks are the section header, the interfaces and then nothing but packets.
    expect(blocks(bytes).map(([t]) => t)).toEqual([PCAPNG_SHB_TYPE, PCAPNG_IDB_TYPE, ...Array<number>(records).fill(PCAPNG_EPB_TYPE)]);
  });

  it('is byte-identical over three runs of the same lab with baseWallNs 0', () => {
    const exports = [1, 2, 3].map(() => {
      const { sim, id } = browsed();
      return sim.exportCapture!(id, { format: 'pcapng', baseWallNs: 0n });
    });
    expect([...exports[1]!]).toEqual([...exports[0]!]);
    expect([...exports[2]!]).toEqual([...exports[0]!]);
    expect(exports[0]!.length).toBeGreaterThan(0);
    // 0 is the engine default, so a caller that passes nothing gets the same file.
    const { sim, id } = browsed();
    expect([...sim.exportCapture!(id, { format: 'pcapng' })]).toEqual([...exports[0]!]);
  });

  it('re-importing the file gives the same rows and writes the same bytes again', () => {
    const { sim, id } = browsed();
    const bytes = sim.exportCapture!(id, { format: 'pcapng', baseWallNs: 0n });
    const info = sim.captures!().find((c) => c.id === id)!;

    const file = readCapture(bytes);
    expect(file.records.length).toBe(info.head);
    expect(file.interfaces).toEqual(info.interfaces.map(({ ref: _ref, ...rest }) => rest));

    const imported = createCaptureStore({ id: 'i_1', name: 'reopened', source: 'import', interfaces: file.interfaces, records: file.records });
    const live = rowsOf((from) => sim.queryCapture!(id, { from, limit: 100 }), info.head);
    const back = rowsOf((from) => imported.query({ from, limit: 100 }), imported.info().head);
    expect(back.map(offline)).toEqual(live.map(offline));

    // The file is a fixed point: writing the imported capture out again gives the same bytes.
    expect([...imported.export({ format: 'pcapng', baseWallNs: 0n })]).toEqual([...bytes]);
    expect([...writeCapture(file, { format: 'pcapng', baseWallNs: 0n })]).toEqual([...bytes]);
  });
});

describe('accept P1: classic pcap export', () => {
  it('uses the nanosecond magic and holds the same records', () => {
    const { sim, id } = browsed();
    const bytes = sim.exportCapture!(id, { format: 'pcap' });
    expect(view(bytes).getUint32(0, true)).toBe(PCAP_MAGIC_NS);
    expect(PCAP_MAGIC_NS).toBe(0xa1b23c4d);
    expect(readCapture(bytes).records.length).toBe(sim.captures!().find((c) => c.id === id)!.head);
  });

  it('refuses a capture that mixes link types, and offers pcapng instead', () => {
    const sim = booted(serialPair(), 4);
    const mixed = sim.startCapture!({
      ports: [
        { device: 'r1', port: 'GigabitEthernet0/0' },
        { device: 'r1', port: 'Serial0/0/0' },
      ],
    });
    expect(sim.captures!().find((c) => c.id === mixed)!.interfaces.map((i) => i.linkType)).toEqual(['ethernet', 'c_hdlc']);
    expect(() => sim.exportCapture!(mixed, { format: 'pcap' })).toThrow(PCAP_MIXED_LINKTYPE_MESSAGE);
    // The message says what to do instead, and pcapng really does write that capture.
    expect(PCAP_MIXED_LINKTYPE_MESSAGE).toContain('pcapng');
    expect(sim.exportCapture!(mixed, { format: 'pcapng' }).length).toBeGreaterThan(0);
  });
});
