/** capture/filter/fields/arp.ts — ARP display fields. */
import { protoDisplayFields } from './kit.js';

export const ARP_DISPLAY_FIELDS = protoDisplayFields({
  help: { arp: 'Address Resolution Protocol.' },
  aliases: [
    { name: 'arp.opcode', reads: ['arp.op'], help: 'ARP operation: 1 request, 2 reply (arp.op).' },
    { name: 'arp.src.hw_mac', reads: ['arp.sha'], help: 'Sender MAC address (arp.sha).' },
    { name: 'arp.src.proto_ipv4', reads: ['arp.spa'], help: 'Sender IPv4 address (arp.spa).' },
    { name: 'arp.dst.hw_mac', reads: ['arp.tha'], help: 'Target MAC address (arp.tha).' },
    { name: 'arp.dst.proto_ipv4', reads: ['arp.tpa'], help: 'Target IPv4 address (arp.tpa).' },
  ],
});
