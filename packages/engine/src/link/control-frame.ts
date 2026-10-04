/**
 * link/control-frame.ts — what counts as control traffic for QoS (ARCHITECTURE-P3 §9.2 ruling R33, W3 fix step).
 *
 * Control traffic is never queued, classified or counted: HDLC keepalives (protocol 0x8035), PPP control frames (LCP,
 * PAP, CHAP, IPCP, IPV6CP), CDP, LLDP and BPDUs.
 *   • `isQosControlFrame(pdu)` — every class above. The device runtime skips its input and output QoS step for these
 *     frames (no classification, count, marking or policing), and a scheduler port of `link/media/p2p.ts` sends them
 *     ahead of its class queues (they leave next, behind the frame on the wire, and are never tail-dropped).
 *   • `isSerialControlFrame(pdu)` — the serial keepalive and PPP control frames only. The virtual FIFO
 *     (`fifoTransmit`) never refuses one `queue-full` (D23's limit counts it, but admits it), so a congested serial line
 *     never loses its keepalives or LCP echoes to congestion; every other frame keeps D23's refusal byte for byte. No
 *     Ethernet frame is exempt in the FIFO, so P1/P2 Ethernet storms keep their bytes.
 *
 * Pure: reads only the decoded layers' `proto` and `fields`; no state, no clock, no randomness.
 */
import type { PduView } from '../contracts/pdu.js';
import { classifyControl } from '../protocols/l2/control.js';
import { isKeepaliveFrame, isSerialPppControlFrame } from './serial.js';

/** @since P3 (ruling R33) True for an HDLC keepalive or a PPP control frame (LCP, PAP, CHAP, IPCP, IPV6CP). */
export function isSerialControlFrame(pdu: Pick<PduView, 'layers'>): boolean {
  return isKeepaliveFrame(pdu) || isSerialPppControlFrame(pdu);
}

/**
 * @since P3 (ruling R33) True for control traffic QoS never touches: an HDLC keepalive, a PPP control frame, a CDP or
 * LLDP frame, or a BPDU (`classifyControl` 'stp', tagged or not).
 */
export function isQosControlFrame(pdu: Pick<PduView, 'layers'>): boolean {
  const outer = pdu.layers[0];
  if (outer === undefined) return false;
  if (outer.proto === 'hdlc' || outer.proto === 'ppp') return isSerialControlFrame(pdu);
  if (outer.proto !== 'ethernet') return false;
  const cls = classifyControl(pdu);
  return cls === 'stp' || cls === 'cdp' || cls === 'lldp';
}
