/** capture/filter/fields/ppp.ts — PPP framing display fields ([S19]; ARCHITECTURE-P3 §2.3, §3.9; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const PPP_DISPLAY_FIELDS = protoDisplayFields({
  help: { ppp: 'Point-to-Point Protocol on a serial link, in HDLC-like framing (RFC 1662); ppp.protocol names what it carries.' },
});
