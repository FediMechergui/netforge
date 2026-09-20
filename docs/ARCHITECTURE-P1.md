# NetForge — P0.5 (catalog, media, wireless) and P1 (CCNA 1): binding architecture brief

> **Status: P0.5 complete — exit gate W7 applied on 2026-09-18** (§8.1 W7, record in §12.1). P1 (§8.2) is next.
> Everything deliberately left for later is listed in §11 and §12.1.

This is the binding brief for the next two builds. Read it together with the contracts, which are the
interfaces every module compiles against:

- `packages/engine/src/contracts/*.ts`, especially the new `catalog.ts`, `rf.ts`, `medium.ts`,
  `transport.ts`, `services.ts`, `capture.ts`, `scenario.ts` and `fields.ts`
- `apps/web/src/bridge/protocol.ts`
- `apps/web/src/store/types.ts`

`docs/ARCHITECTURE.md` (P0) stays in force. Where this document differs, this document wins.

Other sources:

- Spec: `docs/netforge-spec.md`, sections §1.6, §2.1, §4, §5, §7–§10, §12, §13, §16 and §19.
- Device data: `docs/CATALOG.md`.
- Field names: `contracts/fields.ts`. It supersedes `docs/FIELDS.md` and folds in its corrections.

---

## 0. Rules for implementers

1. **One owner per file, build waves.** §8 gives each file exactly one owner and a wave. A module in wave N may
   depend only on waves < N, plus the contracts (wave 0, done).
2. **TRANSITION RULE.** Every contract member tagged `@since P0.5` or `@since P1` is optional in the type only,
   so that P0 code and hand-written fixtures still compile.
   - The wave item that implements a member removes its `?` in the same change and migrates the fixtures.
   - Code written in later waves may rely on the member being present.
   - The exit gates (§8.1 W7, §8.2 W8) remove any `?` that is left. They also delete `CommandSpec.kinds`,
     `PERIODIC_TIMER_KEYS`, `macFromIndex`, `DeviceRuntimeDeps.nextPortIndex`, `LinkModelDeps.deviceKind`,
     `DeviceCatalog.canonicalPort` and the P0 `setPortL3` replace fallback.
3. **Contract changes after wave 0** follow P0 rule 9: make the minimal additive fix and report it.
4. **Every change keeps all four checks green:**
   - `npx tsc -p packages/engine/tsconfig.json`
   - `npx vitest run --root packages/engine`
   - `cd apps/web && npx tsc -p tsconfig.json`
   - `npx vitest run --root apps/web`

   Never run `npm install` without architect approval. Never weaken or delete a test. Pinned values change only
   through the migration list (§9).
5. **Silence rule.** No daemon may emit unsolicited traffic without configuration (§5.3). Adding daemons to P0
   models therefore never changes P0 scenario traffic.
6. **Legal (D13).** Names, help, errors, show output, banners, icons and lab text are original. Model names are
   `NF-…` and follow CATALOG.md.

---

## 1. Fixed decisions D1–D14 and the chosen designs

**D1 — Two stages, one contract set.**

P0.5 delivers:
- the CATALOG.md device and module catalog;
- media v2: every cable type, serial clocking, hub collision domains with CSMA/CD;
- the Wi-Fi air medium with association and AP bridging;
- PtP radio links and cellular attach;
- modules;
- headless configure (D9) and snapshot deltas;
- web: palette v2, icons, cable picker, wireless overlays, device GUI panels, keyboard canvas.

P1 delivers CCNA 1:
- TCP, UDP, sockets and netstat;
- DHCPv4 server, client and relay, with APIPA fallback;
- DNS server, client and cache;
- HTTP server and the Desktop browser;
- IPv6 addressing, NDP, SLAAC, DAD, ICMPv6 and dual stack;
- traceroute (UDP mode on routers, ICMP mode on hosts);
- config-driven speed/duplex negotiation and mismatch symptoms;
- passwords, banners and login;
- the subnetting workbench and the IPv6 explorer;
- simulation mode with breakpoints, filters and step;
- NetScope: display filters, follow stream, statistics, pcap/pcapng import and export;
- the CCNA 1 labs.

RESERVED (names and ports only, no daemons): FTP, TFTP, SMTP, POP3, IMAP, NTP, SNMP, Syslog, Telnet, SSH,
HTTPS/TLS, DHCPv6, PPP, VLANs and NAT. The browser answers `https:` URLs with an original "not simulated"
message.

**D2 — Capability-driven.**
- `DeviceModel` v2 (contracts/device.ts) keeps `kind` only as the icon/palette family. `kind` must equal the
  type-id prefix, and nothing branches behaviour on it.
- `defineModel` (device/catalog/define.ts) derives these fields from the vocabulary in contracts/catalog.ts:
  - `capabilities`: the CAPABILITY_IMPLIES closure.
  - `processes`: CAPABILITY_PROCESSES filtered by `CATALOG_STAGE`, ordered by PROCESS_ORDER.
  - `tables`: from PROCESS_TABLES.
  - `cli`: a CliSpec.
  - `ipDefaults`: `ipDefaultsFor(capabilities)` (host without routing → HOST, else ROUTER).
  - `gui`, `hostPorts`, `portOwners`, `virtualFamilies`.
  - Per port: role, allowed roles, encapsulation, ordinal, connector and wiring.
- CLI scoping uses grammar, capabilities and the selected port's role (contracts/cli.ts). Inspector tabs and GUI
  panels come from `DeviceModel.gui` and the capabilities.
- Every kind check listed in §9.3 becomes a data, capability or role check.

**D3 — Per-port roles.**
- The vocabulary is `PORT_ROLES`, `ROLE_TRAITS` and `ROLE_KINDS` (catalog.ts). The traits are frames, bridged,
  hairpin, l3, linkable, configurable, virtual, egress, wiring and label.
- A port's static default is `PortSpec.role` plus `allowedRoles`. The effective role is `PortState.role`.
- Demux candidates are filtered by the ingress port's role. The MAC filter is
  `macFilterApplies(role, outer, promiscuous)`.
- L3 switches: ports are `switched` with allowed roles `[switched, routed]`, and `no switchport` flips them (§3.10).
- Home routers:
  - `Internet` has role `wan` (MDI).
  - `Gi1–Gi4` are `switched`.
  - `Wl0/Wl1` are `wireless-bss`, bridged.
  - The auto SVI `Vlan1` routes towards the WAN. eth-switch owns SVI egress.
- A cell tower's radio port is `wireless-bss` (one multipoint access radio). A UE's radio port is `cellular`.
- Host NICs are `routed`; the UI labels them "Network adapter".

**D4 — Hubs, repeaters and coax taps are link-layer collision domains.**
- Their ports have the `repeater` role: `frames: false`, no daemons.
- The SharedSegment medium (link/media/segment.ts) forms the derived collision domain:
  - CSMA/CD: 1-persistent carrier sense, IFG, 32-bit jam, binary exponential backoff drawn from
    `link:<id>:csma`, 16 attempts, late collisions after the slot time.
  - Half duplex, with collision counters.
  - Every receiver gets its own clone through PduFactory.
  - Counters arrive through deferred `TransmitResult`s and `TxOutcome`s.
- The full CSMA/CD mechanics land in **P0.5**, because the hub collision demo is a P0.5 acceptance test. P1 adds
  config-driven duplex mismatch and the collision-storm fault.

**D5 — Wireless mediums.**

Wi-Fi: the WirelessBss air medium (link/media/air.ts), one AP radio serving many stations.
- RF uses integer milli-dB maths (constants in contracts/rf.ts, code in link/rf/*):
  - log-distance path loss per band;
  - distance = canvas distance × `Topology.canvas.metresPerUnit` (default 0.25);
  - co-channel contention and 2.4 GHz partial-overlap interference;
  - SNR → MCS rate tables with +2 dB upgrade hysteresis;
  - a range cut-off;
  - a 2 s RF hold before teardown, so dragging does not make links flap.
- Association is a behavioural 802.11 state machine in the `wlan-client` and `wlan-ap` daemons, carried by real
  dot11 management and EAPOL PDUs. The medium grants and delivers.
- **The medium rewraps 802.3 ↔ 802.11 at the radio boundary** with `Pdu.rewrap`. The Decapsulate/Encapsulate
  provenance is stamped with the transmitting or receiving device, so arp/ipv4/eth-switch only ever see
  Ethernet on wireless ports.

PtP radio: a TopologyLink of `kind: 'radio'` between two `radio-ptp` ports, carried by the RadioLink medium.
- The link comes up on the same band, channel and `peer-key`, in range.
- Rate and PER are RF-derived; propagation uses velocity factor 1.0.

Cellular: the CellularCell medium.
- Attach is behavioural and takes 300 ms.
- Ethernet frames travel on the air.
- The tower bridges them to its backhaul with eth-switch (hairpin).

**D6 — Serial.**
- The default encapsulation is `hdlc` (`PortState.encap`). `encapsulation ppp` is reserved and returns an
  original message.
- The DCE end comes from the media: `serial-dce` means end a, `serial-dte` means end b. `dce_end` overrides both.
  Legacy `serial` media uses `PortSpec.serial.dce`, otherwise end a.
- The DCE end needs `clock rate` (or a `clockSource` port). Otherwise the carrier is up, the line protocol is down,
  and the down reason is `no-clock`.
- The `hdlc` daemon sends keepalives every 10 s; 3 misses bring the line protocol down on the missing end only
  (per-end keepalive latch, §3.9).
- `arp.sendVia` frames IPv4 on hdlc ports without ARP. Forwarding across encapsulations uses `rewrap`.

**D7 — Modules.**
- Types: `SlotSpec`, `ModuleModel`, `ModuleInstall` (catalog.ts).
- Insert and remove work only while the device is powered off. Checks run in the order slot → module → fit →
  power → occupancy, with the wording in `HARDWARE_MESSAGES`.
- Module ports are named `${family}${numbering}/${index}`. Their ordinals are 128 + slot×16 + i.
- The port Map keeps canonical order: fixed ports, then module ports, then virtual ports.
- Default modules apply when `modules` is undefined.
- Modules persist in `devices[].modules`. Changes emit `topologyChanged {what:'module'}`.

**D8 — Stable MACs.**
- A port MAC is `portMac(deviceMacBase(id, salt), ordinal)` (contracts/addr.ts; the vectors are verified in its
  JSDoc).
- The base does not depend on the seed or on creation order.
- On a collision the salt is bumped in world-insertion order and persisted as `hardware.macSalt`.
- BSSIDs are `bssidFor(radioMac, i)`.
- P0 tests that pin MAC literals are updated deliberately in P0.5 W3 (§9).

**D9 — GUI panels never bypass validation.**
- `Simulation.configure(device, commands, opts)` runs lines through a HEADLESS CLI session (§3.12):
  - id `h_<n>`, privilege 15;
  - no history, no trace, never listed;
  - job and interactive commands are refused.
- `ConfigureResult` reports per-line errors with caret columns, and has `atomic` and `indentation` modes.
- The grammar is `model.cli.grammar`, even when the shell is `none` (home router).

**D10 — Periodic timers.**
- `periodic?: boolean` exists on `Action timer` and on `SimEventBody timer`. This is **implemented in wave 0**:
  - device.ts copies the flag;
  - `TrackedScheduler` counts it;
  - the eth-switch and arp sweeps set it.
- `PERIODIC_TIMER_KEYS` is deprecated.
- Periodic timers: sweeps, the RA interval, beacons, keepalives, Wi-Fi rescans, cellular re-search, DHCP lease
  T1/T2/expiry and the DHCP restart pause after APIPA.
- Never periodic: retransmissions, DAD, TIME_WAIT, job timeouts, offer hold, ARP/ND retries, ARP probes, `mediumTimer`
  events.

**D11 — Topology schema 1.1.**
- New optional sections (contracts/topology.ts): `canvas.metresPerUnit`, `devices[].modules`,
  `devices[].hardware.macSalt`, `devices[].ui`, `links[].kind`, `links[].dce_end`, `links[].distance_m`, `lab`.
- `migrateTopology` is pure: 1.0 → 1.1 is identity plus the schema id.
- Loading is atomic. `TopologyLoadError` carries per-device problems and is thrown BEFORE the world is replaced.
  The worker bumps `epoch` only on success.
- The io wave switches `TOPOLOGY_SCHEMA_ID` to 1.1.

**D12 — Determinism.**
- The P0 rules stay absolute.
- New rng sub-streams are created per concern (§5.1). No existing stream gains draws. A sub-stream is split once and
  cached (`ProcessCtx.stream(label)` for daemons); `split` is pure, so re-splitting per use repeats values.
- Positions are rounded at every entry point: `addDevice` (and therefore `loadTopology`) and `moveDevice`.
- Math.log10, Math.pow and Math.exp are banned from the RF and TCP paths.
- `rewrap` is a recorded structural write.

**D13 — Legal.**
- `validateCatalog` scans model names, descriptions and labels against a banned-vendor-word list.
- The CLI legal test's banned list is extended with vendor OS names, desktop OS names and analyser product names.

**D14 — Headless, DOM-free engine.**
- The web talks to the engine only through `EngineApi`.
- Stateless helpers the UI needs come from a `@netforge/engine/pure` entry (src/pure.ts, P1 W2 stack): address
  helpers, the display filter parser and field registry, formatters. P0.5 web code (gui/commands, palette-query) does
  not use it.
- A lint test forbids that entry from importing `sim/`, `device/`, `link/` or `protocols/`.

---

## 2. Conflict resolutions (one name per concept)

| Concept | Area proposals | Chosen | Contract |
|---|---|---|---|
| Port roles | A: 13 roles. D: a `routed-host` idea. | A's list. Tower radio = `wireless-bss`. Host NIC = `routed`. | catalog.ts |
| Role traits | A: `cabled`/frames/bridged/l3/egress. | Adds `hairpin`. `cabled` is renamed `linkable`, because PtP radio ports terminate links. | catalog.ts |
| Port kinds | A: 11. B: wireless/dsl. | A: `wlan`, `radio`, `cellular`, `coax`, `phone`, `fiber-pon`, `usb`, `virtual`. | port.ts |
| Connector names | A: `sfp+`, `serial-smart`, `rj45-console`. B: `sfp-plus`, `smart-serial`, `console-rj45`. | One union: `sfp+`, `smart-serial`, `rj45-console`, `lc`, `sc`, … | catalog.ts |
| Cellular framing | A: `raw-ip` encapsulation. B: Ethernet on the air. | Ethernet on the air (FIELDS correction 6). `PortEncap` has no raw-ip. | catalog.ts, fields.ts |
| Who rewraps 802.3↔802.11 | A: wlan-ap via port owner, onEgress and ingress. B: the medium. | **The medium** (`transmit`/`admit`) with `Pdu.rewrap` provenance. wlan daemons handle mgmt/EAPOL only. Port owners are used only for SVIs. | medium.ts, link.ts |
| Demux | A: `{layer, ethertype, protocol, port, roles}`. C: an IP upper-layer table. | Wire ingress: `{layer, ethertype?, roles?}`. L3→L4: `protocols/ip-upper.ts` table. | process.ts |
| Radio port data | A: RadioPortSpec + CellularPortSpec. B: RadioPortSpec with a `role`. | One `RadioPortSpec` without role; the mode comes from `radioModeOf(kind, role)`. | rf.ts |
| Band / generation | A: RadioBand/RadioStandard. B: RfBand/WifiGeneration. | `RfBand`, `RadioGeneration`. | rf.ts |
| PHY config input | A: `PortState.serial {role, clockRate, encapsulation}`. B: settings callback + `PortState.phy`. | `DeviceRuntime.phySettings(port)` (speed, duplex, clockRateBps). Link-owned `PortState.phy` (carrier, lineProtocol, dce). Encapsulation = `PortState.encap`. | link.ts, port.ts |
| Timer periodic | All areas agree; C wanted keys as a fallback. | `periodic?: boolean` flag. Keys deprecated and unused. | process.ts, events.ts |
| Configure API | A: `{start, onError}` → `{results, finalMode}`. D: `{startMode, startContext, indentation, stopOnError, atomic}` → `{lines, applied, reverted}`. | D's options plus A's `finalMode`. | cli.ts, simulation.ts |
| Module operations | A: `insertModule` → HardwareResult. D: `installModule` that throws. | `insertModule`/`removeModule` → `HardwareResult` everywhere. | device.ts, simulation.ts, protocol.ts |
| CLI shell | A: CliSpec `{shell nfos\|host\|none, grammar}`. D: adds `appliance`. | A's CliSpec. `appliance` = shell `none` + grammar `nfos` (GUI-only). | catalog.ts |
| Scoping hooks | A: feature strings. D: typed gates. | Typed gates: `grammars`, `requires`, `requiresAny`, `portRequires`. The cache key uses `DeviceRuntime.portsVersion`. | cli.ts |
| Mode entry | D: overload `setMode(mode, opts)`. | `setMode` unchanged; new `enterMode(mode, SetModeOptions)`. | cli.ts |
| Extra tables | A: `get()`/`names()` + descriptors. C: typed optional members. | A's `get`/`names` + `TABLE_DESCRIPTORS`, with C's row types. Table names: `nd`, `rib6`, `sockets`, `dhcp-bindings`, `dns-cache`, `dot11-assoc`. | tables.ts |
| ND naming | A: `ndp`. C: `nd`. | `nd` (process and table). | catalog.ts, tables.ts |
| Radio/tower/modem/cloud daemons | A: `radio`, `cell`, `modem`, `cloud`. | None. Mediums handle pairing and attach; eth-switch bridges. Only the UE-side `cell-client` exists. | catalog.ts |
| DHCP relay | A: a separate `dhcp-relay`. C: one daemon. | One `dhcp-server` daemon serves pools and relays (`ip helper-address`), avoiding a port-67 bind conflict. | catalog.ts |
| IPv6 port address | A: PortIpv6Address. C: Ipv6PortAddress. | C's `Ipv6PortAddress`. | port.ts |
| GUI actions | C: `appRequest(process, req)`. D: `hostRequest`. | `hostRequest(HostAppRequest)`, an allowlist mapped onto C's request kinds, ticket id `r_<n>`. | simulation.ts |
| Capture tap | B: `onWire`. D: a facade wrapper on transmit/dispatch. | **The link model is the tap** (`LinkModelDeps.capture`, with `wants()`). tx after egress rewrap and before corruption; rx at admit before ingress rewrap. | capture.ts, link.ts |
| Capture link types | B: `c_hdlc`. D: `hdlc`, `raw-ip`. | pcap LINKTYPE names: `ethernet`, `ieee802_11`, `c_hdlc`, `raw`. | capture.ts |
| Associations in snapshots | D: `SimSnapshot.associations`. B: inside media. | `SimSnapshot.media.associations`. | medium.ts, snapshot.ts |
| Selection | A: `slot`. D: `association` + key helper. | Both, plus `selectionKey()`. | snapshot.ts |
| Topology names | Map: `world`. B/D: `canvas`. | `canvas.metresPerUnit`, `lab {name, version}`, a typed `TopologyDeviceUi`. | topology.ts |
| Deferred transmit | B: a new union variant. | A `deferred?: boolean` flag on the ok variant, so existing narrowing sites keep compiling. | link.ts |
| CSMA/CD stage | B: collisions in P1. | Collisions in P0.5; P1 adds duplex mismatch and the storm fault. | — |
| Background frames | B: sniffing tags. | `PduMeta.background` → `frameTx.background`. | pdu.ts, trace.ts |
| DHCP lease timers | C: undecided. | Periodic, so `runToIdle` terminates; renewal tests use `runFor`. | process.ts |
| APIPA | C: open question. | Included in P1 (`origin: 'apipa'`). | port.ts, services.ts |
| Scenario types | Redeclared in the worker and FileMenu. | `contracts/scenario.ts` (`ScenarioInfo`, `ScenarioMeta`, `scenarioMeta`). | scenario.ts |
| Wireless config lines | D: a global `dot11 ssid` section. | Interface-level lines under `interface WlanN` / `RadioN` (§6), rendered into `RadioSettings`. | rf.ts |
| Simulation mode naming | Collides with FidelityMode `simulation`. | Worker `PlaybackMode` (`realtime` \| `simulation`). The engine FidelityMode is untouched. | protocol.ts |
| Breakpoint precision | — | `TraceFilter.tags` matches `PduSummary.tag` (e.g. `dhcp-offer`). | simulation.ts |

---

## 3. P0.5 cross-module protocols

### 3.1 Frame pipeline v2 (`DeviceRuntime.onFrameArrival(port, pdu, corrupted, now, rx?)`)

1. Unknown port → return.
2. Emit `frameRx`. Then `inPackets++`, `inBytes += rx.fragmentBytes ?? size`, set `lastInput`.
3. `!adminUp` → `inDrops`, drop `port-admin-down`.
4. `!up || !booted` → `inDrops`, drop `link-down`, where
   ```ts
   const kaOnly = (p: PortView) => p.phy?.carrier === true && p.phy.lineProtocolReason === 'keepalive-missed';
   const exempt = pdu.layers[0].proto === 'hdlc' && pdu.layers[0].fields.protocol === 0x8035 && kaOnly(port);
   const up = port.spec.kind === 'wlan' ? port.phy?.carrier === true : port.operUp || exempt;
   ```
   - wlan ports gate on carrier: the link model sets `phy.carrier` = powered && adminUp && radio/BSS configured, and
     `operUp` = carrier && (AP: BSS up; station: associated && authorized), so `operUp === carrier && lineProtocol`
     still holds with authorization as the line protocol. dot11 mgmt frames and dot11-data EAPOL (llc 0x888e)
     therefore reach wlan-client/wlan-ap before authorization. Unauthorized data never reaches the pipeline, because
     `admit` re-checks authorization before the dot11→ethernet rewrap (§3.6 data step 6).
   - A serial end down ONLY by keepalive still receives HDLC keepalives (protocol 0x8035) so the line can recover.
     `no-clock` and `encapsulation-mismatch` stay fully blocked.
5. `errDisabled` → drop `port-err-disabled`.
6. `role = port.role ?? defaultRoleFor(kind, capabilities)`. If `!ROLE_TRAITS[role].frames` → `inDrops`, drop
   `other` with detail `no-frames-on-${role}`.
7. `rx.collided` → drop `collision`, no error counter (half-duplex receiver).
8. `rx.fragmentBytes` defined → `runts++` if the fragment is < 64 B, else `crcErrors++`; then `inErrors++` and
   drop `runt` or `fcs-error`.
9. `outer = pdu.layers[0].proto` must be allowed by `port.encap`:
   - `ethernet` allows `ethernet`;
   - `hdlc` allows `hdlc`;
   - `dot11` allows `dot11` and `ethernet` (air data after admit rewrap).

   Otherwise → `inDrops`, drop `other` with detail `no-${encap}-layer` (the P0 detail `no-ethernet-layer` is kept).
10. Validate by outer layer:

    | Outer | FCS error when | Runt when | Giant when |
    |---|---|---|---|
    | ethernet | `corrupted` or `fcsValid === false` → `crcErrors`+`inErrors`, `fcs-error` | size < 64 | size > mtu+18 (= 1518 at MTU 1500) |
    | hdlc | `corrupted` or `fcsValid === false` → `fcs-error` | never | size > mtu+6 |
    | dot11 | `corrupted` or `fcsValid === false` → `fcs-error` | never | size > `DOT11_MAX_FRAME` |

11. Group destination (`ethernet.dst` or `dot11.addr1` has the group bit) → `inBroadcasts++`.
12. `macFilterApplies(role, outer, spec.promiscuous) && !group && dst !== port.mac` → `inDrops`, drop `not-for-me`.
13. Demux key: `ethernet.type` \| `hdlc.protocol` \| `llc.type` (dot11 data, i.e. EAPOL) \| none (dot11 mgmt).
    Target = `demuxIndex[role][outer]`, the highest score (1 + defined keys); ties go to `model.processes` order.
    The index is rebuilt at boot and on every role change.
14. No target → `inDrops`, drop `unsupported-ethertype` with detail `0xNNNN`. dot11 mgmt without a handler → `other`
    with detail `no-handler-dot11-${subtype}`.
15. `applyActions(target, target.onPdu(ctx, pdu, port))`.

`Action {type:'ingress', port, pdu, layer?}` runs steps 11–15 on its port. Virtual ports also count
`inPackets`/`inBytes`.

### 3.2 Egress (`send` by process X on port P)

Unknown port → drop `other` with detail `unknown-port:P`. Otherwise `t = ROLE_TRAITS[P.role]`:

- **`owner`** (svi):
  - `O = model.portOwners[role]`. Missing → `other` with detail `no-owner:svi`.
  - X ≠ O → count out on P, then apply `O.onEgress(ctxO, pdu, P)`, attributed to O.
  - X = O → drop `other` with detail `virtual-transmit`.
- **`loop`** (virtual): count out, then `ingress {port P, pdu, layer: outer ∈ DemuxLayer ? outer : 'ipv4'}`.
- **`link`**: `r = deps.transmit(from, pdu, now)`.
  - `r.ok && !r.deferred` → `outPackets`, `outBytes`, `lastOutput = r.txStart`, `txRetries += r.retries ?? 0`.
  - `r.ok && r.deferred` → count nothing now.
  - `!r.ok` → `outDrops++`.

`DeviceRuntime.onTxOutcome(port, o)` applies deferred results:

| Outcome | Counter effect |
|---|---|
| `sent` | outPackets/outBytes/lastOutput |
| `deferred` | `deferred++` |
| `collision` | `collisions++` (plus `lateCollisions++` when late) |
| `dropped` | `outDrops++` (plus `excessiveCollisions++` for that reason) |
| `repeated` | repeater-port in/out counts |

The 1000-action budget is unchanged. `pduOf` also covers `ingress` and `event` pdus.

### 3.3 Model instantiation and stable MACs (D7, D8)

`Simulation.addDevice(spec)`:

1. `model = catalog.get(type)`, else throw.
2. `installs = spec.modules ?? model.slots` that have a `defaultModule`. Validate that each slot exists, each module
   exists and each module fits. Throw a readable error BEFORE any state change.
3. Generate the id as in P0.
4. `salt = spec.macSalt ?? 0`. While `world.macBases` maps `deviceMacBase(id, salt)` to another device, `salt++`.
   Then register the base; `removeDevice` unregisters it.
5. Build `DeviceSpec {…, modules (slot order), macSalt, ui}`.
6. The runtime computes `macBase` and builds ports in canonical order:
   - Fixed ports:
     - `role = spec.role ?? defaultRoleFor`
     - `encap = spec.encap ?? KIND_ENCAP[kind]`
     - `ordinal = spec.ordinal ?? index+1`
     - `mac = portMac(macBase, ordinal)`
     - `adminUp = configurable ? (spec.defaultAdminUp ?? model.portsDefaultUp) : true`
     - `mtu = spec.mtu ?? 1500`
   - Module ports: `modulePortSpecs`, with ordinal `moduleOrdinal(slotIndex, i)`. SFP modules instead set the cage
     port's `transceiver`.
   - Auto virtual families: ordinal 0, base MAC, family default admin state.
7. Tables = `model.tables` (cam, arp, rib first).
8. Running config = hostname plus one `interface` section per configurable port (`shutdown` when it defaults down).
9. If powered → schedule boot.
10. Emit `topologyChanged device add`.

Export writes `hardware.macSalt` only when > 0, and `modules` only when the model has slots. Load passes both in
file order, which reproduces identical MACs.

### 3.4 Link recompute and negotiation (per cable or radio link)

**Check order:**
1. `power-off:a|b`
2. `admin-down:a|b`
3. `err-disabled:a|b`
4. Cable check (`CableProblem`): `same-device`, `not-a-cable-port`, `radio-needs-radio-port`, `media-mismatch`
   (kinds, wiring), `connector-mismatch`, `no-transceiver`, `sfp-mismatch`, `too-long` (length for the negotiated
   speed).
5. `cut`
6. Negotiation: `speed-mismatch`.
7. Radio: `radio-band-mismatch`, `radio-channel-mismatch`, `radio-key-mismatch`, `out-of-range`.
8. Serial line protocol (carrier already up): `no-clock`, `encapsulation-mismatch` (both ends), then
   `keepalive-missed` applied PER END: only a port whose keepalive latch is set gets `phy.lineProtocol=false`,
   `lineProtocolReason='keepalive-missed'`, operUp=false; the peer keeps operUp = carrier && its own lineProtocol.
   `LinkState.up` = carrier && both ends' lineProtocol (display and animation only). Loss of carrier clears both
   keepalive latches.
9. Up.

**Writes:** `operUp`, `speedBps`, `duplex`, `lastChange`, `phy`, and the LinkState.

**Emits, in this order:**
1. `linkState`, if `up` changed.
2. `phyNegotiated`, if the result changed.
3. `portState` for each changed port. Its `carrier` field is present only when it differs from `operUp`.
4. `segmentChanged`.

Whenever a port's `phy.carrier` changes, the link model also notifies that port's processes with MediumEvent
`{kind:'carrier', up}` (through `deps.notify` → `onMediumEvent`).

Up→down aborts in-flight legs with a `link-down` drop and `frameAbort`.

**Negotiation defaults in P0.5** (P0.5 W1 media, `link/negotiation.ts`): auto/auto gives `min(speedBps)` full
duplex (the P0 numbers). Repeater ports are forced to 10 Mb half. An autoneg end whose peer is a repeater port
parallel-detects 10 Mb and takes HALF duplex (`phy.end.via: 'parallel-detect'`), so hub-attached stations are half
duplex and do CSMA/CD. A repeater↔repeater cable is 10 Mb half on both ends. Any cable with a repeater end joins a
segment (§3.5). P1 makes negotiation config-driven (§4.9).

**Triggers:** add/remove/impairments/cut; `deps.onPortAdmin`; `deps.onPortPhyConfig` (after speed, duplex, clock
rate, encapsulation, keepalive, radio or switchport lines); power; boot; moves of radio devices.

### 3.5 Shared segment CSMA/CD (D4)

**Domain.**
- Union-find over (a) every repeater-role port of a device and (b) every cable with an end on a repeater port or a
  half-duplex/mismatched end.
- Id `seg:<ordinal-smallest member LinkId>`, rebuilt when a member cable is added, removed or recomputed.
- Members: stations first, then repeater ports, each ordered by device creation and then port order.

**Timing.**

| Quantity | Formula |
|---|---|
| d(S,R) | Σ `propagationNs` over the cables of the BFS path + hops × `serializationNs(1, bps)` |
| bps | lowest negotiated speed in the domain (10 Mb with hubs) |
| wire | `ser(size + 8)` |
| IFG | `ser(12)` |
| slot | `ser(64)` |
| jam | `ser(4)` |

**Transmit.**
1. `transmit(S, pdu)` queues the frame. Past a queue of 64 → `ok:false` reason `queue-full` plus a drop. Otherwise
   it returns `{ok:true, deferred:true}` with provisional times (= now).
2. Attempt at S. If carrier as seen at S is busy until `busy > now` → `carrierDefer` trace, `TxOutcome deferred`
   (once per frame), and `mediumTimer 'try:<portKey>'` at `busy + IFG`.
3. Otherwise start at `a0 = max(now, lastCarrierEnd(S) + IFG)`, ending at `a1 = a0 + wire`:
   - Take 5 draws on `link:<id>:seg`, where `<id>` is the LinkId of the transmitting station's cable (streams are
     created once per label and cached for the simulation lifetime, never re-split on a domain rebuild).
   - For each receiver R in canonical order: clone when there is more than one receiver (the original stays the
     sender's identity); schedule `frameArrival` at `a1 + d(S,R)`.
   - Emit `frameTx` for each BFS tree edge u→v: `txStart = a0 + d(S,u)`, `txEnd = a1 + d(S,u)`,
     `arrive = a1 + d(S,v)`.
   - Record tx capture.

**Collision.**
1. A (from S, starting a0) collides with active B (from X, starting b0) iff `|a0 − b0| < d(S,X)`, or X is the
   full-duplex end of a mismatch.
2. Detection: S at `b0 + d`, X at `a0 + d`.
3. Each detector aborts at detection and jams until `tDet + jam`:
   - cancel the pending arrival of EVERY receiver of the aborted transmission;
   - reschedule fragment arrivals with `fragmentBytes = max(0, floor((end − a0) / ser(1)) − 8)`;
   - emit one `frameAbort` per leg and one `collision` event;
   - report `TxOutcome collision {late: tDet − a0 > slot}`;
   - arm `mediumTimer 'jamEnd:<portKey>'`.

**Jam end.**
- Late collision → drop `late-collision`.
- 16th attempt → drop `excessive-collisions`.
- Otherwise `slots = rng('link:<id>:csma').nextInt(0, 2^min(n,10) − 1)` (same `<id>` rule and caching as `:seg`), a
  `backoff` trace, and a `try` timer at `jamEnd + slots × slot`. A repeater-originated jam or storm draws from
  `fault:<id>`.

**Success** at a1 → `TxOutcome sent {txStart: a0}`, repeater ports get `repeated` in/out, and the next queued frame
starts.

**Receivers.** A full-duplex receiver of a fragment counts a runt or CRC error. A half-duplex receiver hit while
transmitting drops with `collision`.

When a cable leaves the domain, its queued frames are dropped `link-down` with `TxOutcome dropped`.

### 3.6 Wi-Fi association, AP bridging and mobility (D5)

**Config.** The AP and station lines under `interface WlanN` are listed in §6. `onPortPhyConfig` →
`links.onPortChanged` starts, stops or reconfigures the BSS. Auto channel picks the lowest-interference channel in
`CHANNELS` order (deterministic).

**Carrier before authorization.** A station port's `phy.carrier` is up whenever its radio is powered and admin up
(AP: powered, admin up, BSS configured). The frames of steps 1–5 below (probe, auth/SAE, assoc, EAPOL) flow on
carrier alone, in both directions, subject to the air range/band rules (§3.1 step 4, `LinkModel.transmit`). Only
Ethernet data needs authorization.

**Air timing of pre-association frames.** A broadcast probe-req from an unassociated station uses stream
`air:scan:<txPortKey>` with no contention (start = now + DIFS + backoff). Directed mgmt/EAPOL frames use the BSS whose
bssid equals `dot11.addr1` (station→AP) or the sending AP's BSS (AP→station) for both `busyUntil` and
`air:<bss>:<key>`.

**Association** (STA = station daemon `wlan-client`, AP = `wlan-ap`):

1. **Scan.**
   - STA (admin up, ssid set) → medium op `sta-state 'scanning'` → `assocState` idle→scanning.
   - STA broadcasts a probe-req (dot11 mgmt, ssid).
   - The air delivers it to every up AP radio on the station's bands in range, on any channel (scan-sweep
     abstraction).
2. **Probe response and selection.**
   - An AP with a matching SSID answers with a unicast probe-resp.
   - STA's `scan` timer fires after `RF.SCAN_DWELL_NS` and picks the best BSS: SSID match, equal security,
     `canAssociate` from `ctx.air.visibleBss(port)`, rssi desc, then bssid ordinal.
   - No candidate → reason `no-bss` and a periodic `rescan` every `RF.RESCAN_NS`.
3. **Authentication.**
   - STA → `sta-state 'authenticating'` with the bssid.
   - Open: seq1/seq2 with status 0.
   - wpa3-sae: commit and confirm in both directions. The confirm has status 1 when
     `fnv1a32(ssid\0passphrase)` differs.
   - Each step times out after `RF.STEP_TIMEOUT_NS`; 3 timeouts → `failed` → rescan.
   - On success the AP issues `assoc 'authenticated'`.
4. **Association.**
   - STA → `sta-state 'associating'` and an assoc-req.
   - The AP checks `maxClients` and the SSID, then sends assoc-resp status 0 with the lowest free aid and issues
     `assoc 'associated'`.
   - AP full → status 17 and `assoc 'none'`.
5. **Authorization.**
   - Open: the AP issues `authorize` → the STA port becomes operUp → OperChanges → STA `onLinkChange(up)` → the IP
     stack starts (DHCP/ARP).
   - wpa2-psk / wpa3-sae:
     1. STA → `sta-state 'handshake'`.
     2. AP sends EAPOL msg1: dot11 data fromDs + llc 0x888e + eapol step 1, never rewrapped.
     3. STA sends msg2; `keyData` is a hash tag, never the passphrase.
     4. The AP compares tags. Mismatch → deauth reason 15 and `assoc 'none'`; STA goes `failed` with reason
        `wrong-key`. After 3 attempts it stays failed until the config changes.
     5. Match → msg3, msg4, then the AP issues `authorize`.
     6. EAPOL steps time out after 1 s, 3 times.
6. **Teardown.**
   - Config removal or shutdown → STA sends disassoc reason 8 and `sta-state 'idle'`. The AP issues `assoc 'none'`
     on disassoc/deauth.
   - Physical loss (hold expiry, AP radio down, power off) → the medium removes the association and notifies STA
     `beacon-loss` and AP `station-lost`. The STA goes operUp false, and `assocState` → scanning with reason
     `out-of-range` or `bss-down`.

**Data, station → AP.**
1. STA arp/ipv4 send Ethernet on Wl0 → `air.transmit`. Not authorized → drop `not-associated` and `ok:false`.
2. Rewrap, stamped STA with cause 'wireless client framing': strip ethernet, push
   `[dot11 data toDs, addr1=bssid, addr2=sta, addr3=eth.dst, llc {type}]`.
3. `start = max(now, contention busyUntil) + DIFS + rng('air:<bss>:<txKey>').nextInt(0, CW) × SLOT`.
4. Attempts 1..7: `dur = OFDM_PREAMBLE + ser(size, rate)`, one PER draw on `air:<bss>:<rxKey>`. Each failure doubles
   CW. All attempts lost → drop `link-loss` with detail 'air retries exhausted'.
5. `arrive = end + propagationNs(distance, 1.0)`. Emit `frameTx` per receiver (`medium 'air'`, `rateBps`, `rssiDbm`,
   `attempt`) and `frameArrival {rewrap: 'dot11-to-ethernet'}`. The result carries `retries`.
6. `admit` at the AP re-checks authorization, then rewraps (stamped AP): strip dot11/llc, push
   `ethernet {dst: toDs ? addr3 : addr1, src: toDs ? addr2 : addr3, type: llc.type}`.
7. The frame enters `Wl0` (wireless-bss) → eth-switch learns the station MAC on `Wl0`. Hairpin is allowed, so
   intra-BSS traffic is forwarded.

**Data, AP → station.** eth-switch sends on `Wl0` → the air rewraps with fromDs, stamped AP.
- Unicast goes to an authorized station MAC (else `not-associated`).
- Group frames go to every authorized station except the one whose MAC equals the Ethernet source (echo
  suppression), cloned per receiver.
- Mgmt and EAPOL frames are never rewrapped.

**Mobility.**
1. `moveDevice(id, pos)` rounds the position, stores it and emits `topologyChanged move`. If the device has
   wlan/radio/cellular ports and no `deviceMoved` for it is pending → schedule `{kind:'deviceMoved', device:id}` at
   now.
2. Dispatch → `links.onDevicesMoved([id])` recomputes every air/radio pair on a band/channel set that overlaps any
   radio of the moved devices (the moved pairs first, then the others in medium-id then station port order; a
   per-band radio index keeps this O(radios on the band)): RSSI, SINR, contention, `loaded` and rate, with hysteresis.
3. Below the drop threshold with no hold running → `mediumTimer 'hold:<stationKey>'` at now + `RF.RF_HOLD_NS`.
   Back above the connect threshold → cancel the hold.
4. `rfState` is emitted only when bars or rate change.
5. When a move happens while paused, the worker calls `runUntil(now)` so the `deviceMoved` event at `now` dispatches.
6. A BSS matching a station's config that crosses the connect threshold (from `onDevicesMoved`, `setScale` or
   `onPortChanged`) while the station's wlan-client is `scanning` or `failed(out-of-range|no-bss)` → MediumEvent
   `bss-in-range`; wlan-client starts a scan at once (non-periodic `scan` timer), so `runToIdle` waits for the
   reassociation instead of returning on the periodic `rescan`.

**Beacons** are off unless the `beacons` extension line is set. When on, they use a periodic timer and
`PduMeta.background`.

### 3.7 PtP radio link (D5)

- A `TopologyLink {kind:'radio', media:'radio'}` joins two `radio-ptp` ports; it is created with the connect tool,
  one per port.
- `lengthM = distance_m ?? canvas distance × metresPerUnit`.
- **Up** iff:
  - both radios are powered and admin up;
  - same band, same channel and same `peer-key`;
  - `RSSI ≥ RF.PTP_CONNECT_RSSI_MDB` and SINR ≥ MCS0;
  - distance ≤ both `maxRangeM`.
- **Down** reasons: `radio-band-mismatch`, `radio-channel-mismatch`, `radio-key-mismatch`, `out-of-range`. RF-only
  drops wait out the `RF.PTP_HOLD_NS` hold.
- `negotiatedBps = min(MCS rate, port speed)`. Propagation velocity factor 1.0.
- PER is folded into the existing single loss draw.
- `LinkState.radio` gives the distance, RSSI, SNR, rate and bars.
- A radio bridge device has `Gi0` (switched) and `Rd0` (radio-ptp) bridged by eth-switch, so the two LANs join.

### 3.8 Cellular attach (D5)

1. The UE's `cell-client`, on boot or admin up, issues medium op `cell-attach`.
2. The medium moves to `searching` and picks the best tower in range: rssi desc, then device-id ordinal.
3. `attaching`, plus `mediumTimer 'attach:<ueKey>'` at now + `RF.CELL_ATTACH_NS` (300 ms).
4. When the timer fires, RF and tower state are re-checked, then `attached`: the UE goes operUp, gets the
   `cell-attached` notification, and `assocState` is emitted with tech `cellular`.

Data:
- Ethernet frames unchanged, contention-free.
- One loss draw per frame on `cell:<cell>:<ueKey>`.
- Rate from the `lte` table.
- The tower bridges `Ce0` (wireless-bss, hairpin) and `Gi0` with eth-switch.

Out of range → hold → `detached` → periodic `re-search`.

### 3.9 Serial HDLC and clocking (D6)

**Cable.** `resolvedDceEnd = LinkSpec.dceEnd ?? MEDIA[media].dceEnd`. Legacy `serial` media: the end with
`spec.serial.dce`, else end a.

**Recompute.**
- On a serial link whose DCE end has no `phySettings(port).clockRateBps` and is not `clockSource`: `up=false`,
  `carrier=true`, `phy.lineProtocol=false`, down reason `no-clock`. The DCE end gets `phy.dce = true`.
- Encapsulations differ → `encapsulation-mismatch`.
- Keepalive op down → a latch on the REPORTING port only → that end gets `keepalive-missed` (§3.4 step 8). The peer
  stays up; `LinkState.up` = carrier && both ends' lineProtocol is display-only. Loss of carrier clears both latches.
- `negotiatedBps = min(clock rate, bandwidth cap, port speed)`.
- `MediaSpec.phyOverheadBytes = 2`.

**hdlc daemon** (roles `wan`/`access-line` on serial ports).
- At init it reads `phy.carrier`. Afterwards it learns carrier changes only from MediumEvent `{kind:'carrier', up}`
  (onLinkChange reports operUp, which cannot show "carrier up, line protocol down").
- It arms or cancels periodic timer `ka:<port>` (every `keepalive` seconds, default 10) from carrier and the
  `keepalive` config: armed iff carrier up and keepalive ≠ 0. Never from onLinkChange.
- Each keepalive is `[hdlc {address 0x8f, control 0, protocol 0x8035}, payload 12 B (myseq, yourseq)]` with
  `meta {tag 'keepalive', background true}`.
- Missed ≥ 3 → `Action medium {op:'line-protocol', up:false, reason:'keepalive-missed'}`, which latches THIS end
  down. A keepalive received while latched down → `line-protocol up:true`.
- Keepalives still flow in both directions while an end is down by keepalive and nothing else: `LinkModel.transmit`
  (sender) and §3.1 step 4 (receiver) exempt hdlc protocol 0x8035 when `phy.carrier` is true and
  `lineProtocolReason === 'keepalive-missed'`. Every other frame on that end drops `link-down`.
- `keepalive 0` cancels the timer and the daemon never reports (it neither sends nor counts misses).
- Example: R2 `keepalive 0` stays up/up; after 30 s R1 alone shows "up, line protocol down" with reason
  `keepalive-missed`. Re-enabling keepalives on R2 brings R1 back up on the next received keepalive.

**IP over serial.**
- ipv4 declares `{layer:'hdlc', ethertype:0x0800, roles:['wan']}`.
- ipv6 (P1) declares `{layer:'hdlc', ethertype:0x86dd, roles:['wan']}`, alongside its ethernet selector
  `{layer:'ethernet', ethertype:0x86dd, roles:L3_ROLES}`.
- `nd.sendVia` on an hdlc port does no neighbour resolution and creates no NdRow. It encapsulates or rewraps exactly
  like arp.sendVia, but with `hdlc {0x0f, 0, 0x86dd}`. Multicast ND (DAD NS, RS, RA) is sent the same way.
- `arp.sendVia` on an hdlc port does no ARP:
  - no outer layer → encapsulate `hdlc {0x0f, 0, 0x0800}`;
  - ethernet outer (forwarded) → `rewrap {strip:1, push:[hdlc]}`;
  - hdlc outer → unchanged.
- Ethernet egress of an hdlc-outer packet → `rewrap {strip:1, push:[ethernet]}` (a fresh header, not MacRewrite).
- `show interfaces` prints "up, line protocol down" from `phy`.
- `encapsulation ppp` returns an original "not available in this release" error.

### 3.10 Virtual interfaces and role change (D3)

**Create.** When `applyConfigLine` sees `[['interface', N]]` with N unknown and `resolvePortName → virtual`, it calls
`ensureVirtualPort(N)`:
- PortState: role from the family, kind `virtual`, ordinal 0, base MAC, family default admin state, operUp false.
- Encapsulation: SVI `ethernet`, loopback `none`.
- Map refilled canonically, `portsVersion++`, running-config section added (with `shutdown` when it defaults down).
- `portState` with reason `virtual-created`, then oper recompute.

Boot replay tries the same path before logging "unknown interface".

**Remove.** `no interface N` → `removeVirtualPort`:
- Auto instances → the original error "This interface is built in and cannot be removed."
- Otherwise: unset the section (processes see the deltas), `onLinkChange(N, false)` if up, delete, `portsVersion++`,
  `portState` with reason `virtual-removed`.

**Virtual oper state** is runtime-owned. It is recomputed on boot completion, power-off, `onPortOper` of any bridged
port, `setPortAdmin` on the virtual port, and role changes.
- SVI up = power && booted && adminUp && some bridged-role port is operUp. VLAN 1 only; non-1 SVIs stay down with a
  log until VLANs arrive in P2.
- Loopback up = power && booted && adminUp.
- On change: write the state, emit `portState`, fan out `onLinkChange` in model order.
- `deps.onPortAdmin` is never called for virtual ports.

**SVI data path.**
- Inbound: eth-switch learns on a bridged port. A frame for the SVI MAC → `Action ingress {port:'Vlan1', pdu}` (the
  original pdu). A group frame → an ingress clone in addition to the flood clones. Then demux `(svi, ethernet)` →
  arp/ipv4.
- Outbound: arp/ipv4 send on `Vlan1` → the owner `eth-switch.onEgress(pdu, 'Vlan1')` → CAM lookup → send on the
  member port, or flood clones.

**switchport / no switchport.** Special-cased in `applyConfigLine` BEFORE the AST mutation, under
`[['interface', P]]`:
- `no switchport` targets `routed`; `switchport` targets `spec.role`.
- A target outside `allowedRoles` → `CLI_MESSAGES.roleLocked`.
- `setPortRole`:
  1. Same role → ok.
  2. Leaving an l3 role with an IPv4 address → `applyConfigLine(ctx, ['ip','address'], negate=true)`, which
     withdraws the routes.
  3. If the port was up → `onLinkChange(P, false)`.
  4. Set the role, rebuild `demuxIndex`, `portsVersion++`, emit `portState` with reason `role-change`.
  5. If the port was up → `onLinkChange(P, true)`.
  6. Recompute SVI oper state.
- The AST stores `no switchport` (rule `storeNegation`), so it survives save/reload.
- Power-off resets every role to `spec.role`.
- Wiring and the link model are untouched.

### 3.11 Module insert and remove (D7)

**`Simulation.insertModule(dev, slot, module)`:**
1. Sync the clock; throw on an unknown device.
2. `runtime.insertModule` checks, in order:
   - slot ∈ `model.slots`, else `no-such-slot`;
   - the module exists, else `unknown-module`;
   - it fits (`SLOT_ACCEPTS`), else `does-not-fit`;
   - the device is powered off, else `powered-on`;
   - the slot is empty, else `slot-occupied`.
3. Build the module's ports (or set the cage `transceiver`). Refill the Map, update `modules`/`spec.modules`, add
   `capabilitiesAdded`, `portsVersion++`.
4. On success: `topologyChanged {what:'module', id:'<dev>/<slot>', op:'add'}` and `topologyVersion++`.

**`removeModule(dev, slot)`:**
1. Sync the clock.
2. Pre-checks: the slot exists; it is occupied (else `slot-empty`); the device is powered off.
3. For each module port with a link → remove the link (linkState, portState and topology link-remove events).
4. `runtime.removeModule` → `cli.onPortsRemoved` (sessions in a removed port's sub-mode drop to `config`) →
   `topologyChanged` module remove → `topologyVersion++`.

Interface sections for removed ports stay in the startup/running text. The next boot logs "unknown interface", and
export keeps the text.

### 3.12 Configure API (D9)

`Simulation.configure(dev, commands, opts)`: look up the device (throw), sync the clock, then `cli.configure`:

1. `grammar = model.cli.grammar`.
2. Device off or booting → every line fails with `MSG_POWERED_OFF`/`MSG_BOOTING`; with `stopOnError` the rest are
   skipped.
3. `before = atomic ? running.clone() : undefined`.
4. Open a transient session:
   - id `h_<n>` from a separate counter;
   - privilege 15;
   - mode `startMode ?? (nfos ? 'config' : 'user-exec')`, context `startContext ?? []`;
   - never in `sessions()`, no history;
   - output buffered, no cliPrompt/cliOutput/debug.
5. For each line:
   - with `indentation`, pop the context to the line's depth;
   - scope match (§3.13); a `job` or `interactive` spec → `CLI_MESSAGES.notHeadless`;
   - run the handler and record `{index, line, ok, output, error with column, mode}`;
   - an error with `stopOnError` marks the rest `skipped`.
6. Any failure with `atomic` → apply `running.diffTree(before)` through `applyConfigLine` (processes see the inverse
   deltas) and set `reverted: true`.
7. `applied` = configChange events for the device during the call. Also return `finalMode`.
8. The facade invalidates that device's render cache. The worker posts a delta batch, or a full snapshot if
   `topologyVersion` changed.

**Config text** has ONE indentation walker (cli/config-text.ts) and ONE rule table (cli/config-rules.ts). Parsing,
boot replay, the config-fragment fault and `configure({indentation})` all use them.

Mode-entering lines are stored as plain full-token section nodes. This fixes the P0 bug where `ip dhcp pool`
children were lost.

**Migrations to configure:**
- config-fragment fault → `configure(dev, lines, {indentation:true, stopOnError:false})`;
- PortInspector shutdown → `['interface X', '[no] shutdown']`, or the host form `['adapter X up|down']`;
- GUI panels → pure line builders (apps/web/src/gui/commands.ts).

### 3.13 CLI scope, modes and jobs (P0.5 part)

**Scope.** `scopedSpecs` is cached per key `(grammar, mode, privilege, capabilities, portsVersion)`. A spec passes
when:
- its mode matches (`MODES` or class selectors) and its privilege allows it;
- the device grammar is in `grammars ?? DEFAULT_GRAMMARS`;
- `requires` ⊆ capabilities and `requiresAny` ∩ capabilities ≠ ∅;
- the legacy `kinds` gate (if any) passes.

`portRequires` is checked per call against the selected interface. A failing spec is hidden from `?`/Tab; a line
typed in full gets `mismatch ?? CLI_MESSAGES.portUnsupported` at the column of the first literal.

**Modes.**
- The session keeps a context stack.
- `exit` pops within config class; `end` returns to priv-exec; `do` works only in config class and refuses specs with
  `entersMode` or `sessionEffect`.
- Parent-mode fallback: a line unrecognized in a config sub-mode is retried in each ancestor config mode, with the
  context truncated on a match. Help lists only the current mode.

**Access.** Shell `none` → `cli.open` throws `CLI_MESSAGES.noShell`; `canOpen` reports it.

**Jobs.** `block(job?)` with no argument keeps the P0 ping job, `{process:'icmpv4', abort: icmp.abort}`.

**Interface arguments** resolve through `dev.resolvePortName` (fixed, module and virtual). `virtual` results are
accepted only by `interface`-entering commands. `interface vlan 1` is joined into one token first.

**Host shell** default adapter = `model.hostPorts[0]`.

**P0.5 grammar additions:**
- `interface Vlan<n>|Loopback<n>`, `switchport`, `clock rate`, `encapsulation`, `bandwidth`, `keepalive`;
- Wlan lines and Radio lines (§6);
- `show inventory`, `show controllers serial`, `show interfaces status`, `show wireless`;
- host `wifi list|connect|disconnect` and `adapter <if> up|down`;
- debug categories `wireless`, `serial`, `segment` (a `DebugCategoryDef` registry).

### 3.14 Topology 1.1, snapshots and batches

**Load:**
1. `parseTopology` accepts `TOPOLOGY_SCHEMA_IDS`.
2. `migrateTopology`.
3. `validateTopologyAgainstCatalog`: types, module fit, port names via `catalog.resolvePort` on a scratch source that
   includes module ports.
4. Problems → throw `TopologyLoadError`; the world is untouched.
5. Otherwise: replace the world, add devices (modules, macSalt, ui; positions rounded by `addDevice`), add links
   (`kind` = `linkKindOf(resolvedMedia)` when omitted, `dce_end`→`dceEnd`, `distance_m`→`distanceOverrideM`),
   `setScale`, and retain `objectives`, `notes` and `lab` verbatim (exportTopology writes them back; there is no
   other lab setter).

**Export** writes:
- the latest schema id;
- `canvas` only when ≠ 0.25, `modules` only when the model has slots, `hardware` only when there is a salt;
- `ui`, link extras and `lab` when set;
- `objectives`/`notes`, which P0 drops and must be fixed.

**Snapshot additions:**
- `PortSnapshot`: role, allowedRoles, encap, ordinal, virtual, linkable, configurable, connector, wiring, autoMdix,
  group, slot, module, transceiver, poe, radio.
  - `phy` is included only when it differs from a plain full-duplex P2P cable, so P0 snapshots stay stable.
  - `phySettings` is included only when it differs from the defaults.
- `DeviceSnapshot`: category, family, variant, icon, capabilities, cli, gui, slots, hostPorts, baseMac, ui, and
  `tables.extra` (from `TABLE_DESCRIPTORS`).
- `SimSnapshot.media`, when non-empty.
- Rendered configs are cached per device. `snapshot({devices})` builds a subset.

**Worker:**
- Marks devices dirty from drained events: frameTx from/to, frameRx, drop, pdu events, table events, log, portState,
  deviceState, configChange, assocState endpoints, backoff/carrierDefer. Plus `watchDevices`. Also:
  - `topologyChanged` op `move` → the device;
  - `rfState` → port.device and peer.device, and links changed;
  - `linkState`, `phyNegotiated`, `segmentChanged` → links changed (`delta.links` present) plus their endpoint/member
    devices; `collision` → the stations.
- API calls whose effect may emit no dirtying event mark their targets dirty explicitly and ALWAYS post a batch,
  playing or paused (a delta when topologyVersion is unchanged, otherwise a full snapshot): `setDeviceUi`,
  `renameDevice`, `moveDevice`, `setPower` → the device; `setImpairments`, `setCanvasScale` → links changed plus the
  devices at both link ends (`setCanvasScale`: all devices with radio/wlan/cellular ports). A batch may be skipped
  only when the dirty set is empty.
- While playing, and after any mutating EngineApi call while paused, posts a `delta` (every 250 ms while playing).
- Posts a full snapshot on epoch or topologyVersion change, step, load, reset, when more than 60 % of devices are
  dirty, and at least every 2 s.
- Caps a batch at 20 000 events (`eventsTruncated`).
- Honours `ClockPolicy.ignoreBackground`.
- Keys in-flight frames by `${pdu.id}@${link}>${portKey(to)}`.

---

## 4. P1 cross-module protocols

### 4.1 Daemons and the silence rule

With `CATALOG_STAGE = 'P1'` (device/catalog/index.ts), CAPABILITY_PROCESSES adds:

| Devices | Added daemons |
|---|---|
| Hosts | ipv6, nd, icmpv6, udp, tcp, dhcp-client, dns-client, http-client, traceroute |
| Servers | dhcp-server, dns-server, http-server |
| Routers | the stack plus dhcp-client, dhcp-server, dns-client, dns-server, http-server, traceroute |
| L2 switches | arp, ipv4, icmpv4, host (for the management SVI) |

Nothing is sent without config:
- IPv6 needs an interface ipv6 line.
- DHCP needs `ip address dhcp`.
- RAs need `ipv6 unicast-routing` plus an address.
- DNS and HTTP servers need `ip dns server` / `ip http server`.

`accept.p1.silence.test.ts` guards this.

### 4.2 IP upper-layer delivery and ICMP fan-back

**ipv4, packet for this device:**
- protocol 1 → icmpv4; 6 → tcp; 17 → udp (when the process exists);
- anything else → drop `unsupported-protocol` plus `icmp.error(3,2)`, unless the destination is broadcast or
  multicast.

**ipv6, packet for this device:**
- nextHeader 58 with type 133–137 → nd; other ICMPv6 → icmpv6; 6/17 → tcp/udp;
- anything else → drop plus `icmp6.error(4, 1, pointer=6)`;
- hop-by-hop headers are skipped; routing type 0 → param-problem; fragments → drop `other` with detail 'ipv6
  reassembly not supported in P1'.

Self-addressed sends use the same table.

**udp:**
- Verify the checksum: mandatory on IPv6; 0 means none on IPv4.
- Match a socket: port, then exact local address before wildcard, then the iface restriction. Match → consume +
  `sock.datagram`.
- No socket and a unicast destination → drop `unsupported-protocol` with detail 'udp port N closed', plus
  `icmp.error(3,3)` or `icmp6.error(1,4)`.

**tcp:** match the 4-tuple; else a LISTEN socket for a SYN; else send a RST and drop with detail 'tcp port N closed'.
RST for a segment with no matching socket: if the incoming segment has ACK → `{flags:'R', seq: SEG.ACK}`; otherwise →
`{flags:'RA', seq: 0, ack: SEG.SEQ + SEG.LEN + (SYN?1:0) + (FIN?1:0)}`. Never send a RST in reply to a RST. In
SYN_SENT, accept a RST only when its ack equals ISS+1.

**Socket binds** (contracts/transport.ts header): the conflict key is (proto, family, localAddr, localPort,
iface ?? '*'); a bind conflicts only when proto, family and port match, the addresses are equal (or either is the
wildcard) and the ifaces are equal (or either is unrestricted). Receive match order: exact addr+iface, exact addr,
wildcard+iface, wildcard.

**ICMP errors** (v4 types 3/11, v6 types 1/3), dispatched on the quoted datagram:
- quoted protocol 1 → the ping job or probe table → `icmp.result`;
- quoted 17 → udp → `sock.error` with code, `icmp {type, code, quotedDstPort, quotedTtl, pdu}` and `from`; the UDP
  socket stays open (a UDP `sock.error` never closes it); the owner decides whether to close it;
- quoted 6 → tcp. In SYN_SENT, hard errors (3/2, 3/3) abort the connection; soft errors are reported only if the
  connection later times out.

**`ipv4.send` with `iface`** skips LPM. `nextHop = req.nextHop` if given, else:
- dst, when dst is 255.255.255.255, a directed broadcast or connected;
- else the gateway on that iface;
- else drop `no-route`.

A limited broadcast without `iface` → `no-route` with detail 'limited broadcast needs an egress interface'.

**RIB arbitration** (core/rib-arbiter.ts): a candidate list per key; the lowest AD is installed; withdrawing the
winner re-installs the next. host.ts offers `ip default-gateway` as `S` with AD 1 through `ipv4.route`, only while
`!model.ipForwarding` (or `no ip routing`). Candidates record `RouteRow.owner` (the offering process); provenance
renders "ip default-gateway" iff `route.owner === 'host'`.

### 4.3 DHCP DORA

Scenario: PC1 has `ip address dhcp` on Gi0. R1 has pool LAN 192.168.1.0/24 with default-router .1 and dns-server
.10. A switch sits between them.

1. **PC1 boots.** ipv4 clears any static address (`setPortL3 ipv4:null`) and marks Gi0 DHCP-managed. dhcp-client
   enters `INIT` and requests `udp.open {owner:'dhcp-client', socket:'dhcp-client#Gi0', family:4,
   localAddr:'0.0.0.0', localPort:68, iface:'Gi0'}`, which creates a BOUND socket row and answers `sock.opened`.
   Nothing is sent while the port is down.
2. **DISCOVER.** On link up:
   - `xid = ctx.stream('xid:Gi0').nextU32()` (cached per iface; one draw per cycle); state `SELECTING`; debug
     `ip dhcp client`.
   - `udp.send {socket 'dhcp-client#Gi0', src 0.0.0.0, dst 255.255.255.255, dstPort 67, iface Gi0,
     tag 'dhcp-discover', app [dhcp {op 1, xid, broadcastFlag true, chaddr, messageType DISCOVER,
     parameterRequestList '1,3,6,15,51', hostname}]}`.
   - Retransmit timer `dhcp:Gi0` (not periodic) at 4 s, with jitter drawn from `ctx.stream('dhcp-jitter:Gi0')` (one
     draw per retransmit).
   - udp builds `[ipv4 0.0.0.0→255.255.255.255 ttl 128, udp 68→67, dhcp]` → `ipv4.send {iface}` → `arp.sendVia`
     broadcast → Ethernet ff:ff:ff:ff:ff:ff.
3. **OFFER.** The switch floods. On R1, ipv4 delivers locally → udp socket `dhcp-server#67` → `sock.datagram {iface
   Gi0/0}`.
   - The pool is the one containing Gi0/0's address (giaddr 0).
   - The address is the lowest free, non-excluded one; an existing binding for the same chaddr wins.
   - Binding row `offered` (expires now+60 s) and timer `offer-hold:LAN|192.168.1.2`.
   - `udp.send` broadcast from .1 to :68, iface Gi0/0, `triggeredBy` DISCOVER, tag `dhcp-offer`: OFFER with yiaddr .2,
     serverId, mask, router, dnsServers, lease 86400, T1 43200, T2 75600.
4. **REQUEST.** PC1 matches the xid in `SELECTING`, takes the first offer, moves to `REQUESTING` and broadcasts
   REQUEST (requestedIp .2, serverId .1, tag `dhcp-request`).
5. **ACK.** R1 sees its own serverId:
   - binding becomes `bound`, expiring at the lease end;
   - cancels `offer-hold` and arms a periodic `binding:…` timer;
   - broadcasts ACK (tag `dhcp-ack`).

   An address not offered to this chaddr gets a NAK. A REQUEST naming another server releases this server's offer.
6. **Bound.** PC1:
   - `ipv4.lease {op:'bind', iface:'Gi0', address:'192.168.1.2', prefixLen:24, router:'192.168.1.1',
     leaseExpiresAt, server:'192.168.1.1', origin:'dhcp'}`. ipv4 then:
     - calls `setPortL3 {ipv4 {…, origin 'dhcp', leaseExpiresAt}}`;
     - installs C and L routes and the candidate default `D` (AD 254) via .1;
     - sends a gratuitous ARP.
   - State `BOUND`, with periodic timers `t1:Gi0`, `t2:Gi0` and `lease:Gi0`.
   - Event `dhcp.lease bound` goes to dns-client.
   - Log (severity 6, facility DHCP): "Interface Gi0 received address 192.168.1.2/24 from 192.168.1.1".
7. **Renew and release.**
   - T1 → `RENEWING`: unicast REQUEST with ciaddr.
   - T2 → `REBINDING`: broadcast REQUEST.
   - Expiry → unbind (C/L/D withdrawn), `dhcp.lease lost`, back to `INIT`.
   - `no ip address dhcp`, `onShutdown` or `ipconfig /release` → unicast RELEASE, then unbind.

**APIPA.** After 4 DISCOVERs (4, 8, 16, 32 s):
1. Pick 169.254.x.y from `ctx.stream('apipa:<iface>')` (x 1–254, y 0–255).
2. `arp.probe {owner:'dhcp-client', token:'apipa:<iface>', iface, address}` → `arp.probeResult` (arp sends 3 probes
   1 s apart on non-periodic timer `arp-probe:<token>`). On a conflict, draw the next candidate from the same cached
   stream and probe again. On no conflict, go to step 3.
3. `ipv4.lease {op:'bind', iface, address, prefixLen:16, origin:'apipa'}` (no router).

Then cancel `dhcp:<iface>` and arm the PERIODIC timer `dhcp-restart:<iface>` (`DHCP_RESTART_PAUSE_NS`, 60 s). When it
fires, DISCOVER starts again; the DISCOVER retransmits (`dhcp:<iface>`) and ARP probes of each new cycle stay
one-shot. A later ACK replaces the APIPA address. With no server, `runToIdle` returns during the post-APIPA pause,
after one full DISCOVER/APIPA cycle (about 60 s + 3 s of probes).

**Relay.** R1 Gi0/0 has `ip helper-address 10.0.0.10` and no matching pool.
1. dhcp-server builds a NEW PDU (`triggeredBy` the original): giaddr = the Gi0/0 address, `hops+1` (limit 16),
   unicast from Gi0/0 to helper:67.
2. The server picks the pool by giaddr and replies by unicast to giaddr:67.
3. The relay sees `op 2` with giaddr equal to its own address → `udp.send {dst:255.255.255.255, dstPort:68,
   iface:'Gi0/0'}`.

### 4.4 DNS lookup (browser fetch of `http://www.lab.nf/`)

0. The Desktop browser calls `EngineApi.hostRequest(PC1, {app:'http.get', url})`. The facade returns ticket `r_<n>`
   and applies `request http-client {http.fetch owner:'gui' token:r_<n> url}`.
1. http-client parses the URL (http only; `https:` → tab error "Secure pages are not simulated in this release.").
   A non-literal host → phase `resolving` → `dns.resolve {owner:'http-client', token, name, qtype}`, with qtype per
   §4.8.
2. dns-client resolves:
   - Cache hit → event `dns.result` with `fromCache`.
   - Miss → servers = `ip name-server` entries, then DHCP-learned ones.
   - `txid = ctx.stream('dns-id').nextU32() & 0xffff` (one draw per query from the cached stream).
   - `udp.open 'dns-client#q<n>'` (ephemeral port), where n is a per-process query counter (never the txid), then
     `udp.send {dst, 53, tag 'dns-query', app [dns {id, rd true, questions 'www.lab.nf A'}]}`.
   - Timer `q:<n>` at 2 s. Responses are matched on (socket, txid).
3. S1 dns-server (`ip dns server`, socket `dns-server#53`):
   - Records come from `ip host` and `ip dns record`; CNAME chains are followed up to 8 deep.
   - Reply `{qr, aa, ra when name-servers are set, rcode 0, answers 'www.lab.nf A 300 192.168.1.80'}`, `triggeredBy`
     the query.
   - Unknown name with `rd` and forwarders configured → forward, cache, relay.
   - Responses stay ≤ 512 B by dropping additionals; `tc` is never set.
4. dns-client on the matching id:
   - cancel the timer and close the socket;
   - write a `dns-cache` row `{name, A, data, ttl 300, expiresAt, source 'answer'}`;
   - send `dns.result {addresses, NOERROR}`.

   Timeout: retry the same server twice, then the next server, then `TIMEOUT`. `NXDOMAIN` is negative-cached for
   60 s. A periodic `dns-sweep` runs every 60 s while the cache is non-empty.

### 4.5 TCP connect / transfer / close and the HTTP fetch

Setup: SRV2 (192.168.1.80) has `ip http server` → `tcp.listen {owner:'http-server', socket:'http-server#80', family:4,
localPort:80}` → a LISTEN row (plus a `family:6` listener `http-server#80v6` when IPv6 is enabled).

1. **SYN.** PC1 http-client (phase `connecting`): `tcp.connect {owner:'http-client', socket:'http-client#r_1',
   dst:'192.168.1.80', dstPort:80}`. tcp then:
   - picks `src = sourceFor(dst)` (none → `sock.error no-route`);
   - picks an ephemeral local port;
   - ISN = `ctx.stream('isn').nextU32()` (one draw per connection);
   - row `SYN_SENT` and debug `ip tcp {from:'CLOSED', to:'SYN_SENT'}`;
   - sends `[ipv4, tcp {flags 'S', seq ISN, window 65535, mss 1460}]` with flow
     `ipv4:192.168.1.2:<eph>>192.168.1.80:80:tcp` and tag `tcp-syn`;
   - arms `rto:…` at 1 s.
2. **SYN-ACK.** SRV2 matches LISTEN → child `http-server#80/1` in `SYN_RECEIVED` (full backlog → silent drop) →
   `{flags 'SA', ack ISN+1, mss 1460}`.
3. **ACK and request.** PC1 → `ESTABLISHED`. It takes an integer SRTT/RTTVAR sample, sends ACK and `sock.connected`.
   http-client then sends
   `GET / HTTP/1.1\r\nHost: www.lab.nf\r\nUser-Agent: NetForge-Browser/1\r\nAccept: */*\r\nConnection: close\r\n\r\n`
   (phase `waiting`).
4. **Segmentation.** Segment size = min(MSS, cwnd, peer window − inflight). Nagle applies only to sub-MSS segments
   while unacked data exists. The tcp codec dispatches the next layer by `tcp.port` whenever the payload is ≥ 1 byte;
   the http codec marks an incomplete message with error `partial`.
5. **Response.** SRV2 gets `sock.accepted`, then `sock.data`. http-server:
   - buffers until CRLFCRLF (400 when malformed);
   - looks up `ip http page PATH TEXT`, else the original default page for `/`, else 404;
   - sends `HTTP/1.1 200 OK\r\nServer: NetForge-HTTP\r\nContent-Type: text/html\r\nContent-Length: N\r\nConnection: close\r\n\r\n<body>`;
   - calls `tcp.close` (FIN after the data).
6. **Client close.** PC1 receives data (phase `receiving`). FIN → `CLOSE_WAIT` + `sock.peerClosed`. http-client
   parses the response (Content-Length or close-delimited), sets its tab to `{phase:'done', status, reason, headers,
   body}`, and calls `tcp.close`. The connection goes `LAST_ACK` → `CLOSED`; `sock.closed`; the row is deleted.
7. **Server close.** SRV2 goes `FIN_WAIT_2`, then `TIME_WAIT` (row `expiresAt = now + 60 s`, timer `timewait`), then
   `CLOSED`.

**Reliability.**
- RTO expiry → retransmit as a NEW pdu (`triggeredBy` the original, tag `tcp-retransmit`);
  `ssthresh = max(flight/2, 2·MSS)`, `cwnd = MSS`, RTO doubles (max 60 s).
- Limits: 5 retransmits → RST and `sock.error timeout`; 3 SYN retries.
- 3 duplicate ACKs → Reno fast retransmit and recovery. Congestion avoidance: `cwnd += floor(MSS²/cwnd)`.
- Zero window → persist probes (RTO backoff, max 60 s). After `TCP_PERSIST_MAX_PROBES` (5) unanswered-window probes the
  connection is aborted with `sock.error timeout`, so `persist:*` stays never periodic and runToIdle terminates.
  Delayed ACK: 200 ms.
- Every state change writes the socket row and emits one debug event `{from, to, trigger, pdu}`.

A closed port gets a RST → `sock.error refused` → tab error "The server refused the connection.".

### 4.6 IPv6 SLAAC, DAD, NDP and ping -6

**R1** has `ipv6 unicast-routing` and `ipv6 address 2001:db8:1::1/64` on Gi0/0.
1. ipv6 sets `ipv6Enabled` and adds the addresses `[fe80::<eui64> (auto-link-local), 2001:db8:1::1/64 (manual)]`,
   both tentative.
2. `groups6 = [ff02::1, ff02::2, solicited-node of each address]`.
3. Port up → `nd.dad` per address. DAD sends NS `{src ::, dst solicited-node, hopLimit 255, target}` and arms
   `dad:<iface>|<addr>` at 1 s.
4. No reply → `ipv6.dadResult ok` → preferred; rib6 gets C 2001:db8:1::/64 and L /128.
5. A duplicate (an NA for the target, or an NS from :: for it while tentative) → state `duplicate`, log severity 4
   "Duplicate address … on …". A duplicate link-local stops IPv6 on the port.
6. Link-local preferred + unicast-routing → periodic `ra:<iface>` (first after rng 0–500 ms, then every 200 s).
   RA: `{src LL, dst ff02::1, hopLimit 255, prefix, prefixLen 64, validLifetimeS, preferredLifetimeS, mtu 1500,
   sourceLla}`.

On serial (hdlc) ports, ND frames and data use hdlc protocol 0x86dd with no link-layer address resolution (§3.9).
The RS/RA delays below draw from `ctx.stream('rs')`, `ctx.stream('ra')` and `ctx.stream('ra-solicit')`.

**PC1** has `ipv6 address autoconfig`.
1. The link-local runs DAD and becomes preferred.
2. `rs:<iface>` after rng 0–1 s sends RS `{src LL, dst ff02::2, sourceLla}`. R1 answers with a solicited RA after rng
   0–500 ms (`ra-solicit:<iface>`).
3. On the RA, nd:
   - creates an `NdRow` for the router: `STALE`, `isRouter`;
   - reports `ipv6.raLearned` → rib6 `::/0` source `ND` (AD 2) via the router link-local.
4. The SLAAC address `eui64Address(prefix, 64, mac)` is added tentative with origin `slaac` and lifetimes, runs DAD,
   and becomes preferred.
5. RS retries stop on the first RA.

**`ping 2001:db8:2::5`** → `icmp6.ping` job:
1. Source = `sourceFor6(dst)`; none → the original "no IPv6 route" line.
2. Packet `[ipv6 {nextHeader 58, hopLimit 64}, icmpv6 {128, id, seq}, payload]` → `ipv6.send` → lpm6 →
   `nd.sendVia` to the router's link-local.
3. The neighbour entry goes `STALE` → frame sent (type 0x86dd) → `DELAY` 5 s → `PROBE` (unicast NS) → NA →
   `REACHABLE`.
4. The router forwards with `mutate('ipv6.hopLimit', …, 'TtlDecrement', cause)`, where the cause is the rib6 route
   line.
5. Progress marks are `!`, `.` and `U`.

### 4.7 Traceroute

The CLI calls `ctx.block({process:'traceroute', abort:{kind:'job.abort', session}, label})`, then requests
`trace.start {session, target, mode}`: mode `udp` for router `traceroute`, `icmp` for host `tracert`. A name target
is resolved through `dns.resolve` first.

**UDP mode.**
- `udp.open 'traceroute#<session>'` on an ephemeral port.
- For hop h in 1..30 and probe p in 0..2: `udp.send {dstPort 33434 + (h−1)·3 + p, ttl h, 12 zero bytes, tag
  'trace h.p'}`, plus timer `trace:<session>` at 3 s.
- Results:

  | Event | Output |
  |---|---|
  | `sock.error ttl-exceeded` whose `quotedDstPort` is the current probe | RTT ` <ms> msec`; the address is printed once per hop |
  | port-unreachable from the target | destination reached |
  | 3/0, 3/1, 3/13 | `!N`, `!H`, `!A` |
  | timeout | ` *` |

- After 3 probes print a newline. Reached, or h = 30 → close, print an original completion line, `cliDone`.

**ICMP mode.** `icmp.probe {owner:'traceroute', token:'<session>:h:p', target, ttl:h, timeoutNs:TRACEROUTE_TIMEOUT_NS}`. icmpv4 sends an echo request
(probe counter id, seq = probe index) and arms `probe:<token>`. Replies, time-exceeded and unreachables come back as
`icmp.result`.

**On the path.** Routers answer TTL ≤ 1 with `icmp.error(11,0)` (P0). The destination's udp answers a closed port
with `icmp.error(3,3)`. IPv6 uses `icmp6.probe` or `udp.send` with the hop limit.

`job.abort` → cancel, close, print a partial footer, `cliDone`.

### 4.8 Dual-stack selection (RFC 6724-lite)

**`sourceFor6(dst, iface?)`:**
1. Egress = `iface ?? lpm6(dst).winner.iface ?? connectedPortFor6(nextHop)`.
2. Candidates = the preferred addresses on the egress port.
3. A link-local or ff02::/16 destination → the link-local candidate.
4. Otherwise sort non-link-local candidates by: same scope first; `commonPrefixLen6` descending; origin rank
   manual < eui64 < slaac < dhcpv6; list order.

**Names.** Query AAAA then A when the device has a preferred global/ULA address AND a rib6 route to the destination;
otherwise A then AAAA. Connects try the addresses in order and move on after the `SocketErrorCode`s `refused`,
`timeout`, `host-unreachable`, `net-unreachable` or `no-route`. ping and traceroute use the first address only.

### 4.9 Speed and duplex negotiation (config-driven)

Abilities = `speeds × duplexModes`. `autoneg = spec.autoneg !== false` unless both speed and duplex are forced.

| Ends | Result |
|---|---|
| Both autoneg | Best common ability: highest speed, full before half. None → down `speed-mismatch`. |
| One forced | The autoneg end parallel-detects speed and takes HALF duplex below 1 Gb (full at ≥ 1 Gb). |
| Both forced | Equal speeds, or `speed-mismatch`. Each end keeps its own duplex. |
| Repeater ports | Forced to 10 Mb half. |

The result goes to `PortState.speedBps`, `duplex`, `phy.end` and `LinkState.phy`. A duplex mismatch puts the cable
into a segment (§3.5):
- the full-duplex end transmits regardless and receives fragments (runts/CRC errors);
- the half-duplex end detects late collisions and drops what it was receiving (`collision`).

**Faults.** `duplex-mismatch` and `clock-missing` become configure lines (indentation mode). `collision-storm` makes
the segment emit jam bursts drawn from `fault:<id>`.

### 4.10 Passwords, banners and login

- `enable secret X` renders as `enable secret nf1 <hash>`: FNV-1a-64 over the device-id salt plus the plain text,
  via `CommandCtx.secrets`.
- `service password-encryption` renders line and enable passwords as `password nf7 <reversible hex>`.
- `line con 0` and `line vty 0 4` are sections with `password`, `login` and `exec-timeout`. Also supported:
  `banner motd|login|exec` and `username X secret Y`.
- **enable with a secret set:**
  1. `CommandOutcome.ask {request: {kind:'secret', prompt:'Password: '}, resume}` → `CliResult.input` and
     `cliPrompt.input`.
  2. The terminal masks the next line (no echo, no history) and `resume` verifies it.
  3. After 3 failures the command ends with an original denial.
- **Console login:** `login` + `password` on the console line → mode `login` → banner login → secret prompt →
  user-exec + banner exec.
- `interrupt` clears pending input. Headless configure refuses interactive specs.

### 4.11 Simulation mode (worker `PlaybackMode`)

1. `setPlaybackMode('simulation')` pauses. Default filters:
   `{list: {kinds:['frameTx','drop','tableWrite'], includeBackground:false}, breakOn: null}`.
2. **play**: every tick calls `s.runUntil(stepTo, {stopOn: breakOn})`.
   - The engine sink runs `matchesTraceFilter` (kinds, protos over `PduSummary.layers`, devices, links, ports,
     tables, `tags`) on every emitted event.
   - The run loop checks the flag after each whole dispatch and stops WITHOUT `advanceTo(t)`, returning `stopped`,
     `stopEvent` and `stopCursor`.
   - The clock clamp considers only in-flight frames that match `list`.
3. **On stop**: `playing = false`, and a batch with a snapshot and `stopped {cursor, event, reason 'breakpoint'}`.
4. **`stepToNext()`**: pause, then run `s.stepToNext(list, {until: s.now + SIM_STEP_HORIZON_NS, maxEvents:
   SIM_STEP_MAX_EVENTS})` (10 s, 20 000 events; protocol.ts), then resync in-flight.
   - On a match, return `stopped {reason 'step'}`.
   - Otherwise `stopped` is null, and `ended` is `'maxEvents'` if `stats.stopped === 'maxEvents'`, `'idle'` if
     `nextEventTime()` is undefined, and `'horizon'` in every other case. The UI shows "No matching event in the next
     10 s" for `'horizon'`.
   - A quiet lab can therefore never jump minutes ahead (expiring ARP/CAM entries, renewing leases) on one click.
5. **Sim-events panel**: `traceQuery({from: max(oldest, traceHead − 500), filter: list, limit: 500})` on open, then
   incremental queries (≤ 4 Hz) whenever `batch.traceHead` advances. Clicking a row selects its PDU.
6. `realtime` clears `breakOn` and `stoppedAt`.

Granularity is one scheduler event: a flood can emit several matching rows in one step.

**"Stop at the first DHCP OFFER"** = `breakOn {kinds:['frameTx'], protos:['dhcp'], tags:['dhcp-offer']}`.

### 4.12 Capture, NetScope and pcap

**One analyser.** Simulation capture methods and `bridge/worker/captures.ts` both delegate to `createCaptureStore`
(contracts/capture.ts `CaptureStore`; netscope `capture/store.ts`, P1 W3). `importCapture` = `readCapture` (io/pcap.ts,
P1 W1) then `createCaptureStore({ source: 'import', ... })`. Both are exported from `src/index.ts` when they land.

**Start.** `startCapture(spec)` creates a CaptureStore:
- interfaces = the spec's ports ∪ both ends of its links ∪ medium members;
- link type by encapsulation: ethernet → `ethernet` (fcsLen 4), dot11 → `ieee802_11` (FCS stripped, fcsLen 0), hdlc →
  `c_hdlc` (2-byte CRC stripped, fcsLen 0);
- the link model's `capture.wants` = the union over running captures.

**Tap.** tx is recorded when a frame starts on its medium: after egress rewrap, before corruption (P2P at transmit,
segment at a0, air at the first attempt). rx is recorded in `admit`, before ingress rewrap, with `corrupted` and
`fragmentBytes`. `record` copies `pdu.bytes` immediately.

**Rows.**
- `decodeStandalone(bytes, outerForLinkType(iface.linkType, bytes), { fcsLen: iface.fcsLen })` builds a `CaptureRow`
  with a stream key; an LRU cache holds 2000 decoded frames. `outerForLinkType`: ethernet → ethernet, ieee802_11 →
  dot11, c_hdlc → hdlc, raw → ipv4/ipv6 by the high nibble of bytes[0]. With fcsLen 0 the link codecs bound the
  payload to the remaining bytes and leave fcs/fcsValid undefined.
- The display filter compiles once per text (capture/filter). `tcp.flags.syn == 1` is an alias that reads
  `tcp.flags` contains `S`.
- `queryCapture` pages the rows.

**Follow stream** reassembles TCP by sequence number with retransmission dedup, and parses HTTP messages with the
http codec's pure parser.

**Export.**
- pcapng: SHB (magic 0x0A0D0D0A, BOM 0x1A2B3C4D); one IDB per interface (linktype, `if_name`, `if_tsresol`=9,
  `if_fcslen` = the interface's `fcsLen`); one EPB per record with `ts = baseWallNs + t` and `epb_flags` direction.
- Classic pcap: magic 0xa1b23c4d (nanoseconds), one link type; `fcsLen` bytes are stripped from each record and
  `origLen` is reduced to match. Mixed link types → `PCAP_MIXED_LINKTYPE_MESSAGE`.
- Bytes go to the UI with `Comlink.transfer`.

**Import.** `readCapture` handles both endians, µs and ns magics, and SHB/IDB/EPB/SPB blocks. It skips unknown
blocks, bounds-checks everything, and applies `MAX_CAPTURE_IMPORT_*`. Interface `fcsLen` = pcapng `if_fcslen` (only
when the FCS-present flag is set), default 0; classic pcap uses 0; unsupported values fall back to 0. Imports go into
the worker `CaptureLibrary` as `i_<n>`.

### 4.13 Labs and concept views

- `listScenarios` returns `scenarioMeta`. The worker sets `ScenarioMeta.missingTypes` for labs whose `requires` types
  this build lacks; `loadScenario` rejects such a lab with an original message.
- **`loadScenario`:**
  1. Seed set → rebuild the simulation with that seed.
  2. `loadTopology({ ...build(), lab: { name, version: version ?? 1 } })`.
  3. Schedule the lab's faults.
  4. Activate the lab (the worker keeps a reference to the `ScenarioInfo`), `epoch++`, post a full snapshot plus the
     lab status.
- **Reopening a saved file:** the worker reads `topology.lab` from the document it parsed, looks up SCENARIOS by name
  and activates that lab if found. The engine only round-trips `lab` (no setter on Simulation).
- **`evaluateLab`** (sim/lab-checks.ts, type `EvaluateLab = (sim, lab) => LabStatus` in contracts/scenario.ts; it
  never advances the live sim's time, emits trace or draws its rng) runs after batches when at least 2 s of wall time
  have passed and there was at least one relevant event (configChange, tableWrite, portState, assocState), and on
  `checkLab()`.
  - Static assertions read structured state.
  - `connectivity` runs in a disposable clone (`createSimulation({seed})` + `loadTopology(exportTopology())`) and
    reads ping job StateView counts.
- `exportTopology` writes `lab` back as loaded.
- Concept views (P1: models W2, views W7) use `@netforge/engine/pure` address helpers. The Canvas stays mounted and hidden, with the Pixi ticker
  stopped.

---

## 5. Determinism, timers, silence

### 5.1 RNG stream registry (root = `createRng(seed)`; never add draws to an existing stream)

A labelled sub-stream is created ONCE and cached; every draw comes from that cached Rng. `split` never advances and
depends only on (origin, label), so calling `split(x).next*()` per use repeats the same value and is forbidden.
Daemons use `ctx.stream(label)` (ProcessCtx; cached for the life of the process instance). The link model caches its
streams for the simulation lifetime and never re-splits on a segment rebuild.

| Stream | Owner | Draws |
|---|---|---|
| `links` → `link:<id>` | P2P cables, radio links | exactly 5 per frame (P0 invariant) |
| `link:<id>:seg` (id = transmitting station's cable) | segment | 5 per transmission attempt |
| `link:<id>:csma` (id = transmitting station's cable) | segment | 1 per collision backoff |
| `air:<medium>:<txPortKey>` | air | 1 CSMA/CA backoff per attempt |
| `air:<medium>:<rxPortKey>` | air | 1 PER per delivery attempt |
| `air:scan:<txPortKey>` | air | 1 backoff per broadcast probe-req of an unassociated station |
| `cell:<medium>:<uePortKey>` | cell | 1 loss per frame |
| `fault:<faultId>` | faults | storm/noise bursts, repeater-originated jams |
| `device:<id>` → `process:<name>` | daemons (P0) | per process |
| `process:udp`, `process:tcp` | transport | 1 ephemeral base per process lifetime |
| `process:tcp` → `isn` | tcp | 1 per connection (cached sub-stream) |
| `process:dhcp-client` → `xid:<iface>`, `dhcp-jitter:<iface>`, `apipa:<iface>` | DHCP | 1 per cycle / 1 per retransmit / 1 per fallback pick (cached per iface) |
| `process:dns-client` → `dns-id` | DNS | 1 per query (cached sub-stream) |
| `process:nd` → `rs`, `ra`, `ra-solicit` | ND | split once, 1 draw per delay |

wlan daemons and the medium's association logic use no randomness. Auto channel selection is deterministic.

### 5.2 Timers

- **Periodic** (`periodic: true`): `cam-sweep`, `arp-sweep`, `ra:*`, `dns-sweep`, `ka:*` (hdlc), `rescan`,
  `re-search`, `t1:*`, `t2:*`, `lease:*`, `binding:*`, `dhcp-restart:*` (the post-APIPA pause), `beacon:*`.
- **Never periodic**: retransmit timers including `dhcp:*` (DISCOVER/REQUEST retransmit), `dad:*`, `rs:*`,
  `timewait:*`, `rto:*`, `dack:*`, `persist:*` (capped at `TCP_PERSIST_MAX_PROBES`), `q:*`, `trace:*`, `probe:*`,
  `offer-hold:*`, `arp-retry:*`, `arp-probe:*`, `nd:*`, `scan`, and every `mediumTimer`.

`runToIdle` on a DHCP topology returns while leases are still running. Renewal tests use `runFor`. `runToIdle` on an
unanswered DHCP client returns during the post-APIPA pause, after one full DISCOVER/APIPA cycle.

### 5.3 Silence rule

P0 and P0.5 scenarios must produce the same packet sequences after P1 daemons are added. Only D8 MAC literals change.
Guard test: `accept.p1.silence.test.ts`.

### 5.4 Integer discipline

- RF: milli-dB.
- TCP: integer SRTT/RTTVAR and cwnd bytes.
- DHCP: permille fractions.
- Positions: integer canvas units.

`review-determinism.probe.test.ts` gains assertions for these. A grep test bans `Math.log10`, `Math.pow` and
`Math.exp` under `link/rf`, `link/media` and `protocols/tcp*`.

---

## 6. Canonical config lines and their consumers

The rules live in `cli/config-rules.ts` (`ConfigLineRule`). GUI panels and host-shell expansions write exactly these
lines.

**P0.5**

| Context | Line | Consumer |
|---|---|---|
| interface (serial) | `clock rate <bps>` | runtime `phySettings` → link (only the DCE end matters; on a DTE end it is stored with an info note) |
| interface (serial) | `encapsulation hdlc\|ppp` | runtime `PortState.encap` (ppp is refused) |
| interface (serial) | `keepalive [<s>]`, `no keepalive` (stored negation) | hdlc |
| interface | `bandwidth <kbps>` | runtime (show; metrics later) |
| interface | `speed …`, `duplex …` (P0 lines) | runtime `phySettings` → negotiation (behaviour in P1) |
| interface (multilayer) | `switchport`, `no switchport` (stored negation) | runtime `setPortRole` |
| global | `interface Vlan<n>`, `interface Loopback<n>` (section), `no interface …` | runtime virtual ports |
| interface WlanN (AP or station) | `ssid <rest>`, `security open\|wpa2-psk\|wpa3-sae`, `passphrase <rest>` (secret), `band`, `channel <n>\|auto`, `channel-width`, `tx-power`, `beacons` | wlan-ap / wlan-client + `radioSettings` → air |
| interface RadioN | `band`, `channel`, `peer-key <rest>` (secret), `tx-power` | `radioSettings` → RadioLink |
| global (AP / switch management) | `ip default-gateway <gw>` | host |

Host shell expansions (P0.5):
- `wifi connect <ssid> [key <pass>]` → `interface Wlan0` + `ssid`, `security wpa2-psk|open`, `passphrase`.
- `wifi disconnect` → `no ssid`.
- `adapter <if> up|down` → interface `[no] shutdown`.

**P1**

| Context | Line | Consumer |
|---|---|---|
| interface | `ip address dhcp` | ipv4 + dhcp-client |
| interface | `ip helper-address <a>` (multi) | dhcp-server (relay) |
| interface | `ipv6 enable`; `ipv6 address X/len [eui-64\|link-local]` (multi); `ipv6 address autoconfig`; `ipv6 nd suppress-ra` | ipv6, nd |
| global | `ipv6 unicast-routing`; `ipv6 route P/len NH\|IF [NH]` (multi) | ipv6, nd |
| global | `ip name-server A…`; `ip domain-name D`; `no ip domain-lookup` (stored negation) | dns-client |
| global | `ip host NAME A…` (multi) | dns-client + dns-server |
| global | `ip dns server`; `ip dns record NAME TYPE DATA [TTL]` (extension, multi) | dns-server |
| global | `ip dhcp excluded-address A [B]` (multi) | dhcp-server |
| section `ip dhcp pool NAME` (mode `dhcp-config`) | `network A M`, `default-router A…`, `dns-server A…`, `domain-name D`, `lease D [H [M]]` | dhcp-server |
| global | `ip http server`; `ip http page PATH <rest>` (extension, multi) | http-server |
| global | `enable secret`, `enable password`, `service password-encryption`, `username X secret Y`, `banner motd\|login\|exec` | CLI runtime |
| section `line con 0` / `line vty 0 4` (mode `config-line`) | `password`, `login`, `exec-timeout` | CLI runtime |

Host shell expansions (P1):
- `ip address dhcp [<adapter>]`
- `ip dns A [B]` → `ip name-server`
- `ipv6 address [<adapter>] X/len`
- `ipv6 autoconfig [<adapter>]`
- server `service http|dns|dhcp …` → the router-form lines above; the Services panel builds them.

---

## 7. Web file map

| Area | Files (apps/web/src/…) | Stage | Owner |
|---|---|---|---|
| Vocabulary (one typed source for media names/dash patterns, drop reasons, protocol shapes+letters, trace kinds, field formatters, categories) | `vocab/{media,drops,protocols,trace-kinds,fields,categories}.ts` | P0.5 W1 | web-inspector |
| Icons (original SVG per `DEVICE_ICONS`, generic fallback, badges from capabilities) | `catalog/visuals.ts`, `icons/{routers,switches,multilayer,datacentre,legacy,security,wireless,home,radios,wan,computers,servers,mobile,voice,peripherals,iot,generic}.ts` | P0.5 W1 | web-canvas |
| Palette v2 (category rail, search over model/description/tags/capability words, family variant chips, recents, persisted collapse, resizable, keyboard) | `app/palette/palette-query.ts` (W2); `app/palette/{Palette,CategoryRail,PaletteSearch,VariantChips}.tsx` (W6) | P0.5 | web-inspector |
| Cable picker (media flyout with dash glyphs; media in validate/add; compatible-port filter; DCE-end hint) | `app/cable/cable-compat.ts` (W2); `app/cable/CablePicker.tsx` (W6) | P0.5 | web-inspector |
| Canvas core (icon registry; grouped port picker with slot rows, console row, radios excluded; media dash + letter; per-leg packets with `abortAt`; air geometry; protocol shapes; collision burst; culling + LOD; lower ZOOM_MIN) | `canvas/{devices,ports,cables,packets,markers,scene,interaction,Canvas}.ts(x)` | P0.5 W6 | web-canvas |
| Wireless overlays (range rings = rangeM / metresPerUnit; association lines with bar count, dBm text and phase badge; PtP beams; channel labels) | `canvas/{rf,air}.ts`; toggles in `app/TopBar.tsx` View menu | P0.5 W6 | web-canvas (layers), web-shell (menu) |
| Keyboard canvas (§16: DOM outline tree, spatial arrow navigation, keyboard cabling, live announcements) | `canvas/a11y/{CanvasOutline.tsx,keyboard-nav.ts,KeyboardCabling.tsx,announcer.ts}` | P0.5 W6 | web-canvas |
| Inspector (tabs from gui/capabilities, clamped to overview; generic extra tables; link phy/radio/segment; association and slot inspectors) | `inspector/{tabs.ts,DeviceInspector.tsx,PortInspector.tsx,TablesView.tsx,LinkInspector.tsx,AssociationInspector.tsx,SlotInspector.tsx}` | P0.5 W6 | web-inspector |
| Slots panel (Physical tab: chassis slots, module list, power-off gate message, insert/remove) | `inspector/ModulesPanel.tsx` | P0.5 W6 | web-inspector |
| AP / home router / radio / tower settings (panels submit through `configure`; per-line errors mapped to form fields) | `inspector/{WirelessPanel,HomeRouterPanel,RadioLinkPanel,CellTowerPanel}.tsx`; `gui/{commands,forms}.ts` (pure builders, W2) | P0.5 | web-inspector |
| Desktop tab (end-device apps in floating non-modal windows; Command Prompt reuses TerminalTab) | `desktop/{DesktopTab,WindowLayer}.tsx`, `desktop/apps/{IpConfigApp,WifiApp,CellularApp,CommandPromptApp}.tsx` | P0.5 W6 | web-inspector |
| Shell (worker split, delta merge, index, persistence, one dock registry, one openDeviceSurface) | `bridge/client.ts`, `bridge/worker/{index,clock,batch,delta}.ts`, `store/{store,selectors,persist}.ts`, `dock/registry.ts`, `app/{App,Dock,TopBar,hotkeys,StatusBar,FileMenu}.tsx`, `shared/openDeviceSurface.ts` | P0.5 W6 | web-shell |
| Terminal (secret/confirm masking, job status line) | `terminal/{TerminalTab.tsx,line-editor.ts,use-session-output.ts}` | P1 W7 | web-shell |
| Browser and Services (http-client tab StateView; URL/history via setDeviceUi; server service panels) | `desktop/apps/BrowserApp.tsx`, `inspector/ServicesPanel.tsx` | P1 W7 | web-learn |
| NetScope (three panes, filter bar with pure parser completion, capture controls, follow stream, statistics, pcap import/export) | `netscope/{NetScope,PacketList,DetailTree,HexPane,FilterBar,FollowStream,Statistics,CaptureControls}.tsx`, `netscope/netscope-client.ts`, `bridge/worker/captures.ts` | P1 W7 | web-netscope |
| Sim-mode list (virtualised traceQuery pages, filter chips, breakpoint editor, next event) | `simmode/{SimEventsPanel,FilterChips,BreakpointEditor}.tsx`, `simmode/sim-events-client.ts`, `bridge/worker/sim-mode.ts` | P1 W7 | web-netscope |
| Concept views (subnetting workbench with bits/mask/VLSM/practice; IPv6 explorer with compression and EUI-64 steps) | `concept/{ConceptView.tsx,subnetting/{SubnetWorkbench.tsx,model.ts},ipv6/{Ipv6Explorer.tsx,model.ts}}` | P1 (models W2, views W7) | web-learn |
| Labs browser (catalogue by topic, instructions via allowlisted markdown with `concept:` links, task ✓/✗ with text) | `labs/{LabBrowser,LabPanel}.tsx`, `labs/markdown.ts`, `bridge/worker/labs.ts` | P1 W7 | web-learn |

Every semantic encoding has a non-colour channel: bar counts, dash patterns, lettered badges, shapes and glyph + text.

---

## 8. Module map and build waves

Owners are agents; each file has exactly one. Wave 0 (architect, done) = every contract file, this document, and
the compile edits in §9.1. Each item lists **owner — files — delivers — tests**.

`packages/engine/src/index.ts` is architect-owned and append-only: a wave item may add only its own
`export * from './<its files>.js'` lines in the matching group, in the same change that creates those files (never
pre-written for modules that do not exist yet). The architect reconciles the file at the W7 (P0.5) and W8 (P1) gates.

### 8.1 P0.5

**W1 — pure foundations (contracts only)**
- **catalog** — `device/catalog/{names,define,validate}.ts`.
  Delivers PORT_FAMILIES-based name resolution (fixed/module/virtual), `defineModel` with every derivation in D2
  (`CATEGORY_BOOT_NS`, `KIND_HOSTNAME_PREFIX`), `modulePortSpecs` and `validateCatalog` (issue codes, banned words,
  JSON-clone check).
  Tests: `device.catalog.{names,define,validate}.test.ts` — the P0 canonicalPort table verbatim; P0 models re-authored
  with identical fields; one negative fixture per issue code.
- **pdu** — `pdu/checksum.ts` (crc16X25, onesSum, pseudo-header sums), `pdu/codecs/dispatch.ts` (tables from
  DISPATCH_TABLE), `pdu/codecs/registry.ts` (CodecContext plumbing, `fixTrailer`, MAX_LAYERS 32 + truncation flag),
  `pdu/pdu.ts` (`rewrap`, `layerAt`, DERIVED from `codec.derived`).
  Tests: `pdu.rewrap.test.ts` (strip/push provenance, same id, no double padding/FCS); `pdu.codecs.test.ts` registry
  order (§9.2).
- **rf** — `link/rf/{log,pathloss,mcs,channels}.ts`.
  Delivers the integer log tables, RSSI/SINR, MCS with hysteresis, PER, `rangeM`, bars and auto channel.
  Tests: `link.rf.test.ts` golden values.
- **media** — `link/negotiation.ts` (pure P0.5 defaults), `link/serial.ts` (DCE resolution, line-protocol rules),
  `link/cabling.ts` v2 (connectors, optics, per-port wiring, maxLengthBySpeed, original wording),
  `link/media/types.ts` (the internal MediumStrategy interface).
  Tests: `link.negotiation.test.ts` (PC auto ↔ hub port → 10 Mb half on both ends, via parallel-detect; hub↔hub →
  10 Mb half; auto/auto → min speed full), `link.serial.test.ts` (per-end keepalive latch, keepalive exemption, carrier
  loss clears latches), extended `link.cabling.test.ts`.
- **cli** — `cli/modes.ts`, `cli/config-rules.ts`, `cli/config-text.ts`, `cli/config-ast.ts` (rule-driven identity,
  section storage fix, render slots, stored negation, `diffTree`).
  Tests: `config-ast.sections.test.ts` (dhcp pool round-trip, `no switchport` persists); P0 goldens unchanged.
- **sim** — `trace/filter.ts` (`matchesTraceFilter`).
  Tests: `trace.filter.test.ts`.
- **io** — `io/migrate.ts`, `io/schema.ts` (1.0 and 1.1, device/link/canvas/lab fields and limits,
  `validateTopologyAgainstCatalog`), `io/netforge-file.ts` (whitelists); flips `TOPOLOGY_SCHEMA_ID` to 1.1.
  Tests: `io.migrate.test.ts`; io.schema message pin updated (§9.2).
- **web-inspector** — `vocab/*.ts`.
  Tests: `vocab.test.ts` (exhaustive, unique shape+letter, no banned words).
- **web-canvas** — `catalog/visuals.ts`, `icons/*.ts`.
  Tests: `visuals.test.ts` (every DEVICE_ICONS id has artwork; every path string parses).

**W2 — catalog data, link-layer codecs, runtime pieces**
- **catalog** — `device/catalog/{routers,switches,multilayer,datacentre,legacy,security,wireless,home,radios,wan,computers,servers,mobile,voice,peripherals,iot,modules}.ts`,
  `device/catalog/index.ts` (ALL_MODELS/ALL_MODULES, `CATALOG_STAGE = 'P0.5'`, `createCatalog` with validation),
  `device/catalog.ts` (re-export shim).
  Tests: `device.catalog.data.test.ts` — zero validation errors; per-model derived-summary snapshot (processes, roles,
  cli, gui, owners); module × fitting-slot uniqueness.
- **pdu** — `pdu/codecs/{hdlc,dot11,dot11-mgmt,llc,eapol}.ts`.
  Tests: `pdu.codecs.link.test.ts` golden frames and FCS.
- **media** — `link/media/p2p.ts` + `link/inflight.ts`.
  Delivers the P0 pipeline extracted, in-flight keyed by (pdu, link, to), the corruption window by outer codec,
  out-of-band refusal and serial overhead of 2.
  Tests: `link.model.test.ts` unchanged and green.
- **device** — `device/ports.ts` (canonical Map refill, virtual port factory, virtual oper), `device/pipeline.ts`
  (encap validators, MAC filter, demuxIndex).
  Tests: `device.ports.test.ts`, `device.pipeline.roles.test.ts`.
- **cli** — `cli/parser.ts` (MatchContext grammar/caps/iface, class selectors), `cli/scope.ts` (cache,
  portRequires).
  Tests: parser tests migrated (§9.2), `cli.scope.test.ts`.
- **web-inspector** — `app/palette/palette-query.ts`, `app/cable/cable-compat.ts`, `gui/{commands,forms}.ts`.
  Tests: `palette-query.test.ts`, `cable-compat.test.ts`, `gui.commands.test.ts`.

**W3 — runtime, mediums, daemons, CLI runtime**
- **device** — `device/device.ts` (D8 MACs, modules, virtual ports, setPortRole + switchport special case,
  owner/loop egress, ingress action, tables v2, `phySettings`/`radioSettings`, `onTxOutcome`/`onMediumEvent`,
  power-off resets), `device/process-ctx.ts` (`rewrap`, `hasCapability`, `air`).
  Tests: `device.{modules,virtual,egress,role}.test.ts`; `device.runtime.test.ts` MACs (§9.2).
- **media** — `link/media/segment.ts` (full CSMA/CD §3.5), `link/media/radio.ts` (§3.7).
  Tests: `link.segment.test.ts`, `link.csma.test.ts`, `link.radio.test.ts`.
- **wireless** — `link/rewrap80211.ts`, `link/media/air.ts`, `link/media/cell.ts`,
  `protocols/{wlan-ap,wlan-client,cell-client}.ts`.
  Tests: `link.air.test.ts`, `wifi.assoc.test.ts`, `cell.attach.test.ts`.
- **l2l3** — `protocols/{eth-switch,arp,ipv4,icmpv4,host}.ts` (roles, ipDefaults, hdlc framing, SVI ingress/onEgress,
  hairpin, non-ethernet relay), `protocols/hdlc.ts`.
  Tests: `l2.eth-switch.svi.test.ts`; arp/ip tests with ipDefaults; `serial.hdlc.test.ts`.
- **cli** — `cli/runtime.ts` (context stack, fallback, CliJob, headless configure + atomic, canOpen,
  onPortsRemoved), `cli/grammar/{index,core-exec,show,config-global,config-if,host-shell,serial,switchport,svi,wireless,modules}.ts`,
  `cli/handlers/*.ts`.
  Tests: `cli.runtime.{modes,configure}.test.ts`; generated help goldens per model × mode × role.

**W4 — link facade and daemon registry**
- **media** — `link/link.ts` (routing §3.4 order, `admit`, `onPortChanged`, `mediumOp`, `onMediumTimer`,
  `onDevicesMoved`, `setScale`, `media()`, `airView`, capture hook points).
  Tests: `link.model.facade.test.ts`.
- **l2l3** — `protocols/index.ts` (hdlc, wlan-ap, wlan-client, cell-client).
  Tests: registry test.

**W5 — simulation**
- **sim** — `sim/simulation.ts`, `sim/media-wiring.ts` (deps, dispatch of mediumTimer/deviceMoved/admit, coalesced
  moves), `sim/configure.ts`, `sim/snapshot-cache.ts`, `sim/run-control.ts` (P0.5 part), `sim/scenarios.ts` (P0.5
  templates: home Wi-Fi, hub, serial pair, multilayer, radio bridge, cellular).
  Tests: `sim.{mac-stability,modules,configure,media,load-atomic,snapshot-cache}.test.ts`.

**W6 — web integration and acceptance**
- **web-shell** — shell files from §7.
  Tests: `worker.delta.test.ts` (including: while paused, `setDeviceUi` and then `setImpairments` each produce a batch
  whose delta contains the device, or the links list), `store.delta.test.ts`, `review-web.epoch` extension, hotkeys
  registry.
- **web-canvas** — canvas, overlays and a11y files from §7.
  Tests: pure layout/placement/ring tests; `keyboard-nav.test.ts`.
- **web-inspector** — palette/cable UI, inspector, panels and desktop files from §7.
  Tests: `tabs.test.ts`; panel command-line tests with a mocked engine.
- **qa** — `packages/engine/test/accept.p05.*.test.ts` (§10.1).

**W7 — P0.5 exit gate (architect)** — **done 2026-09-18** (record: §12.1)
- Remove the remaining `?` on P0.5 members; delete `kinds`, `PERIODIC_TIMER_KEYS`, `macFromIndex`, `nextPortIndex`,
  `deviceKind`, `canonicalPort`; update docs.
- Applied: every transition-only `?` removed (DeviceModel, PortSpec, PortState, DeviceSpec, DeviceRuntime,
  DeviceRuntimeDeps, DeviceCatalog, DeviceTables, ProcessCtx, DemuxSelector, CommandCtx, CliSessionView,
  CliRuntimeDeps, LinkModelDeps, Port/DeviceSnapshot, web PendingCable); the six P0 members plus `wiringOf`,
  `deviceNoun`, `LEGACY_CLI_SPEC` and the parser/scope `kind` inputs deleted; the kind-based cabling rules replaced
  by per-port wiring and `hostTerminal`; `accept.p05.coverage.test.ts` ties §10.1 to the suite. The members that
  keep a `?` on purpose, and why, are listed in §12.1.

### 8.2 P1

**W1**
- **stack** — `core/addr6.ts` (implements `AddrHelpersV6`).
  Tests: `addr.ipv6.test.ts` (RFC 5952 vectors, EUI-64), `addr.ipv4-extra.test.ts`.
- **pdu** — `pdu/pdu.ts` (outerInputs re-encode).
  Tests: mutate counts unchanged; NAT-style mutate records `ChecksumRecompute`.
- **netscope** — `capture/filter/{lexer,parser,fields,eval,complete}.ts`, `io/pcap.ts`.
  Tests: `capture.filter.test.ts`, `io.pcap.test.ts`.
- **media** — `link/negotiation.ts` (config-driven), `link/media/segment.ts` (mismatch + storm).
  Tests: `link.duplex-mismatch.test.ts`.
- **sim** — `sim/run-control.ts` (stopOn, stepToNext with `until`, traceQuery).
  Tests: `sim.run-control.test.ts` (resume equals an uninterrupted run; in a quiet switch lab `stepToNext` with the
  10 s horizon returns no match with `now` advanced by 10 s or less).

**W2**
- **pdu** — `pdu/codecs/{udp,tcp,ipv6,ipv6-ext,icmpv6,dhcp,dns,http}.ts`, `pdu/codecs/registry.ts`
  (`decodeStandalone`).
  Tests: `pdu.codecs.{transport,ipv6,app}.test.ts`.
- **stack** — `core/lpm6.ts`, `core/rib-arbiter.ts`, `src/pure.ts` (the pure entry: re-exports `core/addr6` and
  `capture/filter/*` from W1, plus formatters). In the same change that creates `src/pure.ts`, stack also owns and
  edits (no wave-0 stub, no `npm install`; the workspace symlink exists):
  1. `packages/engine/package.json` (exports only): `"exports": { ".": "./src/index.ts", "./pure": "./src/pure.ts" }`;
  2. `apps/web/tsconfig.json` (paths only): `"@netforge/engine/pure": ["../../packages/engine/src/pure.ts"]` next to
     the existing `"@netforge/engine"` entry;
  3. `apps/web/vite.config.ts` (alias only): `'@netforge/engine/pure': fileURLToPath(new URL('../../packages/engine/src/pure.ts', import.meta.url))`
     placed BEFORE the `'@netforge/engine'` key. Vite checks aliases in order and a string alias also matches
     `find + '/'` prefixes, so the order is what keeps `/pure` from resolving to `index.ts/pure`; this also covers
     `vitest --root apps/web`.
  Tests: `core.lpm6.test.ts`, `core.rib-arbiter.test.ts`, pure-entry import lint test (no `sim/`, `device/`, `link/`,
  `protocols/` imports), `apps/web/test/pure-entry.test.ts` (imports `@netforge/engine/pure`, so both web checks prove
  the subpath resolves).
- **device** — `device/device.ts` (event action, setPortL3 per-member merge keeping the P0 member-less → clear-ipv4
  fallback, pduOf, onShutdown, extra tables in snapshots), `device/process-ctx.ts` (IPv6 helpers; `stream` already
  implemented in wave 0).
  Tests: `device.ctx.test.ts` source selection vectors; setPortL3 per-member merge.
- **cli** — `cli/parser.ts` (ipv6, ip, host, hostname, url, secret, int-range arg types), `cli/runtime.ts` (input,
  login, secrets).
  Tests: `cli.parser.args.test.ts`, `cli.runtime.input.test.ts`.
- **web-learn** — `concept/{subnetting,ipv6}/model.ts`.
  Tests: `concept.models.test.ts`.

**W3**
- **l3** — `protocols/ip-upper.ts`, `protocols/{ipv4,host,icmpv4,arp}.ts` (lease/route arbitration with
  `RouteRow.owner`, iface send, upper delivery, probes, error fan-back; `ipv4.ts` `no ip address` sends `ipv4: null`;
  arp `arp.probe`/`arp.probeResult`).
  Tests: `ip.ipv4.dhcp.test.ts`; ip.ipv4 proto-17 tests split (§9.2); `ip.ipv4.test.ts:85` clear expectation (§9.2);
  `arp.probe.test.ts` (3 probes 1 s apart, both conflict forms, cache untouched).
- **l3v6** — `protocols/{ipv6,nd,icmpv6}.ts`.
  Tests: `ip6.{ipv6,nd,icmpv6}.test.ts`.
- **transport** — `protocols/udp.ts`.
  Tests: `l4.udp.test.ts`.
- **netscope** — `capture/{tap,store,decode-row,stream,stats}.ts`.
  Tests: `capture.stream.test.ts`, `sim.capture.test.ts`.

**W4**
- **transport** — `protocols/tcp.ts`, `protocols/tcp/{fsm,sender,receiver,congestion}.ts`.
  Tests: `l4.tcp.{fsm,retransmit,fastretx,rst}.test.ts`.
- **apps** — `protocols/{dhcp-client,dhcp-server,dns-client,dns-server,traceroute}.ts`.
  Tests: `app.dhcp.*.test.ts`, `app.dns.*.test.ts`, `app.traceroute.test.ts`.

**W5**
- **apps** — `protocols/{http-server,http-client}.ts`.
  Tests: `app.http.test.ts`.
- **l2l3** — `protocols/index.ts` (P1 registry).
- **catalog** — `device/catalog/index.ts` (`CATALOG_STAGE = 'P1'`), plus the L2 switch Vlan family in the NF-C2960
  data: `{family:'Vlan', role:'svi', min:1, max:1, auto:[1], defaultAdminUp:false}` (the home-router Vlan1 family keeps
  `defaultAdminUp:true`).
  Tests: catalog derived-summary snapshot updated deliberately; the §9.2 Vlan1 items.
- **cli** — `cli/grammar/{ipv6,dhcp,dns,transport,traceroute,line-auth,services}.ts` and their handlers.
  Tests: handler tests with fake daemons; `sim.host-shell.p1.test.ts`.

**W6**
- **sim** — `sim/simulation.ts` (hostRequest, captures, lab wiring), `sim/lab-checks.ts`,
  `sim/scenarios/{index,templates}.ts`, `sim/scenarios/ccna1/*.ts` (about 14 labs).
  Tests: `labs.solutions.test.ts`.

**W7**
- **web-shell** — worker sim-mode/captures/labs wiring, store slices, terminal masking.
- **web-netscope** — `netscope/*`, `simmode/*`.
- **web-learn** — `concept/*` views, `labs/*`, BrowserApp, ServicesPanel.
- **qa** — `accept.p1.*.test.ts` (§10.2).

**W8 — P1 exit gate (architect).**

---

## 9. P0 migration list

### 9.1 Done in wave 0 (this change; all four checks green)

1. Widened unions: `DeviceKind`, `PortKind`, `MediaType`, `DropReason`, `MutationReason`, `TraceEvent`, `Selection`,
   `ArgType`, `RouteRow.source`, `FaultKind`, `SimEventBody`. Compile edits:
   - `test/cli.runtime.fake.ts` models are keyed by `FakeKind` (the four P0 shapes).
   - Web: `canvas/cables.ts` MEDIA_NAMES, `canvas/markers.ts` DROP_REASON_TEXT, `inspector/Provenance.tsx`
     DROP_LABEL/REASON_ICON/REASON_LABEL and `inspector/TablesView.tsx` SOURCE_TITLE gain the new members.
   - `cli/parser.ts` gains `default` branches for P1 arg types.
   - `store/store.ts` `sameSelection` uses `selectionKey`.
2. **D10 implemented.**
   - `device.ts` copies `Action.periodic` into the scheduled timer body (only when true).
   - `TrackedScheduler` counts periodic events by the flag.
   - The eth-switch `cam-sweep` and arp `arp-sweep` timers set `periodic: true`.
   - `arp.lifecycle.test.ts` (3 expectations) and `l2.eth-switch.test.ts` (3) now expect `periodic: true`.
   - `PERIODIC_TIMER_KEYS` is deprecated; sim.facade still asserts membership.
3. `device.ts` send skips counting when `TransmitResult.deferred`. It tolerates `setPortL3 ipv4: null` and keeps P0
   replace semantics.
4. `MEDIA` gains usb-console, fiber-pon, serial-dce, serial-dte, coax, phone and radio. P0 entries keep their numbers
   and gain only informational optional fields. `link.cabling.test.ts` uses `'twinax'` instead of `'coax'` as its
   unknown-media example (2 places).
5. `ScenarioInfo` moved to `contracts/scenario.ts`; templates carry `category: 'template'`; worker `listScenarios`
   returns `scenarioMeta`.
6. `DEFAULT_CLOCK_POLICY` gained `ignoreBackground: true` (unused until P0.5 W6).

### 9.2 Pending, by wave (every P0 test or behaviour that changes deliberately)

**Catalog and device (P0.5 W1–W3)**
- `device.catalog.test.ts:7-18`: instead of pinning list() to exactly three models, assert the three are present
  and unchanged, and that the list follows DEVICE_CATEGORIES order. Lines 20-61 also check the derived fields. The
  canonicalPort table (71-112) stays verbatim against the shim.
- NF-2911 processes gain `hdlc` (P0.5); P1 adds the stack.
- `device.runtime.test.ts:24-25, 87-88`: runtime-assigned MACs `00:1f:00:00:00:01/02` become D8 vectors, taken from
  the exported helpers. freshRunning text is unchanged in P0.5 (no auto virtual families on NF-C2960 until P1).
- `review-determinism.probe.test.ts` (3 literals): runtime-derived MACs update to D8 vectors; event sequences stay
  identical. `sim.two-pcs-switch` and `sim.pc-router-pc` pin no MAC literals and stay unchanged.
- The other test files with `00:1f:00:…` literals (arp.*, ip.*, cli.show.*, core.table, l2.eth-switch, link.model,
  pdu.*) are reviewed in the same change: MACs passed in through harness fixtures stay; any assertion that reads a
  runtime-assigned MAC moves to the D8 helpers.
- `device.harness.ts`, `arp.harness.ts`, `ip.fake-ctx.ts`, `cli.show.fixture.ts`, `l2.eth-switch.test.ts`,
  `cli.runtime.fake.ts`: model literals move to `defineModel` when DeviceModel v2 fields become required. PortState
  literals gain role/ordinal/encap; DeviceTables fakes gain `get`/`names` (helper `createDeviceTables`).
- `device.frames.test.ts`: not-for-me is decided by role (same outcomes); demux specificity is unchanged; giant is
  mtu+18 (unchanged); the check order gains step 6, which P0 never hits.
- `ip.ipv4.test.ts:337-340`, `arp.receive.test.ts:19-22`: `handles` gain `roles` (and ipv4 its hdlc selector). In P1
  the ipv6 `handles` include `{layer:'hdlc', ethertype:0x86dd, roles:['wan']}`, and `serial.hdlc.test.ts` gains a
  serial dual-stack case (ping -6 across a clocked serial pair).
- `arp.receive.test.ts:68-75`, ip TTL tests, `ip.ipv4.test.ts:170-181`: fixtures carry `ipDefaults`/`processes`.
  Expected values are unchanged.
- `link.cabling.test.ts:19-28` (`deviceKind` fixtures and the `wiringOf(kind)` test): wiring comes from per-port
  `spec.wiring` (hub repeater and switch ports MDI-X, PC/router MDI); verdicts unchanged.
- **P1 W5 (catalog):** NF-C2960 gains the auto Vlan1 family, administratively down.
  - `device.runtime.test.ts:55` expects 27 interface sections.
  - `device.runtime.test.ts:54` `not.toContain('shutdown')` becomes: contains `interface Vlan1\n shutdown`.
  - Show goldens for NF-C2960 gain the Vlan1 row (administratively down).
  - P0 event sequences for `sim.two-pcs-switch` and the determinism probe are unchanged: Vlan1 is admin down (so oper
    down, and eth-switch makes no ingress clones) until `no shutdown`.

**Media (P0.5 W3–W4)**
- The in-flight key becomes (pdu, link, to); the web store/worker keys include `to`.
- Serial links in the real sim need `clock rate` on the DCE. No P0 scenario uses serial. `link.model.test.ts:281-317`
  keeps passing (its harness has no `portSettings`).
- Console links refuse data (`out-of-band`); no P0 test sends data on console.
- MEDIA `console` widens to terminal ethernet ports with connector pairing; link.cabling console cases are updated
  deliberately.

**CLI (P0.5 W2–W3; P1 W5)**
- `cli.parser.grammar.test.ts:65-77, 93-103`: kinds arrays become grammars/requires/portRequires assertions.
  `EXPECTED_IDS` becomes the union of the fragments. DEBUG_CATEGORIES grows through the registry.
- `cli.parser.match/help.test.ts`: `ctx(mode, kind)` helpers derive grammar and capabilities. P0.5 keeps P0 help lists
  identical. `cli.parser.match.test.ts:398` stays `unrecognized` in P0.5 (the switch has no `routing` capability).
- P1 deliberately changes:
  - `ip address` (config-if) drops `requiresAny: ['routing']` once L2 switches and APs get the Vlan family (P1 W5).
    `cli.parser.match.test.ts:398` then expects the portRequires mismatch (`CLI_MESSAGES.switchedPort`) on a switched
    port, and Vlan1 accepts the line;
  - the PC top-level help list (adds tracert, nslookup, netstat, ipv6config, wifi, adapter);
  - "PC cannot traceroute" (hosts get `tracert`);
  - `cli.runtime.jobs.test.ts:94-106` MSG_NO_IP_STACK on the switch, because L2 switches gain icmpv4 on their SVI.
- `config-ast` goldens are unchanged for P0 lines. The pinned "drops sub-mode `no`" test still holds for rules
  without `storeNegation`.
- Device boot replay and `applyFragment` move to `config-text` / `configure`. The sim.facade config-fragment
  assertion is unchanged.

**io / sim (P0.5 W1, W5)**
- `io.schema.test.ts` wrong-schema message lists both ids. Exports write 1.1. P0 canonical JSON is otherwise
  byte-identical (no slots or salts on P0 devices).
- `sim.facade.test.ts`: the export→load snapshot equality must still hold with the new snapshot fields.
- `exportTopology` keeps objectives, notes and lab.

**sim (P1 W6)**
- `sim.scenarios.p05.test.ts:51,57`: `SCENARIOS` becomes `[...TEMPLATES, ...CCNA1_LABS]`, so the exact name list and
  the `category === 'template'` loop scope to `TEMPLATES`; a new assertion pins `SCENARIOS.slice(0, TEMPLATES.length)`
  to `TEMPLATES` so the templates keep their menu order and stay first. The per-scenario `describe` loop still runs
  over all of `SCENARIOS`, so every lab topology is validated against the catalog.

**Protocol stack (P1 W1–W3)**
- `setPortL3` merge: P1 W2 device adds per-member merge and keeps the member-less fallback. P1 W3 l3 changes
  `ipv4.ts:235` (`no ip address`) to send `ipv4: null`, and `ip.ipv4.test.ts:85` expects
  `{type:'setPortL3', port, ipv4: null}`. The device.ts replace fallback is deleted at the W8 exit gate (§0 rule 2).
- `ip.ipv4.test.ts:262-273` splits in two: with a udp process → deliver; without → `unsupported-protocol` plus
  `icmp.error(3,2)`.
- `pdu.pdu.test.ts:113-115` switches to protocol 253 (a proto-17 payload now decodes as truncated UDP).
- `pdu.codecs.test.ts:57` registry key order: P0 five, then the P0.5 link codecs (changed in P0.5 W2), then the P1
  codecs (P1 W2).
- `arp.host.test.ts:23-89`: host offers the default route through `ipv4.route`; the row shape is unchanged.
- Limited broadcast without `iface` now drops `no-route` (the old gateway-unicast behaviour was a latent bug); a new
  test covers it.
- `cli.runtime.jobs.test.ts:108-139` keeps `icmp.abort` for ping; other jobs use `job.abort`.

### 9.3 Kind checks to remove (engine and web)

**Status (W7, 2026-09-18): all removed.** `DeviceKind` is read only by catalog validation (type-id prefix) and by
the web icon fallback (`KIND_DEFAULT_ICON`); the last behaviour branches (`link/cabling.ts` device nouns, MDI/MDI-X
by kind, computers by kind; `LinkModelDeps.deviceKind`; the CLI `kinds` gate) went at the exit gate.

**Engine**

| Location | Replacement |
|---|---|
| `device.ts:271` | `macFilterApplies` |
| `device.ts:244-267` | encap validators |
| `device.ts:565, 638, 646` | configurable trait |
| `device.ts:278` and `demux()` at `device.ts:654` | `demuxIndex` |
| `simulation.ts:208, 325, 738` | port/device snapshot v2; LinkModelDeps without `deviceKind` |
| `link.ts:153-156`, `cabling.ts:38, 58, 121, 187-194` | per-port wiring and labels |
| `arp.ts:100` | `ipDefaults.arpTimeoutNs` |
| `icmpv4.ts:83` | `ipDefaults.ttl` |
| `ipv4.ts:102` | `routeCause` via `route.owner === 'host'` (RouteRow.owner; not the process list, which APs, home routers and L3 switches also match) |
| `eth-switch.ts:86` | bridged trait |
| `grammar.ts:82` NET_KINDS and its 27 `kinds: NET_KINDS` entries | grammars: nfos |
| `grammar.ts:296,381` | `requiresAny: BRIDGING_CAPABILITIES` (catalog.ts) |
| `grammar.ts:391,468` | `requiresAny: [routing]` |
| `grammar.ts:506` | `requiresAny: ['routing']`, `portRequires: { roles: L3_ROLES, mismatch: CLI_MESSAGES.switchedPort }`. The L3 switch, home router and router keep `ip address`; NF-C2960 and wifi-ap-only APs stay `unrecognized` in P0.5, as in P0 (P1 change: §9.2 CLI) |
| `grammar.ts:583,592,601` | grammars: host |
| `parser.ts:45,147,152`, `runtime.ts:199` | scope |
| `runtime.ts:397` | `cli.initialPrivilege` |
| `show.ts:38, 54-60, 85` | configurable trait / PORT_FAMILIES label / MAC only for MAC-bearing encap |
| `pc.ts:32` | `hostPorts[0]` |

**Web**

| Location | Replacement |
|---|---|
| `Palette.tsx:10-58`, `devices.ts:45-85,185,212`, `ports.ts:38-50` | icon registry |
| `TablesView.tsx:366-367` | table presence + capabilities |
| `PortInspector.tsx:110-114`, `DeviceInspector.tsx:239` | configurable/role |
| `DeviceInspector.tsx:208,248` | category label |

---

## 10. Definition of done

Both stages require: the four checks green; no P0 test deleted or weakened; the exit gate applied; the
determinism rule (every acceptance scenario run 3× with the same seed gives byte-identical trace and snapshot JSON);
and the legal scan clean.

### 10.1 P0.5 acceptance tests (`packages/engine/test/`)

| Test | Scenario and pass condition |
|---|---|
| `accept.p05.catalog.test.ts` | Every catalog model validates, appears in `list()` in palette order, boots (runToIdle), snapshots structured-clone safe and reloads to an identical snapshot. Every module fits each compatible slot with unique names and ordinals. Web `visuals.test.ts`: every model's icon resolves without fallback. |
| `accept.p05.wifi-home-router.test.ts` | Laptop 40 m from `wrouter.nfhome` (wpa2-psk, SSID LAB) walks scanning→authenticating→associating→handshake→associated with 4 EAPOL frames, then pings PC1 on Gi1 5/5. Provenance: Decapsulate ethernet / Encapsulate dot11 at the laptop, the reverse at the router. Wrong passphrase → `failed` with reason `wrong-key` and no data frames. `cliOpen` on the home router is refused (`CLI_MESSAGES.noShell`), yet `configure` of Vlan1 works. |
| `accept.p05.hub-collision.test.ts` | Three PCs on `hub.nfhub4`: a ping PC1→PC3 is also received (and dropped not-for-me) by PC2 as a clone with `meta.parent`; `media.segments[0]` lists 3 stations + 4 repeater ports. Station ends negotiate 10 Mb half via parallel-detect. Two simultaneous pings yield ≥ 1 `collision` event and `backoff` draws on `link:<station cable id>:csma`; both complete; `collisions > 0` in `show interfaces`. |
| `accept.p05.l3switch-routed-port.test.ts` | `mlswitch.nfc3650-24` Gi1/0/24: `no switchport` + `ip address 10.1.1.1/24` → routed; a router pings it 5/5; the port stops flooding. `switchport` withdraws C/L routes with portState reason `role-change`. `no switchport` on NF-C2960 → `CLI_MESSAGES.roleLocked`. Save/reload keeps `no switchport`. Loopback0 is created and pingable; `no interface Vlan1` is refused. |
| `accept.p05.serial-clock.test.ts` | Two NF-2911 on `serial-dce`: without clock rate both ends are up/line protocol down with reason `no-clock`. `clock rate 64000` on the DCE → up, ping 5/5, serialization at 64 kb/s with 2 B overhead. `clock rate` on the DTE prints the DCE-only note. `keepalive 0` on R2 → R2 stays up/up; after 30 s R1 alone shows "up, line protocol down" with reason `keepalive-missed`; `keepalive 10` on R2 again → R1 recovers on the next keepalive. |
| `accept.p05.radio-bridge.test.ts` | Two `radio.nfptp5` with `distance_m 10000`, same channel and peer-key: PC–switch–radio ~ radio–switch–PC ping 5/5 at a table-derived rate. Key mismatch → `radio-key-mismatch`. Two `radio.nfptp60` at 1.5 km → `out-of-range`. |
| `accept.p05.modules.test.ts` | Powered-on `router.nf1941`: insert `mod.ehwic-2t` → `powered-on` with HARDWARE_MESSAGES wording. Powered off: Serial0/0/0–1 appear after the fixed ports with ordinals 128/129, `topologyChanged module add`, topologyVersion+1. `mod.nim-2t` → `does-not-fit`; a second insert → `slot-occupied`. Removing a cabled module removes the link first. Modules round-trip; `modules: []` gives an empty chassis; absent gives defaults. |
| `accept.p05.mac-stability.test.ts` | Worlds built in different orders and with different seeds give identical MACs per device id (D8 vectors). A forced collision persists `hardware.macSalt: 1` and reloads identically. |
| `accept.p05.configure.test.ts` | `configure(pc1, ['ip address 10.0.0.1 255.255.255.0 10.0.0.254'])` produces a running-config byte-identical to console typing, with configChange events only and no session listed. A bad mask reports the error column and skips later lines; `stopOnError:false` continues; `atomic` reverts to identical render text; device off → every line fails; a `ping` line → `CLI_MESSAGES.notHeadless`. The `ip dhcp pool` section renders once with children. |
| `accept.p05.cellular.test.ts` | `phone.nfsmartphone` in range of `cell.nftower` attaches after 300 ms and pings a server behind the tower backhaul. |
| `accept.p05.mobility.test.ts` | Dragging the laptop from 40 m to 120 m (0.25 m/unit) lowers bars and rate, with `rfState` only on changes. Beyond the drop threshold the association survives 2 s, then `beacon-loss`. Moving back reassociates only above −82 dBm. No flapping along the threshold; runToIdle terminates. |
| `accept.p05.determinism.test.ts` | A composite of a modular router with a serial module, an L3 switch with a routed port and loopback, a Wi-Fi home router and a hub gives byte-identical trace and snapshot 3×. The `sim.two-pcs-switch` and `sim.pc-router-pc` event sequences are unchanged (their snapshots differ only in MAC values). |

`accept.p05.coverage.test.ts` (W7) reads this table and fails when a listed file is missing or an
`accept.p05.*.test.ts` file is not listed.

**Web P0.5** (apps/web/test): `palette-query`, `cable-compat`, `gui.commands`, `worker.delta`, `store.delta`,
`keyboard-nav`, `tabs`, `visuals`, `vocab`.

Manual smoke:
- the palette shows every model;
- the cable picker shows DCE glyphs;
- wireless overlays toggle;
- the Desktop IP config app works;
- the slots panel refuses while powered on;
- everything is keyboard-operable.

### 10.2 P1 acceptance tests

| Test | Scenario and pass condition |
|---|---|
| `accept.p1.dhcp-dora.test.ts` | PC1 (`ip address dhcp`)–switch–R1 (pool LAN): exactly DISCOVER 0.0.0.0:68→255.255.255.255:67 → OFFER → REQUEST → ACK, each `triggeredBy` its predecessor. PC1 gets 192.168.1.2/24 with origin dhcp; the rib has C, L and D 0.0.0.0/0 AD 254 via .1; one bound binding row; PC1 pings .1 5/5. `ip default-gateway .254` replaces D with S, and removing it restores D. Relay variant: giaddr = R1 ingress address, hops 1. APIPA when no server answers (ARP probes via `arp.probe`); runToIdle returns before maxEvents with only periodic timers pending. Two concurrent resolves use distinct txids and sockets. |
| `accept.p1.browser-dns-http.test.ts` | `hostRequest(PC1, http.get http://www.lab.nf/)`: DNS query/response, SYN, SYN-ACK, ACK, GET (decoded http), 200 (decoded), FIN exchange. The http-client tab ends `done` with the configured body. The client socket is gone and the server socket sits in TIME_WAIT for 60 s. Port 81 → refused with an original tab message. |
| `accept.p1.tcp-handshake.test.ts` | Handshake visible with flags S / SA / A and seq/ack arithmetic. With 20 % loss the GET completes and every retransmission is a new pdu tagged `tcp-retransmit` with `triggeredBy`. One dropped segment of ten → 3 dup ACKs → one fast retransmit. The ephemeral port is identical across runs. |
| `accept.p1.ipv6-slaac-ping6.test.ts` | Trace shows DAD NS (src ::) for the link-local, RS, RA, DAD for the SLAAC address, then preferred `2001:db8:1::<eui64>` and rib6 `::/0` ND via the router link-local. `ping 2001:db8:2::5` across the router 5/5 with provenance hopLimit 64→63. A duplicate manual address is marked duplicate and logged. |
| `accept.p1.traceroute.test.ts` | Chain PC1–R1–R2–R3–PC3 built by the test with static routes: `tracert` on PC1 lists R1, R2 and R3 with 3 RTTs each and ends at PC3 on an echo reply; `traceroute` on R1 lists R2 and R3 and ends at PC3 on port-unreachable. A broken route prints `!N`; a black hole prints `*` until an abort, which prints the partial footer. |
| `accept.p1.netscope-filter.test.ts` | Capture on PC1 Gi0 while browsing. Filter `tcp.flags.syn == 1` returns exactly the SYN and SYN-ACK; `ip.addr == 192.168.1.80 && tcp.flags.syn == 1` the same. An invalid filter reports its column; completion offers `tcp.flags.*`. Follow stream shows the request and response text; the statistics hierarchy includes ethernet/ipv4/tcp/http. |
| `accept.p1.pcapng-export.test.ts` | pcapng export: SHB 0x0A0D0D0A with BOM 0x1A2B3C4D, IDB linktype 1 with `if_tsresol` 9, EPB count = records; bytes identical over 3 runs with `baseWallNs` 0; re-import gives identical rows and bytes. Classic pcap uses magic 0xa1b23c4d; a mixed-linktype capture is refused with `PCAP_MIXED_LINKTYPE_MESSAGE`. |
| `accept.p1.sim-mode-dhcp-offer.test.ts` | `runUntil(t, {stopOn: {kinds:['frameTx'], protos:['dhcp'], tags:['dhcp-offer']}})` stops right after the first OFFER frameTx with `now` at that event; resuming gives the same full trace as an uninterrupted run; `stepToNext` advances to the next match. Worker test: the batch carries `stopped {reason 'breakpoint'}` and a snapshot. |
| `accept.p1.duplex-mismatch.test.ts` | Switch Fa0/1 `duplex full` + `speed 100` vs PC auto: `phyNegotiated` mismatch duplex; under load the half end shows `lateCollisions > 0` and the full end runts/CRC errors > 0; loss is partial. auto/auto clears it. |
| `accept.p1.host-shell.test.ts` | `ipconfig /all` (live DHCP values), `/release`, `/renew` (blocks; ^C aborts via job.abort), `nslookup`, `ping www.lab.nf`, `netstat -an` (ESTABLISHED during a fetch), `ipv6config`, `ping -6`. |
| `accept.p1.passwords.test.ts` | `enable secret` renders nf1; enable prompts `Password: ` with input kind secret; 3 failures deny; console login with `line con 0` password + login. |
| `accept.p1.silence.test.ts` | Every P0/P0.5 template run 600 s → zero pduCreated from the P1 daemons. |
| `accept.p1.labs.test.ts` | Every CCNA1 lab: the reference `solution` via configure passes all tasks; the unsolved state fails its tasks; evaluation leaves the live trace head unchanged. |

**Web P1:**
- `concept.models.test.ts`: 192.168.1.130/26 gives network .128, broadcast .191, usable .129–.190, wildcard 0.0.0.63;
  2001:0db8:0000:0000:0000:ff00:0042:8329 compresses stepwise to 2001:db8::ff00:42:8329; EUI-64 vectors.
- Also: `markdown.test.ts`, `netscope-client.test.ts`, `sim-events-client.test.ts`, `line-editor` secret mode.

---

## 11. Deferred and reserved; risks to watch

**Deferred from the contract review:** adding `'tableExpire'` to the default sim-mode `list.kinds` (§4.11).

**Deferred at the P0.5 exit gate (W7, 2026-09-18) — settled at the P1 exit gate (W8, §12.2) except where noted:**
- `Simulation.hostRequest` stays unimplemented and optional until P1: its apps are the P1 browser fetch and DHCP
  renew/release; the P0.5 Wi-Fi scan is served by the host shell (`wifi list`) and the worker falls back to it.
  **Done (W6); required since W8.**
- `PduSummary.layers` is filled from P1 (sim-mode protocol filters, NetScope); filling it earlier would change the
  pinned P0 trace bytes. `matchesTraceFilter` already falls back to `[proto]`. **STILL DEFERRED after W8:** no P1
  wave filled it, the three `pduSummary` builders (device/process-ctx.ts, link/link.ts, link/media/p2p.ts) still
  omit it, and the sim-mode protocol filters ship on the `[proto]` fallback. Filling it would still change the
  pinned P0 trace bytes, so it stays optional and needs its own migration-list entry before a later stage fills it.
- The P0 `setPortL3` replace fallback stays until W8 (§0 rule 2, §9.2). **Deleted at W8.**
- Defensive `?? default` reads of now-required members (`specRole`, `specEncap`, `effectivePortRole`, and web
  readers of snapshot fields that hand-built web test fixtures omit) are kept; they are dead for engine data and
  may be dropped at W8 together with the web fixture migration (web tests are not type-checked).
  **W8: the engine-side dead `?.` calls on required `LinkModelDeps` members were dropped (19 sites). `specRole` /
  `specEncap` / `effectivePortRole` KEEP their `??`: they are the shared derivation path for catalog `PortInput`
  and `ModulePortTemplate.spec`, which are `PortSpecDerived` and legitimately omit `role`/`encap`. The web readers
  keep theirs pending the web fixture migration.**

**Deferred** (reserved names or ports only):
- FTP, TFTP, SMTP, POP3, IMAP, NTP, SNMP, Syslog, Telnet/SSH (and nested sessions);
- HTTPS/TLS, DHCPv6, PPP (`encapsulation ppp`), VLANs/trunking (non-1 SVIs stay down);
- NAT/PAT on home routers, WLC/CAPWAP, multi-BSS per radio, PoE behaviour, cloud provider mode, IPv6 fragmentation
  and reassembly;
- timeline/time travel, the physical view, GUI undo, journaling of user commands for exact replay.

**Risks and mitigations:**
- **Fixture churn** when optional members become required. Land `defineModel`, `createDeviceTables` and a
  `testPortState` helper first, then migrate mechanically.
- **Retroactive CSMA cancellation.** A missed receiver seq delivers a phantom frame; test it with an in-flight
  inspector.
- **Trace volume** from fan-out, TCP ACKs and NDP. Beacons are off by default, keepalives are background, and the
  batch cap and worker queries apply.
- **Role-change bounce.** Daemons must trust the `onLinkChange` `up` argument, not the port view.
- **Parent-mode fallback** can run a global command typed in a sub-mode (IOS-faithful). Help goldens pin behaviour.
- **Lease timers are periodic**, so graders relying on renewals must use `runFor`.
- **RFC 5952 normalisation gaps** cause key mismatches. Every ingress normalises; mixed-form tests.
- **Plaintext Wi-Fi passphrases** live in configs and exports. Snapshots never include them; the UI shows a notice on
  export.
- **Owner egress recursion loops.** Catalog validation checks owners, and an owner's own send never re-enters
  `onEgress`.
- **Integer log tables** are committed constants; regenerating them changes every RF golden.

---

## 12. Review changes (contract review, applied in wave 0)

Confirmed findings, and where they landed:

1. **Wi-Fi association could never complete** (mgmt/EAPOL dropped as link-down before authorization). §3.1 step 4 gates
   wlan ports on `phy.carrier`; `LinkModel.transmit` doc splits cable/air rules; medium.ts states station carrier is up
   when the radio is powered and admin up. Runtime `device.ts` step 4 implements the carrier gate.
2. **Serial keepalive deadlock and wrong end.** Per-end keepalive latch (§3.4 step 8, §3.9, medium.ts, link.ts
   `PortPhy`/`LinkState.up`); HDLC keepalive (0x8035) exemption on transmit and ingress while an end is down only by
   keepalive (also in `device.ts` step 4); new MediumEvent `carrier`; hdlc daemon arms `ka:<port>` from carrier and
   config only. Acceptance: R2 `keepalive 0` stays up/up, R1 alone goes down.
3. **Re-split rng per use returned identical values** (ISN, xid, jitter, APIPA, DNS txid, ND delays). New
   `ProcessCtx.stream(label)` (implemented in `device/process-ctx.ts`); transport.ts, services.ts, §4.3, §4.4, §4.5,
   §4.6, §5.1 and D12 use it; DNS sockets/timers keyed by a per-process query counter (`dns-client#q<n>`, `q:<n>`),
   replies matched on (socket, txid). Findings 6 and 13 (same defect) are covered by this design; their alternative
   "cache in process state" wording was not adopted, to keep one mechanism.
4. **P0.5 hub stations were full duplex.** §3.4 P0.5 negotiation: autoneg ↔ repeater parallel-detects 10 Mb half;
   W1 media negotiation tests.
5. **runToIdle never returned for an unserved DHCP client.** Periodic `dhcp-restart:<iface>`, non-periodic `dhcp:*`
   and `arp-probe:*` (services.ts constants and prefixes, process.ts/events.ts comments, D10, §4.3, §5.2, §10.2).
   Merged with findings 11 and 19.
6. (see 3)
7. **UDP sockets closed by ICMP errors** broke traceroute. transport.ts `sock.error` doc: UDP errors never close; §4.2.
8. **HDLC keepalives could not recover the line.** Same fix as 2. Conflict: finding 8 proposed no new MediumEvent and a
   boot-armed timer that checks carrier on every firing; finding 2's `carrier` MediumEvent was chosen, because a
   boot-armed periodic timer would run on every unconnected serial port. Finding 8's exemption wording was adopted.
9. **IPv6 over serial received nowhere.** ipv6 hdlc selector (process.ts header, §3.9), `nd.sendVia` on hdlc, §4.6,
   §9.2 test note.
10. **No APIPA ARP probe message.** `arp.probe` request (process.ts) and `ArpProbeResultEvent` (transport.ts, in the
    ProcessEvent union); §4.3; l3 W3 owns it.
11. (see 5) plus the TCP persist cap: `TCP_PERSIST_MAX_PROBES` (transport.ts), §4.5, §5.2.
12. **pcap FCS handling.** `StandaloneDecodeFn` gains `opts.fcsLen`; `CaptureInterface.fcsLen: 0 | 2 | 4`;
    `outerForLinkType` helper (raw → ipv4/ipv6); §4.12 live/export/import rules.
13. (see 3)
14. **`@netforge/engine/pure` could not resolve.** Stack owns package.json exports, web tsconfig paths and the vite alias
    (ordered object keys, pure first) in the change that creates `src/pure.ts`, plus a web smoke test (§8.2 W2).
    Conflict: finding 22's regex array alias was not adopted; ordered string keys are enough and keep `@/x` behaviour.
15. **Auto Vlan1 on NF-C2960 changed P0 sequences.** `defaultAdminUp:false` for switch SVIs (catalog.ts doc, §8.2 W5
    data), §9.2 Vlan1 test migrations.
16. **setPortL3 migration had three homes.** W2 device merge keeping the fallback, W3 l3 `ipv4: null`, W8 deletes the
    fallback (process.ts, device.ts comment, §8.2, §9.2).
17. **`src/pure.ts` depended on a same-wave module.** Moved to P1 W2 stack.
18. **`ip address` scope change broke a P0 parser pin.** §9.3 row keeps `requiresAny: ['routing']` in P0.5 with
    `CLI_MESSAGES.switchedPort` as the port mismatch; §9.2 records the P1 change.
19. (see 5)
20. **Comlink dropped `TopologyLoadError.problems`.** New `apps/web/src/bridge/errors.ts` shared 'throw' handler,
    imported by engine.worker.ts and client.ts (guarded for tests that mock comlink); protocol.ts rejection docs.
21. **No analyser contract for imported captures.** `CaptureFile`, `ReadCapture`, `WriteCapture`, `CaptureStore`,
    `CaptureStoreInit`, `CreateCaptureStore` in capture.ts; §4.12 delegation sentence.
22. **Ownership of shared entry/config files.** §8 index.ts rule (architect-owned, append-only per wave item); D14
    notes P0.5 web code does not use the pure entry. Config ownership per 14.
23. **Lab lifecycle had no contract.** `topology.lab` round-trip doc, `EvaluateLab` type (scenario.ts), §4.13 load and
    reopen steps.
24. **Paused deltas went stale.** Dirty-set additions and always-post rule for mutating calls (protocol.ts header,
    §3.14 Worker), `worker.delta.test.ts` case.
25. **stepToNext had no horizon.** `SIM_STEP_HORIZON_NS`, `SIM_STEP_MAX_EVENTS`, `ended` (protocol.ts), §4.11 step 4,
    run-control test.

Minor findings applied: segment stream ids = transmitting station's cable, cached (M1; link.ts, §3.5, §5.1);
pre-association air streams `air:scan:<key>` and BSS selection (M2; link.ts, §3.6); moves recompute overlapping
band/channel pairs (M3; link.ts, §3.6); delta dirty marks for media events (M4, merged into 24); `bss-in-range`
MediumEvent (M5; medium.ts, §3.6); socket bind-conflict key (M6; transport.ts, §4.2); tcp codec dispatch vs http
`partial` (M7; fields.ts, §4.5); RST contents (M8; §4.2); `RouteRow.owner` for routeCause and host offering only
without IP forwarding (M9; tables.ts, §4.2, §9.3); `BRIDGING_CAPABILITIES` (M10; catalog.ts, §9.3); `ipDefaultsFor`
(M11; catalog.ts, D2); position rounding at `addDevice` (M12; simulation.ts, D12, §3.14); `linkKindOf` (M13; link.ts,
§3.14); drop event `medium`/`association` (M14; trace.ts); `ScenarioMeta.missingTypes` (M15; scenario.ts, §4.13,
protocol.ts).

Deferred: the optional `'tableExpire'` default in the sim-mode list filter (finding 25, optional item 3).

### 12.1 P0.5 exit gate record (W7, 2026-09-18)

All five checks green after the gate: engine `tsc` and `vitest`, web `tsc` and `vitest`, `vite build`. No test was
deleted or weakened; tests of removed P0 fallbacks were migrated to the equivalent data-driven assertion.

**Deleted P0 members and helpers.** `CommandSpec.kinds` (with `MatchContext.kind`, `ScopeInput.kind` and the kind
component of the scope cache key), `PERIODIC_TIMER_KEYS` (sim.facade now asserts the `periodic` flag of the pending
sweep), `macFromIndex`, `DeviceRuntimeDeps.nextPortIndex`, `LinkModelDeps.deviceKind`, `DeviceCatalog.canonicalPort`
(the free `canonicalPort` helper of `device/catalog.ts` stays for the P0 name table), `wiringOf`, `deviceNoun`,
`PortSpecLike.deviceKind`, `LEGACY_CLI_SPEC`, and the P0 `setMode` / "no virtual-port ops" fallbacks in the CLI
handlers. Cable messages now always name the two ends by label (`PC1 GigabitEthernet0 to PC2 GigabitEthernet0`);
verdicts are unchanged.

**`?` removed (transition-only members).**
- `device.ts`: DeviceModel `category family variant icon tags capabilities cli gui slots virtualFamilies hostPorts
  portOwners tables ipDefaults`; DeviceSpec `modules macSalt`; DeviceCatalog `module modules resolvePort`;
  DeviceRuntime `modules macBase capabilities portsVersion insertModule removeModule modulePorts ensureVirtualPort
  removeVirtualPort setPortRole resolvePortName phySettings radioSettings onTxOutcome onMediumEvent`;
  DeviceRuntimeDeps `airView mediumOp`.
- `port.ts`: PortSpec `role allowedRoles connector encap ordinal` (catalog data may still omit them: `PortInput` and
  `ModulePortTemplate.spec` use `PortSpecDerived`); PortState `role ordinal encap`.
- `cli.ts`: CliSessionView `grammar`; CliRuntimeDeps `radioView airView`; CommandCtx `grammar capabilities context
  headless enterMode radioView air` and `device.ensureVirtualPort / removeVirtualPort / setPortRole`.
- `process.ts`: ProcessCtx `rewrap hasCapability`; DemuxSelector `roles` (built-in daemons already declared them;
  fixtures list `FRAME_ROLES` for "every frame role").
- `tables.ts`: DeviceTables `get names`. `link.ts`: LinkModelDeps `hostTerminal portSettings radioSettings
  transceiver position onTxOutcome notify`. `snapshot.ts`: PortSnapshot `role allowedRoles encap ordinal virtual
  linkable configurable connector`; DeviceSnapshot `category family variant icon capabilities cli gui hostPorts
  baseMac` (key order unchanged, so snapshot JSON is byte-identical). Web `store/types.ts`: PendingCable `media`
  (`setPendingCable` fills the picker media when omitted).
- Test fixtures: `test/port.fixtures.ts` (`testPortSpec`, `portStateFields`, `testModel`, `INERT_LINK_DEPS`,
  `p0Tables`) fills the new members for hand-built models, ports, link deps and table triples.

**`?` kept on purpose.** These members are optional by meaning, not by transition: absence is a defined value that
the engine produces or accepts after P0.5.
- Present only in some cases (data, wire and file formats): PortSpec `wiring slot module radio promiscuous group
  defaultAdminUp mtu clockSource`, PortState `phy module transceiver`, the P0.5 counters of PortCounters (created on
  first increment; keeps P0 snapshot bytes), DeviceModel `poeBudgetW`, DeviceSpec/DeviceSnapshot/topology `ui`,
  every optional field of `events.ts`, `trace.ts` (except `PduSummary.layers`, below), `topology.ts`, LinkSpec/
  LinkState/LinkSnapshot/TransmitResult/MediaSpec, `PduMeta.background`, PortSnapshot `phy phySettings radio`,
  `tables.extra`, SimSnapshot `media`, the web batch `delta` / `eventsTruncated` and DropMarker `at.association`.
- Declarative options with a documented default: CommandSpec `grammars requires requiresAny portRequires job
  sessionEffect hidden since`, ArgSpec `completion pattern portFilter maxLength`, AddDeviceOptions/AddLinkSpec
  (`modules macSalt ui kind dceEnd distanceOverrideM`), CliRuntimeDeps `grammar`, LinkModelDeps `metresPerUnit`,
  Action `ingress.layer`.
- Context-dependent views: CommandCtx `iface` (interface modes only), CliSessionView `context job`, ProcessCtx `air`
  (devices without radios).
- Optional hooks and codec features: Process `onEgress onMediumEvent`, Codec `transparent fixTrailer`.
- Link-model DI defaults used by focused link harnesses: LinkModelDeps `pdus` (absent = receivers share the pdu),
  `devices` and `devicePorts` (absent = first-seen order). The Simulation always supplies them.
- Filled only by P1 behaviour: `Simulation.hostRequest` (browser fetch, DHCP renew/release; §11) and
  `PduSummary.layers` (sim-mode filters, NetScope; §11).

---

### 12.2 P1 exit gate record (W8, 2026-09-20)

All five checks green after the gate: engine `tsc` and `vitest` (161 files / 2493 tests), web `tsc` and `vitest`
(41 files / 647 tests), `vite build`. No test was deleted or weakened; the two tests that pinned the removed
`setPortL3` fallback were migrated to the explicit `ipv4: null` form they now describe.

**Deletions §0 rule 2 mandates.** `CommandSpec.kinds`, `PERIODIC_TIMER_KEYS`, `macFromIndex`,
`DeviceRuntimeDeps.nextPortIndex`, `LinkModelDeps.deviceKind` and `DeviceCatalog.canonicalPort` were already gone
at the P0.5 exit gate (§12.1); this gate deleted the last item, the **P0 `setPortL3` replace fallback** in
`device/device.ts` `mergePortL3` (§9.2 "Protocol stack (P1 W1–W3)"). A member-less `setPortL3` action is now a
no-op; `ipv4` already clears with `ipv4: null` (P1 W3). Migrated: `device.ctx.test.ts` ("a member-less action is a
no-op"), `device.runtime.test.ts:506`, and the mirror of the fallback in the `ip.fake-ctx.ts` action router.

**`?` removed (transition-only members).**
- `simulation.ts` `Simulation`: `hostRequest`, `startCapture`, `stopCapture`, `removeCapture`, `captures`,
  `queryCapture`, `captureRecord`, `followStream`, `captureStats`, `exportCapture` (all implemented in W1/W3/W6).
- `process.ts` `ProcessCtx`: `stream` (wave 0) and the five IPv6 helpers `lpm6`, `ownAddress6`,
  `isLocalDestination6`, `connectedPortFor6`, `sourceFor6` (P1 W2, `device/process-ctx.ts`).
- Fixtures migrated: `test/port.fixtures.ts` gains `NO_IPV6_CTX` (the five helpers as an IPv4-only harness answers
  them) for `arp.harness.ts`, `ip.fake-ctx.ts` and `l2.eth-switch.test.ts` (which also gains `stream`);
  `l4.udp.test.ts` gains real `isLocalDestination6` / `connectedPortFor6`.
- The defensive `ctx.stream?.(…) ?? ctx.rng` and `ctx.<v6helper>?.(…)` call sites in `dhcp-client`, `dns-client`,
  `dns-server`, `http-client`, `tcp` and `udp` were dropped with them (the fallback arm was already unreachable,
  so no rng draw changed), as were 19 dead `deps.<member>?.(` calls on required `LinkModelDeps` members in
  `link/link.ts` and `link/media/{air,cell,radio}.ts`.

**`?` kept on purpose (P1 members).** Optional by meaning, not by transition:
- Present only in some cases: `PortIpv4Address` `origin leaseExpiresAt` (absent = a manual P0 address; `ipv4.ts`
  reads `origin === undefined` as "static" at three decision points, and omitting them keeps P0 snapshot bytes),
  `PortL3` `ipv6 ipv6Enabled groups6` (no IPv6 on the port), `RunStats` `stopped stopEvent stopCursor` (only when a
  run stopped early), `RouteRow.owner` (only arbitrated rows; rib6 stamps no owner), `ScenarioInfo.missingTypes`
  (absent = available), `TopologyFile.lab` (labs only), `CliResult`/`CliSessionView`/`cliPrompt` `input` and
  `CommandOutcome.ask` (only while an input request is open).
- Declarative options with a documented default: `CommandSpec.interactive`, `PortSpec` `duplexModes autoneg`,
  `CodecContext.fcsLen`.
- Optional hooks and codec features: `Process` `onEvent onShutdown`, `Codec` `derived outerInputs stopsMeaning`.
- Link-model DI default: `LinkModelDeps.capture` (absent = no tap; the Simulation always passes the capture hub,
  focused link harnesses pass nothing) — the same category as `pdus` / `devices` / `devicePorts` in §12.1.

**Not promotable; reported instead of forced.** `MediumOps.injectNoise` (`contracts/link.ts`) is tagged `@since P1`
but no wave implements or calls it. Its fault kinds (`rf-interference`, `radio-fade`, `duplex-mismatch`,
`clock-missing`, `collision-storm`) also fall through the `default:` arm of `handleFault` in `sim/simulation.ts`,
so `injectFault` accepts them and does nothing. None of them appears in §10.2, so this is unfinished work, not a
transition leftover: the `?` stays until a wave implements the hook.

**Sweep.** No TODO/FIXME/XXX, no commented-out code, no `skip`/`only`/`todo` test in either suite. Removed as dead:
`SVI_HANDLERS` and `TRACEROUTE_HANDLERS` (empty `{} as const` placeholders), `ProcessCtx`-era `TriggeredBy`,
`isIpv6Extension` with its now-orphaned `EXTENSION_PROTOS`, web `NetScopePanel` (a dead alias whose comment claimed
`app/Dock.tsx` used it — the dock imports `NetScope` directly), `cachedPdu` and `labInstructionsText`. Corrected a
stale future-tense comment in `cli/grammar/svi.ts` (`wifi-ap` is already in `requiresAny`). Replaced the raw U+0000
in `device/device.ts`'s `timerKey` template with the `\0` escape (same string; the literal control byte made `grep`
and `git diff` treat the largest engine file as binary).

**Left standing, with reasons.** `contracts/pdu.ts`'s `@since P1` well-known-port block (`UDP_PORT_DNS`,
`UDP_PORT_DHCP_SERVER/CLIENT`, `TCP_PORT_DNS`, `TCP_PORT_HTTP`, `TCP_PORT_HTTP_ALT`, `TRACEROUTE_BASE_PORT`) has no
consumer — the daemons use the numeric literals — and so do `CONFIG_INVALIDATING_KINDS`, `HandlerId`,
`DhcpClientIdentity`, `ParsedTopology`, `ParsedManifest` and eight unused web store hooks in `store/selectors.ts`.
Deleting contract vocabulary, or rewriting daemon internals to consume it, is a contract change; §0 rule 3 asks for
a report rather than a unilateral fix.

**Stale P1-as-future behaviour in the web, not fixed here.** `inspector/HomeRouterPanel.tsx` still ships
`DHCP_LATER_NOTE` ("not part of this release; it arrives with the next stage"), marks the `dhcp` WAN mode
`available: false`, and rejects it with "not available in this release" — but the home router model carries the
`dhcp-server` capability, so at `CATALOG_STAGE = 'P1'` it runs `udp` + `dhcp-server`. The panel is a P0.5 row in §7
that no P1 wave item touches, `gui/commands.ts` emits no DHCP lines, and `apps/web/test/inspector.panels.test.ts`
pins the note to `/next stage/`. Making the panel tell the truth is a web feature plus a deliberate test change,
so it needs a §9.2 entry and an owner, not a gate edit.

**§9.2 check.** Every item is done or correctly pending. One location differs from the plan: the "serial dual-stack
case (ping -6 across a clocked serial pair)" landed in `ip6.nd.test.ts` ("ip6.nd on serial links") rather than in
`serial.hdlc.test.ts`; the coverage §9.2 asks for exists (HDLC 0x86dd DAD/RA framing plus a 5/5 `ping -6` across
the pair).
