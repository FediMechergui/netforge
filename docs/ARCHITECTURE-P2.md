# NetForge — P2 (CCNA 2): binding architecture brief

> **Status: design, revised after adversarial review (§13); wave 0 not yet applied.** P0, P0.5 and P1 are complete and
> live (engine 165 files / 2528 tests, web 43 / 685). This document is the binding design for stage P2. Nothing in it
> is built yet. Everything deliberately left for later is listed in §8 (cut lines) and §12. The decisions the product
> owner records before wave 0 are in §8.5.

This is the binding brief for the P2 build. Read it together with the contracts, which are the interfaces every
module compiles against:

- `packages/engine/src/contracts/*.ts` after wave 0 (§2 lists every addition),
- `apps/web/src/bridge/protocol.ts` and `apps/web/src/store/types.ts`.

`docs/ARCHITECTURE.md` (P0) and `docs/ARCHITECTURE-P1.md` (P0.5 + P1) stay in force. Where this document differs,
this document wins.

Other sources:

- Spec: `docs/netforge-spec.md` §2.2 (CCNA 2 engine requirements), §4.8–§4.9, §6, §9 (in particular §9.5, §9.6,
  §9.7, §9.8), §12, §19 (row P2) and §20 (risks R2, R3, R5, R6, R8).
- Device data: `docs/CATALOG.md`. Field names: `contracts/fields.ts`.
- The code at commit 7e623b9. Line numbers below refer to that commit.

Stage P2 in one sentence: VLANs, 802.1Q trunks and DTP; inter-VLAN routing (router-on-a-stick, SVIs); the spanning
tree family; EtherChannel; port security; static routing done properly; DHCPv6; NAT; first-hop redundancy; a
wireless controller with lightweight access points; VLAN and spanning-tree overlays; a timeline with time travel;
and the CCNA 2 course. The exit criterion (§19) is "CCNA 2 complete". §8 draws the cut lines that decide what
"complete" costs.

---

## 0. Rules for implementers

P1's rules carry forward unchanged in substance. Rules 7–13 are new and come from building P1 (and from the review of
this brief, §13).

1. **One owner per file, build waves.** §7 gives each file exactly one owner and a wave. A module in wave N may
   depend only on waves < N, plus the contracts (wave 0). `packages/engine/src/index.ts` is architect-owned and
   append-only: a wave item adds only its own `export * from './<its files>.js'` lines, in the change that creates
   those files. The architect reconciles it at the exit gate.
2. **TRANSITION RULE.** Every contract member tagged `@since P2` is optional in the type only, so that P1 code and
   hand-written fixtures still compile.
   - The wave item that implements a member removes its `?` in the same change and migrates the fixtures.
   - Code written in later waves may rely on the member being present.
   - The exit gate (W8) removes any `?` that is left, except members that are **optional by meaning**. Those are
     tagged so in §2 and listed in full in §2.15; they never lose their `?`, because an absent member is what keeps
     P1 bytes (a required `PduSummary.vlan` would add a key to every frameTx summary and change every golden). A W8
     type-level test (`contracts.optional-by-meaning.test.ts`) asserts that each §2.15 member still carries `?`.
   - **Fixtures.** Required `ProcessCtx` and `DeviceRuntime` members would break the hand-written typed fakes (the
     engine tsconfig type-checks `test/**`). Wave 0 adds the spreads `P2_CTX` (`profile: 'P1'`, a `transition` that
     records through `debug`) and `P2_DEVICE` (`profile: 'P1'`, an `errDisablePort` that records the call) to
     `test/port.fixtures.ts`, as P1 did with `NO_IPV6_CTX`. The item that makes a member required spreads them into
     the six typed fakes §9 names (an additive fixture migration; the assertions do not change).
   - **Tag collision.** The course layer already uses `@since P2` for delivered, required members (10 occurrences in
     `apps/web/src/{store/types.ts,app/App.tsx,app/TopBar.tsx,app/Workspace.tsx}`, plus the header of
     `contracts/curriculum.ts`). Wave 0 retags them `@since course`, so the transition sweep never touches them.
3. **Contract changes after wave 0** are the minimal additive fix, reported in the wave report.
   - **The SHOULD set is decided before wave 0** (§8.5). Wave 0 adds the contract blocks of every approved
     **[SHOULD]** item exactly like MUST blocks, together with their web compile stubs (a new `ProtoName` breaks the
     exhaustive `PROTOCOL_VOCAB`; a new `WifiSecurity` breaks `WIFI_SECURITY_LABELS` and `WIFI_SECURITY_TEXT`; a new
     `WifiAssocState` breaks `WIFI_ASSOC_STATE_VOCAB`), so parallel consumers never wait for one another.
   - A SHOULD or COULD item approved **later** is added by exactly one named wave item, which in the same change adds
     the block verbatim and the web stub entries it forces (a reviewed edit of the web owner's files). Its consumers
     are scheduled in the next wave. A block for a feature that is not approved is never added, so no dead
     vocabulary ships.
   - **Daemon names follow their factories.** A daemon name enters `PROCESS_ORDER`, `CAPABILITY_PROCESSES` and
     `L2_PROCESSES` only in the change that registers its factory (`protocols.registry.test.ts` pins the registry to
     exactly `PROCESS_ORDER`). §2.1 records each name's final position; the name is inserted there when it arrives.
4. **Every change keeps the five checks green:**
   - `npx tsc -p packages/engine/tsconfig.json`
   - `npx vitest run --root packages/engine`
   - `cd apps/web && npx tsc -p tsconfig.json`
   - `npx vitest run --root apps/web`
   - `npm run build -w @netforge/web` (vite build of the production bundle)

   Never run `npm install` or add a dependency without explicit approval (none is planned for P2). Pinned values
   change only through the migration list (§9).
5. **Silence rule.** A daemon sends nothing unless configured. In P2, "configured" includes the lines a world's
   defaults profile replays at boot (D2). Every P0/P0.5/P1 scenario, template, CCNA 1 lab and saved file runs in the
   P1 profile and keeps byte-identical traffic and trace. §4.3 gives, for every new daemon, the exact line that turns
   it on. **The proof is a golden, not an argument:** wave 0 records `test/goldens/p1-profile-digests.json` from the
   unchanged engine (§10.1 `accept.p2.p1-digests`), and the only P1-profile trace changes allowed are the ones §9.3
   lists, each with its reason and each regenerated by the architect.
6. **Legal (D22).** Names, help, errors, show output, log messages, lab text and lesson text are original wording.
   Model names are `NF-…`. Vendor-proprietary wire formats are replaced by original NF formats (D8). Protocol names
   that are part of the CCNA vocabulary (DTP, VTP, PAgP, HSRP, PVST+, CAPWAP) are used as names only.
7. **Seams are contracts, spelled out.** P1's defects hid between modules built in parallel. Every seam in P2 has an
   exact contract in §2: the action or request kind, every field, the table row shape, the event kind and who sends
   it to whom. An implementer who needs something that is not in §2 stops and reports it; it does not invent a
   private convention with a neighbour.
8. **Every wave ends with review → adversarial verify → fix.**
   - Review: the wave's items are read against this brief, clause by clause.
   - Adversarial verify: a separate agent tries to break each seam the wave touched (wrong order of events, a port
     that flaps mid-negotiation, a daemon that is absent, a VLAN that does not exist, replaying the scenario with the
     same seed and comparing bytes).
   - Fix: confirmed findings are fixed before the next wave starts. Plausible but unconfirmed findings are listed in
     the wave report.
9. **Own tests only; one full suite per wave.** An implementer runs only its own test files (and the files the
   migration list assigns to it). An implementer's own tests may depend only on earlier waves (and on its own item);
   a test that needs a same-wave item of another owner belongs to a later wave. The lead runs the full five checks
   once at the end of the wave, after the fixes, and runs `accept.p2.p1-digests` at the end of every wave and inside
   every catalog-flip change (W4, W6).
10. **The built bundle is a gate item.** Passing unit tests did not prove P1 worked: a circular import broke the
    production bundle with every check green (f4f883e). Every wave that touches `apps/web` ends with gate **G**:
    1. `npm run build -w @netforge/web`;
    2. start the `netforge-preview` launch configuration (`.claude/launch.json`), which serves the BUILT bundle;
    3. in a real browser: load the wave's named scenario (§10.3), toggle every overlay added so far, open a terminal
       and type one command (use the synthetic-paste technique for console lines), and select one device and one
       packet;
    4. the browser console shows no error and no unhandled rejection.

    Waves that touch only the engine run G too once the catalog has flipped (W4 onwards), because engine modules are
    bundled into the worker.
11. **Never weaken a test.** Acceptance tests (§10) are contracts: an assertion is never loosened, deleted or skipped
    to make a build pass. A test that pinned P1 behaviour changes only when §9 lists it, and only in the way §9 says.
12. **Module-scope reads of other modules are forbidden in new code.** Cross-module constants are read at call time
    (the cause of f4f883e). New registries (overlay modules, lanes, control-frame table) are plain data or are built
    lazily on first use.
13. **Real worlds before the flip.** The catalog flips to P2 only in W4, but W2–W3 daemons must be exercised in real
    simulations (real link timing, real runtime) before then. `SimulationOptions.catalog` (§2.9, tests and tooling
    only) and the W1 helper `test/p2.world.ts` build worlds from P2-stage models and the factories a test passes in.
    Seam tests, timing tests, the parity test and each wave's adversarial verify run on it; the W4 wired acceptance
    tests run on it too, so the first integration of eth-switch, stp, etherchannel, dtp and the runtime is never the
    flip itself.

---

## 1. Fixed decisions D1–D23 and the chosen designs

Each decision names the design chosen and the alternative rejected, with the reason.

**D1 — One stage, one contract set, cut lines.**
P2 delivers the CCNA 2 engine requirements of spec §2.2, the P2 visualization row of §19 (VLAN and STP overlays,
timeline and time travel) and the CCNA 2 course. The work is ranked in §8 into MUST (what "CCNA 2 complete" needs),
SHOULD and COULD. Waves (§7) put the most foundational MUST work first and the heaviest optional work last, so a cut
removes whole wave items and never a piece of a seam.

**D2 — A world has a defaults profile.**
- `Topology.profile?: 'P2'` (schema 1.2). **Absent means `'P1'`.** Every file saved before P2, every template, every
  CCNA 1 lab and every engine test that builds a world without naming a profile runs in the P1 profile.
- Every CCNA 2 lab uses `'P2'`. A new world made by the web app (`EngineApi.init` at app start, `reset` for
  File → New) takes the profile of the **course context**: `'P1'` when the lesson the learner last opened belongs to
  CCNA 1, `'P2'` otherwise (a CCNA 2 lesson, or no lesson yet). Entering the sandbox from a lesson while the world has
  no devices re-initialises it with that lesson's course profile. So a CCNA 1 lesson that says "drag two PCs and a
  switch and ping" still pings at once, and CCNA 1 lesson text does not change (§11.3, §10.2).
- The profile decides only **defaults**. It never gates a feature: every P2 command works in a P1 world when typed.
- Two mechanisms, each with one job:
  - *Visible defaults* (lines a real device shows in its running configuration) are **replayed as config lines at
    every boot** from `DeviceModel.profileConfig[profile]`, after `DeviceModel.defaultConfig` (device.ts:555) and
    before the saved configuration. In P2: managed switches get `spanning-tree mode pvst` (NF-C9300:
    `rapid-pvst`) and `spanning-tree extend system-id`; multilayer switches also get `no ip routing`; the
    lightweight access point gets `capwap enable`, `interface Vlan1` / `ip address dhcp` / `no shutdown`.
  - *Invisible defaults* (behaviour a real device has with no line shown) are read from `ProcessCtx.profile`. In P2
    there is exactly one: proxy ARP is on for routed interfaces of routing devices (`no ip proxy-arp` turns it off).
- **Completeness rule** (so that reversing a default survives save, reload and the grader's clone). Let *D* be the
  lines a device's boot replays before its saved configuration (`defaultConfig` plus `profileConfig[k]` for every k
  with `profileIncludes(profile, k)`); the slots those lines fill are the device's *default slots*. Replay always
  runs *D* first and then the saved lines, so the rendered running configuration must record every departure from
  *D*:
  1. A line whose ordinary storage would leave a default slot empty — the identity-only form of a stored-negation
     rule, or a `no` form of an ordinary rule (`no ip address` or `no capwap enable` on the lightweight AP) — is
     **stored explicitly** in that slot instead of storing nothing. (`ip routing` needs no special case: its rule
     becomes `bothForms`, so `ip routing` and `no ip routing` are one slot and each is stored as typed, §5.)
  2. A rule marked `negationRestoresDefault` (only `spanning-tree mode`) stores *D*'s line for the slot when its `no`
     form is applied (the P2 default mode), or clears the slot when *D* has none (the P1 default: no spanning tree).
  3. `no spanning-tree extend system-id` is refused (`CLI_MESSAGES.extendSystemIdFixed`): NF switches always use
     the extended system id (deviation (13), §12.2).

  Consumers read explicit forms as their plain meaning (`no ip address` = no address; `ip routing` = routing on).
  Slots outside *D* keep today's storage exactly, so no P1-profile running configuration changes. The mechanism is
  one pure function in `cli/config-ast.ts` (§5, W1 cli) that the runtime calls with the device's default slots (W2
  device); `accept.p2.profile` reverses every default line and round-trips it through export, reload and a lab clone.
- "Use current defaults" in the File menu (`EngineApi.useCurrentDefaults`) exports the world; writes
  `ip routing` into the running configuration of every device whose P2 `profileConfig` holds `no ip routing` and
  whose running configuration has no `ip routing` line (the device routed in its P1 world and keeps routing); sets
  `profile: 'P2'` **and `schema = schemaIdFor(t)`** (1.2 — a 1.1 document would drop the key on load, §2.9); and
  reloads it. Spanning tree then runs on its switches.
- **Rejected: spanning tree on everywhere, migrating the goldens.** It changes the P0 anchor
  (`goldens/accept.p05.p0-sequences.json`), moves `sim.two-pcs-switch` from 40 s to at least 70 s, relaxes its
  no-drops assertion, and re-times every CCNA 1 lab and 53 switch-topology test files. **Rejected: a per-device
  epoch** (the l2 map's proposal): an old file with a newly placed switch would mix spanning-tree and non-spanning-tree
  switches silently. One profile per world is explicit and shows in the status bar.

**D3 — What a managed switch does by default.** (Also stated in §4.4.)
- Every port: `switchport mode dynamic auto` (the IOS default), access VLAN 1, native VLAN 1, all VLANs allowed.
- **A `dynamic auto` port never initiates DTP; it answers once it hears DTP.** An `access` port (negotiation on)
  also only answers, advertising access, so a neighbour that negotiated trunk drops back at once (§3.3). The
  negotiated outcome matrix is identical to real DTP, and a default switch is silent in both profiles. The fidelity
  cost is that a capture on an idle auto or access port shows no DTP frames. Rejected: auto ports that advertise
  every 30 s (breaks silence in the P1 profile with no pedagogical gain).
- VLAN 1 exists implicitly (so do 1002–1005, shown by `show vlan brief` as reserved and never stored).
- Spanning tree: **P1 profile — off** (no `spanning-tree mode` line, BPDUs are bridged like any multicast).
  **P2 profile — PVST+ on** (802.1D per VLAN), priority 32768 plus the VLAN id, every port 30 s from link-up to
  forwarding unless it is an edge port (PortFast). NF-C9300 models default to `rapid-pvst` (model data); a link
  between a `pvst` and a `rapid-pvst` switch runs 802.1D on that link by port protocol migration (§3.6 "Mixed
  modes").
- Justification: real switches run spanning tree by default and CCNA 2 teaches exactly that, so new work must behave
  that way (a redundant link does not melt the network; the 30 s forward delay is visible). Existing content must not
  change, and the profile keeps its traffic byte-identical; the P1-profile trace changes that remain are few,
  justified and listed (§9.3).

**D4 — 802.1Q is a codec layer, pushed and popped by structural rewrap with dedicated provenance.**
- New codec `dot1q` (fields `pcp`, `dei`, `vid`, `type`), dispatched from ethertype 0x8100. A tagged frame decodes
  as `[ethernet{type 0x8100}, dot1q{vid, type}, …]`.
- Push: `rewrap {strip: 1, push: [ethernet{dst, src}, dot1q{pcp, vid}], as: 'vlan-push'}`. Pop:
  `rewrap {strip: 2, push: [ethernet{dst, src}], as: 'vlan-pop'}`. With `as` set, `Pdu.rewrap` records exactly
  `VlanTagPush {field 'dot1q.vid', before null, after vid}` (or `VlanTagPop {before vid, after null}`) followed by
  `FcsRecompute {field 'ethernet.fcs'}` instead of Decapsulate/Encapsulate triples. The web already renders both
  reasons (`inspector/Provenance.tsx:72-96`).
- Push then pop of any codec-built frame returns the original bytes (padding is re-encoded to the 64-byte minimum and
  the FCS recomputed); the PduId never changes.
- **Hard invariant: a tag exists only on a trunk wire or on the parent port of a router subinterface.** No L3 daemon,
  no radio rewrap (rewrap80211.ts:92 copies `ethernet.type`) and no serial rewrap ever sees a tagged frame.
  eth-switch normalises the tag on every egress copy; the runtime pops at subinterface ingress and pushes at
  subinterface egress.
- **Rejected: a `vlan` field on the ethernet layer.** It would make the ethernet header variable-length inside one
  codec, turn tag insertion into a field mutation instead of the structural change it is, and lose the "tag slides
  into place" animation of spec §9.2.

**D5 — VLAN-aware bridging lives in eth-switch, keyed by the stage-derived daemon set.**
- eth-switch stays the one bridging daemon (the only daemon selected for bridged ports,
  `ETH_SWITCH_HANDLES`, eth-switch.ts:86-89). It is VLAN-aware on a device whose model runs the `vlan` daemon
  (`isVlanAware(model) = model.processes.includes('vlan')`, §2.1). `processes` is derived per build stage, so a model
  or fixture defined at stage P0.5 or P1 is never VLAN-aware, whatever its capabilities. Every other bridging device
  (APs, home routers, the IP phone, radio bridges, towers, modems, clouds, learning bridges) keeps today's transparent
  behaviour: shared learning under VLAN 1, tags carried through untouched.
- The `layer3-switch` implication does **not** change (`expandCapabilities` has no stage, so a changed implication
  would leak into P0.5-stage fixtures). The multilayer and data-centre models list `managed-switch` explicitly in
  their W4 model data.
- The CAM key already carries the VLAN (`camKey(vlan, mac)`, tables.ts:81); only the four `DEFAULT_VLAN` uses
  (eth-switch.ts:218, 271, 362, 369) change to the classified VLAN.
- The pure pieces (switchport config reader, membership, classification, control-frame table, port-security decision,
  load-balance hash) are separate single-owner modules under `protocols/l2/`.
- **The eth-switch StateView and every VLAN-1 debug message stay byte-identical** (the P0 golden hashes debug
  `message` and `data`, accept.p05.harness.ts:174-178; `l2.eth-switch.test.ts:161` pins the StateView with
  `toEqual`). New state goes to tables.
- Rejected: a second "vlan bridge" daemon beside eth-switch (two daemons would compete for the same frames on the same
  ports and the demux has no way to choose by VLAN).

**D6 — L2 control-plane state lives in device tables, one writer each; a runtime-mediated change signal.**
- Tables (all `@since P2`, §2.6): `vlans` (writer `vlan`), `dtp` (writer `dtp`), `stp` and `stp-bridge` (writer
  `stp`), `etherchannel` (writer `etherchannel`), `port-security` (writer `eth-switch`).
- Readers read synchronously: eth-switch reads `stp`/`etherchannel`/`dtp`/`vlans` per frame; the runtime reads them to
  derive SVI and Port-channel oper state; `show` handlers, lab checks, overlays and compare mode read the same rows.
- A writer that changed something another party derives from issues `Action {type:'l2Changed', what, port?, vlan?}`.
  The runtime then (1) delivers `ProcessEvent {kind:'l2.changed', what, port?, vlan?, from}` to every other L2 daemon
  present (`L2_PROCESSES` in PROCESS_ORDER order, depth-first), and (2) recomputes virtual oper state.
- Admin configuration is never copied into state: every consumer reads it from the running config through one pure
  reader (`readSwitchport`, `protocols/l2/switchport-config.ts`). The snapshot builder derives `PortSnapshot.l2` from
  config plus tables at snapshot time, like `phySettings` today.
- **Rejected: a `PortState.l2` struct written by a `setPortL2` merge action** (the l2 map's proposal). Tables give
  row flash and countdowns (§9.4), timeline lanes, compare mode and the generic `table` lab assertion for free, keep
  `PortView` small, and give every row exactly one writer. The one thing a struct gave — a synchronous signal to the
  runtime — is the explicit `l2Changed` action.

**D7 — Control frames are dispatched by eth-switch through a pure table; control daemons declare no `handles`.**
- `protocols/l2/control.ts` classifies a frame arriving on a bridged port of a VLAN-aware device (§2.4 table,
  `L2_CONTROL`): spanning-tree BPDUs go to `stp` on the logical port; LACP to `etherchannel` on the physical port;
  DTP to `dtp` on the physical port; PAgP to `etherchannel`; VTP to `vtp`. eth-switch hands them over with
  `Action deliver`.
- **Rejected: new `DemuxSelector` keys (destination MAC, SAP).** The demux would need a second key space for 802.3
  frames and would still have to translate bundle members; the table keeps the demux contract unchanged and the
  decision in the one daemon that already sees every frame.

**D8 — Wire formats.**
- IEEE formats where IEEE defines the protocol: STP/RSTP BPDUs (802.3 length + LLC 0x42 to 01:80:c2:00:00:00),
  LACP (slow protocols 0x8809 subtype 1 to 01:80:c2:00:00:02).
- IETF/IANA formats where they exist: HSRP over UDP 1985 to 224.0.0.2 (v1) / 224.0.0.102 (v2), DHCPv6 (UDP 546/547),
  CAPWAP (UDP 5246/5247, RFC 5415 message types and RFC 5416 WLAN configuration numbers; the DTLS session is
  simulated as a state and control messages after it carry `meta.protected`, §3.12), RADIUS (UDP 1812).
- **Original NF formats for vendor-proprietary L2 protocols:** DTP, VTP and PAgP travel as 802.3 + LLC/SNAP with the
  locally administered NF OUI `02-4E-46` (already used by the simulation element 221 in dot11-mgmt) and PIDs 1, 2 and
  3, to the NF control group `03:4e:46:00:00:01`. Their TLVs are original and carry equivalent meaning.
- **Per-VLAN spanning tree** sends IEEE-format BPDUs per VLAN with the extended system id = VLAN. On a **trunk**
  they are tagged with the VLAN, except the native VLAN's, which is untagged, and every trunk BPDU carries an original
  trailing per-VLAN TLV (`pvid`) so a native-VLAN mismatch is detected (§3.2). On an **access** port the BPDU of the
  access VLAN is a plain IEEE BPDU with no TLV, so two access ports in different VLANs merge those VLANs exactly as
  real switches do, and an access port that hears a TLV-carrying BPDU (it faces a trunk) goes type-inconsistent
  (§3.6 Guards).
- **Protocol constants are facts and are kept:** the HSRP virtual MAC prefixes `00:00:0c:07:ac:XX` (v1) and
  `00:00:0c:9f:fX:XX` (v2) are asked about in CCNA exams; the multicast groups and port numbers are IANA assignments.
  The HSRPv1 default authentication string is a vendor name and is replaced by eight zero bytes.
- Rejected: vendor SNAP OUIs and vendor multicast addresses on the wire (they are vendor identifiers, and nothing
  needs interoperability with real devices).

**D9 — Spanning tree runs per VLAN from day one.**
- Modes `pvst` (802.1D rules per VLAN) and `rapid-pvst` (802.1w rules per VLAN). `mst` is COULD (§8).
- One instance per VLAN that exists, is not disabled with `no spanning-tree vlan`, and has at least one up port
  carrying it; at most 128 instances (ascending VLAN order; the rest run none and log once, like a real 2960).
- Rejected: a single common tree first and per-VLAN later. Per-VLAN root election is a named CCNA 2 objective, the
  instance map is small, and retrofitting per-VLAN state into a single-instance daemon is a rewrite.

**D10 — EtherChannel is a virtual `channel`-role port owned by `etherchannel`.**
- `interface Port-channelN` (family `Port-channel`, short `Po`, 1–48). Role `channel`: bridged, virtual, egress
  `owner`, owner `etherchannel`.
- eth-switch and stp treat `Port-channelN` as one bridge port. A frame arriving on a bundled member is translated to
  the bundle before learning, classification and spanning tree. A `send` on the bundle reaches
  `etherchannel.onEgress`, which picks one bundled member by the deterministic hash (`protocols/l2/lag-hash.ts`) and
  sends there. etherchannel sends its own LACP/PAgP frames on members directly, so the owner never sends on its own
  virtual port (the `virtual-transmit` rule, device.ts:765-768, holds).
- Port-channel oper state is derived by the runtime: up iff some member's `etherchannel` row is `bundled` and that
  member is oper up. Its spanning-tree cost follows the bandwidth of the bundled members and is recomputed whenever
  the bundled set changes (a cost update, not a role change or a topology change; §3.6).
- An LACP member that hears no partner runs `individual` (a separate spanning-tree port), as a C2960-class switch
  runs such ports stand-alone; `suspended` is kept for real incompatibilities (§3.7).
- Rejected: bundling inside eth-switch (eth-switch would own egress of a port it also floods to, which is exactly the
  `virtual-transmit` loop) and bonding in the link model (STP and CAM would then see members, not the bundle).

**D11 — Router subinterfaces are virtual `subif`-role ports; the runtime pops and pushes their tag.**
- `interface GigabitEthernet0/0.10`, role `subif` (l3, virtual, egress `parent`), `PortSpec.parent`, the parent's MAC
  and ordinal. `encapsulation dot1Q <vid> [native]` sets `PortState.dot1q`.
- Ingress: the frame pipeline, after framing validation on a routed port, hands a tagged frame to the subinterface
  whose VID matches (pop recorded as `VlanTagPop`, cause `encapsulation dot1Q <vid>`), then continues at the MAC
  filter and demux on the subinterface. Egress `parent`: count on the subinterface, push the tag unless native
  (`VlanTagPush`), transmit on the parent.
- `L3_ROLES` includes `subif` automatically, so arp/ipv4/ipv6/nd need no selector change.
- Rejected: subinterfaces as extra addresses on the parent port (they need their own counters, oper state, ARP and
  connected routes, which the port model already provides).

**D12 — Port security runs inside eth-switch before learning; err-disable is a runtime action.**
- The check runs in eth-switch's per-frame path before `learn` (eth-switch.ts:199), because no other daemon can be
  consulted mid-decision.
- `Action errDisable {port, cause}` / `errRecover {port, cause}`: the runtime sets or clears `PortState.errDisabled`,
  emits `portState` and a log, and calls `deps.onPortAdmin`, so the link model brings the cable down
  (link.ts:521-522 already treats err-disabled as down).
- `shutdown` clears err-disable (a change to `setPortAdmin`, device.ts:1027). Automatic recovery is owned by the daemon
  whose cause it is (eth-switch for port security, stp for BPDU guard, etherchannel for channel misconfiguration),
  with a **periodic** timer (`errdisable:<port>`): recovery with the offender still attached is an endless
  violate → recover cycle, and a non-periodic timer would hold `runToIdle` (and every lab clone) to its event cap.
- Sticky addresses are written into the running config with `Action configLine`. Configured and sticky secure CAM rows
  are derived idempotently from the running config's `switchport port-security mac-address …` lines and are never
  removed by a CAM flush (§3.0, §3.8).

**D13 — Static routing: one candidate per configuration line, validity tracking, recursion.**
- The RIB arbiter owner becomes `static|<line>` (still `stampOwner:false`, so rows gain no field), so two `ip route`
  lines for one prefix are two candidates; the lowest AD wins (floating statics).
- A static candidate is offered only while usable. **Usable**, exactly: (a) with an exit interface, that interface
  is oper up and has an IPv4 address (a fully specified route also needs its next hop inside a connected subnet of
  that interface); (b) with a next hop only, `ctx.connectedPortFor(nh)` answers a port (directly connected; the same
  lookup the P1 code and its fakes already use), else the next hop's longest match in the RIB — ignoring this
  line's own candidate — is a usable route, followed recursively to depth ≤ 8. Re-evaluated after every
  connected/local/offered route change.
- This moves the install time of a static whose next hop is not yet reachable (for example at boot, before the link
  is up) from configuration time to the moment it becomes usable, which is what real routers do. It is the one
  deliberate P1-profile trace change of the L3 core; §9.3 lists the scenarios it touches.
- ECMP (SHOULD): `RibArbiterOptions.maxPaths` (default 1, keeping the pinned tie-break at
  core.rib-arbiter.test.ts:139), `RouteRow.paths` present only with two or more paths, a fixed flow hash.
- Rejected: keeping one static per prefix. Floating statics are a named objective and cannot exist without it.

**D14 — NAT is a separate `nat` daemon hooked by ipv4 at two points.**
- Inbound: a packet arriving on an `ip nat outside` port is handed to nat **before** the for-me test (needed because
  PAT on the interface translates to the router's own address). nat reverses a matching translation and answers
  `ipv4.resume`.
- Outbound: after routing and the TTL decrement (ipv4.ts:718-727), when the input port is inside and the egress port
  is outside, ipv4 hands the packet to nat, which translates and itself sends `arp.sendVia`.
- Standard ACLs (numbered and named, matching only) are pulled forward from CCNA 3 as `core/acl.ts`, used by NAT only;
  interface filtering stays in P3.
- Port and pool allocation are deterministic (no randomness; §4.1).
- Rejected: NAT inside ipv4 (ipv4's `handles` and fresh StateView are pinned, ip.ipv4.test.ts:403-409, and ipv4 is
  already the largest daemon) and NAT in the link layer (it would bypass routing and provenance causes).

**D15 — HSRP [S2] is an `hsrp` daemon; ipv4 is the single writer of two new port-L3 members.**
- `PortL3.virtual4` (virtual addresses with their MAC; MUST, because nat uses it for pool and static addresses) and
  `PortL3.groups4` (joined IPv4 groups; [S2], only hsrp joins groups), written only by ipv4 on `ipv4.virtual` /
  `ipv4.group` requests.
- Consumers: the pipeline MAC filter accepts `virtual4` MACs; arp answers for `virtual4` addresses with the virtual
  MAC; eth-switch delivers frames for an SVI's `virtual4` MAC to that SVI; `isLocalDestination` accepts local virtual
  addresses and [S2] joined groups; [S2] the pipeline's multicast-group filter (step 10b) reads `groups4`.

**D16 — DHCPv6 is a client daemon and a server daemon over UDP sockets.** RA M/O flags come from
`ipv6 nd managed-config-flag` / `other-config-flag` and default off, so every existing RA keeps its bytes.

**D17 — Wireless: CAPWAP control and central switching; the controller is a GUI appliance.**
- MUST: a lightweight AP discovers and joins a controller (CAPWAP control), receives its WLANs (SSID, personal
  security, the controller interface and so the VLAN), and tunnels client data to the controller, which bridges it
  into the WLAN's VLAN.
- **Association stays at the AP (local MAC), reported to the controller.** wlan-ap keeps answering association and
  running the 4-way handshake (it is the only writer of association grants, P1). On every grant change capwap-wtp
  sends a CAPWAP WTP Event Request carrying an original station report; capwap-ac writes the `wlan-clients` row from
  it. Rejected: tunnelling association and EAPOL to the controller (true split MAC) — it rewires the P1 air and
  wlan-ap paths that the wireless goldens pin, for a difference a learner sees only in a capture. Lesson 25 teaches
  split MAC as the real design and states this simplification; deviation (14), §12.2.
- **The controller is a new model, `wlc.nfwlc9800` (NF-WLC-9800).** `wlc.nfwlc3504` (NF-WLC-3504) is a `host` end
  system in P1 files and keeps its P1 behaviour: it stays a host end system (moved to the palette's Legacy category,
  description updated; like every host model it derives the silent `dhcpv6-client`, §9.2 items 13 and 20c), so no P1
  document changes behaviour. The new appliance's distribution ports are intrinsic 802.1Q trunks (no switchport
  lines, no DTP, no spanning tree); it bridges between its tunnel, its interfaces and **one** active distribution
  port, never port to port (§3.0), so it cannot become a transit bridge. Its WLANs point at named controller
  interfaces (name, VLAN, address, gateway, DHCP server) as the CCNA controller workflow does (§5.3).
- The lightweight AP (NF-AP-1832, already in P1 as an autonomous AP) starts CAPWAP only with `capwap enable`, a
  line only the P2 profile replays (or a learner types), never merely because it has an address.
- SHOULD: several WLANs per radio (multi-BSS), WPA2/WPA3-Enterprise with a RADIUS server. COULD: roaming,
  FlexConnect local switching.
- Multi-BSS keeps BSS index 0 byte-identical (ids, stream labels, bytes), so every existing wireless trace is
  unchanged.
- Rejected: local switching first. It is not the CCNA default, needs trunked AP ports the labs do not use, and the
  controller-side VLAN bridging is the same VLAN-aware eth-switch either way.

**D18 — Time travel is an input journal plus deterministic replay, with parked replayers.** [SHOULD]
- The facade journals every mutating input at its position (dispatched-event count, sim time). A replay facade
  implementing `Simulation` re-applies the journal. The worker keeps a few replayers parked at fixed event lags behind
  the live head; a seek advances the nearest one at or before the target (a target older than every parked replayer
  replays from the origin). When review ends, the cursor replay is re-parked in the slot it came from and idles until
  that slot's lag target passes it; §3.13 gives the lifecycle.
- The timeline map prototyped this against five scenarios (DHCP, relay, home Wi-Fi, hub collisions, web server) with
  breakpoints, steps, faults and moves: replayed trace and snapshot JSON were byte-identical.
- Rejected: periodic full snapshots with restore (spec §9.7 wording). Engine state lives in closures and private
  fields across about 21 daemons, the device runtime, the link model, 5 media, the CLI runtime and the capture hub;
  save/restore for all of them is a large seam surface, and a restored rng stream loses its origin
  (core/prng.ts:14-17). Parked replayers are the spec's "snapshots", held as live engine objects.

**D19 — State machines emit one typed debug event.** `ProcessCtx.transition(category, message, fsm, data?)` emits a
single `debug` trace event whose `DebugEvent.fsm` carries `{machine, subject, from, to, …}`. It feeds the §9.5
history strip, the timeline lanes, the spanning-tree change wave and convergence measurement. No new `TraceKind`
(the web `TRACE_KIND_VOCAB` is exhaustive). Only P2 daemons use it; P0/P1 daemons are not retrofitted (their debug
bytes are pinned). `category` is the exact CLI debug category of the daemon (§5.4 table), so `debug` prints the
event, and `subject` uses canonical port ids.

**D20 — Overlays read snapshot data only; no dash patterns.** The VLAN overlay reads `PortSnapshot.l2` and the
`vlans` rows; the STP overlay reads the `stp`/`stp-bridge` rows. Dash patterns already encode media, association phase
and band (`vocab/media.ts:61-86`, `canvas/air.ts`, `canvas/rf.ts:32-38`), so trunks are drawn as rails with chips and
blocked links as a cross glyph plus a missing underlay — never as dashes. Overlays register in a data-only registry
and memoise per device object.

**D21 — The CCNA 2 course reuses the course layer.** `curriculum/ccna2/*`, `sim/scenarios/ccna2/*`, category
`ccna2-lab`, profile P2 labs, new `LabAssertion` kinds (§2.10) and grader fixes (err-disabled ports re-applied to the
clone; `connectivity.after` faults applied inside it). `CCNA2.status` flips to `available` only in the wave that
lands every MUST lesson, its theory and its labs.

**D22 — Legal.** As rule 6. `validateCatalog` and the CLI legal test keep their banned-word lists; P2 adds original
log and show wording for every new message, and lesson text is checked by the curriculum tests.

**D23 — A storm has a memory bound.** With spanning tree off, a loop recirculates forever. P2P egress gets a queue
cap (`P2P_QUEUE_LIMIT = 256` frames, drop `queue-full`, as segment.ts already caps at 64). The cap bounds **memory**
(frames waiting per port) in loops that multiply frames; it does not bound the **event rate**, which is set by line
rate (a loop keeps every link in it busy). `accept.p2.loop-storm-bounded` asserts both bounds separately, the event
bound derived from line rate (§10.1). No existing test queues 256 frames on one port; the media owner confirms this
in W1.

### 1.1 Where the area maps disagreed, and what was chosen

| Question | Proposals | Chosen |
|---|---|---|
| Default-on STP vs silence | l2: per-device epoch; alternative: migrate goldens | World profile (D2) with replayed default lines and the completeness rule; no existing golden migrated, P1-profile digest changes listed (§9.3) |
| DTP default | l2: DTP on by default like IOS | `dynamic auto` and `access` never initiate (D3); outcome matrix unchanged, silent by default |
| Where L2 state lives | l2: `PortState.l2` + `setPortL2`; timeline: tables; wireless: snapshot-derived | Tables + `l2Changed` action (D6); `PortSnapshot.l2` derived at snapshot time |
| BPDU format | l2: IEEE per VLAN | IEEE per VLAN plus an original `pvid` TLV for native-mismatch detection (D8) |
| DTP/VTP/PAgP format | l2: undecided | Original NF formats under the NF OUI (D8) |
| Who owns bundle egress | l2: eth-switch picks a member | `etherchannel` owns `channel` egress (D10) |
| Proxy ARP | l3: off by default | Off in the P1 profile, on in the P2 profile (an invisible default, D2) |
| `ip routing` on multilayer switches | l3: `DeviceModel.ipRoutingDefault` | Replayed `no ip routing` in the P2 profile; the rule stores both forms in one slot so `ip routing` survives export; ipv4 reads the line (D2, §3.5) |
| Lightweight AP start-up | wireless: model `defaultConfig` or silent | Replayed `capwap enable` and `ip address dhcp` on Vlan1 in the P2 profile only |
| Controller model | wireless: turn NF-WLC-3504 into the appliance | New model NF-WLC-9800; NF-WLC-3504 stays the P1 end system (D17) |
| Split MAC | wireless: controller answers association | Association at the AP, reported by WTP Event (D17), a listed deviation |
| New trace kind for FSMs | wireless: `fsm` TraceKind; timeline: `DebugEvent.fsm` | `DebugEvent.fsm` (D19) |
| Time-travel storage | spec: snapshots; timeline: journal + replay | Journal + replay + parked replayers (D18) |

---

## 2. Contract changes

Every member below is tagged `@since P2` in the source (transition rule, §0 rule 2). Members marked **optional by
meaning** keep their `?` for ever (absent = P1 behaviour and P1 bytes); §2.15 lists every one of them, and the
source tags each `@since P2 (optional by meaning)`. Blocks marked **[SHOULD]** land in wave 0 when the item is
approved in §8.5, and otherwise by the one item that builds it (§0 rule 3); **[COULD]** blocks only by approval.
Everything else lands in wave 0. Additions to unions append members at the end, so existing orders (and the
snapshot key order that depends on them) never change.

### 2.1 `contracts/catalog.ts`

```ts
export type BuildStage = 'P0' | 'P0.5' | 'P1' | 'P2';
export const BUILD_STAGES: readonly BuildStage[] = ['P0', 'P0.5', 'P1', 'P2'];

/** @since P2 Which stage's DEFAULT behaviours a world uses (D2). Absent in a topology = 'P1'. Never gates a feature. */
export type DefaultsProfile = 'P1' | 'P2';
export const DEFAULTS_PROFILES: readonly DefaultsProfile[] = ['P1', 'P2'];
/** True when the defaults introduced by `since` apply in a world whose profile is `profile`. */
export function profileIncludes(profile: DefaultsProfile, since: DefaultsProfile): boolean {
  return DEFAULTS_PROFILES.indexOf(since) <= DEFAULTS_PROFILES.indexOf(profile);
}

// CAPABILITIES: append, in this order (tuple order = storage order; appending keeps every existing list unchanged)
//   'managed-switch'       VLAN-aware bridge with VLAN database, DTP, spanning tree, EtherChannel, port security
//   'lightweight-ap'       access point managed by a controller over CAPWAP                 (wireless MUST)
//   'wireless-controller'  WLC appliance: CAPWAP controller + VLAN-aware bridge, no spanning tree (wireless MUST)
// CAPABILITY_IMPLIES additions (existing entries, including 'layer3-switch', are NOT changed — D5):
//   'managed-switch':      ['switching']
//   'lightweight-ap':      ['wifi-ap']
//   'wireless-controller': ['switching']

/** @since P2 The daemon whose presence makes eth-switch VLAN-aware (D5). */
export const VLAN_AWARE_PROCESS: ProcessName = 'vlan';
/**
 * @since P2 eth-switch classifies VLANs, tags trunks and keys the CAM per VLAN only when this is true (D5). Keyed on
 * the STAGE-DERIVED daemon list, so P0.5/P1-stage models and fixtures are never VLAN-aware.
 */
export function isVlanAware(model: Pick<DeviceModel, 'processes'>): boolean {
  return model.processes.includes(VLAN_AWARE_PROCESS);
}

// PORT_ROLES: append 'channel', 'subif', 'wlan-tunnel'.
// PortRoleTraits.egress: 'link' | 'owner' | 'loop' | 'parent'
//   'parent' (@since P2) → count out on the subinterface, push its 802.1Q tag unless native, then transmit on
//                          `PortSpec.parent` exactly like a 'link' send on that port (§3.4).
// ROLE_TRAITS additions:
//   channel:       { frames: true, bridged: true,  hairpin: false, l3: false, linkable: false, configurable: true,
//                    virtual: true, egress: 'owner',  wiring: null, label: 'Port channel' }
//   subif:         { frames: true, bridged: false, hairpin: false, l3: true,  linkable: false, configurable: true,
//                    virtual: true, egress: 'parent', wiring: null, label: 'Subinterface' }
//   'wlan-tunnel': { frames: true, bridged: true,  hairpin: true,  l3: false, linkable: false, configurable: false,
//                    virtual: true, egress: 'owner',  wiring: null, label: 'Controller tunnel' }   (wireless, W0)
// ROLE_KINDS additions: channel ['virtual'], subif ['virtual'], 'wlan-tunnel' ['virtual'].
// BRIDGED_ROLES / L3_ROLES / FRAME_ROLES are derived, so they pick the new roles up (no selector edits needed).

// VirtualFamilySpec.role: 'svi' | 'virtual' | 'channel' | 'wlan-tunnel'

/** @since P2 Subinterface support of a model (routers, multilayer switches): `<parent>.<n>` on ports whose effective role is in `roles`. */
export interface SubinterfaceSpec {
  readonly roles: readonly PortRole[]; // derived: ['routed'] when the model has 'routing'
  readonly max: number;                // highest n (65535)
}

// GUI_PANELS: append 'wlc.controller' (wireless MUST).

/** @since P2 Daemons that take part in the L2 change signal (D6), in PROCESS_ORDER order. 'vtp' is appended in its
 *  place only by the C1 item, in the change that registers the vtp factory (§0 rule 3). */
export const L2_PROCESSES: readonly ProcessName[] = Object.freeze(['eth-switch', 'vlan', 'dtp', 'etherchannel', 'stp']);
```

`PROCESS_ORDER` **final** order (new names in **bold**; the relative order of existing names is unchanged, so every
existing `DeviceModel.processes` list stays an order-preserving subsequence). **Wave 0 inserts none of the new
names.** Each is inserted at this position in the change that registers its factory (§0 rule 3): the W4 catalog
item inserts `vlan`, `dtp`, `etherchannel`, `stp`, `nat`, `dhcpv6-client`, `dhcpv6-server`; the W6 catalog item
inserts `capwap-wtp`, `capwap-ac`; the S2 item `hsrp`; the S11 item `radius-server`; the C1 item `vtp`. So the registry
test (`protocols.registry.test.ts:44-50`, registry = `PROCESS_ORDER` exactly) stays green in every wave, and a cut
feature leaves no name behind:

`wlan-ap`, `wlan-client`, **`capwap-wtp`**, `cell-client`, `hdlc`, `eth-switch`, **`vlan`**, **`dtp`**, **`vtp`**,
**`etherchannel`**, **`stp`**, `arp`, `ipv4`, **`nat`**, `icmpv4`, `host`, `ipv6`, `nd`, `icmpv6`, `udp`, `tcp`,
**`hsrp`**, `dhcp-client`, `dhcp-server`, **`dhcpv6-client`**, **`dhcpv6-server`**, `dns-client`, `dns-server`,
**`radius-server`**, `http-client`, `http-server`, `traceroute`, **`capwap-ac`**.

Constraints relied upon: eth-switch before every L2 control daemon (link-change fan-out order: CAM flush first);
`wlan-ap` before `capwap-wtp` (an EAPOL frame ties at score 2 and must go to wlan-ap, §3.12); ipv4 before nat; udp
before hsrp, dhcpv6-*, radius-server and capwap-ac.

`CAPABILITY_PROCESSES` additions (all `since: 'P2'`; each row is added by the item that registers the daemon, never
earlier):

| Capability | Adds | Added by |
|---|---|---|
| `managed-switch` | `vlan`, `dtp`, `etherchannel`, `stp` | W4 catalog |
| `managed-switch` | `vtp` | C1 item, only if approved |
| `routing` | `nat`, `dhcpv6-client`, `dhcpv6-server` | W4 catalog |
| `routing` | `hsrp` | S2 item (W4 catalog when S2 is approved at W0) |
| `host` | `dhcpv6-client` | W4 catalog |
| `nat-gateway` | `nat` (home routers; NAT stays off until their panel writes the lines, S13) | W4 catalog |
| `lightweight-ap` | `capwap-wtp`, `udp`, `dhcp-client` | W6 catalog |
| `wireless-controller` | `vlan`, `udp`, `capwap-ac` | W6 catalog |
| `server` | `radius-server` | S11 item, only if approved |

`radius-server` opens its UDP socket only when a RADIUS client line is configured on the server (S11), and
`dhcpv6-server` only when an interface carries `ipv6 dhcp server <pool>`, so no `sockets` row appears in a P1 world.

`BRIDGING_CAPABILITIES` gains `wireless-controller`.

### 2.2 `contracts/port.ts`

```ts
/** @since P2 Admin mode of a switched (or Port-channel) port. Default 'dynamic-auto' (D3). */
export type SwitchportMode = 'access' | 'trunk' | 'dynamic-auto' | 'dynamic-desirable';

/**
 * @since P2 The switchport lines of one port, parsed. The ONLY reader is `readSwitchport(config, port)`
 * (protocols/l2/switchport-config.ts); every consumer (eth-switch, dtp, stp, etherchannel, runtime SVI autostate,
 * snapshot, show, lab checks) calls it on the running config. Never stored in PortState.
 */
export interface SwitchportConfig {
  readonly mode: SwitchportMode;
  /** false with `switchport nonegotiate` (accepted only in access or trunk mode). */
  readonly negotiate: boolean;
  readonly accessVlan: number;
  /** `switchport voice vlan <v>`; absent = none. */
  readonly voiceVlan?: number;
  readonly nativeVlan: number;
  /** Canonical VLAN list (core/vlan-list.ts format: ascending ranges, '1-4094' = all, '' = none). */
  readonly allowed: string;
}
export const DEFAULT_SWITCHPORT: SwitchportConfig = Object.freeze({
  mode: 'dynamic-auto', negotiate: true, accessVlan: 1, nativeVlan: 1, allowed: '1-4094',
});
/** @since P2 The fixed L2 view of a wireless-controller distribution port (D17): readSwitchport returns it for every
 *  port of a `wireless-controller` model; the grammar accepts no switchport line there. */
export const CONTROLLER_PORT_SWITCHPORT: SwitchportConfig = Object.freeze({
  mode: 'trunk', negotiate: false, accessVlan: 1, nativeVlan: 1, allowed: '1-4094',
});

/** @since P2 Why a port is err-disabled (PortState.errDisabled holds one of these). */
export type ErrDisableCause = 'psecure-violation' | 'bpduguard' | 'channel-misconfig' | 'fault';
export const ERR_DISABLE_CAUSES: readonly ErrDisableCause[] = Object.freeze(['psecure-violation', 'bpduguard', 'channel-misconfig', 'fault']);

/** @since P2 A virtual IPv4 address answered on a port (HSRP virtual IP, NAT pool / static inside-global address). */
export interface VirtualIpv4 {
  readonly address: Ipv4Address;
  /** MAC used in ARP replies (and as Ethernet source when the owner sends from it). */
  readonly mac: MacAddress;
  readonly owner: ProcessName;
  /** true = a packet to `address` is for this device (HSRP active); false = ARP answers only (NAT pool). */
  readonly local: boolean;
}

// PortSpec += (optional by meaning)
//   parent?: PortId              @since P2 subinterfaces only: the physical port that carries it
// PortState += (optional by meaning)
//   dot1q?: { vid: number; native: boolean }   @since P2 subinterfaces only; runtime-owned, from `encapsulation dot1Q`
// PortState.errDisabled keeps its type `string`; P2 writers store an ErrDisableCause.
// PortL3 += (optional by meaning; written ONLY by ipv4 via setPortL3, per-member merge)
//   virtual4?: readonly VirtualIpv4[]     @since P2 (nat; hsrp with S2), ordered by (owner, address)
//   [SHOULD S2] groups4?: readonly Ipv4Address[]   joined IPv4 multicast groups (hsrp)
```

### 2.3 `contracts/pdu.ts` and `contracts/fields.ts`

```ts
// ProtoName: append 'dot1q' | 'stp' | 'lacp' | 'dtp' | 'dhcpv6' | 'capwap'
//            [SHOULD] 'hsrp' (S2) | 'pagp' (S3) | 'eap' | 'radius' (S11)   [COULD] 'vtp' (C1)

// PduMeta += protected?: true   @since P2 (optional by meaning) CAPWAP control messages after the simulated DTLS step
//                               (§3.12): the inspector labels the payload "protected (DTLS, simulated)" while still
//                               decoding it ("headers real, crypto simulated", spec §4.9).

// RewrapOp += (optional by meaning)
//   as?: 'vlan-push' | 'vlan-pop'
//   'vlan-push': op must be {strip:1, push:[ethernet, dot1q]}; records VlanTagPush {field:'dot1q.vid', before:null,
//                after:vid} then FcsRecompute {field:'ethernet.fcs'}. 'vlan-pop': op must be {strip:2, push:[ethernet]} on
//                a frame whose layers[1] is dot1q; records VlanTagPop {field:'dot1q.vid', before:vid, after:null} then
//                FcsRecompute. Any other shape throws. Without `as`, rewrap is unchanged.

// [SHOULD S9] Pdu.mutate field path: '<proto>[<i>].<field>' addresses the layer at index i (layerAt(i)); the plain
// '<proto>.<field>' form keeps meaning "first layer of that proto". A layer inside an ICMP-error quote (any layer after
// an icmpv4/icmpv6 layer whose codec stopsMeaning) is PATCHED IN PLACE, not re-encoded. The quote is the IP header
// plus 8 bytes (ICMP_QUOTE_PAYLOAD_BYTES), so:
//   - the rewritten field's bytes are replaced; the quoted ipv4 header checksum is recomputed over its own header;
//   - a rewritten quoted ICMP id adjusts the quoted ICMP checksum incrementally (RFC 1624);
//   - a rewritten quoted udp port, OR a rewritten quoted ipv4 address (pseudo-header), adjusts a present non-zero
//     quoted udp checksum incrementally;
//   - a quoted tcp checksum (offset 16) is never inside the 8-byte quote and is never touched;
//   - the enclosing layers re-encode as usual (icmp checksum, outer ipv4, FCS).
// Each derived change is recorded as today (ChecksumRecompute / FcsRecompute).

export const ETHERTYPE_SLOW_PROTOCOLS = 0x8809;
export const DOT1Q_HEADER = 4;
/** Largest tagged Ethernet frame incl. FCS at MTU 1500. */
export const ETH_MAX_FRAME_TAGGED = 1522;
/** ethernet.type values up to this are an 802.3 LENGTH, not an ethertype. */
export const ETH_LENGTH_MAX = 0x05dc;
export const LLC_SAP_STP = 0x42;
export const STP_GROUP_MAC = '01:80:c2:00:00:00';
export const SLOW_PROTOCOLS_MAC = '01:80:c2:00:00:02';
/** Locally administered NF OUI (D8), also used by the dot11 simulation element 221. */
export const NF_OUI = 0x024e46;
/** NF L2 control group (DTP, VTP, PAgP in their NF formats). */
export const NF_L2_CONTROL_MAC = '03:4e:46:00:00:01';
export const NF_PID_DTP = 0x0001;
// [SHOULD S3] export const NF_PID_PAGP = 0x0003;   [COULD C1] export const NF_PID_VTP = 0x0002;
// [SHOULD S2] export const UDP_PORT_HSRP = 1985; HSRP_V1_GROUP = '224.0.0.2'; HSRP_V2_GROUP = '224.0.0.102';
//   HSRP_V1_MAC_PREFIX = '00:00:0c:07:ac:'; HSRP_V2_MAC_PREFIX = '00:00:0c:9f:f'   (protocol constants kept as facts,
//   D8: v1 MAC = prefix + group (2 hex digits); v2 = prefix + group (3 hex digits, 0-4095))
export const UDP_PORT_DHCPV6_CLIENT = 546;
export const UDP_PORT_DHCPV6_SERVER = 547;
export const DHCPV6_ALL_AGENTS = 'ff02::1:2';
export const UDP_PORT_CAPWAP_CONTROL = 5246;
export const UDP_PORT_CAPWAP_DATA = 5247;
/** RFC 5415 §4.5.1 / RFC 5416 message types used (D8). */
export const CAPWAP_MSG = Object.freeze({
  discoveryReq: 1, discoveryResp: 2, joinReq: 3, joinResp: 4, configStatusReq: 5, configStatusResp: 6,
  wtpEventReq: 9, wtpEventResp: 10, changeStateReq: 11, changeStateResp: 12, echoReq: 13, echoResp: 14,
  wlanConfigReq: 3398913, wlanConfigResp: 3398914,
  // [SHOULD S11] stationConfigReq: 25, stationConfigResp: 26
});
```

**Field tables** (`PROTO_FIELDS`, fields.ts; codecs encode/decode exactly these keys):

`ethernet` (changed notes only): `type` ≤ `ETH_LENGTH_MAX` means 802.3 length framing. Decode: the next layer is
`llc`, bounded by the length. Encode: when the builder passes any value ≤ 0x05DC (builders pass 0), the codec writes
the LLC payload length (derived). `LINK_FIELDS` fills `ethernet.type = 0` when the next proto is `llc`.

`llc` (changed): `dsap` (u8, default 0xaa), `ssap` (u8, default 0xaa), `control` (u8, default 0x03). SNAP only
(dsap = ssap = 0xaa): `oui` (u24, default 0) and `type` (u16; an ethertype when `oui` is 0, an NF PID when `oui` is
`NF_OUI`). Non-SNAP frames have no `oui`/`type` and dispatch on `dsap` in space `'llc.sap'`. **The SNAP encode and
decode paths stay byte-identical** (the dot11 byte tests pin them).

| Proto | Fields (type, bits, default; D = derived, R = required, O = decode-only) |
|---|---|
| `dot1q` | `pcp` u3 = 0; `dei` bool = false; `vid` u12 R; `type` u16 (filled from the next proto). **`type` follows the `ethernet.type` 802.3 rule exactly:** when the next layer is `llc` the builder passes 0 and the codec writes the LLC payload length; on decode a value ≤ `ETH_LENGTH_MAX` makes the next layer `llc`, bounded by the length (a tagged per-VLAN BPDU is `[ethernet 0x8100, dot1q {type = length}, llc, stp]`). Transparent (topProto skips it); `fixTrailer` like llc. |
| `stp` | `protocolId` u16 = 0; `version` u8 (0 STP, 2 RST, 3 MST) R; `bpduType` u8 (0x00 config, 0x80 TCN, 0x02 RST/MST) R; config/RST only: `flags` u8 (bit0 TC, bit1 proposal, bits2-3 role 0 unknown/1 alternate-backup/2 root/3 designated, bit4 learning, bit5 forwarding, bit6 agreement, bit7 TC-ack), `rootPriority` u16, `rootMac` mac, `rootPathCost` u32, `bridgePriority` u16, `bridgeMac` mac, `portId` u16, `messageAge`, `maxAge`, `helloTime`, `forwardDelay` (u16 each, units of 1/256 s); RST only: `v1Length` u8 D (0); `pvid` u16 optional (NF per-VLAN TLV `00 00 00 02 <vid>` appended after the BPDU, D8); `flagsText` string O (e.g. 'TC,P,D,L,F'). TCN BPDUs are 4 bytes. |
| `lacp` | `subtype` u8 = 1; `version` u8 = 1; `actorSystemPriority` u16; `actorSystem` mac; `actorKey` u16; `actorPortPriority` u16; `actorPort` u16; `actorState` u8 (bit0 activity, 1 timeout, 2 aggregation, 3 sync, 4 collecting, 5 distributing, 6 defaulted, 7 expired); the six `partner*` twins; `collectorMaxDelay` u16 = 0. TLV types/lengths and reserved bytes derived; fixed 110-byte LACPDU. |
| `dtp` (NF) | `version` u8 = 1; `domain` string (≤ 32, '' = none); `adminMode` u8 (1 access, 2 trunk, 3 desirable, 4 auto) R; `operTrunk` bool R; `trunkType` u8 = 1 (802.1Q); `neighbor` mac R. Original TLV layout: type u16, length u16, value. |
| [SHOULD S2] `hsrp` | `version` u8 (1, 2) R; `opCode` u8 (0 hello, 1 coup, 2 resign) = 0; `state` u8 (0 initial, 1 learn, 2 listen, 4 speak, 8 standby, 16 active) R; `helloMs` u32 = 3000; `holdMs` u32 = 10000; `priority` u32 = 100; `group` u16 R (v1: ≤ 255); `authData` bytes (v1, 8 zero bytes by default); `virtualIp` ipv4; `identifier` mac (v2). v1 wire carries seconds (u8) and the codec converts; v2 is the group-state TLV. |
| `dhcpv6` | `msgType` u8 R (1 solicit … 13 relay-repl); `transactionId` u24 (not in relay messages); `clientDuid`, `serverDuid` string (hex; DUID-LL from the MAC); `iaid` u32; `iaAddress` ipv6; `preferredLifetimeS`, `validLifetimeS`, `t1S`, `t2S` u32; `dnsServers` string (comma-separated); `domainList` string; `statusCode` u16; `rapidCommit` bool; `elapsedTimeCs` u16; `oro` string (comma-separated option codes); relay: `hopCount` u8, `linkAddress` ipv6, `peerAddress` ipv6 (the relay-message option chains to an inner `dhcpv6` layer). |
| `capwap` | `radioId` u8; `wbid` u8 = 1; `tbit` bool (true = native 802.11 frame follows, no FCS); `messageType` u32 (control only; exactly the `CAPWAP_MSG` values: 1/2 discovery, 3/4 join, 5/6 configuration status, 9/10 WTP event, 11/12 change state event, 13/14 echo, 3398913/3398914 IEEE 802.11 WLAN configuration; [S11] 25/26 station configuration); `seq` u8; `wtpName`, `acName` string; `resultCode` u32; `wlans` string (one WLAN per WLAN configuration request: `<id>:<ssid>:<security>:<vlan>:<keyTag>`, never a passphrase); `stations` string (WTP event only, carried as a Vendor Specific Payload element under `NF_OUI`: `<add\|del>:<station mac>:<bssid>:<wlanId>` joined by ';'); `keepAlive` bool (data channel). Control vs data by `ctx.outer` udp port. Labels shown in the inspector are the RFC names. |
| [SHOULD] `pagp` (NF) | `version` u8; `mode` u8 (1 desirable, 2 auto); `device` mac; `port` u16; `group` u16; `partnerDevice` mac; `partnerPort` u16. |
| [SHOULD] `eap` | `code` u8 (1 request, 2 response, 3 success, 4 failure); `id` u8; `eapType` u8 (1 identity, 13 NF-simulated TLS-like exchange); `identity` string; `tag` u32 (credential hash, never the secret). |
| [SHOULD] `radius` | `code` u8 (1 access-request, 2 accept, 3 reject); `id` u8; `authenticator` bytes 16 (FNV-derived, D8 no randomness); `userName` string; `eapMessage` bytes; `messageAuth` bytes 16 (simulated). |
| [COULD] `vtp` (NF) | `version` u8; `code` u8 (1 summary, 2 subset, 3 request); `domain` string; `revision` u32; `vlans` string (`<id>:<name>` joined by ';'). |

**Dispatch** (`DISPATCH_TABLE`, new spaces `'llc.sap'`, `'nf.pid'`, `'eapol.type'`):

```ts
d('ethertype', 0x8100, 'dot1q', 'P2'),
d('ethertype', 0x8809, 'lacp', 'P2'),        // slow protocols; the lacp codec errors on subtype ≠ 1 and stops
d('llc.sap', 0x42, 'stp', 'P2'),
d('nf.pid', 0x0001, 'dtp', 'P2'),
d('udp.port', 546, 'dhcpv6', 'P2'),
d('udp.port', 547, 'dhcpv6', 'P2'),
d('udp.port', 5246, 'capwap', 'P2'),
d('udp.port', 5247, 'capwap', 'P2'),
// [SHOULD] d('udp.port', 1985, 'hsrp', 'P2') (S2), d('nf.pid', 0x0003, 'pagp', 'P2') (S3),
//          d('udp.port', 1812, 'radius', 'P2'), d('eapol.type', 0, 'eap', 'P2') (S11)
// [COULD]  d('nf.pid', 0x0002, 'vtp', 'P2')
```

`LINK_FIELDS` (pdu/codecs/dispatch.ts, code) gains `dot1q → {field:'type', space:'ethertype'}` with the same 802.3
length rule as `ethernet` (a value ≤ `ETH_LENGTH_MAX` dispatches to `llc`); `llc` dispatches on
`type` in `'ethertype'` when `oui` is 0, in `'nf.pid'` when `oui` is `NF_OUI`, and on `dsap` in `'llc.sap'` when not
SNAP. The ethernet and dot11 codecs omit and expect no FCS when `ctx.outer.at(-1)?.proto === 'capwap'` (a frame
carried inside a tunnel).

### 2.4 `contracts/process.ts`

```ts
/** @since P2 State machines that report transitions through `ctx.transition` (D19). */
export type FsmMachine =
  | 'stp-port' | 'stp-bridge' | 'dtp' | 'lacp' | 'channel' | 'port-security' | 'err-disable'
  | 'nat' | 'dhcpv6' | 'capwap-wtp' | 'capwap-ac'
  // [SHOULD] | 'hsrp' | 'pagp' | 'eap'   [COULD] | 'vtp' | 'wlan-roam'
  ;

/**
 * @since P2 One state-machine transition. `subject` is stable and canonical-PortId based — never an abbreviation:
 * 'VLAN0010 GigabitEthernet0/1', 'Port-channel1 GigabitEthernet0/2', 'GigabitEthernet0/1' (dtp), 'controller
 * 192.168.99.5' (capwap-wtp). The history strip and the timeline lanes key on it.
 */
export interface FsmTransition {
  readonly machine: FsmMachine;
  readonly subject: string;
  readonly port?: PortId;
  /** VLAN, channel group, HSRP group or MST instance. */
  readonly instance?: number;
  readonly from: string;
  readonly to: string;
  /** Original-wording reason ('superior BPDU received', 'forward delay expired'). */
  readonly cause?: string;
  /** The PDU that triggered the transition, when one did. */
  readonly pdu?: PduId;
}
// DebugEvent += fsm?: FsmTransition   (optional by meaning; set only through ctx.transition; P0/P1 daemons never set it)

/** @since P2 What changed in an L2 change signal (D6). */
export type L2ChangeKind = 'vlans' | 'trunk' | 'channel' | 'stp' | 'security';

// DemuxSelector += (wireless MUST, W0; optional by meaning)
//   frame?: 'data'   dot11 only: matches 802.11 data frames (+1 score). EAPOL still reaches wlan-ap via the
//                    PROCESS_ORDER tie (both score 2).

// ProcessCtx +=
//   readonly profile: DefaultsProfile;
//     @since P2 the world's defaults profile (D2). Read ONLY for invisible defaults (P2: proxy ARP). W1 device.
//   transition(category: string, message: string, fsm: FsmTransition, data?: Record<string, unknown>): void;
//     @since P2 emits exactly ONE debug event (as ctx.debug) whose DebugEvent.fsm = fsm. `category` is the daemon's
//     §5.4 debug category, character for character. W1 device.
//   radioSettings?(port: PortId): RadioSettings | undefined;
//     @since P2 (wireless; W4 device, device/process-ctx.ts) the ONE settings renderer: local interface lines
//     overlaid by a controller profile (`radio-profile` action). wlan-ap switches from its private renderer to this;
//     for a radio with no controller profile the result is byte-identical to today's renderer.

// Action += (all @since P2)
  | { type: 'errDisable'; port: PortId; cause: ErrDisableCause; detail?: string }
      // runtime: no-op if already err-disabled; else errDisabled = cause, portState reason 'err-disabled', log
      // severity 4 (original wording, includes `detail`), deps.onPortAdmin → link recompute (down).
  | { type: 'errRecover'; port: PortId; cause: ErrDisableCause }
      // runtime: no-op unless errDisabled === cause; else clear it, portState reason 'err-recovered', log severity 5,
      // deps.onPortAdmin → link recompute (up if admin up and cabled).
  | { type: 'l2Changed'; what: L2ChangeKind; port?: PortId; vlan?: number }
      // runtime: (1) for each p in L2_PROCESSES ∩ model.processes, p ≠ issuer, in L2_PROCESSES order (which is the
      //   final PROCESS_ORDER order, so the fan-out does not depend on when a name enters PROCESS_ORDER):
      //   applyActions(p, p.onEvent(ctx, {kind:'l2.changed', what, port, vlan, from: issuer})) depth-first;
      // (2) recomputeVirtual(now).
  | { type: 'configLine'; context: readonly (readonly string[])[]; line: readonly string[]; negate: boolean }
      // runtime: applyConfigLine(context, line, negate) — configChange trace and onConfig fan-out as for a typed line
      // (the issuer receives its own onConfig too; eth-switch's handling of the sticky line is idempotent, §3.8).
      // Used by eth-switch for sticky secure MACs. Counts against ACTION_BUDGET like any action.
  // [wireless; W4 device]
  | { type: 'radio-profile'; port: PortId; bss: readonly BssSettings[] | null; controller?: string }
      // capwap-wtp → runtime: store (null = clear) the controller profile of radio `port`, then onPortPhyConfig(port).
      // `controller` (optional by meaning, W4 close-out 2026-09-23): the pushing controller's name, stored with the
      // profile and reported by radioSettings(port) as RadioSettings.controller (§2.12, display only).
// setPortL3 += virtual4?: readonly VirtualIpv4[] | null   (same merge rules); [S2] groups4?: readonly Ipv4Address[] | null

// ProcessRequest += (all @since P2)
  | { kind: 'nat.inbound'; pdu: Pdu; inPort: PortId }
      // ipv4 → nat: a packet arrived on an `ip nat outside` port, BEFORE the for-me test. nat answers with exactly one
      // of: request ipv4 'ipv4.resume' (translated or not), or a drop.
  | { kind: 'nat.outbound'; pdu: Pdu; inPort: PortId; iface: PortId; nextHop: Ipv4Address; cause?: string }
      // ipv4 → nat: routed, TTL already decremented, inPort inside, iface outside. nat answers with exactly one of:
      // request arp 'arp.sendVia' {pdu, nextHop, iface, cause}, or a drop ('nat-exhausted' | other).
  | { kind: 'ipv4.resume'; pdu: Pdu; inPort: PortId }
      // nat → ipv4: continue receive processing at the for-me test; never handed to nat again.
  | { kind: 'nat.clear'; session?: SessionId }
      // cli → nat: `clear ip nat translation *` (dynamic rows only).
  | { kind: 'ipv4.virtual'; op: 'add' | 'remove'; iface: PortId; address: Ipv4Address; mac: MacAddress; local: boolean; owner: ProcessName }
      // nat (and hsrp with S2) → ipv4: ipv4 merges by (owner, address), writes setPortL3 virtual4, and for add with
      // local true sends arp.gratuitous {iface, address, mac}.
  // [SHOULD S2] | { kind: 'ipv4.group'; op: 'join' | 'leave'; iface: PortId; group: Ipv4Address; owner: ProcessName }
  //                 hsrp → ipv4: merges by (owner, group) and writes setPortL3 groups4.
  | { kind: 'ipv6.lease'; op: 'bind' | 'unbind'; iface: PortId; address?: Ipv6Address; prefixLen?: number;
      preferredUntil?: SimTime; validUntil?: SimTime; server?: Ipv6Address }
      // dhcpv6-client → ipv6: add/remove an Ipv6PortAddress origin 'dhcpv6' (prefixLen 128), tentative → DAD.
// widened (@since P2, optional by meaning): { kind: 'arp.gratuitous'; iface; address?: Ipv4Address; mac?: MacAddress }
//   address/mac absent = today's behaviour (the interface address and MAC).
// widened (@since P2, optional by meaning; wireless W0): udp.open += tunnel?: true
//   A datagram matching a tunnel socket is delivered as `sock.datagram` WITHOUT udp's `consume` action: the owner
//   takes over the PDU's lifecycle (it rewraps and forwards the same PduId, or consumes/drops it itself). Used only by
//   capwap-ac and capwap-wtp for the data channel (5247), so a tunnelled frame shows one PduId end to end and no
//   `pduConsumed` before the station or the gateway (§3.12).
// [SHOULD S11] | { kind: 'wlan.authorize'; port: PortId; station: MacAddress; keyTag?: number }
//   capwap-wtp → wlan-ap, on a CAPWAP Station Configuration Request after the controller's 802.1X accept.
```

**The L2 control table** (`protocols/l2/control.ts`, pure; its shape is contract because three owners depend on it):

| Frame (on a bridged port of a VLAN-aware device) | `L2ControlClass` | Delivered to | Port passed |
|---|---|---|---|
| dst `01:80:c2:00:00:00`, llc dsap 0x42 | `'stp'` | `stp` if a `stp-bridge` row exists for the frame's VLAN; else bridged as multicast in that VLAN | logical (bundle if member) |
| ethertype 0x8809, `lacp.subtype` 1 | `'lacp'` | `etherchannel`; never bridged | physical |
| dst `NF_L2_CONTROL_MAC`, SNAP `NF_OUI`, PID 1 | `'dtp'` | `dtp`; never bridged | physical |
| dst `NF_L2_CONTROL_MAC`, SNAP `NF_OUI`, PID 3 | `'pagp'` [SHOULD] | `etherchannel`; never bridged | physical |
| dst `NF_L2_CONTROL_MAC`, SNAP `NF_OUI`, PID 2 | `'vtp'` [COULD] | `vtp`; dropped when absent | logical |
| other `01:80:c2:00:00:01`–`0f` | `'reserved'` | dropped `not-for-me`, detail `reserved link-layer group` | — |
| anything else | `undefined` | normal bridging | — |

A control class whose daemon is not in `model.processes` is dropped `unsupported-protocol` with detail
`<class> is not running on this device` (except `'stp'`, which is bridged — and on a `wireless-controller`, which
never relays spanning tree, dropped `not-for-me` with detail `the controller does not relay spanning tree`).
Transparent (non-VLAN-aware) bridges do not use the table: they bridge every frame as today.

### 2.5 `contracts/transport.ts` (ProcessEvent)

```ts
/** @since P2 runtime → every other L2 daemon, after an `l2Changed` action (D6). */
export interface L2ChangedEvent { kind: 'l2.changed'; what: L2ChangeKind; port?: PortId; vlan?: number; from: ProcessName }
/**
 * @since P2 stp → eth-switch: flush ('flush' deletes the VLAN's dynamic rows on exactly `ports` now) or fast-age
 * ('fast-age' caps expiresAt at now + ageingNs for the VLAN's dynamic rows on exactly `ports`). stp names the ports:
 * 802.1w lists the non-edge ports it flushes (edge ports are never flushed); 802.1D lists every STP port of the VLAN.
 * Secure rows are never touched (D12).
 */
export interface L2FlushEvent { kind: 'l2.flush'; vlan: number; mode: 'flush' | 'fast-age'; ports: readonly PortId[]; ageingNs?: SimTime }
/** @since P2 ipv6 → dhcpv6-client: the M/O flags of the router last heard on `iface` (sent only when they change and dhcpv6-client exists). */
export interface RaFlagsEvent { kind: 'ipv6.ra'; iface: PortId; router: Ipv6Address; managed: boolean; other: boolean }
/**
 * @since P2 (wireless W0) wlan-ap → capwap-wtp: an association grant of a CENTRAL BSS changed (sent only when
 * capwap-wtp is in model.processes; local BSSs never send it, so P1 wireless traces are unchanged). capwap-wtp turns
 * each into one WTP Event Request station report (§3.12 step 5).
 */
export interface WlanGrantEvent {
  kind: 'wlan.grant'; op: 'add' | 'del'; port: PortId; station: MacAddress; bssid: MacAddress; wlanId: number;
  state: WifiAssocState;
}
// ProcessEvent = … | L2ChangedEvent | L2FlushEvent | RaFlagsEvent | WlanGrantEvent
// LeaseEvent += family?: 6   (optional by meaning; absent = IPv4; dhcpv6-client sends {kind:'dhcp.lease', family: 6,
//   iface, op, dnsServers, domainName})
//   Consumer rule (dns-client, W3 svc): learned servers are keyed by (iface, family); a lease replaces only its own
//   family's list and 'lost' removes only that family's list; the resolver order is the IPv4 list, then the IPv6 list.
//   A v4-only world never sets family, so dns-client's behaviour and debug text there are unchanged.
```

### 2.6 `contracts/tables.ts`

```ts
// ExtraTableName += 'vlans' | 'dtp' | 'stp' | 'stp-bridge' | 'etherchannel' | 'port-security' | 'nat'
//                   | 'dhcpv6-bindings' | 'capwap' | 'capwap-aps' | 'wlan-clients'
//                   [SHOULD] | 'hsrp'   [COULD] | 'vtp'
// TableDescriptor.since: 'P0' | 'P0.5' | 'P1' | 'P2'

// CamRow += secure?: 'configured' | 'dynamic' | 'sticky'   (optional by meaning; secure rows have type 'static',
//                                                           no expiresAt, and are written only by eth-switch)

/** @since P2 key = vlanKey(vlan). Writer: vlan. VLAN 1 and 1002–1005 are implicit and never rows. */
export interface VlanRow extends TableRow { vlan: number; name: string; status: 'active' | 'suspended'; source: 'config' | 'vtp' }
export const vlanKey = (vlan: number): string => String(vlan);

/** @since P2 key = port. Writer: dtp. Rows exist from link-up for trunk (negotiate on) and dynamic-desirable ports, and for a dynamic-auto port only after DTP was received on it (§4.3). */
export interface DtpRow extends TableRow {
  port: PortId; admin: SwitchportMode; oper: 'access' | 'trunk';
  status: 'waiting' | 'negotiated' | 'static';  // waiting = auto port that has heard nothing
  neighbor?: MacAddress; neighborMode?: SwitchportMode;
}

export type StpRole = 'root' | 'designated' | 'alternate' | 'backup' | 'disabled';
export type StpState = 'blocking' | 'listening' | 'learning' | 'forwarding' | 'discarding' | 'disabled';
/** 'type' = an access (non-trunking) port received a BPDU carrying the pvid TLV, i.e. it faces a trunk (§3.6). */
export type StpInconsistency = 'root' | 'loop' | 'pvid' | 'type';
/** Bridge id text: `${priority}/${mac}` e.g. '32778/00:1f:00:0a:00:00' (priority includes the VLAN, D9). */
export type BridgeIdText = string;

/** @since P2 key = stpKey(vlan, port). Writer: stp. One row per (instance, STP port); bundled members have none. */
export interface StpPortRow extends TableRow {
  vlan: number; port: PortId; role: StpRole; state: StpState;
  /** Protocol spoken on this port: 'rstp' or 'stp' (a rapid port that migrated to 802.1D, §3.6 Mixed modes). */
  protocol: 'stp' | 'rstp';
  cost: number; portId: string /* '128.1' */;
  designatedBridge: BridgeIdText; designatedPort: string; edge: boolean;
  inconsistent?: StpInconsistency; bpduGuard?: boolean;
  stateSince: SimTime;
  /** Next timer-driven state change (forward delay), for the draining bar; absent when none is pending. */
  nextTransitionAt?: SimTime;
}
export const stpKey = (vlan: number, port: PortId): string => `${vlan}|${port}`;

/** @since P2 key = vlanKey(vlan). Writer: stp. One row per instance. */
export interface StpBridgeRow extends TableRow {
  vlan: number; mode: 'pvst' | 'rapid-pvst' | 'mst';
  bridgeId: BridgeIdText; rootId: BridgeIdText; isRoot: boolean;
  rootPort?: PortId; rootCost: number;
  helloS: number; maxAgeS: number; forwardDelayS: number;
  topologyChanges: number; lastChangeAt?: SimTime; lastChangePort?: PortId;
}

/** 'individual' = runs as a separate spanning-tree port (no LACP partner, §3.7); 'suspended' = incompatible, no traffic. */
export type ChannelMemberState = 'bundled' | 'waiting' | 'suspended' | 'individual' | 'down';
/** @since P2 key = member port. Writer: etherchannel. */
export interface EtherchannelRow extends TableRow {
  port: PortId; group: number; bundle: PortId /* 'Port-channel1' */;
  protocol: 'lacp' | 'pagp' | 'static'; mode: 'on' | 'active' | 'passive' | 'desirable' | 'auto';
  state: ChannelMemberState; reason?: string /* original wording when suspended */;
  partnerSystem?: MacAddress; partnerKey?: number; partnerPort?: number;
}

/** @since P2 key = port. Writer: eth-switch. Rows exist only for ports with `switchport port-security`. */
export interface PortSecurityRow extends TableRow {
  port: PortId; max: number; count: number; violation: 'protect' | 'restrict' | 'shutdown'; sticky: boolean;
  violations: number; status: 'secure-up' | 'secure-down' | 'secure-shutdown'; lastViolationMac?: MacAddress;
}

/** @since P2 key = natKey(proto, insideGlobal, insideGlobalPort). Writer: nat. Address-only rows use proto 'any'. */
export interface NatRow extends TableRow {
  proto: 'icmp' | 'udp' | 'tcp' | 'any';
  insideLocal: Ipv4Address; insideLocalPort?: number;
  insideGlobal: Ipv4Address; insideGlobalPort?: number;
  outsideLocal?: Ipv4Address; outsideLocalPort?: number;
  outsideGlobal?: Ipv4Address; outsideGlobalPort?: number;
  kind: 'static' | 'dynamic' | 'overload';
  /** The config line that created it (provenance cause). */
  rule: string;
}
export const natKey = (proto: NatRow['proto'], insideGlobal: Ipv4Address, port?: number): string => `${proto}|${insideGlobal}|${port ?? '*'}`;
// The key finds the candidate row; the INBOUND MATCH RULE of §3.9 decides whether an inbound packet may use it (an
// overload row also requires src = outsideGlobal, and an ICMP query row matches replies only).

/** @since P2 key = `${pool}|${address}`. Writer: dhcpv6-server. expiresAt = valid lifetime end. */
export interface Dhcpv6BindingRow extends TableRow { address: Ipv6Address; duid: string; iaid: number; pool: string; preferredUntil?: SimTime }

/** @since P2 (wireless) AP side, key = controller address. Writer: capwap-wtp. */
export interface CapwapRow extends TableRow { controller: Ipv4Address; state: CapwapState; since: SimTime; wlans: number }
/** RFC 5415 WTP states; 'dtls' is simulated (a state with no records on the wire, D8). */
export type CapwapState = 'discovery' | 'dtls' | 'join' | 'configure' | 'data-check' | 'run' | 'idle';
/** @since P2 (wireless) WLC side, key = AP MAC. Writer: capwap-ac. */
export interface CapwapApRow extends TableRow { apMac: MacAddress; apIp: Ipv4Address; name: string; state: CapwapState; clients: number }
/**
 * @since P2 (wireless) WLC side, key = station MAC. Writer: capwap-ac, ONLY from WTP Event Request station reports
 * (§3.12 step 5): 'add' writes or updates the row, 'del' deletes it (reason `cleared`); an AP leaving run deletes its
 * stations' rows. `state` is the AP's association state reported with the station ('associated' or 'authorized').
 */
export interface WlanClientRow extends TableRow { station: MacAddress; ap: MacAddress; bssid: MacAddress; wlanId: number; ssid: string; vlan: number; iface: string; state: WifiAssocState }

/** [SHOULD S2] key = `${iface}|${group}`. Writer: hsrp. */
export interface HsrpRow extends TableRow {
  iface: PortId; group: number; version: 1 | 2;
  state: 'initial' | 'learn' | 'listen' | 'speak' | 'standby' | 'active';
  priority: number; preempt: boolean; virtualIp?: Ipv4Address; virtualMac: MacAddress;
  active?: Ipv4Address | 'local'; standby?: Ipv4Address | 'local';
}
```

`TABLE_DESCRIPTORS` gains one entry per table with original titles ("VLANs", "Trunk negotiation", "Spanning tree
ports", "Spanning tree", "EtherChannel members", "Port security", "NAT translations", "DHCPv6 leases", "Controller
link", "Access points", "Wireless clients", "Standby groups"), columns = the row fields above that a learner reads
(ports with format `'port'`, times `'time'`, states `'state'`).

`PROCESS_TABLES` additions: `vlan: ['vlans', 'port-security']` (port-security rows are written by eth-switch; they
hang off `vlan` so that only managed switches declare the table), `dtp: ['dtp']`, `stp: ['stp', 'stp-bridge']`,
`etherchannel: ['etherchannel']`, `nat: ['nat']`, `'dhcpv6-server': ['dhcpv6-bindings']`, `'capwap-wtp': ['capwap']`,
`'capwap-ac': ['capwap-aps', 'wlan-clients']`, [SHOULD] `hsrp: ['hsrp']`.

`RouteRow` / `Route6Row` [SHOULD S6]: `paths?: readonly { nextHop?: IpAddress; iface?: PortId; cause?: string }[]`
(optional by meaning), present only when two or more paths are installed. `RibArbiterOptions` (core, code) gains `maxPaths?: number`
(default 1) and `multipathEligible?: (row) => boolean`.

### 2.7 `contracts/link.ts`, `contracts/events.ts`, `contracts/trace.ts`

```ts
// link.ts
// DropReason: append 'vlan-filtered' | 'stp-discarding' | 'port-security' | 'nat-exhausted'
/** @since P2 Frames queued on one P2P egress port before 'queue-full' (D23). */
export const P2P_QUEUE_LIMIT = 256;

// events.ts
// FaultKind: append 'err-disable'   target {device, port}; params {cause?: ErrDisableCause} (default 'fault').
//   Applied through DeviceRuntime.errDisablePort. Used by troubleshooting labs and by the lab-check clone (§3.8).
// SimEventBody 'frameArrival' += central?: true   (wireless; optional by meaning) the air hands an 802.11 data frame
//   of a centrally switched BSS to the AP unchanged; admit still re-checks authorization.

// trace.ts (every member below is optional by meaning: absent keeps P1 bytes)
// drop event += background?: true       present only when the dropped PDU has meta.background (BPDUs on host ports,
//                                       HSRP hellos at hosts, HDLC keepalives, beacons). The trace filter, the canvas
//                                       drop markers, the worker delta and the sim-mode list skip them by default (§6).
//                                       P1 background PDUs that are dropped gain the key: a listed P1 digest change (§9.3).
// PduSummary += vlan?: number           outermost 802.1Q VID, present only for tagged frames (packet colouring).
// PduSummary += tunnel?: 'capwap'       (wireless) present only while the frame is inside a CAPWAP tunnel.
```

### 2.8 `contracts/snapshot.ts`

```ts
/** @since P2 L2 view of one bridged port of a VLAN-aware device, derived at snapshot time (D6). */
export interface PortL2View {
  config: SwitchportConfig;
  /** Effective operation: static modes as configured; dynamic modes from the dtp row (access until negotiated). */
  oper: 'access' | 'trunk';
  /** Trunk: VLANs allowed AND existing (canonical list). */
  active?: string;
  /** VLANs this port forwards in (canonical list); absent when spanning tree runs for none of its VLANs. */
  forwarding?: string;
  channel?: { group: number; bundle: PortId; state: ChannelMemberState };
  security?: { status: PortSecurityRow['status']; count: number; max: number; violations: number };
}
// PortSnapshot += (optional by meaning)
//   l2?: PortL2View     present iff the device is VLAN-aware and the view differs from the default
//                       (config ≠ DEFAULT_SWITCHPORT, oper 'trunk', channel or security present). Keeps P1 snapshots stable.
//   parent?: PortId     subinterfaces
//   dot1q?: { vid: number; native: boolean }
// SimSnapshot += profile?: 'P2'   (optional by meaning; absent = 'P1')
```

### 2.9 `contracts/device.ts`, `contracts/topology.ts`, `contracts/simulation.ts`

```ts
// device.ts
// DeviceSpec += profile?: DefaultsProfile      (optional by meaning) set by the Simulation from the world; absent = 'P1'
// DeviceModel += (optional by meaning, filled by defineModel)
//   profileConfig?: Readonly<Partial<Record<DefaultsProfile, readonly string[]>>>
//       config text lines replayed at EVERY boot after defaultConfig and before the saved configuration, for every
//       key k with profileIncludes(profile, k). Together with defaultConfig they are the device's default lines D of
//       the completeness rule (D2): the runtime passes D's slots to the config store (§5).
//   subinterfaces?: SubinterfaceSpec
//   stpDefaultMode?: 'pvst' | 'rapid-pvst'     builds profileConfig (NF-C9300: 'rapid-pvst') and is the mode that
//       `no spanning-tree mode` restores in a P2 world (§5.1)
// PortResolution 'virtual' += parent?: PortId   (subinterfaces: family 'subinterface')
// DeviceRuntime +=
//   readonly profile: DefaultsProfile;
//   errDisablePort(port: PortId, cause: ErrDisableCause, now: SimTime): void   // fault path; same effects as the action

// topology.ts
export const TOPOLOGY_SCHEMA_ID_1_2 = 'netforge.topology/1.2';
// TOPOLOGY_SCHEMA_IDS = [1.0, 1.1, 1.2]; LATEST_TOPOLOGY_SCHEMA_ID = 1.2; migrate 1.1 → 1.2 is identity + schema id.
// TOPOLOGY_SCHEMA_ID stays exported and still equals 'netforge.topology/1.1' (the id every P1 document keeps).
// Topology += profile?: 'P2'   (optional by meaning; absent = 'P1'). `profile` belongs ONLY to the 1.2 field set: a
//   1.1 document carrying it is read with the 1.1 field set, which strips it (io/schema.ts:14-18), so it loads as P1.
/** @since P2 The lowest schema id that can express `t`: 1.2 iff `t.profile` is present, else 1.1. The exporter writes
 * this, so every P1 document still exports byte-identically as 1.1. EVERY writer that sets `profile` (exportTopology,
 * useCurrentDefaults, the scenario kit's `topology(…, {profile})`) sets `schema = schemaIdFor(t)` in the same step. */
export function schemaIdFor(t: Topology): TopologySchemaId;

// simulation.ts
// SimulationOptions += profile?: DefaultsProfile    (optional by meaning) profile of the initial (empty) world; default 'P1'
// SimulationOptions += catalog?: DeviceCatalog      (optional by meaning) TESTS AND TOOLING ONLY (§0 rule 13): the catalog
//                                                   to build devices from instead of createCatalog(PROCESS_FACTORIES).
//                                                   Never passed by apps/web.
// Simulation += readonly profile: DefaultsProfile   loadTopology sets it from t.profile ?? 'P1'; exportTopology writes
//                                                   profile only when 'P2' (and then schema 1.2).
```

### 2.10 `contracts/scenario.ts`

```ts
// ScenarioCategory: 'template' | 'ccna1-lab' | 'ccna2-lab' | (string & {})
// LabAssertion 'port' field union += 'errDisabled'
// LabAssertion 'connectivity' += after?: readonly LabFault[]; settleMs?: number; then?: readonly LabAssertion[]
//   (all three optional by meaning)
//   after: faults applied in the clone once it has settled, then the clone runs settleMs (default 60 000) before the
//          ping; then: static assertions evaluated in the same clone after the ping (NAT rows the ping created).

/** @since P2 A fault the grader applies inside its clone. Devices and ports by NAME. */
export type LabFault =
  | { cut: { a: string; b: string } }
  | { powerOff: string }
  | { shutdown: { device: string; port: string } };

// LabAssertion += (all @since P2; devices and ports by NAME; port names resolve like the 'port' kind)
  | { kind: 'vlan'; device: string; vlan: number; exists?: boolean; name?: string;
      accessPorts?: readonly string[]; match?: 'includes' | 'exactly' }
  | { kind: 'switchport'; device: string; port: string; oper?: 'access' | 'trunk' | 'down';
      mode?: SwitchportMode; accessVlan?: number; voiceVlan?: number; nativeVlan?: number;
      allowedVlans?: readonly number[] /* set equality with the ACTIVE list */ }
  | { kind: 'stp'; device: string; vlan: number; root?: boolean; rootBridge?: string /* device name */;
      port?: string; role?: StpRole; state?: StpState; edge?: boolean; mode?: 'pvst' | 'rapid-pvst' }
  | { kind: 'etherchannel'; device: string; group: number; protocol?: 'lacp' | 'pagp' | 'static';
      up?: boolean; bundled?: readonly string[]; minBundled?: number }
  | { kind: 'portSecurity'; device: string; port: string; enabled?: boolean;
      status?: PortSecurityRow['status']; violation?: 'protect' | 'restrict' | 'shutdown';
      max?: number; stickyMac?: string; minViolations?: number }
  | { kind: 'route'; device: string; family?: 4 | 6; destination: string /* LPM winner for this address */;
      source?: string; network?: string; nextHop?: string; iface?: string; ad?: number; none?: boolean }
  | { kind: 'nat'; device: string; insideLocal?: string; insideGlobal?: string; outsideGlobal?: string;
      proto?: 'icmp' | 'tcp' | 'udp'; kindOf?: 'static' | 'dynamic' | 'overload'; exists?: boolean; minCount?: number }
  // [SHOULD S2]  | { kind: 'fhrp'; device: string; iface: string; group: number; state?: HsrpRow['state'];
  //                  virtualIp?: string; priority?: number; preempt?: boolean }
  // [SHOULD S15] | { kind: 'convergence'; fault: LabFault; protocol: ConvergenceProtocol; withinMs: number; atLeastMs?: number }
```

`contracts/curriculum.ts` is unchanged except its header comment ("P2 course layer" becomes "course layer", rule 2).

### 2.11 `contracts/cli.ts`

- `MODES['config-subif']` and `MODES['config-vlan']` lose `reserved` — **deferred to the W2 cli item** (§9.2 W2
  item 12b), which enters both modes and `config-if-range`, drops the three flags and carries the one migration of
  `cli.modes-rules.test.ts:62`; in W0 they stay `reserved: true` so every P1 mode helper is unchanged. New modes:
  `'config-if-range'`
  (class config, parent config, prompt `(config-if-range)#`, contextKey `'interface'`; the session holds a port list
  and applies each line to each port, §5), `'config-dhcpv6'` (prompt `(config-dhcpv6)#`, contextKey
  `'ipv6 dhcp pool'`), `'config-std-nacl'` (prompt `(config-std-nacl)#`, contextKey `'ip access-list standard'`),
  wireless `'config-wlan'` (prompt `(config-wlan)#`, contextKey `'wlan'`) and `'config-wlc-if'` (prompt
  `(config-wlc-if)#`, contextKey `'wlc-interface'`).
- `ArgType` += `'vlan-list'` (`10,20,30-35`; 1–4094), `'mac-any'` (`aabb.cc00.0100` or `aa:bb:cc:00:01:00`,
  normalised to canonical), `'if-range'` (`fa0/1 - 12, gi0/1`).
- `CLI_MESSAGES` additions (original wording):

```ts
vlanCreated: '% VLAN {vlan} did not exist, so it has been created.',
subifNeedsEncap: '% Give this subinterface an 802.1Q encapsulation (encapsulation dot1Q <vlan>) before an address.',
encapNotHere: '% 802.1Q encapsulation belongs on a subinterface such as {port}.10.',
duplicateVid: '% VLAN {vlan} is already carried by {other} on this interface.',
securityNeedsStaticMode: '% Port security needs a fixed mode. Enter "switchport mode access" (or trunk) first.',
nonegotiateNeedsStaticMode: '% Negotiation can only be switched off on an access or trunk port.',
notSwitchport: '% {port} is not a switched port.',
stpVlanMissing: '% There is no spanning tree for VLAN {vlan} on this switch.',
channelCreated: 'Port-channel{group} was created for this bundle.',
extendSystemIdFixed: '% This switch always adds the VLAN number to its bridge priority; that cannot be switched off.',
portfastOnTrunk: '% Note: {port} is trunking, so PortFast has no effect here until it stops trunking (or use "spanning-tree portfast trunk").',
rootPriorityExhausted: '% VLAN {vlan} cannot be won by priority alone: the current root already uses priority 0.',
wlcInterfaceMissing: '% There is no controller interface named {name}. Create it first under "wlc-interface {name}".',
```

### 2.12 Wireless contracts (`contracts/rf.ts`, `contracts/medium.ts`; wireless MUST, W0)

```ts
// rf.ts
// WifiSecurity += [SHOULD S11] 'wpa2-ent' | 'wpa3-ent'
/** @since P2 One BSS a radio serves (controller profile or local lines). passphrase and keyTag are never exported. */
export interface BssSettings {
  index: number;               // 0 = today's single BSS (ids and bytes unchanged); 1..15 [SHOULD S10]
  ssid: string; security: WifiSecurity;
  passphrase?: string; keyTag?: number;
  vlan?: number; switching: 'local' | 'central'; wlanId?: number;
}
// (every member below is optional by meaning: absent = today's single local BSS and today's bytes)
// RadioSettings += bss?: readonly BssSettings[]  (absent = today's single BSS from ssid/security/passphrase)
// RadioSettings += controller?: string           (display: the controller that pushed the profile)
// RadioPortView += bss?: { index: number; ssid: string; bssid: MacAddress; security: WifiSecurity; clients: number }[]

// medium.ts
// BssSnapshot += index?, wlanId?, vlan?, switching?: 'central'   (present only when not the defaults)
// [SHOULD S12] BssSnapshot += airtimeNs?, utilPermille?, neighbours?: { bss: MediumId; relation: 'co-channel' | 'adjacent'; levelDbm: number }[]
// [SHOULD S11] WifiAssocState += 'eap'
// [COULD C5]   MediumEvent += { kind: 'roam-candidate'; bssid: MacAddress; rssiDbm: number; currentRssiDbm: number }
```

### 2.13 Time-travel contracts [SHOULD S1] (`contracts/journal.ts`, `contracts/timeline.ts`, additions to `simulation.ts`)

```ts
// contracts/journal.ts
export interface JournalPosition { readonly dispatched: number; readonly now: SimTime }  // per world; events popped since it was built
export interface FacadeCounters {
  readonly traceHead: number; readonly sessions: number; readonly headless: number;
  readonly requests: number; readonly topologyVersion: number;
}
export interface JournalOrigin {
  readonly seed: number; readonly mode: FidelityMode; readonly profile: DefaultsProfile;
  readonly topology: Topology | null; readonly counters: FacadeCounters;
}
export type JournalOp =
  | { op: 'addDevice'; spec: AddDeviceSpec } | { op: 'removeDevice'; id: DeviceId } | { op: 'renameDevice'; id: DeviceId; name: string }
  | { op: 'moveDevice'; id: DeviceId; position: { x: number; y: number } } | { op: 'setPower'; id: DeviceId; on: boolean }
  | { op: 'addLink'; spec: AddLinkSpec } | { op: 'removeLink'; id: LinkId } | { op: 'setImpairments'; id: LinkId; imp: Partial<Impairments> }
  | { op: 'injectFault'; at: SimTime; fault: FaultSpec }
  | { op: 'configure'; device: DeviceId; commands: readonly string[]; opts?: ConfigureOptions }
  | { op: 'insertModule'; device: DeviceId; slot: SlotId; module: ModuleType } | { op: 'removeModule'; device: DeviceId; slot: SlotId }
  | { op: 'setDeviceUi'; device: DeviceId; ui: TopologyDeviceUi } | { op: 'setCanvasScale'; metresPerUnit: number }
  | { op: 'hostRequest'; device: DeviceId; req: HostAppRequest }
  | { op: 'cliOpen'; device: DeviceId; via: 'console' | 'vty' } | { op: 'cliExec'; session: SessionId; line: string }
  | { op: 'cliInterrupt'; session: SessionId } | { op: 'cliClose'; session: SessionId };
export interface JournalEntry { readonly at: JournalPosition; readonly op: JournalOp; readonly traceHead: number; readonly threw?: true }
export interface SimJournal { readonly version: 1; readonly origin: JournalOrigin; readonly entries: readonly JournalEntry[] }
export type SeekTarget = { readonly time: SimTime } | { readonly cursor: number } | { readonly position: JournalPosition };
export class ReplayDivergenceError extends Error { readonly entry: number; readonly expectedHead: number; readonly actualHead: number; }
export const REPLAY_READ_ONLY_MESSAGE = 'You are looking at the past. Return to the present to change the network.';

// contracts/timeline.ts
export type LaneId = 'link' | 'stp' | 'etherchannel' | 'vlan' | 'fhrp' | 'routing' | 'nat' | 'dhcp' | 'wireless' | 'security' | 'config' | 'drops';
export interface TimelineQuery { from: SimTime; to: SimTime; buckets: number; lanes?: readonly LaneId[] }
export interface LaneBucket { from: SimTime; to: SimTime; counts: Partial<Record<LaneId, number>>; firstCursor: Partial<Record<LaneId, number>> }
export interface TimelineMarkQuery { lane: LaneId; from: SimTime; to: SimTime; limit: number }
export interface TimeTravelBudget { replayers: number; lagsEvents: readonly number[]; reviewTraceCapacity: number; reviewPduRegistry: number; laneEntries: number }
export const DEFAULT_TIME_TRAVEL_BUDGET: TimeTravelBudget = { replayers: 3, lagsEvents: [5_000, 30_000, 150_000], reviewTraceCapacity: 50_000, reviewPduRegistry: 5_000, laneEntries: 250_000 };
export const VOLATILE_ROW_KEYS = ['updatedAt', 'expiresAt'] as const;

// [SHOULD S15] — written out in full (no external document is needed):
export type ConvergenceProtocol = 'stp' | 'etherchannel' | 'fhrp' | 'routing' | 'wireless';
/** Lanes whose events count as activity of each protocol (laneOf, §3.13 step 1). */
export const CONVERGENCE_LANES: Readonly<Record<ConvergenceProtocol, readonly LaneId[]>> = {
  stp: ['stp'], etherchannel: ['etherchannel'], fhrp: ['fhrp'], routing: ['routing'], wireless: ['wireless'],
};
export interface ConvergenceOptions {
  readonly protocol: ConvergenceProtocol;
  /** Measurement starts here (the fault or the change). */
  readonly from: SimTime;
  /** Quiet period that proves convergence (default 5 000 ms). */
  readonly quietMs?: number;
  /** Restrict to these devices (default: all). */
  readonly devices?: readonly DeviceId[];
}
export interface ConvergenceResult {
  readonly protocol: ConvergenceProtocol;
  readonly from: SimTime;
  /** Time of the LAST lane event after `from` that is followed by `quietMs` with no lane event; null = still changing
   *  at the end of the recorded trace (or no event at all: then `changes` is 0 and settledAt = from). */
  readonly settledAt: SimTime | null;
  /** settledAt − from; null when settledAt is null. */
  readonly durationNs: SimTime | null;
  /** Lane events counted between from and settledAt. */
  readonly changes: number;
  /** The last change: its ring cursor, device and FsmTransition.subject (or table key when not an fsm event). */
  readonly last?: { readonly cursor: number; readonly device: DeviceId; readonly subject: string };
}
export type ConvergenceReport = readonly ConvergenceResult[];
// Pure function (timeline/convergence.ts): measureConvergence(events: readonly TraceEvent[], opts): ConvergenceResult.
// [COULD C3]   RowChange, TableDiff, DeviceDiff, SnapshotComparison — written in full by the architect as a contract
//              change BEFORE the C3 item starts, if C3 is approved; nothing is built against a name alone.
// [COULD C4]   Bookmark — same rule.

// simulation.ts [S1]
// SimulationOptions += journal?: boolean (default true); pduRegistryLimit?: number; resume?: FacadeCounters
// Simulation += position(): JournalPosition; journal(): SimJournal  (structured-clone copy)
// TraceFilter += machines?: readonly FsmMachine[]   (optional by meaning) matches debug events whose event.fsm.machine
//                                                    is listed
// contracts/time.ts += parseSimTime(text: string): SimTime | undefined   (inverse of formatSimTime)
```

Journal rules (binding for S1): only outermost facade calls are recorded (never during dispatch; `handleFault` config
fragments and `userCommand` events are not recorded; `sim.configure` through the CLI wrapper records once); ops are
deep-copied with `structuredClone` at record time; `loadTopology` starts a new journal whose origin holds the counters
from BEFORE the load; reads (`snapshot`, `traceQuery`, `pdu`, captures, `cli.complete`/`help`/`canOpen`,
`validateLink`, `nextEventTime`, `evaluateLab`) are never recorded and must not change state (an observation-purity
test guards it). CLI debug flags are cleared on `loadTopology` (a behaviour change no test pins).

### 2.14 Web contracts (`apps/web/src/bridge/protocol.ts`, `apps/web/src/store/types.ts`)

```ts
// protocol.ts
// EngineApi.init(opts: { seed: number; profile?: DefaultsProfile })   (profile optional by meaning; default 'P1')
// EngineApi.reset(seed: number, profile?: DefaultsProfile)             (optional by meaning; default 'P1')
//   The CALLER chooses the profile from the course context (D2): the web shell keeps `lastCourse` (persisted; the
//   course of the last lesson opened) and passes profileForCourse(lastCourse) = 'P1' for CCNA 1, else 'P2', at app
//   start and on File → New; entering the sandbox from a lesson while the world has no devices calls reset with that
//   lesson's course profile. (apps/web/src/learn/course-profile.ts, pure, web-shell W2.)
// EngineApi += useCurrentDefaults(): Promise<SimSnapshot>
//   export → write `ip routing` on devices whose P2 profileConfig holds `no ip routing` and whose running config has
//   no `ip routing` line → profile 'P2' and schema = schemaIdFor(t) → load; epoch++ (D2).
// [S1] EngineBatch += review?: ReviewInfo | null; timelineHead?: { t: SimTime; at: JournalPosition; lanesRevision: number }
//      (both optional by meaning)
// [S1] EngineApi += seek(target: SeekTarget): Promise<{ snapshot: SimSnapshot; review: ReviewInfo; replayedEvents: number }>;
//                   leaveReview(): Promise<SimSnapshot>; timelineBuckets(q: TimelineQuery): Promise<LaneBucket[]>;
//                   timelineMarks(q: TimelineMarkQuery): Promise<{ cursor: number; t: SimTime; lane: LaneId; event: TraceEvent }[]>;
//                   setTimeTravelBudget(b: Partial<TimeTravelBudget>): Promise<void>
// [S1] export interface ReviewInfo { at: JournalPosition; t: SimTime; live: JournalPosition; atLive: boolean }

// store/types.ts
// UiState += topoOverlays: { vlan: boolean; stp: boolean; stpVlan: number | null; vlanFocus: number | null; capwap: boolean }
//   a NEW persisted slice (WirelessOverlayState keys stay exactly as pinned by canvas.overlays.test.ts:215-218)
// UiActions += setTopoOverlay<K extends keyof UiState['topoOverlays']>(k: K, v: UiState['topoOverlays'][K]): void
// [S1] UiState += timeline: { review: ReviewInfo | null; head: { t: SimTime; at: JournalPosition } | null;
//                             lanes: LaneId[]; seeking: boolean; reviewEvents: TraceEvent[] /* ≤ 2000 */ }
// [S1] applyBatch with batch.review set: snapshot/delta and now apply as today; events go to timeline.reviewEvents,
//      never to `events`; the epoch does not change. review null → a full live snapshot restores the mirror.
```

### 2.15 Members that stay optional (optional by meaning)

These members keep their `?` after the exit gate: absent means P1 behaviour and P1 bytes, and several are hashed into
goldens (every frameTx `pdu` summary is part of the P0 golden's canonical JSON, accept.p05.harness.ts:176-178). The
source tags each `@since P2 (optional by meaning)`; `contracts.optional-by-meaning.test.ts` (W8) asserts, per
member, that the type still accepts an object without it.

| Contract | Members |
|---|---|
| port.ts | `PortSpec.parent`, `PortState.dot1q`, `PortL3.virtual4`, [S2] `PortL3.groups4` |
| pdu.ts | `RewrapOp.as`, `PduMeta.protected` |
| process.ts | `DebugEvent.fsm`, `DemuxSelector.frame`, `ProcessCtx.radioSettings`, widened `arp.gratuitous` `address`/`mac`, `udp.open` `tunnel`, action `radio-profile` `controller` |
| transport.ts | `LeaseEvent.family` |
| tables.ts | `CamRow.secure`, `RouteRow.paths` / `Route6Row.paths` [S6] |
| events.ts | `frameArrival.central` |
| trace.ts | drop `background`, `PduSummary.vlan`, `PduSummary.tunnel`, [S1] `TraceFilter.machines` |
| snapshot.ts | `PortSnapshot.l2`, `PortSnapshot.parent`, `PortSnapshot.dot1q`, `SimSnapshot.profile` |
| device.ts | `DeviceSpec.profile`, `DeviceModel.profileConfig`, `.subinterfaces`, `.stpDefaultMode`, `PortResolution.parent` |
| topology.ts | `Topology.profile` |
| simulation.ts | `SimulationOptions.profile`, `SimulationOptions.catalog`, [S1] `SimulationOptions.journal` / `pduRegistryLimit` / `resume` |
| scenario.ts | `connectivity.after`, `.settleMs`, `.then` |
| rf.ts / medium.ts | `RadioSettings.bss`, `.controller`, `RadioPortView.bss`, the `BssSnapshot` additions |
| web protocol.ts | `EngineApi.init` `profile`, `EngineApi.reset` `profile`, [S1] `EngineBatch.review`, `.timelineHead` |

Members that DO become required at the exit gate (or earlier, in the item that implements them): `ProcessCtx.profile`,
`ProcessCtx.transition`, `DeviceRuntime.profile`, `DeviceRuntime.errDisablePort`, `Simulation.profile`,
`StpPortRow.protocol` and every table-row field above not marked `?`.

---

## 3. Protocol walk-throughs

§3.0 is the reference algorithm the walk-throughs rely on. Every walk-through uses a P2-profile world unless it says
otherwise; "converged" means spanning tree has finished (§3.6).

### 3.0 Reference: frame path v3

**Pipeline** (`device/pipeline.ts` `frameArrivalVerdict`, P1 §3.1; new steps only):

1. Steps 1–9 unchanged (admin, carrier, err-disabled, role frames, collision, fragment, encapsulation).
2. Step 10, giant limit for ethernet = `mtu + 18 + (layers[1]?.proto === 'dot1q' ? 4 : 0)` (1522 at MTU 1500).
3. **Step 10a, subinterface classification** — only on a port whose effective role is `routed`:
   - tagged frame (layers[1] is `dot1q`, VID v): the subinterface S of this port with `dot1q.vid === v` →
     verdict `{kind: 'subif', port: S, pop: true}`; none → drop `encapsulation-mismatch`, detail
     `tagged frame for VLAN <v>; no subinterface carries it`, counter `inDrops`;
   - untagged frame: a native subinterface S (`dot1q.native`) → `{kind: 'subif', port: S, pop: false}`; else the
     parent itself continues.

   The runtime applies a `subif` verdict: pop (when `pop`) with `vlanPopOp`, provenance stamped with the device and
   cause `encapsulation dot1Q <v>` (mirrored as `mutation` trace events), count `inPackets`/`inBytes` on S, then run
   steps 10b–15 on S.
4. **Step 10b, link-layer filter** — only on a port whose role is not `bridged`, and not `promiscuous`; no counters:
   - destination `01:80:c2:00:00:00`–`0f` or `NF_L2_CONTROL_MAC` → drop `not-for-me`, detail
     `link-layer control frame`;
   - [S2] destination in `01:00:5e:00:00:00`–`01:00:5e:7f:ff:ff` whose low 23 bits match no group in
     `port.l3.groups4` → drop `not-for-me`, detail `multicast group not joined` (without S2 no P2 daemon sends IPv4
     multicast, so the rule is not needed).

   No P0/P1 scenario sends either kind of frame to an L3 port, so no existing trace changes.
5. Step 12, MAC filter: `dst !== port.mac && !(port.l3.virtual4 ?? []).some(v => v.mac === dst)`.
6. Drop events for PDUs with `meta.background` carry `background: true` (§2.7).

**eth-switch on a VLAN-aware device** (`onPdu(ctx, pdu, P)`; transparent devices keep today's code path exactly):

1. P not bridged → drop (unchanged). Outer `hdlc` → relay (unchanged). No ethernet layer → drop (unchanged).
2. **Physical control dispatch** (`classifyControl`, §2.4 table). Classes handled on the physical port — `lacp`,
   `pagp`, `dtp`, `reserved` — are delivered with `Action deliver {to, pdu, port: P}` (or dropped per the table) and
   the frame goes no further. This runs before member translation, so LACP still reaches etherchannel on a
   `waiting` or `suspended` member.
3. **Member translation.** `row = etherchannel[P]`: `bundled` → logical port L = `row.bundle`; `waiting` or
   `suspended` → drop `other`, detail `<P> is not forwarding for <bundle> (<state>)`; `individual`, `down` or no row →
   L = P.
4. **Classify.** `V = classify(readSwitchport(config, L), operOf(L), frame)`:
   - untagged or VID 0 → access: `accessVlan`; trunk: `nativeVlan` **if the native VLAN is allowed**, else drop
     `vlan-filtered`, detail `native VLAN <n> is not allowed on <L>` (the native VLAN is treated like any other
     VLAN of the trunk; control frames never reach this step, they were handled on the physical port at step 2);
   - tagged v → access: v if v is the voice VLAN, else drop `vlan-filtered`, detail
     `tagged frame for VLAN <v> on an access port (access VLAN <a>)`; trunk: v if allowed, else drop
     `vlan-filtered`, detail `VLAN <v> is not allowed on <L>` (a tagged native VLAN is accepted);
   - V does not exist (not 1, not 1002–1005, no `vlans` row) → drop `vlan-filtered`, detail
     `VLAN <V> does not exist`;
   - `operOf(L)` = static mode as configured; dynamic modes from the `dtp` row (`access` until negotiated). For a
     Port-channel L, `operOf(L)` is the common oper mode of its bundled members' `dtp` rows (DTP runs on members); a
     member whose negotiated mode differs from the bundle's is `suspended` with reason
     `trunk negotiation differs from Port-channel<n>` (§3.7 compatibility check);
   - on a `wireless-controller` the configuration is `CONTROLLER_PORT_SWITCHPORT` for every distribution port, and a
     frame arriving on a distribution port that is not the **active** one (the lowest-numbered oper-up distribution
     port) is dropped `other`, detail `<P> is a backup distribution port` (D17).
5. **Logical control dispatch.** Class `stp`: if a `stp-bridge` row exists for V → `deliver {to:'stp', pdu, port: L}`
   (even when L is blocking) and stop; otherwise the BPDU continues as an ordinary multicast in V. Class `vtp` [C1]:
   `deliver {to:'vtp', port: L}` and stop.
6. **Spanning-tree gate** — only when a `stp-bridge` row exists for V: `state = stp[stpKey(V, L)]?.state`.
   `forwarding` → continue; `learning` → learn (step 8), then drop `stp-discarding`, detail `learning`; anything else
   or no row → drop `stp-discarding`, detail = the state (or `not a spanning-tree port`).
7. **Port security** — only when a `port-security` row exists for L (§3.8): allow, or drop `port-security` and act.
8. **Learn** `camKey(V, src)` → L (static and secure rows are never overwritten; group sources never learned).
9. **SVI.** Unicast dst equal to the SVI MAC (all SVIs share the base MAC, ports.ts:184) or to a `virtual4` MAC of
   `Vlan<V>` → if `Vlan<V>` does not exist, treat as unknown unicast; if it is down → drop (unchanged detail);
   else pop the tag if present and `Action ingress {port: 'Vlan<V>', pdu}`.
10. **Forward.** CAM hit `camKey(V, dst)` → egress E. E = L → filter (hairpin roles only go back out). E not an
    egress candidate for V → drop `no egress port` (unchanged detail). Otherwise send one normalised copy (step 12).
11. **Flood.** Candidates, in `ctx.ports` order: oper up, bridged role, not a member row in state `bundled`,
    `waiting` or `suspended`, carries V (`carries(E, V) !== undefined`), forwarding in V when a `stp-bridge` row
    exists for V, E ≠ L unless hairpin; on a `wireless-controller`, a distribution port only if it is the active one
    and only when L is not a distribution port (the controller never bridges port to port, D17). A group frame also
    gets an ingress clone for `Vlan<V>` if it is up (only that SVI; the P1 rule "every up SVI" becomes "the SVI of the
    frame's VLAN").
12. **Fan-out and normalisation.** Allocate every clone first, in target order (so PduIds do not depend on tags),
    then for each (copy, target): `want = carries(E, V)` for a port target, and **always `'untagged'` for the SVI
    ingress target** (an L3 daemon never sees a tag, D4; cause `interface Vlan<V>`); `have` = tagged iff
    `layers[1]` is `dot1q`. untagged → tagged: `ctx.rewrap(copy, vlanPushOp(V), <cause>)`; tagged → untagged:
    `ctx.rewrap(copy, vlanPopOp(), <cause>)`; equal → no mutation. Cause = the line that makes E carry V that way:
    `switchport mode trunk`, `negotiated trunk`, `switchport access vlan <V>`, `switchport voice vlan <V>` or
    `switchport trunk native vlan <V>` (for the SVI clone: `interface Vlan<V>`).

`carries(E, V)` (pure, `protocols/l2/membership.ts`): access E → `'untagged'` for its access VLAN, `'tagged'` for its
voice VLAN; trunk E → for a VLAN that is allowed and exists, `'untagged'` if it is the native VLAN and `'tagged'`
otherwise (a native VLAN that is not allowed is not carried at all); else undefined. A Port-channel uses its own
config; `wlan-tunnel` (Capwap0) carries every existing VLAN tagged; a controller distribution port uses
`CONTROLLER_PORT_SWITCHPORT`. `carries` is never asked about an SVI (step 12 handles the ingress target).

**Debug wording stays byte-identical on the untagged-in / untagged-out VLAN-1 paths** (`learned X on P (vlan 1)`,
`flooding … to N port(s): …`, data keys and their order). A test (`l2.eth-switch.p0-parity.test.ts`, W2) runs the
two P0 golden scenarios **on `test/p2.world.ts`** (P2-stage switch model carrying `managed-switch`, so the VLAN-aware
path runs, in the P1 profile) and compares every event to the golden with no tolerated additions.

**`onEgress(ctx, pdu, 'Vlan<V>')`:** V from the SVI name; `camKey(V, dst)` → egress E if it is a candidate, else
flood over V's candidates; normalise each copy (the frame leaves the SVI untagged).

**CAM flushes** (eth-switch deletes rows, reason `cleared` unless stated). **Only dynamic rows are ever flushed.**
Configured static rows (`mac address-table static`) and configured or sticky secure rows are derived from the running
config and change only when their line does (D12, §3.8):

| Trigger | Dynamic rows removed |
|---|---|
| onConfig: a line of port X whose tokens start `switchport mode`, `switchport access vlan`, `switchport trunk native vlan`, `switchport trunk allowed vlan`, `switchport voice vlan` or `switchport nonegotiate` changes (never a `switchport port-security …` line) | every dynamic row on X |
| `l2.changed {what:'trunk', port}` | every dynamic row on the port |
| `l2.changed {what:'channel', port}` | dynamic rows on the member and on its bundle |
| `l2.changed {what:'stp', port, vlan}` when the port left forwarding | dynamic rows (vlan, port) |
| `l2.changed {what:'vlans', vlan}` when the VLAN was deleted | every dynamic row in the VLAN |
| `l2.flush {vlan, mode:'flush', ports}` | the VLAN's dynamic rows on exactly `ports` |
| `l2.flush {vlan, mode:'fast-age', ports, ageingNs}` | none; `expiresAt = min(expiresAt, now + ageingNs)` for the VLAN's dynamic rows on `ports` |
| onLinkChange(port, false) | every dynamic row on the port, including dynamic (non-sticky) secure rows (unchanged, reason `link-down`) |

**Virtual oper state** (`device/ports.ts` `evaluateVirtualOper`, with lookups the runtime injects; without lookups the
P1 rule applies unchanged, which keeps `device.ports.test.ts` valid):

| Role | Up when | Down reasons |
|---|---|---|
| svi on a VLAN-aware device | power, booted, admin up, VLAN V exists, and some port E is oper up, bridged, not a non-`individual` member, carries V, and forwards in V when spanning tree runs for V | `vlan-missing`; otherwise the P1 reason `no-bridged-port-up` (for every VLAN, so a P1-profile Vlan1 reports exactly what it reports today and `device.virtual.test.ts:147` stays unchanged) |
| svi elsewhere | P1 rule (Vlan1 only, any bridged port up) | unchanged |
| channel | power, booted, admin up, some member row with `bundle` = this port and state `bundled` whose port is oper up | `no-bundled-member` |
| subif | power, booted, admin up, parent oper up with role `routed`, `dot1q` set | `parent-down`, `no-encapsulation` |
| wlan-tunnel | power, booted | — |

The runtime recomputes virtual oper at the P1 sites plus: after every `l2Changed`, `errDisable` and `errRecover`
action, and after every applied config line whose first token is `switchport`, `vlan`, `channel-group`,
`encapsulation` or `spanning-tree`.

### 3.1 Access port with a VLAN

Setup: SW1 (NF-C2960). PC1 on Fa0/1, PC2 on Fa0/2, PC3 on Fa0/3. SW1: `vlan 10`, `name SALES`; Fa0/1–2:
`switchport mode access`, `switchport access vlan 10`. Fa0/3 is left at its defaults (VLAN 1).

1. `vlan 10` enters `config-vlan`; `name SALES` stores the section `vlan 10` / ` name SALES`. The `vlan` daemon sees the
   deltas, writes `vlans` row `{key:'10', vlan:10, name:'SALES', status:'active', source:'config'}` and issues
   `l2Changed {what:'vlans', vlan:10}`. The runtime delivers `l2.changed` to eth-switch, dtp, etherchannel and stp,
   then recomputes virtual oper (a `Vlan10` SVI, if one exists, may come up later).
2. `switchport access vlan 10` on Fa0/1: had VLAN 10 not existed, the CLI handler would first apply `vlan 10` and print
   `CLI_MESSAGES.vlanCreated`. The configChange reaches eth-switch (flush Fa0/1's rows), stp (Fa0/1 leaves VLAN 1's
   instance and joins VLAN 10's, which is created because it now has an up port) and the runtime (SVI recompute).
   Fa0/1 goes listening in VLAN 10 and is forwarding 30 s later (PortFast would make it immediate).
3. PC1 broadcasts an ARP request. eth-switch: no member row; not control; classify → untagged on access → V = 10;
   VLAN 10 forwarding on Fa0/1; learn `camKey(10, PC1)` with debug `learned <mac> on FastEthernet0/1 (vlan 10)`;
   flood candidates carrying 10 → Fa0/2 only (Fa0/3 is in VLAN 1). Fa0/2 carries 10 untagged and the frame is
   untagged → no mutation. **PC2 receives the same PduId with the same bytes PC1 sent.**
4. PC3 pings PC1: its ARP floods in VLAN 1 and never reaches Fa0/1 → `arp-unresolved` at PC3. The ping fails.
5. A frame tagged VLAN 20 arriving on Fa0/1 → drop `vlan-filtered`, detail
   `tagged frame for VLAN 20 on an access port (access VLAN 10)`.
6. `no vlan 10`: the vlans row is deleted; `l2.changed {what:'vlans'}`; Fa0/1–2 are now in a VLAN that does not exist:
   their frames drop `vlan-filtered` (`VLAN 10 does not exist`) and `show interfaces switchport` shows the port
   inactive — the IOS behaviour learners are taught to diagnose.

### 3.2 Trunk with a native VLAN and an allowed list

Setup: SW1 Gi0/1 ↔ SW2 Gi0/1. Both: `switchport mode trunk`, `switchport trunk native vlan 99`,
`switchport trunk allowed vlan 1,10,20,99`. VLANs 10, 20, 99 exist on both. PC1 on SW1 Fa0/1 and PC2 on SW2 Fa0/1,
both access VLAN 10; PC3 on SW2 Fa0/3 is left in VLAN 1.

1. `switchport mode trunk` (without `nonegotiate`) makes dtp write a `dtp` row `{admin:'trunk', oper:'trunk',
   status:'static'}` and send DTP (§3.3). eth-switch flushes Gi0/1. stp adds Gi0/1 to the instances of VLANs 1, 10,
   20 and 99 (each on its own timers).
2. PC1's ARP floods in VLAN 10 at SW1. Target Gi0/1 carries 10 tagged → `ctx.rewrap(copy, vlanPushOp(10),
   'switchport mode trunk')`. Provenance, stamped SW1: `VlanTagPush {field:'dot1q.vid', before:null, after:10,
   cause:'switchport mode trunk'}`, `FcsRecompute {field:'ethernet.fcs'}`. The frame is 64 bytes on the wire
   (14 + 4 + 28 + 14 padding + 4); `PduSummary.vlan = 10`.
3. SW2 Gi0/1 classifies tagged 10 (allowed) → learns `camKey(10, PC1)` on Gi0/1 → floods to Fa0/1 (access 10,
   untagged) → `vlanPopOp()`, cause `switchport access vlan 10`: `VlanTagPop {before:10, after:null}`,
   `FcsRecompute`. **The frame PC2 receives is byte-identical to the frame PC1 sent.**
4. Native VLAN: frames of VLAN 99 cross untagged in both directions (no mutation). A frame arriving tagged 99 is
   accepted as VLAN 99 and leaves an access port or the native VLAN untagged. Had the allowed list left out the
   native VLAN (`allowed vlan 10,20`), untagged frames arriving on Gi0/1 would drop `vlan-filtered`, detail
   `native VLAN 99 is not allowed on GigabitEthernet0/1`, and no VLAN 99 frame would cross (§3.0 step 4).
5. Allowed list: a VLAN 30 frame on SW1 never has Gi0/1 as a candidate. A frame arriving on Gi0/1 tagged 30 → drop
   `vlan-filtered`, detail `VLAN 30 is not allowed on GigabitEthernet0/1`. `switchport trunk allowed vlan add 30`
   is resolved by the CLI handler to the canonical line `switchport trunk allowed vlan 1,10,20,30,99` (§5).
6. **Native VLAN mismatch**, SW2 changed to `switchport trunk native vlan 1` (both VLANs 1 and 99 are allowed on
   both ends, so each end sends one of them untagged and the other tagged):
   - Spanning tree on (P2 profile): every trunk BPDU carries the sender's `pvid` TLV. SW2 receives on Gi0/1 an
     untagged BPDU with `pvid` 99 while its own native VLAN is 1; SW1 receives an untagged BPDU with `pvid` 1 while
     its own is 99. **Each end detects the mismatch only from an untagged BPDU it actually receives.** Each marks the
     port `inconsistent: 'pvid'` for the two VLANs involved (its own native VLAN and the received pvid), sets it
     `blocking` (pvst) / `discarding` (rapid) for them, and logs (severity 2, original): `Native VLAN mismatch on
     GigabitEthernet0/1: this switch sends VLAN 99 untagged, the neighbour sends VLAN 1. VLANs 1 and 99 are blocked on
     this port.` The inconsistency clears when an untagged BPDU with a matching pvid arrives, or when the stored
     information ages out.
   - Spanning tree off (P1 profile): untagged VLAN 99 frames from SW1 are classified as VLAN 1 at SW2 — they leak
     between VLANs, observable as PC3 (VLAN 1 on SW2) answering an ARP sent from a VLAN 99 host on SW1.

### 3.3 DTP negotiation

Rules (dtp daemon; a `dtp` row exists from link-up for a `trunk` port with `negotiate` true and for a
`dynamic-desirable` port, and for a `dynamic-auto` or `access` port (negotiate true) only once DTP has been received
on it — §4.3):

1. **Who speaks.** `trunk` and `dynamic-desirable` ports send a DTP frame at link-up and every 30 s
   (`dtp-hello:<port>`, periodic). A `dynamic-auto` port sends nothing until it has received DTP on that port; from
   then on it answers immediately and sends every 30 s like the others. An `access` port with `negotiate` true
   **only answers**: (a) every DTP frame it receives from a neighbour that is not itself an access port is answered
   at once with one DTP frame advertising `adminMode` access (a frame advertising access is consumed and recorded but
   never answered: an access neighbour is static, so the answer carries nothing, and two access ports answering each
   other would never stop — W4 close-out, 2026-09-23, architect ruling on `accept.p2.stp-guards`); (b) when a port
   changes to `access` while its `dtp` row shows a DTP-speaking neighbour, it sends one such frame at once. It never
   sends on a timer. `nonegotiate` ports send nothing and ignore DTP (dropped
   silently, no row). Untouched switches stay silent: no port is in access mode by default and nothing is received.
   A dynamic port that receives `adminMode` access goes oper `access` at once (the IOS outcome: "the port
   negotiates to convert the link into a non-trunk link").
2. **Frame.** `[ethernet {dst NF_L2_CONTROL_MAC, src port MAC, type 0 → length}, llc {dsap 0xaa, ssap 0xaa, control 3,
   oui NF_OUI, type NF_PID_DTP}, dtp {version 1, domain, adminMode, operTrunk, trunkType 1, neighbor: port MAC}]`,
   `meta {tag: 'dtp', background: true}`.
3. **Decision** on every received frame (the row stores `neighborMode`):

   | This port \ neighbour | access (answers only) | trunk | desirable | auto | nonegotiate trunk (silent) |
   |---|---|---|---|---|---|
   | trunk | trunk | trunk | trunk | trunk | trunk |
   | desirable | access | trunk | trunk | trunk | access |
   | auto | access (both silent) | trunk | trunk | access (both silent) | access |

   `trunk` and `access` rows are `status:'static'`; dynamic rows are `waiting` until a frame arrives, then
   `negotiated`. When `oper` changes: tableWrite, `ctx.transition('dtp', …, {machine:'dtp',
   subject:'GigabitEthernet0/1', from, to})` and `l2Changed {what:'trunk', port}` (eth-switch flushes the port, stp
   re-derives its instances).
4. **Ageing.** `dtp-age:<port>` (periodic flag, re-armed per received frame, 300 s): on expiry a dynamic port returns to
   `access` (`waiting`). Link down → row back to `waiting`/`static`, oper access for dynamic ports. Ageing is only
   the fallback for a neighbour that vanished silently; a neighbour reconfigured to access says so at once (rule 1).
5. **Port-channels.** DTP runs on the members (control frames are handled on the physical port, §3.0 step 2). The
   bundle's oper mode is the common oper mode of its bundled members' rows; a member that negotiates differently is
   `suspended` (§3.0 step 4, §3.7).
6. Timing: link-up to trunk is one frame exchange (propagation only). The 5×5 matrix is `accept.p2.dtp` (§10).

### 3.4 Router-on-a-stick

Setup: R1 (NF-2911) Gi0/0 ↔ SW1 Gi0/1 (`switchport mode trunk`). PC1 on SW1 Fa0/1 (VLAN 10, 192.168.10.10, gateway
.1), PC2 on SW1 Fa0/2 (VLAN 20, 192.168.20.10). R1: `interface g0/0` / `no shutdown`; `interface g0/0.10` /
`encapsulation dot1Q 10` / `ip address 192.168.10.1 255.255.255.0`; the same for `.20`; `interface g0/0.99` /
`encapsulation dot1Q 99 native`.

1. **Create.** `interface g0/0.10` resolves (names.ts) to `{kind:'virtual', port:'GigabitEthernet0/0.10',
   family:'subinterface', parent:'GigabitEthernet0/0'}`; `ensureVirtualPort` builds a `subif` PortState: MAC and
   ordinal of the parent, `PortSpec.parent`, admin up, mtu of the parent. Canonical order: after every other virtual
   port, by (parent position, n). Section `interface GigabitEthernet0/0.10` in the running config.
2. **Encapsulation.** `encapsulation dot1Q 10` is special-cased in `applyConfigLine` (like serial encapsulation today,
   device.ts:880-884): accepted only on a subif (`CLI_MESSAGES.encapNotHere` elsewhere, except serial
   `hdlc|ppp`), a VID already used on the same parent → `CLI_MESSAGES.duplicateVid`. Sets `PortState.dot1q =
   {vid:10, native:false}`; oper recompute brings the subif up (parent up). `ip address` on a subif without
   `dot1q` → `CLI_MESSAGES.subifNeedsEncap` (CLI check). ipv4 installs C 192.168.10.0/24 and L .1/32 via
   Gi0/0.10.
3. **PC1 → gateway ARP.** SW1 floods VLAN 10's broadcast; Gi0/1 carries 10 tagged → `VlanTagPush` (SW1,
   `switchport mode trunk`). At R1 Gi0/0: pipeline step 10a → VID 10 → Gi0/0.10, pop (`VlanTagPop`, R1,
   `encapsulation dot1Q 10`), count on Gi0/0.10, MAC filter (group) → demux (`subif` is an L3 role) → arp. The reply
   is sent on Gi0/0.10 → egress `parent`: count out on Gi0/0.10, `VlanTagPush` (R1, `encapsulation dot1Q 10`),
   transmit on Gi0/0.
4. **PC1 pings PC2.** At R1 the echo request is popped at ingress, then ipv4 forwards: LPM C 192.168.20.0/24 via
   Gi0/0.20 → `TtlDecrement 128→127` (cause the connected route line) → `arp.sendVia` iface Gi0/0.20 → `MacRewrite`
   dst and src (src = `macOf(Gi0/0.20)` = Gi0/0's MAC) → send on Gi0/0.20 → push 20. SW1 classifies tagged 20 and
   pops toward Fa0/2.

   Mutation order on the request (every `Pdu.mutate` re-encodes out to the Ethernet layer and so records its own
   `FcsRecompute`, exactly as P1 pins at ip.ipv4.test.ts:195 and pdu.pdu.test.ts:194, :277; every `as`-rewrap
   records `[VlanTag…, FcsRecompute]`, §2.3):
   - SW1: `VlanTagPush 10`, `FcsRecompute`;
   - R1: `VlanTagPop 10`, `FcsRecompute`, `TtlDecrement`, `ChecksumRecompute`, `FcsRecompute`, `MacRewrite` (dst),
     `FcsRecompute`, `MacRewrite` (src), `FcsRecompute`, `VlanTagPush 20`, `FcsRecompute`;
   - SW1: `VlanTagPop 20`, `FcsRecompute`.

   Same PduId throughout. The pdu owner derives this sequence from real calls in a W1 unit test
   (`pdu.vlan.test.ts`, "router-on-a-stick sequence"); if the observed derived records differ, the architect corrects
   this list before W4, and the acceptance test pins the observed engine behaviour, never this prose.
5. **Native subinterface.** An untagged frame on Gi0/0 goes to Gi0/0.99 without a pop; replies on Gi0/0.99 leave
   untagged.
6. **Failure.** `shutdown` on Gi0/0, or a cut cable → parent down → every subif down (`parent-down`) → their C/L routes
   are withdrawn. A frame tagged 30 → drop `encapsulation-mismatch`, detail
   `tagged frame for VLAN 30; no subinterface carries it`.

### 3.5 An L3 switch SVI route

Setup: MLS1 (NF-C3650-24) with PC1 on Gi1/0/1 (VLAN 10) and PC2 on Gi1/0/2 (VLAN 20). MLS1: `vlan 10`, `vlan 20`,
access ports, `interface vlan 10` / `ip address 192.168.10.1 255.255.255.0` / `no shutdown`, the same for VLAN 20.
In the P2 profile the switch booted with `no ip routing` replayed.

1. **Autostate.** Vlan10 comes up when VLAN 10 exists and Gi1/0/1 is up and forwarding in VLAN 10 (§3.0 table). Before
   that, `show ip interface brief` shows it down with the reason from `evaluateVirtualOper`.
2. **Local delivery works without routing.** PC1 pings 192.168.10.1: eth-switch classifies V = 10, the destination is
   the SVI MAC → `Action ingress {port:'Vlan10'}` → ipv4 → icmpv4 reply → `send` on Vlan10 → owner
   `eth-switch.onEgress(Vlan10)` → `camKey(10, PC1)` → Gi1/0/1 → untagged.
3. **Forwarding needs `ip routing`.** PC1 pings PC2: ipv4 sees a packet not for itself; forwarding is enabled iff
   `model.ipForwarding` and the running config does not contain the stored negation `no ip routing`. With the line
   present → drop `no-route`, detail `IP routing is switched off on this device (ip routing)`. The host daemon offers
   `ip default-gateway` whenever forwarding is off by this rule (host.ts:90 today checks only `model.ipForwarding`).
4. After `ip routing`: the `ip routing` rule is `bothForms` (§5), so `ip routing` replaces the stored
   `no ip routing` in the same slot and is itself stored. The running config shows `ip routing`; export, reload and
   the grader's clone replay `no ip routing` (profile) and then `ip routing` (saved), so the switch keeps routing
   (`accept.p2.svi-routing` checks this in a lab clone). LPM C
   192.168.20.0/24 via Vlan20 → TTL → `arp.sendVia` iface Vlan20 → `send` on Vlan20 → `eth-switch.onEgress` → VLAN 20
   → Gi1/0/2. No tag is ever pushed: both hosts sit on access ports.
5. In the P1 profile nothing is replayed, so every existing multilayer scenario keeps forwarding as before, and
   `ip routing` typed there is stored exactly as today. `no ip routing` typed in any world is stored and switches
   forwarding off (a P2 command that works in a P1 world).

### 3.6 Spanning tree: root election and a topology change

Setup: SW1, SW2 and SW3 in a triangle (links SW1–SW2, SW1–SW3 and SW2–SW3, all 1 Gb, cost 4). VLAN 1 only.
SW1 has `spanning-tree vlan 1 priority 4096` so the root does not depend on MAC values. All switches boot at 30 s;
links come up at 30 s.

**Identities and costs.** Bridge id = (priority + VLAN, base MAC `deviceMacBase`). Port id = 802.1t: priority
(default 128, multiples of 16) in the top 4 bits, port number = `ordinal` (physical) or `1024 + n` (Port-channel n)
in the low 12 bits; shown `128.<number>`. Path cost (short method) from the negotiated speed: ≥ 10 G → 2, ≥ 1 G → 4,
≥ 100 M → 19, ≥ 10 M → 100; a Port-channel uses the aggregate bandwidth of its **currently bundled** members
(2 × 1 G → 3, 2 × 100 M → 12; table in `protocols/stp/cost.ts`) and is recomputed whenever the bundled set changes
(one member lost: 3 → 4). A cost change updates the `stp` row's `cost` and re-runs the priority-vector comparison;
it is not by itself a role change, a state change or a topology change. `spanning-tree cost` overrides. Priority-vector comparison is the 802.1D order
(root id, root path cost, designated bridge id, designated port id, receiving port id), in `protocols/stp/vector.ts`.

**PVST+ (`spanning-tree mode pvst`, 802.1D rules per VLAN).**

1. t = 30 s, a port of SW1 comes up: VLAN 1 now has an up port, so stp creates the instance: `stp-bridge` row, one
   `stp` row per STP port `{role:'designated', state:'listening', stateSince:30 s, nextTransitionAt:45 s}`, timer
   `fwd:1:<port>` (15 s, non-periodic), timer `hello:1` (2 s, periodic, armed in ascending VLAN order). Every bridge
   initially believes it is the root and sends a config BPDU on each designated port at once.
2. BPDU: `[ethernet {dst STP_GROUP_MAC, src port MAC, type 0}, llc {dsap 0x42, ssap 0x42, control 3}, stp {version 0,
   bpduType 0x00, root…, rootPathCost, bridge…, portId, messageAge 0, maxAge 20×256, helloTime 2×256,
   forwardDelay 15×256}]`, `meta {tag:'bpdu', background:true}`. On a **trunk** the BPDU also carries `pvid` (the
   VLAN of the instance) and is tagged per §3.0 membership (the native VLAN's untagged); on an **access** port it is
   a plain untagged IEEE BPDU with no `pvid` (D8).
3. SW2 receives SW1's superior BPDU on Gi0/1 → root port Gi0/1 (role changes, the listening timer keeps running).
   In 802.1D a non-root bridge sends BPDUs on its designated ports when it receives one on its root port (relay,
   message age + 1); only the root originates on its hello tick. On the SW2–SW3 link both have root cost 4; the lower
   bridge id (say SW2) is designated; SW3's port becomes `alternate`/`blocking` and its `fwd:` timer is cancelled.
   Each transition: tableWrite, `ctx.transition('spanning-tree events', …, {machine:'stp-port',
   subject:'VLAN0001 GigabitEthernet0/2', instance:1, from, to, cause, pdu})`.
4. t = 45 s: listening → learning (eth-switch learns but does not forward). t = 60 s: learning → forwarding for every
   root and designated port. Each change to or from forwarding issues `l2Changed {what:'stp', port, vlan:1}`
   (SVI autostate; CAM rows of a port leaving forwarding are flushed).
5. **Topology change (802.1D).**
   - *Detection.* A bridge detects a topology change when a non-edge port enters forwarding (and the bridge has at
     least one designated port), **or** when a port in forwarding or learning leaves it (goes blocking, is disabled
     or goes down). So in both failure walk-throughs below the TC starts at the cut.
   - *Notification.* A non-root bridge that detects one sends a TCN BPDU out its root port at once and then on every
     hello until a BPDU with TC-ack arrives on the root port — no try limit (`tcn:<vlan>`, periodic: an
     unacknowledged TCN must not hold `runToIdle`; the first TCN is sent immediately, so `runToIdle` still sees it
     reach the root).
   - *Relay.* A designated port that receives a TCN sets TC-ack in the next BPDU it sends on that port (sent at once)
     and, unless the bridge is the root, sends its own TCN out its root port in the same way.
   - *Root.* The root, on detecting or receiving a TCN, sets the TC flag in its BPDUs for max age + forward delay =
     35 s (`tc:<vlan>`, non-periodic).
   - *Flush.* A bridge that receives a BPDU with TC set (or is the root inside its TC window) sends
     `l2.flush {vlan, mode:'fast-age', ports: <every STP port of the VLAN>, ageingNs: forward delay}` to eth-switch
     once per TC period. `stp-bridge.topologyChanges` increments; `lastChangeAt`/`lastChangePort` are set.
6. **Direct failure.** Cut SW1–SW3 (SW3's root port) at T: SW3 has valid stored information on its alternate port →
   it becomes the root port and restarts at listening → forwarding at T + 30 s.
7. **Indirect failure.** Cut SW1–SW2 at T: SW2 loses its root port and has no alternate, so it claims to be root and
   sends inferior BPDUs to SW3. SW3 keeps its stored superior information on that port until it ages out:
   `age:1:<port>` (periodic flag, re-armed on every BPDU to `maxAge − messageAge`; a relaying bridge adds 1 s to
   `messageAge`, so the information SW2 relayed lives 19 s) fires between T + 17 s and T + 19 s (the last relayed
   BPDU arrived at most one hello before T). SW3's port (the old alternate) then becomes designated, sends SW1's
   information and goes listening → learning → forwarding 30 s later, in [T + 47 s, T + 50 s]. SW2's Gi0/2, forwarding
   all along as a designated port, becomes SW2's root port when that first BPDU arrives. SW2 reaches the root again
   when SW3's port forwards.

**Rapid PVST+ (`spanning-tree mode rapid-pvst`, 802.1w rules per VLAN).**

1. States are `discarding`, `learning`, `forwarding`; roles add `backup`. Every bridge sends its own BPDUs (version 2,
   type 0x02) on designated ports every hello; information ages after 3 × hello = 6 s (`age:` periodic flag).
2. A link is point-to-point when the port is full duplex (`PortState.duplex`). Edge = PortFast (no automatic edge
   detection); an edge port goes forwarding at link-up and loses edge status on receiving a BPDU.
3. Proposal/agreement: a designated, non-forwarding port on a point-to-point link sends a BPDU with the proposal flag.
   - The downstream bridge, on accepting a superior proposal on its new **root** port, **syncs** (puts every
     non-edge designated port to discarding), answers with the agreement flag on the root port and puts the root port
     forwarding at once; the upstream port receiving the agreement goes forwarding at once. The downstream bridge's
     designated ports then propose in turn.
   - A port whose role is **alternate or backup** that receives a proposal replies at once with a BPDU carrying the
     agreement flag (802.1D-2004 ALTERNATE_AGREED: it is already discarding, so agreeing is safe); the proposing
     designated port then goes forwarding at once. In the triangle this is SW3's port on the SW2–SW3 link answering
     SW2's proposal.
   - **A designated port that gets no agreement falls back to `fwd:` timers (2 × forward delay = 30 s) on any link
     type.** That covers shared (half-duplex) links, a neighbour that speaks 802.1D (Mixed modes below) and a
     non-edge port facing a host, which never answers: a host port without PortFast takes 30 s in rapid mode too.
4. At boot the triangle's inter-switch ports converge within one exchange per hop (propagation only; well under 1 s
   of link-up).
5. Direct failure (cut SW3's root port): the alternate becomes root port and forwards in the same dispatch; TC.
6. Indirect failure (cut SW1–SW2): SW2 claims root and sends its own BPDUs on Gi0/2. SW3 accepts inferior
   information from the designated bridge of that segment immediately (802.1w), so its port there (the old
   alternate) becomes designated with SW3's better path and proposes; SW2's Gi0/2 takes that as its new root port,
   syncs and agrees; SW3's port forwards. Well under 1 s, with no `fwd:` timer armed.
7. TC (802.1w): only a non-edge port going to forwarding originates one.
   - *Originator.* The bridge starts `tcwhile` = 2 × hello (`tcwhile:<vlan>:<port>`, non-periodic) on each of its
     non-edge root and designated ports, sends BPDUs with the TC flag on them while it runs, and flushes its own
     dynamic rows on those ports except the one that went forwarding (`l2.flush {mode:'flush', ports}`, an explicit
     list: edge ports are never flushed, so host entries survive).
   - *Receiver (propagation).* A bridge receiving a BPDU with TC on port P starts `tcwhile` and sends TC BPDUs on
     every non-edge root and designated port except P, and flushes the dynamic rows on exactly those ports. So the
     change propagates across the whole tree, not only to the originator's neighbours.

**Mixed modes (a `pvst` and a `rapid-pvst` switch on one link).** NF-C9300 defaults to rapid, the other switches to
pvst (D3), so mixed links are ordinary in P2 worlds.

1. *Port protocol migration* (802.1D-2004 §17.24). A rapid port starts in `protocol: 'rstp'` with a 3 s migrate
   delay (`migrate:<vlan>:<port>`, non-periodic). A version-0 (802.1D) BPDU received after that delay sets the
   port's `protocol` to `'stp'`: on that port only it sends 802.1D config and TCN BPDUs, forgoes proposal/agreement,
   uses listening/learning timers, and accepts TCNs (which it acknowledges and relays as in PVST+ step 5). Other
   ports of the bridge stay rapid.
2. A `pvst` bridge discards type-0x02 (RST) BPDUs (as legacy bridges do), so until migration the rapid neighbour's
   port stays designated; the pvst side's own BPDUs then trigger the migration.
3. `clear spanning-tree detected-protocols [interface <if>]` (exec, §5.4) sets every (or that) port back to
   `'rstp'` and restarts its migrate delay; if the neighbour is still 802.1D it migrates again.
4. `no spanning-tree mode` restores the **model** default (`DeviceModel.stpDefaultMode`) in a P2 world, not always
   `pvst` (§5.1).
5. `stp.mixed.test.ts` and `accept.p2.stp-rapid` cover an NF-C2960 (pvst) linked to an NF-C9300 (rapid): 30 s
   timer-based transition on their shared link, rapid convergence on the rapid-only links.

**Guards.**

- **PortFast.** A port is edge when (`spanning-tree portfast` on the interface, or `spanning-tree portfast default`
  globally) **and** it is operationally non-trunking — which, with the D3 default of `dynamic auto`, includes host
  ports never set to `switchport mode access` — **or** when `spanning-tree portfast trunk` is on an operational
  trunk. Typing `spanning-tree portfast` on a port that is trunking prints `CLI_MESSAGES.portfastOnTrunk` (the line
  is stored and applies once the port stops trunking). Edge ports go forwarding at link-up and cause no TC.
- **Type inconsistency.** An access (non-trunking) port that receives a BPDU carrying the `pvid` TLV faces a trunk:
  it goes `inconsistent: 'type'`, blocking (pvst) / discarding (rapid), and logs (original wording); it recovers
  when such BPDUs stop (information ages out). The `pvid` check itself runs only on trunks, only for untagged BPDUs,
  against the trunk's native VLAN (§3.2 step 6).
- **BPDU guard** (`spanning-tree bpduguard enable`, or `spanning-tree portfast bpduguard default` on edge ports): any
  BPDU received → `errDisable {port, cause:'bpduguard'}`, log (original). Recovery per §3.8.
- **Root guard** (`spanning-tree guard root`): a superior BPDU on the port → `inconsistent:'root'`, blocking or
  discarding, log; it recovers when superior BPDUs stop (the port's information ages out).
- **Loop guard** [SHOULD S5] (`spanning-tree guard loop`): on a root or alternate port whose information ages out, the
  port goes `inconsistent:'loop'` (blocking) instead of designated; it recovers on the next BPDU.

### 3.7 EtherChannel with LACP, and a misconfiguration

Setup: SW1 Gi0/1–2 ↔ SW2 Gi0/1–2. SW1: `interface range gi0/1 - 2` / `switchport mode trunk` /
`channel-group 1 mode active`. SW2: the same with `mode passive`.

1. **Creation.** The CLI handler for `channel-group 1 …` applies `interface Port-channel1` if it does not exist (prints
   `CLI_MESSAGES.channelCreated`) and copies the member's switchport lines into the Port-channel section. Lines typed
   later under `interface Port-channel1` are also applied to every member (the handler does it), so members and bundle
   stay consistent the way IOS keeps them.
2. **Rows.** etherchannel writes `{port:'GigabitEthernet0/1', group:1, bundle:'Port-channel1', protocol:'lacp',
   mode:'active', state:'waiting'}` per member.
3. **LACP.** At link-up an `active` member sends an LACPDU at once and then every 1 s for up to 3 tries (`lacp-fast:<port>`,
   non-periodic); a `passive` member answers the first LACPDU it receives. LACPDU:
   `[ethernet {dst SLOW_PROTOCOLS_MAC, src port MAC, type 0x8809}, lacp {actor…: system = base MAC, key = group,
   port = ordinal, state activity/aggregation/sync…}]`, `meta {tag:'lacp', background:true}`. When a member has seen
   its partner with the sync bit, the same partner system and key as the other bundled members, and compatible
   config (below), it becomes `bundled` (tableWrite, `ctx.transition('etherchannel', …, {machine:'lacp', subject:'Port-channel1 GigabitEthernet0/1'})`,
   `l2Changed {what:'channel', port}`); afterwards LACPDUs every 30 s (`lacp-tx:<port>`, periodic) and partner ageing
   at 90 s (`lacp-age:<port>`, periodic flag).
4. **Bundle up.** The runtime sees the member bundled and up → Port-channel1 up (portState reason `bundle-up`) →
   `onLinkChange(Port-channel1, true)`. stp: members drop out of their instances (rows deleted), Port-channel1 joins
   (listening or proposal, cost 3). eth-switch learns on Port-channel1.
5. **Egress.** eth-switch floods to Port-channel1 once; the `send` reaches `etherchannel.onEgress(pdu,
   'Port-channel1')`: `i = hash(method, frame) mod n` over the bundled members in canonical port order →
   `send` on that member. Default method `src-mac` (`port-channel load-balance` changes it). NetForge port MACs are
   `02:b3:b2:b1:b0:<ordinal>` (addr.ts:280-288), so the last octet is the port ordinal (every single-NIC PC ends in
   `:01`) and must not be the hash input. The MAC hash folds the five octets that vary per device:
   `fold(mac) = o1 ^ o2 ^ o3 ^ o4 ^ o5` (every octet except the fixed `0x02` prefix); `src-mac` = fold(src),
   `dst-mac` = fold(dst), `src-dst-mac` = fold(src) ^ fold(dst). `src-ip`, `dst-ip`, `src-dst-ip` use
   `o0 ^ o1 ^ o2 ^ o3` of the IPv4 addresses (XOR of the two for src-dst) and fall back to the MAC variant for non-IP
   frames. No bundled member → drop `other`, detail `Port-channel1 has no active member`.
6. **Ingress.** A frame on Gi0/2 is translated to Port-channel1 right after physical control dispatch (§3.0 step 3);
   LACPDUs are delivered to etherchannel on the physical port.
7. **Losing a member.** Cut Gi0/2: its row goes `down`, the bundle stays up, flows rehash onto Gi0/1. Port-channel1's
   spanning-tree cost is recomputed from the remaining bandwidth (3 → 4, §3.6): the `stp` row's `cost` changes, but
   no role or state changes, no topology change is raised and no CAM row on Port-channel1 is flushed.
8. **No LACP partner → individual.** A member that hears no LACPDU goes `individual` with reason `no LACP partner`
   (C2960-class stand-alone behaviour): an `active` member after its third unanswered LACPDU (3 s), a `passive`
   member after `lacp-wait:<port>` (3 s, non-periodic). An individual member is an ordinary switch port: it takes part
   in spanning tree on its own and in flooding. An active individual member keeps sending LACPDUs every 30 s
   (`lacp-tx`), so a partner configured later is found and the member bundles then.
   - `passive`–`passive`: both ends' members go `individual` after 3 s; the bundle does not form, spanning tree
     blocks all but one of the parallel links, and traffic still flows over the one left forwarding.
   - **Misconfiguration A — `on` against LACP.** SW2 `mode on`, SW1 `mode active`. SW2 bundles at link-up (static, no
     frames) and ignores LACPDUs. SW1's members go `individual` after 3 s and run as two spanning-tree ports facing
     SW2's one bundle. Frames can be duplicated (as on real equipment), but no loop forms: SW2 never sends a frame
     back into the bundle it arrived on, and spanning tree still sees the two SW1 ports. [SHOULD S5] With EtherChannel
     guard SW2 detects BPDUs from two different SW1 ports on one bundle and err-disables Port-channel1
     (`channel-misconfig`).
9. **Misconfiguration B — incompatible members → suspended.** A member whose speed, duplex, `readSwitchport` view or
   negotiated DTP mode differs from the Port-channel's → `suspended`, reason
   `configuration differs from Port-channel1 (<first difference>)` (DTP: `trunk negotiation differs from
   Port-channel1`); a member whose LACP partner system or key differs from the bundle's → `suspended`, reason
   `partner differs from the rest of Port-channel1`. A suspended member carries no traffic (§3.0 step 3).

### 3.8 Port security: violation → err-disable → recovery

Setup: SW1 Fa0/1: `switchport mode access`, `switchport port-security`, `switchport port-security maximum 1`,
`switchport port-security mac-address sticky` (violation defaults to `shutdown`). PC1 on Fa0/1.

1. `switchport port-security` on a dynamic port → `CLI_MESSAGES.securityNeedsStaticMode`. Accepted here: eth-switch
   writes a `port-security` row `{max:1, count:0, violation:'shutdown', sticky:true, violations:0,
   status:'secure-up'}`.
2. PC1 sends its first frame. eth-switch step 7 (§3.0): the source is unknown, count 0 < max 1 → learn as secure: CAM row
   `{type:'static', secure:'sticky'}` (no `expiresAt`), row `count: 1`, and `Action configLine {context:
   [['interface','FastEthernet0/1']], line: ['switchport','port-security','mac-address','sticky', <mac>],
   negate:false}` → a configChange; the line is in the running config (and survives `copy run start`).
   - The runtime fans the line's `onConfig` out to eth-switch too. eth-switch derives secure rows **idempotently**
     from `switchport port-security mac-address [sticky] <mac>` lines on every onConfig: an address already secure on
     that port changes nothing (no count change, no CAM write); a line for a new address installs its row (this is
     also how a saved or reloaded config restores sticky and configured addresses, before any frame). A
     `switchport port-security …` line never triggers the §3.0 CAM flush, and secure rows are never flushed.
   - So PC1's next frames forward normally: no violation, one configChange in total, and the secure CAM row stays
     (`l2.eth-switch.psec.test.ts`: a sticky learn followed by 10 frames from the same host).
3. PC-X replaces PC1 on Fa0/1 and sends a frame: unknown source, count = max → **violation**:
   - `protect`: drop `port-security`, detail `address <mac> is not allowed on FastEthernet0/1 (protect)`; nothing else.
   - `restrict`: the same drop, `violations + 1`, log severity 4 (original): `Port security on FastEthernet0/1
     refused <mac>: the port allows 1 address.`
   - `shutdown`: the same drop, `violations + 1`, `status: 'secure-shutdown'`, then `Action errDisable {port:
     'FastEthernet0/1', cause: 'psecure-violation'}`. The runtime sets `errDisabled`, emits `portState` reason
     `err-disabled` and a log, and calls `deps.onPortAdmin` → the link goes down (`err-disabled:a`). Dynamic secure
     rows of the port are removed on link-down; sticky and configured rows stay.
4. A MAC already secure on another port of the same VLAN arriving here is also a violation (IOS behaviour).
5. **Recovery by hand:** `shutdown` clears `errDisabled` (new in `setPortAdmin`); `no shutdown` brings the port up;
   row `status:'secure-up'`.
6. **Automatic recovery:** `errdisable recovery cause psecure-violation` and `errdisable recovery interval 30`.
   At err-disable time eth-switch arms `errdisable:FastEthernet0/1` (30 s, **periodic** by the §4.2 rule) if the
   cause is enabled; on expiry → `Action errRecover {port, cause}` → portState `err-recovered` → link up. If PC-X is
   still there, its gratuitous ARP at link-up violates again (a faithful cycle). Because the timer is periodic,
   `runToIdle` does not wait for the cycle (it returns once the port is err-disabled), so a lab clone of a world with
   recovery configured settles far below its event cap; tests of recovery use `runFor`. stp does the same for
   `bpduguard`, etherchannel for `channel-misconfig`. Default interval 300 s.
7. **Grading.** err-disabled state is runtime state a topology file cannot carry. The lab-check clone re-applies it:
   for every port with `errDisabled` set in the live world, `injectFault(0, {kind:'err-disable', target:{device,
   port}, params:{cause}})` before settling — the same technique the clone uses for cut cables (lab-checks.ts:365-393).

### 3.9 NAT: static, dynamic and PAT, with the provenance of every rewritten field

Setup: PC1 192.168.1.10 and PC2 192.168.1.11 — R1 Gi0/0 192.168.1.1 (`ip nat inside`) — R1 Gi0/1 203.0.113.1/24
(`ip nat outside`) — SRV 203.0.113.10.

**Hooks (ipv4 side).** ipv4 learns `ip nat inside|outside` per interface from its own config deltas. With no such
line anywhere the forwarding path is identical to P1.

- A packet arriving on an outside port → `request nat {kind:'nat.inbound', pdu, inPort}` before the for-me test; nat
  answers `request ipv4 {kind:'ipv4.resume', pdu, inPort}` (translated or not), and ipv4 continues at the for-me
  test (a resumed packet never goes to nat again).
- A forwarded packet whose input port is inside and whose egress is outside → after the TTL decrement,
  `request nat {kind:'nat.outbound', pdu, inPort, iface, nextHop, cause}`; nat answers `request arp {kind:'arp.sendVia',
  pdu, nextHop, iface, cause}` or a drop.

**Inbound match rule** (nat, binding). A packet arriving on an outside port matches a row only as follows; anything
else is left untranslated and resumes at the for-me test:

- *Address-only rows* (static, dynamic; proto `any`): `ipv4.dst = insideGlobal`.
- *Overload and port rows* (udp/tcp): proto equal, `ipv4.dst = insideGlobal`, dst port = `insideGlobalPort`,
  **and** `ipv4.src = outsideGlobal` and src port = `outsideGlobalPort` (address- and port-dependent filtering,
  stricter than RFC 4787 REQ-8's minimum).
- *ICMP query rows* (overload, proto icmp): only **reply** types match (0 echo reply; [S9] the ICMP errors of step 5),
  with `ipv4.dst = insideGlobal`, `icmpv4.id = insideGlobalPort` and `ipv4.src = outsideGlobal`. An inbound echo
  **request** never matches a query row (RFC 5508 §3): SRV's own ping to 203.0.113.1 with id 1 while PC1's row
  `icmp|203.0.113.1|1` is alive reaches R1 itself, and R1 answers.

**Static.** `ip nat inside source static 192.168.1.10 203.0.113.5`.

1. Config: nat writes a `nat` row `{proto:'any', insideLocal:'192.168.1.10', insideGlobal:'203.0.113.5',
   kind:'static', rule:<line>}` and requests `ipv4.virtual add {iface: each outside port, address:'203.0.113.5',
   mac: that port's MAC, local:false, owner:'nat'}` so R1 answers ARP for .5.
2. PC1 → SRV echo request at R1: routed out Gi0/1; `TtlDecrement 128→127` (cause the route); `nat.outbound` →
   `mutate('ipv4.src', '203.0.113.5', 'NatTranslate', 'ip nat inside source static 192.168.1.10 203.0.113.5')` →
   derived `ChecksumRecompute ipv4.checksum` (icmpv4 has no pseudo-header; udp/tcp would also record their checksum,
   pdu/codecs outerInputs) → `arp.sendVia` → `MacRewrite` dst, src → `FcsRecompute`.
3. SRV's reply to .5 arrives on Gi0/1 → `nat.inbound`: `mutate('ipv4.dst', '192.168.1.10', 'NatTranslate', <rule>)` →
   `ipv4.resume` → forwarded to Gi0/0 (TTL, ARP, MAC rewrite).

**Dynamic pool.** `access-list 1 permit 192.168.1.0 0.0.0.255`, `ip nat pool P 203.0.113.20 203.0.113.29 netmask
255.255.255.0`, `ip nat inside source list 1 pool P`.

1. PC1's first outbound packet: ACL 1 permits the source (core/acl.ts) → lowest free pool address .20 → row
   `{proto:'any', insideLocal:'192.168.1.10', insideGlobal:'203.0.113.20', kind:'dynamic', rule, expiresAt: now +
   86 400 s}`, `ipv4.virtual add` for .20, then the `ipv4.src` rewrite as above.
2. An eleventh inside host with ten pool addresses in use → drop `nat-exhausted`, detail `pool P has no free address`.
3. A source the ACL denies (or that matches no rule) leaves untranslated.

**PAT on the interface.** `ip nat inside source list 1 interface GigabitEthernet0/1 overload`. PC1 and PC2 both ping
SRV with ICMP id 1 at the same time.

1. PC1's request: the inside global address is Gi0/1's own 203.0.113.1; key `(icmp, 203.0.113.1, 1)` is free → keep
   id 1. Row `{proto:'icmp', insideLocal:'192.168.1.10', insideLocalPort:1, insideGlobal:'203.0.113.1',
   insideGlobalPort:1, outsideLocal:'203.0.113.10', outsideGlobal:'203.0.113.10', kind:'overload', rule,
   expiresAt: now + 60 s}`. Mutations: `ipv4.src` only.
2. PC2's request: `(icmp, 203.0.113.1, 1)` is taken → walk upward → id 2. Mutations (each `mutate` re-encodes out to
   the Ethernet layer, so each records its derived checksum and then `FcsRecompute`, as in §3.4): `NatTranslate
   icmpv4.id 1→2`, `ChecksumRecompute icmpv4.checksum`, `FcsRecompute`, `NatTranslate ipv4.src`,
   `ChecksumRecompute ipv4.checksum`, `FcsRecompute`; then `MacRewrite` ×2, each with its `FcsRecompute`. The nat
   owner derives this list in `nat.pat.test.ts` from real calls; the acceptance test pins the observed sequence.
3. SRV's reply to 203.0.113.1 id 2 → `nat.inbound` runs **before** the for-me test (203.0.113.1 is R1's own address)
   → match → `ipv4.dst → 192.168.1.11`, `icmpv4.id 2→1` → `ipv4.resume` → forwarded to PC2.
4. **Keying** (architect ruling, 2026-09-23, W3 review finding #9): a row is keyed by
   `(proto, insideGlobal, insideGlobalPort)` only — the inside socket and the inside global socket, never the
   destination. One inside socket therefore keeps ONE inside-global port for every destination it talks to, which is
   what `show ip nat translations` shows in the course and what the NAT lesson teaches ("endpoint-independent
   mapping", RFC 4787 REQ-1). The alternative — keying by destination as well — would give the same inside socket a
   different inside-global port per destination, which is address-and-port-dependent mapping: closer to some real
   firewalls, but it breaks the lesson's table and the §3.9 walk-through. The NAT lesson (§11) states the chosen
   behaviour in words; the inbound match rule below is what keeps it safe.
5. **Port allocation** (deterministic, no rng): keep the inside port if `(proto, insideGlobal, port)` is free;
   otherwise walk upward inside the same class (1–511, 512–1023, 1024–65535), wrapping within the class, skipping
   ports held by local sockets (the `sockets` table); ICMP ids use the class 0–65535. Pool addresses: lowest free.
   Timeouts: ICMP 60 s, UDP 300 s, TCP 86 400 s while open and **60 s after a FIN or RST has been seen in both
   directions or an RST in either** (`tcp-finrst`), address-only 86 400 s; `nat-sweep` (60 s, periodic) is armed
   only while a dynamic row exists and cancelled when none is left.
6. **ICMP errors** [SHOULD S9], both directions (RFC 5508 §4); the outer header carries no port or id, so the lookup
   uses the **embedded** packet with its roles reversed:
   - *Inbound* (an error from beyond R1 about a packet R1 translated outbound, e.g. time-exceeded for traceroute):
     find `natKey(embedded proto, embedded ipv4.src, embedded srcPort | icmp id)` and require embedded
     `ipv4.dst = outsideGlobal`; translate outer `ipv4.dst` global → local, embedded `ipv4[i].src` and
     `udp[j].srcPort` / `tcp[j].srcPort` / `icmpv4[k].id` global → local, with the `proto[i].field` paths and the
     quoted-layer patching of §2.3. Traceroute through PAT (udp or icmp probes) is then matched back at the host.
   - *Outbound* (an error from an inside host about an inbound flow, e.g. a statically translated server answering
     port-unreachable): outer `ipv4.src` local → global, and embedded `ipv4[i].dst` plus `udp[j].dstPort` /
     `tcp[j].dstPort` / `icmpv4[k].id` local → global, so the outside host can match the error and no inside address
     leaks.

The rewritten fields and their causes, exhaustively:

| Case | Direction | Fields (NatTranslate) | Derived records |
|---|---|---|---|
| static / dynamic | out | `ipv4.src` | after it: `ipv4.checksum`, the transport checksum when udp/tcp (pseudo-header), then `ethernet.fcs` |
| static / dynamic | in | `ipv4.dst` | same |
| PAT, id/port kept | out / in | `ipv4.src` / `ipv4.dst` | same |
| PAT, id/port moved | out | `icmpv4.id` or `udp.srcPort` / `tcp.srcPort`, then `ipv4.src` | after each NatTranslate: its checksum(s) (`icmpv4.checksum` / `udp.checksum` / `tcp.checksum`; `ipv4.checksum` plus the transport checksum for the address) and then `ethernet.fcs` |
| PAT, id/port moved | in | `icmpv4.id` or `udp.dstPort` / `tcp.dstPort`, then `ipv4.dst` | same |
| static port forward [S9] | in / out | `ipv4.dst` + `tcp.dstPort` / `ipv4.src` + `tcp.srcPort` | same |
| ICMP error [S9] | in | outer `ipv4.dst`; embedded `ipv4[i].src`, `udp[j].srcPort` / `tcp[j].srcPort` or `icmpv4[k].id` | embedded checksums patched per §2.3 (ipv4 header, icmp, udp incl. pseudo-header; never tcp), then outer `icmpv4.checksum`, `ipv4.checksum`, `ethernet.fcs` |
| ICMP error [S9] | out | outer `ipv4.src`; embedded `ipv4[i].dst`, `udp[j].dstPort` / `tcp[j].dstPort` or `icmpv4[k].id` | same |

Every cause is the configuration line of the rule (`NatRow.rule`), e.g.
`ip nat inside source list 1 interface GigabitEthernet0/1 overload`.

### 3.10 HSRP failover [SHOULD S2]

Setup: R1 Gi0/0 192.168.1.2, R2 Gi0/0 192.168.1.3 on one LAN through SW1. Both: `standby version 2`,
`standby 1 ip 192.168.1.1`; R1 also `standby 1 priority 110`, `standby 1 preempt`. PCs use gateway .1.

1. **Start.** On the `standby 1 ip` line with Gi0/0 up and addressed: hsrp opens `udp.open {owner:'hsrp',
   socket:'hsrp#GigabitEthernet0/0', family:4, localPort:1985, iface}`, requests `ipv4.group join 224.0.0.102`,
   writes row `state:'listen'` and arms `listen:Gi0/0:1` (hold time 10 s, non-periodic).
2. **Speak.** Hearing no Active or Standby for the hold time → `speak`: hellos every 3 s (`hello:Gi0/0:1`, periodic)
   for another hold time (`speak:Gi0/0:1`, non-periodic). Hello: `[ethernet {dst 01:00:5e:00:00:66, src interface MAC
   (virtual MAC once Active)}, ipv4 {src .2, dst 224.0.0.102, ttl 1, protocol 17}, udp {1985 → 1985}, hsrp {version
   2, opCode 0, state, helloMs, holdMs, priority, group 1, virtualIp, identifier}]`, built by hsrp and sent with
   `Action send` on Gi0/0 so hsrp controls the Ethernet source; `meta {tag:'hsrp-hello', background:true}`. Hosts drop
   the hellos at step 10b (group not joined, background drop).
3. **Election.** Highest priority, then highest interface address. At the end of speak the best speaker with no
   Standby present becomes `standby`, and a Standby with no Active becomes `active`. R1 (110) ends `active`, R2
   `standby`. Each change: tableWrite and `ctx.transition('standby', …, {machine:'hsrp', subject:'GigabitEthernet0/0 group 1'})`.
4. **Active.** R1 requests `ipv4.virtual add {iface:'GigabitEthernet0/0', address:'192.168.1.1',
   mac:'00:00:0c:9f:f0:01', local:true, owner:'hsrp'}` → ipv4 writes `virtual4` and sends a gratuitous ARP
   (sha and Ethernet source = the virtual MAC) → SW1 learns the virtual MAC on R1's port. PCs' ARP for .1 is answered
   by R1 only (R2 is not active) with the virtual MAC.
5. **Failover.** R1 powers off at T. R2 tracks R1's hellos with `active-hold:Gi0/0:1` (periodic flag, re-armed on each
   hello, 10 s). It fires between T + 7 s and T + 10 s → R2 `active` → `ipv4.virtual add` + gratuitous ARP from the
   virtual MAC → SW1's CAM moves the virtual MAC (debug `… moved from … to …`) → PC traffic resumes with no ARP change
   on the PCs.
6. **Preempt.** R1 returns: listen, then it hears R2 Active with priority 100 < 110 and preempt is set → sends a coup
   (`opCode 1`) → becomes `active`; R2 receives the coup → `speak` → `standby`. Without preempt R1 stays `standby`.
7. v1: group ≤ 255, `224.0.0.2`, virtual MAC `00:00:0c:07:ac:01`, times in seconds on the wire, eight zero bytes of
   authentication data.

### 3.11 DHCPv6: stateless and stateful

Setup: R1 Gi0/0 `ipv6 address 2001:db8:1::1/64`, `ipv6 unicast-routing`; PC1 `ipv6 address autoconfig`.

**Stateless.** R1: `ipv6 dhcp pool STATELESS` / `dns-server 2001:db8:1::53` / `domain-name lab.nf`;
Gi0/0: `ipv6 dhcp server STATELESS`, `ipv6 nd other-config-flag`.

1. ipv6 on R1 joins `ff02::1:2` on Gi0/0 (it reads `ipv6 dhcp server|relay` itself; groups6 updated). nd sets O = 1 in
   RAs (the RA bytes change only on interfaces with the flag).
2. PC1 forms its SLAAC address as in P1. nd already reports the RA flags to ipv6 (`ipv6.raLearned {managed, other}`,
   process.ts); ipv6 forwards them as `event {to:'dhcpv6-client', ev:{kind:'ipv6.ra', iface, router, managed,
   other}}` whenever they change on an interface with `ipv6 address autoconfig`.
3. dhcpv6-client: after a delay drawn from `ctx.stream('sol-delay:<iface>')` (0–1 s), `udp.send` from the link-local
   address port 546 to `ff02::1:2`:547 an INFORMATION-REQUEST `{msgType 11, transactionId from
   ctx.stream('xid6:<iface>') (24 bits), clientDuid (DUID-LL from the MAC), oro '23,24', elapsedTimeCs 0}`, tag
   `dhcpv6-inforeq`. Retransmit `sol:<iface>` (1 s doubling to 120 s, non-periodic, at most 5 tries, then a periodic
   `dhcpv6-restart:<iface>` pause of 60 s).
4. dhcpv6-server answers REPLY `{msgType 7, dnsServers, domainList}` unicast to the client's link-local. The client
   sends `dhcp.lease {family: 6, op:'bound', dnsServers, domainName}` to dns-client, which keeps it beside (never in
   place of) the DHCPv4 servers of the same interface (§2.5 consumer rule); `info-refresh:<iface>` (86 400 s,
   periodic).

**Stateful.** Pool `address prefix 2001:db8:1::/64 lifetime 86400 3600`; Gi0/0 `ipv6 nd managed-config-flag`.

1. RA with M = 1 → SOLICIT (msgType 1) → ADVERTISE (2, `iaAddress` = the lowest free address of the prefix starting
   at `<prefix>::2`, skipping the server's own addresses and bound ones; an existing binding for the same DUID and
   IAID wins) → REQUEST (3) → REPLY (7). The server writes a `dhcpv6-bindings` row
   `{address, duid, iaid, pool, preferredUntil, expiresAt}` and arms `binding6:<key>` (periodic).
2. The client sends `request ipv6 {kind:'ipv6.lease', op:'bind', iface, address, prefixLen:128, preferredUntil,
   validUntil, server}` → ipv6 adds `{origin:'dhcpv6', state:'tentative'}` → DAD → preferred. T1/T2/valid timers
   (`t1:*`, `t2:*`, `valid:*`) are periodic, like DHCPv4.
3. A router interface as client: `ipv6 address dhcp` on the interface does the same exchange without waiting for an RA.
4. Relay [SHOULD S8]: `ipv6 dhcp relay destination 2001:db8:9::5` on the client-side interface → RELAY-FORW (12)
   wrapping the client message, `linkAddress` = a global address of that interface, unicast to the server; RELAY-REPL
   (13) back, unwrapped and sent to the client's link-local.

### 3.12 A lightweight AP joins a controller; client data; roaming

Setup: WLC1 (NF-WLC-9800, `wireless-controller`) GigabitEthernet0/1 ↔ SW1 Gi0/1 (SW1: `switchport mode trunk`;
the controller does not negotiate). LAP1 (NF-AP-1832, `lightweight-ap`) on SW1 Fa0/2 (access VLAN 99, the AP
management VLAN). R1 routes; DHCP pools for VLAN 99 (APs) and VLAN 20 (clients). WLC1 configuration, written by the
controller panel's Interfaces and WLANs pages (§5.3, §5.5):

```
wlc-interface management
 vlan 99
 address 192.168.99.5 255.255.255.0
 gateway 192.168.99.1
wlc-interface STAFF-IF
 vlan 20
 address 192.168.20.5 255.255.255.0
 gateway 192.168.20.1
 dhcp-server 192.168.20.1
wlan 1 STAFF LabNet
 security wpa2-psk
 passphrase …
 interface STAFF-IF
 no shutdown
```

The CLI handler of `address` under a `wlc-interface` maintains the SVI that carries it (`interface Vlan<v>` /
`ip address <a> <m>` / `no shutdown`, like `channel-group` maintains its Port-channel); the management interface's
`gateway` becomes `ip default-gateway`. The distribution ports are intrinsic trunks (`CONTROLLER_PORT_SWITCHPORT`,
no lines, no DTP, no spanning tree); only the active one (the lowest-numbered up port) forwards, the others are
backups (§3.0).

1. **Address.** In the P2 profile LAP1 booted with `capwap enable`, `interface Vlan1` / `ip address dhcp` /
   `no shutdown` replayed → dhcp-client obtains 192.168.99.20 (the access port is in VLAN 99; the AP does not tag).
2. **Discovery.** capwap-wtp starts only when `capwap enable` is in the running config **and** its management
   interface has an address (an autonomous NF-AP-1832 of a P1 file, even with a static address, stays silent):
   `udp.open 'capwap-wtp#ctl'` on local port 5246, then Discovery Request (`capwap {messageType 1, wtpName}`) to
   each `capwap controller <ip>` line, else to the subnet broadcast. Retry `discovery` every 10 s (periodic, so an
   unanswered AP does not hold `runToIdle`). Row `capwap {controller, state:'discovery'}`.
3. **Join** (RFC 5415 state order). capwap-ac (listening on 5246/5247 of its management interface) answers Discovery
   Response (2) → the AP enters `dtls`: the DTLS session is **simulated** — one `ctx.transition` with cause
   `secure session established (simulated)`, no records on the wire — and every later control message carries
   `meta.protected` → Join Request/Response (3/4, result 0) → `configure`: Configuration Status Request/Response
   (5/6) → `data-check`: Change State Event Request/Response (11/12) → `run`. In `run` capwap-ac sends one IEEE 802.11
   WLAN Configuration Request (3398913) per WLAN with `wlans` = `1:LabNet:wpa2-psk:20:<keyTag>` — the VLAN is the
   WLAN interface's VLAN, the key tag is `fnv1a32(ssid\0passphrase)` (the P0.5 tag), never the passphrase — and the
   AP answers 3398914. Each state change: rows on both sides (`capwap`, `capwap-aps`),
   `ctx.transition('capwap', …, {machine:'capwap-wtp', subject:'controller 192.168.99.5'})`. Join retransmits `join`
   (non-periodic, 3 tries). Echo Request/Response (13/14) every 30 s (`echo`, periodic, `meta.background`); three
   missed echoes → back to discovery.
4. **Radio profile.** capwap-wtp issues `Action radio-profile {port:'Wlan0', bss:[{index:0, ssid:'LabNet',
   security:'wpa2-psk', keyTag, vlan:20, switching:'central', wlanId:1}]}` (and the same for Wlan1). The runtime
   stores the profile; `radioSettings(port)` = local lines overlaid by the profile (one renderer, used by the air
   medium and by wlan-ap through `ctx.radioSettings`); `onPortPhyConfig` → the BSS starts.
5. **Association (at the AP) and the station report.** Association and the 4-way handshake are unchanged (P1 §3.6;
   local MAC, D17), except that wlan-ap compares EAPOL tags against the pushed `keyTag`. On every grant change of a
   central BSS (authorized, disassociated, deauthenticated, aged out) wlan-ap sends capwap-wtp a `wlan.grant` event
   (§2.5), and capwap-wtp sends a WTP Event Request (9) whose
   Vendor Specific Payload (`NF_OUI`) carries `stations` = `add:<station>:<bssid>:<wlanId>` or `del:…`; capwap-ac
   answers WTP Event Response (10) and **writes or deletes the `wlan-clients` row** (the only writer, §2.6), taking
   `ssid`, `vlan` and `iface` from its WLAN and `state` from the report. Because the report is sent when the grant is
   made and the AP forwards no data for a station before its grant, the row exists before the first frame for the
   station can reach Capwap0 (`accept.p2.wlc` asserts it before the first downlink frame).
6. **Uplink data.** The laptop's data frame reaches the AP radio; for a `central` BSS the air hands the 802.11 frame
   over unchanged (`frameArrival.central`, admit still checks authorization). Demux `{layer:'dot11', frame:'data'}`
   → capwap-wtp: `ctx.rewrap(pdu, {strip:1, push:[ipv4 {src AP, dst WLC, protocol 17}, udp {5247 → 5247}, capwap
   {tbit:true, radioId}, dot11 {same header, no FCS}]}, 'controller tunnel')` → `request ipv4 {kind:'ipv4.send'}` →
   `arp.sendVia` adds Ethernet. Same PduId; `PduSummary.tunnel = 'capwap'`.
7. **At the controller.** capwap-ac opened its data socket with `udp.open {…, localPort: 5247, tunnel: true}`
   (§2.4), so udp delivers the datagram as `sock.datagram` **without consuming it** and capwap-ac owns the PDU from
   there. capwap-ac: `ctx.rewrap(pdu, {strip:6, push:[ethernet {dst: addr3, src: addr2}, dot1q {vid: 20}]},
   'controller bridging')` (the VLAN of the WLAN's interface) → `Action ingress {port:'Capwap0', pdu}`. Capwap0 is an
   auto `wlan-tunnel` port that carries every VLAN tagged, so eth-switch classifies VLAN 20, learns the station on
   Capwap0 and forwards out the active distribution port GigabitEthernet0/1 (trunk, tag kept). No `pduConsumed`
   appears for this PduId before the gateway (or the station, downlink) consumes it.
8. **Downlink.** eth-switch forwards a frame for the station to Capwap0 → owner `capwap-ac.onEgress`: VLAN from the
   tag, station → AP from its `wlan-clients` row (step 5); no row → drop `other`, detail `no access point serves
   <station>` → pop, wrap `[ipv4, udp 5247, capwap {tbit}, dot11 {fromDs, addr1 station, addr2 BSSID, addr3 source}]`
   → `ipv4.send`. Group frames are cloned per AP in device-id order. At the AP, capwap-wtp (its data socket is also a
   `tunnel` socket) strips to the dot11 layer (FCS restored) and `send`s on the radio; the air accepts a pre-built
   from-DS data frame for a central BSS.
   - *Client DHCP.* The controller bridges client DHCP into the interface's VLAN; the interface's `dhcp-server` is
     stored, shown and gradeable but not used to proxy (deviation (15), §12.2). A DHCP server or relay must serve
     that VLAN, as in the lab.
9. **MTU.** There is no IPv4 fragmentation. capwap-ac rewrites the MSS option of TCP SYNs crossing Capwap0 to 1360
   (`mutate('tcp.mss', 1360, 'Other', 'controller MSS adjustment')`). A tunnelled frame that is still too large is
   dropped as a giant by the next hop with detail `too large for the controller tunnel`.
10. **Roaming [COULD C5].** Two LAPs, same WLAN. In `reassess`, when the current association's RSSI falls below
    `RF.ROAM_TRIGGER_RSSI_MDB` (−75 dBm) and another BSS of the same SSID is at least `RF.ROAM_DELTA_MDB` (8 dB)
    better, the medium sends the station `roam-candidate` once per crossing. wlan-client authenticates with the new
    BSSID (the existing `sta-state authenticating` with another BSSID already tears the old association down,
    air.ts:1054-1058), sends a reassociation request and repeats the 4-way handshake; a hold-off `mediumTimer`
    prevents ping-pong inside the hysteresis band. The new AP's station report (step 5) updates the `wlan-clients`
    row's AP; the old AP's `del` report for that station is ignored when the row already names another AP.

### 3.13 Time travel: scrub back and forward [SHOULD S1]

1. **Record.** The live Simulation journals every mutating facade call at depth 0 as `{at: position(), op, traceHead}`
   (§2.13 rules). The worker also builds a lane index from every drained event (before the batch cap): `(t, cursor,
   lane)` in typed arrays; `laneOf` maps linkState/portState → `link`, `debug.fsm.machine` → its lane,
   tableWrite/tableExpire by table (stp → `stp`, etherchannel → `etherchannel`, vlans/dtp → `vlan`, hsrp → `fhrp`,
   rib/rib6 → `routing`, nat → `nat`, dhcp-bindings/dhcpv6-bindings → `dhcp`, capwap* / dot11-assoc → `wireless`,
   port-security → `security`), configChange → `config`, drop → `drops`.
2. **Parked replayers.** The worker keeps `replayers` (default 3) `Replay`s built from the journal with trace
   capacity 0, no captures and a small PDU registry, each advanced (in chunks of about 500 events per worker tick)
   toward `head − lagsEvents[i]`.
3. **Scrub back.** The learner drags the scrubber to t. `seek({time: t})`: the parked replayer with the largest
   position ≤ target is taken out of its slot (a target older than every parked replayer takes a fresh replay from
   the origin; a target inside the current cursor replay's future just advances the cursor replay) and advances in
   cooperative chunks (a newer seek cancels an older one) with
   `runUntil(e.at.now, {maxEvents: e.at.dispatched − dispatched})` between journal entries, asserting the ring head
   after each entry (`ReplayDivergenceError` on a mismatch). It becomes the cursor replay; the batcher and clock point
   at it; batches carry `review`; the canvas, tables (for example the STP rows before the cut) and packets show that
   instant. The live world is paused. Every mutating API call rejects with `REPLAY_READ_ONLY_MESSAGE`; `evaluateLab`
   keeps reading the live world; `traceQuery` answers from the live ring (cursors are aligned by the ring's start
   head).
4. **Scrub forward.** The cursor replay advances forward only; `play`/`step` in review drive it up to the live
   position, where review ends by itself (`review: null` and a full live snapshot). A backward seek inside review
   takes another parked replayer (or the origin) as in step 3; the replay it replaces is handled as in step 5.
5. **Lifecycle (binding).** A replayer is in exactly one of: *parked* in slot i (target `head − lagsEvents[i]`),
   *cursor* (serving review), or *discarded*. Replayers only move forward.
   - A parked replayer behind its target advances in chunks; one at or ahead of its target **idles** until the target
     passes it (live events move targets forward).
   - When review ends (by `leaveReview` or by reaching live), the cursor replay is **re-parked in the slot it was
     taken from** (it idles there until its target passes it). A cursor replay that came from the origin is re-parked
     in the empty slot with the largest lag, or discarded when no slot is empty.
   - When a newer seek replaces the cursor replay, the old cursor replay is re-parked by the same rule.
   - An empty slot is refilled lazily from the origin in background chunks, only while no review is active. Nothing
     is rebuilt eagerly.
   - `worker.time-machine.test.ts` asserts this lifecycle (the slot and position of each replayer after seek, leave
     and re-seek).
6. **Budget and cost.** `DEFAULT_TIME_TRAVEL_BUDGET`; "history off" drops the replayers (seeks replay from the
   origin). Seek cost is asserted as a count of dispatched events, not wall time, and exactly: a seek dispatches
   `target.dispatched − p` events, where p is the position of the replayer it starts from (the nearest parked
   position ≤ target, the cursor replay's position when the target is ahead of it, or 0 for the origin). In steady
   state (every slot at its target) that is at most the largest lag gap for targets inside the parked window and
   `target.dispatched` for older targets.

---

## 4. Determinism, timers and silence

### 4.1 RNG stream registry (additions to P1 §5.1; never add draws to an existing stream)

| Stream | Owner | Draws |
|---|---|---|
| `process:dhcpv6-client` → `xid6:<iface>` | dhcpv6-client | 1 per exchange (24-bit transaction id), cached sub-stream |
| `process:dhcpv6-client` → `sol-delay:<iface>` | dhcpv6-client | 1 per initial SOLICIT / INFORMATION-REQUEST delay (0–1 s) |

**Nothing else in P2 draws.** vlan, dtp, stp, etherchannel, port security, nat, hsrp, capwap-wtp, capwap-ac and
radius use no randomness:

- Tie-breaks use bridge ids from the device base MAC (D8 stable), port priority plus `ordinal`, and canonical port and
  VLAN order.
- NAT allocates ports and pool addresses by the fixed walk of §3.9.
- CAPWAP and HSRP use fixed ports on both ends, so the udp ephemeral base is never drawn on their paths.
- RADIUS authenticators and EAP challenges [S11] are FNV-1a derived from per-process counters.
- The load-balance hash (§3.7) and the ECMP hash [S6] are fixed integer functions: ECMP
  `h = u32(src) ^ u32(dst); h ^= h >>> 16; i = h % n`.

Control frames still consume the 5 draws of `link:<id>` per frame (P0 invariant). In P2-profile worlds BPDUs therefore
shift the loss pattern of data frames on lossy links; it stays deterministic, and P1-profile worlds send no control
frames by default.

### 4.2 Timers

Periodic = `periodic: true` (D10): `runToIdle` does not wait for it. Every re-armed failure detector is periodic by
this definition even though it is re-armed per PDU (otherwise `runToIdle` never returns); tests of the failures such
detectors catch use `runFor`.

| Daemon | Periodic | Never periodic (runToIdle waits) |
|---|---|---|
| eth-switch | `cam-sweep` (unchanged), `errdisable:<port>` (psecure recovery, only when configured; periodic so a violate → recover cycle never holds `runToIdle`) | — |
| dtp | `dtp-hello:<port>` (30 s), `dtp-age:<port>` (re-armed, 300 s) | — |
| stp | `hello:<vlan>` (2 s, one per instance, armed in ascending VLAN order), `age:<vlan>:<port>` (re-armed per BPDU: 802.1D `maxAge − messageAge`, 802.1w 3 × hello), `tcn:<vlan>` (TCN retransmit every hello until acknowledged, no try limit), `errdisable:<port>` (bpduguard recovery) | `fwd:<vlan>:<port>` (forward delay), `tc:<vlan>` (root TC window 35 s), `tcwhile:<vlan>:<port>` (4 s), `migrate:<vlan>:<port>` (3 s, rapid ports) |
| etherchannel | `lacp-tx:<port>` (30 s), `lacp-age:<port>` (re-armed, 90 s), `errdisable:<port>` | `lacp-fast:<port>` (1 s, ≤ 3), `lacp-wait:<port>` (3 s) |
| nat | `nat-sweep` (60 s, only while a dynamic row exists) | — |
| hsrp [S2] | `hello:<if>:<g>` (3 s), `active-hold:<if>:<g>`, `standby-hold:<if>:<g>` (re-armed per hello) | `listen:<if>:<g>`, `speak:<if>:<g>` (hold time each), `preempt-delay:<if>:<g>` |
| dhcpv6-client | `t1:*`, `t2:*`, `valid:*`, `info-refresh:*`, `dhcpv6-restart:*` (60 s pause after 5 unanswered tries) | `sol:<iface>` (retransmit 1 s doubling, ≤ 5) |
| dhcpv6-server | `binding6:<key>` | — |
| capwap-wtp | `discovery` (10 s), `echo` (30 s) | `join` (≤ 3) |
| capwap-ac | `ap-age:<mac>` (re-armed per echo, 90 s) | — |
| wlan (roaming C5) | — | roam hold-off `mediumTimer` |

Consequences:

- `runToIdle` in a P2-profile switched world returns after spanning tree converged (≤ boot + 30 s forward delay +
  35 s TC window).
- HSRP: `runToIdle` waits for the first election (listen + speak ≈ 20 s).
- An unanswered lightweight AP does not hold `runToIdle` (discovery is periodic).
- An err-disabled port with automatic recovery configured does not hold `runToIdle`, even with the offender still
  attached (`accept.p2.port-security` checks that `runToIdle` returns far below its cap).
- The lab-check clone therefore settles spanning tree, DTP, LACP and HSRP before it pings.

### 4.3 Silence: what turns each new daemon on

| Daemon | Sends nothing unless | P1 profile, default config | P2 profile, default config |
|---|---|---|---|
| `vlan` | never sends | silent | silent |
| `dtp` | a port in `trunk` mode (without `nonegotiate`) or `dynamic desirable`; an `auto` or `access` port only answers received DTP (an access port also sends one frame when it becomes access facing a DTP-speaking neighbour) | all ports `dynamic auto` → silent | same → silent |
| `stp` | `spanning-tree mode <m>` is in the running config AND a VLAN instance has an up STP port | no line → silent | line replayed at boot on managed switches → BPDUs every 2 s per VLAN on designated ports |
| `etherchannel` | `channel-group N mode active` or `desirable` on an up port (`passive`/`auto` answer only; `on` never sends) | silent | silent |
| eth-switch port security | never sends (writes config lines only when sticky is configured) | silent | silent |
| `nat` | never originates | silent | silent |
| `hsrp` [S2] | `standby [g] ip …` on an up interface that has an address | silent | silent |
| `dhcpv6-client` | `ipv6 address dhcp`, or an RA with M or O on an `ipv6 address autoconfig` interface | RAs carry M = O = 0 → silent | same → silent |
| `dhcpv6-server` | answers only | silent | silent |
| `capwap-wtp` | `capwap enable` is in the running config **and** the AP has an IPv4 address on its management interface | no `capwap enable` → silent, even with a static address (an autonomous P1 AP) | replayed `capwap enable` and `ip address dhcp` on Vlan1 → DHCP, then discovery |
| `capwap-ac` | answers only; opens its sockets when the management interface has an address (NF-WLC-9800 exists in no P1 file) | — | silent |
| `radius-server` [S11] | answers only; opens UDP 1812 only when a RADIUS client line is configured on the server | silent, no `sockets` row | silent |
| `vtp` [C1] | `vtp domain` set, mode server or client, and a trunk up | silent | silent |

New daemons emit no debug or log line at boot when unconfigured (the P0 golden tolerates added debug lines, but P2
adds none, and `accept.p2.p1-digests` tolerates none), open no socket unless configured, and are never listed in a
model before their factory is registered (so no "Process X is not available" log appears, §0 rule 3). No new daemon
writes a table row at boot in the P1 profile:

- `vlans` rows exist only for configured VLANs;
- `dtp` rows exist from link-up for `trunk` (negotiating) and `dynamic-desirable` ports, and for a `dynamic-auto`
  or `access` port **only after DTP was received on it** — every port defaults to `dynamic auto`, so an untouched
  switch has no `dtp` rows in either profile;
- `stp` rows exist only while spanning tree runs, which needs the `spanning-tree mode` line;
- `etherchannel`, `port-security`, `nat`, `dhcpv6-bindings` and wireless rows exist only after their lines.

`accept.p2.silence` (§10) guards all of this.

### 4.4 What a switch does by default in P2 (decision)

A freshly placed NF-C2960 (any managed switch):

| | P1 profile (every P0–P1 file, template and CCNA 1 lab) | P2 profile (new worlds, CCNA 2 labs) |
|---|---|---|
| Port admin mode | `dynamic auto` (oper access) | same |
| VLANs | 1 (and 1002–1005 reserved) | same |
| Management SVI | `Vlan1`, administratively down | same |
| DTP frames | none | none (auto and access ports never initiate) |
| Spanning tree | off; BPDUs from other switches are bridged | PVST+ (`spanning-tree mode pvst` replayed), priority 32768 + VLAN, BPDUs every 2 s on designated ports including host ports (hosts discard them at pipeline step 10b, as background drops) |
| Host port to forwarding | at link-up | 30 s after link-up (listening 15 s + learning 15 s) unless PortFast |
| Loop in the topology | storms until the queue cap (D23) | blocked by spanning tree |
| Multilayer switch forwarding | on (as in P1) | off until `ip routing` (`no ip routing` replayed) |

Why: new work must behave like the devices CCNA 2 describes (spanning tree on, the 30 s forward delay visible,
routing off on a multilayer switch until enabled), and old work must not change its traffic by a byte. The profile
achieves both without migrating any existing golden; the P1-profile digest golden records the few justified trace
changes (§9.3). CCNA 1 lessons open P1 worlds (D2), so their "place and ping" steps still work at once. The CCNA 2
lessons say plainly that real switches run spanning tree by default and that older NetForge projects keep "classic
defaults" until upgraded (§11).

### 4.5 Integer discipline and fixed orders

- STP times on the wire are 1/256 s units; the daemon works in SimTime ns and converts exactly (15 s ↔ 3840).
- Port-channel cost, the load-balance hash, NAT allocation and the ECMP hash are integer.
- New RF maths [S12] uses only the committed integer log tables (`tenLog10Udb`, `powerSumMdb`); the grep ban on
  `Math.log10|pow|exp` covers `link/rf`, `link/media` and now `protocols/stp*` and `protocols/etherchannel*`.
- Fixed iteration orders: flood targets in `ctx.ports` order with clones allocated before tag normalisation (§3.0);
  STP instances ascending VLAN, ports canonical; bundled members canonical; WLC group-frame fan-out by AP device-id
  ordinal; BSSs of a radio by index; NAT rows insertion order; `L2_PROCESSES` fan-out in PROCESS_ORDER.
- Multi-BSS ids: `bss:<dev>/<port>` for index 0 (unchanged, so every `air:<bss>:<key>` stream label and golden holds),
  `bss:<dev>/<port>#<n>` for n ≥ 1.
- No P2 module keeps module-level mutable state (several simulations share one realm once replayers exist).

---

## 5. Canonical config lines and their consumers

The rules live in `cli/config-rules.ts` (`ConfigLineRule`). GUI panels write exactly these lines. "Identity" is the
number of leading tokens that name the slot (a later line with the same identity replaces the earlier one).

**Rule-table corrections that P2 needs first (W1 cli):**

- The bare `switchport` rule (config-rules.ts:148, identity 1, storeNegation) matches only the one-token line, so
  `switchport` on an already-switched port no longer removes `switchport mode …` lines, and `switchport mode access`
  no longer cancels a stored `no switchport` (config-ast.ts:377). `no switchport` (role flip to routed) removes every
  `switchport …` child explicitly, as IOS does.
- `ip routing` gains the new rule flag **`bothForms`**: `ip routing` and `no ip routing` share one slot and each is
  stored as typed, replacing the other. A P1 world that typed `ip routing` stores it exactly as today (so no saved
  file's running config changes); `no ip routing` is now stored instead of merely removing the line.
- **Completeness rule (D2), as code.** `cli/config-ast.ts` exports:

  ```ts
  /** Slot key of a line under the rule table: context path + the rule's identity tokens (the key the AST already
   *  uses to decide what a later line replaces). */
  export function slotKeyOf(context: readonly (readonly string[])[], line: readonly string[]): string;
  /** The default slots of a device: slot key → the default line, from its default lines D (defaultConfig +
   *  profileConfig), computed once per boot by the runtime. */
  export type DefaultSlots = ReadonlyMap<string, readonly string[]>;
  export function defaultSlotsOf(defaults: ConfigAst): DefaultSlots;
  // ConfigAst.apply(context, line, negate, opts?: { defaults?: DefaultSlots }) — with `defaults`:
  //   (1) a line that would leave a default slot empty (identity-only form of a storeNegation rule, or a `no` form of
  //       an ordinary rule) is stored explicitly instead;
  //   (2) the `no` form of a rule with `negationRestoresDefault` (only `spanning-tree mode`) stores the default line of
  //       that slot, or clears the slot when the slot is not a default slot;
  //   without `defaults` (every existing call site and test) behaviour is exactly today's.
  ```

  The runtime (W2 device) passes the device's `DefaultSlots` to every apply, including the boot replay of D itself
  and of the saved lines. `no spanning-tree extend system-id` is refused by the grammar handler
  (`CLI_MESSAGES.extendSystemIdFixed`).
- `vlan <list>` is a section (mode `config-vlan`) with one section per VLAN in the stored form (`vlan 10,20` stores
  `vlan 10` and `vlan 20`); `name` applies to each VLAN of the list.

### 5.1 Switching

| Context | Line (identity) | Consumer |
|---|---|---|
| global | `vlan <list>` (section, 2); `no vlan <list>` | vlan |
| config-vlan | `name <name>` (1) | vlan |
| interface (switched, Po) | `switchport mode access\|trunk\|dynamic auto\|dynamic desirable` (2) | eth-switch, dtp, stp, etherchannel (compatibility), runtime (autostate) |
| interface | `switchport access vlan <v>` (3); the handler auto-creates a missing VLAN (`CLI_MESSAGES.vlanCreated`) | same |
| interface | `switchport trunk native vlan <v>` (4) | same |
| interface | `switchport trunk allowed vlan <list>\|add <list>\|remove <list>\|except <list>\|all\|none` (4); the handler resolves the keyword forms against the current value and STORES the canonical list (`switchport trunk allowed vlan 1,10,20,30,99`; `all` removes the line) | same |
| interface | `switchport voice vlan <v>` (3) [S4] | eth-switch, stp |
| interface | `switchport nonegotiate` (2; refused in dynamic modes with `CLI_MESSAGES.nonegotiateNeedsStaticMode`) | dtp |
| interface | `switchport port-security` (2); `… maximum <n>` (3); `… violation protect\|restrict\|shutdown` (3); `… mac-address <mac>` (multi); `… mac-address sticky` (4); `… mac-address sticky <mac>` (multi, also written by eth-switch) | eth-switch |
| interface | `spanning-tree portfast [trunk\|disable]` (2; on an operational trunk without `trunk` the line is stored and `CLI_MESSAGES.portfastOnTrunk` is printed, §3.6); `spanning-tree bpduguard enable\|disable` (2); `spanning-tree guard root\|loop\|none` (2); `spanning-tree cost <n>` (2); `spanning-tree port-priority <n>` (2); `spanning-tree vlan <list> cost\|port-priority <n>` (multi) | stp |
| interface | `channel-group <n> mode on\|active\|passive\|desirable\|auto` (1; creates `interface Port-channel<n>`) | etherchannel |
| global | `spanning-tree mode pvst\|rapid-pvst` (2; `negationRestoresDefault`) (`mst` C2); `no spanning-tree mode` restores the device's default: in a P2 world it stores the model default line (`spanning-tree mode <stpDefaultMode>`, e.g. `rapid-pvst` on NF-C9300), in a P1 world it clears the slot (spanning tree off, the P1 default) | stp |
| global | `spanning-tree extend system-id` (2); its `no` form is refused (`CLI_MESSAGES.extendSystemIdFixed`) | stp |
| global | `spanning-tree vlan <list> priority <p>` (multi per VLAN; p a multiple of 4096) | stp |
| global | `spanning-tree vlan <list> root primary\|secondary` — a macro: the handler reads the `stp-bridge` rows and stores `spanning-tree vlan <v> priority <p>`. It compares **configured** priorities: the root's configured priority = its `BridgeIdText` priority minus the VLAN id. primary: 24576 when the root's configured priority is > 24576, else the root's configured priority − 4096 (so a tie with a lower-MAC root is broken); when that would be < 0 the handler refuses with `CLI_MESSAGES.rootPriorityExhausted` and stores nothing. secondary: 28672. When this switch is already the root, primary stores 24576 unless its own priority is lower (then nothing). | cli → stp |
| global | `spanning-tree vlan <list> hello-time\|forward-time\|max-age <s>` (multi) [S5] | stp |
| global | `no spanning-tree vlan <list>` (stored negation, multi per VLAN) | stp |
| global | `spanning-tree portfast default`; `spanning-tree portfast bpduguard default`; `spanning-tree loopguard default` [S5] | stp |
| global | `port-channel load-balance src-mac\|dst-mac\|src-dst-mac\|src-ip\|dst-ip\|src-dst-ip` (2) | etherchannel |
| global | `errdisable recovery cause psecure-violation\|bpduguard\|channel-misconfig\|all` (multi); `errdisable recovery interval <s>` (3) | the cause's daemon |
| global | `mac address-table static <mac> vlan <v> interface <if>` (multi); `mac address-table aging-time <s>` (3) | eth-switch |
| global | `interface range <if-range>` (mode `config-if-range`; not stored — each line is applied to each port's own section) | CLI runtime |
| global | `vtp mode\|domain\|version\|password …` [C1] | vtp |

### 5.2 Routing and services

| Context | Line | Consumer |
|---|---|---|
| global | `ip routing` / `no ip routing` (`bothForms`: one slot, both stored) | ipv4, host |
| global | `ip route <net> <mask> <nh>\|<if> [<nh>] [<ad 1-255>] [permanent]` (multi) | ipv4 |
| global | `ipv6 route <p/len> <nh>\|<if> [<nh>] [<ad>]` (multi) | ipv6 |
| subinterface | `encapsulation dot1Q <vid> [native]` | runtime (`PortState.dot1q`) |
| interface | `ip proxy-arp` / `no ip proxy-arp` (storeNegation; default from the profile) [S7] | arp |
| interface | `ip nat inside` / `ip nat outside` | ipv4, nat |
| global | `access-list <1-99\|1300-1999> permit\|deny <a> [<wildcard>]\|host <a>\|any` (multi) | nat (core/acl.ts) |
| global | `ip access-list standard <name>` (section, mode `config-std-nacl`) with `permit\|deny …` children | nat |
| global | `ip nat pool <name> <start> <end> netmask <m>\|prefix-length <n>` | nat |
| global | `ip nat inside source list <acl> pool <name> [overload]`; `ip nat inside source list <acl> interface <if> overload` | nat |
| global | `ip nat inside source static <il> <ig>` (multi); `ip nat inside source static tcp\|udp <il> <lp> <ig>\|interface <if> <gp>` [S9] | nat |
| global | `ip nat translation timeout\|udp-timeout\|tcp-timeout\|icmp-timeout <s>` [S9] | nat |
| interface | `standby version 1\|2`; `standby [<g>] ip [<a>]`; `standby [<g>] priority <n>`; `standby [<g>] preempt [delay minimum <s>]`; `standby [<g>] timers <hello> <hold>` [S2] | hsrp |
| global | `ipv6 dhcp pool <name>` (section, mode `config-dhcpv6`) with `address prefix <p/len> [lifetime <valid> <preferred>]`, `dns-server <a>` (multi), `domain-name <d>` | dhcpv6-server |
| interface | `ipv6 dhcp server <pool>`; `ipv6 dhcp relay destination <a> [<if>]` [S8] | dhcpv6-server, ipv6 (joins ff02::1:2) |
| interface | `ipv6 nd managed-config-flag`; `ipv6 nd other-config-flag`; `ipv6 nd prefix default no-autoconfig` [S8] | nd |
| interface | `ipv6 address dhcp` | ipv6, dhcpv6-client |

### 5.3 Wireless

| Context | Line | Consumer |
|---|---|---|
| global (LAP) | `capwap enable` (2; replayed by the P2 profile; `no capwap enable` makes the AP autonomous) | capwap-wtp |
| global (LAP) | `capwap controller <ip>` (multi) | capwap-wtp |
| global (WLC) | `wlc-interface <name>` (section, mode `config-wlc-if`; `management` is the predefined management interface and cannot be removed) | capwap-ac, runtime (via the handler) |
| config-wlc-if | `vlan <v>` (1, required); `address <a> <mask>` (1; the handler maintains `interface Vlan<v>` / `ip address` / `no shutdown`); `gateway <a>` (1; for `management` the handler maintains `ip default-gateway <a>`); `dhcp-server <a>` (1; stored, shown and gradeable, not used to proxy — deviation (15)) | capwap-ac |
| global (WLC) | `wlan <id> <profile> <ssid>` (section, mode `config-wlan`) | capwap-ac |
| config-wlan | `security open\|wpa2-psk\|wpa3-sae` (`wpa2-enterprise\|wpa3-enterprise` S11); `passphrase <rest>` (secret); `interface <name>` (a `wlc-interface`; `CLI_MESSAGES.wlcInterfaceMissing` when absent; default `management`); `radio 2.4\|5\|all`; `radius-server <ip> key <secret>` [S11]; `shutdown`. There is no `client-vlan` line: a WLAN reaches a VLAN only through its interface, as on the controller the course teaches. | capwap-ac |

### 5.4 Exec, show and debug (P2)

`show vlan [brief|id <v>]`, `show interfaces trunk`, `show interfaces <if> switchport`,
`show interfaces status [err-disabled]`, `show mac address-table [dynamic|static|vlan <v>|interface <if>|count]`,
`show spanning-tree [vlan <v>] [summary|root|interface <if> [detail]]`, `show etherchannel summary`,
`show etherchannel port-channel`, `show lacp neighbor` [S3], `show port-security [interface <if>|address]`,
`show errdisable recovery`, `show dtp interface <if>`, `show ip route [static]` (ECMP continuation lines S6),
`show ip nat translations [verbose]`, `show ip nat statistics`, `show access-lists`, `show standby [brief]` [S2],
`show ipv6 dhcp pool|binding|interface`, `show capwap` (AP), `clear mac address-table dynamic [vlan <v>|interface <if>]`,
`clear ip nat translation *`, `clear spanning-tree detected-protocols [interface <if>]` (§3.6 Mixed modes),
`clear errdisable interface <if>` [S5]. All output wording is original.

**Debug categories (binding across the daemon and cli seam).** The CLI prints a debug event only when its `category`
is in the device's debug set (cli/runtime.ts:1131), so each daemon passes exactly this string to `ctx.debug` and
`ctx.transition`, and `debug <category>` enables it:

| Daemon | Category string (= the `debug` tokens) |
|---|---|
| stp | `spanning-tree events` |
| dtp | `dtp` |
| etherchannel (lacp, pagp, static) | `etherchannel` |
| vlan | `sw-vlan` |
| eth-switch, new port-security messages only (existing eth-switch categories and messages unchanged) | `port-security` |
| runtime (errDisable / errRecover log lines are logs, not debug) | — |
| nat | `ip nat` |
| hsrp [S2] | `standby` |
| dhcpv6-client, dhcpv6-server | `ipv6 dhcp` |
| capwap-wtp, capwap-ac | `capwap` |
| vtp [C1] | `sw-vlan vtp` |

### 5.5 GUI panels and host shell

- **Controller panel** (`wlc.controller`, W6): Access points (from `capwap-aps`); **Interfaces** (name, VLAN,
  address, mask, gateway, DHCP server — builds `wlc-interface` sections; the management interface is the first row);
  WLANs (SSID, security, passphrase, interface chosen from the Interfaces list — builds `wlan` sections); Clients
  (`wlan-clients`). It writes through `configure` like every panel (D9).
- **Port inspector, switching section** (W3): mode, access VLAN, trunk native/allowed, spanning-tree role/state per VLAN,
  channel membership, port-security status. A quick action writes `switchport mode access` +
  `switchport access vlan <v>`.
- **IP configuration app** (Desktop): an IPv6 "automatic with DHCPv6" choice writes `ipv6 address dhcp` (host shell
  expansion `ipv6 address dhcp [<adapter>]`).
- **Home router panel** [S13]: a "share one address (NAT)" switch writes `ip nat inside` on Vlan1,
  `ip nat outside` on Internet and `ip nat inside source list 1 interface Internet overload` with
  `access-list 1 permit <lan> <wildcard>`; the P1 "DHCP later" note (§12.2 of the P1 brief) is corrected in the same
  change.
- **IP phone** [S4]: a Voice VLAN field writes `voice vlan <v>` on the phone.

---

## 6. Web file map

Every semantic encoding keeps a non-colour channel (glyph, letter, text or shape). Overlays never use dash patterns
(D20). New canvas layers resolve cross-module references at call time (rule 12) and memoise per device object
(`Canvas.tsx` restyles every layer on each snapshot or delta, :430-444, :491-555).

| Area | Files (`apps/web/src/…`) | Wave | Owner |
|---|---|---|---|
| Vocabulary: drop reasons (4), protocols (dot1q, stp, lacp, dtp, hsrp, dhcpv6, capwap; unique letters; control frames use the hexagon shape of spec §9.1), capabilities (3), role labels, GUI panel, lanes | `vocab/{drops,protocols,categories}.ts` stubs in W0; real labels in W1; `vocab/lanes.ts` [S1], `vocab/fsm.ts` (state lists per machine) [S14] | W0/W1 | architect (stubs), web-inspector |
| Retag `@since P2` course members as `@since course` | `store/types.ts`, `app/{App,TopBar,Workspace}.tsx` | W0 | architect |
| Overlay registry (data only: `{id, label, since, objectives, select(snapshot), sync(input)}`) and the pure models (VLAN tint/chip/rail and mismatch detector from both link ends; STP crown/role letter/state glyph/active-tree underlay/draining bar) | `canvas/overlays/{registry,l2-model,stp-model}.ts` | W1 | web-canvas |
| Defaults profile: status-bar chip "Classic defaults" for P1 worlds, File → "Use current defaults", the profile of a new world from the course context (D2) | `app/StatusBar.tsx`, `app/FileMenu.tsx`, `bridge/worker/index.ts` (init/reset/useCurrentDefaults), `bridge/protocol.ts`, `learn/course-profile.ts` (new, pure: `profileForCourse`), `learn/LearnShell.tsx` (records `lastCourse`; re-initialises an empty world when entering the sandbox from a lesson) | W2 | web-shell |
| Background drops hidden by default: no drop marker, no dirty device, not listed in sim mode unless background is shown | `bridge/worker/delta.ts` (a background drop marks nothing dirty), `simmode/sim-events-client.ts` (background filter covers drops) | W2 | web-shell |
| Drop-marker spawning skips background drops | `canvas/markers.ts`, the marker spawn in `store/store.ts` (web-shell makes the one-line store edit in W2; web-canvas owns markers.ts in W3) | W2 / W3 | web-shell / web-canvas |
| Scene layers and their wiring: the VLAN, STP and CAPWAP layer containers in z-order, registry-driven sync from the `topoOverlays` slice | `canvas/scene.ts`, `canvas/Canvas.tsx` | W3 (VLAN, STP), W6 (CAPWAP) | web-canvas |
| Topology overlay state (new persisted slice `topoOverlays`) and the "Switching overlays" menu | `store/{types,store,persist}.ts`, `app/TopBar.tsx` | W2 | web-shell |
| VLAN overlay (access tint + `V10` chip at the port anchor; trunk rail underlay with `T 10,20 · N99`; native/mode mismatch pulse + `!` glyph; VLAN focus filter) | `canvas/l2.ts` (scene layer under `devices`) | W3 | web-canvas |
| STP overlay (root crown + `ROOT v10`; R/D/A/B letters; cross glyph on blocking/discarding; active tree as a thick underlay; forward-delay draining bar from `nextTransitionAt`; per-VLAN selector; topology-change wave from `stp-bridge.lastChangePort` reusing the `markers.ts` starburst) | `canvas/stp.ts` | W3 | web-canvas |
| Packet colour by VLAN (`PduSummary.vlan`; an untagged leg takes the from-port's access/native VLAN) and a `Q` badge on tagged legs | `canvas/packets.ts` | W3 | web-canvas |
| Keyboard outline: port role, VLAN and spanning-tree state in the item text | `canvas/a11y/CanvasOutline.tsx` | W3 | web-canvas |
| Port inspector switching section; generic tables (vlans, dtp, stp, stp-bridge, etherchannel, port-security, nat, dhcpv6-bindings render through `TablesView` and `TABLE_DESCRIPTORS` with no code) | `inspector/{PortInspector,SwitchportSection}.tsx` | W3 | web-inspector |
| NAT quadrant visualizer (inside/outside × local/global, filled from the `nat` rows and the selected packet's provenance) | `inspector/NatQuadrant.tsx` | W3 | web-inspector |
| Desktop IP configuration: DHCPv6 choice | `desktop/apps/IpConfigApp.tsx`, `gui/commands.ts` | W3 | web-inspector |
| Worker time machine (parked replayers, seek, review mode, lane index) [S1] | `bridge/worker/{time-machine,lanes}.ts`, `bridge/worker/index.ts`, `store/store.ts` (review handling in `applyBatch`) | W4 | web-shell |
| Controller panel (access points, interfaces, WLANs, clients) | `inspector/WlcPanel.tsx`, `gui/{commands,forms}.ts`, `inspector/tabs.ts` (`PANEL_TAB`), `shared/openDeviceSurface.ts` | W6 | web-inspector |
| "Protected (DTLS, simulated)" banner for PDUs with `meta.protected` | `inspector/PacketInspector.tsx` | W6 | web-inspector |
| CAPWAP overlay (tunnel arcs AP↔controller reusing `airArc`, state letters Di/Jn/Cf/Run) | `canvas/capwap.ts` | W6 | web-canvas |
| Timeline strip (own grid row between workspace and dock; lanes with glyphs; scrubber; review banner "Viewing the past — return to now") [S1] | `timeline/{TimelineStrip,Scrubber,LaneRows}.tsx`, `timeline/timeline-client.ts` (pure, W1); the grid row in `app/App.tsx` | W6 | web-timeline (components), web-shell (`App.tsx`) |
| State-machine history strip for the selected port/group (§9.5) [S14] | `inspector/FsmStrip.tsx` | W6 | web-inspector |
| Channel spectrum and co-channel pairs [S12] | `inspector/SpectrumView.tsx` | W6 | web-inspector |
| Labs browser grouped by course then topic | `labs/LabBrowser.tsx` | W6 | web-learn |
| File menu categories: `ccna2-lab` with a generic "Labs: <course>" label | `app/FileMenu.tsx` (`CATEGORY_ORDER`) | W6 | web-shell |
| Home router NAT switch [S13] | `inspector/HomeRouterPanel.tsx`, `gui/commands.ts` | W6 | web-inspector |
| Compare panel [C3], convergence panel [S15], bookmarks and deep links [C4] | `timeline/{ComparePanel,ConvergencePanel,BookmarkBar}.tsx`, `app/deep-link.ts` | W6 (S15) / W7 (C3, C4) | web-timeline |

No new dock tab is added (the timeline is its own row), so `DOCK_STAGE` and the hotkey pins
(`hotkeys.test.ts:141-143, 155-157`) do not change.

`docs/CATALOG.md` (including the R2 fidelity table, §12.2) has one editor, the architect, who collects the rows from
the wave reports at each wave's end; no implementer edits it.

---

## 7. Module map and build waves

Owners are agents; each file has exactly one. Each item lists **owner — files — delivers — tests**. Tests named here
are the owner's own tests (rule 9) and depend only on earlier waves or the owner's own item. A bracketed item
(**[Sn]**, **[Cn]**) is its own item with its own files or clearly delimited functions (a `// [Sn]` block) and its own
tests; it exists only when §8.5 approves it, so cutting it removes whole items and never a piece of a seam. Every wave
ends with review → adversarial verify → fix (rule 8), then the lead runs the five checks, `accept.p2.p1-digests` and
gate G (rules 9, 10). Adversarial verify from W2 on replays real worlds built with `test/p2.world.ts` (rule 13).

### W0 — decisions, contracts, the P1 golden (architect)

- **product owner** — the §8.5 decision record (SHOULD set, COULD set, the scope list the exit gate checks).
- **architect** — every contract file in §2: the MUST blocks **and the blocks of every SHOULD item approved in §8.5**;
  `packages/engine/src/index.ts`; this document; compile-only stubs for the exhaustive records: web
  `vocab/drops.ts` `DROP_VOCAB`, `vocab/protocols.ts` `PROTOCOL_VOCAB` (including the approved SHOULD protos, e.g.
  `hsrp` S2, `pagp` S3), `vocab/categories.ts` `CAPABILITY_VOCAB` and `GUI_PANEL_VOCAB`, `inspector/tabs.ts`
  `PANEL_TAB`, `shared/openDeviceSurface.ts` `SURFACE_PANEL_TAB`, and for approved SHOULD items `vocab/lanes.ts`
  [S1], `vocab/fsm.ts` [S14], the `WIFI_*` records [S11]; engine `device/catalog/define.ts` `GUI_PANEL_SINCE` and the
  panel `want` record (define.ts:119, :299); the `@since course` retag; the `P2_CTX` / `P2_DEVICE` spreads in
  `test/port.fixtures.ts` (§0 rule 2).
- **architect** — `test/goldens/p1-profile-digests.json`, recorded **before any engine code changes** from the
  unchanged engine, and its test `accept.p2.p1-digests.test.ts` (§10.1).
- Five checks green; no behaviour change. **Behaviour-neutral W0:** `managed-switch`, `lightweight-ap` and
  `wireless-controller` are added to `CAPABILITIES` with their own implications, but no model carries them; no
  existing implication changes (D5); **`PROCESS_ORDER`, `CAPABILITY_PROCESSES` and the registry are untouched**
  (§0 rule 3).

### W1 — pure foundations and runtime plumbing

- **pdu** — `pdu/codecs/{dot1q,stp,lacp,dtp,dhcpv6,capwap}.ts`, `pdu/codecs/{ethernet,llc}.ts` (802.3 length,
  non-SNAP), `pdu/codecs/{dispatch,registry}.ts` (new spaces, registry order, the 802.3 rule for `dot1q.type`,
  FCS-in-tunnel rule), `pdu/vlan.ts` (`vlanPushOp`, `vlanPopOp`), `pdu/pdu.ts` (`RewrapOp.as`).
  Tests: `pdu.codecs.p2.test.ts` (golden bytes per codec, including a 110-byte LACPDU, a TCN BPDU and a tagged PVST+
  BPDU `[ethernet 0x8100, dot1q {type = length}, llc, stp]`); `pdu.vlan.test.ts` (push/pop provenance exactly
  `[VlanTagPush, FcsRecompute]` / `[VlanTagPop, FcsRecompute]`; byte identity of push-then-pop for an ARP, a
  1500-byte IPv4, an IPv6 frame and an 802.3/LLC frame; the 64-byte minimum; the router-on-a-stick mutation sequence
  of §3.4 derived from real calls); `pdu.codecs.8023.test.ts` (802.3/LLC decode; the SNAP vectors of the dot11 tests
  unchanged); the §9 W1 pdu migrations.
- **pdu [S2]** — `pdu/codecs/hsrp.ts` and its registry and dispatch lines. Tests: `pdu.codecs.hsrp.test.ts`.
- **pdu [S9]** — `pdu/pdu.ts` `proto[i].field` paths and quoted-layer patching (§2.3). Tests:
  `pdu.quoted-patch.test.ts` (a quoted udp port and a quoted address with the udp pseudo-header; a quoted icmp id with
  the quoted icmp checksum; a quoted tcp header is never touched; quote length kept, every checksum valid).
- **core** — `core/vlan-list.ts` (parse, format, contains, add, remove, except), `core/acl.ts` (standard ACL match,
  first match wins, implicit deny). Tests: `core.vlan-list.test.ts`, `core.acl.test.ts`.
- **core [S6]** — `core/rib-arbiter.ts` (`maxPaths`, `multipathEligible`). Tests: `core.rib-arbiter.p2.test.ts` (the
  pin at core.rib-arbiter.test.ts:139 untouched).
- **device** — `device/pipeline.ts` (steps 10, 10a, the link-layer-control rule of 10b, 12 of §3.0); `device/ports.ts`
  (virtual oper for the new roles and the injected-lookup SVI rule with the §3.0 reasons; subinterface port factory;
  canonical order); `device/device.ts` and `device/process-ctx.ts`, the pieces that need no new pipeline:
  `DeviceSpec.profile` and the `profileConfig` replay after `defaultConfig`; actions `errDisable`, `errRecover`,
  `l2Changed` (fan-out in `L2_PROCESSES` order), `configLine`; `setPortAdmin` clears `errDisabled`; `errDisablePort`;
  `ProcessCtx.profile`, `ctx.transition`. Spreads `P2_CTX` / `P2_DEVICE` into the typed fakes §9 W1 lists.
  Tests: `device.pipeline.p2.test.ts`, `device.ports.p2.test.ts`, `device.l2-actions.test.ts`,
  `device.profile.test.ts` (replay order with a hand-built model).
- **device [S2]** — the multicast-group rule of pipeline step 10b (a delimited function). Tests: in
  `device.pipeline.hsrp.test.ts`.
- **catalog** — `device/catalog/names.ts` (hyphenated families: `Port-channel1`, `po1`, `port-channel 1`;
  subinterfaces `g0/0.10` → `{kind:'virtual', family:'subinterface', parent}`), `device/catalog/define.ts`
  (derive `profileConfig`, `subinterfaces`, the Port-channel family, `ROLE_EGRESS_OWNER.channel = 'etherchannel'`,
  `ROLE_EGRESS_OWNER['wlan-tunnel'] = 'capwap-ac'`, the managed-switch Vlan family `max: 4094` keyed on the
  `managed-switch` capability). No model data changes. Tests: `device.catalog.names.p2.test.ts`,
  `device.catalog.define.p2.test.ts` (with `defineModel(input, 'P2')`; a P0.5-stage `layer3-switch` fixture is
  unchanged).
- **cli** — `cli/config-rules.ts` (§5 rules, the corrections, `bothForms`, `negationRestoresDefault`),
  `cli/config-ast.ts` (`slotKeyOf`, `defaultSlotsOf`, `apply` with `defaults`), `cli/modes.ts`, `cli/parser.ts` (arg
  types `vlan-list`, `mac-any`, `if-range`), and `goldens/cli-help.p1.json` (a frozen copy of today's
  `cli-help.p05.json`) with its guard `cli.help-superset.test.ts` (every later regeneration of `cli-help.p05.json` is
  a superset of the frozen copy except the entries §9 names).
  Tests: `config-ast.p2.test.ts` (identity table of every §5.1 line; bare `switchport` no longer removes children;
  `no ip routing` ↔ `ip routing` in one slot, both stored; `vlan 10,20` stored as two sections; every completeness
  case with a hand-given `DefaultSlots`; without `defaults` today's behaviour), `cli.parser.args.p2.test.ts`.
- **l2** — `protocols/l2/{switchport-config,membership,control,port-security,lag-hash}.ts` (pure).
  Tests: `l2.switchport-config.test.ts` (including `CONTROLLER_PORT_SWITCHPORT`), `l2.membership.test.ts`
  (carries/classify tables, the native VLAN outside the allowed list, the SVI target), `l2.control.test.ts`,
  `l2.port-security.test.ts`, `l2.lag-hash.test.ts` (the five-octet fold; single-NIC PCs spread over members).
- **l2 [S4]** — voice VLAN rules in `membership.ts` (a delimited function). Tests: `l2.voice-vlan.test.ts`.
- **stp** — `protocols/stp/{vector,cost,ids}.ts` (priority-vector order, cost table including the Port-channel
  recompute, bridge and port id text, configured-priority helper for the root macro). Tests: `stp.vector.test.ts`.
- **media** — `link/media/p2p.ts` (`P2P_QUEUE_LIMIT`, drop `queue-full`). Tests: `link.p2p.queue-cap.test.ts`, which
  also measures the scheduler events per delivered frame and exports it as `P2P_EVENTS_PER_FRAME` from
  `test/p2p.constants.ts` (used by `accept.p2.loop-storm-bounded`); the owner greps for any existing test that queues
  ≥ 256 frames on one port and reports none.
- **io** — `io/{schema,migrate,netforge-file}.ts` (schema 1.2; `profile` only in the 1.2 field set; `schemaIdFor`;
  `TOPOLOGY_SCHEMA_ID` stays 1.1). Tests: `io.schema.p2.test.ts` (a P1 document exports byte-identically as 1.1; a P2
  one as 1.2; a 1.1 document carrying `profile` loads as P1; a 1.2 document loads as P2; 1.1 → 1.2 identity) and
  the §9 W1 io migrations.
- **sim** — `sim/simulation.ts`: `SimulationOptions.profile`, `Simulation.profile` plumbed to `DeviceSpec.profile`,
  `SimulationOptions.catalog` (tests and tooling only); `sim/run-control.ts` (`TrackedScheduler.dispatched`).
  Tests: `sim.profile.test.ts`, `sim.catalog-option.test.ts`.
- **sim [S1]** — `trace/ring.ts` (`startHead`, `at`). Tests: `sim.ring.p2.test.ts`.
- **qa** — `test/p2.world.ts`: `createP2Simulation({seed, profile, factories})` builds the catalog from the real
  model inputs with the W4 (and, from W4 on, the W6) model-data deltas applied idempotently, `defineModel(…, 'P2')`,
  and each model's `processes` completed with the §2.1 `CAPABILITY_PROCESSES` rows that later waves add, **filtered
  to the factories passed** (so no "not available" log appears) and in final `PROCESS_ORDER` order; then
  `createSimulation({seed, profile, catalog})`. After the W4 and W6 flips the deltas are already in the data and the
  helper equals the real catalog. Tests: `p2.world.test.ts` (a P2 NF-C2960 is VLAN-aware; a missing factory is
  filtered out; P1-stage models are untouched).
- **timeline [S1]** — `timeline/lanes.ts` (`laneOf`). Tests: `timeline.lanes.test.ts`.
- **timeline [S15]** — `timeline/convergence.ts` (`measureConvergence`, §2.13). Tests: `timeline.convergence.test.ts`.
- **course** — `curriculum/ccna2/lessons.ts` (skeleton: ids, titles, outcomes, lab names), **detached from
  `curriculum/index.ts` until W7** so the planned-course pins stay green. Tests: `curriculum.ccna2.test.ts` imports the
  skeleton directly (ids, ≤ 45 min, every lab reachable from exactly one lesson).
- **web-inspector** — `vocab/*` real entries. Tests: `vocab.test.ts` (exhaustive, unique letters, no banned words).
- **web-canvas** — `canvas/overlays/*`. Tests: `overlays.l2-model.test.ts`, `overlays.stp-model.test.ts`.
- **web-timeline [S1]** — `timeline/timeline-client.ts`. Tests: `timeline-client.test.ts`.

### W2 — bridging, L3 core, runtime integration, facade

- **device** — `device/device.ts`, `device/process-ctx.ts`: the completeness rule wired in (the device's
  `DefaultSlots` passed to every config apply, boot replay included); subinterface creation, `encapsulation dot1Q`
  special case, `subif` ingress verdict and `parent` egress; injected lookups for SVI/Port-channel oper and the new
  recompute sites; `setPortL3 virtual4`; drop `background`; `trace/filter.ts` (a background drop never matches unless
  background traffic is included). Tests: `device.subif.test.ts`, `device.virtual.p2.test.ts`,
  `device.completeness.test.ts` (reverse each default line; reload replays to the same state),
  `trace.filter.background.test.ts`.
- **device [S2]** — `setPortL3 groups4`. Tests: in `device.l2-actions.test.ts` (a delimited case).
- **l2** — `protocols/eth-switch.ts` (VLAN-aware path of §3.0, port security with idempotent secure rows, the flush
  table), `protocols/vlan.ts`. Tests: `l2.eth-switch.vlan.test.ts`, `l2.eth-switch.trunk.test.ts`,
  `l2.eth-switch.psec.test.ts` (including a sticky learn followed by 10 frames from the same host: no violation, one
  configChange, the secure row kept), `l2.eth-switch.svi-trunk.test.ts` (a broadcast arriving tagged reaches the SVI
  untagged), `l2.eth-switch.controller.test.ts` (backup distribution port, no port-to-port bridging, no BPDU relay),
  `l2.eth-switch.p0-parity.test.ts` (§3.0, on `p2.world`), `l2.vlan.test.ts`. `l2.eth-switch.test.ts`: assertions
  unchanged (fixture spread only, §9).
- **l3** — `protocols/{ipv4,ipv6,arp,nd,host,icmpv4}.ts`: static routing rework (per-line candidates, AD, the D13
  usable rule, recursion ≤ 8), the `ip routing` line (both forms), NAT hooks and `ipv4.resume`, `ipv4.virtual`, arp
  virtual entries and widened gratuitous ARP, `dot1q` in `LINK_FRAMING_PROTOS`, ipv6 statics and `ipv6.lease`,
  joining `ff02::1:2`, `ipv6.ra` event, nd M/O flags. Tests: `ip.static-routing.test.ts` (floating, fully specified,
  recursive, invalid when the exit is down, install time = when usable), `ip.ipv4.nat-hooks.test.ts` (fake nat),
  `arp.virtual.test.ts`, `ip6.static-routing.test.ts`, `ip6.nd.flags.test.ts`. `ip.ipv4.test.ts:403-409` unchanged.
- **l3 [S2]** — `ipv4.group`, `groups4` writes, `isLocalDestination` for groups. Tests: `ip.ipv4.groups.test.ts`.
- **l3 [S6]** — ECMP installation and the flow hash. Tests: `ip.ecmp.test.ts`.
- **l3 [S7]** — proxy ARP (a delimited function in `arp.ts`, default from `ctx.profile`). The stored form is
  `storeNegation` (§5.2, `cli/config-rules.ts`), so the read is two-state: a stored `no ip proxy-arp` on the interface
  means off, and an empty slot means `ctx.profile` (on in the P2 profile for a routed interface of a routing device,
  off in P1). A typed `ip proxy-arp` clears the slot and stores nothing — in a P1-profile world it is therefore a
  no-op, which is what §5.2 binds. Tests: `ip.proxy-arp.test.ts`.
- **l3 [S8]** — `ipv6 nd prefix default no-autoconfig` in `nd.ts`. Tests: `ip6.nd.no-autoconfig.test.ts`.
- **sim** — `sim/simulation.ts` (load/export `profile` with schema 1.2, the `err-disable` fault),
  `sim/snapshot-cache.ts` (`PortSnapshot.l2`, `parent`, `dot1q`, `SimSnapshot.profile`).
  Tests: `sim.export-profile.test.ts`, `sim.snapshot-l2.test.ts` (on `p2.world`), `sim.fault.err-disable.test.ts`.
- **sim [S1]** — `sim/journal.ts`, `sim/replay.ts` and the delimited `// [S1]` block of `sim/simulation.ts`
  (facade counters, `resume`, depth-0 recording). Tests: `sim.journal.test.ts`, `sim.replay.test.ts`,
  `sim.observation-purity.test.ts`.
- **cli** — `cli/runtime.ts` (`config-if-range`), `cli/grammar/{vlan,switchport,subif,routing}.ts` and handlers
  (vlan, switchport lines incl. VLAN auto-creation and allowed-list resolution, `encapsulation dot1Q`, `ip route` and
  `ipv6 route` forms, `ip routing`, `show vlan`, `show interfaces trunk|switchport|status`, `show mac address-table`
  filters) and the `cli-help.p05.json` regeneration plus the exact inline lists of
  `cli.grammar.help-goldens.test.ts:58-59` for the router lines this wave adds (§9).
  Tests: `cli.vlan.test.ts`, `cli.switchport.test.ts`, `cli.interface-range.test.ts`, `cli.routing.p2.test.ts`.
- **cli [S4]** — `switchport voice vlan`. **cli [S6]** — `show ip route` ECMP continuation lines. **cli [S7]** —
  `ip proxy-arp`. Each with its own test file.
- **web-shell** — profile plumbing including the course context (`learn/course-profile.ts`, `learn/LearnShell.tsx`),
  `topoOverlays` slice, status chip, File menu action, `bridge/worker/delta.ts` and `simmode/sim-events-client.ts`
  (background drops), the drop-marker spawn line in `store/store.ts` (§6).
  Tests: `store.topo-overlays.test.ts`, `worker.profile.test.ts`, `learn.course-profile.test.ts`,
  `store.background-drops.test.ts`.

### W3 — control-plane daemons, CLI part 2, overlays

- **stp** — `protocols/stp.ts`, `protocols/stp/{pvst,rstp,mixed,guards}.ts`.
  Tests (timing tests on `p2.world` with the W2 eth-switch and the stp factory): `stp.pvst.test.ts` (triangle timings
  of §3.6), `stp.rstp.test.ts` (including the alternate-port agreement on the SW2–SW3 link and the 30 s fallback of a
  non-edge host port), `stp.mixed.test.ts`, `stp.guards.test.ts` (PortFast scopes, BPDU guard, root guard, pvid on
  trunks only, type inconsistency), `stp.tc.test.ts` (802.1D detection when a port leaves forwarding, TCN until
  acknowledged and relayed, 802.1w propagation, host CAM rows on edge ports survive a TC), `stp.instances.test.ts`
  (128 cap, ascending order).
- **stp [S5]** — loop guard, timer lines. Tests: `stp.loop-guard.test.ts`.
- **lag** — `protocols/etherchannel.ts`, `protocols/etherchannel/{lacp,static,compat}.ts`.
  Tests: `lag.lacp.test.ts`, `lag.misconfig.test.ts` (individual without a partner, suspended when incompatible),
  `lag.egress.test.ts`, `lag.cost.test.ts`.
- **lag [S3]** — `protocols/etherchannel/pagp.ts` and `pdu/codecs/pagp.ts` (a new file owned by lag; the pdu owner's
  registry and dispatch lines are added in the same change as a reviewed edit). Tests: `lag.pagp.test.ts`.
- **lag [S5]** — EtherChannel guard. Tests: `lag.guard.test.ts`.
- **l2** — `protocols/dtp.ts`. Tests: `l2.dtp.test.ts` (the 5×5 matrix on `p2.world`, access ports answering, ageing,
  nonegotiate, members of a Port-channel in a dynamic mode).
- **nat** — `protocols/nat.ts`. Tests: `nat.static.test.ts`, `nat.dynamic.test.ts`, `nat.pat.test.ts` (including the
  inbound match rule: an outside echo request never matches a query row; the PAT mutation sequence from real calls).
- **nat [S9]** — port forwarding, ICMP-error translation, timeout lines. Tests: `nat.port-forward.test.ts`,
  `nat.icmp-error.test.ts` (both directions; traceroute through PAT with udp and with icmp probes).
- **svc** — `protocols/{dhcpv6-client,dhcpv6-server}.ts`, `protocols/dns-client.ts` (servers keyed by (iface,
  family), §2.5). Tests: `app.dhcpv6.test.ts`, `app.dns.dual-stack.test.ts` (DHCPv4 plus stateless DHCPv6 list both
  servers; a v4 release keeps the v6 server).
- **svc [S2]** — `protocols/hsrp.ts`. Tests: `fhrp.hsrp.test.ts`. **svc [S8]** — DHCPv6 relay. Tests:
  `app.dhcpv6.relay.test.ts`.
- **cli** — `cli/grammar/{spanning-tree,etherchannel,port-security,errdisable,nat,acl,dhcpv6}.ts` and handlers,
  including every §5.4 show command of these features and `show dtp interface`, the `root primary|secondary` macro
  and `clear spanning-tree detected-protocols`; the help-golden regeneration and exact inline lists for the router
  lines this wave adds (§9). Tests: `cli.stp.test.ts` (including the root-macro tie case), `cli.etherchannel.test.ts`,
  `cli.port-security.test.ts`, `cli.nat.test.ts`, `cli.dhcpv6.test.ts` — handlers against fake tables/StateViews
  (contract shapes).
- **cli [S2]** — `cli/grammar/hsrp.ts`, `show standby`. Tests: `cli.hsrp.test.ts`. **cli [S5]** — STP timer lines,
  loop guard lines, `clear errdisable interface`. **cli [S9]** — NAT port-forward and timeout lines. Each with its own
  test file.
- **web-canvas** — `canvas/{l2,stp,packets,markers,scene}.ts`, `canvas/Canvas.tsx`, `canvas/a11y/CanvasOutline.tsx`.
  Tests: pure geometry/glyph tests; `canvas.markers.background.test.ts`.
- **web-inspector** — `inspector/{PortInspector,SwitchportSection,NatQuadrant}.tsx`, `desktop/apps/IpConfigApp.tsx`,
  `gui/commands.ts`. Tests: panel command-line tests with a mocked engine.
- **web-inspector [S4]** — the IP phone's Voice VLAN field (`gui/commands.ts`, the phone panel). Tests: its panel
  command test.

### W4 — wired acceptance on real worlds, the catalog flip, radio plumbing, the time machine

- **qa** — `accept.p2.{silence,profile,vlan-access,trunk,dtp,router-on-a-stick,svi-routing,stp-pvst,stp-rapid,
  stp-guards,stp-scale,loop-storm-bounded,etherchannel,port-security,static-routing,dhcpv6,nat,determinism}.test.ts`
  (§10), built with `createP2Simulation` from `p2.world` (which does not depend on the flip landing in this wave);
  `p2.world` gains the W6 wireless model deltas (NF-AP-1832 lightweight, NF-WLC-9800) as test-only models for W5.
- **qa [S2]** — `accept.p2.hsrp.test.ts`.
- **catalog** — model data in `device/catalog/{switches,multilayer,datacentre,routers}.ts` (`managed-switch` on the
  managed L2 switches, listed explicitly on the multilayer and data-centre switches; Port-channel family;
  `stpDefaultMode` for NF-C9300), `device/catalog/index.ts` (`CATALOG_STAGE = 'P2'`), `protocols/index.ts` (registry:
  vlan, dtp, etherchannel, stp, nat, dhcpv6-client, dhcpv6-server — and hsrp when S2 is approved) together with the
  pre-approved contract edits of the same change: those names inserted into `PROCESS_ORDER` at their §2.1 positions
  and their `CAPABILITY_PROCESSES` rows. Tests: every §9 W4 migration; `device.catalog.p2.test.ts` (derived summaries
  of NF-C2960, NF-C3650-24, NF-2911). **The lead runs `accept.p2.p1-digests`, `accept.p05.determinism` and
  `accept.p1.silence` inside this change**: they prove that the flip changed nothing in the P1 profile beyond §9.3.
- **device** — `device/device.ts`, `device/process-ctx.ts`: `radio-profile` action, `radioSettings` overlay,
  `ctx.radioSettings` (byte-identical to today's renderer for a radio without a controller profile).
  Tests: `device.radio-profile.test.ts`.
- **web-shell [S1]** — `bridge/worker/{time-machine,lanes}.ts`, worker index, `store/store.ts` review handling.
  Tests: `worker.time-machine.test.ts` (including the §3.13 lifecycle), `store.timeline.test.ts`.

### W5 — CCNA 2 labs (wired) and the wireless engine

- **sim** — `sim/lab-checks.ts` (new `LabAssertion` kinds; clone re-applies err-disabled ports; one clone per
  `connectivity.after` set; port-name normalisation for `table` `where` columns of format `port`),
  `sim/scenarios/{index,kit}.ts` (`CCNA2_LABS` appended after `CCNA1_LABS`; `topology(…, {profile})` sets
  `schema = schemaIdFor(t)`),
  `sim/scenarios/ccna2/{vlans,trunks,intervlan,stp,etherchannel,security,routing,dhcpv6,nat,troubleshooting}.ts`.
  Tests: `labs.ccna2.solutions.test.ts` (every lab: unsolved fails, solution passes, grading read-only),
  `sim.lab-checks.p2.test.ts` (a wrong-answer case for every new kind).
- **sim [S2]** — `sim/scenarios/ccna2/fhrp.ts` and the `fhrp` lab kind. **sim [S15]** — the `convergence` lab kind.
- **wireless** — `link/media/air.ts` (central mode; per-radio busy time for central BSSs only; index-0 identity),
  `link/rewrap80211.ts`, `protocols/{wlan-ap,wlan-client}.ts` (`ctx.radioSettings`, pushed key tags, the `wlan.grant`
  event to capwap-wtp), `protocols/udp.ts` (`tunnel` sockets, §2.4), `protocols/{capwap-wtp,capwap-ac}.ts`.
  Tests (on `p2.world` with the test-only wireless models): `wifi.central.test.ts`, `udp.tunnel.test.ts`,
  `capwap.join.test.ts` (RFC state order, `meta.protected` after the DTLS step), `capwap.data.test.ts` (one PduId, no
  `pduConsumed` at the controller, the `wlan-clients` row before the first downlink frame). `link.air`, `wifi.assoc`,
  `accept.p05.mobility` stay green unchanged.
- **wireless [S10]** — multi-BSS (`link.air.multi-bss.test.ts`). **wireless [S11]** — `protocols/{dot1x-auth,
  radius-server}.ts`, `pdu/codecs/{eap,radius}.ts` (new files owned by wireless; pdu adds the registry and dispatch
  lines), station configuration 25/26 and `wlan.authorize` (`wifi.enterprise.test.ts`). **wireless [S12]** —
  neighbours and airtime.
- **cli** — `cli/grammar/wlc.ts` and handlers (`wlc-interface` section with the SVI-maintaining handler, `wlan`
  section lines, `capwap enable`, `capwap controller`, `show capwap`). Tests: `cli.wlc.test.ts`. Also (architect
  ruling of 2026-09-23, §9.2 W4 item 20e): `cli/grammar/hsrp.ts` scopes the `standby` interface lines to the roles
  `routed`, `subif` and `svi`; un-skips the `accept.p2.profile` `no capwap enable` case (§9.2b). Polish found at
  the W4 browser gate: `show vlan [brief]` wraps its Ports cell on a `, ` boundary so that **every line fits 80
  columns** — the cell wraps at 80 minus the Ports column's start (44 in the usual layout, whose Ports column starts at
  36; never below 20) — continuation lines indented under the column (before, one 200-character cell broke mid-name
  in an 80-column console); the pins of `cli.vlan` move with exact values. (Ruling restated by the architect on
  2026-09-24: the first wording, "at 48 characters", still gave 83-column lines — W5 review findings #11 and #15.)
- **sim** (continued) — un-skips the `accept.p2.static-routing` `route` lab-assertion case once the `route` kind lands
  (§9.2b).

### W6 — wireless catalog flip, web visuals, course text

- **wireless** (W5 close-out, §9.2 item 22b) — the CAPWAP AP identity: `wtpMac` in the Discovery and Join Requests
  (additive codec edit in `pdu/codecs/capwap.ts`, reviewed), capwap-ac sessions and `capwap-aps` rows keyed by it, the
  interim same-source refusal removed. Tests: `capwap.join` (two APs behind one router, both in `run`).

- **catalog** — `device/catalog/wireless.ts`: NF-AP-1832 gains `lightweight-ap` and its `profileConfig`
  (`capwap enable`, `interface Vlan1` / `ip address dhcp` / `no shutdown` in P2); the new NF-WLC-9800
  (`wlc.nfwlc9800`: `wireless-controller`, shell `none`, grammar `nfos`, GUI `wlc.controller`, auto `Capwap0`, four
  GigabitEthernet0/x ports and a console, no `defaultConfig`, original description); NF-WLC-3504 moves to the Legacy
  category with an updated description and is otherwise unchanged; `protocols/index.ts` registry with capwap-wtp and
  capwap-ac inserted into `PROCESS_ORDER` and their `CAPABILITY_PROCESSES` rows in the same change (radius-server
  with S11). Tests: §9 W6 migrations. **The lead runs `accept.p2.p1-digests` inside this change.**
- **web-inspector** — `inspector/WlcPanel.tsx` (with the Interfaces page), `gui/{commands,forms}.ts`,
  `inspector/tabs.ts`, `shared/openDeviceSurface.ts`, `inspector/PacketInspector.tsx` (protected banner).
  Tests: `WlcPanel` command test (§10.2).
- **web-inspector [S14]** — `inspector/FsmStrip.tsx`. **[S12]** — `inspector/SpectrumView.tsx`. **[S13]** —
  `inspector/HomeRouterPanel.tsx`.
- **web-canvas** — `canvas/capwap.ts` and its layer in `canvas/scene.ts` / `canvas/Canvas.tsx`.
- **web-timeline [S1]** — `timeline/{TimelineStrip,Scrubber,LaneRows}.tsx`. **[S15]** — `timeline/ConvergencePanel.tsx`.
- **web-learn** — `labs/LabBrowser.tsx`; a busy "checking" state while a lab check runs (§9.2 item 22c).
- **web-shell** — `app/FileMenu.tsx` (`ccna2-lab` category); **[S1]** `app/App.tsx` (the timeline grid row).
- **course** — `curriculum/ccna2/{theory-a,theory-b,theory-c,videos}.ts` for every non-wireless lesson.
  Tests: `curriculum.ccna2.commands.test.ts` (every backticked command in a lesson parses in `GRAMMAR` for the model the
  lesson names; address lines equal lines of the attached lab's solution, the twin of curriculum.test.ts:171-186),
  `curriculum.ccna2.videos.test.ts`.

### W7 — wireless lab, course flip, remaining acceptance; COULD items by approval

- **sim** — `sim/scenarios/ccna2/wireless.ts`. Tests: `labs.ccna2.solutions.test.ts` covers it.
- **qa** — `accept.p2.wlc.test.ts`, `accept.p2.labs.test.ts`, `accept.p2.coverage.test.ts`; web acceptance (§10.2).
- **qa [S1]** — `accept.p2.replay-exact.test.ts`, `accept.p2.seek.test.ts`.
- **course** — wireless lesson theory; `curriculum/index.ts` (the CCNA 2 skeleton attached, `available`, its
  description rewritten — the P1 text promises dynamic routing, which is CCNA 3).
  Tests: the §9 W7 curriculum migrations.
- **COULD items** (§8), each only with the product owner's approval, each as its own item with its own tests and,
  first, its contract block written in full by the architect: `protocols/vtp.ts` (C1), MST in `protocols/stp/mst.ts`
  (C2), compare (C3), bookmarks/deep links/`activity.json` (C4), roaming (C5), FlexConnect (C6), extras (C10–C11).

### W8 — P2 exit gate (architect)

Remove the transition `?` of every implemented `@since P2` member except those of §2.15, and add
`contracts.optional-by-meaning.test.ts`; reconcile `index.ts`; reduce `p2.world` to a thin wrapper (its deltas are
now the real data); check the §8.5 scope list item by item (each shipped, or recorded as deferred with its stage);
update docs; run the five checks, `accept.p2.p1-digests` and gate G on the P2 lab set; record the gate in a §14
appended to this document, as P1 did in its §12.1–§12.2.

---

## 8. Cut lines

The spec gives P2 five months (§19). This section ranks every P2 feature by value to a CCNA 2 learner against its
cost, and draws three lines.

**Units.** Cost is in engineer-weeks (ew): one focused implementer week, including its tests, its share of review and
fixes, and its CLI lines. Parallel agents shorten calendar time but not the ratios. Estimates come from P1 actuals
for comparable work (for example the DHCPv4 daemons, the air medium, TCP).

**Value** is judged against the CCNA 2 objectives of spec §2.2, whether exam questions depend on the behaviour, and
whether a lab can be built without it.

### 8.1 MUST (core objectives) (≈ 52 ew)

MUST is the set of core CCNA 2 objectives. It is **not** by itself everything spec §19 and §2.2 name for P2 (VTP,
time travel, HSRP, PAgP, voice VLAN, loop guard, MST, WPA-Enterprise, RF overlap, roaming, load balancing and port
forwarding are SHOULD or COULD); what "CCNA 2 complete" means for this stage is the scope list the product owner
records in §8.5, and the exit gate checks exactly that list.

| # | Feature | Value | Cost | Wave items | If cut (last resort only) |
|---|---|---|---|---|---|
| M1 | Defaults profile (replay, completeness rule, course-context profile, "Use current defaults"), contracts, compile stubs, the P1-profile digest golden, `p2.world`, migrations | Enabler: without it spanning tree cannot default on without rewriting P0/P1 goldens, and nothing proves the P1 profile unchanged | 2.5 | W0; W1 io/device/sim/cli/qa; W2 device/sim/web-shell | P2 ships with spanning tree off by default everywhere: a real fidelity lie in every new topology |
| M2 | 802.1Q codec, push/pop provenance, 802.3/LLC framing (ethernet and dot1q), tag-aware pipeline | Enabler for M3–M7; the "tag slides in" provenance is a flagship moment (spec §9.2–§9.3) | 1.5 | W1 pdu, device | Nothing in the VLAN block works |
| M3 | VLAN database, access/trunk/native/allowed, VLAN-aware eth-switch, per-VLAN CAM, SVI autostate, `interface range`, `show vlan/trunk/switchport` | The centre of CCNA 2 (VLANs, trunks, native VLAN, allowed lists) | 4 | W1 l2/cli; W2 l2/cli/device | No CCNA 2 |
| M4 | DTP (auto and access answer, desirable/trunk speak, nonegotiate, bundles) | Named objective; exam questions on the mode matrix | 1.5 | W3 l2; W2–W3 cli | `dynamic` modes act as access; the negotiation lesson becomes theory only |
| M5 | Inter-VLAN routing: router-on-a-stick subinterfaces, multilayer SVIs + `ip routing`, legacy | Named objective with three methods, all lab staples | 2.5 | W1 device/catalog; W2 device/l3/cli | Only the legacy method remains |
| M6 | Spanning tree: PVST+ and Rapid PVST+ (with mixed-mode migration), priority and root macro, costs, PortFast, BPDU guard, root guard, TC and flushing, native-mismatch and type detection | Named objective; the most visual topic of the course | 6.5 | W1 stp; W3 stp/cli | Loops storm; the whole STP module is theory |
| M7 | EtherChannel: static and LACP, load-balance hash, individual and suspended members, `show etherchannel` | Named objective; standard lab | 3.5 | W1 l2/stp; W3 lag/cli | EtherChannel module is theory; redundant uplinks rely on STP only |
| M8 | Port security, err-disable and recovery, the `err-disable` fault | Named objective ("switch security" module), standard lab | 2 | W1 device; W2 l2/device/sim; W3 cli | Security module loses its only hands-on lab |
| M9 | Static routing v4/v6: fully specified, floating (AD), recursive, validity tracking | Named objective (two modules) | 2 | W2 l3/cli | Floating statics impossible; routing module half theory |
| M10 | DHCPv6 stateless and stateful (server, client, RA M/O flags, dual-stack DNS) | Named objective (SLAAC and DHCPv6 module) | 2.5 | W1 pdu; W2 l3; W3 svc/cli | Module 8 becomes SLAAC only |
| M11 | NAT static, dynamic pool, PAT (interface and pool), standard ACL subset, NAT quadrant view | Spec §9.4 calls this visualizer the fix for "the single most confused topic"; exam objective | 3.5 | W1 core/pdu; W2 l3; W3 nat/cli/web-inspector | NAT stays a home-router idea; the quadrant visualizer is lost |
| M12 | Wireless controller: new NF-WLC-9800, CAPWAP join (RFC states, simulated DTLS), controller interfaces and WLAN push (personal security), central switching over a UDP tunnel, station reports, controller panel; one WLAN per radio | Exam objective ("configure a WLAN on a controller with the GUI"); SRWE module | 6.5 | W4 device/qa (test models); W5 wireless/cli; W6 catalog/web; W7 lab | Wireless module limited to autonomous and home APs; the WLC lab disappears. This is the most expensive MUST item and the first MUST to reconsider if time runs out |
| M13 | VLAN and STP overlays, port inspector switching section, VLAN packet colours, background drops hidden | Spec §19 lists the overlays in P2; they make M3/M6 visible | 3 | W1/W3 web-canvas; W2 web-shell; W3 web-inspector | Learners read tables instead of seeing trees |
| M14 | CCNA 2 course: 34 lessons with theory, 19 labs, new assertion kinds, grader fixes, command-parse test | The product for the learner | 7 | W1 course; W5 sim; W6–W7 course | No course, only a sandbox |
| M15 | Acceptance suite, the P1-profile digest test and gates | Proof | 2.5 | W0 architect; W4, W7 qa | — (never cut) |

### 8.2 SHOULD — high value, cut only under pressure (≈ 25 ew)

Each SHOULD item is a set of its own wave items (§7, bracketed); cutting it removes exactly those items.

| # | Feature | Value | Cost | Depends on | Wave items | Consequence of cutting |
|---|---|---|---|---|---|---|
| S1 | Timeline and time travel (journal, replay, parked replayers, review mode, lane strip) | Spec §19 lists it in P2; scrubbing an STP convergence is the differentiator | 5 | M1 | W1 sim/timeline/web-timeline; W2 sim; W4 web-shell; W6 web-timeline/web-shell; W7 qa | No time travel in P2; the P1 sim-mode list and breakpoints remain. The journal contracts are never added |
| S2 | HSRP v1/v2 | Gateway redundancy module has a lab; exam asks about virtual MACs | 2.5 | M9 | W1 pdu/device; W2 device/l3; W3 svc/cli; W4 catalog registry line/qa; W5 sim | FHRP module becomes theory (concepts only, as in the official course) |
| S3 | PAgP | Named alongside LACP; cheap once LACP exists | 0.8 | M7 | W3 lag | Only LACP and static bundles |
| S4 | Voice VLAN (switch lines, phone field) | Named objective; small | 1 | M3 | W1 l2; W2 cli; W3 web-inspector | Voice VLAN taught as theory |
| S5 | Loop guard, EtherChannel guard, STP timer lines, `clear errdisable` | Completes the guard family | 1 | M6, M7 | W3 stp/lag/cli | Misconfiguration A (§3.7) runs the active side as individual ports with no guard (possible duplicate frames, no loop) |
| S6 | ECMP (equal static paths, `show ip route` continuation lines) | "Load balancing" in routing concepts | 1 | M9 | W1 core; W2 l3/cli | One path per prefix; load balancing is theory |
| S7 | Proxy ARP (on by default in the P2 profile) | Explains why exit-interface statics work on Ethernet | 0.3 | M9 | W2 l3/cli | Exit-interface statics on Ethernet fail (document it) |
| S8 | DHCPv6 relay, `ipv6 nd prefix default no-autoconfig` | Completes the DHCPv6 module | 0.7 | M10 | W2 l3; W3 svc | Server must share the client's link |
| S9 | NAT port forwarding, ICMP-error translation (both directions), timeouts | Traceroute through PAT; port forwarding lab | 1.2 | M11 | W1 pdu; W3 nat/cli | Traceroute through NAT shows `*`; no port forwarding |
| S10 | Several WLANs per radio (multi-BSS) | Real controllers serve several SSIDs | 2 | M12 | W5 wireless | One WLAN per radio (two radios → two WLANs) |
| S11 | WPA2/WPA3-Enterprise (EAP, RADIUS server, controller authenticator, station configuration) | Exam objective; costly | 3.5 | M12 | W5 wireless; W6 catalog | Enterprise security taught as theory |
| S12 | RF channel-overlap spectrum and co-channel pairs, airtime | Spec §9.8; the channel-planning lesson | 2 | — | W5 wireless; W6 web-inspector | Channel planning uses the existing channel labels and rates |
| S13 | Home-router NAT switch in its panel | Closes a P1 gap (§12.2 of the P1 brief) | 0.7 | M11 | W6 web-inspector | Home routers stay non-translating |
| S14 | State-machine history strip (§9.5) | Makes STP/DTP/LACP/CAPWAP transitions readable | 1.5 | D19 | W0 stub; W6 web-inspector | Transitions visible only in debug output and tables |
| S15 | Convergence measurement and the `convergence` lab kind | "Tune the timers and see the number drop" | 1.5 | S1 or D19 | W1 timeline; W5 sim; W6 web-timeline | Convergence is read off timestamps by hand |

### 8.3 COULD — defer unless approved (≈ 15 ew, plus deferrals)

| # | Feature | Cost | Why it waits |
|---|---|---|---|
| C1 | VTP v1/v2 (v3 deferred) | 2.5 | Not on the current exam blueprint; the VLAN database works without it |
| C2 | MST | 3 | Conceptual in CCNA; PVST+/Rapid cover the labs |
| C3 | Compare mode (two timeline positions, table diff) | 1.5 | Needs S1; the tables already flash changes |
| C4 | Bookmarks, deep links (`/?lab=…&t=…&focus=…`), `activity.json` session restore | 1.5 | Needs S1; no URL routing exists (vercel.json has no rewrites) |
| C5 | Roaming between APs | 2 | Needs M12 and two LAPs; conceptual in CCNA |
| C6 | FlexConnect local switching | 1.5 | Conceptual in CCNA |
| C10 | L3 port-channels, long path-cost method, BPDU filter, port-security ageing | 2 | Beyond the core labs |
| C11 | `rf-interference` / `radio-fade` faults (the unimplemented P1 `injectNoise` hook) | 1 | Troubleshooting extras |
| — | DFS and 6 GHz extras, RF heatmap, 802.11r, IPv4 fragmentation beyond the MSS clamp, CDP/LLDP, VTP v3 | defer | Physical view / P3 material |

### 8.4 Recommendation

- **Plan for MUST + S1, S2, S3, S4, S6, S7, S9, S14 ≈ 65 ew.**
- If the budget is tight, cut in this order: C (all), S11, S10, S12, S15, S13, S8, S5, S14, S3, S4, S9, S6, S2, S1.
- Only then touch MUST, starting with M12.
- Every bracketed item in §7 is its own item, so every cut removes whole wave items, and a SHOULD block that is not
  approved is never added to the contracts (§0 rule 3).

### 8.5 Decision record (product owner, before wave 0)

Wave 0 cannot start until these are recorded here; the architect then adds exactly the approved blocks, and the exit
gate (W8) checks the scope list item by item.

| # | Decision | Recommendation | Recorded |
|---|---|---|---|
| P1 | The SHOULD set built in P2 | S1, S2, S3, S4, S6, S7, S9, S14 | **approved as recommended** (S1, S2, S3, S4, S6, S7, S9, S14) — product owner, 2026-09-21 |
| P2 | The COULD set | none (each can be approved later, W7) | **none** for now (as recommended) — 2026-09-21 |
| P3 | Spanning tree on by default in new worlds (P2 profile) | yes; CCNA 1 lessons and every old file keep classic defaults | **yes** — 2026-09-21 |
| P4 | Wireless controller depth | MUST as specified: CAPWAP join, controller interfaces, personal-security WLANs, central switching, association at the AP (a listed simplification); enterprise security (S11) and several WLANs per radio (S10) not in the first cut | **core set, as recommended** — 2026-09-21 |
| P5 | Time travel in the first cut | yes (S1), built in parallel with the core; the first recommended SHOULD to cut if time runs out | **yes**, first SHOULD to cut under pressure — 2026-09-21 |
| P6 | HSRP | SHOULD S2 with a lab (the spec lists it in CCNA 2) | **yes** (S2 with a lab) — 2026-09-21 |
| P7 | NAT in P2 | yes (M11), as the spec says, pulling standard ACL matching forward | **yes** — 2026-09-21 |
| P8 | VTP | taught as theory in lesson 05 (modes, revision-number risk); the protocol (C1) not built | **theory only, as recommended** — 2026-09-21 |
| P9 | Multilayer switches in P2 worlds start with routing off (`no ip routing`) | yes (matches the lab habit of typing `ip routing`) | **yes** — 2026-09-21 |
| P10 | **Scope list for the exit gate** ("CCNA 2 complete" for this stage) | M1–M15 plus the approved SHOULDs; every other §2.2 / §19 item recorded as theory-only or deferred with its stage (§11.4, §12.1) | **approved**: M1–M15 + S1, S2, S3, S4, S6, S7, S9, S14 — 2026-09-21 |

---

## 9. Migration list

Every existing test or golden that P2 deliberately changes, with how, by wave. Anything not listed must stay green
unchanged; a failure outside this list is a defect in the change, not a migration. Replacing an exact assertion
(`toEqual`, `toBe`) by a weaker one (a superset or `toContain` check) is never a migration: every entry below keeps
the assertion's strength and states the new exact value (or the rule that computes it).

### 9.1 Asserted unchanged (and why they stay green)

- `goldens/accept.p05.p0-sequences.json` via `accept.p05.determinism.test.ts:176-205` — the P1 profile replays
  nothing; the eth-switch VLAN-1 debug text is byte-identical (§3.0, proven before the flip by the parity test on
  `p2.world`); new daemons are silent, open no socket, log nothing and write no rows.
- `sim.two-pcs-switch` (ping at 40 s, `drops == []`, CAM size 2), `sim.pc-router-pc`, `review-determinism.probe`,
  `accept.p1.silence`, every `accept.p05.*` and `accept.p1.*` test.
- `l2.eth-switch.test.ts` (StateView `toEqual` at :161, config deltas ignored at :330-337): its fixture model is not
  VLAN-aware (no `vlan` daemon), and the transparent path is today's code. Its assertions are unchanged; its typed
  `ProcessCtx` literal gains the `P2_CTX` spread (§9.2 item 7).
- `device.virtual.test.ts:115-148` (Vlan1 of `mlswitch.nfc3650-24` down with `['no-bridged-port-up']` at :147): the
  VLAN-aware SVI rule keeps the P1 reason (§3.0).
- `device.catalog.define.test.ts:136-152` (a P0.5-stage `layer3-switch` fixture: capabilities
  `['switching','routing','layer3-switch']`, `L3_SWITCH_VLAN_FAMILY`) and `l2.eth-switch.svi.test.ts:45-87`: no
  implication changes and VLAN awareness is keyed on the stage-derived `vlan` daemon (D5).
- `protocols.registry.test.ts:44-50`: the registry and `PROCESS_ORDER` grow together, in the same change (§0 rule 3).
- `ip.ipv4.test.ts:403-409` (ipv4 `handles` and fresh snapshot): no new selector; new snapshot members appear only when
  non-empty.
- `arp.host.test.ts:105-118` (`ip route 0.0.0.0 0.0.0.0 10.0.0.9` installed with no C row in the fake RIB): the D13
  usable rule asks `ctx.connectedPortFor` first, which the fake answers. If the fake's port is not answered, the fake
  gains the connected port (a fixture change), never a weaker assertion.
- `core.rib-arbiter.test.ts:139`: `maxPaths` defaults to 1.
- `device.ports.test.ts:263-266`: the pure rule without injected lookups is the P1 rule.
- `config-ast.sections.test.ts:138-146` and every other config-AST test: without `defaults`, `apply` behaves exactly
  as today (§5).
- `dns-client` tests: a lease without `family` behaves exactly as today (§2.5).
- `link.air`, `wifi.assoc`, `accept.p05.wifi-home-router` (provenance order :83-106), `accept.p05.mobility`: BSS
  index 0 keeps its ids, bytes and stream labels; central switching is opt-in; `wlan.grant` is sent only for central
  BSSs.
- `device.catalog.wireless-wan.test.ts:108-140` ("the controller is an end system with a host shell"): NF-WLC-3504
  keeps its P1 behaviour (D17): capabilities, shell, GUI, host ports and IP defaults are unchanged; only its derived
  `processes` list moves, gaining the silent `dhcpv6-client` like every host model (§9.2 items 13 and 20c).
- `apps/web/test/canvas.overlays.test.ts:215-218` (the six wireless overlay keys): P2 overlays use a new slice.
- `apps/web/test/hotkeys.test.ts:141-143, 155-157`: no dock tab and no `DOCK_STAGE` change.
- `curriculum.test.ts:77-78, :121-126, :160-162` until W7: the CCNA 2 skeleton stays detached from
  `curriculum/index.ts` (§7 W1 course).

### 9.2 By wave

**W0 (architect)**
1. Web exhaustive records gain stub entries (`DROP_VOCAB` +4, `PROTOCOL_VOCAB` +6 plus one per approved SHOULD
   proto, `CAPABILITY_VOCAB` +3, `GUI_PANEL_VOCAB`, `PANEL_TAB`, `SURFACE_PANEL_TAB` +1); engine `GUI_PANEL_SINCE` and
   the define.ts panel record +1. `vocab.test.ts` assertions unchanged; the new entries must satisfy them (unique
   letters, no banned words).
2. Comment-only retag `@since P2` → `@since course` (10 web occurrences, `contracts/curriculum.ts` header).
3. New golden `test/goldens/p1-profile-digests.json` (a new file, recorded from the unchanged engine; §9.3 governs
   every later change to it).

**W1**
4. `pdu.codecs.test.ts:57` registry key order: the P2 codecs are appended after the P1 codecs, in the order
   dot1q, stp, lacp, dtp, dhcpv6, capwap (then approved SHOULD codecs in S-number order).
5. `pdu.codecs.link.test.ts:564-567` ("rejects non-SNAP headers"): non-SNAP LLC is now valid and dispatches on the
   DSAP (§2.3). The case keeps its strength with new exact values: `42 42 03 …` decodes with no error to
   `llc {dsap: 0x42, ssap: 0x42, control: 3}` whose `next` is `stp`; a second case `f0 f0 03 …` (an unregistered
   SAP) decodes with no error to `llc {dsap: 0xf0, ssap: 0xf0, control: 3}` with `next` undefined. The truncation and
   range assertions (:566-568) are unchanged.

   5b. `pdu.codecs.transport.test.ts:124` — the P1 `udp6` fixture (:75) builds its datagram with `srcPort = 547`
   and `dstPort = 546`, which were free port numbers in P1 and are the DHCPv6 ports in P2 (`udp.port` 546 and 547 →
   `dhcpv6`, §2.3), so the inner layer of the decoded frame is `dhcpv6`. Same assertion strength (`toEqual`), new
   exact value: `['ethernet', 'ipv6', 'udp', 'dhcpv6']`. **Only the dispatch changed, not the bytes**: the golden hex
   `02230222000c9c1601020304` at :126, `checksumValid === true`, the independent RFC 8200 §8.1 pseudo-header check and
   the zeroed-checksum assertion are all byte-identical and unchanged. The fixture's ports are NOT renumbered — that
   would move an independently computed P1 golden. The two other `udp6` users (:384 hop-limit mutate, :391 `ipv6.src`
   re-encode) assert provenance and `udp.checksumValid`, which the extra layer does not disturb, and are unchanged.
   `accept.p2.p1-digests` is unaffected: no P1-profile scenario sends UDP 546/547. Owner: W1 pdu (the dispatch rows
   themselves are architect-owned, `contracts/fields.ts:483-484`, added in W0/W1).
6. io (`TOPOLOGY_SCHEMA_ID` stays exported and equal to 1.1; migration brings a document to `schemaIdFor(t)`, so a
   1.0 document still becomes 1.1):
   - `io.migrate.test.ts:157-160`: `TOPOLOGY_SCHEMA_ID` is 1.1 (unchanged); `LATEST_TOPOLOGY_SCHEMA_ID` becomes
     `'netforge.topology/1.2'` (`toBe`); `TOPOLOGY_SCHEMA_IDS` `toEqual` `[1.0, 1.1, 1.2]`.
   - `:163-171` (1.0 → 1.1) and `:173-178` (a 1.1 document keeps its content) unchanged; `:180-193` (every step
     reaches the latest id) unchanged in code and now also walks 1.1 → 1.2.
   - `:194-197` and `io.netforge-file.test.ts:354`: the messages list three ids
     (`… netforge.topology/1.0, netforge.topology/1.1, netforge.topology/1.2` / `must be one of "…1.0", "…1.1",
     "…1.2"`), same regular-expression strength.
   - `io.schema.test.ts`: the wrong-schema message lists three ids. P1 documents still export as 1.1, byte-identical.
7. Required runtime members (W1 device: `ProcessCtx.profile`, `ProcessCtx.transition`, `DeviceRuntime.profile`,
   `DeviceRuntime.errDisablePort`): the typed fakes gain the `P2_CTX` / `P2_DEVICE` spreads, assertions unchanged —
   `l2.eth-switch.test.ts:94`, `ip.fake-ctx.ts:166`, `arp.harness.ts:139`, `l4.udp.test.ts:133` (`ProcessCtx`
   literals), `cli.runtime.fake.ts:167`, `cli.runtime.p05.fixture.ts:53` (`implements DeviceRuntime`). Any other
   typed fake the compiler finds gets the same spread and is named in the wave report.
8. Config rules: the bare `switchport` rule matches only the one-token line; `ip routing` becomes `bothForms`. No P1
   test contains a `switchport <x>` line or `no ip routing`, and no test pins that `ip routing` is dropped;
   `config-ast.sections` "no switchport persists" stays green unchanged. `goldens/cli-help.p1.json` is added as a
   frozen copy of today's `cli-help.p05.json` (a new file).

**W2**
9. Static-route install time moves from configuration to "when usable" (D13). The P0 golden scenarios have no
   `ip route`. `ip.ipv4.test.ts:122-232` is expected to pass unchanged because its fixtures' next hops are connected;
   if one is not, the fixture gains the connected route and the assertions stay as they are. The l3 owner also greps
   for a test that configures two `ip route` lines for one prefix expecting the second to replace the first (none
   known) and reports it. The P1-profile digests that move are §9.3 (a).
10. `setPortAdmin(false)` clears `errDisabled`. `device.ports.test.ts:225-229` (power-off reset) is unchanged; no test
    pins "shutdown keeps err-disable".
11. Drop events gain `background: true` for background PDUs. `link.p2p.test.ts:443` drops a non-background PDU and is
    unchanged; `device.pipeline.roles.test.ts:141, 199` compare verdicts, not trace events, and are unchanged. The
    device and media owners grep for `toEqual` on a drop event of a keepalive or beacon and list each one here, with
    the key added to its expected object. The P1-profile digests that change are §9.3 (b).
12. Help lists (W2 cli, and again W3 cli, for the router lines those waves add): `goldens/cli-help.p05.json` is
    regenerated, guarded by `cli.help-superset.test.ts` against the frozen P1 copy. The exact inline lists of
    `cli.grammar.help-goldens.test.ts:58-59` (`router.nf2911` `config-if ethernet/routed` and `config`) are rewritten
    as complete literal arrays, still `toEqual`, by the owner of the wave that changes them: W3 adds `access-list` to
    `config`; W2 adds `encapsulation` to `config-if ethernet/routed` only if the grammar offers it there; [S2] W3 adds
    `standby`. Each regenerated file and array is listed in the wave report.

    12b. `cli.modes-rules.test.ts:62` — §2.11's removal of `reserved` from `MODES['config-subif']` and
    `MODES['config-vlan']` is **deferred from W0 to the W2 cli item**, together with `config-if-range`: dropping the
    flag in W0 would have made `modesOfClass('config')` grow while no grammar can reach the modes, and W0 has no
    migration for this line. The W2 cli item drops the three flags in the change whose grammar enters them, and
    updates this assertion with the same strength (`toEqual`) and the complete new literal array in MODES declaration
    order: `['config', 'config-if', 'config-line', 'dhcp-config', 'config-subif', 'config-vlan', 'config-if-range']`
    (`config-router` stays reserved — no P2 grammar enters it). Because `contracts/cli.ts` is architect-owned (§7 W0),
    lines 485-486 and 492 are an **explicit, architect-approved exception to one-owner-per-file**: removing those
    three `reserved: true` flags (and the now-stale part of the comment at :487-491, and the note at `cli/modes.ts`
    :183-184) is the only edit the W2 cli item may make in that file. W3 cli (`config-dhcpv6`, `config-std-nacl`) and
    W5 cli (`config-wlan`, `config-wlc-if`) do the same for the modes they enter, each appending its mode to this
    array, in declaration order, in its own change.

**W4 (catalog flip)**
13. `CATALOG_STAGE = 'P2'` and the derived lists, additive edits with exact values:
    - `device.catalog.test.ts:30` `NF_PC.processes` `toEqual` `['arp','ipv4','icmpv4','host','ipv6','nd','icmpv6',
      'udp','tcp','dhcp-client','dhcpv6-client','dns-client','http-client','traceroute']`;
    - `device.catalog.test.ts:64` `NF_2911.processes` `toEqual` `['hdlc','arp','ipv4','nat','icmpv4','ipv6','nd',
      'icmpv6','udp','tcp','dhcp-client','dhcp-server','dhcpv6-client','dhcpv6-server','dns-client','dns-server',
      'http-server','traceroute']` (with S2, `'hsrp'` after `'tcp'`);
    - `device.catalog.test.ts:45`, `device.catalog.network-data.test.ts:76-77`, `device.catalog.define.test.ts:130`,
      `device.catalog.data.test.ts:77, 84`, `device.catalog.end-devices.test.ts:124, 130, 138, 145, 163`: the same
      insertions at their final `PROCESS_ORDER` positions;
    - managed switches (the five L2 NF-C29xx/NF-C9200 models, multilayer and data-centre switches) gain processes
      `vlan, dtp, etherchannel, stp` and tables `vlans, port-security, dtp, stp, stp-bridge, etherchannel`;
      multilayer and data-centre capabilities gain `managed-switch` (listed in their data, D5);
    - every model with `routing` (routers, multilayer and data-centre switches, home routers through `nat-gateway`,
      firewalls) gains `nat, dhcpv6-client, dhcpv6-server` (and `hsrp` with S2) and tables `nat, dhcpv6-bindings`;
    - every model with `host` (end devices, servers, the IP phone) gains `dhcpv6-client`.
14. `protocols.registry.test.ts:55` (the exact `PROCESS_FACTORIES` map) gains `vlan`, `dtp`, `etherchannel`, `stp`,
    `nat`, `dhcpv6-client`, `dhcpv6-server` (and `hsrp` with S2) mapped to their factories — the same exact
    `toEqual`; :44-50 unchanged.
15. `review-p1-catalog.management-vlan.test.ts:56-65`: the `MANAGED` list splits. Managed switches pin
    `{family:'Vlan', …, max: 4094, defaultAdminUp: false, auto: [1]}`; APs and learning bridges keep `max: 1`.
16. `device.virtual.test.ts:150-165` ("an SVI other than Vlan1 stays down and logs why"): NF-C3650 is now VLAN-aware.
    Vlan10 stays down with reason `vlan-missing` and the log `Interface Vlan10 stays down: VLAN 10 does not exist.`
    Then, after `vlan 10` and an up access port in VLAN 10, it comes up (a new assertion in the same test). The old
    message (`vlanUnsupportedMessage`) remains for devices that are not VLAN-aware.
17. `goldens/cli-help.p05.json` regenerated for the switch models (managed-switch grammar); the superset guard holds.
18. `cli.parser.grammar.test.ts` `EXPECTED_IDS` becomes the union with the P2 fragments (listed literally);
    `DEBUG_CATEGORIES` grows through the registry.
19. `apps/web/test/tabs.test.ts:173` (switch table sections) gains the P2 tables, listed literally.
20. Any test that pins a whole switch or router `DeviceSnapshot` with `toEqual` gains `tables.extra` and the new
    StateViews (additive, listed literally). The catalog owner greps `toEqual(` on snapshots of NF-C2960 / NF-C3650 /
    NF-2911 and lists each one in the wave report. (The P1 digest test normalises these away, §10.1.)

**W4 close-out (2026-09-23): confirmed findings of the W4 review, applied with exact values, assertions unchanged
unless stated**

20a. Fixture pins. The flip registered every P2 factory, so the `p2.world` helpers that passed only the daemons under
     test gained dtp, etherchannel and stp. Each helper is pinned to the world it was written for with the
     `undefined` overlay: `lag.harness.ts` `lagWorld` → `{vlan, etherchannel, stp: undefined, dtp: undefined,
     ...factories}`; `l2.eth-switch.p2.harness.ts` `VLAN_AWARE_MODEL` → `p2Registry({vlan, dtp: undefined,
     etherchannel: undefined, stp: undefined})`; `trace.pdu-vlan.test.ts:37` → `{vlan, dtp: undefined}`;
     `stp.instances.test.ts:129` → `stpWorld(3, 'P1', {...STP_FACTORIES, dtp: undefined, etherchannel: undefined})`.
     `STP_FACTORIES` itself is NOT pinned: it is the default world of `accept.p2.stp-*`, which must keep equalling the
     real catalog (§10); `stp.guards.test.ts` passes with dtp present once the DTP defect is fixed (§3.3 rule 1a).
20b. Tests that used the live catalog as "the P1 switch" or "a model without profile lines": the negatives
     `cli.vlan.test.ts:164`, `cli.stp.test.ts:140`, `cli.switchport.test.ts:295` and `:316-319` use
     `p1SwitchModel()` = `defineModel({...NF_C2960_INPUT, capabilities: ['switching']}, 'P1')` (`test/cli.p2.fixture.ts`;
     the stage alone is not enough, the P2 lines are scoped by the stage-independent `managed-switch`);
     `sim.snapshot-l2.test.ts:81` passes `catalog: createCatalog(PROCESS_FACTORIES, {models:
     ALL_MODEL_INPUTS.map((i) => defineModel(i, 'P1')), stage: 'P1'})`; `device.profile.test.ts:28` builds
     `PLAIN_MODEL` from NF_C2960 without its `profileConfig` and `stpDefaultMode`.
20c. `device.catalog.wireless-wan.test.ts` (the wireless, home, radio and WAN data are authored for stage P2 since the
     flip, as `device.catalog.data.test.ts:84-93` requires): `:49` validates the P1-derived inputs at 'P1' and the
     exported arrays at 'P2' (as `device.catalog.network-data.test.ts:36-40`); `:133` NF-WLC-3504 `processes` gains
     `'dhcpv6-client'` after `'dhcp-client'` (item 13; it keeps its P1 behaviour, §9.1, D17); `:146` the home routers'
     `processes` are `['wlan-ap', 'hdlc', 'eth-switch', 'arp', 'ipv4', 'nat', 'icmpv4', 'host', 'ipv6', 'nd', 'icmpv6',
     'udp', 'tcp', 'hsrp', 'dhcp-client', 'dhcp-server', 'dhcpv6-client', 'dhcpv6-server', 'dns-client', 'dns-server',
     'http-server', 'traceroute']`.
20d. Item 18, `DEBUG_CATEGORIES` through the registry: a routing model's `debug ` list gains `'standby'` after
     `'ipv6'` (`cli.parser.help.test.ts:129`, `cli.grammar.p05.test.ts:178`, `cli.stp.test.ts:456`) and its
     `debug ip ` list is `['icmp', 'nat', 'packet', 'routing']` (`cli.parser.help.test.ts:130`).
20e. Items 17 and 18, the fold: the P2 fragments join `GRAMMAR_FRAGMENTS` after the P1 ones (in
     `P2_GRAMMAR_FRAGMENTS` order), `P2_HANDLERS` joins `HANDLERS`, and `BUILTIN_GRAMMAR` is `GRAMMAR`. Pins moved,
     each with its exact new value: `cli.parser.grammar.test.ts` `EXPECTED_IDS` += the 77 P2 ids (listed literally)
     and `:103-106` += `vlan, switchport-p2, subif, routing, spanning-tree, etherchannel, port-security, errdisable,
     nat, acl, dhcpv6, hsrp`; `cli.grammar.help-goldens.test.ts:58-59` (item 12: router `config-if ethernet/routed`
     += `encapsulation`, `standby`; `config` += `access-list`); `cli.parser.help.test.ts:61` (config +=
     `access-list`), `:63` (config-if += `encapsulation`, `standby`), `:73` (show += `access-lists`, `standby`),
     `:80` (`show ip ` += `nat`), `:141` (`no ` += `encapsulation`, `standby`); `cli.grammar.p05.test.ts:167` (serial
     += `standby`), `:168` (gigabit += `encapsulation`, `standby`), `:263` (router show += `access-lists`,
     `standby`); `cli.vlan.test.ts:171-182` and `cli.stp.test.ts:427-431` pin the folded table (the P1 keys then the
     P2 keys, every P2 id in `HANDLERS`, `BUILTIN_GRAMMAR === GRAMMAR`). `goldens/cli-help.p05.json` regenerated: 64
     listings gain tokens and none loses one (the superset guard holds). Open question for the architect: the W3
     `standby` scope (`L3_PORT`) also offers `standby` on the NF-2911's serial WAN ports. **Architect ruling
     (2026-09-23):** a standby group needs a shared multi-access segment on which a virtual MAC can answer ARP, so the
     `standby` interface lines are scoped to the roles `routed`, `subif` and `svi` only (not `wan`, which holds the
     point-to-point serial links, and not `virtual`/`mgmt`), with one original mismatch message that also points a
     switch port at `no switchport`. `show standby` and the `standby` debug category keep their capability scope.
     Owner: §7 W5 **cli**, in the same change as `cli.wlc` (it regenerates `cli-help.p05.json` anyway): the serial
     listings of `cli.grammar.p05.test.ts:167` lose `standby` again, and `cli.hsrp` gains the serial and loopback
     refusals.
20f. New golden `test/goldens/p1-template-exports.json` (a new file): the startup text every template device exports,
     recorded from the pre-P2 engine (commit 7e623b9) and byte-identical to this engine's. `accept.p2.profile` compares
     every template export with it, so a config-rule or renderer change cannot move a P1 export unseen (the
     `asP1Export` expectation is rendered by the store under test). Never regenerated to make a test pass.

**W5**
21. `labs.solutions.test.ts:69-71` and `accept.p1.labs.test.ts:47-49`: "the CCNA 1 labs are the tail of `SCENARIOS`"
    becomes "templates, then `CCNA1_LABS`, then `CCNA2_LABS`" (index checks, same strength).
22. The lab-check clone re-applies err-disabled ports and scheduled `after` faults. CCNA 1 labs have neither, so their
    results are unchanged.

**W5 close-out (architect, 2026-09-24): rulings on the W5 review**

22a. `show vlan` wrap: the §7 W5 cli ruling is restated as "every line fits 80 columns" (wrap = 80 minus the Ports
     column's start, never below 20; `VLAN_TABLE_WIDTH`, `VLAN_PORTS_MIN_WRAP` in `cli/handlers/vlan.ts`), applied by
     the architect: `cli.vlan` pins the 11-line layout of its fixture and gains a case with a 32-character VLAN name.
22b. CAPWAP AP identity (review finding #13). **Interim, shipped in W5:** capwap-ac refuses a newcomer's Discovery and
     Join (result 1) while another device is joined under the same Ethernet source at another address, so two APs
     behind one router no longer evict each other (one joins, one waits). **Proper fix, owner §7 W6 wireless (with a
     reviewed additive edit in the pdu owner's `pdu/codecs/capwap.ts`):** the Discovery and Join Requests carry the
     AP's base MAC (`wtpMac`, NF vendor element 3 — the role the WTP Board Data element plays in RFC 5415); capwap-ac
     keys its sessions and `capwap-aps` rows by `wtpMac`, never by the Ethernet source; the interim refusal is
     removed; `capwap.join` gains two APs behind one router, both reaching `run`. The W7 wireless lab keeps its APs
     in the controller's management VLAN, so it does not depend on this.
22c. A wrong EtherChannel answer (one side `mode on`, the other LACP with lone members) keeps sending topology-change
     notices that the neighbour acknowledges on an inferior port, which 802.1D ignores — faithful behaviour for that
     misconfiguration. The world never idles, so grading that wrong answer runs each clone to its 200 000-event cap
     (about 17 s). Accepted for P2 (the guard that would err-disable such a bundle is [S5], not approved). W6
     web-learn shows a busy "checking" state while a lab check runs, so a long check does not look like a hang.
22d. Accepted as built: the `debug capwap` category the W5 cli item added (original wording; §5.4 gains it).
     Recorded for later, not changed: the device pipeline ignores the `frame: 'data'` demux selector (wlan-ap's
     workaround is correct; W8 reconciles the contract); the trace filter has no VLAN key; a multilayer switch relays
     DHCP with `no ip routing` (fidelity backlog, P3); grader limits met by the labs — `cut` removes every cable
     between two devices, `connectivity` pings a device's first address, no TCP check (P3).
22e. Suite health, for the W8 gate: the `accept.p2.loop-storm-bounded` P1 case (one simulated second at line rate on
     five links) takes 2–5 minutes alone and far longer on a throttled machine — past its nominal 300 s budget,
     which vitest cannot enforce on a synchronous test; W8 decides whether the §10.1 row keeps `runFor(1 s)` or
     scales its bound to a shorter window. The two "always-post rule while paused" cases of `worker.delta` fail at
     full parallelism on a loaded machine (the first overruns its 5 s budget and its tail posts into the second);
     they pass alone and with `--maxWorkers=4`, and the worker code is unchanged since W4. Neither is a W5 regression.

**W6 (wireless catalog)**
23. `device.catalog.data.test.ts:120` (ap.nfap-lw gains `lightweight-ap`, processes `capwap-wtp, udp, dhcp-client`,
    table `capwap`, `profileConfig`, listed literally) and `:169` (NF-WLC-3504: category `legacy` and its new
    description; capabilities, processes and ports unchanged); a new pin for `wlc.nfwlc9800` (capabilities,
    processes `eth-switch, vlan, arp, ipv4, icmpv4, host, udp, capwap-ac` as derived, `cli.shell: 'none'`, GUI
    `wlc.controller`, four GigabitEthernet0/x ports and a console, auto `Capwap0`); any test pinning the model list or
    palette order (for example `accept.p05.catalog.test.ts`) gains `wlc.nfwlc9800` at its palette position and moves
    NF-WLC-3504 to the Legacy group — each listed literally in the wave report.
24. `protocols.registry.test.ts:55` gains `capwap-wtp` and `capwap-ac` (and `radius-server` with S11), exact `toEqual`.
25. `goldens/cli-help.p05.json`: ap.nfap-lw entries gain the `capwap` lines and a `wlc.nfwlc9800` entry is added (the
    superset guard holds: nothing disappears). NF-AP-1832's description loses "until wireless controllers are
    simulated".
26. [S13] `apps/web/test/inspector.panels.test.ts` stops pinning the home router's "next stage" DHCP note.
27. [S11] `apps/web/test/tabs.test.ts:351` (`WIFI_PHASES`) gains `eap`.

**W7**
28. `packages/engine/test/curriculum.test.ts:70-85`: CCNA 1 and CCNA 2 `available`, CCNA 3 `planned`. The planned-course
    pins (:77-78, :121-126, :160-162) are unchanged in code and now hold for CCNA 3 (every CCNA 2 lab exists by W7).
    New CCNA 2 pins are added as new tests.
29. `apps/web/test/learn.landing.test.ts:62-72`: `not.toContain('Start CCNA 2')` becomes `toContain`; the "planned"
    fixture becomes CCNA 3.

### 9.2b Acceptance cases deferred to W5 (architect, 2026-09-23)

Two §10 acceptance cases are skipped in W4 because the item that makes them possible belongs to W5, not because of an
engine defect. Each carries its cause in the `it.skip` title, and the W5 owner named here MUST un-skip it in the same
change that lands the item; the W8 exit gate checks that no `it.skip` is left in `accept.p2.*`.

| Case | Blocked on | Un-skipped by |
|---|---|---|
| `accept.p2.profile` — `no capwap enable` on the NF-AP-1832 holds in the live world, the reload and the clone | `capwap enable` has no CLI grammar before W5 | §7 W5 **cli** (`cli/grammar/wlc.ts`) |
| `accept.p2.static-routing` — the `route` lab assertion picks a /24 over a /16 | `sim/lab-checks.ts` does not implement the `route` LabAssertion kind yet | §7 W5 **sim** (new `LabAssertion` kinds) |

---

### 9.3 P1-profile digest changes (the only ones allowed)

`test/goldens/p1-profile-digests.json` (W0) stores, per `SCENARIOS` entry, the per-event `p0EventLine` digests of every
event kind and a normalised snapshot hash. It may change only as listed here; the architect regenerates the affected
entries and attaches the per-event diff to the wave report, and a regeneration is accepted only when **every** changed
event is of the listed kind:

| | Wave | Scenarios | Changed events, and nothing else | Why |
|---|---|---|---|---|
| (a) | W2 l3 | the templates whose startup configs hold `ip route` (templates.ts:268, :281, :318) and the CCNA 1 labs with static routes (ccna1/routing.ts:232-234, :451; ccna1/services.ts:159, the relay lab) | the rib `tableWrite` of each `S` row **and its companion `debug` line (`add S … via …`, ipv4, category `ip routing`)** move from boot to the dispatch in which its next hop becomes usable (and their order among that dispatch's rib writes); the row's `updatedAt` follows (multilayer-routed-port: mls1's row 40 s → 45 s), so the device's snapshot hash moves with it | D13: a real router installs a static only when its next hop resolves; every frame, ping and `show` output of the script is unchanged. **Applied after W2** (2026-09-21): the recorded diff was exactly 36 `tableWrite` + 36 `debug` lines per world set, same event counts, no other kind — worlds three-routers, serial-pair, multilayer-routed-port, ccna1-traceroute-path, ccna1-dhcp-relay re-recorded |
| (b) | W2 device | every scenario whose script drops an HDLC keepalive or a beacon | those `drop` events gain `background: true` | the canvas and sim-mode list must be able to hide background drops (§2.7) |

Everything else — the W4 and W6 catalog flips, the air changes of W5, `ctx.radioSettings`, the new daemons — must
leave every digest byte-identical; the lead proves it by running the test inside those changes.

---

## 10. Acceptance tests

Definition of done for P2:

- the five checks green and gate G passed on the final build;
- no test deleted or weakened; the exit gate applied;
- `accept.p2.p1-digests` green with only the §9.3 changes;
- every acceptance scenario run 3× with the same seed gives byte-identical trace and snapshot JSON;
- the legal scan clean.

Times below are sim time. "Link-up" is the `linkState up` event of the cable in question. From W4 the wired tests
build their worlds with `createP2Simulation` (`test/p2.world.ts`, §0 rule 13), which equals the real catalog once the
flips have landed.

### 10.1 Engine acceptance (`packages/engine/test/`)

| Test | Scenario and pass condition |
|---|---|
| `accept.p2.p1-digests.test.ts` (W0) | For every `SCENARIOS` entry (templates, and CCNA 1 labs with their solution applied), a fixed script: boot, the solution lines, one ping and one `show` per lab, `runFor(600 s)`. The per-event `p0EventLine` digests over **all** event kinds (debug and log included, no tolerated additions) and a snapshot hash equal `goldens/p1-profile-digests.json` exactly. The snapshot is normalised before hashing by one fixed rule written in W0: StateViews of P2 daemons and tables whose descriptor is `since: 'P2'` are removed, and so are the P2 members of model-derived lists. §9.3 lists the only allowed changes. |
| `accept.p2.silence.test.ts` | (a) Every template and every CCNA 1 lab (P1 profile), 600 s: no `pduCreated`, `tableWrite`, `tableExpire`, `log` or `debug` event attributable to `vlan, dtp, stp, etherchannel, nat, hsrp, dhcpv6-client, dhcpv6-server, capwap-wtp, capwap-ac, radius-server` (including `sockets` rows those daemons own); no `tableWrite`/`tableExpire` on a P2 table; no drop with a P2 reason; no `Process … is not available` log. (b) A P2-profile world NF-C2960 + 2 PCs with no configuration, 600 s: the only P2-daemon PDUs are BPDUs (tag `bpdu`, background), no DTP/LACP/HSRP/DHCPv6/CAPWAP PDU, and every BPDU that reached a PC was dropped `not-for-me` with `background: true`. (c) A P1 world with an NF-AP-1832 whose Vlan1 has a static address and no `capwap enable`: no CAPWAP PDU and no `capwap` row in 600 s. |
| `accept.p2.profile.test.ts` | `createSimulation({seed})` has profile P1. Every template exported after load deep-equals its build output with schema 1.1 (unchanged P1 guarantee). A 1.1 document carrying `profile: 'P2'` loads as P1; the same document with schema 1.2 loads as P2. In a P2 world: NF-C2960's running config contains `spanning-tree mode pvst` and `spanning-tree extend system-id`; NF-C3650 also `no ip routing`; NF-C9300 `spanning-tree mode rapid-pvst`; NF-2911 neither; NF-AP-1832 `capwap enable` and Vlan1 `ip address dhcp`. Export writes `profile: 'P2'` and schema 1.2, and reload gives an identical snapshot. **Completeness:** for every profile line, on each model that has it, type its reversal (`ip routing`; `no spanning-tree mode` on NF-C9300; `no ip address` and `no capwap enable` on NF-AP-1832), then export, reload, and build a lab clone: the running config, `Simulation`'s forwarding (a ping across the MLS) and the daemons' state are identical in all three; `no spanning-tree extend system-id` is refused with its message and stores nothing. `useCurrentDefaults` on a P1 world with two switches and a routing NF-C3650 gives profile P2, schema 1.2, `stp-bridge` rows after boot, and the NF-C3650 still routes (`ip routing` written). |
| `accept.p2.vlan-access.test.ts` | §3.1. PC1→PC2 ping 5/5; PC3→PC1 0/5 with drop `arp-unresolved` at PC3; SW1 CAM keys `10/<PC1 mac>` and `1/<PC3 mac>`; the echo request PC2 receives has PC1's PduId and byte-identical bytes; no `VlanTagPush`/`VlanTagPop` in any provenance; a frame tagged 20 injected on Fa0/1 drops `vlan-filtered`; after `no vlan 10` the ping fails with `vlan-filtered` detail `VLAN 10 does not exist`. **Access VLAN mismatch** (P2 profile): SW1 Fa0/24 (access VLAN 10) ↔ SW2 Fa0/24 (access VLAN 20), a VLAN 10 PC on SW1 and a VLAN 20 PC on SW2 in one subnet: after convergence the ping succeeds 5/5 and neither port is inconsistent. |
| `accept.p2.trunk.test.ts` | §3.2 (allowed `1,10,20,99` on both ends). Ping 5/5. The echo request's provenance contains exactly one `VlanTagPush {field:'dot1q.vid', before:null, after:10}` stamped SW1 with cause `switchport mode trunk` and one `VlanTagPop {before:10, after:null}` stamped SW2 with cause `switchport access vlan 10`, each immediately followed by `FcsRecompute`; PC2's frame bytes equal PC1's. VLAN 99 traffic has no dot1q mutation. A frame tagged 30 drops `vlan-filtered`. With `allowed vlan 10,20` an untagged frame on Gi0/1 drops `vlan-filtered` with detail `native VLAN 99 is not allowed on GigabitEthernet0/1`. **Native mismatch** (SW2 native 1) in the P2 profile: both switches log the mismatch message and their Gi0/1 `stp` rows for VLANs 1 and 99 have `inconsistent: 'pvid'`; the inconsistency clears after SW2 is set back to native 99. In the P1 profile PC3 (VLAN 1 on SW2) answers an ARP sent from a VLAN 99 host on SW1. |
| `accept.p2.dtp.test.ts` | All 25 mode pairs of §3.3 (access, trunk, desirable, auto, trunk + nonegotiate): 1 s after link-up, each end's oper mode equals the table. auto–auto and auto–access send zero DTP PDUs. After a negotiated trunk's peer is reconfigured to `access`, the dynamic port is `access` within propagation + 1 s (the access port's one DTP frame). A Port-channel of two `dynamic desirable` members facing two `dynamic auto` members is a trunk; a member whose peer is set to access is `suspended` with reason `trunk negotiation differs from Port-channel1`. |
| `accept.p2.router-on-a-stick.test.ts` | §3.4. PC1→PC2 ping 5/5; the echo request's mutation reasons are exactly the §3.4 step 4 sequence as confirmed by the W1 `pdu.vlan.test.ts` derivation, with causes `encapsulation dot1Q 10`/`20` at R1; native `.99` frames cross untagged; `shutdown` on Gi0/0 brings both subinterfaces down with reason `parent-down`, removes their C routes, and the ping fails; a frame tagged 30 drops `encapsulation-mismatch`. |
| `accept.p2.svi-routing.test.ts` | §3.5 in the P2 profile: PC1→PC2 fails with drop `no-route` whose detail mentions `ip routing`; after `ip routing`, 5/5 with no dot1q mutation, **and a lab `connectivity` check PC1→PC2 passes in the grader's clone** (built from `exportTopology`); shutting Gi1/0/2 takes Vlan20 down with reason `no-bridged-port-up`. **Trunked host:** an L2 NF-C2960 joined to MLS1 by a trunk, PC4 in VLAN 10 behind it: PC4 resolves Vlan10's address and pings it 5/5 (the broadcast reached the SVI untagged). The same topology in the P1 profile forwards without `ip routing`. |
| `accept.p2.stp-pvst.test.ts` | §3.6 triangle, SW1 priority 4096: SW1 `isRoot`; exactly one alternate/blocking port, on the SW2–SW3 link at the switch with the higher bridge id; every root/designated port reaches `forwarding` with `stateSince − linkUp ∈ [30 s, 30 s + 10 ms]`; a PC broadcast reaches each other PC exactly once. Direct failure (cut SW3's root link at T): SW3's former alternate is forwarding at T + 30 s ± 10 ms. Indirect failure (cut SW1–SW2 at T): SW3's former alternate is forwarding in [T + 47 s, T + 50 s]. On each failure `stp-bridge.topologyChanges` increases and the root's TC window starts before T + 1 s. **TCN timing (architect ruling, 2026-09-23):** on the DIRECT failure the bridge that lost its root port has an alternate to promote, so its first TCN leaves at T. On the INDIRECT failure no bridge can send one at T — the root signals with the TC flag and never sends a TCN, the designated end of the cut has lost its only root port and claims the root role, and the alternate holder detects nothing until max age expires — so the first TCN leaves the former alternate holder when it converges, in [T + 47 s, T + 50 s]. The earlier wording ("the first TCN is sent at T") described only the direct case and is superseded. |
| `accept.p2.stp-rapid.test.ts` | Same triangle, `rapid-pvst`, with `spanning-tree portfast` on the PC ports: final roles as above; every port in its final state within 1 s of the last link-up, and **no inter-switch port ever waits on a forward-delay timer** — **(architect ruling, 2026-09-23)** a designated port arms `fwd:<vlan>:<port>` at link-up as the no-agreement fallback that 802.1w requires, and the agreement cancels it microseconds later, so the assertion is that every inter-switch port's `nextTransitionAt` is clear within 1 s of link-up and no such port transitions on a timer expiry, not that the timer is never armed (the same row's full-duplex host port without PortFast needs exactly that timer to reach forwarding at link-up + 30 s). The earlier wording ("no `fwd:` timer ever armed") is superseded; the SW2→SW3 proposal is answered by SW3's alternate port with an agreement. Direct failure: the alternate forwards at T + propagation (< 1 ms). Indirect failure: SW3's former alternate forwards before T + 1 s. A PC port **without** PortFast reaches forwarding at link-up + 30 s ± 10 ms. A half-duplex (hub-backed) link falls back to 30 s. **Mixed:** an NF-C2960 (pvst) linked to an NF-C9300 (rapid): the C9300's port shows `protocol: 'stp'` after the migrate delay and forwards 30 s after link-up; links between rapid switches still converge within 1 s; `clear spanning-tree detected-protocols` returns the port to `rstp` and it migrates back to `stp`. |
| `accept.p2.stp-guards.test.ts` | PortFast host port: forwarding at link-up; `spanning-tree portfast default` on an untouched switch (ports `dynamic auto`) makes host ports edge. BPDU guard: cabling a switch to a PortFast + bpduguard port err-disables it (`errDisabled: 'bpduguard'`) on the first BPDU. Root guard: a switch with priority 0 attached to a root-guard port puts that port `inconsistent: 'root'` and SW1 stays root; after it is removed the port recovers within 25 s (`runFor`). **Type:** a static trunk facing an access port puts the access port `inconsistent: 'type'` (blocking). |
| `accept.p2.stp-scale.test.ts` | P2 world: 8 NF-C2960 in a ring with two cross links, 20 VLANs, every inter-switch link a trunk, 10 access ports per switch up. After convergence, `runFor(60 s)` dispatches fewer than 100 000 events, no drop has detail `action-budget`, and the `stp-bridge` row of every VLAN names the same root on all 8 switches. |
| `accept.p2.loop-storm-bounded.test.ts` | A topology whose loop **multiplies** frames: two NF-C2960 joined by three parallel FastEthernet (100 Mb/s) cables, one PC on each, one broadcast. P1 profile (no spanning tree), `runFor(1 s)`: `queue-full` drops are present; at the end, on every P2P port, queued plus in-flight frames ≤ `P2P_QUEUE_LIMIT + 1` (memory bound); dispatched events ≤ `links × 2 × ⌈1 s / slot⌉ × P2P_EVENTS_PER_FRAME × 1.1`, where slot = 84 bytes × 8 / 100 Mb/s = 6.72 µs and `P2P_EVENTS_PER_FRAME` comes from the W1 media test (event bound = line rate). No fixed events-per-second constant. P2 profile: after convergence (`runFor(65 s)` first), the same broadcast gives zero `queue-full` drops and each PC receives it exactly once. |
| `accept.p2.etherchannel.test.ts` | §3.7 LACP active/passive: both members `bundled` within 3 s of link-up; Port-channel1 up; `show etherchannel summary` lists the bundle as in use with both members bundled; `stp` rows exist for Port-channel1 and none for Gi0/1–2. Load balancing: four PCs chosen (by device id) so that the §3.7 fold hash of their actual MACs maps to both members (a precondition the test asserts); each PC's frames leave on member `fold(mac) mod 2` (checked on member frameTx). Cutting Gi0/2: the bundle stays up; Port-channel1's `stp` row `cost` becomes 4; no role or state change, no topology change and no CAM flush on Port-channel1 in the next 60 s; a running ping loses at most the one in flight. passive–passive: all members `individual` with reason `no LACP partner` at link-up + 3 s, and a ping between the switches still succeeds over the spanning-tree path. Misconfiguration A: SW1's members `individual`, SW2's Port-channel1 up, no storm (the loop-storm event bound holds). Misconfiguration B: the member with a different access VLAN is `suspended` with a reason naming the difference. |
| `accept.p2.port-security.test.ts` | §3.8. Sticky learning emits one configChange with `switchport port-security mac-address sticky <mac>` and a CAM row `secure: 'sticky'`; PC1's next 5 frames forward, `violations` stays 0 and the secure row stays. `shutdown` mode: the violating frame drops `port-security`, the port has `errDisabled: 'psecure-violation'`, the link goes down, `show interfaces status err-disabled` lists it. `restrict`: `violations` equals the number of violating frames, the port stays up, one log per violation. `protect`: `violations` unchanged, no log. Recovery by `shutdown`/`no shutdown`. Recovery by `errdisable recovery … interval 30` (`runFor`): up at T + 30 s ± 1 ms, err-disabled again by the violator's next frame. With recovery configured and the violator still attached, `runToIdle` returns having dispatched fewer than 10 000 events. A lab connectivity assertion through the err-disabled port fails in the grader's clone. |
| `accept.p2.static-routing.test.ts` | Floating static `ip route 10.3.0.0 255.255.0.0 10.9.0.2 5` over a backup link: only the AD 1 route is installed while the primary is up; cutting the primary installs `[5/0]` in the same instant; restoring reverses it. A fully specified route works. A three-level recursive route resolves; a route whose next hop resolves only through itself is never installed. A static configured before its link is up is installed when the next hop becomes reachable, not before. IPv6: a static with a link-local next hop and an interface forwards; a floating IPv6 static takes over after a cut. The `route` lab assertion picks a /24 over a /16. |
| `accept.p2.dhcpv6.test.ts` | Stateless: messages exactly INFORMATION-REQUEST (11) then REPLY (7); PC1 keeps its SLAAC address and learns the DNS server; a dual-stack PC with a DHCPv4 lease lists both DNS servers, IPv4 first. Stateful: SOLICIT, ADVERTISE, REQUEST, REPLY in order; PC1 gets `2001:db8:1::2` with origin `dhcpv6` and prefix 128; one `dhcpv6-bindings` row; `ping -6` to R1 5/5. With M = O = 0 no DHCPv6 PDU is sent. Transaction ids identical over 3 runs. |
| `accept.p2.nat.test.ts` | §3.9. Static: SRV sees source 203.0.113.5; the provenance has `NatTranslate ipv4.src` with the rule as cause. Dynamic: the first host gets .20; with the pool full the next drops `nat-exhausted`. PAT: PC1 and PC2 ping SRV at the same time with ICMP id 1: two overload rows with inside-global ids 1 and 2; SRV sees (203.0.113.1, 1) and (203.0.113.1, 2); both pings 5/5; every received ipv4/icmpv4 checksum is valid. **Inbound match:** while PC1's row `icmp\|203.0.113.1\|1` is alive, SRV pings 203.0.113.1 with id 1: R1 itself answers and no packet reaches PC1. `clear ip nat translation *` removes dynamic rows only; idle ICMP rows expire after 60 s. |
| `accept.p2.determinism.test.ts` | A composite P2 world (PVST+, trunk, router-on-a-stick, LACP channel, port security, PAT, DHCPv6) runs 3× with one seed: byte-identical trace and snapshot JSON; `runToIdle` terminates. |
| `accept.p2.hsrp.test.ts` [S2] | §3.10. R1 active, R2 standby; an ARP for .1 is answered only by R1 with `00:00:0c:9f:f0:01`; R1 powered off at T → R2 active at t ∈ [T + 7 s, T + 10 s]; a continuous ping loses only pings sent in that window and the PC sends no new ARP; preempt returns R1 to active. The v1 variant uses `00:00:0c:07:ac:01` and 224.0.0.2. |
| `accept.p2.wlc.test.ts` | §3.12. The LAP gets a lease, then `discovery → dtls → join → configure → data-check → run` with the RFC 5415 message types (rows on both sides), and every control message after the DTLS step carries `meta.protected`; the laptop associates to LabNet through the LAP, gets a VLAN 20 address and pings its gateway 5/5; the `wlan-clients` row exists before the first downlink frame for the laptop; a laptop→gateway frame keeps one PduId end to end, its provenance shows station framing, the AP's tunnel encapsulation and the controller's decapsulation plus VLAN tag, and no `pduConsumed` for it occurs before the gateway; the passphrase appears in no PDU byte and no snapshot; with a second controller port cabled to a second switch, no frame and no BPDU crosses between the two switches through the controller; 3 runs byte-identical; with the WLC powered off `runToIdle` still terminates. |
| `accept.p2.labs.test.ts` | Every CCNA 2 lab: unsolved fails its tasks, the solution passes all, evaluation leaves the live trace head unchanged. |
| `accept.p2.replay-exact.test.ts` [S1] | For every SCENARIO with a seeded input script (solution configure, `show` commands, a breakpoint stop, `step`, `stepToNext`, a cut, a move, a power cycle, `runFor`/`runToIdle`): replaying the journal to `position()` gives byte-identical trace JSON (from `origin.counters.traceHead`) and snapshot JSON; replaying to every intermediate entry equals the live snapshot recorded there; two replays interleaved in one realm stay identical. |
| `accept.p2.seek.test.ts` [S1] | 50 seeded targets, forward and backward, equal fresh replays; every mutator is rejected in review with `REPLAY_READ_ONLY_MESSAGE`; leaving review returns the pre-review live snapshot; every seek dispatches exactly `target.dispatched − p` events for the replayer it started from (§3.13 step 6), and in steady state at most the largest lag gap for targets inside the parked window. |
| `accept.p2.coverage.test.ts` | Reads this table; fails when a listed file is missing or an `accept.p2.*.test.ts` file is not listed. |

### 10.2 Web acceptance (`apps/web/test/`)

- `overlays.l2-model.test.ts`: a trunk pair with native 99 against native 1 is flagged as a mismatch on both ends;
  chips read `T 10,20 · N99`; access chips read `V10`.
- `overlays.stp-model.test.ts`: crown on the root only; `A` plus a cross on the alternate; the draining bar fraction
  at `stateSince + 7.5 s` of a 15 s phase is 0.5.
- `store.topo-overlays.test.ts`.
- `worker.profile.test.ts` and `learn.course-profile.test.ts`: app start and File → New after opening a CCNA 1
  lesson → P1; after a CCNA 2 lesson, or with no lesson → P2; entering the sandbox from a CCNA 1 lesson with an
  empty world → P1; with devices placed → unchanged; a loaded template → P1 plus the "Classic defaults" chip.
- `store.background-drops.test.ts` and `canvas.markers.background.test.ts`: 60 s of synthetic background drops
  (the BPDUs an idle P2 world with two PCs drops) spawn no drop marker, mark no device dirty and list nothing in the
  sim-mode list by default; a non-background drop still does all three.
- `WlcPanel` command test: the Interfaces page emits exactly the §5.3 `wlc-interface` lines for a new interface, and
  the WLANs page exactly the `wlan` lines (with `interface <name>`) for a new WLAN.
- [S1] `store.timeline.test.ts` (review batches never touch `events` or the epoch), `worker.time-machine.test.ts`
  (including the §3.13 lifecycle).
- `vocab.test.ts` (exhaustive, unique letters, no banned words).

### 10.3 Gate G per wave (built bundle, real browser; rule 10)

Each script uses only what that wave ships in the built bundle (before W4 the bundle's switches are not yet
VLAN-aware, so W2 and W3 check that the new UI loads and stays quiet, not VLAN behaviour).

| After | Script (all in the `netforge-preview` build) |
|---|---|
| W0, W1 | Load template `two-pcs-and-switch`; `ping 10.0.0.2` from PC1's terminal; no console error. |
| W2 | File → New with no lesson opened (no "Classic defaults" chip); open a CCNA 1 lesson, then File → New (the chip shows); load a template (the chip shows); on a switch terminal type `show vlan brief`; ping between two PCs. |
| W3 | Load a template; toggle the VLAN and STP overlays (empty state, no error); open a switch port's inspector (switching section present); type `show vlan brief` and `show spanning-tree` on a switch. |
| W4 | Load a P1 template; "Use current defaults"; `stp-bridge` rows appear in the Tables tab; build the §3.6 triangle in a new world and see the VLAN and STP overlays drawn (crown, role letters, one cross). |
| W5 | Load lab `ccna2-stp-root-placement`; apply its solution through the terminal; Check shows full marks. |
| W6 | New world: an NF-2911 with DHCP pools for VLANs 99 and 20 (relay or subinterfaces), an NF-C2960 with a trunk to an NF-WLC-9800 and an access port in VLAN 99 to an NF-AP-1832; in the controller panel set the management interface (VLAN 99, address, gateway) and add a WLAN; the AP's `capwap` row reaches `run` and the CAPWAP overlay shows the join. [S1] Scrub back 10 s and forward again, leave review; the timeline strip shows STP lane marks. |
| W7, W8 | Open the CCNA 2 course, open the WLC lesson, start its lab, check it; every overlay toggled once. |

---

## 11. CCNA 2 course plan

The course reuses the course layer unchanged: `Course` → `CourseModule` → `Lesson`, theory in the markdown subset, an
optional verified video, and a pointer to one lab by `ScenarioInfo.name` (contracts/curriculum.ts). CCNA 2 adds
content, not machinery.

### 11.1 Lessons

34 lessons in 11 modules. Ids are `ccna2-NN-slug`, and no lesson runs over 45 minutes of reading and watching. Titles
and outcomes are original wording and paraphrase the objectives (§1.6 of the spec). Labs marked [S…] exist only if
that SHOULD item is built; otherwise their lesson runs theory-only.

| Module | Lesson (outcome: after it the learner can…) | Lab |
|---|---|---|
| 1 Switches, revisited | 01 How a switch forwards (… explain learning, flooding, filtering and CAM ageing, per VLAN) | — |
| | 02 Managing a switch (… reach a switch on a management SVI through its default gateway) | `ccna2-switch-management` |
| | 03 Speed, duplex and cabling (… set speed and duplex and recognise a mismatch) | — |
| 2 VLANs | 04 Why split a LAN (… say what a VLAN separates and what it does not) | — |
| | 05 Access ports and the VLAN list (… create and name VLANs and put ports in them; explain what VTP modes do and why a higher revision number can wipe a VLAN list — theory only) | `ccna2-vlan-access-ports` |
| | 06 Trunks and tags (… build an 802.1Q trunk, set its native VLAN and allowed list, and read the tag in the provenance view) | `ccna2-trunk-native-allowed` |
| | 07 Trunk negotiation (… predict the result of any two DTP modes and switch negotiation off) | `ccna2-dtp-modes` |
| | 08 Voice VLANs (… carry a phone's traffic in its own VLAN beside a PC's) | [S4] |
| 3 Routing between VLANs | 09 One router port per VLAN, then one for all (… configure router-on-a-stick subinterfaces) | `ccna2-router-on-a-stick` |
| | 10 Multilayer switching (… route between VLANs with SVIs and `ip routing`, uplink a routed port with `no switchport`, and hand out addresses across VLANs with a relay) | `ccna2-l3-switch-svis` (includes a routed-port uplink task) |
| | 11 Fixing inter-VLAN routing (… find a wrong VLAN, a missing trunk VLAN or a down subinterface) | `ccna2-troubleshoot-vlans` |
| 4 Spanning tree | 12 What a loop does (… explain a broadcast storm and watch spanning tree prevent it) | — |
| | 13 Electing a root (… predict and place the root bridge per VLAN) | `ccna2-stp-root-placement` |
| | 14 Port roles, states and timers (… name each port's role and why it waits 30 s) | — |
| | 15 Rapid spanning tree (… compare 802.1D and 802.1w convergence, switch modes, see a rapid switch fall back to 802.1D beside an older one, and say what MST adds — MST as one theory paragraph) | `ccna2-rapid-stp` |
| | 16 Edge ports and guards (… protect the tree with PortFast, BPDU guard and root guard) | `ccna2-stp-guards` |
| 5 EtherChannel | 17 Bundling links (… bundle two links with LACP, balance traffic, and read bundled, individual and suspended members to spot a misconfigured bundle) | `ccna2-etherchannel-lacp` |
| 6 Addressing services | 18 DHCP across VLANs (… explain why a relay is needed on each VLAN interface) | — (practised in lesson 10's lab) |
| | 19 SLAAC and DHCPv6 (… configure stateless and stateful DHCPv6 and the flags that choose them) | `ccna2-dhcpv6` |
| 7 Gateway redundancy | 20 One gateway, one point of failure (… explain what a first-hop redundancy protocol adds) | — |
| | 21 Hot-standby gateways (… configure a standby group and watch failover) | [S2] `ccna2-hsrp-gateway` |
| 8 Access-layer security | 22 Threats at layer 2 (… name the attacks port security and guards stop; concepts only, spec §11.6) | — |
| | 23 Port security (… limit and pin the addresses on a port, and recover an err-disabled port) | `ccna2-port-security` |
| | 24 Hardening switch ports (… shut unused ports, move the native VLAN, switch negotiation off) | — (tasks inside the port-security lab) |
| 9 Wireless at scale | 25 Controllers and lightweight APs (… describe CAPWAP, its encrypted control channel, split MAC and central switching; the lesson notes that in NetForge the AP answers association itself and reports the client to the controller, and that the encryption is shown, not computed) | — |
| | 26 Channels and overlap (… plan non-overlapping channels in 2.4, 5 and 6 GHz) | [S12] `ccna2-channel-plan` |
| | 27 WLANs on a controller (… create a controller interface and a WLAN on it, and connect a client through a lightweight AP) | `ccna2-wlc-wlan` |
| | 28 Securing a WLAN (… choose between personal and enterprise security) | [S11] `ccna2-wlan-enterprise` |
| 10 Static routing | 29 How a router chooses (… apply longest match, administrative distance and recursive lookup, and explain equal-cost paths and load balancing) | — |
| | 30 Static route forms (… write next-hop, exit-interface, fully specified and host routes) | `ccna2-static-routes` (includes a /32 host route) |
| | 31 Default and floating routes (… add a backup route that takes over when a link fails) | `ccna2-floating-static` |
| | 32 IPv6 static routes (… route IPv6 with global and link-local next hops) | `ccna2-ipv6-static` |
| 11 Translation and fault finding | 33 Address translation (… configure static NAT, a pool and PAT, read inside/outside, local/global, and [S9] forward a port to an inside server) | `ccna2-nat-pat` ([S9] adds a port-forward task) |
| | 34 Finding faults (… troubleshoot a switched and routed network methodically) | `ccna2-troubleshoot-routing` |

MUST labs: 19 (every lab row without a bracket). With S2, S11, S12 built: 22.

### 11.2 Labs

- Category `ccna2-lab`, `course: 'CCNA 2'`, `topic` = the module title, `seed` fixed, profile P2 (`topology(…,
  {profile: 'P2'})` in the kit).
- The lab types are guided, build and troubleshoot, as in CCNA 1.
- Troubleshoot labs schedule hidden faults (`config-fragment`, `cable-cut`, the new `err-disable`).
- Every lab has a reference `solution` for `labs.ccna2.solutions.test.ts` and at least one wrong-answer case per new
  assertion kind in `sim.lab-checks.p2.test.ts`.
- Labs that depend on spanning tree say in their instructions that ports take 30 s to forward (or configure
  PortFast on host ports in the initial config when the lesson is not about spanning tree), so learners are not
  surprised by a silent first ping.
- The wireless lab uses NF-WLC-9800 and NF-AP-1832; its tasks follow the course workflow: create the controller
  interface (name, VLAN, address, gateway, DHCP server), then the WLAN on it.

**Assertion kinds used** (§2.10): `vlan`, `switchport`, `stp`, `etherchannel`, `portSecurity`, `route`, `nat`,
`port` with `errDisabled`, and `connectivity` with `after`/`then`; [S2] `fhrp`, [S15] `convergence`.

**Grader changes** (`sim/lab-checks.ts`, W5):

- The clone re-applies err-disabled ports (§3.8 step 7).
- One clone is built per distinct `connectivity.after` set; it settles, applies the faults, runs `settleMs`, pings,
  then evaluates `then` inside the same clone.
- `table` `where` values for columns of format `port` are normalised through the device's name resolver, so
  `Gi0/1` matches `GigabitEthernet0/1`.
- Clones settle with `runToIdle`, which waits for forward delay, TC windows, LACP negotiation and HSRP elections
  (§4.2).

**Worker and UI.** `LAB_RELEVANT_KINDS` needs no change: every P2 state a lab reads lives in tables, and table
writes are already relevant. The labs browser groups by course, then topic (W6). The File menu lists `ccna2-lab`
under "Labs: CCNA 2".

### 11.3 Content rules

- The lesson skeleton lands in W1 (`curriculum/ccna2/lessons.ts`), **detached** from `curriculum/index.ts` (the
  CCNA 2 course keeps status `planned`, no modules, no lessons) until the W7 flip, so the planned-course pins of
  `curriculum.test.ts` stay green; `curriculum.ccna2.test.ts` imports the skeleton directly, and lab-name existence is
  checked against `SCENARIOS` from W5 (W7 for the wireless lab).
- CCNA 1 lessons keep their text: a sandbox entered from a CCNA 1 lesson is a P1 world (D2), so "place two PCs and
  a switch and ping" still works at once.
- Theory is written only after the CLI grammar of its feature exists (W6 for everything except wireless; W7 for the
  wireless lessons), because `curriculum.ccna2.commands.test.ts` parses every backticked command in a lesson against
  `GRAMMAR` for the model the lesson names. Address lines printed in a lesson must be lines of its lab's solution
  (the twin of curriculum.test.ts:171-186).
- The five fixed section headings, the markdown subset, the no-vendor rule and the 45-minute cap of the CCNA 1 tests
  apply unchanged.
- The spanning-tree lessons state plainly that real switches run spanning tree by default, and that NetForge
  projects saved before P2 keep "classic defaults" (no spanning tree by default) until upgraded from the File menu.
- `CCNA2.status` flips to `available` in W7, when every MUST lesson has theory and every MUST lab exists. Its
  description is rewritten: the P1 placeholder promises routers that learn their routes, which is CCNA 3.

**Video verification rule (oEmbed).**

- A video is attached to a lesson only after a person has checked it by hand:
  `https://www.youtube.com/oembed?url=<watch url>&format=json` returns 200 with the title and channel recorded in the
  entry; the video is public and embeddable; it teaches that lesson's outcome; and neither its title nor its channel
  names a vendor.
- The call and the date are written in the header of `curriculum/ccna2/videos.ts`, as in CCNA 1.
- `curriculum.ccna2.videos.test.ts` never touches the network. It checks the key is a CCNA 2 lesson id, the id
  shape, the `https://www.youtube.com/watch?v=<id>` URL, the vendor guard and no duplicates across CCNA 1 and CCNA 2.
- A lesson with no verified video runs theory-only. That is allowed; no minimum coverage is imposed.

### 11.4 Objective traceability (spec §2.8, §12.7)

Every spec §2.2 objective is either practised in a lab, taught as theory, or recorded here as untaught with its
stage. With the recommended plan (§8.4):

| Objective (spec §2.2) | Where |
|---|---|
| VTP modes, domain, revision number | Lesson 05 theory (C1 not built) |
| MST | Lesson 15 theory paragraph (C2 not built) |
| L3 switch routed ports | Lesson 10 and its lab (routed-port uplink task) |
| Host routes; equal-cost load balancing | Lessons 29–30 (host route in `ccna2-static-routes`); ECMP hands-on only with S6 |
| NAT port forwarding | Lesson 33 and its lab when S9 is built; otherwise theory in lesson 33 |
| Voice VLAN, HSRP, PAgP, loop guard, WPA-Enterprise, RF overlap, roaming | Hands-on only when S4, S2, S3, S5, S11, S12 or C5 is built; otherwise theory in lessons 08, 20–21, 17, 16, 28, 26 and 25 |

`curriculum.ccna2.test.ts` carries this table as data (objective → lesson id or `'untaught:<stage>'`) and fails when
an objective has no row.

---

## 12. Deferred items and risks

### 12.1 Deferred (with the stage that should take them)

- **COULD items C1–C11 (§8.3)**, unless approved for W7.
- **CDP and LLDP** (spec CCNA 3). Consequences in P2: the voice VLAN is set on the phone by hand (S4); native-VLAN
  mismatch is detected through the per-VLAN BPDU TLV, not neighbour discovery.
- **ACL filtering on interfaces** (`ip access-group`, extended ACLs, hit counters): CCNA 3. P2 ships standard ACL
  matching for NAT only (`core/acl.ts`); `show access-lists` lists entries without hit counts.
- **IPv4 fragmentation** and a `Pdu` split primitive (`MutationReason 'FragmentSplit'` has no operation): P3. The
  CAPWAP tunnel relies on the MSS clamp (§3.12 step 9).
- **Serialised engine checkpoints** (a `Checkpointable` contract, rng origin preserved across restore): only if
  profiling shows replay is too slow (§12.2 R8).
- **Exact session restore from `activity.json`** and **"continue from here"** (truncate the journal and replace the
  live world): C4 and later.
- **`PduSummary.layers`** stays unfilled (P1 §11): filling it changes pinned P0 bytes and needs its own migration
  entry. P2 adds `PduSummary.vlan` and `tunnel`, which appear only on new paths.
- **HSRP object tracking, HSRP for IPv6, VRRP, GLBP**: P3 or P5.
- **`injectNoise` and the RF faults** (C11), still unimplemented since P1 §12.2.
- **True split MAC** (association and the 4-way handshake answered by the controller) and **DHCP proxy on the
  controller**: P5 wireless depth, if ever (deviations (14), (15)).
- **A real DTLS exchange for CAPWAP**: never needed for learning; the state and the protected marker stay (deviation
  (16)).

### 12.2 Risks and mitigations

| Risk (spec §20) | Where it bites in P2 | Mitigation |
|---|---|---|
| **R2 fidelity** | Deliberate deviations: (1) `dynamic auto` never initiates DTP; (2) DTP, VTP and PAgP use original NF formats; (3) per-VLAN spanning tree sends IEEE-format BPDUs plus an NF TLV on trunks instead of the vendor format; (4) no automatic edge detection; (5) STP ages information at hello granularity; (6) load balancing folds the five varying MAC octets (or the IPv4 octets) modulo the member count instead of 8 buckets; (7) the voice VLAN is set on the phone by hand; (8) access ports only answer DTP (they never advertise on a timer); (9) one WLAN per radio unless S10; (10) the controller clamps TCP MSS instead of fragmenting; (11) a PVST+ instance cap of 128; (12) no C2960 "suspend individual" platform option: LACP members without a partner always run individual; (13) the extended system id cannot be switched off; (14) association and the 4-way handshake are answered by the AP and reported to the controller (local MAC), not answered by the controller (split MAC); (15) the controller bridges client DHCP instead of proxying it to the interface's DHCP server; (16) the CAPWAP DTLS session is a simulated state, and protected control messages are still shown decoded. | Each is listed in the fidelity table in `docs/CATALOG.md` (the architect adds the row when the wave that builds the feature reports it, §6) and, where a learner could notice, in the lesson text (lesson 25 states (14) and (16)). Behaviour that exam questions test (mode matrix, election order, timers, violation modes, virtual MACs, NAT terms, CAPWAP message flow and ports) is exact. |
| **R3 performance** | Spanning tree per VLAN × ports: hello ticks cost `instances × designated ports` BPDUs every 2 s, each about 4 trace events; many VLANs on many trunks multiply it. Parked replayers re-run the live world. | 128-instance cap; one `hello:<vlan>` timer per instance (each tick stays far below `ACTION_BUDGET`, 1000); BPDUs, DTP, LACP, HSRP and CAPWAP echoes are `background` (the clock clamp, sim-mode lists and drop markers skip them); `PortSnapshot.l2` omitted when default; eth-switch caches parsed switchport config per port and invalidates it on config deltas; replayers run with trace capacity 0 and a small PDU registry, in 500-event chunks; STP overlay memoised per device object; `accept.p2.stp-scale` (8 switches, 20 VLANs) bounds the dispatched events of a converged minute. |
| **R5 determinism** | New control planes, tag rewrites on flood copies, NAT allocation, replay. | No P2 daemon draws randomness except DHCPv6's two cached streams (§4.1); clones allocated before tag normalisation; timers armed in fixed orders; integer hashes; `accept.p2.determinism` (3 runs) and, with S1, `accept.p2.replay-exact` over every scenario. The adversarial verify step of every wave replays the wave's scenarios twice and diffs bytes. |
| **R6 content volume** | 34 lessons and 19–22 labs, written after the grammar exists, in two waves. | The skeleton lands in W1 so structure tests run early; theory is parallelised per module; `curriculum.ccna2.commands.test.ts` makes a lesson that names a wrong command fail at once; labs reuse kit builders; videos are optional. |
| **R8 time-travel memory** | Each parked replayer is a whole world (about 0.7–5 MB at CCNA sizes), plus the cursor replay's ring and the lane index. | `DEFAULT_TIME_TRAVEL_BUDGET` (3 replayers, 50 k review ring, 5 k PDU registry, 250 k lane entries ≈ 4 MB, merged into buckets when full): about 10–30 MB extra for CCNA-sized worlds. "History off" drops the replayers. The journal is small but contains typed secrets; it is treated like configuration (export notice). |
| **Seams** (lesson 1 of P1) | Member-to-bundle translation; tag normalisation on every egress path (flood, known unicast, hairpin, SVI ingress and egress, subinterface egress, Capwap0); the `l2Changed` fan-out; the stp → eth-switch flush list; NAT hand-off and resume; `virtual4` consumers (pipeline, arp, eth-switch); the controller profile shared by the air and wlan-ap; the udp tunnel hand-off; station reports; the config store's default slots. | Each is an exact contract in §2 and a named step in §3; the debug categories are a table (§5.4); each wave's adversarial verify targets the seams it touched on real worlds (`p2.world`, rule 13); acceptance tests assert provenance order and byte identity end to end. |
| **Stage-flip regressions** | W4 and W6 change the catalog, so every switch in every P0/P1 scenario starts running the VLAN-aware path and every AP gains daemons. | `accept.p2.p1-digests` (W0) pins every template and CCNA 1 lab over all event kinds; it runs at the end of every wave and inside both flip changes, and only the §9.3 changes are allowed. `l2.eth-switch.p0-parity.test.ts` proves the VLAN-1 path byte-identical in W2 on `p2.world`. Daemon names enter the registry only with their factories, and the lightweight AP needs `capwap enable`. |
| **Defaults that do not survive a save** | A replayed default the learner reverses would come back on reload or in the grader's clone. | The completeness rule (D2) and `ip routing` storing both forms; `accept.p2.profile` reverses every default line through export, reload and a lab clone. |
| **Built bundle** (lesson 4) | New canvas layers, registries and worker modules. | Gate G every wave (rule 10); no module-scope cross-module reads (rule 12). |

### 12.3 Open items for the product owner

The decisions are recorded in §8.5 before wave 0. Background for each:

1. **Wireless controller as MUST (M12, 6.5 ew).** It is the most expensive MUST item. Cutting it leaves the wireless
   module at autonomous and home APs, and the controller objective unmet. Its depth is chosen (P4): association
   stays at the AP, DTLS is simulated, DHCP is bridged.
2. **HSRP is SHOULD (S2).** The official course treats first-hop redundancy mostly as concepts, but the spec lists
   HSRP in CCNA 2. Recommended in the plan.
3. **NAT is in P2 (M11)** as the spec says, although current course versions teach it in the third course. It pulls
   standard ACL matching forward from CCNA 3.
4. **VTP (C1) is deferred** although the spec lists v1/2/3. It is off the current exam blueprint, the VLAN database
   works without it, and lesson 05 teaches it as theory.
5. **Multilayer switches default to `no ip routing` in the P2 profile.** This matches the lab habit of typing
   `ip routing`. It differs from some real platforms that route by default. Reverse it by deleting one line of
   `profileConfig`.
6. **Time travel (S1) is SHOULD.** It is in the spec's P2 row. It is recommended for the plan, but the core
   objectives do not need it; it is the first recommended item to cut under pressure.
7. **Spanning tree on by default in new worlds.** Recommended (P3). The cost is the 30 s wait on host ports in new
   worlds, which CCNA 2 teaches; CCNA 1 lesson sandboxes and old files are not affected (D2).

---

## 13. Review changes (adversarial review of this brief, applied before wave 0)

Three adversarial reviews returned findings #0–#50. Each is listed with its disposition and where it landed. None was
rejected outright; where only part of a proposal was taken, the part left out and the reason are given. Findings that
reported the same defect are merged (#3 = #35, #9 = #39, #12 = #41).

**Regression findings**

- **#0 [high] Reversed defaults lost on export — accepted, option (b) generalised.** D2 gains the completeness rule
  (a line that would empty a default slot is stored explicitly; `negationRestoresDefault` for `spanning-tree mode`),
  `ip routing` becomes `bothForms`, `no spanning-tree extend system-id` is refused, and the controller's trunk lines
  disappear (its ports are intrinsic, D17); §5 gives the function contract; `accept.p2.profile` round-trips every
  reversal through export, reload and a clone; `accept.p2.svi-routing` checks the clone. Option (a) was not taken:
  kit-built CCNA 2 labs carry startup configs without the profile lines, so "replay only on an empty device" would
  boot their switches without spanning tree.
- **#1 [high] No proof of P1-profile byte identity — accepted.** `goldens/p1-profile-digests.json` recorded in W0 from
  the unchanged engine, `accept.p2.p1-digests` over all event kinds (§10.1), run every wave and inside both flips
  (rule 9); the two design-caused changes (D13 install times, `background` on drops) are the only ones §9.3 allows;
  silence (a) widened to `log`/`debug`/`sockets`; the Vlan1 reason, the AP and controller changes were removed at the
  source (#4, #7).
- **#2 [high] Transition rule would make byte-critical members required — accepted.** §2.15 lists every member
  optional by meaning; §2 tags them; a W8 type-level test keeps their `?` (rule 2).
- **#3 [medium] PROCESS_ORDER changes turn W0 red; radius-server listed early — accepted** (merged with #35). A daemon
  name enters `PROCESS_ORDER`, `CAPABILITY_PROCESSES` and `L2_PROCESSES` only with its factory (rule 3, §2.1 with
  final positions and "added by" column); registry map edits listed in §9 W4/W6; radius-server rows only with S11 and
  its socket only when configured.
- **#4 [medium] Vlan1 down reason changes on VLAN-aware devices — accepted.** The VLAN-aware SVI rule keeps the P1
  reason `no-bridged-port-up` (for every VLAN; no new reason is added), so `device.virtual.test.ts:147` and P1 traces
  stay; `accept.p2.svi-routing` updated.
- **#5 [medium] `layer3-switch` implication leaks into P0.5/P1 fixtures — accepted.** VLAN awareness keys on the
  stage-derived `vlan` daemon (`isVlanAware`, D5); the implication is not changed; multilayer models list
  `managed-switch` in their W4 data; §9.1 records both fixtures as unchanged.
- **#6 [medium] Err-disable recovery cycle holds runToIdle — accepted.** `errdisable:<port>` is periodic (D12, §3.8,
  §4.2); recovery tests use `runFor`; `accept.p2.port-security` asserts `runToIdle` returns below 10 000 events with
  the violator attached.
- **#7 [medium] W6 changes two existing models in every profile — accepted.** capwap-wtp needs `capwap enable`
  (replayed only in P2); NF-WLC-3504 stays the P1 host end system (Legacy category), and the appliance is the new
  NF-WLC-9800 (D17, §7 W6, §9 W6); the new dhcp-client on the AP cannot act on a P1 file because the P1 grammar never
  accepted `ip address dhcp` there; `accept.p2.silence` (c) covers a statically addressed P1 AP.
- **#8 [medium] CCNA 1 lesson sandboxes become P2 — accepted.** New worlds take the profile of the course context
  (`learn/course-profile.ts`, D2, §2.14); web tests in §10.2; CCNA 1 lesson text unchanged.
- **#9 [medium] Loop-storm test cannot pass; D23 overstated — accepted** (merged with #39). Three parallel 100 Mb/s
  links, a memory bound and a line-rate event bound using the measured `P2P_EVENTS_PER_FRAME`; D23 now says the cap
  bounds memory, not event rate.
- **#10 [medium] Rapid test contradicts non-edge host ports — accepted.** PC ports get PortFast in `stp-rapid`; a
  non-PortFast host port is asserted at 30 s; §3.6 Rapid step 3 says a designated port without agreement falls back
  to `fwd:` timers on any link type.
- **#11 [medium] Migration list misses pinned assertions — accepted.** §9 now covers the io schema pins (with
  `TOPOLOGY_SCHEMA_ID` staying 1.1), the non-SNAP LLC case with exact new values, the router help lists per wave
  (literal arrays, still `toEqual`) under a frozen-copy superset guard, `NF_PC`/`NF_2911.processes` with exact lists,
  and D13 "usable" is defined (connected port first, then RIB recursion), keeping `arp.host.test.ts:105-118`.
- **#12 [medium] Sticky config line flushes its own secure row — accepted** (merged with #41). The onConfig flush
  covers only mode/VLAN/trunk/voice/nonegotiate lines; secure and configured rows are never flushed and are derived
  idempotently from the running config (§3.0, §3.8, D12); psec unit test and acceptance case added.
- **#13 [low] Required members break typed fakes — accepted.** `P2_CTX`/`P2_DEVICE` spreads in W0, the six fixture
  files in §9 W1 (the members now become required in W1, see #42); "unchanged" reworded to "assertions unchanged".
- **#14 [low] A 1.1 document with `profile` loses it — accepted.** `profile` belongs only to the 1.2 field set; every
  writer sets `schema = schemaIdFor(t)` (§2.9, D2, kit in W5); `accept.p2.profile` and `io.schema.p2` test both cases.
- **#15 [low] dot1q has no 802.3 length rule — accepted.** §2.3 field table and `LINK_FIELDS`; golden bytes for a
  tagged PVST+ BPDU and an 802.3 push/pop round trip in W1.
- **#16 [low] SVI copy of a tagged group frame keeps its tag — accepted.** §3.0 step 12: the SVI target always wants
  untagged (cause `interface Vlan<V>`); unit test and a trunked-host case in `accept.p2.svi-routing`.

**Protocol findings**

- **#17 [high] Native VLAN carried outside the allowed list — accepted.** `classify` and `carries` treat the native VLAN
  like any VLAN of the trunk; §3.2 uses allowed `1,10,20,99`, states that each end detects only from BPDUs it
  receives, and adds the not-allowed case; `accept.p2.trunk` updated for both profiles.
- **#18 [high] RSTP alternate ports never agree — accepted.** ALTERNATE_AGREED added to §3.6 Rapid step 3; unit test
  for the SW2→SW3 handshake; the no-agreement fallback stated.
- **#19 [high] Mixed PVST+ / Rapid PVST+ unspecified — accepted.** §3.6 "Mixed modes" (per-port protocol migration,
  `StpPortRow.protocol`, RST BPDUs discarded by pvst bridges, `clear spanning-tree detected-protocols`,
  `no spanning-tree mode` restoring the model default in P2); a C2960/C9300 case in `accept.p2.stp-rapid`.
- **#20 [high] Split MAC claimed but not designed; no writer of `wlan-clients` — accepted in part.** Option (B) taken:
  association stays at the AP (a listed deviation (14), taught in lesson 25), capwap-wtp sends WTP Event station
  reports from a new `wlan.grant` event, capwap-ac is the only writer of `wlan-clients`; `wlan.authorize` moved to
  S11; the row-before-downlink assertion added. Option (A) (true split MAC) was not taken: it rewires the P1 air and
  wlan-ap paths the wireless goldens pin, for a difference visible only in a capture.
- **#21 [medium] Router-on-a-stick sequence omits FcsRecompute — accepted.** §3.4 and §3.9 list the engine's derived
  records; both sequences are derived from real calls in W1/W3 unit tests and the acceptance tests pin observed
  behaviour.
- **#22 [medium] Stale trunk for 300 s after the neighbour goes access — accepted.** Access ports answer received DTP
  and send one frame on becoming access facing a DTP speaker (§3.3); still silent by default; `accept.p2.dtp` expects
  propagation + 1 s; deviation (8) reworded.
- **#23 [medium] Topology-change rules incomplete — accepted.** 802.1D detection on leaving forwarding, TCN until
  acknowledged (periodic `tcn:`), TCN relay; `L2FlushEvent.ports` replaces `exceptPort`; 802.1w propagation on
  non-edge ports; `stp.tc.test.ts` cases including edge rows surviving.
- **#24 [medium] pvid check blocks the access-VLAN mismatch — accepted.** Access ports send plain BPDUs with no TLV;
  the pvid check runs only on trunks; new `'type'` inconsistency; two acceptance cases.
- **#25 [medium] No-partner LACP members suspended — accepted.** They run `individual` (passive–passive and
  active-vs-on); `suspended` is kept for real incompatibilities; deviation (12) records the missing platform option;
  `accept.p2.etherchannel` expects individual members and a working ping. For active-vs-on, "individual plus the S5
  guard" was chosen over keeping suspension, because it is what learners see on real switches.
- **#26 [medium] NAT inbound match unspecified — accepted.** §3.9 inbound match rule (replies only for ICMP query rows,
  address- and port-dependent filtering), `tcp-finrst` 60 s, the SRV-pings-R1 case in `accept.p2.nat`.
- **#27 [medium] ICMP-error NAT incomplete — accepted.** Embedded-packet lookup with reversed roles, the outbound
  direction, and the embedded ICMP/UDP checksum rules (§2.3, §3.9 step 5 and table); `nat.icmp-error` tests both
  directions and traceroute with udp and icmp probes.
- **#28 [medium] CAPWAP numbering and states — accepted in part.** RFC 5415/5416 numbers (`CAPWAP_MSG`), the state
  order with `dtls` and `data-check`, Change State Event, WLAN configuration in Run, WTP Event for station reports,
  station configuration only with S11. DTLS is modelled as a simulated state plus `meta.protected` (deviation (16)),
  not as a handshake on the wire: the spec's "headers real, crypto simulated" is met and the payload stays inspectable.
- **#29 [medium] The controller bridges port to port — accepted.** One active distribution port, backups drop, no BPDU
  relay, no port-to-port bridging (§3.0, D17); port name fixed to GigabitEthernet0/1; unit and acceptance cases.
- **#30 [medium] WLAN maps straight to a VLAN — accepted in part.** Controller interfaces (`wlc-interface`, name, VLAN,
  address, gateway, DHCP server), `interface <name>` in the WLAN, `client-vlan` removed, an Interfaces page and its
  panel test. DHCP proxy is not modelled: client DHCP is bridged into the interface's VLAN (deviation (15)); the
  learner-visible outcome in the labs is the same and it avoids a relay inside the controller.
- **#31 [low] Port-channel cost vs "no stp write" — accepted.** Cost follows the bundled bandwidth (3 → 4) as a cost
  update only; the acceptance assertion now checks no role/state change, no TC and no CAM flush, and cost 4.
- **#32 [low] Trunk status of a dynamic Port-channel undefined — accepted.** `operOf` of a bundle is the members'
  common negotiated mode; a differing member is suspended; DTP test and acceptance case.
- **#33 [low] PortFast scope — accepted.** Edge = PortFast and operationally non-trunking, or `portfast trunk`; warning
  on a trunk; `portfast default` covers `dynamic auto` host ports; guard tests.
- **#34 [low] Root macro ignores the VLAN id — accepted.** The macro compares configured priorities, breaks a tie,
  refuses at 0 (`CLI_MESSAGES.rootPriorityExhausted`); tie case in `cli.stp.test.ts`.

**Feasibility findings**

- **#35 [high] W0 cannot be green (registry test) — accepted**; see #3.
- **#36 [high] W2–W3 daemons cannot run in real worlds before the flip — accepted, with a different placement.**
  `SimulationOptions.catalog` (tests only) and `test/p2.world.ts` (W1 qa); the parity, timing and matrix tests and
  every adversarial verify run on it (rule 13). The wired acceptance tests move to W4 on `p2.world` instead of "the
  end of W3", because rule 1 forbids a W3 item depending on same-wave items; the first integration is still not the
  flip.
- **#37 [high] SHOULD contract blocks without an owner — accepted.** The SHOULD set is decided before W0 (§8.5) and its
  blocks and web stubs land in W0 (rule 3); the S15 types are written in full (§2.13); C3/C4 types must be written in
  full before their item starts; a later approval names one item that adds the block and its stubs.
- **#38 [high] LAG hash on the port-ordinal octet — accepted.** The hash folds the five varying MAC octets (§3.7);
  the acceptance test computes each PC's member from its real MAC; deviation (6) reworded.
- **#39 [high] Storm test cannot pass — accepted**; see #9.
- **#40 [high] Gate G scripts not executable — accepted.** §10.3 rewritten to what each wave ships: W2/W3 load the
  new UI quietly, W4 shows the overlays after the flip, W6 builds a working controller world and carries the scrub.
- **#41 [medium] Sticky learning flushes itself — accepted**; see #12.
- **#42 [medium] Same-wave test dependencies — accepted.** Profile replay, err-disable, `configLine`, `l2Changed`,
  `ctx.profile`/`transition` move to W1 device; `Simulation.profile` to W1 sim; `radio-profile` and
  `ctx.radioSettings` (device/process-ctx.ts) to W4 device; the wireless tests use `p2.world`'s test-only models;
  rule 9 now forbids own tests on same-wave items.
- **#43 [medium] CAPWAP tunnel continues a consumed PDU — accepted.** `udp.open` `tunnel` (§2.4): delivery without
  `consume`; `protocols/udp.ts` owned by wireless W5; `accept.p2.wlc` asserts one PduId and no `pduConsumed` at the
  controller.
- **#44 [medium] Seek cost contradicts the replayers; lifecycle unspecified — accepted.** §3.13 steps 5–6 give the
  lifecycle (re-park in the origin slot, idle when ahead, lazy refill outside review) and an exact cost rule; the
  acceptance test asserts it.
- **#45 [medium] MUST called "CCNA 2 complete"; cuts not whole items — accepted.** §8.1 renamed "MUST (core
  objectives)"; §8.5 records the scope list the W8 gate checks; every bracketed feature is its own wave item; the
  HSRP codec, dispatch, constants and `groups4` moved into S2.
- **#46 [medium] Unowned files — accepted.** `trace/filter.ts` (W2 device), `delta.ts`, `sim-events-client.ts` and
  the store spawn line (W2 web-shell), `markers.ts`, `scene.ts`, `Canvas.tsx` (web-canvas W3/W6), web tests for
  background drops; the architect is the only editor of `docs/CATALOG.md`.
- **#47 [medium] DHCPv6 lease overwrites DHCPv4 DNS servers — accepted.** `dns-client.ts` in W3 svc; servers keyed by
  (iface, family), v4 first (§2.5); dual-stack test and acceptance line.
- **#48 [low] Objectives taught nowhere — accepted.** VTP theory in lesson 05, MST in 15, routed-port task in lesson
  10's lab, host routes and ECMP in 29–30, port forwarding in 33 with S9; §11.4 traceability table, enforced by
  `curriculum.ccna2.test.ts`.
- **#49 [low] FSM subject and debug category mismatch — accepted.** Canonical subjects in §3.6 and examples; the §5.4
  category table is binding; the transition examples in §3.6, §3.7, §3.10 and §3.12 use it.
- **#50 [low] CCNA 2 skeleton vs curriculum pins — accepted.** The skeleton stays detached from `curriculum/index.ts`
  until W7; `curriculum.ccna2.test.ts` imports it directly; lab existence is checked from W5 (W7 for wireless).

**Consequences for the plan.** MUST grows from ≈ 49 to ≈ 52 ew (M1 +1, M6 +0.5, M12 +0.5, M15 +0.5) and the
recommended plan from ≈ 62 to ≈ 65 ew. The wave list (§7) and the cut lines (§8) agree: every MUST row names only
unbracketed items, every SHOULD row names exactly its bracketed items, and the wired acceptance suite moved from W5 to
W4 in both places.
