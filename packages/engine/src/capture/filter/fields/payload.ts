/** capture/filter/fields/payload.ts — bytes no decoder claimed (`data`). */
import { protoDisplayFields } from './kit.js';

export const PAYLOAD_DISPLAY_FIELDS = protoDisplayFields({
  help: { payload: 'Bytes no decoder claimed.' },
  protocolAliases: [{ name: 'data', proto: 'payload' }],
});
