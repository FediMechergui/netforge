/** capture/filter/fields/pap.ts — PPP Password Authentication Protocol display fields ([S19]; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const PAP_DISPLAY_FIELDS = protoDisplayFields({
  help: { pap: 'PPP Password Authentication Protocol: the peer name and its password cross the link in the clear.' },
  aliases: [
    { name: 'pap.peer_id', reads: ['pap.peerId'], help: 'Name the peer authenticates as (pap.peerId).' },
  ],
});
