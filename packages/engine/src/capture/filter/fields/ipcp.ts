/** capture/filter/fields/ipcp.ts — PPP IPv4 Control Protocol display fields ([S19]; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const IPCP_DISPLAY_FIELDS = protoDisplayFields({
  help: { ipcp: 'PPP IPv4 Control Protocol: the two ends agree to carry IPv4 and exchange their addresses.' },
  aliases: [
    { name: 'ipcp.opt.ip_address', reads: ['ipcp.ipAddress'], help: 'IP address option (ipcp.ipAddress).' },
  ],
});
