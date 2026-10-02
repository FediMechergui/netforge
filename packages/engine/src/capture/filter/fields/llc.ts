/** capture/filter/fields/llc.ts — LLC/SNAP (help text only). */
import { protoDisplayFields } from './kit.js';

export const LLC_DISPLAY_FIELDS = protoDisplayFields({
  help: { llc: 'LLC/SNAP header after an 802.11 data header.' },
});
