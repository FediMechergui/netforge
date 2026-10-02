# NetForge — P3a (CCNA 3 content): binding architecture brief

> **Status: design, revised after adversarial review (§13) and the product owner's decisions (§8.5); wave 0 not yet
> applied.** P0, P0.5, P1 (CCNA 1) and P2 (CCNA 2) are complete and live at commit 5263f16 (engine 300 files / 4215
> tests, web 74 / 1084; ARCHITECTURE-P2 §14). This document is the binding design for stage P3a. Nothing in it is
> built yet. Everything deliberately left for later is listed in §8 (cut lines) and §12. The product owner recorded the decisions of §8.5 on 2026-09-29: the MUST
> plan, thirteen SHOULD items and two COULD items (§8.4, "the approved plan"). §13 lists what the adversarial review of
> this brief changed, and its last subsection what the product owner's decisions changed.

This is the binding brief for the P3a build. Read it together with the contracts, which are the interfaces every
module compiles against:

- `packages/engine/src/contracts/*.ts` after wave 0 (§2 lists every addition),
- `apps/web/src/bridge/protocol.ts` and `apps/web/src/store/types.ts`.

`docs/ARCHITECTURE.md` (P0), `docs/ARCHITECTURE-P1.md` (P0.5 + P1) and `docs/ARCHITECTURE-P2.md` (P2) stay in force.
Where this document differs, this document wins.

Other sources:

- Spec: `docs/netforge-spec.md` §2.3 (CCNA 3 engine requirements), §2.8 (traceability), §4.2, §4.4–§4.7, §6, §9
  (in particular §9.4, §9.6, §9.7, §9.9), §12, §13.1, §19 (row P3) and §20 (risks R1–R9).
- The five P3 area maps, written by architects who read the code at 5263f16: routing (OSPF, EIGRP, LSDB browser,
  SPF animation); ACLs, device hardening and IPv4 fragmentation; WAN (PPP, GRE, IPsec, WAN concepts) and QoS;
  network management and automation; cross-cutting (course, defaults profile, grader, P3b seams, engineering
  health, waves, cost). Their design decisions are carried here with their rejected alternatives; §1.1 records where
  they disagreed and what was chosen; §8 deduplicates their costs.
- ARCHITECTURE-P2 §14, whose "known and accepted, for P3" items (web tests not type-checked, suite time, the
  load-dependent `worker.delta` cases, the grader limits of §9.2 item 22d, the EtherChannel wrong answer that never
  idles, item 22c) are carried into §7 W0 and §12.
- Device data: `docs/CATALOG.md`. Field names: `contracts/fields.ts`.
- The code at commit 5263f16. Line numbers below refer to that commit.

**The split.** The spec's P3 row ("OSPF/EIGRP, ACLs, WAN/PPP, QoS, management protocols, automation sandbox,
assessment engine, authoring studio, LTI, collaboration") is split by the product owner into **P3a**, the CCNA 3
content (this brief, static site, no backend), and **P3b**, the platform (assessment engine, authoring studio, LTI
1.3, collaboration; it needs a backend and gets its own brief). P3a builds none of the platform; it builds only the
seams that make it cheap (D6).

Stage P3a in one sentence: single-area OSPFv2 with its verification commands, an LSDB browser and an SPF animation,
classic EIGRP with its feasible successors, standard and extended IPv4 ACLs with hit counters, logging and a
structured "why was this dropped", SSH-only device access with a real remote terminal (telnet and simulated SSH over
the network, `access-class` enforced), DHCP snooping and dynamic ARP inspection, PPP with PAP and CHAP, GRE tunnels
and site-to-site IPsec (VTI, IKEv2-lite, ESP with simulated crypto), QoS marking with a traffic generator, a
congestion view, a queueing sandbox and the full scheduler (LLQ, CBWFQ, WFQ, policing, shaping), CDP and LLDP, device
clocks and NTP, local logging and syslog, a device REST API reached over the simulated network with a data-format
playground, an NF-Py scripting host, and a graded CCNA 3 course of 40 lessons and 21 labs — carried by a grader that
areas extend with data, a `'P3'` defaults profile (CDP, the timestamps lines and extended logging), and goldens that
prove every CCNA 1 and CCNA 2 world byte-identical. The spec's P3 exit criterion (§19) is split with the stage: P3a's
is the scope list the product owner recorded in §8.5 (P13, P16); the "instructors authoring their own labs" half
belongs to P3b, whose studio needs the backend. §8 draws the cut lines that decide what P3a costs.

---

## 0. Rules for implementers

P2's rules 1–13 carry forward unchanged in substance (restated below with P3 names). Rules 14–21 are new: 14–18 and
21 come from building P2 (its §14 exit record, including the W6 push incident), 19–20 from the grader the areas now
share.

1. **One owner per file, build waves.** §7 gives each file exactly one owner and a wave. A module in wave N may
   depend only on waves < N, plus the contracts (wave 0). `packages/engine/src/index.ts` is architect-owned and
   append-only: a wave item adds only its own `export * from './<its files>.js'` lines, in the change that creates
   those files. The architect reconciles it at the exit gate.
2. **TRANSITION RULE.** Every contract member tagged `@since P3` is optional in the type only, so that P2 code and
   hand-written fixtures still compile.
   - The wave item that implements a member removes its `?` in the same change and migrates the fixtures.
   - Code written in later waves may rely on the member being present.
   - The exit gate (W8) removes any `?` that is left, except members that are **optional by meaning**. Those are
     tagged `@since P3 (optional by meaning)`, listed in full in §2.15, and never lose their `?`: an absent member is
     what keeps P1 and P2 bytes. The W8 test `contracts.optional-by-meaning.test.ts` gains the P3 rows.
   - **Fixtures.** Wave 0 adds the spreads `P3_CTX` (a `clock()` that returns an unset clock view; [S32] `files()` and
     `readFile()` over an empty store) and `P3_DEVICE` (`clockView` and `setClock`, which record their calls; [S24]
     `emitLog`; [S20] `egressPolicy`, which returns undefined) to `test/port.fixtures.ts`, as P2
     did with `P2_CTX`/`P2_DEVICE`. The item that makes a member required spreads them into the typed fakes §9 names.
   - **No tag collision.** No source file carries `@since P3` at 5263f16, so no retag is needed.
3. **Contract changes after wave 0** are the minimal additive fix, reported in the wave report.
   - **The SHOULD and COULD sets are decided before wave 0** (§8.5, recorded 2026-09-29). Wave 0 adds the contract
     blocks of every approved **[Sn]** and **[Cn]** item exactly like MUST blocks (the [C1] and [C13] blocks are written
     in full in §2.16 and §2.17), together with the compile stubs they force: a new `ProtoName` breaks the
     exhaustive `PROTOCOL_VOCAB`; a new `FsmMachine` breaks `FSM_VOCAB`, `FSM_MACHINE_LANES` and the typed record of
     `timeline.lanes.test.ts:111`; a new `ExtraTableName` breaks `TABLE_DESCRIPTORS`, `TABLE_LANES` and
     `timeline.lanes.test.ts:86`; a new `LaneId` breaks `LANE_VOCAB` and `DEFAULT_TIMELINE_LANES`
     (`apps/web/src/store/store.ts:77`); a new `DropReason` breaks `DROP_VOCAB`; a new `ConceptToolId` breaks the
     concept registry; a new `GuiPanelId` breaks `PANEL_TAB` (`inspector/tabs.ts:87`) and `SURFACE_PANEL_TAB`
     (`shared/openDeviceSurface.ts:38`); a new `MutationReason` breaks `REASON_ICON` and `REASON_LABEL`
     (`inspector/Provenance.tsx:72, :90`); a new `ErrDisableCause` breaks `ERR_DISABLE_CAUSE_TEXT`
     (`device/device.ts:210`); [S2] a new `DockTab` needs its `ALL_TABS` row (`dock/registry.ts`, hidden by its stage
     until W4) and its `app/Dock.tsx` entry. §9 W0 item 1 lists every file.
   - **Wave 0 adds types, constants and compile stubs only.** A W0 addition that would change behaviour — a runtime
     list a handler iterates (`ERR_DISABLE_CAUSES`, which `show errdisable recovery` prints), a table a model derives
     (`PROCESS_TABLES`), a value a function returns (`profileForCourse`) — lands in the wave item that implements the
     behaviour, and §9 lists the pins it moves there.
   - An item approved **later** is added by exactly one named wave item, which in the same change adds its block
     verbatim and the web stub entries it forces (a reviewed edit of the web owner's files). A block for a feature
     that is not approved is never added, so no dead vocabulary ships.
   - **Daemon names follow their factories.** A daemon name enters `PROCESS_ORDER` and `CAPABILITY_PROCESSES` only in
     the change that registers its factory (`protocols.registry.test.ts` pins the registry to exactly
     `PROCESS_ORDER`). §2.1 records each name's final position.
4. **Every change keeps the six checks green:**
   - `npx tsc -p packages/engine/tsconfig.json`
   - `npx vitest run --root packages/engine --project fast` (the lead also runs `--project slow` once per wave, §7 W0)
   - `cd apps/web && npx tsc -p tsconfig.json` (src only, so node types never leak into src)
   - **3b (new):** `cd apps/web && npx tsc -p tsconfig.test.json` (web tests are type-checked, P2 §14)
   - `npx vitest run --root apps/web` (worker count fixed by `apps/web/vitest.config.ts`, never by CLI flags)
   - `npm run build -w @netforge/web`

   Never run `npm install` or add a dependency without explicit approval. None is planned for P3a: the data-format
   parsers, the YANG model and the Python subset [S32] are written in the engine (D21). Pinned values change only
   through the migration list (§9).
5. **Silence rule.** A daemon sends nothing unless configured, where "configured" includes the lines and the
   invisible defaults a world's profile applies (D2). Every P0–P2 scenario, template, CCNA 1 and CCNA 2 lab and saved
   file keeps byte-identical traffic and trace (a file saved before P3a holds only lines the P1/P2 grammar accepted,
   none of which configures a P3 service, so D22's switch transport stays dormant in it). §4.3 gives, for every new daemon,
   the exact line that turns it on. **The proof is two goldens, not an argument:** `test/goldens/p1-profile-digests.json`
   (P2 W0, unchanged) and the new `test/goldens/p2-profile-digests.json`, recorded in P3 W0 **from the unchanged
   engine** (D3), which also holds two synthetic guard worlds (profile P1 and P2) that send DHCP, UDP and TCP to an
   addressed switch SVI, so the D22 guard is not vacuous. The only trace changes allowed are the ones §9.3 (P1
   profile) and §9.4 (P2 profile) list, each regenerated by the architect.
6. **Legal (D23).** Names, help, errors, show output, log messages, lab text and lesson text are original wording.
   Model names are `NF-…`. Vendor-proprietary wire formats are replaced by original NF formats (P2 D8); CDP is used
   as a name only. YANG models are IETF modules plus the original `nf-native`, never a vendor model.
7. **Seams are contracts, spelled out.** Every seam in P3a has an exact contract in §2: the action or request kind,
   every field, the table row shape, the event kind and who sends it to whom. An implementer who needs something that
   is not in §2 stops and reports it; it does not invent a private convention with a neighbour.
8. **Every wave ends with review → adversarial verify → fix.** Review reads the wave's items against this brief,
   clause by clause. Adversarial verify is a separate agent that tries to break each seam the wave touched (wrong
   event order, a port that flaps mid-negotiation, an absent daemon, an adjacency that never forms, the same seed
   replayed and diffed). Confirmed findings are fixed before the next wave; plausible but unconfirmed ones are listed
   in the wave report.
9. **Own tests only; one full suite per wave.** An implementer runs only its own test files (and the files §9 assigns
   to it); those tests depend only on earlier waves and its own item. The lead runs the six checks once at the end of
   the wave, after the fixes, plus the digest goldens (rule 5) at the end of every wave and inside every catalog flip.
   **Byte-risky items** (marked ⚑ in §7: the ipv4 and arp changes, nat's `filterOut`, eth-switch steps 7b/7c, the
   pipeline control check, udp's discard rule, the snapshot cache and the QoS marking hooks; with the approved items,
   tcp's hidden listeners [S13], the `emitLog` seam [S24], the hdlc encapsulation switch and PPP framing [S19], the
   tunnel, PPP, EIGRP and ESP rows of l3 [S18] [S19] [C1] [C13] and the p2p held queue [S20]) also run
   `accept.p2.p1-digests` and the four `accept.p3.p2-digests-*` shards as their own files, with the fixed worker
   count; they never re-record, so a byte change is found by the item that made it, not at the wave end.
10. **The built bundle is a gate item.** Every wave that touches `apps/web` ends with gate **G** (§10.3): build; start
    the `netforge-preview` launch configuration, which serves the BUILT bundle; in a real browser load the wave's
    named scenario, toggle every overlay added so far, open a terminal and type one command (synthetic paste for
    console lines), select one device and one packet; the console shows no error and no unhandled rejection. From the
    W4 flip on, engine-only waves run G too, because engine modules are bundled into the worker.
11. **Never weaken a test.** Acceptance tests (§10) are contracts: an assertion is never loosened, deleted or skipped
    to make a build pass. A test that pinned P1 or P2 behaviour changes only when §9 lists it, in the way §9 says.
12. **Module-scope reads of other modules are forbidden in new code.** Cross-module constants are read at call time.
    New registries (checkers, fact readers, overlay modules, lanes, control-frame rows, YANG nodes) are plain data or
    are built lazily on first use.
13. **Real worlds before the flip.** The catalog flips to P3 only in W4, but W1–W3 daemons are exercised in real
    simulations before then. W0 generalises `test/p2.world.ts` into `test/staged.world.ts`
    (`createStagedSimulation({seed, stage, profile, factories})`, the P2 helper's logic keyed by stage); P2's
    `createP2Simulation` stays as a wrapper (37 test files use it). The P2 exit gate reduced `p2.world.ts` to read the
    real catalog (`test/p2.world.ts:20-26`), so `staged.world` carries the P3 data as **test-only data** until the
    flip: the §2.1 final `PROCESS_ORDER` restricted to approved names, the P3 `CAPABILITY_PROCESSES` rows of §2.1 and
    the stage-filtered snooping tables of §2.6, applied when `stage` is `'P3'`. The W4 flip adds
    `staged.world.p3-parity.test.ts`, which asserts that this data equals the real contract; W8 reduces the helper to
    a wrapper. Seam tests, timing tests, parity tests and each wave's adversarial verify run on it; the W4 wired
    acceptance tests run on it too. Daemon tests configure devices through `startupConfig` or
    `DeviceRuntime.applyConfigLine`, which store lines through the config rules (W1 cli, `parseConfigText`,
    `device.ts:1395-1397`) without the grammar, so a W2 daemon never waits for the W2 grammar.
14. **Catalog flips run alone, after the wave's acceptance tests.** W4 runs in two steps: first qa's W4 acceptance
    tests pass on `staged.world`; then the flip change opens, and while it is open (W4, and W6 when a new model is
    approved) no other wave item is active in the tree. Inside it the lead runs `accept.p2.p1-digests`, the four
    `accept.p3.p2-digests-*` shards, `accept.p3.p2-exports`, `accept.p3.lab-status`, `accept.p3.silence`,
    `accept.p05.determinism`, `accept.p1.silence`, `accept.p2.silence` and every W4 qa file again, now against the
    real catalog, and nothing else merges until they pass. (`accept.p2.silence` builds its worlds on the P2-stage
    catalog of `p2.world.ts:136-146`, so it guards P2 worlds but proves nothing about the flip; `accept.p3.silence`
    (a) is the flip's silence proof.)
15. **Implementers never run whole suites, in parallel or otherwise.** They run only their own files (a byte-risky
    item's digest shards included, rule 9), with the fixed low worker count of the vitest configs. The lead runs the
    engine suite, then the web suite, serially, once per wave (fast project; the slow project once per wave and at
    every gate).
16. **Agents never run any git command.** The lead alone commits and pushes, and checks `git status` and the remote
    after every workflow run (P2 §14 process incident: an agent pushed to `master` during W6).
17. **Workflow scripts are resumable.** Each keeps a per-item state file outside the repository. Items are idempotent
    and write only their own files. Implement, review, verify, fix and full-check are separately resumable steps.
    Scripts contain no git call and no destructive reset.
18. **One owner per file, extended to shared registries.** Contracts, `index.ts` and `PROCESS_ORDER` belong to the
    architect. `protocols/index.ts` belongs to the flip owner. The pdu registry and dispatch table belong to pdu; an
    item that adds a codec adds its registry and dispatch lines as a reviewed additive edit in the same change.
    Grammar fragments are per area (`cli/grammar/<area>.ts`, owner cli). Display fields are split per protocol
    (`capture/filter/fields/<proto>.ts`, W2), with `capture/filter/fields.ts` kept as the index file that the
    pure-entry closure pins (`pure-entry.lint.test.ts:64-65`). Lab-check adapters (`sim/lab-checks/<area>.ts`), theory
    files (`theory-a` … `theory-d` by module group) and lab files (`sim/scenarios/ccna3/<area>.ts`) are split per
    area, each owned by the area that knows the feature (§7). An architect's W0 compile stub in a file another owner
    holds, and any edit one item makes in another item's file, is a **named reviewed additive edit**; §7 lists each
    such file with its one owner.
19. **`runToIdle` means converged, and every failure mode still lets it return.** A retransmission or retry that can
    repeat forever (OSPF DBD stuck in ExStart, a PPP authentication retry, an unanswered NTP poll) is a periodic timer
    or is capped (NTP's fast retries are six non-periodic polls, then only the periodic one, D19). Committed link
    events are not periodic, so a traffic flow that congests a link holds `runToIdle`: continuous flows are used only
    under `runFor`, and every flow stops at a hard cap (D16). `accept.p3.grader-bounded` asserts rule 19 over every
    lab's unsolved, solved and wrong-answer worlds; P2's EtherChannel item 22c is the one documented exception.
20. **Gradeable state lives in tables or configuration.** StateViews are for display (`show`, inspectors) only, so
    `LAB_RELEVANT_KINDS` (`configChange`, `tableWrite`, `portState`, `assocState`; `bridge/worker/labs.ts:23`) stays
    right: every fact reader names its table or configuration source (§2.10), and every change a lab can grade emits
    one of those kinds (the device clock is graded from the ntp daemon's `clock` row, so `clock set` is a tableWrite
    too). A check run inside a grader clone may read the
    clone's StateViews (the P2 ping precedent, `sim/lab-checks.ts:847-891`), because it drives the clone itself; a live
    check never does. A periodic refresh never rewrites a row unless a displayed column changes (otherwise hellos would
    trigger the worker's automatic re-check every two seconds of wall time).
21. **No deploy before the exit gate.** Nothing is pushed to the production branch (`master`, which the live site
    serves) before the W8 exit gate passes and the product owner approves it. Wave commits go to a `p3` branch only;
    the lead alone pushes, and after every workflow run checks that the remote `master` still points at the last
    gate-approved commit (5263f16 until P3a's gate) and that no branch moved unexpectedly. This encodes the P2 §14
    incident: an agent pushed an intermediate W5 build to `master` and the live site served it for four days. It also
    keeps the intermediate states between W4 and W7 (CCNA 3 labs listed while the course is still "planned") away from
    learners.

---

## 1. Fixed decisions D1–D27 and the chosen designs

Each decision names the design chosen and the alternative rejected, with the reason. Items marked **[Sn]** or
**[Cn]** are SHOULD or COULD items of §8. The product owner approved S1, S2, S3, S9, S13, S18, S19, S20, S21, S24,
S25, S32, S37 and C1, C13 (§8.5, 2026-09-29): their decisions bind like MUST decisions. The decisions of every other
bracketed item are designs recorded for the stage §12.1 names; they bind only if that item is approved later.

**D1 — One stage, one contract set, cut lines; the platform waits for P3b.**
P3a delivers the CCNA 3 engine requirements of spec §2.3 that §8.5 approves, the visualizations that make them
teachable, and the CCNA 3 course. Work is ranked in §8 into MUST, SHOULD and COULD; waves (§7) put the most
foundational MUST work first and the optional work in bracketed items, so a cut removes whole wave items and never a
piece of a seam. **Rejected: the spec's single P3 stage** (content plus assessment engine, studio, LTI and
collaboration in five months). The platform needs a backend, tenancy and a deployment decision (managed services or a
self-hostable stack) that are independent of CCNA 3 content; only the seams that make it cheap are built here (D6).

**D2 — A `'P3'` defaults profile; CDP is its only default in the MUST plan.**
- `DefaultsProfile = 'P1' | 'P2' | 'P3'`; `Topology.profile?: 'P2' | 'P3'` (`'P3'` needs schema 1.3, §2.9). The P2 D2
  machinery is reused unchanged: visible defaults are replayed lines (`DeviceModel.profileConfig`), invisible defaults
  are read from `ProcessCtx.profile` through `profileIncludes(profile, 'P3')`.
- **Which worlds are P3.** Every CCNA 3 lab. A new world takes the profile of the course context. `Course.profile`
  is set as data in W0 (`ccna1` P1, `ccna2` P2, `ccna3` P3 while CCNA 3 is still `planned`), but nothing reads it
  until the W7 course flip: until then `profileForCourse` keeps its P2 rule (`ccna1` → P1, anything else → P2,
  `learn/course-profile.ts:20-22`) and `LATEST_DEFAULTS_PROFILE` is `'P2'`. The W7 course flip changes both in one
  change (§8.5 P15): `profileForCourse(id) = courseById(id)?.profile ?? LATEST_DEFAULTS_PROFILE` and
  `LATEST_DEFAULTS_PROFILE = 'P3'`. So before W7 nothing a learner can open changes profile; after it a CCNA 2 lesson
  keeps opening P2 worlds (its text is written against P2 behaviour), CCNA 3 lessons and the sandbox with no lesson
  open P3 worlds, and every saved P2 file and CCNA 2 lab stays a P2 world. Nothing reaches the live site before W8
  (rule 21).
- **The one invisible default (MUST): CDP runs.** A device whose model has `cdpDefault` (derived in `define.ts`:
  `!nat-gateway && ((cli.shell === 'nfos' && (routing || managed-switch)) || wireless-controller)` — routers, managed
  and multilayer switches with a CLI, and the controller; never home routers (`nat-gateway`, shell `none`,
  `define.ts:377`), lightweight APs, hosts or other GUI-only devices) runs CDP when `profileIncludes(profile, 'P3')`
  unless `no cdp run` is stored. `cdp run` / `no cdp run` and the per-interface `cdp enable` / `no cdp enable` are
  `bothForms` slots (P2 §5), so either form typed in any profile survives export, reload and the grader's clone, and
  `cdp run` typed in a P2 world works (the profile never gates a feature). The running configuration of a default P3
  world shows no CDP line, as on real devices.
- **Defaults that come with approved SHOULD items** (both approved, §8.5 P1 and P3). [S24] adds the visible lines
  `service timestamps debug datetime msec` and `service timestamps log datetime msec` to `profileConfig.P3` of routers,
  managed switches and the controller (with a config rule of identity 3, §5.7, so the two lines do not overwrite each
  other); the W4 flip writes them. [S25] adds the invisible "extended logging" default: the interface and
  line-protocol change logs, the restart and configuration logs, and console log printing at level debugging. So a
  P3 world has three defaults: CDP (MUST), the two timestamps lines [S24] and extended logging [S25]; each has its
  §4.3 row and passes the rule below.
- **The rule for any P3 default** (binding on every area): a default enters P3 only if (a) the real device does it
  with no line shown or shows the line by default, and (b) a CCNA 3 objective teaches that default. Each is a row of
  §4.3. Every other P3 behaviour (LLDP, NTP, OSPF, ACLs, QoS, snooping, the API, and the approved EIGRP, PPP, tunnels,
  IPsec, the remote terminal, syslog and scripts) is opt-in in every profile.
- **Upgrading a world.** "Use current defaults" becomes a ladder in the engine, `sim/defaults-upgrade.ts` (pure; also
  used by the goldens and by P3b): the step to P2 keeps P2's `ip routing` preservation; the step to P3 rewrites no
  line. The status-bar chip stays for P1 worlds only; the File menu item is enabled whenever the profile is below
  `LATEST_DEFAULTS_PROFILE`, and its hint lists what changes from a `PROFILE_NOTES` data record.
- **Rejected: CDP on in every profile.** It puts new PDUs into every P1 and P2 world, breaks every digest and
  `accept.p2.silence` case (b) ("the only P2-daemon PDUs are BPDUs") and changes every CCNA 2 lab's trace.
  **Rejected: CDP opt-in everywhere.** The CCNA 3 lessons would teach a false default (real devices answer
  `show cdp neighbors` out of the box, and hardening means turning it *off* at the edge), and a sandbox would need a
  `cdp run` line no real configuration shows. **Rejected: the management map's larger default set in the MUST plan**
  (visible timestamps lines, console logging and the realism logs as MUST defaults): each is kept, but tied to the
  SHOULD item that builds its consumer, so the MUST profile adds exactly one behaviour and one silence row.
  **Rejected: CDP on the lightweight AP** (the management map): NF-AP-1832 runs no `vlan` daemon, its transparent path
  never classifies control frames (`protocols/l2/control.ts:4-6`) and bridges the switch's CDP onto the radios, so it
  would send CDP it could never receive; a receive path would be a new transparent-path rule for a device no CCNA 3
  objective asks about. **Rejected: flipping `LATEST_DEFAULTS_PROFILE` at the W4 catalog flip** (the cross-cutting
  map): between W4 and W7 the sandbox and File → New would open P3 worlds (CDP on) with no lesson that explains them.

**D3 — P1 and P2 worlds stay byte-identical, proved by goldens recorded before any P3 code.**
- `goldens/p1-profile-digests.json` and `accept.p2.p1-digests` stay; the test's guard migrates (§9 W0 item 3).
- **New, W0, architect, from the unchanged engine at 5263f16:**
  - `goldens/p2-profile-digests.json` over 32 worlds: the 20 CCNA 2 labs loaded exactly as the worker's
    `loadScenario` loads them (seed, lab stamp, scheduled faults); the 9 templates loaded with `profile: 'P2'`; one P2
    sandbox built by `addDevice` (NF-C2960, NF-C3650-24, NF-2911, NF-AP-1832, NF-WLC-9800, two PCs), which pins the
    new-world `profileConfig` path; and **two synthetic guard worlds**, `guard-switch-svi` in profile P1 and in
    profile P2: an NF-C2960 with Vlan1 addressed and up, an NF-2911 serving DHCP on that VLAN, two DHCP PCs (their
    DISCOVER and REQUEST broadcasts reach the SVI), a `traceroute` from the router to the SVI and a browser fetch from
    a PC to `http://<SVI address>`. No shipped world addresses a switch SVI in a VLAN that carries UDP or TCP
    (`ccna1/foundations.ts:337` has a static admin PC only; the CCNA 2 SVIs sit in VLAN 99 with static hosts,
    `vlans.ts`, `trunks.ts:55`, `intervlan.ts:53`; the DHCP labs leave SW1 unaddressed, `ccna1/services.ts:79, :193`),
    so without these two the D22 guard would measure nothing. The script is P1's: boot 60 s → solution → 30 s → a
    chosen ping → 20 s → a chosen `show` → `runFor(600 s)`; the guard worlds replace the ping with the DHCP leases, the
    traceroute and the fetch. The chosen `show` of every world is one whose output no §9.2 item changes (never
    `show errdisable recovery`, whose rows change in W2).
  - **Storage** (P2 worlds emit background BPDUs, so the P1 format would reach tens of MB): the digest and per-kind
    counts over **all** events; per-10-second-window digests (a mismatch names its window); full `p0EventLine`s only
    for events not attributable to a background PDU (at most 2 MB in total); the typed results; the snapshot hash and
    parts, normalised by the per-device rule of §4.6 against a recorded `p2Vocabulary`.
  - `goldens/p2-lab-exports.json`: the exported topology text of every CCNA 2 lab after load (the twin of
    `p1-template-exports.json`).
  - `goldens/lab-status.p2.json`: the `evaluateLab` status, with every detail string, of all 35 existing labs (CCNA 1
    and 2), unsolved at 60 s and solved at the end. It proves the grader refactor (D5) behaviour-identical.
- The digest test is sharded into four files, `accept.p3.p2-digests-templates.test.ts`, `-labs-a`, `-labs-b` and
  `-guards` (hyphenated, so the coverage test's file pattern matches them, §10.1), plus one harness,
  `test/p2-digests.harness.ts`, and runs in the slow project. Only the architect re-records, with
  `NF_RECORD_P2_DIGESTS=1`, and attaches the diff to the wave report; the lead runs all digest tests at every wave end
  and inside every flip, and byte-risky items run them as their own files (rules 9, 14).
- **Rejected: arguing silence without a P2 golden** (P2 learned that only goldens catch seams). **Rejected: the P1
  storage format** (every event line) for P2 worlds. **Rejected: one combined `p12-digests` test**: the P1 golden is
  already pinned and green; a second file with its own storage rule is cheaper to reason about.

**D4 — Fidelity fixes apply in every profile, as listed digest changes; existing messages never change.**
- A defect fix that changes P1 or P2 behaviour (for example the cross-cutting map's "a multilayer switch relays DHCP
  with `no ip routing`") is made in all profiles and recorded in §9.3 or §9.4 with the exact events that move. This is
  a product-owner decision (§8.5); the recommendation is yes.
- Existing log and debug messages keep their text and severity in every profile. The P1 admin up/down log (severity 3
  where real devices use 5, `device.ts:1528-1538`) stays as it is and is a listed deviation; new messages appear only
  on new code paths.
- **Rejected: gating a defect fix by profile.** It doubles the behaviour to test forever and accumulates special
  cases. **Rejected: the management map's re-severitied admin-down log in P3 worlds only**: one event would then have
  two texts depending on the world, and every P1/P2 digest that brings a port up would still need the old one.

**D5 — The grader becomes a registry: generic kinds, per-area adapters, a feedback envelope.**
- `sim/lab-checks.ts` (1214 lines, one closed `switch` at :1137) keeps `evaluateLab` and the clone host. The P1/P2
  checkers move **verbatim** to `sim/lab-checks/{core,switching,routing}.ts` (proved by `lab-status.p2.json`); P3
  checkers live in `sim/lab-checks/{ospf,acl,hardening,qos,discovery,time,automation}.ts`, each owned by the area
  that knows the feature (§7).
- `sim/lab-checks/registry.ts` assembles `CHECKERS satisfies { [K in LabAssertion['kind']]: Checker<K> }`, exhaustive
  by type and built lazily (rule 12). W0 ships stub cases for the new kinds in the existing closed switch
  (`sim/lab-checks.ts:1137`, the only place they compile before the registry exists), each failing with one original
  "not available in this build" detail (as P2 did with web vocabulary stubs); W1 sim moves them into the registry.
- **Generic kinds** (§2.10): `neighbor`, `fact`, `acl`, `aclDecision`; widened `connectivity`, `route`, `table` and
  `LabFault`; the approved [S18] `path` (with [C13] `tunnelAt`); [S38] `packetSeen` is not approved. Protocol areas plug in data, not code in the core:
  `NEIGHBOR_SOURCES: Record<NeighborProtocol, …>`, `FACT_READERS: Record<LabFactName, {type, read}>` (a declared
  value type, so a lint test checks every lab's `equals` and the P3b studio can list facts from data) and
  `IDENTITY_SOURCES` (router ids and similar). A device **name** in an assertion matches a row whose peer is any
  identity of that device: hostname, any interface address, base MAC or a protocol router id. Every fact reader names
  its table or configuration source (rule 20): `ospf.routerId` reads the `routerId` column of the device's
  `ospf-interfaces` rows (the router id in use, not the configured one), the `clock.*` facts the ntp daemon's `clock`
  row (§2.6).
- **A typed kind is added only** when it compares three or more fields of one row or needs resolution beyond a port;
  otherwise it is a `fact`. Each assertion carries an optional `feedback` / `misconception` envelope (spec §12.4).
- Clone results are memoised by the canonical hash of the clone input (exported topology plus runtime L1 state,
  deterministic by the P2 guarantees), so routine re-checks never rebuild clones.
- **Rejected: the areas' ~25 typed kinds** (`ospfNeighbor`, `ospfInterface`, `ospfProcess`, `ospfLsa`,
  `dhcpSnooping`, `arpInspection`, `remoteAccess`, `neighbour`, `ntp`, `syslog`, `api`, …) added to the closed switch:
  one file owned across four areas, overlapping semantics, and a studio that could not list assertions from data.
  Each is expressed with a generic kind in §2.10's mapping table.

**D6 — Seams for P3b; every input is a journaled facade op; no new op without a user.**
- **Every input stays a facade op** (P2 §2.13): `configure`, `cliExec`, `hostRequest`, the topology ops. P3a's new
  inputs are all of these kinds: the host-shell `rest` and `flow` commands are `cliExec`; the traffic generator app
  and [S27]/[S32] apps are `hostRequest`. A device changes its own configuration only through the `configure` action
  (D21), a deterministic consequence of replayed events that is never journaled, and a remote session's server side
  (D14) is likewise a consequence of the client's journaled lines. Replay-exact time travel therefore covers everything
  P3a adds. P3a adds no journal op ([S31], not approved, would add `cliBreak`).
- **No `apiRequest` journal op in P3a.** It would have no user until P3b exposes an external API; P3b adds it with that
  API (rule 3: no dead vocabulary).
- **[S37] Labs as data.** `contracts/lab-document.ts` (`LabDocument`, format `netforge.lab/1`, the spec §13.1
  `activity.json`), a zod schema in `io/lab-schema.ts`, `labDocumentOf(s)` / `scenarioOf(doc)` with a round trip over
  every built-in lab, a `lab-versions.json` golden that fails an edit without a version bump, a pure headless
  `gradeTopology(doc, submission)` in `sim/grade.ts` with a parity test against live grading, and a `resolveLab(ref)`
  seam replacing `SCENARIOS.find` in the worker (`bridge/worker/labs.ts:31`).
- `ScenarioInfo.customChecks` is used by no lab and no task (`contracts/scenario.ts:205`, `:216`; not run by the
  grader, `sim/lab-checks.ts:103`): W0 marks it `@deprecated`, W8 removes it.
- **Rejected: building a platform piece in P3a** (backend, tenancy, LTI, studio). **Rejected: any side channel** by
  which scripts, playbooks or API calls change a device without a facade op or the `configure` action (it would break
  replay, time travel and, later, collaboration's unit of sync).

**D7 — OSPFv2 is an `ospf` daemon over a pure library, speaking RFC 2328 bytes; one process per device.**
- `ospf` (`router ospf <pid>`) and, [S6], `ospfv3` (`ipv6 router ospf <pid>`) are separate daemons that share pure
  modules in `protocols/ospf/` (ism, nsm, dr, hello-check, flood, lsdb) and in `core/` (`ospf-spf.ts`,
  `ospf-lsa.ts`: sequence, age and newer-instance rules, Fletcher checksum). Each writes only its own tables.
- **Wire format:** OSPF is IETF, so RFC 2328 (v3: RFC 5340) byte-exact. One codec `ospf` with a `version` field; each
  LSA, or each LSA header in DBD and LSAck, is its own chained `ospf-lsa` layer, so the inspector shows one card and
  one hex range per LSA; variable lists are flat string fields (as CAPWAP did in P2); `stopsMeaning` is true. Packet
  checksum is the IP one's complement over the packet minus the authentication field; the LSA checksum is Fletcher
  excluding the age.
- **Transport:** IP protocol 89 (`IPV4_UPPER` row, `protocols/ip-upper.ts:33-44`). The daemon builds
  `[ipv4 {src, dst, ttl 1, protocol 89, dscp 48}, ospf …]` (DSCP 48 = the classic TOS 0xc0; the ipv4 codec has `dscp`
  and `ecn`, no `tos`, `fields.ts:94-95`) and requests `ipv4.send {pdu, iface, nextHop}`. A **new
  `arp.sendVia` rule** (after the HDLC branch, beside the broadcast rule at `arp.ts:337-344`) never resolves an IPv4
  multicast next hop and frames it to `01:00:5e` plus the low 23 bits (RFC 1112); serial HDLC is unchanged because its
  branch runs first. Groups are joined with the existing `ipv4.group` request (HSRP's, `ipv4.ts:951-964`): 224.0.0.5 on
  every non-passive OSPF interface that leaves ISM Down, 224.0.0.6 on entering DR or Backup. Switches flood 224.0.0.x
  (no snooping); hosts drop hellos at pipeline step 10b as background.
- **Configuration model:** one OSPF process per device (a second `router ospf <m>` is refused with
  `CLI_MESSAGES.ospfOneProcess`, keeping the identity-2 rule of `config-rules.ts:158-161`); `network A W area X`
  enables an interface whose primary address matches (most specific wildcard, then configuration order), and
  interface `ip ospf <pid> area <a>` overrides it; network type by role — `wan` (serial HDLC) point-to-point, `routed`,
  `subif`, `svi` broadcast, loopback a /32 host stub unless `ip ospf network point-to-point`, [S18] `tunnel`
  point-to-point; router id = `router-id` > highest up loopback > highest up interface address, chosen at process
  start (a later change prints `ospfRouterIdLater` and applies at `clear ip ospf process` or reload); `router ospf` is
  refused while `no ip routing` is stored (`ipRoutingSwitchedOff`, `ipv4.ts:271`).
- **Rejected:** one daemon for both families (two RIB owners and table writers in one process; v2 and v3 LSAs
  differ); an NF format (only vendor-proprietary L2 protocols get NF formats); building frames in the daemon as
  `hsrp.ts:247-278` does (it duplicates HDLC framing and is wrong on serial links, an OSPF staple); several processes
  per device (not CCNA material; every show, debug and network path would become multi-process).

**D8 — RIB integration by batch, and a registration-based RIB watch.**
- New request `ipv4.routes {owner, rows}` **replaces** the owner's whole candidate set. Rows sharing a key are
  equal-cost paths in path order; the arbiter owner is `${owner}|${slot}`, so a changed next hop is a re-offer in
  place (one tableWrite). ipv4 applies the batch in ascending (network u32, prefix length) order — re-offer changed
  slots, offer new ones, withdraw vanished ones — runs `settleStatics` once, sends no decision event, and emits one
  `ip routing` debug line per installed-row change. Per-route `ipv4.route` (`ipv4.ts:885-907`) costs two actions per
  route against `ACTION_BUDGET = 1000` (`device.ts:198`, `:946-954`); one SPF on a 500-prefix area would exceed it.
- Administrative distances: connected 0, static 1, OSPF 110 (`AD_OSPF`), DHCP default 254; [C1] EIGRP 90
  (`AD_EIGRP`; external 170 and summary 5 arrive with redistribution and summarisation, P5). OSPF picks its own best
  per prefix first (intra-area > inter-area > E1 > E2, then cost), up to `maximum-paths` (default 4, bounded by
  `IPV4_MAX_PATHS`); [C1] EIGRP offers its successors, up to its own `maximum-paths` (D26). `multipathEligible`
  (`ipv4.ts:445`) widens to `(source === 'S' && !owner) || source === 'O' || source === 'EIGRP'` (the last term is
  [C1]'s, added by W1 l3).
- Paths through an interface that goes down are withdrawn at link-down, before SPF, as real routers do; the SPF 5 s
  later computes alternates. D13 of P2 ("install when usable", `ipv4.ts:761-786`) already treats any installed
  non-static route as usable, so a static whose next hop is learned by OSPF and a floating static above AD 110 work
  unchanged.
- **RIB watch.** `ipv4.ribWatch {owner, keys?, lpm?}` registers interest: exact RIB keys (OSPF's
  `default-information originate` watches `0.0.0.0/0` and the connected keys of DHCP-addressed OSPF interfaces) and
  longest-match results for addresses (an unsynchronised NTP client watches the route toward its server, D19; [S18]
  the tunnel owner watches each tunnel destination, GRE and [C13] IPsec alike). ipv4 answers at once and afterwards on
  every change with
  `ipv4.ribChanged {key?, row?, lpm?}` **to that owner only**; `keys: []` and `lpm: []` stop the watch. A world that
  configures no OSPF, NTP or [S18] tunnel never registers one, so no P1 or P2 world sees the event.
- **Rejected:** per-route requests (action budget); OSPF writing the `rib` table itself (breaks the single-writer
  arbiter and the floating-static interplay); polling on a timer; ipv4 fanning every RIB change out to every routing
  daemon; the WAN map's separate `rib.changed {family}` broadcast to devices that own a tunnel port (a second
  mechanism for the same need). Known arbiter deviation: at equal AD across protocols `better` compares metrics
  (`core/rib-arbiter.ts:156-160`); real routers keep the first installed. Rare and listed.

**D9 — OSPF timers use the real defaults; the idle rule decides which are periodic; nothing draws randomness.**
- Hello 10 s, dead 40 s, wait 40 s, retransmit 5 s, MinLSInterval 5 s, MinLSArrival 1 s, SPF first run 5 000 ms after
  a change then at least 10 000 ms apart, LSRefreshTime 1800 s, MaxAge 3600 s. The full table with periodic classes
  is §4.2.
- **Hello reply.** 1 s after any neighbour on an interface goes Down → Init, the interface sends one extra hello
  (coalesced). Without it a point-to-point adjacency needs the second periodic hello (+10 s), by which time only
  periodic timers remain and `runToIdle` (and the grader clone) would return **before** the adjacency exists. It is
  RFC-compatible (one open-source router does it); real devices may wait up to one hello interval. Listed deviation.
- **Hello on a DR/BDR change.** When an interface's (DR, BDR) pair changes, the interface arms `dr-hello:<if>` (0 ns,
  non-periodic, coalesced per interface; the periodic `hello:<if>` is not moved), which sends one hello at once unless
  a hello already left the interface after the change (a periodic one due in the same instant). RFC 2328 §9.4 reruns
  the election only on a router that itself became or stopped being DR or BDR, so at the wait expiry a router that
  computes DR = BDR = the other router goes DROther and learns it is Backup only from a hello in which the DR declares
  itself; at U + 40 s the periodic hello and the wait timer are due together, and when the periodic one runs first
  (the scheduler's fixed order), the DR's next declaring hello would otherwise be the periodic one 10 s later. With
  the rule the sequence of §3.1 step 4 completes within a millisecond whatever that order is. RFC-compatible; listed
  deviation (real devices wait for the periodic hello).
- **A fixed order for the two throttles.** An `lsa-gen` due at the same instant as `spf` runs first: `spf`, on expiry,
  first performs every origination due at or before now, then computes, whatever order the two timers were armed in.
  A router's SPF therefore always sees its own newest LSAs; a neighbour's LSAs re-originated in the same instant need
  propagation and are picked up by the next SPF, 10 s later. §3.2 and §4.2 give the resulting timings (routes on a
  point-to-point link at link-up + 15 s).
- **No randomness.** The initial DD sequence number is `(u32(ownRid) ^ u32(nbrRid) ^ (attempt << 16)) & 0x7fffffff`
  (attempt = a per-neighbour restart counter); LSA sequences start at 0x80000001; control frames still consume the
  five `link:<id>` draws per frame (P0 invariant), so only worlds that configure OSPF shift loss patterns on lossy
  links.
- **Rejected:** hello jitter from a stream (spec §4.2 mentions it; no teaching value, fuzzy lab timings, and the P2
  precedent is that no control plane draws); instant SPF (it hides the 5 s convergence learners measure, spec §9.7);
  delayed acknowledgements (an extra timer per interface for no learner-visible gain; acks are direct and immediate —
  listed deviation).

**D10 — SPF is one pure function used three times.**
`core/ospf-spf.ts`, exported from `@netforge/engine/pure` (which may not import `protocols/`, `pure.ts:8-10`),
provides `buildSpfGraph(lsaRows, area)`, `runSpf(graph, rootRid) → {tree, nextHops}` (bidirectional-link check,
ECMP), `spfSteps(…)` (frames of settled vertex, tentative list with costs and parents, relaxed edges) and
`ospfRoutes(…)`. The daemon, the grader (`fact ospf.lsdbSynced`, `route` checks) and the web SPF stepper [S3] all
call it; the daemon's StateView carries the final tree per area, and a test asserts the stepper's last frame equals
it. **Rejected:** a separate web implementation (it could disagree with the router); tracing every Dijkstra step
(heavy, needed only on demand).

**D11 — Route codes: a second legend line only when routing runs; 'D' stays DHCP, EIGRP is `'EIGRP'` shown as D.**
- `RouteRow.source` gains `'O'` with `routeType?: 'E2'` (optional by meaning; absent on an `'O'` row = intra-area;
  [S4] adds `'IA'`, [C6] `'E1'`, [C4] `'N1' | 'N2'`, §2.6). Display codes `O`, `O E2`, `O*E2` ([S4] `O IA`).
  `routeCause` (`ipv4.ts:244-253`) renders the provenance cause `ospf 1: O 10.3.0.0/24 [110/3] via 10.0.12.2`
  ([C1] `eigrp 100: D 10.4.0.0/24 [90/3328] via 10.0.12.2`).
- The P1 legend line (`cli/handlers/show.ts:320`) stays byte-identical: typed `show ip route` outputs are pinned by
  the P1 digests. A second line is printed only when a routing process is configured, and names only the sources of
  the processes that are configured: with OSPF, `Dynamic sources: O - OSPF, IA - OSPF inter area, E1/E2 - OSPF
  external type 1/2`; [C1] with EIGRP, `D - EIGRP` is appended (or is the whole list when only EIGRP runs), followed
  by the sentence `A D* route at distance 254 was learned by DHCP.` whenever the table also holds a DHCP default.
- **The 'D' clash (binding: [C1] is approved, §8.5 P5).** `RouteRow.source 'D'` is the DHCP-learned default
  (`contracts/tables.ts:134`, AD 254, P1 bytes), and 'D' is EIGRP's letter on real devices. EIGRP's machine source is
  therefore the new value `'EIGRP'`, rendered `D` in `show ip route` and in `routeCause`; the DHCP default keeps
  `'D'` and its rendering `D*` (`[254/0]`). The two are told apart by the machine source everywhere a program reads
  them — lab `route {source}` assertions, `fact` readers, the overlay, the provenance cause — and by distance and the
  legend sentence where a learner reads them. `D EX` (external EIGRP) needs redistribution, which is P5; C1 never
  produces it. **Rejected:** renaming the DHCP code (moves P1 tableWrite bytes); EIGRP reusing `'D'` as a machine code
  (lab `source` assertions and the contract meaning would become ambiguous); a different display letter for EIGRP
  (every lesson, exam question and real device shows `D`).

**D12 — ACLs: an `acl` daemon over a pure matcher, hooked by ipv4 at the real order of operations.**
- `core/acl.ts` (standard lists for NAT today, header `:5`) gains extended IPv4 lists: protocols, addresses with
  wildcards, `eq|neq|lt|gt|range` ports with named ports, ICMP types and names, `established`, `log` / `log-input`,
  remarks. It stays pure and is exported from `pure.ts` (`tupleOf`, `evaluateAcl → {action, seq, implicit?, trail}`,
  `readAcls`, `parseAclEntry`, `aclEntryText`, `wildcardMatches`, `rangeToAces`, `lintAcl`). `readStandardAcls` is kept
  for NAT, with one change: it ignores a trailing `log` on a standard entry, so a NAT list never silently loses a
  logged entry (`parseStandardAclEntry` refuses the extra token, `core/acl.ts:72`, and stays as it is,
  `core.acl.test.ts:35`; the P2 grammar has no `log`, `grammar/acl.ts`, so no P2 document changes).
- **The daemon.** A new `acl` daemon owns the `acl` table (single writer), the compiled-list cache (invalidated by
  configuration deltas), log aggregation, the ICMP rate limit and `clear access-list counters`. ipv4 (and nat, on its
  outbound seam) hand packets over with the continuation request `acl.filter {family, dir, iface, pdu, onPermit}`; the
  daemon answers with exactly one of `onPermit`, or a drop plus (rate permitting) an ICMP error.
- **Where filtering happens.** Inbound: right after the IPv4 header checksum, **before NAT inbound and before the
  for-me test**, so traffic to the router itself is filtered (relay broadcasts, OSPF hellos — an implicit deny breaks
  an adjacency, which is faithful) and an ACL on a NAT outside interface sees global addresses; a packet denied there
  never allocates a NAT row. Outbound: after routing, the TTL decrement and NAT outbound, so it sees the translated
  source — and, as on real devices (NAT precedes the output list), NAT has already allocated its row when the list
  denies (`nat.ts:712-715`); transit packets only (locally originated packets are never filtered outbound). The
  hooks copy NAT's pattern (`natRoles` at `ipv4.ts:408`, `natHooked` :922-924, inbound :1223-1227, outbound
  :1098-1101, `ipv4.resume` :1285-1290) and exist only when an
  `ip access-group` line is stored and the model runs `acl`. NAT keeps its P2 seam unless ipv4 sets `filterOut` on
  `nat.outbound`. Bridged traffic never reaches ipv4 (router-ACL semantics); `ip access-group` on a switchport is
  refused (no port or VLAN ACLs, deferred).
- **Semantics.** First match wins, implicit deny at the end. An **undefined list bound to an interface permits
  everything**, as on real devices (NAT keeps its own rule, `acl.ts:109-112`). [S11] IPv6 lists end with an implicit
  `permit icmp any any nd-na`, `permit icmp any any nd-ns`, `deny ipv6 any any`, so an explicit
  `deny ipv6 any any` breaks neighbour discovery — the classic lesson.
- **Counters are rows.** One `acl` row per entry plus the implicit row(s), and only for lists applied as filters
  (`ip access-group`, [S11] `ipv6 traffic-filter`, [S13] enforced `access-class`). Each hit is one tableWrite carrying
  `lastPdu`; that gives the row flash, the timeline `security` lane, the provenance "permitted" chip and generic
  assertions. NAT's use of a list is never counted (P2 bytes; listed deviation).
- **Logging** (`log`, `log-input` [S12]): the first packet of a flow (list, seq, protocol, addresses, ports) is logged
  at once, severity 6, facility `ACL`, original wording; then one aggregated line per flow every 5 minutes from a
  periodic `acl-log` timer armed only while aggregates are pending.
- **ICMP answers.** A denied packet gets ICMP 3/13 unless `no ip unreachables` [S12] is set, at most one per 500 ms per
  device (`ACL_UNREACH_RATE_NS`, integer), so a router ping shows `U.U.U`. For a `dir: 'out'` deny, `acl.filter`
  carries `inPort` (the packet's ingress interface), so `icmp.error` sources the error from it as for any forwarded
  packet (without it, `icmpv4.ts:511-514` would use the egress interface). A packet NAT translated first (the
  `filterOut` path, flagged `natted`) gets no ICMP: its source is now the router's own global address (listed
  deviation). TCP maps 3/13 to the soft error `admin-prohibited`, a new `sock.error` code.
- **`established`** matches a TCP segment whose flags contain ACK or RST; it is stateless and the lesson says so.
- **Sequence numbers.** `ConfigNode.seq` (optional by meaning) is kept on ACL entry nodes, set by a leading number in a
  list mode or last + 10. The running configuration renders entries without it (as real devices do); `show
  access-lists` shows it; replay from text (reload, export, the lab clone) renumbers 10, 20, … exactly as a device
  does after a reload. `ip access-list standard|extended <number>` keeps P2's storage (a section named by the number,
  `config-rules.ts:280`, so P2 documents reload unchanged); a numbered section and the global `access-list N` lines
  of the same number are one list, global lines first (P2's join rule, `readStandardAcls`), numbered 10, 20, … over
  the whole list on replay; `ip access-list resequence` is supported.
- **One list per direction.** `ip access-group` stores one line per direction per family; the handler removes the
  same-direction line first (the allowed-VLAN handler precedent). Drops carry a structured `rule` (optional by
  meaning, §2.4) for "why was this dropped" and clickable markers.
- **Rejected:** ACLs inline in ipv4 (its handles and StateView are pinned, `ip.ipv4.test.ts:403-409`, ipv6 would
  duplicate the logic, and counters would need a table writer inside ipv4 — P2 D14's reasoning); counters in a
  StateView (no flash, no lanes, no generic assertion); rows for every configured list (NAT lists of P2 worlds would
  write rows at boot); outbound filtering before NAT (wrong answer to "which address does the outside ACL see");
  visible sequence tokens in the running configuration; silent drops (learners see misleading timeouts).

**D13 — Access-layer hardening runs inside eth-switch's per-frame path.**
- New steps in the VLAN-aware path: **7b DHCP snooping** and **7c dynamic ARP inspection**, after port security
  (step 7, `eth-switch.ts:901-907`); [S15] **2a/7a IP source guard**; [S16] storm control, evaluated lazily. Decisions
  come from pure modules `protocols/l2/{dhcp-snooping,arp-inspection,rate-window}.ts` ([S15] `source-guard.ts`, [S16]
  `storm-control.ts`), the port-security pattern (`protocols/l2/port-security.ts:1-21`). eth-switch writes the new
  tables. They hang off `vlan` (P2 D12 precedent) but only through the stage-filtered derivation the W4 flip adds
  (§2.6): a model declares them only at stage P3 and only with `managed-switch`, so no P1/P2-stage model and never the
  controller (which runs `vlan`) derives them. W0 adds only their `ExtraTableName` members.
- **Bindings** are learned from a DHCPACK that arrives on a trusted port **or** is sent by the switch's own SVI (relay
  or server on a multilayer switch, in `onEgressVlanAware`); the client port comes from the CAM entry for
  (VLAN, chaddr). They go away on RELEASE or NAK from the binding's port, at lease end (the existing periodic
  `cam-sweep` also expires bindings), and at link-down of the port. Static bindings come from `ip source binding …`
  lines, derived idempotently like secure CAM rows. The MAC check (chaddr = Ethernet source) is on by default. Option
  82 is not inserted (listed deviation).
- **DAI.** On untrusted ports of inspected VLANs an ARP is valid when [S14] an ARP ACL permits it or a binding exists
  with (VLAN, port, MAC = sender MAC, IP = sender IP); requiring the port to match is a listed deviation. Rate limit 15
  pps by default in 1-second windows aligned to sim-time seconds; exceeding it err-disables the port
  (`arp-inspection`). Invalid ARPs are logged at severity 4, at most 5 lines per VLAN per second.
- **Rate limits are proven by tests, not by learners.** No MUST sender produces a DHCP or ARP burst (a DHCP server
  sends one OFFER per DISCOVER; the traffic generator's payload starts with `NFTG` and is neither DHCP nor ARP), so the
  snooping and DAI rate limits are exercised by unit and acceptance tests through the test injector
  (`test/inject.ts`, `injectFrames`, §7 W1 qa), and lab 20 has no rate-limit task.
- **Err-disable.** Causes `dhcp-rate-limit` and `arp-inspection` ([S16] `storm-control`) join the `ErrDisableCause`
  union in W0 (types and the `ERR_DISABLE_CAUSE_TEXT` stub only) and the runtime list `ERR_DISABLE_CAUSES` in the W2
  l2 change that raises them; P2's `errDisable` action and periodic `errdisable:<port>` recovery timer are reused; one
  cause per port at a time, and port security (step 7) runs first, so its cause wins. `show errdisable recovery`
  iterates the list (`cli/handlers/errdisable.ts:23, :45`), so it gains the two rows in W2, a listed output change
  (§9 W2 gives the exact lines).
- **Rejected:** a separate daemon (the per-frame decision cannot consult another daemon mid-frame without a request per
  frame and a split writer); recording the client port at DISCOVER time (needs per-transaction state that the CAM row
  already holds).

**D14 — Device access: SSH configuration is MUST; the network remote terminal is [S13] (approved).**
- **MUST.** `ip domain-name`, `crypto key generate rsa [modulus N]` (a stored configuration line: replaying it
  regenerates the key, `crypto key zeroize rsa` removes it — listed deviation, a real device keeps the key outside the
  configuration), `ip ssh version 2`, `ip ssh time-out`, `ip ssh authentication-retries`, `username … secret`,
  `line vty` with `login local`, `transport input ssh|telnet|ssh telnet|all|none` and `access-class <list> in` are
  accepted, validated (the key needs a non-default hostname and a domain name) and stored; `show ip ssh`, `show ssh`
  and `show users` report them. The configuration facts (`ssh.enabled`, `vty.transport`, `vty.accessClass`, …)
  grade the configuration half of the secure-access lab; with [S13] its access half is graded through real logins
  (below).
- **On switches too.** Lessons 15 and 19 configure SSH and a vty list on a switch, which today's grammar scopes block:
  `ip domain-name` requires a `dns-client` model (`grammar/dns.ts:20, :86`, `DNS_CLIENT_CAPABILITIES`), and every ACL
  line requires `routing` (`NAT_CAPABILITIES`, `grammar/nat.ts:31`, used by `grammar/acl.ts`). Both scopes widen to
  `routing` and `managed-switch` (the switch help goldens move, §9 W2). `userSecretOf` (`cli/runtime.ts:383-388`)
  accepts only `username <n> secret|password <s>`, so it learns the new `username <n> privilege <p> secret|password
  <s>` form; otherwise `login local` would refuse every user created with a privilege.
- **[S13] Remote terminal (approved, §8.5 P8).** `vty` (server) and `vty-client` daemons over the P1 TCP stack:
  hidden service listeners (`tcp.listen {service: true}`: no row, no debug, no `sock.opened`, and kept out of the tcp
  StateView, so a P1 or P2 router whose configuration has `line vty` keeps its snapshot bytes) that open only when
  configured — telnet when a `line vty` section exists and its transport allows telnet (the transport defaults to
  `telnet ssh` when no `transport input` line is stored), SSH when an RSA key exists and the transport allows SSH;
  telnet in clear (`IAC WILL ECHO` masks the password prompt); SSH with clear version strings then a payload marked
  `meta.protected` with `protectedBy: 'ssh'` and XORed with an FNV-derived keystream (no randomness); `access-class`
  enforced at accept through `acl.check` (a refusal is a TCP RST after the handshake — listed deviation); a
  nested-session depth cap of 4.
  - **Remote sessions without a new dep.** Remote sessions are CliRuntime sessions with `via: 'vty'`. The vty daemon's
    `remoteCli` action and the vty-client's `cliRemote` action are applied like `configure` (D21): the runtime
    schedules a zero-delay, non-periodic `SimEvent {kind: 'remoteCli'}` through its existing `scheduler` dep, and the
    Simulation — which owns the CliRuntime — calls `openRemote` / `execRemote` / `closeRemote` / `setRemote` in that
    event's own dispatch. The output of a `via: 'vty'` session never becomes a `cliOutput` trace event: the Simulation
    delivers it to the device's vty daemon as `ProcessEvent vty.output`, which sends it back over TCP. The client side
    is journaled as the user's `cliExec` lines; the server side is a consequence of replayed events, numbered
    deterministically through `FacadeCounters.remote`. **Rejected:** the ACL map's `DeviceRuntimeDeps.remoteCli`
    (a second path into the CliRuntime and a new required dep for the five `createDevice` harnesses, which D21 already
    refused for `configure`).
  - **Gradeable logins.** vty writes a bounded `vty-logins` table (50 rows, the `restconf-log` precedent, rule 20):
    one row per login attempt that reached the daemon, with its protocol, peer, user and result (`success`, `failed`
    for a wrong password, `refused` by `access-class`). A transport refusal never reaches vty (tcp answers the SYN with
    a RST), so it writes no row. Labs 15 and 19 grade the learner's own logins live from these rows and the `acl`
    rows of the vty binding, and the grader's own logins in its clone with the `service` kind (§2.10, §11.1).
  - **On managed switches the transport wakes only on a P3 line** (D22). `line vty` is a P1 line, so a P1 or P2 file
    may hold it; the switch's transport therefore wakes for vty only on a stored `transport input` line other than
    `none` or on `crypto key generate rsa`, both P3 lines. A switch whose vty lines carry only P1 lines keeps its
    dormant transport, and a telnet to it is answered "protocol unreachable" as in P2 (listed deviation; the lessons
    type `transport input ssh`).
- **Rejected: the remote terminal as MUST.** It is the largest single item of the ACL map (4 ew) and its main risk (the
  CLI runtime ↔ device ↔ TCP seam, nested sessions, journaling of server sessions); the configure-and-verify objective
  is met by the stored lines, and the product owner approved it as [S13]. **Rejected: keeping vty UI-only for ever**
  (`contracts/cli.ts:342`; no source address for `access-class`, no "telnet sends the password in the clear"
  capture) — which is why [S13] exists.

**D15 — Fragmentation is [S17], owned by l3, and not approved; every tunnel drops honestly instead.**
- [S17] (not approved, §12.1 P3c) would split at the single IPv4 egress point, `arp.sendVia`, so routers and hosts
  both fragment; DF set and too big → drop `mtu-exceeded` plus ICMP 3/4 carrying the next-hop MTU (RFC 1191); reassembly
  only at the destination, 15 s timeout; the first fragment keeps its PduId, the others are new PDUs with
  `meta.parent`; the ipv4 codec gives a non-initial fragment a `payload` next layer (`pdu/codecs/ipv4.ts:103-109`
  today dispatches by protocol whatever `fragOffset` says); an ACL entry with L4 conditions matches a non-initial
  fragment on its L3 part when it permits and is skipped when it denies.
- **The fallback, which is the P3a behaviour.** The tunnel owner refuses an inner packet larger than the tunnel's IP
  MTU with drop `mtu-exceeded` (detail: `larger than the tunnel can carry (1476 bytes); fragmentation is not
  simulated`; [C13] 1456 bytes on an IPsec tunnel), sends ICMP 3/4 carrying that MTU when DF is set, and `ip tcp
  adjust-mss <n>` clamps TCP (the CAPWAP precedent, `capwap-ac.ts:662`). The fallback is part of [S18], not a separate
  item, and it needs nothing from [S17]: the drop reason `mtu-exceeded` and the `icmp.error` member `param?` (the
  next-hop MTU in the low 16 bits of icmpv4 `unused`) belong to [S18]'s block, and the W1 l3 [S18] item implements
  `param` in icmpv4 (§2.4, §2.7, §7). [S17], if approved later, reuses both.
- **Rejected:** fragmenting in `ipv4.forward` (every continuation — ACL, NAT — would need it); tunnels that never
  fragment and never say so (a fidelity lie on every 1500-byte ping); reusing `giant` for a sender-side refusal
  (`giant` means a receiver saw an oversize frame, `device/pipeline.ts:241-247`).

**D16 — QoS: marking in the device runtime, queues in the link model, one pure scheduler.**
- **MUST (QoS lite).** MQC `class-map` / `policy-map` / `class` with `match` (dscp, precedence, cos, protocol,
  input-interface, access-group through the D12 matcher, any) and `set` (dscp, precedence, cos) only;
  `service-policy input|output` on routed physical ports and subinterfaces. Each rewrite is `Pdu.mutate` with the new
  reason `QosMark` and the cause `policy-map MARK class VOIP set dscp ef`.
  - **Compilation is lazy.** The runtime keeps one compiled policy per (port, direction) tagged with a **configuration
    generation**, a counter every configuration delta under `class-map`, `policy-map`, `access-list`, `ip access-list`
    or `service-policy` increments; a lookup whose tag is stale recompiles through the pure `qos/config.ts` reader.
    `service-policy` is **not** a `PHY_CONFIG_KEYS` line in P3a: that key only reaches the link model's
    `onPortChanged` (`device.ts:1362-1364`, `media-wiring.ts:194`) and is skipped for virtual ports, so it could not
    recompile anything, and edits to a class-map or an ACL body would never reach the policy ([S20] adds it for
    scheduler ports, which do need the link model).
  - **Input marking** runs at a new pipeline step **10c**, in the runtime, only on a `deliver` or `subif` verdict of
    `frameArrivalVerdict` and before the tag pop, with the policy of the port the verdict names (the subinterface for
    `subif`): flooded unicast for other MACs, control frames and BPDUs, which `frameArrivalVerdict` drops after 10a,
    10b and the step-12 MAC filter (`pipeline.ts:524-549`), are never classified or counted, and `match cos` still
    sees the 802.1Q PCP.
  - **Output marking** runs for a routed physical port in the runtime's transmit point (`transmitOn`,
    `device.ts:1224-1241`) before `deps.transmit`, and for a subinterface in the subinterface egress branch right after
    `vlanPush` (`device.ts:1214-1219`), keyed by the subinterface — `transmitOn` only sees the parent port — so `set
    cos` writes the pushed tag's PCP. SVIs and switchports refuse `service-policy` in P3a
    (`CLI_MESSAGES.qosPortUnsupported`): an SVI's output egresses on member ports and its input never passes step 10c.
  - A deterministic **traffic generator** (`traffic` daemon on hosts, UDP to the discard port 9, fixed pacing, DSCP,
    count or duration; the receiver computes delay, jitter and loss into a `flows` table) supplies load. Every flow
    stops at the hard cap `TRAFFIC_MAX_DURATION_MS` = 300 000 (5 min of sim time) after it starts; a flow with neither
    count nor duration is **continuous** until `flow stop` or the cap, and is used only under `runFor`: its datagrams
    commit non-periodic link events (`p2p.ts:213-232`), so over a congested link it would hold `runToIdle` until the
    cap (rule 19).
  - The **congestion view** reads one display member, `PortSnapshot.txBacklog` (optional by meaning, present only while
    frames wait): the depth and up to 8 summaries of the frames the link model has committed with a future `txStart`
    (the "virtual FIFO", `link/media/p2p.ts:186-277`, :213), filled by the snapshot cache from the in-flight store.
    The web cannot draw them from the in-flight list: `visible(now)` hides legs with `txStart > now`
    (`link/inflight.ts:138-150`) and the web's `reconcileInflight` deletes future frames on every snapshot or delta
    (`apps/web/src/store/store.ts`); the overlay reads snapshot rows only (D24).
  - The **queueing sandbox** concept tool runs FIFO, WFQ (scheduled as flow DRR, a listed deviation), CBWFQ and LLQ
    over synthetic arrivals on the pure scheduler `core/queueing.ts`.
- **[S20] Full scheduler (approved with [S21], §8.5 P7).** Queues live **in the link model, per egress port** (spec
  §4.7): `CableP2P` gets a held
  queue for ports with a scheduler spec (`LinkModelDeps.egressPolicy(ref)`); `transmit` enqueues and returns
  `{ok: true, deferred: true}`; `onTxComplete` (`p2p.ts:291-294`) dequeues through `core/queueing.ts` and serialises
  (five rng draws at dequeue, `onTxOutcome {sent}`, the `segment.ts:1365-1371` precedent); LLQ with a conditional
  policer, CBWFQ by deficit round robin, queue limits, 75 % admission, `frameQueued` trace events, `PortSnapshot.qos`.
  [S21] adds WFQ in class-default, policing and shaping. A port with no policy keeps the virtual FIFO byte for byte.
  [S20] makes `service-policy output` a `PHY_CONFIG_KEYS` line for physical scheduler ports.
  - **Where each action attaches.** Marking (`set`) attaches in either direction on routed physical ports and
    subinterfaces (M13). Queueing actions (`priority`, `bandwidth`, `queue-limit`, `fair-queue` [S21], `shape` [S21])
    act as packets leave a physical port, so a policy that holds one attaches only as `service-policy output` on a
    routed physical port (`qosQueueingOutputOnly`, `qosQueueingPhysicalOnly`; a flat queueing policy on a
    subinterface needs a parent shaper, which is hierarchical QoS, C19/P5). `police` [S21] attaches in either
    direction; an input policer runs at step 10c after marking. The 75 % admission check refuses a policy whose
    priority and bandwidth classes ask for more than 75 % of the port's bandwidth (`qosAdmission`). The M13
    `qosSetOnly` message is not added: with [S20] approved it would be dead vocabulary (rule 3).
- **Rejected:** a `qos` daemon (egress is synchronous in the runtime; an action round trip per frame on every device is
  waste); queues in the device runtime (the link model owns `tx`, `busyUntil` and serialisation); LLQ inside the
  virtual FIFO (times are committed at enqueue); virtual-time WFQ with finish tags (division chains, float-prone, no
  CCNA-level gain); a sandbox with its own maths (it could disagree with the link — the D10 principle); a web-only FIFO
  view that keeps future in-flight legs in `reconcileInflight` (every snapshot, delta and seek would have to preserve
  them, and the overlay would read trace-driven state, against D24).

**D17 — WAN: HDLC stays; PPP [S19], GRE [S18] and site-to-site IPsec [C13] are real; WAN concepts are theory.**
- **MUST.** No new WAN engine feature; the point-to-point lesson's lab practises the P1 HDLC serial link (clock rate,
  encapsulation, keepalives). **Approved** (§8.5 P1, P6, P10): [S19] PPP joins that lab, [S18] GRE and [C13] IPsec
  (D27) each get a lab (lessons 24 and 25). WAN topologies and VPN types stay theory ([S22], the WAN/VPN concept
  visualizer, is not approved).
- **[S19] PPP** is a real encapsulation with its own codecs (`ppp`, `lcp`, `pap`, `chap`, `ipcp`, `ipv6cp`; RFC 1662
  framing without flags, FCS by the existing `crc16X25`) and a separate `ppp` daemon after `hdlc`. One pure RFC 1661
  automaton serves LCP and the NCPs; line protocol is per-end PPP state in the link model reported by the daemon
  (`MediumOp ppp-link`, `MediumEvent serial-line`, `keepaliveExempt` → `serialControlExempt`, `link/serial.ts:233`);
  CHAP uses real MD5 (`core/md5.ts`, RFC 1321 vectors) over `username <peer> password <pw>` (a `secret` entry cannot be
  used — as on real devices); PAP travels in clear on purpose; challenges and magic numbers are FNV-derived; a
  failed authentication retries every 10 s on a periodic timer. hdlc's `onConfig` (`hdlc.ts:346-371`) learns to disarm
  its keepalive when a port leaves HDLC (a strict no-op when the effective encapsulation does not change). The latent
  `nd.ts:143-148` mapping of `ppp` to HDLC framing is fixed. PPP runs on direct serial cables only; NF-CSU-DSU and
  NF-INTERNET serial access lines stay HDLC-only (listed deviation).
- **[S18] GRE** is a virtual `tunnel` role owned by a `gre` daemon (`TUNNEL_FAMILY`, `ROLE_EGRESS_OWNER.tunnel`). The
  head rewraps once (`strip` the framing, `push [ipv4 {src, dst, protocol 47, ttl 255, dscp copied}, gre]`, cause
  `interface Tunnel0`) and calls `ipv4.send` — exactly the CAPWAP uplink shape (`capwap-wtp.ts:824-837`); the tail
  (`IPV4_UPPER` 47) strips and hands the inner packet to ipv4 as `ingress {port: 'Tunnel0', layer: 'ipv4'}`. The PduId
  never changes. Tunnel line protocol is derived by the runtime from a `tunnels` row written by gre and signalled by a
  `virtualChanged` action (the P2 D6 pattern), re-evaluated on gre's own configuration and link changes and on
  `ipv4.ribChanged` for its destination (D8). `PduSummary.tunnel` widens to `'gre'`. A tunnel port's routing
  bandwidth is 100 kb/s and its delay 50 000 µs (the classic tunnel defaults, overridable by `bandwidth` and
  `delay`), so OSPF over a tunnel costs 1000 at the default reference and [C1] EIGRP adds the tunnel's delay.
- **IPsec** (VTI, IKEv2-lite, ESP with simulated crypto) is [C13], approved for P3a (D27); crypto maps, IKEv1 and
  remote access stay with the P4 security track. The tunnel owner stays `gre`, generalised to two modes (`gre`,
  `ipsec`), so IPsec reuses [S18]'s role, family, underlay evaluation, MTU fallback and line-protocol path.
- **Rejected:** PPP folded into `hdlc.ts` (its StateView and debug bytes are pinned by P0.5 tests); HDLC framing with PPP
  semantics (wrong wire image; spec §4.5 requires PPP to round-trip); the tunnel as a link-model medium (the outer
  header would not be routed through the provider, so underlay TTL, ACL and NAT would be fake); GRE inside ipv4 (pinned,
  largest daemon); MPLS or Metro Ethernet in the engine (conceptual in the course; P5).

**D18 — Discovery: CDP in an original NF format, LLDP in IEEE format, delivered through the P2 control table.**
- **CDP** (P2 D8 rule for vendor-proprietary L2 protocols): 802.3 + LLC/SNAP with `NF_OUI` and the new PID 4
  (`NF_PID_CDP`), to `NF_L2_CONTROL_MAC`, original TLVs; the name "CDP" is used as a name only. **LLDP**: IEEE 802.1AB,
  ethertype 0x88cc to `01:80:c2:00:00:0e`, chassis, port, TTL, system, capability and management-address TLVs.
- **Delivery.** `protocols/l2/control.ts` (:66-73, :113-138) gains two rows before `reserved`,
  `{cls: 'cdp', to: 'cdp', port: 'physical', whenAbsent: 'drop'}` and `{cls: 'lldp', to: 'lldp', port: 'physical',
  whenAbsent: 'drop'}`; `classifyControl` returns `'cdp'` for `NF_PID_CDP` under `NF_L2_CONTROL_MAC` and `'lldp'` for
  ethertype 0x88cc to `01:80:c2:00:00:0e` (today `'reserved'`). Each is delivered to its daemon on the physical port
  and never bridged.
  - On a bridged port of a VLAN-aware switch, eth-switch step 2 delivers them; where the class's daemon does not run
    (the controller runs cdp but not lldp) the frame drops `not-for-me` with the existing detail
    `controlNotRunningDetail` ("lldp is not running on this device").
  - On a routed port the runtime checks the two control classes **on the physical port before step 10a**:
    `frameArrivalVerdict` runs 10a before 10b (`pipeline.ts:541-546`), so an untagged CDP frame on a port with a
    native subinterface would otherwise take the subinterface path. The check covers **classes `cdp` and `lldp` only**
    (DTP, LACP and BPDUs reaching a multilayer switch's routed ports, whose daemons run there, keep today's path): the
    class's daemon runs → delivered on the physical port; otherwise the frame goes on to step 10b and drops
    `not-for-me` exactly as today.
  - A device that runs cdp with `no cdp run` consumes CDP silently (drop `not-for-me`, detail "CDP is off on this
    device"). Transparent bridges (unmanaged switches, the lightweight AP's bridge) and hubs never classify and bridge
    everything.
  - CDP and LLDP run on Ethernet ports only (listed deviation: real CDP also runs on serial HDLC links).
- **State.** Tables `cdp-neighbours` and `lldp-neighbours`, one writer each, `expiresAt` = holdtime (the P2 countdown
  ring and generic assertions for free); rows are deleted at link-down and expire otherwise. One device-level periodic
  transmit timer (CDP 60 s, LLDP 30 s) sends on every enabled up port in canonical order; one immediate send at link-up
  from `onLinkChange`; frames are `meta.background` with tags `cdp` / `lldp`; CDP is always sent untagged.
- **Rejected:** a new demux key for SNAP PIDs (P2 D7 rejected new keys; the pure table already decides); a private
  ethertype for CDP (inconsistent with DTP/PAgP); per-port timers (n× the events for the same behaviour).

**D19 — Time: one calendar; device clocks are views on SimTime; NTP is real on the wire.**
- `NF_WORLD_EPOCH_UNIX_MS = 1_736_150_400_000` (Mon 2025-01-06 08:00:00 UTC) is the calendar instant of SimTime 0, the
  "true time", written as a literal (no `Date` in the engine; `contracts/time.ts:11-12` bans the wall clock). Each
  device keeps `{baseUnixMs, baseSubMsNs, baseAt, source, stratum?, reference?, tz}` in its runtime; the displayed
  value is `base + (now − baseAt)`. Integer arithmetic; BigInt is confined to clock and NTP maths and never enters a
  snapshot or the trace (JSON digests would throw).
- Network devices boot **unset** (`NF_CLOCK_UNSET_UNIX_MS`, 2020-01-01 00:00:00 UTC, plus uptime; `show clock` prefixes
  `*`); hosts and servers ([S32] the dev host) boot with true time (source `host`), so a server is a natural stratum-1
  source. Reload resets a network device to unset (no hardware calendar; listed deviation).
- **NTP** is RFC 5905 NTPv4 over UDP 123 with 64-bit timestamps from device clocks. `ntp server X` polls at once (at
  configuration or when an address appears), then every 64 s on a periodic timer.
- **While a client is unsynchronised it re-polls without waiting for the periodic poll.** The first polls often fail:
  routers boot at 45 s, a non-PortFast uplink forwards only after 30 s, OSPF needs at least 45 s, and an upstream
  server may not be synchronised yet. So an unsynchronised client (1) re-polls at once, through a 0 ns coalesced
  `ntp-kick:<server>`, when any of its ports comes up and when the route toward the server changes (it registers
  `ipv4.ribWatch {lpm: [server]}` while unsynchronised, D8, and drops the watch on synchronisation); and (2) after an
  unanswered or rejected poll, retries on a bounded fast schedule of 1, 2, 4, 8, 16 and 32 s (`ntp-retry:<server>`,
  non-periodic, six retries, 63 s in all; a kick restarts the schedule). After the sixth retry only the periodic poll
  remains, so `runToIdle` returns (rule 19).
- **Servers.** A server answers mode 4 at once. A synchronised server, or one with `ntp master`, answers with its
  stratum; **an unsynchronised server answers stratum 16, leap 3 (alarm), refId `INIT`**, and a client rejects that
  reply (stratum ≥ 16 or leap = 3) and treats it as unanswered for the retry schedule. The client validates (origin
  match, stratum < 16, leap ≠ 3), computes θ and δ exactly in integer ns, and **steps its clock on the first valid
  reply** (listed deviation: real clients filter several polls and slew), so `runToIdle` and the grader clone reach a
  synchronised world. Stratum = server stratum + 1; 16 means unsynchronised. `ntp master [n]` serves the device's own
  clock at stratum n — **8 when n is omitted**, as on real devices — even an unset one (realistic, and a lesson). A
  server's host line `service ntp on` expands to `ntp master 1`.
- **Gradeable clock state** is the ntp daemon's one-row `clock` table (§2.6: source, stratum, reference and the offset
  from true time), written when a synchronisation, `ntp master` or `clock set` changes it (rule 20). `clock set`
  reaches the runtime through ntp (`ntp.clockSet`), so it too is a tableWrite that the worker's re-check sees. The
  runtime keeps the clock itself; `DeviceSnapshot.clock` is for display.
- **Rejected:** the wall clock at world creation (non-deterministic; clones and replays diverge); showing SimTime as the
  clock (every device would already agree, leaving NTP nothing to fix); per-device random offsets (new draws, no
  teaching gain); the full discipline algorithm (invisible at CCNA level, weeks of work); retrying only on the
  periodic 64 s poll (an unsynchronised chain would still be unsynchronised when `runToIdle` returns); a `clock.*` fact
  that reads the runtime clock (`clock set` would emit nothing lab-relevant, `bridge/worker/labs.ts:23`).

**D20 — Logging: one runtime seam, three consumers, trace bytes unchanged. [S24] [S25] (both approved)**
- [S24] The roughly ten direct runtime log sites (`device.ts:1528-1538`, :1134, :1150, :1441, :1965, :1970, :851) and
  the `log` action go through one helper `emitLog(sev, fac, msg, now, mnemonic?)`, which (1) emits the unchanged `log`
  TraceEvent and (2) when the model runs `logger`, delivers `ProcessEvent {kind: 'log.record'}` to it depth-first inside
  the same action budget. The logger keeps the buffer (StateView; `show logging`), applies levels and renders lines
  with one pure renderer that reads the device clock and `service timestamps`
  (`[*]<timestamp>: %FAC-SEV-MNEMONIC: text`; without a mnemonic, `%FAC-SEV: text`; without the timestamps line, P1's
  `*hh:mm:ss.uuuuuu` debug form, so P1/P2 debug output is byte-identical).
- [S25] Syslog: RFC 3164-style `<PRI>TIMESTAMP HOSTNAME: message` over UDP 514 to each `logging host`, filtered by
  `logging trap`; a `syslog-server` daemon on servers (`service syslog on` → the extension line `syslog-server enable`)
  writes a bounded `syslog-messages` table (500 rows). The P3 extended-logging default (D2): interface and line-protocol
  change logs, restart, and "configured from console / from restconf by <user>" logs; console and `terminal monitor`
  printing, fed from the trace sink exactly like debug (`sim/simulation.ts:359` gains a `log` branch calling
  `cli.onLogEvent`).
- **Rejected:** the logger printing through `cliOutput` (it knows no sessions); printing logs to consoles in all
  profiles (it breaks the P1 digests' typed transcripts); RFC 5424 structured syslog (not what the course shows).

**D21 — Automation: a configure seam, a device API over the simulated network, IETF models, no dependency.**
- **The configure seam.** A daemon changes configuration with `Action {type: 'configure', token, lines, atomic?,
  indentation?, origin}`. The runtime schedules a zero-delay, non-periodic `SimEvent {kind: 'deviceConfigure'}` through
  its existing `scheduler` dep (no new runtime dep); in that event's own dispatch, with its own `ACTION_BUDGET`, the
  Simulation — **the one caller** — runs `cliCore.configure` (the headless console grammar and handlers at privilege
  15, never journaled — it is a consequence of replayed events) and delivers `config.result` to the issuer. With
  `atomic`, any failing line reverts all (`contracts/cli.ts:297`).
- **How the origin reaches `configChange`.** `ConfigureOptions.origin` is kept on the headless session `configure`
  opens, and the CLI runtime passes it as the new optional fourth argument of `DeviceRuntime.applyConfigLine(context,
  line, negate, origin?)` (`contracts/device.ts:266`) for every line that session applies; the runtime copies it into
  the `configChange` events of that line. `CommandCtx.config` (`contracts/cli.ts:393`) keeps its signature, so no
  handler changes. **Rejected:** `Action configLine` (`process.ts:365-370`; it bypasses handlers — VLAN
  auto-creation, allowed-list resolution, range checks, error texts — so the API would accept what the CLI refuses);
  calling the CLI synchronously inside the issuer's action application (re-entrant `onConfig`, and a 50-VLAN PUT would
  exhaust the action budget); a `DeviceRuntimeDeps.configure` callback (a second caller of `cliCore.configure`, and a
  new required dep for five `createDevice` harnesses); a "current origin" held by the runtime during the call (hidden
  state that a nested or failed call could leave set).
- **The device API is RESTCONF over simulated TCP 443.** A `restconf` daemon on routers and managed switches opens its
  listener only when `restconf` and `ip http secure-server` are both configured. TLS is a simulated state (the CAPWAP
  DTLS precedent, P2 D8): sockets carry `tls: true`, no handshake bytes go on the wire, every data segment carries
  `meta.protected` with `protectedBy: 'tls'`, and NetScope decodes the HTTP under a "protected (TLS, simulated)"
  banner. Authentication is HTTP Basic against `username <u> privilege 15 secret <s>` with `ip http authentication
  local` (the `privilege` option is new on `username`, `cli/grammar/line-auth.ts:66`). Requests are logged in a bounded
  `restconf-log` table (gradeable, rule 20). Status codes: GET/HEAD 200; POST 201 or 409; PUT 201 or 204; PATCH and
  DELETE 204; 400, 401, 404, 405, 415 with an `ietf-restconf:errors` body whose message is the CLI's original error text.
- **Models.** `ietf-interfaces` (with `interfaces-state`), `ietf-ip` and `ietf-yang-library` keep their standard names;
  the vendor-native model is replaced by an original `nf-native` (hostname, VLAN list, banner). One pure data file,
  `automation/yang/model.ts`, maps each node to the canonical configuration lines of §5 and to a reader, and drives
  RESTCONF GET and writes, [S28] the YANG browser and [C21] NETCONF, so no view shows a node the device refuses. JSON
  encoding per RFC 7951.
- **Clients.** http-client gains `http.request {owner, token, method, url, headers?, body?, timeoutNs?, session?}`
  answered by `http.result`; `http.fetch` and the browser's `https:` refusal (`http-client.ts:277`, header `:10`)
  stay unchanged. The MUST client is a host-shell command, `rest <method> <url> [<options>]`, a CLI job (journaled as
  `cliExec`) that prints the status line, headers and body as text. The options are `-H "<name>: <value>"`
  (repeatable), `-u <user>:<password>` and, **last**, `-d <body>`, which takes the rest of the line verbatim: the host
  shell quotes with double quotes only and has no escapes, and an unquoted value may not contain `"` (`cli/parser.ts:48-49,
  :767-776`), so a JSON body can never be quoted. The grammar declares one trailing argument of ArgType `rest`
  (verbatim, `parser.ts:416`); the job handler splits it with the parser's quoting rule and gives `-d` everything
  after it. [S32] adds `-f <file>` with the hosts' file store it brings (below). [S27] (not approved) would add the API
  client desktop app; [S32] adds the NF-Py scripting host.
- **Data formats.** Pure parsers in `automation/data/` (JSON with positions, a YAML subset, XML), exported from `pure`
  (the pure-entry lint allows `automation/`), drive the data-formats playground and the lesson code-sample test (§11.3).
- **[S32] NF-Py** (approved, §8.5 P9), a teaching subset of Python 3 written in TypeScript in the engine (lexer,
  parser, bytecode compiler, resumable VM; `json`, a `requests`-style module, `time`), runs as the `script-host`
  daemon on a new NF-DEVHOST; its I/O suspends the VM, `time.sleep` is a non-periodic timer, and all caps are
  deterministic. Runs are recorded in a bounded `script-runs` table (gradeable, rule 20).
  - **The hosts' file store belongs to [S32].** Scripts need a place to live, and the management map put it in its
    storage item M8 (here [S29], not approved). [S32] therefore carries the hosts' slice of that contract: the flat
    `files:` file system (`FileSystemId = 'files'`), the `storage` action restricted to it, `ProcessCtx.files` /
    `readFile`, `TopologyDevice.files` (schema 1.3, so scripts survive export and reach lab clones) and
    `DeviceSnapshot.storage` (the workspace's file list). [S29], if approved later, widens `FileSystemId` with `flash:`
    and `nvram:` and adds TFTP and the copy forms; nothing of it is needed here. NF-DEVHOST runs no TFTP.
- **Rejected:** an out-of-band API through the facade (no packets, so no management-VLAN, reachability or ACL lesson,
  nothing to capture, and the grader could not tell the API path was used); plain HTTP on 80 (RFC 8040 requires TLS and
  "authentication types" is an exam point); a real TLS handshake (crypto cost, no CCNA value); copying a vendor-native
  model (legal); a RESTCONF written separately from the browser's model (drift); **Pyodide** (6–10 MB download, 2–4 s
  cold start beyond the spec §4.12 budget; running it inside the deterministic dispatch needs SharedArrayBuffer and
  COOP/COEP headers that break the lesson video embeds, while running it asynchronously makes scripts depend on wall
  time and unusable in a grader clone; it exposes real `fetch`, a hole through spec §11.6; and it is a new dependency);
  Skulpt or Brython (global mutable state, `Math.random` and `Date` in their libraries); JavaScript scripting
  (off-curriculum).

**D22 — Managed switches gain `udp` and `tcp`, dormant until a P3 service is configured, so P1 and P2 bytes never
move.**
- The `managed-switch` capability gains `udp` and `tcp` since P3 (`switching` derives only eth-switch, arp, ipv4,
  icmpv4 and host, `contracts/catalog.ts:710`). NTP (MUST) and RESTCONF (MUST) run on switch SVIs; the approved [S13]
  (vty) and [S25] (syslog) need them too ([S29] and [S33] would, if approved later).
- **Why a plain addition would move bytes.** With a live transport, anything reaching an addressed, up switch SVI
  changes in every profile: a broadcast is always "local" (`process-ctx.ts:486`), so a DHCP DISCOVER or REQUEST that
  dies today in ipv4 as `unsupported-protocol` "ip protocol 17 has no listener" (`ipv4.ts:1106-1113`) would be handed to
  udp (a new debug line) and drop there as "udp port 67 closed" (`udp.ts:531-539`); unicast UDP would draw ICMP 3/3
  instead of 3/2; TCP a RST (`tcp.ts:864-866`) instead of ICMP; the sender would see `port-unreachable` or `refused`
  instead of `proto-unreachable` (`udp.ts:191-198`), and traceroute and browser output would change.
- **Dormant transport (the decision).** On a device whose `udp` and `tcp` come only from the `managed-switch` row,
  ipv4 treats IP protocols 17 and 6 as having no listener — P2's path byte for byte — **until a P3 service that owns a
  socket on the device is configured**: `ntp server` or `ntp master`; `restconf` together with `ip http
  secure-server`; with the approved items, [S13] a `transport input` line other than `none` under `line vty`, or
  `crypto key generate rsa` (never `line vty` alone, which P1 and P2 files hold, D14), and [S25] `logging host`; with
  items approved later, [S29] a copy job or `tftp-server` and [S33] `snmp-server community|user`. Every entry is a line
  the P1 and P2 grammars refused, which is what keeps the rule byte-preserving. The list is one data record,
  `DORMANT_TRANSPORT_OWNERS` in `protocols/ip-upper.ts` (owner l3; each entry a configuration-line prefix, extended by
  each approved item's W1 l3 change), read by ipv4 in its `onConfig`. ipv4 precedes udp, tcp and every service in `PROCESS_ORDER`, so the delta that starts the
  service has already woken the transport when the service sends its first packet. Removing the last such line makes
  the transport dormant again. udp and tcp themselves are unchanged; their StateViews and the `sockets` table exist on
  every managed switch and are removed by the per-device digest normalisation (§4.6).
- **Consequence.** A P1 or P2 world, a CCNA 1 or 2 lab and every file saved before P3a (their grammar had no P3
  service line) answer exactly as today, so §9.3 (a) and §9.4 (a) record no change. The live behaviour (3/3, RST, broadcasts
  handed to udp) appears only on a switch where the learner configured NTP or the API, which is the P3 behaviour the
  lessons describe. The two synthetic guard worlds of D3 prove the dormant path; `accept.p3.switch-transport` proves
  the wake-up and the return to dormancy.
- **Rejected:** answering on every switch as hosts do (it would move every DHCP exchange, traceroute and browser
  fetch that reaches an addressed switch SVI in every user file, with only a measurement against goldens that contain
  no such world); a management-only stack (duplicated code); switches that cannot be managed (CCNA configures NTP and
  the API on switches).

**D23 — Legal.** As rule 6. `validateCatalog` and the CLI legal test keep their banned-word lists; P3 adds original
log, show, help and error wording for every new message, and lesson text is checked by the curriculum tests. Items
flagged for legal review before the wave that ships them: the `%FAC-SEV-MNEMONIC` log shape ([S24], kept as a
teaching fact like the HSRP MACs of P2 D8, because exam questions read severity from it; every mnemonic word is
original); the NF-Py `requests`-style module name ([S32]; fallback `nfrequests`). "Python", "YANG", "RESTCONF",
"NETCONF", "IKEv2", "ESP" and "Ansible-style" name standards and languages descriptively. "EIGRP" [C1] is used as the
protocol's name: its wire format is published (RFC 7868), so, unlike CDP (P2 D8), it keeps its real layout. No vendor
or product name appears in lesson text, help, show output or logs.

**D24 — Web: overlays read snapshot data only; one concept-tool list; heavy apps load lazily.**
Overlays read snapshot rows only and never use dash patterns (P2 D20). The three copies of the concept-tool union
(`contracts/scenario.ts:49`, `apps/web/src/store/types.ts:62`, `apps/web/src/labs/markdown.ts:23`) become one
contract, `ConceptToolId`, and the markdown link allowlist is derived from it. New desktop apps and concept tools are
dynamic imports (lazy chunks). No dock tab is added in the MUST plan; the approved [S2] adds the `routing` tab with a
listed hotkey migration (registered hidden in W0, shown from W4, §7).

**D25 — The CCNA 3 course reuses the course layer.** 40 lessons in 14 modules, ids `ccna3-NN-slug` frozen in §11 at
W0 (overlay owners key on them early); category `ccna3-lab`; profile P3 labs; lab files owned by the area that knows
the feature (`sim/scenarios/ccna3/{ospf,eigrp,acl,hardening,wan,vpn,qos,discovery,time,automation,troubleshooting}.ts`);
objectives as data (`curriculum/ccna3/objectives.ts`); code samples in lessons checked by parsers (§11.3).
`CCNA3.status` flips to `available` only in W7, when every lesson has theory and every approved lab exists (21 labs,
§11.1).

**D26 — [C1] EIGRP: the classic core as an `eigrp` daemon over a pure DUAL, speaking RFC 7868 bytes (approved,
§8.5 P5).**
- **Scope.** Classic-mode EIGRP for IPv4: one autonomous system per device (`router eigrp <as>`; a second is refused
  with `eigrpOneProcess`, refused under `no ip routing` with `eigrpNeedsIpRouting`), enablement by `network <a>
  [<wildcard>]` (classful without a wildcard), `passive-interface`, `eigrp router-id`, `metric weights 0 k1 k2 k3 k4
  k5`, `maximum-paths`, and the interface lines `delay`, `bandwidth`, `ip hello-interval eigrp` and `ip hold-time
  eigrp`. Automatic summarisation is off, as current software ships it: `no auto-summary` is accepted and not
  rendered, `auto-summary` is refused (`eigrpAutoSummary`). Stub, summarisation and unequal-cost sharing (`eigrp stub`,
  `ip summary-address eigrp`, `variance`: C2), redistribution (C6, so no `D EX` route exists), named mode, wide metrics
  and EIGRPv6 stay P5; lesson 10 teaches them as theory.
- **Wire format.** RFC 7868 (a published format, D23): IP protocol 88 (`IPV4_UPPER`), hellos to 224.0.0.10 through
  the M4 multicast framing rule (joined with `ipv4.group` on every enabled, non-passive interface), the 20-byte header
  (version 2, opcode, checksum, flags init/CR/RS/EOT, sequence, acknowledgement, virtual router id 0, AS) and TLVs: the
  parameter TLV (K values and hold time) and the classic IPv4 internal-route TLV. One codec `eigrp`; the route TLVs are
  one flat string field (the OSPF `links` precedent, §2.16); `stopsMeaning` is true. Hello 5 s and hold 15 s on every
  interface (serial HDLC links are point-to-point, so the 60 s / 180 s multipoint case never arises).
- **Neighbours and reliable transport.** A hello from an unknown address on an enabled, non-passive interface, with the
  same AS and the same K values, creates a `pending` neighbour and triggers an immediate hello on that interface
  (`hello-reply`, 0 ns, coalesced — the D9 precedent, so the peer learns this router without waiting for the periodic
  hello; listed deviation) and a unicast Update with the init flag. The neighbour is `up` when that Update is
  acknowledged. Update, query and reply packets are sequenced per neighbour and acknowledged (an ack is a hello
  carrying `ack`); an unacknowledged packet is retransmitted after the RTO (max(200 ms, 6 × SRTT), capped at 5 s; SRTT
  measured once, from the first acknowledgement) at most 16 times, then the neighbour is reset. Reliable packets are
  unicast to each neighbour, hellos multicast (listed deviation: real routers multicast updates on a LAN with the
  conditional-receive machinery). A K-value mismatch refuses the neighbour with a severity-5 log (original wording);
  another AS is ignored with a debug line.
- **Metric.** The classic composite, in integers: BW = floor(10⁷ / minimum bandwidth in kb/s), DLY = floor(Σ delay in
  µs / 10), metric = 256 × (K1·BW + floor(K2·BW / (256 − load)) + K3·DLY), then floor(metric × K5 / (reliability +
  K4)) when K5 ≠ 0; load 1 and reliability 255 are constants (listed deviation: neither is measured). Bandwidth follows
  D7's routing-bandwidth order (`bandwidth` > 1544 kb/s on serial > the port speed; tunnels 100 kb/s, D17); delay is
  the `delay` line (tens of µs) or the port default (GigE 10 µs, FastE 100 µs, serial 20 000 µs, loopback 5 000 µs,
  SVI 10 µs, tunnel 50 000 µs). A router adds the bandwidth and delay of the interface on which it learned the route.
  Infinite is 2³² − 1.
- **DUAL.** One pure module, `protocols/eigrp/dual.ts`, per destination: the topology entry holds each neighbour's
  reported distance (RD) and the metric through it; the feasible distance (FD) is the best metric since the route
  last became passive; a neighbour is a feasible successor when its RD < FD (the feasibility condition). Successors
  are the minimum-metric feasible neighbours (equal cost only, up to `maximum-paths`). When a successor is lost or its
  metric rises: with a feasible successor, a local computation in the same dispatch — the route stays passive, the FD
  becomes the new successor's metric (as the verification commands show it), the `eigrp-route` transition passive →
  passive carries the cause `feasible successor promoted`, and no query is sent; without one, the route goes active,
  a query goes to every remaining neighbour, and it returns to passive when every reply is in (a neighbour that goes
  down counts as a reply). Split horizon: a route is not advertised out its successor's interface; when a successor
  moves to an interface, one update with the infinite metric goes out that interface (poison reverse). Stuck in
  active: an SIA query at 90 s and a neighbour reset at 180 s, both periodic (rule 19). The successors reach ipv4 as
  one `ipv4.routes` batch per change (D8), owner `eigrp`, source `'EIGRP'`, AD 90; the codes follow D11.
- **State.** `eigrp-neighbors` and `eigrp-topology` tables (one writer each, written only on a displayed change, rule
  20); FSM machines `eigrp-nbr` and `eigrp-route`; debug categories `eigrp packets` and `eigrp fsm`; the grader reads
  the tables through `neighbor {protocol: 'eigrp'}`, `route {source: 'EIGRP'}` and the `eigrp.*` facts (§2.10). No
  randomness: sequence numbers start at 1 per neighbour, and no hello is jittered.
- **Rejected:** deferring to P5 (the recommendation; the product owner approved the classic core for P3a, and P5
  adds named mode, wide metrics and EIGRPv6 on top of this daemon); EIGRP inside the ospf daemon (two RIB owners and
  two state machines in one process, the D7 reasoning); per-route requests (the action budget, D8); an NF wire format
  (only unpublished vendor protocols get one, D23); multicast reliable updates with the conditional-receive flag (a
  second transmit path for no learner-visible gain); an OSPF-style computation throttle (EIGRP computes at once, and
  the immediate failover is the lesson).

**D27 — [C13] Site-to-site IPsec: a VTI owned by the tunnel owner, IKEv2-lite in an `ike` daemon, ESP with simulated
crypto (approved, §8.5 P10).**
- **Scope.** Route-based site-to-site IPsec: a Tunnel interface in `tunnel mode ipsec ipv4` with `tunnel protection
  ipsec profile <p>` (a virtual tunnel interface, VTI); IKEv2 with a pre-shared key from a keyring; one fixed proposal
  (AES-CBC-256, SHA-256, DH group 14 — named on the wire and in the shows, never computed); ESP in tunnel mode. Crypto
  maps, IKEv1, transform sets, remote-access VPN, rekeying and lifetimes, dead-peer detection and GRE over IPsec stay
  with the P4 security track; `tunnel protection` on a GRE-mode tunnel is refused with `ipsecProtectionVtiOnly`.
- **Simulated crypto, real headers (the P2 D8 CAPWAP DTLS precedent).** Every header is on the wire byte for byte:
  the outer IPv4 (protocol 50), the ESP header (SPI, sequence number) and trailer (padding to a 4-byte boundary, pad
  length, next header 4, a 12-byte ICV), and the IKEv2 header and payloads over UDP port 500. What real IPsec
  encrypts travels in clear inside the PDU, marked `meta.protected` with `protectedBy: 'esp'` (the ESP payload) or
  `'ike'` (the IKE_AUTH payloads); NetScope decodes it under an "Encrypted (ESP, simulated)" or "Protected (IKE,
  simulated)" banner, so the learner sees what the provider sees (ESP only) and what the tunnel carries. The
  pre-shared key never appears in a PDU byte, the snapshot or the trace: the IKE_AUTH proof is an FNV-1a value over the
  key, the IKE SPIs, the nonces and the sender's role, and the ICV an FNV-1a value over the SA's key id, the SPI, the
  sequence number and the payload, so a wrong key fails exactly where real cryptography would, without computing any.
  Listed deviation.
- **The tunnel owner.** `gre` stays the tunnel owner (`ROLE_EGRESS_OWNER.tunnel = 'gre'`, D17), generalised to two
  modes. It evaluates the underlay the same way for both (source up and addressed, destination routed through a
  non-tunnel egress, the D8 lpm watch) and, in ipsec mode, asks ike for an SA (`ike.connect`) when the underlay becomes
  ready and releases it (`ike.disconnect`) when it goes. ike answers with `tunnel.sa {op: 'up' | 'down'}`; gre writes
  the `tunnels` row — up only while the SA is up, otherwise down with reason `ike-negotiating`, `ike-failed`,
  `ike-no-proposal` or `ike-no-response` — and issues `virtualChanged` ([S18]'s path). At the head gre rewraps once
  (`strip` the framing, `push [ipv4 {src, dst, protocol 50, ttl 255, dscp copied}, esp {spi, seq}]`, an `Encrypt`
  record, cause `interface Tunnel0`), applies the D15 fallback at the IPsec IP MTU (transport MTU − `IPSEC_OVERHEAD`,
  1456) and calls `ipv4.send`; at the tail `IPV4_UPPER` 50 hands ESP to gre, which finds the SA by SPI (none → drop
  `ipsec-no-sa`: a peer still using an SA the router lost at a reload), strips the outer layers with a `Decrypt` record
  that clears `meta.protected`, and injects the inner packet as `ingress {port: 'Tunnel0', layer: 'ipv4'}`. The PduId
  never changes; `PduSummary.tunnel` is `'ipsec'`. Sequence numbers are carried and shown, not checked against a replay
  window (listed deviation).
- **IKEv2-lite.** The `ike` daemon on routers runs IKE_SA_INIT and IKE_AUTH (four messages) over UDP port 500 on both
  ends (socket `ike#500`, opened with the first `ike.connect`, closed with the last `ike.disconnect`), with real
  headers and original compact payload encodings; IKE SPIs, nonces, KE values and ESP SPIs are FNV-derived (no
  randomness). Both ends initiate when their underlay becomes ready (`ike-kick`, 0 ns); when the two initiations
  cross, the exchange started by the lower tunnel source address continues and the other end abandons its own and
  answers (listed deviation: RFC 7296 lets both complete and deletes one). An unanswered request is retransmitted after
  1, 2 and 4 s (non-periodic), then the SA fails with `ike-no-response`; a failed SA retries on a periodic 10 s timer
  (rule 19), so a wrong key never holds `runToIdle`. The responder matches the initiator's address against its
  keyring peers (no match → `NO_PROPOSAL_CHOSEN`, reason `ike-no-proposal`); a wrong key fails IKE_AUTH with
  `AUTHENTICATION_FAILED`, a severity-4 log on both ends and reason `ike-failed`. A new IKE_SA_INIT from a peer with an
  established SA replaces that SA (the peer reloaded). The `ipsec-sa` table (writer ike, one row per protected tunnel)
  is the gradeable state (rule 20).
- **Rejected:** deferring to P4 (the recommendation; approved for P3a); crypto maps (a crypto-ACL egress hook in ipv4
  like D12's, and the P4 syllabus); IKEv1 (nine messages, the P4 phase visualizer); real AES and SHA (spec §6 "crypto
  simulated", no learner-visible gain, the DTLS precedent); no IKE messages at all (a daemon cannot read its peer's
  key, so a mismatch could not fail); a second tunnel owner for IPsec (it would duplicate [S18]'s underlay evaluation,
  MTU fallback and line-protocol path).

### 1.1 Where the area maps disagreed, and what was chosen

| Question | Proposals | Chosen |
|---|---|---|
| P3 defaults profile | cross-cutting: a `'P3'` profile with CDP as its only (invisible) default, everything else opt-in; management: P3 with invisible CDP, console logging and realism logs, plus visible `service timestamps` lines | D2: CDP is the only MUST default; the timestamps lines come with [S24], extended logging with [S25]; any default must pass the (a)+(b) rule and have a §4.3 row |
| Existing log severity in P3 worlds | management: `%LINK-5-CHANGED` replaces the P1 severity-3 admin-down log in P3 worlds | D4: existing messages never change in any profile; the severity is a listed deviation |
| The P2-profile guard | all maps: record a P2 golden in W0; routing: CCNA 2 labs and templates; WAN and management: templates + CCNA 1 + CCNA 2 in one `p12` test; cross-cutting: 30 worlds, windowed storage, companion export and lab-status goldens | D3: cross-cutting's design plus two synthetic switch-SVI guard worlds (P3 review); the P1 golden stays as is; four shards; `lab-status.p2.json` covers all 35 existing labs |
| P1-guard migration | each map: widen `since: 'P2'` (cited at :591-606, :598-605, :600-608, :28-34) | §9 W0 item 3: the assertions at `accept.p2.p1-digests.test.ts:598-605` accept `since ∈ BUILD_STAGES after 'P1'`; the normalisation becomes per device (§4.6), so switches' new `udp`/`tcp` vanish too |
| Route code 'D' | routing: machine source `'EIGRP'` rendered D; cross-cutting: flagged as a PO decision | D11: DHCP keeps `'D'`; EIGRP [C1] (approved) is `'EIGRP'` rendered `D`, with a legend sentence for a DHCP `D*` |
| EIGRP | routing: COULD, recommended for P5; the design in its §3–§5 | approved as [C1] (§8.5 P5): D26 writes the design in full (classic core only; the map's `variance`, `eigrp stub` and summary lines stay C2/P5, and its `EX` route type and AD 170/5 wait for redistribution) |
| IPsec | WAN: COULD (P4) or SHOULD (VTI + IKEv2-lite, 4.5 ew); a sketch only (its W10) | approved as [C13] (§8.5 P10): D27 writes the design in full on [S18]'s tunnel owner |
| Grader: typed kinds vs generic | areas: ~25 typed kinds; cross-cutting: registry, generic kinds, adapters | D5 and the §2.10 mapping table; the only typed P3 kinds are `acl`, `aclDecision` and the approved [S13] `service`, [S18] `path`, [S20] `traffic` ([S29] `file`, [S38] `packetSeen` and [S8] `convergence` are not approved) |
| `route` member names | routing: `routeType`, `paths`; cross-cutting: `subtype`, `minPaths` | `routeType` (the row's field name: one name per concept) and `minPaths` |
| `cut` by port | routing: `aPort?`, `bPort?`; cross-cutting: `aPort?` | both ends optional; a cut names one cable by either end's port |
| Fragmentation owner | ACL map: SHOULD (F1), with an MSS clamp + honest drop fallback (F0) "maybe owned by WAN"; WAN: needs it for GRE, safety net drops `giant` | D15: [S17] owned by l3; the fallback lives inside [S18] with a new drop reason `mtu-exceeded`, not `giant` |
| RIB change signal | routing: `ipv4.ribWatch` + `ipv4.ribChanged {key, row}`; WAN: `rib.changed {family}` sent to devices with a tunnel port | D8: one registration-based watch with `keys` and `lpm` |
| Where QoS queues live | WAN: link model per egress port; spec §4.7 | D16: link model, per egress port [S20]; classification and marking in the runtime; the scheduler is a pure module shared with the sandbox |
| QoS depth | WAN: full MQC MUST (≈ 11 ew) or "Q-lite" (≈ 5 ew) | Q-lite MUST (M13), full scheduler [S20], WFQ/police/shape [S21], both approved (§8.5 P7) |
| PPP | WAN: MUST (spec) or SHOULD (left the exam blueprint); cross-cutting: lab 22 MUST unless WAN demotes | [S19] (approved); lesson 22's MUST lab practises the P1 HDLC link, and its PPP and CHAP tasks join it with [S19] |
| GRE | WAN: MUST | [S18] (VPN objectives are describe-level; §8.4); approved, so lesson 24 has its lab |
| Remote terminal | ACL map: MUST, first to cut, fallback SSH configuration only; management: NETCONF over SSH and SSH-driven automation libraries depend on it | D14: SSH configuration MUST (M10), remote terminal [S13] (approved); NETCONF [C21] (not approved) would need [S13] |
| vty ACL objective and SSH lab | ACL map: need a network session to have a source address | Configuration and facts in MUST (lessons 15 and 19); with [S13] approved both are graded live through real logins (the `vty-logins` and `acl` rows) and in the clone (`service`) |
| How a remote session reaches the CLI runtime | ACL map: the runtime forwards `remoteCli` to a new `deps.remoteCli` | D14: a zero-delay `remoteCli` SimEvent handled by the Simulation, the D21 `configure` pattern (no new dep) |
| vty on a managed switch | ACL map: managed switches gain `tcp` for vty | D14/D22: the switch transport wakes for vty only on a P3 line (`transport input`, an RSA key), never on `line vty` alone |
| The hosts' file store | management: part of M8 storage and TFTP ([S29] here) | carried by [S32] (hosts' `files:` only), because [S29] is not approved and scripts need it (D21) |
| The tunnel MTU fallback | WAN: `giant` safety net; ACL map: ICMP 3/4 with `icmp.error.param` in F1 (here [S17]) | D15: `mtu-exceeded` and `icmp.error.param` belong to [S18], since [S17] is not approved |
| Managed-switch transport | ACL map: `tcp` (for vty), a snapshot-only change; management: `udp` and `tcp` (MUST), may move ICMP answers | D22: `udp` and `tcp` in MUST, dormant until a P3 service is configured on the switch (P3 review), so no P1/P2 byte moves |
| Scripts, REST and journaling | cross-cutting: a new journaled `apiRequest` op; management: every input already travels as `hostRequest` or `cliExec` | D6: no new op in P3a; `apiRequest` belongs to P3b; [S31] `cliBreak` (not approved) would be the one new op |
| REST client in MUST | management: API client desktop app (MUST) | host-shell `rest` command (MUST, a journaled CLI job); the desktop app is [S27] |
| API request log | management: restconf StateView log; cross-cutting: gradeable state in tables | rule 20: bounded `restconf-log` table |
| Syslog | management: MUST (logger, syslog-server, realism logs, console printing); cross-cutting: lab 29 MUST | describe-level objective: [S24] local logging, [S25] syslog and extended logging, both approved; lab 29 keeps NTP in MUST and gains its logging and syslog tasks |
| Storm control | ACL map: SHOULD; cross-cutting lesson 20: part of the MUST lab | [S16], not approved; lesson 20 teaches it as theory (`later:P3c`) |
| Files and TFTP | management: MUST; cross-cutting: lesson 31 bracketed | [S29] (describe-level objective) |
| Python and playbooks | management: Python SHOULD, playbook runner COULD; cross-cutting: lesson 39 [S], lesson 40 [C] | NF-Py [S32] (approved) with lesson 40's lab; playbook runner [C22] (not approved) would bring lesson 39's lab |
| Python sandbox dependency | cross-cutting: e.g. Pyodide, needs approval; management: NF-Py, Pyodide rejected | D21: NF-Py, no dependency; [S32] approved with no dependency (§8.5 P9) |
| NetFlow, RSPAN | management: COULD, recommend P4 | deferred to P4 (CyberOps flow records, IDS sensors), §12.1 |
| CDP on which devices | cross-cutting: routing and managed-switch; management: also APs, controller, phones | D2 `cdpDefault`: routing and managed-switch models with a CLI, and the controller; not the lightweight AP (no receive path, P3 review) and not home routers; phones with [S35] |
| When the default profile flips | cross-cutting: `LATEST_DEFAULTS_PROFILE` with the W4 catalog flip, the course at W7 | both at the W7 course flip (P3 review; §8.5 P15), and nothing deployed before W8 (rule 21) |
| `PROCESS_ORDER` slots | ACL: `acl` after `nat`; WAN: `gre` after `nat` | `…, nat, acl, gre, icmpv4, …` (§2.1) |
| Test helper | routing, management: `test/p3.world.ts`; cross-cutting: generalise into `staged.world` | rule 13: `test/staged.world.ts`; the P2 aliases are deleted in W0 |
| Wave of the catalog flip | management: W3; the others: W4 | W4, alone (rule 14) |
| OSPF on a tunnel | WAN: the tunnel role needs OSPF network type point-to-point | D7: `tunnel` → point-to-point, added with [S18] |
| Lanes | WAN: `wan`; management: `mgmt` | `mgmt` (MUST: cdp, lldp, ntp rows and the `ntp` machine); `wan` with the approved [S18]/[S19]/[C13]; ACL rows and [S13] `vty-logins` in the existing `security` lane, OSPF and [C1] EIGRP in `routing` |
| Queueing sandbox | WAN: [S] web concept tool | part of MUST (M13), on the pure `core/queueing.ts` that [S20] reuses |
| The FIFO congestion view | WAN: web-only, from frames with a future `txStart` | an engine display member, `PortSnapshot.txBacklog` (P3 review: the in-flight list never carries future frames) |

---

## 2. Contract changes

Every member below is tagged `@since P3` in the source (transition rule, §0 rule 2). Members marked **optional by
meaning (OBM)** keep their `?` for ever (absent = P1/P2 behaviour and bytes); §2.15 lists every one of them, and the
source tags each `@since P3 (optional by meaning)`. Everything unmarked is MUST. The blocks of the items approved in
§8.5 — [S1], [S2], [S3], [S9], [S13], [S18], [S19], [S20], [S21], [S24], [S25], [S32], [S37], [C1] and [C13] — land in
wave 0 exactly like MUST blocks; the two COULD blocks are written in full by the architect in §2.16 ([C1]) and §2.17
([C13]). The blocks of every other bracketed item are designs for the stage §12.1 names and are never added in P3a
(§0 rule 3). Additions to unions append at the end, so existing orders (and the snapshot key order that depends on
them) never change.

### 2.1 `contracts/catalog.ts`

```ts
export type BuildStage = 'P0' | 'P0.5' | 'P1' | 'P2' | 'P3';
export const BUILD_STAGES: readonly BuildStage[] = ['P0', 'P0.5', 'P1', 'P2', 'P3'];

/** Which stage's DEFAULT behaviours a world uses (P2 D2, P3 D2). Absent in a topology = 'P1'. Never gates a feature. */
export type DefaultsProfile = 'P1' | 'P2' | 'P3';
export const DEFAULTS_PROFILES: readonly DefaultsProfile[] = ['P1', 'P2', 'P3'];
/**
 * @since P3 The profile a new world takes when no course names one (web `profileForCourse`, "Use current defaults").
 * 'P2' until the W7 course flip; that change sets 'P3' together with the course (§7 W7, §9 W7, §8.5 P15).
 */
export const LATEST_DEFAULTS_PROFILE: DefaultsProfile = 'P2';

// CAPABILITIES: append (tuple order = storage order)
//   [S32] 'programmable'   implies ['host']: a host that runs the NF-Py script host and the automation workspace
// GUI_PANELS: append 'desktop.traffic' (the Traffic generator app, M13), then the approved [S32] 'desktop.automation'
//   (not approved, never added in P3a: [S27] 'desktop.api-client', [S33] 'desktop.snmp-manager')
// PortEncap: [S19] 'ppp' becomes live (reserved today, catalog.ts:227-228); [S18] append 'tunnel' ("the owner frames it")
// FramingProto: [S19] += 'ppp'
// PORT_ROLES: [S18] append 'tunnel'
//   tunnel: { frames: true, bridged: false, hairpin: false, l3: true, linkable: false, configurable: true,
//             virtual: true, egress: 'owner', wiring: null, label: 'Tunnel interface' }; ROLE_KINDS.tunnel = ['virtual']
// VirtualFamilySpec.role += [S18] 'tunnel'; VirtualFamilySpec.encap?: PortEncap [S18] (OBM)
```

`PROCESS_ORDER` **final** order (new names in **bold**; the relative order of existing names is unchanged, so every
existing `DeviceModel.processes` list stays an order-preserving subsequence). **Wave 0 inserts none of the new
names**; each is inserted at this position in the change that registers its factory (§0 rule 3): the W4 catalog flip
inserts `ospf`, `acl`, `cdp`, `lldp`, `ntp`, `restconf`, `traffic` and the approved `ppp` [S19], `gre` [S18], `vty`,
`vty-client` [S13], `logger` [S24], `syslog-server` [S25], `eigrp` [C1] and `ike` [C13]; the W6 flip inserts
`script-host` [S32]. The names of items that are not approved (`ospfv3`, `tftp`, `snmp-agent`, `snmp-manager`) are
never inserted in P3a. Until then `test/staged.world.ts` holds this order, restricted to approved names, as test-only
data (§0 rule 13).

`wlan-ap`, `wlan-client`, `capwap-wtp`, `cell-client`, `hdlc`, **`ppp`** [S19], `eth-switch`, `vlan`, `dtp`,
`etherchannel`, `stp`, **`cdp`**, **`lldp`**, `arp`, `ipv4`, `nat`, **`acl`**, **`gre`** [S18], `icmpv4`, `host`,
`ipv6`, `nd`, `icmpv6`, `udp`, `tcp`, **`vty`** [S13], **`vty-client`** [S13], **`logger`** [S24], **`ntp`**,
**`tftp`** [S29], **`snmp-agent`** [S33], **`snmp-manager`** [S33], **`syslog-server`** [S25], `hsrp`, **`ospf`**,
**`ospfv3`** [S6], **`eigrp`** [C1], **`ike`** [C13], `dhcp-client`, `dhcp-server`, `dhcpv6-client`, `dhcpv6-server`,
`dns-client`, `dns-server`, `http-client`, `http-server`, **`restconf`**, `traceroute`, **`traffic`**, `capwap-ac`,
**`script-host`** [S32].

Constraints relied upon: `hdlc` before `ppp` (the encapsulation switch disarms HDLC keepalives first); `eth-switch`
before `cdp`/`lldp` (link-change fan-out: CAM flush first); `ipv4` before `acl` and `gre`; `udp` before `ntp`,
`logger`, `tftp`, `snmp-*`, `syslog-server`, `ike`; `tcp` before `vty`, `restconf`; `http-client` before `restconf` is
not required (they talk only through sockets), nor `gre` before `ike` (they talk only through requests). `cdp` and
`lldp` do not join `L2_PROCESSES` (they need no `l2Changed`).

`CAPABILITY_PROCESSES` additions (all `since: 'P3'`; each row is added by the item that registers the daemon, never
earlier):

| Capability | Adds | Added by |
|---|---|---|
| `routing` | `ospf`, `acl`, `cdp`, `lldp`, `ntp`, `restconf` | W4 catalog |
| `managed-switch` | `udp`, `tcp` (dormant until a P3 service is configured, D22), `acl`, `cdp`, `lldp`, `ntp`, `restconf` | W4 catalog |
| `wireless-controller` | `cdp`, `ntp` | W4 catalog |
| `server` | `ntp` | W4 catalog |
| `host` | `traffic` | W4 catalog |
| `routing`, `managed-switch`, `wireless-controller` | `logger` [S24] | W4 catalog |
| `server` | `syslog-server` [S25] | W4 catalog |
| `routing` | `gre` [S18]; `ppp` [S19]; `eigrp` [C1]; `ike` [C13] | W4 catalog |
| `routing`, `managed-switch` / `host` | `vty`, `vty-client` / `vty-client` [S13] | W4 catalog |
| `programmable` | `script-host` [S32] | the second flip (W6) |
| `routing` / `routing`, `managed-switch`, `server` / `routing`, `managed-switch` / `server`, `programmable` | `ospfv3` [S6] / `tftp` [S29] / `snmp-agent` / `snmp-manager` [S33] | not approved: no row in P3a |

`programmable` gains `script-host` only: the management map also gave it `tftp`, which is [S29] (not approved), and a
script needs nothing from TFTP (D21).

Home routers and other GUI-only routing devices derive `ospf`, `acl`, `cdp`, `lldp`, `ntp` and `restconf` — and the
approved `ppp`, `gre`, `vty`, `vty-client`, `logger`, `eigrp` and `ike` — through the `routing` implication, exactly
as they derive `hsrp` today; with no CLI and no configured line they stay silent, and `cdpDefault` is false for them
(D2). Their snapshots gain the (empty) tables of those daemons after the flip (§9 W4,
`sim.snapshot-cache.test.ts:166-176`; normalised away in the goldens, §4.6). The lightweight AP gets no discovery
row: it has no receive path (D2, D18).

```ts
// device.ts — DeviceModel += (OBM, filled by defineModel)
//   cdpDefault?: true     CDP runs by default in a P3 world (D2): !nat-gateway && ((cli.shell === 'nfos' &&
//                         (routing || managed-switch)) || wireless-controller). Absent = never on by default.
//   [S29] storage?: { flashBytes: number; nvramBytes: number; image: { file: string; version: string; nominalBytes: number } }
//         (not approved; a host's `files:` store [S32] needs no model member: every `host` model has one, empty by default)
```

### 2.2 `contracts/port.ts`

```ts
// ErrDisableCause: append 'dhcp-rate-limit' | 'arp-inspection'     (W0: the union only; [S16] 'storm-control' is not approved)
//   ERR_DISABLE_CAUSES is appended in the same order by the W2 l2 change that raises the causes (a pre-approved
//   contract edit), never in W0: `show errdisable recovery` iterates it (cli/handlers/errdisable.ts:23, :45).
//   ERR_DISABLE_CAUSE_TEXT (device/device.ts:210, a Record) gets its two original texts as a W0 compile stub.
// PortCounters += aclDenies?: number   (OBM) incremented by the runtime on every 'acl-deny' drop that names a port.
```

Nothing else changes in `port.ts`: OSPF, snooping, tunnel and PPP state live in tables (rule 20).

### 2.3 `contracts/pdu.ts` and `contracts/fields.ts`

```ts
// ProtoName: append 'ospf' | 'ospf-lsa' | 'cdp' | 'lldp' | 'ntp', then the approved items' names in this order:
//   [S13] 'telnet' | 'ssh'  [S18] 'gre'  [S19] 'ppp' | 'lcp' | 'pap' | 'chap' | 'ipcp' | 'ipv6cp'  [S25] 'syslog'
//   [C1] 'eigrp'  [C13] 'esp' | 'ikev2'            (not approved, never added in P3a: [S29] 'tftp', [S33] 'snmp')

// PduMeta += protectedBy?: 'tls'   (OBM) with `protected: true`, names the simulated channel (RESTCONF). Absent
//   together with `protected` keeps P2's DTLS meaning.   [S13] widens it with 'ssh'; [C13] with 'esp' | 'ike'.
// PduMeta += [S34] mirror?: true (OBM; a SPAN copy)   [S17] parent?: PduId is reused for non-initial fragments
// MutationReason: append 'QosMark'   [S17] 'FragmentReassemble'   ('FragmentSplit', 'Encrypt', 'Decrypt' exist)
// [S17] Pdu.fragmentAt(ctx, ipLayer, offset, length, more, cause) and PduFactory.fragment: the first fragment keeps
//   the PduId (rewritten in place, FragmentSplit recorded); the others are new PDUs with meta.parent.
// DispatchSpace += [S19] 'ppp.proto'

export const IPPROTO_OSPF = 89;
export const OSPF_ALL_ROUTERS = '224.0.0.5';
export const OSPF_ALL_DROUTERS = '224.0.0.6';
/** The NF control-frame PID of the NF discovery format ("CDP", a name only; P2 D8). */
export const NF_PID_CDP = 0x0004;
export const LLDP_NEAREST_BRIDGE_MAC = '01:80:c2:00:00:0e';
export const ETHERTYPE_LLDP = 0x88cc;
export const UDP_PORT_NTP = 123;
export const UDP_PORT_DISCARD = 9;
export const TCP_PORT_HTTPS = 443;
// [S6]  OSPF6_ALL_ROUTERS = 'ff02::5'; OSPF6_ALL_DROUTERS = 'ff02::6'
// [S18] IPPROTO_GRE = 47; GRE_OVERHEAD = 24
// [S19] PPP_ADDRESS = 0xff; PPP_CONTROL = 0x03; PPP_HEADER = 4; PPP_FCS = 2;
//       PPP_PROTO = { ipv4: 0x0021, ipv6: 0x0057, lcp: 0xc021, pap: 0xc023, chap: 0xc223, ipcp: 0x8021, ipv6cp: 0x8057 }
// [S25] UDP_PORT_SYSLOG = 514   [S29] UDP_PORT_TFTP = 69   [S33] UDP_PORT_SNMP = 161; UDP_PORT_SNMP_TRAP = 162
// [C1]  IPPROTO_EIGRP = 88; EIGRP_GROUP = '224.0.0.10'; …   [C13] IPPROTO_ESP = 50; UDP_PORT_IKE = 500; …  (§2.16, §2.17)
```

**Field tables** (`PROTO_FIELDS`; codecs encode and decode exactly these keys; D = derived, R = required, O =
decode-only):

| Proto | Fields |
|---|---|
| `ospf` | Header: `version` u8 R (2; 3 with S6); `type` u8 R (1 hello, 2 DBD, 3 LSR, 4 LSU, 5 LSAck); `length` u16 D; `routerId` ipv4 R; `area` ipv4 R; `checksum` u16 D; `checksumValid` O; `auType` u16 = 0; [S5] `authKey` string (type 1, ≤ 8), `keyId` u8, `cryptoSeq` u32, `digest` bytes 16 (type 2, a trailer). Hello: `mask` ipv4; `helloInterval` u16 = 10; `options` u8 (E 0x02); `priority` u8 = 1; `deadInterval` u32 = 40; `dr` ipv4; `bdr` ipv4; `neighbors` string (router ids joined by `,`). DBD: `mtu` u16; `options` u8; `flags` u8 (I 4, M 2, MS 1); `ddSeq` u32. LSR: `requests` string (`<type>:<lsid>:<adv>` joined by `;`). LSU: `count` u32 D. `stopsMeaning`: true. |
| `ospf-lsa` | `age` u16; `options` u8; `lsType` u8 (MUST: 1 router, 2 network, 5 external; [S4] 3, 4; [C4] 7); `lsid` ipv4; `advRouter` ipv4; `seq` u32; `checksum` u16 (Fletcher, age excluded) and `length` u16: **D in an LSU; R when `headerOnly`** (a DBD or LSAck header copy carries the full LSA's values, which its 20 bytes cannot recompute; the encoder reads the enclosing `ospf.type` through `ctx.outer`); `checksumValid` O; `headerOnly` bool O (from the enclosing packet type: DBD and LSAck carry headers only). Router body: `flags` u8 (V 4, E 2, B 1), `links` string (`<kind>,<id>,<data>,<metric>` joined by `;`; kinds p2p, transit, stub). Network body: `mask`, `attached` string. Summary / ASBR-summary [S4]: `mask`, `metric` u24. External: `mask`, `e2` bool, `metric` u24, `forward` ipv4, `tag` u32. |
| `cdp` (NF) | `version` u8 = 2; `ttl` u8 = 180; `deviceId` string R; `addresses` string (comma-joined); `portId` string R; `capabilities` string (`R`, `S`, `I` letters); `platform` string; `software` string (original text); `nativeVlan` u16?; `duplex` string?. Original TLV layout: type u16, length u16, value. [S35] adds `voiceVlan` u16?. |
| `lldp` | `chassisSubtype` u8 = 4 (MAC); `chassisId` string; `portSubtype` u8 = 5 (interface name); `portId` string; `ttl` u16 = 120; `portDescription` string?; `systemName` string?; `systemDescription` string?; `capabilities` u16?; `enabledCapabilities` u16?; `mgmtAddress` ipv4?; end TLV derived. [S35] adds `medVlan` u16?. |
| `ntp` | `leap` u2 (3 = alarm: an unsynchronised server); `version` u3 = 4; `mode` u3 (3 client, 4 server); `stratum` u8 (16 = unsynchronised); `poll` s8 = 6; `precision` s8; `rootDelay` u32; `rootDispersion` u32; `refId` string (`LOCL`, `INIT` or an address); `refTimestamp`, `originTimestamp`, `receiveTimestamp`, `transmitTimestamp` (decimal `s.fffffffff` strings; 64-bit on the wire). |

The field tables of the approved SHOULD items are carried from the area maps without change ([C1] `eigrp` and [C13]
`esp`, `ikev2` are in §2.16 and §2.17): [S18] `gre`
(`checksumPresent`, `keyPresent`, `seqPresent` bool = false; `version` u3 = 0; `protocolType` u16 filled in the
ethertype space); [S19] `ppp` (`address`, `control`, `protocol` u16, `fcs` D, `fcsValid` O), `lcp` (`code`, `id`,
`length` D, `mru`?, `authProto`?, `magic`?, `echoMagic`?, `reason`?, `rejected`?), `pap` (`code`, `id`, `peerId`,
`password` — clear on the wire, by design — `message`), `chap` (`code`, `id`, `value` bytes 16, `name`, `message`),
`ipcp` (`code`, `id`, `ipAddress`?), `ipv6cp` (`code`, `id`, `interfaceId`?); [S13] `telnet` (`data` string, `iac`
string: the option commands, e.g. `WILL ECHO`), `ssh` (`phase` `'version' | 'protected'`, `version` string on the
clear version exchange, `length` u32 D, `payload` bytes: the XORed stream the inspector shows decoded under the SSH
banner); [S25] `syslog` (`pri`, `facility` D, `severity` D, `timestamp`, `hostname`, `message`). Not approved, so
never added in P3a: [S29] `tftp`, [S33] `snmp` (their fields stay in the management map).

**Dispatch** (`DISPATCH_TABLE`):

```ts
d('ipproto', 89, 'ospf', 'P3'),
d('nf.pid', 0x0004, 'cdp', 'P3'),
d('ethertype', 0x88cc, 'lldp', 'P3'),
// udp.port 123 → 'ntp' loses its `reserved` flag (fields.ts:470-476, services.ts:6-7)
d('tcp.port', 443, 'http', 'P3'),       // HTTP decoded on 443; the inspector shows it under the TLS banner (D21)
// [S18] d('ipproto', 47, 'gre', 'P3')   [S19] d('ppp.proto', …) per PPP_PROTO   [S13] telnet 23 / ssh 22 un-reserved
// [S25] syslog 514 un-reserved   ([S29] tftp 69 and [S33] snmp 161 stay reserved: not approved)
// [C1] d('ipproto', 88, 'eigrp', 'P3')   [C13] d('ipproto', 50, 'esp', 'P3'), d('udp.port', 500, 'ikev2', 'P3')
```

`LINK_FIELDS` gains [S19] `ppp → {field: 'protocol', space: 'ppp.proto'}` and [S18] `gre → {field: 'protocolType',
space: 'ethertype'}`. [S17] the ipv4 codec gives a packet with `fragOffset > 0` a `payload` next layer and reports a
first fragment's transport checksum as unknown, not wrong. `IPV4_UPPER` (`protocols/ip-upper.ts:33-44`, code) gains
`{89, 'ospf'}`; [S18] `{47, 'gre'}`; [C1] `{88, 'eigrp'}`; [C13] `{50, 'gre'}` (the tunnel owner, D27); [S6]
`IPV6_UPPER` `{89, 'ospfv3'}` (not approved).

### 2.4 `contracts/process.ts`

```ts
// FsmMachine: append 'ospf-if' | 'ospf-nbr' | 'ntp'
//   [S6] 'ospf6-if' | 'ospf6-nbr'   [S18] 'tunnel'   [S19] 'ppp-lcp' | 'ppp-auth' | 'ppp-ncp'   [C1] 'eigrp-nbr' | 'eigrp-route'   [C13] 'ike'
//   subjects: 'GigabitEthernet0/0' (ospf-if); 'GigabitEthernet0/0 2.2.2.2' (ospf-nbr); '10.0.0.10' (ntp, the server);
//             [S19] 'Serial0/0/0' and 'Serial0/0/0 IPCP'; [S18] 'Tunnel0'; [C1] 'GigabitEthernet0/0 10.0.12.2'
//             (eigrp-nbr) and '10.4.0.0/24' (eigrp-route); [C13] 'Tunnel0' (ike)

// ProcessCtx +=
//   clock(): DeviceClockView;          @since P3 the device clock (D19, contracts/clock.ts). W1 device; required once
//                                      implemented (P3_CTX spread, §0 rule 2).
//   [S32] files(fs: FileSystemId): readonly StoredFileMeta[];  readFile(fs: FileSystemId, path: string): StoredFile | undefined
//         (hosts' `files:` only in P3a; [S29] would widen FileSystemId, D21)

/** @since P3 Why a policy dropped a packet (D12, D13): the sentence, and where the rule lives. */
export interface DropRule {
  readonly kind: 'acl' | 'dhcp-snooping' | 'arp-inspection' /* [S15] | 'ip-source-guard'  [S16] | 'storm-control' */;
  /** Original wording, e.g. 'denied by access list 101 line 20 (deny tcp host 10.1.1.10 any eq www), inbound on GigabitEthernet0/0'. */
  readonly text: string;
  readonly table?: TableName; readonly key?: string;
  readonly config?: { readonly context: readonly (readonly string[])[]; readonly line: readonly string[] };
  readonly iface?: PortId; readonly dir?: 'in' | 'out';
  readonly list?: string; readonly seq?: number | 'implicit' /* [S11] | 'nd-na' | 'nd-ns' */;
  readonly family?: 4 /* [S11] | 6 */;
}

/** @since P3 Who changed the configuration through the configure seam (D21). */
export interface ConfigOrigin {
  readonly via: 'restconf' /* [S33] | 'snmp'  [S29] | 'tftp'  [C21] | 'netconf' */;
  readonly user?: string; readonly address?: IpAddress;
}

// Action +=
  | { type: 'configure'; token: string; lines: readonly string[]; atomic?: boolean; indentation?: boolean; origin: ConfigOrigin }
      // runtime: schedule SimEvent {kind:'deviceConfigure'} at now through deps.scheduler (zero delay, non-periodic).
      // In THAT dispatch the Simulation — the one caller — runs cliCore.configure(device, lines, {atomic, indentation,
      // origin}) with its own ACTION_BUDGET; the headless session hands `origin` to applyConfigLine for each line; then
      // it delivers ProcessEvent {kind:'config.result', token, result} to the issuer. Never nested, never journaled (D21).
  | { type: 'clock'; op: 'step' | 'set'; offsetNs?: string /* decimal, may be negative */; unixMs?: number;
      source: 'ntp' | 'master' | 'user'; stratum?: number; reference?: string }
      // ntp only (a step after a valid reply; a set on behalf of `clock set`, which the CLI sends as ntp.clockSet) →
      // runtime: rebase the device clock; emits ONE ctx.transition-style debug event {machine:'ntp', subject:
      // reference, from, to} when the synchronised state changes (category 'ntp events'). ntp writes its `clock` row.
// drop action += rule?: DropRule   (OBM) passed through to the trace `drop` event
// [S18] | { type: 'virtualChanged' }   runtime: recomputeVirtual(now) (tunnel oper from the `tunnels` row)
// [S13] | { type: 'remoteCli'; op: 'open'|'line'|'close'; conn: string; peer?: IpAddress; proto?: 'telnet'|'ssh'; user?: string; text?: string }
//       | { type: 'cliRemote'; session: SessionId; prompt?: string; input?: 'plain'|'secret'; remote?: string }
//       runtime: both schedule SimEvent {kind: 'remoteCli', device, from, act} at now through deps.scheduler (zero
//       delay, non-periodic); in THAT dispatch the Simulation calls CliRuntime.openRemote/execRemote/closeRemote
//       (remoteCli, from vty) or setRemote (cliRemote, from vty-client). No DeviceRuntimeDeps member (D14, D21).
// [S32] | { type: 'storage'; op: 'write' | 'delete'; fs: FileSystemId; path: string; file?: StoredFileInput }
//       runtime: writes or deletes a file of the host's `files:` store (script-host; [S29] would add flash:/nvram:)

// ProcessRequest +=
  | { kind: 'ipv4.routes'; owner: ProcessName; rows: readonly RouteRow[] }
      // → ipv4: replace owner's candidate set (D8): ascending (network u32, prefixLen); re-offer changed slots, offer
      // new, withdraw vanished; arbiter owner `${owner}|${slot}`; settleStatics once; no decision event.
  | { kind: 'ipv4.ribWatch'; owner: ProcessName; keys?: readonly string[]; lpm?: readonly Ipv4Address[] }
      // → ipv4: register (replace) the owner's watch; answered at once and on every change by ipv4.ribChanged to the
      // owner only. keys = exact RIB keys ('0.0.0.0/0'); lpm = addresses whose longest-match result is watched (MUST:
      // an unsynchronised NTP client's servers, D19; [S18] a tunnel destination). Both empty/absent = stop.
  | { kind: 'ospf.clear'; session?: SessionId }          // cli → ospf after the interactive confirm (refused headless)
  | { kind: 'acl.filter'; family: 4 /* [S11] | 6 */; dir: 'in' | 'out'; iface: PortId; inPort?: PortId; natted?: true;
      pdu: Pdu; onPermit: Action }
      // ipv4 ([S11] ipv6, nat with filterOut) → acl. inPort (dir 'out' only): the packet's ingress interface, used as
      // the ICMP error's source interface. natted: set by nat on the filterOut path (the packet is already translated).
      // acl answers with EXACTLY ONE of: [onPermit]; or a drop {reason 'acl-deny', port: iface, detail, rule} plus,
      // when the rate gate is open, `no ip unreachables` is absent and `natted` is not set, request icmpv4
      // icmp.error {3, 13, inPort: dir 'in' ? iface : inPort} ([S11] icmpv6 1/1). Counts on the matched row.
  | { kind: 'acl.clear'; list?: string /* [S11] family?: 4 | 6 */ }  // cli → acl: `clear access-list counters [<list>]`
  | { kind: 'http.request'; owner: ProcessName | 'cli' /* [S27] | 'gui' */; token: string; method: HttpMethod; url: string;
      headers?: readonly (readonly [string, string])[]; body?: Uint8Array; timeoutNs?: SimTime; session?: SessionId }
      // → http-client: resolve (dns-client for names), tcp.connect {tls: url is https}, send head + Content-Length body,
      // parse the response; answer http.result to a process owner or text to the CLI session (owner 'cli', the
      // host-shell `rest` job); [S27] a StateView tab (owner 'gui'). http.fetch is unchanged.
  | { kind: 'traffic.start'; flow: TrafficFlowSpec; session?: SessionId }   // host shell / GUI → traffic (M13)
  | { kind: 'traffic.stop'; id: string; session?: SessionId }
  | { kind: 'ntp.clockSet'; unixMs: number; session?: SessionId }
      // cli `clock set` → ntp: ntp returns the `clock {op: 'set', source: 'user'}` action and writes its `clock` row
      // (rule 20). Every nfos device with the `clock set` command runs ntp after the W4 flip.
  | { kind: 'tcp.probe'; session: string; dst: IpAddress; port: number; src?: IpAddress; timeoutNs: SimTime }
      // grader clone → tcp, applied exactly as icmp.ping is (dev.applyActions, sim/lab-checks.ts:847-891): one SYN
      // from an ephemeral port. Outcome in the tcp StateView `probes` (§2.6), keyed by session: 'open' on SYN-ACK
      // (answered with a RST, so no connection is kept), 'refused' on RST, 'unreachable' on an ICMP destination
      // unreachable (type and code kept), 'timeout' after timeoutNs (3 s).
  | { kind: 'udp.probe'; session: string; dst: IpAddress; port: number; src?: IpAddress; timeoutNs: SimTime }
      // grader clone → udp: one datagram (payload: the original marker 'NFPR' and the session) from an ephemeral
      // port; the udp StateView records 'unreachable' on an ICMP error, else 'sent'. Pass or fail is read from the
      // clone's trace (§2.10): the datagram consumed by a socket on the target = reached a listener.
// widened (all OBM):
//   ipv4.resume += after?: 'acl-in'     acl → ipv4: continue at the NAT inbound hook (absent = P2 meaning: the for-me test)
//   nat.outbound += filterOut?: true    ipv4 → nat: after translating, nat hands the packet to acl.filter (dir 'out')
//                                       with onPermit = the arp.sendVia request it would have sent
// [S6]  | { kind: 'ipv6.routes'; owner; rows: readonly Route6Row[] } | { kind: 'ipv6.group'; op: 'join'|'leave'; iface; group: Ipv6Address; owner }
//       | { kind: 'ospfv3.clear'; session? }
// [S11] | { kind: 'ipv6.resume'; pdu: Pdu; inPort: PortId; after: 'acl-in' }
// [S13] | { kind: 'acl.check'; family: 4|6; list: string; tuple: PacketTuple; token: string; owner: ProcessName }  (answered by acl.verdict)
//       | { kind: 'vty.connect'; session; target: IpAddress; proto: 'telnet'|'ssh'; user?; password?; port? }
//       | { kind: 'vty.input'; session; line: string } | { kind: 'vty.interrupt'; session }
//       tcp.listen += service?: true  (OBM: hidden listener, no row, no debug, no sock.opened, not in the tcp StateView)
// [S18] icmp.error += param?: number  (OBM: next-hop MTU in the low 16 bits of icmpv4 `unused`, RFC 1191; the D15
//       fallback of every tunnel, GRE and [C13] IPsec; implemented by W1 l3 [S18]; [S17] would reuse it)
// [S29] | { kind: 'tftp.transfer'; owner; token; session?; op: 'get'|'put'; server: IpAddress; remote: string;
//           local: { fs: FileSystemId; path: string } | { config: 'running' | 'startup' } }
// [S32] | { kind: 'script.run'; token; file: string; argv?: readonly string[]; session? } | { kind: 'script.stop'; token }
//       | { kind: 'file.write'; path: string; content: string } | { kind: 'file.delete'; path: string }
// [S33] | { kind: 'snmp.op'; token; op: 'get'|'getnext'|'getbulk'|'walk'|'set'; target; version: '2c'|'3'; community?; user?; oid; value? }
// [C1]  | { kind: 'eigrp.clear'; neighbor?: IpAddress; session? }                   (cli → eigrp, §2.16)
// [C13] | { kind: 'ike.connect'; port; local; peer; profile } | { kind: 'ike.disconnect'; port }   (gre → ike)
//       | { kind: 'tunnel.sa'; port; op: 'up' | 'down'; spiIn?; spiOut?; keyId?; reason? }         (ike → gre, §2.17)

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** @since P3 One generated flow (M13). Caps: ≤ 8 flows per device; per flow ≤ 2 Mb/s and ≤ 1000 pps; every flow
 *  stops at most TRAFFIC_MAX_DURATION_MS after it starts (a count or duration beyond it is refused). */
export interface TrafficFlowSpec {
  readonly id?: string;                 // default: the lowest free 'f<n>'
  readonly dst: IpAddress; readonly dstPort?: number /* default 9 (discard) */;
  readonly sizeBytes: number;           // IP datagram size, 60–1500
  readonly rateKbps?: number; readonly pps?: number;   // exactly one; pacing = floor(size·8·1e9 / rate) ns
  readonly dscp?: number;               // 0–63, default 0
  readonly count?: number; readonly durationMs?: number;
      // bounded: a non-periodic pacing timer, so runToIdle waits for its end. Neither = continuous: a periodic pacing
      // timer that stops at `flow stop` or the cap; used only under runFor, because its datagrams commit non-periodic
      // link events and a congested link would hold runToIdle until the cap (rule 19).
  readonly preset?: 'voice-g729' | 'voice-g711';          // 50 pps × 60 B / × 200 B, dscp 46
}
/** @since P3 The hard cap of every generated flow: 5 minutes of sim time (D16). */
export const TRAFFIC_MAX_DURATION_MS = 300_000;
```

`DemuxLayer` gains [S19] `'ppp'`.

### 2.5 `contracts/transport.ts` (ProcessEvent)

```ts
/** @since P3 ipv4 → the watcher that registered with ipv4.ribWatch (D8); never sent to anyone else. `lpm` is MUST
 *  (NTP, D19). */
export interface RibChangedEvent { kind: 'ipv4.ribChanged'; key?: string; row?: RouteRow; lpm?: { address: Ipv4Address; row?: RouteRow } }
/** @since P3 Simulation → the process that issued a `configure` action (D21). */
export interface ConfigResultEvent { kind: 'config.result'; token: string; result: ConfigureResult }
/** @since P3 http-client → the process owner of an http.request. */
export interface HttpResultEvent {
  kind: 'http.result'; token: string; status?: number; reason?: string;
  headers?: readonly (readonly [string, string])[]; body?: Uint8Array;
  error?: SocketErrorCode | 'bad-url' | 'timeout';
}
/** @since P3 udp → traffic on the receiving host: a generated datagram (it carries the traffic header) that reaches a
 *  port with no socket is consumed silently (no port-unreachable) and handed over (M13). */
export interface TrafficRxEvent { kind: 'traffic.rx'; pdu: Pdu; iface: PortId; from: IpAddress; dstPort: number }
// ProcessEvent = … | RibChangedEvent | ConfigResultEvent | HttpResultEvent | TrafficRxEvent
//   [S24] | { kind: 'log.record'; at: SimTime; severity: Severity; facility: string; message: string; mnemonic?: string }
//   [S13] | { kind: 'acl.verdict'; token: string; action: 'permit' | 'deny'; seq: number | 'implicit' }
//         | { kind: 'vty.output'; conn: string; text: string; prompt?: string; input?: 'plain' | 'secret'; closed?: true }
//   [S29] | { kind: 'tftp.result'; token; ok: boolean; bytes: number; error?: string }   [S33] | { kind: 'snmp.result'; token; … }
// tcp.listen / tcp.connect += tls?: true   (OBM) data segments of the connection carry meta.protected + protectedBy 'tls'
// sock.error code += 'admin-prohibited'   tcp's soft error for ICMP 3/13 (D12)
```

The UDP discard rule is exact: udp consumes a datagram to a port with no socket **only** when the traffic daemon runs
on the device **and** the datagram's payload starts with the traffic header (an original 4-byte marker `NFTG`, the
flow id, a u32 sequence number, the u64 send time in ns and a flags byte whose bit 0 marks a flow's final datagram);
every other datagram keeps P1's port-unreachable behaviour, so no P1 or P2 world (which carries no generated datagram)
changes.

### 2.6 `contracts/tables.ts`

```ts
// TableDescriptor.since: 'P0' | 'P0.5' | 'P1' | 'P2' | 'P3'
// ExtraTableName += 'ospf-interfaces' | 'ospf-neighbors' | 'ospf-lsdb' | 'acl' | 'dhcp-snooping' | 'arp-inspection'
//                   | 'cdp-neighbours' | 'lldp-neighbours' | 'ntp-peers' | 'clock' | 'restconf-log' | 'flows'
//   then the approved items' tables in this order: [S13] 'vty-logins'   [S18] 'tunnels'   [S19] 'ppp'
//   [S25] 'syslog-messages'   [S32] 'script-runs'   [C1] 'eigrp-neighbors' | 'eigrp-topology'   [C13] 'ipsec-sa'
//   (not approved, never added in P3a: [S6] 'ospf6-*', [S16] 'storm-control', [S33] 'snmp-traps')
//   (W0 adds the members and their TABLE_DESCRIPTORS / TABLE_LANES compile stubs; which models derive a table is
//   decided by PROCESS_TABLES in the change that registers the daemon, below.)

// RouteRow.source: 'C' | 'L' | 'S' | 'D' | 'O' | 'EIGRP'   ('EIGRP' is [C1]'s, D11)
// RouteRow.routeType?: 'E2' (OBM; MUST: `default-information originate`)   [S4] | 'IA'   [C6] | 'E1'   [C4] | 'N1' | 'N2'
// Route6Row.source += [S6] 'O'; Route6Row.routeType? [S6] (OBM)
export const AD_OSPF = 110;   // [C1] AD_EIGRP = 90 (§2.16; external 170 and summary 5 wait for P5)

export type OspfAreaId = string;   // dotted: '0.0.0.0'
export type OspfNetworkType = 'broadcast' | 'point-to-point' | 'loopback' /* [C3] | 'non-broadcast' | 'point-to-multipoint' */;
export type OspfIsmState = 'down' | 'loopback' | 'waiting' | 'point-to-point' | 'drother' | 'backup' | 'dr';
export type OspfNsmState = 'down' | 'attempt' | 'init' | '2way' | 'exstart' | 'exchange' | 'loading' | 'full';
/** @since P3 key = port. Writer: ospf. Exists while the interface is enabled for OSPF. Rewritten only when a column changes (rule 20). */
export interface OspfInterfaceRow extends TableRow {
  port: PortId; process: number; routerId: Ipv4Address /* the id in use (fact ospf.routerId) */; area: OspfAreaId;
  networkType: OspfNetworkType; state: OspfIsmState;
  address?: Ipv4Address; prefixLen?: number; cost: number; costSource: 'bandwidth' | 'configured';
  priority: number; helloS: number; deadS: number; passive: boolean;   // [S5] += auth: 'none' | 'simple' | 'md5'
  dr?: Ipv4Address; drAddress?: Ipv4Address; bdr?: Ipv4Address; bdrAddress?: Ipv4Address;
  neighbors: number; adjacent: number; stateSince: SimTime;
  waitUntil?: SimTime;                                                              // the draining bar while Waiting
  rejected?: { from: Ipv4Address; routerId: Ipv4Address; reason: string; at: SimTime };   // the last refused hello
}
/** @since P3 key = ospfNbrKey(port, routerId). Writer: ospf. Written only on state, role, DR/BDR or priority change. */
export interface OspfNeighborRow extends TableRow {
  port: PortId; routerId: Ipv4Address; address: Ipv4Address; priority: number; state: OspfNsmState;
  role: 'dr' | 'bdr' | 'drother' | 'none'; dr: Ipv4Address; bdr: Ipv4Address; stateSince: SimTime; master?: boolean;
}
export const ospfNbrKey = (port: PortId, routerId: Ipv4Address): string => `${port}|${routerId}`;
export type OspfLsaType = 1 | 2 | 5 /* [S4] | 3 | 4   [C4] | 7 */;
export interface OspfRouterLink { kind: 'p2p' | 'transit' | 'stub'; id: Ipv4Address; data: Ipv4Address; metric: number }   // virtual links: P5
/** @since P3 key = ospfLsaKey(scope, type, lsid, adv); scope = area or 'as'. Writer: ospf. No expiresAt (Table.expire
 *  would delete it): the live age is ageAtInstall + (now − installedAt) / 1 s, capped at 3600. */
export interface OspfLsaRow extends TableRow {
  scope: OspfAreaId | 'as'; type: OspfLsaType; lsid: Ipv4Address; advRouter: Ipv4Address; seq: number;
  ageAtInstall: number; installedAt: SimTime; checksum: number; length: number; options: number; self: boolean;
  flags?: { b: boolean; e: boolean; v: boolean }; links?: readonly OspfRouterLink[];      // type 1
  mask?: Ipv4Address; attached?: readonly Ipv4Address[];                                  // type 2 (mask also 5; [S4] 3/4)
  metric?: number; external?: { e2: boolean; forward: Ipv4Address; tag: number };        // 5 ([S4] metric on 3/4)
  maxAge?: true;                                                                            // being flushed
}
export const ospfLsaKey = (scope: string, type: number, lsid: string, adv: string): string => `${scope}|${type}|${lsid}|${adv}`;

/** @since P3 key = aclKey(family, list, seq). Writer: acl. Rows exist ONLY for lists applied as filters (D12). */
export interface AclRow extends TableRow {
  family: 4 /* [S11] | 6 */; list: string; type: 'standard' | 'extended' /* [S11] | 'ipv6' */;
  seq: number | null; implicit?: 'deny' /* [S11] | 'nd-na' | 'nd-ns' */;
  entry: string;                         // canonical aclEntryText, no sequence number
  action: 'permit' | 'deny'; matches: number;
  lastPdu?: PduId; lastAt?: SimTime; lastIface?: PortId /* [S13] | 'vty' */; lastDir?: 'in' | 'out';
  applied: string;                       // 'GigabitEthernet0/0 in' ([S13] adds ', vty in')
}
export const aclKey = (f: 4, list: string, seq: number | 'implicit'): string => `${f}|${list}|${seq}`;   // [S11] widens

/** @since P3 key = `${vlan}|${mac}`. Writer: eth-switch. expiresAt = lease end (none for static bindings). */
export interface DhcpSnoopingRow extends TableRow { mac: MacAddress; ip: Ipv4Address; vlan: number; port: PortId; kind: 'learned' | 'static'; leaseS?: number }
/** @since P3 key = vlanKey(vlan). Writer: eth-switch. One write per inspected ARP on an untrusted port. */
export interface ArpInspectionRow extends TableRow { vlan: number; forwarded: number; dropped: number; droppedNoBinding: number; droppedAcl: number }

/** @since P3 key = `${localPort}|${deviceId}`. Writer: cdp. expiresAt = last update + holdtime. */
export interface CdpNeighbourRow extends TableRow {
  localPort: PortId; deviceId: string; remotePort: string; platform: string; capabilities: string /* 'R S I' */;
  addresses: string; version: string; holdtimeS: number; cdpVersion: number;
  nativeVlan?: number; duplex?: 'full' | 'half';    // [S35] += voiceVlan?: number
}
/** @since P3 key = `${localPort}|${chassisId}|${portId}`. Writer: lldp. expiresAt = last update + TTL. */
export interface LldpNeighbourRow extends TableRow {
  localPort: PortId; chassisId: string; portId: string; ttlS: number; systemName?: string; portDescription?: string;
  systemDescription?: string; capabilities?: string; enabled?: string; mgmtAddress?: Ipv4Address;   // [S35] += medVlan?
}
/** @since P3 key = configured address. Writer: ntp. Rewritten on a poll result that changes a column. */
export interface NtpPeerRow extends TableRow {
  address: IpAddress; configured: boolean; refId: string; stratum: number; lastRxAt?: SimTime; pollS: number;
  reach: number /* u8 shift register */;
  delayNs?: number;                      // one round trip: always far below 2^53 ns
  offsetMs?: number; offsetSubMsNs?: number;
      // θ = offsetMs ms + offsetSubMsNs ns (floor toward −∞, 0 ≤ offsetSubMsNs < 1 000 000): a first sync of an unset
      // clock (2020-01-01) against true time (2025-01-06) is ≈ 1.6 × 10¹⁷ ns, beyond 2^53 ns (≈ 104 days)
  selected: 'sys-peer' | 'candidate' | 'reject' | 'unreached';
}
/** @since P3 key = 'clock', one row per device. Writer: ntp. Written only when source, stratum, reference or offset
 *  changes (a synchronisation, `ntp master`, `clock set`); absent while the clock was never set (source 'unset'). The
 *  gradeable device clock (rule 20); the runtime keeps the clock itself. */
export interface ClockRow extends TableRow {
  source: 'user' | 'ntp' | 'master'; stratum?: number; reference?: string;
  offsetMs: number; offsetSubMsNs: number;   // displayed clock − true time, split as in NtpPeerRow
  since: SimTime;
}
/** @since P3 key = String(seq). Writer: restconf. Bounded to 50 rows; the oldest is deleted with reason 'replaced'. */
export interface RestconfLogRow extends TableRow {
  seq: number; method: HttpMethod; path: string; status: number; client: IpAddress; user?: string; at: SimTime;
}
/** @since P3 key = `${src}|${flow}`, on the RECEIVING host. Writer: traffic. Rewritten at most once per received
 *  second, plus one final write by `flow-flush:<key>` 1 s after the last datagram the receiver saw. */
export interface FlowRow extends TableRow {
  flow: string; src: IpAddress; dst: IpAddress; dstPort: number;
  dscp: number;                 // DSCP of the last datagram received (so marking on the path is visible)
  received: number;
  lost: number;                 // (highest sequence seen + 1) − received; datagrams lost after the highest one received
                                // are counted only when the flow's final datagram (flags bit 0) arrives
  delayMinNs: number; delayMaxNs: number; delayAvgNs: number; jitterNs: number;   // RFC 3550 integer jitter
  firstAt: SimTime; lastAt: SimTime; ended: boolean;   // ended: the final datagram arrived
}
```

`TABLE_DESCRIPTORS` gains one entry per table with original titles ("OSPF interfaces", "OSPF neighbours",
"Link-state database", "Access list hits", "DHCP snooping bindings", "ARP inspection", "CDP neighbours", "LLDP
neighbours", "Time servers", "Device clock", "API requests", "Traffic flows"; for the approved items "Remote logins",
"Tunnels", "PPP links", "Syslog messages", "Script runs", "EIGRP neighbours", "EIGRP topology", "IPsec SAs"),
columns = the row fields a learner reads (ports with format `'port'`, times `'time'`, states `'state'`). They land in
W0 as compile stubs of the typed record
(`contracts/tables.ts:468`) with their final values; a descriptor does not make any model derive its table.

`PROCESS_TABLES` additions, each in the change that registers the daemon: `ospf: ['ospf-interfaces',
'ospf-neighbors', 'ospf-lsdb']`, `acl: ['acl']`, `cdp: ['cdp-neighbours']`, `lldp: ['lldp-neighbours']`, `ntp:
['ntp-peers', 'clock']`, `restconf: ['restconf-log']`, `traffic: ['flows']`; the approved [S13] `vty: ['vty-logins']`,
[S18] `gre: ['tunnels']`, [S19] `ppp: ['ppp']`, [S25] `'syslog-server': ['syslog-messages']`, [S32] `'script-host':
['script-runs']`, [C1] `eigrp: ['eigrp-neighbors', 'eigrp-topology']`, [C13] `ike: ['ipsec-sa']` (the W4 flip, and
the W6 flip for `script-host`).

**The snooping tables are stage-filtered, never plain `vlan` rows.** `deriveTables` (`define.ts:358-364`) has no
stage filter and snapshots export empty tables (`snapshot-cache.ts:316-335`), so appending to `PROCESS_TABLES.vlan`
would change every VLAN-aware device at once, the controller included (it runs `vlan`). The W4 flip adds instead
`STAGED_PROCESS_TABLES` to `contracts/tables.ts`:

```ts
/** @since P3 Tables a daemon brings only from a stage on, and only to models with a capability (P3 review T6). */
export const STAGED_PROCESS_TABLES: readonly { process: ProcessName; tables: readonly ExtraTableName[]; since: BuildStage;
  requires: Capability }[] = [{ process: 'vlan', tables: ['dhcp-snooping', 'arp-inspection'], since: 'P3', requires: 'managed-switch' }];
// [S16] adds 'storm-control' to that row.
```

and `deriveTables` applies a row only when the model's stage is at or after `since` and the model has `requires`. So
no P1/P2-stage model and never NF-WLC-9800 declares the two tables (`device.catalog.p2.test.ts:81, :151, :170` keep
their exact arrays at stage P2; the controller's list at `device.catalog.data.test.ts:213` gains only its cdp and ntp
tables at the flip, §9.2 W4). After the flip the real catalog is at
stage P3, so managed switches in every world, P1 and P2 worlds included, show two empty tables in their snapshots and
Tables tab; the per-device digest normalisation removes them (§4.6), and §9 W4 lists the moved pins.

**StateViews the shows read** (display only, rule 20; the W3 cli tests are written against these shapes):

```ts
// ospf StateView (kind 'ospf')
interface OspfStateView {
  process?: { pid: number; routerId: Ipv4Address; configuredRouterId?: Ipv4Address /* applied at clear or reload */;
              startedAt: SimTime; referenceBandwidthMbps: number; maximumPaths: number; defaultOriginate?: 'on' | 'always' };
  spf: { runs: number; lastAt?: SimTime; nextAt?: SimTime; holdUntil?: SimTime; lastReason?: string };
  interfaces: readonly { port: PortId; helloDueAt?: SimTime; waitUntil?: SimTime }[];          // "Hello due in"
  neighbors: readonly { port: PortId; routerId: Ipv4Address; deadAt: SimTime; retransmitQueue: number }[];   // "Dead in"
  trees: readonly { area: OspfAreaId; tree: SpfTree }[];      // D10: the final SPF tree per area ([S3] parity)
}
// ntp StateView (kind 'ntp')
interface NtpStateView {
  peers: readonly { address: IpAddress; nextPollAt?: SimTime; retriesLeft: number; lastSentAt?: SimTime; lastReject?: string }[];
  master?: { stratum: number };
  served: number;                                             // requests answered
}
// tcp and udp StateViews += probes?: readonly { session: string; dst: IpAddress; port: number;
//   outcome: 'pending' | 'open' | 'refused' | 'unreachable' | 'timeout' | 'sent'; icmp?: { type: number; code: number };
//   at: SimTime }[]     (OBM: present only after a probe, which runs only in grader clones; at most 16, newest last)
```

Row shapes of the approved SHOULD items, carried from the area maps: [S18] `TunnelRow {port, mode 'gre' | 'ipsec'
[C13], source?, sourceIface?, destination?, state, reason?, transportMtu, ipMtu, since}` (reasons `no-source`,
`no-destination`, `no-route`, `recursive-routing`, and [C13] `ike-negotiating`, `ike-failed`, `ike-no-proposal`,
`ike-no-response`; `ipMtu` 1476 in GRE mode, 1456 in ipsec mode); [S19] `PppRow {port, phase, lcp, authLocal,
authLocalState?, authPeer, authPeerState?, peerName?, ipcp, peerAddress?, ipv6cp?, magic, peerMagic?, failures,
lastFailure?, since}`; [S25] `SyslogMessageRow {seq, from, facility, severity, hostname?, stamp, message,
receivedStamp}`. Two approved items needed a gradeable row the maps did not define (rule 20), written here:

```ts
/** @since P3 [S13] key = String(seq). Writer: vty. Bounded to 50 rows (the restconf-log rule). One row per login
 *  attempt that reached vty; a transport refusal is a TCP RST and writes none. */
export interface VtyLoginRow extends TableRow {
  seq: number; proto: 'telnet' | 'ssh'; peer: IpAddress; user?: string;
  result: 'success' | 'failed' | 'refused';   // failed: wrong credentials; refused: access-class
  reason?: string;                            // 'access-class 10', 'bad password', …
  at: SimTime;
}
/** @since P3 [S32] key = run id ('r1', 'r2', …). Writer: script-host. Bounded to 20 rows. Written when a run starts
 *  and when it ends — never per output line or per request (rule 20). */
export interface ScriptRunRow extends TableRow {
  run: string; file: string; state: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: SimTime; endedAt?: SimTime; requests: number;   // HTTP requests the run made (final count at the end)
  error?: string;                                            // the traceback's last line on 'failed'
}
```

The [C1] and [C13] rows are in §2.16 and §2.17. Not approved, so never added in P3a: [S16] `StormControlRow` (ACL
map), [S33] `snmp-traps`.

### 2.7 `contracts/link.ts`, `contracts/events.ts`, `contracts/trace.ts`, `contracts/medium.ts`

```ts
// link.ts
// DropReason: append 'dhcp-snooping' | 'arp-inspection'   ('acl-deny' exists, link.ts:296, and is first emitted in P3)
//   then the approved: [S18] 'mtu-exceeded' (D15; [S17] would reuse it)  [S20] 'policed'  [C13] 'ipsec-no-sa'
//   (not approved, never added in P3a: [S15] 'ip-source-guard', [S16] 'storm-control', [S34] 'span-destination')
// [S19] LinkDownCode += 'ppp-negotiating' | 'ppp-auth-failed'
// [S20] TransmitFn = (from, pdu, now, opts?: TransmitOptions); TransmitOptions { qosClass?: number } (OBM)
//       EgressClassSpec, EgressSchedulerSpec, EgressQueueView (WAN map §3, unchanged); LinkModelDeps.egressPolicy?(ref),
//       LinkModel.egressQueues?(ref) (OBM)

// events.ts
// SimEventBody += { kind: 'deviceConfigure'; device: DeviceId; from: ProcessName; token: string; lines: readonly string[];
//                   opts: { atomic?: boolean; indentation?: boolean; origin: ConfigOrigin } }   non-periodic, like userCommand
//   [S13] | { kind: 'remoteCli'; device: DeviceId; from: ProcessName; act: RemoteCliAction | CliRemoteAction }
//           non-periodic, zero delay; the Simulation applies it to its CliRuntime (D14) and delivers the output of a
//           via-'vty' session to the device's vty daemon as ProcessEvent vty.output
// FaultKind: unchanged (lab config faults use the existing `config-fragment` path, §2.10 LabFault.config)

// trace.ts (every member below is OBM: absent keeps P1/P2 bytes)
// drop event += rule?: DropRule
// log event += mnemonic?: string        set only by P3 code paths (never by a P1/P2 log site)
// configChange event += origin?: ConfigOrigin
// [S20] TraceEvent += { t; kind: 'frameQueued'; pdu: PduSummary; device; port; queue: string; depth: number }
// PduSummary.tunnel: 'capwap' ([S18] | 'gre')  ([C13] | 'ipsec')
// [S10] TraceFilter += reasons?: readonly DropReason[]

// medium.ts [S19]
// MediumOp += { op: 'ppp-link'; up: boolean; reason?: 'ppp-negotiating' | 'ppp-auth-failed' | 'keepalive-missed' }
// MediumEvent += { kind: 'serial-line'; ready: boolean }   sent only when the value changes AND either end is ppp
```

### 2.8 `contracts/snapshot.ts`

```ts
// SimSnapshot.profile?: 'P2' | 'P3'    (OBM; absent = 'P1')
// DeviceSnapshot += clock?: { source: ClockSource; baseUnixMs: number; baseAt: SimTime; stratum?: number;
//                             reference?: string; tzOffsetMin: number }
//   (OBM) present only in a P3 world, or when the source is 'user', 'ntp' or 'master' (set by a typed line or a
//   sync), so no P1/P2 snapshot gains it; changes only on set/sync, so it never dirties a device per tick — the web
//   extrapolates from `now`.
// PortSnapshot += qos?: { input?: string; output?: string; classes: readonly { name: string; matched: number;
//                         matchedBytes: number; marked: number }[] }
//   (OBM) present only on a port with a service policy (M13 marking counters, runtime-owned through
//   DeviceRuntime.qosCounters, display only); [S20] widens it to the EgressQueueView of the WAN map.
// PortSnapshot += txBacklog?: { depth: number; frames: readonly { pdu: PduId; summary: PduSummary; txStart: SimTime;
//                               bytes: number }[] }        (the type is PortTxQueueView)
//   (named `txBacklog` by the W0 ruling R6: the required P0 frame count `txQueue: number` is unchanged)
//   (OBM) the frames the link model has committed on this egress port with txStart > now (the virtual FIFO, D16):
//   the depth and up to 8 of them, oldest first. Written in every profile, only while depth ≥ 1 (absent otherwise);
//   the snapshot cache fills it from the in-flight store (`link/inflight.ts` `queued(ref, now)`) and marks the
//   device dirty at an enqueue that leaves a backlog and at each txComplete of a port that has one, so an
//   uncongested world never gains it. The digest normalisation removes it (§4.6), so no golden sees it. The qos
//   overlay's only queue source (D24).
// [S32] DeviceSnapshot.storage?: readonly DeviceStorageView[]   (OBM; present only on a host with user files in
//   `files:`, the automation workspace's file list; [S29] would add flash: and nvram:)
```

### 2.9 `contracts/device.ts`, `contracts/topology.ts`, `contracts/simulation.ts`, `contracts/curriculum.ts`, new `contracts/clock.ts`

```ts
// device.ts
// DeviceRuntime +=
//   clockView(now: SimTime): DeviceClockView;  setClock(op: ClockAction, now: SimTime): void
//   qosCounters(port: PortId): PortSnapshot['qos']     (undefined without a policy; the snapshot cache and the shows)
//   applyConfigLine(context, line, negate, origin?: ConfigOrigin)   (OBM 4th parameter, copied into configChange, D21)
//   [S24] emitLog(severity, facility, message, now, mnemonic?): void    (the one log path, D20)
//   [S20] egressPolicy(port: PortId): EgressSchedulerSpec | undefined   (compiled from the port's output policy;
//         read by the link model through LinkModelDeps.egressPolicy; [S21] adds fair-queue, police and shape to it)
// DeviceRuntimeDeps: unchanged. The runtime schedules deviceConfigure (and [S13] remoteCli) through its existing
//   `scheduler`; the Simulation's dispatch of that event is the one caller of cliCore.configure (D21) and of the
//   CliRuntime remote-session methods (D14).
// CommandCtx += clock(): DeviceClockView   (W0; `show clock`, `show ntp status`, the timestamps [S24] render)
//              qosCounters?(port: PortId): PortSnapshot['qos']   (display) ; [S20] egressQueues?(port)

// topology.ts
export const TOPOLOGY_SCHEMA_ID_1_3 = 'netforge.topology/1.3';
// TOPOLOGY_SCHEMA_IDS = [1.0, 1.1, 1.2, 1.3]; LATEST_TOPOLOGY_SCHEMA_ID = 1.3; migrate 1.2 → 1.3 is identity + id.
// Topology.profile?: 'P2' | 'P3'   (OBM). 'P3' belongs ONLY to the 1.3 field set; the 1.2 field set keeps
//   z.literal('P2') (io/schema.ts:266), so a 1.2 document carrying 'P3' is refused with the schema's value message.
// [S32] TopologyDevice.files?: readonly TopologyFile[]   (the hosts' `files:` store, D21; [S29] would add flash: files)
// [S31] TopologyDevice.nvram?: { configRegister?: number }   (not approved: never added in P3a)
/** schemaIdFor(t): 1.3 iff t.profile === 'P3' or a 1.3-only key is present ([S32] files); 1.2 iff
 *  t.profile === 'P2'; else 1.1. A P1 or P2 document therefore still exports byte-identically. */
export function schemaIdFor(t: Topology): TopologySchemaId;

// simulation.ts
// SimulationOptions.profile?: DefaultsProfile   (accepts 'P3'; the RangeError text at simulation.ts:311-312 lists three)
// HostAppRequest += { app: 'traffic.start'; flow: TrafficFlowSpec } | { app: 'traffic.stop'; id: string }
//   (the grader's tcp/udp probes are NOT host apps: the clone applies tcp.probe / udp.probe process requests directly,
//   as it applies icmp.ping, §2.4)
//   [S27] | { app: 'http.request'; method: HttpMethod; url: string; headers?; body? }
//   [S32] | { app: 'script.run'; file: string; argv? } | { app: 'script.stop'; run: string }
//         | { app: 'file.write' | 'file.delete'; path: string; content? }
//   [S33] | { app: 'snmp'; … }
// HOST_APP_PROCESS (sim/simulation.ts:221-229) gains the matching rows (traffic; S items theirs).
// [S34] CaptureSpec += span?: { device: DeviceId; session: number }

// journal.ts: [S31] JournalOp += { op: 'cliBreak'; session: SessionId }   (no other new op, D6)

// curriculum.ts
// Course += profile?: DefaultsProfile   @since P3. Set as data in W0 (ccna1 'P1', ccna2 'P2', ccna3 'P3' while still
//   planned); read by profileForCourse only from the W7 course flip; required at W8 (planned cards 'P3').
```

New pure file `contracts/clock.ts` (D19):

```ts
export const NF_WORLD_EPOCH_UNIX_MS = 1_736_150_400_000;   // Mon 2025-01-06 08:00:00 UTC = SimTime 0
export const NF_CLOCK_UNSET_UNIX_MS = 1_577_836_800_000;   // Wed 2020-01-01 00:00:00 UTC + uptime
export const NTP_UNIX_OFFSET_S = 2_208_988_800;
export type ClockSource = 'unset' | 'user' | 'ntp' | 'master' | 'host';
export interface DeviceClockView {
  readonly source: ClockSource; readonly authoritative: boolean;   // false → rendered with a leading '*'
  readonly unixMs: number; readonly subMsNs: number;
  readonly stratum?: number; readonly reference?: string;
  readonly tz: { readonly name: string; readonly offsetMin: number };
}
export type ClockStyle = 'show-clock' | 'timestamp-msec' | 'timestamp' | 'legacy-debug';
export function formatClock(view: DeviceClockView, style: ClockStyle): string;
/** 64-bit NTP timestamp ↔ clock value; BigInt inside, decimal strings outside (never in JSON as bigint). */
export function ntpTimestamp(view: DeviceClockView): string;
export function fromNtpTimestamp(text: string): { unixMs: number; subMsNs: number };
```

[S32] adds the hosts' slice of the management map's `contracts/storage.ts` (D21): `FileSystemId = 'files'`,
`StoredFile`, `StoredFileMeta`, `StoredFileInput`, `DeviceStorageView` and `TopologyFile`, as the map defines them.
[S29] (not approved) would widen `FileSystemId` with `'flash' | 'nvram'` and add `IMAGE_TRANSFER_SCALE = 1024` and
`DEFAULT_CONFIG_REGISTER = 0x2102`.

### 2.10 `contracts/scenario.ts` (grader)

```ts
// ScenarioCategory: … | 'ccna3-lab'
/** @since P3 One list of concept tools (D24): replaces the unions at scenario.ts:49, store/types.ts:62, markdown.ts:23. */
export type ConceptToolId = 'subnetting' | 'ipv6' | 'queueing' | 'data-formats' | 'wildcard' /* [S9], approved */
  /* not approved, never added in P3a: [S22] | 'wan'  [S28] | 'yang'  [C26] | 'sdn' */;
// ScenarioInfo.concept?: ConceptToolId
// ScenarioInfo.customChecks: @deprecated in W0 (no lab or task uses it); removed at W8 (D6)

/** @since P3 (OBM) on every assertion (spec §12.4): shown when the assertion fails. */
export interface LabAssertionNotes { feedback?: string; misconception?: string }
// LabAssertion = ( …P1 and P2 kinds… | …P3 kinds below… ) & LabAssertionNotes

export type NeighborProtocol = 'ospf' | 'cdp' | 'lldp' | 'ppp' /* [S19] */ | 'eigrp' /* [C1] */   /* [S6] | 'ospfv3' */;
// 'ppp' reads the `ppp` rows (state word: the LCP state, 'opened'); 'eigrp' the `eigrp-neighbors` rows ('up').
/** Facts are data: each name has a declared type, a reader (FACT_READERS, sim/lab-checks/facts.ts and the area
 *  adapters) and a declared source, a table or the configuration (rule 20; the source is in the comment). */
export type LabFactName =
  | 'ospf.routerId'                                   // ospf-interfaces.routerId (the id in use, not the configured one)
  | 'ospf.referenceBandwidthMbps' | 'ospf.defaultOriginate'                           // configuration; subject: none
  | 'ospf.ifaceArea' | 'ospf.ifaceCost' | 'ospf.ifaceNetworkType' | 'ospf.ifaceState'
  | 'ospf.ifacePriority' | 'ospf.passive'                                             // ospf-interfaces; subject: interface name
  | 'ospf.lsdbSynced'                                 // ospf-lsdb; subject: area; every router of the area holds the same LSA headers
  | 'snooping.enabled' | 'dai.enabled'                                                // configuration; subject: VLAN
  | 'dai.dropped'                                                                     // arp-inspection; subject: VLAN
  | 'snooping.trusted' | 'dai.trusted'                                                // configuration; subject: port
  | 'snooping.bindingPort'                                                            // dhcp-snooping; subject: host device name → the bound port
  | 'ssh.enabled' | 'ssh.version' | 'ssh.keyBits' | 'vty.transport' | 'vty.loginLocal' | 'vty.accessClass'   // configuration
  | 'qos.inputPolicy' | 'qos.outputPolicy'                                            // configuration; subject: interface name
  | 'cdp.enabled' | 'lldp.enabled'                                                    // configuration + profile; subject: optional interface name
  | 'ntp.synced' | 'ntp.peer'                                                         // ntp-peers (the sys-peer row)
  | 'ntp.stratum' | 'clock.source' | 'clock.offsetMs'                                 // the ntp daemon's `clock` row (absent → 'unset')
  // the approved items' facts, each with its source:
  | 'vty.logins'                                      // [S13] vty-logins: successful logins (count); subject: optional 'telnet' | 'ssh'
  | 'tunnel.up'                                       // [S18] tunnels.state; subject: tunnel interface
  | 'ppp.lcp' | 'ppp.ipcp' | 'ppp.auth'                                               // [S19] ppp rows; subject: serial interface
  | 'qos.admitted'                                    // [S20] configuration (the output policy passed admission); subject: interface
  | 'logging.buffered' | 'logging.trap'                                               // [S24]/[S25] configuration
  | 'automation.lastRun'                              // [S32] script-runs: the state of the newest run; subject: optional file name
  | 'eigrp.fd' | 'eigrp.successor' | 'eigrp.feasibleSuccessor'                       // [C1] eigrp-topology; subject: prefix
  | 'eigrp.kValues'                                   // [C1] configuration ('1 0 1 0 0')
  | 'ipsec.sa'                                        // [C13] ipsec-sa.state; subject: tunnel interface
  // not approved, never added in P3a: [S4] 'ospf.abr' | 'ospf.asbr'
  ;
// A fact of declared type 'address' compares against a device NAME through IDENTITY_SOURCES (hostname, any interface
// address, base MAC, protocol router ids — OSPF's and [C1] EIGRP's). 'eigrp.successor' and 'eigrp.feasibleSuccessor'
// are of type 'address' (the next hop of the first successor / feasible successor in path order; absent when none).

export interface LabPacketProbe { proto: 'ip' | 'icmp' | 'tcp' | 'udp'; src: string; dst: string; srcPort?: number; dstPort?: number; established?: boolean }

// LabAssertion += (all @since P3; devices, ports and hosts by NAME)
  | { kind: 'neighbor'; device: string; protocol: NeighborProtocol; neighbor?: string /* device NAME */; iface?: string;
      state?: string /* the protocol's own state word: 'full', '2way' … */; role?: 'dr' | 'bdr' | 'drother';
      exists?: boolean; count?: number; minCount?: number }
  | { kind: 'fact'; device: string; fact: LabFactName; subject?: string; equals?: string | number | boolean;
      atLeast?: number; atMost?: number }
  | { kind: 'acl'; device: string; list: string; type?: 'standard' | 'extended'; exists?: boolean;
      entries?: readonly string[] /* canonical aclEntryText, no sequence */; match?: 'exactly' | 'includes';
      applied?: readonly { iface?: string; vty?: true; dir: 'in' | 'out' }[];   // bindings read from the configuration
      entry?: number | 'implicit'; minMatches?: number }
      // [S11] += family?: 4 | 6; type 'ipv6'
  | { kind: 'aclDecision'; device: string; list: string; packet: LabPacketProbe;
      expect: 'permit' | 'deny'; entry?: number | 'implicit' }                  // [S11] += family?: 4 | 6
      // pure: evaluates the CONFIGURED list with core/acl's evaluateAcl; no traffic, no clone
  // the approved items' kinds (W5 sim, clone checks):
  | { kind: 'service'; from: string; to: string; service: 'telnet' | 'ssh'; user?: string; password?: string;   // [S13]
      expect: 'success' | 'fail' | 'refused'; timeoutMs?: number; after?: readonly LabFault[] }
      // the clone opens a remote session from `from` (a vty-client) to `to` and reads the outcome from its vty-logins
      // row (success, failed) or the client's TCP refusal (refused: a RST, transport or access-class)
  | { kind: 'path'; from: string; to: string; toIface?: string; toAddress?: string; family?: 4 | 6;                // [S18]
      via?: readonly string[]; notVia?: readonly string[]; after?: readonly LabFault[]; settleMs?: number;
      tunnelAt?: { device: string; tunnel: 'gre' | 'ipsec' } }                                                    // [C13]
      // tunnelAt: every frame of the probe that `device` receives carries PduSummary.tunnel === tunnel (read from the
      // clone trace's legs), so "only ESP crosses the provider" is gradeable without [S38]'s capture tap
  | { kind: 'traffic'; flows: readonly (TrafficFlowSpec & { from: string; to: string })[]; runMs: number;         // [S20]
      expect: readonly { receiver: string; flow: string; maxLossPct?: number; maxDelayMs?: number; maxJitterMs?: number }[] }
  // not approved, never added in P3a (designs for P3c): [S8] 'convergence' (written in full by the architect if S8 is
  //   approved: P2's S15 block was never built, ARCHITECTURE-P2 §14); [S29] 'file'; [S38] 'packetSeen'

// Widened, every member OBM (absent = P2 behaviour and bytes):
// connectivity += proto?: 'icmp' | 'tcp' | 'udp'; port?: number; toIface?: string; toAddress?: string;
//                 source?: string /* interface or address on `from` */;
//                 droppedAt?: string /* device NAME that must drop it, with expect 'fail' */; dropReason?: DropReason
//   tcp/udp use the tcp.probe / udp.probe process requests (§2.4), applied in the clone exactly as icmp.ping is
//   (sim/lab-checks.ts:847-891); they never need an application on the target.
//   TCP passes on SYN-ACK ('open', from the tcp StateView `probes`) and fails on RST, an ICMP unreachable or 3 s
//   without an answer. UDP passes when the clone's trace shows the probe datagram consumed by a socket on the target
//   (it reached a listener) and fails on an ICMP unreachable, a drop, or 3 s without either. droppedAt and dropReason
//   are read from the clone trace's `drop` event of the probe's PduId.
// route += metric?: number; routeType?: 'E2' /* [S4] | 'IA'  [C6] | 'E1'  [C4] | 'N1' | 'N2' */; minPaths?: number
// table += minCount?: number; maxCount?: number;
//          whereOps?: Readonly<Record<string, { op: 'lt' | 'le' | 'gt' | 'ge' | 'ne' | 'contains'; value: string | number }>>
// LabFault += { config: { device: string; lines: readonly string[] } }   (applied through configure in the clone)
// LabFault cut += aPort?: string; bPort?: string   (cut only the cable on that port; absent = every cable, P2)
```

**How each area's needs map onto these kinds** (D5):

| Need | Assertion |
|---|---|
| OSPF adjacency, DR/BDR | `neighbor {protocol: 'ospf', state: 'full', role}` |
| OSPF interface, process | `fact ospf.*`; `table ospf-interfaces` with `whereOps` |
| One map per area | `fact ospf.lsdbSynced {subject: '0.0.0.0', equals: true}` (computed with `core/ospf-spf.ts`) |
| Installed routes, ECMP, failover | `route {source: 'O', routeType, metric, minPaths}`; `connectivity.after` with `cut {aPort}` |
| ACL content, binding, hits | `acl {entries, applied, entry, minMatches}` |
| ACL semantics | `aclDecision`; `connectivity {proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'R1', dropReason: 'acl-deny'}` |
| SSH-only access | `config` lines plus `fact ssh.*` / `vty.*` ([S13] adds `service`) |
| Snooping, DAI | `fact snooping.*` / `dai.*`; `table dhcp-snooping`; `connectivity` through an inspected port |
| QoS marking | `config` lines, `fact qos.inputPolicy`, `table flows {where: {src: '192.168.1.10', flow: 'f1', dscp: 46}}` on the receiver (both senders default to `f1`, so the source is part of the key; `dscp 46` exactly, since `ge 46` would pass CS6 = 48) |
| CDP, LLDP | `neighbor {protocol: 'cdp' \| 'lldp', neighbor, iface}`; `fact cdp.enabled {subject: port, equals: false}` for edge hardening |
| NTP | `fact ntp.synced`, `ntp.stratum`, `ntp.peer` (a device name), `clock.source` |
| REST change | `config`/`vlan` (the effect) plus `table restconf-log {whereOps: {path: {op: 'contains', value: 'vlan-list=30'}}, where: {method: 'PUT'}}` |
| Reading JSON (lab 38; lesson 37 has no lab) | `table restconf-log {where: {method: 'GET'}, whereOps: {path: {op: 'contains', value: 'ietf-interfaces'}}}` plus the effect of the value read (`vlan`, `config`) |
| A router-id fault (troubleshooting) | the live `fact ospf.routerId`; never a clone check alone, because the clone boots from the export and applies a configured router id the live router has not applied yet (no `clear ip ospf process`) |
| [S13] Real logins, vty ACL | live: `table vty-logins {where: {proto: 'ssh', result: 'success'}}` (the learner's own login) and `{result: 'refused'}` from the denied PC; `acl {list, applied: [{vty: true, dir: 'in'}], entry: 'implicit', minMatches: 1}`; clone: `service {from, to, service: 'ssh', expect: 'success'}` and `{service: 'telnet', expect: 'refused'}` |
| [S18] GRE | `fact tunnel.up {subject: 'Tunnel0', equals: true}`; `connectivity` site to site; `path {via: ['R1', 'R2']}` through the tunnel |
| [S19] PPP and CHAP | `neighbor {protocol: 'ppp', state: 'opened'}`; `fact ppp.auth {subject: 'Se0/0/0', equals: 'chap'}`; `fact ppp.ipcp {equals: 'opened'}` |
| [S20]/[S21] LLQ and policing | `config` lines and `fact qos.outputPolicy`/`qos.admitted`; `traffic {flows: [voice, bulk], expect: [{flow: 'f1', maxLossPct: 0, maxDelayMs: 100}]}` (clone) |
| [S24]/[S25] Logging and syslog | `fact logging.trap`, `logging.buffered`; `table syslog-messages {device: 'SRV1', whereOps: {message: {op: 'contains', value: '%LINK-3-UPDOWN'}}}` |
| [S32] A script run | `fact automation.lastRun {device: 'DEV1', subject: 'inventory.py', equals: 'completed'}` plus the effect it had (`table restconf-log`, `vlan`); live, never re-run |
| [C1] EIGRP | `neighbor {protocol: 'eigrp', state: 'up'}`; `route {source: 'EIGRP', nextHop, metric}`; `fact eigrp.feasibleSuccessor {subject: '10.4.0.0/24', equals: 'R3'}`, `eigrp.fd`; failover by `connectivity.after` with `cut {aPort}` |
| [C13] Site-to-site IPsec | `fact ipsec.sa {subject: 'Tunnel0', equals: 'established'}`, `fact tunnel.up`; `connectivity` site to site; "only ESP crosses the provider": `path {from: 'PC1', to: 'PC2', tunnelAt: {device: 'ISP', tunnel: 'ipsec'}}` |

**Grader limits fixed in P3** (P2 §9.2 item 22d): `cut` can name one cable; `connectivity` can target an interface or
an address (a loopback), not only the first address; TCP and UDP reachability can be graded; a lab can apply a
configuration fault in the clone.

### 2.11 `contracts/cli.ts` and `contracts/config.ts`

- `MODES['config-router']` loses `reserved` (the W2 cli item that enters it, §9 W2) and is refined to entries whose
  second token is `ospf`. New modes: `'config-ext-nacl'` (prompt `(config-ext-nacl)#`, contextKey `'ip access-list
  extended'`), `'config-cmap'` (`(config-cmap)#`, `'class-map'`), `'config-pmap'` (`(config-pmap)#`, `'policy-map'`),
  `'config-pmap-c'` (`(config-pmap-c)#`, `'class'` under `policy-map`). The approved COULD items add [C1]
  `'config-router-eigrp'` (prompt `(config-router)#`, contextKey `'router eigrp'`: the refinement of `config-router`
  entries whose second token is `eigrp`) and [C13] `'config-ikev2-keyring'` (`(config-ikev2-keyring)#`, `'crypto ikev2
  keyring'`), `'config-ikev2-keyring-peer'` (`(config-ikev2-keyring-peer)#`, `'peer'` under a keyring),
  `'config-ikev2-profile'` (`(config-ikev2-profile)#`, `'crypto ikev2 profile'`) and `'config-ipsec-profile'`
  (`(ipsec-profile)#`, `'crypto ipsec profile'`). Not approved, never added in P3a: [S6] `'config-rtr'`, [S11]
  `'config-ipv6-acl'`, [S14] `'config-arp-nacl'`, [S31] `'rommon'`, [C10] `'config-tr'`.
- `ConfigNode += seq?: number` (OBM, never rendered); `ConfigLineRule += sequenced?: { list: 'section' | { token: number } }`
  (OBM); `ConfigAst.apply(…, opts)` opts `+= seq?: number`.
- `ConfigureOptions += origin?: ConfigOrigin` (OBM).
- [S24] `CliRuntime += onLogEvent(ev)`; [S25] `CliSessionView += monitor?: boolean` (OBM); [S13] `CliRuntime +=
  openRemote / execRemote / closeRemote / setRemote` (called only by the Simulation's `remoteCli` event dispatch, D14),
  `CliSessionView += remote?: string` (OBM: "R1 via SSH", the terminal's chip), `FacadeCounters += remote?` (OBM). Not
  approved, never added in P3a: [S31] `CliRuntime += sendBreak(session)`; [S29] `ArgType += 'url'`.
- `CLI_MESSAGES` additions (original wording):

```ts
ospfOneProcess: '% This device runs one OSPF process; process {pid} is already configured. Remove it with "no router ospf {pid}" first.',
ospfRouterIdLater: '% The new router ID is used after "clear ip ospf process" or a reload.',
ospfNeedsIpRouting: '% OSPF needs IP routing. Enter "ip routing" first.',
ospfNetworkOtherArea: '% {net} {wildcard} is already in area {area}. Remove that line first.',
ospfNoRouterId: 'OSPF process {pid} cannot start: it has no router ID and no interface address to borrow one from.',  // a log
clearOspfConfirm: 'Restart every OSPF process and drop its neighbours? [no]: ',
aclNumberRange: '% Standard lists use 1-99 or 1300-1999; extended lists use 100-199 or 2000-2699.',
aclUndefinedApplied: '% Note: access list {list} does not exist yet, so this interface lets every packet through.',
accessGroupSwitchport: '% Access lists filter routed interfaces; {port} is a switched port.',
sshNeedsHostname: '% Give the device a name other than the default before creating a key.',
sshNeedsDomain: '% Set a domain name (ip domain-name) before creating a key.',
sshVersionNeedsKey: '% SSH version 2 needs an RSA key of at least 768 bits.',
qosClassMissing: '% There is no class-map named {name}.',
qosPortUnsupported: '% Service policies attach to routed interfaces and subinterfaces; {port} is not one of them.',
// [S20]/[S21] (the M13 qosSetOnly message is not added: S20 is approved, so it would be dead vocabulary)
qosQueueingOutputOnly: '% Queueing happens as packets leave. Attach this policy with "service-policy output".',
qosQueueingPhysicalOnly: '% Queueing needs a physical interface; on {port} a policy can only mark and police.',
qosAdmission: '% The priority and bandwidth classes ask for {asked} kb/s, more than 75% of the {bw} kb/s on {port}.',
// [C1]
eigrpOneProcess: '% This device runs one EIGRP process; autonomous system {as} is already configured. Remove it with "no router eigrp {as}" first.',
eigrpNeedsIpRouting: '% EIGRP needs IP routing. Enter "ip routing" first.',
eigrpAutoSummary: '% Automatic summarisation is not simulated: every subnet is advertised as it is.',
// [C13]
ipsecProfileMissing: '% There is no IPsec profile named {name}.',
ipsecProtectionVtiOnly: '% Tunnel protection applies to IPsec tunnels here ("tunnel mode ipsec ipv4"); GRE over IPsec is not simulated.',
restconfNeedsSecureServer: '% The API listens only when "ip http secure-server" is also configured.',
trafficFlowCap: '% A flow lasts at most {minutes} minutes; give a smaller count or duration.',
trafficTooManyFlows: '% This device already sends {max} flows. Stop one first (flow stop <id>).',
```

### 2.12 `contracts/timeline.ts`

```ts
// LaneId: append 'mgmt' after 'drops' (cdp-neighbours, lldp-neighbours, ntp-peers, clock rows; the 'ntp' machine), so
//   LANE_IDS keeps every existing index and 'mgmt' is lane 12; then 'wan' (lane 13) for the approved [S18], [S19] and
//   [C13] (tunnels, ppp and ipsec-sa rows; the tunnel, ppp-lcp, ppp-auth, ppp-ncp and ike machines)
// FSM_MACHINE_LANES / TABLE_LANES (timeline/lanes.ts, code): ospf-if, ospf-nbr and the ospf-* tables → 'routing';
//   acl, arp-inspection → 'security'; dhcp-snooping → 'dhcp'; restconf-log → 'config'; flows → none; and for the
//   approved items: [C1] eigrp-nbr, eigrp-route, eigrp-neighbors, eigrp-topology → 'routing'; [S13] vty-logins →
//   'security'; [S25] syslog-messages → 'mgmt'; [S32] script-runs → none; the 'wan' entries above. These are the final
//   values; the architect writes them in W0 (a reviewed edit of the sim-owned file, §7), since the typed records of
//   timeline.lanes.test.ts:86 and :111 would not compile with stubs that differ from them.
// [S8] (not approved) ConvergenceProtocol would be new: P2's S15 was never built (ARCHITECTURE-P2 §14).
```

### 2.13 SHOULD and COULD blocks carried from the area maps

The following blocks are specified in the area maps (and, where a decision of this brief changed them, in §1 and
§2.1–§2.12) and are carried **verbatim** by the item that builds them; the architect copies the approved ones into the
contract files in W0 (rule 3). They are listed here so that no item invents a variant.

**Approved (§8.5), added in W0:**

| Item | Contract block (source) |
|---|---|
| [S2]/[S3] LSDB browser, SPF stepper | web only: `DockTab 'routing'`, `DockStage 'P3'` and its `ALL_TABS` row, `UiState.routingUi`, `OverlayId 'spf'` (§2.14; routing map §3.8) |
| [S13] remote terminal | `vty.connect/input/interrupt`, `remoteCli`, `cliRemote`, the `remoteCli` SimEvent, `vty.output`, `acl.check`/`acl.verdict`, `tcp.listen.service`, `protectedBy 'ssh'`, `AclRow.lastIface 'vty'`, CliRuntime remote sessions, `CliSessionView.remote`, `VtyLoginRow`, the `service` kind, `'vty.logins'` (ACL map §3; D14 for the event, the table and the switch rule) |
| [S18] GRE | `tunnel` role and `TUNNEL_FAMILY`, `ROLE_EGRESS_OWNER.tunnel = 'gre'`, `virtualChanged`, `TunnelRow`, `gre` codec, `PduSummary.tunnel 'gre'`, `DropReason 'mtu-exceeded'`, `icmp.error.param` (moved from [S17], D15), the `path` kind, `'tunnel.up'` (WAN map §3; cross-cutting §3.2) |
| [S19] PPP | codecs (`ipv6cp` included), `ppp.proto` space, `MediumOp ppp-link`, `MediumEvent serial-line`, `LinkDownCode`, `DemuxLayer 'ppp'`, `PppRow`, `CaptureLinkType 'ppp_hdlc'` (pcap link type 50), `NeighborProtocol 'ppp'`, the `ppp.*` facts (WAN map §3) |
| [S20]/[S21] QoS scheduler | `TransmitOptions`, `EgressClassSpec`, `EgressSchedulerSpec`, `EgressQueueView`, `frameQueued`, `DropReason 'policed'`, `DeviceRuntime.egressPolicy`, the `traffic` kind, the three [S20] messages of §2.11 (WAN map §3; D16) |
| [S24]/[S25] logging | `emitLog`, `log.record`, `onLogEvent`, `CliSessionView.monitor`, `SyslogMessageRow`, the `logging.*` facts (management map §3) |
| [S32] NF-Py | `script.run/stop`, `file.write/delete`, the `programmable` capability, NF-DEVHOST (`pc.nfdevhost`), `ScriptRunRow`, `'automation.lastRun'`, and the hosts' slice of the storage contract (`FileSystemId = 'files'`, `StoredFile`, `StoredFileMeta`, `StoredFileInput`, `DeviceStorageView`, `TopologyFile`, the `storage` action, `ProcessCtx.files/readFile`, `TopologyDevice.files`, `DeviceSnapshot.storage`; D21) (management map §3) |
| [S37] P3b seams | `contracts/lab-document.ts` below |
| [C1] EIGRP | §2.16, written in full here |
| [C13] Site-to-site IPsec | §2.17, written in full here |

[S1] and [S9] add no engine contract beyond `OverlayId 'ospf'`, the `topoOverlays` keys (§2.14) and `ConceptToolId
'wildcard'` (§2.10).

**Not approved — designs for the stage §12.1 names, never added in P3a:**

| Item | Contract block (area map section) |
|---|---|
| [S8] convergence | the `convergence` kind and `ConvergenceProtocol`, to be written in full by the architect if approved (not a reuse: P2's S15 block was never built) |
| [S11] IPv6 ACLs | `family 6` on `acl.filter`, `acl.clear`, `DropRule`, `AclRow`, `aclKey` and the `acl`/`aclDecision` kinds; `type 'ipv6'`; the `'nd-na'`/`'nd-ns'` implicit rows; `ipv6.resume` (ACL map §3) |
| [S17] fragmentation | `Pdu.fragmentAt`, `PduFactory.fragment`, `FragmentReassemble`, ipv4 codec rule (ACL map §3); it would reuse [S18]'s `icmp.error.param` and `mtu-exceeded` |
| [S29] files | the rest of `contracts/storage.ts` (`flash:`, `nvram:`, the image constants), `tftp.transfer`, `ArgType 'url'`, `DeviceModel.storage` (management map §3) |
| [S33] SNMP | `snmp.op`, `snmp.result`, `snmp` codec, `snmp-traps` (management map §3) |
| [S4], [S5], [S27], [S35] | the members bracketed inline in §2.3–§2.6: LSA types 3 and 4, `routeType 'IA'`, summary bodies [S4]; `OspfInterfaceRow.auth` and the `ospf` auth fields [S5]; `http.request.owner 'gui'` [S27]; CDP `voiceVlan` and LLDP `medVlan` [S35] |

```ts
// [S37] contracts/lab-document.ts
export interface LabDocument {
  readonly format: 'netforge.lab/1';
  readonly meta: { name: string; version: number; title: string; course?: string; topic?: string; seed: number;
                   concept?: ConceptToolId; instructions?: string };
  readonly topology: Topology;          // the build() result, exported
  readonly tasks: readonly LabTaskMeta[];
  readonly faults?: readonly FaultSpec[];
  readonly solution?: Readonly<Record<string, readonly string[]>>;
}
export function labDocumentOf(s: ScenarioInfo): LabDocument;
export function scenarioOf(doc: LabDocument): ScenarioInfo;
// sim/grade.ts: gradeTopology(doc: LabDocument, submission: Topology): LabStatus   (boots, settles a clone, evaluates)
```

### 2.14 Web contracts (`apps/web/src/bridge/protocol.ts`, `apps/web/src/store/types.ts`)

```ts
// protocol.ts
// EngineApi.init / reset: profile?: DefaultsProfile accepts 'P3' (OBM, unchanged shape)
// EngineApi.useCurrentDefaults(): upgrades to LATEST_DEFAULTS_PROFILE through sim/defaults-upgrade.ts (D2)
// [S31] EngineApi += sendBreak(session: SessionId): Promise<void>   (not approved: never added in P3a)

// store/types.ts
// ConceptTool = ConceptToolId (the engine contract; the local union at :62 is deleted)
// TopoOverlayState += qos: boolean                    (M13: FIFO stacks at egress ports from PortSnapshot.txBacklog, and
//                                                      cable load sleeves)
// store.ts: DEFAULT_TIMELINE_LANES (:77) gains 'mgmt' last (W0 stub; store.timeline.test.ts:54-56 pins it to LANE_IDS)
//   approved: [S1] ospf: boolean; ospfArea: string | null   [S18/S19] wan: boolean   [C1] eigrp: boolean;
//   eigrpPrefix: string | null (the destination whose successors and feasible successors the overlay draws)
//   persisted with defaults false/null (a persisted-slice migration, §9 W2)
//   not approved, never added in P3a: [S7] routeTo; [S26] neighbours, neighbourProtocol
// [S2] DockTab += 'routing'; dock/registry.ts DockStage += 'P3' and ALL_TABS gains {id: 'routing', label: 'Link state',
//      stage: 'P3'} (hidden while DOCK_STAGE is 'P1'; W4 web-shell sets DOCK_STAGE 'P3' and maps the tab to the lazy
//      routing/LinkStatePanel in app/Dock.tsx); UiState += routingUi: { device: DeviceId | null; area: string | null;
//      lsa: string | null; spf: { step: number; playing: boolean } }   (not persisted)
// labs/markdown.ts: ConceptLinkTool = ConceptToolId; the `concept:<id>` allowlist is derived from the ids that have a
//   registered tool; code blocks gain an optional display-only `lang` ('json' | 'yaml' | 'xml' | 'http' | 'python' | 'text').
// OverlayId (canvas/overlays/registry.ts) += 'qos' and the approved [S1] 'ospf'  [S3] 'spf'  [S18/S19] 'wan'  [C1] 'eigrp'
//   (not approved: [S7] 'route-path', [S26] 'neighbours')
```

### 2.15 Members that stay optional (optional by meaning)

These members keep their `?` after the exit gate: absent means P1/P2 behaviour and bytes, and several are hashed into
goldens. The source tags each `@since P3 (optional by meaning)`; the W8 extension of
`contracts.optional-by-meaning.test.ts` asserts, per member, that the type still accepts an object without it.

| Contract | Members |
|---|---|
| catalog.ts / device.ts | `DeviceModel.cdpDefault`, [S18] `VirtualFamilySpec.encap` |
| port.ts | `PortCounters.aclDenies` |
| pdu.ts | `PduMeta.protectedBy` (its [S13] 'ssh' and [C13] 'esp', 'ike' values too) |
| process.ts | drop action `rule`, `ipv4.resume.after`, `nat.outbound.filterOut`, `acl.filter.inPort`, `acl.filter.natted`, [S13] `tcp.listen.service`, [S18] `icmp.error.param` |
| transport.ts | `tcp.listen.tls`, `tcp.connect.tls` |
| tables.ts | `RouteRow.routeType` |
| trace.ts | drop `rule`, log `mnemonic`, configChange `origin` |
| snapshot.ts | `SimSnapshot.profile` ('P3' value), `DeviceSnapshot.clock`, `PortSnapshot.qos`, `PortSnapshot.txBacklog`, [S32] `DeviceSnapshot.storage` |
| device.ts | the `origin` parameter of `DeviceRuntime.applyConfigLine` |
| StateViews | the tcp and udp `probes` member |
| topology.ts | `Topology.profile` ('P3' value), [S32] `TopologyDevice.files` |
| cli.ts / config.ts | `ConfigNode.seq`, `ConfigLineRule.sequenced`, `ConfigureOptions.origin`, [S25] `CliSessionView.monitor`, [S13] `CliSessionView.remote`, [S13] `FacadeCounters.remote` |
| scenario.ts | `LabAssertionNotes.feedback` / `.misconception`, the widened `connectivity`, `route`, `table`, `cut` members, [C13] `path.tunnelAt` |
| link.ts | [S20] `TransmitOptions`, `LinkModelDeps.egressPolicy`, `LinkModel.egressQueues` |

(The OBM members of items that are not approved — [S29] `DeviceModel.storage`, [S34] `PduMeta.mirror`, [S6]
`Route6Row.routeType`, [S10] `TraceFilter.reasons`, [S31] `TopologyDevice.nvram` — are never added in P3a.)

Members that DO become required at the exit gate (or earlier, in the item that implements them): `ProcessCtx.clock`,
`CommandCtx.clock`, `DeviceRuntime.clockView`, `DeviceRuntime.setClock`, `DeviceRuntime.qosCounters`,
`Course.profile`, [S24] `DeviceRuntime.emitLog`, [S20] `DeviceRuntime.egressPolicy`, [S32] `ProcessCtx.files` and
`ProcessCtx.readFile`, [S13] the four CliRuntime remote-session methods, and every table-row field above not marked
`?`. No `DeviceRuntimeDeps` member is added (D14, D21), so the five `createDevice` harnesses (`device.harness.ts:191`,
`device.p2.harness.ts:75`, `device.radio-profile.test.ts:75`, `device.ctx.test.ts:211`, `ip6.harness.ts:199`) need no
new dep.

### 2.16 [C1] EIGRP (approved; written in full by the architect, D26)

Added in W0 like a MUST block. The design is D26; the walk-through §3.12.

```ts
// catalog.ts: PROCESS_ORDER 'eigrp' after 'ospf' (§2.1); CAPABILITY_PROCESSES routing += cp('eigrp', 'P3') (W4 flip)

// pdu.ts
// ProtoName += 'eigrp'
export const IPPROTO_EIGRP = 88;
export const EIGRP_GROUP = '224.0.0.10';
export const EIGRP_HELLO_S = 5;
export const EIGRP_HOLD_S = 15;
export const EIGRP_INFINITY = 0xffff_ffff;
// DISPATCH_TABLE += d('ipproto', 88, 'eigrp', 'P3');   IPV4_UPPER += {88, 'eigrp'}

// process.ts
// FsmMachine += 'eigrp-nbr'  (subject 'GigabitEthernet0/0 10.0.12.2'; states 'pending' | 'up' | 'down')
//             | 'eigrp-route' (subject '10.4.0.0/24'; states 'passive' | 'active'; a local computation is a
//                             passive → passive transition with cause 'feasible successor promoted')
// ProcessRequest += { kind: 'eigrp.clear'; neighbor?: IpAddress; session?: SessionId }
//   cli → eigrp: `clear ip eigrp neighbors [<address>]` resets every neighbour (or one); not interactive

// tables.ts
// ExtraTableName += 'eigrp-neighbors' | 'eigrp-topology';   PROCESS_TABLES eigrp: ['eigrp-neighbors', 'eigrp-topology']
// RouteRow.source += 'EIGRP' (D11)
export const AD_EIGRP = 90;
export type EigrpNbrState = 'pending' | 'up';
/** @since P3 [C1] key = `${iface}|${address}`. Writer: eigrp. Written when the state changes and once when SRTT and
 *  RTO are first measured; the hold countdown and the queue live in the StateView (rule 20). */
export interface EigrpNeighborRow extends TableRow {
  iface: PortId; address: Ipv4Address; as: number; state: EigrpNbrState;
  holdS: number;                        // the hold time the neighbour advertises
  upSince?: SimTime; srttMs: number; rtoMs: number;
}
export interface EigrpPath {
  nextHop: Ipv4Address; iface: PortId;
  metric: number;                       // the distance through this neighbour (what the FD would be)
  rd: number;                           // the neighbour's reported distance
}
/** @since P3 [C1] key = prefix ('10.4.0.0/24'). Writer: eigrp. Written when the state, the FD or a path list changes. */
export interface EigrpTopologyRow extends TableRow {
  prefix: string; state: 'passive' | 'active'; fd: number;
  successors: readonly EigrpPath[];     // equal-cost minimum, up to maximum-paths, in path order
  feasible: readonly EigrpPath[];       // RD < FD, not successors (`show ip eigrp topology`)
  others: readonly EigrpPath[];         // RD ≥ FD (`show ip eigrp topology all-links`)
  connected?: PortId;                   // a directly connected network of this router
  pendingReplies?: number;              // while active
}
// StateView kind 'eigrp' (display only):
//   { process?: { as: number; routerId: Ipv4Address; kValues: readonly number[]; maximumPaths: number };
//     neighbors: readonly { iface: PortId; address: Ipv4Address; holdUntil: SimTime; queue: number; lastSeq: number }[];
//     active: readonly { prefix: string; since: SimTime; waitingFor: readonly Ipv4Address[] }[] }

// scenario.ts: NeighborProtocol += 'eigrp' (state word 'up'); LabFactName += 'eigrp.fd' | 'eigrp.successor' |
//   'eigrp.feasibleSuccessor' (eigrp-topology; subject prefix) | 'eigrp.kValues' (configuration); IDENTITY_SOURCES
//   += EIGRP router ids;  route {source: 'EIGRP'} reads the rib rows the daemon offered.
// cli.ts: MODES += 'config-router-eigrp' (§2.11); CLI_MESSAGES += eigrpOneProcess, eigrpNeedsIpRouting, eigrpAutoSummary
// timeline: eigrp-nbr, eigrp-route and both tables → 'routing' (§2.12)
// web: PROTOCOL_VOCAB eigrp (label 'EIGRP', letter 'EG', control hexagon); FSM_VOCAB eigrp-nbr, eigrp-route;
//   OverlayId 'eigrp'; TopoOverlayState eigrp, eigrpPrefix (§2.14)
```

**Field table `eigrp`** (RFC 7868 layout; D = derived, R = required, O = decode-only): header `version` u8 = 2;
`opcode` u8 R (1 update, 3 query, 4 reply, 5 hello; 10 SIA-query and 11 SIA-reply); `checksum` u16 D (the IP one's
complement over the packet); `checksumValid` O; `flags` u32 (init 1, CR 2, RS 4, EOT 8); `seq` u32; `ack` u32; `vrid`
u16 = 0; `as` u16 R. TLVs: `kValues` string (`k1,k2,k3,k4,k5`, the parameter TLV, with `holdS` u16); `routes` string
(one IPv4 internal-route TLV per entry, `prefix/len,delayUs,bwKbps,mtu,hops,rel,load,nextHop` joined by `;`, `inf` as
the delay of an unreachable route; the codec scales delay and bandwidth to the RFC's 256-based units on the wire).
`stopsMeaning`: true. The codec test pins a hello, an init update, an update carrying two routes, a query with an
infinite route, a reply and an ack (a hello with `ack`), each against golden bytes.

**Lines** (§5.1): global `router eigrp <1-65535>` (section, mode `config-router-eigrp`, the existing `router <protocol>`
rule of identity 2, so `router ospf 1` and `router eigrp 100` are different slots; a second AS refused with
`eigrpOneProcess`; refused under `no ip routing`); in the process `network <a> [<wildcard>]` (multi), `eigrp router-id
<a>` (2), `passive-interface <if>` (multi) and `passive-interface default` (2), `metric weights 0 <k1> <k2> <k3> <k4>
<k5>` (2), `maximum-paths <1-4>` (1), `no auto-summary` (accepted, not rendered: the default); child render order
`eigrp router-id`, `metric weights`, `network`, `passive-interface`, `maximum-paths`. Interface: `delay <1-16777215>`
(tens of µs), `ip hello-interval eigrp <as> <1-65535>`, `ip hold-time eigrp <as> <1-65535>`, and the existing
`bandwidth`. **Exec:** `show ip eigrp neighbors [<if>]`, `show ip eigrp topology [all-links | <prefix>]`, `show ip
eigrp interfaces`, `show ip route eigrp`, the EIGRP section of `show ip protocols`, `clear ip eigrp neighbors
[<address>]`. **Debug:** `eigrp packets`, `eigrp fsm` (§5.8).

### 2.17 [C13] Site-to-site IPsec (approved; written in full by the architect, D27)

Added in W0 like a MUST block, on top of [S18]'s block (the tunnel role, `TunnelRow`, `virtualChanged`,
`mtu-exceeded`, `icmp.error.param`). The design is D27; the walk-through §3.13.

```ts
// catalog.ts: PROCESS_ORDER 'ike' after 'eigrp' (§2.1); CAPABILITY_PROCESSES routing += cp('ike', 'P3') (W4 flip).
//   ROLE_EGRESS_OWNER.tunnel stays 'gre' (the tunnel owner, now with two modes).

// pdu.ts
// ProtoName += 'esp' | 'ikev2';   PduMeta.protectedBy += 'esp' | 'ike';   PduSummary.tunnel += 'ipsec' (trace.ts)
export const IPPROTO_ESP = 50;
export const UDP_PORT_IKE = 500;
export const ESP_ICV_BYTES = 12;
/** Outer IPv4 20 + ESP header 8 + trailer 2 + ICV 12 + at most 2 alignment bytes at the largest inner packet that fits:
 *  a VTI's IP MTU defaults to the transport MTU − 44 (1456 on a 1500-byte port), and every inner packet of that size
 *  or less fits. */
export const IPSEC_OVERHEAD = 44;
// DISPATCH_TABLE += d('ipproto', 50, 'esp', 'P3'), d('udp.port', 500, 'ikev2', 'P3');   IPV4_UPPER += {50, 'gre'}
// MutationReason: 'Encrypt' and 'Decrypt' exist and are first recorded here (D27)

// process.ts
// FsmMachine += 'ike'  (subject 'Tunnel0'; states 'idle' | 'init-sent' | 'init-answered' | 'auth-sent' | 'established'
//                      | 'failed')
// ProcessRequest +=
  | { kind: 'ike.connect'; port: PortId; local: Ipv4Address; peer: Ipv4Address; profile: string }
      // gre → ike when an ipsec-mode tunnel's underlay becomes ready or its protection profile changes; ike opens
      // `ike#500` if needed and arms `ike-kick:<port>` (0 ns)
  | { kind: 'ike.disconnect'; port: PortId }
      // gre → ike: the underlay went, the mode left ipsec, or the tunnel was removed; ike drops the SA and its row
  | { kind: 'tunnel.sa'; port: PortId; op: 'up' | 'down'; spiIn?: number; spiOut?: number; keyId?: number;
      reason?: 'ike-negotiating' | 'ike-failed' | 'ike-no-proposal' | 'ike-no-response' }
      // ike → gre: the tunnel's SA; gre keeps the SPIs, the key id and its ESP sequence counter, writes the tunnels
      // row (up only while the SA is up) and issues virtualChanged

// link.ts: DropReason += 'ipsec-no-sa'   (an ESP packet whose SPI names no SA of this router)

// tables.ts
// ExtraTableName += 'ipsec-sa';   PROCESS_TABLES ike: ['ipsec-sa'];   TunnelRow.mode += 'ipsec' and its reasons (§2.6)
/** @since P3 [C13] key = tunnel port. Writer: ike. Written on a state change only (rule 20). */
export interface IpsecSaRow extends TableRow {
  port: PortId; local: Ipv4Address; peer: Ipv4Address; profile: string; role: 'initiator' | 'responder';
  state: 'negotiating' | 'established' | 'failed';
  reason?: 'ike-failed' | 'ike-no-proposal' | 'ike-no-response';
  ikeSpiI?: string; ikeSpiR?: string;   // 16 hex digits each
  espSpiIn?: number; espSpiOut?: number;
  proposal?: string;                    // 'aes-cbc-256 sha256 group14' once chosen
  since: SimTime;
}
// StateViews (display only): gre += per ipsec tunnel { encaps: number; decaps: number; seqOut: number;
//   lastSeqIn: number; noSa: number };  ike { exchanges: readonly { port: PortId; messageId: number;
//   retriesLeft: number; nextAt?: SimTime }[] }

// scenario.ts: LabFactName += 'ipsec.sa' (ipsec-sa.state; subject: tunnel interface); path += tunnelAt (§2.10)
// cli.ts: MODES += the four crypto modes (§2.11); CLI_MESSAGES += ipsecProfileMissing, ipsecProtectionVtiOnly
// timeline: the 'ike' machine and ipsec-sa → 'wan' (§2.12)
// web: PROTOCOL_VOCAB esp (letter 'ES'), ikev2 (letter 'IK', control hexagon); FSM_VOCAB ike; DROP_VOCAB ipsec-no-sa;
//   the packet inspector's banners for protectedBy 'esp' and 'ike'
```

**Field tables.**

| Proto | Fields |
|---|---|
| `esp` | Header: `spi` u32 R; `seq` u32 R. The next layer is the inner packet (by `nextHeader`: 4 → `ipv4`), encoded in clear under `meta.protected` with `protectedBy: 'esp'`. Trailer: `padLength` u8 D (0–3: pads payload + 2 to a multiple of 4 with the bytes 1, 2, 3); `nextHeader` u8 R (4); `icv` bytes 12 D (FNV-1a chained over the SA key id, `spi`, `seq` and the payload bytes; never a key); `icvValid` O. `stopsMeaning`: false (the inspector decodes the inner packet under the banner). |
| `ikev2` | Header (RFC 7296): `spiI` string R (16 hex digits); `spiR` string (zeros in the first request); `nextPayload` u8 D; `version` u8 = 0x20; `exchange` u8 R (34 IKE_SA_INIT, 35 IKE_AUTH); `flags` u8 (I 0x08, R 0x20); `messageId` u32; `length` u32 D. Payloads, each with the RFC generic payload header and an original compact body: `sa` string (`enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14` for the IKE SA; `esp:enc=aes-cbc-256,integ=sha256,spi=0x…` for the child SA); `ke` string (32 hex bytes, FNV-derived); `nonce` string (32 hex bytes, FNV-derived); `idi` / `idr` string (the address); `auth` string (16 hex bytes: the simulated pre-shared-key proof); `tsi` / `tsr` string (`0.0.0.0/0`, a VTI's traffic selectors); `notify` string (`AUTHENTICATION_FAILED`, `NO_PROPOSAL_CHOSEN`). IKE_AUTH messages carry `meta.protected` with `protectedBy: 'ike'`. `stopsMeaning`: true. |

The codec tests pin golden bytes for the four IKE messages and an ESP packet, the trailer for inner lengths 1453–1456
(every one fits in 1500), and that no byte of any PDU equals the configured key.

**Lines** (§5.7): global `crypto ikev2 keyring <k>` (section, mode `config-ikev2-keyring`) with `peer <n>` (mode
`config-ikev2-keyring-peer`) holding `address <a>` and `pre-shared-key <k>` (secret: rendered as typed, never in a PDU);
`crypto ikev2 profile <p>` (mode `config-ikev2-profile`) with `match identity remote address <a> [<mask>]`,
`authentication local pre-share`, `authentication remote pre-share`, `keyring local <k>`; `crypto ipsec profile <p>`
(mode `config-ipsec-profile`) with `set ikev2-profile <p>`. Tunnel interface: `tunnel mode ipsec ipv4` (the mode
default stays `gre ip`, not rendered), `tunnel protection ipsec profile <p>` (refused on a GRE-mode tunnel with
`ipsecProtectionVtiOnly`; an unknown profile is accepted with the note `ipsecProfileMissing`, and the tunnel stays
down `ike-negotiating` until it exists). **Exec:** `show crypto ikev2 sa`, `show crypto ipsec sa [interface <if>]`
(SPIs, packets encapsulated and decapsulated from the gre StateView), and `show interfaces Tunnel0` gains
`Tunnel protection via IPsec (profile VPN)` and `Tunnel transport MTU 1500 bytes, IP MTU 1456`. **Debug:** `crypto
ikev2` (§5.8).

---

## 3. Protocol walk-throughs

§3.0 is the reference the walk-throughs rely on. Every walk-through uses a P3-profile world unless it says otherwise;
lab initial configurations put `spanning-tree portfast` on host ports (§11.2), so no timing below waits for spanning
tree. "Converged" means `runToIdle` returned (rule 19).

### 3.0 Reference paths

**(a) The IPv4 receive and forward path with the P3 hooks** (`protocols/ipv4.ts`; new steps in bold; each hook exists
only when its line is stored and its daemon runs, so a world without the lines runs P2's path byte for byte):

1. Header checksum and the rx debug line (unchanged).
2. **Inbound ACL** (D12): the input port has `ip access-group <l> in` → `request acl {kind: 'acl.filter', family: 4,
   dir: 'in', iface, pdu, onPermit: request ipv4 {kind: 'ipv4.resume', pdu, inPort, after: 'acl-in'}}`. A resumed
   packet continues at step 3 and is never filtered again.
3. NAT inbound on an `ip nat outside` port (P2 §3.9), then `ipv4.resume` (no `after`) → step 4.
4. The for-me test: local addresses, `virtual4`, joined groups (OSPF's 224.0.0.5/6 after its joins; [C1] EIGRP's
   224.0.0.10) → ip-upper (**89 → ospf**, [S18] **47 → gre**, [C1] **88 → eigrp**, [C13] **50 → gre**, the tunnel
   owner in ipsec mode).
5. Forward: LPM (**`O` rows and ECMP paths**, D8), `TtlDecrement` with the route's cause (**`ospf 1: O 10.3.0.0/24
   [110/3] via 10.0.12.2`**).
6. NAT outbound (inside → outside), **with `filterOut: true` when the egress port has an outbound ACL**: nat translates
   (allocating its row, `nat.ts:712-715`), then requests `acl.filter {dir: 'out', inPort, natted: true, onPermit:
   request arp {kind: 'arp.sendVia', …}}`; a deny there sends no ICMP (D12).
7. **Outbound ACL** when NAT is not involved: `acl.filter {dir: 'out', inPort, onPermit: request arp arp.sendVia}`;
   a deny's ICMP 3/13 is sourced from `inPort`. Locally originated packets (`ipv4.send`) never pass through steps 6–7.
8. `arp.sendVia`: the HDLC branch (unchanged, first); **the IPv4-multicast rule** (never resolved; `01:00:5e` plus the
   low 23 bits); the broadcast rule; resolution. [S19] a `ppp` branch beside HDLC; [S18] a `tunnel` branch (no
   resolution, send on the tunnel port → owner egress `gre.onEgress`, which wraps GRE or [C13] ESP and applies the D15
   MTU fallback). No fragmentation ([S17] is not approved).
9. Egress marking (M13, `QosMark`): for a routed physical port, **the compiled output policy of the port classifies and
   marks** in the runtime's `transmitOn` (`device.ts:1224-1241`), then `deps.transmit`; for a subinterface, the
   subinterface's output policy runs in the subinterface egress branch right after `vlanPush` (`device.ts:1214-1219`),
   before `transmitOn(parent, …)`, so `set cos` writes the pushed tag. Policies are looked up by configuration
   generation (D16). [S20] passes `{qosClass}` to a scheduler port (a routed physical port with a queueing output
   policy), whose held queue in the link model decides when the frame leaves.

**(b) Pipeline additions** (`device/pipeline.ts` `frameArrivalVerdict`, P2 §3.0):

- **Control check on the physical port, routed ports, before step 10a**: a frame to `01:80:c2:00:00:0e` or
  `NF_L2_CONTROL_MAC` runs `classifyControl`; class `cdp` or `lldp` whose daemon runs on the device → verdict "deliver
  to it on the physical port", even when the port has a native subinterface (10a runs before 10b, `:541-546`, and would
  otherwise take the frame to the subinterface). Every other frame, and every other class (DTP, LACP, BPDUs), goes on
  to 10a/10b exactly as today; at step 10b (`:321-333`) a control destination with no running daemon still drops
  `not-for-me` (with `background: true` for background PDUs). On bridged ports of a VLAN-aware switch eth-switch step 2
  delivers the same two classes.
- **Step 10c, input QoS** (M13): run by the runtime only when `frameArrivalVerdict` returns `deliver` (the port's own
  policy) or `subif` (the subinterface's policy), and **before** the tag pop, so `match cos` sees the 802.1Q PCP and a
  frame the verdict drops (flooded unicast for another MAC, a control frame, a BPDU) is never classified or counted.
  Ports without an input policy skip the step.
- **eth-switch steps 7b / 7c** (D13, §3.4) sit after port security (step 7) in the VLAN-aware per-frame path; ports and
  VLANs without the snooping lines skip them.

**(c) The configure seam** (D21):

1. A daemon returns `{type: 'configure', token, lines, atomic: true, indentation: true, origin}`.
2. The runtime schedules `SimEvent {kind: 'deviceConfigure', device, from, token, lines, opts}` at `now` through its
   existing `scheduler` dep.
3. In that event's own dispatch (its own `ACTION_BUDGET`), the Simulation — the one caller — calls
   `cliCore.configure(device, lines, opts)`: a headless session at privilege 15, the console grammar and handlers. It
   is not journaled.
4. The session hands `opts.origin` to `DeviceRuntime.applyConfigLine(context, line, negate, origin)` for each line, so
   the `configChange` events carry `origin`. With `atomic`, a failing line reverts every line of the call.
5. The issuer receives `ProcessEvent {kind: 'config.result', token, result}`.

**(d) An API request** (D21): the requester (the host-shell `rest` job, [S32] a script) sends
`http.request` to http-client → name resolution through dns-client when needed → `tcp.connect {tls: true}` for
`https:` → request head plus a Content-Length body → response parsed by Content-Length → `http.result` to a process
owner or printed text to a CLI session.

### 3.1 OSPF adjacency and DR election on a LAN

Setup: SW1 (NF-C2960, PortFast on Fa0/1–3). R1, R2, R3 (NF-2911) Gi0/0 on Fa0/1–3, addresses 10.0.123.1/.2/.3 /24.
Each router: `router ospf 1` / `router-id <n>.<n>.<n>.<n>` / `network 10.0.123.0 0.0.0.255 area 0` (router ids
1.1.1.1, 2.2.2.2, 3.3.3.3, all priority 1). R1's and R2's Gi0/0 come up at U; R3's cable is added at U + 65 s (off
the 10 s hello grid, so no periodic hello coincides with its link-up).

1. **U, on R1 (R2 in the same instant).** `resync` (0 ns, after `onConfig`/`onLinkChange`, so the daemon reads the port
   view after the whole dispatch applied its actions — the stale-view lag noted at `ipv4.ts:735`) enables Gi0/0 in area
   0, network type broadcast (role `routed`), cost 1.
   - ISM Down → Waiting: `ctx.transition('ip ospf adj', …, {machine: 'ospf-if', subject: 'GigabitEthernet0/0', from:
     'down', to: 'waiting'})`; row `ospf-interfaces[Gi0/0]` written with `{state: 'waiting', waitUntil: U + 40 s}`.
   - Actions: `ipv4.group join 224.0.0.5`; a Hello now; `hello:Gi0/0` (10 s, periodic); `wait:Gi0/0` (40 s,
     non-periodic).
   - Router-LSA 1.1.1.1 originated (seq 0x80000001, one stub link 10.0.123.0/24 metric 1: while Waiting there is no DR,
     so the LAN is a stub). `lsa-gen` opens its 5 s window; `spf` is armed at U + 5 s.
   - The Hello is `[ethernet {dst 01:00:5e:00:00:05}, ipv4 {10.0.123.1 → 224.0.0.5, ttl 1, proto 89, dscp 48}, ospf
     {v2, type 1, routerId 1.1.1.1, area 0.0.0.0, mask /24, hello 10, dead 40, pri 1, dr 0.0.0.0, bdr 0.0.0.0,
     neighbors ''}]`, `meta {tag: 'ospf-hello', background: true}`, sent by `ipv4.send {iface: Gi0/0, nextHop:
     224.0.0.5}` and framed by the new arp multicast rule. SW1 floods it; PCs drop it at step 10b as background.
2. **U + propagation, R2 receives R1's hello.** ipv4 finds the group joined → ip-upper 89 → `deliver` to ospf. Checks:
   area, mask, hello/dead, authentication, E-bit. A mismatch refuses the hello: `row.rejected` is set, an `ip ospf
   hello` debug line is written, and no neighbour is created. Otherwise NSM Down → Init: row
   `ospf-neighbors[Gi0/0|1.1.1.1]`, `dead:Gi0/0:1.1.1.1` (40 s, periodic), and `hello-reply:Gi0/0` armed at U + 1 s.
   R1 does the same for R2.
3. **U + 1 s.** Each router sends a Hello listing the other → 2-WayReceived → 2-Way. AdjOK? is false: the interface is
   still Waiting (the DR is unknown), and nobody declares a DR or BDR (no BackupSeen).
4. **U + 40 s.** On each router the periodic `hello:Gi0/0` and `wait:Gi0/0` are due together; the scheduler's fixed
   (time, sequence) order decides which runs first, and the outcome is the same either way. At the wait expiry the
   router runs the election (RFC 2328 §9.4) over {self} ∪ neighbours at ≥ 2-Way with priority > 0; no hello declaring a
   DR can have arrived yet (any such hello leaves at U + 40 s and needs δ to arrive). The two routers compute different
   first answers:
   - **R2.** Step 2: BDR = best (priority, router id as u32) among candidates not declaring DR → 2.2.2.2. Step 3: no
     candidate declares DR, so DR = BDR = 2.2.2.2. Step 4: R2 has newly become DR, so steps 2 and 3 rerun with R2
     declaring itself DR → BDR = 1.1.1.1. R2: Waiting → **DR**; it joins 224.0.0.6, and since its (DR, BDR) pair
     changed, a hello declaring DR 10.0.123.2, BDR 10.0.123.1 leaves at once — the periodic one if it runs after the
     election, else `dr-hello` (D9).
   - **R1.** Steps 2–3 give BDR = DR = 2.2.2.2; R1 is neither, so step 4 does not rerun. R1: Waiting → **DROther**
     (DR 10.0.123.2, BDR 10.0.123.2); its pair changed too, so it sends a hello of its own the same way.
   - AdjOK? on each 2-Way neighbour: the neighbour (R1's view) or the router itself (R2's) is DR → both go to ExStart
     now.
   - **U + 40 s + δ** (δ = serialisation and propagation through SW1, well under 1 ms). R2's triggered hello reaches
     R1. R2 now declares itself DR, which is a NeighborChange on R1: the election reruns, BDR = 1.1.1.1 (the only
     candidate not declaring DR), DR = 2.2.2.2; R1 has newly become BDR, so it reruns once more with the same result.
     R1: DROther → **Backup**; it joins 224.0.0.6 and sends a hello declaring itself BDR (`dr-hello`). At R2 that
     hello is a NeighborChange whose election changes nothing, so no further hello follows.
   - Interface rows get `dr`/`bdr`; debug `ip ospf adj` on R1 shows both runs and ends with `GigabitEthernet0/0
     election: DR 2.2.2.2 (10.0.123.2), BDR 1.1.1.1 (10.0.123.1)`; the `ospf-if` transitions of R1 are
     waiting → drother → backup.
   Without the triggered hello (D9), when the periodic hellos run before the wait timers, R1 would stay DROther until
   R2's periodic hello at U + 50 s.
5. **ExStart, U + 40 s.** Each side sends an empty DBD (I|M|MS, ddSeq from D9, MTU 1500) unicast to the neighbour
   and arms `rxmt:Gi0/0:<rid>` (5 s, periodic). The higher router id (2.2.2.2) is master: R1 → Exchange (slave), adopts
   the master's ddSeq and answers MS=0 with its LSA header, M=0; R2 → Exchange, sends ddSeq+1 with its header; R1 acks
   by echo. Both have M clear → ExchangeDone. Each lists the other's router-LSA → Loading → LSR (unicast) → LSU
   (unicast) → install (`ospf-lsdb` tableWrite) and a direct LSAck → Full. Every state change is one `ospf-nbr`
   transition; the exchange takes well under 1 ms of sim time.
6. **Full with a DR (U + 40 s + ε, a few ms).** R2 originates the network-LSA (LSID 10.0.123.2, mask /24, attached
   {2.2.2.2, 1.1.1.1}, only fully adjacent routers). R1 and R2 re-originate their router-LSAs with one transit link (id
   10.0.123.2, data = own address, metric 1) — immediate, since their last origination (at U) was more than 5 s ago.
   Flooding on the broadcast segment: a router that is not DR — the BDR R1 here, like any DROther — sends **its own**
   new LSA in an LSU to 224.0.0.6 (AllDRouters); the DR re-floods it to 224.0.0.5, which also serves as R1's implicit
   acknowledgement, and floods its own LSAs to 224.0.0.5; the BDR never re-floods an LSA it received on that segment
   (it only listens, ready to take over); other acknowledgements are direct. `spf` was armed at the first change
   (U + 40 s + ε) for 5 s later and runs at **U + 45 s + ε** (the last run, at U + 5 s, is long past): tree R1 → N
   10.0.123.2 → R2, no new routes (only the connected LAN).
7. **U + 65 s, R3 joins.** Its Gi0/0 comes up: Waiting, a Hello with dr 0.0.0.0. R1 and R2 create Init neighbours and
   answer with their hello replies at U + 66 s, and R3 reaches 2-Way with both. **R1's reply is the BackupSeen**: R1
   declares itself BDR (R2's reply declares R2 DR with a BDR present, which is not BackupSeen). So R3 runs the election
   at once, without waiting 40 s, and the existing declarations win: BDR = 1.1.1.1 (declares BDR), DR = 2.2.2.2
   (declares DR); R3 becomes DROther (non-preemptive, even with the highest router id). The two replies arrive in the
   same millisecond; the scheduler's fixed order decides which R3 processes first, and the outcome is the same (if
   R1's comes first, R3 briefly computes DR = BDR = 1.1.1.1 and corrects it on R2's reply, a NeighborChange). R3 goes
   to ExStart with the DR and the BDR only (its first DBD finds R3 still Init at R1 and R2, which RFC 2328 §10.6 turns
   into 2-WayReceived) and is Full with both at about U + 66 s; the DR adds 3.3.3.3 to the
   network-LSA. `show ip ospf neighbor` on R3: `2.2.2.2 FULL/DR`, `1.1.1.1 FULL/BDR`; on R1: `3.3.3.3 FULL/DROTHER`.
   Two DROthers see each other `2WAY/DROTHER`.
8. **DR failure.** R2 is powered off at T. R1 and R3 detect it with `dead:` in [T + 30 s, T + 40 s] (the last hello was
   at most 10 s before T): NSM → Down (InactivityTimer) → ISM NeighborChange → election: R1 (BDR) → DR, R3 → BDR. R1
   originates network-LSA 10.0.123.1 and a router-LSA pointing at it; R2's stale LSAs stay until MaxAge but SPF ignores
   them (bidirectional check); SPF runs 5 s after the change.

Acceptance timings: R2 DR at U + 40 s ± 10 ms; R1 Waiting → DROther at U + 40 s ± 10 ms and DROther → Backup less
than 1 ms later (on R2's triggered hello); Full at U + 40 s + ε; the first SPF with the LAN at U + 45 s + ε; R3
DROther, Full at U + 66 s + ε; failover in [T + 30 s, T + 40 s]; new DR = the former BDR; a priority-0 router is
never DR or BDR.

### 3.2 Single-area convergence and a link failure

Setup: R1, R2, R3 (NF-2911) in a triangle: R1 Gi0/0–R2 Gi0/0 10.0.12.0/30 and R2 Gi0/1–R3 Gi0/0 10.0.23.0/30, both
`ip ospf network point-to-point`; R1 Se0/0/0–R3 Se0/0/0 10.0.13.0/30, HDLC, DCE clock on R1. LANs R1 Gi0/1
10.1.0.0/24 and R3 Gi0/1 10.3.0.0/24, both passive. Everything in area 0. Reference 100 Mb/s: GigE cost 1, serial 64
(the routing bandwidth of a serial port is 1544 kb/s, D7; `show interfaces` keeps its clocked rate — listed deviation).

1. **Convergence** (the GigE point-to-point links come up at U; each router's previous origination was at least 5 s
   earlier). Point-to-point interfaces go Down → Point-to-point (no wait, no DR). At U each router originates its
   router-LSA with the new stub link (immediate) and arms `spf` for U + 5 s. Hello at link-up; the hello reply 1 s
   later → 2-Way → ExStart (AdjOK is always true on point-to-point) → Full at U + 1 s + ε. The router-LSA must now
   carry the point-to-point link, but MinLSInterval holds that origination to U + 5 s. At U + 5 s each router runs its
   pending `lsa-gen` and then its `spf` (D9's fixed order): the SPF sees its own new LSA, but the neighbour's copy still
   lacks the link back — the neighbour re-originates it in the same instant and it arrives just after — so the
   bidirectional check keeps the new path out. The neighbour's LSA, arriving at U + 5 s + δ, arms `spf` for
   max(U + 10 s + δ, lastSpf + 10 s) = U + 15 s, and that SPF installs the routes: **routes at link-up + 15 s**.
   Serial frames are HDLC; the multicast address matters
   only at the IP layer. R1's table: `O 10.3.0.0/24 [110/3] via 10.0.12.2, GigabitEthernet0/0` and
   `O 10.0.23.0/30 [110/2]`; the serial path (65) is not installed. The routes arrive as ONE `ipv4.routes` request; the
   rib rows are written in key order.
2. **Failure at T** (the R1–R2 cable is cut). Both Gi0/0 go down at T: ipv4 withdraws C/L; ospf NSM → Down (LLDown);
   every OSPF path via Gi0/0 is withdrawn at T (D8), so 10.3.0.0/24 has no route at T. The router-LSA is re-originated
   at T and flooded on the serial link. SPF at T + 5 s installs `O 10.3.0.0/24 [110/65] via 10.0.13.2, Serial0/0/0`. A
   continuous ping loses only the echoes sent in [T, T + 5 s + serial latency]. With `ip route 10.3.0.0 255.255.255.0
   10.0.13.2 120` present, the floating static installs at T and the O route replaces it at T + 5 s (AD 110 < 120).
3. **Restore at T2** (T2 ≥ T + 30 s, so both throttles are free). The same pattern as step 1: at T2 each router
   originates its router-LSA with the stub link again (its last origination was at T) and arms `spf` for T2 + 5 s;
   Full at T2 + 1 s + ε; the point-to-point link is originated at T2 + 5 s, just before that SPF, which again misses the
   neighbour's link back; the neighbour's LSA arrives at T2 + 5 s + δ, and the SPF at **T2 + 15 s** returns the route to
   `[110/3] via 10.0.12.2`. A restore sooner after the failure waits for the throttles (MinLSInterval from T, the SPF
   hold from T + 5 s) and is never earlier than T2 + 15 s.
4. **Indirect failure** (the R1–R2 link through a switch, broadcast type, the switch–R2 cable cut): R1's port stays up,
   so detection is by `dead:` in [T + 30 s, T + 40 s], then as above.

Grading uses `route {source: 'O', nextHop, metric}` and `connectivity {after: [{cut: {a: 'R1', b: 'R2', aPort:
'Gi0/0'}}], settleMs: 60000}`. `settleMs` guidance for OSPF labs: a direct failover needs 5 s, an indirect one up to
dead 40 s + SPF 5 s = 45 s, a restore or a first convergence on point-to-point links 15 s, and a broadcast segment
40 s wait + 5 s; 60 s covers every case, with 15 s to spare.

### 3.3 An extended ACL with counters, logging and provenance

Setup: PC1 192.168.10.10 and PC2 .11 on SW1 → R1 Gi0/0 192.168.10.1; R1 Gi0/1 192.168.20.1 → SRV 192.168.20.100
(`http-server`). R1: `ip access-list extended NO-WEB-PC1` with `deny tcp host 192.168.10.10 host 192.168.20.100 eq www
log`, `permit icmp 192.168.10.0 0.0.0.255 any`, `permit ip any any`, applied with `interface Gi0/0` /
`ip access-group NO-WEB-PC1 in` (near the source).

1. **Configuration.** The entries are stored with hidden seq 10, 20, 30 (`ConfigNode.seq`). ipv4 sees the access-group
   delta (`aclGroups[Gi0/0].in = NO-WEB-PC1`, one `ip routing` debug line). acl sees the list become applied and writes
   rows `4|NO-WEB-PC1|10`, `|20`, `|30` and `|implicit` with `matches: 0`, `applied: 'GigabitEthernet0/0 in'` (four
   tableWrites). The counts below are derived from the constants, never typed as numbers in the tests.
2. **Ping from PC1.** The echo request reaches R1 Gi0/0; after the checksum, ipv4 requests `acl.filter {4, in, Gi0/0,
   pdu, onPermit: ipv4.resume {after: 'acl-in'}}`. acl builds the tuple {proto 1, .10 → .100, type 8}: line 10 misses
   (not tcp), line 20 matches → permit. Row 20 becomes `{matches: 1, lastPdu, lastAt, lastIface: Gi0/0, lastDir: 'in'}`
   (one tableWrite) and acl returns `[onPermit]`. After the resume: NAT hook (none) → for-me (no) → forward
   (`TtlDecrement`) → Gi0/1 has no outbound list → `arp.sendVia`. Replies are not filtered (no list on Gi0/1). Result
   5/5; row 20 counts 5.
3. **HTTP from PC1.** The SYN (.10:49152 → .100:80) matches line 10 → deny. Row 10 is incremented; the first packet of
   the flow is logged at once, severity 6, facility `ACL`: `list NO-WEB-PC1 line 10 denied tcp 192.168.10.10(49152) ->
   192.168.20.100(80), 1 packet`; `acl-log` is armed (periodic, 300 s). acl returns `drop {reason 'acl-deny', port
   Gi0/0, detail, rule {kind 'acl', list, seq 10, family 4, dir 'in', iface, table 'acl', key, config {context
   [['ip','access-list','extended','NO-WEB-PC1']], line […]}, text}}` and, the rate gate being open,
   `request icmpv4 icmp.error {3, 13, inPort: Gi0/0}`. The runtime emits the drop with its rule and sets Gi0/0
   `aclDenies = 1`. PC1's TCP records the soft error `admin-prohibited` (a soft error does not abort the connect) and
   retransmits the SYN on its RTO: `TCP_INITIAL_RTO_NS` 1 s, doubled per expiry, at most `TCP_SYN_RETRIES` 3
   (`contracts/transport.ts:221, :225`; `tcp.ts:18-19`), so the SYNs leave at 0, 1, 3 and 7 s — all inside the
   browser's `HTTP_CLIENT_TIMEOUT_NS` of 10 s (`contracts/services.ts:85`), which ends the tab in `error` at 10 s
   before a fifth attempt. Each of the four SYNs is denied, counted and — being ≥ 500 ms apart — answered with ICMP
   3/13; the next aggregation tick logs `…, 3 packets` (the first packet was logged at once). The acceptance test
   computes these numbers from the three constants.
4. **HTTP from PC2** matches line 30; every segment of that connection counts on row 30.
5. **`show access-lists`** prints `10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log (4 matches)`,
   `20 permit icmp 192.168.10.0 0.0.0.255 any (5 matches)`, `30 permit ip any any (n matches)`; the implicit deny is
   never printed (as on the device).
6. **Provenance and trace.** The SYN's drop event carries `rule`; the drop marker's detail reads `ACL NO-WEB-PC1 #10`;
   the timeline shows marks in the `security` and `drops` lanes. [S10] (not approved, P3c) would add the inspector's "Why it stopped here" box
   with its buttons and the "✓ permitted by NO-WEB-PC1 line 20 (in Gi0/0)" chip taken from the acl tableWrite whose
   `lastPdu` is the echo request.
7. **NAT variant.** On a NAT router an inbound ACL on the outside interface runs before `nat.inbound` (it sees global
   addresses), and a packet it denies never allocates a NAT row. An outbound ACL on the outside interface runs inside
   NAT's `filterOut` continuation, after NAT has translated the packet and allocated its row (`nat.ts:712-715`; real
   devices also translate before the output list), so it sees the translated source; its deny leaves the row to age
   out and sends no ICMP (the packet's source is now the router's own global address; listed deviation).
8. **Cross-area: implicit deny breaks OSPF.** `ip access-group 10 in` on an OSPF interface with `access-list 10 permit
   192.168.10.0 0.0.0.255` drops the neighbour's hellos (protocol 89, source outside the list) at step 2 of §3.0(a):
   after `dead` the adjacency goes Down and the routes are withdrawn. `accept.p3.ospf-acl` pins it; the lesson teaches
   it.

### 3.4 DHCP snooping stops a rogue server; DAI stops a spoofed ARP

Setup: SW1 (NF-C2960): PC1 on Fa0/1 (VLAN 10); ROGUE, a router with pool 10.66.0.0/24 and gateway .1, on Fa0/24;
trunk Gi0/1 to R1, which serves 192.168.10.0/24. SW1: `ip dhcp snooping`, `ip dhcp snooping vlan 10`, Gi0/1 `ip dhcp
snooping trust`, Fa0/24 `ip dhcp snooping limit rate 10`.

1. PC1's DISCOVER arrives on untrusted Fa0/1. Step 7b: snooping is on for VLAN 10; a client message (op 1, UDP 68 →
   67); chaddr equals the Ethernet source; no rate limit on Fa0/1 → learned and flooded to Fa0/24 and Gi0/1.
2. ROGUE's OFFER arrives on untrusted Fa0/24 → drop `dhcp-snooping`, detail `DHCP server message (OFFER) from
   10.66.0.1 on untrusted port FastEthernet0/24 (vlan 10)`, rule → the `ip dhcp snooping vlan 10` line with the hint
   about `trust`; debug category `ip dhcp snooping`. PC1 never sees it.
3. R1's OFFER and ACK arrive on trusted Gi0/1 and are forwarded. On the ACK: `cam[10/chaddr]` = Fa0/1 → row
   `10|<mac>` `{192.168.10.11, vlan 10, Fa0/1, learned, leaseS 86400, expiresAt}` (it flashes in the `dhcp` lane). A
   missing CAM row writes no binding and a debug line says why.
4. The binding goes on RELEASE from Fa0/1, NAK, lease end (`cam-sweep`) or link-down of Fa0/1; static bindings stay.
5. More than 10 DHCP packets on Fa0/24 in one sim-time second → `errDisable {Fa0/24, 'dhcp-rate-limit'}`; recovery by
   `errdisable recovery cause dhcp-rate-limit`. No MUST sender produces such a burst (ROGUE sends one OFFER per
   DISCOVER), so the tests inject eleven DHCP server messages with `test/inject.ts` (`injectFrames`, D13); lab 20
   configures the limit but has no rate-limit task.
6. **DAI.** SW1 adds `ip arp inspection vlan 10` and Gi0/1 `ip arp inspection trust`. ATTACKER on Fa0/5 holds a lease on
   .12 (binding Fa0/5, .12). The learner sets ATTACKER's address to 192.168.10.1; its gratuitous ARP (sender .1) arrives
   on untrusted Fa0/5. Step 7c: rate 1 in this window (≤ 15), no ARP ACL, binding (10, Fa0/5, A) says .12 ≠ .1 → drop
   `arp-inspection`, detail `ARP request from <A> claiming 192.168.10.1 on FastEthernet0/5 (vlan 10) matches no DHCP
   snooping binding`, rule → table `dhcp-snooping`, key `10|<A>`; the VLAN 10 `arp-inspection` row gets `dropped + 1`,
   `droppedNoBinding + 1`; a log at severity 4 (facility `DAI`, original wording). PC1's ARP cache keeps R1's MAC and
   its pings keep working. With DAI off, the same gratuitous ARP rewrites PC1's row for .1 (the poisoning demo).
7. R1's replies arrive on trusted Gi0/1 and are not inspected; PC1's own ARPs match its binding → `forwarded` rises.
   Sixteen or more ARPs in one window on Fa0/5 → `errDisable 'arp-inspection'` (proved with injected ARPs, as step 5).
8. **The gotcha the lab teaches:** a static-address host on an untrusted port has every ARP dropped until one of
   `ip source binding <mac> vlan 10 <ip> interface <if>`, [S14] an ARP ACL, or trust is added.
9. **Grader clone.** Bindings are runtime state lost on export; the clone's hosts run DORA while it settles, so the
   bindings rebuild before any check. `accept.p3.dhcp-snooping` asserts a connectivity check through a DAI port passes
   in the clone.

### 3.5 QoS lite: marking at the edge, and a FIFO link under congestion (M13)

Setup: PC-V 192.168.1.10 and PC-D 192.168.1.20 on SW1 → R1 Gi0/0 192.168.1.1. R1 Se0/0/0 (DCE, `clock rate 128000`)
10.0.0.1/30 ↔ R2 Se0/0/0 10.0.0.2; R2 Gi0/0 192.168.2.1 → PC-S 192.168.2.10. R1:
`ip access-list extended VOICE-PORTS` / `permit udp any any range 16384 32767`; `class-map match-all VOIP` /
`match access-group name VOICE-PORTS`; `policy-map MARK` / `class VOIP` / `set dscp ef`; `interface Gi0/0` /
`service-policy input MARK`.

1. **Configuration.** Each of these lines bumps the configuration generation (D16). The first frame that reaches
   Gi0/0 after them finds its cached input policy stale and recompiles it (pure `qos/config.ts` reader over the running
   configuration): classes `[VOIP (acl VOICE-PORTS), class-default]`, actions `[set dscp 46]`. Editing VOICE-PORTS or
   the class-map later bumps the generation again, so the next frame recompiles. The class-map's ACL is read through
   `core/acl.ts` (no acl daemon involvement: classification counts nothing on `acl` rows, as NAT's use does not).
2. **Flows.** On PC-V the host shell runs `flow start 192.168.2.10 pps 50 size 60 port 16384` (a journaled `cliExec`;
   `traffic.start` to the traffic daemon, which opens socket `traffic#f1` for the flow's lifetime and arms `flow:f1`,
   periodic, every 20 ms). Each datagram's payload starts with the traffic header: the marker `NFTG`, the flow id, a
   u32 sequence number, the send time (u64 ns) and the flags byte. On PC-D: `flow start 192.168.2.10 rate 200 size
   1000` (port 9, DSCP 0). Both are continuous: they run until `flow stop` or the 300 s cap, which is how the lab
   world uses them (live, no `runToIdle`); the acceptance test gives them a count or runs them under `runFor`.
3. **Marking.** A voice datagram reaches R1 Gi0/0; `frameArrivalVerdict` returns `deliver`, and step 10c classifies it
   (UDP 16384 → VOICE-PORTS permits → VOIP) and runs `Pdu.mutate('ipv4.dscp', 46, 'QosMark', 'policy-map MARK class
   VOIP set dscp ef')` → the derived `ChecksumRecompute ipv4.checksum` and `FcsRecompute` records follow, as for every
   mutate. The runtime's per-class
   counters (display only, `PortSnapshot.qos`) count matched and marked. Data datagrams fall in class-default and are
   not rewritten.
4. **Congestion.** Both flows are routed to Se0/0/0: 200 kb/s of data plus ≈ 26 kb/s of voice at L2 over a 128 kb/s
   line. The link model's virtual FIFO commits each frame's `txStart = max(now, busyUntil)` at enqueue
   (`p2p.ts:213`), so every waiting frame's `frameTx` already carries a future `txStart`; each 1004-byte data frame
   takes ≈ 63 ms to serialise. The queue grows to `P2P_QUEUE_LIMIT` (256, P2 D23), then both flows suffer `queue-full`
   drops.
5. **What the learner sees.** The `qos` overlay draws the FIFO stack at R1 Se0/0/0 from `PortSnapshot.txBacklog` (up to
   8 capsules from its frame summaries plus a `+k` counter from its depth, voice capsules labelled `EF`), and the cable
   load sleeve at 100 % (utilisation computed in the web from `outBytes` deltas against `speedBps`, display-only
   floats). At PC-S, udp finds
   no socket on 16384, but the traffic daemon runs there and the payload starts with the traffic header, so the
   datagram is consumed silently and handed over as `traffic.rx`; the traffic daemon updates the `flows` row `192.168.1.10|f1`: `dscp 46`, `received`,
   `lost` from sequence gaps, delay and RFC 3550 jitter, rewritten at most once per received second and flushed 1 s
   after the last datagram. Voice delay climbs past 1 s within 30 s.
6. **`show policy-map interface GigabitEthernet0/0`** on R1 prints, per class, matched packets and bytes and the marking
   action with its count; `show class-map` lists the classes and their match lines.
7. **The lesson point** (lesson 27): marking alone does not protect voice on a FIFO link; queueing does. The queueing
   sandbox runs the same two arrival patterns through FIFO, WFQ, CBWFQ and LLQ on `core/queueing.ts` side by side.
   [S20] builds LLQ on real ports (§3.11), and the lab gains its LLQ tasks.
8. **Grading:** the `config` lines; `fact qos.inputPolicy {device: 'R1', subject: 'Gi0/0', equals: 'MARK'}`; `table
   flows {device: 'PC-S', where: {src: '192.168.1.10', flow: 'f1', dscp: 46}}` (both senders default to `f1`, and an
   exact `dscp: 46` refuses CS6 = 48, which `ge 46` would pass).

### 3.6 CDP discovers neighbours; LLDP on request

Setup: R1 (NF-2911) Gi0/0 ↔ SW1 (NF-C2960) Gi0/1; SW1 Gi0/2 ↔ SW2 Gi0/1 is a trunk; PC1 on SW1 Fa0/1.

1. **Boot.** cdp reads `enabled = profileIncludes(profile, 'P3') && model.cdpDefault ? no 'no cdp run' line : a 'cdp
   run' line`. With every port down it sends nothing, writes no row and emits no debug.
2. **Link-up** on R1 Gi0/0 and SW1 Gi0/1: `cdp.onLinkChange(up)` on both; the port is enabled (no `no cdp enable`), so
   one frame is built and sent at once: `[ethernet {dst 03:4e:46:00:00:01, src port MAC, type = length}, llc {aa aa 03,
   oui NF_OUI, type 4}, cdp {version 2, ttl 180, deviceId 'R1', addresses '10.0.12.1', portId 'GigabitEthernet0/0',
   capabilities 'R', platform 'NF-2911', software '<original text>', duplex 'full'}]`, `meta.background`, tag `cdp`,
   always untagged. The device-level periodic `cdp-tx` (60 s) is armed if it is not yet. SW1's frames carry
   capabilities `S I` and, on trunks, `nativeVlan`.
3. **Receipt.** SW1 gets R1's frame on bridged Gi0/1: eth-switch step 2, `classifyControl` → `cdp` → delivered to cdp on
   the physical port, never bridged. R1 gets SW1's frame on routed Gi0/0: the control check on the physical port,
   before step 10a → `cdp` → delivered (before P3 this was a `not-for-me` drop at step 10b). PC1 gets SW1's periodic
   frame on Fa0/1: no cdp daemon → `not-for-me`, `background: true`: no marker, hidden in the sim-mode list by
   default.
4. **The row.** `cdp-neighbours` `{key 'GigabitEthernet0/1|R1', localPort, deviceId 'R1', remotePort
   'GigabitEthernet0/0', platform, capabilities 'R', addresses, version, holdtimeS 180, cdpVersion 2, duplex, expiresAt
   now + 180 s}` → tableWrite (the row flashes, the `mgmt` lane marks it). `cdp-age` is re-armed to the earliest
   `expiresAt` (periodic). Debug `cdp packets`: `received CDP v2 from R1 on GigabitEthernet0/1, 1 address, holdtime
   180 s`. A periodic refresh that changes no displayed column rewrites only `expiresAt` (rule 20: `expiresAt` is a
   volatile key, P2 `VOLATILE_ROW_KEYS`).
5. **`show cdp neighbors`** prints a capability legend and rows ordered by local port, then device id: Device ID, Local
   port, Hold (`ceil((expiresAt − now) / 1 s)`), Capability, Platform, Remote port. `show cdp neighbors detail` and
   `show cdp entry R1` add addresses, version text, advertisement version, native VLAN and duplex.
6. **Ageing.** R1 powered off: SW1 Gi0/1 goes down and the row is deleted (reason `link-down`). Behind an unmanaged
   switch (the link stays up) the row expires at last update + 180 s ± 1 ms (reason `aged`). `no cdp enable` on SW1
   Fa0/1 (edge hardening) stops sending on that port; `no cdp run` stops everything, clears the table and is stored
   explicitly in a P3 world.
7. **LLDP** is the same flow after `lldp run`: IEEE frames to `01:80:c2:00:00:0e` every 30 s, TTL 120; `no lldp
   transmit` / `no lldp receive` are per-port and asymmetric. `cdp run` or `lldp run` typed in a P1 or P2 world works
   identically (D2). [S41] adds the native-VLAN and duplex mismatch logs (severity 4, at most once per port per 60 s).

### 3.7 An NTP chain sets every clock (M15), and logs carry its time [S24] [S25]

Setup: R1 Gi0/1 10.0.0.1 ↔ SW1 (Vlan1 10.0.0.2) ↔ SRV1 (NF-SERVER) 10.0.0.10. SRV1: `service ntp on` (= `ntp master
1`). R1: `ntp server 10.0.0.10`. SW1: `ntp server 10.0.0.1` (the line that wakes SW1's dormant transport, D22).

1. **Boot.** R1 boots at t = 45 s with an unset clock: 2020-01-01 00:00:00 plus uptime. `show clock` prints `*00:00:12.500
   UTC Wed Jan 1 2020`; `show clock detail` adds "No time source". SRV1 boots with true time (source `host`).
2. **R1's ntp sees `ntp server`.** It opens socket `ntp#123`, sends a mode-3 NTPv4 packet (version 4, poll 6, transmit =
   R1's clock as an NTP timestamp), arms `ntp-poll:10.0.0.10` (periodic, 64 s), registers `ipv4.ribWatch {lpm:
   [10.0.0.10]}` (it is unsynchronised) and writes an `ntp-peers` row (configured, reach 0). If Gi0/1 has no address or
   route yet the send fails `no-route`; the route appearing (`ipv4.ribChanged`) or a port coming up kicks a re-poll at
   once, and an unanswered poll is retried after 1, 2, 4, 8, 16 and 32 s (D19).
3. **SRV1 answers** at once in mode 4: stratum 1, refId `LOCL`, receive and transmit timestamps from its true-time clock,
   origin = R1's transmit timestamp. (An unsynchronised server would answer stratum 16, leap 3, refId `INIT`, which the
   client rejects and retries.)
4. **R1 validates** (origin match, stratum < 16, leap ≠ 3), computes θ = ((T2 − T1) + (T3 − T4)) / 2 and δ exactly in
   BigInt ns, and returns `clock {op: 'step', offsetNs, source: 'ntp', stratum: 2, reference: '10.0.0.10'}`. The runtime
   rebases the clock and emits the `ntp` transition (unsynchronised → synchronised, category `ntp events`); the peer row
   becomes `sys-peer`, reach 1, with the offset split into `offsetMs` and `offsetSubMsNs`; ntp writes its `clock` row
   (source `ntp`, stratum 2, reference 10.0.0.10) and drops its RIB watch. `show ntp associations` marks the system
   peer with `*`; `show ntp status`: `Clock is synchronised, stratum 2, reference is 10.0.0.10`; `show clock`:
   `08:05:12.412 UTC Mon Jan 6 2025`, no `*`. R1 now answers NTP clients at stratum 2.
5. **SW1** (managed switch; its `ntp server` line woke its transport, D22) polls R1 the same way. Its first poll, at
   its own boot, gets no answer: R1 is still booting (45 s). The link-up of SW1's port toward R1 at 45 s kicks a
   re-poll; if that poll reaches R1 before R1's own exchange with SRV1 has completed, R1 answers stratum 16 and SW1
   retries 1 s later → stratum 3. After `runToIdle` each clock equals true time plus the exact path asymmetry of its
   chain.
6. **Server loss.** SRV1 powered off: R1's polls go unanswered; `reach` shifts in zeros every 64 s (periodic, so
   `runToIdle` still returns; the fast retries apply only while unsynchronised); after 8 polls the peer is `unreached`
   and the clock keeps running from its last step (no drift model).
7. **[S24] local logging.** With the replayed `service timestamps log datetime msec`, R1 `shutdown` on Gi0/2 produces the
   existing admin-state log (severity 3, facility LINK, P1 wording, `device.ts:1532-1538`, D4), buffered and shown by
   `show logging` as `Jan  6 08:10:03.123: %LINK-3: Interface GigabitEthernet0/2 administratively down` (no `*`: the
   clock is synchronised).
8. **[S25] syslog and extended logging.** R1 adds `logging host 10.0.0.10`, `logging trap warnings`. A cable cut on Gi0/2
   at t = 400 s: the runtime (P3 world) emits `emitLog(3, 'LINK', …, 'UPDOWN')` then `emitLog(5, 'LINEPROTO', …,
   'UPDOWN')`; the logger buffers both, prints them on console sessions, and sends only severity ≤ 4 over UDP 514:
   `[syslog {pri 187 (local7 × 8 + 3), timestamp 'Jan  6 08:10:03.123', hostname 'R1', message '%LINK-3-UPDOWN: …'}]`.
   SRV1's syslog-server writes a `syslog-messages` row with the received stamp from its own clock.

Grading (MUST): `fact ntp.synced {device: 'R1', equals: true}`, `fact ntp.stratum {device: 'SW1', equals: 3}`, `fact
ntp.peer {device: 'R1', equals: 'SRV1'}` (a device name resolved by identity), `fact clock.source {device: 'SW1',
equals: 'ntp'}` — all read from the `ntp-peers` and `clock` tables (rule 20). The first poll, the kicks and the bounded
retries are non-periodic, so the grader clone reaches synchronisation under `runToIdle` whenever the chain can
synchronise within 63 s of its last kick. Lab 29's approved logging tasks ([S24], [S25]) add `fact logging.trap
{device: 'R1', equals: 'warnings'}`, `fact logging.buffered` and a live `table syslog-messages {device: 'SRV1',
whereOps: {message: {op: 'contains', value: '%LINK-3-UPDOWN'}}}` (the learner cut a link and the server received the
line with a synchronised stamp).

### 3.8 A REST change graded by a lab

Setup: PC1 (NF-PC) 10.0.99.10/24 on an access port in VLAN 99 of SW1; SW1–SW3 (NF-C2960) in a line of trunks carrying
VLAN 99; management SVIs Vlan99 10.0.99.11 / .12 / .13. Each switch's initial configuration: `username admin privilege
15 secret <lab value>`, `ip http secure-server`, `ip http authentication local`, `restconf`. With `restconf` and
`ip http secure-server` both present the switch's transport is awake (D22) and the restconf daemon runs
`tcp.listen 'restconf#443' {tls: true}`. SW2's Gi0/2 carries the description `uplink - add vlan 40 NAME FINANCE on SW3`
(original text), which the lab asks the learner to read from the JSON of a `rest GET` (the GET itself is graded).

1. **The request.** On PC1's host shell the learner types `rest PUT https://10.0.99.11/restconf/data/nf-native:native/
   vlan/vlan-list=30 -u admin:<password> -H "Content-Type: application/yang-data+json" -d
   {"nf-native:vlan-list":[{"id":30,"name":"VOICE"}]}` (one `cliExec`, journaled; `-d` is last and takes the rest of
   the line verbatim, D21, so the body needs no quoting). The CLI job blocks the session
   (`ctx.block`, the `ipconfig /renew` pattern, `cli/handlers/pc.ts:229-231`) and requests `http.request {owner: 'cli',
   session, token, method: 'PUT', url, headers [Content-Type, Accept, Authorization: Basic …], body}`.
2. **http-client** does `tcp.connect 10.0.99.11:443 {tls: true}`: ARP for .11 floods in VLAN 99; SW1 reaches its Vlan99
   SVI; SYN, SYN-ACK, ACK; no TLS handshake bytes. Request segments carry `meta.protected` with `protectedBy: 'tls'`;
   NetScope shows `PUT /restconf/data/…` and the JSON body under the "protected (TLS, simulated)" banner.
3. **SW1 restconf** accepts child `restconf#443/1`, buffers until head plus Content-Length are complete (non-periodic
   `head:<socket>` 30 s guard), checks the Basic credentials against the privilege-15 `username` lines (failure → 401),
   resolves the path through `automation/yang/model.ts` to node `nf-native:native/vlan/vlan-list`, key id 30, and checks
   the body key equals the URL key (RFC 8040; otherwise 400). PUT replaces the entry: the diff against current state
   gives `configure {token 'restconf#443/1', lines ['vlan 30', ' name VOICE'], atomic: true, indentation: true, origin
   {via: 'restconf', user: 'admin', address: '10.0.99.10'}}`.
4. **deviceConfigure** runs at the same SimTime in its own dispatch: the headless CLI applies `vlan 30`; the vlan daemon
   writes the `vlans` row and issues `l2Changed`; spanning tree creates the VLAN-30 instance if a port carries it;
   `configChange` events carry the origin; restconf receives `config.result` ok.
5. **The response.** `HTTP/1.1 201 Created` (204 if the entry existed), then `tcp.close`; restconf writes the
   `restconf-log` row `{seq, method 'PUT', path, status 201, client '10.0.99.10', user 'admin', at}`. A CLI refusal
   (VLAN 5000) returns 400 with an `ietf-restconf:errors` body whose message is the CLI's original error text; nothing is
   applied (atomic).
6. **Back on PC1.** http-client parses the response and prints to the session: the status line, the headers, and the
   body (JSON pretty-printed as text); then `cliDone`. `rest GET https://10.0.99.11/restconf/data/ietf-interfaces:
   interfaces` prints the RFC 7951 JSON of the switch's interfaces, rendered from the running configuration.
7. **Lab tasks:** `vlan {device: 'SW1'|'SW2'|'SW3', vlan: 30, name: 'VOICE'}` (the effect); `table {device: 'SW1'…,
   table: 'restconf-log', where: {method: 'PUT'}, whereOps: {path: {op: 'contains', value: 'vlan-list=30'}, status:
   {op: 'le', value: 204}}}` (proves the change came through the API); and the **JSON reading tasks** that lesson 37's
   lab used to carry: `table {device: 'SW2', table: 'restconf-log', where: {method: 'GET'}, whereOps: {path: {op:
   'contains', value: 'ietf-interfaces'}}}` (the learner read the interfaces) and `vlan {device: 'SW3', vlan: 40, name:
   'FINANCE'}` (the value found in the JSON was acted on). All live reads; no clone and no replay of the requests.
   Three runs with one seed are byte-identical; the journal replays the `cliExec` ops.
8. **[S32] variant (lab 40).** A script saved in DEV1's `files:` store (NF-DEVHOST) loops over the three switches with
   the `requests`-style module; each call suspends the VM and becomes the same `http.request` (owner `script-host`);
   the requests are strictly sequential; the run is a `script-runs` row (written at its start and end) and its output
   and request list are in the script-host StateView. Lab 40 grades `fact automation.lastRun {device: 'DEV1', subject:
   'inventory.py', equals: 'completed'}` and the `restconf-log` rows the run left on each switch; it never re-runs the
   script.

### 3.9 PPP with CHAP comes up, then fails with a wrong password [S19]

Setup: R1 Se0/0/0 (DCE, `clock rate 64000`) ↔ R2 Se0/0/0 (`serial-dce` cable). R1: `username R2 password NetF0rge`,
`interface Se0/0/0` / `ip address 10.1.1.1 255.255.255.252` / `encapsulation ppp` / `ppp authentication chap` /
`no shutdown`; R2 mirrors it with `username R1 password NetF0rge`.

1. R1 has ppp, R2 still hdlc: the link model sees a mismatch (`link/serial.ts:134`), both ends down
   `encapsulation-mismatch`; R2's HDLC keepalives are blocked and R1's ppp sends nothing (line not ready).
2. R2 applies `encapsulation ppp`: the runtime sets the encapsulation; hdlc disarms `ka:Serial0/0/0`; the link recompute
   sees both ends ppp and clocked with PPP not open → reason `ppp-negotiating`; `serial-line {ready: true}` goes to both
   ppp daemons.
3. **LCP**, both ends at once: Up and Open → Req-Sent; each sends ConfReq id 1 `[ppp 0xc021, lcp {code 1, authProto
   chap-md5, magic}]` (exempt from gating), `lcp-restart` 2 s; each ACKs the peer's (Ack-Sent) and, on the ACK of its
   own, → Opened (`ppp-lcp` transition). Each 23-byte frame takes ≈ 2.9 ms at 64 kb/s.
4. **CHAP**, both directions: R1 sends Challenge {id 1, 16 FNV-derived bytes, name 'R1'}; R2 finds `username R1
   password` and answers Response {id 1, MD5(0x01 ‖ 'NetF0rge' ‖ challenge), name 'R2'}; R1 recomputes, matches, sends
   Success. Both ends report `ppp-link up`; `operUp` becomes true, `onLinkChange` fires, ipv4 installs C and L.
5. **IPCP** ConfReq/ConfAck both ways → opened, `peerAddress 10.1.1.2`; the ping 10.1.1.2 goes `arp.sendVia` (ppp
   branch, IPCP open) → `ppp {protocol 0x0021}` → at R2 the ppp framing rule demuxes on 0x0021 to ipv4. One PduId each
   way. LCP echoes every 10 s, background.
6. **Wrong password** (R2 has `username R1 password WRONG`): R1's expected MD5 differs → Failure `the response does not
   match`, severity-5 log; Terminate-Request `authentication failed` / Terminate-Ack; both LCPs Stopped; both ends
   `ppp-link up: false reason 'ppp-auth-failed'`; `show interfaces` says `line protocol down (authentication failed)`; a
   ping drops `link-down`. The periodic `ppp-retry` (10 s) repeats the cycle; `runToIdle` returns because every
   per-attempt timer is cancelled at Stopped. Correcting the password makes the next retry succeed. The CHAP secret
   occurs in no PDU byte; PAP (the other lesson case) puts the password in clear on purpose.

### 3.10 GRE carries a ping between two sites [S18]

Setup: PC1 192.168.1.10 — R1 Gi0/0; R1 Se0/0/0 209.165.200.225/30 — ISP — R2 Se0/0/0 209.165.200.230/30; R2 Gi0/0 —
PC2 192.168.2.10. The ISP has no private routes. R1: `ip route 0.0.0.0 0.0.0.0 209.165.200.226`, `interface Tunnel0` /
`ip address 172.16.0.1 255.255.255.252` / `tunnel source Serial0/0/0` / `tunnel destination 209.165.200.230`,
`ip route 192.168.2.0 255.255.255.0 172.16.0.2`; R2 mirrors it.

1. `interface Tunnel0` creates the virtual port (family Tunnel, role `tunnel`, encapsulation `tunnel`), down
   `no-source`. After source and destination, gre evaluates: Se0/0/0 up and addressed; `ipv4.ribWatch {lpm:
   [209.165.200.230]}` answers the default route via Se0/0/0 (not a tunnel) → `tunnels` row `{state up, transportMtu
   1476}` → `virtualChanged` → Tunnel0 up → ipv4 installs C 172.16.0.0/30 and L; the static via 172.16.0.2 becomes usable.
2. PC1 pings PC2. At R1: LPM 192.168.2.0/24 → `TtlDecrement` of the inner header → `arp.sendVia` tunnel branch → owner
   egress `gre.onEgress` → `rewrap {strip 1 (ethernet), push [ipv4 {209.165.200.225 → 209.165.200.230, proto 47, ttl
   255, dscp copied}, gre]}` (provenance: Decapsulate ethernet, Encapsulate gre, Encapsulate ipv4, cause `interface
   Tunnel0`) → size check against the tunnel MTU → `ipv4.send` → default route → HDLC on Se0/0/0. The leg carries
   `PduSummary.tunnel = 'gre'`.
3. The ISP forwards the outer packet (outer `ipv4.ttl` 255 → 254); the inner addresses are never routed there.
4. At R2: for-me → ip-upper 47 → gre matches Tunnel0 → strip-only rewrap (hdlc, ipv4, gre removed) → `ingress {port:
   'Tunnel0', layer: 'ipv4'}` counts on Tunnel0 → ipv4 (tunnel selector) forwards via Gi0/0 with the inner TTL
   decrement. One PduId end to end.
5. Failures: `no tunnel destination` → down `no-destination`; withdrawing the default route → `ipv4.ribChanged` →
   down `no-route`; a 1500-byte ping with DF → drop `mtu-exceeded` and ICMP 3/4 (next-hop MTU 1476); without DF and
   without [S17] → drop `mtu-exceeded` with the detail of D15.
6. OSPF over the tunnel (network type point-to-point on role `tunnel`): the hello to 224.0.0.5 leaves via Tunnel0 as a
   unicast outer packet; at R2 it reaches ospf with 224.0.0.5 joined on Tunnel0 (OSPF cost 1000 at the default
   reference, D17). [S36] (not approved, P3c) If R1 advertises
   209.165.200.224/30 into OSPF, R2 learns its tunnel destination through the tunnel (AD 110, more specific than the
   default): the lpm watch fires → Tunnel0 down `recursive-routing` with a log → the adjacency drops → after the 10 s
   periodic hold the tunnel returns: the classic flap.

### 3.11 LLQ protects voice on a congested serial link [S20]

Setup as §3.5 with `clock rate 128000` and, on R1: `class-map match-all VOICE` / `match dscp ef`; `policy-map
WAN-EDGE` / `class VOICE` / `priority 32` / `class class-default` / `fair-queue` [S21] (or FIFO); `interface Se0/0/0` /
`bandwidth 128` / `service-policy output WAN-EDGE`.

1. `service-policy output` (a `PHY_CONFIG_KEYS` line for physical ports from [S20] on, D16): the runtime compiles the
   scheduler spec (refBps 128 kb/s; admission 32 ≤ 96 → accepted) and calls `onPortPhyConfig`; the link model installs
   the held queue on R1 Se0/0/0. Frames already committed by the
   virtual FIFO keep their times; the scheduler respects `busyUntil`.
2. A voice packet reaches the egress: `transmitOn` classifies it (dscp 46 → VOICE, index 0) and calls
   `deps.transmit(…, {qosClass: 0})`; the port is congested and the bucket allows it → priority queue, `frameQueued
   {queue: 'VOICE', depth: 1}`, `{ok: true, deferred: true}`.
3. At the current data frame's `txComplete` the scheduler (`core/queueing.ts`) pops the priority queue first: frameTx
   with `txStart = now`, the five draws, txComplete and arrival scheduled, `onTxOutcome sent`. Voice waits at most one
   data serialisation (≈ 63 ms) plus its own (≈ 5 ms).
4. Data waits in class-default: frame 65 drops `queue-full`, detail `class class-default is full (64 packets)`. Voice
   above 32 kb/s during congestion drops `policed`, detail `priority class VOICE is over its 32 kb/s`.
5. `show policy-map interface Serial0/0/0` prints per class matched packets and bytes, the 30-second offered rate, drops,
   depth / limit and the priority or fair-queue parameters, equal to the trace counts.
6. **[S21] in lab 27.** The lab's last task polices the bulk traffic at the LAN edge: `policy-map MARK` / `class
   class-default` / `police 64000 conform-action transmit exceed-action drop` (the input policy already on R1 Gi0/0,
   §3.5): excess datagrams drop `policed` at step 10c, after marking and before they reach the serial queue, and `show
   policy-map interface GigabitEthernet0/0` counts conform and exceed packets equal to the trace.

### 3.12 EIGRP: successor, feasible successor and failover [C1]

Setup (the routing map's §4.4, corrected): R1, R2, R3 (NF-2911) and R4 (NF-4331). R1 Gi0/0 10.0.12.1/24 — R2
10.0.12.2; R1 Gi0/1 10.0.13.1/24 — R3 10.0.13.3, where both ends carry `bandwidth 100000` and `delay 10` (a 100 Mb/s,
100 µs link); R2 — R4 10.0.24.0/24 and R3 — R4 10.0.34.0/24 on GigE; R4's LAN 10.4.0.0/24 on GigE with PC4
10.4.0.10. Every router:
`router eigrp 100` / `network 10.0.0.0` (classful: every 10.x interface). K values 1 0 1 0 0; GigE 1 000 000 kb/s and
10 µs.

1. **Neighbours (link-up U).** Each router joins 224.0.0.10 on its enabled interfaces and sends a hello (hold 15) at
   once. A hello from an unknown address creates a `pending` neighbour (`eigrp-nbr` down → pending), triggers the
   `hello-reply` on that interface (0 ns) and a unicast Update with the init flag (reliable, `rtp:<if>:<nbr>` armed);
   the peer's ack (a hello with `ack = seq`) makes the neighbour `up` (row `eigrp-neighbors[Gi0/0|10.0.12.2]`, SRTT and
   RTO measured once). The full topology follows as reliable Updates with EOT. On GigE all of this takes well under
   1 ms of sim time per hop.
2. **Metrics at R1 for 10.4.0.0/24** (D26: 256 × (floor(10⁷ / min bw) + floor(Σ delay µs / 10))):
   - via R2: min bw 1 000 000 → 10; delay 10 (R1 Gi0/0) + 10 (R2 → R4) + 10 (R4's LAN) = 30 µs → 3; metric 256 × 13 =
     **3328**; R2's reported distance 256 × (10 + 2) = **3072**.
   - via R3: min bw 100 000 → 100; delay 100 + 10 + 10 = 120 µs → 12; metric 256 × 112 = **28672**; RD 256 × (10 + 2)
     = 3072.
   - FD 3328; successor R2. R3's RD 3072 < FD 3328, so R3 is a **feasible successor**.
   - `eigrp-topology[10.4.0.0/24]` `{state 'passive', fd 3328, successors [{10.0.12.2, Gi0/0, 3328, 3072}], feasible
     [{10.0.13.3, Gi0/1, 28672, 3072}]}`; one `ipv4.routes` batch; `show ip route`: `D    10.4.0.0/24  via 10.0.12.2
     [90/3328] GigabitEthernet0/0`, and the second legend line `Dynamic sources: D - EIGRP` (D11).
   - `show ip eigrp topology`: `P 10.4.0.0/24, 1 successor, FD 3328` / `via 10.0.12.2 (3328/3072),
     GigabitEthernet0/0` / `via 10.0.13.3 (28672/3072), GigabitEthernet0/1`.
3. **The R1–R2 cable is cut at T.** R1's Gi0/0 goes down at T: ipv4 withdraws C/L and every EIGRP path through Gi0/0
   (D8); eigrp drops neighbour R2 (`eigrp-nbr` up → down). DUAL, in the same dispatch: the successor is lost, R3 is
   feasible → local computation, the route stays passive (`eigrp-route` passive → passive, cause `feasible successor
   promoted`), FD becomes 28672, and one `ipv4.routes` batch installs `D 10.4.0.0/24 [90/28672] via 10.0.13.3,
   GigabitEthernet0/1` **at T**. No query is sent. R1 sends R3 an update with the infinite metric for 10.4.0.0/24 on
   Gi0/1 (poison reverse: R3 is now its successor). A continuous ping from R1 to 10.4.0.1 loses only what was on the
   cut cable.
4. **Variant without a feasible successor.** R3 — R4 also carries `bandwidth 100000` and `delay 10`. R3's own distance
   is now 256 × (100 + floor((100 + 10) / 10)) = **28416** ≥ FD 3328, so R3 is not feasible; R1's path via R3 is 256 ×
   (100 + floor((100 + 100 + 10) / 10)) = **30976** (the routing map's 31616 was a slip). At T R1 goes active
   (`eigrp-route` passive → active), sends a reliable query to R3 and waits; R3's successor is R4, not R1, so it
   replies at once with 28416; with every reply in, R1 goes passive and installs `[90/30976] via 10.0.13.3` at T + one
   query and one reply (under 1 ms on GigE).
5. **Indirect failure** (R1 — R2 through a switch, the switch — R2 cable cut): R1's port stays up, so R2 is lost when
   its hold expires, in [T + 10 s, T + 15 s] (the last hello was at most 5 s before T); then as step 3.
6. **Mismatches.** `metric weights 0 1 1 1 0 0` on R2 only: R1 and R2 refuse each other's hellos, log the K-value
   mismatch at severity 5 and never form; `router eigrp 200` on R2: its hellos are ignored with a debug line.

Acceptance timings: every neighbour `up` within link-up + 10 ms; every route within link-up + 50 ms; the failover route
at T exactly (same dispatch); the no-FS variant passive again within T + 5 ms; the indirect failure in [T + 10 s, T +
15 s]. Grading (lab 10): `neighbor {device: 'R1', protocol: 'eigrp', neighbor: 'R3', state: 'up'}`, `route {device:
'R1', network: '10.4.0.0/24', source: 'EIGRP', nextHop: '10.0.12.2', metric: 3328}`, `fact eigrp.feasibleSuccessor
{device: 'R1', subject: '10.4.0.0/24', equals: 'R3'}` and `connectivity {from: 'R1', to: 'PC4', after: [{cut: {a: 'R1',
b: 'R2', aPort: 'Gi0/0'}}], settleMs: 5000}`.

### 3.13 A site-to-site IPsec VTI comes up; only ESP crosses the provider [C13]

Setup as §3.10 (PC1 — R1 — ISP — R2 — PC2; the ISP has no private routes; each router's default route points at the
ISP), but Tunnel0 is protected. R1: `crypto ikev2 keyring KR` / `peer R2` / `address 209.165.200.230` / `pre-shared-key
<lab value>`; `crypto ikev2 profile PROF` / `match identity remote address 209.165.200.230 255.255.255.255` /
`authentication remote pre-share` / `authentication local pre-share` / `keyring local KR`; `crypto ipsec profile VPN` /
`set ikev2-profile PROF`; `interface Tunnel0` / `ip address 172.16.0.1 255.255.255.252` / `tunnel source Serial0/0/0` /
`tunnel destination 209.165.200.230` / `tunnel mode ipsec ipv4` / `tunnel protection ipsec profile VPN`; `ip route
192.168.2.0 255.255.255.0 Tunnel0`. R2 mirrors it toward 209.165.200.225.

1. **The underlay.** gre evaluates Tunnel0 (mode ipsec, IP MTU 1456): Se0/0/0 is up and addressed, and `ipv4.ribWatch
   {lpm: [209.165.200.230]}` answers the default route through Se0/0/0 (not a tunnel) → `tunnels` row `{mode 'ipsec',
   state 'down', reason 'ike-negotiating', transportMtu 1500, ipMtu 1456}` and `ike.connect {port: 'Tunnel0', local:
   '209.165.200.225', peer: '209.165.200.230', profile: 'VPN'}`. Tunnel0's line protocol stays down.
2. **IKE_SA_INIT.** ike opens `ike#500`, writes `ipsec-sa[Tunnel0] {state 'negotiating', role 'initiator'}`, goes idle →
   init-sent and at `ike-kick` sends `[ipv4 {.225 → .230, protocol 17}, udp {500 → 500}, ikev2 {spiI <16 hex>, spiR
   0…0, exchange 34, flags I, messageId 0, sa 'enc=aes-cbc-256,integ=sha256,prf=sha256,dh=14', ke, nonce}]`, arming
   `ike-rexmt:Tunnel0` (1 s). R2, whose underlay became ready in the same instant, does the same toward .225.
3. **Crossing initiations.** R1's request reaches R2 while R2 is in init-sent: .225 is lower, so R2 abandons its own
   exchange (its row becomes role `responder`) and answers. R2's request reaches R1, which keeps its own exchange and
   discards it with a `crypto ikev2` debug line. The outcome is the same whichever arrives first (D27).
4. **The answer and IKE_AUTH.** R2 answers IKE_SA_INIT (flags R, its `spiR`, the chosen `sa`, `ke`, `nonce`) → R2
   init-answered. R1 → auth-sent and sends IKE_AUTH (exchange 35, messageId 1, marked `meta.protected` with
   `protectedBy: 'ike'`): `idi 209.165.200.225`, `auth` (the FNV proof over its key, both SPIs, both nonces and the
   role I), the child `sa` with R1's inbound ESP SPI, `tsi`/`tsr` `0.0.0.0/0`.
5. **Established.** R2 finds its keyring peer for 209.165.200.225, computes the proof it expects with its own key, and
   it matches: R2 answers IKE_AUTH with its own proof and inbound SPI, writes `ipsec-sa[Tunnel0] {state 'established',
   role 'responder', SPIs, proposal 'aes-cbc-256 sha256 group14'}` and requests `tunnel.sa {port: 'Tunnel0', op: 'up',
   spiIn, spiOut, keyId}` from gre. R1 checks R2's proof and does the same. The `ike` transitions end at `established`
   on both ends; the four messages take a few milliseconds of serial time.
6. **Tunnel up.** gre writes `tunnels[Tunnel0] {state 'up'}` and issues `virtualChanged` → Tunnel0 up → ipv4 installs
   C 172.16.0.0/30 and L; the static route through Tunnel0 becomes usable.
7. **A ping PC1 → PC2.** At R1: LPM 192.168.2.0/24 → Tunnel0 → `TtlDecrement` of the inner header → `arp.sendVia`
   tunnel branch → `gre.onEgress` in ipsec mode → `rewrap {strip 1 (ethernet), push [ipv4 {209.165.200.225 →
   209.165.200.230, protocol 50, ttl 255, dscp copied}, esp {spi: R2's inbound SPI, seq 1, nextHeader 4}]}` with the
   records Decapsulate ethernet, Encapsulate esp, Encrypt, Encapsulate ipv4 (cause `interface Tunnel0`), `meta.protected`
   with `protectedBy: 'esp'` → the size check against 1456 → `ipv4.send` → the default route → HDLC on Se0/0/0. The
   leg carries `PduSummary.tunnel = 'ipsec'`.
8. **The provider's view.** The ISP routes the outer packet (outer TTL 255 → 254). A capture at the ISP shows IPv4
   protocol 50 and an ESP header; the inner ICMP appears only under the "Encrypted (ESP, simulated)" banner. The filter
   `esp` matches every tunnel leg; no leg at the ISP carries a private address outside the banner.
9. **The tail.** At R2: for-me → ip-upper 50 → gre finds the SA by SPI → strip-only rewrap (hdlc, ipv4 and esp
   removed) with a `Decrypt` record that clears `meta.protected` → `ingress {port: 'Tunnel0', layer: 'ipv4'}` → ipv4
   forwards to PC2 with the inner TTL decrement. One PduId end to end; the reply returns on R2's outbound SA with its
   own sequence 1.
10. **A wrong key** on R2: R2's expected proof differs, so it answers IKE_AUTH with `notify AUTHENTICATION_FAILED`;
    both ends go `failed` (rows `{state 'failed', reason 'ike-failed'}`), log at severity 4 (original wording) and
    send `tunnel.sa {op: 'down', reason: 'ike-failed'}`; Tunnel0 stays down `ike-failed`. PC1's ping now follows R1's
    default route to the ISP, which has no private route and answers "destination unreachable" (the lesson's point:
    a route through a tunnel that is down falls back to the default route). The periodic `ike-retry:Tunnel0` (10 s)
    repeats the exchange, so `runToIdle` returns; correcting the key makes the next retry succeed. The key occurs in
    no PDU byte.
11. **Too big.** A 1500-byte ping with DF from PC1 drops `mtu-exceeded` at R1 (`larger than the tunnel can carry (1456
    bytes); fragmentation is not simulated`) and PC1 receives ICMP 3/4 with next-hop MTU 1456 (D15).
12. **Grading (lab 25):** `fact ipsec.sa {device: 'R1', subject: 'Tunnel0', equals: 'established'}`, `fact tunnel.up
    {device: 'R2', subject: 'Tunnel0', equals: true}`, `connectivity {from: 'PC1', to: 'PC2'}` and `path {from: 'PC1',
    to: 'PC2', tunnelAt: {device: 'ISP', tunnel: 'ipsec'}}` — only ESP crosses the provider.

### 3.14 SSH-only access with a vty ACL, over the network [S13]

Setup: PC1 192.168.10.10 and PC2 192.168.10.11 on SW1 → R1 Gi0/0 192.168.10.1. R1: `hostname R1`, `ip domain-name
lab.nf`, `crypto key generate rsa modulus 1024`, `ip ssh version 2`, `username admin secret <lab value>`, `access-list
10 permit host 192.168.10.10`, `line vty 0 4` / `login local` / `transport input ssh` / `access-class 10 in` (the ACL
map's §4.4, with D14's event path and login table).

1. vty opens a hidden listener on TCP 22 only (`tcp.listen {service: true}`: no row, no debug, not in the tcp
   StateView); none on 23, since the transport excludes telnet. acl writes the rows of list 10 with `applied: 'vty in'`.
2. PC1 `telnet 192.168.10.1`: the SYN finds no listener → RST → "connection refused"; no `vty-logins` row.
3. PC2 `ssh -l admin 192.168.10.1`: the vty-client job asks for the password locally (`cliRemote {input: 'secret'}`,
   applied through the `remoteCli` SimEvent to PC2's session), then connects. R1 accepts, vty sends `acl.check {family
   4, list '10', tuple {src 192.168.10.11, …}}` → `acl.verdict {deny, seq 'implicit'}`; row `4|10|implicit` +1 with
   `lastIface 'vty'`; `tcp.abort` (a RST after the handshake, listed deviation); a severity-5 log; a `vty-logins` row
   `{proto 'ssh', peer 192.168.10.11, user 'admin', result 'refused', reason 'access-class 10'}`. PC2 prints "connection
   refused by 192.168.10.1".
4. PC1 `ssh -l admin 192.168.10.1`: permit (row 10 +1); SSH version strings in clear, then segments marked
   `meta.protected` with `protectedBy: 'ssh'` (XORed with the FNV keystream) carry the user and password; vty checks
   them against `username admin secret` (`login local`) and returns `remoteCli {op: 'open', conn, peer, proto 'ssh',
   user 'admin'}`; the runtime schedules the `remoteCli` SimEvent, and in its dispatch the Simulation calls
   `CliRuntime.openRemote` → a session `via: 'vty'` at R1's user exec; `vty-logins` gains `result 'success'`. The prompt
   `R1>` returns as `vty.output` → TCP → vty-client → `cliRemote {remote: 'R1 via SSH', prompt: 'R1>'}` → PC1's terminal
   shows the chip and the prompt.
5. Each line typed on PC1 is a journaled `cliExec` of PC1's session; vty-client sends it protected, vty turns it into
   `remoteCli {op: 'line'}` → `execRemote`, and the output returns as `vty.output`. `exit` closes the session
   (`closeRemote`, TCP close). A further `ssh` from R1 nests, up to depth 4.
6. **Capture.** SSH segments show their plaintext only under the SSH banner; the same run with `transport input telnet
   ssh` and `telnet` shows the password characters in clear, one per segment.
7. **On a switch.** SW1 with the same lines answers the same way once `transport input ssh` (a P3 line) has woken its
   transport (D22); with only `line vty 0 4` / `login local` (P1 lines) a telnet to SW1 draws "protocol unreachable",
   as in P2 (D14).
8. **Grading (labs 15 and 19)**, live: `table vty-logins {device: 'R1', where: {proto: 'ssh', result: 'success'}}` and
   `{result: 'refused'}`, `acl {device: 'R1', list: '10', applied: [{vty: true, dir: 'in'}], entry: 'implicit',
   minMatches: 1}`; in the clone: `service {from: 'PC1', to: 'R1', service: 'ssh', user: 'admin', password: <lab
   value>, expect: 'success'}`, `{from: 'PC2', …, expect: 'refused'}` and `{from: 'PC1', service: 'telnet', expect:
   'refused'}`.

---

## 4. Determinism, timers and silence

### 4.1 RNG stream registry (additions to P1 §5.1 and P2 §4.1; never add draws to an existing stream)

**P3a adds no stream.** No P3 daemon draws randomness:

- OSPF: the DD sequence number `(u32(ownRid) ^ u32(nbrRid) ^ (attempt << 16)) & 0x7fffffff`; LSA sequences from
  0x80000001; no hello jitter (D9).
- ACL: nothing to draw; the ICMP rate gate is a SimTime comparison (`ACL_UNREACH_RATE_NS = 500 000 000`).
- Snooping and DAI: rate windows aligned to sim-time seconds (`floor(now / SEC)`).
- CDP and LLDP: fixed periods from a device-level timer, canonical port order.
- NTP: fixed ports 123 on both ends (no ephemeral draw); timestamps from device clocks.
- RESTCONF and the `rest` command: the client's ephemeral TCP port comes from tcp's existing cached per-device stream
  (P1 §5.1), drawn only when a request is made.
- Traffic: fixed pacing `floor(size · 8 · 10⁹ / rate)` ns; the flow socket's ephemeral port from udp's existing cached
  stream, drawn only when a flow starts.
- [S13] SSH keystream, [S19] PPP magic numbers and CHAP challenges, [C13] IKE SPIs, nonces, KE values and ESP SPIs:
  FNV-1a (`fnv1a32`, `contracts/addr.ts:259`) over (device id, port or session, per-process counter).
- [C1] EIGRP: no draw; sequence numbers start at 1 per neighbour; no hello jitter; the RTO derives from the measured
  SRTT (D26).
- NTP retries: a fixed schedule (1, 2, 4, 8, 16, 32 s), no jitter.
- The grader's tcp and udp probes: the ephemeral port from the existing cached per-device streams, drawn only when a
  probe runs, which happens only inside grader clones.
- [S32] NF-Py has no `random` module in P3a; dictionary order is insertion order; float repr is fixed by rule (D21).

Control frames still consume the five `link:<id>` draws per frame (P0 invariant): in P3 worlds CDP frames, and in any
world configured OSPF, EIGRP, PPP or IKE, shift the loss pattern of data frames on lossy links; it stays deterministic,
and P1/P2 worlds send none of these frames by default.

### 4.2 Timers

Periodic = `periodic: true`: `runToIdle` does not wait for it. Every re-armed failure detector and every retry that can
repeat for ever is periodic by this definition (rule 19); tests of the failures they catch use `runFor`.

| Daemon | Periodic | Never periodic (`runToIdle` waits) |
|---|---|---|
| ospf | `hello:<if>` (10 s); `dead:<if>:<rid>` (40 s, re-armed per hello); `rxmt:<if>:<rid>` (5 s: DBD, LSR, unacknowledged LSU; a stuck exchange never holds idle, bounded by `dead` or an ExStart restart after 10 retransmissions); `refresh` (one timer at the earliest self-LSA reaching 1800 s); `maxage` (60 s sweep, only while non-self LSAs exist); `self-war:<lsa>` (re-origination after a newer copy of a self-LSA arrives, e.g. a duplicate router id) | `wait:<if>` (40 s, broadcast only, once per interface-up); `hello-reply:<if>` (1 s after a neighbour goes Down → Init, coalesced); `dr-hello:<if>` (0 ns, coalesced, when the interface's DR or BDR changes, D9); `lsa-gen:<lsa>` (MinLSInterval: first origination immediate, then ≥ 5 s apart); `spf` (5 000 ms after the triggering change, then not before lastSpf + 10 000 ms; at expiry it first runs every `lsa-gen` due at or before now, D9); `resync` (0 ns, coalesced, after `onConfig` and `onLinkChange`) |
| acl | `acl-log` (300 s, armed only while aggregated flows are pending) | — |
| eth-switch (snooping, DAI) | `cam-sweep` (existing; also expires bindings); `errdisable:<port>` (existing; recovery for the new causes) | — (rate windows are evaluated lazily; no timer) |
| cdp | `cdp-tx` (60 s, one per device); `cdp-age` (re-armed to the earliest expiry) | — (the link-up send is immediate) |
| lldp | `lldp-tx` (30 s); `lldp-age` | — |
| ntp | `ntp-poll:<server>` (64 s) | the first poll (an immediate send); while unsynchronised, `ntp-kick:<server>` (0 ns, coalesced: a port comes up or the route toward the server changes) and `ntp-retry:<server>` (1, 2, 4, 8, 16, 32 s after an unanswered or rejected poll; six at most per kick) (D19) |
| restconf | — | `head:<socket>` (30 s, like http-server) |
| http-client | — | `fetch:<token>` (existing); the `http.request` timeout (`timeoutNs`, default `HTTP_CLIENT_TIMEOUT_NS`, 10 s) |
| traffic | `flow:<id>` for a continuous flow (used only under `runFor`: its datagrams commit non-periodic link events, so a congested link holds `runToIdle` until the cap) | `flow:<id>` for a flow with `count` or `durationMs` (bounded, so `runToIdle` waits for its end); the 300 s cap of every flow; `flow-flush:<key>` on the receiver (1 s after the last datagram, coalesced: the final `flows` write) |
| tcp, udp (probes) | — | `probe:<session>` (3 s; only in grader clones) |
| runtime | — | `deviceConfigure` (zero delay) |
| [S19] ppp | `lcp-echo:<p>` (keepalive, 10 s); `ppp-retry:<p>` (10 s after a failure or Stopped) | `lcp-restart:<p>`, `ipcp-restart:<p>` (2 s; Max-Configure 10, Max-Terminate 2, Max-Failure 5); `chap-retry:<p>` (2 s × 10) |
| [S18] gre | — ([S36], not approved, would add `recursion-hold:<p>`) | — (the tunnel is re-evaluated on configuration, link changes and `ipv4.ribChanged`) |
| [S13] vty, vty-client | — | login and idle guards (the P1 CLI job timers); the client's connect timeout (the tcp connect timers) |
| [S24] logger, [S25] syslog | — | — (sends immediately) |
| [S32] script-host | — | `script-slice:<run>` (1 ms after each 10 000-instruction quantum); `script-sleep:<run>` |
| [S20] qos shaper [S21] | — | `mediumTimer` with prefix `qos:` (gates dequeue) |
| [C1] eigrp | `hello:<if>` (5 s); `hold:<if>:<nbr>` (15 s, re-armed by every packet from the neighbour); `sia:<prefix>` (90 s SIA query, then the neighbour reset at 180 s; only while active) | `hello-reply:<if>` (0 ns, coalesced, when a hello creates a neighbour); `rtp:<if>:<nbr>` (the RTO, at most 16 retransmissions, then the neighbour is reset); `resync` (0 ns, coalesced, after `onConfig` and `onLinkChange`) |
| [C13] ike | `ike-retry:<port>` (10 s after a failed exchange) | `ike-kick:<port>` (0 ns, coalesced: `ike.connect` or a profile change); `ike-rexmt:<port>` (1, 2 and 4 s after an unanswered request; three at most, then `ike-no-response`) |

Consequences:

- `runToIdle` in an OSPF world returns after the adjacencies are Full and the last SPF ran: link-up + 40 s wait + 5 s
  + ε on a LAN (§3.1), link-up + 15 s on point-to-point links (§3.2: the point-to-point link is re-originated at + 5 s,
  and the neighbour's copy reaches the SPF only at the next run, 10 s later).
- A mismatched hello, a stuck ExStart, an NTP server that never answers (after six fast retries only the periodic poll
  is left), an unused CDP port, [S19] a failed CHAP, [C1] an EIGRP K-value mismatch or a neighbour that never
  acknowledges (16 retransmissions, then a reset whose next attempt waits for a periodic hello) and [C13] a wrong IKE
  key or a silent peer (three retransmissions, then only the periodic retry) never hold `runToIdle`.
- `runToIdle` in an EIGRP world returns a few milliseconds after link-up (hellos, the hello reply, the reliable
  exchange and the computation are all immediate), and a failover with a feasible successor completes in the dispatch
  of the link-down (§3.12). An IPsec tunnel is up a few milliseconds after its underlay (§3.13).
- An uncongested flow and a finished flow never hold `runToIdle`; a continuous flow over a congested link does, so
  continuous flows appear only under `runFor` (tests) or in live worlds (labs), and the 300 s cap bounds even those.
- The grader clone therefore settles OSPF, EIGRP, NTP synchronisation, DHCP bindings (hosts run DORA), CDP/LLDP
  tables, PPP, IPsec SAs and bounded traffic flows before it evaluates.

### 4.3 Silence: what turns each new daemon or behaviour on

| Daemon or behaviour | Sends nothing unless | P1 or P2 profile, default configuration | P3 profile, default configuration |
|---|---|---|---|
| `ospf` | `router ospf <pid>` and an enabled, up, non-passive interface with an address | silent | silent |
| `acl` | never originates, except ICMP 3/13 for packets it denies; rows exist only for applied lists | silent, no rows | silent, no rows |
| eth-switch steps 7b/7c | `ip dhcp snooping` + `ip dhcp snooping vlan <v>`; `ip arp inspection vlan <v>` | per-frame path, StateView and existing debug lines byte-identical | same |
| `cdp` | P1/P2: `cdp run` typed; P3: on by default on `cdpDefault` models (D2), off with `no cdp run` | silent | one frame per enabled up port at link-up and every 60 s (background, tag `cdp`); hosts drop them `not-for-me` background |
| `lldp` | `lldp run` | silent | silent |
| `ntp` | `ntp server <a>` or `ntp master` (servers: `service ntp on` expands to `ntp master 1`); a master only answers | silent, no socket | silent, no socket |
| `restconf` | `restconf` and `ip http secure-server` (then it listens on TCP 443 and only answers) | silent, no `sockets` row | silent, no `sockets` row |
| `traffic` | a flow started from the host shell or the desktop app | silent | silent |
| `udp`, `tcp` on managed switches (D22) | dormant: ipv4 hands them nothing until a P3 service (`ntp server`/`ntp master`, `restconf` with `ip http secure-server`, approved S services) is configured on the switch; then they answer as on hosts (port unreachable, RST) | P2's path byte for byte (protocol unreachable); proved by the guard worlds | same |
| runtime `deviceConfigure` | a `configure` action (only restconf issues one in MUST) | never | never |
| QoS steps (10c, egress marking) | `service-policy input\|output <p>` on a routed port or subinterface | unchanged path | unchanged path |
| `PortSnapshot.txBacklog` | a port with frames waiting behind a busy transmitter (display only, never in the trace) | present while a backlog exists; normalised away in the goldens | same |
| [S24] visible timestamps lines (a P3 default) | — | not replayed | replayed on routers, managed switches, the controller |
| [S25] extended logging, console printing (a P3 default) | — | never (typed `logging console` works in any profile) | on (oper-change, restart, configuration logs; console at level debugging) |
| [S13] `vty` / `vty-client` | a `line vty` section with telnet allowed, or an RSA key with SSH allowed (hidden listeners: no row, no debug, not in the tcp StateView); the client acts only on a typed `telnet`/`ssh`. On a managed switch nothing reaches the listener until a P3 line wakes the transport (D22) | silent, no `sockets` row, snapshot unchanged | silent |
| [S18] `gre` | a Tunnel port with source and destination | silent | silent |
| [S19] `ppp` | a port whose effective encapsulation is `ppp` (typed; the P1/P2 grammars refused it) | silent | silent |
| [S24] `logger` | buffering produces no trace; sends only with [S25] `logging host` | silent | silent |
| [S25] `syslog-server` | `syslog-server enable` (`service syslog on`) | silent | silent |
| [S32] `script-host` | a run (NF-DEVHOST only, from the W6 flip) | silent | silent |
| [C1] `eigrp` | `router eigrp <as>` and an enabled, up, non-passive interface with an address (then hellos to 224.0.0.10) | silent, no 224.0.0.10 join | silent |
| [C13] `ike` | a Tunnel port in `tunnel mode ipsec ipv4` with `tunnel protection ipsec profile <p>` whose underlay is ready (gre's `ike.connect`; only then is UDP 500 opened) | silent, no socket | silent |

The daemons of items that are not approved ([S6] `ospfv3`, [S29] `tftp`, [S33] `snmp-*`) are never registered in P3a.

New daemons emit no debug or log line at boot when unconfigured, open no socket unless configured, write no table row
at boot, and are never listed in a model before their factory is registered (so no "Process X is not available" log
appears, rule 3). `accept.p3.silence` (§10.1) guards all of this.

### 4.4 What a P3 world does by default (decision)

A freshly placed device in a new world:

| | P2 profile (CCNA 2 labs, saved P2 files) | P3 profile (CCNA 3 labs, new worlds after the W7 course flip) |
|---|---|---|
| Spanning tree, DTP, `no ip routing` on multilayer switches, proxy ARP, `capwap enable` | as P2 D2 | same (P3 includes P2's defaults) |
| CDP | off; `cdp run` turns it on | on for `cdpDefault` models; `show cdp neighbors` answers after the first exchange |
| LLDP | off | off (as real devices) |
| Device clock (routers, switches) | unset (`*`), shown only by `show clock` | same |
| Host and server clocks | true time | same |
| Running configuration | P2's | P2's plus the two `service timestamps` lines ([S24], approved) |
| Logs of link changes | none beyond P1's admin-state log | interface and line-protocol logs, restart and configuration logs, printed on consoles ([S25], approved) |
| Managed switch UDP/TCP | dormant (protocol unreachable, as in P2) until a P3 service is configured on it (D22, every profile) | same |

Why: new CCNA 3 work must behave like the devices the course describes (CDP answering out of the box, and hardening
means turning it off at the edge), and old work must not change its traffic by a byte. The CCNA 3 lessons say plainly
that real devices run CDP by default and that NetForge projects saved before P3 keep their profile until upgraded.

### 4.5 Integer discipline and fixed orders

- **[C1] EIGRP.** The composite metric in integers (D26: floor divisions, K5 applied last, infinite 2³² − 1, far
  below 2⁵³); neighbours by (interface canonical order, address u32); topology rows and route batches in prefix order;
  successors by (metric, next hop u32); queries sent in neighbour order; one computation per destination per dispatch.
- **[C13] IPsec.** SPIs and sequence numbers are u32 (an ESP sequence counter cannot wrap within the traffic caps of
  D16); proofs and ICVs are chained `fnv1a32` values; the crossing-initiation rule compares tunnel source addresses as
  u32.
- **OSPF.** Costs use integer floor division (`max(1, floor(refMbps × 1000 / bwKbps))`). Interfaces in canonical port
  order; neighbours by router id as u32; the LSDB iterated by (scope, type, lsid u32, advRouter u32); LSUs bundled per
  interface per dispatch in LSDB key order; SPF candidate ties by (cost, transit network before router — RFC 2328
  §16.1 step (3) — vertex id u32), never heap insertion order; ECMP next hops by (egress port canonical order, next hop
  u32); route batches in key order; DR election by (priority, router id u32); an `lsa-gen` due with `spf` runs first
  (D9).
- **ACL.** Evaluation in sequence order; rows keyed `family|list|seq` and written in evaluation order; log flows keyed
  and aggregated in first-seen order.
- **L2 hardening.** Bindings keyed `vlan|mac`; windows aligned to sim-time seconds; storm-control levels in integer
  hundredths of a percent [S16].
- **QoS.** `core/queueing.ts` is integer DRR and token buckets counted in bits, elapsed time capped at the bucket fill
  time so products stay below 2⁵³, remainders carried (no drift); class order = policy order; flows in first-seen
  order; traffic pacing integer.
- **Time.** BigInt only inside `contracts/clock.ts` helpers and NTP maths; delays stored as safe integers of ns;
  offsets as integer milliseconds plus a sub-millisecond ns remainder (a first sync of an unset clock is ≈ 1.6 × 10¹⁷
  ns, beyond 2⁵³); NTP timestamps as decimal strings in fields.
- **The grep ban** on `Math.log10|log|pow|exp` extends to `protocols/ospf*`, `core/ospf-*`, `core/queueing.ts`,
  `qos/`, [S20] `link/qos/`, [C1] `protocols/eigrp*`.
- **No module-level mutable state** in any P3 module (several simulations share one realm once replayers exist); every
  new registry is plain data or built lazily (rule 12).

### 4.6 How P1 and P2 worlds stay byte-identical

1. **Goldens** (D3): `accept.p2.p1-digests` (unchanged golden) and `accept.p3.p2-digests` (new golden), run at every
   wave end and inside every flip; only §9.3 / §9.4 rows may change them.
2. **Normalisation** (one rule, extended in W0, applied per device): before hashing, a device loses the StateView
   **and the owned tables** of every process it derives only through `CAPABILITY_PROCESSES` rows whose `since` is later
   than the golden's stage (so `udp`, `tcp` and `sockets` disappear from a managed switch, D22, while a router's `udp`
   stays), every table whose descriptor `since` is later than the golden's stage (the stage-filtered snooping tables,
   the empty OSPF, ACL, CDP, LLDP, NTP and API tables a home router derives through `routing`), the later-stage members
   of the model-derived lists (`capabilities`, `gui`, `allowedRoles`), and the P3 display member
   `PortSnapshot.txBacklog`. Applied to a snapshot of the unchanged engine it removes nothing, so no recorded golden
   changes. The P1 guard asserts that everything outside P1's vocabulary is `since` P2 or P3; the P2 guard, that
   everything outside `p2Vocabulary` is `since` P3.
3. **Silence** (§4.3), **the profile** (D2) and **dormancy** (D22): the new defaults — CDP, and with the approved
   [S24] and [S25] the timestamps lines and extended logging — exist only in P3 worlds; a managed switch's new transport
   answers nothing until a P3 service line is configured on it; [S13]'s hidden vty listeners on P1/P2 routers with
   `line vty` stay out of the tcp StateView.
4. **Conditional output.** The second `show ip route` legend line appears only with a routing process (D11); `show
   access-lists` adds ` (N matches)` only for rows with N > 0, and NAT-only lists are never counted (D12); the logger
   renderer keeps P1's debug prefix without the timestamps line [S24].
5. **Pins that move are listed** (§9): the P1 guard's `since` assertion, `BUILD_STAGES`/`DEFAULTS_PROFILES` arrays, the
   pdu registry order, the reserved dispatch entries, schema ids, help goldens, modes arrays, catalog summaries at the
   flip — each with its exact new value.

---

## 5. Canonical config lines and their consumers

The rules live in `cli/config-rules.ts` (`ConfigLineRule`). GUI panels and quick actions write exactly these lines.
"Identity" is the number of leading tokens that name the slot.

**Rule-table changes P3 needs first (W1 cli):**

- `router <protocol> <rest>` (`config-rules.ts:158-161`, identity 2, render slot `router`, mode `config-router`) keeps
  its identity: a second `router ospf <m>` is refused by the handler (`ospfOneProcess`), never stored as a second
  section. A `ROUTER_CHILD_ORDER` renders children as router-id, auto-cost, area, passive-interface, network,
  default-information, maximum-paths.
- `sequenced` (D12): ACL entry lines keep `ConfigNode.seq`; `access-list <n> …` lines are sequenced per list number
  (`{token: 1}`), `ip access-list … <name>` children per section; `ConfigAst.apply` places an entry by `seq` and
  renders without it.
- `cdp run` and `cdp enable` become `bothForms` (D2); `lldp run` is ordinary (off by default everywhere); `no lldp
  transmit|receive` are stored negations.
- `ip access-group <list> in|out` gets a per-direction slot (identity 3 counted as `ip access-group * <dir>`): the
  handler removes the same-direction line before storing (D12).
- `ip access-list standard|extended <number>` keeps P2's section storage (`config-rules.ts:280`, D12); the extended
  form gets the same section rule with mode `config-ext-nacl`.
- `username <n> privilege <0-15> secret <s>` is a new form of the existing `username` rule (`config-rules.ts:147-148`);
  the identity stays 2 and `secretToken` is 5. `userSecretOf` reads it (D14).
- `service-policy input|output <p>` is a per-direction slot. It is **not** a `PHY_CONFIG_KEYS` line in P3a
  (`device.ts:296-312`): policies compile lazily against the configuration generation (D16); [S20] adds it for
  physical scheduler ports.
- `bandwidth <kbps>` (`config-rules.ts:206`) keeps its rule; its grammar widens from serial ports (`grammar/serial.ts:72-81`,
  `portRequires: SERIAL_PORT`) to routed Ethernet ports and subinterfaces, so the OSPF cost lesson can use it (§9 W2),
  and [S18] to tunnel ports.
- **The approved items' rules** (W1 cli, each a delimited block): [C1] `router eigrp <as>` uses the same `router
  <protocol>` rule (so `router ospf 1` and `router eigrp 100` are different identity-2 slots), with its own child order
  (`eigrp router-id`, `metric weights`, `network`, `passive-interface`, `maximum-paths`) and the interface `delay` rule
  (identity 1); [S18] the Tunnel interface lines of §5.7 and [C13] the three `crypto …` sections (keyring with nested
  `peer` sections, profiles) and the two tunnel protection lines; [S19] the serial PPP lines and the global `username
  <n> password <pw>` form (identity 2, `secretToken` 3); [S20]/[S21] the queueing actions under `policy-map` / `class`
  and interface `fair-queue`, with `service-policy output` a `PHY_CONFIG_KEYS` line on physical ports; [S24]/[S25] the
  `logging …` lines and the identity-3 `service timestamps <kind>` rule; [S13] `transport input` (identity 2 under
  `line vty`) and `access-class` stay as M10 stores them.

### 5.1 Routing (OSPF, and [C1] EIGRP)

| Context | Line (identity) | Consumer |
|---|---|---|
| global | `router ospf <1-65535>` (section, mode `config-router`, 2; refused under `no ip routing`; a second process refused) | ospf |
| config-router | `router-id <a>` (1); `network <a> <wildcard> area <0-4294967295\|a.b.c.d>` (multi; the handler refuses the same address and wildcard in another area); `passive-interface <if>` (multi; stored negation while `passive-interface default` is set); `passive-interface default` (2); `auto-cost reference-bandwidth <1-4294967>` (Mb/s, 2); `default-information originate [always]` (2); `maximum-paths <1-4>` (1) | ospf |
| config-router | [S5] `area <a> authentication [message-digest]`; [C4] `area <a> stub\|nssa [no-summary]`; [C5] `area <a> range …`; [C6] `redistribute static\|connected subnets`; [C9] `timers throttle spf <s> <h> <m>` | ospf |
| interface | `ip ospf <pid> area <a>` (the handler replaces another pid's line); `ip ospf cost <1-65535>`; `ip ospf priority <0-255>`; `ip ospf hello-interval <1-65535>` (without a dead line the effective dead becomes 4 × hello); `ip ospf dead-interval <1-65535>`; `ip ospf network point-to-point\|broadcast` | ospf |
| interface | `bandwidth <kbps>` (the existing rule, `config-rules.ts:206`; its grammar widened from serial to routed Ethernet ports and subinterfaces; now also read by ospf for cost) | ospf, show |
| interface | [S5] `ip ospf authentication [message-digest\|null]`, `ip ospf authentication-key <k>` (secret), `ip ospf message-digest-key <1-255> md5 <k>` (multi, secret) | ospf |
| global | [S6] `ipv6 router ospf <pid>` (section, mode `config-rtr`) with `router-id`, `passive-interface`, `auto-cost reference-bandwidth`, `default-information originate`; interface `ipv6 ospf <pid> area <a>`, `ipv6 ospf cost\|priority\|hello-interval\|dead-interval\|network` | ospfv3 |
| global | [C1] `router eigrp <1-65535>` (section, mode `config-router-eigrp`, 2; one process; refused under `no ip routing`) | eigrp |
| config-router-eigrp | [C1] `network <a> [<wildcard>]` (multi; classful without a wildcard); `eigrp router-id <a>` (2); `passive-interface <if>` (multi) / `passive-interface default` (2); `metric weights 0 <k1> <k2> <k3> <k4> <k5>` (2); `maximum-paths <1-4>` (1); `no auto-summary` (accepted, not rendered; `auto-summary` refused with `eigrpAutoSummary`). Not in C1 (C2, P5): `variance`, `eigrp stub` | eigrp |
| interface | [C1] `delay <1-16777215>` (tens of µs; identity 1); `ip hello-interval eigrp <as> <1-65535>`; `ip hold-time eigrp <as> <1-65535>`; `bandwidth` (the existing rule, now also read by eigrp). Not in C1: `ip summary-address eigrp` (C2, P5) | eigrp, show |

### 5.2 ACLs and device access

| Context | Line (storage) | Consumer |
|---|---|---|
| global | `access-list <1-99\|1300-1999> permit\|deny any\|host A\|A [W] [log]` (multi, sequenced by list; NAT's reader ignores the trailing `log`, D12). Every ACL line of this table is offered on `routing` and `managed-switch` models (D14) | acl, nat |
| global | `access-list <100-199\|2000-2699> permit\|deny <proto> <src> [eq\|neq\|lt\|gt P\|range P P] <dst> [ports] [established] [<icmp-name>\|<type> [<code>]] [log]`; `access-list <n> remark <text>` | acl |
| global | `ip access-list standard\|extended <name\|number>` (section; a numbered section keeps P2's storage and joins the global `access-list N` lines of that number, global lines first), children `[<seq>] permit\|deny …`, `remark …`, `no <seq>`; `ip access-list resequence <list> <start> <step>` (not stored) | acl |
| interface (L3 roles only) | `ip access-group <list> in\|out` (one per direction; refused on switchports with `accessGroupSwitchport`) | ipv4 (hook), acl |
| line vty | `access-class <list> in` (stored, shown; enforced at every remote login by [S13]); `transport input ssh\|telnet\|ssh telnet\|all\|none` (the effective transport is `telnet ssh` when the line is absent; any value but `none` wakes a switch's dormant transport, D22); `login local` (exists) | vty [S13], show, grader, l3 (dormancy) |
| global | `ip domain-name <d>` (scope widened to `managed-switch`, D14); `crypto key generate rsa [general-keys] [modulus 360-4096]` (asks for the size when omitted; needs a non-default hostname and a domain name; wakes a switch's dormant transport, D22); `crypto key zeroize rsa`; `ip ssh version 1\|2`; `ip ssh time-out <s>`; `ip ssh authentication-retries <n>` | show, grader, [S13] vty, l3 (dormancy) |
| global | `username <n> [privilege <0-15>] secret <s>` (privilege is new; used by restconf; `userSecretOf` reads both forms for `login local`) | line auth, restconf |
| global | [S11] `ipv6 access-list <name>` (section) with `[sequence <n>] permit\|deny <proto> <src> … [log]`; interface `ipv6 traffic-filter <name> in\|out`; line vty `ipv6 access-class <name> in` | acl |
| interface | [S12] `no ip unreachables`; `log-input` and `dscp`/`precedence` match terms in extended entries | acl |
| global | [C10] `time-range <n>` (section) with `periodic …` / `absolute …` | acl |

### 5.3 Access-layer hardening

| Context | Line | Consumer |
|---|---|---|
| global | `ip dhcp snooping`; `ip dhcp snooping vlan <list>`; `no ip dhcp snooping verify mac-address`; `no ip dhcp snooping information option` (accepted and stored; no effect — option 82 is not inserted) | eth-switch |
| interface (switched) | `ip dhcp snooping trust`; `ip dhcp snooping limit rate <pps>` | eth-switch |
| global | `ip source binding <mac> vlan <v> <ip> interface <if>` (multi) | eth-switch |
| global | `ip arp inspection vlan <list>`; [S14] `ip arp inspection validate src-mac\|dst-mac\|ip`, `arp access-list <n>` + `ip arp inspection filter <n> vlan <list> [static]` | eth-switch |
| interface | `ip arp inspection trust`; `ip arp inspection limit rate <pps> [burst interval <s>]\|none` | eth-switch |
| interface | [S15] `ip verify source [port-security]`; [S16] `storm-control broadcast\|multicast\|unicast level [pps\|bps] <rise> [<fall>]`, `storm-control action shutdown\|trap` | eth-switch |
| global | `errdisable recovery cause dhcp-rate-limit\|arp-inspection` ([S16] `\|storm-control`) (appended choices) | eth-switch |

### 5.4 QoS and traffic

| Context | Line | Consumer |
|---|---|---|
| global | `class-map [match-all\|match-any] <n>` (section, mode `config-cmap`) with `match dscp <v…>`, `match ip precedence <v…>`, `match cos <v…>`, `match access-group <n>\|name <n>`, `match protocol ip\|icmp\|tcp\|udp`, `match input-interface <if>`, `match any` | runtime QoS reader |
| global | `policy-map <n>` (section, mode `config-pmap`), then `class <n>\|class-default` (mode `config-pmap-c`) with `set dscp <v>\|ip precedence <v>\|cos <v>` (M13); the approved [S20] `priority <kbps>\|percent <p>`, `bandwidth <kbps>\|percent <p>\|remaining percent <p>`, `queue-limit <n>`; [S21] `fair-queue` (class-default), `police <bps> [<bc>] conform-action transmit\|drop\|set-dscp-transmit <v> exceed-action …`, `shape average <bps> [<bc>]` | runtime QoS reader; [S20] link scheduler |
| interface | `service-policy input\|output <n>` (one per direction, on routed physical ports and subinterfaces; refused on SVIs and switchports with `qosPortUnsupported`). A policy with a queueing action attaches only as `output` (`qosQueueingOutputOnly`) on a routed physical port (`qosQueueingPhysicalOnly`) and within the 75 % admission (`qosAdmission`); marking and [S21] policing attach in either direction (D16). [S21] interface `fair-queue` (WFQ on the whole port) | runtime, [S20] link model |
| host shell (original syntax) | `flow start <dst> (rate <kbps>\|pps <n>) size <bytes> [dscp <v>] [port <p>] [count <n>\|for <s>]` (without `count` or `for` the flow is continuous and stops at the 300 s cap; a larger count or duration is refused with `trafficFlowCap`); `flow voice <dst> [g711] [dscp <v>]`; `flow stop <id>`; `flow show` | traffic |

### 5.5 Discovery and time

| Context | Line | Consumer |
|---|---|---|
| global | `cdp run` / `no cdp run` (`bothForms`; P3 invisible default on); `cdp timer <5-254>` (60); `cdp holdtime <10-255>` (180); `[no] cdp advertise-v2` | cdp |
| interface | `cdp enable` / `no cdp enable` (`bothForms`) | cdp |
| global | `lldp run`; `lldp timer <5-65534>` (30); `lldp holdtime <0-65535>` (120); `lldp reinit <2-5>` | lldp |
| interface | `no lldp transmit`; `no lldp receive` (stored negations) | lldp |
| global | `clock timezone <name> <±hours> [<minutes>]`; `ntp server <addr\|name> [prefer] [source <if>]` (multi); `ntp master [<1-15>]` (stratum 8 when omitted); `ntp source <if>` | runtime clock, ntp |
| exec | `clock set hh:mm:ss <day> <month> <year>` (not stored; the CLI sends `ntp.clockSet`, and ntp issues the `clock` action with source `user` and writes its `clock` row) | ntp, runtime |
| host shell (servers) | `service ntp on\|off` → `ntp master 1` / its removal | ntp |

### 5.6 Device API and data formats

| Context | Line | Consumer |
|---|---|---|
| global | `ip http secure-server`; `ip http authentication local`; `restconf` | restconf |
| global | `username <u> privilege 15 secret <s>` (§5.2) | restconf (Basic authentication) |
| host shell | `rest <GET\|HEAD\|POST\|PUT\|PATCH\|DELETE> <url> [-H "<name>: <value>"]… [-u <user>:<password>] [-d <body…>]` (a job; Ctrl+C aborts it; `-d` comes last and takes the rest of the line verbatim, so a JSON body is typed unquoted, D21; [S32] adds `-f <file>`) | http-client |

RESTCONF resources: `/.well-known/host-meta`, `/restconf`, `/restconf/data/<ietf-interfaces | ietf-ip | nf-native |
ietf-yang-library path>`, `/restconf/operations/nf-native:save-config`. Methods and status codes as D21.

### 5.7 SHOULD and COULD lines (carried from the area maps)

Approved (§8.5): [S19], [S18], [S24]/[S25], [S13], [S32], [C13] below, and [C1] in §5.1. The [S29], [S30], [S31], [S33],
[S34], [S36] and [C17] lines are designs for P3c and are never added to the P3a grammar.

- [C13] Global: `crypto ikev2 keyring <k>` (section, mode `config-ikev2-keyring`) with `peer <n>` (section, mode
  `config-ikev2-keyring-peer`) holding `address <a>` and `pre-shared-key <k>` (secret); `crypto ikev2 profile <p>`
  (section, mode `config-ikev2-profile`) with `match identity remote address <a> [<mask>]`, `authentication local
  pre-share`, `authentication remote pre-share`, `keyring local <k>`; `crypto ipsec profile <p>` (section, mode
  `config-ipsec-profile`) with `set ikev2-profile <p>`. Tunnel interface: `tunnel mode gre ip|ipsec ipv4` (`gre ip`,
  the default, is not rendered); `tunnel protection ipsec profile <p>` (IPsec mode only). Consumers: ike, gre (§2.17).
- [S19] Serial interface: `encapsulation hdlc|ppp`; `ppp authentication chap|pap|chap pap|pap chap`; `ppp pap
  sent-username <n> password <pw>`; `keepalive [<s>]` (LCP echo on ppp); `peer neighbor-route` / `no peer
  neighbor-route`. Global: `username <n> password <pw>` (new; the `nf7` form under `service password-encryption`).
- [S18] Tunnel interface: `interface Tunnel<n>`; `ip address`; `tunnel source <if|addr>`; `tunnel destination <addr>`;
  `tunnel mode gre ip` (default, not rendered); `ip mtu <n>`; `ip tcp adjust-mss <n>`; [S36] `ipv6 address …`; [C17]
  `keepalive <s> <n>`, `tunnel key <n>`.
- [S24] `logging buffered [<size>] [<lvl>]`, `logging console [<lvl>]` / `no logging console` (`bothForms`), `logging
  monitor [<lvl>]`, `service timestamps log|debug datetime [msec] [localtime] [show-timezone]|uptime` — with its own
  rule of identity 3 (`service timestamps <kind>`): the generic `service <name>` rule has identity 2
  (`config-rules.ts:144`), under which the `log` and `debug` lines would overwrite each other. [S25] `logging
  host <addr>` (multi; `logging <addr>` alias), `logging trap <0-7|keyword>` (default informational), `logging
  source-interface <if>`, `logging facility local0-7`; host shell `service syslog on|off` → `syslog-server enable`.
- [S29] `copy running-config|startup-config tftp:[//host/file]`, `copy tftp:[//host/file]
  running-config|startup-config|flash:[name]`, `copy running-config flash:<f>`, `dir [flash:|nvram:]`, `show flash:`,
  `show file systems`, `delete flash:<f>`, `tftp-server flash:<f>`; host shell `service tftp on|off`. [S30] `boot
  system flash:<img>`, image copies. [S31] `config-register 0x<hex>`; ROMMON `confreg`, `reset`, `boot`, `dir flash:`.
- [S33] `snmp-server community <s> [ro|rw] [<acl>]`, `snmp-server location|contact <text>`, `snmp-server host <addr>
  [traps] [version 1|2c] <community>`, `snmp-server enable traps snmp [linkdown] [linkup] [coldstart]`; host shell
  `snmpget|snmpwalk|snmpset <host> <community> <oid> [type value]`, `service snmptrap on|off`.
- [S34] `monitor session <1-66> source interface <if-list> [rx|tx|both]`, `… source vlan <v> [rx]`, `… destination
  interface <if> [encapsulation replicate]`, `no monitor session <n>`.
- [S13] exec `telnet <host> [<port>]`, `ssh -l <user> [-v 2] <host>` on routers, switches and host shells (jobs of
  vty-client; Ctrl+C sends `vty.interrupt`).
- [S32] dev-host shell: `python|python3 <file> [args]` (a job; Ctrl+C sends `script.stop`), `type <file>`, `del <file>`,
  `dir` (the host's `files:` store), and `rest … -f <file>` on every host shell.

### 5.8 Exec, show and debug (P3)

`show ip ospf`, `show ip ospf neighbor [detail]`, `show ip ospf interface [brief|<if>]`, `show ip ospf database
[router|network|external] [self-originate]`, `show ip protocols`, `show ip route ospf`, `clear ip ospf process`
(interactive, refused headless); `show access-lists [<n>]`, `show ip access-lists [<n>]`, `show ip interface [<if>]`,
`clear access-list counters [<n>]`; `show ip ssh`, `show ssh`, `show users`; `show ip dhcp snooping [binding]`, `show ip
arp inspection [vlan <l>|interfaces|statistics]`, `show errdisable recovery` (two more causes, from W2; [S16] a third); `show class-map
[<n>]`, `show policy-map [<n>]`, `show policy-map interface <if> [input|output]`; `show cdp`, `show cdp neighbors [<if>]
[detail]`, `show cdp entry <name|*>`, `show cdp interface [<if>]`, `show cdp traffic`, `clear cdp table|counters`,
`show lldp`, `show lldp neighbors [<if>] [detail]`, `show lldp entry <name|*>`, `show lldp interface`, `show lldp
traffic`, `clear lldp table`; `show clock [detail]`, `show ntp associations [detail]`, `show ntp status`; `show
restconf`. The approved items add their own: `show interfaces tunnel` and the Tunnel rows of `show ip interface
brief` [S18]; `show ppp interface` and the PPP lines of `show interfaces` [S19]; the queue lines of `show policy-map
interface` and `show interfaces` [S20]/[S21]; `show logging`, `clear logging`, `terminal monitor` [S24]/[S25]; the
remote sessions of `show users` and `show ssh` [S13]; `show ip eigrp neighbors|topology|interfaces`, `show ip route
eigrp`, `clear ip eigrp neighbors` [C1]; `show crypto ikev2 sa`, `show crypto ipsec sa` [C13]. All output wording is
original; RFC state words (FULL, DR, BDR, 2WAY, passive, active) are protocol facts and are kept.

**Debug categories (binding across the daemon and cli seam).** The CLI prints a debug event only when its `category`
is in the device's debug set (`cli/runtime.ts:1223-1226`), so each daemon passes exactly this string to `ctx.debug` and
`ctx.transition`:

| Daemon | Category string (= the `debug` tokens) |
|---|---|
| ospf | `ip ospf adj` (ISM and NSM transitions, elections), `ip ospf hello` (hellos and every refusal with its reason), `ip ospf flood` (LSU, LSR, LSAck; install and flush), `ip ospf spf` (runs, reasons, route changes), `ip ospf packet` (one line per packet) |
| acl | `ip access-list` (a NetForge extension: matches, log aggregation) |
| eth-switch, snooping and DAI messages only | `ip dhcp snooping`, `ip arp inspection` ([S16] `storm-control`) |
| cdp / lldp | `cdp packets`, `cdp events` / `lldp packets` |
| ntp | `ntp packets`, `ntp events` |
| restconf | `restconf` |
| traffic | `traffic` (a NetForge extension) |
| [S13] vty, vty-client | `ip ssh`, `telnet` |
| [S18] gre (both modes) | `tunnel` |
| [S19] ppp | `ppp negotiation`, `ppp authentication` |
| [S25] syslog-server / [S32] script-host | `syslog` / `script` |
| [C1] eigrp | `eigrp packets` (one line per packet sent or received), `eigrp fsm` (neighbour changes and DUAL: feasibility, local computations, active and passive) |
| [C13] ike | `crypto ikev2` (each message, the crossing rule, proofs accepted or refused, SA up and down) |

**Output shapes** (original wording; examples):

```
R1# show ip ospf neighbor
Neighbour ID     Pri  State            Dead in    Address        Interface
2.2.2.2            1  FULL/DR          00:00:34   10.0.123.2     GigabitEthernet0/0
3.3.3.3            1  FULL/DROTHER     00:00:31   10.0.123.3     GigabitEthernet0/0

R1# show ip ospf interface brief
Interface  Process  Area  Address/Mask     Cost  State  Neighbours full/total
Gi0/0      1        0     10.0.123.1/24    1     BDR    2/2
Se0/0/0    1        0     10.0.13.1/30     64    P2P    1/1
Lo0        1        0     1.1.1.1/32       1     LOOP   0/0

R1# show ip route
Route source codes: C - connected, L - local, S - static, * - candidate default route
Dynamic sources: O - OSPF, IA - OSPF inter area, E1/E2 - OSPF external type 1/2

O    10.3.0.0/24  via 10.0.12.2 [110/3] GigabitEthernet0/0
O*E2 0.0.0.0/0  via 10.0.12.2 [110/1] GigabitEthernet0/0

R1# show access-lists
Standard access list 10
    10 permit 192.168.10.0 0.0.0.255 (12 matches)
Extended access list NO-WEB-PC1
    10 deny tcp host 192.168.10.10 host 192.168.20.100 eq www log (4 matches)
    20 permit icmp 192.168.10.0 0.0.0.255 any (5 matches)
    30 permit ip any any (9 matches)

R1# show ip interface GigabitEthernet0/0
GigabitEthernet0/0 is up, line protocol is up
  Address 192.168.10.1/24, MTU 1500 bytes
  Helper addresses: none
  Inbound access list: NO-WEB-PC1
  Outbound access list: not set
  Unreachables: sent    Proxy ARP: on    NAT: not a NAT interface

SW1# show ip dhcp snooping binding
MAC address        IP address       Lease (s)  Kind     VLAN  Interface
00:50:79:66:68:00  192.168.10.11    86385      learned  10    FastEthernet0/1
1 binding

SW1# show ip arp inspection vlan 10
VLAN  Inspection  Forwarded  Dropped  No binding  Filter denied  Trusted ports
10    on          42         3        3           0              GigabitEthernet0/1

R1# show ntp status
Clock is synchronised, stratum 2, reference is 10.0.0.10

R1# show ip eigrp topology                                   ([C1], §3.12)
EIGRP topology, AS 100, router ID 10.0.13.1
Codes: P passive, A active, U update, Q query, R reply

P 10.4.0.0/24, 1 successor, FD 3328
        via 10.0.12.2 (3328/3072), GigabitEthernet0/0
        via 10.0.13.3 (28672/3072), GigabitEthernet0/1

R1# show crypto ikev2 sa                                     ([C13], §3.13)
Tunnel    Local            Remote           Role       State        Proposal
Tunnel0   209.165.200.225  209.165.200.230  initiator  established  aes-cbc-256 sha256 group14
```

The `show ip route` first line is P1's legend, byte for byte (`show.ts:320`); the second appears only with a routing
process. The implicit deny is never printed by `show access-lists`.

### 5.9 GUI panels and host shell

- **Traffic generator** (`desktop.traffic`, M13): a flow list (destination, rate or pps, size, DSCP, voice presets, count
  or duration; "until stopped" means at most 5 minutes), start/stop through `hostRequest traffic.start|stop`, and live
  delay, jitter and loss read from the receiver's `flows` rows.
- **Port inspector** (W3): a QoS line (input/output policy, per-class matched and marked counts from `PortSnapshot.qos`);
  the approved [S1] OSPF section (area, type, cost and its source, state, DR/BDR, neighbours and their states, the last
  refused hello), [S19] PPP and [S18] Tunnel sections (the Tunnel section shows [C13] protection, the SA state and the
  IP MTU), and the [S20] Policy section.
- **Services panel** (`inspector/ServicesPanel.tsx`): an NTP section (on/off writes `service ntp on|off`; stratum;
  clients served); the approved [S25] Syslog section with a message table. Every section writes the §5 lines through
  `configure`.
- **Device inspector overview**: the clock (`*` when unset, source, stratum), extrapolated in the web from
  `DeviceSnapshot.clock` and `now`.
- **Host shell**: `rest` and `flow` (above); [S13] `telnet`, `ssh`; [S32] `python` (NF-DEVHOST), `type`, `del`, `dir`.

---

## 6. Web file map

Every semantic encoding keeps a non-colour channel (glyph, letter, text or shape). Overlays never use dash patterns
(P2 D20). New canvas layers resolve cross-module references at call time (rule 12) and memoise per device object. New
desktop apps and concept tools are dynamic imports (D24). Tables render through `TablesView` and `TABLE_DESCRIPTORS`
with no code.

| Area | Files (`apps/web/src/…`) | Wave | Owner |
|---|---|---|---|
| Vocabulary: drop reasons (+2, and the approved `mtu-exceeded` [S18], `policed` [S20], `ipsec-no-sa` [C13]), protocols (`ospf` 'O', `ospf-lsa` 'OL', `cdp`, `lldp`, `ntp`, and the approved `telnet`, `ssh` [S13], `gre` [S18], `ppp`, `lcp`, `pap`, `chap`, `ipcp`, `ipv6cp` [S19], `syslog` [S25], `eigrp` 'EG' [C1], `esp` 'ES', `ikev2` 'IK' [C13]; unique letters; control frames use the hexagon shape of spec §9.1), FSM state lists (`ospf-if`, `ospf-nbr`, `ntp`, and `tunnel` [S18], `ppp-lcp`, `ppp-auth`, `ppp-ncp` [S19], `eigrp-nbr`, `eigrp-route` [C1], `ike` [C13]), lanes `mgmt` and `wan`, GUI panels `desktop.traffic` and [S32] `desktop.automation`, err-disable cause labels (+2), mutation reason `QosMark`, the capability label `programmable` [S32] | `vocab/{drops,protocols,fsm,lanes,categories,fields}.ts` stubs in W0; real labels in W1 | W0 / W1 | web-inspector (owner; the architect's W0 stubs are reviewed edits) |
| The other exhaustive records the W0 unions break: `PANEL_TAB` (`inspector/tabs.ts:87`) and `SURFACE_PANEL_TAB` (`shared/openDeviceSurface.ts:38`) gain `desktop.traffic` and [S32] `desktop.automation`; `REASON_ICON` and `REASON_LABEL` (`inspector/Provenance.tsx:72, :90`) gain `QosMark`; `DEFAULT_TIMELINE_LANES` (`store/store.ts:77`) gains `mgmt` and `wan`; [S2] `dock/registry.ts` (`DockStage` += `'P3'`, the hidden `routing` row) and `app/Dock.tsx` (a placeholder for `routing` until W4) | those files | W0 | web-inspector (tabs, surface, provenance) and web-shell (store, dock), as reviewed stub edits by the architect |
| One concept-tool list (`ConceptTool = ConceptToolId`; the markdown allowlist derived from registered tools) | `store/types.ts:62` (web-shell), `labs/markdown.ts:23` (web-learn), `concept/ConceptView.tsx` (`CONCEPT_TOOLS`, web-shell) | W0 | the named owners; the architect's W0 edits are reviewed edits |
| Web tests type-checked (check 3b); fixed worker counts | `tsconfig.test.json` (new), `vitest.config.ts` (new, merges `vite.config`), the 8 test-file type errors and the pending P1 fixture migration | W0 | architect |
| `worker.delta` independent of machine load | `test/worker.delta.test.ts` (fresh module per test, explicit drain helper, per-file timeout) | W0 | web-shell |
| Defaults profile in the web: `profileOfSnapshot` accepts P3; the "Classic defaults" chip for P1 only; File → "Use current defaults" enabled below latest with a `PROFILE_NOTES` hint (W1); the worker's upgrade calls the engine ladder `sim/defaults-upgrade.ts` (W2, after W1 sim ships it); `profileForCourse` from `Course.profile` then `LATEST_DEFAULTS_PROFILE`, in the course-flip change (W7) | `learn/course-profile.ts`, `app/StatusBar.tsx`, `app/FileMenu.tsx`, `bridge/worker/index.ts` (:348-360) | W1 / W2 / W7 | web-shell |
| Markdown code blocks: an optional display-only `lang` | `labs/markdown.ts`, the lesson renderer | W1 | web-learn |
| QoS overlay model (pure): FIFO stack per egress port from `PortSnapshot.txBacklog` (≤ 8 capsules from its frame summaries + `+k` from its depth, DSCP letters `EF`/`AF`/`BE`), cable load sleeve per direction from `outBytes` deltas (thickness ∝ utilisation, a % label when zoomed, an ok/warn/err ramp as the redundant channel); `store.ts`'s `reconcileInflight` is unchanged | `canvas/overlays/qos-model.ts` | W1 | web-canvas |
| QoS overlay layer, registry entry `qos`, keyboard outline text | `canvas/qos.ts`, `canvas/overlays/registry.ts`, `canvas/scene.ts`, `canvas/Canvas.tsx`, `canvas/a11y/CanvasOutline.tsx` | W3 | web-canvas |
| Topology overlay slice `topoOverlays.qos` and the approved `ospf`/`ospfArea` [S1], `wan` [S18]/[S19], `eigrp`/`eigrpPrefix` [C1] (persisted, defaults false/null, one persisted-slice migration) and their View-menu entries; [S2] the `routingUi` slice (not persisted) | `store/{types,store,persist}.ts`, `app/TopBar.tsx` | W2 | web-shell |
| [S2] The `routing` dock tab shown: `DOCK_STAGE` `'P3'`, `app/Dock.tsx` maps `routing` to the lazy `routing/LinkStatePanel.tsx`, the hotkey migration (§9.2 item 36b) | `dock/registry.ts`, `app/Dock.tsx` | W4 | web-shell |
| Drop markers read `rule` when present (`ACL NO-WEB-PC1 #10`) | `canvas/markers.ts` | W3 | web-canvas |
| Packet inspector: the protected banner generalised from DTLS to `protectedBy` (TLS, simulated; and the approved [S13] SSH, [C13] "Encrypted (ESP, simulated)" and "Protected (IKE, simulated)"); `QosMark`, [C13] `Encrypt`/`Decrypt` provenance chips | `inspector/PacketInspector.tsx` (:263-280), `inspector/Provenance.tsx` | W3 | web-inspector |
| Port inspector QoS line (policies, per-class matched and marked from `PortSnapshot.qos`); device overview clock (`*` when unset, source, stratum, extrapolated from `DeviceSnapshot.clock` and `now`); Services panel NTP section | `inspector/{PortInspector,ServicesPanel}.tsx`, the device overview component, `gui/commands.ts` | W3 | web-inspector |
| Queueing sandbox concept tool (FIFO, WFQ as flow DRR, CBWFQ, LLQ over synthetic arrivals, driven by `core/queueing.ts` from `@netforge/engine/pure`; step and play; every packet's wait as text) | `concept/queueing/{model.ts,QueueingTool.tsx}` | W2 (model, after W1 core) / W3 (tool) | web-concept |
| Data-formats playground (JSON, YAML, XML editors; parse errors with line and column; tree with key paths; conversion; a "which type / which key" practice generator; a sample library of the JSON the devices return); lesson 37's concept tool (no lab) | `concept/data-formats/{model.ts,DataFormatsTool.tsx}` | W2 (after W1 auto) / W3 | web-concept |
| Traffic generator desktop app (flows list, presets, live delay/jitter/loss from `flows` rows) | `desktop/apps/TrafficApp.tsx`, registration (`desktop/DesktopTab.tsx:22`), `vocab/categories.ts` (`GUI_PANEL_VOCAB`) | W3 | web-desktop |
| Labs browser and File menu: `ccna3-lab` under "Labs: CCNA 3" (from W5, when the labs join `SCENARIOS`; `groupScenarios` would otherwise append the group unlabelled, `filemenu.groups.test.ts:29-35`) | `labs/LabBrowser.tsx`, `app/FileMenu.tsx` (`CATEGORY_ORDER`) | W5 | web-shell |
| Landing: CCNA 3 available; the next planned card (§8.5) | `learn/Landing.tsx` data path, `curriculum` data | W7 | web-learn |
| [S1] OSPF overlay (adjacency underlay per link from both ends' rows: thick when FULL, thin + `2W` chip, pulsing `IN`/`XS`/`XC`/`LD` chips static under reduced motion; `DR`/`BDR` letters at LAN port anchors; cost chips `c64`; `P` for passive; `!` with the refusal reason; the draining bar while Waiting; translucent area zones with `Area 0` chips; no dashes) and the port inspector's OSPF section | `canvas/overlays/ospf-model.ts` (W1), `canvas/ospf.ts` (W3), `inspector/OspfSection.tsx` (W3) | W1 / W3 | web-canvas, web-inspector |
| [S2] LSDB browser: dock tab `routing` ("Link state"): router and area pickers, LSA list (live age, hex sequence, self and MaxAge marks), LSA detail ("the same in every router of this area: yes/no", "show the packets that carried it"), LSDB graph (routers at canvas positions, transit networks at the centroid of their routers) | `routing/{LinkStatePanel,LsaList,LsaDetail,LsdbGraph}.tsx`, `routing/lsdb-model.ts` (the store slice is web-shell's W2 row, the dock wiring its W4 row) | W3 | web-routing (new) |
| [S3] SPF stepper (first / back / step / play / last; tentative-list table; a live-region sentence per step) and the canvas `spf` layer (settled rings, cost chips, tree underlay on the real cables) | `routing/SpfStepper.tsx`, `canvas/overlays/spf-model.ts`, `canvas/spf.ts` | W3 | web-routing, web-canvas |
| [C1] EIGRP overlay (for the prefix chosen in the View menu: successor links as a thick underlay with an `S` chip, feasible successors medium with `FS`, the live inequality text `RD 3072 < FD 3328` at the router, `A` while active; no dashes) | `canvas/overlays/eigrp-model.ts` (W1), `canvas/eigrp.ts` and its registry entry (W3) | W1 / W3 | web-canvas |
| [S9] Wildcard visualizer (32-bit Address/Wildcard/Result rows, must-match bits solid, any-bits hatched with `*`; count, range, pattern sentence; test an address; build from a prefix, a range (`rangeToAces`) or a bit pattern; seeded practice) | `concept/wildcard/{model.ts,WildcardTool.tsx}` | W2 (after W1 core) / W3 | web-concept |
| [S13] Terminal remote session: a "remote: R1 via SSH" chip from `CliSessionView.remote`, the remote prompt, masked input on `WILL ECHO` or a local SSH password prompt | `terminal/*` | W3 | web-shell |
| [S18]/[S19] WAN overlay (PPP phase rail D·E·A·N per cable end, `N ✓ 10.1.1.2`, a crossed `A` on failure; tunnel as a hollow tube on `airArc` labelled `Tu0 GRE 172.16.0.0/30` — [C13] `Tu0 IPsec` with a lock glyph and the SA state word, `ipsec` legs pulsing as spec §9.1 asks, static under reduced motion — a `G` badge on GRE legs); PPP and Tunnel port-inspector sections (the Tunnel section shows the mode, [C13] the protection profile, the SA state and the IP MTU) | `canvas/overlays/wan-model.ts` (W1), `canvas/wan.ts` (W3), `inspector/{PppSection,TunnelSection}.tsx` (W3) | W1 / W3 | web-canvas, web-inspector |
| [S20] Per-class queue lanes (priority lane nearest the cable, `P` badge), drop tags (`queue full · class-default`, [S21] `policed`), the "waited 41 ms in VOICE (priority)" chip from `frameQueued` → `frameTx`, the Policy section with per-class bars and a 30-second sparkline | `canvas/qos.ts`, `inspector/PolicySection.tsx` | W3 | web-canvas, web-inspector |
| [S24]/[S25] Logging: Services-panel Syslog section with a severity-filtered message table (number and name; received stamp beside the message stamp) | `inspector/ServicesPanel.tsx` | W3 | web-inspector |
| [S32] Automation workspace (the `files:` list from `DeviceSnapshot.storage`, a textarea editor with a gutter and an overlay highlighter from the pure NF-Py tokenizer, live syntax marks, Run/Stop, output and traceback panes, a "Requests" list linking to NetScope) | `automation/{AutomationWorkspace,CodeEditor,py-highlight}.tsx` | W6 | web-desktop |

**Designs for P3c (not approved, §8.5; no wave item in P3a)** — kept here so a later approval needs no new design:

| Area | Files (`apps/web/src/…`) | Owner if approved |
|---|---|---|
| [S7] Path-to-destination overlay (next hop per routing device from its RIB LPM, `↻` for a loop, `∅` for a black hole; `core/lpm` exported through pure) | `canvas/overlays/route-path-model.ts`, `canvas/route-path.ts` | web-canvas |
| [S10] ACL workbench: `AclView` for the `acl` table (per list header, seq, action glyph and word, entry, matches with a log-scaled bar, last match with a link to the packet, implicit rows in italics), "Test a packet" first-match walk from `evaluateAcl`'s trail, the inspector's "Why it stopped here" box with [Show the rule] / [Show the configuration line] / [Test this packet], "✓ permitted by …" provenance chips | `inspector/AclView.tsx`, `inspector/{PacketInspector,Provenance}.tsx` | web-inspector |
| [S23] Lint badges and placement advisor / impact preview in `AclView` | `inspector/AclView.tsx`, `inspector/acl-advisor.ts` | web-inspector |
| [S22] WAN and VPN concept visualizer (topologies, leased line, Metro Ethernet, MPLS label push/swap/pop, broadband, VPN types) | `concept/wan/*` | web-concept |
| [S26] Neighbours overlay (a chip at each link end `R1 · Gi0/0 · R` with the holdtime ring; a hollow glyph where a device runs CDP/LLDP but has no entry; protocol selector; "map from here" dims what neighbour tables cannot reach) | `canvas/overlays/neighbours-model.ts`, `canvas/neighbours.ts` | web-canvas |
| [S27] API client (method, URL with RESTCONF path helpers, headers with a Basic-auth builder, JSON body checked by the pure parser, phase ladder like the browser app, status meaning in words, pretty JSON tree; always text, never HTML) | `desktop/apps/ApiClientApp.tsx` | web-desktop |
| [S28] YANG browser (tree, keys, types, config true/false; RESTCONF URL, a sample body and the CLI lines each node maps to; "open in the API client from <host>") | `concept/yang/*` | web-concept |
| [S31] "Send break" button and Ctrl+Break on console sessions | `terminal/*`, `bridge/protocol.ts` | web-shell |
| [S33] SNMP manager app; [S34] "capture the SPAN destination" shortcut | `desktop/apps/SnmpManagerApp.tsx`, `capture/*` | web-desktop, web-inspector |

The MUST plan adds no dock tab; the approved [S2] adds `routing`, registered hidden in W0 and shown in W4, which moves
`DOCK_STAGE` and the hotkey pins (`hotkeys.test.ts:141-143, 155-157`; §9.2 item 36b, W4). `docs/CATALOG.md` (with the
fidelity table, §12.2) has one editor, the architect, who collects the rows from the wave reports; no implementer edits
it.

---

## 7. Module map and build waves

Owners are agents; each file has exactly one. Each item lists **owner — files — delivers — tests**; tests named here are
the owner's own (rule 9) and depend only on earlier waves or the owner's own item: **no item depends on work of its own
wave or a later one** (P2 §13 #42; P3 review P4, P5). A bracketed item (**[Sn]**, **[Cn]**) is its own item with its
own files or clearly delimited functions (a `// [Sn]` block) and its own tests; it exists only when §8.5 approves it.
§8.5 approved S1, S2, S3, S9, S13, S18, S19, S20, S21, S24, S25, S32, S37, C1 and C13: their items are placed below
by the same rule (each depends only on earlier waves, and a pair of same-wave items that meet at a seam test against a
fake of the other, the integration being a W4 acceptance row). Unapproved items have no wave item in P3a. Items marked
⚑ are byte-risky and also run the digest shards (rule 9). Every wave ends with review → adversarial verify
→ fix (rule 8); then the lead runs the six checks, the digest goldens and gate G (rules 9, 10, 15). Adversarial verify
from W1 on uses `test/staged.world.ts` (rule 13). Wave commits go to the `p3` branch only (rule 21).

New owners in P3a: **ospf**, **acl**, **qos**, **disc** (cdp, lldp), **http** (http-client, restconf), **auto**
(`automation/`), and, for the approved items, **wan** ([S18], [S19], [C13]: `protocols/{gre,ppp,ike}.ts`,
`protocols/{ppp,ike}/*`, `core/md5.ts`, `sim/lab-checks/wan.ts`, `sim/scenarios/ccna3/vpn.ts`), **eigrp** ([C1]:
`protocols/eigrp.ts`, `protocols/eigrp/*`, `sim/lab-checks/eigrp.ts`, `sim/scenarios/ccna3/eigrp.ts`) and
**web-routing** ([S2], [S3]). Existing owners keep their P2 files (pdu, core, device, media, catalog, cli, l2, l3, nat,
svc, sim, io, qa, course, capture, web-shell, web-canvas, web-inspector, web-learn, web-concept, web-desktop).

**Files with one owner and named reviewed edits by others** (rule 18; P3 review P21):

| File | Owner | Reviewed additive edits by others |
|---|---|---|
| `contracts/*`, `packages/engine/src/index.ts` | architect | the pre-approved contract edits named below: W2 cli (`MODES` `reserved` flags), W2 l2 (`ERR_DISABLE_CAUSES`), the W4 flip (`PROCESS_ORDER`, `CAPABILITY_PROCESSES`, `STAGED_PROCESS_TABLES`), the W7 course flip (`LATEST_DEFAULTS_PROFILE`) |
| `device/catalog/define.ts` | catalog | architect W0 (`GUI_PANEL_SINCE`, the panel `want` record) |
| `device/device.ts` | device | architect W0 (`ERR_DISABLE_CAUSE_TEXT` stub); [S18] `virtualChanged` and [S24] `emitLog` are **device**-owned bracketed items |
| `sim/lab-checks.ts` | sim | architect W0 (stub cases in the switch at :1137) |
| `sim/lab-checks/<area>.ts` | the area: `ospf.ts` ospf, `acl.ts` acl, `hardening.ts` l2, `qos.ts` qos, `discovery.ts` disc, `time.ts` svc, `automation.ts` http, and for the approved items `eigrp.ts` eigrp ([C1]), `wan.ts` wan ([S18], [S19], [C13]) | — (sim owns `registry.ts`, `core.ts`, `switching.ts`, `routing.ts`, `facts.ts` and reviews the adapters) |
| `protocols/hdlc.ts` | l2l3 (its P1 owner, ARCHITECTURE-P1 §7) | wan [S19] (the encapsulation switch in `onConfig`, a strict no-op when the effective encapsulation does not change) |
| `protocols/{arp,ipv4,ip-upper,icmpv4,nd}.ts` | l3 | — (the approved items' rows and branches are **l3**-owned bracketed items: [S18], [S19], [C1], [C13], [S13]/[S25] dormancy entries) |
| `protocols/tcp.ts`, `protocols/udp.ts` | svc | — ([S13]'s hidden listeners are an **svc** bracketed item) |
| `protocols/acl.ts` | acl | — ([S13]'s `acl.check` is a delimited block of the W2 acl item) |
| `protocols/gre.ts` | wan | — ([C13]'s ipsec mode is a **wan** bracketed item, W3) |
| `dock/registry.ts`, `app/Dock.tsx` | web-shell | architect W0 ([S2] stubs) |
| `timeline/lanes.ts` | sim | architect W0 (the final P3 entries of §2.12) |
| `sim/simulation.ts` | sim | — ([S25]'s log branch at :359 is a **sim**-owned bracketed item) |
| `protocols/nat.ts` | nat | — ([S12]'s extended lists for NAT are a **nat**-owned bracketed item) |
| `link/media/p2p.ts` | media | — ([S20]'s held queue is a **media**-owned bracketed item; qos owns `link/qos/scheduler.ts`) |
| pdu registry and dispatch table | pdu | each codec item's registry and dispatch lines (rule 18) |
| `curriculum/index.ts` | course | — |
| `sim/scenarios/ccna3/<area>.ts` | the area (§11.2): `ospf.ts` ospf, `eigrp.ts` eigrp, `acl.ts` acl, `hardening.ts` l2, `wan.ts` and `troubleshooting.ts` course, `vpn.ts` wan, `qos.ts` qos, `discovery.ts` disc, `time.ts` svc, `automation.ts` auto | — (an approved item's tasks inside a MUST lab are added by that lab file's owner, W5) |
| `apps/web/src/vocab/*`, `inspector/tabs.ts`, `shared/openDeviceSurface.ts`, `inspector/Provenance.tsx` | web-inspector | architect W0 stubs |
| `apps/web/src/store/{types,store}.ts`, `concept/ConceptView.tsx` | web-shell | architect W0 stubs |
| `apps/web/src/labs/markdown.ts` | web-learn | architect W0 (`ConceptToolId` allowlist) |
| `test/port.fixtures.ts`, `test/accept.p2.p1-digests.test.ts`, `test/accept.p2.coverage.test.ts` | architect | — |
| `test/staged.world.ts`, `test/inject.ts` | qa | — |
| `cli.port-security.test.ts` | cli | W2 l2 (the `show errdisable recovery` migration its change forces, §9 W2) |

### W0 — decisions, goldens first, contracts, engineering health (architect)

- **product owner** — the §8.5 decision record.
- **architect, first, before any engine change** — record from commit 5263f16 unchanged (D3):
  `test/goldens/p2-profile-digests.json` (with `test/p2-digests.harness.ts` and the four shards
  `accept.p3.p2-digests-templates`, `-labs-a`, `-labs-b` and `-guards`, the last holding the two synthetic D22 guard
  worlds), `test/goldens/p2-lab-exports.json` (with `accept.p3.p2-exports.test.ts`) and
  `test/goldens/lab-status.p2.json` (with `accept.p3.lab-status.test.ts`).
- **architect** — every contract file of §2: the MUST blocks and the blocks of every item approved in §8.5 (S1, S2,
  S3, S9, S13, S18, S19, S20, S21, S24, S25, S32, S37; C1 and C13 from §2.16 and §2.17), **types, unions and constants
  only** (rule 3); `packages/engine/src/index.ts`; this document; the compile stubs of §9 W0 item 1 (engine
  `ERR_DISABLE_CAUSE_TEXT`, `TABLE_DESCRIPTORS`, `timeline/lanes.ts` with its final P3 entries, `GUI_PANEL_SINCE` and
  the panel `want` record in `define.ts`; web `vocab/*`, err-disable labels, the concept registry, `PANEL_TAB`,
  `SURFACE_PANEL_TAB`, `REASON_ICON`/`REASON_LABEL`, `DEFAULT_TIMELINE_LANES`, the [S2] dock stubs); stub cases for the new
  `LabAssertion` kinds in the existing switch of `sim/lab-checks.ts` (:1137; one "not available in this build" detail
  each; W1 sim moves them into the registry); the `P3_CTX` / `P3_DEVICE` spreads in `test/port.fixtures.ts`;
  `ConceptToolId` and its three consumers; `customChecks` marked `@deprecated`; the P1-guard migration in
  `accept.p2.p1-digests.test.ts` (§9 W0 item 3); the coverage-test migration (§9 W0 item 8); the approved-item list of
  `accept.p3.coverage` (the exact array of §8.5 P1 and P2, §10.1).
- **architect (health, P2 §14)** — `apps/web/tsconfig.test.json` (src + test, types `vite/client` and `node`) with the 8
  type errors fixed and the pending web fixture migration finished (check 3b); `apps/web/vitest.config.ts` (fixed
  `maxWorkers`); engine vitest projects `fast` and `slow` (`slow` = `accept.p2.loop-storm-bounded`, the replay-exact
  shards, the digest tests).
- **course** — `curriculum/index.ts`: `profile` on `ccna1` ('P1'), `ccna2` ('P2') and `ccna3` ('P3', still `planned`)
  as data; nothing reads it until W7 (D2).
- **qa** — `test/staged.world.ts` (`createStagedSimulation`) with the P3 test-only data of rule 13 (the final
  `PROCESS_ORDER` restricted to approved names, the P3 `CAPABILITY_PROCESSES` rows including the approved items' rows
  of §2.1, the stage-filtered snooping tables, and a test-only NF-DEVHOST with `host` + `programmable` for [S32] until
  the W6 flip), `createP2Simulation` kept as a wrapper; the `@deprecated` aliases of `test/p2.world.ts` deleted and their
  importers (`cli.wlc.test.ts`, `device.catalog.p2.test.ts` and `p2.world.ts` itself) moved to the real names with
  assertions unchanged; `accept.p2.replay-exact` sharded by category into `accept.p2.replay-exact-templates`,
  `-ccna1` and `-ccna2` (assertions unchanged). Tests `staged.world.test.ts` (at stage P3 an NF-C2960 derives the
  §2.1 rows and the snooping tables, NF-WLC-9800 does not; at stage P2 the helper equals `createP2Simulation`).
- **web-shell** — the `worker.delta` fix.
- Six checks green; no behaviour change. **Behaviour-neutral W0:** `'P3'` is added to `BuildStage` and
  `DefaultsProfile` with no user; `LATEST_DEFAULTS_PROFILE` is `'P2'`; `PROCESS_ORDER`, `CAPABILITY_PROCESSES`,
  `PROCESS_TABLES`, `ERR_DISABLE_CAUSES` and the registry are untouched (rule 3); `Course.profile` is data nobody
  reads.

### W1 — pure foundations, runtime plumbing, the L3 plumbing OSPF needs

- **pdu** — `pdu/codecs/{ospf,cdp,lldp,ntp}.ts` (the `ospf-lsa` layer lives in `ospf.ts`), Fletcher in
  `pdu/checksum.ts`, registry and dispatch lines, `ntp` un-reserved, `tcp.port 443 → http`. Tests
  `pdu.codecs.p3.test.ts` (golden bytes: a hello, a DBD and an LSAck whose LSA headers carry the full LSA's checksum
  and length, an LSU carrying a router and a network LSA with Fletcher vectors; an NF CDP frame; an IEEE LLDP frame
  with chassis subtype 4, port subtype 5, TTL 120 and the end TLV; NTP mode 3 and mode 4 packets, and a stratum-16
  leap-3 reply), the §9 W1 pdu migrations.
- **core** — `core/ospf-spf.ts`, `core/ospf-lsa.ts`, `core/acl.ts` (extended matcher, `evaluateAcl` trail,
  `rangeToAces`, `lintAcl`; `readStandardAcls` ignores a trailing `log`), `core/queueing.ts` (FIFO, flow DRR, class
  DRR, strict priority with a conditional token-bucket policer, integer); `pure.ts` exports. Tests
  `core.ospf-spf.test.ts` (RFC examples, the §16.1 step (3) tie order, ECMP, the bidirectional check),
  `core.ospf-lsa.test.ts`, `core.acl.extended.test.ts` (the standard cases of `core.acl.test.ts` unchanged, `:35`
  included; a NAT list with a `log` entry keeps it), `core.queueing.test.ts` (DRR ratio 2:1 ± 5 %, PQ bound, no drift
  over 10⁶ packets).
- **ospf** (new) — `protocols/ospf/{config,ism,dr,hello-check,cost}.ts` (pure). Tests `ospf.dr.test.ts` (priority 0;
  a late higher router id stays DROther; BackupSeen from a neighbour that declares itself BDR and not from one that
  declares itself DR with a BDR present; §3.1 step 4's Waiting → DROther → Backup reruns), `ospf.hello-check.test.ts`,
  `ospf.cost.test.ts` (reference 1000: GigE 1, FastE 10; serial 64).
- **l2** — `protocols/l2/control.ts` (rows `cdp`, `lldp`; `classifyControl` for the NF CDP PID and for LLDP),
  `protocols/l2/{dhcp-snooping,arp-inspection,rate-window}.ts` (pure). Tests `l2.control.p3.test.ts`,
  `l2.dhcp-snooping.test.ts`, `l2.arp-inspection.test.ts`, `l2.rate-window.test.ts`; the §9 W1 l2 migrations
  (`l2.control.test.ts:68`, `l2.eth-switch.vlan.test.ts:187-193`).
- **auto** (new) — `automation/data/{json,yaml,xml}.ts` (pure parsers with positions), `automation/yang/{model,path}.ts`
  (the IETF subset and `nf-native`, the RESTCONF path parser). Tests `automation.data.test.ts` (round trips, error line
  and column), `automation.yang.test.ts` (every node's lines parse in `GRAMMAR`; no vendor module name).
- **device** — `device/device.ts` and `device/process-ctx.ts`: drop `rule` passthrough, `aclDenies`, clock state with
  `ctx.clock()` and `CommandCtx.clock()`, the `clock` action, the `configure` action (it only schedules
  `deviceConfigure` through `deps.scheduler`), the `origin` parameter of `applyConfigLine` copied into `configChange`.
  Spreads `P3_CTX` / `P3_DEVICE` into the typed fakes §9 W1 lists. Tests `device.clock.test.ts`,
  `device.drop-rule.test.ts`, `device.configure-action.test.ts` (the event is scheduled at now, non-periodic, never
  applied inline; `applyConfigLine` with an origin stamps it on `configChange`).
- **cli** — `cli/config-rules.ts` (§5 rules and changes), `cli/config-ast.ts` (`sequenced`, `seq`), `cli/modes.ts`
  (refinement of `config-router` to `ospf` entries), `cli/parser.ts` (area as integer or dotted; ACL port names and ICMP
  names), the headless session of `configure` keeping `ConfigureOptions.origin` and passing it to `applyConfigLine`.
  Tests `config-ast.p3.test.ts` (sequencing, insert 15, `no 20`, renumbering on replay; a numbered section joining the
  global lines of its number; the access-group and service-policy slots; `cdp run` both forms; `username … privilege 15
  secret …` with `secretToken` 5), `cli.parser.args.p3.test.ts`, `cli.configure-origin.test.ts`.
- **catalog** — `device/catalog/define.ts` (`cdpDefault` by the D2 rule). Tests `device.catalog.define.p3.test.ts`
  (with `defineModel(…, 'P3')`: NF-2911, NF-C2960, NF-C3650-24 and NF-WLC-9800 true; NF-AP-1832, a home router and a PC
  false).
- **io** — `io/{schema,migrate,netforge-file}.ts` (schema 1.3, `schemaIdFor`). Tests `io.schema.p3.test.ts` (P1 exports
  1.1, P2 1.2, P3 1.3, byte-identically; a 1.2 document carrying `'P3'` is refused; 1.2 → 1.3 identity), §9 W1 io
  migrations.
- **l3** ⚑ — `protocols/arp.ts:178` (`ctx.profile !== 'P2'` → `!profileIncludes(ctx.profile, 'P2')`: otherwise proxy ARP
  switches off in P3 worlds); **the OSPF plumbing** (moved from W2, so the W2 ospf tests depend on an earlier wave):
  `protocols/{arp,ipv4,ip-upper}.ts` — the IPv4-multicast framing rule, `IPV4_UPPER` 89, `ipv4.routes`,
  `ipv4.ribWatch` / `ipv4.ribChanged` with `keys` and `lpm`, multipath for `'O'`, `routeCause` for OSPF; **the dormant
  switch transport** of D22 (`DORMANT_TRANSPORT_OWNERS`). Tests: a delimited case in `ip.proxy-arp.test.ts` (on in
  P3), `ip.ospf-plumbing.test.ts` (slot re-offer = one tableWrite; ECMP; batch order; an lpm watch answered at once and
  on change), `arp.multicast.test.ts`, `ip.switch-transport.test.ts` (on `staged.world` at stage P3: a switch SVI
  answers a unicast datagram with 3/2 and a SYN with ICMP until `ntp server` is stored, then 3/3 and RST; removing the
  line restores 3/2; the DHCP broadcast still dies in ipv4 while dormant). `ip.ipv4.test.ts:403-409` unchanged (no
  new selector).
- **svc** — `protocols/tcp.ts`: the `tls` flag and the `admin-prohibited` soft error (moved from W2, so W2 http can use
  them). Tests `l4.tls-flag.test.ts`, `l4.admin-prohibited.test.ts`.
- **sim** — the profile sweep (`sim/simulation.ts:798`, `sim/snapshot-cache.ts:453`, `sim/scenarios/kit.ts:110`),
  `sim/defaults-upgrade.ts` (carrying the cases of `worker.profile.test.ts:195-264` as engine cases), the
  `deviceConfigure` event handler (the one caller of `cliCore.configure`, D21); **the grader split**:
  `sim/lab-checks/{registry,core,switching,routing,facts}.ts` (P1/P2 checkers moved verbatim; the envelope; the
  neighbour, fact and identity frameworks), proven by `accept.p3.lab-status`. Tests `sim.profile.p3.test.ts`,
  `sim.defaults-upgrade.test.ts`, `sim.configure-event.test.ts` (against a fake runtime that issues the action: the
  handler runs in its own dispatch with its own budget and delivers `config.result`),
  `sim.lab-checks.registry.test.ts` (exhaustive; stub details).
- **qa** — `test/inject.ts`: `injectFrames(sim, {from, port, frames, count, spacingNs})`, backed by a test-only
  `injector` daemon that `staged.world` registers through its `factories` on a test host model; it sends pre-built
  frames (DHCP server messages, ARPs) out of its port at a fixed spacing, so the snooping and DAI rate limits, which no
  MUST sender can trigger, are testable (D13). Tests `inject.test.ts`.
- **course** — `curriculum/ccna3/{lessons,objectives}.ts`, **detached** from `curriculum/index.ts` until W7. Tests
  `curriculum.ccna3.test.ts` (ids as §11.1, ≤ 45 min, every lab reachable from exactly one lesson, every objective has a
  row with a `handsOn` value of §11.4).
- **web-inspector** — `vocab/*` real entries. Tests `vocab.test.ts` (exhaustive, unique letters, no banned words).
- **web-canvas** — `canvas/overlays/qos-model.ts` (reads `PortSnapshot.txBacklog` and port counters); [S1]
  `canvas/overlays/ospf-model.ts`. Tests `overlays.qos-model.test.ts`; [S1] `overlays.ospf-model.test.ts`.
- **web-shell** — `profileOfSnapshot` accepts `'P3'`; the "Classic defaults" chip stays P1-only; File → "Use current
  defaults" enabled whenever the profile is below `LATEST_DEFAULTS_PROFILE` (still `'P2'`, so for P1 worlds only, as
  today) with a `PROFILE_NOTES` hint; `profileForCourse` unchanged (D2). Tests `app.profile-notes.test.ts`;
  `learn.course-profile.test.ts` unchanged.
- **web-learn** — the markdown `lang`. Tests `labs.markdown.lang.test.ts`.

**Approved items in W1** (each its own item and tests; they depend only on W0):

- **pdu** — [S13] `pdu/codecs/{telnet,ssh}.ts` (22 and 23 un-reserved); [S18] `gre.ts` (`ipproto 47`, `LINK_FIELDS`);
  [S19] `{ppp,lcp,pap,chap,ipcp,ipv6cp}.ts` (the `ppp.proto` space; the RFC 1994 CHAP vector); [S25] `syslog.ts` (514
  un-reserved); [C1] `eigrp.ts` (`ipproto 88`); [C13] `{esp,ikev2}.ts` (`ipproto 50`, `udp.port 500`). Each with its
  registry and dispatch lines (rule 18) and golden-byte tests `pdu.codecs.{telnet-ssh,gre,ppp,syslog,eigrp,ipsec}.test.ts`
  (§2.16, §2.17 name the cases).
- **wan** (new) — [S19] `core/md5.ts` (RFC 1321 vectors) and `protocols/ppp/fsm.ts` (the RFC 1661 table as tests);
  [C13] `protocols/ike/{exchange,proof}.ts` (pure: the four messages, the FNV proof, the SPI and nonce derivation, the
  crossing rule). Tests `core.md5.test.ts`, `ppp.fsm.test.ts`, `ike.exchange.test.ts` (at the field level: the bytes
  are the W1 pdu item's, so no test here needs the codec).
- **eigrp** (new) — [C1] `protocols/eigrp/{config,metric,dual}.ts` (pure: the configuration reader with classful
  networks, the integer metric, DUAL per destination). Tests `eigrp.metric.test.ts` (the §3.12 numbers, K5 ≠ 0, the
  tunnel defaults), `eigrp.dual.test.ts` (feasibility, local computation, active/passive with replies, a neighbour lost
  while active, split horizon and poison reverse).
- **l3** ⚑ — [S18] `IPV4_UPPER` 47, the `arp.sendVia` tunnel branch, the ipv4 selector `{layer: 'ipv4', roles:
  ['tunnel']}` and `icmp.error.param` in `protocols/icmpv4.ts` (D15); [C1] `IPV4_UPPER` 88, `multipathEligible` for
  `'EIGRP'`, `routeCause` for EIGRP; [C13] `IPV4_UPPER` 50 → gre; [S13]/[S25] the `DORMANT_TRANSPORT_OWNERS` entries of
  D22. Tests `ip.tunnel-plumbing.test.ts` (a hand-built tunnel port; ICMP 3/4 carries the MTU), `ip.eigrp-plumbing.test.ts`,
  and cases added to `ip.switch-transport.test.ts` (`line vty` alone leaves the switch dormant; `transport input ssh`
  and `logging host` wake it).
- **catalog** — [S18] `TUNNEL_FAMILY`, the `tunnel` role traits, `ROLE_EGRESS_OWNER.tunnel = 'gre'` in `define.ts`.
  Tests `device.catalog.tunnel.test.ts` (routing models derive the family, home routers do not).
- **media** — [S19] `link/serial.ts` per-end PPP rules and `serialControlExempt` (pure). Tests `link.serial.ppp.test.ts`.
- **device** — [S13] the `remoteCli` and `cliRemote` actions scheduled as the `remoteCli` SimEvent (D14); [S18]
  `virtualChanged` (`recomputeVirtual`, the tunnel case of `evaluateVirtualOper` reading the `tunnels` row) and the
  tunnel owner's egress call; [S24] ⚑ the `emitLog` seam over the ~10 log sites (the `log` TraceEvent unchanged);
  [S32] the hosts' `files:` store (the `storage` action, `ProcessCtx.files` / `readFile`). Tests
  `device.remote-cli-action.test.ts`, `device.virtual-tunnel.test.ts`, `device.emit-log.test.ts` (trace bytes of every
  log site unchanged; `log.record` to a stub logger only when the model runs `logger`), `device.files.test.ts`.
- **svc** ⚑ — [S13] `tcp.listen {service: true}` in `protocols/tcp.ts` (no row, no debug, no `sock.opened`, not in the
  StateView). Tests `l4.hidden-listener.test.ts` (a P1 router's tcp StateView bytes unchanged with a hidden listener).
- **cli** — the approved items' configuration rules (§5, "The approved items' rules"). Tests `config-ast.approved.test.ts`
  (the EIGRP child order and slots; the crypto sections; `service timestamps log` and `debug` coexist; `service-policy
  output` a PHY key on physical ports only).
- **io** — [S32] `TopologyDevice.files` in schema 1.3 (`schemaIdFor` counts it). Tests: cases in `io.schema.p3.test.ts`
  (a host with files exports 1.3; a P2 document without files still exports 1.2 byte-identically).
- **auto** — [S32] `automation/py/{lexer,parser}.ts` (pure, exported through `pure` for the editor). Tests
  `automation.py.parse.test.ts`.
- **web-canvas** — [S18]/[S19] `canvas/overlays/wan-model.ts`; [C1] `canvas/overlays/eigrp-model.ts`. Tests
  `overlays.wan-model.test.ts`, `overlays.eigrp-model.test.ts`.

### W2 — daemons part 1, ACL hooks, CLI part 1

Daemon tests configure devices through `startupConfig` or `applyConfigLine` (rule 13), so they need the W1 config
rules, not the W2 grammar.

- **ospf** — `protocols/ospf.ts`, `protocols/ospf/{nsm,flood,lsdb,originate,routes}.ts`. Tests on `staged.world`:
  `ospf.adjacency.test.ts` (p2p and broadcast; the hello reply; the DR-change hello and §3.1's R1 sequence; ExStart
  master/slave; a DBD received in Init), `ospf.flood.test.ts` (a non-DR sends its own LSAs to 224.0.0.6, the DR
  re-floods to 224.0.0.5, the BDR re-floods nothing it received on the segment), `ospf.routes.test.ts` (one
  `ipv4.routes` batch, immediate withdrawal, `lsa-gen` before `spf` at the same instant, the §3.2 timings: routes at
  link-up + 15 s, failover at T + 5 s, restore at T2 + 15 s), `ospf.default-originate.test.ts`.
- **l3** ⚑ — `protocols/ipv4.ts`: the ACL hooks (inbound, outbound with `inPort`, `ipv4.resume.after`, `filterOut` on
  `nat.outbound`). Tests `ip.acl-hooks.test.ts` (a fake acl: order against NAT, locally originated packets unfiltered,
  `inPort` on outbound requests).
- **nat** ⚑ — `protocols/nat.ts`: with `filterOut`, hand the translated packet to `acl.filter` (dir `out`, `natted`)
  with the `arp.sendVia` request as `onPermit`. Tests `nat.filter-out.test.ts` (a fake acl; the row exists after an
  outbound deny; without `filterOut`, P2 bytes).
- **acl** (new) — `protocols/acl.ts`. Tests `acl.daemon.test.ts` (rows only for applied lists, counts, first-packet log
  and 5-minute aggregation, ICMP 3/13 at most one per 500 ms and sourced from `inPort` on outbound denies, none for
  `natted` packets, `clear`, undefined list permits).
- **l2** ⚑ — `protocols/eth-switch.ts`: steps 7b/7c, the SVI-egress binding; `ERR_DISABLE_CAUSES` appended (a
  pre-approved contract edit). Tests `l2.snooping.test.ts`, `l2.dai.test.ts` (rate limits with `test/inject.ts`),
  `l2.eth-switch.p2-parity.test.ts` (no snooping line → the P2 path, StateView and debug bytes identical); the §9 W2
  `show errdisable recovery` migration its change forces in `cli.port-security.test.ts:183-206`.
- **disc** (new) — `protocols/{cdp,lldp}.ts`. Tests `disc.cdp.test.ts`, `disc.lldp.test.ts` on `staged.world`, with a
  managed switch as the receiver (eth-switch step 2 and the W1 control rows); a routed-port receiver is covered by W2
  device's own test with a stub daemon and by `accept.p3.cdp` (W4).
- **svc** ⚑ — `protocols/{ntp,traffic}.ts`, `protocols/udp.ts` (the discard rule; `udp.probe`), `protocols/tcp.ts`
  (`tcp.probe`). Tests `app.ntp.test.ts` (a three-level chain with exact offsets split into ms and ns; the kick on
  link-up and on a route change; the 1-2-4-8-16-32 s retries and nothing after the sixth; stratum-16 answers rejected;
  bare `ntp master` = stratum 8; the `clock` row; `clock set` through `ntp.clockSet`), `app.traffic.test.ts` (pacing,
  jitter, loss, caps, the 300 s cap, the flush write, tail losses with and without the final datagram),
  `l4.probe.test.ts` (open, refused, unreachable, timeout; the udp outcome).
- **http** (new) — `protocols/http-client.ts` (`http.request`, the CLI-session owner), `protocols/restconf.ts`. Tests
  `http.request.test.ts`, `restconf.test.ts` (status matrix, 401, atomic revert, PUT twice → 201 then 204, the
  `restconf-log` bound, `configChange` carrying the origin) on `staged.world` (W1 tcp `tls`, W1 configure action and
  handler).
- **qos** (new, moved from W1: it needs W1 core's matcher) — `qos/{config,classify,mark}.ts` (the pure MQC reader, the
  classifier over the D12 matcher, the marking plan, the configuration generation). Tests `qos.config.test.ts`,
  `qos.classify.test.ts`.
- **device** ⚑ — `device/pipeline.ts`: the control check on the physical port before step 10a, classes `cdp` and
  `lldp` only (moved from W1: it needs the W1 control rows). Tests `device.pipeline.p3.test.ts` on `staged.world` with
  a stub `cdp` daemon passed through `factories` (delivered on a routed port, also with a native subinterface; dropped
  exactly as today when it does not run; DTP, LACP and BPDUs on a routed port keep today's path).
- **media** — `link/inflight.ts`: `queued(ref, now)` (the legs on an egress port with `txStart > now`, oldest first).
  Tests `link.inflight.queued.test.ts`.
- **sim** ⚑ — `sim/snapshot-cache.ts` (`DeviceSnapshot.clock`, `SimSnapshot.profile` 'P3', `PortSnapshot.txBacklog` from
  `queued` with the device dirtied at an enqueue that leaves a backlog and at each `txComplete` of a port that has one,
  `PortSnapshot.qos` from `DeviceRuntime.qosCounters` tested with a fake runtime), `HOST_APP_PROCESS` rows (traffic).
  Tests `sim.snapshot-clock.test.ts`, `sim.snapshot-txqueue.test.ts` (none on an uncongested link),
  `sim.device-configure.test.ts` (moved from W1: the real runtime's action through the W1 handler; never nested; a
  60-line atomic configure within budget; `config.result` delivered; `configChange` carries the origin).
- **cli** — part 1: `cli/grammar/{ospf,acl,qos,discovery,time,api,ssh}.ts` and handlers: every §5.1–§5.6 configuration
  line, `show ip ospf [neighbor|interface]`, the second `show ip route` legend line and `O` codes, `show access-lists`,
  `show ip interface`, `clear access-list counters`, `clear ip ospf process`, `show class-map`, `show policy-map
  [interface]`, `show clock`, `clock set` (through `ntp.clockSet`), the host-shell `rest` job (its option splitting and
  the verbatim `-d`) and `flow` job; the scopes widened to `managed-switch` for `ip domain-name` and the ACL lines
  (D14); `userSecretOf` for the privilege form; `bandwidth` on routed Ethernet ports and subinterfaces; the
  `errdisable recovery cause` choices +2; the `service-policy` refusal on SVIs and switchports; the modes entered
  (config-router, config-ext-nacl, config-cmap, config-pmap, config-pmap-c) lose `reserved` in the same change (§9 W2).
  Tests `cli.ospf.test.ts`, `cli.acl.test.ts` (sequence editing, per-direction access-group, lists on a switch),
  `cli.qos.test.ts`, `cli.discovery.test.ts`, `cli.time.test.ts`, `cli.ssh.test.ts` (key prerequisites and messages, on
  a router and on a switch; `login local` with a privilege-15 user), `cli.rest.test.ts` (a JSON body with quotes,
  brackets and spaces arrives verbatim; `-d` must be last), `cli.flow.test.ts`; help goldens regenerated (§9 W2).
- **capture** (moved from W1: it needs the W1 ospf codec) — `capture/filter/fields/<proto>.ts` split per protocol with
  `capture/filter/fields.ts` kept as the index (`pure-entry.lint.test.ts:64-65`); `ospf`, `ospf-lsa`, `cdp`, `lldp`,
  `ntp` display fields. Tests `capture.filter.fields.p3.test.ts` (`ospf.type == 1`, `ip.dsfield.dscp == 46`).
- **web-concept** (moved from W1: parity with W1 core) — `concept/queueing/model.ts`, `concept/data-formats/model.ts`;
  [S9] `concept/wildcard/model.ts`. Tests `concept.queueing.test.ts` (the parity case against `core/queueing.ts`),
  `concept.data-formats.test.ts`; [S9] `concept.wildcard.test.ts`.
- **web-shell** — `topoOverlays.qos` and the approved [S1] `ospf`/`ospfArea`, [S18]/[S19] `wan`, [C1]
  `eigrp`/`eigrpPrefix` (one persisted-slice migration), [S2] the `routingUi` slice, the View-menu entries, concept-view
  routing by `ConceptToolId`; the worker's "Use current defaults" calls the engine ladder `sim/defaults-upgrade.ts` (moved from W1,
  §9 W2 item for `worker.profile.test.ts:195-264`). Tests `store.topo-overlays.p3.test.ts`.

**Approved items in W2** (each depends only on W0–W1):

- **eigrp** — [C1] `protocols/eigrp.ts` (hellos, neighbours, the reliable transport, DUAL through the W1 pure modules,
  one `ipv4.routes` batch per change, the two tables, the transitions). Tests on `staged.world`: `eigrp.adjacency.test.ts`
  (the hello reply, init and ack, K-value and AS mismatches, hold expiry, 16 retransmissions then a reset),
  `eigrp.routes.test.ts` (§3.12: the metrics, the FS failover in the link-down dispatch, the query and reply variant,
  `maximum-paths`, passive interfaces).
- **wan** — [S18] `protocols/gre.ts` (GRE mode: the underlay evaluation with the lpm watch, the `tunnels` row,
  `virtualChanged`, head and tail rewraps, the D15 fallback with ICMP 3/4 and `ip tcp adjust-mss`). Tests
  `wan.gre.test.ts` on `staged.world` (§3.10; W1 pdu, l3, catalog, device).
- **media** — [S19] `link/link.ts`: the `ppp-link` medium op and the `serial-line` event. Tests `link.ppp-link.test.ts`.
- **device** ⚑ — [S19] `device/pipeline.ts` PPP framing and the receive gate, the encapsulation refusals removed
  (`device.ts:316-317`, :1404); [S25] the extended-logging default logs (interface and line protocol, restart,
  configuration) through the W1 `emitLog`, P3 worlds only. Tests `device.pipeline.ppp.test.ts`,
  `device.extended-logging.test.ts` (none in P1/P2 worlds).
- **l3** ⚑ — [S19] the `arp.sendVia` ppp branch, the `nd.ts:143-148` mapping fix, the ipv4 selector `{layer: 'ppp',
  ethertype: 0x0021, roles: ['wan']}`. Tests `ip.ppp-plumbing.test.ts`.
- **capture** — [S19] `ppp` → `ppp_hdlc` in `capture/tap.ts` and pcap link type 50; the display fields of the approved
  protocols in `capture/filter/fields/<proto>.ts` (`telnet`, `ssh`, `gre`, the PPP family, `syslog`, `eigrp`, `esp`,
  `ikev2`). Tests `capture.ppp.test.ts`, cases in `capture.filter.fields.p3.test.ts` (`esp.spi`, `eigrp.opcode == 5`).
- **svc** — [S24] `protocols/logger.ts` (buffer, levels, the renderer over the device clock and `service timestamps`).
  Tests `app.logger.test.ts` on `staged.world` (W1 `emitLog`): P1's debug prefix without the timestamps line.
- **acl** — [S13] `acl.check` / `acl.verdict`, a delimited block of the W2 acl item (rows `applied: '…, vty in'`,
  `lastIface 'vty'`). Tests: cases in `acl.daemon.test.ts`.
- **qos** — [S20]/[S21] `link/qos/scheduler.ts` (pure over W1 `core/queueing.ts`: LLQ with its conditional policer,
  CBWFQ by DRR, queue limits, the 75 % admission function; [S21] WFQ in class-default, the policer, the shaper's
  next-eligible time). Tests `qos.scheduler.test.ts` (2:1 ± 5 %, the LLQ bound, conform/exceed counts, shaping without
  drops below the limit).
- **cli** — the grammar and handlers of every approved configuration line (Tunnel and crypto lines with their modes,
  PPP lines, the queueing actions, logging lines, `router eigrp` and `delay`; the modes of §2.11 added in the same
  change, §9.2 item 22); [S13] the CliRuntime remote sessions (`openRemote`, `execRemote`, `closeRemote`, `setRemote`,
  `via: 'vty'`, the depth cap of 4, `FacadeCounters.remote`, `CliSessionView.remote`) and the `telnet` / `ssh` jobs on
  routers, switches and hosts (against a fake vty-client); [S25] `onLogEvent`, `terminal monitor`,
  `CliSessionView.monitor`, `service syslog on|off`; [S32] the dev-host shell (`python`, `type`, `del`, `dir`) and
  `rest -f`. Tests `cli.eigrp.test.ts`, `cli.wan.test.ts`, `cli.crypto.test.ts`, `cli.qos-queueing.test.ts`,
  `cli.logging.test.ts`, `cli.remote.test.ts` (nesting cap, journaling of the client lines), `cli.devhost.test.ts`.
- **sim** — [S13] the `remoteCli` SimEvent handler and the delivery of a `via: 'vty'` session's output as `vty.output`
  (against a fake CliRuntime); [S32] the `HOST_APP_PROCESS` rows (`script.run/stop`, `file.write/delete`) and
  `DeviceSnapshot.storage` in `sim/snapshot-cache.ts` ⚑. Tests `sim.remote-cli-event.test.ts`,
  `sim.snapshot-storage.test.ts` (absent without user files).
- **auto** — [S32] `automation/py/{compiler,vm,lib}.ts` (pure; the `json`, `requests`-style and `time` modules against
  a fake I/O host; the caps). Tests `automation.py.vm.test.ts`.

### W3 — CLI part 2, checkers and grader clone features, QoS marking, web; the approved items' daemons and views

- **cli** — part 2: `show ip ospf database`, `show ip ospf neighbor detail`, `show ip protocols`, `show ip dhcp snooping
  [binding]`, `show ip arp inspection …`, `show cdp …`, `show lldp …`, `show ntp …`, `show restconf`, `show ip ssh`,
  `show ssh`, `show users`, every §5.8 debug category. Tests against fake tables and the §2.6 StateView shapes (the
  "Dead in" column from `neighbors[].deadAt`, SPF statistics from `spf`, `when`/`poll` from `peers[].nextPollAt`).
- **sim** — the grader clone features (moved from W5, so the W4 acceptance rows can use them): `tcp.probe` /
  `udp.probe` applied like `icmp.ping` with UDP pass/fail from the clone trace, `droppedAt` and `dropReason`, `LabFault
  config` (through the W1 configure handler), `cut` by port, `toAddress` / `toIface`, the clone memo. Tests
  `sim.lab-checks.clone.p3.test.ts` on `staged.world` (W2 probes).
- **ospf, acl, l2, qos, disc, svc, http** — one checker-adapter file each, `sim/lab-checks/{ospf,acl,hardening,qos,
  discovery,time,automation}.ts`, with the fact readers of §2.10, each naming its table or configuration source (rule
  20), against fakes. Tests `sim.lab-checks.p3.<area>.test.ts` (one wrong-answer case per kind and per widened member).
- **device** ⚑ (moved from W1/W2: it calls W2 `qos/*`) — the QoS policy cache keyed by the configuration generation,
  step 10c on `deliver`/`subif` verdicts before the tag pop, output marking in `transmitOn` and in the subinterface
  branch after `vlanPush`, `qosCounters`. Tests `device.qos-marking.test.ts` on `staged.world` (the mutation sequence
  `QosMark`, `ChecksumRecompute`, `FcsRecompute` from real calls; a flooded frame for another MAC and a BPDU are neither
  classified nor counted; output `set cos 5` on a subinterface writes the pushed tag's PCP; editing the class-map's
  ACL changes the next frame's class).
- **web-canvas** — `canvas/qos.ts` and its scene wiring, marker text, outline.
- **web-inspector** — PortInspector QoS line, PacketInspector banner and chips, ServicesPanel NTP, device clock.
- **web-concept** — `QueueingTool.tsx`, `DataFormatsTool.tsx`.
- **web-desktop** — `TrafficApp.tsx`.

**Approved items in W3** (each depends only on W0–W2; where two meet at a seam in this wave, each tests against a
fake of the other and a W4 acceptance row integrates them):

- **wan** — [S19] `protocols/ppp.ts` (LCP, PAP, CHAP, IPCP and IPV6CP over the W1 automaton, echo, retry, the `ppp`
  table and transitions) and ⚑ the encapsulation switch in `protocols/hdlc.ts` (a reviewed edit of l2l3's file; it
  needs W2 device's acceptance of `encapsulation ppp`), on `staged.world` (W1 pdu, wan, media; W2 media, device, l3).
  Tests `wan.ppp.test.ts` (§3.9), `wan.hdlc-switch.test.ts` (a strict no-op when the encapsulation does not change;
  the P0.5 hdlc pins unchanged). [C13] `protocols/ike.ts` and the ipsec mode of `protocols/gre.ts` (on W2's GRE item): the
  `ike.connect` / `tunnel.sa` seam, ESP head and tail, the IPsec MTU fallback, the `ipsec-sa` table. Tests
  `wan.ipsec.test.ts` on `staged.world` (§3.13). The adapter `sim/lab-checks/wan.ts` (`tunnel.up`, `ppp.*`,
  `ipsec.sa`, `NEIGHBOR_SOURCES.ppp`) against fakes.
- **svc** — [S13] `protocols/{vty,vty-client}.ts` and the `vty-logins` table on `staged.world` (W1 codecs, hidden
  listeners and device actions; W2 cli remote sessions, sim event handler and `acl.check`). Tests `app.vty.test.ts`
  (§3.14). [S25] logger's UDP 514 sender (a delimited block of W2's logger) and `protocols/syslog-server.ts`. Tests
  `app.syslog.test.ts`. The time adapter gains the `logging.*` facts.
- **media** — [S20]/[S21] the held queue in `link/media/p2p.ts` (enqueue with `{ok: true, deferred: true}`, dequeue at
  `onTxComplete` through W2's `link/qos/scheduler.ts`, the five draws at dequeue, `frameQueued`, the shaper gate on a
  `qos:` medium timer, `LinkModel.egressQueues`) and the `LinkModelDeps.egressPolicy` wiring, against a fake runtime.
  A port with no policy keeps the virtual FIFO byte for byte. Tests `link.p2p.scheduler.test.ts` ⚑.
- **device** ⚑ — [S20]/[S21] a delimited block of the W3 device QoS item: `DeviceRuntime.egressPolicy` compiled from
  the output policy, `{qosClass}` on `deps.transmit`, `service-policy output` as a `PHY_CONFIG_KEYS` line on physical
  ports, input policing at step 10c after marking. Tests `device.qos-egress.test.ts` against a fake link model.
- **sim** — [S25] the `log` branch at `sim/simulation.ts:359` calling `cli.onLogEvent` (console and monitor printing in
  P3 worlds). Tests `sim.log-branch.test.ts` (P1/P2 typed transcripts unchanged).
- **cli** — part 2 for the approved items: `show interfaces tunnel`, the Tunnel rows of `show ip interface brief`, `show
  ppp interface` and the PPP lines of `show interfaces`, the queue lines of `show policy-map interface` and `show
  interfaces`, the admission refusal at `service-policy output` (the W2 `qos/config.ts` reader), `show logging` / `clear
  logging`, the remote sessions of `show users` / `show ssh`, `show ip eigrp …`, `show ip route eigrp`, `clear ip eigrp
  neighbors`, the EIGRP legend line (D11), `show crypto ikev2 sa`, `show crypto ipsec sa`, and their debug categories.
  Tests against fake tables and StateViews.
- **eigrp** — [C1] the adapter `sim/lab-checks/eigrp.ts` (`NEIGHBOR_SOURCES.eigrp`, the `eigrp.*` facts, the EIGRP
  router ids in `IDENTITY_SOURCES`) against fakes.
- **acl, qos, http** — the approved facts in their adapters: [S13] `vty.logins` (acl), [S20] `qos.admitted` (qos),
  [S32] `automation.lastRun` (http, reading `script-runs`).
- **web-canvas** — [S1] `canvas/ospf.ts`; [S3] `canvas/overlays/spf-model.ts`, `canvas/spf.ts`; [S18]/[S19] and [C13]
  `canvas/wan.ts`; [S20] the per-class lanes in `canvas/qos.ts`; [C1] `canvas/eigrp.ts`; their registry entries.
- **web-inspector** — [S1] `OspfSection`; [S18]/[S19]/[C13] `PppSection`, `TunnelSection`; [S20] `PolicySection` and
  the wait chip; [S25] the Syslog section; [S13]/[C13] the SSH, ESP and IKE banners.
- **web-routing** (new) — [S2] `routing/{lsdb-model.ts,LinkStatePanel,LsaList,LsaDetail,LsdbGraph}.tsx`; [S3]
  `routing/SpfStepper.tsx` (reading the W2 `routingUi` slice; the dock wiring is web-shell's W4 item). Tests
  `routing.lsdb-model.test.ts`, `routing.spf-parity.test.ts`.
- **web-concept** — [S9] `concept/wildcard/WildcardTool.tsx`.
- **web-shell** — [S13] the terminal's remote-session chip, prompt and masked input.

### W4 — wired acceptance on real worlds; the P3 catalog flip, alone

Two steps, in this order (rule 14):

1. **qa** — the MUST `accept.p3.*` engine tests of §10.1 marked W4, built with `staged.world` (the clone features they
   use are W3's), green on `staged.world` before the flip opens; the rows of the approved items ([S13], [S18], [S19],
   [S20], [S21], [S24], [S25], [C1], [C13]).
2. **catalog (the flip, alone)** — `protocols/index.ts` (registry: ospf, acl, cdp, lldp, ntp, restconf, traffic, and
   the approved ppp, gre, vty, vty-client, logger, syslog-server, eigrp and ike), `device/catalog/index.ts`
   (`CATALOG_STAGE = 'P3'`), [S24] the two `service timestamps` lines in `profileConfig.P3` of routers, managed switches
   and the controller,
   the data files whose `*_DATA_STAGE` must equal it (`device.catalog.data.test.ts:86-88`: `routers`, `switches`,
   `multilayer`, `datacentre`, `legacy`, `security` and `computers.ts`), `device/catalog/define.ts` (`deriveTables`
   applies `STAGED_PROCESS_TABLES`), together with the pre-approved contract edits of the same change: the names
   inserted into `PROCESS_ORDER` at their §2.1 positions, the `CAPABILITY_PROCESSES` rows (including the dormant
   `udp`, `tcp` on `managed-switch`, D22) and `STAGED_PROCESS_TABLES`. `LATEST_DEFAULTS_PROFILE` stays `'P2'` (it flips
   with the course, W7). Tests: every §9 W4 migration; `device.catalog.p3.test.ts` (derived summaries of NF-C2960,
   NF-C3650-24, NF-2911 and NF-WLC-9800, the controller without snooping tables); `staged.world.p3-parity.test.ts`
   (staged.world's test-only P3 data equals the contract). **Inside this change the lead runs the rule 14 list**; only
   §9.3/§9.4 rows may move (both say "no change").
- **web-shell** — the `mgmt` and `wan` lanes' timeline wiring; [S2] the `routing` dock tab shown (`DOCK_STAGE` `'P3'`,
  `app/Dock.tsx` maps it to the lazy W3 `routing/LinkStatePanel.tsx`, the §9.2 item 36b hotkey migration).

### W5 — CCNA 3 labs (everything but automation)

- **sim** — the approved clone kinds: [S13] `service`, [S18] `path` with [C13] `tunnelAt`, [S20] `traffic` (on
  `staged.world` with the W3 daemons; tests `sim.lab-checks.approved-kinds.test.ts`); `sim/scenarios/{index,kit}.ts`
  (`CCNA3_LABS` appended after `CCNA2_LABS`; `topology(…, {profile: 'P3'})` sets `schema = schemaIdFor(t)`); the §9 W5
  scenario pins. Tests `accept.p3.grader-bounded.test.ts`.
- **course** — `sim/scenarios/ccna3/index.ts` (`CCNA3_LAB_ORDER`).
- **lab files, one owner each** (rule 18): **ospf** `sim/scenarios/ccna3/ospf.ts`; **eigrp** `…/eigrp.ts` ([C1]: lab
  10 `ccna3-eigrp-feasible-successor` and lab 33 `ccna3-troubleshoot-eigrp`); **acl** `…/acl.ts` (lab 15 with its
  [S13] login tasks); **l2** `…/hardening.ts` (lab 19 with its [S13] login tasks, lab 20); **course** `…/wan.ts` (lab
  22, HDLC and the [S19] PPP tasks) and `…/troubleshooting.ts`; **wan** `…/vpn.ts` (lab 24 [S18], lab 25 [C13]); **qos**
  `…/qos.ts` (lab 27 with its [S20] LLQ and [S21] policing tasks); **disc** `…/discovery.ts` (lab 28); **svc**
  `…/time.ts` (lab 29 with its [S24]/[S25] logging tasks). Tests `labs.ccna3.solutions.test.ts` (every lab: unsolved
  fails, solution passes, grading read-only), owned by sim.
- **web-shell** — `app/FileMenu.tsx` `CATEGORY_ORDER` gains `ccna3-lab` (moved from W7: the labs join `SCENARIOS` now,
  `filemenu.groups.test.ts:29-35`).
- **io** [S37] — `io/lab-schema.ts` (the zod schema), `labDocumentOf` / `scenarioOf`. Tests: the round trip over every
  CCNA 1 and 2 lab (the CCNA 3 labs of this wave join in W7's `accept.p3.lab-document`).
- **auto** [S32] — `protocols/script-host.ts` (runs, slices, sleeps, the `script-runs` table, files through the W1
  `storage` action) on `staged.world`'s test-only NF-DEVHOST (W2 NF-Py VM, W2 `http.request`). Tests `app.script.test.ts`.

### W6 — second flip ([S32]), the automation labs, web visuals completed, theory

- **catalog [S32] (a flip, alone)** — NF-DEVHOST (`pc.nfdevhost`, `host` + `programmable`) in `computers.ts`, the
  `programmable` row (`script-host` only: no `tftp`, which is [S29]), `PROCESS_ORDER` gains `script-host`,
  `PROCESS_TABLES['script-host']`; the §9.2 W6 pins; the lead runs the rule 14 list inside the change.
- **auto** — `sim/scenarios/ccna3/automation.ts`: lab 38 (the RESTCONF change with its JSON reading tasks) and [S32] lab
  40 `ccna3-script-inventory`, opened after the flip change has closed (rule 14's order, as W4's two steps: lab 40
  needs NF-DEVHOST in the catalog). Lesson 37 has no lab (§11.1).
- **course** — `curriculum/ccna3/{theory-a,theory-b,theory-c,videos}.ts` for modules 1–13 (theory is written only after
  its grammar exists). Tests `curriculum.ccna3.commands.test.ts` (§11.3: every backticked command and every fence line
  parses in `GRAMMAR` for the lesson's models; `json`/`yaml`/`xml`/`http` blocks parse with their own parsers),
  `curriculum.ccna3.videos.test.ts`.
- **web-desktop [S32]** — the automation workspace.
- **sim [S37]** — `sim/grade.ts` (`gradeTopology`), with a parity test against live grading over every CCNA 1–3 lab
  built so far.
- **web-shell [S37]** — `resolveLab(ref)` replacing `SCENARIOS.find` in `bridge/worker/labs.ts:31`.

### W7 — automation theory, the course and profile flip, remaining acceptance

- **course** — `curriculum/ccna3/theory-d.ts` (module 14) and its videos; `curriculum/index.ts` (the CCNA 3 skeleton
  attached, `available`, description rewritten; the next planned card with `profile: 'P3'`, §8.5 P11), together with
  the pre-approved contract edit `LATEST_DEFAULTS_PROFILE = 'P3'` in the same change (§8.5 P15).
- **web-shell** — in the same change: `profileForCourse(id) = courseById(id)?.profile ?? LATEST_DEFAULTS_PROFILE`; the
  §9 W7 web pins (course profile, worker profile).
- **web-learn** — landing and planned-card migration (§9 W7).
- **qa** — `accept.p3.{labs,coverage,determinism}.test.ts`; [S32] `accept.p3.script.test.ts` (NF-DEVHOST exists from
  the W6 flip); [S37] `test/goldens/lab-versions.json` and `accept.p3.lab-document.test.ts`; the web acceptance of
  §10.2.
- **No COULD item waits for W7.** The approved C1 and C13 were decided before W0 (§8.5 P2), their blocks are written in
  full (§2.16, §2.17), and they are built in W1–W5 like the SHOULD items. A COULD item approved later would be added
  here as one named item, its contract block written in full by the architect first (rule 3).

### W8 — P3a exit gate (architect)

Remove the transition `?` of every implemented `@since P3` member except those of §2.15, and extend
`contracts.optional-by-meaning.test.ts`; remove `customChecks`; reconcile `index.ts`; reduce `staged.world` to a thin
wrapper where the catalog now equals it; check the §8.5 scope list item by item (M1–M19, S1, S2, S3, S9, S13, S18, S19,
S20, S21, S24, S25, S32, S37, C1 and C13 each shipped; every other item recorded with its stage from §12.1); update docs and `docs/CATALOG.md`; run the six checks, the slow project, all digest goldens and gate
G on the P3 lab set; record the gate in a §14 appended to this document. Only then, and with the product owner's
approval, is the `p3` branch merged and pushed to `master` (rule 21).

---

## 8. Cut lines

The spec gives P3 five months (§19), and that row included the platform, which is now P3b. This section ranks every
P3a feature by value to a CCNA 3 learner against its cost, and draws three lines.

**Units.** Cost is in engineer-weeks (ew): one focused implementer week, including its tests, its share of review and
fixes, and its CLI lines. Estimates are the area maps', compared with P2's own estimates for similar items (STP 6.5,
HSRP 2.5, NAT 3.5, the WLC 6.5). Those P2 figures are estimates too: P2 recorded no effort actuals (ARCHITECTURE-P2
§14), so nothing here is calibrated on actuals, and the approved plan carries an explicit review contingency (§8.4).
**Deduplication:** each area map priced its own share of wave 0, the goldens, the grader kinds, the lessons and labs,
and the acceptance suite; here those are counted once, in the cross-cutting lines M1, M2, M3, M18 and M19, and each area
line carries only its protocol, CLI and visual work. §8.4 shows the reconciliation map by map, and the additions of the
adversarial review (§13) as a separate row.

**Value** is judged against the CCNA 3 objectives of spec §2.3, against what the current exam blueprint asks a learner
to *configure and verify* (single-area OSPFv2; standard and extended ACLs; DHCP snooping and dynamic ARP inspection;
CDP and LLDP; NTP; SSH device access) versus *describe* (syslog, SNMP, QoS per-hop behaviour, TFTP/FTP, VPNs, REST and
data encodings, configuration management, controller-based networking), and against whether a lab can be built
without the feature.

### 8.1 MUST (≈ 69.8 ew; the review contingency of the whole approved plan is in §8.4)

MUST is the set of core CCNA 3 objectives plus the machinery without which no CCNA 3 lab can exist. It is **not** by
itself everything spec §2.3 names; what "CCNA 3 complete" means for this stage is the scope list the product owner
records in §8.5, and the exit gate checks exactly that list. The "Wave items" column names every §7 item that carries
part of the line.

| # | Feature | Value | Cost | Wave items | If cut (last resort only) |
|---|---|---|---|---|---|
| M1 | P3 defaults profile (types, the sweep including the `arp.ts:178` trap, `LATEST_DEFAULTS_PROFILE`, `Course.profile`, web mapping, chip and menu), schema 1.3, the defaults ladder, the P2-profile goldens (digests with the two D22 guard worlds, exports, lab status), P1-guard migration, `accept.p3.profile` / `silence`, W0 contract blocks and compile stubs, `ConceptToolId` | Enabler and proof: without it CDP cannot default on, and nothing proves CCNA 1 and CCNA 2 worlds unchanged | 4.1 | W0 architect, course; W1 io, sim, l3, web-shell; W2 web-shell; W4 flip; W7 course, web-shell | — (never cut) |
| M2 | Engineering health: web tests type-checked (check 3b), `worker.delta` load-independent, fast/slow projects and shards, `staged.world` with its test-only P3 data, the test injector | P2 §14's carried debt; the suite grows by half with CCNA 3 | 1.8 | W0 architect, qa, web-shell; W1 qa; W4 flip (parity test) | Flaky gates and 5-minute inner loops for every agent |
| M3 | Grader v3: registry split proven by `lab-status.p2`, envelope, neighbour/fact/identity frameworks, `acl` and `aclDecision`, `connectivity` proto/port/`droppedAt` with the tcp/udp probe requests, `route`/`table`/`LabFault` members, clone memo, `grader-bounded` | Every CCNA 3 lab needs at least one of these; P2's grader limits (item 22d) are fixed | 3.9 | W0 architect (stubs); W1 sim; W2 svc (probes); W3 sim and the area adapters; W5 sim | Labs limited to P2 assertion kinds; ACL labs cannot grade TCP |
| M4 | OSPF wire and L3 plumbing: `ospf`/`ospf-lsa` codecs with both checksums, the IPv4-multicast framing rule, `IPV4_UPPER` 89, `ipv4.routes`, `ipv4.ribWatch` (keys and lpm), multipath for `O`, route codes and causes | Enabler for M5 (and the lpm watch for M15) | 3.0 | W1 pdu, l3 | No OSPF |
| M5 | OSPFv2 daemon: ISM, DR/BDR election with the DR-change hello, hello checks and refusals, router id, enablement by network and interface lines, passive, cost and reference bandwidth, broadcast/point-to-point/loopback; NSM, DBD master/slave, LSR/LSU/LSAck, retransmission, LSDB rules, DR flooding, router and network LSAs, refresh and MaxAge; the pure SPF core, intra-area routes, ECMP, immediate withdrawal, the fixed `lsa-gen`/`spf` order; `default-information originate [always]`; fact and neighbour adapters | Named objective (configure and verify single-area OSPFv2); the centre of the course | 9.6 | W1 core, ospf; W2 ospf; W3 ospf (adapter) | Routing modules become theory; CCNA 3 loses its core |
| M6 | OSPF CLI and verification: modes, lines, handlers, `show ip ospf [neighbor\|interface\|database]`, `show ip protocols`, `show ip route ospf`, debug categories, `clear ip ospf process` | Verification is half the objective | 2.5 | W1 cli; W2–W3 cli | Only tables in the inspector |
| M7 | ACL core: extended IPv4 matcher (protocols, ports and names, ICMP names, `established`, `log`, remarks), sequence numbers (`ConfigNode.seq`, `sequenced`), resequence | Named objective (standard and extended ACLs) | 2.0 | W1 core, cli | No ACL filtering |
| M8 | `acl` daemon and ipv4/nat hooks at the real order of operations, counter rows, drop `rule`, ICMP 3/13 rate-limited and sourced from the ingress interface, TCP `admin-prohibited`, first-packet log and 5-minute aggregation, `clear`, `aclDenies`, fact adapters | Named objective (placement, hit counters, logging) | 2.8 | W1 svc (`admin-prohibited`); W2 acl, l3, nat; W3 acl (adapter) | ACLs cannot filter interfaces |
| M9 | ACL CLI: `config-ext-nacl`, sequence editing, `ip access-group` per direction, `show access-lists` with matches, `show ip interface`, `clear access-list counters`, help goldens | Verification of the above | 1.5 | W2–W3 cli | ACLs unconfigurable |
| M10 | SSH-only device access at configuration level, on routers and switches: key generation with its prerequisites, `ip ssh`, `username … secret` (with `privilege`, read by `login local`), `login local`, `transport input`, `access-class` stored and shown, the `ip domain-name` and ACL scopes widened to switches, `show ip ssh` / `show ssh` / `show users`, `ssh.*` and `vty.*` facts | Named objective (configure SSH); lesson 19's lab | 1.5 | W1 cli (rules); W2–W3 cli; W3 acl (adapter) | Device hardening becomes theory |
| M11 | DHCP snooping: trust, bindings from ACKs and the own SVI, MAC check, rate limit → err-disable (proved with the injector), static bindings, `show ip dhcp snooping [binding]` | Named objective (configure and verify) | 2.0 | W1 l2; W2 l2; W3 cli, l2 (adapter); W4 flip (staged tables) | Rogue-server lesson becomes theory |
| M12 | Dynamic ARP inspection: binding check, rate limit → err-disable, the `arp-inspection` table, logs, shows | Named objective (configure and verify) | 1.5 | W1 l2; W2 l2; W3 cli, l2 (adapter) | ARP-spoofing defence becomes theory |
| M13 | QoS lite: MQC `class-map`/`policy-map` with `match` and `set`, the lazily compiled policies, input marking at step 10c and output marking at `transmitOn` and after `vlanPush` with `QosMark` provenance, `show class-map`/`show policy-map [interface]`; the traffic generator (daemon, discard sink, `flows` table, host-shell `flow`, Traffic app); the FIFO congestion view (`PortSnapshot.txBacklog`, the `qos` overlay); the queueing sandbox on `core/queueing.ts` | The QoS objectives are describe-level; marking, congestion and the four disciplines become visible and one lab exists | 7.5 | W1 core, web-canvas; W2 qos, svc, cli, media, sim, web-concept, web-shell; W3 device, web-canvas, web-inspector, web-concept, web-desktop, qos (adapter) | QoS module becomes theory with static figures |
| M14 | Discovery: `udp`/`tcp` on managed switches with the dormant-transport rule (D22), control-table rows and the routed-port control check, CDP (NF format, daemon, table, `show cdp …`, `no cdp run`/`no cdp enable`), LLDP (IEEE, daemon, shows, transmit/receive), the table descriptors, lanes and FSM vocabulary of the management tables | Named objective (configure and verify CDP and LLDP); the P3 profile's one default | 4.8 | W1 l2, pdu, catalog (`cdpDefault`), l3 (dormancy); W2 disc, device; W3 cli, disc (adapter); W4 flip | Discovery lesson becomes theory; no P3 default |
| M15 | Device clock and NTP: the calendar epoch, unset boot, `clock set`/`timezone`, `show clock`; NTPv4 client/server/master with the non-periodic re-polls and bounded retries, stratum-16 answers, `ntp-peers` and the `clock` table, `show ntp associations\|status`, `service ntp`, the facts | Named objective (configure and verify NTP client and server) | 4.7 | W1 device, pdu; W2 svc, sim, cli; W3 cli, web-inspector, svc (adapter) | NTP lesson becomes theory |
| M16 | Device API: the configure seam (`deviceConfigure`, `config.result`, the origin through `applyConfigLine`), `http.request` with verbs and bodies, the tcp `tls` flag, the `restconf` daemon with the IETF/`nf-native` model, JSON encoding, Basic authentication, errors, `restconf-log`, `username … privilege`, the host-shell `rest` command with its verbatim `-d` | REST verbs, URIs, status codes, authentication and JSON on real (simulated) wires; lesson 38's lab | 4.5 | W1 auto, device, sim, cli, svc (`tls`); W2 http, sim, cli; W3 http (adapter) | Automation is theory only |
| M17 | Data-formats playground (JSON/YAML/XML parsers with positions, tree, conversion, practice, the device JSON samples) | Interpreting JSON is an exam objective; lesson 37's concept tool (no lab); the lesson code-sample parser | 2.0 | W1 auto; W2–W3 web-concept | Data formats taught from static examples |
| M18 | CCNA 3 course: skeleton and frozen ids, objectives as data, theory for 40 lessons, verified videos, 16 MUST labs with solutions and wrong-answer cases, the commands and data-format parse test, the course flip (the five labs of approved items and their tasks inside MUST labs are priced in those items, §8.2, §8.3) | The product for the learner | 7.4 | W0 course (profile data); W1 course; W5 the lab owners; W6 auto, course; W7 course | No course, only a sandbox |
| M19 | The acceptance suite (every `accept.p3.*` file of §10.1), web acceptance, gates | Proof | 2.7 | W0 architect (goldens); W4, W7 qa | — (never cut) |
| — | **Review contingency**, sized on the whole approved plan (≈ 10 % of 123.2 ew, §8.4; it was 7.0 ew, 10 % of MUST, before §8.5): unassigned effort for what the wave reviews find; P2's MUST grew about 6 % at its brief review alone (ARCHITECTURE-P2 §13), and P3a's cost figures are uncalibrated (see Units) | Keeps the plan honest | 12.3 | any wave, by the lead | — |

### 8.2 SHOULD — high value, cut only under pressure (≈ 85.8 ew in total; each is its own set of wave items)

**Approved for P3a (§8.5 P1, 2026-09-29): S1, S2, S3, S9, S13, S18, S19, S20, S21, S24, S25, S32 and S37 — 40.9 ew.**
Every other row is not approved and keeps its stage from §12.1; its "Wave items" column is the placement it would take
if approved later.

Each SHOULD item includes its own lab (0.15 ew) where it has one, its CLI lines and its visuals; cutting it removes
exactly its bracketed wave items and, where noted, turns a lesson's lab into theory (§11).

| # | Feature | Value | Cost | Depends on | Wave items | If not built |
|---|---|---|---|---|---|---|
| S1 ✓ | OSPF topology overlay and the port inspector's OSPF section | The spec §9.6 routing overlay: adjacency, DR/BDR, costs and refusals on the cables | 2.0 | M5 | W1 web-canvas; W2 web-shell; W3 web-canvas, web-inspector | OSPF is read from tables and show output |
| S2 ✓ | LSDB browser (dock tab `routing`, a listed hotkey migration) | "One area, one map" made visible; spec §2.3 names it | 2.0 | M5, S1 | W0 architect (dock stubs); W2 web-shell (`routingUi`); W3 web-routing; W4 web-shell (the tab shown) | The `ospf-lsdb` table in the Tables tab |
| S3 ✓ | SPF stepper and canvas SPF layer | Spec §2.3 "SPF tree animation" | 1.5 | S2 | W3 web-routing, web-canvas | The SPF result only |
| S4 | Multi-area OSPF (ABR, types 3/4, area scoping, IA routes, `show ip ospf border-routers`, area zones), lab 08 | Named in spec §2.3; concept-level on the exam | 3.0 | M5 | W3 ospf, cli; W5 ospf (lab) | Lesson 08 is theory |
| S5 | OSPF authentication (simple, simulated MD5), mismatch diagnostics | Spec §2.3 | 1.0 | M5 | W3 ospf, pdu, cli | Theory paragraph |
| S6 | OSPFv3 (daemon, v3 LSAs, `ipv6.routes`/`ipv6.group`, ip-upper v6, CLI), lab 09 | Spec §2.3; concept-level on the exam | 4.0 | M4–M6 | W3 ospf, l3, pdu, cli; W5 ospf (lab) | Lesson 09 is theory |
| S7 | Path-to-destination overlay | Spec §9.6 "Routing (any)" | 1.0 | — | W3 web-canvas | — |
| S8 | Convergence measurement and the `convergence` lab kind, with its contract block written in full (P2's S15 was never built) | "Tune timers and see the number drop" (spec §9.7) | 1.8 | M5 | W0 architect (block); W3 sim | Convergence read from timestamps |
| S9 ✓ | Wildcard visualizer concept tool | Spec §2.3 "wildcard masks with a bit-level visualizer"; wildcard questions are frequent | 1.5 | M7 | W2 web-concept (model); W3 web-concept (tool) | The subnetting workbench's derived wildcard field and practice question (`concept/subnetting/model.ts:193-218`, :475-538) |
| S10 | ACL workbench: hit view, packet tester (first-match walk), "why it stopped here" box, permit chips, `TraceFilter.reasons` | Spec §9.3 provenance for policy drops; first-match reasoning | 2.0 | M8 | W3 device, web-inspector | Drops show their rule text; counters via `show access-lists` and the Tables tab |
| S11 | IPv6 ACLs (mode, implicit ND tail, `traffic-filter`, `ipv6.resume`, ICMPv6 1/1, `ipv6 access-class`) | Spec §2.3 | 1.5 | M8 | W3 acl, l3, cli | IPv4 only; lesson 17's IPv6 task is theory |
| S12 | ACL extras: `log-input`, `no ip unreachables`, DSCP/precedence terms, NAT with extended lists | Completeness | 0.8 | M8 | W3 acl, nat, cli | — |
| S13 ✓ | Remote terminal: `vty`/`vty-client` over TCP, telnet and simulated SSH codecs, hidden listeners, `access-class` enforced, the `remoteCli` event path, the `vty-logins` table, the `service` kind, the terminal UX | "Telnet sends the password in the clear"; real refused logins; labs 15 and 19 graded through real logins | 4.5 | M8, M10, M14 (switch tcp) | W1 pdu, svc, device, l3; W2 cli, sim, acl; W3 svc, cli, acl (adapter), web-shell, web-inspector; W5 sim (`service`), acl and l2 (lab tasks) | Access is graded by configuration; the capture lesson is theory |
| S14 | ARP ACLs and DAI `validate` | Completeness | 0.8 | M12 | W3 l2, cli | Static hosts need `ip source binding` or trust |
| S15 | IP source guard | Spec §2.3 | 1.0 | M11 | W3 l2, cli | Theory in lesson 20 |
| S16 | Storm control | Spec §2.3 | 1.2 | — | W3 l2, cli | Theory in lesson 20 |
| S17 | IPv4 fragmentation and reassembly, DF / frag-needed, the ACL fragment rule | Fidelity for tunnels and large pings | 3.0 | M8 | W3 l3, pdu | Oversize packets are dropped with an honest reason |
| S18 ✓ | GRE tunnels (tunnel role, `gre`, `tunnels` rows, `virtualChanged`, the `ribWatch` lpm, the MTU fallback of D15 with `mtu-exceeded` and `icmp.error.param`, `ip tcp adjust-mss`), the `path` kind, lab 24 | Spec §2.3; site-to-site VPN hands-on; describe-level on the exam; the base of C13 | 4.3 | M4 (ribWatch) | W1 pdu, l3, catalog, device, web-canvas; W2 wan, cli, web-shell; W3 cli, wan (adapter), web-canvas, web-inspector; W5 sim (`path`), wan (lab) | Lesson 24 is theory (and C13 cannot be built) |
| S19 ✓ | PPP: codecs, RFC 1661 automaton, PAP, CHAP with real MD5, IPCP (+ peer route, IPV6CP), per-end line protocol, `username … password`, lab 22's PPP tasks | Spec §2.3; left the current exam blueprint | 5.2 | — | W1 pdu, wan (fsm, md5), media, cli, web-canvas; W2 media, device, l3, capture, cli; W3 wan (ppp and the hdlc switch), cli, wan (adapter), web-canvas, web-inspector; W5 course (lab tasks) | Lesson 22 practises HDLC; PPP is theory |
| S20 ✓ | Full QoS scheduler: held queues in the link model (QM2 less the pure core the sandbox already needs), LLQ with a conditional policer, CBWFQ by DRR, queue limits, 75 % admission and the queue lines of `show interfaces`, `frameQueued`, per-class queue lanes, the Policy section and the wait chip, the `traffic` lab kind, lab 27's LLQ tasks | Spec §2.3 "queuing (FIFO, WFQ, CBWFQ, LLQ)" and the congestion animation on real ports | 5.0 | M13 | W1 cli; W2 qos, cli; W3 media, device, cli, qos (adapter), web-canvas, web-inspector; W5 sim (`traffic`), qos (lab tasks) | The sandbox shows the disciplines; real ports stay FIFO |
| S21 ✓ | WFQ in class-default, policing, shaping, lab 27's policing task | Spec §2.3 "policing vs shaping" | 3.5 | S20 | W1 cli; W2 qos, cli; W3 media, device, cli; W5 qos (lab task) | Theory (and the sandbox) |
| S22 | WAN and VPN concept visualizer | Spec §2.3 WAN topologies, MPLS overlay, VPN types | 1.5 | — | W3 web-concept | Static figures |
| S23 | ACL lint badges and placement advisor / impact preview | Spec §2.3 "placement guidance" | 2.5 | S10 | W3 web-inspector | Placement taught in lesson text |
| S24 ✓ | Local logging: the `emitLog` seam, the logger buffer, levels, `show logging`, timestamp rendering, the visible P3 `service timestamps` lines | Syslog levels and timestamps on the device | 1.0 | M15 | W1 device, cli; W2 svc, cli; W3 cli, svc (adapter); W4 flip (the timestamps lines); W5 svc (lab task) | Severity is read from the trace's log rows |
| S25 ✓ | Syslog and extended logging: UDP 514, `logging host`/`trap`, the syslog-server and its viewer, the P3 extended-logging default, console and monitor printing | Syslog to a server; the P3 console experience | 2.0 | S24 | W1 pdu, l3 (dormancy); W2 device, cli; W3 svc, sim, web-inspector; W5 svc (lab tasks) | Lab 29 grades NTP only |
| S26 | Neighbours overlay (CDP/LLDP) | "Map an unknown network" on the canvas | 0.7 | M14 | W3 web-canvas | Tables and `show cdp neighbors` |
| S27 | API client desktop app | A GUI REST client (the `rest` command covers the objective) | 1.5 | M16 | W3 http (`gui` owner), web-desktop | The `rest` command |
| S28 | YANG browser | Spec §2.3 "YANG model browser" | 1.5 | M16 | W3 web-concept | The model shown in lesson text |
| S29 | Files and TFTP: storage, TFTP client/server, copy forms, `dir`, `show flash:`, files in schema 1.3, lab 31 | Spec §2.3 device file system, backup; describe-level | 3.2 | M14 (switch udp) | W3 svc, io, cli; W5 svc (lab) | Lesson 31 is theory |
| S30 | Image management (scaled copies, `boot system`, `show version` lines) | Spec §2.3 image upgrade | 1.5 | S29 | W3 svc, cli | Theory |
| S31 | Password recovery (break, ROMMON, configuration register, `cliBreak`) | Spec §2.3 | 1.5 | S29 | W3 cli, sim, web-shell | Theory |
| S32 ✓ | NF-Py scripting host, the automation workspace, NF-DEVHOST (a second flip in W6), lab 40; and the hosts' `files:` store it needs (the storage slice, `TopologyDevice.files`, `DeviceSnapshot.storage`, the dev-host shell: +0.5, since S29 is not approved, D21) | Spec §2.3 "Python scripting sandbox" | 6.7 | M16 | W1 auto, device, io; W2 auto, cli, sim; W3 http (adapter); W5 auto (`script-host`); W6 catalog (flip), web-desktop, auto (lab) | Lesson 40 is theory; scripts taught as read-and-predict exercises in the playground |
| S33 | SNMP v2c (BER codec, agent with a MIB-II subset, SET through the configure seam, traps, manager daemon and app), lab 30 | Spec §2.3; describe-level | 4.7 | M14 (switch udp) | W3 svc, pdu, web-desktop; W5 svc (lab) | Lesson 30 is theory |
| S34 | Local SPAN | Spec §2.3; feeds P4's IDS sensors | 1.0 | — | W3 l2, capture | Theory |
| S35 | CDP/LLDP-MED voice VLAN to IP phones (closes P2 deviation 7) | Removes the hand-set phone VLAN | 1.0 | M14 | W3 disc | The phone keeps its typed voice VLAN |
| S36 | GRE extras: recursive-routing detection and hold, IPv6 over GRE | The classic GRE-over-OSPF flap | 1.0 | S18 | W3 wan | — |
| S37 ✓ | P3b seams: `LabDocument`, schema and round trip, the lab-version golden, headless `gradeTopology` with a parity test, `resolveLab` | Makes P3b's assessment engine a thin wrapper | 1.7 | M3 | W0 architect (block); W5 io; W6 sim, web-shell; W7 qa | P3b does this work first |
| S38 | `packetSeen` with a clone capture tap | "Only ESP crosses the provider", "DSCP 46 on the wire" assertions | 0.4 | M3 | W5 sim | Other kinds only |
| S39 | Quiet-period settle for worlds that never idle | Robustness (P2 item 22c class) | 0.3 | M3 | W5 sim | The EtherChannel exception stays the only one |
| S40 | Dispatch hot-path profiling (loop-storm as the benchmark) | Suite time and R3 | 1.0 | — | W3 sim | — |
| S41 | CDP extras: native-VLAN and duplex mismatch logs, `show cdp traffic\|interface` counters | Classic CDP diagnostics | 0.5 | M14 | W3 disc, cli | Native mismatch still found by the P2 BPDU TLV |

### 8.3 COULD — C1 and C13 approved (12.5 ew); the others deferred (≈ 39.5 ew)

**Approved for P3a (§8.5 P2, 2026-09-29): C1 and C13 — 12.5 ew**, with their contract blocks written in full (§2.16,
§2.17) and their wave items placed in W1–W5 like the SHOULD items. Every other row keeps its stage from §12.1.

| # | Feature | Cost | Why it waits |
|---|---|---|---|
| C1 ✓ | EIGRP classic core (codec 0.8; neighbours and reliable transport 1.5; DUAL and the topology table 2.0; CLI and shows 1.0; the `'EIGRP'` RIB source and route codes 0.3; overlay 1.0; 2 labs 1.0; acceptance 0.4) | 8.0 | **Approved** (§8.5 P5; D26). It left the exam blueprint and the recommendation was P5; the classic core is built now, and P5 adds named mode, wide metrics and EIGRPv6 on the same daemon. Wave items: W1 pdu, l3, eigrp, cli, web-canvas; W2 eigrp, cli, web-shell; W3 cli, eigrp (adapter), web-canvas; W4 flip, qa; W5 eigrp (labs 10 and 33); W6 course (lesson 10's theory) |
| C2 | EIGRP stub, summarisation, unequal-cost load balancing | 2.5 | P5 |
| C3 | OSPF NBMA and point-to-multipoint | 1.5 | No Frame Relay medium; little value on Ethernet |
| C4 | OSPF stub, totally stubby, NSSA, type 7 | 3.0 | P5 (spec §2.4) |
| C5 | OSPF area range, summary-address | 1.0 | P5 |
| C6 | `redistribute static\|connected subnets` | 0.8 | Beyond the default route |
| C7 | OSPF MTU-mismatch lab (`ip mtu`, DBD MTU check) | 0.7 | Troubleshooting extra |
| C8 | OSPF scale: lazy LSDB rows, LSA interning, partial SPF | 1.5 | Only if `accept.p3.ospf-scale` shows the need |
| C9 | `timers throttle spf\|lsa` | 0.3 | CCNP |
| C10 | Time-based ACLs | 1.0 | Needs the device calendar (M15) |
| C11 | `exec-timeout` enforcement, `login block-for` | 0.8 | Builds on S13 (approved); waits for P4 with server AAA |
| C12 | Local AAA (`aaa new-model`, `aaa authentication login default local`) | 0.5 | Builds on S13 (approved); waits for P4 with server AAA |
| C13 ✓ | Site-to-site IPsec: VTI, IKEv2-lite, ESP with simulated crypto (codecs `esp` and `ikev2` 0.8; the `ike` daemon 1.5; the tunnel owner's ipsec mode 0.8; crypto CLI and shows 0.7; web banners and the tunnel's IPsec state 0.3; lab 25 0.15; acceptance 0.25) | 4.5 | **Approved** (§8.5 P10; D27); needs S18 (the tunnel owner), approved. Crypto maps, IKEv1 and remote access stay P4. Wave items: W1 pdu, l3, wan (pure IKE), cli; W2 cli; W3 wan (ike and the ipsec mode), cli, web-canvas, web-inspector; W4 flip, qa; W5 sim (`tunnelAt`), wan (lab 25); W6 course (lesson 25's theory) |
| C14 | PPP multilink | 1.5 | Builds on S19 (approved); beyond the course (P3c) |
| C15 | PPPoE client, server, dialer | 3.0 | Builds on S19 (approved); beyond the course (P3c) |
| C16 | Transparent CSU/DSU and cloud access lines for PPP | 0.7 | Builds on S19 (approved); lab 22 uses a direct cable (P3c) |
| C17 | GRE keepalives, `tunnel key` | 0.5 | Builds on S18 (approved); not needed by lab 24 (P3c) |
| C18 | MPLS label overlay on the provider cloud | 2.0 | P5 in practice |
| C19 | WRED, hierarchical QoS, AutoQoS, broader protocol recognition, `hold-queue` | 3.0 | CCNP (P5) |
| C20 | Invisible fair-queue default on slow serial lines (a P3 profile default) | 0.3 | Builds on S21 (approved), but fails the D2 rule's (b) |
| C21 | NETCONF (simulated SSH state, RFC 6242 framing) and XML encoding for RESTCONF | 2.5 | Recognise-level |
| C22 | Playbook runner (YAML plays over RESTCONF, idempotent, recap), lab 39 | 2.5 | Recognise-level |
| C23 | SNMPv3 (USM state, simulated crypto) | 1.0 | Needs S33 |
| C24 | FTP | 1.5 | Needs S29 |
| C25 | NTP authentication | 0.5 | CCNP |
| C26 | Controller-based networking concept visualizer | 1.0 | Lesson 36 text first |
| C27 | SDN controller mock with a northbound REST API | 3.0 | Overlaps P5's controller mock |
| C28 | Configuration archive / `configure replace` | 1.0 | P5 |
| C29 | `usbflash0:` | 0.5 | Needs S29 |
| C30 | Clock drift and calendar | 0.5 | No teaching value at CCNA level |
| C31 | Deep links `?lesson=` / `?lab=` (LTI resource links need them) | 0.5 | P3b needs them first |
| C32 | Demux `frame: 'data'` contract, trace VLAN key, TimelineStrip guard removal (P2 §14 leftovers) | 0.5 | Cosmetic |
| — | NetFlow/IPFIX exporter and collector (3.0), RSPAN (1.0) | defer | **P4**: the CyberOps flow records and IDS sensors need them |

### 8.4 The approved plan

**The plan the product owner approved on 2026-09-29 (§8.5 P1, P2, P13)** is the MUST plan, thirteen SHOULD items and
two COULD items. Summed item by item:

| Part | Items and costs (ew) | Subtotal |
|---|---|---|
| MUST | M1 4.1 + M2 1.8 + M3 3.9 + M4 3.0 + M5 9.6 + M6 2.5 + M7 2.0 + M8 2.8 + M9 1.5 + M10 1.5 + M11 2.0 + M12 1.5 + M13 7.5 + M14 4.8 + M15 4.7 + M16 4.5 + M17 2.0 + M18 7.4 + M19 2.7 | **69.8** |
| SHOULD, approved | S1 2.0 + S2 2.0 + S3 1.5 + S9 1.5 + S13 4.5 + S18 4.3 + S19 5.2 + S20 5.0 + S21 3.5 + S24 1.0 + S25 2.0 + S32 6.7 + S37 1.7 | **40.9** |
| COULD, approved | C1 8.0 + C13 4.5 | **12.5** |
| **The approved plan** | 69.8 + 40.9 + 12.5 | **123.2** |
| Review contingency | ≈ 10 % of the whole approved plan (not of MUST alone): unassigned effort for what the wave reviews find, spent before any cut | **12.3** |
| **The approved plan with the contingency** | 123.2 + 12.3 | **135.5** |

S32 is priced 6.7, not the 6.2 of the recommendation: it now carries the hosts' `files:` store that scripts need,
which the management map had put in its storage item (here [S29], not approved; D21, +0.5). The contingency grows from
7.0 (10 % of MUST) to 12.3 because every approved item is estimated by the same uncalibrated method as MUST (see Units)
and the approved plan has more seams (the remote-session event path, the tunnel owner shared by GRE and IPsec, the
link-model scheduler) than the MUST plan. For scale: P2's approved plan was ≈ 65 ew on a 52 ew MUST; P3a's is ≈ 1.9 ×
that, and ≈ 1.6 × the recommended plan (≈ 75.0 ew, ≈ 82.0 with its 7.0 contingency).

**How the maps' 117 ew of MUST became 69.8.** The raw sum of the maps' MUST items is 117.0 ew, about 2.25 × P2's MUST
(≈ 52 ew). Two things reduce it: duplicates (every map priced W0, goldens, grader kinds, lessons, labs and acceptance)
and demotions by exam value. The adversarial review then corrected two rows (QoS, management) and added the work its
findings required (§13). Item ids inside the second and third columns (O1, L1, QM1, V1, M13 …) are the maps' own.

| Map | Raw MUST (its items) | Duplicates of the cross-cutting lines | Demoted, with the reason | Kept in P3a MUST |
|---|---|---|---|---|
| Routing | 22.7 | 5.8 (O1 contracts and golden share, O10 lab kinds and labs less 0.2 of adapters, O11 acceptance, O12 lessons) | 2.0: the OSPF overlay → S1 (spec §19 names no overlay for P3; tables and show output verify the objective) | 14.9 (M4–M6) |
| ACLs and hardening | 26.5 | 6.7 (its L1 lab kinds less 0.3 of adapters, its course item C1, its Q1 golden and acceptance) | 8.8: the remote terminal V1 → S13 (4.0, the map's own "first MUST to cut"; configuration-level SSH meets "configure SSH"); `access-class` enforcement, A5's 0.3 → S13 (A5's other 0.2, storing and showing the line and grading it by configuration and facts, stays in M10 beside V2's 1.0); wildcard visualizer A6 → S9 (1.5; the subnetting workbench already derives and drills wildcards); hit view and packet tester A7 → S10 (2.0); lint A8a → S23 (1.0) | 11.0 (M7–M12) |
| WAN and QoS | 21.5 | 2.5 (WM3: contracts, stubs, golden, acceptance) | 12.5: PPP WM1 → S19 (4.5; left the current exam blueprint; HDLC plus theory, the map's own fallback); GRE WM2 → S18 (3.5; VPNs are describe-level; the first SHOULD to add, below); to S20, 4.5: the held queue and scheduler integration (QM2 less the pure core, 2.5), the admission check and `show interfaces` queue lines (0.5 of QM3), the per-class lanes, Policy section and wait chip (1.5 of QM5) | 6.5 of Q-lite (QM1 2.5, QM4 1.5, the MQC modes, lines and shows 1.0 of QM3, the FIFO overlay 1.0 of QM5, the pure `core/queueing.ts` 0.5 of QM2) + 1.0 promoted (the queueing sandbox, the map's QS4) = 7.5 (M13) |
| Management and automation | 29.0 | 5.4 (its profile-and-golden item M1 less 0.3 kept for D22, its lessons, labs and kinds item M14 less 0.3 of adapters, its acceptance item M15) | 8.7: files and TFTP M8 → S29 (3.0) and logging/syslog M7 → S24/S25 (3.0) (describe-level; the P3 profile then adds exactly one default); the API client M11 → S27 (1.5; the new 0.4 ew `rest` command meets the REST objective); the neighbours overlay, 0.7 of M13 → S26 (M13's other 0.3, the table descriptors and the lane and FSM vocabulary, stays in M14); CDP mismatch logs → S41 (0.5) | 14.9 + 0.4 new (`rest`) = 15.3 (M14 4.6, M15 4.3, M16 4.4, M17 2.0) |
| Cross-cutting | 17.3 | — | 0.4: `path` → S18 (only the tunnel lab needs it); plus 0.2 trimmed from videos (modules 13–14 expect low coverage) | 16.7 + 2.3 retained from the areas' duplicates (W0 contracts 0.8, the adapter framework 0.2, one consolidated acceptance suite 1.3) = 19.0 (M1–M3, M18, M19) |
| **Maps, reconciled** | **117.0** | **20.4** (2.3 of it retained in cross-cutting lines) | **32.4** (+ 0.2 trimmed) | **67.7** |
| Review additions (§13) | — | — | — | **+ 2.1**: M1 +0.3 (the two guard worlds and the fourth shard, `Course.profile` data in W0), M2 +0.3 (`staged.world`'s test-only P3 data, the injector), M3 +0.2 (the probe requests and their result surface), M5 +0.2 (the DR-change hello, the fixed `lsa-gen`/`spf` order, the `routerId` column), M10 +0.3 (switch scopes, `userSecretOf`, switch help goldens), M14 +0.2 (the dormant-transport rule and its acceptance), M15 +0.4 (kicks, bounded retries, stratum-16 answers, the `clock` table, the split offset), M16 +0.1 (`rest` option splitting, the origin through `applyConfigLine`), M18 −0.1 (lab 37 removed, lab 38 gains its JSON tasks, lab 20 loses its rate-limit tasks), M19 +0.2 (`accept.p3.switch-transport`, the coverage-parser rules) |
| **MUST** | | | | **69.8** (the review contingency is sized on the whole approved plan, above) |

The QoS row changed at review: the brief first kept only QM1, QM4 and QS4 (5.0) in M13 while M13 still named the MQC
modes and shows, the `qos` overlay and the pure scheduler, which the map had priced inside QM2, QM3 and QM5 and the brief
had moved whole to S20. The reconciled split above moves 2.5 ew of map work from S20 into M13 (5.0 → 7.5); S20 keeps
4.5 of map work plus 0.5 for its `traffic` lab kind and lab 27's LLQ tasks, which its earlier 7.0 (exactly QM2 + QM3 +
QM5) left unpriced (7.0 → 5.0).

- **The recommendation this replaces** was MUST + S1, S9, S37 (≈ 75.0 ew, ≈ 82.0 with a 7.0 contingency), with an
  "add if budget is found" order (S18, S24, S10, S25, S27, S2 + S3, S19, S4, S13, S32, S20). The product owner approved
  more than it: every item of that order except S10, S27 and S4, plus S21 and the COULD items C1 and C13 (§8.5).
- **Cut order, for use under pressure only** (the contingency is spent before any cut; each cut removes whole wave
  items, turns the named labs or tasks back into theory as §11 records, and must be recorded in §8.5 by the product
  owner). An item is never cut before the items that depend on it (C13 before S18, S21 before S20, S25 before S24, S3
  before S2 before S1):
  1. **The approved COULD items:** C1 EIGRP (−8.0: labs 10 and 33 become theory; D11's rule stays for P5), then C13
     IPsec (−4.5: lab 25 becomes theory).
  2. **The approved SHOULD items, lowest exam value per week first:** S21 (−3.5: lab 27 loses its policing task), S20
     (−5.0: lab 27 loses its LLQ tasks; real ports stay FIFO), S32 (−6.7: lab 40 becomes theory; no NF-DEVHOST, no
     second flip), S13 (−4.5: labs 15 and 19 graded by configuration again, as the MUST plan grades them), S19 (−5.2:
     lab 22 keeps HDLC only), S3 (−1.5), S2 (−2.0), S25 (−2.0: lab 29 keeps local logging), S24 (−1.0: lab 29 grades NTP
     only), S18 (−4.3: lab 24 becomes theory; possible only once C13 is cut), then S9, S1 and S37, as the recommendation
     had them.
  3. **Only then MUST**, in this order: M13 down to the traffic generator, the FIFO view and the sandbox (−3.5: no MQC,
     no marking, no QoS shows; the generator stays as the FIFO view's load source; lab 27 grades only the congested
     flow; possible only once S20 and S21 are cut), M17 to static lesson examples (−2.0; lesson 37 loses its concept
     tool; lab 38's JSON reading tasks stay), M12 DAI to theory (−1.5), M16 down to a read-only RESTCONF (GET only, no
     configure seam: −1.5; lab 38 reads and verifies instead of changing; S32 needs only `http.request`, so it survives
     this cut). M1–M6, M18 and M19 are never cut.
- Every bracketed item in §7 is its own item, so every cut removes whole wave items, and a block that is not approved
  is never added to the contracts (rule 3).

### 8.5 Decision record (product owner, recorded 2026-09-29, before wave 0)

Wave 0 cannot start until these are recorded here; the architect then adds exactly the approved blocks, and the exit
gate (W8) checks the scope list item by item. The product owner recorded every row on 2026-09-29; the approvals go
beyond the recommendation in P1, P2, P5 to P10 and P13, and §13's last subsection lists what that changed in this brief.

| # | Decision | Recommendation | Recorded |
|---|---|---|---|
| P1 | The SHOULD set built in P3a | S1, S9, S37 (≈ 5.2 ew); next in, if budget allows: S18, S24, S10, S25, S27 | **approved, beyond the recommendation: S1, S2, S3, S9, S13, S18, S19, S20, S21, S24, S25, S32, S37** (40.9 ew, §8.4); every other SHOULD keeps its stage from §12.1 — product owner, 2026-09-29 |
| P2 | The COULD set | none (each can be approved later, W7) | **C1 and C13** (12.5 ew); their contract blocks are written in full in §2.16 and §2.17 and they are built in W1–W5; every other COULD keeps its stage from §12.1 — product owner, 2026-09-29 |
| P3 | A `'P3'` defaults profile whose only default is CDP (invisible, on `cdpDefault` models: CLI routers and managed switches, and the controller; not the lightweight AP); the visible `service timestamps` lines only with S24; extended logging only with S25 | yes; CCNA 2 lessons and every saved P2 file keep P2 worlds (D2) | **approved as recommended**; since S24 and S25 are approved, a P3 world also replays the two `service timestamps` lines and has extended logging on (D2, §4.3) — product owner, 2026-09-29 |
| P4 | Fidelity fixes that change P1/P2 behaviour: applied in all profiles as listed digest changes, or gated by profile | all profiles, each listed in §9.3/§9.4 (D4); existing messages never change | **approved as recommended**: all profiles, each listed in §9.3/§9.4; existing messages never change — product owner, 2026-09-29 |
| P5 | EIGRP | C1, deferred to P5 with its CCNP depth; lesson 10 theory; the D11 route-code rule recorded for then | **approved, built in P3a as C1**: the classic core with its two labs (D26, §2.16, §3.12); stub, summarisation and unequal-cost sharing (C2), named mode, wide metrics and EIGRPv6 stay P5; the D11 route-code rule binds now — product owner, 2026-09-29 |
| P6 | PPP | S19 not in the first cut; lesson 22 practises the P1 HDLC link; PAP/CHAP taught as theory | **approved (S19)**: PPP with PAP and CHAP; lesson 22's lab keeps its HDLC tasks and gains the PPP and CHAP tasks — product owner, 2026-09-29 |
| P7 | QoS depth | QoS lite as MUST (M13, 7.5 ew: marking, traffic generator, FIFO congestion view, queueing sandbox); the full scheduler S20 (5.0) and S21 not in the first cut | **the full scheduler approved: M13 + S20 + S21** (16.0 ew): LLQ, CBWFQ, WFQ in class-default, policing and shaping on real ports; lab 27 gains its LLQ and policing tasks — product owner, 2026-09-29 |
| P8 | The remote terminal (telnet/SSH over the simulated network) | SSH configuration as MUST (M10, on routers and switches); S13 not in the first cut; the vty-ACL task and the secure-access lab graded by configuration | **approved (S13)**: vty over TCP, telnet and simulated SSH, `access-class` enforced; the vty-ACL task (lab 15) and the secure-access lab (lab 19) are graded live through real logins (D14, §3.14) — product owner, 2026-09-29 |
| P9 | The Python sandbox and its dependency | no dependency (Pyodide rejected, D21); NF-Py S32 not in the first cut; lesson 40 theory | **approved (S32)** with no external dependency: NF-Py in the engine, the automation workspace, NF-DEVHOST and lab 40; Pyodide stays rejected (D21) — product owner, 2026-09-29 |
| P10 | Site-to-site IPsec | C13, deferred to P4 with the security track; lesson 25 theory | **approved, built in P3a as C13**: VTI, IKEv2-lite, ESP with simulated crypto (D27, §2.17, §3.13), lesson 25's lab; crypto maps, IKEv1 and remote-access VPN stay P4 — product owner, 2026-09-29 |
| P11 | The next planned course card after CCNA 3 (the landing test needs one planned course) | one planned card for the P4 security track (original title, profile `'P3'`), replacing CCNA 3's planned card at the W7 flip | **approved as recommended** — product owner, 2026-09-29 |
| P12 | Legal review before the waves that ship them | the `%FAC-SEV-MNEMONIC` log shape (S24/S25) and the `requests`-style module name (S32) reviewed before W2 if those items are approved | **approved as recommended**: S24, S25 and S32 are approved, so both reviews happen before W2 — product owner, 2026-09-29 |
| P13 | **Scope list for the exit gate** ("CCNA 3 complete" for this stage) | M1–M19 plus the approved SHOULD and COULD items; every other SHOULD and COULD item recorded with its stage from §12.1 (`later:P3c`, P3b, P4, P5 or never); every §2.3 objective with its `handsOn` value (§11.4) | **approved as recommended**: M1–M19, S1, S2, S3, S9, S13, S18, S19, S20, S21, S24, S25, S32, S37, C1, C13; every other SHOULD and COULD item recorded with its stage from §12.1; every §2.3 objective with its `handsOn` value (§11.4) — product owner, 2026-09-29 |
| P14 | Managed switches' UDP and TCP (D22) | dormant until a P3 service is configured on the switch: P1 and P2 worlds and files saved before P3a keep their bytes (a switch SVI keeps answering "protocol unreachable"), proved by two synthetic guard worlds in the W0 golden; the live behaviour appears only where a learner configures NTP or the API | **approved as recommended** (with S13 and S25 approved, their wake-up lines are P3 lines only, D22) — product owner, 2026-09-29 |
| P15 | When the defaults profile flips, and deployment | `LATEST_DEFAULTS_PROFILE` flips to `'P3'` together with the course at W7 (not at the W4 catalog flip); `Course.profile` is data from W0; nothing is pushed to `master` before the W8 exit gate, wave commits go to a `p3` branch only, and the lead checks the remote after every workflow run (rule 21) | **approved as recommended** — product owner, 2026-09-29 |
| P16 | The P3a/P3b split and P3a's exit criterion | P3a = the CCNA 3 content (this brief), static site, no backend; P3b = the platform (assessment engine, authoring studio, LTI 1.3, collaboration) with its own brief and backend decision; P3a's exit criterion is P13's scope list, and spec §19's "instructors authoring their own labs" moves to P3b's exit criterion (P3a ships only the S37 seams if approved) | **approved as recommended**; S37 is approved, so P3a ships its seams — product owner, 2026-09-29 |

---

## 9. Migration list

Every existing test or golden that P3a deliberately changes, with how, by wave. Anything not listed must stay green
unchanged; a failure outside this list is a defect in the change, not a migration. Replacing an exact assertion
(`toEqual`, `toBe`) by a weaker one is never a migration: every entry keeps the assertion's strength and states the new
exact value (or the rule that computes it). Line numbers are at 5263f16; an owner who finds a pin moved lists its new
location in the wave report. The item that forces a migration performs it, in the same change.

### 9.1 Asserted unchanged (and why they stay green)

- `goldens/accept.p05.p0-sequences.json` via `accept.p05.determinism.test.ts`, `goldens/p1-profile-digests.json` via
  `accept.p2.p1-digests` (§9.3 lists no change), `accept.p1.silence`, every `accept.p05.*`, `accept.p1.*` and
  `accept.p2.*` test: the P3 profile exists only in P3 worlds, new daemons are silent (§4.3), a managed switch's new
  transport is dormant until a P3 service line is configured (D22), the new defaults (CDP, and the approved [S24]
  timestamps lines and [S25] extended logging) exist only in P3 worlds, and [S13]'s hidden vty listeners on routers
  whose P1/P2 configuration holds `line vty` write nothing and stay out of the tcp StateView (D14).
- `accept.p2.silence` (b) ("in a P2 world the only P2-daemon PDUs are BPDUs"): a P2 world never runs CDP by default. It
  builds on the P2-stage catalog (`p2.world.ts:136-146`), so the flip's silence proof is `accept.p3.silence` (a).
- `accept.p2.labs` and every P1/P2 lab test except the `SCENARIOS` pins of §9.2 W5: the grader split is proven
  behaviour-identical by `accept.p3.lab-status` (all 35 labs, every detail string).
- `ip.ipv4.test.ts:403-409` (ipv4 `handles` and fresh StateView): the MUST plan adds no ipv4 selector (OSPF arrives
  through ip-upper; ACL and routes through requests; the dormant-transport flag is internal state, not a handle).
  The approved [S18] (W1) and [S19] (W2) migrate it (§9.2 item 30); [C1] and [C13] add no selector (they arrive
  through ip-upper).
- `l2.eth-switch.test.ts` (StateView `toEqual` at :161): snooping and DAI state lives in tables; the StateView and every
  existing debug message are unchanged (`l2.eth-switch.p2-parity.test.ts` proves the path without the lines).
- The `show ip route` legend pinned by the P1 digests' typed transcripts (`show.ts:320`): the second line appears only
  with a routing process.
- `core.acl.test.ts` and the NAT tests: `parseStandardAclEntry` is unchanged (`:35` still refuses `… 0.0.0.255 log`);
  `readStandardAcls` strips a trailing `log` before parsing, which no P2 document can contain (the P2 grammar has no
  `log`); NAT's "undefined list permits nothing" rule (`acl.ts:109-112`) is unchanged; `show access-lists` for a
  NAT-only list prints exactly as today (no counters).
- `core.rib-arbiter.test.ts:139`: `maxPaths` still defaults to 1; only ipv4's arbiter options change.
- `http-client` browser tests (`http.fetch`, the `https:` refusal at `http-client.ts:277`, header `:10`):
  `http.request` is a new request; the browser path is untouched.
- `hdlc` StateView and debug pins, `accept.p05.serial-clock`: unchanged (the approved [S19] adds a branch that is a
  strict no-op when the effective encapsulation does not change; `wan.hdlc-switch.test.ts` pins it, W3).
- The P1 `log` TraceEvent of every existing log site: unchanged by the approved [S24] `emitLog` seam
  (`device.emit-log.test.ts`, W1); console printing of logs happens only in P3 worlds or after a typed `logging
  console` ([S25]), so no P1/P2 typed transcript gains a log line.
- The link model's virtual FIFO on every port without a queueing policy: unchanged by the approved [S20] held queue
  (`link.p2p.scheduler.test.ts`, W3).
- Every config-AST test without `seq`: `apply` behaves exactly as today; `ip access-list standard <number>` keeps its
  section storage (`config-rules.ts:280`).
- `device.catalog.define.test.ts:136-152` and every P0.5–P2-stage fixture: `cdpDefault` and the staged snooping tables
  are derived only for `defineModel(…, 'P3')`, like every stage-derived member.
- `device.catalog.p2.test.ts:81` (`L2_TABLES`) and every P2-stage table list: `STAGED_PROCESS_TABLES` applies only at
  stage P3 (§2.6).
- `l4.udp.test.ts` and the tcp/udp StateView pins: the discard rule applies only on a device that runs `traffic` and
  only to its ports; the `probes` member is absent until a probe runs, which happens only in grader clones; [S13]'s
  hidden listeners never appear in the tcp StateView.
- The web's `reconcileInflight` (`apps/web/src/store/store.ts`) and its tests: unchanged; the FIFO view reads
  `PortSnapshot.txBacklog` (D16).
- `learn.course-profile.test.ts` until W7: `profileForCourse` keeps its rule until the course flip (D2).

### 9.2 By wave

**W0 (architect, course, qa, web-shell)**

1. Exhaustive records gain their entries (compile stubs, the final values where the contract decides them):
   - web: `DROP_VOCAB` +5 (the two MUST reasons and the approved `mtu-exceeded`, `policed`, `ipsec-no-sa`),
     `PROTOCOL_VOCAB` +18 (the five MUST protocols and the thirteen approved ones: `telnet`, `ssh`, `gre`, `ppp`, `lcp`,
     `pap`, `chap`, `ipcp`, `ipv6cp`, `syslog`, `eigrp`, `esp`, `ikev2`), `FSM_VOCAB` +10 machines (`ospf-if`,
     `ospf-nbr`, `ntp`, `tunnel`, `ppp-lcp`, `ppp-auth`, `ppp-ncp`, `eigrp-nbr`, `eigrp-route`, `ike`), `LANE_VOCAB` +2
     (`mgmt`, `wan`), `GUI_PANEL_VOCAB` +2 (`desktop.traffic`, `desktop.automation`), err-disable labels +2, the
     provenance reason vocabulary +1 `QosMark` (`vocab/fields.ts`), the capability label `programmable`, the concept
     registry +3 (`queueing`, `data-formats`, `wildcard`); `PANEL_TAB` (`inspector/tabs.ts:87`) and
     `SURFACE_PANEL_TAB` (`shared/openDeviceSurface.ts:38`) +2, and `shell.surface.test.ts:31` pins the new exact
     record; `REASON_ICON` and `REASON_LABEL` (`inspector/Provenance.tsx:72, :90`) +1 `QosMark`;
     `DEFAULT_TIMELINE_LANES` (`store/store.ts:77`) gains `'mgmt'` and `'wan'` last, so `store.timeline.test.ts:54-56`
     (it pins the constant to `LANE_IDS`) stays green unchanged; [S2] `dock/registry.ts` gains `DockStage` `'P3'` and
     the `routing` row at stage P3 (hidden: `DOCK_STAGE` stays `'P1'` until W4, so `buildDockTabs()` and the hotkey pins
     are unchanged in W0) and `app/Dock.tsx` a placeholder entry;
   - engine: `ERR_DISABLE_CAUSE_TEXT` (`device/device.ts:210`) +2 original texts; `TABLE_DESCRIPTORS`
     (`contracts/tables.ts:468`) +20 with their final values (the twelve MUST tables and the approved `vty-logins`,
     `tunnels`, `ppp`, `syslog-messages`, `script-runs`, `eigrp-neighbors`, `eigrp-topology`, `ipsec-sa`);
     `timeline/lanes.ts` `FSM_MACHINE_LANES` +10 and `TABLE_LANES` with the §2.12 entries; `GUI_PANEL_SINCE` and the
     define.ts panel record +2.
   `vocab.test.ts` assertions unchanged; the new entries satisfy them (unique letters, no banned words).
2. `ConceptToolId` (D24): `contracts/scenario.ts:49`, `apps/web/src/store/types.ts:62` and `apps/web/src/labs/
   markdown.ts:23` read the one contract. The markdown tests that pin the allowlist keep every case and gain exact
   cases for `concept:queueing`, `concept:data-formats` and the approved `concept:wildcard` [S9]; an unknown id is
   still refused.
3. **The P1-guard migration** (`accept.p2.p1-digests.test.ts:598-605`): "every daemon outside the P1 list has only
   `since: 'P2'` rows" becomes "only rows whose `since` is a stage after P1 (`P2` or `P3`)", and "every table outside the
   P1 list has a `since: 'P2'` descriptor" becomes "a `since` of `P2` or `P3`", both still asserted per name with
   `toEqual([])` / membership in the exact two-element set; the normalisation (`normaliseSnapshot`, :262-290) becomes
   the per-device rule of §4.6 item 2 (a process's StateView and owned tables are removed from a device that derives it
   only through later-stage rows; later-stage tables and `PortSnapshot.txBacklog` are removed); on the recorded golden it
   removes nothing. The header comment (:33-34) is updated.
4. `test/p2.world.ts`: the `@deprecated` aliases are deleted; their three importers (`cli.wlc.test.ts`,
   `device.catalog.p2.test.ts` and `p2.world.ts` itself) use the real names, assertions unchanged.
   `test/staged.world.ts` is new; `createP2Simulation` stays as a wrapper.
5. `BUILD_STAGES` and `DEFAULTS_PROFILES` pins become the exact five- and three-element arrays. Since `'P3'` is now a
   valid profile, `sim.profile.test.ts:51` asserts that `profile: 'P4' as DefaultsProfile` throws exactly
   `RangeError('profile must be one of P1, P2, P3, got P4')` (`sim/simulation.ts:311-312` builds the text from
   `DEFAULTS_PROFILES`).
6. New goldens (new files): `p2-profile-digests.json` (32 worlds, the two guard worlds included), `p2-lab-exports.json`,
   `lab-status.p2.json`; §9.3/§9.4 govern every later change to them.
7. Web test type errors (8) are fixed by typing the tests, never by loosening an assertion; the pending P1 web fixture
   migration is finished; check 3b added.
8. `accept.p2.replay-exact` is split into `accept.p2.replay-exact-templates`, `-ccna1` and `-ccna2` (hyphenated, so
   `ACCEPT_P2`, `accept.p2.coverage.test.ts:20`, matches them), assertions unchanged. `accept.p2.coverage.test.ts:37-51`
   gains one explicit shard record: the row `accept.p2.replay-exact.test.ts` of the closed P2 brief is satisfied by
   exactly those three files, each of which must exist, and every `accept.p2.*.test.ts` file must still be a listed file
   or one of its shards (both directions kept; the P2 brief is not edited). Engine vitest gets `fast`/`slow` projects;
   no test is skipped.
9. `worker.delta.test.ts`: the "always-post while paused" cases run in a fresh module with an explicit drain helper;
   assertions unchanged.
10. `ScenarioInfo.customChecks` gains `@deprecated` (comment only).
11. `timeline.lanes.test.ts`: `EXPECTED_TABLES` (:86, typed over `ExtraTableName`) gains the twenty P3 tables with
    their §2.12 lanes (`ospf-interfaces`, `ospf-neighbors`, `ospf-lsdb` → `routing`; `acl`, `arp-inspection` →
    `security`; `dhcp-snooping` → `dhcp`; `cdp-neighbours`, `lldp-neighbours`, `ntp-peers`, `clock` → `mgmt`;
    `restconf-log` → `config`; `flows` → `undefined`; and the approved `vty-logins` → `security`, `tunnels`, `ppp`,
    `ipsec-sa` → `wan`, `syslog-messages` → `mgmt`, `script-runs` → `undefined`, `eigrp-neighbors`, `eigrp-topology` →
    `routing`); `EXPECTED_MACHINES` (:111, typed over `FsmMachine`) gains `ospf-if`, `ospf-nbr` → `routing`, `ntp` →
    `mgmt`, and the approved `eigrp-nbr`, `eigrp-route` → `routing`, `tunnel`, `ppp-lcp`, `ppp-auth`, `ppp-ncp`, `ike`
    → `wan`; :152, :158 and :167 keep their assertions (they compare with the constants, which gain the same entries);
    :198-199 becomes "numbers the fourteen lanes 0..13" with `LANE_IDS` equal to the twelve P2 ids followed by
    `'mgmt'` and `'wan'`.
12. `curriculum/index.ts` gains `Course.profile` data (course): `profileForCourse` does not read it until W7, so no pin
    moves.

**W0 rulings (lead architect, 2026-09-30).** Decided after the W0 build and its review; binding like the rest of this
brief. Where a ruling and an earlier line of this document differ, the ruling wins.

- **R1.** `RouteRow.source` gains `'O'` and `'EIGRP'` in W0. The authorised stub edit is
  `apps/web/src/inspector/TablesView.tsx` `SOURCE_TITLE`: two entries, in original wording. Nothing writes either
  value before the item that implements it.
- **R2.** `TraceEvent` `'frameQueued'` [S20] is added in W0. The authorised stub is one case in
  `apps/web/src/simmode/sim-events-client.ts` (a label only, no behaviour), together with the entry that the exhaustive
  `TRACE_KIND_VOCAB` (`vocab/trace-kinds.ts`, a W0 stub file) needs. Only the [S20] held queue (W3) emits the kind.
  The typed records `SAMPLE` and `EXPECTED_BY_KIND` of `timeline.lanes.test.ts` gain the kind, in no lane (`laneOf`
  is unchanged).
- **R3.** `PortEncap` `'tunnel'` [S18] is added in W0. The authorised stub is one entry in `device/pipeline.ts`
  `ENCAP_ALLOWS` (no framing accepted). The exhaustive switch of `capture/tap.ts` `captureLinkForEncap` also needs a
  case, which returns `raw`, as for `'none'`; the [S18] capture owner confirms it. No port carries the value before
  the [S18] item derives `TUNNEL_FAMILY`. W0 migration: `device.pipeline.roles.test.ts:161` pins the exact record
  with `tunnel: []` added (still `toEqual`).
- **R4.** `FramingProto` `'ppp'`, `MediumOp` `'ppp-link'` and `CaptureLinkType` `'ppp_hdlc'` [S19] are NOT added in W0.
  They land with the [S19] items that write the PPP framing (`FRAMING_RULES`), the link (`link/link.ts` `mediumOp`) and
  the capture code (`capture/tap.ts`).
- **R5.** The `HostAppRequest` traffic apps (M13) and the [S32] apps are NOT added in W0. Each lands with the W2/W3
  sim item that adds its `HOST_APP_PROCESS` row.
- **R6.** The FIFO congestion view is named `PortSnapshot.txBacklog?: PortTxQueueView` (optional by meaning). The
  required P0 member `txQueue: number` is untouched, so neither `goldens/accept.p05.p0-sequences.json` nor the P1
  digests move. This brief says `txBacklog` everywhere it meant the new data (D16, §1.1, §2.8, §2.14, §2.15, §3.5,
  §4.3, §4.6, §6, §7, §8.1, §9, §10, §13). Both digest normalisers (§4.6 item 2) remove `txBacklog` and keep `txQueue`.
- **R7.** Schema 1.3: W0 declares only `TOPOLOGY_SCHEMA_ID_1_3` (and, types only, `Topology.profile` 'P3' and [S32]
  `TopologyDevice.files`). The W1 io item adds the id to `TOPOLOGY_SCHEMA_IDS`, `LATEST_TOPOLOGY_SCHEMA_ID` and
  `schemaIdFor`, as a reviewed additive edit of `contracts/topology.ts`.
- **R8.** Pure helpers in contract files land in W1 with their owners, as reviewed additive edits: `contracts/clock.ts`
  `formatClock`, `ntpTimestamp` and `fromNtpTimestamp` (the W1 core/svc clock item), and `contracts/lab-document.ts`
  `labDocumentOf` and `scenarioOf` (the [S37] item). W0 stays types only.
- **R9.** Accepted as built:
  - `LabDocument.tasks` is `LabTask[]`, and faults keep their `at`.
  - The `acl.check` family is `4` only.
  - `CONCEPT_TOOLS` is not extended in W0. Each tool lands with its item, which then migrates
    `concept.views.test.ts:171` (the exact list gains that tool).
  - The table descriptors have no past-timestamp columns.
  - `CAPABILITY_PROCESSES` gains `programmable: []`.
  - W0 migration: `vocab.test.ts`'s exact FSM machine list (`state-machine vocabulary [S14]`) grows by the ten P3
    machines of item 1 (`ospf-if`, `ospf-nbr`, `ntp`, `tunnel`, `ppp-lcp`, `ppp-auth`, `ppp-ncp`, `eigrp-nbr`,
    `eigrp-route`, `ike`). It is still an exact array compared with `toEqual`. This replaces "`vocab.test.ts`
    assertions unchanged" in item 1 for that one list.
- **R10.** Open item for W1: the [S13] owner specifies how a remote CLI session's output reaches the vty daemon.
- **R11.** (W0 close-out, architect, 2026-09-30.) The 18 P3 field tables live in `P3_PROTO_FIELDS`
  (`contracts/fields.ts`), which nothing reads, so NetScope's display filter in P1/P2 worlds is unchanged in W0; each
  W1 **pdu** codec item moves its protocol's table into `PROTO_FIELDS` in the same change as its codec, registry and
  dispatch lines (§2.3, §7 W1 pdu).
- **R12.** (W0 close-out.) R2's exhaustive `TRACE_KIND_VOCAB` entry makes a "Queued" chip (count 0) appear among the
  simulation-mode filter chips in every world — a web-only change, accepted; engine bytes are untouched.
- **R13.** (W0 close-out.) The first W0 recording of `p2-profile-digests.json` stripped each port's P0 frame count
  `txQueue`, which §4.6 does not ask for. The harness keeps that deletion behind the transitional
  `GOLDEN_STRIPS_TX_QUEUE = true` so the tree stays green. Re-recording the four digest shards' snapshot hashes with
  the constant `false` (only `snapshot` / `snapshotParts` may move) is an architect action that needs the product
  owner's permission in this environment; until then the P2 golden does not see transmit-queue changes (the P1
  golden, which keeps `txQueue`, still does). It must be done before the W2 items that touch transmit accounting.
  **Done 2026-09-30** with the product owner's authorisation: the four shards were re-recorded with the constant
  `false`; only `snapshot` / `snapshotParts` moved in the 32 worlds (every event, window, count and typed result
  byte-identical); the constant and its branches are deleted.

**W1**

13. `pdu.codecs.test.ts:57` registry key order: the P3 codecs are appended after the P2 codecs, in the order `ospf`,
    `ospf-lsa`, `cdp`, `lldp`, `ntp`, then the approved ones in the `ProtoName` order of §2.3: `telnet`, `ssh`, `gre`,
    `ppp`, `lcp`, `pap`, `chap`, `ipcp`, `ipv6cp`, `syslog`, `eigrp`, `esp`, `ikev2` (exact array).
14. Reserved dispatch entries: UDP 123 decodes as `ntp` (no longer `reserved`, `fields.ts:470-476`,
    `services.ts:6-7`); TCP 443 decodes as `http`; with the approved items TCP 23 and 22 decode as `telnet` and `ssh`
    [S13] and UDP 514 as `syslog` [S25], and the new entries IP 47, 88, 50 and UDP 500 decode as `gre`, `eigrp`, `esp`
    and `ikev2`; UDP 69 (tftp), 161 (snmp) and TCP 21 (ftp) stay reserved. Tests pinning the reserved list get the new
    exact list; the pdu owner greps for any P1 fixture that carries one of these ports or protocols and lists it with its
    new decoded layer list (the P2 §9.2 item 5b precedent: only dispatch changes, never bytes).
15. io: `io.migrate.test.ts` — `LATEST_TOPOLOGY_SCHEMA_ID` becomes `'netforge.topology/1.3'`, `TOPOLOGY_SCHEMA_IDS`
    `toEqual` the four ids, every step still reaches the latest id; `io.schema.p2.test.ts:80` (latest is 1.2) becomes
    1.3; the messages of `io.migrate.test.ts`, `io.netforge-file.test.ts:354` and `io.schema.test.ts` list four ids
    (same regular-expression strength). P1 and P2 documents still export as 1.1 and 1.2, byte-identical; a document
    with [S32] host files exports as 1.3.
16. The profile sweep (`arp.ts:178`, `sim/simulation.ts:798`, `sim/snapshot-cache.ts:453`, `sim/scenarios/kit.ts:110`,
    `io/schema.ts:266`): each P2 literal becomes a "P2 or later" rule; the P2 tests stay green unchanged and gain P3
    cases.
17. The grader split: `sim/lab-checks.ts` keeps exporting `evaluateLab`; test imports are unchanged.
18. `test/pure-entry.lint.test.ts`: the allowed source directories gain `automation/` (exact list).
19. Required runtime members (`ProcessCtx.clock`, `CommandCtx.clock`, `DeviceRuntime.clockView`, `setClock`, and the
    approved [S24] `emitLog`, [S20] `egressPolicy`, [S32] `ProcessCtx.files` / `readFile` in the items that implement
    them): the typed fakes gain the `P3_CTX` / `P3_DEVICE` spreads, assertions unchanged — the P2 list (`l2.eth-switch.test.ts:94`,
    `ip.fake-ctx.ts:166`, `arp.harness.ts:139`, `l4.udp.test.ts:133`, `cli.runtime.fake.ts:167`,
    `cli.runtime.p05.fixture.ts:53`) plus `l2.eth-switch.p2.harness.ts:144` and `udp.tunnel.test.ts:87`, and any other
    the compiler finds, named in the wave report. No `DeviceRuntimeDeps` member is added (D21), so the five
    `createDevice` harnesses (§2.15) are untouched.
20. The control rows (W1 l2): `l2.control.test.ts:68` — an LLDP frame (`01:80:c2:00:00:0e`, 0x88cc) now classifies as
    exactly `'lldp'`, and the file gains the NF CDP case → `'cdp'`; the other reserved examples of that case (:64-67,
    :69) stay `'reserved'`. `l2.eth-switch.vlan.test.ts:187-193` ("a reserved link-layer group frame is dropped
    not-for-me") takes `01:80:c2:00:00:0f` with ethertype 0x0800 as its example (still reserved: the same exact drop
    with `DETAIL_RESERVED_GROUP`), and a new case pins LLDP at a switch that does not run `lldp`: drop `not-for-me`,
    detail exactly `lldp is not running on this device`.

**W1 additions (recorded at the W1 fix and integrate step, 2026-10-01).** Pins the W1 items forced without a line above;
each keeps its assertion's strength.

20a. pdu (knock-ons of items 13 and 14): `pdu.codecs.p2.test.ts:69` and `lag.pagp.test.ts:33` pinned the registry's
     tail (`slice(-8)`, `slice(-2)`); each keeps its exact array at the P2 codecs' position (`slice(21, 29)`,
     `slice(27, 29)`) and gains `[...CODECS.keys()][29]` `toBe('ospf')`. `pdu.codecs.transport.test.ts:300` used TCP 23
     as the reserved example: it now decodes exactly `['ipv4', 'tcp', 'telnet']` ([S13]), and the reserved case moves to
     TCP 21, exactly `['ipv4', 'tcp', 'payload']` (ftp stays reserved).
20b. io (knock-ons of item 15: the load gate normalises the in-memory copy to the latest id, the exporter still writes
     `schemaIdFor`): `io.schema.p2.test.ts:138-141` — the loaded P2 document `toEqual({...p2Doc(), schema: 1.3})`, plus
     `schemaIdFor(loaded)` exactly 1.2; `:198-200` — `TOPOLOGY_MIGRATIONS[1.2].to` is 1.3 and `TOPOLOGY_MIGRATIONS[1.3]`
     is undefined; `:222-223` — `loaded.schema` is 1.3.
20c. l3 (M4, the §2.3 row for 89; item 30 covers only the approved 47, 50 and 88): `ip.upper.test.ts:24-31` —
     `IPV4_UPPER` exactly `[[1,'icmpv4'],[6,'tcp'],[17,'udp'],[47,'gre'],[50,'gre'],[88,'eigrp'],[89,'ospf']]`;
     `ipv4UpperEntry(89)` (was undefined) `toEqual({protocol: 89, process: 'ospf', label: 'ospf'})`; the unknown-protocol
     case keeps an exact `toBeUndefined()`, on 253.
20d. cli (the approved [S24] rules of §5.7): `cli.modes-rules.test.ts:114` used `logging buffered` as a global line
     without a rule; it now `toEqual` the rule `{pattern: ['logging', 'buffered', '<rest>'], contexts: [''], identity: 2,
     cardinality: 'single'}`, and the no-rule case keeps an exact `toBeUndefined()`, on `snmp-server community public`.
20e. Item 19, the typed fakes the compiler found when `CommandCtx.clock` became required (W1 fix): `cli.p05.fixture.ts`
     and `cli.show.fixture.ts` gain `clock: P3_CTX.clock` (the unset view); assertions unchanged.

**W1 rulings (architect, 2026-10-01)**

- **R14.** The W1 fix's `pathOrder` option in `core/rib-arbiter.ts` (equal-AD, equal-metric paths of one owner install
  in batch order; absent = the P1/P2 order) is accepted as a reviewed additive edit of the l3/core owner's file.
- **R15.** `CommandCtx.clock` is required (the W1 fix applied rule 2 early). `PortTxQueueView` frame entries gain
  `dscp?` (optional by meaning; written by the W2 snapshot cache; normalised away with `txBacklog` in the goldens) —
  §2.15 lists it.
- **R16.** `L2_CONTROL` keeps the five P2 rows (pinned by `l2.control.test.ts:101-107`) and the seven-row
  `L2_CONTROL_TABLE` (adding cdp and lldp before reserved) is what dispatch reads; D18's wording "L2_CONTROL gains
  cdp and lldp" is read as "the control table". No migration.
- **R17.** A switch that opens an outbound client session ([S13] `telnet`/`ssh` from its own CLI) wakes its dormant
  transport for that session, like a configured service, so the reply is not dropped (D22). Owner: the [S13] item of
  W2/W3, with a case in `ip.switch-transport.test.ts`.
- **R18.** `LabCheckResult` gains `misconception?` (optional by meaning, the analytics tag of the envelope), and the
  widened `route` / `table` assertion members are implemented by the W2 **sim** grader item (with their wrong-answer
  cases in `sim.lab-checks.p3.test.ts`).
- **R19.** `CourseObjective` / `ObjectiveHandsOn` stay in `curriculum/ccna3/objectives.ts` (data-module types; the W8
  gate decides whether they move to `contracts/curriculum.ts`).
- **R20.** The device `storage` action enforces the io limits (256 files per device, 255-character names, 1 MiB per
  file) — owner: the [S32] writer item of W2.
- **R21.** The ESP SA key id is an encode-only input of the `esp` codec (`keyId`, never decoded, not in
  `PROTO_FIELDS`); the ICV keeps an unkeyed integrity word and a chain word so wire damage shows, and the tunnel tail
  checks the keyed word with `espIcvKeyMatches` (§2.17 note). The [C13]/[S18] tunnel owner puts `keyId` from
  `tunnel.sa` into the pushed `esp` layer.
- **R22.** The web `RESERVED_PROTOCOL_VOCAB` drops ntp, ssh, telnet and syslog (now decoded) — owner: the W2 web
  item.

**W2**

21. Help lists (W2 cli, and again W3 cli): `goldens/cli-help.p05.json` regenerated, guarded by
    `cli.help-superset.test.ts` against the frozen P1 copy; the exact inline lists of
    `cli.grammar.help-goldens.test.ts:60-64` rewritten as complete literal arrays, still `toEqual`, with the keywords of
    the approved items included (marked below):
    - :60 `router.nf2911` `config-if ethernet/routed` → `['bandwidth', 'cdp', 'delay', 'description', 'do', 'duplex',
      'encapsulation', 'end', 'exit', 'fair-queue', 'ip', 'ipv6', 'lldp', 'mac-address', 'no', 'service-policy',
      'shutdown', 'speed', 'standby']` (`delay` [C1], `fair-queue` [S21]; OSPF, EIGRP and ACL interface lines sit under
      the existing `ip`);
    - :61 `router.nf2911` `config` → `['access-list', 'banner', 'cdp', 'class-map', 'clock', 'crypto', 'do', 'enable',
      'end', 'exit', 'hostname', 'interface', 'ip', 'ipv6', 'line', 'lldp', 'logging', 'no', 'ntp', 'policy-map',
      'restconf', 'router', 'service', 'username']` (`logging` [S24]/[S25]; `crypto` also leads the [C13] sections,
      `router` also `router eigrp` [C1]);
    - :62 router `user-exec` gains exactly `ssh` and `telnet` [S13] in sorted position, otherwise unchanged; :64
      `pc.nfpc` `user-exec show` unchanged;
    - :63 `pc.nfpc` `user-exec` → `['adapter', 'arp', 'exit', 'flow', 'ip', 'ipconfig', 'ipv6', 'ipv6config',
      'netstat', 'no', 'nslookup', 'ping', 'rest', 'show', 'ssh', 'telnet', 'tracert']` (`ssh`, `telnet` [S13]).
    The golden file's other lists move by the same rules; at W3 (final): `router.nf2911` `config-if serial/wan` →
    `['bandwidth', 'clock', 'delay', 'description', 'do', 'encapsulation', 'end', 'exit', 'fair-queue', 'ip', 'ipv6',
    'keepalive', 'no', 'ppp', 'service-policy', 'shutdown']` (CDP and LLDP run on Ethernet only, D18; `delay` [C1],
    `fair-queue` [S21], `ppp` [S19]); `router.nf2911` `priv-exec show` → `['access-lists', 'arp', 'cdp', 'class-map',
    'clock', 'crypto', 'history', 'hosts', 'interfaces', 'ip', 'ipv6', 'lldp', 'logging', 'ntp', 'policy-map', 'ppp',
    'restconf', 'running-config', 'ssh', 'standby', 'startup-config', 'users', 'version']` (`crypto` [C13], `logging`
    [S24], `ppp` [S19]); the switch lists (D14 widens `ip domain-name` and the ACL lines to `managed-switch`):
    `switch.nfc2960` `config` → `['access-list', 'banner', 'cdp', 'clock', 'crypto', 'do', 'enable', 'end', 'errdisable',
    'exit', 'hostname', 'interface', 'ip', 'line', 'lldp', 'logging', 'no', 'ntp', 'port-channel', 'restconf',
    'service', 'spanning-tree', 'username', 'vlan']`, `config-if ethernet/switched` → `['cdp', 'channel-group',
    'description', 'do', 'duplex', 'end', 'exit', 'ip', 'lldp', 'mac-address', 'no', 'shutdown', 'spanning-tree',
    'speed', 'switchport']`, `priv-exec show` → `['access-lists', 'arp', 'cdp', 'clock', 'dtp', 'errdisable',
    'etherchannel', 'history', 'interfaces', 'ip', 'lacp', 'lldp', 'logging', 'mac', 'ntp', 'port-security',
    'restconf', 'running-config', 'spanning-tree', 'ssh', 'startup-config', 'users', 'version', 'vlan']`, `config-if
    virtual/svi` unchanged (SVIs refuse `service-policy`); the new lists of the Tunnel interface [S18]/[C13], the four
    crypto modes [C13], `config-router-eigrp` [C1] and the NF-DEVHOST shell [S32, at the W6 flip] are recorded as new
    golden entries. The W2 lists are the W2 subsets of these (the W3 shows join at W3); every other model follows the
    same rules by capability, and each regenerated list is named in the wave report.
22. `cli.modes-rules.test.ts:62`: `config-router` loses `reserved` and `config-ext-nacl`, `config-cmap`, `config-pmap`,
    `config-pmap-c` are added, with the approved `config-router-eigrp` [C1] and `config-ikev2-keyring`,
    `config-ikev2-keyring-peer`, `config-ikev2-profile`, `config-ipsec-profile` [C13], in the W2 cli change whose
    grammar enters them; the assertion keeps `toEqual` with the complete new literal array in MODES declaration order.
    As in P2 §9.2 item 12b, removing those `reserved` flags in the architect-owned `contracts/cli.ts` is the only edit
    the W2 cli item may make there (the new modes themselves are W0 contract members).
23. `topoOverlays` persisted slice: a persist migration adds `qos: false` and the approved `ospf: false`, `ospfArea:
    null` [S1], `wan: false` [S18]/[S19], `eigrp: false`, `eigrpPrefix: null` [C1]; `store.topo-overlays.test.ts` pins
    the default object with the new exact value. [S2]'s `routingUi` is not persisted and moves no persistence pin.
24. **`show errdisable recovery`** (W2 l2, forced by appending `ERR_DISABLE_CAUSES`; D13): the output gains two rows
    after `channel-misconfig`. In `cli.port-security.test.ts:183-206`, `out[4]` is `/^dhcp-rate-limit\s+off$/` and
    `out[5]` is `/^arp-inspection\s+off$/` (new exact lines); `'Recovery interval: 30 s'` moves from `out[5]` to
    `out[7]` (and the later `'Recovery interval: 300 s'` from `[5]` to `[7]`); `MSG_NO_ERR_DISABLED_PORT` and the port
    table header move from `out[7]` to `out[9]`, and the port rows from `out[8]`/`out[9]` to `out[10]`/`out[11]`. Every
    assertion keeps its matcher. W2 cli appends the two causes to `ERRDISABLE_RECOVERY_CAUSES`
    (`cli/grammar/errdisable.ts:20`) before `'all'`, which changes the refusal text `% Give the cause: …`: a test
    pinning it gets the new exact text. No golden script types the command (D3).
25. `worker.profile.test.ts:195-264` (the pure `withCurrentDefaults` suite): the worker now delegates to
    `sim/defaults-upgrade.ts` (whose own tests carry the same cases since W1); the suite keeps every case and assertion
    against the worker's function.
26. `userSecretOf` (`cli/runtime.ts:383-388`): tests of the `username X secret|password Y` forms unchanged; the
    privilege form gains exact cases.

**W2 additions (recorded at the W2 fix and integrate step, 2026-10-02).** Pins the W2 items forced without a line
above; each keeps its assertion's strength (an exact value stays an exact value; line numbers are the current ones).

21b. cli (knock-ons of item 21: the W2 fold puts `P3_GRAMMAR_FRAGMENTS`, then `P3_APPROVED_GRAMMAR_FRAGMENTS`, after
     the P2 fragments in `GRAMMAR_FRAGMENTS` / `GRAMMAR`, and their handlers in `HANDLERS`):
     - help lists, all still `toEqual` complete arrays: `cli.parser.help.test.ts` user-exec (:44) = item 21 :62, config
       and the routed port (:65, :67) = item 21 :61 and :60, the PC (:221) = item 21 :63, the router `show ` subtree
       (:79) and `cli.grammar.p05.test.ts:271` → `['access-lists', 'arp', 'class-map', 'clock', 'history', 'hosts',
       'interfaces', 'ip', 'ipv6', 'policy-map', 'running-config', 'standby', 'startup-config', 'version']` (the W2
       subset of item 21's show list), `show ip ` (:88) → `['access-lists', 'arp', 'dhcp', 'interface', 'nat', 'ospf',
       'route', 'sockets']`, `no ` on the routed port (:152) → `['bandwidth', 'cdp', 'delay', 'description', 'duplex',
       'encapsulation', 'fair-queue', 'ip', 'ipv6', 'lldp', 'mac-address', 'service-policy', 'shutdown', 'speed',
       'standby']`; `cli.grammar.p05.test.ts:171-172` the serial port → item 21's final `serial/wan` list (complete
       at W2) and the routed port → item 21 :60, :235 the laptop shell gains `flow`, `rest`, `ssh`, `telnet` (before
       `wifi`), :246 the PC = item 21 :63; `cli.grammar.p1.test.ts:222` `config-line` → `['access-class', 'do', 'end',
       'exec-timeout', 'exit', 'login', 'no', 'password', 'transport']` (§5.2); `cli.nat.test.ts:86` a named standard
       list → `['deny', 'do', 'end', 'exit', 'no', 'permit', 'remark', '<1-2147483647>']` (§5.2 sequence numbers and
       `remark`).
     - D14 (the ACL lines widened to `managed-switch`): `cli.nat.test.ts:94-98` — `access-list 1 permit any` on
       `switch.nfc2960` now matches exactly `{ok: true, handler: configAccessList, args: {form: 'any', number: '1',
       action: 'permit'}}`; two new exact cases keep NAT a router's (`ip nat inside source …` and `ip nat pool …` do
       not match on the switch).
     - the table: `cli.parser.grammar.test.ts` `EXPECTED_IDS` (:101-130) gains every `P3_HANDLERS` and
       `P3_APPROVED_HANDLER_IDS` id in fragment order, and the fragment keys (:173-176) gain `ospf, acl-p3, hardening,
       qos, discovery, time, api, ssh, eigrp, wan, crypto, qos-queueing, logging, remote, devhost` after `wlc` (exact);
       "every path begins with a keyword" (:183-215) admits exactly the four sequenced named-ACL specs whose first
       element is `<seq>` (`naclEntryP3` and `naclSeq` in `config-std-nacl` and `config-ext-nacl`), pinned as an exact
       set with the exact `seq` ArgSpec; `cli.vlan.test.ts:233-242`, `cli.stp.test.ts:429-439` and
       `cli.wlc.test.ts:303-309` — the table is the P1 fragments, the P2 specs, then exactly `P3_GRAMMAR`, `wlc` closes
       the P1/P2 block (exact slices instead of "the last N specs"); `cli.modes.p2.test.ts:42` and
       `cli.wlc.test.ts:283-287` — `modesOfClass('config')` is item 22's complete list (exact).
     - the regenerated `goldens/cli-help.p05.json` (item 21) moves 124 lists, additions only, no list removed; the
       `ppp …` lines are offered on `wan`-role serial ports only (`grammar/wan.ts` `PPP_PORT`), so the serial access lines
       of `csu.nfcsu` and `cloud.nfinternet` stay unchanged (D17: HDLC only).
23b. web-shell (knock-on of item 23): `overlays.registry.test.ts:60` pins `TOPO_OVERLAY_DEFAULTS` with the six new
     defaults (exact object). The constant lives in web-canvas's `canvas/overlays/registry.ts`; its six keys are a
     reviewed additive edit by web-shell, forced by the now-required `TopoOverlayState` keys.
26b. web (ruling R22): `vocab.test.ts:593-600` — `ntp`, `ssh`, `telnet` and `syslog` keep their exact former labels and
     are exactly absent from `RESERVED_PROTOCOL_VOCAB`.
30b. l3 [S19] (the receive side item 30 left out; verified W2 findings 2 and 7): `IPV6_HANDLES` gains `{layer: 'ppp',
     ethertype: PPP_PROTO.ipv6 (0x0057), roles: ['wan']}` after the HDLC selector, so IPv6 framed by nd over PPP is
     demultiplexed to ipv6; nd's PPP branch drops `link-down` (detail `IPv6CP is not open on <port>`) while the port's
     `ppp` row has an `ipv6cp` other than `'opened'` (absent counts as not negotiated; no row, no gate — arp's IPCP gate
     mirrored). No existing test pinned the ipv6 handles; `ip.ppp-plumbing.test.ts` pins the exact array, the demux and
     the gate. The W3 `wan.ppp` test adds an IPv6 ping across the PPP link.
30c. device [S25] (the extended-logging default of P3 worlds): `device.emit-log.test.ts:102-170` — a P3 world's router
     boots with exactly one log, `%SYS-5-BOOTED` (`systemStartedMessage(model)`), as trace bytes and as the logger's
     `log.record`; the cases that asserted "nothing logged at boot" pin exactly that line first and slice past it for
     the rest (still `toEqual`); the P1/P2 cases are unchanged.
30d. Knock-ons of item 30, each still `toEqual`: `device.pipeline.roles.test.ts:162` `ENCAP_ALLOWS.ppp` → `['ppp']` (R4:
     the W2 device item adds `FramingProto` `'ppp'` with its `FRAMING_RULES`, and `contracts/catalog.ts`
     `macFilterApplies` treats `ppp` like `hdlc` — a frame without a destination MAC is never MAC-filtered — a reviewed
     extension of R4 in the same change); `sim.capture.test.ts:274` `CAPTURE_LIVE_FCS_LEN` gains `ppp_hdlc: 0` (the
     exhaustive record of the new `CaptureLinkType` member); `device.role.test.ts:120-139`, `device.subif.test.ts:188`
     and `cli.handlers.p05.test.ts:138-152` get the accepting `encapsulation ppp` case (`{ok: true}`; the handler's
     `{}` and its `configCalls` entry; `pppUnavailable` and `MSG_PPP_NOT_AVAILABLE` are deleted, the access-line
     refusal is `DEVICE_CONFIG_MESSAGES.pppAccessLine`).

**W2 rulings (architect, 2026-10-02)**

- **R23.** The W2 fix's additive contract members are accepted: `CommandCtx.profile?`, `.setMonitor?`, `.files?`,
  `.readFile?`; `DeviceRuntime.files?`, `.readFile?`; the `remoteOutput` SimEvent (a remote session's output is
  delivered in its own dispatch, never re-entering the device's `applyActions`); `macFilterApplies` (item 30d). The W8
  gate settles their optionality with the rest.
- **R24.** `udp.send` gains `dscp?` (optional by meaning; absent = 0, today's bytes) — owner: the W3 **svc** item, so
  application traffic can carry a marking without a policy.
- **R25.** `LoggerStateView` becomes a contract type (`contracts/process.ts`, additive) — owner: the W3 **svc** item;
  the same item aligns the logger's default console level with `log-render`'s.
- **R26.** `PolicerSpec` gains its conform and exceed actions, and the conform/exceed counts reach
  `show policy-map interface` through `DeviceRuntime.qosCounters` — owners: the W3 **qos** and **cli** items.
- **R27.** The l3 half of R17 (an outbound telnet/ssh client session wakes a switch's dormant transport) and its case
  in `ip.switch-transport.test.ts` — owner: the W3 **l3** item.
- **R28.** Web worker tests: each re-imports the whole engine (442 modules after W2, ~1.2–1.8 s per import on the
  current disk), so a cold first run times out at 5 s. The W3 **web-shell** item makes those tests reset only the
  worker module and keep the engine module cached (or an equivalent that cuts the per-test import cost); no timeout is
  raised.
- **R29.** `accept.p2.loop-storm-bounded` now runs ~317 s alone (647 s in the full suite), above its 300 s literal,
  which vitest cannot enforce on a synchronous test; the W8 gate decides (P2 §9.2 22e carried). A repository on a
  synced cloud folder slows file reads; moving it to a local folder is the product owner's call.
- **R30.** The §10.3 W2 gate's "`rest` with no arguments (the usage text)" is met by the host shell's house rule: a
  command missing its arguments answers `% More input is required to complete this command.` exactly as `ping` and
  `flow` do, and `rest ?` names the verbs. No separate usage text is added.
- **R31.** "Run to idle" (`app/PlaybackControls.tsx`, since P1) warns "Stopped after 200 000 events; the queue is
  still busy." whenever `pendingEvents > 0`, but an idle run (D10) always leaves the periodic maintenance timers
  pending, so any world with a router warns after a normal idle run. The warning is shown only when the run stopped
  at its event cap (`RunStats.stopped === 'maxEvents'`), carried through the bridge by a minimal additive change —
  owner: the W3 **web-shell** item, with a test for both cases.

**W3**

27. `show access-lists` for an applied list gains ` (N matches)` on rows with N > 0: no P2 test applies a list to an
    interface (P2 had no filtering), so no existing pin moves; asserted.
28. The protected banner (`PacketInspector.tsx:263-280`): the DTLS case keeps its exact text; `protectedBy: 'tls'` adds
    a case.
29. (moved to W4, item 36b: the [S2] dock tab is shown there.)
30. The approved [S18] and [S19] (and [C1], [C13]) plumbing pins, each moved by the item that forces it:
    `ip.ipv4.test.ts:403-406` handles gain `{layer: 'ipv4', roles: ['tunnel']}` (W1 l3 [S18]) and `{layer: 'ppp',
    ethertype: 0x0021, roles: ['wan']}` (W2 l3 [S19]) — exact new arrays; any pin on `IPV4_UPPER` gains 47 [S18], 88
    [C1] and 50 [C13] (W1 l3); `capture/tap.ts:78-80` maps `ppp` to `ppp_hdlc` (W2 capture); `nd.ts:143-148` maps
    `ppp` to PPP framing (W2 l3); the encapsulation refusals (`device.ts:316-317`, :1404; `cli/handlers/serial.ts:24-25`,
    :61) are removed and their tests get the accepting case (W2 device and cli).
30b. The protected banner (with item 28): `protectedBy: 'ssh'` [S13], `'esp'` and `'ike'` [C13] add cases; the DTLS
    and TLS cases keep their exact text (W3 web-inspector).

**W4 (the flip)**

The flip's own pins move to `device.catalog.p3.test.ts` with P3 values; the P2 catalog tests keep pinning the P2 layer
exactly, **filtered to `since: 'P2'` or computed at stage P2** (the contract constants are not stage-derived, so "same
assertions, stage made explicit" alone cannot hold):

31. `protocols.registry.test.ts:57-63` and `:66-100` (the exact factory map) gain the seven P3 daemons and the eight
    approved ones (`ppp`, `gre`, `vty`, `vty-client`, `logger`, `syslog-server`, `eigrp`, `ike`), with their factories
    in `PROCESS_ORDER`; `:121` (`processFactory('ospf')` is undefined) names a daemon that stays unregistered in P3a:
    `'ospfv3'` ([S6], not approved; `'eigrp'` is registered now, and `'script-host'` would move again at W6), same
    assertion.
32. `device.catalog.p2.test.ts`: :92-95 → `CATALOG_STAGE` `'P3'`, every `*_DATA_STAGE` `'P3'`, `validateCatalog(…,
    {stage: 'P3', …})` `[]`; :103-104 → `PROCESS_ORDER.filter((n) => !P3_DAEMONS.includes(n))` equals
    `P2_ORDER_AFTER_W6` exactly, and `PROCESS_ORDER` itself is pinned in `device.catalog.p3.test.ts`; :118 unchanged;
    :130-136 → each capability's rows filtered to `since: 'P2'` equal the same exact P2 arrays (`routing` and `host`
    filtered before `slice(-4)` / `slice(-1)`; `lightweight-ap` gains no P3 row and stays exact); the derived-model
    pins at :92-95, :149, :151, :168, :170, :196, :198, :207-208 and :243 are computed with `defineModel(…, 'P2')`
    (`staged.world` at stage P2), same exact arrays.
33. `device.catalog.data.test.ts`: :79 and :86-88 (every `*_DATA_STAGE` equals `CATALOG_STAGE`): the flip edits the
    seven data files (`routers`, `switches`, `multilayer`, `datacentre`, `legacy`, `security`, `computers.ts`);
    :187-188, :199 and :211 (derived lists of the data models) get the new exact P3 lists (the P2 list with the §2.1
    names inserted at their `PROCESS_ORDER` positions by capability, and their tables); :213 (NF-WLC-9800's tables) gains
    exactly `cdp-neighbours`, `ntp-peers` and `clock` (its `cdp` and `ntp` rows) and never the snooping tables.
34. `device.catalog.define.p2.test.ts:82, :103, :186`; `device.catalog.end-devices.test.ts:76, :131, :139, :146, :164`
    (hosts gain `traffic`, `flows` and [S13] `vty-client`; servers `ntp`, `ntp-peers`, `clock` and [S25]
    `syslog-server`, `syslog-messages`); `device.catalog.network-data.test.ts:81-82`;
    `device.catalog.test.ts:31, :47, :67`: each gets its new exact value from the §2.1 rows by the rule of item 33, or,
    where it pins the P2 layer on purpose, is computed at stage P2.
35. Table lists: `apps/web/test/tabs.test.ts:177-184` (a managed switch's Tables tab gains, in `PROCESS_ORDER` order of
    their daemons, `dhcp-snooping`, `arp-inspection`, `cdp-neighbours`, `lldp-neighbours`, `acl`, `sockets`, the
    approved `vty-logins`, then `ntp-peers`, `clock` and `restconf-log`, all empty); `sim.snapshot-cache.test.ts:166-176`
    (the home router gains the empty `ospf-interfaces`, `ospf-neighbors`, `ospf-lsdb`, `acl`, `cdp-neighbours`,
    `lldp-neighbours`, `ntp-peers`, `clock` and `restconf-log` tables and the approved `ppp`, `tunnels`, `vty-logins`,
    `eigrp-neighbors`, `eigrp-topology` and `ipsec-sa` through its `routing` implication). The exact arrays are derived by
    `deriveTables` and written literally.
36. `CATALOG_STAGE` pins elsewhere become `'P3'`. `LATEST_DEFAULTS_PROFILE` does **not** change here (W7). [S24] the
    P3 `profileConfig` of routers, managed switches and the controller gains the two `service timestamps` lines: a pin
    on a P3-stage model's `profileConfig.P3` gets the new exact list (no P1/P2 profile list moves).
36b. [S2] (W4 web-shell, moved from W3): `DOCK_STAGE` becomes `'P3'`, so `buildDockTabs()` gains `routing` after `labs`
    and `hotkeys.test.ts:141-143, 155-157` get the new exact arrays (the digit hotkey `9` goes to `routing`).
37. The D22 rows of §9.3/§9.4: none (dormant transport); the flip moves no P1/P2 digest.

**W5**

38. `SCENARIOS` gains `CCNA3_LABS` after `CCNA2_LABS`: `accept.p1.labs.test.ts:52` and `labs.solutions.test.ts:74`
    (`SCENARIOS.slice(T + C1)` equals `CCNA2_LABS`) become `SCENARIOS.slice(T + C1, T + C1 + CCNA2_LABS.length)` equals
    `CCNA2_LABS` plus `SCENARIOS.slice(T + C1 + CCNA2_LABS.length)` equals `CCNA3_LABS`; `labs.ccna2.solutions.test.ts:193`
    (`SCENARIOS.length`) becomes `t + c1 + CCNA2_LABS.length + CCNA3_LABS.length`, and `:196` the bounded CCNA 2 slice
    plus the CCNA 3 tail. They pin by reference to the arrays, so W6's automation lab moves nothing. `accept.p2.labs`
    filters by category and is unchanged.
39. `apps/web/test/filemenu.groups.test.ts:29-35`: `CATEGORY_ORDER` equals `['template', 'ccna1-lab', 'ccna2-lab',
    'ccna3-lab']` and the groups end with `['ccna3-lab', 'Labs: CCNA 3']` (exact); the case title names the CCNA 3 labs.
40. `accept.p2.replay-exact` gains a CCNA 3 shard, the new file `accept.p3.replay-exact-ccna3.test.ts` (listed in
    §10.1), assertions as the P2 shards (it covers the approved labs 10, 24, 25 and 33 and the approved tasks of the
    MUST labs, remote sessions included).

**W6 (the [S32] flip)**

40b. NF-DEVHOST joins `computers.ts`: the catalog's model lists and counts by category, the Computers palette pins and
    `device.catalog.end-devices.test.ts` get the new exact values with `pc.nfdevhost`; `CAPABILITY_PROCESSES` gains the
    `programmable` row and `PROCESS_ORDER` `script-host` (the pins of item 31–33 are re-derived by the same rules);
    `docs/CATALOG.md` gains the model (architect). No P1/P2 digest moves (no shipped world holds the model).

**W7 (the course and profile flip)**

41. `learn.course-profile.test.ts:43` (`profileForCourse('ccna3')` is `'P2'`) becomes `'P3'` — a changed pin, not a new
    case; `:44-47` (null, undefined, `''`, an unknown id → `LATEST_DEFAULTS_PROFILE`) become `'P3'`; `:48-49` (only
    CCNA 1 is classic) unchanged; `:174` (every course has a profile) becomes membership in `['P1', 'P2', 'P3']`.
42. `worker.profile.test.ts:144-193`: `useCurrentDefaults` gives `'P3'`; the "no-op on a world already at current
    defaults" case uses a P3 world; a new exact case upgrades a P2 world (File → "Use current defaults" is now enabled
    for P2 worlds).
43. `curriculum.test.ts:74-91` (:75 the exact course ids gain the planned P4 card's id; :90) and
    `learn.landing.test.ts:62-72` (:66 "not Start CCNA 3" becomes "Start CCNA 3"; :72 CCNA 3 is `available`), `:86-87`,
    `:105`, `:137-138`: CCNA 3 is `available`; the new planned card (§8.5 P11) keeps "at least one planned course" true,
    with its exact title and "No lessons in this release." text.
44. The CCNA 2 description pin stays; the CCNA 3 description placeholder is rewritten (its pin gets the new exact text).

**W8**

45. `contracts.optional-by-meaning.test.ts` gains the §2.15 rows; `Course.profile` becomes required (web course
    fixtures gain it).
46. `customChecks` removed (`contracts/scenario.ts:205`, `:216`; the comment at `sim/lab-checks.ts:103`); no test uses it.

### 9.3 P1-profile digest changes (the only ones allowed)

`test/goldens/p1-profile-digests.json` may change only as listed here; the architect regenerates the affected entries
and attaches the per-event diff to the wave report, and a regeneration is accepted only when **every** changed event is
of the listed kind.

| | Wave | Scenarios | Changed events, and nothing else | Why |
|---|---|---|---|---|
| (a) | W4 catalog | none | **no change.** Managed switches derive `udp` and `tcp` from the flip, but their transport is dormant until a P3 service line is configured (D22), and no P1 world can hold one (`line vty` alone never wakes it); the synthetic P1 guard world (`accept.p3.p2-digests-guards`) proves it with DHCP, traceroute and a browser fetch aimed at a switch SVI. The approved daemons the flip adds are silent (§4.3), and [S13]'s hidden listeners on routers whose P1 configuration holds `line vty` write no event and stay out of the tcp StateView (D14) | D22, D14, byte-preserving by design |
| (b) | any | none identified at W0 | the events of a defect fix the product owner approves under §8.5 P4, recorded when it lands | D4 |

Everything else — the W4 flip, the new daemons, the ACL hooks, the pipeline and eth-switch steps, the log paths, and
the approved items' seams ([S24] `emitLog`, [S19] the hdlc switch, [S20] the held queue, [S13] the hidden listeners)
— must leave every P1 digest byte-identical; the lead proves it by running the test inside those changes, and each byte-risky
item runs it itself (rule 9).

### 9.4 P2-profile digest changes (the only ones allowed)

`test/goldens/p2-profile-digests.json` (and its two companion goldens) follow the same rule.

| | Wave | Scenarios | Changed events, and nothing else | Why |
|---|---|---|---|---|
| (a) | W4 catalog | none | **no change**, as §9.3 (a), in P2 worlds; the synthetic P2 guard world proves it | D22 |
| (b) | the fixing item | only if approved and confirmed a defect | e.g. the cross-cutting map's "a multilayer switch relays DHCP with `no ip routing`": the exact relay events the fix removes | D4 |

---

## 10. Acceptance tests

Definition of done for P3a:

- the six checks green, the slow project green, and gate G passed on the final build;
- no test deleted, weakened or skipped; the exit gate applied;
- `accept.p2.p1-digests` and `accept.p3.p2-digests-*` green with only the §9.3/§9.4 changes (none planned);
  `accept.p3.lab-status` green;
- every acceptance scenario run 3× with the same seed gives byte-identical trace and snapshot JSON;
- the legal scan clean.

Times below are sim time. "Link-up" is the `linkState up` event of the cable in question. From W4 the tests build their
worlds with `staged.world`, which equals the real catalog once the flip has landed. Counts that follow from constants
(TCP retries, NTP retries, flow caps) are computed from the constants in the test, never typed as numbers.

### 10.1 Engine acceptance (`packages/engine/test/`)

The table is machine-read by `accept.p3.coverage` (W7), with the rule `accept.p2.coverage.test.ts:37-51` uses: every
row's first column is exactly one back-ticked file name matching `^accept\.p3\.[a-z0-9-]+\.test\.ts$`, optionally
followed by a wave or an `[Sn]` / `[Cn]` tag; one file per row, no brace expansions. A row tagged `[Sn]` or `[Cn]`
is required only when that item is approved: the coverage test carries the approved list of §8.5 P1 and P2 as an exact
array, written in W0 — `['S1', 'S2', 'S3', 'S9', 'S13', 'S18', 'S19', 'S20', 'S21', 'S24', 'S25', 'S32', 'S37',
'C1', 'C13']` — so the rows of [S13], [S18], [S19], [S20], [S21], [S24], [S25], [S32], [S37], [C1] and [C13] are
required, and the rows of unapproved items ([S4], [S5], [S6], [S11], [S16], [S17], [S29], [S31], [S33], [S34], [S36])
stay listed as the designs of their stage and must not exist as files in P3a.

| Test | Scenario and pass condition |
|---|---|
| `accept.p3.p2-digests-templates.test.ts` (W0) | The 9 templates of D3 with the fixed script: the digest and per-kind counts over **all** event kinds, the per-10-second-window digests, the stored non-background event lines, the typed results and the normalised snapshot hash equal `goldens/p2-profile-digests.json` exactly; a mismatch names its world and window. §9.4 lists the only allowed changes. |
| `accept.p3.p2-digests-labs-a.test.ts` (W0) | As the templates shard, for the first ten CCNA 2 labs loaded exactly as the worker's `loadScenario` loads them. |
| `accept.p3.p2-digests-labs-b.test.ts` (W0) | As the templates shard, for the other ten CCNA 2 labs and the P2 `addDevice` sandbox. |
| `accept.p3.p2-digests-guards.test.ts` (W0) | The two synthetic D22 guard worlds (profile P1 and P2: an NF-C2960 with Vlan1 addressed and up, a router DHCP server, two DHCP PCs, a router `traceroute` to the SVI, a browser fetch to the SVI) equal their recorded digests exactly: every DISCOVER and REQUEST still dies in ipv4 as `unsupported-protocol`, the traceroute ends with protocol unreachable, the fetch fails the P2 way. |
| `accept.p3.p2-exports.test.ts` (W0) | Every CCNA 2 lab exported after load equals `goldens/p2-lab-exports.json` byte for byte (schema 1.2, `profile: 'P2'`). |
| `accept.p3.lab-status.test.ts` (W0) | All 35 CCNA 1 and 2 labs: the `evaluateLab` status with every detail string, unsolved at 60 s and solved at the end, equals `goldens/lab-status.p2.json`. |
| `accept.p3.silence.test.ts` (W4) | (a) Every template and CCNA 1 lab (P1) and every CCNA 2 lab (P2), 600 s, on the real (flipped) catalog: no `pduCreated`, `tableWrite`, `tableExpire`, `log` or `debug` event attributable to `ospf, acl, cdp, lldp, ntp, restconf, traffic` or to the approved `ppp, gre, vty, vty-client, logger, syslog-server, eigrp, ike`, including `sockets` rows; no tableWrite on a P3 table; no drop with a P3 reason; no IP-protocol-89, -88 or -50 PDU and no UDP-500 PDU; no 224.0.0.5/6/10 join; no `frameTx` of a CDP or LLDP frame; no `frameQueued`; no `configChange` carrying an `origin`; no udp or tcp delivery on a managed switch (the CCNA 2 labs whose switches hold `line vty` included); the tcp StateView of every router with `line vty` byte-identical to the P2 golden's. (b) A blank P3 world (NF-2911, NF-C2960, two PCs), 600 s: the only P3-daemon PDUs are CDP frames, all background; each one that reached a PC was dropped `not-for-me` with `background: true`; no other new PDU. (c) `cdp run` typed in a P2 world: CDP neighbours appear exactly as in (b). |
| `accept.p3.profile.test.ts` (W4) | `createSimulation({seed, profile: 'P3'})` has profile P3; a P3 world exports `profile: 'P3'`, schema 1.3, and reloads to an identical snapshot; a P2 world still exports 1.2 byte-identically. CDP runs on every `cdpDefault` model (NF-2911, NF-C2960, NF-C3650-24, NF-WLC-9800) in P3 and on none in P2; a home router and NF-AP-1832 never run it. **Completeness:** `no cdp run` and `no cdp enable` in a P3 world, and `cdp run` in a P2 world, survive export, reload and a lab clone (running configuration, CDP rows and PDUs identical in all three). Proxy ARP is still on for a routed interface of a P3 router (the `arp.ts:178` trap). The pure ladder `sim/defaults-upgrade.ts` taken to P3 on a P2 world gives profile P3, schema 1.3 and CDP rows after boot, with no configuration line rewritten (`useCurrentDefaults` itself reaches P3 only after the W7 flip, §10.2). |
| `accept.p3.switch-transport.test.ts` (W4) | D22 on the real catalog: the guard world built in P3 answers exactly as the P2 golden (dormant: 3/2, `unsupported-protocol`, no udp or tcp delivery, no `sockets` row); after `ntp server` on the switch a unicast datagram to a closed port draws 3/3, a SYN draws a RST, and the NTP exchange works; after `restconf` + `ip http secure-server` the API answers; removing the last such line restores 3/2. |
| `accept.p3.grader-bounded.test.ts` (W5) | For every CCNA 3 lab (the approved labs 10, 24, 25 and 33 and the approved tasks included): the unsolved, solved and each wrong-answer world reach idle under `runToIdle` within the clone's event cap; a world with a mismatched OSPF hello, a stuck ExStart, an NTP server that never answers (six fast retries, then only the periodic poll), [S19] a failed CHAP, [C1] an EIGRP K-value mismatch and [C13] a wrong IKE key or a silent IKE peer each returns in fewer than 5 000 events. |
| `accept.p3.ospf-p2p.test.ts` (W4) | Two NF-2911 on a GigE point-to-point link, plus a serial variant: FULL within link-up + 1.5 s; no DR; the packet order is exactly Hello, Hello (reply), DBD (I/M/MS) ×2, DBD …, LSR, LSU, LSAck; the point-to-point link originated at link-up + 5 s; the route installed by the SPF at link-up + 15 s ± 10 ms (§3.2 step 1); `O … [110/2]` (serial `[110/65]`). |
| `accept.p3.ospf-dr-election.test.ts` (W4) | §3.1: R2 DR at U + 40 s ± 10 ms; R1's `ospf-if` transitions exactly waiting → drother (U + 40 s) → backup (less than 1 ms later, on R2's DR-declaring hello), with exactly one hello from each router after each change of its (DR, BDR) pair, whichever of `hello` and `wait` the scheduler runs first; DR 2.2.2.2, BDR 1.1.1.1; the first SPF with the LAN at U + 45 s + ε; the late higher router id (R3 at U + 65 s) is DROTHER via BackupSeen from R1's reply, Full at U + 66 s + ε; a priority-0 router is never DR/BDR; DROthers are 2WAY with each other; the network-LSA only from the DR; a non-DR's own LSU goes to 224.0.0.6 and the BDR re-floods nothing it received; DR failover in [T + 30 s, T + 40 s] with the former BDR as DR. |
| `accept.p3.ospf-convergence.test.ts` (W4) | §3.2: each router's `O` routes equal `ospfRoutes` over its own LSDB rows (engine/pure parity); first convergence at link-up + 15 s; the failover route at T + 5 s ± 10 ms; ping loss only in [T, T + 5 s + ε]; the floating-static variant; the restore at T2 + 15 s ± 10 ms for T2 ≥ T + 30 s; an `lsa-gen` due with `spf` runs first; exact `show ip route` lines including the second legend line; a lab `connectivity.after` with `cut {aPort}` passes in the clone (W3 clone features). |
| `accept.p3.ospf-mismatch.test.ts` (W4) | Area, hello/dead and (broadcast) mask mismatches: no neighbour row, the `rejected` reason and the `ip ospf hello` debug line; a duplicate router id is logged and `runToIdle` returns. |
| `accept.p3.ospf-default-originate.test.ts` (W4) | `O*E2 0.0.0.0/0 [110/1]` on every other router; removing the static flushes the type-5 LSA (MaxAge flood); `always` keeps it. |
| `accept.p3.ospf-config.test.ts` (W4) | Passive interfaces send no hello but are advertised; loopbacks /32 unless point-to-point; reference 1000 gives GigE 1 and FastE 10; `ip ospf cost` and `bandwidth` on a routed GigE port (the widened grammar); the router-id order and the "after clear" message; `fact ospf.routerId` reads the id in use until `clear ip ospf process`; refused under `no ip routing`; a second process refused with `ospfOneProcess`. |
| `accept.p3.ospf-ecmp.test.ts` (W4) | One rib row with 2 paths; flows split by `ecmpIndex`; `maximum-paths 1` gives one path. |
| `accept.p3.ospf-scale.test.ts` (W4) | 50 routers in one area: converged under the clone cap; a converged minute under a fixed event bound; SPF runs per change bounded by the throttle; no `action-budget` drop. |
| `accept.p3.ospf-acl.test.ts` (W4) | §3.3 step 8: an inbound standard list without the neighbour drops its hellos (`acl-deny`, protocol 89) and the adjacency goes Down after `dead`; permitting the neighbour restores it. |
| `accept.p3.acl-standard.test.ts` (W4) | A standard list near the destination; implicit deny; an undefined list bound to an interface permits everything; `aclDenies` on the right interface; NAT's use of the same list is not counted; a NAT list whose entry carries `log` keeps that entry. |
| `accept.p3.acl-extended.test.ts` (W4) | §3.3: ping 5/5; HTTP denied with the drop `rule` (list, seq 10, key); the SYN count, row 10's matches and the aggregated log count derived from `TCP_INITIAL_RTO_NS`, `TCP_SYN_RETRIES` and `HTTP_CLIENT_TIMEOUT_NS` (4 SYNs at 0, 1, 3, 7 s; "(4 matches)"; "3 packets"); ICMP 3/13 at most one per 500 ms; the first log line immediate, the aggregate at + 300 s; PC2's HTTP succeeds; `lastPdu` of row 20 names the echo request; the `established` variant allows only return traffic; a lab `connectivity {proto: 'tcp', port: 80, expect: 'fail', droppedAt: 'R1', dropReason: 'acl-deny'}` passes in the clone (W3 clone features) and an `aclDecision` for the same tuple says deny. |
| `accept.p3.acl-order.test.ts` (W4) | With NAT: an outside inbound list sees global addresses and a packet it denies creates no NAT row; an outside outbound list sees the translated source, NAT's row exists after its deny, and no ICMP is sent for it; without NAT an outbound deny's ICMP 3/13 is sourced from the ingress interface; locally originated packets are not filtered; an inbound implicit deny blocks relayed DHCP broadcasts. |
| `accept.p3.acl-edit.test.ts` (W4) | Insert 15, `no 20`, resequence; the running configuration shows no sequence numbers; export, reload and the lab clone renumber 10, 20 …; `ip access-group` replaced per direction; `ip access-list extended 101` is stored as a numbered section (P2's storage) and joins the global `access-list 101` lines, global lines first. |
| `accept.p3.device-access.test.ts` (W4) | On a router and on a switch: key generation refused without a hostname or a domain name (exact messages); with both, `show ip ssh` reports version 2 and the key size; `username admin privilege 15 secret …` works with `login local`; `transport input ssh`, `login local` and `access-class 10 in` (a list defined on the switch) round-trip through export, reload and the clone; the `ssh.*` and `vty.*` facts read them. |
| `accept.p3.dhcp-snooping.test.ts` (W4) | §3.4 steps 1–5: exact drops and the binding row; rate-limit err-disable from an injected burst (`test/inject.ts`) and recovery (`runFor`); the grader clone rebuilds bindings and a connectivity check through an inspected port passes. |
| `accept.p3.dai.test.ts` (W4) | §3.4 steps 6–8: the spoofed ARP dropped and the victim's cache unchanged; the statistics row; a static host dropped until a static binding exists; 16 injected ARPs in one second → err-disable. |
| `accept.p3.qos-marking.test.ts` (W4) | §3.5 with bounded flows: the voice datagram's provenance at R1 is exactly `QosMark ipv4.dscp 0→46` (cause `policy-map MARK class VOIP set dscp ef`), `ChecksumRecompute`, `FcsRecompute`; data datagrams are not rewritten; a flooded frame for another MAC is neither classified nor counted; editing VOICE-PORTS changes the next datagram's class; an output `set cos 5` on a subinterface records `dot1q.pcp` on the pushed tag; `service-policy` on an SVI is refused with `qosPortUnsupported`; `show policy-map interface` counts equal the trace counts; under `runFor` the receiver's `flows` row (`where {src, flow, dscp: 46}`) shows voice delay > 1 s within 30 s, `queue-full` drops on the FIFO link and `PortSnapshot.txBacklog` at R1 Se0/0/0 with depth > 8 and 8 summaries; 3 runs byte-identical. |
| `accept.p3.traffic-bounded.test.ts` (W4) | Caps enforced (8 flows per device, 2 Mb/s and 1000 pps per flow, 300 s per flow, refused with exact messages); a bounded flow holds `runToIdle` until its last datagram and no longer; an uncongested or finished flow does not hold it; a continuous flow stops at `TRAFFIC_MAX_DURATION_MS` (`runFor`); the receiver's final `flows` write comes 1 s after its last datagram, and tail losses are counted when the final datagram arrives; a datagram without the traffic header to a closed port still draws port unreachable, on any host. |
| `accept.p3.cdp.test.ts` (W4) | §3.6: both rows within link-up + propagation with exact fields, the router's row received on its routed port (also with a native subinterface); hold counts down; aged at last update + 180 s ± 1 ms behind an unmanaged switch; link-down deletes the row; `no cdp enable` and `no cdp run` behave as specified; NF-AP-1832 bridges CDP and has no row; `runToIdle` returns in fewer than 5 000 events. |
| `accept.p3.lldp.test.ts` (W4) | The IEEE byte golden (chassis subtype 4, port subtype 5, TTL 120, end TLV); the 30 s interval; transmit/receive asymmetry; never bridged by a VLAN-aware switch; dropped with `lldp is not running on this device` at the controller; bridged by a transparent one. |
| `accept.p3.clock-ntp.test.ts` (W4) | §3.7: the unset `*` clock value; `clock set` writes the `clock` row (source `user`); the chain SRV1 (1) → R1 (2) → SW1 (3): after `runToIdle` each clock equals true time plus the exact path asymmetry of its chain, with SW1's first poll unanswered and its re-poll kicked by link-up; an unsynchronised R1 answers stratum 16 / leap 3 and SW1 rejects it; the retry schedule from the constants; associations and status exact; offsets stored as ms plus a ns remainder (a first sync from 2020 fits); server loss decays `reach` over polls (`runFor`); bare `ntp master` serves stratum 8, and on an unset clock the wrong time; the `clock.*` and `ntp.*` facts read tables only; no bigint in any snapshot or trace JSON. |
| `accept.p3.restconf.test.ts` (W4) | §3.8: the status-code matrix; 401; the CLI validator's error becomes a 400 body; atomic revert; PUT twice gives 201 then 204; every segment on 443 carries `meta.protected` + `protectedBy: 'tls'`; configure is never nested (a 60-VLAN PUT within budget); `configChange` carries the origin; GET reflects CLI changes; the `restconf-log` bound; the `rest` command prints status, headers and body, keeps a `-d` body with quotes, brackets and spaces verbatim, and is replayed exactly from the journal. |
| `accept.p3.mgmt-scale.test.ts` (W4) | 25 routers and switches in a P3 world (CDP on, NTP to one server), 10 minutes: dispatched events under the derived bound; `runToIdle` returns. |
| `accept.p3.determinism.test.ts` (W7) | A composite P3 world (OSPF triangle, extended ACL, snooping + DAI, marking with two **bounded** flows through an LLQ serial port, CDP, NTP with syslog, one RESTCONF change; and an EIGRP pair, a PPP CHAP link, an IPsec VTI and an SSH session from a PC, for the approved items) runs 3× with one seed: byte-identical trace and snapshot JSON; `runToIdle` terminates. |
| `accept.p3.labs.test.ts` (W7) | Every CCNA 3 lab: unsolved fails its tasks, the solution passes all, evaluation leaves the live trace head unchanged. |
| `accept.p3.coverage.test.ts` (W7) | Reads this table by the rule above; fails when a listed file is missing, when a row does not name exactly one file, or when an `accept.p3.*.test.ts` file is not listed. |
| `accept.p3.replay-exact-ccna3.test.ts` (W5) | The P2 replay-exact assertions over every CCNA 3 lab (a new shard, §9.2 W5). |
| `accept.p3.ospf-multiarea.test.ts` [S4] | The routing map's multi-area walk-through exactly (ABR B flag, type 3/4, `O IA` metrics, area-scoped rows, `show ip ospf border-routers`). |
| `accept.p3.ospf-auth.test.ts` [S5] | A mismatch refuses the adjacency with its reason; the MD5 key is in no byte. |
| `accept.p3.ospfv3.test.ts` [S6] | Dual-stack FULL; `O`/`OI` in rib6 via link-local next hops; ff02::5/6. |
| `accept.p3.acl-ipv6.test.ts` [S11] | Implicit ND permits; an explicit `deny ipv6 any any` breaks neighbour resolution. |
| `accept.p3.vty.test.ts` [S13] | §3.14: telnet with a line password; SSH with `login local` and a key; `transport input ssh` refuses telnet (RST, no `vty-logins` row); `access-class` refuses PC2 (RST after the handshake, counted on the implicit row with `lastIface 'vty'`, logged, a `refused` row) and admits PC1 (a `success` row); telnet bytes contain the password and SSH bytes do not; every remote session goes through the `remoteCli` SimEvent (no `DeviceRuntimeDeps` member); nesting stops at depth 4; on a switch, `line vty` alone leaves the transport dormant ("protocol unreachable") and `transport input ssh` wakes it; replay-exact with remote sessions. (The `service` kind is W5's and is proved by `sim.lab-checks.approved-kinds.test.ts` and the labs.) |
| `accept.p3.storm-control.test.ts` [S16] | A P1-profile loop with broadcast level 1.00 bounds broadcast bytes per window to the threshold; window edges exact to the ns. |
| `accept.p3.fragmentation.test.ts` [S17] | A 3000-byte ping across MTU 1500 → 3 fragments with `FragmentSplit`, reassembly at the host; DF → `mtu-exceeded` + ICMP 3/4 with MTU 1500; a lost fragment times out at 15 s; the ACL non-initial fragment rule. |
| `accept.p3.gre.test.ts` [S18] | §3.10: ping 5/5 with one PduId; head and tail provenance exact; the ISP RIB has no private route; TTLs decremented only where §3.10 says; `tunnel = 'gre'` only on WAN legs; exact down reasons; the MTU fallback of D15 without [S17] (drop `mtu-exceeded` with its detail, ICMP 3/4 carrying 1476 when DF is set, `ip tcp adjust-mss` clamping the SYN); OSPF over the tunnel at cost 1000. (The `path` kind is W5's, proved by `sim.lab-checks.approved-kinds.test.ts` and lab 24.) |
| `accept.p3.gre-recursion.test.ts` [S36] | The flap bounded under `runFor`, up after 10 s ± 1 ms. |
| `accept.p3.ppp-chap.test.ts` [S19] | §3.9: exact message order; `MD5(id ‖ secret ‖ challenge)`; the secret in no byte, snapshot or trace; the wrong-password retry count under `runFor(60 s)`. |
| `accept.p3.ppp-pap.test.ts` [S19] | PAP in clear, as the WAN map's row. |
| `accept.p3.ppp-mismatch.test.ts` [S19] | The HDLC/PPP mismatch sends nothing. |
| `accept.p3.ppp-keepalive.test.ts` [S19] | `keepalive-missed` after 5 intervals. |
| `accept.p3.qos-llq.test.ts` [S20] | §3.11: no voice drop; every voice wait ≤ one 1008-byte serialisation at 128 kb/s + 1 ms; the class-default drop detail; counters equal the trace. |
| `accept.p3.qos-cbwfq.test.ts` [S20] | CBWFQ 2:1 ± 5 %; the admission refusal message. |
| `accept.p3.qos-bounded.test.ts` [S20] | The line-rate event bound. |
| `accept.p3.qos-police-shape.test.ts` [S21] | Conform/exceed counts; shaping delays without drops below the limit. |
| `accept.p3.syslog.test.ts` [S24] | Trap, console and buffer levels; RFC 3164 bytes with PRI 187 ([S25]); the server row ([S25]); synced vs `*` stamps; the two `service timestamps` lines coexist and are replayed in a P3 world only; the [S25] extended-logging logs in P3 worlds only; `logging host` on a switch wakes its transport; P1/P2 typed transcripts carry no log lines. |
| `accept.p3.tftp.test.ts` [S29] | As the management map's acceptance row, unchanged. |
| `accept.p3.password-recovery.test.ts` [S31] | As the management map's acceptance row, unchanged. |
| `accept.p3.script.test.ts` [S32] | The management map's §4.3 row, adapted to lab 40's inventory script: output exact; requests strictly sequential; an infinite loop aborted at exactly `MAX_INSTRUCTIONS` after the expected number of 1 ms slices; `time.sleep(5)` advances 5 s; a syntax error sends no PDU; the `script-runs` row written at start and end only; the script file survives export and reload in `TopologyDevice.files` (schema 1.3) without any [S29] contract; 3 runs byte-identical; `replay-exact` over a script scenario. |
| `accept.p3.eigrp.test.ts` [C1] | §3.12 steps 1–2 and 6: the neighbour sequence (hello, hello reply, init update, ack) with exact packets; every metric of §3.12 (3328, 3072, 28672); the topology row and `show ip eigrp topology` exact; the `D` code, AD 90 and the legend line (with the DHCP sentence when a `D*` DHCP default is present, D11); equal-cost `maximum-paths`; a passive interface sends no hello but is advertised; the K-value mismatch refuses with its log and the other AS is ignored; `auto-summary` refused; EIGRP golden bytes against RFC 7868. |
| `accept.p3.eigrp-dual.test.ts` [C1] | §3.12 steps 3–5: the FS failover installs `[90/28672]` in the link-down dispatch with no query and the `feasible successor promoted` transition; the no-FS variant goes active, queries, and installs `[90/30976]` within T + 5 ms; the indirect failure in [T + 10 s, T + 15 s]; 16 unanswered retransmissions reset a neighbour; SIA timers periodic; `runToIdle` returns within link-up + 50 ms of routes; a lab `connectivity.after` with `cut {aPort}` passes in the clone; engine/fact parity (`eigrp.feasibleSuccessor` names R3). |
| `accept.p3.ipsec.test.ts` [C13] | §3.13 steps 1–9 and 11: the four IKE messages in order with exact headers, the crossing rule whichever request arrives first, IKE_AUTH marked `protectedBy: 'ike'`; the `ipsec-sa` rows; Tunnel0 up only after both SAs; ping 5/5 with one PduId end to end; head provenance exactly Decapsulate ethernet, Encapsulate esp, Encrypt, Encapsulate ipv4 and tail Decrypt; every leg at the ISP is IPv4 protocol 50 with `PduSummary.tunnel === 'ipsec'` (read from the trace; the `path.tunnelAt` kind that grades it is W5's, proved with lab 25); the key in no byte, snapshot or trace; the D15 fallback at 1456 with ICMP 3/4. |
| `accept.p3.ipsec-failure.test.ts` [C13] | §3.13 step 10: a wrong key gives `AUTHENTICATION_FAILED`, `ike-failed` rows, logs, Tunnel0 down and the ping falling back to the default route; the periodic retry count under `runFor(60 s)`; the corrected key comes up on the next retry; an unknown peer gives `NO_PROPOSAL_CHOSEN`; a silent peer gives three retransmissions (1, 2, 4 s) then `ike-no-response`; a peer reload with the old SPI in flight drops `ipsec-no-sa` until the new SA; `tunnel protection` on a GRE-mode tunnel refused; `runToIdle` returns in every case. |
| `accept.p3.snmp.test.ts` [S33] | As the management map's acceptance row, unchanged. |
| `accept.p3.span.test.ts` [S34] | As the management map's acceptance row, unchanged. |
| `accept.p3.lab-document.test.ts` [S37] | Every built-in lab round-trips JSON → schema → scenario with `build()` deep-equal; headless `gradeTopology` equals live grading for every lab (unsolved and solved); `lab-versions.json` fails an edited lab without a version bump. |

### 10.2 Web acceptance (`apps/web/test/`)

- `overlays.qos-model.test.ts`: a port whose `PortSnapshot.txBacklog` holds three frames draws three capsules in `txStart`
  order; with depth 12 (8 summaries) it draws 8 and `+4`; no `txBacklog` draws nothing; the load sleeve fraction for a
  saturated 128 kb/s link is 1.0; DSCP letters from the frames' summaries.
- `concept.queueing.test.ts`: for one arrival list, the web model's departures equal `core/queueing.ts` exactly for
  FIFO, WFQ (flow DRR), CBWFQ and LLQ; every step's sentence is text.
- `concept.data-formats.test.ts`: parse errors with line and column for JSON, YAML and XML; conversions round-trip the
  RESTCONF samples.
- `learn.course-profile.test.ts` and `worker.profile.test.ts` (from W7): CCNA 1 → P1, CCNA 2 → P2, CCNA 3 → P3; no
  lesson → `LATEST_DEFAULTS_PROFILE` (P3 after the W7 flip); a P2 file → P2 with "Use current defaults" enabled; a
  template → P1 with the "Classic defaults" chip.
- `store.topo-overlays.p3.test.ts`; `labs.markdown.lang.test.ts` (a `json` block renders as code, never as a link or
  HTML).
- `desktop.traffic.test.ts`: the app's start button emits exactly `hostRequest {app: 'traffic.start', flow}` with the
  form's values; presets fill 50 pps / 60 B / DSCP 46.
- `vocab.test.ts` (exhaustive, unique letters, no banned words).
- The approved items: [S1] `overlays.ospf-model.test.ts` (chips, DR/BDR letters, the draining bar at 0.5 in the middle
  of Waiting); [S2]/[S3] `routing.lsdb-model.test.ts`, `routing.spf-parity.test.ts` (the last frame equals the
  StateView tree), `dock.routing.test.ts` (from W4: the `routing` tab and hotkey 9); [S9] `concept.wildcard.test.ts`
  (count, contiguous and non-contiguous, range → ACEs); [S13] `terminal.remote.test.ts` (the chip from
  `CliSessionView.remote`, masked input); [S18]/[S19]/[C13] `overlays.wan-model.test.ts` (the D·E·A·N rail from `ppp`
  rows, the tube from `tunnels` rows, the IPsec label and SA state word, the pulse static under reduced motion); [S20]
  `inspector.policy-section.test.ts`; [C1] `overlays.eigrp-model.test.ts` (S and FS chips from `eigrp-topology`
  rows, the `RD 3072 < FD 3328` text); [C13] the ESP and IKE banners in `inspector.packet-protected.test.ts`; [S32]
  editor highlight and error marker.

### 10.3 Gate G per wave (built bundle, real browser; rule 10)

Each script uses only what the bundle of that wave ships (P2 §13 #40; P3 review P15).

| After | Script (all in the `netforge-preview` build) |
|---|---|
| W0, W1 | Load template `two-pcs-and-switch`; `ping 10.0.0.2` from PC1; **then** load lab `ccna2-stp-root-placement`, apply its solution, Check shows full marks; no console error. |
| W2 | File → New (P2, still latest): build R1–R2 on GigE, type `router ospf 1` and a `network` line on both (the daemon is not yet in the bundle's catalog: the lines store and `show running-config` shows them); type `show clock` and `show access-lists` on R1; on a PC type `rest` with no arguments (the usage text); no console error. |
| W3 | Load a template; toggle every overlay (QoS, and the approved OSPF, SPF, WAN and EIGRP overlays; empty state); open the queueing sandbox, the data-formats playground and the wildcard tool; open a port inspector (QoS line present); type `show access-lists`, `show clock`, `show cdp neighbors` (empty) on a router. |
| W4 | File → New (still P2): R1, SW1, two PCs; `cdp run` on R1 and SW1, then `show cdp neighbors` lists the neighbour; build the §3.2 OSPF triangle and see the routes converge with the OSPF overlay, open the `routing` dock tab (hotkey 9) and step the SPF on R1; replace OSPF with `router eigrp 100` on the triangle and see `D` routes and the EIGRP overlay; `restconf` + `ip http secure-server` on SW1, then `rest GET` from a PC prints JSON; configure SSH on R1 and `ssh -l` from a PC (the remote chip appears); `encapsulation ppp` with CHAP on a serial pair (the WAN overlay's rail fills). |
| W5 | Load lab `ccna3-ospf-single-area` (a P3 world: CDP answers); apply its solution through the terminal; Check shows full marks. Then load `ccna3-ipsec-site-to-site`, apply its solution, ping PC1 → PC2, see only ESP at the ISP in NetScope (the "Encrypted (ESP, simulated)" banner), Check passes; load `ccna3-qos-voice-first` and see the per-class lanes. |
| W6 | Load lab `ccna3-restconf-change`; run the `rest GET` and `rest PUT` of §3.8; see the protected banner in NetScope; Check passes. Then load `ccna3-script-inventory`, open the automation workspace on DEV1, run the script, see its requests in NetScope; Check passes. |
| W7, W8 | Landing → "Start CCNA 3" → a lesson → its lab → "Check my work"; File → New opens a P3 world; every overlay of the View menu toggled once; no console error. |

---

## 11. CCNA 3 course plan

The course reuses the course layer unchanged: `Course` → `CourseModule` → `Lesson`, five fixed theory sections, the
markdown subset, an optional verified video, and a pointer to one lab by `ScenarioInfo.name` (`contracts/
curriculum.ts`). CCNA 3 adds content, `Course.profile`, objectives as data and the code-sample check (§11.3).

### 11.1 Lessons

40 lessons in 14 modules, about 610 minutes of reading and watching. Ids are `ccna3-NN-slug` and are **frozen here at
W0** (overlay owners key on them, `canvas/overlays/registry.ts` `objectives`). No lesson runs over 45 minutes. Outcomes
are original wording that paraphrases the objectives. The lab column follows the **approved plan** (§8.4, §8.5): a lab
or task marked [Sn] or [Cn] belongs to an approved item and exists; the lessons of items that are not approved run
theory-only, and their hands-on part is recorded `later:P3c` (or a later stage) in §11.4.

| Module | Lesson (after it the learner can…) | min | Lab |
|---|---|---|---|
| 1 Routers that learn | 01 `why-routers-share-routes`: say what dynamic routing automates that static routes cannot; contrast distance-vector and link-state learning | 12 | theory |
| | 02 `how-ospf-maps-a-network`: follow a router from first hello to full adjacency; explain how advertisements become one shared map from which each router computes shortest paths, with the LSDB browser and the SPF animation ([S2], [S3]) | 16 | theory (the LSDB browser and SPF stepper on the lesson's figure world) |
| | 03 `neighbours-and-the-designated-router`: predict the DR and BDR on a shared segment, steer them with priority, tell broadcast from point-to-point behaviour | 16 | `ccna3-ospf-dr-election` |
| 2 One OSPF area | 04 `switching-ospf-on`: enable OSPF with network statements and with interface lines, fix the router ID, keep hellos off LANs with no router | 18 | `ccna3-ospf-single-area` |
| | 05 `cost-and-the-best-path`: derive cost from bandwidth and the reference bandwidth, change it, predict the installed path(s) | 14 | `ccna3-ospf-cost` |
| | 06 `default-routes-and-timers`: originate a default route into OSPF; explain what mismatched hello/dead timers do | 14 | `ccna3-ospf-default-route` |
| | 07 `fixing-ospf`: use neighbour, interface and database views to find why routers will not peer or a route is missing | 16 | `ccna3-troubleshoot-ospf` (troubleshoot) |
| 3 Growing OSPF | 08 `more-than-one-area`: why areas exist, what an ABR passes, the LSA types (1–5 and 7 as theory) | 16 | theory ([S4] not approved: the lab is `later:P3c`) |
| | 09 `ospf-for-ipv6`: run OSPF for IPv6 beside IPv4 and compare how it names neighbours and links | 14 | theory ([S6] not approved: the lab is `later:P3c`) |
| 4 EIGRP | 10 `eigrp-and-its-metric`: form EIGRP neighbours, read the composite metric, find the successor and the feasible successor, and watch a failover with and without one; what stub, summarisation and unequal-cost sharing change (theory) | 18 | [C1] `ccna3-eigrp-feasible-successor` (build: §3.12's metrics and the FS failover) |
| 5 Thinking like a defender | 11 `the-language-of-security`: CIA; threat, vulnerability, exploit, risk; who attacks and why | 12 | theory |
| | 12 `how-attacks-unfold`: reconnaissance, access, denial-of-service and malware families, as effects on a network (concepts only, spec §11.6) | 14 | theory |
| | 13 `layers-of-defence`: place firewall, IPS, AAA, 802.1X and encryption in depth; what hashing, symmetric and public-key cryptography each give | 16 | theory |
| 6 Access control lists | 14 `how-an-acl-decides`: top-down first match, implicit deny, wildcard masks | 14 | theory + `concept:wildcard` ([S9]) |
| | 15 `standard-acls`: numbered and named standard lists, direction and placement near the destination, `access-class` on the vty lines | 16 | `ccna3-acl-standard` (the vty-ACL task graded live through the remote terminal [S13]: the admitted and the refused logins in `vty-logins`, the vty rows of the list) |
| | 16 `extended-acls`: filter by protocol, address and port, `established`, placement near the source | 18 | `ccna3-acl-extended` |
| | 17 `editing-and-reading-acls`: sequence-number edits, remarks, match counters, logging | 14 | `ccna3-acl-edit-verify` (troubleshoot) |
| | 18 `translation-at-the-edge`: how NAT and ACLs combine at the edge; what NAT64 is for (revisits ccna2-33) | 10 | theory (practised in lesson 34's lab) |
| 7 Hardening | 19 `locking-down-device-access`: SSH-only management, local users, a vty ACL; what an exec timeout and a login lockout add | 16 | `ccna3-secure-device-access` (configuration, then graded live through the remote terminal [S13]: an SSH login from the admin PC succeeds, telnet is refused, the vty ACL refuses the other PC; §3.14) |
| | 20 `guarding-the-access-layer`: DHCP snooping and dynamic ARP inspection; what storm control and IP source guard add | 18 | `ccna3-dhcp-snooping-dai` (trust, bindings and DAI; the rate limits are configured and explained, not graded, D13) |
| 8 Wide area networks | 21 `joining-distant-sites`: leased line, MPLS, metro Ethernet, DSL/cable/fibre/cellular; choose one per site | 16 | theory |
| | 22 `point-to-point-links`: serial links and HDLC; the PPP phases (LCP, NCP) and PAP/CHAP | 16 | `ccna3-serial-links` (the HDLC link, then PPP with CHAP [S19]: LCP and IPCP open, a wrong password found and fixed) |
| 9 Tunnels and VPNs | 23 `private-paths-over-public-networks`: site-to-site vs remote access; AH, ESP and the two IKE phases | 16 | theory |
| | 24 `gre-tunnels`: build and route through a GRE tunnel; why GRE alone is not private | 16 | [S18] `ccna3-gre-tunnel` |
| | 25 `site-to-site-ipsec`: protect site-to-site traffic and prove only ESP crosses the provider | 16 | [C13] `ccna3-ipsec-site-to-site` (§3.13; the provider check is `path.tunnelAt`) |
| 10 Quality of service | 26 `why-traffic-needs-priority`: delay, jitter, loss; FIFO, WFQ, CBWFQ, LLQ | 14 | theory + `concept:queueing` |
| | 27 `marking-queuing-and-policing`: CoS/DSCP at a trust boundary, what a priority queue does for voice, policing vs shaping | 16 | `ccna3-qos-voice-first` (mark and watch a FIFO link congest; then put voice first with LLQ [S20] and police the bulk traffic [S21]; §3.5, §3.11) |
| 11 Managing the network | 28 `who-is-next-door`: map an unknown network with CDP and LLDP; turn discovery off where it leaks | 14 | `ccna3-discover-neighbours` |
| | 29 `time-and-logs`: the NTP hierarchy; syslog severities, facilities and servers | 16 | `ccna3-time-and-logs` (NTP, then local logging with timestamps [S24] and a syslog server [S25]; §3.7) |
| | 30 `watching-the-network`: SNMP v2c/v3 polling and traps, flow records, SPAN to an analyser | 16 | theory ([S33], [S34] not approved: `later:P3c`) |
| | 31 `looking-after-files-and-images`: file systems, configuration backup and restore, image upgrade; password recovery as theory | 16 | theory ([S29] not approved: `later:P3c`) |
| 12 Designing and fixing | 32 `designing-networks-that-grow`: three-tier vs collapsed core; choose hardware by ports, speed, PoE, redundancy | 14 | theory |
| | 33 `a-method-for-enterprise-faults`: documentation, baselines, symptoms, a layered method and the tools for each layer | 14 | [C1] `ccna3-troubleshoot-eigrp` (troubleshoot: apply the layered method to an EIGRP network with a K-value mismatch, a wrong AS number, a passive interface and a missing `network` line) |
| | 34 `finding-faults-across-layers`: troubleshoot a multi-site network with routing, ACL, NAT and time faults | 16 | `ccna3-troubleshoot-enterprise` |
| 13 Virtual networks | 35 `clouds-and-virtual-machines`: cloud and service models, hypervisors, virtual switches | 14 | theory |
| | 36 `software-defined-networking`: the three planes, controllers, northbound and southbound APIs, intent-based networking | 14 | theory |
| 14 Automating the network | 37 `data-a-machine-can-read`: the same data as JSON, XML and YAML; find the error in a broken document | 14 | theory + `concept:data-formats` (the playground holds the practice; no lab: nothing in the playground is gradeable) |
| | 38 `talking-to-devices-through-apis`: REST verbs, URIs, status codes and credentials; read and change a device through RESTCONF using an IETF YANG model | 18 | `ccna3-restconf-change` (reads the JSON a `rest GET` returns and acts on a value in it, then changes a VLAN through RESTCONF) |
| | 39 `configuration-as-code`: compare configuration-management tools; what a playbook run across devices does | 16 | theory ([C22] not approved: `later:P3c`) |
| | 40 `scripting-the-network`: a short script that inventories devices through their API | 16 | [S32] `ccna3-script-inventory` (an NF-Py script on NF-DEVHOST reads each switch's interfaces through RESTCONF; §3.8 step 8) |

**Counts.** MUST labs (16): 03, 04, 05, 06, 07, 15, 16, 17, 19, 20, 22, 27, 28, 29, 34, 38. Approved SHOULD labs (2):
24 [S18], 40 [S32]. Approved COULD labs (3): 10 and 33 [C1] (C1's two labs), 25 [C13]. **The approved plan ships 21
labs** (P2 shipped 20); five MUST labs also gain the approved tasks: 15 and 19 [S13], 22 [S19], 27 [S20]/[S21], 29
[S24]/[S25]. Labs of items that are not approved (08 [S4], 09 [S6], 30 [S33], 31 [S29], 39 [C22]) are not built; their
lessons are theory. Lesson 37 is theory with its concept tool: no assertion kind can grade work done in a web-only
playground, so its JSON reading tasks moved into lab 38, where a `rest GET` leaves a gradeable `restconf-log` row.
Lesson 33, a theory lesson in the recommended plan, carries C1's second lab (a lesson points to one lab, and lesson 10
already holds the first), so the troubleshooting method is practised twice (33 on EIGRP, 34 across the enterprise). If
content must be cut, merge first: 11 + 12, and 06 into 05 (the default-route task moves to lab 05); 32 + 33 can merge
only if lab 33 moves with it.

### 11.2 Labs

- Category `ccna3-lab`, `course: 'CCNA 3'`, `topic` = the module title, a fixed seed, profile P3
  (`topology(…, {profile: 'P3'})` in the kit, which writes schema 1.3).
- Guided, build and troubleshoot types, as in CCNA 1 and 2. Troubleshoot labs schedule hidden faults through the kit's
  helpers; the grader's `LabFault config` applies configuration faults in its clone.
- Every lab has a reference `solution` for `labs.ccna3.solutions.test.ts` and at least one wrong-answer case per new
  assertion kind and widened member in `sim.lab-checks.p3.test.ts`.
- PortFast on host ports and on router-facing access ports (a router is an edge: it sends no BPDU) in the initial
  configuration unless the lesson is about spanning tree (P3 worlds include P2's defaults, so spanning tree runs).
- **OSPF labs warn about the timers**: routers take 45 s to boot; on a broadcast segment the election waits 40 s and
  the first SPF runs 5 s later, so instructions say **"allow about 90 s before the first ping"** (add 30 s where a
  router-facing switch port is not PortFast); on point-to-point links the routes come 15 s after link-up (§3.2), so
  "about a minute".
- **Router-id faults are graded live.** A troubleshooting lab whose fault is a router id grades it with the live `fact
  ospf.routerId` (the id in use): the grader clone boots from the export and would apply a configured router id the
  live router has not applied yet.
- **Lab files are owned by the area that knows the feature** (rule 18): `sim/scenarios/ccna3/{ospf,eigrp,acl,hardening,
  wan,vpn,qos,discovery,time,automation,troubleshooting}.ts` (eigrp: eigrp, labs 10 and 33; vpn: wan, labs 24 and 25;
  discovery: disc, lab 28; time: svc, lab 29; automation: auto, labs 38 and 40); the course owner owns `ccna3/index.ts`
  (`CCNA3_LAB_ORDER`, sorted as in CCNA 2).
- **Assertion kinds used** (§2.10): `neighbor`, `fact`, `acl`, `aclDecision`, `route` (with `routeType`, `metric`,
  `minPaths`, and `source: 'EIGRP'`), `table` (with `whereOps`), `connectivity` (with `proto`, `port`, `droppedAt`,
  `toAddress`, `after`), `config`, `vlan`; and the approved kinds [S13] `service`, [S18] `path` (with [C13]
  `tunnelAt`), [S20] `traffic`. The kinds of items that are not approved ([S29] `file`, [S38] `packetSeen`, [S8]
  `convergence`) do not exist in P3a.
- **EIGRP labs** need no timing warning: neighbours and routes form within milliseconds of link-up (§3.12); the lab
  text says "about a minute" only for the 45 s router boot.
- **Graded live through the remote terminal** (labs 15 and 19, [S13]): the learner's own logins are read from
  `vty-logins` and the vty rows of the list, so the lab text asks for one admitted and one refused login before Check;
  the clone's `service` checks confirm the configuration independently of the learner's attempts (§3.14).
- **Worker and UI.** `LAB_RELEVANT_KINDS` needs no change: every P3 state a lab reads lives in tables or configuration,
  the device clock included (the ntp daemon's `clock` row, so `clock set` is a tableWrite; rule 20). The labs browser
  groups by course, then topic. The File menu lists `ccna3-lab` under "Labs: CCNA 3" (from W5).

### 11.3 Content rules

- The lesson skeleton lands in W1 (`curriculum/ccna3/lessons.ts`), **detached** from `curriculum/index.ts` (CCNA 3 keeps
  status `planned` with no modules) until the W7 flip, so the planned-course pins stay green; `curriculum.ccna3.test.ts`
  imports it directly; lab-name existence is checked against `SCENARIOS` from W5 (W6 for the automation labs).
- Theory is written only after the CLI grammar of its feature exists (W6 for modules 1–13, W7 for module 14).
- **Code samples are checked.** `curriculum.ccna3.commands.test.ts` generalises the CCNA 2 commands test: every
  backticked command and every fence line is parsed against `GRAMMAR` for the models the lesson names; a fenced block
  with an info string is not CLI and must parse with its own parser — `json` with `JSON.parse`, `yaml` and `xml` with
  `automation/data`, `http` against the simulated RESTCONF route table, `python` with the NF-Py parser ([S32],
  approved), `text` unchecked. Address lines printed in a lesson must be lines of its lab's
  solution (the CCNA 1 and 2 rule). The markdown code block's `lang` is display-only (D24); the security boundary does
  not change.
- The five fixed section headings, the markdown subset, the no-vendor rule and the 45-minute cap apply unchanged. No
  lesson names a vendor, a controller product or a vendor certification programme; YANG examples use IETF modules and
  `nf-native` only.
- The discovery lessons state plainly that real devices run CDP by default and that NetForge projects saved before P3
  keep their profile until upgraded from the File menu. The OSPF lessons state the listed deviations a learner can
  notice (the 1 s hello reply; the extra hello when the DR or BDR changes; serial cost from 1544 kb/s while `show
  interfaces` shows the clock rate). Lesson 10 says EIGRP has left the current exam blueprint and that `D` in the
  routing table means EIGRP except a `D*` default at distance 254, which DHCP installed (D11). Lessons 19 and 25 say
  that the SSH and IPsec cryptography is simulated: the headers are real, and the protected payload is shown decoded
  under a banner (D14, D27).
- A lesson whose lab depends on a SHOULD or COULD item that is not approved runs theory-only, and says what the
  hands-on part would have shown; it never links to a missing lab.
- `CCNA3.status` flips to `available` in W7, when every lesson has theory and every lab of the approved plan (21) exists;
  its placeholder description is rewritten.

**Video rule (unchanged from P2).** A video is attached only after a person has checked it by hand and written the date
and the calls in the header of `curriculum/ccna3/videos.ts`: oEmbed returns 200 with title and channel copied exactly;
the watch page reports it playable when embedded; the sponsor-segment lookup returns 404 and the description and
chapters were read (a spoken advertisement near the start disqualifies); neither title nor channel names a vendor; the
video fits the lesson's minutes at 238 words per minute and stays ≤ 45 minutes. `curriculum.ccna3.videos.test.ts` never
touches the network: it checks the key is a CCNA 3 lesson id, the id and URL shapes, the vendor guard and no duplicates
across CCNA 1–3. **Expected hazard:** most automation, SDN and QoS videos come from vendor channels or name a vendor, a
controller product or a vendor developer programme; lower coverage is expected for modules 13–14, and theory-only is
allowed.

### 11.4 Objective traceability (spec §2.3, §2.8)

Objectives move out of the test into data: `curriculum/ccna3/objectives.ts` holds `{ id: 'CCNA3.<cluster>.<n>', text
(paraphrase), lesson, lab?, handsOn: 'lab' | 'theory' | 'later:P3c' | 'untaught:P4' | 'untaught:P5' }`. `'theory'` means
the objective is describe-level and the lesson meets it; `'later:P3c'` means its hands-on part needs a SHOULD or COULD
item that is not in this plan and is recorded for **P3c**, the follow-up content stage (§12.1), so a tool is never
"taught as theory"; `'untaught:P4'` and `'untaught:P5'` name the stage that takes it. `curriculum.ccna3.test.ts` fails
when an objective has no row and lists every objective that is not `'lab'` as the spec §2.8 `coverage-gap` warning.
With the approved plan (§8.5):

| Cluster | Objectives → lesson (L = hands-on in a lab of the approved plan) |
|---|---|
| OSPF | single-area 04L; DR/BDR 03L; broadcast and point-to-point 03L; hello/dead 06L; cost and reference bandwidth 05L; passive-interface 04L; router-id 04L; LSDB and SPF 02 theory, made visible by the LSDB browser and the SPF animation (S2/S3, approved); multi-area 08 theory (later:P3c, S4); OSPFv3 09 theory (later:P3c, S6); NBMA 03 theory (untaught:P5); LSA types 1, 2 and 5 04L/06L, types 3 and 4 in 08 theory (later:P3c, S4), type 7 (untaught:P5); authentication 07 theory (later:P3c, S5) |
| EIGRP | neighbour and topology tables 10L; successor, feasible successor and the feasibility condition 10L; the composite metric and K values 10L and 33L; troubleshooting adjacencies 33L (C1, approved); stub, summarisation, unequal-cost 10 theory (untaught:P5, C2) |
| ACLs | standard and extended 15L/16L; numbered and named 15L; wildcard masks 14 (the S9 visualizer, approved); `established` 16L; placement 15/16 (the advisor later:P3c, S23); hit counters 17L; logging 17L; the vty ACL 15L (graded live through real logins, S13); IPv6 17 theory (later:P3c, S11); time-based 17 theory (untaught:P4) |
| Security concepts | CIA, threat, vulnerability, exploit 11; attack taxonomy 12; defence in depth 13; AAA 13 (local users 19L; server AAA untaught:P4); 802.1X 13 (untaught:P4) |
| Hardening | SSH only 19L (configuration and real SSH and telnet logins, S13); unused ports 19L and ccna2-24; DHCP snooping 20L; DAI 20L; IP source guard 20 theory (later:P3c, S15); storm control 20 theory (later:P3c, S16); BPDU guard ccna2-16; native VLAN and nonegotiate ccna2-24 |
| WAN | leased line, broadband, MPLS, metro Ethernet 21 theory (the visualizer later:P3c, S22); HDLC 22L; PPP LCP/NCP and CHAP 22L (S19); PAP 22 theory (S19 builds it and the lesson shows its clear-text password in a capture; the lab grades CHAP); VPN concepts 23; GRE 24L (S18); site-to-site IPsec 25L (C13: VTI, IKEv2, ESP; crypto maps, IKEv1 and remote-access VPN untaught:P4) |
| QoS | CoS/DSCP/IPP marking 27L; FIFO/WFQ/CBWFQ/LLQ 26 (sandbox) and 27L (FIFO congestion and LLQ on a real port, S20); policing vs shaping 27L (a policing task, S21; shaping in 27 theory and the sandbox); congestion animation 27L |
| Management | CDP and LLDP 28L; NTP 29L; syslog severities and servers 29L (S24, S25); SNMP v2c 30 theory (later:P3c, S33), v3 (later:P3c, C23); NetFlow/IPFIX 30 theory (untaught:P4); SPAN 30 theory (later:P3c, S34); RSPAN theory (untaught:P4); file system and image backup 31 theory (later:P3c, S29/S30); password recovery 31 theory (later:P3c, S31) |
| Automation | JSON/XML/YAML 37 (the data-formats concept tool) and 38L (reading the JSON a `rest GET` returns); REST 38L; RESTCONF and YANG 38L; the YANG browser (later:P3c, S28; lesson 38 shows the model as text); NETCONF 38 theory (later:P3c, C21); configuration-management tools 39 theory (the playbook runner later:P3c, C22); Python 40L (NF-Py, S32); SDN and intent-based 36 theory (the visualizer later:P3c, C26) |
| Beyond §2.3 (course modules) | NAT ccna2-33 and 18; design 32; troubleshooting 33L (EIGRP, C1)/34L; cloud and virtualisation 35 |

---

## 12. Deferred items and risks

### 12.1 Deferred (with the stage that should take them)

- **P3b (the platform, its own brief).** The assessment engine (grading service with event and CPU caps, gradebook,
  analytics), the authoring studio (with the diff-to-assertions proposer that reuses the checkers' read halves), LTI
  1.3 (OIDC login, id_token and JWKS, Assignment and Grade Services — `LabStatus` score and total map to it),
  collaboration (a CRDT whose unit of sync is the facade op, D6), tenancy and storage for `.netforge` and
  `activity.json`, the `apiRequest` journal op, deep links (C31), and with the studio the "instructors authoring their
  own labs" half of spec §19's P3 exit criterion (§8.5 P16). Because the engine is pure TypeScript, grading is a
  Node or Deno worker, which supersedes the spec §3.2 Rust/WASM plan. The backend route is decided at P3b W0: (A)
  managed Postgres with row-level security, OIDC, object storage and functions, plus a separate stateful host for the
  collaboration socket (the static host serves no websockets); or (B) a self-hostable compose stack (API, Postgres,
  S3-compatible storage, a queue, grading workers, the collaboration server) that meets spec §3.5's self-host need. The
  cross-cutting map recommends piloting on (A) with a portable schema (plain SQL migrations), so (B) is a re-host.
- **P4 (security track).** Crypto maps, IKEv1 and remote-access VPN (site-to-site VTI IPsec is C13, built in P3a);
  NetFlow/IPFIX and
  RSPAN; server AAA (RADIUS/TACACS+) and 802.1X port authentication; reflexive ACLs and zone-based firewalls; DHCPv6
  guard, RA guard, IPv6 source guard, option 82 and the snooping database agent; time-based ACLs if C10 is not
  approved.
- **P5 (CCNP).** EIGRP stub, summarisation and unequal-cost sharing (C2), redistribution, named mode, wide metrics and
  EIGRPv6, on the classic core C1 builds in P3a; OSPF stub/NSSA/type 7, virtual
  links, LSA filtering, summarisation and redistribution beyond the default route, SHA key chains, NBMA over a Frame
  Relay medium; BGP; MPLS and Metro Ethernet services in the engine; WRED, hierarchical QoS, AutoQoS; mGRE and DMVPN;
  configuration archive and replace; the controller mock; port and VLAN ACLs.
- **P3c (a follow-up content stage, before P4).** The SHOULD items of §8.2 that §8.5 P1 did not approve, and the COULD
  items that deepen CCNA 3 without a new platform, each already designed here (§1, §2.13, the area maps), so P3c's
  brief is a selection plus waves. The CCNA 3 lessons keep their theory; P3c adds the hands-on part `'later:P3c'` marks
  in §11.4.
- **Every SHOULD and COULD item not approved on 2026-09-29, with its stage** (P13; §11.4 uses the same values; an
  item approved later leaves this table). Approved and therefore absent: S1, S2, S3, S9, S13, S18, S19, S20, S21, S24,
  S25, S32, S37, C1, C13.

  | Stage | Items |
  |---|---|
  | P3c | S4, S5, S6, S7, S8, S10, S11, S12, S14, S15, S16, S17, S22, S23, S26, S27, S28, S29, S30, S31, S33, S34, S35, S36, S38, S39, S40, S41 (every SHOULD not approved); C7, C8, C14, C15, C16, C17, C20, C21, C22, C23, C24, C26, C29, C32 |
  | P3b | C31 (deep links, which LTI needs); the instructor-authored labs half of spec §19's exit criterion (§8.5 P16) |
  | P4 | C10, C11, C12; crypto maps, IKEv1 and remote-access VPN (beyond C13); NetFlow/IPFIX and RSPAN |
  | P5 | C2, C3, C4, C5, C6, C9, C18, C19, C25, C27, C28; EIGRP named mode, wide metrics and EIGRPv6 (beyond C1) |
  | never | C30 (clock drift: no teaching value at CCNA level) |
- **Never, or conceptual only:** BFD, graceful restart, RIP (not in the course), real cryptography (crypto stays a
  simulated state with real headers), switch QoS queues and trust (`mls qos`), QoS pre-classification on tunnels.
- **P2 §14 leftovers not taken here:** the TimelineStrip guard and the demux `frame: 'data'` contract (C32).

### 12.2 Risks and mitigations

| Risk (spec §20) | Where it bites in P3a | Mitigation |
|---|---|---|
| **R1 scope** | The maps' MUST items sum to 117 ew, 2.25 × P2's MUST; the figures are uncalibrated (P2 recorded no effort actuals). The approved plan is 123.2 ew (135.5 with the contingency), about 1.6 × the recommended plan and 1.9 × P2's approved plan. | §8.4: duplicates counted once; demotions by exam value with stated fallbacks; every SHOULD and COULD item is its own set of bracketed wave items; a review contingency of ≈ 10 % of the whole approved plan (12.3 ew) spent before any cut; a cut order that removes the approved COULD items first, then the approved SHOULD items (never before the items that depend on them), and only then MUST. |
| **R2 fidelity** | Deliberate deviations: (1) the OSPF hello reply after 1 s; (2) immediate direct LSAcks; (3) one OSPF process per device; (4) full SPF only and no LSA group pacing; (5) a deterministic DD sequence number; (6) serial routing bandwidth 1544 kb/s while `show interfaces` shows the clock rate; (7) equal-AD ties across protocols broken by metric; (8) NAT's use of a list is not counted; (9) no DHCP option 82; (10) DAI requires the binding's port to match; (11) the RSA key is a configuration line; (12) ACL log aggregation fixed at 5 minutes; (13) the existing admin-state log keeps severity 3; (14) no default WFQ on slow serial lines (FIFO with the 256-frame cap); (15) the traffic generator's discard sink on UDP 9; (16) TLS is a simulated state with no handshake bytes; (17) CDP uses an NF format and its rows are removed at link-down; (18) no hardware calendar: clocks reset on reload; (19) NTP steps the clock on the first valid reply; (20) RESTCONF serves a curated model with no candidate datastore; (21) the queueing sandbox schedules WFQ as flow DRR; (22) OSPF sends an extra hello when an interface's DR or BDR changes; (23) no ICMP for an outbound ACL deny of a packet NAT has already translated; (24) CDP and LLDP run on Ethernet ports only; (25) a managed switch's UDP and TCP stay dormant (protocol unreachable) until a P3 service is configured on it; (26) an unsynchronised NTP client re-polls on a fixed 1–32 s schedule. The approved items add: [S13] `access-class` refuses after the handshake, simulated SSH crypto, a managed switch answers vty only after a P3 line (`transport input`, an RSA key) wakes its transport; [S18] no GRE keepalives, no fragmentation (an oversize packet drops `mtu-exceeded`, D15); [S19] PPP on direct cables only, deterministic magic numbers and challenges, a 10 s retry, no CDPCP/LQM; [S20]/[S21] CBWFQ scheduled by DRR, a 200 ms LLQ burst, queueing policies on physical ports only; [S32] NF-Py is a subset with 2⁵³ integers; [C1] an EIGRP hello reply, reliable packets unicast to each neighbour, load and reliability constant (1 and 255), no automatic summarisation; [C13] simulated IPsec crypto (real headers, payload shown decoded, FNV proofs and ICVs), one fixed proposal, no rekey, lifetime or dead-peer detection, no replay window, crossing initiations resolved by the lower address, VTI only. | Each is a row of the fidelity table in `docs/CATALOG.md` (the architect adds it when the wave that builds the feature reports it) and, where a learner could notice, a sentence in the lesson. Behaviour that exam questions test (the election rules, the adjacency states, costs, AD values, first-match and implicit deny, wildcard maths, the snooping trust model, CDP/LLDP fields, NTP strata, REST verbs and status codes) is exact. |
| **R3 performance** | SPF: about 1 ms for 500 vertices, and a flap re-runs SPF on every router of the area; memory for one LSDB per router. Trace volume: one tableWrite per ACL hit and per inspected ARP; CDP every 60 s per port. [S20] queueing at line rate. | The SPF throttle bounds frequency; LSA rows reference frozen bodies (C8 interning if needed); `accept.p3.ospf-scale` at 50 routers (a realistic ceiling for course labs). ACL rows only for applied lists; CDP/LLDP/OSPF hellos are background; one CDP transmit timer per device; rows rewritten only on displayed changes (rule 20); `accept.p3.mgmt-scale`. [S20] runs at WAN rates (64 kb/s–2 Mb/s) with generator caps and `accept.p3.qos-bounded`. |
| **R4 legal** | The `%FAC-SEV-MNEMONIC` shape [S24/S25]; the `requests`-style module name [S32]; the names "CDP" and "EIGRP" [C1]; the YANG models; the IKEv2 payload names and proposal words [C13]. | Original wording for every message and mnemonic; CDP in an NF format under the NF OUI (P2 D8); EIGRP in its published RFC 7868 format (D23); IKEv2 and ESP names are IETF protocol facts; IETF module names only and an original `nf-native`; legal review before W2 for the flagged items (§8.5 P12). |
| **R5 determinism** | Flooding order and SPF ties; same-instant multicast clones; BigInt in clock maths; the configure seam; [S32] floats. | The fixed orders of §4.5; LSUs bundled in LSDB key order; SPF ties never on heap order; same-instant clones processed in scheduler sequence; BigInt never leaves the clock helpers; the configure seam is an event, never nesting; no new rng stream; `accept.p3.determinism` (3 runs) and `accept.p2.replay-exact` over the CCNA 3 labs. |
| **R6 content volume** | 40 lessons and 21 labs (16 MUST, 5 of approved items, and approved tasks in 5 MUST labs), theory written after the grammar. | The skeleton and frozen ids in W1; theory parallelised per module group (theory-a … theory-d); the commands and code-sample test fails a wrong command at once; labs reuse kit builders; videos optional; merge candidates named (§11.1). |
| **R9 curriculum drift** | The exam blueprint moved PPP and EIGRP out; automation is recognise-level. | Objectives as data with `handsOn` states; the coverage-gap warning; every demoted topic keeps a theory row. |
| **Suite time** | The P2 digest test, replay shards and the loop storm already take minutes; the new golden and the CCNA 3 shards add more. | The slow project, run by the lead once per wave and at gates; shards; implementers run only their own files (rule 15). |
| **Bundle size** | New concept tools and desktop apps; engine additions in the worker. | Lazy chunks for every new app and tool; engine code lives in the worker bundle; parsers are small pure modules; no dependency. [S32] adds about 130 KB minified to the worker and 40 KB to the main bundle (the tokenizer for highlighting). |
| **Seams** (P1's lesson) | The ACL continuation and resume after NAT; the multicast framing rule; `ipv4.routes` and the RIB watch; routed-port control delivery; the configure event; `http.result` ownership and the CLI job; the tcp `tls` flag; the udp discard hand-off; runtime marking before transmit; with the approved items the `remoteCli` event and the vty ↔ CliRuntime output path [S13], the tunnel owner shared by GRE and IPsec and its `ike.connect` / `tunnel.sa` seam [S18] [C13], the ppp ↔ link-model line state [S19], the runtime ↔ link-model scheduler (`egressPolicy`, `qosClass`) [S20], EIGRP's reliable transport [C1]. | Each is an exact contract in §2 and a step in §3; debug categories are a table (§5.8); each wave's adversarial verify targets the seams it touched on `staged.world`. |
| **Stage-flip regressions** | The W4 flip gives every router and switch in every old world new (silent) daemons, switches `udp`/`tcp`, and the snapshots new empty tables. | The flip runs alone, after qa's acceptance tests (rule 14), with both digest goldens, the exports and lab-status goldens and both silence tests inside; D22's transport is dormant and two synthetic guard worlds prove it; the snooping tables are stage-filtered and never reach the controller; names enter the registry only with their factories; the byte-risky items ran the digest shards themselves (rule 9). |
| **Defaults that do not survive a save** | `no cdp run` in a P3 world would come back on reload. | `bothForms` storage (D2); `accept.p3.profile` round-trips every CDP form through export, reload and the clone. |
| **Process** | P2's W6 push to `master` by an agent, which the live site served for four days. | Agents never run git (rule 16); resumable scripts with no git calls (rule 17); wave commits on a `p3` branch only and nothing pushed to `master` before the W8 gate (rule 21); the lead checks the remote after every run. |
| **Built bundle** | New layers, registries and worker modules. | Gate G every wave (rule 10); no module-scope cross-module reads (rule 12). |

### 12.3 The product owner's decisions and their background

The decisions were recorded in §8.5 on 2026-09-29, before wave 0. Background for each, as it stood when they were
taken, and what was decided:

1. **The SHOULD set.** The recommendation added only S1 (the OSPF overlay), S9 (the wildcard visualizer) and S37 (the
   P3b seams): ≈ 5.2 ew on a 69.8 ew MUST. The product owner approved thirteen SHOULD items (40.9 ew), most of the
   recommendation's "add in this order" list and S21; the others keep a stated fallback and a stage (§12.1).
2. **The P3 profile.** One MUST default (CDP) keeps P3 worlds honest about discovery without moving any P1/P2 byte.
   With S24 and S25 approved, the management map's broader defaults (timestamps lines, console logging, link-change
   logs) join the P3 profile, each passing the D2 rule.
3. **Fix vs gate.** Fixing defects in every profile moves listed digests once; gating them keeps two behaviours alive
   for ever. Approved as recommended.
4. **EIGRP and IPsec** are named by the spec for CCNA 3 but have left the current blueprint (EIGRP) or belong with the
   security track (IPsec); both were designed in the area maps. Both are approved as COULD items C1 and C13, and this
   brief writes their designs in full (D26, D27, §2.16, §2.17, §3.12, §3.13).
5. **PPP, the full QoS scheduler, the remote terminal and Python** were the four large items the maps flag first; each
   had a fallback that meets the configure-and-verify objectives (HDLC plus theory; QoS lite; SSH configuration; the
   `rest` command and the playground). All four are approved (S19; S20 and S21; S13; S32), so the fallbacks now serve
   only as the cut order's landing points (§8.4).
6. **The next planned card** keeps the landing page's promise of more to come; the P4 security track is the next course
   content in the spec's roadmap (P3b adds no course).
7. **The review's three new records** (P14–P16): the switch transport stays dormant so no old byte moves; the default
   profile flips with the course and nothing is deployed before the exit gate; and P3a's exit criterion is its own
   scope list, the "instructors author labs" half of spec §19 going to P3b.

---

## 13. Review changes (adversarial review of this brief, applied before wave 0)

Two adversarial reviews returned findings: a technical one checked against the code at 5263f16 (T1–T41: 3 high, 20
medium, 18 low) and a plan one on coherence, completeness and buildability (P1–P22: 6 high, 10 medium, 6 low). Each is
listed with its disposition and where it landed. The lead architect decided sixteen of them before this revision (D22's
switch transport, traffic flows, the OSPF election and timings, the queue view, the staged tables, the profile flip and
deployment, lab 37, the rate limits, CDP on the AP, SSH on switches, NTP, QoS marking placement, pricing, the missing
decisions and the stages of unbuilt items); those are applied as decided. None was rejected; where the brief took a
different route from the reviewer's proposal, the route and the reason are given. Findings that reported the same
defect are merged: T6 = P2 (tables), T13 = P14 (CDP on the AP), T15 = P16 (lab 37), T20 = P2 (stubs), T27 = P17 (help
goldens), T28 = P9 (course-profile pin), T39 = P2 (`show errdisable recovery`).

**Technical findings**

- **T1 [high] The D22 guard was vacuous and "saved file" was false — accepted, by the lead's byte-preserving
  alternative.** Managed switches still derive `udp`/`tcp`, but ipv4 treats them as absent on a device whose transport
  comes only from `managed-switch` until a P3 service that owns a socket is configured there (`DORMANT_TRANSPORT_OWNERS`,
  D22). An untouched switch SVI answers exactly as today, so §9.3 (a) and §9.4 (a) now say "no change" with the reason,
  and rule 5 keeps "and saved file" (a file saved before P3a cannot hold a P3 service line). The reviewer's two synthetic
  guard worlds (P1 and P2: an NF-C2960 with Vlan1 up, a router DHCP server, two DHCP PCs, a router traceroute and a
  browser fetch to the SVI) are recorded at W0 from 5263f16 in the fourth digest shard (D3), so the guard is no longer
  vacuous; `accept.p3.switch-transport` and `ip.switch-transport.test.ts` prove the wake-up and the return to dormancy.
  Not taken, because the alternative makes them moot: listing every moving event kind in §9.3/§9.4 and recording a
  user-file behaviour change.
- **T2 [high] A continuous flow over a congested link held `runToIdle` for ever — accepted.** Continuous flows are used
  only under `runFor`; every flow stops at the hard cap `TRAFFIC_MAX_DURATION_MS` = 300 000 (D16, §2.4, §4.2, rule 19);
  `accept.p3.traffic-bounded` now says "an uncongested or finished flow does not hold `runToIdle`";
  `accept.p3.determinism` uses bounded flows.
- **T3 [high] R1's own election gives DROther, not Backup — accepted.** D9 adds the non-periodic, coalesced
  `dr-hello:<if>` (a hello at once when the interface's DR or BDR changes; a listed deviation); §3.1 step 4 documents
  R1's Waiting → DROther → Backup sequence, and `ospf.dr.test.ts`, `ospf.adjacency.test.ts` and
  `accept.p3.ospf-dr-election` pin it; step 7 now takes BackupSeen from R1's reply (R1 declares itself BDR), with R3's
  cable moved to U + 65 s so no periodic hello coincides with it. (With T33.)
- **T4 [medium] The brief's timers give about 15 s on point-to-point links — accepted.** D9 fixes the order (an
  `lsa-gen` due with `spf` runs first: `spf` performs pending originations, then computes) and §3.2, §4.2, the
  `settleMs` guidance and the acceptance rows are recomputed: routes at link-up + 15 s on point-to-point links (the
  neighbour's re-originated LSA reaches the SPF only at its next run, which the fixed order cannot change), failover at
  T + 5 s, restore at T2 + 15 s for T2 ≥ T + 30 s, the LAN still at U + 45 s + ε; 60 s settle covers every case.
- **T5 [medium] The FIFO view had no data source — accepted, option one.** `PortSnapshot.txBacklog` (optional by meaning:
  depth plus up to 8 frame summaries, written only while a backlog exists, filled from the in-flight store's new
  `queued(ref, now)`, normalised away in the goldens) is the overlay's only source; D24 holds; `reconcileInflight` is
  unchanged (D16, §2.8, §3.5, §6, §10.2).
- **T6 [medium] Appending the snooping tables to `PROCESS_TABLES.vlan` in W0 changed every VLAN-aware device —
  accepted.** W0 adds only the `ExtraTableName` members; the W4 flip adds `STAGED_PROCESS_TABLES` and a stage filter in
  `deriveTables`, P3 stage and `managed-switch` only, never the controller (§2.6, D13); `staged.world` carries them as
  test-only data before the flip; the moved pins are in §9.2 W4 (items 32–35) and the snapshot shape change is
  normalised (§4.6). The same principle now binds every W0 addition (rule 3): `ERR_DISABLE_CAUSES` is appended by the
  W2 l2 change.
- **T7 [medium] `service-policy` as a `PHY_CONFIG_KEYS` line recompiled nothing — accepted.** Policies compile lazily
  against a configuration generation that every `class-map`, `policy-map`, `access-list`, `ip access-list` and
  `service-policy` delta increments; `service-policy` is not a `PHY_CONFIG_KEYS` line in P3a ([S20] adds it for
  scheduler ports) (D16, §3.5, §5).
- **T8 [medium] Output marking in `transmitOn` saw the parent port — accepted.** Subinterface output marking runs in
  the subinterface branch after `vlanPush`, keyed by the subinterface; SVI output policies are refused with the new
  `qosPortUnsupported` message. Beyond the finding, SVI input policies are refused too, since an SVI's input never
  passes step 10c (D16, §3.0, §5.4, `accept.p3.qos-marking`).
- **T9 [medium] Step 10c marked frames that are later dropped — accepted.** 10c runs in the runtime only on a `deliver`
  or `subif` verdict, before the tag pop (§3.0 (b), D16); `device.qos-marking.test.ts` pins that a flooded frame is not
  counted.
- **T10 [medium] The first NTP poll often failed and the retry was periodic — accepted.** While unsynchronised a client
  re-polls at once on link-up and on a route change toward the server (an `ipv4.ribWatch` lpm watch) and retries after
  1, 2, 4, 8, 16 and 32 s (six non-periodic retries per kick, then only the periodic poll); an unsynchronised server
  answers stratum 16, leap 3, refId `INIT`, and clients reject it; bare `ntp master` is stratum 8 (D19, §3.7, §4.2,
  §5.5, `accept.p3.clock-ntp`).
- **T11 [medium] `offsetNs` could exceed 2⁵³ — accepted.** `NtpPeerRow` stores `offsetMs` plus `offsetSubMsNs`; the new
  `clock` row uses the same split; `delayNs` stays (a round trip is far below 2⁵³) (§2.6, §4.5).
- **T12 [medium] The `cdpDefault` rule included home routers — accepted, with the lead's rule.** `cdpDefault =
  !nat-gateway && ((cli.shell === 'nfos' && (routing || managed-switch)) || wireless-controller)` (D2, §2.1).
- **T13 [medium] The lightweight AP had no CDP receive path — accepted, option one.** `lightweight-ap` leaves
  `cdpDefault` and the CDP/LLDP capability rows; the AP bridges CDP like any transparent bridge (D2 with a rejected
  alternative, D18, §2.1, §1.1). (= P14, first half.)
- **T14 [medium] SSH and ACLs on switches were blocked by grammar scopes — accepted.** `ip domain-name` and the ACL
  lines widen to `managed-switch`; `userSecretOf` reads the `privilege` form; the switch help-golden migrations are
  listed with exact arrays (D14, §5.2, §9.2 W2 items 21 and 26, `accept.p3.device-access`).
- **T15 [medium] No assertion kind could grade the data-formats playground — accepted, option two.** Lesson 37 is
  "theory + `concept:data-formats`" with no lab; MUST labs are 16; lab 38 gains the JSON reading tasks (a `rest GET`
  graded through `restconf-log`, then the value found acted on, graded by `vlan`) (§3.8, §11.1, §11.4, §2.10). (= P16,
  third point.)
- **T16 [medium] The tcp/udp probe seam was unspecified — accepted, by a different surface.** The probes are process
  requests (`tcp.probe`, `udp.probe`, §2.4) that the clone applies exactly as it applies `icmp.ping`
  (`sim/lab-checks.ts:847-891`), with outcomes in a new optional `probes` member of the tcp and udp StateViews; they are
  not `HostAppRequest`s, so no facade op is added. TCP passes on SYN-ACK; UDP passes when the clone trace shows the
  datagram consumed by a socket on the target, and fails on an ICMP unreachable, a drop or 3 s (§2.10).
- **T17 [medium] "A denied packet creates no NAT row" was false outbound — accepted.** The claim is limited to inbound
  denies; an outbound deny follows NAT's translation and allocation, as on real devices; `acl.filter` gains `inPort`
  (dir `out`) so the ICMP error is sourced from the ingress interface. Beyond the finding, a deny of a packet NAT has
  already translated (`natted`) sends no ICMP, because its source is now the router's own address (a listed deviation)
  (D12, §3.0, §3.3, `accept.p3.acl-order`).
- **T18 [medium] The TCP retry counts were wrong — accepted.** SYNs at 0, 1, 3 and 7 s (RTO 1 s doubling, 3 retries,
  inside the 10 s fetch timeout): "(4 matches)" and "3 packets"; the acceptance test derives the counts from
  `TCP_INITIAL_RTO_NS`, `TCP_SYN_RETRIES` and `HTTP_CLIENT_TIMEOUT_NS` (§3.3, §5.8, §10.1).
- **T19 [medium] `rest -d '<json>'` could not be tokenised — accepted, option one.** `-d` comes last and takes the
  rest of the line verbatim (one trailing ArgType `rest` argument that the job splits); `cli.rest.test.ts` pins a body
  with quotes, brackets and spaces (D21, §3.8, §5.6).
- **T20 [medium] The W0 stub list was incomplete — accepted.** Rule 3 and §9 W0 item 1 add `REASON_ICON`/`REASON_LABEL`,
  `PANEL_TAB`, `SURFACE_PANEL_TAB`, `ERR_DISABLE_CAUSE_TEXT`, `DEFAULT_TIMELINE_LANES` and the typed records of
  `timeline.lanes.test.ts` (with P2).
- **T21 [medium] `origin` had no path into `configChange` — accepted.** `DeviceRuntime.applyConfigLine` gains an
  optional fourth `origin` argument, fed by the headless session `configure` opens; the Simulation's `deviceConfigure`
  dispatch is the one caller of `cliCore.configure`, and `DeviceRuntimeDeps.configure` is dropped (D21, §2.9, §3.0 (c)).
- **T22 [medium] The shows needed unspecified StateView data — accepted.** §2.6 now gives the ospf StateView
  (`neighbors[].deadAt`, `spf.{runs, lastAt, nextAt}`, the SPF trees) and the ntp StateView (`peers[].nextPollAt`,
  retries), and the W3 cli tests are written against them.
- **T23 [medium] Nothing in MUST could trigger the rate limits — accepted as the lead decided.** Lab 20 has no
  rate-limit task; the limits are proven by unit and acceptance tests with the test injector `test/inject.ts`
  (`injectFrames`, W1 qa); the now unused `snooping.rateLimit` fact is removed (D13, §3.4, §7 W1).
- **T24 [low] Two P2 precedents that were never built — accepted.** [S8] writes the `convergence` block in full
  (§2.10, §2.12, §2.13, §8.2 +0.3); §4.1 cites `fnv1a32` (`contracts/addr.ts:259`).
- **T25 [low] The ipv4 codec has no `tos` — accepted.** `dscp 48` (D7, §3.1).
- **T26 [low] LSA-header checksum and length cannot always be derived — accepted.** Required when `headerOnly`, derived
  only in an LSU (§2.3; `pdu.codecs.p3.test.ts`).
- **T27 [low] `bandwidth` was serial-only; help-golden gaps — accepted.** The `bandwidth` grammar widens to routed
  Ethernet ports and subinterfaces (§5); §9.2 W2 item 21 lists `bandwidth` and `service-policy` on the routed port,
  `clock` in router config and `flow`/`rest` in the PC's user exec as exact arrays at `:60-64`. (= P17, first point.)
- **T28 [low] `learn.course-profile.test.ts:43` is a changed pin — accepted.** It moves at W7 with the flip (§9.2 item
  41). (With P1 and P9.)
- **T29 [low] Stale citations and counts — accepted.** `http-client.ts:277` (header `:10`); `cli/runtime.ts:1223-1226`;
  three importers of the `p2.world` aliases; RFC 2328 §16.1 step (3).
- **T30 [low] D18's delivery wording was too broad — accepted.** Classes `cdp` and `lldp` only (D18, §3.0 (b)).
- **T31 [low] CDP on a routed port with a native subinterface — accepted.** The control check runs on the physical port
  before step 10a (D18, §3.0 (b), `device.pipeline.p3.test.ts`, `accept.p3.cdp`).
- **T32 [low] The two `service timestamps` lines overwrote each other — accepted.** Their rule has identity 3 (D2,
  §5.7, `accept.p3.syslog`).
- **T33 [low] "The BDR sends nothing" — accepted.** A non-DR router, the BDR included, floods its own LSAs to
  224.0.0.6; the BDR only never re-floods what it received on the segment (§3.1 step 6, `ospf.flood.test.ts`).
- **T34 [low] "About a minute" was too short — accepted.** "About 90 s before the first ping on a broadcast segment"
  (45 s boot + 40 s wait + 5 s SPF), "about a minute" on point-to-point links; router-facing access ports get PortFast
  in lab initial configurations, otherwise add 30 s (§11.2).
- **T35 [low] The grader clone applies an unapplied router id — accepted, option two.** Router ids are graded with the
  live `fact ospf.routerId`, which reads the new `routerId` column of `ospf-interfaces` (the id in use); a lab rule and
  a §2.10 mapping row forbid clone-only grading of a router-id fault (§11.2).
- **T36 [low] The `flows` table's tail was undefined and its grading ambiguous — accepted.** A `flow-flush` write 1 s
  after the last datagram, a final-datagram flag that bounds tail losses, `ended`, and grading by `where {src, flow,
  dscp: 46}` (§2.5, §2.6, §3.5, §2.10).
- **T37 [low] NAT's reader dropped standard entries with `log` — accepted, second option.** `readStandardAcls` ignores
  a trailing `log`; the P2 grammar has no `log`, so no P2 document changes, and `parseStandardAclEntry` with
  `core.acl.test.ts:35` stays as it is (D12, §9.1).
- **T38 [low] `ip access-list standard <number>` changed a P2 command's storage — accepted, by keeping P2's storage.**
  A numbered section stays a section (`config-rules.ts:280`) and joins the global lines of its number, global lines
  first; nothing moves, so §9.1 asserts it unchanged instead of §9.2 listing a migration (D12, §5, `accept.p3.acl-edit`).
- **T39 [low] Golden shows whose output changes — accepted.** The chosen `show` of every golden world is one no §9.2
  item changes (D3); `show errdisable recovery` now changes at W2, with exact lines (§9.2 item 24). (With P2.)
- **T40 [low] The capture split must keep `fields.ts` — accepted.** `capture/filter/fields.ts` stays the index file
  (rule 18, §7 W2 capture).
- **T41 [low] The sandbox's WFQ is flow DRR — accepted.** R2 deviation (21) (§12.2, D16).

**Plan findings**

- **P1 [high] The course-profile mapping broke CCNA 1 at W1 and CCNA 2 at W4 — accepted as the lead decided.**
  `Course.profile` is data from W0 (course item; `ccna3` still planned); `profileForCourse` keeps its classic rule until
  the W7 course flip, whose change also sets `LATEST_DEFAULTS_PROFILE = 'P3'` (not W4); rule 21: nothing is pushed to
  `master` before the W8 gate, wave commits go to a `p3` branch, and the lead checks the remote after every workflow
  (D2, §2.1, §7 W0/W4/W7, §8.5 P15, §9.2 items 41–42, §10.2, §10.3).
- **P2 [high] W0 could not be green or behaviour-neutral — accepted.** The missing stubs (with T20), the lane and FSM
  test records, `sim.profile.test.ts:51` asserting `'P4'`; `ERR_DISABLE_CAUSES` appended in W2 with the
  `cli.port-security.test.ts:183-206` migration; the snooping tables stage-filtered at W4 and never on the controller
  (with T6); rule 3 now forbids any behaviour-changing W0 addition (§9.2 W0 items 1, 5, 11; W2 item 24).
- **P3 [high] `staged.world` could not build P3 worlds before the flip — accepted.** It carries the final order, the P3
  capability rows and the staged snooping tables as test-only data from W0, and the flip adds
  `staged.world.p3-parity.test.ts` (rule 13, §7 W0/W4).
- **P4 [high] Same-wave dependencies — accepted, with one placement different from the proposal.** The OSPF L3
  plumbing and the dormant-transport rule move to W1 l3; tcp `tls` and `admin-prohibited` to W1 svc; `qos/*`, capture
  fields, the web concept models with their parity tests, the worker's defaults-ladder wiring and
  `sim.device-configure.test.ts` to W2 (the W1 sim handler is tested with a fake runtime); the routed-port control
  check to W2 device (it needs the W1 control rows). **Device marking goes to W3, not W2**, because it calls `qos/*`,
  which is now W2: placing both in W2, as proposed, would repeat the defect. §7's preamble states the rule.
- **P5 [high] W4 acceptance rows needed W5 grader features — accepted.** The clone features move to W3 sim, testable on
  `staged.world` with the W2 probes (§7 W3, §10.1).
- **P6 [high] S37 and three other SHOULD items had no wave item — accepted.** S37: W0 block, W5 io, W6 sim and
  web-shell, W7 qa; S8: W0 block, W3 sim; S40: W3 sim; S32: W3 auto (NF-Py), W5 auto (`script-host`), W6 flip,
  workspace and lab; §8.2 regains its "Wave items" column for every row.
- **P7 [medium] Scenario and File-menu pins broke at W5 — accepted.** §9.2 W5 items 38–39 with exact values;
  `CATEGORY_ORDER` moves to W5; §9.1 no longer lists `labs.ccna2.solutions` as unchanged.
- **P8 [medium] Catalog-flip pins missing — accepted.** §9.2 W4 items 31–36 cover `device.catalog.p2` (filtered to
  `since: 'P2'` or computed at stage P2), `device.catalog.data` (the seven data files join the flip), the other catalog
  tests, the registry test's exact map and `:121`, and the table lists of `tabs.test.ts` and
  `sim.snapshot-cache.test.ts`. Where a list is long, the entry states the exact rule that computes it (as §9's
  preamble allows), and the change writes the literal.
- **P9 [medium] Web profile and landing pins missing — accepted.** `worker.profile.test.ts:144-193` (W7) and `:195-264`
  (W2); `learn.course-profile.test.ts:43-47, :174` (W7); `learn.landing.test.ts:62-72` and `curriculum.test.ts:74-91`
  (W7); `io.schema.p2.test.ts:80` (W1) (§9.2 items 15, 25, 41–43).
- **P10 [medium] M13 was underpriced — accepted as the lead decided.** M13 7.5 ew, S20 5.0 ew, with the split shown in
  §8.4's WAN row; the MUST cut option keeps the traffic generator as the FIFO view's load source (−3.5, §8.4).
- **P11 [medium] The calibration claim and two rows did not reconcile — accepted.** §8 now says the P2 figures were
  estimates and P2 recorded no actuals; a 7.0 ew review contingency (≈ 10 % of MUST; P2's MUST grew ≈ 6 % at its
  review) is a row of §8.1; the ACL row explains M10's extra 0.2 (A5's storage and facts; A5's enforcement, 0.3, is
  what moved to S13), so it demotes 8.8 and keeps 11.0; the management row keeps map M13's descriptors and vocabulary
  (0.3) in M14 and demotes only the overlay (0.7) to S26. The course row needed no change (M18 is not underpriced).
- **P12 [medium] Missing product-owner decisions — accepted.** §8.5 P14 (D22, now byte-preserving), P15 (the flip timing
  and no deploy before W8), P16 (the P3a/P3b split and the redefined exit criterion; spec §19's "instructors authoring
  their own labs" moves to P3b); the intro and §12.1 say the same.
- **P13 [medium] Spec §2.3 items with no stage — accepted as the lead decided.** §12.1 gives every SHOULD and COULD item
  not in the recommended plan a stage (`later:P3c`, a follow-up content stage; P3b; P4; P5; one "never"); §11.4 gains
  the `handsOn` value `'later:P3c'`, no tool is "taught as theory", and the YANG browser row has its lesson (38) and
  value; §8.5 P13 checks it.
- **P14 [medium] CDP on the AP and dead vocabulary in MUST blocks — accepted.** The AP half is T13. The IPv6 ACL
  members, `http.request.owner 'gui'`, `auth`, LSA types 3/4/7 with `IA`/`E1`/`N1`/`N2` and virtual links,
  `protectedBy 'ssh'`, `lastIface 'vty'`, `voiceVlan` and `medVlan` move to their bracketed items (§2.3–§2.6, §2.10,
  §2.13). Not moved: `ribWatch.lpm` and `RibChangedEvent.lpm`, which the MUST NTP client now uses (T10).
- **P15 [medium] The W2 gate used W3 components — accepted.** §10.3 W2 uses only what W2 ships; the sandbox, the
  playground and the QoS overlay move to W3's script, and every script says so.
- **P16 [medium] Contract and grading gaps — accepted.** `CommandCtx.clock()` lands in W0 (§2.9); the facts read tables
  or configuration — `ospf.routerId` from the new `routerId` column, `clock.*` and `ntp.stratum` from the ntp daemon's
  new `clock` table, which `clock set` also writes because it goes through ntp (`ntp.clockSet`), so it is a
  tableWrite the worker already re-checks on (the lead's "configChange-equivalent") (rule 20, §2.4, §2.6, §2.10, D19);
  lab 37 is T15; §2.10's table gains the JSON-reading row.
- **P17 [low] Test updates missing or wrong — accepted.** The help goldens at `:60-64` with exact arrays (with T27);
  the LLDP control pins `l2.control.test.ts:68` and `l2.eth-switch.vlan.test.ts:187-193`, and the drop detail at a
  VLAN-aware port without the daemon (`lldp is not running on this device`); the fixtures
  `l2.eth-switch.p2.harness.ts:144` and `udp.tunnel.test.ts:87`; no `DeviceRuntimeDeps` member is added (T21), so the
  five `createDevice` harnesses need nothing; `P3_DEVICE.emitLog` only with S24 (rule 2, §9.2 items 19–21).
- **P18 [low] The coverage tests could not parse the planned names — accepted.** Shard names are hyphenated
  (`accept.p3.p2-digests-*`, `accept.p2.replay-exact-*`); `accept.p2.coverage.test.ts:37-51` gains an explicit shard
  record instead of an edit to the closed P2 brief; P3's §10.1 has one file per row with trailing tags and states the
  parse rule (§9.2 item 8, §10.1).
- **P19 [low] P1/P2 byte identity was checked late — accepted.** Byte-risky items (⚑ in §7) run the digest shards as
  their own files (rules 9, 15).
- **P20 [low] The W4 flip checks and order were incomplete — accepted.** Rule 14 adds `accept.p3.p2-exports` and
  `accept.p3.silence`, notes that `accept.p2.silence` runs on the P2-stage catalog, and orders qa before the flip.
- **P21 [low] Files with two owners or none — accepted.** §7 opens with a one-owner table naming every reviewed edit;
  `management.ts` splits into `discovery.ts` (disc) and `time.ts` (svc); the adapter files belong to their areas;
  `device.ts`, `simulation.ts`, `nat.ts` and `p2p.ts` keep one owner, with the S items as that owner's bracketed items;
  the W0 lab-check stubs go into the existing switch of `sim/lab-checks.ts` (D5); the architect writes the final lane
  entries in W0.
- **P22 [low] §8.1's wave columns disagreed with §7 — accepted.** The columns are regenerated from the revised §7, and
  §8.4 no longer calls S1 and S9 "the two visualizations the spec names" (those are S2/S3).

**Consequences for the plan.** MUST grows from ≈ 64.9 to ≈ 69.8 ew: two map rows corrected (M13 +2.5 from S20, M14 +0.3
from S26's share of map M13) and the review's additions (+2.1: M1 +0.3, M2 +0.3, M3 +0.2, M5 +0.2, M10 +0.3, M14 +0.2,
M15 +0.4, M16 +0.1, M18 −0.1, M19 +0.2), plus a 7.0 ew review contingency (≈ 76.8 with it). SHOULD falls from ≈ 87.3 to
≈ 85.3 (S20 7.0 → 5.0, S26 1.0 → 0.7, S8 1.5 → 1.8); COULD stays ≈ 52. The recommended plan (MUST + S1, S9, S37) is
≈ 75.0 ew, ≈ 82.0 with the contingency (it was ≈ 70.1). The course ships 16 MUST labs (was 17). The wave list (§7), the
cut lines (§8) and the migrations (§9) agree: no item depends on its own wave or a later one, every MUST row names the
§7 items that carry it, every SHOULD row names exactly its bracketed items, and every W0 addition is a type, a constant
or a compile stub.

### Product-owner decisions (2026-09-29)

The product owner recorded §8.5 on 2026-09-29: the MUST plan, the SHOULD items S1, S2, S3, S9, S13, S18, S19, S20, S21,
S24, S25, S32, S37 and the COULD items C1 and C13; every other SHOULD and COULD item keeps its stage (§12.1). What that
changed in this brief:

- **Record and plan.** §8.5's "Recorded" column is filled row by row and P13's scope list names the approved ids. §8.4
  becomes "the approved plan": 69.8 (MUST) + 40.9 (SHOULD) + 12.5 (COULD) = **123.2 ew**, with a review contingency
  resized to ≈ 10 % of the whole plan (12.3, was 7.0 on MUST alone) = **135.5 ew**; the "add in this order" list gives
  way to a cut order for use under pressure (C1, C13, then the approved SHOULD items, never before their dependants,
  then MUST). §8.2 and §8.3 mark the approved rows and give each its wave items; the header, the one-sentence scope, §1,
  §2 and §12.3 say which designs now bind.
- **C1 and C13 written in full**, as the COULD rule requires before W0: D26 (EIGRP: RFC 7868 wire format, the hello
  reply, reliable transport, the integer metric, DUAL) and D27 (IPsec: a VTI on [S18]'s tunnel owner, IKEv2-lite, ESP
  with simulated crypto after the CAPWAP DTLS precedent); D11's 'D' rule now binds (`'EIGRP'` rendered `D`, a legend
  sentence for DHCP's `D*`); §2.16 and §2.17 (tables, fields, requests, modes, facts, messages); §3.12 (successor and
  feasible-successor failover, with the routing map's 31616 corrected to 30976) and §3.13 (the VTI coming up, only ESP at
  the provider); rows in §4.1–§4.5, §5, §6, §7, §9, §10.1 (`accept.p3.eigrp`, `-eigrp-dual`, `-ipsec`, `-ipsec-failure`),
  §11 and §12. C1's scope is the classic core only: `variance`, `eigrp stub`, `ip summary-address eigrp` (C2) and the
  external route type and AD 170/5 (redistribution) stay P5.
- **Dependencies on unapproved items, found and removed.** (1) The tunnel MTU fallback of D15 used [S17]'s
  `icmp.error.param` and a drop reason tagged "[S17 or S18]": both now belong to [S18], implemented by W1 l3, so GRE and
  IPsec need no fragmentation. (2) [S32] needed [S29]'s storage contract (the `storage` action, `ProcessCtx.files`,
  `TopologyDevice.files`, `DeviceSnapshot.storage`) and its `programmable` row carried `tftp`: [S32] now carries the
  hosts' `files:` slice itself (+0.5 ew, 6.2 → 6.7) and the row adds `script-host` only. (3) "Only ESP crosses the
  provider" was gradeable only with [S38] `packetSeen`: [C13] adds `path.tunnelAt`. (4) The registry pin `:121` named
  `eigrp`, which is now registered; it names `ospfv3`. (5) Three acceptance rows (W4) used clone kinds built in W5;
  they now read the trace, and W5's own test proves the kinds.
- **Designs the maps left open, decided here.** [S13]: remote sessions reach the CLI runtime through a `remoteCli`
  SimEvent, not a new `DeviceRuntimeDeps` member (D21's pattern); hidden listeners stay out of the tcp StateView (P1/P2
  routers with `line vty` keep their bytes); a switch's dormant transport wakes for vty only on P3 lines (`transport
  input`, an RSA key), never on `line vty`; a bounded `vty-logins` table and the `vty.logins` fact make logins
  gradeable (labs 15 and 19 graded live); `CliSessionView.remote` feeds the terminal chip; telnet and SSH field
  tables. [S20]/[S21]: queueing actions attach only as output policies on routed physical ports, with three new
  messages; `qosSetOnly` is dropped as dead vocabulary; `DeviceRuntime.egressPolicy` joins the contract. [S32]: a
  `ScriptRunRow` for `script-runs`. [S18]: tunnel ports have a 100 kb/s routing bandwidth and a 50 000 µs delay. C1's
  second lab sits on lesson 33 (a troubleshooting lab; lesson 10 holds the first); lab 27 becomes
  `ccna3-qos-voice-first` with LLQ and policing tasks.
- **Waves.** Every approved item has its own wave items with no same-wave dependency: GRE moves to W2 so IPsec (W3)
  builds on it, `virtualChanged` and the `emitLog` seam to W1, the pure NF-Py front end to W1 and its VM to W2; items
  that meet at a seam in one wave test against fakes and meet in a W4 acceptance row; [S2]'s dock tab is registered
  hidden in W0 and shown by web-shell in W4 (the hotkey migration moves from W3 to W4); W7 no longer waits for COULD
  approvals.
- **Course.** 21 labs (16 MUST, 24 and 40 for S18 and S32, 10, 25 and 33 for C1 and C13), and approved tasks in labs
  15, 19, 22, 27 and 29; lessons of unapproved items are theory with `later:P3c`; §11.4's `handsOn` values, §10.3's gate
  scripts and §12.1's deferred table follow.
