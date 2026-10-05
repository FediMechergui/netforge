/**
 * device/device.ts — the live device runtime (spec §4.4 device/port/storage model, §4.8 process
 * model, §7.4 startup/running config; ARCHITECTURE "Frame arrival pipeline", "Sending",
 * "Config flow"; ARCHITECTURE-P1 D2, D3, D6, D7, D8, §3.1–§3.3, §3.10, §3.11).
 *
 * Responsibilities:
 *  - ports (D7, D8): built in canonical order — fixed ports (model order), module ports (slot order, ordinal
 *    128 + slot×16 + i), auto virtual interfaces (family order) — with stable MACs
 *    `portMac(deviceMacBase(spec.id, spec.macSalt), ordinal)` (virtual ports use the base MAC, ordinal 0). The
 *    port Map object never changes identity; it is refilled in place when modules or virtual ports change.
 *  - hardware (D7, §3.11): `insertModule` / `removeModule` only while powered off, with checks in the order
 *    slot → module → fit → power → occupancy and the HARDWARE_MESSAGES wording. Modules contribute ports (or a
 *    cage transceiver) and capabilities; the effective capability set adds daemons and tables at the next boot.
 *  - storage: `running` (RAM, a `ConfigAst`, lost on power-off/reload) and `startup` (NVRAM, kept until
 *    `erase startup-config`);
 *  - power/boot: power-on schedules a `boot` event after `model.bootNs`; `onBoot` instantiates the daemons,
 *    builds the demux index, replays the configuration through `applyConfigLine` (cli/config-text replay lines, so
 *    every process receives its `ConfigDelta`s and virtual interfaces are created on the way), calls `init`,
 *    marks the device booted, lets the link model bring the ports up and recomputes virtual oper state;
 *  - the frame pipeline v2 (§3.1): counters → `frameArrivalVerdict` (device/pipeline.ts: admin, receive gate,
 *    err-disabled, role frames trait, collision/fragment, encapsulation, FCS/runt/giant, MAC filter by role, demux
 *    by role and outer layer) → `applyActions`;
 *  - egress (§3.2) by the role's egress trait: `link` → `deps.transmit`; `owner` → `model.portOwners[role]`'s
 *    `onEgress`; `loop` → counted and re-entered through the `ingress` action;
 *  - `applyActions`: depth-first application of process actions with a 1000-action budget per top-level call
 *    (send/deliver/request/drop/consume/timer/cancelTimer/cliOutput/cliDone/setPortL3/log/ingress/medium/event);
 *    `setPortL3` merges per member (`mergePortL3`; undefined keeps, a value replaces, null clears)
 *    and `event` hands a ProcessEvent to the target's `onEvent` depth-first (a missing target is a runtime debug line);
 *  - timers: a `(process,key) → {seq, at}` map; re-arming cancels the previous event and a fired event that no
 *    longer matches the map is ignored;
 *  - config flow: `applyConfigLine` → runtime special cases (virtual interface create/remove, `switchport`
 *    role flips, `encapsulation`, `hostname`, `shutdown`) → AST set/unset → fan the delta out to every process in
 *    daemon order, then apply all collected actions → `configChange` trace → `deps.onPortPhyConfig` for
 *    PHY- and radio-relevant lines;
 *  - virtual interfaces (§3.10): created from `interface Vlan<n>` / `Loopback<n>`, removed by `no interface`,
 *    oper state owned here (never reported to the link model);
 *  - tables (P1): the declared set is cam, arp, rib plus every extra table of the model and of the effective daemons
 *    (PROCESS_TABLES: rib6, nd, sockets, dhcp-bindings, dns-cache, dot11-assoc), reached with `tables.get(name)` and
 *    exported by the snapshot as `tables.extra` in declared order;
 *  - PHY and radio settings rendered from running-config for the link model (`phySettings`, `radioSettings`),
 *    deferred transmit outcomes (`onTxOutcome`) and medium notifications (`onMediumEvent`).
 *
 * P2 (ARCHITECTURE-P2 D2, D6, D12, §2.4, §2.9, §3.0; W1 device):
 *  - defaults profile: `profile` is `spec.profile ?? 'P1'`; at every boot the model's `profileConfig[k]` lines are
 *    replayed for every k with `profileIncludes(profile, k)` (DEFAULTS_PROFILES order), after `defaultConfig` and
 *    before the saved configuration. A P1 world replays nothing new;
 *  - actions `errDisable` / `errRecover` (and the fault path `errDisablePort`): set or clear `PortState.errDisabled`,
 *    `portState` reason `err-disabled` / `err-recovered`, a log line, `deps.onPortAdmin` so the link model recomputes,
 *    then the virtual oper recompute; `shutdown` (setPortAdmin false) clears an err-disable cause;
 *  - action `l2Changed`: `l2.changed` is delivered to every other L2 daemon present, in `L2_PROCESSES` order, each
 *    one's actions applied depth-first before the next is called, then the virtual oper recompute — all inside the
 *    issuing call's action budget;
 *  - action `configLine`: `applyConfigLine` exactly as for a typed line (configChange trace, onConfig fan-out to every
 *    daemon including the issuer);
 *  - pipeline steps 10, 10a, 10b and 12 of P2 run in `frameArrivalVerdict` / `ingressVerdict`.
 *
 * P2 (ARCHITECTURE-P2 D2, D11, D15, §3.0, §3.4, §5; W2 device):
 *  - completeness rule: the device's `DefaultSlots` (`deviceDefaultSlots`: the slots of its default lines D =
 *    `defaultConfig` + `profileConfig`) are computed once and passed to EVERY config apply — the boot replay of D
 *    itself, the saved lines, typed lines, `configLine` actions, `setPortAdmin` — and to the parse of a saved
 *    configuration text, so an explicit `no ip address` under a default slot survives export and reload;
 *  - subinterfaces (`<parent>.<n>`, D11): created by `interface GigabitEthernet0/0.10` (global line, section line or
 *    `ensureVirtualPort`) from `planSubinterface` / `createSubinterfacePortState`; `encapsulation dot1Q <vid>
 *    [native]` is special-cased in `applyConfigLine` (only on a subinterface, `CLI_MESSAGES.encapNotHere` elsewhere;
 *    a VID already carried by a sibling → `CLI_MESSAGES.duplicateVid`) and sets `PortState.dot1q`; step 10a's `subif`
 *    verdict is applied here (pop with `vlanPopOp`, provenance stamped with this device and cause `encapsulation
 *    dot1Q <v>`, mirrored as `mutation` events, counted on the subinterface, then `subinterfaceVerdict`); egress
 *    `parent` counts on the subinterface, pushes the tag unless native and transmits on the parent;
 *  - virtual oper lookups (`VirtualOperLookups`): on a VLAN-aware device (`isVlanAware`) the SVI rule reads the
 *    `vlans`, `etherchannel`, `dtp`, `stp` and `stp-bridge` rows and `readSwitchport`; `bundledMembers` reads the
 *    `etherchannel` rows for Port-channels. Recompute sites: the P1 ones, `l2Changed`, `errDisable`, `errRecover`
 *    and every applied config line whose first token is in `VIRTUAL_RECOMPUTE_KEYS`;
 *  - `setPortL3` merges `virtual4` and [S2] `groups4` like the other members; a drop of a PDU with
 *    `meta.background` carries `background: true` (§2.7).
 *
 * P2 (ARCHITECTURE-P2 §2.4, §2.12, §3.12 step 4; W4 device — wireless):
 *  - action `radio-profile` (capwap-wtp → runtime): stores (`bss: null` clears) the controller profile of radio
 *    `port` — a frozen copy of the BSS list, ordered by `index`, and the pushing controller's name when the action
 *    carries one — then `deps.onPortPhyConfig(port)` so the link model re-reads the radio. A port that is not a
 *    radio (or does not exist) is only a runtime debug line. The profile is RAM: power-off forgets it, and the next
 *    boot renders the local lines until the controller pushes a profile again;
 *  - `radioSettings(port)` is the ONE renderer: the local interface lines, overlaid by the controller profile when
 *    one is stored (`overlayRadioProfile`: BSS 0 supplies `ssid`, `security` and `passphrase`, the whole list is
 *    `bss`, the stored name is `controller`; the radio-level lines band/channel/width/tx-power/beacons/peer-key stay
 *    local). A radio without a profile takes the unchanged P0.5 path, so its settings are byte-identical to before
 *    (the wifi goldens and the P1 digests do not move);
 *  - `ctx.radioSettings(port)` (device/process-ctx.ts) is this same renderer, so wlan-ap and the air medium read
 *    one answer.
 *
 * P3 (ARCHITECTURE-P3 §2.4, §2.7, §2.9, D12, D14, D17, D19, D20, D21; W1 device):
 *  - drop `rule` passthrough: a `drop` action's `rule` is copied onto the trace `drop` event, and every `acl-deny`
 *    drop that names a port counts `PortCounters.aclDenies` there;
 *  - the device clock (D19): a `DeviceClockBase` (process-ctx.ts) — unset (2020-01-01 plus uptime) on a network device,
 *    true time on a host — read by `clockView(now)`, `ctx.clock()` and (through the CLI) `CommandCtx.clock()`, with the
 *    `clock timezone` line's zone; the `clock` action (and `setClock`) rebases it and emits one `ntp` transition debug
 *    event (category `ntp events`) when the synchronised state (source `ntp` or `master`) changes; power-off forgets it;
 *  - the `configure` action (D21) only schedules SimEvent `deviceConfigure` at now through `deps.scheduler` (zero delay,
 *    non-periodic): the Simulation is its one caller; `applyConfigLine(context, line, negate, origin?)` copies `origin`
 *    into every `configChange` event of that line (the removal lines of `no interface` and the address withdrawal of a
 *    role flip included);
 *  - [S13] the `remoteCli` and `cliRemote` actions only schedule SimEvent `remoteCli` at now (D14);
 *  - [S18] the `virtualChanged` action recomputes virtual oper state; the tunnel rule reads the tunnel owner's
 *    `tunnels` row (`VirtualOperLookups.tunnelState`); a send on a tunnel port goes to the owner (`gre`) like any owner
 *    egress;
 *  - [S24] `emitLog` is the one log path (D20): every runtime log site and the `log` action emit the unchanged `log`
 *    trace event (a `mnemonic` only when a P3 caller passes one) and, when the model runs `logger`, deliver
 *    `log.record` to it — depth-first inside the issuer's budget for the `log` action, as its own application for the
 *    runtime's direct sites;
 *  - [S32] the hosts' `files:` store: a flat, persistent store on devices with `host` (it survives power-off, like a
 *    disk), changed only by the `storage` action, read by `ctx.files` / `ctx.readFile` and `files` / `readFile`.
 *
 * P3 (ARCHITECTURE-P3 D17, D18, D20, §3.0 (b), §3.7, §3.9; rulings R4, R20; W2 device):
 *  - the control check on a routed port before step 10a (device/pipeline.ts `routedControlVerdict`): the runtime passes
 *    its running daemons, so a `cdp` or `lldp` frame is delivered to its daemon on the physical port;
 *  - [S19] `encapsulation ppp` is accepted on a router's serial WAN port (the P1 refusal is removed); a serial access
 *    line (NF-CSU-DSU, NF-INTERNET) stays HDLC-only (`DEVICE_CONFIG_MESSAGES.pppAccessLine`, a listed deviation). PPP
 *    framing and its receive gate live in device/pipeline.ts;
 *  - [S25] the extended-logging default of a P3 world (D2, D20; never in a P1 or P2 world), on the models that take it
 *    (`extendedLoggingModel`: routers and managed switches with the NF-OS CLI, the controller), through `emitLog`: on a
 *    port's oper change a link log (`LINK`, severity 3, mnemonic `UPDOWN`; physical ports, when the carrier changed and
 *    not for an administrative shutdown, which the P1 admin log already reports) and a line-protocol log (`LINEPROTO`,
 *    severity 5, `UPDOWN`; every port, once per change); at boot completion a start log (`SYS`, 5, `BOOTED`); and a
 *    configuration log (`SYS`, 5, `CONFIGURED`) for a typed line or a configure-seam line that changed the running
 *    configuration, once per source (the console, or the configure origin) and dispatch instant — never for the boot
 *    replay or a daemon's `configLine` action;
 *  - ruling R20: the `storage` action enforces the io limits of a `files:` store (`MAX_TOPOLOGY_FILES_PER_DEVICE` files,
 *    `MAX_TOPOLOGY_FILE_NAME_CHARS`-character names, `MAX_TOPOLOGY_FILE_CHARS` characters per file; io/schema.ts), so
 *    every file a host holds survives export and reload (`storageWriteProblem`).
 *
 * P3 (ARCHITECTURE-P3 D16, §3.0 (a) step 9 and (b) step 10c, §3.5, §3.11; rulings R26; W3 device) — QoS in the runtime:
 *  - the policy cache: one compiled policy per (port, direction) (`qos/config.ts` `compileQosPolicy`), tagged with the
 *    QoS configuration generation (`qosGen`: +1 for every `isQosConfigDelta` delta — class-map, policy-map,
 *    access-list, ip access-list, the interface service-policy / bandwidth / fair-queue lines — and at power-off) and
 *    the port version; a lookup whose tag is stale recompiles, so an edit of a class-map or of its ACL reaches the next
 *    frame. Only routed physical ports, serial WAN ports and subinterfaces apply a policy (`QOS_POLICY_ROLES`). A port
 *    without a `service-policy` line costs one map lookup per frame and its frames take the P2 path byte for byte;
 *  - step 10c (input): on a `deliver` verdict with the port's own input policy, on a `subif` verdict with the
 *    subinterface's — before the tag pop, so `match cos` sees the PCP, and only when the subinterface's previewed verdict
 *    delivers (`poppedFrameView`), so a frame the pipeline drops (flooded unicast for another MAC, a BPDU, a control
 *    frame) is never classified or counted: classify, count matched (and marked), mark with `Pdu.mutate(…, 'QosMark',
 *    'policy-map P class C set …')` (each rewrite followed by its derived ChecksumRecompute / FcsRecompute records, all
 *    mirrored as `mutation` events), then [S21] police after the marking (`police … conform-action … exceed-action …`;
 *    a drop is `policed` with the class's detail and counts inDrops; `set-dscp-transmit` rewrites the DSCP, `QosMark`);
 *  - output marking: a routed physical port's output policy in `transmitOn` before `deps.transmit` (every frame the
 *    port sends, a subinterface's included), a subinterface's right after `vlanPush` keyed by the subinterface, so
 *    `set cos` writes the pushed tag's PCP; [S21] an output policer drop counts outDrops on the port it policed;
 *  - `qosCounters(port)`: the per-class matched / marked counts (display only) and [S21] (R26) the conform / exceed
 *    counts of every policer the runtime runs;
 *  - ruling R33 (W3 fix): control traffic (`isQosControlFrame`: HDLC keepalives, PPP control frames, CDP, LLDP and
 *    BPDUs) is never classified, counted, marked or policed by an input or output policy, and gets no `{qosClass}`;
 *  - [S20]/[S21]: `egressPolicy(port)` compiles a physical port's scheduler spec (`compileEgressScheduler`: an output
 *    policy with a queueing action within the 75 % admission, else interface `fair-queue`); `transmitOn` passes the
 *    frame's class as `{qosClass}` on a scheduler port (and only there: every other port keeps the three-argument call);
 *    `service-policy output` and `fair-queue` are PHY lines of physical ports (`isSchedulerPhyLine`), and any QoS delta
 *    that changes a port's spec tells the link model (`onPortPhyConfig`). An output policer the spec carries (a
 *    transmit/drop pair, `qosPoliceInScheduler`) is the link scheduler's; every other one is the runtime's.
 *
 * Power-off semantics (RAM is lost, NVRAM survives): every daemon's `onShutdown` runs first (its actions apply while the
 * ports are still up; P1), then tables are cleared (declared order), processes and timers
 * dropped, virtual interfaces other than the auto ones removed, roles/encapsulations/admin state/counters/L3
 * state reset to the factory defaults and the running-config reset to hostname = spec.name plus one interface
 * section per configurable port (`shutdown` when it defaults down). Installed modules are hardware and stay.
 *
 * `now` inside the runtime is the `at` of the event being dispatched (never a wall clock); device-level
 * operations that take no time argument (`applyConfigLine`, `saveConfig`) use the most recent dispatched time.
 * Iteration that affects behaviour runs over the port Map (canonical order) and the daemon order array.
 */
import { deviceMacBase } from '../contracts/addr.js';
import {
  DEFAULTS_PROFILES,
  HARDWARE_MESSAGES,
  L2_PROCESSES,
  PROCESS_ORDER,
  ROLE_KINDS,
  ROLE_TRAITS,
  SLOT_ACCEPTS,
  expandCapabilities,
  isVlanAware,
  profileIncludes,
  type Capability,
  type DefaultsProfile,
  type HardwareErrorCode,
  type HardwareResult,
  type ModuleModel,
  type ModuleType,
  type PortRole,
  type SlotId,
  type SlotSpec,
} from '../contracts/catalog.js';
import { CLI_MESSAGES } from '../contracts/cli.js';
import type { ConfigAst, ConfigDelta, ConfigNode, DefaultSlots } from '../contracts/config.js';
import type { DeviceClockView } from '../contracts/clock.js';
import type { DeviceModel, DeviceRuntime, DeviceRuntimeDeps, DeviceSpec, PortResolution } from '../contracts/device.js';
import type { SimEventBody } from '../contracts/events.js';
import type { DeviceId, PortId, ProcessName } from '../contracts/ids.js';
import type { DropReason, EgressSchedulerSpec, FrameRxInfo, PolicerSpec, PortPhySettings, TransmitOptions, TxOutcome } from '../contracts/link.js';
import type { AirView, MediumEvent } from '../contracts/medium.js';
import type { Pdu, PduFactory, RewrapOp } from '../contracts/pdu.js';
import type { ErrDisableCause, Ipv6PortAddress, PortIpv4Address, PortL3, PortState, PortView, VirtualIpv4 } from '../contracts/port.js';
import type {
  Action,
  ClockAction,
  CliRemoteAction,
  ConfigOrigin,
  DebugEvent,
  DemuxLayer,
  DropRule,
  Process,
  ProcessCtx,
  RemoteCliAction,
  Severity,
  StateView,
} from '../contracts/process.js';
import type { PortQosView } from '../contracts/snapshot.js';
import type { FileSystemId, StoredFile, StoredFileInput, StoredFileMeta } from '../contracts/storage.js';
import type { L2ChangedEvent, LogRecordEvent } from '../contracts/transport.js';
import { CHANNELS, type BssSettings, type ChannelWidthMhz, type RadioSettings, type RfBand, type WifiSecurity } from '../contracts/rf.js';
import {
  stpKey,
  vlanKey,
  type DeviceTables,
  type DtpRow,
  type EtherchannelRow,
  type StpPortRow,
  type Table,
  type TableFactory,
  type TableName,
  type TableRow,
  type TunnelRow,
} from '../contracts/tables.js';
import type { SimTime } from '../contracts/time.js';
import type { TraceEvent, TraceSink } from '../contracts/trace.js';
import { createConfigAst, defaultSlotsOf, parseConfigText } from '../cli/config-ast.js';
import { DEFAULT_CONFIG_RULES, isSchedulerPhyLine, maskSecretTokens } from '../cli/config-rules.js';
import { normalizeIpv6 } from '../core/addr6.js';
import { configTextLinesOf } from '../cli/config-text.js';
import { vlanPopOp, vlanPushOp } from '../pdu/vlan.js';
import { carries, channelOperOf, isImplicitVlan, operOf, type L2PortView } from '../protocols/l2/membership.js';
import { readSwitchport } from '../protocols/l2/switchport-config.js';
import { MAX_TOPOLOGY_FILES_PER_DEVICE, MAX_TOPOLOGY_FILE_CHARS, MAX_TOPOLOGY_FILE_NAME_CHARS } from '../io/schema.js';
import { isQosControlFrame } from '../link/control-frame.js';
import { createQosPolicer, policeQosPacket, qosPoliceConformDropDetail, qosPolicedDetail, type QosPolicer } from '../link/qos/scheduler.js';
import { classifyQos, qosPacketFacts } from '../qos/classify.js';
import {
  compileEgressScheduler,
  compileQosPolicy,
  isQosConfigDelta,
  qosPolicerSpecOf,
  qosPortReferenceRateBps,
  readQosAttachments,
  type QosAttachment,
  type QosCompileOptions,
  type QosPolicy,
} from '../qos/config.js';
import { planQosMarking, planQosPoliceMarkdown, qosFactsAfter, type QosMarkMutation } from '../qos/mark.js';
import { CATALOG_STAGE } from './catalog/index.js';
import { deriveProcesses, deriveTables, modulePortSpecs } from './catalog/define.js';
import { parseSubinterfaceName, resolvePortName } from './catalog/names.js';
import {
  buildDemuxIndex,
  countIngress,
  effectivePortRole,
  frameArrivalVerdict,
  ingressVerdict,
  loopIngressLayer,
  poppedFrameView,
  qosPolicyRole,
  subinterfaceVerdict,
  type DemuxIndex,
  type FrameVerdict,
} from './pipeline.js';
import {
  SVI_SUPPORTED_VLAN,
  autoVirtualPortStates,
  checkVirtualPortRemoval,
  createPortState,
  createSubinterfacePortState,
  createVirtualPortState,
  fixedPortStates,
  insertPorts,
  isAutoInstance,
  parseVirtualPortName,
  planSubinterface,
  planVirtualPort,
  recomputeVirtualOper,
  removePorts,
  resetPortForPowerOff,
  seedInterfaceSection,
  seedRunningConfig,
  specEncap,
  specRole,
  subinterfacesOf,
  sviVlanOf,
  vlanMissingMessage,
  vlanUnsupportedMessage,
  type PortBuildContext,
  type VirtualOperLookups,
} from './ports.js';
import {
  bootClockBase,
  clockTimezoneOf,
  clockViewAt,
  createProcessCtx,
  pduSummary,
  rebaseClockBase,
  type DeviceClockBase,
  type ProcessHost,
} from './process-ctx.js';

/** Maximum number of actions applied per top-level `applyActions` call. */
export const ACTION_BUDGET = 1000;

/** Debug events retained per process. */
export const DEBUG_RING_CAPACITY = 200;

/** Syslog facility used for admin-state changes. */
const FACILITY_LINK = 'LINK';

/** Syslog facility used for runtime/system messages. */
const FACILITY_SYS = 'SYS';

/** @since P2 Learner-facing names of the err-disable causes, used in the runtime's log lines (original wording). */
export const ERR_DISABLE_CAUSE_TEXT: Readonly<Record<ErrDisableCause, string>> = Object.freeze({
  'psecure-violation': 'a port security violation',
  bpduguard: 'BPDU guard',
  'channel-misconfig': 'an EtherChannel misconfiguration',
  fault: 'an injected fault',
  // P3 (ARCHITECTURE-P3 §2.2, §9.2 W0 item 1): the final texts; eth-switch raises them since W2 l2 (steps 7b/7c, which
  // also appended them to ERR_DISABLE_CAUSES).
  'dhcp-rate-limit': 'the DHCP snooping rate limit',
  'arp-inspection': 'dynamic ARP inspection',
});

/** @since P2 Log line of an `errDisable` action (severity 4; `detail` appended when given). Original wording. */
export function errDisabledMessage(port: PortId, cause: ErrDisableCause, detail?: string): string {
  const base = `Interface ${port} is error-disabled by ${ERR_DISABLE_CAUSE_TEXT[cause]}`;
  return detail === undefined || detail === '' ? `${base}.` : `${base}: ${detail}.`;
}

/** @since P2 Log line of an `errRecover` action (severity 5). Original wording. */
export function errRecoveredMessage(port: PortId, cause: ErrDisableCause): string {
  return `Interface ${port} leaves the error-disabled state (${ERR_DISABLE_CAUSE_TEXT[cause]}) and may come up again.`;
}

// ── P3 (ARCHITECTURE-P3 D14, D19, D20, D21; W1 device) ─────────────────────────

/** @since P3 [S24] The daemon that receives `log.record` from the one log path (D20), when the model runs it. */
export const EMIT_LOG_TARGET: ProcessName = 'logger';

/** @since P3 The debug category of the clock's synchronisation transitions (§5.8: ntp's `ntp events`). */
export const CLOCK_TRANSITION_CATEGORY = 'ntp events';

/** @since P3 The `ntp` transition subject when neither the action nor the clock names a reference. */
export const CLOCK_TRANSITION_NO_REFERENCE = 'none';

/** @since P3 A clock source that counts as synchronised for the `ntp` transition: an NTP sync or `ntp master`. */
export function isSynchronisedClockSource(source: DeviceClockView['source']): boolean {
  return source === 'ntp' || source === 'master';
}

/** @since P3 The `ntp` transition message of a clock that became synchronised (original wording). */
export function clockSynchronisedMessage(reference: string, stratum: number | undefined): string {
  return stratum === undefined ? `The clock is now synchronised to ${reference}.` : `The clock is now synchronised to ${reference}, stratum ${stratum}.`;
}

/** @since P3 The `ntp` transition message of a clock that stopped being synchronised (original wording). */
export function clockUnsynchronisedMessage(reference: string): string {
  return `The clock is no longer synchronised to ${reference}.`;
}

/** @since P3 [S32] The file system of the hosts' store (D21): the only one in P3a. */
export const HOST_STORE_FS: FileSystemId = 'files';

/**
 * @since P3 [S32] A valid name in the flat `files:` store: not empty, no directory separator (`/`, `\`), no control
 * character, not `.` or `..`.
 */
export function isStoredFileName(path: string): boolean {
  if (path === '' || path === '.' || path === '..') return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2f || c === 0x5c) return false;
  }
  return true;
}

/** @since P3 [S32] UTF-8 length of `text` in bytes (`StoredFileMeta.size`), counted without an encoder. */
export function storedFileSize(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * @since P3 [S32] Why a `storage` write of `path` with `content` cannot be stored in a `files:` store that holds `paths`
 * (ruling R20: the io limits, io/schema.ts), in original wording; undefined when it can. A name longer than
 * `MAX_TOPOLOGY_FILE_NAME_CHARS` UTF-16 code units, a content longer than `MAX_TOPOLOGY_FILE_CHARS` code units (1 MiB,
 * the startup-config bound) and a NEW file in a store that already holds `MAX_TOPOLOGY_FILES_PER_DEVICE` files are
 * refused; replacing an existing file never counts against the file limit. The writers ([S32] `file.write`,
 * script-host) may call it first to tell the user why; the runtime enforces it.
 */
export function storageWriteProblem(paths: ReadonlySet<string> | readonly string[], path: string, content: string): string | undefined {
  if (path.length > MAX_TOPOLOGY_FILE_NAME_CHARS) return `the name is longer than ${MAX_TOPOLOGY_FILE_NAME_CHARS} characters`;
  if (content.length > MAX_TOPOLOGY_FILE_CHARS) return `the file is longer than ${MAX_TOPOLOGY_FILE_CHARS} characters`;
  const has = Array.isArray(paths) ? (paths as readonly string[]).includes(path) : (paths as ReadonlySet<string>).has(path);
  if (!has) {
    const count = Array.isArray(paths) ? (paths as readonly string[]).length : (paths as ReadonlySet<string>).size;
    if (count >= MAX_TOPOLOGY_FILES_PER_DEVICE) return `the store already holds ${MAX_TOPOLOGY_FILES_PER_DEVICE} files`;
  }
  return undefined;
}

// ── P3 [S25]: the extended-logging default (D2, D20; W2 device) ─────────────────

/** @since P3 [S25] Syslog facility of the line-protocol change log (the link log uses the P1 `LINK` facility). */
export const FACILITY_LINEPROTO = 'LINEPROTO';

/** @since P3 [S25] Mnemonic of the link and line-protocol change logs (§3.7: `%LINK-3-UPDOWN`, `%LINEPROTO-5-UPDOWN`). */
export const LOG_MNEMONIC_UPDOWN = 'UPDOWN';

/** @since P3 [S25] Mnemonic of the start log at boot completion (original wording). */
export const LOG_MNEMONIC_BOOTED = 'BOOTED';

/** @since P3 [S25] Mnemonic of the configuration log (original wording). */
export const LOG_MNEMONIC_CONFIGURED = 'CONFIGURED';

/** @since P3 [S25] Severity of the link change log (§3.7). */
export const LINK_LOG_SEVERITY: Severity = 3;

/** @since P3 [S25] Severity of the line-protocol change, start and configuration logs (§3.7). */
export const EXTENDED_LOG_SEVERITY: Severity = 5;

/** @since P3 [S25] Does a world of `profile` have the extended-logging default (D2: P3 worlds only)? */
export function extendedLoggingDefault(profile: DefaultsProfile): boolean {
  return profileIncludes(profile, 'P3');
}

/**
 * @since P3 [S25] Does a model take the extended-logging default? The devices whose P3 defaults are a network device's
 * (D2; the [S24] timestamps lines go to the same set): a router or a managed or multilayer switch with the NF-OS CLI,
 * and the controller; never a home router (`nat-gateway`, GUI only), a host, an access point or a legacy device.
 */
export function extendedLoggingModel(model: Pick<DeviceModel, 'capabilities' | 'cli'>): boolean {
  const caps = model.capabilities ?? [];
  if (caps.includes('nat-gateway')) return false;
  if (caps.includes('wireless-controller')) return true;
  return model.cli?.shell === 'nfos' && (caps.includes('routing') || caps.includes('managed-switch'));
}

/** @since P3 [S25] The link change log of `port` (original wording). */
export function linkStateMessage(port: PortId, up: boolean): string {
  return `Interface ${port}: the link is ${up ? 'up' : 'down'}`;
}

/** @since P3 [S25] The line-protocol change log of `port` (original wording). */
export function lineProtocolMessage(port: PortId, up: boolean): string {
  return `Interface ${port}: line protocol is ${up ? 'up' : 'down'}`;
}

/** @since P3 [S25] The start log at boot completion (original wording). */
export function systemStartedMessage(model: string): string {
  return `The system has started (${model}).`;
}

/** @since P3 [S25] How a configure origin names its channel in the configuration log. */
const ORIGIN_CHANNEL: Readonly<Record<ConfigOrigin['via'], string>> = Object.freeze({ restconf: 'RESTCONF' });

/**
 * @since P3 [S25] The configuration log (original wording): from the console for a typed line (no origin), else over
 * the configure origin's channel, naming its user and address when the origin carries them.
 */
export function configurationChangedMessage(origin?: ConfigOrigin): string {
  if (origin === undefined) return 'Configuration changed from the console.';
  const by = origin.user === undefined ? '' : ` by ${origin.user}`;
  const from = origin.address === undefined ? '' : ` from ${origin.address}`;
  return `Configuration changed over ${ORIGIN_CHANNEL[origin.via]}${by}${from}.`;
}

/** @since P3 A copy of a configure origin with only the members that are set (D21; stored on `configChange`). */
function copyOrigin(o: ConfigOrigin): ConfigOrigin {
  const out: { -readonly [K in keyof ConfigOrigin]: ConfigOrigin[K] } = { via: o.via };
  if (o.user !== undefined) out.user = o.user;
  if (o.address !== undefined) out.address = o.address;
  return out;
}

/** @since P3 [S13] A copy of a `remoteCli` / `cliRemote` action for its SimEvent (only the members that are set). */
function copyRemoteAct(a: RemoteCliAction | CliRemoteAction): RemoteCliAction | CliRemoteAction {
  if (a.type === 'cliRemote') {
    const c: CliRemoteAction = { type: 'cliRemote', session: a.session };
    if (a.prompt !== undefined) c.prompt = a.prompt;
    if (a.input !== undefined) c.input = a.input;
    if (a.remote !== undefined) c.remote = a.remote;
    return c;
  }
  const r: RemoteCliAction = { type: 'remoteCli', op: a.op, conn: a.conn };
  if (a.peer !== undefined) r.peer = a.peer;
  if (a.proto !== undefined) r.proto = a.proto;
  if (a.user !== undefined) r.user = a.user;
  if (a.text !== undefined) r.text = a.text;
  return r;
}

/** @since P3 [S32] One stored file of the hosts' store (content and its size, the time of the last write). */
interface StoredFileEntry {
  readonly content: string;
  readonly size: number;
  readonly modifiedAt: SimTime;
}

/**
 * @since P2 The `profileConfig` lists a device replays at boot in a world of `profile` (D2): one list per key k with
 * `profileIncludes(profile, k)`, in DEFAULTS_PROFILES order, empty lists left out. A P1 world gets only a 'P1' key's
 * lines (no model has one today), so it replays nothing new.
 */
export function profileConfigLines(model: Pick<DeviceModel, 'profileConfig'>, profile: DefaultsProfile): readonly (readonly string[])[] {
  const out: (readonly string[])[] = [];
  for (const k of DEFAULTS_PROFILES) {
    if (!profileIncludes(profile, k)) continue;
    const lines = model.profileConfig?.[k];
    if (lines !== undefined && lines.length > 0) out.push(lines);
  }
  return out;
}

/**
 * @since P2 The default lines D of the completeness rule (D2, §5): `defaultConfig`, then every `profileConfigLines`
 * list, as one config text line list (W2 device computes the device's `DefaultSlots` from it).
 */
export function deviceDefaultLines(model: Pick<DeviceModel, 'defaultConfig' | 'profileConfig'>, profile: DefaultsProfile): readonly string[] {
  const out: string[] = [...(model.defaultConfig ?? [])];
  for (const lines of profileConfigLines(model, profile)) out.push(...lines);
  return out;
}

/**
 * @since P2 The device's default slots (D2, §5): `defaultSlotsOf` over the parsed default lines D of `model` in a
 * world of `profile`. The runtime computes it once per device (D depends only on the model and the profile) and
 * passes it to every config apply. A model without default lines gives an empty map, with which `ConfigAst.apply` is
 * exactly `set` / `unset` (no P1 device has a default slot).
 */
export function deviceDefaultSlots(model: Pick<DeviceModel, 'defaultConfig' | 'profileConfig'>, profile: DefaultsProfile): DefaultSlots {
  const lines = deviceDefaultLines(model, profile);
  if (lines.length === 0) return new Map();
  return defaultSlotsOf(parseConfigText(lines.join('\n')));
}

/**
 * @since P2 First tokens of the config lines after which the runtime recomputes virtual oper state (§3.0 "Virtual
 * oper state"): switchport membership, VLAN creation, channel membership, subinterface encapsulation, spanning tree.
 */
export const VIRTUAL_RECOMPUTE_KEYS: readonly string[] = Object.freeze(['switchport', 'vlan', 'channel-group', 'encapsulation', 'spanning-tree']);

/** @since P2 The `encapsulation` keyword of a subinterface line, compared without case (`dot1Q`, `dot1q`). */
export const DOT1Q_ENCAPSULATION = 'dot1q';

/** @since P2 Provenance cause of the pop at subinterface ingress and the push at subinterface egress (§3.4). */
export function dot1qCause(vid: number): string {
  return `encapsulation dot1Q ${vid}`;
}

/**
 * @since P2 Parse the arguments of `encapsulation dot1Q <vid> [native]` (`args` = the tokens after `encapsulation`):
 * the VID must be 1–4094 and the only optional word is `native`. Undefined when the arguments are not that.
 */
export function parseDot1qArgs(args: readonly string[]): { vid: number; native: boolean } | undefined {
  if (args.length < 2 || args.length > 3 || (args[0] as string).toLowerCase() !== DOT1Q_ENCAPSULATION) return undefined;
  if (!/^[0-9]+$/.test(args[1] as string)) return undefined;
  const vid = Number(args[1]);
  if (!Number.isSafeInteger(vid) || vid < 1 || vid > 4094) return undefined;
  if (args.length === 3 && args[2] !== 'native') return undefined;
  return { vid, native: args.length === 3 };
}

/**
 * Interface config keys whose change the link model must see (`DeviceRuntimeDeps.onPortPhyConfig`): speed,
 * duplex, clock rate, encapsulation, keepalive, the radio lines and switchport (§3.4 triggers).
 */
export const PHY_CONFIG_KEYS: readonly string[] = Object.freeze([
  'speed',
  'duplex',
  'clock',
  'encapsulation',
  'keepalive',
  'ssid',
  'security',
  'passphrase',
  'band',
  'channel',
  'channel-width',
  'tx-power',
  'peer-key',
  'beacons',
  'switchport',
]);

/**
 * Original wording of the runtime's own config refusals (§1.6). P3 [S19] (§9.2 item 30): the P1 refusal of
 * `encapsulation ppp` on a router's serial port is removed; `pppAccessLine` refuses it on a serial access line only.
 */
export const DEVICE_CONFIG_MESSAGES = Object.freeze({
  /** @since P3 [S19] `encapsulation ppp` on a serial access line (NF-CSU-DSU, NF-INTERNET): HDLC only (D17, a listed deviation). */
  pppAccessLine: 'This serial access line carries HDLC only.',
  /** `encapsulation <other>`. */
  encapsulationUnknown: 'Encapsulation {encap} is not supported on this interface.',
  /** `encapsulation …` on a port that is not a serial interface. */
  encapsulationNotSerial: 'Encapsulation can only be changed on serial interfaces.',
  /** `setPortRole` on a port the device does not have. */
  unknownInterface: 'Unknown interface {name}',
  /** @since P2 `encapsulation dot1Q …` on a subinterface with a missing or invalid VLAN id, or an unknown extra word. */
  dot1qArguments: 'Enter "encapsulation dot1Q <vlan> [native]" with a VLAN id from 1 to 4094.',
  /** @since P2 `encapsulation <other>` on a subinterface (only 802.1Q is carried there). */
  subinterfaceEncapsulation: 'A subinterface carries 802.1Q only: enter "encapsulation dot1Q <vlan> [native]".',
  /** @since P2 A send on a subinterface whose encapsulation is not set (it is down, so no daemon should reach this). */
  subinterfaceNoEncapsulation: 'no-encapsulation',
});

/** Link-layer port kinds that carry a radio (ctx.air is offered only to devices with one). */
const RADIO_KINDS: readonly string[] = Object.freeze(['wlan', 'radio', 'cellular']);

/** Valid `security` values. */
const WIFI_SECURITIES: readonly WifiSecurity[] = Object.freeze(['open', 'wpa2-psk', 'wpa3-sae']);

/** Valid `channel-width` values below 60 GHz. */
const CHANNEL_WIDTHS: readonly ChannelWidthMhz[] = Object.freeze([20, 40, 80, 160]);

/** `speed <n>` values are megabits per second. */
const MBPS = 1_000_000;

/**
 * @since P2 (wireless; W4 device) The stored form of a controller profile (`radio-profile` action): a frozen copy of
 * every BSS (only the members that are set are copied, so an absent `passphrase` stays absent), ordered by `index`
 * ascending (§4.5 "BSSs of a radio by index"; equal indexes keep the order given). The daemon's own array and
 * objects are never kept, so a daemon that reuses them cannot change a stored profile.
 */
export function copyRadioProfile(bss: readonly BssSettings[]): readonly BssSettings[] {
  const out = bss.map((b, i): { b: BssSettings; i: number } => {
    const c: BssSettings = { index: b.index, ssid: b.ssid, security: b.security, switching: b.switching };
    if (b.passphrase !== undefined) c.passphrase = b.passphrase;
    if (b.keyTag !== undefined) c.keyTag = b.keyTag;
    if (b.vlan !== undefined) c.vlan = b.vlan;
    if (b.wlanId !== undefined) c.wlanId = b.wlanId;
    return { b: Object.freeze(c), i };
  });
  out.sort((x, y) => x.b.index - y.b.index || x.i - y.i);
  return Object.freeze(out.map((e) => e.b));
}

/**
 * @since P2 (wireless; W4 device) Overlay a stored controller profile on the settings rendered from the local
 * interface lines, in place (§2.12, §3.12 step 4). The controller owns the BSS set: BSS 0 (today's single BSS)
 * supplies `ssid`, `security` and `passphrase` — a profile without a BSS 0 (or an empty one) leaves the radio idle
 * (no `ssid`, security `open`, no `passphrase`), as a lightweight access point with no WLAN mapped serves nothing —
 * and the whole list is `bss`; `controller`, the name of the controller that pushed the profile (the action's
 * `controller`), is set when one was given and left out otherwise (§2.12: display only). The radio-level lines (band,
 * channel, width, transmit power, beacons, peer key) stay as the local lines set them.
 */
export function overlayRadioProfile(settings: RadioSettings, profile: readonly BssSettings[], controller?: string): RadioSettings {
  const primary = profile.find((b) => b.index === 0);
  if (primary === undefined) {
    delete settings.ssid;
    settings.security = 'open';
    delete settings.passphrase;
  } else {
    settings.ssid = primary.ssid;
    settings.security = primary.security;
    if (primary.passphrase === undefined) delete settings.passphrase;
    else settings.passphrase = primary.passphrase;
  }
  settings.bss = profile;
  if (controller === undefined) delete settings.controller;
  else settings.controller = controller;
  return settings;
}

/** @since P2 (wireless; W4 device) One stored controller profile: the BSS list and, when the action named it, the controller. */
interface StoredRadioProfile {
  readonly bss: readonly BssSettings[];
  readonly controller?: string;
}

/** Timer map key. */
const timerKey = (process: ProcessName, key: string): string => `${process}\0${key}`;

/** Fill `{key}` placeholders of a message template. */
function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  let out = template;
  for (const key of Object.keys(values)) out = out.split(`{${key}}`).join(String(values[key]));
  return out;
}

/** One pending action and the process it was returned by. */
interface PendingAction {
  process: ProcessName;
  action: Action;
}

/** Actions a handler returned, applied depth-first as the actions of `process`. */
interface FollowUp {
  process: ProcessName;
  actions: Action[];
}

/**
 * @since P2 A deferred runtime step of a multi-target action (`l2Changed`): run when it reaches the top of the stack,
 * so each fan-out target is called only after the previous target's actions were applied. Counts against the budget.
 */
interface PendingStep {
  process: ProcessName;
  step: () => FollowUp | undefined;
}

/** What `applyOne` hands back: follow-up actions, or (P2) steps to run in order. */
type ApplyResult = FollowUp | { steps: readonly (() => FollowUp | undefined)[] } | undefined;

// ── P3 (D16; W3 device): the runtime's QoS state ─────────────────────────────

/** @since P3 The two directions a `service-policy` attaches in. */
type QosDirection = 'input' | 'output';

/** @since P3 (M13) The display counters of one class (`PortQosView.classes`). */
interface QosClassCount {
  matched: number;
  matchedBytes: number;
  marked: number;
}

/** @since P3 [S21] A runtime policer and the key of the spec it was built from (`JSON` of its `PolicerSpec`). */
interface QosPolicerEntry {
  readonly key: string;
  readonly policer: QosPolicer;
}

/**
 * @since P3 (D16) One (port, direction): the attached policy-map name, the compiled policy tagged with the
 * configuration generation and the port version it was compiled at, and the class counters and runtime policers by
 * class name (kept across recompiles of the same policy-map, reset when the attached name changes). RAM.
 */
interface QosDirState {
  readonly name: string;
  gen: number;
  version: number;
  /** Undefined = the policy-map does not exist (nothing is classified). */
  policy: QosPolicy | undefined;
  readonly counts: Map<string, QosClassCount>;
  readonly policers: Map<string, QosPolicerEntry>;
}

/**
 * @since P3 [S20] The compiled egress scheduler of a physical port at (generation, port version, reference rate): the
 * spec (undefined = the virtual FIFO; an output policy refused by the 75 % admission counts as none), whether it comes
 * from the output policy (its class index is the frame's `qosClass`) or from interface `fair-queue`, and its JSON key
 * (an unchanged recompile keeps the previous object, so the spec's identity changes only with its content).
 */
interface EgressSpecEntry {
  readonly gen: number;
  readonly version: number;
  readonly refBps: number;
  readonly spec: EgressSchedulerSpec | undefined;
  readonly fromPolicy: boolean;
  readonly key: string;
}

/** @since P3 What a QoS step decided for a frame: its class index, or a policer drop with its detail. */
type QosStepResult = { readonly cls: number } | { readonly drop: string };

/** @since P3 The directions in the order `PortQosView.classes` lists them. */
const QOS_DIRECTIONS: readonly QosDirection[] = Object.freeze(['input', 'output']);

/** @since P3 [S21] The identity of a policer spec (a changed `police` line replaces the runtime policer). */
function policerKey(spec: PolicerSpec): string {
  return JSON.stringify(spec);
}

/**
 * The pdu still in hand in an action, if any (for budget-exhaustion drops): the pdu of send/deliver/drop/consume/
 * ingress, the packet a send request carries (`arp.sendVia`, `ipv4.send`, `ipv6.send`, `nd.sendVia`) and the quoted
 * original of an ICMP error request (`icmp.error`, `icmp6.error`). Socket requests carry payloads, not pdus, and the
 * pdus inside ProcessEvents were already consumed, so neither is dropped again.
 */
export function pduOf(a: Action): Pdu | undefined {
  switch (a.type) {
    case 'send':
    case 'deliver':
    case 'drop':
    case 'consume':
    case 'ingress':
      return a.pdu;
    case 'request': {
      const req = a.req;
      if (req.kind === 'arp.sendVia' || req.kind === 'ipv4.send' || req.kind === 'ipv6.send' || req.kind === 'nd.sendVia') return req.pdu;
      if (req.kind === 'icmp.error' || req.kind === 'icmp6.error') return req.original;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A `setPortL3` action (the L3 write path of ipv4 and ipv6). */
export type SetPortL3Action = Extract<Action, { type: 'setPortL3' }>;

/**
 * Apply a `setPortL3` action to a port's derived L3 state and return the new state object (the input is not
 * modified). MERGE per member: undefined = unchanged, null = clear, value = replace that member with a copy
 * (IPv6 address texts and groups are normalised to RFC 5952; unparsable texts are kept as given).
 * An action carrying none of the four members is a no-op (the P0 member-less "clear ipv4" form was deleted at
 * the P1 exit gate, §0 rule 2; ipv4 sends `ipv4: null` instead).
 * Optional `ipv4` fields (`origin`, `leaseExpiresAt`) are copied only when set, so P0 snapshots keep their bytes.
 */
export function mergePortL3(current: Readonly<PortL3>, a: SetPortL3Action): PortL3 {
  const out: PortL3 = {};

  const ipv4 = a.ipv4;
  if (ipv4 === undefined) {
    if (current.ipv4 !== undefined) out.ipv4 = current.ipv4;
  } else if (ipv4 !== null) {
    const v4: PortIpv4Address = { address: ipv4.address, prefixLen: ipv4.prefixLen };
    if (ipv4.origin !== undefined) v4.origin = ipv4.origin;
    if (ipv4.leaseExpiresAt !== undefined) v4.leaseExpiresAt = ipv4.leaseExpiresAt;
    out.ipv4 = v4;
  }

  if (a.ipv6 === undefined) {
    if (current.ipv6 !== undefined) out.ipv6 = current.ipv6;
  } else if (a.ipv6 !== null) {
    out.ipv6 = a.ipv6.map((addr): Ipv6PortAddress => ({ ...addr, address: normalizeIpv6(addr.address) ?? addr.address }));
  }

  if (a.ipv6Enabled === undefined) {
    if (current.ipv6Enabled !== undefined) out.ipv6Enabled = current.ipv6Enabled;
  } else if (a.ipv6Enabled !== null) {
    out.ipv6Enabled = a.ipv6Enabled;
  }

  if (a.groups6 === undefined) {
    if (current.groups6 !== undefined) out.groups6 = current.groups6;
  } else if (a.groups6 !== null) {
    out.groups6 = a.groups6.map((g) => normalizeIpv6(g) ?? g);
  }

  // P2 (D15): the virtual addresses written by ipv4 on `ipv4.virtual`; copied entry by entry in the order given
  if (a.virtual4 === undefined) {
    if (current.virtual4 !== undefined) out.virtual4 = current.virtual4;
  } else if (a.virtual4 !== null) {
    out.virtual4 = a.virtual4.map((v): VirtualIpv4 => ({ address: v.address, mac: v.mac, owner: v.owner, local: v.local }));
  }

  // [S2] the joined IPv4 groups written by ipv4 on `ipv4.group`
  if (a.groups4 === undefined) {
    if (current.groups4 !== undefined) out.groups4 = current.groups4;
  } else if (a.groups4 !== null) {
    out.groups4 = [...a.groups4];
  }
  // [/S2]
  return out;
}

// ── tables v2 ─────────────────────────────────────────────────────────────────

/** `DeviceTables` whose optional P0.5 members are always present, plus the runtime's resync hook. */
export interface DeviceTableSet extends DeviceTables {
  get<R extends TableRow = TableRow>(name: TableName): Table<R> | undefined;
  names(): readonly TableName[];
  /**
   * Make the declared set equal `names` (cam, arp and rib always stay first): missing tables are created, tables
   * no longer declared are dropped (their rows are gone with the hardware that needed them).
   */
  sync(names: readonly TableName[]): void;
}

/** The three P0 tables every device owns, in their fixed order. */
const BASE_TABLES: readonly TableName[] = Object.freeze(['cam', 'arp', 'rib']);

/** Declared order of a table name list: cam, arp, rib, then the others in first-occurrence order. */
function orderTableNames(names: readonly TableName[]): TableName[] {
  const out: TableName[] = [...BASE_TABLES];
  for (const n of names) if (!out.includes(n)) out.push(n);
  return out;
}

/**
 * Build a device's table set (`DeviceModel.tables` order; cam, arp, rib first) from a `TableFactory`. Used by the
 * runtime and by test fixtures that need a v2 `DeviceTables` with `get`/`names`.
 */
export function createDeviceTables(
  device: DeviceId,
  names: readonly TableName[],
  factory: TableFactory,
  sink: TraceSink,
  now: () => SimTime,
): DeviceTableSet {
  const tables = new Map<TableName, Table<TableRow>>();
  const make = (name: TableName): Table<TableRow> => factory<TableRow>({ name, device, sink, now });
  const sync = (wanted: readonly TableName[]): void => {
    const order = orderTableNames(wanted);
    const kept = new Map<TableName, Table<TableRow>>();
    for (const name of order) kept.set(name, tables.get(name) ?? make(name));
    tables.clear();
    for (const [name, table] of kept) tables.set(name, table);
  };
  sync(names);
  return {
    get cam() {
      return tables.get('cam') as unknown as DeviceTables['cam'];
    },
    get arp() {
      return tables.get('arp') as unknown as DeviceTables['arp'];
    },
    get rib() {
      return tables.get('rib') as unknown as DeviceTables['rib'];
    },
    get<R extends TableRow = TableRow>(name: TableName): Table<R> | undefined {
      return tables.get(name) as Table<R> | undefined;
    },
    names(): readonly TableName[] {
      return [...tables.keys()];
    },
    sync,
  };
}

// ── the runtime ───────────────────────────────────────────────────────────────

class DeviceRuntimeImpl implements DeviceRuntime, ProcessHost {
  readonly id: DeviceId;
  readonly model: DeviceModel;
  readonly spec: DeviceSpec;
  hostname: string;
  power = false;
  bootedAt?: SimTime;
  readonly ports: Map<PortId, PortState> = new Map();
  readonly tables: DeviceTableSet;
  startup?: ConfigAst;
  readonly processes: Map<ProcessName, Process> = new Map();
  readonly macBase: number;

  readonly trace: TraceSink;
  readonly pdus: PduFactory;

  private readonly deps: DeviceRuntimeDeps;
  /** @since P2 The device's default slots (D2, §5), passed to every config apply and to the parse of saved text. */
  private readonly defaultSlots: DefaultSlots;
  private runningAst: ConfigAst;
  /** One-shot running-config from `spec.runningConfig`, consumed by the first boot; dropped on power-off. */
  private pendingRunning: ConfigAst | undefined;
  private clock: SimTime;
  private bootSeq: number | undefined;
  private readonly timers = new Map<string, { seq: number; at: SimTime }>();
  private readonly ctxs = new Map<ProcessName, ProcessCtx>();
  /** Per-process debug rings; entries carry an emission sequence so `recentDebug` can merge them in order. */
  private readonly debugRings = new Map<ProcessName, { seq: number; ev: DebugEvent }[]>();
  private debugSeq = 0;
  /** Installed modules, in model slot order. */
  private readonly installed = new Map<SlotId, ModuleType>();
  private effectiveCaps: readonly Capability[];
  /** Daemon order: `model.processes`, plus daemons of module capabilities in PROCESS_ORDER. */
  private processOrder: readonly ProcessName[];
  private demuxIndex: DemuxIndex;
  private version = 0;
  private airResolved = false;
  private airCache: AirView | undefined;
  /** @since P2 (wireless) Controller profiles by radio port (`radio-profile` action); RAM, cleared on power-off. */
  private readonly radioProfiles = new Map<PortId, StoredRadioProfile>();
  /**
   * @since P3 The device clock (D19) once a `clock` action rebased it; undefined = the boot clock (`bootClockBase`:
   * unset plus uptime on a network device, true time on a host). RAM: power-off forgets it.
   */
  private clockBase: DeviceClockBase | undefined;
  /** @since P3 [S32] The hosts' `files:` store by path (D21); persistent (kept across power-off, like a disk). */
  private readonly fileStore = new Map<string, StoredFileEntry>();
  /** @since P3 [S25] The extended-logging default applies: a P3 world and a model that takes it (fixed per device). */
  private readonly extendedLogging: boolean;
  /** @since P3 [S25] The carrier state last reported by a link log, per physical port (RAM: cleared at power-off). */
  private readonly linkLogged = new Map<PortId, boolean>();
  /** @since P3 [S25] The line-protocol state last reported by a line-protocol log, per port (RAM). */
  private readonly lineLogged = new Map<PortId, boolean>();
  /** @since P3 [S25] The source and instant of the last configuration log (RAM): one log per source and instant. */
  private lastConfigLog: { at: SimTime; source: string } | undefined;
  /**
   * @since P3 (D16) The QoS configuration generation: +1 for every configuration delta that can change a compiled
   * policy or a scheduler spec (`isQosConfigDelta`: class-map, policy-map, access-list, ip access-list, the interface
   * service-policy / bandwidth / fair-queue lines) and at power-off (the running configuration is replaced).
   */
  private qosGen = 0;
  /** @since P3 (D16) The interface QoS attachments of the running configuration at (generation, port version). */
  private qosIndex: { readonly gen: number; readonly version: number; readonly ports: ReadonlyMap<PortId, QosAttachment> } | undefined;
  /** @since P3 (D16) The compiled policies, counters and runtime policers by `<port>|<direction>`. RAM. */
  private readonly qosDirs = new Map<string, QosDirState>();
  /** @since P3 [S20] The compiled egress scheduler of each physical port that has one or had one. RAM. */
  private readonly egressSpecs = new Map<PortId, EgressSpecEntry>();
  /** @since P3 [S20] The spec each port had when the link model last heard of it (`onPortPhyConfig`). RAM. */
  private readonly egressKnown = new Map<PortId, EgressSchedulerSpec>();
  /** @since P3 (D16) How `match input-interface` names resolve: the device's own port names. */
  private readonly qosCompile: QosCompileOptions = {
    resolvePort: (text: string): string | undefined => {
      const r = this.resolvePortName(text);
      return r.kind === 'existing' ? r.port : undefined;
    },
  };

  constructor(spec: DeviceSpec, deps: DeviceRuntimeDeps, now: SimTime) {
    const model = deps.catalog.get(spec.type);
    if (model === undefined) throw new Error(`unknown device type ${spec.type}`);
    this.id = spec.id;
    this.model = model;
    this.spec = spec;
    this.deps = deps;
    this.trace = deps.trace;
    this.pdus = deps.pdus;
    this.clock = now;
    this.hostname = spec.name;
    this.macBase = deviceMacBase(spec.id, spec.macSalt ?? 0);

    // Validate and record the installed modules BEFORE any state is built (readable errors, no partial device).
    for (const install of this.orderInstalls(spec.modules ?? [])) {
      const slot = this.slotSpec(install.slot);
      if (slot === undefined) throw new Error(fill(HARDWARE_MESSAGES['no-such-slot'], { model: model.model, slot: install.slot }));
      const mod = this.moduleModel(install.module);
      if (mod === undefined) throw new Error(fill(HARDWARE_MESSAGES['unknown-module'], { module: install.module }));
      if (!SLOT_ACCEPTS[slot.type].includes(mod.fits)) throw new Error(fill(HARDWARE_MESSAGES['does-not-fit'], { module: mod.model, slotType: slot.type }));
      const occupant = this.installed.get(slot.id);
      if (occupant !== undefined) {
        throw new Error(fill(HARDWARE_MESSAGES['slot-occupied'], { slot: slot.id, module: this.moduleModel(occupant)?.model ?? occupant }));
      }
      this.installed.set(slot.id, mod.type);
    }
    this.effectiveCaps = this.computeCapabilities();
    this.processOrder = this.computeProcessOrder();
    this.demuxIndex = buildDemuxIndex([], new Map());

    const build = this.buildContext();
    const states: PortState[] = fixedPortStates(model, build);
    for (const [slotId, type] of this.installed) {
      const slot = this.slotSpec(slotId) as SlotSpec;
      states.push(...this.moduleStates(slot, this.moduleModel(type) as ModuleModel, build));
    }
    states.push(...autoVirtualPortStates(model, this.macBase));
    insertPorts(this.ports, model, states);
    for (const [slotId, type] of this.installed) this.applyCageTransceiver(slotId, type);

    this.tables = createDeviceTables(spec.id, this.computeTableNames(), deps.tables, deps.trace, () => this.clock);

    this.defaultSlots = deviceDefaultSlots(model, spec.profile ?? 'P1');
    this.extendedLogging = extendedLoggingDefault(spec.profile ?? 'P1') && extendedLoggingModel(model);
    this.runningAst = this.freshRunning();
    if (spec.startupConfig !== undefined) this.startup = this.parseSavedConfig(spec.startupConfig);
    if (spec.runningConfig !== undefined && spec.power) this.pendingRunning = this.parseSavedConfig(spec.runningConfig);

    if (spec.power) this.setPower(true, now);
  }

  // ── ProcessHost ─────────────────────────────────────────────────────────

  get now(): SimTime {
    return this.clock;
  }

  get running(): ConfigAst {
    return this.runningAst;
  }

  /** Effective capabilities: model capabilities plus those added by installed modules (CAPABILITIES order). */
  get capabilities(): readonly Capability[] {
    return this.effectiveCaps;
  }

  /** @since P2 The world's defaults profile (D2): `spec.profile`, absent = 'P1'. Read at every boot and by `ctx.profile`. */
  get profile(): DefaultsProfile {
    return this.spec.profile ?? 'P1';
  }

  /**
   * @since P3 [S19] Is `line` (in `context`) a global `username <n> [privilege <l>] password <pw>` line of a P3-profile
   * world, whose `configChange` is traced masked (§10.1 `accept.p3.ppp-chap`)? Never in a P1/P2 world (bytes unchanged).
   */
  private masksUserPassword(context: readonly (readonly string[])[], line: readonly string[]): boolean {
    return context.length === 0 && line[0] === 'username' && line.includes('password', 2) && profileIncludes(this.profile, 'P3');
  }

  /** RF view for daemons: resolved once per power cycle, only for devices with a radio port. */
  get air(): AirView | undefined {
    if (!this.airResolved) {
      this.airResolved = true;
      let radio = false;
      for (const p of this.ports.values()) if (RADIO_KINDS.includes(p.spec.kind)) radio = true;
      this.airCache = radio ? this.deps.airView(this.id) : undefined;
    }
    return this.airCache;
  }

  recordDebug(ev: DebugEvent): void {
    let ring = this.debugRings.get(ev.process);
    if (ring === undefined) {
      ring = [];
      this.debugRings.set(ev.process, ring);
    }
    ring.push({ seq: this.debugSeq++, ev });
    if (ring.length > DEBUG_RING_CAPACITY) ring.splice(0, ring.length - DEBUG_RING_CAPACITY);
  }

  // ── accessors ───────────────────────────────────────────────────────────

  /** Installed modules by slot, in model slot order. */
  get modules(): ReadonlyMap<SlotId, ModuleType> {
    return this.installed;
  }

  /** Bumped whenever the port set or an effective role changes. */
  get portsVersion(): number {
    return this.version;
  }

  port(id: PortId): PortState | undefined {
    return this.ports.get(id);
  }

  portView(id: PortId): PortView | undefined {
    return this.ports.get(id);
  }

  stateSnapshots(): StateView[] {
    const out: StateView[] = [];
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      if (p !== undefined) out.push(p.stateSnapshot());
    }
    return out;
  }

  recentDebug(limit = 50): DebugEvent[] {
    const all: { seq: number; ev: DebugEvent }[] = [];
    for (const ring of this.debugRings.values()) for (const e of ring) all.push(e);
    all.sort((a, b) => a.seq - b.seq); // emission order across processes
    const tail = limit >= all.length ? all : all.slice(all.length - Math.max(0, limit));
    return tail.map((e) => e.ev);
  }

  uptime(now: SimTime): SimTime {
    return this.bootedAt === undefined ? 0 : Math.max(0, now - this.bootedAt);
  }

  resolvePortName(name: string): PortResolution {
    return resolvePortName({ model: this.model, ports: this.ports }, name);
  }

  // ── P3: the device clock (D19) ──────────────────────────────────────────

  /** @since P3 The device clock at `now`: the rebased clock, else the boot clock; zone from `clock timezone`. */
  clockView(now: SimTime): DeviceClockView {
    const base = this.clockBase ?? bootClockBase(this.effectiveCaps, this.bootedAt, now);
    return clockViewAt(base, now, clockTimezoneOf(this.runningAst.root));
  }

  /** @since P3 Rebase the device clock (the ntp daemon's `clock` action; D19). */
  setClock(op: ClockAction, now: SimTime): void {
    this.rebaseClock('ntp', op, now);
  }

  /**
   * @since P3 The `clock` action of `owner` (ntp): rebase the clock at `now` (`rebaseClockBase`; a malformed action is
   * a runtime debug line and changes nothing), then, when the synchronised state (source `ntp` or `master`) changed,
   * emit ONE debug event carrying the `ntp` transition (category `ntp events`, subject the reference), recorded and
   * traced exactly like `ctx.transition`.
   */
  private rebaseClock(owner: ProcessName, a: ClockAction, now: SimTime): void {
    this.clock = now;
    const before = this.clockView(now);
    const next = rebaseClockBase(before, a, now);
    if (next === undefined) {
      this.runtimeDebug(owner, `clock ${a.op} ignored: the value is not a whole number the clock can hold`, now);
      return;
    }
    this.clockBase = next;
    const was = isSynchronisedClockSource(before.source);
    const is = isSynchronisedClockSource(next.source);
    if (was === is) return;
    const subject = (is ? (next.reference ?? before.reference) : (before.reference ?? next.reference)) ?? CLOCK_TRANSITION_NO_REFERENCE;
    const ev: DebugEvent = {
      at: now,
      device: this.id,
      process: owner,
      category: CLOCK_TRANSITION_CATEGORY,
      message: is ? clockSynchronisedMessage(subject, next.stratum) : clockUnsynchronisedMessage(subject),
      fsm: { machine: 'ntp', subject, from: was ? 'synchronised' : 'unsynchronised', to: is ? 'synchronised' : 'unsynchronised' },
    };
    this.recordDebug(ev);
    this.trace.emit({ t: now, kind: 'debug', event: ev });
  }

  // ── P3 [S24]: the one log path (D20) ────────────────────────────────────

  /**
   * @since P3 [S24] Emit the unchanged `log` trace event (`mnemonic` only when given) and, when the model runs
   * `logger`, apply its reaction to `log.record` as one action application.
   */
  emitLog(severity: Severity, facility: string, message: string, now: SimTime, mnemonic?: string): void {
    this.clock = now;
    const next = this.logRecord(undefined, severity, facility, message, now, mnemonic);
    if (next !== undefined) this.applyActions(next.process, next.actions, now);
  }

  /**
   * @since P3 [S24] Emit the `log` trace event, then return the logger's reaction to `log.record` (to apply depth-first
   * by the caller), or undefined when the device runs no `logger` or the logger itself is the issuer (a log line of
   * the logger is never handed back to it).
   */
  private logRecord(issuer: ProcessName | undefined, severity: Severity, facility: string, message: string, now: SimTime, mnemonic: string | undefined): FollowUp | undefined {
    const ev: Extract<TraceEvent, { kind: 'log' }> = { t: now, kind: 'log', device: this.id, severity, facility, message };
    if (mnemonic !== undefined) ev.mnemonic = mnemonic;
    this.trace.emit(ev);
    if (issuer === EMIT_LOG_TARGET) return undefined;
    const logger = this.processes.get(EMIT_LOG_TARGET);
    const ctx = this.ctxs.get(EMIT_LOG_TARGET);
    if (logger === undefined || ctx === undefined || logger.onEvent === undefined) return undefined;
    const record: LogRecordEvent = { kind: 'log.record', at: now, severity, facility, message };
    if (mnemonic !== undefined) record.mnemonic = mnemonic;
    return { process: EMIT_LOG_TARGET, actions: logger.onEvent(ctx, record) };
  }

  // ── P3 [S32]: the hosts' `files:` store (D21) ───────────────────────────

  /** @since P3 [S32] True when this device keeps a `files:` store: every device with the `host` capability. */
  private get hasFileStore(): boolean {
    return this.effectiveCaps.includes('host');
  }

  /** @since P3 [S32] The files of `fs`, by path (code-unit order); empty on a device without a store. */
  files(fs: FileSystemId): readonly StoredFileMeta[] {
    if (fs !== HOST_STORE_FS || !this.hasFileStore) return [];
    const out: StoredFileMeta[] = [];
    for (const path of [...this.fileStore.keys()].sort()) {
      const e = this.fileStore.get(path) as StoredFileEntry;
      out.push(Object.freeze({ fs, path, size: e.size, modifiedAt: e.modifiedAt }));
    }
    return Object.freeze(out);
  }

  /** @since P3 [S32] One file of `fs` with its content, or undefined. */
  readFile(fs: FileSystemId, path: string): StoredFile | undefined {
    if (fs !== HOST_STORE_FS || !this.hasFileStore) return undefined;
    const e = this.fileStore.get(path);
    if (e === undefined) return undefined;
    return Object.freeze({ fs, path, size: e.size, modifiedAt: e.modifiedAt, content: e.content });
  }

  /**
   * @since P3 [S32] The `storage` action: write (create or replace; `modifiedAt` = now) or delete one file of the
   * store. Refused with a runtime debug line on a device without a store, for another file system, a path that is not
   * a flat name, a write without content, or (ruling R20) a write beyond the io limits (`storageWriteProblem`: the name
   * or the content too long, or a new file in a full store); deleting a missing file changes nothing.
   */
  private applyStorage(owner: ProcessName, a: Extract<Action, { type: 'storage' }>, now: SimTime): void {
    if (!this.hasFileStore) {
      this.runtimeDebug(owner, `storage ${a.op} of ${a.path} ignored: this device keeps no files`, now);
      return;
    }
    if (a.fs !== HOST_STORE_FS || !isStoredFileName(a.path)) {
      this.runtimeDebug(owner, `storage ${a.op} of ${a.path} ignored: not a file name of ${HOST_STORE_FS}:`, now);
      return;
    }
    if (a.op === 'delete') {
      this.fileStore.delete(a.path);
      return;
    }
    const file: StoredFileInput | undefined = a.file;
    if (file === undefined || typeof file.content !== 'string') {
      this.runtimeDebug(owner, `storage write of ${a.path} ignored: no content`, now);
      return;
    }
    // ruling R20: the io limits, so every stored file survives export and reload
    const problem = storageWriteProblem(new Set(this.fileStore.keys()), a.path, file.content);
    if (problem !== undefined) {
      this.runtimeDebug(owner, `storage write of ${a.path.length > 64 ? `${a.path.slice(0, 64)}…` : a.path} ignored: ${problem}`, now);
      return;
    }
    this.fileStore.set(a.path, { content: file.content, size: storedFileSize(file.content), modifiedAt: now });
  }

  // ── run-loop entry points ───────────────────────────────────────────────

  onFrameArrival(portId: PortId, pdu: Pdu, corrupted: boolean | undefined, now: SimTime, rx?: FrameRxInfo): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return;
    this.trace.emit({ t: now, kind: 'frameRx', pdu: pduSummary(pdu), device: this.id, port: portId });
    const c = port.counters;
    c.inPackets++;
    c.inBytes += rx?.fragmentBytes ?? pdu.size;
    port.lastInput = now;

    const verdict = frameArrivalVerdict({
      port,
      frame: pdu,
      corrupted,
      rx,
      booted: this.bootedAt !== undefined,
      capabilities: this.effectiveCaps,
      index: this.demuxIndex,
      subinterfaces: this.subinterfacesFor(port),
      groupFilter: true,
      // P3 (D18): the control check on a routed port reads the running daemons (cdp, lldp)
      daemons: this.processes,
    });
    if (verdict.kind === 'subif') {
      // Step 10a hand-over (D11, §3.4 step 3): pop the tag (stamped with this device, cause `encapsulation dot1Q <v>`),
      // count on the subinterface, then steps 10b–15 on it.
      const sub = this.ports.get(verdict.port);
      if (sub === undefined || sub.dot1q === undefined) {
        port.counters.inDrops++;
        this.emitDrop(pdu, 'other', `no-subinterface:${verdict.port}`, port.id);
        return;
      }
      // Steps 3–4 on the subinterface itself (step 5 is inherited from the parent, which already passed): a shut or
      // oper-down subinterface receives nothing, exactly like a physical port.
      if (!sub.adminUp) {
        sub.counters.inDrops++;
        this.emitDrop(pdu, 'port-admin-down', undefined, sub.id);
        return;
      }
      if (!sub.operUp) {
        sub.counters.inDrops++;
        this.emitDrop(pdu, 'link-down', undefined, sub.id);
        return;
      }
      // P3 (D16) step 10c with the subinterface's input policy, BEFORE the pop (so `match cos` sees the PCP), and only
      // when the subinterface will deliver the frame (its verdict previewed on the popped view): a flooded frame for
      // another MAC is never classified or counted (review T9)
      const subPolicy = this.qosDir(sub, 'input');
      // ruling R33: control traffic (keepalives, PPP control, CDP, LLDP, BPDUs) is never classified or counted
      if (subPolicy !== undefined && !isQosControlFrame(pdu)) {
        const preview = subinterfaceVerdict({
          port: sub,
          frame: verdict.pop ? poppedFrameView(pdu) : pdu,
          capabilities: this.effectiveCaps,
          index: this.demuxIndex,
          groupFilter: true,
        });
        if (preview.kind === 'deliver') {
          const r = this.qosStep(sub, subPolicy, 'input', pdu, undefined);
          if (r !== undefined && 'drop' in r) {
            sub.counters.inDrops++;
            this.emitDrop(pdu, 'policed', r.drop, sub.id);
            return;
          }
        }
      }
      if (verdict.pop) this.rewrap(pdu, vlanPopOp(), dot1qCause(sub.dot1q.vid));
      sub.counters.inPackets++;
      sub.counters.inBytes += pdu.size;
      sub.lastInput = now;
      const onSub = subinterfaceVerdict({ port: sub, frame: pdu, capabilities: this.effectiveCaps, index: this.demuxIndex, groupFilter: true });
      const next = this.applyVerdict(sub, pdu, onSub);
      if (next !== undefined) this.applyActions(next.process, next.actions, now);
      return;
    }
    // P3 (D16) step 10c on a `deliver` verdict with the port's own input policy: classify, count, mark, then [S21] police
    if (verdict.kind === 'deliver') {
      const policy = this.qosDir(port, 'input');
      // ruling R33: control traffic (keepalives, PPP control, CDP, LLDP, BPDUs) is never classified or counted
      const r = policy === undefined || isQosControlFrame(pdu) ? undefined : this.qosStep(port, policy, 'input', pdu, undefined);
      if (r !== undefined && 'drop' in r) {
        countIngress(port.counters, verdict.counters);
        port.counters.inDrops++;
        this.emitDrop(pdu, 'policed', r.drop, port.id);
        return;
      }
    }
    const next = this.applyVerdict(port, pdu, verdict);
    if (next !== undefined) this.applyActions(next.process, next.actions, now);
  }

  /** The subinterfaces of a `routed` port for step 10a (undefined on any other port: nothing to classify). */
  private subinterfacesFor(port: PortState): PortState[] | undefined {
    if (effectivePortRole(port, this.effectiveCaps) !== 'routed') return undefined;
    return subinterfacesOf(this.ports.values(), port.id);
  }

  /** A recorded structural rewrite by the runtime itself (D12): stamped with this device and mirrored as `mutation` events. */
  private rewrap(pdu: Pdu, op: RewrapOp, cause: string): void {
    const from = pdu.provenance.length;
    pdu.rewrap({ now: this.clock, device: this.id }, op, cause);
    const prov = pdu.provenance;
    for (let i = from; i < prov.length; i++) {
      this.trace.emit({ t: this.clock, kind: 'mutation', pdu: pdu.id, mutation: prov[i] as NonNullable<(typeof prov)[number]> });
    }
  }

  onTimer(process: ProcessName, key: string, now: SimTime): void {
    this.clock = now;
    const k = timerKey(process, key);
    const pending = this.timers.get(k);
    if (pending === undefined || pending.at !== now) return; // stale: re-armed or cancelled
    this.timers.delete(k);
    const p = this.processes.get(process);
    const ctx = this.ctxs.get(process);
    if (p === undefined || ctx === undefined) return;
    this.applyActions(process, p.onTimer(ctx, key), now);
  }

  onBoot(now: SimTime): void {
    this.clock = now;
    this.bootSeq = undefined;
    if (!this.power || this.bootedAt !== undefined) return;

    // 1. instantiate processes so they receive every config delta; the demux index follows the instances
    for (const name of this.processOrder) {
      const factory = this.deps.catalog.process(name);
      if (factory === undefined) {
        this.emitLog(3, FACILITY_SYS, `Process ${name} is not available on this platform`, now);
        continue;
      }
      const proc = factory();
      this.processes.set(name, proc);
      this.ctxs.set(name, createProcessCtx(this, name, this.deps.rng.split(`process:${name}`)));
    }
    this.demuxIndex = buildDemuxIndex(this.processOrder, this.processes);

    // 2. load configuration: model defaults, then (P2, D2) the defaults of the world's profile, then the startup-config
    //    from NVRAM — or, on the first boot of a device restored from a saved project, its saved running-config
    if (this.model.defaultConfig !== undefined && this.model.defaultConfig.length > 0) {
      this.replayConfig(parseConfigText(this.model.defaultConfig.join('\n')));
    }
    for (const lines of profileConfigLines(this.model, this.profile)) this.replayConfig(parseConfigText(lines.join('\n')));
    const initial = this.pendingRunning ?? this.startup;
    this.pendingRunning = undefined;
    if (initial !== undefined) this.replayConfig(initial);

    // 3. init (after config is loaded)
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.init === undefined) continue;
      this.applyActions(name, p.init(ctx), now);
    }

    // 4. booted; let the link model bring the physical ports up, then derive virtual oper state
    this.bootedAt = now;
    this.trace.emit({ t: now, kind: 'deviceState', device: this.id, power: true, booted: true });
    // P3 [S25]: the start log of the extended-logging default (P3 worlds only), before the ports come up
    if (this.extendedLogging) this.emitLog(EXTENDED_LOG_SEVERITY, FACILITY_SYS, systemStartedMessage(this.model.model), now, LOG_MNEMONIC_BOOTED);
    for (const port of [...this.ports.values()]) {
      if (this.isVirtual(port)) continue;
      this.deps.onPortAdmin({ device: this.id, port: port.id }, port.adminUp, now);
    }
    this.recomputeVirtual(now);
  }

  onPortOper(portId: PortId, operUp: boolean, now: SimTime): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return;
    this.logOperChange(port, operUp, now); // P3 [S25]: P3 worlds only
    this.fanLinkChange(portId, operUp, now);
    this.recomputeVirtual(now);
  }

  /**
   * @since P3 [S25] The extended-logging default's change logs for `port` now `operUp` (P3 worlds only, booted and
   * powered): on a physical port, a link log when its carrier differs from the last one logged — not when the port is
   * administratively down (the P1 admin log already said so); then, on every port, a line-protocol log when `operUp`
   * differs from the last one logged.
   */
  private logOperChange(port: PortState, operUp: boolean, now: SimTime): void {
    if (!this.extendedLogging || !this.power || this.bootedAt === undefined) return;
    if (!this.isVirtual(port)) {
      // an administratively down port counts as without carrier, so `no shutdown` logs the link coming up again
      const carrier = port.adminUp && (port.phy?.carrier ?? operUp);
      if ((this.linkLogged.get(port.id) ?? false) !== carrier) {
        this.linkLogged.set(port.id, carrier);
        if (carrier || port.adminUp) this.emitLog(LINK_LOG_SEVERITY, FACILITY_LINK, linkStateMessage(port.id, carrier), now, LOG_MNEMONIC_UPDOWN);
      }
    }
    if ((this.lineLogged.get(port.id) ?? false) !== operUp) {
      this.lineLogged.set(port.id, operUp);
      this.emitLog(EXTENDED_LOG_SEVERITY, FACILITY_LINEPROTO, lineProtocolMessage(port.id, operUp), now, LOG_MNEMONIC_UPDOWN);
    }
  }

  /**
   * @since P3 [S25] The configuration log of a typed or configure-seam line that changed the running configuration (P3
   * worlds only, booted): once per source — the console, or the configure origin — and dispatch instant.
   */
  private logConfigured(origin: ConfigOrigin | undefined, now: SimTime): void {
    if (!this.extendedLogging || !this.power || this.bootedAt === undefined) return;
    const source = origin === undefined ? 'console' : `${origin.via}|${origin.user ?? ''}|${origin.address ?? ''}`;
    const last = this.lastConfigLog;
    if (last !== undefined && last.at === now && last.source === source) return;
    this.lastConfigLog = { at: now, source };
    this.emitLog(EXTENDED_LOG_SEVERITY, FACILITY_SYS, configurationChangedMessage(origin), now, LOG_MNEMONIC_CONFIGURED);
  }

  onTxOutcome(portId: PortId, outcome: TxOutcome, now: SimTime): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return;
    const c = port.counters;
    switch (outcome.kind) {
      case 'sent':
        c.outPackets++;
        c.outBytes += outcome.bytes;
        port.lastOutput = outcome.txStart;
        return;
      case 'deferred':
        c.deferred = (c.deferred ?? 0) + 1;
        return;
      case 'collision':
        c.collisions++;
        if (outcome.late) c.lateCollisions = (c.lateCollisions ?? 0) + 1;
        return;
      case 'dropped':
        c.outDrops++;
        if (outcome.reason === 'excessive-collisions') c.excessiveCollisions = (c.excessiveCollisions ?? 0) + 1;
        return;
      case 'repeated':
        if (outcome.dir === 'in') {
          c.inPackets++;
          c.inBytes += outcome.bytes;
          port.lastInput = now;
        } else {
          c.outPackets++;
          c.outBytes += outcome.bytes;
          port.lastOutput = now;
        }
        return;
    }
  }

  onMediumEvent(portId: PortId, ev: MediumEvent, now: SimTime): void {
    this.clock = now;
    if (!this.ports.has(portId)) return;
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.onMediumEvent === undefined) continue;
      this.applyActions(name, p.onMediumEvent(ctx, portId, ev), now);
    }
  }

  applyActions(process: ProcessName, actions: Action[], now: SimTime): void {
    this.clock = now;
    const stack: (PendingAction | PendingStep)[] = [];
    for (let i = actions.length - 1; i >= 0; i--) stack.push({ process, action: actions[i] as Action });
    let budget = ACTION_BUDGET;

    while (stack.length > 0) {
      if (budget === 0) {
        // exhausted: drop every pdu still in hand and stop (deferred steps carry none)
        while (stack.length > 0) {
          const left = stack.pop() as PendingAction | PendingStep;
          const pdu = 'action' in left ? pduOf(left.action) : undefined;
          if (pdu !== undefined) this.emitDrop(pdu, 'other', 'action-budget', undefined);
        }
        return;
      }
      budget--;
      const item = stack.pop() as PendingAction | PendingStep;
      const more: ApplyResult = 'action' in item ? this.applyOne(item.process, item.action, now) : item.step();
      if (more === undefined) continue;
      if ('steps' in more) {
        for (let i = more.steps.length - 1; i >= 0; i--) stack.push({ process: item.process, step: more.steps[i] as () => FollowUp | undefined });
        continue;
      }
      for (let i = more.actions.length - 1; i >= 0; i--) stack.push({ process: more.process, action: more.actions[i] as Action });
    }
  }

  /** Apply one action; returns follow-up actions (deliver/request/egress/ingress) or (P2) deferred steps, or undefined. */
  private applyOne(owner: ProcessName, a: Action, now: SimTime): ApplyResult {
    switch (a.type) {
      case 'send':
        return this.applySend(owner, a.port, a.pdu, now);
      case 'deliver': {
        const target = this.processes.get(a.to);
        const ctx = this.ctxs.get(a.to);
        if (target === undefined || ctx === undefined) {
          this.emitDrop(a.pdu, 'unsupported-protocol', `no process ${a.to}`, a.port);
          return undefined;
        }
        return { process: a.to, actions: target.onPdu(ctx, a.pdu, a.port) };
      }
      case 'request': {
        const target = this.processes.get(a.to);
        const ctx = this.ctxs.get(a.to);
        if (target === undefined || ctx === undefined || target.onRequest === undefined) {
          this.runtimeDebug(owner, `request ${a.req.kind} ignored: no process ${a.to}`, now);
          return undefined;
        }
        return { process: a.to, actions: target.onRequest(ctx, a.req) };
      }
      case 'drop':
        // P3 (D12, D13): the policy's `rule` passes through to the trace event
        this.emitDrop(a.pdu, a.reason, a.detail, a.port, a.rule);
        return undefined;
      case 'consume':
        this.trace.emit({ t: now, kind: 'pduConsumed', pdu: pduSummary(a.pdu), device: this.id, process: owner });
        return undefined;
      case 'timer': {
        const k = timerKey(owner, a.key);
        const prev = this.timers.get(k);
        if (prev !== undefined) this.deps.scheduler.cancel(prev.seq);
        const at = now + Math.max(0, Math.round(a.delay));
        const seq = this.deps.scheduler.schedule(
          at,
          a.periodic === true
            ? { kind: 'timer', device: this.id, process: owner, key: a.key, periodic: true }
            : { kind: 'timer', device: this.id, process: owner, key: a.key },
        );
        this.timers.set(k, { seq, at });
        return undefined;
      }
      case 'cancelTimer': {
        const k = timerKey(owner, a.key);
        const prev = this.timers.get(k);
        if (prev !== undefined) {
          this.deps.scheduler.cancel(prev.seq);
          this.timers.delete(k);
        }
        return undefined;
      }
      case 'cliOutput':
        this.deps.cliSink.output(a.session, a.text, now);
        return undefined;
      case 'cliDone':
        this.deps.cliSink.done(a.session, now);
        return undefined;
      case 'setPortL3': {
        const port = this.ports.get(a.port);
        if (port !== undefined) port.l3 = mergePortL3(port.l3, a);
        return undefined;
      }
      case 'log':
        // P3 [S24]: the one log path; the logger's reaction is applied depth-first inside the issuer's budget
        return this.logRecord(owner, a.severity, a.facility, a.message, now, undefined);
      case 'ingress':
        return this.applyIngress(a.port, a.pdu, a.layer, now);
      case 'medium': {
        if (!this.ports.has(a.port)) {
          this.runtimeDebug(owner, `medium request ${a.op.op} on ${a.port} ignored: no medium`, now);
          return undefined;
        }
        this.deps.mediumOp({ device: this.id, port: a.port }, a.op, now);
        return undefined;
      }
      case 'event': {
        // depth-first like `request`; a missing target (or one without onEvent) is only a runtime debug line
        const target = this.processes.get(a.to);
        const ctx = this.ctxs.get(a.to);
        if (target === undefined || ctx === undefined || target.onEvent === undefined) {
          this.runtimeDebug(owner, `event ${a.ev.kind} ignored: no process ${a.to}`, now);
          return undefined;
        }
        return { process: a.to, actions: target.onEvent(ctx, a.ev) };
      }
      // ── P2 (ARCHITECTURE-P2 §2.4) ──
      case 'errDisable':
        this.errDisable(a.port, a.cause, a.detail, now);
        return undefined;
      case 'errRecover':
        this.errRecover(a.port, a.cause, now);
        return undefined;
      case 'l2Changed':
        return { steps: this.l2ChangedSteps(owner, a, now) };
      case 'configLine': {
        // a daemon's own line (sticky MACs): no configuration log (P3 [S25])
        const result = this.applyLine(a.context.map((c) => [...c]), [...a.line], a.negate, undefined, false);
        if (!result.ok) this.runtimeDebug(owner, `config line "${a.negate ? 'no ' : ''}${a.line.join(' ')}" refused: ${result.error ?? 'unknown reason'}`, now);
        return undefined;
      }
      // ── P2 wireless (ARCHITECTURE-P2 §2.4, §3.12 step 4; W4 device) ──
      case 'radio-profile':
        this.radioProfile(owner, a.port, a.bss, a.controller, now);
        return undefined;
      // ── P3 (ARCHITECTURE-P3 §2.4; W1 device) ──
      case 'configure':
        this.scheduleConfigure(owner, a, now);
        return undefined;
      case 'clock':
        this.rebaseClock(owner, a, now);
        return undefined;
      case 'virtualChanged':
        // [S18] the tunnel owner wrote a `tunnels` row: the tunnel's line protocol follows it
        this.recomputeVirtual(now);
        return undefined;
      case 'remoteCli':
      case 'cliRemote':
        // [S13] (D14): the Simulation applies it to its CliRuntime in the event's own dispatch
        this.scheduleEvent({ kind: 'remoteCli', device: this.id, from: owner, act: copyRemoteAct(a) }, now);
        return undefined;
      case 'storage':
        this.applyStorage(owner, a, now);
        return undefined;
      default:
        return undefined;
    }
  }

  /** @since P3 Schedule `body` at `now` (zero delay, never periodic) through the existing scheduler dep (D14, D21). */
  private scheduleEvent(body: SimEventBody, now: SimTime): void {
    this.deps.scheduler.schedule(now, body);
  }

  /**
   * @since P3 The `configure` action (D21): schedule SimEvent `deviceConfigure` at `now` (zero delay, non-periodic) with a
   * copy of the lines and options; nothing is applied here. In that event's dispatch the Simulation runs
   * `cliCore.configure` with the origin and delivers `config.result` to `owner`.
   */
  private scheduleConfigure(owner: ProcessName, a: Extract<Action, { type: 'configure' }>, now: SimTime): void {
    const opts: { atomic?: boolean; indentation?: boolean; origin: ConfigOrigin } = { origin: copyOrigin(a.origin) };
    if (a.atomic !== undefined) opts.atomic = a.atomic;
    if (a.indentation !== undefined) opts.indentation = a.indentation;
    this.scheduleEvent({ kind: 'deviceConfigure', device: this.id, from: owner, token: a.token, lines: [...a.lines], opts }, now);
  }

  /**
   * @since P2 (wireless; W4 device) The `radio-profile` action: store (`null` = clear) the controller profile of radio
   * `portId` as a frozen, index-ordered copy together with the pushing controller's name (when the action carries
   * one), then `deps.onPortPhyConfig` so the link model re-reads `radioSettings` (the BSS starts, changes or stops). A
   * profile replaces the previous one whole, name included. A port that does not exist or is not a radio is ignored
   * with a runtime debug line and no link-model call.
   */
  private radioProfile(owner: ProcessName, portId: PortId, bss: readonly BssSettings[] | null, controller: string | undefined, now: SimTime): void {
    const port = this.ports.get(portId);
    if (port === undefined || port.spec.radio === undefined || !RADIO_KINDS.includes(port.spec.kind)) {
      this.runtimeDebug(owner, `radio profile for ${portId} ignored: not a radio`, now);
      return;
    }
    if (bss === null) this.radioProfiles.delete(portId);
    else this.radioProfiles.set(portId, controller === undefined ? { bss: copyRadioProfile(bss) } : { bss: copyRadioProfile(bss), controller });
    this.deps.onPortPhyConfig?.({ device: this.id, port: portId }, now);
  }

  /**
   * @since P2 The `l2Changed` fan-out (D6): one step per other L2 daemon present (`L2_PROCESSES` order, the issuer
   * skipped, daemons without `onEvent` skipped) delivering `l2.changed`, then one step recomputing virtual oper state.
   * Each target is looked up when its step runs, after the previous target's actions were applied.
   */
  private l2ChangedSteps(issuer: ProcessName, a: Extract<Action, { type: 'l2Changed' }>, now: SimTime): (() => FollowUp | undefined)[] {
    const steps: (() => FollowUp | undefined)[] = [];
    for (const name of L2_PROCESSES) {
      if (name === issuer || !this.processes.has(name)) continue;
      steps.push(() => {
        const target = this.processes.get(name);
        const ctx = this.ctxs.get(name);
        if (target === undefined || ctx === undefined || target.onEvent === undefined) return undefined;
        const ev: L2ChangedEvent = { kind: 'l2.changed', what: a.what, from: issuer };
        if (a.port !== undefined) ev.port = a.port;
        if (a.vlan !== undefined) ev.vlan = a.vlan;
        return { process: name, actions: target.onEvent(ctx, ev) };
      });
    }
    steps.push(() => {
      this.recomputeVirtual(now);
      return undefined;
    });
    return steps;
  }

  /**
   * @since P2 Err-disable `portId` for `cause` (the `errDisable` action and `errDisablePort`): no-op when the port is
   * unknown or already err-disabled; otherwise set the cause, emit `portState` reason `err-disabled` and a severity-4
   * log, let the link model recompute the link (a physical port goes down) and recompute virtual oper state.
   */
  private errDisable(portId: PortId, cause: ErrDisableCause, detail: string | undefined, now: SimTime): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined || port.errDisabled !== undefined) return;
    port.errDisabled = cause;
    this.emitPortState(portId, 'err-disabled');
    this.emitLog(4, FACILITY_LINK, errDisabledMessage(portId, cause, detail), now);
    if (!this.isVirtual(port)) this.deps.onPortAdmin({ device: this.id, port: portId }, port.adminUp, now);
    this.recomputeVirtual(now);
  }

  /**
   * @since P2 Clear `cause` from `portId` (the `errRecover` action): no-op unless the port is err-disabled for exactly
   * `cause`; otherwise clear it, emit `portState` reason `err-recovered` and a severity-5 log, let the link model
   * recompute (up again when admin up and cabled) and recompute virtual oper state.
   */
  private errRecover(portId: PortId, cause: ErrDisableCause, now: SimTime): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined || port.errDisabled !== cause) return;
    delete port.errDisabled;
    this.emitPortState(portId, 'err-recovered');
    this.emitLog(5, FACILITY_LINK, errRecoveredMessage(portId, cause), now);
    if (!this.isVirtual(port)) this.deps.onPortAdmin({ device: this.id, port: portId }, port.adminUp, now);
    this.recomputeVirtual(now);
  }

  /** @since P2 Fault path (`err-disable` fault, lab-check clone): the same effects as an `errDisable` action. */
  errDisablePort(port: PortId, cause: ErrDisableCause, now: SimTime): void {
    this.errDisable(port, cause, undefined, now);
  }

  /** §3.2 egress by the role's egress trait. */
  private applySend(owner: ProcessName, portId: PortId, pdu: Pdu, now: SimTime): { process: ProcessName; actions: Action[] } | undefined {
    const port = this.ports.get(portId);
    if (port === undefined) {
      this.emitDrop(pdu, 'other', `unknown-port:${portId}`, undefined);
      return undefined;
    }
    const role = effectivePortRole(port, this.effectiveCaps);
    const egress = ROLE_TRAITS[role].egress;
    if (egress === 'owner') {
      const ownerName = this.model.portOwners?.[role];
      if (ownerName === undefined) {
        this.emitDrop(pdu, 'other', `no-owner:${role}`, portId);
        return undefined;
      }
      if (ownerName === owner) {
        this.emitDrop(pdu, 'other', 'virtual-transmit', portId);
        return undefined;
      }
      const proc = this.processes.get(ownerName);
      const ctx = this.ctxs.get(ownerName);
      if (proc === undefined || ctx === undefined || proc.onEgress === undefined) {
        this.emitDrop(pdu, 'other', `no-owner:${role}`, portId);
        return undefined;
      }
      this.countOut(port, pdu.size, now);
      return { process: ownerName, actions: proc.onEgress(ctx, pdu, portId) };
    }
    if (egress === 'loop') {
      this.countOut(port, pdu.size, now);
      return { process: owner, actions: [{ type: 'ingress', port: portId, pdu, layer: loopIngressLayer(pdu) }] };
    }
    if (egress === 'parent') {
      // P2 (D11, §3.4 step 3): count on the subinterface, push its tag unless native, transmit on the parent.
      const parent = port.spec.parent === undefined ? undefined : this.ports.get(port.spec.parent);
      if (parent === undefined) {
        this.emitDrop(pdu, 'other', `no-parent:${portId}`, portId);
        return undefined;
      }
      if (port.dot1q === undefined) {
        this.emitDrop(pdu, 'other', DEVICE_CONFIG_MESSAGES.subinterfaceNoEncapsulation, portId);
        return undefined;
      }
      // a shut or oper-down subinterface transmits nothing (the link model gates the parent only)
      if (!port.adminUp) {
        port.counters.outDrops++;
        this.emitDrop(pdu, 'port-admin-down', undefined, portId);
        return undefined;
      }
      if (!port.operUp) {
        port.counters.outDrops++;
        this.emitDrop(pdu, 'link-down', undefined, portId);
        return undefined;
      }
      const policy = this.qosDir(port, 'output');
      if (policy === undefined) {
        this.countOut(port, pdu.size, now);
        if (!port.dot1q.native) this.rewrap(pdu, vlanPushOp(port.dot1q.vid), dot1qCause(port.dot1q.vid));
        this.transmitOn(parent, pdu, now);
        return undefined;
      }
      // P3 (D16, §3.0 (a) step 9): the subinterface's output policy runs right after the push, keyed by the
      // subinterface (`transmitOn` only sees the parent), so `set cos` writes the pushed tag's PCP; [S21] a runtime
      // policer drop counts on the subinterface and never reaches the parent
      const bytes = pdu.size;
      if (!port.dot1q.native) this.rewrap(pdu, vlanPushOp(port.dot1q.vid), dot1qCause(port.dot1q.vid));
      const r = isQosControlFrame(pdu) ? undefined : this.qosStep(port, policy, 'output', pdu, undefined);
      if (r !== undefined && 'drop' in r) {
        port.counters.outDrops++;
        this.emitDrop(pdu, 'policed', r.drop, portId);
        return undefined;
      }
      this.countOut(port, bytes, now);
      this.transmitOn(parent, pdu, now);
      return undefined;
    }
    this.transmitOn(port, pdu, now);
    return undefined;
  }

  /**
   * The link egress (`ROLE_TRAITS[role].egress === 'link'`, and the parent of a subinterface): `deps.transmit` and the
   * port's counters. P3 (D16, §3.0 (a) step 9): a routed physical port's output policy classifies, marks and [S21]
   * polices first; [S20] a scheduler port (`egressPolicy`) gets the frame's class as `{qosClass}`. A port with neither
   * calls `deps.transmit` exactly as before (three arguments).
   */
  private transmitOn(port: PortState, pdu: Pdu, now: SimTime): void {
    const portId = port.id;
    let opts: TransmitOptions | undefined;
    const policy = this.qosDir(port, 'output');
    // ruling R33: control traffic (keepalives, PPP control, CDP, LLDP, BPDUs) is never classified, counted or given a
    // class; a scheduler port's link model sends it ahead of the class queues
    if (policy !== undefined && !isQosControlFrame(pdu)) {
      const scheduler = this.schedulerOf(port);
      const r = this.qosStep(port, policy, 'output', pdu, scheduler);
      if (r !== undefined && 'drop' in r) {
        port.counters.outDrops++;
        this.emitDrop(pdu, 'policed', r.drop, portId);
        return;
      }
      // [S20] the class index is the position in the scheduler spec (one spec class per policy class)
      if (scheduler !== undefined && r !== undefined) opts = { qosClass: r.cls };
    }
    // Read the size before transmit: the air medium rewraps the pdu in place (Ethernet -> 802.11), and outBytes
    // counts the frame as the port handed it over, matching inBytes on the receive side.
    const bytes = pdu.size;
    const ref = { device: this.id, port: portId };
    const res = opts === undefined ? this.deps.transmit(ref, pdu, now) : this.deps.transmit(ref, pdu, now, opts);
    if (res.ok) {
      // Deferred (segment media): counters arrive later through onTxOutcome.
      if (res.deferred !== true) {
        port.counters.outPackets++;
        port.counters.outBytes += bytes;
        port.lastOutput = res.txStart;
        if (res.retries !== undefined && res.retries > 0) port.counters.txRetries = (port.counters.txRetries ?? 0) + res.retries;
      }
    } else {
      port.counters.outDrops++;
    }
  }

  /** The `ingress` action (§3.1 last paragraph): steps 11–15 on `portId` starting at `layer`. */
  private applyIngress(portId: PortId, pdu: Pdu, layer: DemuxLayer | undefined, now: SimTime): { process: ProcessName; actions: Action[] } | undefined {
    const port = this.ports.get(portId);
    if (port === undefined) {
      this.emitDrop(pdu, 'other', `unknown-port:${portId}`, undefined);
      return undefined;
    }
    if (this.isVirtual(port)) {
      port.counters.inPackets++;
      port.counters.inBytes += pdu.size;
      port.lastInput = now;
    }
    const verdict = ingressVerdict({ port, frame: pdu, layer, capabilities: this.effectiveCaps, index: this.demuxIndex, groupFilter: true });
    return this.applyVerdict(port, pdu, verdict);
  }

  /** Count a verdict's receive counters, then emit its drop or return the target's onPdu actions. */
  private applyVerdict(port: PortState, pdu: Pdu, verdict: FrameVerdict): { process: ProcessName; actions: Action[] } | undefined {
    countIngress(port.counters, verdict.counters);
    if (verdict.kind === 'drop') {
      this.emitDrop(pdu, verdict.reason, verdict.detail, port.id);
      return undefined;
    }
    const target = this.processes.get(verdict.process);
    const ctx = this.ctxs.get(verdict.process);
    if (target === undefined || ctx === undefined) {
      port.counters.inDrops++;
      this.emitDrop(pdu, 'unsupported-protocol', `no process ${verdict.process}`, port.id);
      return undefined;
    }
    return { process: verdict.process, actions: target.onPdu(ctx, pdu, port.id) };
  }

  private countOut(port: PortState, bytes: number, now: SimTime): void {
    port.counters.outPackets++;
    port.counters.outBytes += bytes;
    port.lastOutput = now;
  }

  // ── P3 (D16, §3.0 (a) step 9 and (b) step 10c, §3.5, §3.11; W3 device): QoS ──────────────────────────────────

  /**
   * @since P3 A port's QoS view (M13, `PortSnapshot.qos`): undefined without a `service-policy` line on a port whose
   * role applies it. `input` / `output` name the attached policy-maps; `classes` lists the input policy's classes in
   * policy order (class-default last), then the output policy's (none for a policy-map that does not exist), each with
   * its matched packets and bytes and the frames a `set` line applied to; [S21] (ruling R26) a class whose `police`
   * the runtime runs carries its conform and exceed counts (`police`); an output policer the link scheduler enforces
   * (a `transmit`/`drop` pair on a scheduler port) is counted there (`LinkModel.egressQueues`), not here.
   */
  qosCounters(portId: PortId): PortQosView | undefined {
    const port = this.ports.get(portId);
    if (port === undefined) return undefined;
    const att = this.qosAttachments().get(portId);
    if (att === undefined || (att.input === undefined && att.output === undefined)) return undefined;
    if (!qosPolicyRole(effectivePortRole(port, this.effectiveCaps))) return undefined;
    const classes: PortQosView['classes'][number][] = [];
    for (const dir of QOS_DIRECTIONS) {
      const st = this.qosDir(port, dir);
      const policy = st?.policy;
      if (st === undefined || policy === undefined) continue;
      const scheduler = dir === 'output' ? this.schedulerOf(port) : undefined;
      policy.classes.forEach((c, i) => {
        const k = st.counts.get(c.name);
        const row: PortQosView['classes'][number] = { name: c.name, matched: k?.matched ?? 0, matchedBytes: k?.matchedBytes ?? 0, marked: k?.marked ?? 0 };
        if (c.police !== undefined && scheduler?.classes[i]?.police === undefined) {
          const e = st.policers.get(c.name);
          const p = e !== undefined && e.key === policerKey(qosPolicerSpecOf(c.police)) ? e.policer : undefined;
          row.police = { conform: p?.conform ?? 0, conformBytes: p?.conformBytes ?? 0, exceed: p?.exceed ?? 0, exceedBytes: p?.exceedBytes ?? 0 };
        }
        classes.push(row);
      });
    }
    return { ...(att.input !== undefined ? { input: att.input } : {}), ...(att.output !== undefined ? { output: att.output } : {}), classes };
  }

  /** @since P3 (D16) The interface attachments at the current generation and port version (rebuilt when either moved). */
  private qosAttachments(): ReadonlyMap<PortId, QosAttachment> {
    const idx = this.qosIndex;
    if (idx !== undefined && idx.gen === this.qosGen && idx.version === this.version) return idx.ports;
    const ports = readQosAttachments(this.runningAst);
    this.qosIndex = { gen: this.qosGen, version: this.version, ports };
    return ports;
  }

  /**
   * @since P3 (D16) The policy `port` applies in `dir`: undefined without a `service-policy` line there or on a role
   * that takes none (`QOS_POLICY_ROLES`). The compiled policy is kept per (port, direction) with the generation and
   * port version it was compiled at; a stale one recompiles through the pure reader (`compileQosPolicy`), keeping the
   * counters and policers of the same policy-map; a removed or renamed attachment starts from zero.
   */
  private qosDir(port: PortState, dir: QosDirection): QosDirState | undefined {
    const att = this.qosAttachments().get(port.id);
    const name = att === undefined ? undefined : att[dir];
    if (name === undefined) {
      if (this.qosDirs.size > 0) this.qosDirs.delete(`${port.id}|${dir}`);
      return undefined;
    }
    if (!qosPolicyRole(effectivePortRole(port, this.effectiveCaps))) return undefined;
    const key = `${port.id}|${dir}`;
    let st = this.qosDirs.get(key);
    if (st === undefined || st.name !== name) {
      st = { name, gen: -1, version: -1, policy: undefined, counts: new Map(), policers: new Map() };
      this.qosDirs.set(key, st);
    }
    if (st.gen !== this.qosGen || st.version !== this.version) {
      st.policy = compileQosPolicy(this.runningAst, name, this.qosCompile);
      st.gen = this.qosGen;
      st.version = this.version;
    }
    return st;
  }

  /**
   * @since P3 (D16, §3.5 step 3, §3.11 step 6) One QoS step for `pdu` at `port` with the policy of `st`: classify
   * (`classifyQos`; on input the arrival port answers `match input-interface`), count it (matched, and marked when a
   * `set` line applies), mark it (`Pdu.mutate(…, 'QosMark', 'policy-map P class C set …')`, each followed by the
   * derived ChecksumRecompute and FcsRecompute records, mirrored as `mutation` events), then [S21] police the class
   * after the marking unless `scheduler` enforces that class's policer: a `drop` action answers `{drop: detail}`, a
   * `set-dscp-transmit` rewrites the DSCP (`QosMark` again). Undefined when the policy-map does not exist.
   */
  private qosStep(port: PortState, st: QosDirState, dir: QosDirection, pdu: Pdu, scheduler: EgressSchedulerSpec | undefined): QosStepResult | undefined {
    const policy = st.policy;
    if (policy === undefined) return undefined;
    const facts = qosPacketFacts(pdu, dir === 'input' ? port.id : undefined);
    const { index: cls, name } = classifyQos(policy, facts);
    const bytes = pdu.size;
    let count = st.counts.get(name);
    if (count === undefined) {
      count = { matched: 0, matchedBytes: 0, marked: 0 };
      st.counts.set(name, count);
    }
    count.matched++;
    count.matchedBytes += bytes;
    const plan = planQosMarking(policy, cls, facts);
    if (plan.marked) count.marked++;
    this.qosMutate(pdu, plan.mutations);
    const police = policy.classes[cls]?.police;
    if (police === undefined || scheduler?.classes[cls]?.police !== undefined) return { cls };
    const spec = qosPolicerSpecOf(police);
    const key = policerKey(spec);
    let entry = st.policers.get(name);
    if (entry === undefined || entry.key !== key) {
      entry = { key, policer: createQosPolicer(spec, this.clock) };
      st.policers.set(name, entry);
    }
    const verdict = policeQosPacket(entry.policer, bytes, this.clock);
    const markdown = planQosPoliceMarkdown(policy, cls, verdict, qosFactsAfter(facts, plan.mutations));
    if (!markdown.transmit) {
      return { drop: verdict === 'exceed' ? qosPolicedDetail(name, 'police', spec.rateBps) : qosPoliceConformDropDetail(name, spec.rateBps) };
    }
    this.qosMutate(pdu, markdown.mutations);
    return { cls };
  }

  /** @since P3 (D16) Apply marking rewrites with this device's stamp (`QosMark`), mirroring every new provenance record. */
  private qosMutate(pdu: Pdu, mutations: readonly QosMarkMutation[]): void {
    for (const m of mutations) {
      const from = pdu.provenance.length;
      pdu.mutate({ now: this.clock, device: this.id }, m.field, m.value, 'QosMark', m.cause);
      const prov = pdu.provenance;
      for (let i = from; i < prov.length; i++) {
        this.trace.emit({ t: this.clock, kind: 'mutation', pdu: pdu.id, mutation: prov[i] as NonNullable<(typeof prov)[number]> });
      }
    }
  }

  // ── [S20]/[S21] (§7 W3, the approved items): the delimited block of the device QoS item — the egress scheduler spec, ──
  //    `{qosClass}` (in `transmitOn`), the scheduler PHY lines (in `applyLine`); input policing is in `qosStep` ──

  /**
   * @since P3 [S20] The compiled output scheduler of a physical port (read by the link model through
   * `LinkModelDeps.egressPolicy`): its output policy when that policy queues (`priority`, `bandwidth`, `queue-limit`,
   * [S21] `fair-queue`, `shape`) and passes the 75 % admission against the port's reference rate (its `bandwidth` line,
   * else its routing bandwidth — the rate `service-policy output` admitted it against), else [S21] interface
   * `fair-queue`; undefined otherwise (the virtual FIFO, D16), and on every virtual port. The object stays the same
   * while its content does, so the link model can compare it by identity.
   */
  egressPolicy(portId: PortId): EgressSchedulerSpec | undefined {
    const port = this.ports.get(portId);
    return port === undefined ? undefined : this.egressEntry(port)?.spec;
  }

  /** @since P3 [S20] The scheduler spec compiled from `port`'s output policy (undefined for none, or a `fair-queue` one). */
  private schedulerOf(port: PortState): EgressSchedulerSpec | undefined {
    const e = this.egressEntry(port);
    return e !== undefined && e.fromPolicy ? e.spec : undefined;
  }

  /**
   * @since P3 [S20] The egress scheduler entry of a physical port with a `service-policy output` or [S21] `fair-queue`
   * line (undefined for any other port), recompiled when the generation, the port version or the reference rate moved
   * (`compileEgressScheduler`; the reference rate without a `bandwidth` line is the routing bandwidth, as the
   * `service-policy output` admission check reads it). A policy the admission refuses gives no spec. An unchanged
   * recompile keeps the previous spec object.
   */
  private egressEntry(port: PortState): EgressSpecEntry | undefined {
    const att = this.qosAttachments().get(port.id);
    if (att === undefined || (att.output === undefined && att.fairQueue !== true)) return undefined;
    const role = effectivePortRole(port, this.effectiveCaps);
    if (ROLE_TRAITS[role].virtual || !qosPolicyRole(role)) return undefined;
    // ruling R34: the one QoS reference rate (the `bandwidth` line, else the routing bandwidth), as the CLI admits against
    const refBps = qosPortReferenceRateBps(this.runningAst, port.id, role, port.speedBps ?? port.spec.speedBps);
    const cached = this.egressSpecs.get(port.id);
    if (cached !== undefined && cached.gen === this.qosGen && cached.version === this.version && cached.refBps === refBps) return cached;
    const compiled = compileEgressScheduler(this.runningAst, port.id, refBps, this.qosCompile);
    const admitted = compiled !== undefined && (compiled.source === 'fair-queue' || compiled.admission.ok) ? compiled : undefined;
    const fresh = admitted?.spec;
    const key = fresh === undefined ? '' : JSON.stringify(fresh);
    const spec = fresh !== undefined && cached?.spec !== undefined && cached.key === key ? cached.spec : fresh;
    const entry: EgressSpecEntry = { gen: this.qosGen, version: this.version, refBps, spec, fromPolicy: admitted?.source === 'policy', key };
    this.egressSpecs.set(port.id, entry);
    return entry;
  }

  /**
   * @since P3 [S20] After a QoS delta: tell the link model (`onPortPhyConfig`, where it re-reads `egressPolicy`) about
   * every physical port whose scheduler spec changed — a policy-map body or an interface `bandwidth` can change one —
   * except `told`, the line's own port, already told as a scheduler PHY line. A world with no spec before or after
   * (every P1/P2 world) tells nothing.
   */
  private syncEgressSpecs(now: SimTime, told: PortId | undefined): void {
    let any = this.egressKnown.size > 0;
    if (!any) {
      for (const a of this.qosAttachments().values()) {
        if (a.output !== undefined || a.fairQueue === true) {
          any = true;
          break;
        }
      }
    }
    if (!any) return;
    for (const port of this.ports.values()) {
      if (this.isVirtual(port)) continue;
      const spec = this.egressEntry(port)?.spec;
      if (spec === this.egressKnown.get(port.id)) continue;
      if (spec === undefined) this.egressKnown.delete(port.id);
      else this.egressKnown.set(port.id, spec);
      if (port.id !== told) this.deps.onPortPhyConfig?.({ device: this.id, port: port.id }, now);
    }
  }

  // ── end of the [S20]/[S21] block ──

  /** @since P3 (D16) Forget the QoS state of the whole device (power-off: the running configuration is gone). */
  private qosReset(): void {
    this.qosGen++;
    this.qosIndex = undefined;
    this.qosDirs.clear();
    this.egressSpecs.clear();
    this.egressKnown.clear();
  }

  // ── config ──────────────────────────────────────────────────────────────

  /**
   * Apply one configuration line (see the file header). P3 (D21): `origin` (the configure seam's, absent for typed
   * lines) is copied into every `configChange` event this line produces, so P1/P2 events keep their bytes.
   */
  applyConfigLine(context: string[][], line: string[], negate: boolean, origin?: ConfigOrigin): { ok: boolean; error?: string } {
    return this.applyLine(context, line, negate, origin, true);
  }

  /**
   * `applyConfigLine`; P3 [S25]: `user` is false for a daemon's `configLine` action, which logs no configuration change
   * (a typed or configure-seam line logs one, `logConfigured`).
   */
  private applyLine(context: string[][], line: string[], negate: boolean, origin: ConfigOrigin | undefined, user: boolean): { ok: boolean; error?: string } {
    const now = this.clock;
    if (line.length === 0 || line[0] === undefined || line[0] === '') return { ok: false, error: 'Empty configuration line' };
    const first = context[0];
    const key = line[0];
    let ifacePort: PortState | undefined;
    if (first !== undefined && first[0] === 'interface') {
      const name = first[1];
      ifacePort = name === undefined ? undefined : this.ports.get(name);
      if (ifacePort === undefined && name !== undefined && this.isCreatableName(name)) {
        const made = this.ensureVirtualPort(name, now);
        if (!made.ok) return { ok: false, error: made.error };
        ifacePort = this.ports.get(made.port);
      }
      if (ifacePort === undefined) return { ok: false, error: `Unknown interface ${name ?? ''}`.trimEnd() };
    }

    // global `interface N` / `no interface N`: virtual interface create and remove (§3.10; P2: subinterfaces too)
    if (context.length === 0 && key === 'interface') {
      const name = line[1];
      if (name === undefined || name === '') return { ok: false, error: 'An interface name is required' };
      if (negate) return this.removeVirtualPortWith(name, now, origin);
      if (!this.ports.has(name)) {
        if (!this.isCreatableName(name)) return { ok: false, error: `Unknown interface ${name}` };
        const made = this.ensureVirtualPort(name, now);
        if (!made.ok) return { ok: false, error: made.error };
      }
    }

    if (key === 'hostname' && !negate && (line[1] === undefined || line[1] === '')) {
      return { ok: false, error: 'A host name is required' };
    }

    // interface special cases decided BEFORE the AST changes
    if (ifacePort !== undefined && key === 'switchport' && line.length === 1) {
      const target: PortRole = negate ? 'routed' : specRole(ifacePort.spec, this.effectiveCaps);
      const flipped = this.setPortRoleWith(ifacePort.id, target, now, origin);
      if (!flipped.ok) return flipped;
    }
    if (ifacePort !== undefined && key === 'encapsulation') {
      if (effectivePortRole(ifacePort, this.effectiveCaps) === 'subif') {
        // P2 (§3.4 step 2): `encapsulation dot1Q <vid> [native]` sets the subinterface's tag; its `no` form clears it
        const dot1q = this.checkDot1q(ifacePort, negate ? undefined : line.slice(1));
        if (!dot1q.ok) return { ok: false, error: dot1q.error };
        if (dot1q.dot1q === undefined) delete ifacePort.dot1q;
        else ifacePort.dot1q = dot1q.dot1q;
      } else if (line[1] !== undefined && line[1].toLowerCase() === DOT1Q_ENCAPSULATION) {
        return { ok: false, error: fill(CLI_MESSAGES.encapNotHere, { port: ifacePort.id }) };
      } else {
        const encap = this.checkEncapsulation(ifacePort, negate ? undefined : line[1]);
        if (!encap.ok) return { ok: false, error: encap.error };
        ifacePort.encap = encap.encap;
      }
    }

    // P2 (D2, §5): every apply carries the device's default slots (the completeness rule)
    let delta = this.runningAst.apply(context, line, negate, { defaults: this.defaultSlots });
    if (delta === undefined && negate && context.length === 0 && key !== 'hostname' && DEFAULT_CONFIG_RULES.ruleFor(context, line)?.negationRestoresDefault !== true) {
      // `no <something>` that removes nothing at global level is kept as a `no` line (round-trip); not for a rule whose
      // `no` form means "back to the default" (P2 `spanning-tree mode`): the default is already what the slot holds
      delta = this.runningAst.set([], ['no', ...line]);
    }

    if (key === 'hostname') {
      const name = negate ? this.spec.name : (line[1] as string);
      this.hostname = name;
      if (negate) this.runningAst.set([], ['hostname', this.spec.name]);
    }
    if (key === 'shutdown' && ifacePort !== undefined) {
      this.setPortAdmin(ifacePort.id, negate, now);
    }

    if (delta === undefined) return { ok: true };
    // P3 (D16): a delta a compiled policy or a scheduler spec reads moves the QoS configuration generation, so the next
    // frame (or the next egressPolicy read) recompiles
    const qosDelta = isQosConfigDelta(delta);
    if (qosDelta) this.qosGen++;
    // an attachment that changes (set or removed) starts its counters and policers from zero
    if (qosDelta && ifacePort !== undefined && key === 'service-policy') {
      for (const dir of QOS_DIRECTIONS) if (line[1] === undefined || line[1] === dir) this.qosDirs.delete(`${ifacePort.id}|${dir}`);
    }
    this.fanOutConfig(delta, now);
    // P3 [C13] (ruling R36): the IPsec pre-shared key never reaches the trace: its `configChange` carries the masked line
    // (the existing `maskSecretTokens`); [S19] (§10.1 `accept.p3.ppp-chap`: the CHAP secret in no trace) in a P3-profile
    // world the global `username <n> [privilege <l>] password <pw>` line (the password CHAP and PAP read) is masked the
    // same way. Every other line, and that line in a P1/P2 world, is traced as typed (P1/P2 bytes unchanged).
    const traced = key === 'pre-shared-key' || this.masksUserPassword(context, line) ? maskSecretTokens(context, line) : line;
    this.emitConfigChange(traced.join(' '), negate, context.map((c) => c.slice()), origin, now);
    // P2 (§3.0 "Virtual oper state"): a recompute site after the lines that change what an SVI, a Port-channel or a
    // subinterface derives its state from (the daemons wrote their rows in the fan-out above)
    if (VIRTUAL_RECOMPUTE_KEYS.includes(key)) this.recomputeVirtual(now);
    // [S20]/[S21] (D16): `service-policy output` and interface `fair-queue` are PHY lines of physical ports too
    // (`isSchedulerPhyLine`), so the link model re-reads the port's scheduler spec
    const phyPort =
      ifacePort !== undefined && !this.isVirtual(ifacePort) && (PHY_CONFIG_KEYS.includes(key) || isSchedulerPhyLine(line)) ? ifacePort.id : undefined;
    if (phyPort !== undefined) this.deps.onPortPhyConfig?.({ device: this.id, port: phyPort }, now);
    if (qosDelta) this.syncEgressSpecs(now, phyPort);
    // P3 [S25]: the configuration log of the extended-logging default (P3 worlds only)
    if (user) this.logConfigured(origin, now);
    return { ok: true };
  }

  /**
   * @since P2 `encapsulation dot1Q <vid> [native]` on subinterface `port` (`args` = the tokens after `encapsulation`;
   * undefined = the `no` form, which clears the tag). Refused with original wording when the arguments are not an
   * 802.1Q line, and with `CLI_MESSAGES.duplicateVid` when a sibling subinterface of the same parent already carries
   * the VID (§3.4 step 2).
   */
  private checkDot1q(port: PortState, args: readonly string[] | undefined): { ok: true; dot1q: PortState['dot1q'] | undefined } | { ok: false; error: string } {
    if (args === undefined) return { ok: true, dot1q: undefined };
    if (args[0] === undefined || args[0].toLowerCase() !== DOT1Q_ENCAPSULATION) return { ok: false, error: DEVICE_CONFIG_MESSAGES.subinterfaceEncapsulation };
    const parsed = parseDot1qArgs(args);
    if (parsed === undefined) return { ok: false, error: DEVICE_CONFIG_MESSAGES.dot1qArguments };
    if (port.spec.parent !== undefined) {
      for (const other of subinterfacesOf(this.ports.values(), port.spec.parent)) {
        if (other.id !== port.id && other.dot1q !== undefined && other.dot1q.vid === parsed.vid) {
          return { ok: false, error: fill(CLI_MESSAGES.duplicateVid, { vlan: parsed.vid, other: other.id }) };
        }
      }
    }
    return { ok: true, dot1q: { vid: parsed.vid, native: parsed.native } };
  }

  /** True when `name` is a virtual interface this model can create (a family instance, or P2 a subinterface name). */
  private isCreatableName(name: PortId): boolean {
    return parseVirtualPortName(this.model, name) !== undefined || parseSubinterfaceName(name) !== undefined;
  }

  /** @since P2 Parse a saved configuration text with the device's default slots (explicit negations of D are kept, §5). */
  private parseSavedConfig(text: string): ConfigAst {
    return parseConfigText(text, DEFAULT_CONFIG_RULES, { defaults: this.defaultSlots });
  }

  /**
   * `encapsulation X` on `port` (undefined value = `no encapsulation`, back to the spec default). P3 [S19] (§9.2 item
   * 30): `ppp` is accepted on a serial WAN port (a router's serial interface); a serial access line stays HDLC-only.
   */
  private checkEncapsulation(port: PortState, value: string | undefined): { ok: true; encap: NonNullable<PortState['encap']> } | { ok: false; error: string } {
    if (port.spec.kind !== 'serial') return { ok: false, error: DEVICE_CONFIG_MESSAGES.encapsulationNotSerial };
    if (value === undefined) return { ok: true, encap: specEncap(port.spec) };
    if (value === 'hdlc') return { ok: true, encap: 'hdlc' };
    if (value === 'ppp') {
      // [S19] PPP runs on direct serial cables between routers only (D17)
      if (effectivePortRole(port, this.effectiveCaps) !== 'wan') return { ok: false, error: DEVICE_CONFIG_MESSAGES.pppAccessLine };
      return { ok: true, encap: 'ppp' };
    }
    return { ok: false, error: fill(DEVICE_CONFIG_MESSAGES.encapsulationUnknown, { encap: value }) };
  }

  /** Notify every process of `delta` (daemon order), then apply all collected actions in order. */
  private fanOutConfig(delta: ConfigDelta, now: SimTime): void {
    if (this.processes.size === 0) return;
    const collected: { process: ProcessName; actions: Action[] }[] = [];
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined) continue;
      collected.push({ process: name, actions: p.onConfig(ctx, delta) });
    }
    for (const c of collected) this.applyActions(c.process, c.actions, now);
  }

  /**
   * Replay a stored config tree through `applyConfigLine` (cli/config-text replay lines) so processes see every
   * line. An `interface` section line only makes sure its port exists (creating virtual interfaces); a section
   * naming an interface this device cannot have is logged once and its lines are skipped.
   */
  private replayConfig(ast: ConfigAst): void {
    const skipped: PortId[] = [];
    for (const l of configTextLinesOf(ast.root)) {
      const first = l.context[0];
      if (first !== undefined && first[0] === 'interface') {
        if (skipped.includes(first[1] ?? '')) continue;
        this.applyConfigLine(l.context, l.tokens, l.negate);
        continue;
      }
      if (l.context.length === 0 && l.tokens[0] === 'interface' && !l.negate) {
        const name = l.tokens[1] ?? '';
        if (this.ports.has(name)) continue;
        const made = this.isCreatableName(name) ? this.ensureVirtualPort(name, this.clock) : undefined;
        if (made === undefined || !made.ok) {
          skipped.push(name);
          this.emitLog(4, FACILITY_SYS, `Startup configuration refers to an unknown interface ${name}`.trimEnd(), this.clock);
        }
        continue;
      }
      this.applyConfigLine(l.context, l.tokens, l.negate);
    }
  }

  // ── PHY and radio settings ──────────────────────────────────────────────

  /** The running-config `interface` section of a port, if any. */
  private interfaceNode(port: PortId): ConfigNode | undefined {
    return this.runningAst.root.children.find((n) => n.key === 'interface' && n.args[0] === port);
  }

  phySettings(portId: PortId): PortPhySettings {
    const out: PortPhySettings = { speed: 'auto', duplex: 'auto' };
    const node = this.interfaceNode(portId);
    if (node === undefined) return out;
    for (const child of node.children) {
      const arg = child.args[0];
      if (child.key === 'speed' && arg !== undefined) {
        const mbps = Number(arg);
        if (arg !== 'auto' && Number.isSafeInteger(mbps) && mbps > 0) out.speed = mbps * MBPS;
      } else if (child.key === 'duplex' && (arg === 'full' || arg === 'half' || arg === 'auto')) {
        out.duplex = arg;
      } else if (child.key === 'clock' && arg === 'rate') {
        const bps = Number(child.args[1]);
        if (Number.isSafeInteger(bps) && bps > 0) out.clockRateBps = bps;
      }
    }
    return out;
  }

  radioSettings(portId: PortId): RadioSettings | undefined {
    const port = this.ports.get(portId);
    const radio = port?.spec.radio;
    if (port === undefined || radio === undefined || !RADIO_KINDS.includes(port.spec.kind)) return undefined;
    const lines = new Map<string, string[]>();
    for (const child of this.interfaceNode(portId)?.children ?? []) lines.set(child.key, child.args);
    const text = (key: string): string | undefined => {
      const args = lines.get(key);
      return args === undefined || args.length === 0 ? undefined : args.join(' ');
    };

    const bandArg = text('band');
    const band: RfBand = bandArg !== undefined && (radio.bands as readonly string[]).includes(bandArg) ? (bandArg as RfBand) : radio.defaultBand;
    const channelArg = text('channel');
    let channel: number | 'auto';
    if (channelArg === 'auto') channel = 'auto';
    else if (channelArg !== undefined && Number.isSafeInteger(Number(channelArg))) channel = Number(channelArg);
    else if (band === radio.defaultBand) channel = radio.defaultChannel;
    else channel = band === 'cell' ? radio.defaultChannel : (CHANNELS[band][0] ?? radio.defaultChannel);
    let widthMhz: ChannelWidthMhz = 20;
    const widthArg = Number(text('channel-width'));
    if (band === '60') widthMhz = 2160;
    else if ((CHANNEL_WIDTHS as readonly number[]).includes(widthArg) && widthArg <= radio.maxWidthMhz) widthMhz = widthArg as ChannelWidthMhz;
    const powerArg = Number(text('tx-power'));
    const txPowerDbm = text('tx-power') !== undefined && Number.isSafeInteger(powerArg) ? Math.min(powerArg, radio.maxTxPowerDbm) : radio.maxTxPowerDbm;
    const securityArg = text('security');
    const security: WifiSecurity = securityArg !== undefined && (WIFI_SECURITIES as readonly string[]).includes(securityArg) ? (securityArg as WifiSecurity) : 'open';

    const out: RadioSettings = { band, channel, widthMhz, txPowerDbm, security };
    const ssid = text('ssid');
    if (ssid !== undefined) out.ssid = ssid;
    const passphrase = text('passphrase');
    if (passphrase !== undefined) out.passphrase = passphrase;
    const peerKey = text('peer-key');
    if (peerKey !== undefined) out.peerKey = peerKey;
    if (lines.has('beacons')) out.emitBeacons = true;
    // P2 (wireless, §3.12 step 4): a stored controller profile overlays the BSS members; without one, the P0.5 render
    // above is returned untouched (byte-identical)
    const profile = this.radioProfiles.get(portId);
    return profile === undefined ? out : overlayRadioProfile(out, profile.bss, profile.controller);
  }

  // ── device-level operations ─────────────────────────────────────────────

  setPortAdmin(portId: PortId, adminUp: boolean, now: SimTime): void {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return;
    const role = effectivePortRole(port, this.effectiveCaps);
    if (!ROLE_TRAITS[role].configurable) return;
    // keep the running-config in step even when called directly (CLI device op); P2: through the completeness rule
    this.runningAst.apply([['interface', portId]], ['shutdown'], adminUp, { defaults: this.defaultSlots });
    // P2 (D12): `shutdown` clears an err-disable cause, so the following `no shutdown` brings the port back.
    if (!adminUp && port.errDisabled !== undefined) delete port.errDisabled;
    if (port.adminUp === adminUp) return;
    port.adminUp = adminUp;
    this.trace.emit({ t: now, kind: 'portState', device: this.id, port: portId, adminUp, operUp: port.operUp, reason: adminUp ? 'admin-up' : 'admin-down' });
    this.emitLog(3, FACILITY_LINK, adminUp ? `Interface ${portId} administratively enabled` : `Interface ${portId} administratively down`, now);
    if (ROLE_TRAITS[role].virtual) {
      if (adminUp) this.logUnsupportedVlan(port, now);
      this.recomputeVirtual(now);
      return;
    }
    this.deps.onPortAdmin({ device: this.id, port: portId }, adminUp, now);
  }

  setPower(on: boolean, now: SimTime): void {
    this.clock = now;
    if (on === this.power) return;
    this.power = on;
    if (on) {
      this.bootedAt = undefined;
      this.bootSeq = this.deps.scheduler.schedule(now + this.model.bootNs, { kind: 'boot', device: this.id });
      this.trace.emit({ t: now, kind: 'deviceState', device: this.id, power: true, booted: false });
      return;
    }
    // power off: RAM state is lost
    if (this.bootSeq !== undefined) {
      this.deps.scheduler.cancel(this.bootSeq);
      this.bootSeq = undefined;
    }
    this.pendingRunning = undefined;
    // onShutdown (P1): each daemon may say goodbye (DHCP RELEASE, …) before RAM is lost. Actions apply now, while the
    // ports are still up; the links go down right after, and any timer armed here is cancelled with the rest below.
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.onShutdown === undefined) continue;
      this.applyActions(name, p.onShutdown(ctx), now);
    }
    for (const t of this.timers.values()) this.deps.scheduler.cancel(t.seq);
    this.timers.clear();
    for (const change of recomputeVirtualOper(this.ports, { power: false, booted: false }, this.effectiveCaps, now)) {
      this.emitPortState(change.port, change.reason);
    }
    this.processes.clear();
    this.ctxs.clear();
    this.debugRings.clear();
    this.demuxIndex = buildDemuxIndex([], new Map());
    this.airResolved = false;
    this.airCache = undefined;
    this.radioProfiles.clear(); // P2 (wireless): a controller profile is RAM
    this.clockBase = undefined; // P3 (D19): no hardware calendar — the next boot starts unset again (the files stay)
    // P3 [S25]: what the change logs last reported is RAM (the next boot logs its ports coming up again)
    this.linkLogged.clear();
    this.lineLogged.clear();
    this.lastConfigLog = undefined;
    for (const name of this.tables.names()) this.tables.get(name)?.clear('cleared');
    this.hostname = this.spec.name;

    // virtual interfaces other than the auto ones only exist in the lost running-config
    const created: PortId[] = [];
    for (const port of this.ports.values()) {
      if (port.spec.kind !== 'virtual') continue;
      const parsed = parseVirtualPortName(this.model, port.id);
      if (parsed === undefined || !isAutoInstance(parsed.family, parsed.number)) created.push(port.id);
    }
    if (created.length > 0) {
      removePorts(this.ports, this.model, created);
      this.version++;
    }
    let rolesChanged = false;
    for (const port of this.ports.values()) {
      const before = port.role;
      resetPortForPowerOff(port, { capabilities: this.effectiveCaps, portsDefaultUp: this.model.portsDefaultUp }, now);
      if (before !== undefined && before !== port.role) rolesChanged = true;
    }
    if (rolesChanged) this.version++;
    this.runningAst = this.freshRunning();
    this.qosReset(); // P3 (D16): compiled policies, QoS counters, policers and scheduler specs are RAM
    this.bootedAt = undefined;
    this.trace.emit({ t: now, kind: 'deviceState', device: this.id, power: false, booted: false });
    for (const port of [...this.ports.values()]) {
      if (this.isVirtual(port)) continue;
      this.deps.onPortAdmin({ device: this.id, port: port.id }, false, now);
    }
  }

  reload(now: SimTime): void {
    this.setPower(false, now);
    this.setPower(true, now);
  }

  saveConfig(): void {
    this.startup = this.runningAst.clone();
  }

  eraseStartup(): void {
    this.startup = undefined;
  }

  // ── roles (§3.10 switchport / no switchport) ────────────────────────────

  setPortRole(portId: PortId, role: PortRole, now: SimTime): { ok: boolean; error?: string } {
    return this.setPortRoleWith(portId, role, now, undefined);
  }

  /** `setPortRole`; P3 (D21): `origin` is stamped on the address withdrawal's `configChange` (the line's own event). */
  private setPortRoleWith(portId: PortId, role: PortRole, now: SimTime, origin: ConfigOrigin | undefined): { ok: boolean; error?: string } {
    this.clock = now;
    const port = this.ports.get(portId);
    if (port === undefined) return { ok: false, error: fill(DEVICE_CONFIG_MESSAGES.unknownInterface, { name: portId }) };
    const current = effectivePortRole(port, this.effectiveCaps);
    const allowed = port.spec.allowedRoles ?? [specRole(port.spec, this.effectiveCaps)];
    if (!allowed.includes(role) || !ROLE_KINDS[role].includes(port.spec.kind)) return { ok: false, error: CLI_MESSAGES.roleLocked };
    if (current === role) return { ok: true };

    // leaving an L3 role withdraws the address (processes see the unset delta and remove C/L routes)
    if (ROLE_TRAITS[current].l3 && !ROLE_TRAITS[role].l3) {
      const configured = this.interfaceNode(portId)?.children.some((c) => c.key === 'ip' && c.children.some((leaf) => leaf.key === 'address')) === true;
      if (configured || port.l3.ipv4 !== undefined) this.applyConfigLine([['interface', portId]], ['ip', 'address'], true, origin);
    }
    const wasUp = port.operUp;
    if (wasUp) this.fanLinkChange(portId, false, now);
    port.role = role;
    this.demuxIndex = buildDemuxIndex(this.processOrder, this.processes);
    this.version++;
    this.emitPortState(portId, 'role-change');
    if (wasUp) this.fanLinkChange(portId, true, now);
    this.recomputeVirtual(now);
    return { ok: true };
  }

  // ── virtual interfaces (§3.10) ──────────────────────────────────────────

  ensureVirtualPort(name: PortId, now: SimTime): { ok: true; port: PortId; created: boolean } | { ok: false; error: string } {
    this.clock = now;
    if (!this.ports.has(name) && parseSubinterfaceName(name) !== undefined) return this.ensureSubinterface(name, now);
    const plan = planVirtualPort(this.model, this.ports, name, this.effectiveCaps);
    if (!plan.ok) return { ok: false, error: plan.error };
    if (!plan.created) return { ok: true, port: plan.port, created: false };
    const state = createVirtualPortState(plan.family, plan.number, this.macBase);
    insertPorts(this.ports, this.model, [state]);
    seedInterfaceSection(this.runningAst, state, this.effectiveCaps);
    this.version++;
    this.emitPortState(state.id, 'virtual-created');
    if (state.adminUp) this.logUnsupportedVlan(state, now);
    this.recomputeVirtual(now);
    return { ok: true, port: state.id, created: true };
  }

  /**
   * @since P2 `interface <parent>.<n>` (D11, §3.4 step 1): a `subif` port with the parent's MAC, ordinal and MTU,
   * administratively up, its own interface section, `portState` reason `virtual-created`; it stays down until
   * `encapsulation dot1Q` is set (`no-encapsulation`).
   */
  private ensureSubinterface(name: PortId, now: SimTime): { ok: true; port: PortId; created: boolean } | { ok: false; error: string } {
    const plan = planSubinterface(this.model, this.ports, name, this.effectiveCaps);
    if (!plan.ok) return { ok: false, error: plan.error };
    if (!plan.created) return { ok: true, port: plan.port, created: false };
    const parent = this.ports.get(plan.parent) as PortState;
    const state = createSubinterfacePortState(parent, plan.number);
    insertPorts(this.ports, this.model, [state]);
    seedInterfaceSection(this.runningAst, state, this.effectiveCaps);
    this.version++;
    this.emitPortState(state.id, 'virtual-created');
    this.recomputeVirtual(now);
    return { ok: true, port: state.id, created: true };
  }

  removeVirtualPort(name: PortId, now: SimTime): { ok: boolean; error?: string } {
    return this.removeVirtualPortWith(name, now, undefined);
  }

  /** `removeVirtualPort`; P3 (D21): `origin` is stamped on every `configChange` of the removal (`no interface N`). */
  private removeVirtualPortWith(name: PortId, now: SimTime, origin: ConfigOrigin | undefined): { ok: boolean; error?: string } {
    this.clock = now;
    const check = checkVirtualPortRemoval(this.model, this.ports, name);
    if (!check.ok) return { ok: false, error: check.error };
    const port = this.ports.get(name) as PortState;
    const context: string[][] = [['interface', name]];
    const section = this.interfaceNode(name);
    if (section !== undefined) {
      // unset the section's lines first so every process sees them go (the address withdraws its routes)
      const lines = configTextLinesOf({ key: '', args: [], children: [section] });
      for (const l of lines) {
        if (l.context.length !== 1 || l.negate || l.tokens[0] === 'shutdown') continue;
        this.applyConfigLine(context, l.tokens, true, origin);
      }
      const delta = this.runningAst.unset([], ['interface', name]);
      if (delta !== undefined) {
        this.fanOutConfig(delta, now);
        this.emitConfigChange(`interface ${name}`, true, [], origin, now);
      }
    }
    if (port.operUp) {
      port.operUp = false;
      port.lastChange = now;
      this.fanLinkChange(name, false, now);
    }
    removePorts(this.ports, this.model, [name]);
    this.lineLogged.delete(name); // P3 [S25]: a re-created interface starts unlogged
    // P3 (D16): a re-created interface starts with fresh QoS counters
    for (const dir of QOS_DIRECTIONS) this.qosDirs.delete(`${name}|${dir}`);
    this.egressSpecs.delete(name);
    this.egressKnown.delete(name);
    this.version++;
    this.trace.emit({ t: now, kind: 'portState', device: this.id, port: name, adminUp: port.adminUp, operUp: false, reason: 'virtual-removed' });
    return { ok: true };
  }

  // ── modules (D7, §3.11) ─────────────────────────────────────────────────

  insertModule(slotId: SlotId, type: ModuleType, now: SimTime): HardwareResult {
    this.clock = now;
    const slot = this.slotSpec(slotId);
    if (slot === undefined) return this.hardwareError('no-such-slot', { model: this.model.model, slot: slotId });
    const mod = this.moduleModel(type);
    if (mod === undefined) return this.hardwareError('unknown-module', { module: type });
    if (!SLOT_ACCEPTS[slot.type].includes(mod.fits)) return this.hardwareError('does-not-fit', { module: mod.model, slotType: slot.type });
    if (this.power) return this.hardwareError('powered-on', { device: this.hostname });
    const occupant = this.installed.get(slot.id);
    if (occupant !== undefined) return this.hardwareError('slot-occupied', { slot: slot.id, module: this.moduleModel(occupant)?.model ?? occupant });

    this.installed.set(slot.id, mod.type);
    this.reorderInstalled();
    this.effectiveCaps = this.computeCapabilities();
    const states = this.moduleStates(slot, mod, this.buildContext());
    if (states.length > 0) {
      insertPorts(this.ports, this.model, states);
      for (const s of states) seedInterfaceSection(this.runningAst, s, this.effectiveCaps);
    }
    this.applyCageTransceiver(slot.id, mod.type);
    this.hardwareChanged();
    return { ok: true };
  }

  removeModule(slotId: SlotId, now: SimTime): HardwareResult & { removedPorts?: readonly PortId[] } {
    this.clock = now;
    const slot = this.slotSpec(slotId);
    if (slot === undefined) return this.hardwareError('no-such-slot', { model: this.model.model, slot: slotId });
    if (!this.installed.has(slot.id)) return this.hardwareError('slot-empty', { slot: slot.id });
    if (this.power) return this.hardwareError('powered-on', { device: this.hostname });

    const removed = this.modulePorts(slot.id);
    if (removed.length > 0) removePorts(this.ports, this.model, removed);
    if (slot.cage !== undefined) {
      const cage = this.ports.get(slot.cage);
      if (cage !== undefined) delete cage.transceiver;
    }
    this.installed.delete(slot.id);
    this.effectiveCaps = this.computeCapabilities();
    this.hardwareChanged();
    return { ok: true, removedPorts: removed };
  }

  modulePorts(slotId: SlotId): readonly PortId[] {
    const out: PortId[] = [];
    for (const port of this.ports.values()) if (port.spec.module !== undefined && port.spec.slot === slotId) out.push(port.id);
    return out;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private isVirtual(port: Pick<PortState, 'role' | 'spec'>): boolean {
    return ROLE_TRAITS[effectivePortRole(port, this.effectiveCaps)].virtual;
  }

  private buildContext(): PortBuildContext {
    return { macBase: this.macBase, capabilities: this.effectiveCaps, portsDefaultUp: this.model.portsDefaultUp };
  }

  private slotSpec(id: SlotId): SlotSpec | undefined {
    return (this.model.slots ?? []).find((s) => s.id === id);
  }

  private moduleModel(type: ModuleType): ModuleModel | undefined {
    return this.deps.catalog.module?.(type);
  }

  /** Installs sorted by the model's slot order (unknown slots keep their relative order at the end). */
  private orderInstalls(installs: readonly { slot: SlotId; module: ModuleType }[]): { slot: SlotId; module: ModuleType }[] {
    const slots = this.model.slots ?? [];
    const rank = (slot: SlotId): number => {
      const at = slots.findIndex((s) => s.id === slot);
      return at < 0 ? slots.length : at;
    };
    return installs.map((install, i) => ({ install, i })).sort((a, b) => rank(a.install.slot) - rank(b.install.slot) || a.i - b.i).map((e) => ({ slot: e.install.slot, module: e.install.module }));
  }

  /** Refill `installed` in model slot order and mirror it into `spec.modules`. */
  private reorderInstalled(): void {
    const ordered = this.orderInstalls([...this.installed].map(([slot, module]) => ({ slot, module })));
    this.installed.clear();
    for (const i of ordered) this.installed.set(i.slot, i.module);
    this.spec.modules = ordered.map((i) => ({ slot: i.slot, module: i.module }));
  }

  /** Port states a module adds in `slot` (none for transceivers, which become the cage port's `transceiver`). */
  private moduleStates(slot: SlotSpec, mod: ModuleModel, build: PortBuildContext): PortState[] {
    if (mod.ports.length === 0) return [];
    return modulePortSpecs({ capabilities: this.model.capabilities ?? [] }, slot, mod).map((spec) => createPortState(spec, spec.ordinal ?? 0, build));
  }

  private applyCageTransceiver(slotId: SlotId, type: ModuleType): void {
    const slot = this.slotSpec(slotId);
    const mod = this.moduleModel(type);
    if (slot?.cage === undefined || mod === undefined || mod.ports.length > 0) return;
    const cage = this.ports.get(slot.cage);
    if (cage !== undefined) cage.transceiver = mod.type;
  }

  /** After a module change: spec mirror, daemons, tables, RF view, ports version. */
  private hardwareChanged(): void {
    this.reorderInstalled();
    this.processOrder = this.computeProcessOrder();
    this.tables.sync(this.computeTableNames());
    this.airResolved = false;
    this.airCache = undefined;
    this.version++;
  }

  private hardwareError(code: HardwareErrorCode, values: Readonly<Record<string, string>>): { ok: false; code: HardwareErrorCode; error: string } {
    return { ok: false, code, error: fill(HARDWARE_MESSAGES[code], values) };
  }

  /** Model capabilities plus the capabilities of installed modules (expanded, CAPABILITIES order). */
  private computeCapabilities(): readonly Capability[] {
    const added: Capability[] = [];
    for (const type of this.installed.values()) for (const c of this.moduleModel(type)?.capabilitiesAdded ?? []) added.push(c);
    if (added.length === 0) return this.model.capabilities ?? [];
    return expandCapabilities([...(this.model.capabilities ?? []), ...added]);
  }

  /** `model.processes`, plus the daemons of module-added capabilities, ordered by PROCESS_ORDER. */
  private computeProcessOrder(): readonly ProcessName[] {
    const base = this.model.capabilities ?? [];
    if (this.effectiveCaps.length === base.length && this.effectiveCaps.every((c) => base.includes(c))) return this.model.processes;
    const all: ProcessName[] = [...this.model.processes];
    for (const p of deriveProcesses(this.effectiveCaps, CATALOG_STAGE)) if (!all.includes(p)) all.push(p);
    const rank = (name: ProcessName): number => {
      const at = PROCESS_ORDER.indexOf(name);
      return at < 0 ? PROCESS_ORDER.length : at;
    };
    return all.map((name, i) => ({ name, i })).sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i).map((e) => e.name);
  }

  /** Declared tables: `model.tables`, plus the tables of the effective daemons. */
  private computeTableNames(): readonly TableName[] {
    return orderTableNames([...(this.model.tables ?? []), ...deriveTables(this.processOrder)]);
  }

  /** Factory-default running-config: hostname plus one interface section per configurable port (Map order). */
  private freshRunning(): ConfigAst {
    const ast = createConfigAst();
    seedRunningConfig(ast, this.spec.name, this.ports.values(), this.effectiveCaps);
    return ast;
  }

  /** Fan `onLinkChange(port, up)` out in daemon order, applying each process's actions at once. */
  private fanLinkChange(portId: PortId, up: boolean, now: SimTime): void {
    for (const name of this.processOrder) {
      const p = this.processes.get(name);
      const ctx = this.ctxs.get(name);
      if (p === undefined || ctx === undefined || p.onLinkChange === undefined) continue;
      this.applyActions(name, p.onLinkChange(ctx, portId, up), now);
    }
  }

  /** Recompute virtual oper state; per change emit `portState` then fan `onLinkChange` out. */
  private recomputeVirtual(now: SimTime): void {
    const changes = recomputeVirtualOper(this.ports, { power: this.power, booted: this.bootedAt !== undefined }, this.effectiveCaps, now, this.virtualLookups());
    for (const change of changes) {
      this.emitPortState(change.port, change.reason);
      const port = this.ports.get(change.port);
      if (port !== undefined) this.logOperChange(port, change.operUp, now); // P3 [S25]: P3 worlds only
      this.fanLinkChange(change.port, change.operUp, now);
    }
  }

  // ── P2 virtual oper lookups (ARCHITECTURE-P2 §3.0 "Virtual oper state", D6) ──

  /** @since P2 True when this device runs the `vlan` daemon (D5): the SVI rule becomes the VLAN-aware one. */
  private get vlanAware(): boolean {
    return isVlanAware({ processes: this.processOrder });
  }

  /** @since P2 Does VLAN `vlan` exist here: implicit (1, 1002–1005) or a `vlans` row. */
  private vlanExists(vlan: number): boolean {
    if (isImplicitVlan(vlan)) return true;
    return this.tables.get('vlans')?.has(vlanKey(vlan)) === true;
  }

  /** @since P2 The `etherchannel` row of member `port`, if any. */
  private channelRowOf(port: PortId): EtherchannelRow | undefined {
    return this.tables.get<EtherchannelRow>('etherchannel')?.get(port);
  }

  /** @since P2 Member ports whose `etherchannel` row names `bundle` with state `bundled`, in row order. */
  private bundledMembers(bundle: PortId): PortId[] {
    const rows = this.tables.get<EtherchannelRow>('etherchannel')?.rows() ?? [];
    const out: PortId[] = [];
    for (const r of rows) if (r.bundle === bundle && r.state === 'bundled') out.push(r.port);
    return out;
  }

  /** @since P2 The L2 view of a bridged port for `carries` (§3.0): its switchport lines and its oper mode. */
  private l2ViewOf(port: PortState): L2PortView {
    const role = effectivePortRole(port, this.effectiveCaps);
    const config = readSwitchport(this.runningAst, port.id, this.model);
    const dtp = this.tables.get<DtpRow>('dtp');
    const oper = role === 'channel'
      ? channelOperOf(config, this.bundledMembers(port.id).map((m) => dtp?.get(m)))
      : operOf(config, dtp?.get(port.id));
    return { port: port.id, config, oper, role };
  }

  /**
   * @since P2 The SVI carrier test of the VLAN-aware rule: bridged port `portId` counts for `Vlan<vlan>` when it is
   * not a non-`individual` member of a bundle, carries `vlan` (`carries` ≠ undefined) and, when spanning tree runs
   * for `vlan` (an `stp-bridge` row), forwards in it. Oper up and the bridged role are checked by the rule itself.
   */
  private sviCarrier(portId: PortId, vlan: number): boolean {
    const port = this.ports.get(portId);
    if (port === undefined) return false;
    const member = this.channelRowOf(portId);
    if (member !== undefined && member.state !== 'individual') return false;
    if (carries(this.l2ViewOf(port), vlan, (v) => this.vlanExists(v)) === undefined) return false;
    if (this.tables.get('stp-bridge')?.has(vlanKey(vlan)) !== true) return true;
    return this.tables.get<StpPortRow>('stp')?.get(stpKey(vlan, portId))?.state === 'forwarding';
  }

  /**
   * @since P2 The lookups injected into `recomputeVirtualOper`: `bundledMembers` always (a device without
   * `etherchannel` rows has no bundled member, which is the P1 answer), the two SVI lookups only on a VLAN-aware
   * device (elsewhere the P1 SVI rule applies unchanged).
   */
  private virtualLookups(): VirtualOperLookups {
    const bundledMembers = (bundle: PortId): readonly PortId[] => this.bundledMembers(bundle);
    // P3 [S18] (D17): a tunnel port's line protocol is its `tunnels` row (no row, no table: down)
    const tunnelState = (port: PortId): TunnelRow | undefined => this.tables.get<TunnelRow>('tunnels')?.get(port);
    if (!this.vlanAware) return { bundledMembers, tunnelState };
    return {
      vlanExists: (vlan) => this.vlanExists(vlan),
      sviCarrier: (port, vlan) => this.sviCarrier(port, vlan),
      bundledMembers,
      tunnelState,
    };
  }

  /**
   * Log why an administratively enabled SVI stays down: on a VLAN-aware device (P2) an SVI whose VLAN does not exist
   * (`vlanMissingMessage`, §9.2 W4 item 16); elsewhere an SVI other than Vlan1 (`vlanUnsupportedMessage`, P1 wording).
   */
  private logUnsupportedVlan(port: PortState, now: SimTime): void {
    if (effectivePortRole(port, this.effectiveCaps) !== 'svi') return;
    if (this.vlanAware) {
      const vlan = sviVlanOf(port.id);
      if (vlan === undefined || this.vlanExists(vlan)) return;
      this.emitLog(4, FACILITY_SYS, vlanMissingMessage(port.id, vlan), now);
      return;
    }
    const parsed = parseVirtualPortName(this.model, port.id);
    if (parsed === undefined || parsed.number === SVI_SUPPORTED_VLAN) return;
    this.emitLog(4, FACILITY_SYS, vlanUnsupportedMessage(port.id), now);
  }

  private emitPortState(portId: PortId, reason: string | undefined): void {
    const port = this.ports.get(portId);
    if (port === undefined) return;
    const ev: Extract<TraceEvent, { kind: 'portState' }> = { t: this.clock, kind: 'portState', device: this.id, port: portId, adminUp: port.adminUp, operUp: port.operUp };
    if (reason !== undefined) ev.reason = reason;
    this.trace.emit(ev);
  }

  private emitDrop(pdu: Pdu, reason: DropReason, detail: string | undefined, port: PortId | undefined, rule?: DropRule): void {
    const ev: Extract<TraceEvent, { kind: 'drop' }> = { t: this.clock, kind: 'drop', pdu: pduSummary(pdu), device: this.id, reason };
    if (port !== undefined) ev.port = port;
    if (detail !== undefined) ev.detail = detail;
    // P2 (§2.7): a dropped background PDU (keepalive, beacon, BPDU at a host, HSRP hello) is marked so the trace
    // filter, the canvas markers and the sim-mode list can hide it by default
    if (pdu.meta.background === true) ev.background = true;
    // P3 (D12, D13): why a policy dropped it; absent on every P1/P2 drop
    if (rule !== undefined) ev.rule = rule;
    // P3 (§2.2): an ACL denial that names a port counts on it (`acl-deny` is first emitted in P3)
    if (reason === 'acl-deny' && port !== undefined) {
      const p = this.ports.get(port);
      if (p !== undefined) p.counters.aclDenies = (p.counters.aclDenies ?? 0) + 1;
    }
    this.trace.emit(ev);
  }

  /** The `configChange` event of one applied line; P3 (D21): `origin` only when the configure seam passed one. */
  private emitConfigChange(line: string, negate: boolean, context: string[][], origin: ConfigOrigin | undefined, now: SimTime): void {
    const ev: Extract<TraceEvent, { kind: 'configChange' }> = { t: now, kind: 'configChange', device: this.id, line, negate, context };
    if (origin !== undefined) ev.origin = copyOrigin(origin);
    this.trace.emit(ev);
  }

  private runtimeDebug(process: ProcessName, message: string, now: SimTime): void {
    const ev: DebugEvent = { at: now, device: this.id, process, category: 'runtime', message };
    this.recordDebug(ev);
    this.trace.emit({ t: now, kind: 'debug', event: ev });
  }
}

/**
 * Create the runtime for `spec`. If `spec.power` is true a `boot` event is scheduled at
 * `now + model.bootNs`. Throws when `spec.type` is not in the catalog or `spec.modules` is invalid
 * (unknown slot or module, a module that does not fit, two modules in one slot) — before any state exists.
 */
export function createDevice(spec: DeviceSpec, deps: DeviceRuntimeDeps, now: SimTime): DeviceRuntime {
  return new DeviceRuntimeImpl(spec, deps, now);
}
