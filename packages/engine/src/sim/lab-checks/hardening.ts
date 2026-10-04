/**
 * sim/lab-checks/hardening.ts — the l2 area's checker adapter: DHCP snooping, dynamic ARP inspection and SSH-only
 * device access (ARCHITECTURE-P3 D5, D13, D14, §2.6, §2.10, §3.4, §3.14, §5.2, §5.3; §0 rules 12 and 20; §7 W3 "ospf,
 * acl, l2, qos, disc, svc, http"). sim/lab-checks/facts.ts wires these entries into FACT_READERS; nothing here is read
 * at module scope (rule 12: the entries are plain data whose `read` reads tables and the running configuration at call
 * time, through the same pure readers the switch's pipeline and the CLI use).
 *
 * Facts, each with its declared type and source (rule 20):
 *   subject = a VLAN (1-4094):
 *   snooping.enabled     boolean  configuration: `ip dhcp snooping` and an `ip dhcp snooping vlan <list>` line naming
 *                                 the VLAN (`dhcpSnoopingActive`, the §4.3 silence row)
 *   dai.enabled          boolean  configuration: an `ip arp inspection vlan <list>` line naming the VLAN
 *                                 (`arpInspectionActive`)
 *   dai.dropped          number   arp-inspection.dropped of the VLAN's row (every inspected ARP the switch dropped);
 *                                 0 before the first inspected ARP writes the row; not set on a device whose model
 *                                 keeps no such table
 *   subject = an interface (long or short name):
 *   snooping.trusted     boolean  configuration: `ip dhcp snooping trust` on the interface
 *   dai.trusted          boolean  configuration: `ip arp inspection trust` on the interface
 *   subject = a host device NAME (or a literal MAC or IPv4 address):
 *   snooping.bindingPort port     dhcp-snooping.port of the first binding (table order) of one of the host's MACs (its
 *                                 base MAC and port MACs) — or of that MAC, or of that address; not set without one.
 *                                 A port fact compares through the device's port names, so 'Fa0/1' and
 *                                 'FastEthernet0/1' are the same answer.
 *   no subject (the device's configuration):
 *   ssh.enabled          boolean  configuration: an RSA key exists (`crypto key generate rsa …` is a stored line, D14)
 *   ssh.version          number   configuration: `ip ssh version <1|2>`; not set without the line
 *   ssh.keyBits          number   configuration: the key's modulus (`rsaModulus`, the size `show ip ssh` reports); not
 *                                 set without a key
 *   vty.transport        string   configuration: `transport input` of the first `line vty` section as stored ('ssh',
 *                                 'telnet', 'ssh telnet', 'all', 'none'); 'ssh telnet' when the line is absent (the
 *                                 effective default, §5.2, in the form the CLI stores both protocols); not set without
 *                                 a `line vty` section
 *   vty.loginLocal       boolean  configuration: `login local` in the first `line vty` section; not set without one
 *   vty.accessClass      string   configuration: the list of `access-class <list> in` in the first `line vty` section
 *                                 (a number as plain decimal text); not set without the line
 * A missing or malformed subject, or a subject the device or the topology does not have, fails the assertion with an
 * original detail.
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import { normalizeMac, parseIpv4, portMac, u32ToIpv4 } from '../../contracts/addr.js';
import type { ConfigNode } from '../../contracts/config.js';
import type { DeviceRuntime } from '../../contracts/device.js';
import type { PortState } from '../../contracts/port.js';
import type { LabFactName } from '../../contracts/scenario.js';
import type { ArpInspectionRow, DhcpSnoopingRow } from '../../contracts/tables.js';
import { configTextLinesOf } from '../../cli/config-text.js';
import { rsaModulus } from '../../cli/handlers/ssh.js';
import { aclListName } from '../../protocols/acl.js';
import { arpInspectionActive, arpInspectionPort, readArpInspection } from '../../protocols/l2/arp-inspection.js';
import { dhcpSnoopingActive, dhcpSnoopingPort, readDhcpSnooping } from '../../protocols/l2/dhcp-snooping.js';
import { deviceNamed, noDevice, noPort, portNamed } from './core.js';
import type { FactContext, FactReader, FactReading } from './facts.js';

/** The VLAN the subject names, or the problem that fails the assertion. */
function subjectVlan(ctx: FactContext, fact: LabFactName): { readonly vlan: number } | { readonly problem: string } {
  if (ctx.subject === undefined) return { problem: `${fact} needs a VLAN as its subject.` };
  const t = ctx.subject.trim();
  const v = /^\d{1,4}$/.test(t) ? Number(t) : Number.NaN;
  if (!(v >= 1 && v <= 4094)) return { problem: `"${ctx.subject}" is not a VLAN (1-4094).` };
  return { vlan: v };
}

/** The interface the subject names, or the problem that fails the assertion. */
function subjectPort(ctx: FactContext, fact: LabFactName): { readonly port: PortState } | { readonly problem: string } {
  if (ctx.subject === undefined) return { problem: `${fact} needs an interface as its subject.` };
  const port = portNamed(ctx.dev, ctx.subject);
  if (port === undefined) return { problem: noPort(ctx.dev.spec.name, ctx.subject).detail ?? '' };
  return { port };
}

/** snooping.enabled (file header). */
function readSnoopingEnabled(ctx: FactContext): FactReading {
  const at = subjectVlan(ctx, 'snooping.enabled');
  if ('problem' in at) return at;
  return { value: dhcpSnoopingActive(readDhcpSnooping(ctx.dev.running), at.vlan) };
}

/** dai.enabled (file header). */
function readDaiEnabled(ctx: FactContext): FactReading {
  const at = subjectVlan(ctx, 'dai.enabled');
  if ('problem' in at) return at;
  return { value: arpInspectionActive(readArpInspection(ctx.dev.running), at.vlan) };
}

/** dai.dropped (file header). */
function readDaiDropped(ctx: FactContext): FactReading {
  const at = subjectVlan(ctx, 'dai.dropped');
  if ('problem' in at) return at;
  const rows = ctx.dev.tables.get<ArpInspectionRow>('arp-inspection')?.rows();
  if (rows === undefined) return { value: undefined };
  return { value: rows.find((r) => r.vlan === at.vlan)?.dropped ?? 0 };
}

/** snooping.trusted (file header). */
function readSnoopingTrusted(ctx: FactContext): FactReading {
  const at = subjectPort(ctx, 'snooping.trusted');
  if ('problem' in at) return at;
  return { value: dhcpSnoopingPort(readDhcpSnooping(ctx.dev.running), at.port.id).trusted };
}

/** dai.trusted (file header). */
function readDaiTrusted(ctx: FactContext): FactReading {
  const at = subjectPort(ctx, 'dai.trusted');
  if ('problem' in at) return at;
  return { value: arpInspectionPort(readArpInspection(ctx.dev.running), at.port.id).trusted };
}

/** The base MAC and every port MAC of `dev`, normalised. */
function macsOf(dev: DeviceRuntime): Set<string> {
  const out = new Set<string>();
  for (const m of [portMac(dev.macBase, 0), ...[...dev.ports.values()].map((p) => p.mac)]) {
    const n = normalizeMac(m);
    if (n !== null) out.add(n);
  }
  return out;
}

/** snooping.bindingPort (file header). */
function readBindingPort(ctx: FactContext): FactReading {
  if (ctx.subject === undefined) return { problem: 'snooping.bindingPort needs a host as its subject.' };
  const subject = ctx.subject.trim();
  let matches: (r: DhcpSnoopingRow) => boolean;
  const host = deviceNamed(ctx.sim, subject);
  const mac = normalizeMac(subject);
  const ip = parseIpv4(subject);
  if (host !== undefined) {
    const macs = macsOf(host);
    matches = (r) => macs.has(normalizeMac(r.mac) ?? r.mac);
  } else if (mac !== null) {
    matches = (r) => normalizeMac(r.mac) === mac;
  } else if (ip !== null) {
    const address = u32ToIpv4(ip);
    matches = (r) => r.ip === address;
  } else {
    return { problem: noDevice(subject).detail ?? '' };
  }
  const row = ctx.dev.tables.get<DhcpSnoopingRow>('dhcp-snooping')?.rows().find(matches);
  return { value: row?.port };
}

/** The global configuration lines of `dev` as token lists (an `ip` group node unfolded), stored negations left out. */
function globalLines(dev: DeviceRuntime): string[][] {
  return configTextLinesOf(dev.running.root)
    .filter((l) => l.context.length === 0 && !l.negate)
    .map((l) => l.tokens);
}

/** ssh.enabled (file header). */
function readSshEnabled(ctx: FactContext): FactReading {
  return { value: rsaModulus({ running: ctx.dev.running }) !== undefined };
}

/** ssh.version (file header). */
function readSshVersion(ctx: FactContext): FactReading {
  const line = globalLines(ctx.dev).find((t) => t.length === 4 && t[0] === 'ip' && t[1] === 'ssh' && t[2] === 'version');
  const v = line?.[3];
  return { value: v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined };
}

/** ssh.keyBits (file header). */
function readSshKeyBits(ctx: FactContext): FactReading {
  return { value: rsaModulus({ running: ctx.dev.running }) };
}

/** The first `line vty …` section of the configuration (file header). */
function firstVtySection(dev: DeviceRuntime): ConfigNode | undefined {
  return dev.running.root.children.find((c) => c.key === 'line' && c.args[0] === 'vty');
}

/** vty.transport (file header). */
function readVtyTransport(ctx: FactContext): FactReading {
  const vty = firstVtySection(ctx.dev);
  if (vty === undefined) return { value: undefined };
  const line = vty.children.find((c) => c.key === 'transport' && c.args[0] === 'input' && c.args.length > 1);
  return { value: line === undefined ? 'ssh telnet' : line.args.slice(1).join(' ') };
}

/** vty.loginLocal (file header). */
function readVtyLoginLocal(ctx: FactContext): FactReading {
  const vty = firstVtySection(ctx.dev);
  if (vty === undefined) return { value: undefined };
  return { value: vty.children.some((c) => c.key === 'login' && c.args.length === 1 && c.args[0] === 'local') };
}

/** vty.accessClass (file header). */
function readVtyAccessClass(ctx: FactContext): FactReading {
  const line = firstVtySection(ctx.dev)?.children.find((c) => c.key === 'access-class' && c.args.length === 2 && c.args[1] === 'in');
  return { value: line === undefined ? undefined : aclListName(line.args[0]!) };
}

/** FACT_READERS entries of the l2 area. */
export const HARDENING_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'snooping.enabled': { type: 'boolean', source: 'configuration: ip dhcp snooping, ip dhcp snooping vlan', read: readSnoopingEnabled },
  'dai.enabled': { type: 'boolean', source: 'configuration: ip arp inspection vlan', read: readDaiEnabled },
  'dai.dropped': { type: 'number', source: 'arp-inspection.dropped', read: readDaiDropped },
  'snooping.trusted': { type: 'boolean', source: 'configuration: interface ip dhcp snooping trust', read: readSnoopingTrusted },
  'dai.trusted': { type: 'boolean', source: 'configuration: interface ip arp inspection trust', read: readDaiTrusted },
  'snooping.bindingPort': { type: 'port', source: 'dhcp-snooping.port', read: readBindingPort },
  'ssh.enabled': { type: 'boolean', source: 'configuration: crypto key generate rsa', read: readSshEnabled },
  'ssh.version': { type: 'number', source: 'configuration: ip ssh version', read: readSshVersion },
  'ssh.keyBits': { type: 'number', source: 'configuration: crypto key generate rsa modulus', read: readSshKeyBits },
  'vty.transport': { type: 'string', source: 'configuration: line vty / transport input', read: readVtyTransport },
  'vty.loginLocal': { type: 'boolean', source: 'configuration: line vty / login local', read: readVtyLoginLocal },
  'vty.accessClass': { type: 'string', source: 'configuration: line vty / access-class', read: readVtyAccessClass },
};
