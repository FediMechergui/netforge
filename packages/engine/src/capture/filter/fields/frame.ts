/**
 * capture/filter/fields/frame.ts — the `frame` pseudo-protocol: record metadata (number, lengths, relative time,
 * interface, direction, damage). Always first in the registry.
 */
import { def, valuesAccessor, type DisplayFieldAccessor, type DisplayFieldType, type DisplayFilterFrame, type DisplayScalar } from './kit.js';

/** Suggested values of the frame's enumerated text fields. */
export const FRAME_FIELD_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'frame.direction': ['tx', 'rx', 'unknown'],
});

/** The `frame` protocol entry and its fields, in registry order. */
export function frameAccessors(): DisplayFieldAccessor[] {
  const out: DisplayFieldAccessor[] = [];
  const add = (name: string, type: DisplayFieldType, help: string, pick: (frame: DisplayFilterFrame) => DisplayScalar | undefined): void => {
    const d = def(name, [name], type, help);
    out.push(valuesAccessor(d, (frame) => {
      const v = pick(frame);
      return v === undefined ? [] : [v];
    }));
  };
  const frameDef = def('frame', ['frame'], 'protocol', 'Every captured frame.');
  out.push(Object.freeze({
    def: frameDef,
    values: (frame: DisplayFilterFrame) => (frame.bytes === undefined ? [] : [frame.bytes]),
    present: () => true,
  }));
  add('frame.number', 'number', 'Frame number in the capture, starting at 1.', (f) => f.number);
  add('frame.len', 'number', 'Frame length on the wire, in bytes.', (f) => f.len);
  add('frame.cap_len', 'number', 'Bytes captured for this frame.', (f) => (f.bytes === undefined ? f.len : f.bytes.length));
  add('frame.time_relative', 'number', 'Seconds since the first frame of the capture.', (f) => f.timeRelativeNs / 1_000_000_000);
  add('frame.interface', 'number', 'Index of the capture interface that saw the frame.', (f) => f.iface);
  add('frame.interface_name', 'string', 'Name of the capture interface, e.g. "PC1 Gi0".', (f) => f.ifaceName);
  add('frame.direction', 'string', 'Direction at the capture point: "tx", "rx" or "unknown".', (f) => f.dir ?? 'unknown');
  add('frame.corrupted', 'bool', 'The frame was damaged on the medium.', (f) => f.corrupted === true);
  return out;
}
