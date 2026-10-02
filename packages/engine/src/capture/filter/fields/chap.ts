/** capture/filter/fields/chap.ts — PPP Challenge Handshake Authentication Protocol display fields ([S19]; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const CHAP_DISPLAY_FIELDS = protoDisplayFields({
  help: { chap: 'PPP Challenge Handshake Authentication Protocol: a challenge and an MD5 response prove the shared secret, which never crosses the link.' },
  aliases: [
    { name: 'chap.identifier', reads: ['chap.id'], help: 'Identifier pairing a response with its challenge (chap.id).' },
  ],
});
