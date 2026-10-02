/** capture/filter/fields/esp.ts — ESP display fields ([C13]; ARCHITECTURE-P3 §2.17, §3.13; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const ESP_DISPLAY_FIELDS = protoDisplayFields({
  help: { esp: 'Encapsulating Security Payload (IP protocol 50): the IPsec header and trailer around a protected packet (simulated encryption).' },
  aliases: [
    { name: 'esp.sequence', reads: ['esp.seq'], help: 'Sequence number of the packet within its security association (esp.seq).' },
    { name: 'esp.pad_len', reads: ['esp.padLength'], help: 'Trailer: number of padding bytes (esp.padLength).' },
    { name: 'esp.protocol', reads: ['esp.nextHeader'], help: 'Trailer: protocol of the protected packet, 4 = IPv4 (esp.nextHeader).' },
  ],
});
