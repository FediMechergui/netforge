/** capture/filter/fields/dot11-mgmt.ts — 802.11 management bodies (`wlan` names for the network name and BSSID). */
import { protoDisplayFields } from './kit.js';

export const DOT11_MGMT_DISPLAY_FIELDS = protoDisplayFields({
  help: { 'dot11-mgmt': 'IEEE 802.11 management body (beacons, probes, authentication, association).' },
  aliases: [
    { name: 'wlan.ssid', reads: ['dot11-mgmt.ssid'], help: 'Wireless network name (dot11-mgmt.ssid).' },
    { name: 'wlan.bssid', reads: ['dot11-mgmt.bssid'], help: 'Wireless BSSID (dot11-mgmt.bssid).' },
  ],
  values: { 'dot11-mgmt.security': ['open', 'wpa2-psk', 'wpa3-sae', 'wpa2-ent'] },
});
