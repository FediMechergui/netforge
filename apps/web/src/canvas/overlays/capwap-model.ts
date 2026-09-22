/**
 * canvas/overlays/capwap-model.ts — the pure model behind the controller-tunnel (CAPWAP) overlay (ARCHITECTURE-P2 §6):
 * one tunnel arc per lightweight access point and controller it talks to, with the AP's join state as letters
 * Di / Dt / Jn / Cf / Dc / Run (the letters are the non-colour channel; the W6 layer, canvas/capwap.ts, draws the arcs
 * with `airArc`).
 *
 * Reads the AP side's `capwap` rows (§2.6 `CapwapRow`, writer capwap-wtp) and resolves the controller address to the
 * device whose interface holds it. A controller that is not in the world (or has no address yet) leaves `controller`
 * null and the arc is drawn to nowhere (the layer shows the state letters at the AP only).
 *
 * Pure: no Pixi, no store. `deriveDeviceCapwap` depends on one device object only, so the registry memoises it.
 */
import type { CapwapRow, CapwapState, DeviceId, DeviceSnapshot, Ipv4Address, SimSnapshot } from '@netforge/engine';

/** State letters of an access point's join (RFC 5415 states; `dtls` and `data-check` get letters of their own). */
export const CAPWAP_STATE_LETTER: Readonly<Record<CapwapState, string>> = Object.freeze({
  idle: '–',
  discovery: 'Di',
  dtls: 'Dt',
  join: 'Jn',
  configure: 'Cf',
  'data-check': 'Dc',
  run: 'Run',
});

/** Letters of a state (the raw state when unknown). */
export function capwapLetter(state: string): string {
  return Object.prototype.hasOwnProperty.call(CAPWAP_STATE_LETTER, state) ? CAPWAP_STATE_LETTER[state as CapwapState] : state;
}

/** One device's CAPWAP view: the AP-side rows and the IPv4 addresses the device answers on. */
export interface DeviceCapwap {
  /** AP side: one row per controller, in row order. */
  readonly links: readonly CapwapRow[];
  /** Interface addresses (to resolve a controller address to this device). */
  readonly addresses: readonly Ipv4Address[];
}

/** Derive a device's CAPWAP rows and addresses. Pure in the device object. */
export function deriveDeviceCapwap(d: DeviceSnapshot): DeviceCapwap {
  const rows = (d.tables.extra ?? []).find((t) => t.name === 'capwap')?.rows ?? [];
  const links = rows.filter((r) => typeof r.controller === 'string' && typeof r.state === 'string') as unknown as CapwapRow[];
  const addresses: Ipv4Address[] = [];
  for (const p of d.ports) if (p.l3.ipv4 !== undefined) addresses.push(p.l3.ipv4.address);
  return { links, addresses };
}

/** One access point ↔ controller tunnel. */
export interface CapwapTunnelMark {
  readonly ap: DeviceId;
  /** The controller device, or null when the address belongs to no device of the world. */
  readonly controller: DeviceId | null;
  readonly controllerAddress: Ipv4Address;
  readonly state: CapwapState;
  readonly letter: string;
  /** The AP reached `run`: the tunnel carries client traffic. */
  readonly joined: boolean;
  readonly wlans: number;
}

/** The controller-tunnel overlay's render model. */
export interface CapwapOverlayModel {
  readonly tunnels: readonly CapwapTunnelMark[];
}

/** Build the controller-tunnel overlay (devices in snapshot order, rows in row order). */
export function buildCapwapOverlay(
  snapshot: SimSnapshot,
  perDevice: (d: DeviceSnapshot) => DeviceCapwap = deriveDeviceCapwap,
): CapwapOverlayModel {
  const owner = new Map<Ipv4Address, DeviceId>();
  for (const d of snapshot.devices) for (const a of perDevice(d).addresses) if (!owner.has(a)) owner.set(a, d.id);
  const tunnels: CapwapTunnelMark[] = [];
  for (const d of snapshot.devices) {
    for (const row of perDevice(d).links) {
      const controller = owner.get(row.controller);
      tunnels.push({
        ap: d.id,
        controller: controller === undefined || controller === d.id ? null : controller,
        controllerAddress: row.controller,
        state: row.state,
        letter: capwapLetter(row.state),
        joined: row.state === 'run',
        wlans: typeof row.wlans === 'number' ? row.wlans : 0,
      });
    }
  }
  return { tunnels };
}
