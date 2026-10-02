/**
 * capture/filter/fields/cdp.ts — NF neighbour discovery display fields ("CDP" is a name only: the frame is the
 * original NF format, ARCHITECTURE-P3 D18; W2 capture). Familiar lowercase names for the device and port ids, the
 * native VLAN and the software text; derived: each IPv4 management address the frame lists.
 */
import { derived, derivedField, isDottedIpv4, listEntries, protoDisplayFields } from './kit.js';

export const CDP_DISPLAY_FIELDS = protoDisplayFields({
  help: { cdp: 'Neighbour discovery ("CDP", NetForge format): a router or switch tells each directly connected neighbour its name, port, model and addresses.' },
  aliases: [
    { name: 'cdp.deviceid', reads: ['cdp.deviceId'], help: 'Name of the announcing device (cdp.deviceId).' },
    { name: 'cdp.portid', reads: ['cdp.portId'], help: 'Port the announcement left from (cdp.portId).' },
    { name: 'cdp.native_vlan', reads: ['cdp.nativeVlan'], help: 'Native VLAN of the announcing port; neighbours should agree (cdp.nativeVlan).' },
    { name: 'cdp.software_version', reads: ['cdp.software'], help: 'Software description of the announcing device (cdp.software).' },
  ],
  derived: [
    derivedField('cdp.address', ['cdp.addresses'], 'ipv4', 'An IPv4 management address the announcing device lists.', derived('cdp', (layer) => listEntries(layer, 'addresses', ',').filter(isDottedIpv4))),
  ],
  values: { 'cdp.duplex': ['full', 'half'] },
});
