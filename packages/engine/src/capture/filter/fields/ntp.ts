/** capture/filter/fields/ntp.ts — NTPv4 display fields (RFC 5905; ARCHITECTURE-P3 D19; W2 capture). */
import { protoDisplayFields } from './kit.js';

const REF_IDS = ['LOCL', 'INIT'];

export const NTP_DISPLAY_FIELDS = protoDisplayFields({
  help: { ntp: 'Network Time Protocol version 4 (UDP 123): a client asks a server for the time and measures the delay.' },
  aliases: [
    { name: 'ntp.flags.li', reads: ['ntp.leap'], help: 'Leap indicator; 3 = alarm, the server is not synchronised (ntp.leap).' },
    { name: 'ntp.flags.vn', reads: ['ntp.version'], help: 'NTP version (ntp.version).' },
    { name: 'ntp.flags.mode', reads: ['ntp.mode'], help: 'Mode: 3 client request, 4 server reply (ntp.mode).' },
    { name: 'ntp.ppoll', reads: ['ntp.poll'], help: 'Poll interval as a power of two seconds, e.g. 6 = 64 s (ntp.poll).' },
    { name: 'ntp.rootdelay', reads: ['ntp.rootDelay'], help: 'Round-trip delay to the reference clock, 16.16 fixed point (ntp.rootDelay).' },
    { name: 'ntp.rootdispersion', reads: ['ntp.rootDispersion'], help: 'Dispersion to the reference clock, 16.16 fixed point (ntp.rootDispersion).' },
    { name: 'ntp.refid', reads: ['ntp.refId'], help: 'Reference id: "LOCL" for a local master clock, "INIT" when unsynchronised, else the server address (ntp.refId).' },
    { name: 'ntp.reftime', reads: ['ntp.refTimestamp'], help: 'Time the clock was last set (ntp.refTimestamp).' },
    { name: 'ntp.org', reads: ['ntp.originTimestamp'], help: 'Origin timestamp: the request time the reply echoes (ntp.originTimestamp).' },
    { name: 'ntp.rec', reads: ['ntp.receiveTimestamp'], help: 'Receive timestamp: when the server got the request (ntp.receiveTimestamp).' },
    { name: 'ntp.xmt', reads: ['ntp.transmitTimestamp'], help: 'Transmit timestamp: when the packet left its sender (ntp.transmitTimestamp).' },
  ],
  values: { 'ntp.refId': REF_IDS, 'ntp.refid': REF_IDS },
});
