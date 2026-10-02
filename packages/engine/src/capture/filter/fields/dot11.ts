/** capture/filter/fields/dot11.ts — IEEE 802.11 frames (`wlan` names). */
import { protoDisplayFields } from './kit.js';

export const DOT11_DISPLAY_FIELDS = protoDisplayFields({
  help: { dot11: 'IEEE 802.11 wireless frame.' },
  protocolAliases: [{ name: 'wlan', proto: 'dot11' }],
  aliases: [
    { name: 'wlan.ra', reads: ['dot11.addr1'], help: 'Wireless receiver address (dot11.addr1).' },
    { name: 'wlan.ta', reads: ['dot11.addr2'], help: 'Wireless transmitter address (dot11.addr2).' },
  ],
  values: { 'dot11.frameType': ['mgmt', 'ctrl', 'data'] },
});
