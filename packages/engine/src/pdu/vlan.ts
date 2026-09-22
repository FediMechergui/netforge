/**
 * 802.1Q push/pop operations (ARCHITECTURE-P2 D4, §2.3, §3.0 step 12, §3.4).
 *
 * A tag is a structural change, made with `Pdu.rewrap` (through `ctx.rewrap`) and these ops:
 *  • `vlanPushOp(vid, pcp?)` = `{strip: 1, push: [ethernet {}, dot1q {pcp, vid}], as: 'vlan-push'}`;
 *  • `vlanPopOp()`           = `{strip: 2, push: [ethernet {}], as: 'vlan-pop'}`.
 * The ethernet specs are left empty on purpose: with `as` set, `Pdu.rewrap` keeps the frame's own dst/src and moves
 * its type into (or out of) the tag, so the ops do not depend on the frame and one op object serves every copy of a
 * flood. The provenance is exactly `[VlanTagPush, FcsRecompute]` / `[VlanTagPop, FcsRecompute]`, and push then pop
 * returns the original bytes; the PduId never changes.
 *
 * Invariant (D4): a tag exists only on a trunk wire or on the parent port of a router subinterface. Reading a
 * frame's tag (layers[1] is dot1q) belongs to protocols/l2/membership.ts (`isTaggedFrame`, `frameVlanTag`).
 *
 * Pure and allocation-light: the ops are fresh plain objects (callers may keep them), no module state.
 */
import type { RewrapOp } from '../contracts/pdu.js';
import { DOT1Q_VID_MAX } from './codecs/dot1q.js';

/**
 * The rewrap op that tags an untagged Ethernet frame with VLAN `vid` (priority `pcp`, default 0).
 * @throws RangeError when `vid` is not 0–4095 or `pcp` not 0–7
 */
export function vlanPushOp(vid: number, pcp = 0): RewrapOp {
  if (!Number.isInteger(vid) || vid < 0 || vid > DOT1Q_VID_MAX) throw new RangeError(`vlanPushOp: VLAN id must be 0-4095, got ${vid}`);
  if (!Number.isInteger(pcp) || pcp < 0 || pcp > 7) throw new RangeError(`vlanPushOp: priority must be 0-7, got ${pcp}`);
  return {
    strip: 1,
    push: [
      { proto: 'ethernet', fields: {} },
      { proto: 'dot1q', fields: { pcp, vid } },
    ],
    as: 'vlan-push',
  };
}

/** The rewrap op that removes the 802.1Q tag of a tagged Ethernet frame. */
export function vlanPopOp(): RewrapOp {
  return { strip: 2, push: [{ proto: 'ethernet', fields: {} }], as: 'vlan-pop' };
}

