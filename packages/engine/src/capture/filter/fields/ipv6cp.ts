/** capture/filter/fields/ipv6cp.ts — PPP IPv6 Control Protocol display fields ([S19]; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const IPV6CP_DISPLAY_FIELDS = protoDisplayFields({
  help: { ipv6cp: 'PPP IPv6 Control Protocol: the two ends agree to carry IPv6 and exchange interface identifiers.' },
  aliases: [
    { name: 'ipv6cp.opt.interface_identifier', reads: ['ipv6cp.interfaceId'], help: 'Interface identifier option, 64 bits in hex (ipv6cp.interfaceId).' },
  ],
});
