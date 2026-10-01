/**
 * sim/defaults-upgrade.ts — "Use current defaults" as a ladder of pure steps (ARCHITECTURE-P3 D2, §2.14; §7 W1 sim;
 * ARCHITECTURE-P2 D2 for the P2 step). Used by the worker's `useCurrentDefaults` (from W2), the goldens and P3b.
 *
 * `upgradeDefaults(t, modelOf, to)` moves an exported world from its profile (`t.profile ?? 'P1'`) up to `to`
 * (default LATEST_DEFAULTS_PROFILE), one step per profile, each step in DEFAULTS_UPGRADE_STEPS:
 *   → P2  every device whose P2 `profileConfig` replays `no ip routing` (a multilayer switch) and whose configuration
 *         has neither an `ip routing` nor a `no ip routing` line of its own gets `ip routing` appended to the
 *         configuration it runs (`runningConfig`, else the startup `config`; the line is written as `runningConfig`),
 *         so a switch that routed in its classic world keeps routing once the P2 default is replayed under it (the
 *         `ip routing` slot stores both forms, P2 §5). A device of a type this build lacks is left alone.
 *   → P3  rewrites no line: the P3 defaults (CDP, and the approved items' timestamps and extended logging) are what a
 *         P3 world simply is.
 * After every step `profile` is the step's profile and `schema = schemaIdFor(t)` in the same step (1.2 for P2, 1.3 for
 * P3). The input is never mutated; a device no step touches keeps its object. A world already at or above `to` is
 * returned as it is: the ladder never lowers a profile. `withCurrentDefaults(t, modelOf)` is the ladder to
 * LATEST_DEFAULTS_PROFILE ('P2' until the W7 course flip), the function the worker carried since P2.
 *
 * An unknown `to`, or a document whose profile is not one of DEFAULTS_PROFILES, throws a RangeError with an original
 * message, before anything is copied.
 */
import { DEFAULTS_PROFILES, LATEST_DEFAULTS_PROFILE, type DefaultsProfile } from '../contracts/catalog.js';
import type { DeviceModel } from '../contracts/device.js';
import { schemaIdFor, type Topology, type TopologyDevice } from '../contracts/topology.js';

/** @since P3 The catalog view the ladder reads: a device type → its model's `profileConfig` (undefined: a type this build lacks). */
export type ProfileConfigOf = (type: string) => Pick<DeviceModel, 'profileConfig'> | undefined;

/** @since P3 One rung of the ladder: the profile it reaches and how it rewrites a device (`undefined` = rewrites none). */
export interface DefaultsUpgradeStep {
  readonly to: Exclude<DefaultsProfile, 'P1'>;
  readonly device?: (d: TopologyDevice, modelOf: ProfileConfigOf) => TopologyDevice;
}

/** The line a routing device must show for IPv4 forwarding to be on, and the P2 default that switches it off. */
const IP_ROUTING_LINE = 'ip routing';
const NO_IP_ROUTING_LINE = 'no ip routing';

/**
 * True when a config text already decides the `ip routing` slot with a line of its own — `ip routing` (it routes)
 * or `no ip routing` (the learner switched routing off in the classic world; it must not route after the move).
 */
function decidesIpRouting(text: string | undefined): boolean {
  if (text === undefined) return false;
  return text.split(/\r?\n/).some((line) => {
    const l = line.trim();
    return l === IP_ROUTING_LINE || l === NO_IP_ROUTING_LINE;
  });
}

/** The P2 step for one device: keep a classic multilayer switch routing (file header). */
function keepIpRouting(d: TopologyDevice, modelOf: ProfileConfigOf): TopologyDevice {
  const replayed = modelOf(d.type)?.profileConfig?.P2 ?? [];
  if (!replayed.some((line) => line.trim() === NO_IP_ROUTING_LINE)) return d;
  const running = d.runningConfig ?? d.config;
  if (decidesIpRouting(running)) return d;
  const base = running === undefined || running === '' ? '' : running.endsWith('\n') ? running : `${running}\n`;
  return { ...d, runningConfig: `${base}${IP_ROUTING_LINE}\n` };
}

/** @since P3 D2 The ladder, one step per profile after P1, in profile order. */
export const DEFAULTS_UPGRADE_STEPS: readonly DefaultsUpgradeStep[] = Object.freeze([
  Object.freeze({ to: 'P2', device: keepIpRouting }),
  Object.freeze({ to: 'P3' }),
] satisfies DefaultsUpgradeStep[]);

/** The rank of a profile in DEFAULTS_PROFILES; throws for anything else. */
function rankOf(profile: unknown, what: string): number {
  const i = DEFAULTS_PROFILES.indexOf(profile as DefaultsProfile);
  if (i < 0) throw new RangeError(`${what} must be one of ${DEFAULTS_PROFILES.join(', ')}, got ${String(profile)}`);
  return i;
}

/** @since P3 D2 Move `t` up the ladder to `to` (file header). Pure. */
export function upgradeDefaults(t: Topology, modelOf: ProfileConfigOf, to: DefaultsProfile = LATEST_DEFAULTS_PROFILE): Topology {
  const target = rankOf(to, 'profile');
  const current = rankOf(t.profile ?? 'P1', 'the document profile');
  if (current >= target) return t;
  let out = t;
  for (const step of DEFAULTS_UPGRADE_STEPS) {
    const rank = rankOf(step.to, 'profile');
    if (rank <= current || rank > target) continue;
    const rewrite = step.device;
    const devices = rewrite === undefined ? out.devices : out.devices.map((d) => rewrite(d, modelOf));
    const next: Topology = { ...out, devices, profile: step.to };
    next.schema = schemaIdFor(next);
    out = next;
  }
  return out;
}

/** @since P3 The ladder to LATEST_DEFAULTS_PROFILE: the worker's "Use current defaults" (D2). Pure. */
export function withCurrentDefaults(t: Topology, modelOf: ProfileConfigOf): Topology {
  return upgradeDefaults(t, modelOf, LATEST_DEFAULTS_PROFILE);
}
