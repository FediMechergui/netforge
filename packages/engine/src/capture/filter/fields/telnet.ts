/** capture/filter/fields/telnet.ts — Telnet display fields ([S13]; ARCHITECTURE-P3 §2.3, §3.14; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const TELNET_DISPLAY_FIELDS = protoDisplayFields({
  help: { telnet: 'Telnet remote terminal (TCP 23): every keystroke and reply, passwords included, crosses the network in the clear.' },
});
