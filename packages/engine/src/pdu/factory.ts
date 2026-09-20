/**
 * `PduFactory` implementation (spec §4.5) — the ONLY source of `PduId`s.
 *
 * One monotonic counter starting at 1 is shared by `build`, `decode` and `clone`.
 * `onCreate` fires for every new handle (the Simulation uses it to maintain its
 * id → Pdu registry and `SimSnapshot.pduCount`).
 *
 * PINNED INVARIANT (contract): `build` encodes innermost-first via the codecs, then
 * DECODES the resulting bytes — `layers` is always the decoder's view of `bytes`,
 * never the LayerSpec list.
 */
import type { PduId } from '../contracts/ids.js';
import type { SimTime } from '../contracts/time.js';
import type { LayerSpec, Pdu, PduFactory, PduMeta, ProtoName } from '../contracts/pdu.js';
import { decodeLayers, encodeLayers } from './codecs/registry.js';
import { PduImpl } from './pdu.js';

/** Options for `createPduFactory`. */
export interface PduFactoryOptions {
  /** Called once for every PDU the factory creates (build, decode, clone), after construction. */
  onCreate?: (pdu: Pdu) => void;
  /** First id to hand out (default 1). Lets a restored simulation continue its counter. */
  firstId?: PduId;
}

/** A `PduFactory` exposing its counter so the Simulation can report `pduCount`. */
export interface PduFactoryImpl extends PduFactory {
  /** Number of PDUs created so far (`nextId - firstId`). */
  readonly created: number;
  /** Id the next PDU will receive. */
  readonly nextId: PduId;
}

/**
 * Create a factory with its own id counter. Ids are dense: 1, 2, 3, … in creation
 * order, which makes them a deterministic tiebreaker (`inflight` ordering).
 */
export function createPduFactory(opts: PduFactoryOptions = {}): PduFactoryImpl {
  const firstId = opts.firstId ?? 1;
  const onCreate = opts.onCreate;
  let next: PduId = firstId;

  const take = (): PduId => next++;
  const announce = (pdu: Pdu): Pdu => {
    if (onCreate) onCreate(pdu);
    return pdu;
  };

  return {
    get created(): number {
      return next - firstId;
    },
    get nextId(): PduId {
      return next;
    },
    build(layers: readonly LayerSpec[], meta: PduMeta): Pdu {
      if (layers.length === 0) throw new Error('PduFactory.build: at least one layer is required');
      const bytes = encodeLayers(layers);
      const outer: ProtoName = layers[0]!.proto;
      return announce(new PduImpl(take(), bytes, decodeLayers(bytes, outer), meta));
    },
    decode(bytes: Uint8Array, meta: PduMeta, outer: ProtoName = 'ethernet'): Pdu {
      const own = bytes.slice(); // the PDU owns its wire image
      return announce(new PduImpl(take(), own, decodeLayers(own, outer), meta));
    },
    clone(pdu: Pdu, at: SimTime): Pdu {
      return announce(pdu.clone(take(), at));
    },
  };
}
