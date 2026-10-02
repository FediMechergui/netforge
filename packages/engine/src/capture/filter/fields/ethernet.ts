/** capture/filter/fields/ethernet.ts — Ethernet II display fields (`eth` names). */
import { protoDisplayFields } from './kit.js';

export const ETHERNET_DISPLAY_FIELDS = protoDisplayFields({
  help: { ethernet: 'Ethernet II frame.' },
  protocolAliases: [{ name: 'eth', proto: 'ethernet' }],
  aliases: [
    { name: 'eth.src', reads: ['ethernet.src'], help: 'Source MAC address (ethernet.src).' },
    { name: 'eth.dst', reads: ['ethernet.dst'], help: 'Destination MAC address (ethernet.dst).' },
    { name: 'eth.addr', reads: ['ethernet.src', 'ethernet.dst'], help: 'Either MAC address of the frame.' },
    { name: 'eth.type', reads: ['ethernet.type'], help: 'Ethertype of the payload (ethernet.type).' },
  ],
});
