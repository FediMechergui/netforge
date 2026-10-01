/**
 * sim/lab-checks/switching.ts — the P2 switching checkers (ARCHITECTURE-P2 §2.10; ARCHITECTURE-P3 D5, §7 W1 sim: moved
 * VERBATIM from sim/lab-checks.ts, proved by `accept.p3.lab-status`). Devices and ports by NAME; a port name resolves
 * like the 'port' kind (long or short form).
 *
 *   vlan         → existence: VLAN 1 and 1002–1005 always, else a `vlans` row or a `vlan <v>` section (the rule of
 *                  `show vlan`); `name`: the fixed name of an implicit VLAN, else the row's name, else the section's
 *                  `name` line, else `VLAN0010`; `accessPorts`: the ports `show vlan brief` lists for the VLAN (switched
 *                  ports and Port-channels operating as access whose access or voice VLAN is it), compared with
 *                  `match` 'includes' (default: every named port is listed) or 'exactly' (the same set).
 *                  `exists` defaults to true; `exists: false` passes when the VLAN does not exist and checks nothing else.
 *   switchport   → `readSwitchport` on the running config (mode, access/voice/native VLAN), `oper` = 'down' while the
 *                  port is not operationally up, else the operating mode (`operOf` / `channelOperOf` over the dtp
 *                  rows, as the snapshot's `PortL2View.oper`); `allowedVlans` is set equality with the ACTIVE list =
 *                  the allowed list ∩ the VLANs that exist (1, 1002–1005 and the `vlans` rows — the list `show
 *                  interfaces trunk` prints as allowed and existing, so a trunk that allows everything also carries
 *                  1002–1005), read whatever the oper mode. A port that is not a switch port (role other than
 *                  switched / channel) fails.
 *   stp          → the `stp-bridge` row of the VLAN (absent → fails: spanning tree does not run for it): `root` =
 *                  isRoot, `mode`, `rootBridge` = the device (by name) whose own bridge id for that VLAN is this
 *                  row's root id; `port` with `role` / `state` / `edge` reads that port's `stp` row (a port with no
 *                  row takes no part in that VLAN's tree and fails). role/state/edge without `port` fail.
 *   etherchannel → the `etherchannel` rows of the group (none → fails): `protocol` of every member, `up` = the oper
 *                  state of the group's Port-channel, `bundled` = each named member is in state 'bundled' (inclusion,
 *                  other members may be bundled too), `minBundled` = at least that many members bundled.
 *   portSecurity → `enabled`, `violation`, `max` and `stickyMac` from the running config (`readPortSecurity`, the
 *                  reader eth-switch uses); `status` and `minViolations` from the port's `port-security` row.
 *                  `stickyMac` is a MAC in any notation or the NAME of a device (any MAC of its ports matches), so a
 *                  lab never hard-codes a derived MAC. Any field but `enabled` fails while port security is off.
 */
import { normalizeMac } from '../../contracts/addr.js';
import type { ConfigAst, ConfigNode } from '../../contracts/config.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { PortState } from '../../contracts/port.js';
import type { LabAssertion } from '../../contracts/scenario.js';
import type { Simulation } from '../../contracts/simulation.js';
import type { DtpRow, EtherchannelRow, PortSecurityRow, StpBridgeRow, StpPortRow, VlanRow } from '../../contracts/tables.js';
import { IMPLICIT_VLAN_NAMES, defaultVlanName } from '../../cli/handlers/vlan.js';
import { formatVlanList, vlanListIntersect } from '../../core/vlan-list.js';
import { channelOperOf, isImplicitVlan, operOf, type L2OperMode } from '../../protocols/l2/membership.js';
import { readPortSecurity } from '../../protocols/l2/port-security.js';
import { readSwitchport, switchportModeText } from '../../protocols/l2/switchport-config.js';
import { PASS, deviceNamed, fail, noDevice, noPort, portNamed, rowsOf, verdict, type Check } from './core.js';

// ── P2: switching (vlan, switchport, stp, etherchannel, portSecurity) ────────

/** The `vlan <v>` section of a running config, if any (`vlan 10,20` is stored as one section per VLAN). */
function vlanSectionOf(config: ConfigAst, vlan: number): ConfigNode | undefined {
  const text = String(vlan);
  return config.root.children.find((c) => c.key === 'vlan' && c.args.length === 1 && c.args[0] === text);
}

/** The `vlans` row of `vlan`, if the device keeps one. */
function vlanRowOf(dev: DeviceRuntime, vlan: number): VlanRow | undefined {
  return rowsOf<VlanRow>(dev, 'vlans').find((r) => r.vlan === vlan);
}

/** Does VLAN `vlan` exist on `dev`, by the rule `show vlan` uses (implicit, a `vlans` row, or a `vlan` section)? */
function vlanExistsOn(dev: DeviceRuntime, vlan: number): boolean {
  return isImplicitVlan(vlan) || vlanRowOf(dev, vlan) !== undefined || vlanSectionOf(dev.running, vlan) !== undefined;
}

/** The name `show vlan` gives `vlan`: fixed for the implicit VLANs, else the row's, the section's, or `VLAN0010`. */
function vlanNameOn(dev: DeviceRuntime, vlan: number): string {
  const fixed = IMPLICIT_VLAN_NAMES[vlan];
  if (fixed !== undefined) return fixed;
  const row = vlanRowOf(dev, vlan);
  if (row !== undefined && row.name !== '') return row.name;
  const named = vlanSectionOf(dev.running, vlan)?.children.find((c) => c.key === 'name')?.args[0];
  return named !== undefined && named !== '' ? named : defaultVlanName(vlan);
}

/** True for a port that carries switchport lines: a switched Ethernet port or a Port-channel. */
const isSwitchPort = (port: PortState): boolean => port.role === 'switched' || port.role === 'channel';

/** Operating mode of a switch port (as the snapshot's `PortL2View.oper` and `show vlan` derive it). */
function operModeOf(dev: DeviceRuntime, port: PortState): L2OperMode {
  const config = readSwitchport(dev.running, port.id, dev.model);
  const dtp = dev.tables.get<DtpRow>('dtp');
  if (port.role === 'channel') {
    const members = rowsOf<EtherchannelRow>(dev, 'etherchannel').filter((r) => r.bundle === port.id && r.state === 'bundled');
    return channelOperOf(config, members.map((m) => dtp?.get(m.port)));
  }
  return operOf(config, dtp?.get(port.id));
}

/** Canonical ids of the ports `show vlan brief` lists for `vlan`, in port order. */
function accessPortsOf(dev: DeviceRuntime, vlan: number): PortState[] {
  const out: PortState[] = [];
  for (const p of dev.ports.values()) {
    if (!isSwitchPort(p) || operModeOf(dev, p) !== 'access') continue;
    const config = readSwitchport(dev.running, p.id, dev.model);
    if (config.accessVlan === vlan || config.voiceVlan === vlan) out.push(p);
  }
  return out;
}

/** Short names of `ports` for a detail (`Fa0/1, Fa0/2`), or `no port`. */
const portList = (ports: readonly PortState[]): string => (ports.length === 0 ? 'no port' : ports.map((p) => p.spec.short).join(', '));

export function checkVlan(sim: Simulation, a: Extract<LabAssertion, { kind: 'vlan' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const exists = vlanExistsOn(dev, a.vlan);
  if (a.exists === false) return exists ? fail(`VLAN ${a.vlan} still exists on ${a.device}.`) : PASS;
  if (!exists) return fail(`VLAN ${a.vlan} does not exist on ${a.device}.`);
  const problems: string[] = [];
  if (a.name !== undefined) {
    const name = vlanNameOn(dev, a.vlan);
    if (name !== a.name) problems.push(`is named ${name}, expected ${a.name}`);
  }
  if (a.accessPorts !== undefined) {
    const listed = accessPortsOf(dev, a.vlan);
    const listedIds = new Set(listed.map((p) => p.id));
    const wanted: PortState[] = [];
    for (const name of a.accessPorts) {
      const p = portNamed(dev, name);
      if (p === undefined) return noPort(a.device, name);
      if (!wanted.some((w) => w.id === p.id)) wanted.push(p);
    }
    const wantedIds = new Set(wanted.map((p) => p.id));
    const missing = wanted.filter((p) => !listedIds.has(p.id));
    const extra = a.match === 'exactly' ? listed.filter((p) => !wantedIds.has(p.id)) : [];
    if (missing.length > 0 || extra.length > 0) {
      problems.push(`lists ${portList(listed)}, expected ${a.match === 'exactly' ? 'exactly ' : ''}${portList(wanted)}`);
    }
  }
  return verdict(`VLAN ${a.vlan} on ${a.device}`, problems);
}

/** Canonical list of the VLANs that exist on `dev` for trunk purposes: 1, 1002–1005 and its `vlans` rows. */
function existingVlanList(dev: DeviceRuntime): string {
  const ids = [1, 1002, 1003, 1004, 1005];
  for (const r of rowsOf<VlanRow>(dev, 'vlans')) if (!ids.includes(r.vlan)) ids.push(r.vlan);
  return formatVlanList(ids);
}

/** `1,10,20` or `none`. */
const vlanText = (list: string): string => (list === '' ? 'none' : list);

export function checkSwitchport(sim: Simulation, a: Extract<LabAssertion, { kind: 'switchport' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  if (!isSwitchPort(port)) return fail(`${a.device} ${a.port} is not a switch port (its role is ${port.role}).`);
  const config = readSwitchport(dev.running, port.id, dev.model);
  const problems: string[] = [];
  if (a.oper !== undefined) {
    const oper = port.operUp ? operModeOf(dev, port) : 'down';
    if (oper !== a.oper) problems.push(oper === 'down' ? `is down, expected it to operate as ${a.oper}` : `operates as ${oper}, expected ${a.oper}`);
  }
  if (a.mode !== undefined && config.mode !== a.mode) {
    problems.push(`is in mode ${switchportModeText(config.mode)}, expected ${switchportModeText(a.mode)}`);
  }
  if (a.accessVlan !== undefined && config.accessVlan !== a.accessVlan) problems.push(`has access VLAN ${config.accessVlan}, expected ${a.accessVlan}`);
  if (a.voiceVlan !== undefined && config.voiceVlan !== a.voiceVlan) {
    problems.push(`${config.voiceVlan === undefined ? 'has no voice VLAN' : `has voice VLAN ${config.voiceVlan}`}, expected ${a.voiceVlan}`);
  }
  if (a.nativeVlan !== undefined && config.nativeVlan !== a.nativeVlan) problems.push(`has native VLAN ${config.nativeVlan}, expected ${a.nativeVlan}`);
  if (a.allowedVlans !== undefined) {
    const active = vlanListIntersect(config.allowed, existingVlanList(dev));
    const want = formatVlanList(a.allowedVlans);
    if (active !== want) problems.push(`carries VLANs ${vlanText(active)} on its trunk (allowed and existing), expected ${vlanText(want)}`);
  }
  return verdict(`${a.device} ${a.port}`, problems);
}

/** The `stp-bridge` row of `vlan` on `dev`, if its tree runs. */
function stpBridgeOf(dev: DeviceRuntime, vlan: number): StpBridgeRow | undefined {
  return rowsOf<StpBridgeRow>(dev, 'stp-bridge').find((r) => r.vlan === vlan);
}

/** The name of the device whose own bridge id for `vlan` is `bridgeId`, if any. */
function bridgeOwner(sim: Simulation, vlan: number, bridgeId: string): string | undefined {
  for (const d of sim.devices()) if (stpBridgeOf(d, vlan)?.bridgeId === bridgeId) return d.spec.name;
  return undefined;
}

export function checkStp(sim: Simulation, a: Extract<LabAssertion, { kind: 'stp' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const bridge = stpBridgeOf(dev, a.vlan);
  if (bridge === undefined) return fail(`Spanning tree is not running for VLAN ${a.vlan} on ${a.device}.`);
  const rootName = (): string => bridgeOwner(sim, a.vlan, bridge.rootId) ?? bridge.rootId;
  const problems: string[] = [];
  if (a.mode !== undefined && bridge.mode !== a.mode) problems.push(`runs ${bridge.mode}, expected ${a.mode}`);
  if (a.root !== undefined && bridge.isRoot !== a.root) {
    problems.push(a.root ? `is not the root bridge (the root is ${rootName()})` : 'is the root bridge');
  }
  if (a.rootBridge !== undefined) {
    const other = deviceNamed(sim, a.rootBridge);
    if (other === undefined) return noDevice(a.rootBridge);
    const theirs = stpBridgeOf(other, a.vlan);
    if (theirs === undefined) problems.push(`cannot have ${a.rootBridge} as its root: ${a.rootBridge} runs no spanning tree for VLAN ${a.vlan}`);
    else if (theirs.bridgeId !== bridge.rootId) problems.push(`sees ${rootName()} as the root, expected ${a.rootBridge}`);
  }
  if (a.port === undefined) {
    if (a.role !== undefined || a.state !== undefined || a.edge !== undefined) return fail('A spanning-tree role, state or edge check needs the port it is about.');
    return verdict(`${a.device} (VLAN ${a.vlan})`, problems);
  }
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  const row = rowsOf<StpPortRow>(dev, 'stp').find((r) => r.vlan === a.vlan && r.port === port.id);
  if (row === undefined) {
    problems.push(`has no spanning-tree port ${a.port}`);
  } else {
    if (a.role !== undefined && row.role !== a.role) problems.push(`has ${a.port} in role ${row.role}, expected ${a.role}`);
    if (a.state !== undefined && row.state !== a.state) problems.push(`has ${a.port} ${row.state}, expected ${a.state}`);
    if (a.edge !== undefined && row.edge !== a.edge) problems.push(`has ${a.port} ${row.edge ? 'as' : 'not as'} an edge port, expected ${a.edge ? 'an edge port' : 'a non-edge port'}`);
  }
  return verdict(`${a.device} (VLAN ${a.vlan})`, problems);
}

export function checkEtherchannel(sim: Simulation, a: Extract<LabAssertion, { kind: 'etherchannel' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const members = rowsOf<EtherchannelRow>(dev, 'etherchannel').filter((r) => r.group === a.group);
  const first = members[0];
  if (first === undefined) return fail(`${a.device} has no port in channel group ${a.group}.`);
  const problems: string[] = [];
  if (a.protocol !== undefined) {
    const other = members.find((m) => m.protocol !== a.protocol);
    if (other !== undefined) problems.push(`runs ${other.protocol} on ${other.port}, expected ${a.protocol}`);
  }
  if (a.up !== undefined) {
    const up = dev.port(first.bundle)?.operUp === true;
    if (up !== a.up) problems.push(`has ${first.bundle} ${up ? 'up' : 'down'}, expected ${a.up ? 'up' : 'down'}`);
  }
  for (const name of a.bundled ?? []) {
    const port = portNamed(dev, name);
    if (port === undefined) return noPort(a.device, name);
    const row = members.find((m) => m.port === port.id);
    if (row === undefined) problems.push(`has no member ${name}`);
    else if (row.state !== 'bundled') problems.push(`has ${name} ${row.state}${row.reason === undefined ? '' : ` (${row.reason})`}, expected bundled`);
  }
  if (a.minBundled !== undefined) {
    const n = members.filter((m) => m.state === 'bundled').length;
    if (n < a.minBundled) problems.push(`has ${n} bundled member${n === 1 ? '' : 's'}, expected at least ${a.minBundled}`);
  }
  return verdict(`Channel group ${a.group} of ${a.device}`, problems);
}

/** The MACs a `stickyMac` value stands for: one MAC in any notation, or every port MAC of the device so named. */
function macsNamed(sim: Simulation, text: string): readonly string[] | undefined {
  const mac = normalizeMac(text);
  if (mac !== null) return [mac];
  const dev = deviceNamed(sim, text);
  return dev === undefined ? undefined : [...dev.ports.values()].map((p) => p.mac);
}

export function checkPortSecurity(sim: Simulation, a: Extract<LabAssertion, { kind: 'portSecurity' }>): Check {
  const dev = deviceNamed(sim, a.device);
  if (dev === undefined) return noDevice(a.device);
  const port = portNamed(dev, a.port);
  if (port === undefined) return noPort(a.device, a.port);
  const cfg = readPortSecurity(dev.running, port.id);
  const subject = `Port security on ${a.device} ${a.port}`;
  if (a.enabled !== undefined && (cfg !== undefined) !== a.enabled) return fail(`${subject} is ${a.enabled ? 'off' : 'still on'}.`);
  const more = a.status !== undefined || a.violation !== undefined || a.max !== undefined || a.stickyMac !== undefined || a.minViolations !== undefined;
  if (!more) return PASS;
  if (cfg === undefined) return fail(`${subject} is off.`);
  const problems: string[] = [];
  if (a.violation !== undefined && cfg.violation !== a.violation) problems.push(`acts by ${cfg.violation} on a violation, expected ${a.violation}`);
  if (a.max !== undefined && cfg.max !== a.max) problems.push(`allows ${cfg.max} address${cfg.max === 1 ? '' : 'es'}, expected ${a.max}`);
  if (a.stickyMac !== undefined) {
    const macs = macsNamed(sim, a.stickyMac);
    if (macs === undefined) return fail(`${a.stickyMac} is neither a MAC address nor a device of this topology.`);
    if (!macs.some((m) => cfg.stickyMacs.includes(m))) {
      problems.push(`pins ${cfg.stickyMacs.length === 0 ? 'no sticky address' : `only ${cfg.stickyMacs.join(', ')}`}, expected ${a.stickyMac}`);
    }
  }
  if (a.status !== undefined || a.minViolations !== undefined) {
    const row = rowsOf<PortSecurityRow>(dev, 'port-security').find((r) => r.port === port.id);
    if (row === undefined) {
      problems.push('has no port-security state yet');
    } else {
      if (a.status !== undefined && row.status !== a.status) problems.push(`is ${row.status}, expected ${a.status}`);
      if (a.minViolations !== undefined && row.violations < a.minViolations) {
        problems.push(`counted ${row.violations} violation${row.violations === 1 ? '' : 's'}, expected at least ${a.minViolations}`);
      }
    }
  }
  return verdict(subject, problems);
}
