# NetForge — P3c (deeper CCNA 3): binding architecture brief

> **Status: design, reviewed (two adversarial reviews, §13) and decided: the product owner answered the 12 questions
> of §8.5a on 2026-10-14, and the architect's rulings of §8.5b are recorded. Wave 0 is not applied.** P0 to P3a are
> complete and live at commit cad4ac9 (engine 544 files / 7622 tests, web 125 / 1663; ARCHITECTURE-P3 §14). This
> document is the binding design for stage P3c. Nothing in it is built yet. §8 draws the cut lines and recommends a
> plan; the product owner answers §8.5a; §13 lists what the adversarial reviews changed.

This is the binding brief for the P3c build. Read it together with the contracts, which are the interfaces every
module compiles against:

- `packages/engine/src/contracts/*.ts` after wave 0 (§2 lists every addition),
- `apps/web/src/bridge/protocol.ts` and `apps/web/src/store/types.ts`.

`docs/ARCHITECTURE.md` (P0), `docs/ARCHITECTURE-P1.md` (P0.5 + P1), `docs/ARCHITECTURE-P2.md` (P2) and
`docs/ARCHITECTURE-P3.md` (P3a, "the P3a brief") stay in force. Where this document differs, this document wins.

Other sources:

- The P3a brief: §0 (rules), §1 (D1–D27), §2.13 (the bracketed SHOULD/COULD members), §8.2/§8.3 (the unapproved
  items and their first estimates), §11.4 (objective traceability), §12.1 (the P3c list), §14 (the exit record and its
  "known and accepted, for later stages" list).
- The five P3c area maps, written by architects who read the code at cad4ac9: 01 routing (S4, S5, S6, S7, S8, C7, C8);
  02 ACLs, L2 security and IPv4 fidelity (S10, S11, S12, S14, S15, S16, S17, S23); 03 WAN, tunnels, QoS extras and
  discovery (S22, S26, S35, S36, S41, C14, C15, C16, C17, C20); 04 management, files and automation (S27, S28, S29, S30,
  S31, S33, S34, C21, C22, C23, C24, C29); 05 course, platform health and cross-cutting (the P3 goldens, the stage, S38,
  S39, S40, C32, R63 (d), the bundle split, process). Their designs are carried here with their rejected alternatives;
  §1.1 records where they disagreed and what was chosen; §8 deduplicates their costs.
- **The five P3a area maps are lost.** They are not in the repository, its history or the session folders. The P3a
  brief deferred several designs to them ("the routing map's multi-area walk-through", "the management map's
  acceptance row, unchanged", "ACL map §3"). §3 of this brief rewrites every such part at the level an implementer
  needs; nothing in P3c may cite a P3a area map.
- Device data: `docs/CATALOG.md`. Field names: `contracts/fields.ts`.
- The code at commit cad4ac9 on branch `p3c`. Line numbers below refer to that commit.

**What P3c is.** P3a shipped the CCNA 3 course with 21 labs and recorded 18 of its 81 objectives as `'later:P3c'`
(`curriculum/ccna3/objectives.ts`). P3c is the follow-up content stage that turns those into hands-on work, plus the
engineering health that P3a's exit record left open. It is a static-site release like P3a: no backend, no new course,
no new defaults profile (D1). P3b (the platform) is untouched.

Stage P3c in one sentence: multi-area OSPF with ABRs and summary LSAs, OSPF authentication with real keyed MD5, an MTU
mismatch that keeps OSPF in ExStart, OSPFv3 on a shared adjacency engine, IPv6 ACLs with their implicit ND tail, IP
source guard and storm control on the access layer, an honest IPv4 MTU with DF and ICMP "fragmentation needed", the
ACL workbench, a WAN and VPN explorer, a neighbours overlay, voice VLANs learned by CDP, the GRE recursive-routing hold,
CDP mismatch logs, device file systems with TFTP, image upgrades and password recovery, SNMP v2c with an agent, traps
and a manager, local SPAN, a YANG browser — five new labs (08, 09, 30, 31, 39 in the recommended plan) and new tasks in
labs 06, 07, 17 and 20 — carried by P3-profile goldens recorded first from the live engine, a stage `'P3c'` that keeps
those goldens honest, a faster hot path, a split web bundle, and smaller, checkpointed waves.

---

## 0. Rules for implementers

P3a's rules 1–21 (ARCHITECTURE-P3 §0) carry forward unchanged in substance. The list below restates the ones whose
wording changes with P3c names, and adds rules 22–28: 22–27 come from the P3a build record (§14 "Process", the lead's
notes, map 05 §4), 28 from the acceptance-file collision map 01 found.

**Carried unchanged** (read them in ARCHITECTURE-P3 §0): rule 1 (one owner per file, build waves, `index.ts`
append-only), rule 3 (contract changes after W0 are minimal and reported; W0 adds types, constants and compile stubs
only; daemon names follow their factories), rule 6 (legal: original wording, `NF-…` names, IETF YANG only), rule 7
(seams are contracts), rule 8 (review → adversarial verify → fix every wave), rule 10 (the built bundle is a gate
item), rule 11 (never weaken a test), rule 12 (no module-scope reads of other modules), rule 17 (resumable scripts),
rule 18 (one owner per file, extended to shared registries), rule 19 (`runToIdle` means converged; every failure mode
still lets it return), rule 20 (gradeable state lives in tables or configuration).

**Restated with P3c names:**

2. **TRANSITION RULE.** Every new contract member is tagged `@since P3c`. A member that is optional only until it is
   implemented carries the `?` and the item that implements it removes the `?` and migrates the fixtures in the same
   change; the exit gate removes any `?` left. A member that is **optional by meaning** is tagged `@since P3c
   (optional by meaning)`, is listed in §2.13, and keeps its `?` for ever: absent means P1, P2 and P3a bytes.
   `contracts.optional-by-meaning.test.ts` gains the P3c rows. P3a's W8 gate removed every transition `?`, so a new
   **required** member of a widely faked interface (`ProcessCtx`, `DeviceRuntime`, `CliRuntime`, `EngineApi`) updates
   every typed fake in the same change; W0 adds a `P3C_CTX` / `P3C_DEVICE` spread to `test/port.fixtures.ts` for the
   members §2 names.
4. **Every change keeps the six checks green** (ARCHITECTURE-P3 rule 4, with check 3b). Rule 25 below says which
   vitest project each actor runs. No `npm install` and no new dependency without explicit approval; none is planned.
5. **Silence rule, proved by three goldens.** A daemon sends nothing unless configured. Every P0–P3a scenario,
   template, lab and saved file keeps byte-identical traffic and trace, except the changes §9.5 lists for P3-profile
   worlds (none for P1 or P2 worlds). The proof is `p1-profile-digests.json`, `p2-profile-digests.json` and the new
   **`p3-profile-digests.json`, recorded in W0 from the unchanged engine at cad4ac9** (D3), with its synthetic guard
   worlds. Only the architect re-records, and only the entries §9.5 lists, at the wave §9.5 names.
9. **Own tests only; one full suite per wave.** As P3a rule 9. **Byte-risky items** (⚑ in §7; every item that §9.5
   names is ⚑) also run, as their own files with the fixed worker count, `accept.p2.p1-digests`, the four
   `accept.p3.p2-digests-*` shards **and the five `accept.p3c.p3-digests-*` shards**. A builder never re-records.
   **Re-record protocol:** a ⚑ item whose shard fails reports the exact moved entries (shard, world id, window or
   assertion) in its result; the reviewer checks each against §9.5 (an entry §9.5 does not name for that wave is a
   defect); the architect re-records exactly the listed entries in the wave's fix run (`NF_RECORD_P3_DIGESTS=<world
   id>`), and the lead commits the re-record as its own step of the fix run. Nobody re-records wholesale.
13. **Real worlds before the flip.** W0 gives `test/staged.world.ts` a `stage: 'P3c'` path again, holding as test-only
    data the final P3c `PROCESS_ORDER` restricted to approved names, the P3c `CAPABILITY_PROCESSES` rows and the P3c
    `STAGED_PROCESS_TABLES` rows (§2.1). The W4b flip adds `staged.world.p3c-parity.test.ts`; the exit gate reduces the
    helper to a wrapper again.
14. **One catalog flip, alone, after its wave's acceptance tests** (D6). Inside it the lead runs, against the real
    catalog: `accept.p2.p1-digests`; the four `accept.p3.p2-digests-*` shards; `accept.p3.p2-exports`;
    `accept.p3.lab-status`; the five `accept.p3c.p3-digests-*` shards; `accept.p3c.p3-exports`;
    `accept.p3c.lab-status-p3`; `accept.p3.lab-document`; `accept.p05.determinism`; `accept.p3.determinism`;
    `accept.p3.replay-exact-ccna3`; `accept.p3.labs` with `lab-versions`; `accept.p3c.hot-path`; `accept.p1.silence`,
    `accept.p2.silence`, `accept.p3.silence` and the new `accept.p3c.silence`; `staged.world.p3c-parity`;
    `protocols.registry` and `device.catalog.p3` (both migrate inside the flip, §9.2); the help goldens
    `cli.grammar.help-goldens` (with the sanctioned additions-only regeneration of `cli-help.p05.json`, §9.4) and
    `cli.help-superset`; and every W4a qa file. Nothing else merges until they pass. A second flip is allowed only for
    a new model.
15. **Implementers never run whole suites.** As P3a rule 15, with rule 25's tiers.
16. **Agents run no git command that changes state** — no `add`, `commit`, `stash`, `checkout`, `switch`, `reset`,
    `restore`, `rebase`, `merge`, `branch`, `tag`, `push`, `update-ref`, `fetch`, `config` — and no tool that shells out
    to git (`vitest --changed`, rule 26). The lead alone commits, snapshots and pushes (P2 §14 push incident).
    **Changed from P3a** (whose rule 16 said agents run no git command at all): agents may run read-only git (`status`,
    `log`, `diff`, `show`, `ls-files`, `ls-remote`, `branch -vv`). Reason: reviewers and verifiers cite line numbers at
    cad4ac9 and check what a builder changed, which needs `git show cad4ac9:<path>` and `git diff`; none of these writes
    the repository or a remote.
21. **No deploy before the exit gate.** Wave commits go to branch `p3c` only. `master` stays at cad4ac9 (the live P3a
    site) until the P3c exit gate passes and the product owner approves the merge.
    - **Before W0** the lead checks the tracking set-up: `git branch -vv` on 2026-10-14 shows `master` tracking
      `origin/master` and `p3` tracking `origin/p3` (both at cad4ac9) and `p3c` with no upstream. If `master` ever tracks
      another branch, the lead (never an agent) corrects it to `origin/master` before any push.
    - The **first push** of the branch is `git push -u origin p3c`; every later push names `origin p3c` explicitly.
    - **After every workflow run** the lead runs `git ls-remote origin refs/heads/master refs/heads/p3` and checks
      that both equal cad4ac9 (a live check, not the cached `origin/master`), and that no other branch moved.
    - A pre-push hook refusing `master` would be persistent configuration; it is not installed unless the product owner
      approves it.

**New rules:**

22. **Small waves, separate runs.** A workflow run holds **at most 6 builders**. Build, review, adversarial verify, fix
    and integrate are **separate runs**, not stages of one long run, and each run is sized to finish in about 90
    minutes of wall time. A content wave that needs more builders is split into runs a/b/c (§7 does this). P3a ran
    waves of 11–13 builders, and session ends stopped six of its workflows (ARCHITECTURE-P3 §14). **An item may
    continue across checkpointed runs:** a builder whose item is not done at about 80 minutes stops at a green
    checkpoint (its own tests passing, rule 23's snapshot taken), reports what remains, and the next run of the same
    wave resumes the same item with the same owner; no other builder touches its files meanwhile. Items known to exceed
    one run are split up front (§7: the [S6] refactor into W1a and W1c parts, [S33] into agent and manager items, the
    W5 labs into one lab per builder). Process overhead (review, verify, fix and integrate runs, about five runs per
    wave, each followed by the six checks) is not in the item figures; the review contingency of §8.4 covers it, and
    rule 27 records it.
23. **Checkpoint after every run.** The lead snapshots the tree to `refs/wip/p3c-<wave>-<run>-<step>` after **every**
    run, not only after a kill. Generator scripts always emit a resume variant that carries finished results in as
    data; scripts are passed inline (cross-session `resumeFromRunId` failed in P3a: "journal not on disk"). A resumed
    run never re-runs a finished item.
24. **Power and load preflight.** The lead starts a slow-project, gate-project or full-check run only on AC power:
    a preflight (`scripts/preflight-ac.ps1`) prints `(Get-CimInstance Win32_Battery).BatteryStatus` for every battery
    and starts only when **every** battery reports 2, 3, 6, 7, 8 or 9 (unknown/AC, fully charged, charging,
    charging-high, charging-low, charging-critical), or when the query returns **no battery** (a desktop is on AC);
    any other value (1 discharging, 4 low, 5 critical, 10 undefined, 11 partially charged) refuses.
    No other project's vitest runs at the same time. The wave report records the wall time of every full check (P3a:
    one check stalled at 10 % battery; the loop storm took 386 s on battery and 375 s beside another vitest).
25. **Four test tiers.**
    - `fast` (engine): every file not listed below. Implementers run only their own files in it.
    - `slow` (engine): the digest shards, the replay shards, `accept.p3.silence`, `accept.p3c.silence`. The lead runs it
      once per wave.
    - `gate` (engine, new): exactly the files of the explicit list `GATE_TESTS` — `accept.p2.loop-storm-bounded`,
      `accept.p3.ospf-scale`, `accept.p3c.ospf-scale-multiarea`. Membership never depends on wall time: a test seen
      above 60 s of wall time in a wave report is a **review trigger** for the architect to add it to `GATE_TESTS` in a
      named change. The lead runs `gate` at gates and inside the flip only.
    - the web suite, unchanged.

    `packages/engine/vitest.workspace.ts` gains a third list (`GATE_TESTS`) beside `SLOW_TESTS`; rule 15's fixed worker
    count stays.
26. **A faster inner loop.** Implementers run `npx vitest related <their src files> --root packages/engine --project
    fast` (it follows the static import graph and calls no git). `vitest --changed` is forbidden (it shells out to
    git, rule 16). A byte-risky item runs its digest shards with `-t '<world>'` per world where the harness supports
    it, then whole before it reports done.
27. **Effort actuals.** The wave report records start and end dates, wall time and builder count per run and per wave.
    §14 turns them into a calibration note (neither P2 nor P3a recorded actuals; P3a's 123.2 ew plan ran 2026-09-30 to
    2026-10-14).
28. **P3c acceptance files are `accept.p3c.<name>.test.ts`.** A file named `accept.p3.*` for an item P3a did not
    approve fails `accept.p3.coverage` and `p3-approved-items.test.ts` (map 01 §0.2), which stay green and unchanged.
    The P3c approved list is `P3C_APPROVED_ITEMS` in `test/p3c-approved-items.ts`, proved equal by
    `p3c-approved-items.test.ts` to the **Approved ids** row of §8.5c (the bold array, read with the regex
    `\b(?:[SC]\d+[ab]?|R63d)\b`; P3a's `\b[SC]\d+\b` cannot read `S17a`, `S36a` or `R63d`). `accept.p3c.coverage`
    arrives in W0 and reads §10.1 of **this** brief, whose every row carries an **Arrives** wave: a row whose wave has
    not been reached yet is **pending**, and the check asserts only that its file either does not exist yet or, if it
    exists, is named by that row (the file itself must then pass, like any test), so the six checks stay green from W0
    (rule 4); from its wave on the row's file must
    exist; the exit gate (W7) requires every approved row present. The current wave is the constant
    `P3C_CURRENT_WAVE` in `test/p3c-approved-items.ts`, which the lead advances in each wave's integrate run. Approving
    an item later means, in one change: the §8.5c row, the list, the §10.1 row and the file.

---

## 1. Fixed decisions D1–D14 and the chosen designs

Each decision names the design chosen and the alternative rejected, with the reason. Items in brackets are the
SHOULD/COULD ids of the P3a brief, kept so that every P3a cross-reference still resolves.

**D1 — A build stage `'P3c'`; no new defaults profile.**
- `BuildStage` gains `'P3c'` after `'P3'` (`BUILD_STAGES = ['P0','P0.5','P1','P2','P3','P3c']`). Every P3c capability
  row, staged table, GUI panel and stage constant is `since: 'P3c'`.
- **Why the stage is needed (corrected by review).** The new names do **not** need it: `normaliseSnapshot`
  (`p2-digests.harness.ts:602-627`) already drops any process absent from the golden's recorded `PROCESS_ORDER` and
  any table absent from its recorded `TABLE_DESCRIPTORS`, so `ospfv3`, `tftp`, `snmp-agent`, `snmp-manager` and the
  `storm-control` table would be normalised away with or without a stage. The stage is needed only where P3c
  **reuses an existing name** and where a constant is stage-gated: (1) NF-IPPHONE's `cdp` and `lldp`, derived through
  the new `voice-endpoint` capability — names already in the recorded vocabulary, so only a `since: 'P3c'` row lets the
  P3 harness drop them from a P3 world's snapshot (the phone answers only after the flip); (2) `GUI_PANEL_SINCE` and
  the stage constants (`CATALOG_STAGE`, `END_DEVICE_STAGE`, …) that gate P3c data in `staged.world` before the flip.
  That need is enough to keep the stage (architect ruling, §8.5b X-15); its cost is the `BUILD_STAGES` pins and the
  `Record<BuildStage, …>` stubs, moved once in W0.
- `DefaultsProfile` stays `'P1' | 'P2' | 'P3'` and `LATEST_DEFAULTS_PROFILE` stays `'P3'`. A world's defaults do not
  change in P3c. An approved item that would change what an existing P3 world does takes, in this order of preference:
  (c) config-only (silent until a line is typed); (b) a listed P3-golden change in §9.5; (a) a new profile, which no
  recommended item needs (each costs about 1.5–2 ew: the M1 pattern, the web chip, the defaults ladder).
- **Rejected:** no new stage (maps 01 and 04: "a catalog flip with no learner benefit"; `BUILD_STAGES` pins move).
  The pins move once; without the stage the phone's reused `cdp`/`lldp` rows would move the P3 golden at the flip.
- **Rejected:** a `'P3c'` or early `'P4'` defaults profile. The only candidates (S35 phones learning the voice VLAN,
  S41 logs, S17's drop behaviour, S30 `show version` lines, C20) are each handled per item below (D9, D10, §9.5).

**D2 — Schema `netforge.topology/1.4`, written only when a 1.4 member is present.**
- 1.4 = 1.3 plus `TopologyFile.fs?: 'flash'` (absent = the host's `files:` store), `TopologyFile.nominalBytes?` [S30]
  and `TopologyDevice.nvram?: { configRegister?: number }` [S31] (and `'usbflash0'` if [C29] is ever approved).
- `schemaIdFor(t)` returns 1.4 only when one of those members is present; otherwise exactly what it returns at cad4ac9.
  Every P1 (1.1), P2 (1.2) and P3a (1.3) document exports byte-identically; `p1-template-exports.json`,
  `p2-lab-exports.json` and the new `p3-lab-exports.json` do not move. 1.3 → 1.4 is the identity migration.
  `io/lab-schema.ts` (`netforge.lab/1`, which embeds `Topology`) loads 1.4 topologies.
- **Rejected:** router files inside 1.3 by widening `TopologyDevice.files`. The live 1.3 reader strips unknown keys, so a
  P3a build would silently drop `fs` and write router flash files into nothing; 1.4 is refused by id instead
  (`TOPOLOGY_SCHEMA_IDS`), which is honest. (Map 05 offered 1.3 reuse "if the reader is widened"; the live site is
  replaced at release, but saved files outlive builds.)

**D3 — The P3 golden record is taken first, in W0, from cad4ac9 unchanged. Hard prerequisite.**
- Before any P3c source change, the architect records from commit cad4ac9 (D3 pattern of P3a):
  1. `test/goldens/p3-profile-digests.json` through a generalised harness `test/profile-digests.harness.ts`
     (parametrised by profile and a recorded vocabulary; `p2-digests.harness.ts` becomes a wrapper with byte-identical
     output, proven by the P2 shards). Worlds: the 21 CCNA 3 labs loaded as the worker's `loadScenario` loads them, with
     the fixed script (60 s boot, the solution, the probes, 600 s); a P3 sandbox built through `addDevice`/`addLink` in
     `createSimulation({profile: 'P3'})` (pins the `profileConfig` path: CDP, `service timestamps`, extended logging);
     the 9 templates loaded as P3 worlds; and **two synthetic guard worlds** that put P3c's silent daemons at risk
     (§10.1 `-guards`). Shards: `accept.p3c.p3-digests-templates`, `-labs-a` (7 labs), `-labs-b` (7), `-labs-c` (7),
     `-guards` (the sandbox and the two guard worlds). **Shards are keyed by lab id, not by position:** the golden
     records, per shard, the frozen list of its world ids (the 21 lab names of `CCNA3_LAB_ORDER` at cad4ac9, split
     7/7/7 in that order), and each shard reads its list from the golden, never from the live `CCNA3_LAB_ORDER`. New
     labs inserted in lesson order at W5 therefore never move a world between shards, and no P3c lab joins the P3
     golden. The workspace glob `accept.*-digests*` already sends them to `slow`.
  2. `test/goldens/lab-status.p3.json`: the 21 CCNA 3 labs, unsolved at 60 s and solved at 710 s, every assertion
     detail (`accept.p3c.lab-status-p3`).
  3. `test/goldens/p3-lab-exports.json`: the export bytes of the 21 CCNA 3 labs, schema 1.3
     (`accept.p3c.p3-exports`).
  4. `test/goldens/p3c-storm-window.json`: the loop-storm world's 100 ms window (event counts per kind and the trace
     digest), the byte proof for [S40] (`accept.p3c.hot-path`).
- The recording change contains nothing else and is committed by the lead. Each golden's header names the **source**
  commit, cad4ac9 (as P3a's header names "at commit 5263f16", `p2-digests.harness.ts:404-408`); a file cannot hold the
  hash of the commit that adds it, so the W0 wave report names the recording commit. Every P3a guard stays unchanged
  (P1 and P2 goldens, `lab-status.p2`, `lab-versions`, `cli-help.p1`; `cli-help.p05` moves only as §9.4 lists).
- **Guard world 1 at W1b** (decided in W0, before recording): its UDP 69/161 probes decode as `payload` at cad4ac9 and
  as `tftp`/`snmp` once W1b un-reserves the ports, so its `PduSummary.proto`, `.layers` and `.summary` (inside every
  frame event) change at W1b. The architect re-records that world's entries in the W1b fix run (§9.5, decode-only
  change); its **pass condition** (dormant switch: protocol unreachable; router: port unreachable; no `sockets` row) is
  asserted separately in `-guards` from the live world and is never re-recorded.
- **Rejected:** recording after the first content wave (the P3a determinism and replay tests prove run-to-run equality,
  not equality with what is live; the live site and saved P3 files are now what P2 worlds were at P3a W0).

**D4 — Acceptance naming and the approved list** (rule 28). Every P3c acceptance file is `accept.p3c.*.test.ts`,
including the files the P3a brief named `accept.p3.ospf-multiarea`, `-ospf-auth`, `-ospfv3`, `-acl-ipv6`,
`-storm-control`, `-tftp`, `-password-recovery`, `-snmp`, `-span`, `-gre-recursion`, `-fragmentation`. P3a's
`accept.p3.coverage`, `P3_APPROVED_ITEMS` and their tests are not touched. **Rejected:** widening the P3a list (maps 02,
03, 04): it rewrites a P3a exit-gate record and breaks `p3-approved-items.test.ts`'s equality with P3a §8.5.

**D5 — The course release is in place** (map 05 §1.2).
- CCNA 3 stays one course (`status: 'available'`, `profile: 'P3'`) with its 14 modules, 40 frozen lesson ids and 81
  objectives. New labs are **inserted** into `CCNA3_LAB_ORDER` in lesson order (21 → 26 in the recommended plan): labs
  08 and 09 after lab 07 (`ccna3-troubleshoot-ospf`), 30 and 31 after lab 29 (`ccna3-time-and-logs`), 39 between 38
  (`ccna3-restconf-change`) and 40 (`ccna3-script-inventory`). Positions of
  later labs shift; the order pins that move are listed in §9.2 W5b (the P3 golden shards are keyed by lab id, D3).
- **One lab per lesson** (`Lesson.lab?: string`, `contracts/curriculum.ts:38`). Lessons 06, 07, 17 and 20 already hold
  a lab, so their P3c hands-on parts are **tasks added to those labs**, each with a `lab-versions.json` bump and a
  re-record (`NF_RECORD_LAB_VERSIONS=<lab>`). **Rejected:** `Lesson.labs?: string[]` (a web change to the lesson page,
  the "Open the lab" button and the labs browser, for little gain).
- A concept tool cannot be graded, so an objective met by a tool becomes `'theory'` (the CCNA3.acl.4 precedent).
- **No `'later:P3c'` survives the exit gate.** Each of the 18 rows becomes `'lab'`, `'theory'`, or is re-staged with
  an existing value (`'untaught:P4'`, `'untaught:P5'`) or, if the product owner wants one, a new value added to
  `ObjectiveHandsOn` (decision X-4). `'later:P3c'` itself stays in the union for the life of P3c and is removed at the
  exit gate together with its test row.
- **Videos (X-5, the product owner's answer to Q11: add videos).** Each lesson that gains a lab in P3c (08, 09, 30, 31,
  39) gets a second verified video on its hands-on part, held in a new member `Lesson.labVideo?: LessonVideo`
  (`@since P3c (optional by meaning)`: absent when no candidate passes the rule). The verification rule is unchanged from
  P3a: oEmbed 200, `playableInEmbed`, no sponsor segment, no vendor in the title or channel. The lesson minutes
  include it. `curriculum.ccna3.videos.test.ts` checks it, and it is a W6 course item priced at 0.6 ew.

**D6 — One catalog flip, W4b, alone** (rule 14). It inserts the P3c daemon names into `PROCESS_ORDER` at their final
positions (§2.1), adds the P3c `CAPABILITY_PROCESSES` rows and the `storm-control` staged table, sets the stage
constants (`CATALOG_STAGE`, `END_DEVICE_STAGE`, `DATACENTRE_DATA_STAGE`, home `DATA_STAGE`) to `'P3c'`, adds
NF-IPPHONE's `cdp`/`lldp` [S35] and the routers' and switches' `storage` data [S29]/[S30]. **P3c rows derive only on
models with a CLI shell**, defined exactly as `model.cli.shell !== 'none'` (the derivation shells are `nfos`, `host`
and `none`, `device/catalog/define.ts:438-446`): NF-OS routers and switches and the `host`-shell servers, PCs, NF-DEVHOST
and NF-IPPHONE derive them; home routers (`nat-gateway`) and WLCs (`none`) do not (audit gap 8: home routers derive
P3a's routing daemons with no CLI; P3c does not add to that). The P3a rows are unchanged.

**D7 — Routing.**
- [S4] An ABR is a router with an **active area-0 interface** and at least one other area (the Cisco rule, RFC 3509
  alternative); a router with two non-backbone areas and no area 0 originates no summaries, and the lesson says so.
  No virtual links, no `area range`, no stub areas (P5).
  **This changes the B-flag rule, stated here explicitly:** today `ospf.ts:1250` sets `areaBorder: areas.length > 1`
  over every configured OSPF interface (`areasOf`, `ospf.ts:1234-1238`), up or not. From W2b [S4] the router-LSA's B
  bit is set by the D7 rule (an **up** area-0 interface and one more area), computed in `protocols/ospf/originate.ts`
  (`desiredSelf`). The router-LSA bytes change in any P3 world with a two-area router whose area-0 interface is down,
  or with two non-backbone areas and no area 0. The S4 item scans every P3 golden world for a router whose B bit flips
  and lists it in its report (lab 07's R2 keeps B: its Gi0/1 in area 0 is up; no other golden world is expected to
  move, §9.5).
- [S5] **Real keyed MD5** (RFC 2328 D.4.3) over `core/md5.ts`, which S19 built; "simulated MD5" leaves the fidelity
  table. Authentication is checked on **every** OSPF packet type, not just hellos. `OspfInterfaceRow.auth?` is optional
  by meaning (absent = none), so every existing `ospf-interfaces` row keeps its bytes. SHA key chains stay P5.
- [S6] OSPFv3 is a separate daemon `ospfv3` and a **separate codec `ospf6`** (D7 of P3a said "one codec with version
  3"; rejected because v3 fields would enter the `ospf` field table, the display filters and the fields test). Both
  daemons run on one adjacency engine: a **W1a zero-diff refactor** extracts `protocols/ospf/engine.ts` (adjacency,
  flooding, LSDB, throttles, timers) parameterised by an `OspfFamily` adapter; `ospf` = engine + `family-v4.ts`,
  `ospfv3` = engine + `family-v6.ts`. **Rejected:** copy-adapting the 1988-line v2 closure (≈ 1500 duplicated lines,
  two daemons to maintain). OSPFv3 has no authentication (IPsec AH/ESP: P4), no address-family mode, no
  `default-information originate` for v6.
- [C7] `ip mtu <68-1500>` widens to routed Ethernet ports, subinterfaces and serial ports, and is read by OSPF's DBD
  and `show ip interface` only; `ip ospf mtu-ignore` is included. The IPv4 data plane enforces the physical MTU only
  through [S17a] (D8), never through `ip mtu` alone. **The DBD MTU check is real IOS behaviour and is always on**
  (RFC 2328 §10.6), so it is a **P3 behaviour change** (§4.4, product-owner question 4): a saved P3 world in which a
  jumbo-MTU data-centre switch (NF-N9K class, `mtu: JUMBO_MTU` on every port, `device/catalog/datacentre.ts:31,36,49`)
  peers OSPF with a 1500-byte router is Full at cad4ac9 and sticks in ExStart after P3c, as on real devices. No golden
  world holds such a pair. Tunnels keep advertising their port MTU (1500) in the DBD, not the gre-computed IP MTU 1476
  (a listed fidelity gap; it keeps every GRE-and-OSPF world's bytes).
- [S8] The `convergence` kind is written in full in §2.10 (P2's S15 block was never built). Its quiet period is 12 s for
  the `routing` protocol (longer than the 10 s SPF hold, so a second SPF after a restore is not cut off) and 5 s for the
  others.

**D8 — ACLs, the access layer and IPv4 fidelity.**
- [S11] IPv6 tuples are a **discriminated** `PacketTuple6` beside the existing `PacketTuple` (`AnyPacketTuple`).
  **Rejected:** widening `PacketTuple.family` in place, which breaks the v4-typed consumers in vty and the lab checks.
  `ipv6 access-class` is enforced on real IPv6 vty sessions: a hidden family-6 listener opens only when a `line vty`
  section exists **and** the device has an IPv6 global address **and** its transport is awake (D22), so no P3a world
  gains a listener. New CLI specs carry `requiresAnyProcess: ['acl']` where a scope exists. **This does not keep them
  out of `cli-help.p05.json`** (corrected by review): that golden is generated over `ALL_MODELS` on the real catalog,
  where routers and managed switches already derive the P3-stage `acl` daemon (`contracts/catalog.ts:801`, `:831`),
  so the words appear there at W3a2; §9.4 lists them as additions. `cli-help.p1.json` never moves.
- [S15] IP source guard is eth-switch step **7d** (after port security 7 and snooping/DAI 7b/7c), IPv4 only, exempting
  DHCP client messages and ARP, and requiring snooping on the VLAN. The `port-security` option is refused without
  `switchport port-security`.
- [S16] Storm control is an **ingress** check in the per-frame path, one Map lookup when no port has the line, with
  sim-second windows evaluated lazily on arrival (no timer), levels in integer hundredths of a percent of the
  **operational** speed, rising/falling hysteresis, and a row written **once when the line is stored or the port comes
  up** (state `forwarding`, `current` 0, `windowStart` = now), then on a state change or once per window that had
  drops, never per frame (rule 20). Because windows are lazy, `current`, `dropped` and `state` can stay stale after
  traffic stops (no frame closes the window); lab text and graders never read them as live values.
- [S17] **Split.** [S17a] "honest MTU" is in the recommended plan: `ping … size <36-18024> df-bit` (capped, see §4.1),
  the host `ping -l <size> -f`, physical `ip mtu`, the egress check at `arp.sendVia` (DF set → drop `mtu-exceeded` plus
  ICMP 3/4 with the next-hop MTU; DF clear → drop `mtu-exceeded` "fragmentation is not simulated", the same fallback
  tunnels use since S18), and the ACL non-initial-fragment rule with the `fragments` keyword. [S17b] (real
  fragmentation and reassembly, tunnel pre-fragmentation, NAT virtual reassembly) is a SHOULD outside the recommended
  plan; its design is Appendix A.
- [CCNA3.acl.6] is flipped to `'lab'` by **retracing** it to labs 15 and 16, whose tasks already grade the binding's
  interface and direction (map 02 Q15). [S23] stays a SHOULD (the advisor UI), with no objective of its own.

**D9 — WAN and discovery.**
- [S35] The phone's CDP/LLDP is **answer-driven**: NF-IPPHONE runs `cdp` and `lldp` on its uplink only, and sends
  nothing until it has heard CDP or LLDP there, so no new §4.3 default exists and P1/P2 phones stay silent. The phone
  **stops bridging** switch CDP/LLDP to its PC port (real behaviour). A typed `voice vlan <v>` on the phone wins over a
  learned one (keeps P2). A learned voice VLAN restarts the phone's DHCP in that VLAN. LLDP-MED Network Policy is in
  scope (W-2 may cut it to CDP only, −0.4 ew).
- [S36] **Split.** [S36a] the recursive-routing hold (a periodic 10 s `recursion-hold:<port>` timer, fixed) is in the
  recommended MUST; [S36b] IPv6 over GRE is a SHOULD, static routes are enough to teach it, and the IPsec VTI stays
  IPv4-only (a listed deviation).
- [S41] Native-VLAN mismatch is checked on operational trunks only (no change to CDP bytes in any world); duplex on
  every CDP port; each at most once per port per 60 s, checked on receipt (no timer).
- [C20] is not built (it contradicts lab 27's FIFO step and fails D2 (b)); CATALOG deviation 14 stays. [C14] goes to
  P5, [C15] to P4.

**D10 — Management and automation.**
- [S29] The device store becomes keyed by `(fs, path)`. Routers and switches get `flash:` and `nvram:` from
  `DeviceModel.storage`; `nvram:` holds only a virtual `startup-config`; **the model image is virtual** (rendered by
  `dir`, never stored, never in a snapshot or an export), so `DeviceSnapshot.storage` stays absent unless a user file
  exists and no P1/P2 router snapshot moves. NF-SERVER's existing `files:` store is the TFTP root. A copy job on a
  switch wakes its transport through the shipped `ext.ipv4.transportHold` (D22) for its lifetime. Grading reads a fact
  `storage.file`, not a typed `file` kind (D5 of P3a: no typed kind without need). `copy tftp: running-config`
  **merges**, as on real devices and as the lesson says. A `copy tftp: flash:` learns the file's size before any DATA
  through the **RFC 2349 `tsize` option** (the client's RRQ asks `tsize 0`, the server's OACK answers the size), so the
  flash-full check runs before the first block (§3.4).
- [S30] The image transfers as `ceil(nominalBytes / IMAGE_TRANSFER_SCALE)` bytes: a fixed 16-byte **image header**
  (`NFIMG1` and the nominal size as 10 decimal digits) followed by a fixed filler. The receiver of a file whose content
  starts with a valid header stores `nominalBytes` from it in the runtime file metadata (`StoredFileMeta.nominalBytes`,
  §2.9), which `dir`, the capacity check and the 1.4 export read; any other file has no `nominalBytes`. `show version`
  gains its image and register lines **only in P3-profile worlds** (P1/P2 `show version` is byte-identical; "existing
  messages never change", P3a §8.5 P4); the lines need `DeviceModel.storage` data, which arrives at the W4b flip, so
  they first appear in a real P3 world inside the flip (§9.5). A reload into a newer version changes only `show
  version` (a fidelity row).
- [S31] `cliBreak` is the area's one new journal op. Break works only on console sessions, only inside the boot window
  (`DeviceModel.bootNs`), and only on routers (switches use a mode button, not modelled; M-11). `config-register
  0x<hex>` is an **immediate global command** that writes the persistent register (`TopologyDevice.nvram`), as on IOS
  where it is not kept in the running configuration: it is not a `ConfigAst` line, so `show running-config` and the
  export each have one source.
- [S33] SNMP v2c only: `version 1` is refused with a message. The agent's `sysObjectID` uses the documentation
  enterprise number 32473 (RFC 5612), never a vendor arc. SET writes through the configure seam with `origin
  {via: 'snmp'}`. The manager runs on `server` and `programmable` hosts and is not scriptable from NF-Py.
- [S28] The YANG browser is web-only over the existing `automation/yang/model.ts`; `CCNA3.automation.4` becomes
  `'theory'`.

**D11 — Engineering health.**
- [S40] Hot-path profiling is **byte-neutral by construction** (event order, content and rng draws unchanged), ⚑, and
  runs **alone in the hot path** in W0h so that every later wave inherits the faster suite. It ships a benchmark script
  (`packages/engine/bench/loop-storm.ts`, excluded from every vitest project) and a recorded storm-window digest.
- **The bundle split** runs in W0h, so new labs and tools land on it: main-thread value imports go through
  `@netforge/engine/pure` (or narrow subpath entries), a lint test forbids non-type imports of `'@netforge/engine'`
  outside `src/bridge/worker/**`, curriculum and lab text load lazily, and a vendor split is added. Target: main chunk
  from 4.09 MB to ≈ 1.2–1.6 MB.
- [C32] (a) **delete** `DemuxSelector.frame` and capwap-wtp's use of it in **one change in W0h** (the contract member
  and `capwap-wtp.ts:896` together; W0 keeps the member, since deleting it alone breaks capwap-wtp at compile time as
  an excess property; behaviour unchanged, no byte risk: no matcher reads it, `device/pipeline.ts:494-495`);
  (b) `TraceFilter.vlans?`; (c) remove `TimelineStrip`'s dead guards and `TIMELINE_UNAVAILABLE_TEXT` (a named migration,
  §9).
- [S39] `runToQuiet`, the safer variant: every world that idles today stays on exactly today's path (try `runToIdle`
  up to a smaller cap, then the quiet rule), with `QUIET_WINDOW_MS = 60_000` simulated. `accept.p3.grader-bounded`
  then drops the EtherChannel exception.
- **R63 (d)** is fixed in the engine for P3 worlds only (a debug or log line that starts mid-line gets a leading
  newline); P1/P2 bytes keep the known case.
- [D-C7] The loop-storm case keeps `runFor(1 s)` (R61 (c)) and moves to the `gate` project (rule 25).

**D12 — Help goldens.** `test/goldens/cli-help.p1.json` is a **frozen floor and never moves**
(`cli.help-superset.test.ts:1-11`). `cli-help.p05.json` is generated over `ALL_MODELS` on the real catalog and already
holds P3 words (`ntp`, `crypto`, `restconf`, `policy-map`, the EIGRP and crypto modes), so a spec scoped with
`requiresAnyProcess` to a P3 process appears in it as soon as its grammar lands, and one scoped to a P3c process as soon
as the W4b flip derives that process. It is therefore **regenerated with additions only at exactly two waves** — W3a2
(the W3a grammar and the four new mode listings, through a `P3C_APPROVED_MODES` list in
`cli.grammar.help-goldens.test.ts`, the `P3_APPROVED_MODES` precedent) and the W4b flip (the words scoped to `ospfv3`,
`tftp`, `snmp-agent`, `snmp-manager`) — each regeneration a sanctioned step of that wave's integrate run, checked by
the superset guard (`cli.help-superset`: p05 ⊇ p1, frozen order kept, `ALLOWED_REMOVALS` stays empty). §9.4 lists the
additions per model family. Sub-word listings (`ping <target> ?`, `errdisable recovery cause ?`, host `ping ?` flags)
are not captured by the golden and do not move it.

**D13 — Lost designs are rewritten here, not reconstructed by implementers.** §3 rewrites the multi-area and OSPFv3
walk-throughs, the TFTP and SNMP field tables, `SnmpTrapRow`, the MIB list, the TFTP timers, the IPv6 ACL contract
blocks and the storm-control row; §10.1 rewrites the acceptance rows the P3a brief left as "the map's row, unchanged".

**D14 — Release cadence.** One release at the exit gate (rule 21). W0h's learner-visible gains (bundle size, speed)
ship with it; an early W0h release needs its own mini-gate and the product owner's approval (X-11).

### 1.1 Where the area maps disagreed, and what was chosen

| Topic | Maps | Chosen | Why |
|---|---|---|---|
| A `'P3c'` build stage | 01, 04: no; 05: yes | yes (D1) | The phone's reused `cdp`/`lldp` rows and the stage-gated constants need it (new names are normalised away without it); the `BUILD_STAGES` pins move once |
| Acceptance file names | 01: `accept.p3c.*`; 02, 03, 04: `accept.p3.*` | `accept.p3c.*` (D4, rule 28) | `accept.p3.*` files of unapproved P3a items fail two live guards |
| Router files in 1.3 or 1.4 | 04: 1.4; 05: either, if the reader widens | 1.4 (D2) | A 1.3 reader strips unknown keys silently |
| `PROCESS_ORDER` position of `ospfv3` | 01: "append last"; P3a §2.1: after `ospf` | after `ospf`, before `eigrp` | Insertion keeps every existing list an order-preserving subsequence; P3a §2.1 recorded the final position |
| CCNA3.acl.6 | 05: `'theory'` with S23; 02: `'lab'` by retrace | `'lab'` by retrace (D8) | Labs 15 and 16 already grade placement; no code |
| S17 | 02: S17a MUST, S17b SHOULD | as map 02 | The teaching point (DF, ICMP 3/4, the ACL rule) at a quarter of the cost |
| S36 | 03: S36a MUST, S36b SHOULD | as map 03 | The hold is designed and has an acceptance row |
| S38, R63 (d) | 05: "if approved" | SHOULD, in the recommended plan | S38 grades lab 30's SPAN and clear-text community tasks; R63 (d) is learner-visible in P3 worlds |
| C26 | no map priced it | SHOULD, in the recommended plan, 1.1 ew (architect's estimate) | The only route for CCNA3.automation.8 other than re-staging it |
| Home-router derivation | 05: decide at the flip | P3c rows only on CLI models (D6) | No cost, keeps snapshot tables from growing |

---

## 2. Contract changes

Every member below is tagged `@since P3c` in the source (rule 2). Members marked **OBM** are optional by meaning, keep
their `?` for ever and are listed in §2.14. The blocks here are those of the **recommended plan** (§8.4): MUST plus the
recommended SHOULD and COULD items. Each block is tagged with its item. Wave 0 adds the blocks of exactly the items listed
in the approved ids of §8.5c (rule 3: types, unions and constants only, plus the compile stubs they force); a block
whose item is not approved is never added. The blocks of items outside the recommended plan are in Appendix A. Unions
append at the end, so existing orders (and the snapshot key order that depends on them) never change.

**Compile stubs a W0 addition forces** (P3a rule 3's list, unchanged in kind): a new `ProtoName` breaks
`PROTOCOL_VOCAB`; a new `FsmMachine` breaks `FSM_VOCAB`, `FSM_MACHINE_LANES` and `timeline.lanes.test.ts`'s typed
record; a new `ExtraTableName` breaks `TABLE_DESCRIPTORS` and `timeline.lanes.test.ts` (`TABLE_LANES` is a
`Partial<Record<…>>`, `lanes.ts:104`, so it is not forced; W0 adds its rows as data anyway); a new `DropReason` breaks
`DROP_VOCAB`, `io/lab-schema.ts`'s reason list, `Provenance.DROP_LABEL` and `markers.ts`; a new `ConceptToolId` breaks
`CONCEPT_TOOL_VIEWS` and the markdown allowlist; a new `GuiPanelId` breaks `PANEL_TAB`, `SURFACE_PANEL_TAB` and
`GUI_PANEL_SINCE`; a new `ErrDisableCause` breaks `ERR_DISABLE_CAUSE_TEXT`; a new `CliMode` breaks `MODES`
(`MODE_PROMPT`, `contracts/cli.ts:554`, is a `Record<string, string>` and is not forced; W0 adds the four prompts as
data); a new `BuildStage` breaks every `Record<BuildStage, …>`; a new `Capability` breaks `CAPABILITY_PROCESSES` and
the capability vocabulary; a new `LabAssertion` kind breaks the checker registry (a "not available in this build" stub
until its item lands); a new `LabFactName` breaks the exhaustive `FACT_AREAS` (`sim/lab-checks/facts.ts:319`) and a
new `NeighborProtocol` breaks `NEIGHBOR_AREAS` (`facts.ts:194`) — W0 maps each new name to an area thunk returning
`{}` until its adapter item lands. §9.2 W0 item 1 names every file.

### 2.1 `contracts/catalog.ts`

```ts
export type BuildStage = 'P0' | 'P0.5' | 'P1' | 'P2' | 'P3' | 'P3c';                       // D1
export const BUILD_STAGES: readonly BuildStage[] = ['P0', 'P0.5', 'P1', 'P2', 'P3', 'P3c'];
// DefaultsProfile, DEFAULTS_PROFILES and LATEST_DEFAULTS_PROFILE ('P3') are unchanged (D1).

// CAPABILITIES: append [S35] 'voice-endpoint' (implies nothing; NF-IPPHONE gains it at the W4b flip)
// GUI_PANELS: append [S33] 'desktop.snmp-manager', then [S27] 'desktop.api-client' (GUI_PANEL_SINCE 'P3c')
```

`PROCESS_ORDER` **final** order (new names in **bold**; existing names keep their relative order, so every existing
`DeviceModel.processes` list stays an order-preserving subsequence). **W0 inserts none**; the W4b flip inserts each
name at this position in the change that registers its factory (P3a rule 3):

… `udp`, `tcp`, `vty`, `vty-client`, `logger`, `ntp`, **`tftp`** [S29], **`snmp-agent`** [S33], **`snmp-manager`**
[S33], `syslog-server`, `hsrp`, `ospf`, **`ospfv3`** [S6], `eigrp`, `ike`, `dhcp-client`, … (the rest unchanged).

Constraints relied upon: `udp` before `tftp` and `snmp-*`; `ipv6` and `ip-upper` delivery before `ospfv3` (requests
only); `ospf` before `ospfv3` is not required (they share no state, only pure modules).

`CAPABILITY_PROCESSES` additions, all `since: 'P3c'`, added by the W4b flip, and derived **only on models with a CLI
shell** (D6: `deriveProcesses` gains the model's `CliSpec`, as `deriveCdpDefault` already takes it, and skips a row whose `since` is `'P3c'` on a model with no shell, i.e. the home routers; every earlier row derives exactly as today):

| Capability | Adds |
|---|---|
| `routing` | `tftp`, `snmp-agent`, `ospfv3` (in `PROCESS_ORDER` order) |
| `managed-switch` | `tftp`, `snmp-agent` |
| `server` | `tftp`, `snmp-manager` |
| `programmable` | `snmp-manager` |
| `voice-endpoint` [S35] | `cdp`, `lldp` (the phone's daemons run on its `group: 'uplink'` port only) |

`PROCESS_TABLES` additions (with the registering change): `ospfv3` → `ospf6-interfaces`, `ospf6-neighbors`,
`ospf6-lsdb`; `snmp-manager` → `snmp-traps`. `STAGED_PROCESS_TABLES` [S16]: one row has one `since`, so the existing
`vlan` row (`contracts/tables.ts:1403-1409`, `since: 'P3'`) is unchanged and the W4b flip appends a **second row**
`{process: 'eth-switch', tables: ['storm-control'], since: 'P3c', requires: 'managed-switch'}` (eth-switch writes the
table). `PROCESS_TABLES` is unaffected by it. `device.catalog.p3.test.ts:170` and `staged.world.p3-parity.test.ts:81`
move by design (§9.2).

### 2.2 `contracts/port.ts`

```ts
// ErrDisableCause: append [S16] 'storm-control'
// ERR_DISABLE_CAUSES: appended by the W2a l2 item that raises it (a runtime list `show errdisable recovery` prints;
//   P3a rule 3: never in W0); ERR_DISABLE_CAUSE_TEXT gets its row as a W0 compile stub.
```

### 2.3 `contracts/pdu.ts` and `contracts/fields.ts`

```ts
// pdu.ts
// ProtoName: append [S6] 'ospf6'. 'tftp' and 'snmp' are NOT new names: DISPATCH_TABLE already uses them
//   (fields.ts:671,673; ProtoName is open by `string & {}`) and the web lists them in RESERVED_PROTOCOL_VOCAB
//   (apps/web/src/vocab/protocols.ts:152-154); they move from the reserved vocabulary to PROTOCOL_VOCAB (§9.2 W0 item 1)
export const OSPF6_ALL_ROUTERS = 'ff02::5';      // [S6]
export const OSPF6_ALL_DROUTERS = 'ff02::6';     // [S6]
export const UDP_PORT_TFTP = 69;                 // [S29]
export const UDP_PORT_SNMP = 161;                // [S33]
export const UDP_PORT_SNMP_TRAP = 162;           // [S33]
// PduMeta.mirror?: true   [S34] (OBM) a SPAN copy; set only on copies, never on the original
```

Field tables (`fields.ts`; every key is a display field and a NetScope filter field; `?` = present only when the
packet carries it):

| Table | Additions |
|---|---|
| `ospf` [S5] | `authKey?` string ≤ 8 (auType 1), `keyId?` u8, `cryptoSeq?` u32, `digest?` bytes 16 (auType 2, a trailer after the OSPF length). The header's `auType` exists. |
| `ospf-lsa` [S4] | no new keys: `lsType` gains 3 and 4; `mask` and `metric` (u24) are used by the summary body `mask(4) 0(1) metric(3)` |
| `ospf6` [S6] (new) | header `version` 3, `type`, `length`, `routerId`, `areaId`, `checksum` (over the IPv6 pseudo-header), `instanceId` u8; hello `interfaceId` u32, `priority`, `options` u24, `helloInterval` u16, `deadInterval` u16, `dr`, `bdr`, `neighbors`; DBD `options`, `mtu`, `flags` (I/M/MS), `ddSeq`; LSR, LSU, LSAck as v2 |
| `ospf6-lsa` [S6] (new) | `lsType` (function-coded: `0x2001` router, `0x2002` network, `0x2003` inter-area-prefix, `0x2004` inter-area-router, `0x4005` external, `0x0008` link, `0x2009` intra-area-prefix), `lsId`, `advRouter`, `seq`, `age`, `checksum`, `length`, and per body: router links `{type, metric, ifaceId, nbrIfaceId, nbrRouterId}`; network `attached`; link `linkLocal`, `prefixes`; prefix LSAs `refType`, `refLsId`, `refAdvRouter`, `prefixes {prefix, prefixLen, metric}` |
| `tftp` [S29] (new) | §3.4 |
| `snmp` [S33] (new) | §3.5 |
| `cdp` [S35] | `voiceVlan?` u16 (NF TLV type 9, original format) |
| `lldp` [S35] | `medVlan?` u16 (TLV 127, OUI 00-12-BB subtype 2 Network Policy, application type 1 voice); `medCapabilities?` u16 (TLV 127, OUI 00-12-BB subtype 1 LLDP-MED Capabilities, so the switch's daemon can see that a neighbour advertised MED); every other organisation TLV stays skipped |
| `gre` [C17] | `key?` u32 (written when K is set; today the word is zero) |

Dispatch (pdu owner, with each codec item): `udp.port 69 → tftp` and `udp.port 161 → snmp` lose their `reserved` flag
and keep their `'P1'` stage (the P3a R22 precedent for ntp, ssh, telnet and syslog); `udp.port 162 → snmp` is added;
IPv6 next header 89 → `ospf6`. The new field tables `ospf6`, `ospf6-lsa`, `tftp` and `snmp` are declared with
`table(proto, 'P3c', …)` (`fields.ts:57`). `pdu.codecs.p3.test.ts:406-415`'s reserved list moves (§9).
`IPV6_UPPER` (`protocols/ip-upper.ts`, l3) gains `{89, 'ospfv3'}`.

### 2.4 `contracts/process.ts`

```ts
// ── [S6] IPv6 routing plumbing (owner ipv6; D8 of P3a mirrored for IPv6) ──
| { kind: 'ipv6.routes'; owner: ProcessName; rows: readonly Route6Row[] }   // replaces the owner's set, key order
| { kind: 'ipv6.group'; op: 'join' | 'leave'; iface: PortId; group: Ipv6Address; owner: ProcessName }
| { kind: 'ospfv3.clear'; session?: SessionId }

// ── [S11] IPv6 ACLs ──
export interface PacketTuple6 {
  readonly family: 6;
  readonly proto: number;               // next header after the extension headers
  readonly src: Ipv6Address; readonly dst: Ipv6Address;
  readonly srcPort?: number; readonly dstPort?: number;
  readonly icmpType?: number; readonly icmpCode?: number;
  readonly tcpFlags?: number;
  readonly fragment?: 'non-initial';    // a non-initial ipv6-frag carries no L4 fields
}
export type AnyPacketTuple = PacketTuple | PacketTuple6;
// acl.filter.family: 4 | 6       acl.check: { …; family: 4 | 6; tuple: AnyPacketTuple }
// acl.clear.family?: 4 | 6 (OBM; absent = 4)
| { kind: 'ipv6.resume'; pdu: Pdu; inPort: PortId; after: 'acl-in' }

// ── [S12] [S17a] PacketTuple (IPv4) gains ──
// dscp?: number (OBM) [S12];  fragment?: 'non-initial' (OBM) [S17a]

// ── DropRule ──
// family?: 4 | 6 [S11] (value widening of the existing OBM member; absent = 4)
// seq?: number | 'implicit' | 'nd-na' | 'nd-ns' [S11] (value widening)
// kind: append [S15] 'ip-source-guard', [S16] 'storm-control'

// ── [S29] TFTP ──
| { kind: 'tftp.transfer'; owner: ProcessName | 'cli'; token: string; session?: SessionId;
    op: 'get' | 'put'; server: IpAddress; remote: string;
    local: { fs: FileSystemId; path: string } | { config: 'running' | 'startup' };
    image?: true }                                            // [S30] a scaled image copy: the RRQ asks `tsize`;
                                                              //   the size and nominalBytes come from the server (§3.4)
// ConfigOrigin.via: append [S29] 'tftp', [S33] 'snmp'

// ── [S33] SNMP ──
| { kind: 'snmp.op'; owner: ProcessName | 'cli' | 'gui'; token: string;
    op: 'get' | 'getnext' | 'getbulk' | 'walk' | 'set';
    target: IpAddress; version: '2c' | '3'; community?: string;
    user?: SnmpV3User;                                        // [C23]
    oid: string; value?: SnmpValue; maxRepetitions?: number;
    nonRepeaters?: number }                                   // (OBM; getbulk only; absent = 0)
export type SnmpValue =
  | { type: 'integer'; value: number } | { type: 'octets'; value: string } | { type: 'oid'; value: string }
  | { type: 'ipaddress'; value: IpAddress } | { type: 'counter32' | 'gauge32' | 'timeticks'; value: number }
  | { type: 'counter64'; value: string }                      // decimal text: no bigint leaves the codec
  | { type: 'null' }
  | { type: 'noSuchObject' | 'noSuchInstance' | 'endOfMibView' };   // RFC 3416 exceptions 0x80, 0x81, 0x82: a GET's
                                                              //   "No such object", the end of a walk
export interface SnmpV3User {                                  // [C23]
  readonly name: string; readonly level: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
  readonly authProto?: 'md5' | 'sha'; readonly authKey?: string; readonly privKey?: string;
}

// ── [S27] http.request.owner: ProcessName | 'cli' | 'gui'
// ── [S35] a learned voice VLAN restarts the phone's DHCP in it
| { kind: 'dhcp.restart'; iface: PortId }
// ── [C32] DemuxSelector.frame?: 'data' is DELETED in W0h, in one change with capwap-wtp's `handles` entry
//    (capwap-wtp.ts:896); W0 keeps the member; behaviour unchanged
```

### 2.5 `contracts/transport.ts` (ProcessEvent)

```ts
| { kind: 'tftp.result'; token: string; ok: boolean; bytes: number; blocks: number; error?: string }   // [S29]
| { kind: 'snmp.result'; token: string; ok: boolean;
    varbinds: readonly { oid: string; value: SnmpValue }[]; error?: string; errorIndex?: number }     // [S33]
```

### 2.6 `contracts/tables.ts`

```ts
// ── routing ──
// RouteRow.routeType?: 'E2' | 'IA'                 [S4] (OBM, value widening; absent = intra-area or not OSPF)
export type OspfLsaType = 1 | 2 | 3 | 4 | 5;         // [S4]
// OspfLsaRow.mask, .metric: documented for types 3 and 4 [S4]
// OspfInterfaceRow.auth?: 'simple' | 'md5'         [S5] (OBM; absent = none)
// OspfInterfaceRow.authKeyId?: number              [S5] (OBM; the youngest key id, display)
// No OspfStateView member for border routers (changed by review): a StateView member is part of the normalised
//   snapshot hash, so filling it whenever SPF finds an ABR or ASBR would move single-area P3 goldens (lab 06's ASBR).
//   `show ip ospf border-routers` is computed in the CLI handler from the `ospf-lsdb` rows through the pure
//   `runSpf` / `interAreaRoutes` (exported through `@netforge/engine/pure`): no state, no byte.

// Route6Row.source: 'C' | 'L' | 'S' | 'ND' | 'O'   [S6]
// Route6Row.routeType?: 'OI' | 'OE2'               [S6] (OBM; absent = intra-area)
// Route6Row.owner?: ProcessName                    [S6] (OBM; absent = ipv6's own rows)
export interface Ospf6InterfaceRow extends TableRow {           // [S6] key `${port}`
  port: PortId; area: string; ifaceId: number; type: 'broadcast' | 'point-to-point' | 'loopback';
  state: OspfIsmState; cost: number; priority: number; dr: string; bdr: string;
  hello: number; dead: number; linkLocal: Ipv6Address; passive?: true; rejected?: string;
}
export interface Ospf6NeighborRow extends TableRow {            // [S6] key `${port}|${routerId}`
  port: PortId; routerId: string; ifaceId: number; priority: number; state: OspfNsmState;
  role: 'DR' | 'BDR' | 'DROTHER' | '-'; linkLocal: Ipv6Address; deadAt: SimTime;
}
export interface Ospf6LsaRow extends TableRow {                 // [S6] key `${scope}|${lsType}|${lsId}|${advRouter}`
  scope: string; lsType: number; lsId: number; advRouter: string; seq: number; age: number; checksum: number;
  links?: readonly { type: number; metric: number; ifaceId: number; nbrIfaceId: number; nbrRouterId: string }[];
  attached?: readonly string[]; linkLocal?: Ipv6Address;
  prefixes?: readonly { prefix: Ipv6Address; prefixLen: number; metric: number }[];
  ref?: { lsType: number; lsId: number; advRouter: string };
}
// Ospf6StateView: kind 'ospfv3', the OspfStateView shape
// ExtraTableName: append [S6] 'ospf6-interfaces' | 'ospf6-neighbors' | 'ospf6-lsdb',
//                        [S16] 'storm-control', [S33] 'snmp-traps'

// ── ACLs ──
// AclRow.family: 4 | 6 [S11] (value widening of the existing required member; family-4 rows keep their bytes)
// AclRow.type: 'standard' | 'extended' | 'ipv6' [S11] (value widening)
// AclRow.implicit?: 'deny' | 'nd-na' | 'nd-ns' [S11] (value widening of the existing OBM member)
export const aclKey = (f: 4 | 6, list: string, seq: number | 'implicit' | 'nd-na' | 'nd-ns'): string => …;
//   family-4 keys are byte-identical to today's

// ── access layer ──
// ArpInspectionRow.droppedSrcMac?, droppedDstMac?, droppedIp?, aclPermitted?: number   [S14] (OBM; written once nonzero)
export interface StormControlRow extends TableRow {             // [S16] key `${port}|${kind}`
  // written once when the line is stored or the port comes up (state 'forwarding', current 0, windowStart = now),
  // then on a state change or once per window with drops; current/dropped/state may be stale once traffic stops
  port: PortId; kind: 'broadcast' | 'multicast' | 'unicast';
  unit: 'percent' | 'pps' | 'bps';
  rise: number; fall: number;            // percent in hundredths (100 = 1.00 %), else pps or bps
  current: number;                       // the last full window's level, same unit (not a live value)
  state: 'forwarding' | 'blocking' | 'err-disabled';
  action: 'drop' | 'shutdown' | 'trap';
  dropped: number; windowStart: SimTime;
}

// ── WAN and discovery ──
// CdpNeighbourRow.voiceVlan?: number [S35] (OBM)   LldpNeighbourRow.medVlan?: number [S35] (OBM)
// LldpNeighbourRow.medCapabilities?: number [S35] (OBM; the neighbour's LLDP-MED capability bits)
// TunnelDownReason: append [C17] 'keepalive-missed'
// TunnelRow.keepalive?: { periodS: number; retries: number; missed: number } [C17] (OBM)
// TunnelRow.key?: number [C17] (OBM)
// TunnelRow.holdUntil?: SimTime [S36a] (OBM; present while the recursion hold is armed)

// ── management ──
export interface SnmpTrapRow extends TableRow {                  // [S33] key `${seq}`, bounded (SNMP_TRAPS_RETAINED = 64)
  seq: number; at: SimTime; from: IpAddress; community: string; version: '2c' | '3';
  trap: 'coldStart' | 'linkDown' | 'linkUp' | 'authenticationFailure';
  varbinds: readonly { oid: string; value: SnmpValue }[];
}
// ScriptRunRow.kind?: 'python' | 'playbook'        [C22] (OBM; absent = python, so lab 40's rows keep their bytes)
// ScriptRunRow.recap?: readonly { host: string; ok: number; changed: number; failed: number; unreachable: number }[]
//                                                   [C22] (OBM)
```

`TABLE_DESCRIPTORS` and `TABLE_LANES` rows for the new tables: `ospf6-*` → lane `routing`; `storm-control` → lane
`security` (the lane `port-security` and `arp-inspection` use, `timeline/lanes.ts:114,128`; `dhcp-snooping` is in
lane `dhcp`); `snmp-traps` → lane `mgmt`. `snmp-traps` joins `RUNTIME_ONLY_TABLES`
(`sim/grade.ts:106`): it is graded live, as `restconf-log` is.

### 2.7 `contracts/link.ts`, `contracts/capture.ts`, `contracts/trace.ts`

```ts
// DropReason: append [S15] 'ip-source-guard', [S16] 'storm-control', [S34] 'span-destination'
// CaptureSpec.span?: { device: DeviceId; session: number } [S34] (OBM): "capture what this SPAN session delivers"
```

### 2.8 `contracts/simulation.ts`

```ts
// TraceFilter.reasons?: readonly DropReason[]   [S10] (OBM): a drop matches when its reason is listed; every other
//   event kind never matches while the member is set
// TraceFilter.vlans?: readonly number[]         [C32] (OBM): matched against PduSummary.vlan
// HostAppRequest: append
//   | { app: 'http.request'; method: HttpMethod; url: string;
//       headers?: readonly (readonly [string, string])[]; body?: string }     [S27] (body as UTF-8 text, journaled)
//   | { app: 'snmp'; op: 'get' | 'getnext' | 'getbulk' | 'walk' | 'set'; target: IpAddress; version: '2c' | '3';
//       community?: string; user?: SnmpV3User; oid: string; value?: SnmpValue;
//       maxRepetitions?: number; nonRepeaters?: number }                     [S33] [C23]
// RunStats.stopped: append [S39] 'quiet'
// [S39] new type (no options type exists today; contracts/simulation.ts:258 is `runToIdle(maxEvents?: number)`):
export interface RunToIdleOptions { readonly quiet?: { readonly windowNs: SimTime } }   // (OBM; absent = today exactly)
// Simulation.runToIdle(maxEvents?: number, opts?: RunToIdleOptions): RunStats            (additive second parameter)
// Simulation.aclLists?(device: DeviceId): readonly AclListView[]   [S10] (OBM, display only: no event, no state)
```

`HOST_APP_PROCESS` lives in `sim/simulation.ts`, not in a contract: the sim item of W3b (http + auto's request path)
and the svc manager item add `'http.request' → 'http-client'` and `'snmp' → 'snmp-manager'` there.

### 2.9 `contracts/device.ts`, `storage.ts`, `topology.ts`, `journal.ts`, `cli.ts` (runtime)

```ts
// device.ts
// DeviceModel.storage?: { flashBytes: number; nvramBytes: number;
//                         image: { file: string; version: string; nominalBytes: number } }   [S29] [S30] (OBM)

// storage.ts
export type FileSystemId = 'files' | 'flash' | 'nvram';             // [S29]
export const IMAGE_TRANSFER_SCALE = 1024;                           // [S30] wire bytes = ceil(nominal / 1024)
export const IMAGE_HEADER_BYTES = 16;                               // [S30] 'NFIMG1' + nominal size, 10 decimal digits
export const DEFAULT_CONFIG_REGISTER = 0x2102;                      // [S31]
// StoredFileMeta.nominalBytes?: number   [S30] (OBM; set when the content starts with a valid image header)
// StoredFileInput.nominalBytes?: number  [S30] (OBM; the runtime slot `dir`, the capacity check and the export read;
//   the `{type: 'storage'}` action, contracts/process.ts:745, carries it through StoredFileInput)
// TopologyFile.fs?: 'flash'          [S29] (OBM; absent = 'files'; schema 1.4 only)
// TopologyFile.nominalBytes?: number [S30] (OBM; schema 1.4 only)

// topology.ts
export const TOPOLOGY_SCHEMA_ID_1_4 = 'netforge.topology/1.4';     // D2; W0 declares the constant only (R7 precedent)
// TopologyDevice.nvram?: { configRegister?: number }   [S31] (OBM; written only when ≠ DEFAULT_CONFIG_REGISTER)

// journal.ts
| { op: 'cliBreak'; session: SessionId }                            // [S31] the only new journal op of P3c

// cli.ts (runtime): CliRuntime.sendBreak?(session: SessionId): void [S31] (transition `?` in W0; written in
//   cli/runtime.ts by W3a2 cli-runtime; W3b web-shell removes the `?` and updates every typed fake, rule 2)
// web EngineApi.sendBreak?(session): void                              [S31] (same: `?` in W0, removed in W3b)
```

### 2.10 `contracts/scenario.ts` (grader) and `contracts/timeline.ts`

```ts
// LabFactName: append
//   [S4]  'ospf.abr'            subject: device; boolean (an active area-0 interface and one more area)
//   [S4]  'ospf.asbr'           subject: device; boolean (originates a type-5 LSA)
//   [S6]  'ospfv3.routerId' | 'ospfv3.ifaceArea' | 'ospfv3.ifaceCost'   (as the ospf.* facts)
//   [S15] 'ipsg.enabled'        subject: port; boolean, from configuration
//   [S29] 'storage.file'        subject: `${fs}:${path}`; value: size in bytes, or absent
//   [S30] 'device.imageVersion' subject: device; the running image's version string
//   [S31] 'device.configRegister' subject: device; number (the register in effect)
// NeighborProtocol: append [S6] 'ospfv3'
// route: routeType?: 'E2' | 'IA' [S4]   (family 6 rows: source 'O' and routeType 'OI' | 'OE2' [S6])
// acl, aclDecision: family?: 4 | 6 [S11] (OBM)   LabPacketProbe: IPv6 addresses accepted [S11]
// acl: type?: 'standard' | 'extended' | 'ipv6' [S11] (value widening); entry?: number | 'implicit' | 'nd-na' | 'nd-ns'
//   [S11] (value widening; contracts/scenario.ts:357-368)
// ConceptToolId: append [S22] 'wan', [S28] 'yang', [C26] 'sdn'

// [S8] the convergence kind
| { kind: 'convergence'; fault: LabFault; protocol: ConvergenceProtocol; only?: 'ospf' | 'eigrp';
    withinMs: number; atLeastMs?: number; windowMs?: number /* default 120_000 */ }

// [S38] the packetSeen kind
| { kind: 'packetSeen';
    at: { device: string; port?: string } | { link: [string, string] };   // resolved like the capture points
    filter: string;                         // a NetScope display filter; compiled at lab load, refused if invalid
    dir?: 'tx' | 'rx' | 'both';             // default 'both'
    expect?: 'seen' | 'absent';             // default 'seen'
    min?: number;                           // default 1 (with 'seen')
    drive?: { probe: { from: string; to: string; proto?: 'icmp' | 'tcp' | 'udp'; port?: number } }
          | { flows: readonly (TrafficFlowSpec & { from: string; to: string })[]; runMs: number }
          | { snmp: { from: string; to: string; community: string; oid: string }; runMs: number }
                                            // one SNMPv2c GET from a host's snmp-manager in the clone (lab 30)
          | { runMs: number };              // a passive window (CDP, hellos, traps)
    includeBackground?: boolean;            // hellos and keepalives count (OSPF auth, CDP)
    after?: readonly LabFault[]; settleMs?: number }
```

```ts
// contracts/timeline.ts  [S8]
export type ConvergenceProtocol = 'stp' | 'etherchannel' | 'fhrp' | 'routing' | 'wireless' | 'wan';
export const CONVERGENCE_LANES: Readonly<Record<ConvergenceProtocol, readonly LaneId[]>>;
//   routing → ['routing'], wan → ['wan'], stp → ['stp'], … (the lanes of timeline/lanes.ts)
export const CONVERGENCE_QUIET_MS: Readonly<Record<ConvergenceProtocol, number>>;   // routing 12_000, others 5_000
export interface ConvergenceOptions {
  readonly protocol: ConvergenceProtocol; readonly from: SimTime;
  readonly quietMs?: number; readonly devices?: readonly DeviceId[];
  readonly only?: 'ospf' | 'eigrp';   // the routing lane: that daemon's machines and tables plus the rib rows it owns
}
export interface ConvergenceResult {
  readonly protocol: ConvergenceProtocol; readonly from: SimTime;
  readonly settledAt: SimTime | null; readonly durationNs: SimTime | null; readonly changes: number;
  readonly last?: { readonly cursor: number; readonly device: DeviceId; readonly subject: string };
}
// timeline/convergence.ts (pure): measureConvergence(events: readonly TraceEvent[], opts): ConvergenceResult
// FsmMachine: append [S6] 'ospf6-if' | 'ospf6-nbr' (lane routing)
```

The convergence check runs in a fault clone with `settleNs = 0`: the clone applies its faults at the clone instant,
attaches a synchronous trace listener before the first event after the fault, runs `runFor(windowMs)`, and measures.
W1a sim confirms the clone applies faults before the check starts (map 01 Q-S8-2); if it does not, the item adds a
`CloneHost.run` option `faultsFirst` (OBM) rather than a private convention.

### 2.11 `contracts/cli.ts` and `contracts/config.ts`

```ts
// CliMode: append [S6] 'config-rtr' (prompt '(config-rtr)#', contextKey 'ipv6 router ospf'),
//                 [S11] 'config-ipv6-acl', [S14] 'config-arp-nacl', [S31] 'rommon' (prompt 'rommon N >')
// ArgType: append [S29] 'url' (tftp://host/file, flash:name, nvram:startup-config)
// CLI_MESSAGES: append (original wording, final text in the implementing item)
//   [S5] ospfAuthKeyTooLong   [S6] ospf6NeedsRouterId, ospf6NeedsUnicastRouting, ospf6OneProcess
//   [C7] ipMtuRange           [S15] ipsgNeedsPortSecurity   [S17a] pingSizeRange
//   [S29] fileNotFound, flashFull, tftpTimeout, tftpRefused   [S31] breakNotOnVty, rommonUnknown
//   [S33] snmpV1Refused
```

### 2.12 Web contracts (`apps/web/src/bridge/protocol.ts`, `apps/web/src/store/types.ts`, `apps/web/src/canvas/overlays/registry.ts`)

```ts
// store/types.ts
// TopoOverlayState += routePath: boolean; routeTo: string | null        [S7]  (persisted; default false / null)
// TopoOverlayState += neighbours: boolean; neighbourProtocol: 'cdp' | 'lldp' | 'both'   [S26] (default false / 'both')
//   one persisted-slice version bump with its migration for both items (the first item to land owns it)
// canvas/overlays/registry.ts (not store/types.ts; registry.ts:51,56):
// OverlayId += 'route-path' [S7], 'neighbours' [S26]    RoutingOverlayToggle += 'routePath', 'neighbours'

// bridge/protocol.ts
// request  { type: 'aclLists'; device } → { lists: AclListView[]; bindings: AclBindingView[] }          [S10]
// request  { type: 'aclEvaluate'; device; list: string; tuple: AnyPacketTuple }
//          → { decision: AclDecision; list: AclListView | null }                                       [S10]
// request  { type: 'cliBreak'; session }                                                               [S31]
// RunToIdleSnapshot.runStopped: 'quiet' mapped                                                         [S39]
```

`AclListView` and `AclBindingView` are display types in `contracts/simulation.ts` [S10]: a list's name, family, type,
entries (text, seq, matches, implicit) and its bindings (device, interface or `vty`, direction).

### 2.13 Members that become required during P3c

`CliRuntime.sendBreak` and `EngineApi.sendBreak` [S31]. They are **not** required at once: W0 adds them with a
transition `?` (adding them required in a types-only W0 would break `createCliRuntime`, the web engine API and every
fake). W3a2 cli-runtime writes `CliRuntime.sendBreak` in `cli/runtime.ts` (it issues the `cliBreak` journal op that
W2b device built); W3b web-shell writes `EngineApi.sendBreak`, removes both `?` (a reviewed contract edit) and updates
every typed fake in the same change (rule 2). No other new member is required; the [S11] changes to `AclRow`,
`DropRule`, `PacketTuple`-consuming requests and `aclKey` are value widenings of existing members.

### 2.14 Members that stay optional (optional by meaning)

`RouteRow.routeType` (widened), `OspfInterfaceRow.auth`, `.authKeyId`, `Route6Row.routeType`, `Route6Row.owner`, `Ospf6InterfaceRow.passive`, `.rejected`, `PacketTuple.dscp`,
`PacketTuple.fragment`, `PacketTuple6.*?` (ports, ICMP, flags, fragment), `acl.clear.family`, `DropRule.family` and
`AclRow.implicit` (widened, already OBM), the four `ArpInspectionRow` counters, `CdpNeighbourRow.voiceVlan`,
`LldpNeighbourRow.medVlan`, `.medCapabilities`, `StoredFileMeta.nominalBytes`, `StoredFileInput.nominalBytes`,
`snmp.op.nonRepeaters`,
`TunnelRow.keepalive`, `.key`, `.holdUntil`, `ScriptRunRow.kind`, `.recap`, `PduMeta.mirror`, `CaptureSpec.span`,
`TraceFilter.reasons`, `.vlans`, `RunToIdleOptions.quiet`, `Simulation.aclLists`, `DeviceModel.storage`,
`TopologyFile.fs`, `.nominalBytes`, `TopologyDevice.nvram`, `tftp.transfer.image`, `snmp.op.user`,
`.maxRepetitions`, `SnmpV3User.*?`, the `convergence` kind's `only`, `atLeastMs`, `windowMs`, and the `packetSeen`
kind's optional members. Each is tagged `@since P3c (optional by meaning)`; `contracts.optional-by-meaning.test.ts`
and the web `protocol.optional-by-meaning.test.ts` gain the rows. `DemuxSelector.frame` **leaves** the P2 list [C32].

---

## 3. Protocol walk-throughs

These replace the P3a area-map material the P3a brief pointed at and that is lost (D13). P3a's §3.0–§3.14 stay in force
and are not repeated; "P3a §3.2" below means the single-area timing model of ARCHITECTURE-P3 §3.2 (MinLSInterval 5 s,
SPF delay 5 s, SPF hold 10 s, an `lsa-gen` due with `spf` runs first). Times are sim time. Where a step derives an
instant from that model, the **order of events is binding** and the instant is what W4a measures; if the throttle
interplay moves an instant, the measured value is recorded as a ruling and pinned (the P3a R46 precedent), never
loosened.

### 3.1 Multi-area OSPF: an ABR, summary LSAs and `O IA` routes [S4]

Setup: R1, R2, R3 (NF-2911), router ids 1.1.1.1, 2.2.2.2, 3.3.3.3, reference bandwidth 100 Mb/s (GigE cost 1). R1 Gi0/0
10.0.12.1/30 – R2 Gi0/0 10.0.12.2/30, area 1; R2 Gi0/1 10.0.23.1/30 – R3 Gi0/0 10.0.23.2/30, area 0; both links
`ip ospf network point-to-point`. R1 Gi0/1 10.1.0.1/24 area 1 and R3 Gi0/1 10.3.0.1/24 area 0, both passive. R3
Se0/0/0 203.0.113.1/30 to an ISP (not in OSPF), `ip route 0.0.0.0 0.0.0.0 203.0.113.2`, `default-information
originate` (R3 is an ASBR). All three GigE links come up at U; R3's static default is in its RIB at U.

1. **At U.** Each router originates one router-LSA per attached area with its stub links (P3a §3.2 step 1). R2's two
   router-LSAs (area 0 and area 1) carry the **B** flag: R2 has an active area-0 interface and one other area (D7).
   R3's area-0 router-LSA carries **E**; R3 originates the type-5 LSA for 0.0.0.0/0, metric 1, E2. Each router arms
   `spf` for U + 5 s.
2. **U + 1 s + ε.** Both adjacencies are Full. The DBD exchange carries area-scoped LSAs per area (`lsdbForArea`) and
   the AS-scoped type 5 on every adjacency, so R1 holds R3's type 5 from about U + 1 s (unusable yet: R3 is not in
   area 1).
3. **U + 5 s.** `lsa-gen` (the point-to-point links), then each SPF, which misses every neighbour's link back (P3a §3.2).
   R2's per-area SPFs still yield its own stub networks as intra-area routes (10.0.12.0/30 in area 1, 10.0.23.0/30 in
   area 0). After those SPFs, R2 computes its wanted summaries (the summary rules below) and originates, in this order:
   type 3 **10.0.12.0/30 metric 1 into area 0**; type 3 **10.0.23.0/30 metric 1 into area 1**. They are new LSAs, so
   MinLSInterval does not hold them.
4. **U + 15 s.** The SPF armed by the neighbours' re-originated LSAs runs on all three routers. R1 installs
   `O IA 10.0.23.0/30 [110/2] via 10.0.12.2, GigabitEthernet0/0` (cost to the ABR 1 + summary metric 1); R3 installs
   `O IA 10.0.12.0/30 [110/2] via 10.0.23.1`. R2 now has every intra-area route and the E2 default via R3, and
   originates after its SPFs: type 3 **10.1.0.0/24 metric 2 into area 0**; type 3 **10.3.0.0/24 metric 2 into area 1**;
   type 4 **3.3.3.3 metric 1 into area 1** (R3 is an ASBR reachable in area 0). R2 originates no type 4 into area 0 for
   R3 (R3 is in area 0) and never summarises an area-0 route back into area 0.
5. **U + 25 s.** The new summaries reached R1 and R3 at U + 15 s + δ; their SPF hold ends at U + 25 s. R1 installs
   `O IA 10.3.0.0/24 [110/3] via 10.0.12.2` and `O*E2 0.0.0.0/0 [110/1] via 10.0.12.2` (the ASBR found through the
   type 4: forwarding cost 1 + 1 = 2; the E2 metric stays 1). R3 installs `O IA 10.1.0.0/24 [110/3] via 10.0.23.1`.
   **IA routes in a three-router two-area chain arrive at link-up + 25 s**; lab text says "allow about a minute and a
   half after boot".
6. **Area-scoped rows.** R1's `ospf-lsdb` holds, for area 0.0.0.1: router 1.1.1.1, router 2.2.2.2 (B), summaries
   10.0.23.0/30 and 10.3.0.0/24, ASBR-summary 3.3.3.3; and the AS-scoped external 0.0.0.0. It holds **no** area-0
   router-LSA. R3's LSDB (area 0): router 2.2.2.2 (B), router 3.3.3.3 (E), summaries
   10.0.12.0 and 10.1.0.0, the external. `show ip ospf database` prints the sections in type order 1, 2, 3, 4, then 5.
7. **`show ip ospf border-routers` on R1** lists two rows: R2 reached intra-area (`i`) at cost 1 via 10.0.12.2 Gi0/0,
   role ABR, area 1; R3 reached inter-area (`I`) at cost 2 via 10.0.12.2 Gi0/0, role ASBR, area 1. The layout is
   original (fields: kind letter, router id, `[cost]`, next hop, interface, roles, area, SPF run number), computed by
   the CLI handler from the `ospf-lsdb` rows through the pure SPF (no StateView member, §2.6). `show ip ospf`
   on R2 prints one section per area and "This router is an area border router" (original wording).
8. **A summarised network goes away** (at T ≥ U + 60 s, `shutdown` on R3 Gi0/1). R3 re-originates its router-LSA at T
   and runs SPF at T + 5 s. R2 receives it at T + δ, runs SPF at T + 5 s, drops 10.3.0.0/24 from area 0's routes and
   **flushes** its type 3 for 10.3.0.0/24 from area 1 (MaxAge flood, not held by MinLSInterval). R1 receives the flush
   at T + 5 s + δ; its SPF at T + 10 s removes the `O IA` route.
9. **The ABR loses area 0** (at T2 ≥ T + 60 s, the R2–R3 cable is cut). At T2 R2 has no active area-0 interface, so it is
   no longer an ABR: it re-originates its area-1 router-LSA without B at T2 and arms SPF. R1 receives that router-LSA at
   T2 + δ and its SPF runs at **T2 + 5 s** (its hold ended long before). By RFC 2328 §16.1 a router enters R1's routing
   table as an area border router only when its router-LSA has bit B (or E) set, and by §16.2 step (4) "if no such entry
   exists for router BR … do nothing with this LSA": R1's SPF therefore ignores every type 3 and type 4 that R2
   originated, and **every `O IA` route and the `O*E2` default go at T2 + 5 s** (routing by the B bit). At T2 + 5 s
   R2's own SPF finds no wanted summaries and R2 flushes every type 3 and type 4 it originated into area 1; the flushes
   reach R1 at T2 + 5 s + δ and arm an SPF at T2 + 15 s, which changes nothing that is routed.

**The summary rules** (pure, `protocols/ospf/originate.ts` `summaryLsasOf`; RFC 2328 §12.4.3 and §16.2–16.4):
- For each intra-area route of area A, one type 3 into every other attached area, metric = the route's cost. An
  inter-area route is summarised only from the backbone into non-backbone areas, never back into area 0.
- One type 4 for each reachable ASBR into every attached area other than the ASBR's own.
- No summary of a route whose next hop lies in the target area. Link-state id = the network address; when two
  prefixes share a network address the RFC Appendix E host-bit rule picks the id.
- After every SPF the wanted set is diffed against the self-originated type 3/4 rows by body (`lsaBodyEqual`):
  changed rows are originated through `lsa-gen` (MinLSInterval), vanished rows flushed. An unchanged summary is never
  re-originated (no churn).
- A router examines summaries only from areas it is attached to; an ABR examines **only backbone** summaries; it skips
  its own, MaxAge copies and summaries whose advertising router is unreachable in that area. Route preference: intra
  (any area) < IA < E2.
- The grader facts `ospf.abr` and `ospf.asbr` read configuration plus `ospf-interfaces` (an up area-0 interface and one
  more area; a type-5 origination).

**Labs 05 and 07 change behaviour, not grading.** Lab 07's fault (`ip ospf 1 area 1` on R2 Gi0/0) and lesson 05's
experiment make R2 an ABR in the unsolved world, so R2 now originates summaries there. The four graded tasks read
neighbours, interfaces, router ids and connectivity and are unchanged; lab 07's P3 golden digest moves (§9.5). Lab 06
(an ASBR, single area) must not move: no summary, no B change and no StateView member; the S4 item runs lab 06's digest
entry as a guard.

### 3.2 OSPF refuses a neighbour: authentication and an MTU mismatch [S5] [C7]

1. **Authentication resolution** (pure `protocols/ospf/auth.ts` `ospfAuthOf(cfg, port)`): the interface line
   (`ip ospf authentication [message-digest|null]`) wins over the area line (`area <a> authentication
   [message-digest]`); `null` forces none; absent both, none. Type 1 sends the key (`ip ospf authentication-key`,
   cut to 8 bytes with `ospfAuthKeyTooLong`) in the header **in clear** (a teaching point, like PAP). Type 2 sends
   `0(2) keyId(1) 16(1) cryptoSeq(4)` in the header, checksum 0, and a 16-byte keyed-MD5 trailer (RFC 2328 D.4.3) with
   the youngest `ip ospf message-digest-key <id> md5 <key>`. `cryptoSeq` = ⌊sim now / 1 s⌋, the **simulation clock**
   (not the time since the process started): it is non-decreasing across `clear ip ospf process` and reloads within a
   world, deterministic, and draws no rng, so a restarted router is not refused for a dead interval (RFC 2328 D.5 keeps
   the neighbour's last sequence until the neighbour goes Down); a received sequence lower than the neighbour's last
   is refused.
2. **Every packet type is checked** before dispatch, beside the area check of the receive path (`ospf.ts:~1859`). A
   failure drops the packet with reason `other` and an original detail (type mismatch, key mismatch, unknown key id,
   digest mismatch); a refused **hello** also sets the interface row's `rejected` reason (the S1 canvas chip shows it)
   and writes the `ip ospf hello` debug line; other packets write `ip ospf packet`. A key changed after Full therefore
   drops the adjacency when `dead` expires (`runFor`).
3. **No key byte leaks.** With type 2 neither key appears in any PDU byte; with type 1 the key appears (by design).
4. **MTU** [C7]. The DBD carries the interface's IP MTU (`ip mtu` ?? the port MTU). On receipt (RFC 2328 §10.6), a DBD
   whose MTU exceeds the receiving interface's IP MTU is discarded unless `ip ospf mtu-ignore` is set, with the `ip ospf
   adj` debug line ("its database description MTU … is larger than this interface's …", original wording). The
   lower-MTU router L rejects every DBD from the higher-MTU router H, and the outcome **depends on the router ids**
   (RFC 2328 §10.6–10.8):
   - **L has the higher router id** (L is master): H accepts L's initial DBD, becomes slave and goes to Exchange; L stays
     in ExStart. `show ip ospf neighbor` shows ExStart on one side and Exchange on the other.
   - **H has the higher router id** (H is master): L never accepts H's initial DBD, so it never answers as slave; H never
     receives a DBD with I and MS clear, so it cannot proceed. **Both stay in ExStart.**

   Lab 07's MTU fault fixes the router ids so that the lower-MTU side has the higher id (the first outcome); the
   acceptance row pins both orderings. The stuck ExStart never holds `runToIdle` (P3a rule 19). No new row member: the
   state and the debug line are the evidence (map 01 Q-C7-1). The check is always on (real IOS behaviour, a listed P3
   behaviour change, D7, §4.4); tunnels keep advertising their port MTU.

### 3.3 OSPFv3 beside OSPFv2 [S6]

Setup: R1–R2 GigE `ipv6 ospf network point-to-point`, area 0; R2 Gi0/1 and R3 Gi0/0 on a switch (broadcast), area 0.
Dual-stack: OSPFv2 runs as before; IPv6 prefixes 2001:db8:12::/64 (R1–R2), 2001:db8:23::/64 (the LAN), R1 Gi0/1
2001:db8:1::/64 and R3 Gi0/1 2001:db8:3::/64 (passive). Each interface has an EUI-64 link-local address.

1. **Enablement.** `ipv6 unicast-routing`; `ipv6 router ospf 1` enters `config-rtr`; `router-id` sets the id, else the
   IPv4 rule (highest loopback, then highest interface address) borrows one; with no IPv4 address the process prints
   `ospf6NeedsRouterId` once and stays down; without `ipv6 unicast-routing` it prints `ospf6NeedsUnicastRouting`.
   Interface `ipv6 ospf 1 area 0` enables an interface; one process per device (`ospf6OneProcess`).
2. **Hellos.** From the interface's link-local address to **ff02::5**, hop limit 1, next header 89, the `ospf6`
   header with instance id 0 and the interface id (the port's `ifIndex`, §3.5, stable for the device's life). No
   ifIndex exists in the engine today: the rule of §3.5 is a shared pure helper `ifIndexOf` in `device/if-index.ts`,
   owned by W1a device and used by both [S6] and [S33].
   The hello carries no mask; the checks are area, hello/dead, instance id and the E bit, in that order (the v2 module
   order without mask and subnet). `ipv6.group {join, ff02::5}` on every enabled interface; `ff02::6` only while the
   router is DR or BDR on that interface (`leave` on losing the role).
3. **Adjacency.** The shared engine (D7): the same ISM, NSM, DR election on router ids, DBD master/slave, flooding,
   retransmission and timers as v2. Point-to-point Full at link-up + 1 s + ε; on the LAN the 40 s wait, then DR/BDR.
4. **LSAs.** Each router originates a router-LSA (0x2001, link-state id 0) whose links are
   `{type, metric, ifaceId, nbrIfaceId, nbrRouterId}` (type 1 point-to-point, type 2 transit to the DR's network); a
   link-LSA (0x0008, link-local scope, flooded only on that link) per enabled interface carrying its link-local address
   and its prefixes; an intra-area-prefix-LSA (0x2009) referencing its router-LSA with its global prefixes (the
   point-to-point /64 and its passive LAN). The DR originates the network-LSA (0x2002, link-state id = its interface
   id, the attached router ids) and an intra-area-prefix-LSA referencing it with the LAN prefix. Scope keys: `link:<port>`
   for 0x0008, the area for 0x2xxx, `as` for 0x4005.
5. **SPF.** Vertices `R:<routerId>` and `N:<drRouterId>.<ifaceId>`; the shared `runSpf`; prefixes attached from the
   0x2009 LSAs after the tree is built; next hops are the neighbour's **link-local** address with the outgoing
   interface (from its hello source, confirmed by its link-LSA). `ospf6Routes(…)` is pure and exported through
   `@netforge/engine/pure`.
6. **Routes.** One `ipv6.routes {owner: 'ospfv3', rows}` request per SPF, rows in key order, multipath for `O`, one
   `tableWrite` per changed rib6 row. R1: `O 2001:db8:3::/64 [110/3] via FE80::<R2 Gi0/0>, GigabitEthernet0/0`. The
   `show ipv6 route` legend gains `O`/`OI`/`OE2` **only when an `ipv6 router ospf` section exists** (as the IPv4 legend
   adds OSPF codes only with a `router ospf` section, `show.ts:516-535`); otherwise it is today's constant
   `ROUTE6_CODES_LEGEND` (`cli/handlers/ipv6.ts:174`), so no P1/P2 `show ipv6 route` output changes.
   Timings equal v2's on the same timers: point-to-point routes at link-up + 15 s; the LAN's first SPF at U + 45 s.
   With [S4], ABRs originate inter-area-prefix (0x2003) and inter-area-router (0x2004) LSAs by §3.1's rules and remote
   areas' prefixes are `OI`.
7. **Failure.** As P3a §3.2 step 2: a direct cut withdraws the routes at T and the SPF at T + 5 s installs the
   alternative.
8. **Silence.** Without `ipv6 router ospf`, no next-header-89 PDU, no ff02::5/6 join, no `ospf6-*` row; the
   `IPV6_UPPER` row is inert. The `ipv6.routes` and `ipv6.group` paths of `ipv6.ts` run only when a request arrives, so
   every P1/P2 IPv6 world keeps its bytes (the l3 item proves it with the P1, P2 and P3 digest shards, ⚑).

### 3.4 Backing up a configuration over TFTP; an image upgrade; password recovery [S29] [S30] [S31]

**The `tftp` field table** (RFC 1350; display and filter fields `tftp.opcode`, `tftp.file`, `tftp.mode`, `tftp.block`,
`tftp.len`, `tftp.error`):

| Key | Type | In | Meaning |
|---|---|---|---|
| `opcode` | u16 | all | 1 RRQ, 2 WRQ, 3 DATA, 4 ACK, 5 ERROR, 6 OACK (RFC 2347) |
| `filename` | string | RRQ, WRQ | NUL-terminated on the wire |
| `mode` | string | RRQ, WRQ | `octet` only; any other mode is answered ERROR 0 (original text) |
| `tsize?` | u32 | RRQ, OACK | RFC 2349 transfer size option (`tsize` NUL value NUL): 0 in a request, the file's size in the OACK; the only option modelled (display and filter field `tftp.tsize`) |
| `block` | u16 | DATA, ACK | DATA from 1; ACK 0 answers a WRQ or an OACK |
| `data` | bytes | DATA | ≤ 512 bytes; a shorter block (0 bytes included) ends the transfer |
| `errorCode` | u16 | ERROR | 0 undefined, 1 file not found, 2 access violation, 3 disk full, 4 illegal operation, 5 unknown transfer id, 6 file exists, 8 option refused (RFC 2347) |
| `errorMsg` | string | ERROR | original wording |

**Constants and timers** (`protocols/tftp.ts`; P3a rule 19): `TFTP_BLOCK_BYTES = 512`; `TFTP_RETRANSMIT_NS = 2 s`, a
one-shot timer `tftp-rxmt:<token>` armed only while that transfer has an unacknowledged packet; `TFTP_RETRIES = 5`
(the sixth silence ends the job with `tftpTimeout`: a dead server ends a job 12 s after its first packet);
`TFTP_SERVER_SESSIONS = 8` per device (more are answered ERROR 0); a transfer of more than 65 535 blocks is refused
before it starts. An idle server arms nothing.

**Transfer ids.** The client sends from an ephemeral port (udp's deterministic allocator) to port 69; the server
answers from a fresh ephemeral port (the RFC transfer id) and both sides lock to it; a packet from another port draws
ERROR 5 and aborts nothing.

1. **Backup.** On R1, `copy running-config tftp:` prompts "Address or name of remote host []?" and "Destination
   filename [r1-confg]?" (original wording; the default is the hostname in lower case plus `-confg`); the URL form
   `copy running-config tftp://10.0.0.100/r1-confg` skips the prompts. R1 sends WRQ; SRV1 (`service tftp on`, an
   NF-SERVER) answers ACK 0 from a new port; R1 sends DATA 1…n (the running configuration's text as bytes, n =
   ⌊length/512⌋ + 1), each acknowledged before the next (lock-step). SRV1 writes `files:r1-confg` through the storage
   action (create or overwrite). R1 prints one `!` per block and the byte count and seconds (original wording);
   `tftp.result {ok: true, bytes, blocks}` closes the CLI job.
2. **A lost block.** The sender of the unacknowledged packet retransmits it after 2 s; the receiver re-acknowledges a
   duplicate DATA and never writes it twice.
3. **Restore.** `copy tftp: running-config` sends RRQ, receives the file, and applies it line by line through the
   `configure` action with `origin {via: 'tftp'}`: a **merge**, as on real devices. `copy tftp: startup-config`
   replaces the startup configuration text.
4. **A switch.** SW1's transport is dormant (D22). The copy job holds it awake through `ext.ipv4.transportHold {owner:
   'tftp', key: <token>, hold: true}` for the job's lifetime and releases it at the end; the switch is dormant again
   afterwards (a probe to a closed port draws protocol unreachable again).
5. **Flash.** Routers and switches have `flash:` (capacity `DeviceModel.storage.flashBytes`) and `nvram:` (the virtual
   `startup-config` only). `dir flash:` lists the **virtual image** first (never stored, never exported), then user
   files, then the free bytes (capacity − the image's nominal size − the files, each file counted at its
   `nominalBytes` when it has one, else its length). `copy running-config flash:<f>`, `delete flash:<f>`, `show flash:`
   and `show file systems` follow; `tftp-server flash:<f>` serves one flash file. **The flash-full check before the
   first block:** a local copy (`copy running-config flash:`) knows its size; `copy tftp: flash:` (the only copy whose
   RRQ carries an option) sends its RRQ with `tsize 0`, every NetForge server answers an OACK with the size, and the
   client checks the capacity against it. The image header arrives only with DATA 1, so for a file whose name ends
   `.bin` the check counts `tsize × IMAGE_TRANSFER_SCALE` (the nominal size the header will carry) and `tsize`
   otherwise. A copy that does not fit answers the OACK with ERROR 3 "disk full" and prints `flashFull`; no DATA
   moves. (A server that ignores the option and sends DATA 1 directly is checked as blocks arrive and aborted with
   ERROR 3 at the first block that would overflow, as real IOS does.)
6. **Export.** A user file on flash is written in schema 1.4 (`TopologyFile.fs: 'flash'`) and survives export, reload
   and the lab clone; a world with no flash file still exports 1.3 (P3), 1.2 or 1.1 byte-identically.
7. **An image upgrade** [S30]. SRV1 holds `nf2900-15.9.bin` as a 1.4 file with `nominalBytes` 40 MB (41 943 040) and
   content of ⌈nominal / 1024⌉ = 40 960 bytes: the 16-byte image header, then a fixed filler. `copy tftp: flash:` moves
   exactly those bytes in **81 DATA blocks (80 full and an empty final block**, RFC 1350: a transfer whose length is a
   multiple of 512 ends with a 0-byte block); `accept.p3c.image` computes both numbers from the constants. R1's storage
   reads the header and stores `nominalBytes` in the file's metadata (§2.9), so `dir`, the capacity check and the 1.4
   export see 40 MB. `verify /md5 flash:<f>` prints the real MD5 of the stored bytes. `boot system flash:<f>` (a
   configuration line) chooses the image at the next reload; a missing image halts in ROMMON. After the
   reload `show version` names the new version and image — **in P3-profile worlds only**, together with
   "Configuration register is 0x2102"; P1/P2 `show version` is unchanged (D10). Behaviour is identical across versions
   (a fidelity row).
8. **Password recovery** [S31]. A console session sends a break (the terminal's "Send break" button or Ctrl+Break →
   the `cliBreak` journal op) **during the boot window** (power-on to boot completion, `DeviceModel.bootNs`). The router
   halts in ROMMON (no process runs, no port comes up; prompt `rommon 1 >`). `confreg 0x2142` stores the register
   (persistent across power-off, like the file store); `reset` or `boot` boots; with bit 0x40 set the startup
   configuration is ignored. The learner then `copy startup-config running-config`, sets a new `enable secret`,
   `config-register 0x2102`, `copy running-config startup-config`; `show version` says the register "will be 0x2102 at
   the next reload" (original wording). `config-register` is an immediate command in global configuration mode that
   writes the persistent register; it is not stored as a configuration line and never appears in `show
   running-config` (D10). A break on a vty session prints `breakNotOnVty`; a break outside the window does nothing.
   The register is exported (`TopologyDevice.nvram`, 1.4) only when it is not 0x2102.

### 3.5 SNMP v2c polling and traps; SPAN to an analyser [S33] [S34]

**The `snmp` field table** (RFC 3416 over a BER subset; display and filter fields `snmp.version`, `snmp.community`,
`snmp.pdu`, `snmp.request_id`, `snmp.error_status`, `snmp.error_index`, `snmp.varbinds`, `snmp.name`, `snmp.value`):

| Key | Type | Meaning |
|---|---|---|
| `version` | u8 | 1 = v2c; 3 = v3 [C23]; 0 = v1, decoded for display only (the agent refuses it, D10) |
| `community` | string | v2c only; in clear on the wire (a teaching point) |
| `pdu` | enum | `get` 0xA0, `getnext` 0xA1, `response` 0xA2, `set` 0xA3, `getbulk` 0xA5, `trap` 0xA7 (SNMPv2-Trap), `report` 0xA8 [C23] |
| `requestId` | i32 | |
| `errorStatus` | u8 | 0 noError, 1 tooBig, 5 genErr, 6 noAccess, 7 wrongType, 10 wrongValue, 16 authorizationError, 17 notWritable |
| `errorIndex` | u8 | 1-based varbind index |
| `nonRepeaters`, `maxRepetitions` | u8 | getbulk only, in the error fields' positions |
| `varbinds` | list | `{oid, type, value}`; exceptions `noSuchObject` 0x80, `noSuchInstance` 0x81, `endOfMibView` 0x82 |

BER types: INTEGER, OCTET STRING, NULL, OBJECT IDENTIFIER, SEQUENCE, IpAddress 0x40, Counter32 0x41, Gauge32 0x42,
TimeTicks 0x43, Counter64 0x46; definite lengths, short and long form. A malformed message decodes with `malformed:
true` and the agent drops it.

**The MIB subset** (`automation/mib/model.ts`, pure data with readers, mirroring `automation/yang/model.ts`; every OID is
an IETF standard OID):

| Group | Object | OID | Type | Access | Source |
|---|---|---|---|---|---|
| system | sysDescr.0 | 1.3.6.1.2.1.1.1.0 | octets | ro | original text naming the NF model and NF-OS version |
| | sysObjectID.0 | 1.3.6.1.2.1.1.2.0 | oid | ro | 1.3.6.1.4.1.32473.1.<model index> (RFC 5612 documentation number) |
| | sysUpTime.0 | 1.3.6.1.2.1.1.3.0 | timeticks | ro | centiseconds since boot completion |
| | sysContact.0 | 1.3.6.1.2.1.1.4.0 | octets | rw | `snmp-server contact` |
| | sysName.0 | 1.3.6.1.2.1.1.5.0 | octets | rw | `hostname` |
| | sysLocation.0 | 1.3.6.1.2.1.1.6.0 | octets | rw | `snmp-server location` |
| interfaces | ifNumber.0 | 1.3.6.1.2.1.2.1.0 | integer | ro | |
| ifTable (`1.3.6.1.2.1.2.2.1.<col>.<ifIndex>`) | ifIndex (1), ifDescr (2), ifType (3: 6 Ethernet, 22 serial, 24 loopback, 53 virtual), ifMtu (4), ifSpeed (5, gauge, capped at 2³²−1), ifPhysAddress (6), ifAdminStatus (7, **rw**: 1 up, 2 down), ifOperStatus (8), ifInOctets (10), ifInErrors (14), ifOutOctets (16), ifOutErrors (20) | | | | the port views and counters |
| ifXTable | ifName | 1.3.6.1.2.1.31.1.1.1.1.<ifIndex> | octets | ro | the short port name |
| ip | ipForwarding.0 | 1.3.6.1.2.1.4.1.0 | integer | ro | 1 when the device routes, else 2 |
| traps | snmpTrapOID.0 | 1.3.6.1.6.3.1.1.4.1.0 | oid | — | coldStart .1.3.6.1.6.3.1.1.5.1, linkDown .5.3, linkUp .5.4, authenticationFailure .5.5 |

`ifIndex`: physical ports 1…n in the model's port order; virtual interfaces (SVIs, loopbacks, tunnels, subinterfaces)
from n + 1 in the order of first creation since boot (the shared pure helper `ifIndexOf`, `device/if-index.ts`, W1a
device, also used by [S6]). Counters are Counter32 and wrap. `ifType` uses 53 (propVirtual) for every virtual
interface, where IANA has 131 (tunnel) for tunnels and 135 (l2vlan) for subinterfaces: a listed simplification
(CATALOG fidelity row). A GET of an unknown object answers `noSuchObject`/`noSuchInstance`, and a GETNEXT past the
last object answers `endOfMibView` (§2.4 `SnmpValue`), which ends a walk.

1. **Enable.** `snmp-server community NMS-RO ro 10` on R1 wakes the agent (on a switch it also wakes the dormant
   transport, D22). `snmp-server location`, `contact` set the system objects.
2. **Poll.** From NMS (an NF-SERVER), `snmpwalk -v2c -c NMS-RO 10.0.0.1 1.3.6.1.2.1.2.2.1.2` sends GetNext requests
   (the walk is client-side) and prints one line per interface (original layout). The agent checks the community (an
   unknown community is answered by nothing; with traps enabled it sends `authenticationFailure`), then the ACL through
   `acl.check` (a deny is silently dropped), then serves: GET by exact OID, GETNEXT in lexicographic order, GETBULK
   capped at `SNMP_MAX_BULK = 32` varbinds. The manager's request times out after 2 s and retries twice (capped one-shot
   timers, rule 19).
3. **Set.** With an `rw` community, SET of sysName, sysContact, sysLocation or ifAdminStatus becomes one `configure`
   action with `origin {via: 'snmp'}` (`hostname …`, `snmp-server …`, `shutdown`/`no shutdown`); any other object
   answers notWritable, a wrong type wrongType.
4. **Traps.** `snmp-server host 10.0.0.100 version 2c NMS-TRAP` plus `snmp-server enable traps snmp linkdown linkup
   coldstart` sends SNMPv2-Trap PDUs to UDP 162: varbinds sysUpTime.0, snmpTrapOID.0, then ifIndex, ifAdminStatus and
   ifOperStatus for link traps. coldStart only at boot completion and only when a host is configured. Traps are
   unacknowledged. NMS with `service snmptrap on` (the `snmp-manager` daemon) writes one `snmp-traps` row per trap
   (bounded at 64, oldest dropped), which a lab grades live (`table snmp-traps`, rule 20).
5. **SPAN** [S34]. On SW1, `monitor session 1 source interface Fa0/1 both` and `monitor session 1 destination
   interface Fa0/24`. Every frame received on Fa0/1 (rx, as received, before any filtering) and every frame sent on it
   (tx, as sent) is cloned with `meta.mirror: true` and a new PduId and queued on Fa0/24's egress like any frame (an
   oversubscribed destination drops copies `queue-full`). Fa0/24 forwards nothing it receives (`span-destination`),
   leaves spanning tree, and counts the copies in its output counters. A source VLAN copies rx only (stricter than
   Catalyst 2960/3560 VSPAN, which accepts `both`: a CATALOG deviation row). Without
   `encapsulation replicate` copies leave untagged. At most two local sessions per switch (catalog data). Copies draw
   PduIds only when a session is configured.

### 3.6 IPv6 access lists and the implicit ND tail [S11]

This is the content of the lost "ACL map §3": the contract blocks are §2.4 and §2.6; the rules are here.

- **Entries.** `ipv6 access-list <name>` (named only) holds `[sequence <n>] permit|deny <proto> <src> [<ports>] <dst>
  [<ports>] [established] [<icmp6-name>|<type> [<code>]] [log]`, plus `remark` and `no sequence <n>`; `<proto>` is
  `ipv6`, `tcp`, `udp`, `icmp` or a number; `<src>`/`<dst>` is `any`, `host <a>` or `<prefix>/<len>`. ICMPv6 names
  include `nd-ns`, `nd-na`, `router-solicitation`, `router-advertisement`, `echo-request`, `echo-reply`. Sequence
  numbers start at 10, step 10. `core/acl6.ts` holds `parseAcl6Entry`, `acl6EntryText`, `readAcls6`, `tupleOf6` (walks
  extension headers as ip-upper does; a non-initial `ipv6-frag` carries no L4 fields), `evaluateAcl6` and `lintAcl6`
  (adds `nd-blocked`: an explicit deny that matches ICMPv6 135/136 before any permit).
- **The implicit tail**, after the last explicit entry, in this order: `permit icmp any any nd-na`, `permit icmp any
  any nd-ns`, `deny ipv6 any any`. Each is a row (`implicit: 'nd-na' | 'nd-ns' | 'deny'`, keys `aclKey(6, list,
  'nd-na')` …) and counts its matches. RS and RA are **not** in the tail.
- **Where it runs.** `ipv6 traffic-filter <name> in|out` (one per direction). Inbound: before `deliverLocal` and
  `forward`, so it also filters ND addressed to the router. Outbound: after the hop-limit decrement and before
  `nd.sendVia`, transit traffic only. The hooks exist only while a `traffic-filter` line is stored and the model runs
  `acl`; `ipv6.resume {after: 'acl-in'}` continues a permitted packet.
- **A deny** drops `acl-deny` with a family-6 `DropRule` and answers ICMPv6 type 1 code 1 (administratively
  prohibited) from the ingress interface's global address, **one rate gate per family** (500 ms each; real devices
  limit them separately, map 02 Q2).

Walk-through. R1 dual-stack: Gi0/0 2001:db8:10::1/64 (PC1 ::10), Gi0/1 2001:db8:20::1/64 (SRV ::100, `http-server`).
`ipv6 access-list NO-WEB6` with `deny tcp host 2001:db8:10::10 host 2001:db8:20::100 eq www` and `permit ipv6 any any`,
applied `ipv6 traffic-filter NO-WEB6 in` on Gi0/0.

1. PC1's HTTP SYN matches row 10: drop `acl-deny`, rule key `aclKey(6, 'NO-WEB6', 10)`, ICMPv6 1/1 back to PC1; the
   SYN retries draw at most one ICMPv6 per 500 ms. PC1's ping6 to SRV passes row 20.
2. Replace the list's entries by a single `deny ipv6 any any`. PC1's next neighbour solicitation to R1 matches the
   explicit row 10 (the implicit ND permits come after it): it is dropped and counted on row 10. PC1's neighbour entry
   for R1 goes stale, its probe fails, and the ping fails. `lintAcl6` reports `nd-blocked`. Inserting `sequence 5 permit
   icmp any any nd-ns` and `sequence 6 permit icmp any any nd-na` restores it.
3. With only `permit tcp any any eq 22` (no explicit deny), ND still works through the implicit tail; the tail's
   `nd-ns` and `nd-na` rows count.
4. `ipv6 access-class VTY6 in` on `line vty 0 4`: an SSH login over IPv6 from a source the list denies is refused after
   the handshake and writes a `refused` `vty-logins` row; the acl row records `lastIface: 'vty'`. The hidden family-6
   listener exists only under D8's three conditions.

### 3.7 The access layer: IP source guard, storm control, ARP ACLs [S15] [S16] [S14]

The eth-switch per-frame order on an access port becomes: … 7 port security, 7b DHCP snooping, 7c DAI, **7d IP source
guard**, then forwarding; **storm control** is checked at ingress before learning. One owner holds eth-switch for all
three items (l2).

- **IP source guard** (`protocols/l2/source-guard.ts`, pure `decideSourceGuard`). On a port with `ip verify source
  [port-security]` in a VLAN with snooping on: IPv4 frames whose source address equals an unexpired binding's address for
  (VLAN, port) pass; with `port-security` the Ethernet source must also equal the binding's MAC. Exempt: DHCP client
  messages (UDP 68 → 67, any source), ARP (DAI's job) and non-IPv4. Everything else drops `ip-source-guard` with a
  `DropRule` pointing at the line. Without snooping on the VLAN nothing is filtered and a debug line says why. The
  `port-security` option is refused without `switchport port-security` (`ipsgNeedsPortSecurity`). `show ip verify
  source [interface <if>]` prints interface, filter type (ip / ip-mac), state, address, MAC and VLAN (original layout).
- **Storm control** (`protocols/l2/storm-control.ts`, pure). Lines `storm-control broadcast|multicast|unicast level [pps|
  bps] <rise> [<fall>]` (fall defaults to rise) and `storm-control action shutdown|trap`. A window is one simulated
  second `[k s, (k+1) s)`, evaluated lazily on the first frame of the class after its boundary; no timer. A percent
  level is in hundredths (`level 1.00` = 100) of the port's **operational** speed: threshold bits per window =
  ⌊speedBps × level / 10 000⌋; frame bits are the frame's wire length (with FCS, without preamble) × 8; `pps` counts
  frames. Unicast counts every unicast frame (the real behaviour). Within a window, the frame that would push the
  window's count above `rise` and every later frame of that class in the window are dropped `storm-control` (state
  `blocking`). At the next boundary, if the previous window's offered count (dropped frames included) was ≤ `fall`, the
  state returns to `forwarding`; otherwise the whole new window drops. `action shutdown` err-disables the port on the
  first exceedance (cause `storm-control`; `errdisable recovery cause storm-control` re-enables it); `action trap`
  also emits one log per exceedance (severity 3, facility `STORM_CONTROL`, original wording). The row is written
  **once when the line is stored or the port comes up** (state `forwarding`, `current` 0, `dropped` 0, `windowStart` =
  now; this is what lab 20 grades with no traffic), then on a state change and once per window that had drops, never
  per frame (rule 20). Windows are lazy, so after traffic stops `current`, `dropped` and `state` keep the last closed
  window's values; lab text and graders never read them as live. With no line on any port the per-frame
  cost is one Map lookup (the loop-storm budget). `show storm-control [<if>] [broadcast|multicast|unicast]` prints
  interface, filter state, upper, lower, current (original layout).
- **ARP ACLs and `validate`** (`protocols/l2/arp-acl.ts`, pure; `decideArpInspection` order, IOS order): (1) rate limit;
  (2) trusted port; (3) `ip arp inspection validate src-mac|dst-mac|ip` checks (src-mac: Ethernet source ≠ sender MAC;
  dst-mac: a reply whose Ethernet destination ≠ target MAC; ip: sender address — and target address for replies — is
  0.0.0.0, broadcast or multicast); (4) the VLAN's ARP ACL (`ip arp inspection filter <n> vlan <list> [static]`): an
  explicit permit forwards, an explicit deny drops, no match falls through to bindings unless `static`, in which case the
  implicit deny drops; (5) bindings, as today. `validate` is one stored line whose keyword set is replaced. The
  no-ACL, no-validate path is byte-identical to today (`l2.arp-inspection.test.ts` pins it); the new counters are OBM
  columns written once nonzero.

### 3.8 An honest MTU: DF and "fragmentation needed" [S17a]

1. **Making a big packet.** `ping <target> size <36-18024> [df-bit] [repeat <n>]` on NF-OS (size = the IPv4 total
   length); `ping -l <size> [-f] <target>` on host shells (size = the ICMP payload, as on PCs). The size is capped so
   one echo never exceeds 18 024 bytes.
2. **The check** at the single IPv4 egress, `arp.sendVia`, before resolution, on **non-tunnel ports only**: the egress
   MTU is the interface's `ip mtu` if set, else the port MTU (a subinterface uses its parent's; serial and PPP ports use
   the port MTU). Tunnel sends are already handed to gre (`protocols/arp.ts:389-393`), which keeps D15's fallback and
   its own detail (`gre.ts:102-103`). A datagram that fits takes today's path unchanged: a pure comparison with no
   event, debug or counter on the fast path, and no change to IPv4 id assignment.
3. **Too big, DF set:** drop `mtu-exceeded` (detail "larger than the MTU of <if> (<n> bytes) and Don't Fragment is set",
   original wording) and `icmp.error {type 3, code 4, param: <mtu>, inPort}` back to the source (RFC 1191 next-hop MTU).
   A host's own oversize DF ping fails locally with the same reason and no ICMP.
4. **Too big, DF clear:** drop `mtu-exceeded` "…fragmentation is not simulated" — the fallback tunnels have used since
   S18 — and no ICMP (a real device would fragment; a listed deviation until [S17b]).
5. **The ACL fragment rule** (core, no traffic needed): when `tuple.fragment === 'non-initial'` and an entry has L4
   conditions, a permit matches on its L3 part and a deny is skipped (trail `failed: 'fragment'`); the `fragments`
   keyword matches non-initial fragments only. `tupleOf` sets `fragment` from `fragOffset`.
6. **No world moves.** No P1/P2/P3 world produces a datagram above its egress MTU (pings are 100 bytes, flows ≤ 1500,
   TCP MSS 1460, jumbo ports exist only where L2-forwarded). The item proves it with a one-off scan: every golden world
   run with an assertion inside the new check that fails if any datagram would exceed its MTU.

### 3.9 A phone learns its voice VLAN; a recursive tunnel holds [S35] [S36a]

- **Voice VLAN.** P3 world: SW1 Fa0/2 `switchport access vlan 10`, `switchport voice vlan 30`; a phone on Fa0/2 and PC1
  behind the phone. SW1's CDP (on by default in P3) on Fa0/2 now carries TLV 9 `voiceVlan 30` (only on ports with a
  voice VLAN). The phone's transparent path classifies CDP and LLDP frames arriving on its uplink to its own daemons and
  no longer bridges them to the PC port. Its `cdp` daemon wakes on the first CDP heard and advertises capabilities `H P`
  on the uplink every 60 s; the neighbour row records `voiceVlan 30`; the phone's eth-switch `voiceUplink` reads the
  typed `voice vlan` line first, else the learned value; the phone tags its own frames VLAN 30 and sends `dhcp.restart
  {iface}` so its DHCP client restarts and leases in VLAN 30. PC1 stays untagged in VLAN 10 and receives no CDP. With
  LLDP: SW1 sends the Network Policy TLV only to a neighbour that advertised the MED capability; the phone advertises
  it once it has heard LLDP. In a P2 world SW1 sends no CDP and the phone stays silent (P2 bytes).
- **Recursive routing hold** (P3a §3.10 step 6). When the tunnel destination's LPM egress becomes the tunnel itself,
  Tunnel0 goes down `recursive-routing` with its log (built in S18) and gre arms the **periodic** `recursion-hold:<port>`
  (10 s); while armed, RIB-change evaluations skip that tunnel (otherwise the flap happens inside one dispatch). At
  expiry gre evaluates once: up if the LPM now leaves through a non-tunnel interface, else down again and the hold
  re-arms; one log per transition. A configuration or link change that resolves the recursion stops the timer. Under
  `runFor` the classic flap (up, routes learned through the tunnel, down, …) is bounded and periodic, so `runToIdle`
  still returns.

### 3.10 Grading helpers: a quiet settle and a wire assertion [S39] [S38]

- **Quiet settle.** `runToIdle(cap, {quiet: {windowNs}})` first runs exactly today's `runToIdle` up to a smaller cap
  (`LAB_CLONE_IDLE_FIRST_EVENTS`, chosen so that every lab world in `lab-status.p2` and `lab-status.p3` idles inside
  it); only a world still busy then switches to the quiet rule: stop when a window of `QUIET_WINDOW_MS = 60 000`
  simulated ms passes with no lab-relevant event (`configChange`, `tableWrite`, `portState`, `assocState`) **and** no
  pending non-periodic event other than frame and link events (no one-shot timer, boot or fault). `RunStats.stopped` is
  `'quiet'`. The cap stays the backstop. The P2 EtherChannel wrong answer then grades in a bounded, deterministic
  number of events.
- **`packetSeen`.** The checker (`sim/lab-checks/capture.ts`) settles the clone, opens a capture through the clone's own
  hub on the resolved points, runs the drive, decodes the records (capped at 10 000) and evaluates the compiled filter;
  the detail names the count and the first matching (or offending) frame. A filter that does not compile is an
  authoring error refused when the lab loads (`lab-schema`). OSPF hellos and CDP are background: an assertion about
  them sets `includeBackground`.

---

## 4. Determinism, timers and silence

### 4.1 Randomness, integers and caps

- **No new rng stream** and no new draw on an existing stream. Every P3c sequence number (OSPF `cryptoSeq`, TFTP ports,
  SNMP request ids, ifIndex) is derived from state, the clock or the existing deterministic allocators.
- Integers only on every wire and in every row: storm-control levels in hundredths of a percent; Counter64 crosses the
  codec boundary as decimal text; image sizes as integers with `IMAGE_TRANSFER_SCALE`.
- Caps (rule 19): TFTP retries 5 per packet and 8 server sessions; SNMP manager retries 2, bulk 32 varbinds, 64 trap
  rows; `ping size` ≤ 18 024; `packetSeen` ≤ 10 000 decoded records; the `convergence` window ≤ 300 000 ms; SPAN ≤ 2
  local sessions per switch.

### 4.2 Timers

| Owner | Timer | Kind | Armed |
|---|---|---|---|
| ospf, ospfv3 | the P3a OSPF timers (hello, wait, dead, rxmt, `lsa-gen`, `spf`), on the shared engine | as P3a | as P3a |
| gre [S36a] | `recursion-hold:<port>` 10 s | periodic | while a tunnel is down `recursive-routing` |
| gre [C17] | `gre-keepalive:<port>` (`keepalive <s> <n>`, default 10 s / 3) | periodic | while a GRE-mode tunnel has `keepalive` |
| tftp [S29] | `tftp-rxmt:<token>` 2 s | one-shot, ≤ 5 retries | while a transfer has an unacknowledged packet |
| snmp-manager [S33] | `snmp-req:<token>` 2 s | one-shot, ≤ 2 retries | while a request is outstanding |
| l2 [S16] | none (lazy windows) | — | — |
| l2 [S16] | `errdisable:<port>` (existing) | one-shot | after a `storm-control` err-disable with recovery on |
| ipv4 [S17a] | none | — | — |

### 4.3 Silence: what turns each new behaviour on

| Behaviour | The line (or event) that turns it on |
|---|---|
| ospfv3 [S6] | `ipv6 router ospf <pid>` plus `ipv6 ospf <pid> area <a>` on an interface |
| OSPF authentication [S5] | `ip ospf authentication …` or `area <a> authentication …` |
| OSPF DBD MTU check [C7] | always on (real IOS behaviour); the DBD MTU changes only with `ip mtu` (today's value otherwise). It refuses a peer that advertises a larger MTU, so a jumbo-port data-centre switch peering a 1500-byte router now sticks in ExStart (a listed P3 change, §4.4) |
| summaries [S4] | an up area-0 interface plus one more area |
| IPv6 ACL hooks [S11] | `ipv6 traffic-filter` (interface) or `ipv6 access-class` (vty) |
| IP source guard [S15] | `ip verify source` |
| storm control [S16] | `storm-control … level …` |
| ARP ACL / validate [S14] | `ip arp inspection filter …` / `ip arp inspection validate …` |
| MTU check [S17a] | always evaluated; acts only on a datagram above its egress MTU (none in any shipped world) |
| phone discovery [S35] | hearing CDP or LLDP on the phone's uplink |
| CDP mismatch logs [S41] | a received CDP frame whose native VLAN or duplex differs (P3 worlds, or `cdp run`) |
| recursion hold [S36a] | a tunnel going down `recursive-routing` |
| tftp client / server [S29] | a `copy … tftp:` job / `tftp-server …` or `service tftp on` |
| snmp-agent [S33] | `snmp-server community …` (and `snmp-server host` for traps) |
| snmp-manager [S33] | a host-shell `snmp*` job, the app, or `service snmptrap on` |
| SPAN [S34] | `monitor session … destination …` with a source |
| ROMMON [S31] | a console break inside the boot window |
| playbook [C22] | the host-shell `playbook` command |

A managed switch's transport stays dormant (D22) until a P3 or P3c service line is configured on it.
`DORMANT_TRANSPORT_OWNERS` (`protocols/ip-upper.ts:161-182`) holds `{service, context, lines}` line-prefix matchers,
not process names; it gains `{service: 'tftp', lines: [['tftp-server']]}` and `{service: 'snmp-agent', lines:
[['snmp-server', 'community']]}`. `snmp-server host` alone does not wake the transport. A copy job holds it through
`transportHold`; the doc comment of `SANCTIONED_EXT_REQUESTS` (`contracts/process.ts:449-463`), which names vty-client
as the `transportHold` user, gains tftp.

### 4.4 What a P3 world does differently after P3c (by design)

No traffic, trace or snapshot byte changes in a P1 or P2 world. One **visible** P1/P2 change, with no golden move:
`show errdisable recovery` prints `ERRDISABLE_SHOWN_CAUSES` (`ERR_DISABLE_CAUSES` minus `fault`, no profile filter,
`cli/handlers/errdisable.ts:23`), so appending `storm-control` [S16] adds a line to its output on P1/P2 switches too
(the digest harness never types it, `p2-digests.harness.ts:33-34`; the P3a precedent for a listed visible change).

In a P3 world, only these change, each listed in §9.5 with the worlds it reaches:
- [S4] a router with an up area-0 interface and another area originates summaries (lab 07's unsolved world, lesson 05's
  experiment, user worlds); the router-LSA's B bit follows the new rule (D7: a two-area router whose area-0 interface
  is down, or one with two non-backbone areas, loses B);
- [C7] the always-on DBD MTU check: two OSPF neighbours whose MTUs differ (a jumbo-port data-centre switch and a
  1500-byte router) no longer reach Full (real behaviour; product-owner question 4; a CATALOG row); no golden world has
  such a pair;
- [S35] a switch with `switchport voice vlan` adds TLV 9 to its CDP on that port; a phone answers CDP and stops
  bridging it;
- [S41] a native-VLAN or duplex mismatch between CDP neighbours logs;
- [S30] [S31] `show version` gains the image and register lines;
- R63 (d) a debug or log line that starts mid-line gets a leading newline.

---

## 5. Canonical config lines and their consumers

Lines are stored by the config rules (W1/W2 cli) and read by the named consumer. "Exec" rows are commands, not lines.

| Item | Mode | Line | Consumer |
|---|---|---|---|
| [S4] | exec | `show ip ospf border-routers`; `show ip ospf database summary\|asbr-summary` | cli (ospf view) |
| [S5] | router | `area <a> authentication [message-digest]` | ospf |
| [S5] | interface | `ip ospf authentication [message-digest\|null]`; `ip ospf authentication-key <k>` (secret); `ip ospf message-digest-key <1-255> md5 <k>` (secret, multi by id) | ospf |
| [C7] | interface | `ip mtu <68-1500>` (routed Ethernet, subinterfaces, serial; tunnels keep their range); `ip ospf mtu-ignore` | ospf, cli, [S17a] ipv4 |
| [S6] | global | `ipv6 router ospf <pid>` (section, `config-rtr`) with `router-id`, `passive-interface [default] <if>`, `auto-cost reference-bandwidth <m>`, `maximum-paths <n>` | ospfv3 |
| [S6] | interface | `ipv6 ospf <pid> area <a>`; `ipv6 ospf cost\|priority\|hello-interval\|dead-interval <n>`; `ipv6 ospf network point-to-point\|broadcast` | ospfv3 |
| [S6] | exec | `show ipv6 ospf [neighbor [detail]\|interface [brief\|<if>]\|database [router\|network\|link\|prefix\|inter-area prefix]]`, `show ipv6 route ospf`, `show ipv6 protocols`, `clear ipv6 ospf process`; debug `ipv6 ospf adj\|hello\|flood\|spf\|packet` | cli |
| [S11] | global | `ipv6 access-list <name>` (section, `config-ipv6-acl`) with sequenced entries, `remark`, `no sequence <n>` | acl |
| [S11] | interface / vty | `ipv6 traffic-filter <name> in\|out` / `ipv6 access-class <name> in` | acl, ipv6 / vty |
| [S11] | exec | `show ipv6 access-list [<name>]`, `clear ipv6 access-list [<name>]` | cli |
| [S12] | interface | `no ip unreachables` (`ip unreachables` is the stored default) | acl, icmpv4 |
| [S12] | extended entry | `dscp <0-63\|name>`, `precedence <0-7\|name>`, `log-input` | acl, nat, qos |
| [S14] | global | `arp access-list <n>` (section, `config-arp-nacl`); `ip arp inspection filter <n> vlan <list> [static]`; `ip arp inspection validate {src-mac\|dst-mac\|ip}+` | l2 |
| [S15] | interface | `ip verify source [port-security]` | l2 |
| [S16] | interface | `storm-control broadcast\|multicast\|unicast level [pps\|bps] <rise> [<fall>]`; `storm-control action shutdown\|trap`; global `errdisable recovery cause storm-control` | l2 |
| [S17a] | exec / host | `ping <t> [size <n>] [df-bit] [repeat <n>]` / `ping [-l <n>] [-f] <t>` | icmpv4, host |
| [S35] | (none) | learned; the switch's existing `switchport voice vlan <v>` is now advertised | cdp, lldp, eth-switch |
| [S36b] | Tunnel interface | `ipv6 address …`, `ipv6 enable` | ipv6, gre |
| [C17] | Tunnel interface | `keepalive <s> <n>`, `tunnel key <n>` | gre |
| [S29] | exec | `copy running-config\|startup-config tftp:[//host/file]`, `copy tftp:[//host/file] running-config\|startup-config\|flash:[name]`, `copy running-config flash:<f>`, `dir [flash:\|nvram:]`, `show flash:`, `show file systems`, `delete flash:<f>` | cli, tftp |
| [S29] | global / host | `tftp-server flash:<f>` / `service tftp on\|off` | tftp |
| [S30] | global / exec | `boot system flash:<f>` / `verify /md5 flash:<f>` | device boot, cli |
| [S31] | global (immediate, not stored) / rommon | `config-register 0x<hex>` (writes the persistent register; no `ConfigAst` line, never in `show running-config`) / `confreg 0x<hex>`, `reset`, `boot`, `dir flash:` | device |
| [S33] | global | `snmp-server community <s> [ro\|rw] [<acl>]`, `snmp-server location\|contact <text>`, `snmp-server host <a> [traps] version 2c <community>`, `snmp-server enable traps snmp [linkdown] [linkup] [coldstart] [authentication]` | snmp-agent |
| [C23] | global | `snmp-server group <g> v3 noauth\|auth\|priv`, `snmp-server user <u> <g> v3 auth md5\|sha <k> [priv aes 128 <k>]` | snmp-agent |
| [S33] | exec / host | `show snmp`, `show snmp community` / `snmpget\|snmpwalk\|snmpset -v2c -c <c> <host> <oid> [<type> <value>]`, `service snmptrap on\|off` | cli, snmp-manager |
| [S34] | global | `monitor session <1-66> source interface <list> [rx\|tx\|both]`, `… source vlan <v> [rx]`, `… destination interface <if> [encapsulation replicate]`, `no monitor session <n>`; exec `show monitor session [<n>]` | l2, cli |
| [C22] | host (NF-DEVHOST) | `playbook <file> [-i <inventory>]` | script-host |

Every line has a `no` form unless noted. Secrets use `secretToken` and render in the `7` form with `service
password-encryption` (the S19 rule).

---

## 6. Web file map

| File | Owner | Item |
|---|---|---|
| `apps/web/vite.config.ts`, `src/**` import rewrites, `test/bundle.engine-imports.lint.test.ts` | web-shell | bundle split |
| `src/curriculum-loader.ts`, `src/labs/lab-loader.ts` (both **new**; lazy `import()`) | web-learn | bundle split |
| `src/simmode/{FilterChips,BreakpointEditor,SimEventsPanel}.tsx` (VLAN chip; reasons filter) | web-shell | [C32] (b), [S10] |
| `src/timeline/TimelineStrip.tsx` (guards removed) | web-shell | [C32] (c) |
| `src/timeline/ConvergencePanel.tsx`, `timeline/convergence-client.ts` | web-shell | [S8] |
| `src/canvas/overlays/route-path-model.ts`, `canvas/route-path.ts` | web-canvas | [S7] |
| `src/canvas/overlays/neighbours-model.ts`, `canvas/neighbours.ts` | web-canvas | [S26] |
| `src/canvas/overlays/ospf-model.ts` (ABR glyph; v3 family switch) | web-canvas | [S4], [S6] |
| `src/routing/lsdb-model.ts`, `routing/LsaDetail.tsx` (summary kinds) | web-routing | [S4] |
| `src/inspector/AclView.tsx`, `inspector/acl-tester.ts`, `inspector/acl-advisor.ts`, `inspector/acl-impact.ts`, `PacketInspector.tsx` / `Provenance.tsx` ("why it stopped here", permit chips) | web-inspector | [S10], [S23] |
| `src/bridge/worker/acl.ts` (the `aclLists` / `aclEvaluate` handlers) | web-shell | [S10] |
| `src/inspector/ServicesPanel.tsx` (TFTP section) | web-inspector | [S29] |
| `src/terminal/{TerminalPanel,TerminalTab}.tsx` ("Send break", Ctrl+Break) | web-shell | [S31] |
| `src/desktop/apps/SnmpManagerApp.tsx`, `desktop/apps/ApiClientApp.tsx` | web-desktop | [S33], [S27] |
| `src/concept/wan/*`, `concept/yang/*`, `concept/sdn/*` | web-concept | [S22], [S28], [C26] |
| `src/netscope/*` (the SPAN shortcut) | web-inspector (the W3c builder that writes it) | [S34] |
| `src/automation/*` (YAML highlight, "Run playbook") | web-desktop | [C22] |
| `src/gui/commands.ts` (phone panel: "30 (learned by CDP)") | web-desktop | [S35] |
| `src/vocab/*`, `inspector/tabs.ts`, `shared/openDeviceSurface.ts`, `Provenance.DROP_LABEL`, `canvas/markers.ts` | web-inspector | architect W0 stubs |
| `src/store/{types,store,persist}.ts`, `concept/ConceptView.tsx` | web-shell | architect W0 stubs; the persisted-slice migration by [S7] |
| `src/canvas/overlays/registry.ts` (`OverlayId`, `RoutingOverlayToggle`) | web-canvas | architect W0 stubs |

Every new app, tool and panel is a lazy chunk (`React.lazy` / `import()`), never in the main chunk; the bundle lint
test (W0h) fails a non-type import of `'@netforge/engine'` outside `src/bridge/worker/**`.

---

## 7. Module map and build waves

Owners are agents; each file has exactly one. Each item lists **owner — files — delivers — tests**; tests named are the
owner's own (rule 9) and depend only on earlier runs or the owner's own item: **no item depends on work of its own run
or a later one** (the review found three such dependencies; they are resolved by moving the web-desktop [S27]/[C22]
parts to W3c and splitting W5 into W5a and W5b). A pair of same-run items that meet at a seam tests against a fake of the other; the integration is a
W4a acceptance row. Items marked ⚑ are byte-risky (rule 9). Every **run** holds at most six builders (rule 22) and is
followed by its own review, adversarial-verify and fix runs (rule 8) and a checkpoint (rule 23); the lead then runs the
six checks, the digest goldens and, from W0h on, gate G (rules 9, 10, 15). Wave commits go to branch `p3c` only (rule
21).

The plan below places the **recommended plan** (§8.4). An item the product owner does not approve is removed with its
files; an item approved beyond it takes the placement Appendix A gives. Items are named by owner, then item tag.

**Files with one owner and named reviewed edits by others** (rule 18):

| File | Owner | Reviewed additive edits by others |
|---|---|---|
| `contracts/*`, `packages/engine/src/index.ts`, `packages/engine/package.json` (`exports`), `test/port.fixtures.ts`, `test/p3c-approved-items.ts` | architect | W0h sim ([C32] (a): `DemuxSelector.frame` deleted with capwap-wtp's use); W0h web-shell (the `exports` subpath entries); W1a io (`contracts/topology.ts` `schemaIdFor`, R7 precedent); W2a l2 (`ERR_DISABLE_CAUSES`); W3b web-shell (the `sendBreak` `?` removed); the W4b flip (`PROCESS_ORDER`, `CAPABILITY_PROCESSES`, `STAGED_PROCESS_TABLES`, stage constants) |
| `protocols/ospf.ts`, `protocols/ospf/*`, `core/ospf-spf.ts`, `core/ospf6-spf.ts`, `sim/lab-checks/ospf.ts`, `sim/scenarios/ccna3/ospf.ts` | ospf | — (one ospf builder at a time: W1a refactor part 1 → W1c refactor part 2 → W2a [S5]/[C7] → W2b [S4] → W3a1 [S6] → W3c adapter → W5a labs) |
| `protocols/{arp,ipv4,ipv6,ip-upper,icmpv4,icmpv6,nd}.ts` | l3 | W2b ospf (`ipv4.ts:~360` `routeSourceCode` `O IA`, one line); W3c wan ([S36b] the `nd.ts` / `ipv6.ts` tunnel branch, a delimited `// [S36b]` block) |
| `protocols/eth-switch.ts`, `protocols/l2/*` | l2 | W1c media ([C16] the relay accepts `ppp`, one line) — (one l2 builder at a time: W1a pure modules → W2a [S14]/[S15]/[S16] → W2b [S34]/[S35]) |
| `protocols/acl.ts`, `core/acl.ts`, `core/acl6.ts`, `core/acl-placement.ts` | acl (core files: core) | — |
| `protocols/gre.ts` | wan | — |
| `protocols/cdp.ts`, `protocols/lldp.ts` | disc | — |
| `protocols/{tftp,snmp-agent,snmp-manager}.ts`, `protocols/{udp,tcp,dhcp-client}.ts`, `sim/lab-checks/mgmt.ts` (new: facts `storage.file`, `device.imageVersion`, `device.configRegister`) | svc | — |
| `protocols/vty.ts` | svc (vty's P3a owner) | — (W3a1 svc adds `acl.check {family 6}`; named here so vty has one owner in P3c) |
| `protocols/http-client.ts`, `protocols/script-host.ts`, `automation/*` | http + auto | — |
| `sim/run-control.ts`, `sim/simulation.ts`, `sim/grade.ts`, `sim/lab-checks/{core,registry,facts,capture,convergence}.ts`, `io/lab-schema.ts` (validators), `timeline/*` | sim | W1a io (`io/lab-schema.ts` 1.4 topologies); W2b device (`sim/simulation.ts` `cliBreak` journal op); W3a1 svc (`sim/simulation.ts` `HOST_APP_PROCESS` `snmp`); W3b http + auto (`HOST_APP_PROCESS` `http.request`); W3c svc (`sim/grade.ts` `RUNTIME_ONLY_TABLES` gains `snmp-traps`) |
| `io/schema.ts`, `io/migrate.ts` | io | — |
| pdu registry and dispatch table | pdu | — (two pdu runs never overlap) |
| `cli/modes.ts`, `cli/grammar/index.ts`, `cli/handlers/index.ts`, the show and debug registries | architect (W0 stubs only) | none after W0: W0 registers the four modes and one empty grammar, handler, show and debug fragment per W3a builder area; builders edit only their own fragment files (W3a ownership table) |
| `cli/grammar/<area>.ts`, `cli/handlers/<area>.ts`, `cli/config-rules.ts`, `cli/runtime.ts` | cli (one builder per file, W3a ownership table) | — |
| `device/device.ts`, `device/if-index.ts` (new), `device/catalog/*` | device / catalog | architect W0 (`ERR_DISABLE_CAUSE_TEXT`, `GUI_PANEL_SINCE` stubs) |
| `curriculum/ccna3/theory-{a,b,c,d}.ts`, `curriculum/ccna3/lessons.ts` (the `lab:` fields of lessons 08, 09, 30, 31, 39), `curriculum/ccna2/theory-a.ts` (lesson 08's sentence), `objectives.ts`, `sim/scenarios/ccna3/index.ts`, `README.md` counts | course | — |
| `packages/engine/vitest.workspace.ts`, `test/goldens/*` (`lab-versions.json` and `cli-help.p05.json` included), `test/profile-digests.harness.ts` | architect | — (the course builder never edits `lab-versions.json`; the architect re-records it in W5b) |
| `test/staged.world.ts`, `test/inject.ts` | qa | — |

### W0 — decisions, the P3 goldens first, contracts, tiers (architect, qa, product owner)

- **product owner** — the 12 questions of §8.5a; the architect then records the **Approved ids** row (§8.5c). W0 does
  not start until both are recorded. (The architect's rulings of §8.5b are already recorded.)
- **architect, first, alone, before any other change** — from commit cad4ac9 unchanged (D3):
  `test/profile-digests.harness.ts` (the P2 harness generalised; `p2-digests.harness.ts` becomes a wrapper and the four
  P2 shards stay byte-identical), `test/goldens/p3-profile-digests.json` with the shards
  `accept.p3c.p3-digests-templates`, `-labs-a`, `-labs-b`, `-labs-c`, `-guards`; `test/goldens/lab-status.p3.json`
  with `accept.p3c.lab-status-p3`; `test/goldens/p3-lab-exports.json` with `accept.p3c.p3-exports`; and
  `test/goldens/p3c-storm-window.json` (the loop-storm 100 ms window's event count and trace digest, for [S40]). The
  golden headers name the source commit cad4ac9; the shards' world lists are frozen in the golden by lab id (D3). The
  lead commits this change alone, and the W0 wave report names the recording commit.
- **architect** — the contract blocks of every approved item (§2), **types, unions and constants only**, with the
  compile stubs §2 lists (engine and web); `BuildStage 'P3c'`; `TOPOLOGY_SCHEMA_ID_1_4` (constant only, R7);
  `P3C_CTX` / `P3C_DEVICE` spreads; `test/p3c-approved-items.ts` (`P3C_APPROVED_ITEMS`, the exact array of §8.5c's
  Approved ids row, and `P3C_CURRENT_WAVE = 'W0'`), `p3c-approved-items.test.ts` (equality with §8.5c, read with
  `\b(?:[SC]\d+[ab]?|R63d)\b`) and `accept.p3c.coverage.test.ts` (reading this brief's §10.1 with its **Arrives**
  column; pending rows asserted only "absent, or present and named", rule 28; P3a's coverage files untouched);
  `vitest.workspace.ts` with the explicit `GATE_TESTS` list (rule 25) and the preflight script
  `scripts/preflight-ac.ps1` (rule 24); the [S8] block in full; the CLI registry stubs: `cli/modes.ts` gains the four
  modes (prompt, context key, parent; reserved until their grammar), and `cli/grammar/index.ts`, `cli/handlers/index.ts`
  and the show and debug registries register one empty fragment per W3a builder area (`cli/grammar/{ospf6,acl6,
  hardening-p3c,files,snmp,monitor}.ts` and their handler files), so no W3a builder edits a shared registry; the
  `FACT_AREAS` and `NEIGHBOR_AREAS` thunks for the new facts and `'ospfv3'`; `CliRuntime.sendBreak?` and
  `EngineApi.sendBreak?` with their transition `?` (§2.13). `DemuxSelector.frame` stays in W0 (it leaves in W0h).
- **qa** — `test/staged.world.ts` gains the `'P3c'` path (rule 13): the final P3c `PROCESS_ORDER` restricted to
  approved names, the P3c `CAPABILITY_PROCESSES` rows (CLI models only), the `storm-control` staged table, the
  `voice-endpoint` capability on NF-IPPHONE, and the routers' and switches' `storage` data. Test
  `staged.world.p3c.test.ts`.
- Six checks green (the coverage check sees every later row pending); **behaviour-neutral**: no `PROCESS_ORDER`,
  `CAPABILITY_PROCESSES`, `ERR_DISABLE_CAUSES`, factory-registry or stage-constant change (rule 3); the CLI fragments it
  registers are empty and the four modes are unreachable until their grammar lands, so no help golden moves in W0.

### W0h — engineering health (3 builders; S40 alone in the hot path)

- **sim** [S40] ⚑ — `packages/engine/bench/loop-storm.ts` (excluded from every project), profiling under `node
  --cpu-prof`, and fixes of the top frames in the dispatch path (`sim/simulation.ts` dispatch, `link/link.ts`
  `summarizePdu`, `device/device.ts` / `process-ctx.ts` `pduSummary`, trace-ring writes, flood cloning, `portKey` map
  lookups, snapshot-cache dirty marking, pipeline spreads), each byte-neutral; summary caching keyed on the PDU's
  mutation version. Delivers ≥ 3× on the storm window (recorded, not asserted). Tests: `accept.p3c.hot-path` (the
  recorded storm window's event count and digest equal), every digest shard, both determinism tests, replay-exact,
  `lab-status.p2`/`.p3`, run by the item itself.
- **web-shell** (bundle split) — main-thread value imports routed through `@netforge/engine/pure` or narrow subpath
  entries (`/contracts`, `/curriculum`) added to `packages/engine/package.json` `exports` (a reviewed edit by the
  architect); lazy curriculum and lab text; `manualChunks` for pixi, xterm, react; `test/bundle.engine-imports.lint.test.ts`.
  Gate G plus a smoke of every lazy entry (course, lab, automation workspace, every concept tool). No engine byte moves.
- **sim + web-shell** [C32] — (a) `DemuxSelector.frame` deleted from the contract and from capwap-wtp's `handles`
  (`capwap-wtp.ts:896`) **in one change** (the contract line is a reviewed edit of the architect's file; W0 kept the
  member so that capwap-wtp compiles); (b) `trace/filter.ts` reads `TraceFilter.vlans`, the VLAN chip in `FilterChips` and the
  breakpoint editor; (c) `TimelineStrip` guards and `TIMELINE_UNAVAILABLE_TEXT` removed (named migration §9.2). Tests
  `trace.filter.vlans.test.ts`, `accept.p3c.demux-and-vlan-filter`, the P2 wireless digest shards for (a).

### W1a — pure foundations and the OSPF refactor (6 builders)

- **ospf** [S6] ⚑ (refactor part 1 of 2) — the zero-diff extraction of `protocols/ospf/engine.ts` (adjacency, DBD
  exchange, flooding, LSDB, throttles, timers) behind the **unchanged** v2 factory in `protocols/ospf.ts`. Tests: every
  `accept.p3.ospf-*`, `accept.p3.labs`, `accept.p3.determinism`, `accept.p3.replay-exact-ccna3`, the P3 digest shards
  (labs a–c), unchanged. (Part 2, the `OspfFamily` adapter, is W1c.)
- **pdu** (run a) — `pdu/codecs/ospf.ts` (summary bodies 3/4 [S4]; auType 1 and 2 [S5]), `pdu/codecs/ospf6.ts` [S6],
  `pdu/codecs/cdp.ts` (TLV 9) and `pdu/codecs/lldp.ts` (Network Policy) [S35]; registry and dispatch (IPv6 NH 89). Tests
  `pdu.codecs.p3c-routing.test.ts` (byte goldens; the RFC 2328 D.4.3 digest vector), `pdu.codecs.p3c-disc.test.ts`.
- **core** — `core/acl6.ts` [S11]; `core/acl.ts` `dscp`/`precedence`/`log-input` [S12], the fragment rule and
  `fragments` [S17a], `aclTrailText` [S10]; `core/lpm.ts` `lpmRows` and the `pure.ts` exports of `core/lpm` and
  `core/lpm6` [S7]; `core/acl-placement.ts` [S23]. Tests `core.acl6.test.ts`, `core.acl.extras.test.ts`,
  `core.acl.fragment-rule.test.ts`, `core.lpm-rows.test.ts`, `core.acl-placement.test.ts`.
- **l2** (pure) — `protocols/l2/source-guard.ts` [S15], `storm-control.ts` [S16], `arp-acl.ts` [S14]. Tests
  `l2.source-guard.test.ts`, `l2.storm-control.test.ts` (window edges to the ns, hysteresis, units),
  `l2.arp-acl.test.ts`.
- **io + device** [S29] [S30] [S31] — `io/schema.ts` 1.4 field set, `io/migrate.ts` 1.3 → 1.4 identity, `io/lab-schema.ts`
  1.4 topologies, `contracts/topology.ts` `schemaIdFor` (a reviewed edit, R7 precedent); `device/device.ts` store
  keyed by `(fs, path)`, `hasFileStore(fs)`, the flash capacity check, the virtual image and `nvram:`, the persistent
  configuration register, `StoredFileMeta.nominalBytes` read from the image header; `device/if-index.ts` (new, the
  shared pure `ifIndexOf` of §3.5, used by [S6] and [S33]). Tests `io.schema.v14.test.ts` (every 1.1/1.2/1.3 document
  exports byte-identically), `device.storage.flash.test.ts`, `device.if-index.test.ts`. This item is the largest of
  W1a and may continue across checkpointed runs (rule 22).
- **sim** [S39] [S8] — `sim/run-control.ts` `quiet` option and `RunStats.stopped 'quiet'`; its use in lab-checks core,
  path, service, traffic drain and `grade.ts`; `timeline/convergence.ts` `measureConvergence`. Tests
  `sim.run-quiet.test.ts`, `timeline.convergence.test.ts`, `lab-status.p2`/`.p3` byte-identical.

### W1b — codecs part 2, pure models, config rules, discovery, concept tools (6 builders)

- **pdu** (run b) ⚑ — `pdu/codecs/tftp.ts` [S29] (with OACK and the `tsize` option), `pdu/codecs/snmp.ts` (BER subset
  [S33], the 0x80–0x82 exceptions, and the v3 USM header fields [C23]), `pdu/codecs/gre.ts` key word [C17]; dispatch:
  69 and 161 un-reserved, 162 added; the `tftp` and `snmp` field tables at `since: 'P3c'`. Tests
  `pdu.codecs.tftp.test.ts`, `pdu.codecs.snmp.test.ts` (golden bytes against RFC 3416 examples), the §9 pdu pin moves,
  the `-guards` shard (guard world 1's decode-only move, re-recorded by the architect in the W1b fix run, §9.5).
- **auto** — `automation/mib/model.ts` [S33] (the §3.5 table), `automation/playbook/model.ts` [C22] (inventory, plays,
  tasks, the `nf.*` modules). Tests `automation.mib.model.test.ts`, `automation.playbook.model.test.ts`.
- **cli** (config rules) — `cli/config-rules.ts` rows for every P3c line of §5 (the sections `ipv6 router <p>`,
  `ipv6 access-list`, `arp access-list`; multi-instance `message-digest-key`, `monitor session`, `snmp-server
  community|host`, `storm-control <class>`; `secretToken` on the key lines; `bothForms` for `ip unreachables`; no rule
  for `config-register`, an immediate command, D10), so that
  W2 daemon tests store lines through `startupConfig` without the grammar (P3a rule 13). The architect's W0 stub already
  registered the new grammar fragment files (empty), so no W3a item edits the grammar index. Tests
  `cli.config-rules.p3c.test.ts`; the pin moves of `cli.modes-rules.test.ts:122-124` and `device.runtime.test.ts:322-324`
  (§9.2).
- **web-concept** (a) — `concept/wan/*` [S22], `concept/sdn/*` [C26]. Tests `concept.wan.model.test.ts` (label-stack
  algebra, quiz scoring), `concept.sdn.model.test.ts`.
- **web-concept** (b) — `concept/yang/*` [S28]. Test `concept.yang.test.ts` (every node reachable; every config node's
  sample lines parse against the grammar).
- **disc** ⚑ — [S41] the two mismatch logs in `protocols/cdp.ts`; [S35] the daemon parts (send `voiceVlan` on
  voice-VLAN ports from this wave on; the phone's answer-driven, uplink-only mode and `H P` capabilities; LLDP-MED with
  `medCapabilities`). Tests `disc.cdp-mismatch.test.ts`, `disc.cdp-voice-vlan.test.ts` (against a fake phone uplink),
  every P3 digest shard (expected: no move; §9.5 names what may move).

### W1c — the OSPF refactor part 2, overlays and the serial access line (3 builders)

- **ospf** [S6] ⚑ (refactor part 2 of 2) — the `OspfFamily` adapter, `protocols/ospf/family-v4.ts`, `protocols/ospf.ts`
  reduced to a factory (engine + family-v4). Tests: as part 1, unchanged. **S6 checkpoint (end of W2a, §8.4):** the
  refactor is spent here, the IPv6 plumbing in W2a; the keep-or-cut decision on the rest of S6 is taken then.

- **web-canvas** — [S7] route-path overlay (IPv4 and IPv6, hosts from their default gateway, `↻` loops, `∅` black
  holes, ECMP fan-out, a tunnel as one hop, a `NAT` glyph at an inside interface), [S26] neighbours overlay, the one
  persisted-slice migration. Tests `route-path-model.test.ts`, `neighbours-model.test.ts`, the registry-order and
  persist-migration tests.
- **media** [C16] — `link/serial.ts` transparent access-line end (never `encapsulation-mismatch`; takes the far end's
  encapsulation for `serialLineReady`; the access port's stored `encap` unchanged); the eth-switch relay accepts `ppp`
  (a reviewed one-line edit by l2). Tests `link.serial.transparent.test.ts`, `accept.p2.p1-digests`, the P2 shards.

### W2a — daemons and hooks, part 1 (6 builders)

- **ospf** [S5] [C7] — `protocols/ospf/auth.ts`, the all-packet check, signing at the single packet build, `ip mtu` and
  `mtu-ignore` in `protocols/ospf/config.ts`, the DBD MTU check. Tests `ospf.auth.test.ts`, `ospf.mtu.test.ts`.
- **l3** (run a) [S6] ⚑ — `protocols/ipv6.ts` `ipv6.routes` (D8 of P3a mirrored), `ipv6.group` owner joins,
  `Route6Row.owner`, the `O`/`OI` renderers; `ip-upper.ts` `IPV6_UPPER` 89. Tests `ip.ipv6-routes-batch.test.ts`,
  `ip.ipv6-group.test.ts`, every digest shard.
- **acl** [S11] [S12] ⚑ — `protocols/acl.ts` family-keyed state (it runs in labs 15–17), `readTrafficFilters`,
  family-6 rows and the ND tail, ICMPv6 1/1 (its own gate), `acl.check {family: 6}`, `acl.clear {family}`;
  `log-input`, `no ip unreachables`. Tests `acl.daemon.ipv6.test.ts`, `acl.daemon.log-input.test.ts`,
  `acl.unreachables.test.ts`, every P3 digest shard (expected: no move).
- **l2** [S14] [S15] [S16] ⚑ — eth-switch step 7d, the storm-control ingress check (one Map lookup when unconfigured),
  the DAI order, `ERR_DISABLE_CAUSES` appended, the err-disable and trap paths. Tests `l2.eth-switch.ipsg.test.ts`,
  `l2.eth-switch.storm.test.ts`, `l2.arp-inspection.validate.test.ts`, the loop-storm case (gate project), every
  digest shard.
- **wan** [S36a] [C17] — `protocols/gre.ts` the recursion hold, keepalives and the key match. Tests
  `wan.gre-recursion.test.ts`, `wan.gre-keepalive.test.ts`; the migration of `wan.gre.test.ts:180-191` (§9.2).
- **svc** (run a) [S29] — `protocols/tftp.ts` client and server (with the `tsize` option and OACK, ERROR 3 on a
  full flash), `DORMANT_TRANSPORT_OWNERS` matchers (§4.3), the `transportHold` use. Test `app.tftp.test.ts`.

**S6 keep-or-cut checkpoint (end of W2a).** With W2a integrated, S6 has spent its refactor (W1a, W1c, 1.0 ew) and its
IPv6 plumbing (W2a l3, 0.8 ew); about 4.0 ew remain (the v3 daemon, CLI, adapter, web switch and lab 09). The lead
compares the actuals so far (rule 27) with the plan: if the contingency is already spent, the architect cuts the rest
of S6 (the refactor and the plumbing stay, both are byte-neutral and proven), lab 09 is not built, ospf.10 is
re-staged (§11.3), and the cut is recorded in §8.5b; otherwise S6 continues and is not cut again.

### W2b — daemons and hooks, part 2 (6 builders)

- **ospf** [S4] ⚑ — `core/ospf-spf.ts` `interAreaRoutes` and the type-4 ASBR lookup (border routers by the B/E bit,
  RFC 2328 §16.1–16.2); `protocols/ospf/originate.ts` `summaryLsasOf` and **the new B-flag rule** in `desiredSelf`
  (replacing `areaBorder: areas.length > 1` at `ospf.ts:1250`, D7); `protocols/ospf/routes.ts` order; `lsdb.ts` admits
  3/4; the post-SPF summary diff; `ipv4.ts:~360` `O IA` (a reviewed one-line edit of l3's file). Tests
  `core.ospf-spf.interarea.test.ts`, `ospf.originate.summary.test.ts`, `ospf.b-flag.test.ts`, a scan of every P3
  golden world for a router whose B bit flips (reported), every P3 digest shard with lab 06's entry as a guard (lab 07
  moves, §9.5).
- **l3** (run b) [S11] [S17a] [S12] ⚑ — `ipv6.ts` traffic-filter hooks and `ipv6.resume`; `arp.ts` `sendVia` MTU
  check with ICMP 3/4; `icmpv4.ts` `no ip unreachables` for the ACL and no-route codes; physical `ip mtu` read. Tests
  `ip.ipv6.acl-hooks.test.ts`, `ip.mtu-egress.test.ts`, the "would exceed MTU" scan of every golden world, every digest
  shard.
- **svc** (run b) [S33] (agent item) — `protocols/snmp-agent.ts` (GET, GETNEXT, GETBULK with `nonRepeaters`, the
  exceptions, SET through `configure`, traps; ifIndex through `ifIndexOf`), `DORMANT_TRANSPORT_OWNERS`. Test
  `app.snmp-agent.test.ts` (against a fake manager). The manager is its own item in W3a1.
- **l2** [S34] [S35] ⚑ — SPAN copies and the destination rule; the phone's transparent-path classification of CDP and
  LLDP, the learned voice VLAN in `voiceUplink`. Tests `l2.span.test.ts`, `l2.phone-voice-vlan.test.ts` (learned case),
  every digest shard (§9.5: from W2b the phone's transparent path changes; no golden world holds a phone, so none is
  expected to move).
- **nat** [S12] — extended lists through `readAcls`/`evaluateAcl` (full tuple); `MSG_BAD_ACL_REF` rewritten;
  `readStandardAcls` kept. Tests `nat.extended-list.test.ts`, the P2 NAT lab digest shards.
- **device** [S30] [S31] — the boot path (`boot system`, a missing image → ROMMON), the break window, ROMMON mode,
  `confreg`, the register's effect on boot; the `cliBreak` journal op through `sim/simulation.ts` (a reviewed edit of
  sim's file). Tests `device.rommon.test.ts`, `sim.journal.cli-break.test.ts`.

### W3a — CLI, the OSPFv3 daemon and the SNMP manager, in two owner-disjoint runs

Every W3a file has exactly one owner, and no two builders of W3a (in either run) share a file. The shared registries
(`cli/modes.ts`, `cli/grammar/index.ts`, `cli/handlers/index.ts`, the show and debug registries) are the architect's
and were stubbed in W0 (the four modes and one empty grammar, handler, show and debug fragment per area below); no W3a
builder edits them. The ping keywords (both shells) have one owner, and so does `ip mtu`.

| File | Owner | Run |
|---|---|---|
| `protocols/ospf/family-v6.ts`, `core/ospf6-spf.ts`, the `ospfv3` factory | ospf | W3a1 |
| `cli/grammar/ospf.ts`, `cli/handlers/ospf.ts`, `cli/grammar/ospf6.ts` and `cli/handlers/ospf6.ts` (new, W0-registered), `cli/grammar/wan.ts` (`ip mtu` widened from the tunnel-only spec to routed Ethernet, subinterfaces and serial; [C17] `keepalive`, `tunnel key`; [S36b] the tunnel's `ipv6` lines) | cli-routing | W3a1 |
| `cli/grammar/acl.ts`, `cli/handlers/acl.ts`, `cli/grammar/acl6.ts` and its handlers (new), `cli/grammar/hardening.ts`, `cli/handlers/hardening.ts`, `cli/grammar/hardening-p3c.ts` and its handlers (new), `cli/grammar/errdisable.ts` | cli-acl | W3a1 |
| `protocols/{dhcp-client,tcp,vty,snmp-manager}.ts`, the `snmp` row of `HOST_APP_PROCESS` (a reviewed edit of sim's `sim/simulation.ts`) | svc | W3a1 |
| `cli/grammar/{files,snmp,monitor}.ts` and their handlers (new), `cli/grammar/host-shell.ts`, `cli/handlers/{host,host-net}.ts`, `cli/grammar/core-exec.ts` (the `ping` keywords), `cli/handlers/show.ts` (`show version` lines) | cli-management | W3a2 |
| `cli/runtime.ts`, `cli/log-render.ts` | cli-runtime | W3a2 |

#### W3a1 (4 builders)

- **ospf** [S6] — `protocols/ospf/family-v6.ts`, the `ospfv3` factory (registered in the test-only order of
  `staged.world`; `PROCESS_ORDER` waits for W4b), `core/ospf6-spf.ts` (or `buildSpfGraph6` feeding `runSpf`),
  `ospf6Routes` in `pure`, inter-area v3 LSAs with [S4], the interface id from `ifIndexOf`. Tests `ospf6.spf.test.ts`,
  `ospf6.daemon.test.ts`.
- **cli** (routing) — `cli/grammar/ospf.ts` (summary kinds, `border-routers` computed from the LSDB rows through the
  pure SPF, auth lines, `mtu-ignore`), `cli/grammar/ospf6.ts` (`config-rtr`), the `ipv6 route` legend rule (§3.3 step
  6), `ip mtu` widened, the C17 and S36b tunnel lines; handlers, shows and debug rows in its own fragments. Tests
  `cli.ospf-multiarea.test.ts`, `cli.ospf-auth.test.ts`, `cli.ospf6.test.ts`, `cli.ip-mtu.test.ts`.
- **cli** (acl and access layer) — `cli/grammar/acl.ts` (S12 terms), `cli/grammar/acl6.ts` (IPv6 lists,
  `traffic-filter`, `access-class`), `cli/grammar/hardening-p3c.ts` (`ip verify source`, storm control, ARP ACLs,
  validate), `errdisable recovery cause storm-control`; shows (`show ipv6 access-list`, `show ip verify source`, `show
  storm-control`, `show arp access-list`). Specs carry `requiresAnyProcess: ['acl']` where a scope exists. Tests
  `cli.acl-ipv6.test.ts`, `cli.hardening-p3c.test.ts`.
- **svc** (run c) [S35] [S11] [S33] (manager item) — `dhcp-client` restart on `dhcp.restart`; `tcp`'s hidden family-6
  vty listener under D8's conditions; `vty` `acl.check {family 6}`; `protocols/snmp-manager.ts` (requests with
  `version`, `nonRepeaters`, walk ending at `endOfMibView`, the trap receiver) and the `snmp` row of `HOST_APP_PROCESS`.
  Tests `dhcp.client.restart.test.ts`, `vty.ipv6-access-class.test.ts`, `app.snmp-manager.test.ts` (against the W2b
  agent).

#### W3a2 (2 builders)

- **cli** (management) ⚑ — `cli/grammar/files.ts` (copy forms, `url` ArgType, prompts, `dir`, `show flash:`, `delete`,
  `tftp-server`, `boot system`, `verify /md5`, the immediate `config-register`, the `rommon` mode), `cli/grammar/snmp.ts`,
  `cli/grammar/monitor.ts` (`monitor session`, `show monitor`), the host-shell `service tftp|snmptrap`,
  `snmpget|walk|set` (with `-v2c`, mapped to `version`), NF-SERVER's `dir`/`type`/`del` (M-5, R59 (c) relaxed), **both
  ping forms** (`ping … size/df-bit/repeat` on NF-OS, `ping -l/-f` on host shells); the `show version` lines (P3 profile
  only; they need `DeviceModel.storage`, which real models gain at W4b, so in this run they are tested on
  `staged.world` and no golden moves until the flip, §9.5). Tests `cli.files.test.ts`, `cli.snmp.test.ts`,
  `cli.ping-size.test.ts`, `cli.show.version.p3.test.ts`, every P3 digest shard (expected: no move).
- **cli** (runtime) R63 (d) [S31] ⚑ — `cli/runtime.ts` `midLine` per session (a debug or log line that starts mid-line
  in a P3 world gets a leading newline) and `CliRuntime.sendBreak` (issues the `cliBreak` journal op of W2b). Tests
  `cli.debug-midline.test.ts`, `cli.runtime.send-break.test.ts`, the 47h / `cli.logging` / `accept.p3.vty` migrations
  (§9.2), every P3 digest shard (§9.5: the R63 (d) entries).
- **Integrate run of W3a2 (architect, sanctioned step):** `cli-help.p05.json` is regenerated with **additions only**
  for the W3a grammar and the four mode listings (`P3C_APPROVED_MODES` in `cli.grammar.help-goldens.test.ts`), checked
  by `cli.help-superset` (§9.4); `cli-help.p1.json` is not touched.

### W3b — web, the grader kinds, HTTP and automation (6 builders)

- **web-inspector** [S10] [S23] — `AclView`, the packet tester, "why it stopped here", permit chips, the reasons filter;
  then lint badges, the advisor panel and the impact preview (capped at 50 hosts). Tests
  `inspector.acl-view.test.tsx`, `inspector.acl-tester.test.ts`, `inspector.provenance.why.test.tsx`,
  `inspector.acl-advisor.test.ts`, `inspector.acl-impact.test.ts`.
- **web-shell** [S10] [S31] [S8] — `bridge/worker/acl.ts` (`aclLists`, `aclEvaluate` over `readAcls`), the terminal's
  "Send break" and Ctrl+Break, `EngineApi.sendBreak`; removes the transition `?` of both `sendBreak` members (a reviewed
  contract edit) and updates every typed fake (rule 2); `ConvergencePanel`. Tests `worker.acl-evaluate.parity.test.ts`
  (the worker's decision equals the daemon's row), `terminal.break.test.tsx`, `timeline.convergence-panel.test.ts`.
- **web-desktop** [S33] [S35] — `SnmpManagerApp` (over the W3a1 manager), the phone panel's learned VLAN. Tests
  `desktop.snmp-manager.test.tsx`, `desktop.phone-learned-vlan.test.tsx`. (The API client and the playbook UI need this
  run's http + auto work, so they are W3c.)
- **web-routing + web-canvas** [S4] [S6] — LSDB-browser summary kinds, `LsaDetail` cases, list order 1–5, the ABR
  glyph, the OSPF overlay's v3 family switch, rib6 `O` titles. Tests `routing.lsdb-model.summary.test.ts`,
  `overlays.ospf-model.abr.test.ts`.
- **sim** [S8] [S38] — `sim/lab-checks/convergence.ts`, `sim/lab-checks/capture.ts` (with the `drive.snmp` GET through
  the clone's manager), their registry rows and `io/lab-schema.ts` validators (a filter compiled at load). Tests
  `sim.lab-checks.convergence.test.ts`, `sim.lab-checks.packet-seen.test.ts` (wrong-answer cases),
  `accept.p3.lab-document` wrong-shape cases.
- **http + auto** [S27] [C22] — `protocols/http-client.ts` `gui` owner (headers and body kept for `gui` calls only) and
  the `http.request` row of `HOST_APP_PROCESS` (a reviewed edit of sim's file); `protocols/script-host.ts` playbook runs
  (`ScriptRunRow.kind`, `recap`), the `playbook` host command. Tests `app.http-client.gui-owner.test.ts`,
  `sim.host-request.http.test.ts`, `app.playbook.test.ts`.

### W3c — adapters, extras, the IPv6 tunnel and the desktop apps that need W3b (6 builders)

- **ospf** (adapter) — facts `ospf.abr`, `ospf.asbr`, `ospfv3.*`; the `ospfv3` neighbour adapter; `route` with `IA`
  (filling the W0 `FACT_AREAS` / `NEIGHBOR_AREAS` thunks in `sim/lab-checks/ospf.ts`). Test
  `sim.lab-checks.ospf-p3c.test.ts`.
- **acl + l2** (adapters) — `acl`/`aclDecision` family 6 with `type: 'ipv6'` and `entry: 'nd-na' | 'nd-ns'`;
  `ipsg.enabled` (in `sim/lab-checks/acl.ts` and `hardening.ts`). Test `sim.lab-checks.acl-l2-p3c.test.ts`.
- **svc** (run d) [C23] + adapters — USM in the agent and the manager options; facts `storage.file`,
  `device.imageVersion`, `device.configRegister` in **`sim/lab-checks/mgmt.ts`** (new, svc); `snmp-traps` in
  `RUNTIME_ONLY_TABLES` (a reviewed edit of sim's `sim/grade.ts`). Tests `app.snmpv3.test.ts`,
  `sim.lab-checks.mgmt-p3c.test.ts`.
- **wan** [S36b] — IPv6 over GRE: the tunnel's IPv6 interface, the head and tail for 0x86dd, ICMPv6 Packet Too Big at
  the tunnel MTU, and the delimited `nd.ts` / `ipv6.ts` tunnel branch (reviewed by l3). Test `wan.gre-ipv6.test.ts`.
- **web-inspector** [S29] [S34] — the Services panel's TFTP section, the NetScope SPAN shortcut (`src/netscope/*`,
  §6), drop labels. Tests `inspector.services.tftp.test.tsx`, `netscope.span-shortcut.test.ts`.
- **web-desktop** [S27] [C22] — `ApiClientApp` (over W3b's `gui` owner), the automation workspace's YAML highlight
  and "Run playbook" (over W3b's `playbook` command). Tests `desktop.api-client.test.tsx`,
  `desktop.api-client.world.test.tsx` (lab 38's topology), `automation.run-playbook.test.tsx`.

### W4a — acceptance on `staged.world` (qa, up to 6 builders)

qa writes every `accept.p3c.*` file of §10.1 whose **Arrives** column says W4a (one builder per area: routing; ACL and
access layer; WAN and discovery; management; health and cross-cutting; web acceptance §10.2), all on `staged.world` at
stage `'P3c'`. The lead advances `P3C_CURRENT_WAVE` to `'W4a'` in the integrate run.

### W4b — the P3c catalog flip, alone (catalog, architect)

The only open item in the tree (rule 14, D6). **catalog** — `PROCESS_ORDER` insertions (`tftp`, `snmp-agent`,
`snmp-manager`, `ospfv3`), the `CAPABILITY_PROCESSES` rows of §2.1 with the `cli.shell !== 'none'` condition in
`deriveProcesses`, the `voice-endpoint` capability on NF-IPPHONE, the second `STAGED_PROCESS_TABLES` row
(`storm-control`), `DeviceModel.storage` data for every NF-OS router and switch (original image names), the stage
constants set to `'P3c'`; `protocols/index.ts` factory registrations; `staged.world.p3c-parity.test.ts`;
`accept.p3c.silence`. The lead runs rule 14's list inside the change. `protocols.registry.test.ts`,
`device.catalog.p3.test.ts` and `staged.world.p3-parity` migrate here (§9.2). The flip is ⚑: the [S30] `show version`
lines first appear in real P3 worlds here (§9.5); the architect regenerates `cli-help.p05.json` with additions only for
the words scoped to the newly derived processes, as a sanctioned step inside the flip (§9.4).

### W5a — labs (6 builders, one lab file each)

- **ospf** — lab 08 `ccna3-ospf-multi-area` [S4], lab 09 `ccna3-ospf-ipv6` [S6], lab 07's new MD5 and MTU faults and
  tasks [S5] [C7] (router ids fixed so the lower-MTU side has the higher id, §3.2), lab 06's convergence task [S8].
- **acl** — lab 17's IPv6 part [S11].
- **l2** — lab 20's IP source guard task [S15] and storm-control task [S16] (graded by configuration plus the row written
  when the line is stored).
- **svc** — lab 30 `ccna3-watch-the-network` [S33] [S34] [C23] [S38] (`sim/scenarios/ccna3/mgmt.ts`, new, svc).
- **device** — lab 31 `ccna3-backup-and-upgrade` [S29] [S30] [S31] (`sim/scenarios/ccna3/files.ts`, new, device).
- **auto** — lab 39 `ccna3-playbook-vlans` [C22] in `sim/scenarios/ccna3/automation.ts` (between lab 38 and lab 40).

Each lab owner supplies its `labs.ccna3.solutions` rows and wrong-answer cases in its own lab test file; no W5a item
depends on another.

### W5b — course plumbing over the five labs (course, architect)

- **course** — `CCNA3_LAB_ORDER` (the five labs inserted in lesson order, D5), the registry in
  `sim/scenarios/ccna3/index.ts`, `curriculum/ccna3/lessons.ts` (`lab:` set on lessons 08, 09, 30, 31 and 39),
  `accept.p3c.labs`, `accept.p3c.grader-bounded`, `accept.p3c.determinism`, and the §9.2 W5b pin moves.
- **architect** — `lab-versions.json` (new entries at version 1, bumps for 06, 07, 17, 20), re-recorded with
  `NF_RECORD_LAB_VERSIONS=<lab>`; the §9.5 W5b entries of labs 06, 07, 17 and 20.

### W6 — theory and course (5 builders)

- **course** (theory-a) — lessons 06, 07, 08, 09. **course** (theory-b) — lessons 15, 16, 17, 20, 21. **course**
  (theory-c) — lessons 22, 23, 24, 28, 30, 31, 34. **course** (theory-d) — lessons 36, 38, 39. Each rewrites the "what
  the hands-on part would have shown" paragraph into instructions, links the new tools (`concept:wan`, `concept:yang`,
  `concept:sdn`) and keeps every lesson within its minutes (≤ 45; `curriculum.ccna3.videos.test.ts` holds theory plus
  video within the minutes); `curriculum.ccna3.commands.test.ts` is the safety net.
- **course** (objectives and docs) — `objectives.ts` flips (§11.3), `curriculum.ccna3.test.ts`, the CCNA 2 lesson 08
  sentence (`curriculum/ccna2/theory-a.ts`, [S35]), README counts, the W8-scope doc pins (§9.2), the CATALOG fidelity
  rows each wave reported.

### W7 — P3c exit gate (architect)

Scope audit `docs/P3C-SCOPE-AUDIT.md` against §8.5c's Approved ids and §8.5b's X-14 scope list; `accept.p3c.coverage`
with `P3C_CURRENT_WAVE = 'W7'` (every approved row present); the `?` tidy (rule 2); `index.ts` reconciled;
`staged.world` reduced to a wrapper; `'later:P3c'` removed from `ObjectiveHandsOn`; docs (CATALOG, README); the six
checks, `slow` and `gate` serially on AC (rules 24, 25); Gate G over every CCNA 3 lab (26 in the recommended plan); the
§14 exit record with effort actuals (rule 27). Then the product owner approves the merge to `master` (rule 21).

---

## 8. Cut lines

**Units.** Cost is in engineer-weeks (ew), as in P3a §8: one focused implementer week including tests, a share of
review and fixes, and the CLI lines. Estimates are the P3c maps' revised figures (the P3a brief's first figure in
brackets). They are **uncalibrated**: neither P2 nor P3a recorded effort actuals (P3a's approved 123.2 ew plan ran
2026-09-30 to 2026-10-14 as agent waves; rule 27 starts the record). **Deduplication:** each map priced its own share
of wave 0, rows and docs; those shares are kept once, as named "share" lines, and the cross-cutting work (goldens,
stage, flip, course plumbing, exit gate) is counted once in the H and X lines. Each item's own lab, lesson and
acceptance file are inside its figure.

**Value** is judged against the 18 `'later:P3c'` objectives (each closed item flips one), the CCNA 3 blueprint's
configure-and-verify versus describe split (P3a §8), the deviations a learner can notice (`docs/CATALOG.md`), and
engineering health that every later wave pays for. **Risk** is the byte risk to the P1, P2 and P3 goldens and the
built-bundle risk.

**Classes.** MUST is the recommended minimum, in three kinds: **MUST (objective)**, an item that closes a `'later:P3c'`
objective at reasonable cost (`'lab'` in §11.3); **MUST (health)**, the H and X lines; and **MUST by value** (marked
**†** below), an item that closes no objective, or whose objective is `'theory'` whether it is built or not, kept in
MUST for a stated UX or fidelity value: S10, S17a, S26, S35, S36a, S41 and C7 close no objective (7.0 ew); S22 and S28
turn wan.1 and automation.4 into `'theory'`, which is also their fallback (2.6 ew; C26, a rec SHOULD, is the same case
for automation.8). The value is in each row's Value column; the cut order (§8.4) lists every † item. SHOULD and COULD
marked **rec** are in the recommended plan (§8.4). Everything else is deferred with a stage. The product owner answers
§8.5a; nothing here is approved.

**Work already done by this brief** (the S4 walk-through rewrite, 0.2; the routing share's §3.1/§3.3, 0.1; the
management share's F1 re-specification in §3.4–§3.5, 0.2) is taken out of those items' figures and moved into the
contingency lines of §8.4 (0.5 ew), so every total with contingency is unchanged.

**Course work.** Map 05's formula prices the course work at about 3 ew (0.3 base, 0.15 per new lab, 0.1 per edited
lab, 0.1 per lesson rewrite). The base is X2 (0.3); every other part is inside an item's figure: each new or edited lab
and its lesson rewrite are priced in the item that owns the lab (§11.1–§11.2), and the lessons that belong to no lab
are charged to their nearest item — lesson 16 to S17a, 21 and 23 to S22, 22 to C16, 24 to S36a, 28 and 34 to S41 (with
S26 and S35 for 28), 36 to C26, 38 to S28, and CCNA 2 lesson 08 to S35. W6's five builders spend that priced work; they
have no figure of their own.

### 8.1 MUST (42.5 ew; with a 10 % contingency and the 0.5 ew already done, 47.3 ew)

| # | Feature | Value | Cost | Depends on | Risk | Wave items | If cut |
|---|---|---|---|---|---|---|---|
| H1 | P3 golden record (harness, `p3-profile-digests` in 5 shards keyed by lab id, `lab-status.p3`, `p3-lab-exports`, the storm-window digest) and `accept.p3c.coverage` with its Arrives column | The only proof that live P3 worlds, saved files and the 21 labs keep their bytes | 0.8 | — | none (records only) | W0 architect | — (never cut; hard prerequisite) |
| H2 | `BuildStage 'P3c'`, the `staged.world` P3c path, the parity test | Keeps the P3 golden honest across the flip | 0.4 | H1 | low (stage pins move) | W0 architect, qa; W4b | — (never cut) |
| H3 | Test tiers (`gate` project), the AC preflight, the `vitest related` recipe | P3a's suite took 880 s and stalled on battery | 0.3 | — | none | W0 architect | Slow, flaky gates |
| H4 | [S40] hot-path profiling, byte-neutral, with the benchmark | Suite time for every later wave; R3 | 1.5 (1.0) | H1 | **high ⚑** (the hot path of every world) | W0h sim | The 153–386 s storm case stays |
| H5 | The bundle split (main chunk 4.09 MB → ≈ 1.2–1.6 MB), lazy curriculum, the import lint | Learner load time; new labs and tools land on it | 1.0 | — | **high for the built bundle** (evaluation order; the P1 circular-import incident) | W0h web-shell | Every P3c lab and tool grows the main chunk |
| H6 | [C32] demux contract deleted, the trace VLAN key, TimelineStrip guards removed | An honest contract; a VLAN filter | 0.5 (0.5) | — | none with (a)(ii) | W0h sim, web-shell | Carried again |
| H7 | [S39] quiet settle | The last never-idle exception goes; P3c's new wrong answers have a safety net | 0.6 (0.3) | H1 | low (grading only; proved by both lab-status goldens) | W1a sim | The EtherChannel exception stays |
| X1 | The P3c catalog flip, `accept.p3c.silence`, the home-router CLI condition | The one learner-visible switch-on, proved | 0.4 | H2 | medium (rule 14 discipline) | W4b catalog | — (never cut) |
| X2 | Course plumbing: lab order, counts, pins, README, Gate G text, the §11.4 table, re-staged objectives | No `'later:P3c'` survives | 0.3 | — | none | W5b, W6 course | — (never cut) |
| X3 | Exit gate: scope audit, §10.2 and §10.3 scripts, docs | Proof | 0.5 | all | none | W7 architect | — (never cut) |
| S4 | Multi-area OSPF (ABR, types 3/4, `O IA`, `border-routers`, ABR glyph, summary kinds in the LSDB browser), lab 08 | Closes ospf.9 and ospf.14; fixes unreachable areas in saved worlds | 2.6 (3.0; 0.2 of the walk-through rewrite already done) | — | low ⚑ (P3 worlds with two areas only; the B-flag rule change; lab 07's digest listed) | W2b ospf; W3a1 cli; W3b web-routing; W3c ospf; W5a ospf | Lesson 08 stays theory |
| S5 | OSPF authentication (simple, real keyed MD5, all packet types), lab 07 task | Closes ospf.16 | 1.2 (1.0) | — | none (OBM rows) | W1a pdu; W2a ospf; W3a1 cli; W5a ospf | Theory paragraph |
| S6 | OSPFv3 on a shared engine (refactor in two parts, `ospf6` codec, ipv6 plumbing, CLI), lab 09 | Closes ospf.10; concept-level on the exam | 5.8 (4.0) | S4 for `OI`; the shared `ifIndexOf` (W1a device) | **high ⚑** (the refactor; `ipv6.ts` plumbing in a P1/P2 daemon) | W1a ospf, pdu; W1c ospf; W2a l3; W3a1 ospf, cli; W3b web-routing; W3c ospf; W5a ospf | Lesson 09 stays theory; keep-or-cut checkpoint at the end of W2a |
| C7 † | OSPF MTU mismatch (`ip mtu`, DBD check, `mtu-ignore`), lab 07 task | By value (no objective): classic "will not peer" troubleshooting; shares S5's receive path | 0.8 (0.7) | — | low (the always-on DBD check is a listed P3 change for jumbo peers) | W2a ospf; W3a1 cli; W5a ospf | Theory |
| R-sh | Routing share of W0 (blocks, rows, the guard migrations) | — | 0.3 (0.1 of §3.1/§3.3 already done) | — | — | W0 | — |
| S11 | IPv6 ACLs (`traffic-filter`, ND tail, ICMPv6 1/1, `ipv6 access-class` on IPv6 vty), lab 17 part | Closes acl.10 | 2.3 (1.5) | — | low ⚑ (the acl daemon's family-keyed state runs in labs 15–17; `cli-help.p05` gains words, §9.4) | W1a core; W2a acl; W2b l3; W3a1 cli, svc; W3c acl; W5a acl | IPv4 only; lab 17's IPv6 part theory |
| S15 | IP source guard, lab 20 task | Closes hardening.5 | 1.1 (1.0) | — | nil (lab 20 doc moves) | W1a l2; W2a l2; W3a1 cli; W3c l2; W5a l2 | Theory in lesson 20 |
| S16 | Storm control, lab 20 task | Closes hardening.6 | 1.4 (1.2) | — | **medium** (a staged table in every managed switch, normalised by H2; `show errdisable recovery` gains a line on P1/P2 switches, §4.4) | W1a l2; W2a l2; W3a1 cli; W4b; W5a l2 | Theory in lesson 20 |
| S10 † | ACL workbench (hit view, packet tester, "why it stopped here", permit chips, reasons filter) | By value (no objective; UX): spec §9.3 provenance for policy drops; first-match reasoning made visible | 2.2 (2.0) | — | none | W1a core; W3b web-inspector, web-shell | Drops show their rule text only |
| S17a † | Honest MTU: `ping size/df-bit`, host `-l/-f`, physical `ip mtu`, DF → ICMP 3/4, the ACL fragment rule | By value (no objective; fidelity): teaches DF and "fragmentation needed" at a quarter of S17's cost | 0.9 (part of 3.0) | — | low on the wire (proved by the scan); the help golden is not moved by sub-word keywords (§9.4) | W1a core; W2b l3; W3a2 cli | Oversize packets cannot be made |
| acl.6 | Placement objective retraced to labs 15 and 16 | Closes acl.6 for free | 0 | — | none | W6 course | — |
| A-sh | ACL share (blocks, rows, CATALOG rows, the help ruling) | — | 0.4 | — | — | W0 | — |
| S22 † | WAN and VPN explorer (concept tool) | By value (UX): wan.1 is `'theory'` built or not; the explorer shows label stacks and VPN kinds the canvas cannot | 1.6 (1.5) | — | none | W1b web-concept; W6 course | Static figures |
| S26 † | Neighbours overlay (CDP/LLDP) | By value (no objective; UX): lesson 28 "map an unknown network" on the canvas | 0.8 (0.7) | — | none (web) | W1c web-canvas | Tables and `show cdp neighbors` |
| S35 † | Voice VLAN learned by CDP and LLDP-MED; the phone stops bridging CDP | By value (no objective; fidelity): closes P2 deviation 7 | 1.6 (1.0) | — | low in P1/P2 (answer-driven); listed P3 change ⚑ | W1a pdu; W1b disc; W2b l2; W3a1 svc; W3b web-desktop; W4b | The phone keeps its typed voice VLAN |
| S36a † | GRE recursive-routing hold | By value (no objective; fidelity): the classic flap, with its designed acceptance row | 0.4 (part of 1.0) | — | none (P3 recursive worlds only; two pins migrate) | W2a wan | The tunnel stays down until a change |
| S41 † | CDP native-VLAN and duplex mismatch logs | By value (no objective; fidelity): classic CDP diagnostics | 0.3 (0.5) | — | low ⚑ (P3 mismatch worlds only, listed) | W1b disc | The P2 BPDU TLV still finds a native mismatch |
| S28 † | YANG browser (concept tool) | By value (UX): automation.4 is `'theory'` built or not; the model browsed, not read as text | 1.0 (1.5) | — | none | W1b web-concept | The model shown as text |
| S29 | Files and TFTP (flash, nvram, copy forms, server with `tsize`, schema 1.4), lab 31 | Closes management.9 with S30 | 3.0 (3.2) | — | low (1.4 only when present; virtual image) | W1a io, device; W1b pdu; W2a svc; W3a2 cli; W3c svc, web-inspector; W4b; W5a device | Lesson 31 stays theory |
| S30 | Image management (`boot system`, scaled copies with the image header, `verify /md5`, `show version` lines) | management.9 | 1.3 (1.5) | S29 | low ⚑ (P3-profile `show version` only, moving at the W4b flip) | W2b device; W3a2 cli; W4b; W5a device | Theory |
| S31 | Password recovery (break, ROMMON, register, `cliBreak`) | Closes management.10 | 1.6 (1.5) | S29 (1.4) | low (a new journal op only) | W2b device; W3a2 cli; W3b web-shell; W5a device | Theory |
| S33 | SNMP v2c (BER, agent, MIB subset, SET, traps, manager, app), lab 30; two items (agent W2b, manager W3a1) | Closes management.4 | 4.5 (4.7) | the shared `ifIndexOf` | low (silent, normalised) | W1b pdu, auto; W2b svc; W3a1 svc; W3a2 cli; W3b web-desktop; W3c svc; W4b; W5a svc | Lesson 30 stays theory |
| S34 | Local SPAN, lab 30 task | Closes management.7; feeds P4's IDS sensors | 1.0 (1.0) | — | none unless configured | W2b l2; W3a2 cli; W3c web-inspector; W5a svc | Theory |
| M-sh | Management share (lesson notes, CATALOG rows) | — | 0.1 (0.2 of the F1 re-specification already done in §3.4–§3.5) | — | — | W0, W6 | — |

### 8.2 SHOULD (rec = in the recommended plan)

| # | Feature | Value | Cost | Depends on | Risk | Wave items | If not built |
|---|---|---|---|---|---|---|---|
| S8 rec | Convergence measurement, the `convergence` kind, the panel, lab 06 task | Spec §9.7 "tune timers and see the number drop" | 2.2 (1.8) | — | none | W1a sim; W3b sim, web-shell; W5a ospf | Convergence read from timestamps |
| S7 rec | Path-to-destination overlay (IPv4 and IPv6) | Spec §9.6 "Routing (any)"; CCNA 1 "why does my ping fail" | 1.3 (1.0) | — | none (web) | W1a core; W1c web-canvas | — |
| S23 rec | ACL lint badges, placement advisor, impact preview | Spec §2.3 placement guidance (acl.6 is closed by retrace) | 2.3 (2.5) | S10 | none | W1a core; W3b web-inspector | Placement taught in text |
| S12 rec | ACL extras: `log-input`, `no ip unreachables`, DSCP/precedence terms, NAT with extended lists | Completeness; a hardening step | 1.0 (0.8) | — | very low (the NAT reader switch is re-checked by the P2 NAT shards) | W1a core; W2a acl; W2b nat, l3; W3a1 cli | — |
| S14 rec | ARP ACLs and DAI `validate` | The second fix for lab 20's static server | 1.0 (0.8) | — | low (OBM columns) | W1a l2; W2a l2; W3a1 cli | Static hosts need a binding or trust |
| A-sh2 rec | ACL share for S12/S14/S23 | — | 0.1 | — | — | W0 | — |
| S36b rec | IPv6 over GRE | Removes the "IPv4 only" deviation of [S18] | 1.1 (part of 1.0) | — | none (P3 tunnels with `ipv6 address`) | W3a1 cli; W3c wan | — |
| C16 rec | PPP through the CSU/DSU and the cloud | Removes the [S19] direct-cable deviation | 0.8 (0.7) | — | low (the P1/P2 templates' HDLC chains must not move; guarded) | W1c media | Lab 22 keeps its direct cable |
| C17 rec | GRE keepalives and `tunnel key` | A key mismatch is a good lab 34 fault; removes a deviation | 0.7 (0.5) | — | none | W1b pdu; W2a wan; W3a1 cli | — |
| C22 rec | Playbook runner, lab 39 | Closes automation.6 | 2.0 (2.5) | — | none | W1b auto; W3b http+auto; W3c web-desktop; W5a auto | Lesson 39 stays theory |
| C23 rec | SNMPv3 (USM; real HMAC-MD5, a simulated SHA tag), lab 30 task | Closes management.5; cheap once S33 exists | 1.0 (1.0) | S33 | none | W1b pdu; W3c svc; W5a svc | Theory |
| S27 rec | API client desktop app | UX; the `rest` command already meets the objective | 1.2 (1.5) | — | none | W3b http+auto; W3c web-desktop | The `rest` command |
| M-sh2 rec | Management share for C22/C23/S27 | — | 0.2 | — | — | W0, W6 | — |
| C26 rec | Controller, SDN and intent concept tool (architect's estimate; no map priced it) | Closes automation.8 | 1.1 (1.0) | — | none (web) | W1b web-concept; W6 course | automation.8 re-staged (X-17) |
| S38 rec | `packetSeen` with a clone capture tap | Grades lab 30's SPAN copies and clear-text community; DSCP on the wire | 0.6 (0.4) | — | none (clone only) | W3b sim; W5a svc | Other kinds only |
| R63d rec | A P3 debug or log line that starts mid-line starts on a new line | Learner-visible in P3 worlds and over telnet/SSH relays | 0.3 | — | P3-profile only, listed ⚑ | W3a2 cli | The R63 (d) known case stays |
| S17b | Real fragmentation and reassembly, tunnel pre-fragmentation (Appendix A) | Fidelity for tunnels and large pings | 3.1 (+0.4 NAT virtual reassembly) | S17a | **high** (tunnel tests move if pre-fragmenting) | Appendix A | DF-clear oversize drops honestly |

### 8.3 COULD and deferred

| # | Feature | Cost | Class | Why |
|---|---|---|---|---|
| C8g rec | OSPF scale gate `accept.p3c.ospf-scale-multiarea` (50 routers, 3 areas, a dual-stack variant) | 0.3 | COULD, rec | Proves S4 and S6 do not need C8 |
| C8 | OSPF scale proper (LSA interning, lazy rows, partial SPF) | 1.5 | only if the gate fails | `accept.p3.ospf-scale` passes; course labs use 3–5 routers |
| C14 | PPP multilink | 2.0 (1.5) | defer: **P5** | No objective; beyond the course |
| C15 | PPPoE client, server, dialer | 3.8 (3.0) | defer: **P4** | The home-ISP story; a ppp carrier refactor |
| C20 | Invisible fair-queue on slow serial lines | 0.4 (0.3) | **never** | Contradicts lab 27's FIFO step; fails D2 (b); CATALOG deviation 14 stays |
| C21 | NETCONF and XML for RESTCONF | 2.3 (2.5) | defer: P5 | Recognise-level; automation.5 becomes `'theory'` (X-4) |
| C24 | FTP | 1.5 (1.5) | defer: P4 | TFTP already meets management.9 |
| C29 | `usbflash0:` | 0.5 (0.5) | defer: P5 | Cosmetic |
| M-sh3 | Management share for C21/C24/C29 | 0.1 | with them | — |

### 8.4 The recommended plan

| Part | Items and costs (ew) | Subtotal |
|---|---|---|
| MUST, health and cross-cutting | H1 0.8 + H2 0.4 + H3 0.3 + H4 1.5 + H5 1.0 + H6 0.5 + H7 0.6 + X1 0.4 + X2 0.3 + X3 0.5 | 6.3 |
| MUST, routing | S4 2.6 + S5 1.2 + S6 5.8 + C7 0.8 + share 0.3 | 10.7 |
| MUST, ACLs and the access layer | S11 2.3 + S15 1.1 + S16 1.4 + S10 2.2 + S17a 0.9 + acl.6 0 + share 0.4 | 8.3 |
| MUST, WAN and discovery | S22 1.6 + S26 0.8 + S35 1.6 + S36a 0.4 + S41 0.3 | 4.7 |
| MUST, management and automation | S29 3.0 + S30 1.3 + S31 1.6 + S33 4.5 + S34 1.0 + S28 1.0 + share 0.1 | 12.5 |
| **MUST** | of which MUST by value (†): 9.6 | **42.5** |
| MUST with a 10 % contingency and the work already done | 42.5 + 4.3 + 0.5 | **47.3** |
| SHOULD and COULD, rec | S8 2.2 + S7 1.3 + C8g 0.3; S23 2.3 + S12 1.0 + S14 1.0 + 0.1; S36b 1.1 + C16 0.8 + C17 0.7; C22 2.0 + C23 1.0 + S27 1.2 + 0.2; C26 1.1; S38 0.6 + R63d 0.3 | 17.2 |
| **The recommended plan** | 42.5 + 17.2 + 0.6 (X-5 videos, Q11) | **60.3** |
| Review contingency (≈ 10 %, spent before any cut; it also covers the process overhead of rule 22) plus the work already done | 6.0 + 0.5 | 6.5 |
| **The recommended plan with the contingency** | 60.3 + 6.5 | **66.8** |
| Not recommended | S17b 3.1, C8 1.5, C14 2.0, C15 3.8, C20 0.4, C21 2.3, C24 1.5, C29 0.5, share 0.1 | 15.2 |
| **Every candidate item** | 60.3 + 15.2 | **75.5** |
| Every item with a 10 % contingency and the work already done | 74.9 + 7.5 + 0.5 | **82.9** |

Options outside the totals: S17b's NAT virtual reassembly (+0.4); S11 with `ipv6 access-class` stored and graded by
configuration only (−0.4, A-3); S35 with CDP only (−0.4, W-2); C8 proper only if its gate fails (+1.5).

**Reconciliation with the maps.** Map 01 routing 14.7 (here 10.7 MUST + S8 2.2 + S7 1.3 + C8g 0.3 = 14.5, plus the 0.3
already done (S4 0.2, R-sh 0.1) = 14.8: S7 +0.1 for IPv6, R-11). Map 02 ACL 15.8 with S17 whole (here 8.3 + 4.4 +
S17b 3.1 = 15.8). Map 03 WAN 13.5 (here 4.7 + 2.6 + C14 2.0 + C15 3.8 + C20 0.4 = 13.5). Map 04 management 21.5 (here
12.5 + 4.4 + 4.4 = 21.3, plus the 0.2 already done = 21.5). Map 05 health 5.0–5.9 (here H1–H7 5.1 + S38 0.6 + R63d 0.3 =
6.0; the 0.1 difference is map 05's unstated "minus overlap", kept here as cost). Added by this brief: X1 0.4, X3 0.5
(map 05 priced neither the flip's own proofs nor the exit gate), X2 0.3 (map 05's course base; the per-lab and
per-lesson parts are inside the items, §8 "Course work"), C26 1.1 (no map priced it).

**For scale.** P3a's approved plan was 123.2 ew (135.5 with contingency) and its MUST 69.8. P3c's recommended plan is
≈ 0.48 × P3a's approved plan; its MUST is ≈ 0.61 × P3a's MUST.

**Cut order, for use under pressure only** (the contingency is spent first; each cut removes whole wave items, turns
the named labs or tasks back into theory and re-stages their objectives, and is recorded in §8.5b; an item is never cut
before the items that depend on it — C23 before S33, S23 before S10, S30 and S31 before S29):
1. The rec COULD and the low-value SHOULD items: C8g, S27, C16, C17, S36b, S12, S14, R63d.
2. The rec SHOULD items with an objective or a lab task, lowest exam value per week first: S23, S7, C26 (automation.8
   becomes `'theory'`, its fallback), S8 (lab 06 loses its task), C23 (management.5 re-staged), S38 (lab 30 grades SPAN
   by table instead and drops the clear-text task), C22 (lab 39 not built).
3. **S6, decided at its checkpoint at the end of W2a** (§7): after W2a about 4.0 ew remain (the v3 daemon, CLI, adapter,
   web switch, lab 09); cutting it then re-stages ospf.10 and leaves the refactor and the plumbing in place. After the
   checkpoint S6 is not cut.
4. The **MUST by value (†)** items, lowest value per week first: S41 (−0.3), S36a (−0.4), S26 (−0.8), C7 (−0.8; lab
   07 loses its MTU fault), S17a (−0.9; the ACL fragment rule stays only if S12 is kept), S35 (−1.6), S28 (−1.0;
   automation.4 stays `'theory'`), S22 (−1.6; wan.1 stays `'theory'`), S10 (−2.2; only after S23).
5. Only then the **MUST (objective)** items: S31 (−1.6), S30 (−1.3), S34 (−1.0; lab 30 loses its SPAN task).
6. **Never cut** once W1a starts: H1–H3, X1–X3, S4, S5, S11, S15, S16, S29, S33. H4, H5 and H6 are spent in W0h and H7
   in W1a, so they are not cuttable after those waves.

### 8.5 Decision record

The review split the record in three. **§8.5a** holds the 12 questions only the product owner can answer (scope, money,
what learners see, legal, release); their "Recorded" column is empty until the product owner answers. **§8.5b** holds
the architect's rulings on every other row of the first draft (implementation choices the brief already argues), each
with its decided value, recorded as "architect" and open to challenge at the next review. **§8.5c** holds the
machine-read Approved ids. Wave 0 cannot start until §8.5a is answered and §8.5c reflects the answer to Q1. The
architect then adds exactly the approved blocks, writes `P3C_APPROVED_ITEMS`, and the exit gate (W7) checks the scope
list item by item. Row ids keep the first draft's numbering (X from map 05 and this brief; R map 01; A map 02; W map
03; M map 04); each question names the rows it decides.

#### 8.5a Questions for the product owner

| # | Question (plain words) | Architect's recommendation | Recorded |
|---|---|---|---|
| Q1 | **Scope and budget.** How much of P3c do we build? The recommended plan costs 59.7 engineer-weeks (66.2 with a safety margin); the minimum (MUST only) costs 42.5 (47.3). In particular: do we keep OSPF for IPv6 (S6, 5.8 weeks, the single biggest item, reviewed at a keep-or-cut checkpoint after wave W2a), and the "nice to have" items with little exam value (the API client app S27, PPP through the carrier cloud C16, GRE keepalives C17, IPv6 over GRE S36b, ACL extras S12, ARP ACLs S14, debug lines on a new line R63d)? (decides X-1, X-17, R-10) | Approve the recommended plan, with S6 kept and reviewed at its W2a checkpoint | Approved as recommended (product owner, 2026-10-14) |
| Q2 | **Labs.** Add five new labs (08 multi-area OSPF, 09 OSPF for IPv6, 30 watching the network, 31 backups and upgrades, 39 playbooks) and new tasks in four existing labs (06, 07, 17, 20)? Those four labs get a new version, so a learner's saved progress on them is checked again. Lab 20's storm-control task is graded from the configuration and a status row written when the line is typed, with no traffic needed. (decides X-6, R-5, A-10) | Yes: five new labs and the four edited ones; no second lab per lesson | Approved as recommended (product owner, 2026-10-14) |
| Q3 | **The promise about objectives.** After P3c, no course objective may still say "coming in P3c". An objective whose item is not built moves to a later stage (P4 or P5) or, if its lesson already explains it, becomes "theory". Do you accept that the WAN explorer, the YANG browser and the SDN explorer meet their objectives as "theory" only (explorers cannot be graded)? (decides X-4, M-4, W-11) | Yes | Approved as recommended (product owner, 2026-10-14) |
| Q4 | **Existing CCNA 3 worlds change a little, without a new "defaults" setting.** In worlds learners already saved: routers with two OSPF areas start sending summaries; an IP phone learns its voice VLAN from the switch and stops passing discovery packets to the PC behind it; mismatched CDP neighbours log a warning; `show version` gains two lines; debug lines start on a new line; and two OSPF neighbours with different packet sizes (MTU), such as a jumbo-frame data-centre switch and a normal router, no longer become neighbours, which is what real devices do. Accept these for existing worlds? (decides X-2, X-9, M-1, W-1, W-4 and the C7 DBD MTU check) | Accept: each matches real devices, and CCNA 1 and 2 worlds do not change | Approved as recommended (product owner, 2026-10-14) |
| Q5 | **Saved files.** A world with a file in a router's flash memory or a changed configuration register saves in a new file format (1.4), which today's live site cannot open. Every other world saves exactly as before. Accept? (decides X-3) | Accept | Approved as recommended (product owner, 2026-10-14) |
| Q6 | **Simplifications a learner might notice.** Approve as a whole: big packets are dropped, never split into fragments; SNMP version 1 is refused; password recovery works on routers only; the IPsec tunnel interface carries IPv4 only; one OSPF-for-IPv6 process per router, without authentication; OSPF SHA key chains are not offered. (decides A-14, M-12, M-11, W-7, R-6) | Approve; each is listed in the device catalog and its lesson | Approved as recommended (product owner, 2026-10-14) |
| Q7 | **What waits for later.** Confirm: PPP multilink → P5; PPPoE → P4; the invisible fair-queue default → never; NETCONF → P5 (so its objective is "theory"); FTP → P4; USB flash → P5; real fragmentation → P4; OSPF scale work only if its test fails; OSPF `area range` and stub areas → P5; no target above 50 routers. (decides W-9, W-10, M-15, M-19, M-20, R-3, R-18) | Confirm as listed | Approved as recommended (product owner, 2026-10-14) |
| Q8 | **Release.** One release at the end (the exit gate), or an early release of the faster loading (wave W0h) with its own mini-check? Either way the live site stays exactly as it is today until you approve the final merge. (decides X-11, rule 21) | One release at the exit gate | Approved as recommended (product owner, 2026-10-14) |
| Q9 | **How we work.** Accept the process rules 22–28: at most six builders at a time, separate runs of about 90 minutes, slow test runs only on mains power, a saved checkpoint after every run, test tiers, and a record of the real effort. They trade some speed for being able to resume after an interruption. (decides X-12) | Accept | Approved as recommended (product owner, 2026-10-14) |
| Q10 | **Legal.** Who reviews the SNMP object identifiers (we use the documentation number RFC 5612 reserves, never a vendor's), the text of the management information base, the playbook language (our own, naming no vendor tool) and the new `show` layouts, and is that done before wave W1b? (decides M-22, M-17) | Your legal reviewer, before W1b, as in P3a | Approved as recommended (product owner, 2026-10-14) |
| Q11 | **Videos.** No new videos in P3c? (decides X-5) | No videos | **Add videos** (product owner, 2026-10-14): ruling X-5 below |
| Q12 | **Choices learners see.** The API client app on every device that has the web browser, without saved history between sessions; the ACL packet tester in the web view only (not a CLI command); the server's command line gains `dir`, `type` and `del`. (decides M-2, M-3, A-1, M-5) | Yes to all three | Approved as recommended (product owner, 2026-10-14) |

#### 8.5b Architect's rulings

| # | Decision | Ruling (decided value) | Recorded |
|---|---|---|---|
| X-7 | The loop-storm case (D-C7) | Keep `runFor(1 s)` (R61 (c)), move it to the explicit `GATE_TESTS` list, speed it up with S40 | architect |
| X-8 | C32 (a) (D-C8) | Delete `DemuxSelector.frame`, contract and capwap-wtp together in W0h | architect |
| X-10 | The P3 golden's world list (D-C10) | The 21 labs (frozen by lab id per shard), the P3 sandbox, the 9 templates as P3 worlds, two synthetic guard worlds (D3); guard world 1 re-recorded at W1b | architect |
| X-13 | Home-router derivation of P3c daemons (D-C13) | P3c rows derive only where `cli.shell !== 'none'` (D6) | architect |
| X-14 | Scope list for the exit gate (D-C14) | H1–H7, X1–X3 and every approved id of §8.5c; every other item recorded with its stage (§12.1); every objective with its `handsOn` value | architect |
| X-15 | A build stage `'P3c'` (maps disagree, §1.1) | Yes (D1), for the phone's reused `cdp`/`lldp` rows and the stage-gated constants (corrected rationale) | architect |
| X-16 | Acceptance naming and the approved list | `accept.p3c.*`, `P3C_APPROVED_ITEMS` from §8.5c, `accept.p3c.coverage` from W0 with pending rows (rule 28); P3a's guards untouched (D4) | architect |
| X-18 | Where lab 39 lives | `sim/scenarios/ccna3/automation.ts`, between labs 38 and 40; `CCNA3_AUTOMATION_LABS` becomes three labs (§9.2 W5b) | architect |
| X-19 | Fallback of configure-level objectives (X-4's rule) | management.4, management.9 and management.10 → `'untaught:P4'`; automation.6 → `'untaught:P5'` (§11.3) | architect |
| X-20 | The S6 keep-or-cut checkpoint | At the end of W2a (§7, §8.4 cut order step 3) | architect |
| R-1 | The lost multi-area walk-through (Q-S4-1) | §3.1 is binding, with step 9 following RFC 2328 §16.1–16.2 (routes go at T2 + 5 s) | architect |
| R-2 | Does an ABR without an area-0 interface summarise (Q-S4-2) | No (the Cisco rule); the B-flag rule change is stated in D7; the lesson says so | architect |
| R-4 | Real keyed MD5 instead of "simulated MD5" (Q-S5-1) | Yes; `cryptoSeq` from the simulation clock; the fidelity row is removed | architect |
| R-7 | One codec for v2 and v3, or a separate `ospf6` (Q-S6-1) | Separate `ospf6` (D7) | architect |
| R-8 | Refactor v2 into an engine plus adapters, or copy-adapt (Q-S6-2) | Refactor, zero-diff, in two parts (W1a, W1c) | architect |
| R-9 | v3 in the OSPF overlay and the LSDB browser (Q-S6-3) | Overlay family switch yes; the LSDB browser stays v2 (P5) | architect |
| R-11 | S7 for IPv4 only, or IPv4 and IPv6 (Q-S7-1) | Both (+0.1, in the figure) | architect |
| R-12 | S7 shows a host's own path from its default gateway (Q-S7-2) | Yes | architect |
| R-13 | The convergence quiet period (Q-S8-1) | 12 s for `routing`, 5 s for the others | architect |
| R-14 | The fault-clone semantics at settle 0 (Q-S8-2) | Confirmed in W1a; an OBM `faultsFirst` option if needed (§2.10) | architect |
| R-15 | Control-plane or data-plane convergence (Q-S8-3) | Control plane in grading; the panel shows the control plane and, when a ping ran in the window, its first success | architect |
| R-16 | How "stuck in ExStart" surfaces (Q-C7-1) | The neighbour state and the debug line; no new row member; the outcome depends on router-id order (§3.2); lab 07 gives the lower-MTU side the higher id | architect |
| R-17 | `ip mtu` enforced in the IPv4 data plane (Q-C7-2) | Only through S17a's egress check (D8), never by C7 alone; the DBD check is always on; tunnels keep advertising the port MTU | architect |
| R-19 | Where `show ip ospf border-routers` comes from | Computed in the CLI from the LSDB rows through the pure SPF; no `OspfStateView` member (§2.6) | architect |
| A-2 | One ICMP rate gate for both families, or one each (Q2) | One per family, 500 ms each | architect |
| A-3 | `ipv6 access-class` on real IPv6 vty (+0.4) or configuration only (Q3) | Real IPv6 vty, under D8's three conditions | architect |
| A-4 | `no ip unreachables` also silences no-route and port-unreachable (Q4) | Yes for the ACL and no-route codes | architect |
| A-5 | NAT with extended lists matches the full tuple (Q5) | Yes | architect |
| A-6 | DAI `validate` drops in their own columns (Q6) | Yes (OBM columns) | architect |
| A-7 | ARP ACL `static` semantics (Q7) | As on real devices: without `static` a no-match falls through to bindings | architect |
| A-8 | IP source guard `port-security` requires port security (Q8) | Yes; refused with a message | architect |
| A-9 | Storm-control percent of which speed (Q9) | The operational speed | architect |
| A-11 | NAT and fragments (Q11) | Moot while S17b is deferred; then a listed deviation | architect |
| A-12 | Tunnels pre-fragment when DF is clear (Q12) | Moot while S17b is deferred; then no (keep D15's drop) | architect |
| A-13 | Help goldens for the ACL and access-layer words (Q13) | `cli-help.p1` never moves; `cli-help.p05` moves by insertions only, regenerated at W3a2 and inside the W4b flip; no removals (§9.4) | architect |
| A-15 | Flip acl.6 by retracing to labs 15 and 16 (Q15) | Yes | architect |
| A-16 | When the `storm-control` row is first written | Once when the line is stored or the port comes up; its counters are not live values (§3.7) | architect |
| W-2 | LLDP-MED in scope, or CDP only (map 03 Q1) | In scope, with the MED Capabilities field | architect |
| W-3 | A typed phone `voice vlan` overrides the learned one (S35 (b)) | Yes (keeps P2) | architect |
| W-5 | The recursion hold: fixed 10 s or configurable (S36 (a)) | Fixed 10 s | architect |
| W-6 | IPv6 over GRE without OSPFv3 (map 03 Q3) | Yes; static routes teach it | architect |
| W-8 | S41 native-VLAN check on access ports too (map 03 Q4) | No; trunks only (no CDP byte changes) | architect |
| W-12 | S26: lab 28's document names the overlay; lesson 28 points to it | Lab 28 unchanged (no bump); lesson 28 points to the overlay | architect |
| W-13 | C16: a lab 22 variant through the cloud | No; sandbox only | architect |
| M-6 | `copy tftp: running-config` merges or replaces (Q29c) | Merges (real behaviour) | architect |
| M-7 | Switches get `flash:` and `copy … flash:` (Q29d) | Yes, like routers | architect |
| M-8 | A reload into a newer image changes only `show version` (Q30a) | Yes; a fidelity row | architect |
| M-9 | `verify /md5` (Q30b) | Include | architect |
| M-10 | The break window (Q31a) | Power-on to boot completion (`bootNs`) | architect |
| M-13 | The manager on `programmable` and an NF-Py `snmp` module (Q33b) | On `programmable` yes; no NF-Py module | architect |
| M-14 | SPAN copies count in the destination's port counters (S34) | Yes | architect |
| M-16 | The playbook's table (Q22a) | `script-runs` widened (`kind`, `recap`) | architect |
| M-18 | SNMPv3 crypto (C23) | Real HMAC-MD5; SHA a simulated tag (the C13 rule) | architect |
| M-21 | Help goldens for the management words (map 04 F4) | As A-13: insertions only in `cli-help.p05` at W3a2 and W4b; `cli-help.p1` never moves | architect |
| M-23 | How a copy to flash knows its size, and where `nominalBytes` lives | The RFC 2349 `tsize` option with an OACK; the 16-byte image header; `StoredFileMeta.nominalBytes` (§3.4, §2.9) | architect |
| M-24 | `config-register` | An immediate command writing the persistent register, never a stored line (D10) | architect |
| M-25 | Lab 30's clear-text community task | Graded by `packetSeen` with a `drive.snmp` GET window (`snmp.community == "NMS-RO"`), not a passive window | architect |
| M-26 | The SNMP contracts | `SnmpValue` gains the three RFC 3416 exceptions; `snmp.op.nonRepeaters` (OBM); the host-app request carries `version` | architect |

#### 8.5c Approved ids (machine-read)

`p3c-approved-items.test.ts` reads the bold array below with `\b(?:[SC]\d+[ab]?|R63d)\b` and proves it equal to
`P3C_APPROVED_ITEMS`. It holds every approved id, MUST and health items included, with the split ids `S17a`, `S36a`,
`S36b`, `R63d`, and `C8` meaning the OSPF scale gate only (C8 proper needs its own row). It is the recommended plan
until the product owner answers Q1; the answer edits this row before W0.

| Row | Ids | Recorded |
|---|---|---|
| Approved ids | **S40, S39, C32, S4, S5, S6, C7, S11, S15, S16, S10, S17a, S22, S26, S35, S36a, S41, S28, S29, S30, S31, S33, S34, S8, S7, C8, S23, S12, S14, S36b, C16, C17, C22, C23, S27, C26, S38, R63d** | architect, after Q1 (recommended plan approved by the product owner, 2026-10-14) |

---

## 9. Migration list

Every existing test, pin or golden that P3c deliberately changes, with how, by wave. Anything not listed must stay green
unchanged; a failure outside this list is a defect in the change, not a migration. Replacing an exact assertion by a
weaker one is never a migration: every entry keeps the assertion's strength and states the new exact value or the rule
that computes it. Line numbers are at cad4ac9; an owner who finds a pin moved lists its new location in the wave
report. The item that forces a migration performs it, in the same change. Items outside the recommended plan carry
their migrations in Appendix A.

### 9.1 Asserted unchanged (and why they stay green)

- `goldens/accept.p05.p0-sequences.json`, `p1-profile-digests.json`, `p2-profile-digests.json`,
  `p1-template-exports.json`, `p2-lab-exports.json`, `lab-status.p2.json`, and every `accept.p05.*`, `accept.p1.*`,
  `accept.p2.*` test: every P3c daemon is silent until configured (§4.3), every P3c capability row and staged table is
  `since: 'P3c'` or a new name the recorded vocabulary drops, `DeviceSnapshot.storage` stays absent without a user
  file (the virtual image), schema 1.4 is written only with a 1.4 member, and `show version` changes only in P3
  worlds. (`show errdisable recovery` output gains a line on P1/P2 switches, §4.4, but no harness types it.)
- `accept.p3.coverage`, `p3-approved-items.test.ts`, `P3_APPROVED_ITEMS`: no `accept.p3.*` file of an unapproved P3a item
  is created (rule 28). The P3a §10.1 rows of [S4], [S5], [S6], [S11], [S16], [S17], [S29], [S31], [S33], [S34], [S36]
  stay listed there as P3a's record.
- Every `accept.p3.*` test except those §9.2 names: single-area OSPF worlds are unchanged by [S4] (no second area, no
  B-bit change, no StateView member: lab 06's ASBR world included);
  `ospf-interfaces` rows keep their bytes ([S5]'s members are OBM); family-4 ACL keys are unchanged ([S11]); the
  no-ACL, no-validate DAI path is unchanged ([S14]); `accept.p3.gre`'s MTU fallback is unchanged (S17b deferred).
- `l2.arp-inspection.test.ts` details, `core.acl.test.ts`, `readStandardAcls` and its NAT tests ([S12] keeps it
  exported, unchanged).
- `cli.show.handlers.test.ts` and every P1/P2 `show version` pin ([S30] is P3-profile only).
- `http-client` browser and `rest` tests, lab 40's `script-runs` bytes ([S27] keeps headers and body for `gui` calls only;
  [C22]'s `kind` is absent for Python runs).
- The `lab-versions.json` entries and lab documents of every lab not named in §9.2 W5b.
- `test/goldens/cli-help.p1.json`: a frozen floor, never regenerated (`cli.help-superset.test.ts:1-11`).

### 9.2 By wave

**W0 (architect, qa)**

1. Exhaustive records gain their entries as compile stubs: web `DROP_VOCAB` +3 (`ip-source-guard`, `storm-control`,
   `span-destination`), `PROTOCOL_VOCAB` +3 (`ospf6`, `tftp`, `snmp`) with **`RESERVED_PROTOCOL_VOCAB` losing `tftp`
   and `snmp`** (`apps/web/src/vocab/protocols.ts:152-154`; the P3a R22 precedent), so `vocab.test.ts`'s reserved pin
   becomes exactly `ftp`, `smtp`, `pop3`, `imap`; `FSM_VOCAB` +2, `CONCEPT_TOOL_VIEWS` +3 (stub views), `PANEL_TAB` /
   `SURFACE_PANEL_TAB` +2, `Provenance.DROP_LABEL` +3, `markers.ts` labels, `OverlayId` / `RoutingOverlayToggle` +2
   (`canvas/overlays/registry.ts`); engine `TABLE_DESCRIPTORS` +5 (and the `TABLE_LANES` rows as data),
   `FSM_MACHINE_LANES` +2, `ERR_DISABLE_CAUSE_TEXT` +1, `GUI_PANEL_SINCE` +2, `MODES` +4 (reserved until their grammar)
   and `MODE_PROMPT` +4 (data), `lab-schema.ts` reason list +3, every `Record<BuildStage, …>` +1, the capability
   vocabulary +1 (`voice-endpoint`), the checker registry +2 stubs (`convergence`, `packetSeen`), `FACT_AREAS` +9
   (the new `LabFactName`s, area thunks returning `{}`), `NEIGHBOR_AREAS` +1 (`ospfv3`), and the CLI registries' empty
   fragments (§7 W0). `timeline.lanes.test.ts`'s typed records gain the rows. `vocab.test.ts` stays exhaustive.
2. `BUILD_STAGES` pins (the catalog and stage tests that list the stages) gain `'P3c'` last.
3. `contracts.optional-by-meaning.test.ts` gains the §2.14 rows (`DemuxSelector.frame` stays until W0h); the web
   `protocol.optional-by-meaning.test.ts` gains the bridge rows and `RunToIdleSnapshot.runStopped 'quiet'`.
4. `test/p2-digests.harness.ts` becomes a wrapper of `profile-digests.harness.ts`; the four P2 shards pass unchanged.
5. `vitest.workspace.ts`: `accept.p2.loop-storm-bounded` and `accept.p3.ospf-scale` move from `SLOW_TESTS` to the new
   explicit `GATE_TESTS`; `accept.p3c.silence` joins `SLOW_TESTS`; `accept.p3c.ospf-scale-multiarea` joins
   `GATE_TESTS`.

**W0h**

6. [C32] (c) `apps/web/test/timeline.strip.test.ts:41,300`: the cases pinning `TIMELINE_UNAVAILABLE_TEXT` are deleted
   with the dead path they test (named here, rule 11); the strip's remaining cases are unchanged.
7. [C32] (a) `contracts.optional-by-meaning.test.ts` **loses** `DemuxSelector.frame`, in the same change as the
   contract and `capwap-wtp.ts:896`; the capwap-wtp `handles` pin (if one asserts `frame: 'data'`) drops the member;
   the P2 wireless digests prove behaviour unchanged.
8. Bundle split: web tests that import engine values from `'@netforge/engine'` in `src/` paths move to the pure or
   subpath entry, assertions unchanged.

**W1a**

9. [S39] `accept.p3.grader-bounded`: the documented EtherChannel exception is replaced by an exact deterministic
   event bound for that wrong answer (a strengthening; the bound is computed from `LAB_CLONE_IDLE_FIRST_EVENTS` and
   `QUIET_WINDOW_MS`, never typed).
10. [S29] io: the `TOPOLOGY_SCHEMA_IDS` and `LATEST_TOPOLOGY_SCHEMA_ID` pins gain 1.4; `schemaIdFor` pins gain the 1.4
    cases; every 1.1–1.3 export pin is unchanged.

**W1b**

11. `pdu.codecs.p3.test.ts:406-415`: the reserved list becomes exactly `ftp`, `smtp`, `pop3`, `imap` (tftp and snmp
    leave it); the dispatch table pins gain 69, 161, 162 and IPv6 NH 89; the 69 and 161 rows keep stage `'P1'`.
12. `cli.modes-rules.test.ts:122-124`: `snmp-server` now has a rule; the assertion moves to `ftp-server` (a word with
    no rule) with the same strength.
13. `device.runtime.test.ts:322-324`: the arbitrary rule-less line becomes `no ip ftp username lab` (still rule-less in
    P3c).
14. The P3 golden's guard world 1 (decode-only: its UDP 69/161 probes now decode as `tftp`/`snmp`), re-recorded by the
    architect in the W1b fix run (§9.5).

**W2a**

15. [S36a] `test/wan.gre.test.ts:180-191` ("it stays down (no flap)"): becomes the flap — down at T, up at T + 10 s,
    down again, under `runFor(30 s)`, exact instants; `accept.p3.gre.test.ts:277-286`'s comment "[S36]'s flap is not
    approved" is updated (no assertion moves).
16. [S16] every pin of `show errdisable recovery` output and of `ERR_DISABLE_CAUSES` (`cli.port-security.test.ts`,
    `cli/handlers/errdisable` tests) gains the `storm-control` row last, on every profile (§4.4).
17. [S11] none: the `AclRow`, `DropRule`, `acl.filter`/`acl.check` and `aclKey` changes are value widenings, so every
    family-4 row, key, drop and fixture keeps its bytes (asserted by `accept.p3.acl-*` unchanged).

**W2b**

18. [S12] `cli.nat*.test.ts` pins of `MSG_BAD_ACL_REF`: the new wording, exact.
19. [S4] lab 07's and lesson 05's unsolved worlds originate summaries: the lab 07 wrong-answer cases in
    `labs.ccna3.*` are re-verified (their assertions are behavioural and do not move); lab 07's P3 golden entries move
    (§9.5); any router-LSA pin of a two-area router whose area-0 interface is down takes the new B bit (none known).

**W3a2**

20. `cli-help.p05.json` regenerated with **additions only** for the W3a grammar (the §9.4 W3a2 list), and
    `cli.grammar.help-goldens.test.ts` gains `P3C_APPROVED_MODES` (`config-rtr`, `config-ipv6-acl`, `config-arp-nacl`,
    and `rommon` if the mode walk reaches it), a sanctioned step of the architect in the integrate run, checked by
    `cli.help-superset`. `cli-help.p1.json` does not move.
21. R63 (d): the P3-world pins of 47h, `cli.logging.test.ts` and `accept.p3.vty.test.ts` that show a debug line after a
    `!` mark now show it on its own line; the P1/P2 cases are unchanged.

**W3b**

22. [S31] every typed fake of `CliRuntime` and `EngineApi` gains `sendBreak` when its transition `?` is removed (rule 2;
    `test/port.fixtures.ts` spreads and the web engine-API fakes).

**W4b (the flip)**

23. `protocols.registry.test.ts:161-163`: `processFactory('tftp')` **and** `processFactory('ospfv3')` are registered
    now; the two "never registered" probes move to `'netconf'` ([C21], deferred) and `'ftp'` ([C24], deferred), same
    assertion; the `'toString'` probe is unchanged.
24. `device.catalog.p3.test.ts:100` ("`ospfv3`, `tftp`, `snmp-agent`, `snmp-manager` are not in `PROCESS_ORDER`")
    becomes the positive assertion of their §2.1 positions; `:15` and `:135` (`p3Rows('programmable')`, filtered by
    stage) stay true; **`:136`** (`CAPABILITY_PROCESSES.programmable` toEqual `[p3('script-host')]`) becomes
    `[p3('script-host'), p3c('snmp-manager')]`, exact; `:170` gains the second `STAGED_PROCESS_TABLES` row
    `{process: 'eth-switch', tables: ['storm-control'], since: 'P3c', requires: 'managed-switch'}`.
25. `staged.world.p3-parity.test.ts:77` moves to the P3c rows; **`:81`** (`P3_STAGED_PROCESS_TABLES` toEqual
    `STAGED_PROCESS_TABLES`) compares with `STAGED_PROCESS_TABLES` filtered to `since` ≤ `'P3'` (exact, the one P3 row);
    `staged.world.p3c-parity.test.ts` is new.
26. `accept.p3.silence`: its lists gain `ospfv3`, `tftp`, `snmp-agent`, `snmp-manager`, IPv6 NH 89, ff02::5/6, UDP 69,
    161, 162, the three new drop reasons; its assertions do not weaken.
27. NF-IPPHONE's `processes` and capabilities pins in `device.catalog.*` and `accept.p05.catalog` gain
    `voice-endpoint`, `cdp`, `lldp` (stage `'P3c'`).
28. The P1/P2 catalog data tests that list home-router processes are unchanged (D6's `cli.shell !== 'none'`).
29. `cli-help.p05.json` regenerated with **additions only** for the words scoped to the newly derived processes (the
    §9.4 W4b list), a sanctioned step inside the flip, checked by `cli.help-superset`.
30. [S30] P3-world `show version` pins on the real catalog gain the two lines (they need `DeviceModel.storage`, which
    arrives here); the `staged.world` pins of W3a2 are unchanged.

**W5b (labs: course plumbing)**

31. `lab-versions.json` (architect): new entries at version 1 for labs 08, 09, 30, 31, 39; bumps for 06 [S8], 07 [S5]
    [C7], 17 [S11], 20 [S15] [S16], each re-recorded with `NF_RECORD_LAB_VERSIONS=<lab>`.
32. `accept.p3.labs`, `labs.ccna3.solutions.test.ts`, the web `labs.browser.p3.test.ts` and the Gate G text: 21 → 26
    labs (the recommended plan). `labs.ccna3.course.test.ts`: "the eleven lab files" becomes **thirteen** (the ten area
    files, `automation.ts`, and the new `mgmt.ts` and `files.ts`), its `FILES` list gains the two; "in lesson order"
    stays true (the five labs are inserted in lesson order, D5).
33. `labs.ccna3.automation.test.ts:292-309`: `CCNA3_AUTOMATION_LABS` becomes exactly `['ccna3-restconf-change',
    'ccna3-playbook-vlans', 'ccna3-script-inventory']`; lab 39 sits at lab 38's index + 1, lab 40 at lab 39's index + 1
    and stays last; the "every lab of the approved plan has landed" assertion is unchanged in strength.
34. `accept.p3.lab-document.test.ts:214-216`: `LABS.length` becomes `15 + 20 + 26` and the category list
    `…Array(26).fill('ccna3-lab')`; the edited labs' documents and the new ones round-trip.
35. `curriculum/ccna3/lessons.ts`: `lab:` set on lessons 08, 09, 30, 31, 39 (course); "every lab reachable from exactly
    one lesson" holds with 26 labs. `curriculum.ccna3.videos.test.ts:373`: `lesson(L39)?.lab` becomes
    `'ccna3-playbook-vlans'`, exact (the lesson's text pins move in W6).
36. `apps/web/test/learn.landing.test.ts:127-128`: `courseFacts(ccna3)` becomes `{modules: 14, lessons: 40, labs: 26,
    minutes: <the new sum of lesson minutes>}` and the text "… 26 of them with a lab …", both exact, the minutes computed
    from the lesson data in the change and typed there (lab 07's minutes +10 do not count: lesson minutes only).

**W6 (course)**

37. `curriculum.ccna3.test.ts:160-242`: the 18 `'later:P3c'` rows take their §11.3 values exactly; `:453`'s counts
    become `{lab: 59, theory: 13, 'later:P3c': 0, 'untaught:P4': 6, 'untaught:P5': 3}` (recommended plan: +14 lab,
    +4 theory; a cut item's row takes its §11.3 fallback and the counts follow, exact).
38. `curriculum.ccna3.commands.test.ts:696-697`: lesson 08's "does not build area border routers yet" and lesson 09's
    "does not run OSPF for IPv6 yet" pins are replaced by the new sentences, exact; the other honesty pins of the
    edited lessons (07, 15, 16, 17, 20, 21, 23, 24, 30, 31, 36, 38, 39) move the same way.
39. `curriculum.ccna3.videos.test.ts:374-377`: lesson 39's "NetForge does not run playbooks yet … planned for a later
    stage" pin is replaced by the new instructions sentence, exact, and the `not.toMatch(/`ccna3-…`/)` line drops L39;
    `:461`: lesson 38's "NETCONF and a YANG browser are not built yet" becomes the new sentence (the YANG browser is
    linked; NETCONF stays theory), exact; every lesson's theory plus video stays within its minutes (asserted
    unchanged in strength).
40. `docs.w8-scope.test.ts:60-99`: "README states P3a" becomes P3c (with ARCHITECTURE-P3C.md named as the binding
    brief); the per-course lesson and lab counts are derived from the lesson `lab:` fields (`:88-99`), so README states
    "CCNA 3 (40 lessons, 26 labs)" and "Three courses and 61 labs" (recommended plan).
41. The CCNA 2 lesson 08 voice sentence (`curriculum/ccna2/theory-a.ts:253`): any pin of it in
    `curriculum.ccna2.*` moves to the new wording, exact.

**W7 (gate)**

42. `ObjectiveHandsOn` and `OBJECTIVE_HANDS_ON` lose `'later:P3c'`; `curriculum.ccna3.test.ts:408`'s value list and
    `:453`'s counts lose the key.

### 9.3 P1-profile and P2-profile digest changes (the only ones allowed)

None.

### 9.4 Help-golden changes (additions only)

- **`cli-help.p1.json` never moves.** It is the frozen floor (`cli.help-superset.test.ts:1-11`).
- **`cli-help.p05.json` moves by insertions only, at exactly two sanctioned regenerations** (D12): the W3a2 integrate
  run and inside the W4b flip, each by the architect and checked by `cli.help-superset` (p05 ⊇ p1, frozen order kept,
  `ALLOWED_REMOVALS` empty). The golden records each mode's top-level words, the `show ` and `debug ` subtrees and
  config-if's top level (`cli.grammar.help-goldens.test.ts:21-45`), so only new words at those levels move it. Rule:
  a spec scoped to a P3c daemon (`ospfv3`, `tftp`, `snmp-agent`, `snmp-manager`) appears at W4b; every other new spec
  appears at W3a2 (on the models that run its scope process, which for `acl` means every NF-OS router and managed
  switch). Expected additions (the integrate run diffs the generator's output against this list; a word not listed is a
  defect, a listed word missing is a defect):

| Model family | Listing | W3a2 | W4b |
|---|---|---|---|
| NF-OS routers | config | `boot`, `config-register` | `snmp-server`, `tftp-server` |
| NF-OS routers | priv-exec | `dir`, `delete`, `verify` | — |
| NF-OS routers | priv-exec show | `flash:`, `file` | `snmp` |
| NF-OS managed switches | config | `boot`, `config-register`, `monitor`, `arp` (if not already listed) | `snmp-server`, `tftp-server` |
| NF-OS managed switches | priv-exec | `dir`, `delete`, `verify` | — |
| NF-OS managed switches | priv-exec show | `flash:`, `file`, `monitor`, `storm-control` | `snmp` |
| NF-OS managed switches | config-if | `storm-control` | — |
| host shells of servers | user-exec | — | `snmpget`, `snmpwalk`, `snmpset`, `service` (if not already listed), `dir`, `type`, `del` (M-5's gate: runs `script-host` or `tftp`) |
| new mode listings | — | `config-rtr`, `config-ipv6-acl`, `config-arp-nacl`, `rommon` if the walk reaches it (`P3C_APPROVED_MODES`) | — |

- Sub-word listings are not recorded and do not move the golden: `ping <target> ?` (`size`, `df-bit`, `repeat`),
  `errdisable recovery cause ?` (`storm-control`), host `ping ?` (`-l`, `-f`), `ip ?` (`verify`, `mtu`), `ipv6 ?`
  (`router`, `access-list`, `traffic-filter`, `ospf`).
- No golden loses a word.

### 9.5 P3-profile digest and lab-status changes (the only ones allowed)

Each entry is re-recorded by the architect in the fix run of the wave named, entry by entry, never wholesale (rule 9's
protocol); every item that moves one is ⚑. "Entries" means, per named world, its entries in
`goldens/p3-profile-digests.json`, `goldens/lab-status.p3.json` and `goldens/p3-lab-exports.json`, whichever the change
moves.

| Wave | Item | World(s) | What moves |
|---|---|---|---|
| W1b | pdu run b [S29] [S33] | guard world 1 of `-guards` | decode only: the UDP 69/161 probes and the ICMP errors quoting them summarise as `tftp`/`snmp` (`PduSummary.proto`, `.layers`, `.summary`); the pass condition (protocol or port unreachable, no `sockets` row) is asserted separately and never re-recorded |
| W1b | disc [S41] | any golden world holding a trunk native-VLAN or duplex CDP mismatch (lab 34 `ccna3-troubleshoot-enterprise` is checked first) | the new log events; the item lists the worlds it found |
| W1b | disc [S35] | any golden world with a `switchport voice vlan` port on a P3 switch (lab 27 `ccna3-qos-voice-first` is checked first) | TLV 9 in the switch's CDP on that port; the item lists the worlds it found |
| W2b | l2 [S35] | none expected | no golden world contains an IP phone (`templates.ts` and `ccna3/*.ts` have none), so the phone's transparent-path change and its answers (after W4b) move nothing |
| W2b | ospf [S4] | lab 07 `ccna3-troubleshoot-ospf` (unsolved world) and any world the B-bit scan finds | the summaries R2 originates; any changed B bit; lab 06 must not move |
| W3a2 | cli-runtime R63 (d) | any golden world whose fixed script prints a debug or log line mid-line | the leading newline |
| W4b | catalog [S30] | any golden world whose fixed script runs `show version` | the two lines (they need `DeviceModel.storage`, which the flip adds) |
| W5b | architect, with the W5a lab items [S5] [C7] [S8] [S11] [S15] [S16] | labs 06, 07, 17, 20 | their documents change: each lab's three entries (`p3-profile-digests`, `lab-status.p3`, `p3-lab-exports`) |

Nothing else. In particular the 9 templates and the P3 sandbox are expected unchanged; a template that moves is a defect
unless a row above names it. The P3 golden never gains a world: the five new labs are proved by `accept.p3c.labs`,
`-grader-bounded` and `-determinism`, not by the P3 golden (D3: its shards are frozen by lab id).

---

## 10. Acceptance tests

Definition of done for P3c:
- the six checks, the `slow` project and the `gate` project green, and gate G passed on the final build;
- no test deleted, weakened or skipped except the named migrations of §9; the exit gate applied;
- `accept.p2.p1-digests`, `accept.p3.p2-digests-*`, `accept.p3.p2-exports`, `accept.p3.lab-status` green with no change;
  the `accept.p3c.p3-digests-*` shards, `accept.p3c.p3-exports` and `accept.p3c.lab-status-p3` green with only the §9.5
  changes;
- every acceptance scenario run 3× with the same seed gives byte-identical trace and snapshot JSON;
- the legal scan clean; no `'later:P3c'` left (§11.3).

Times are sim time. From W4a the tests build their worlds with `staged.world` at stage `'P3c'`, which equals the real
catalog once W4b lands. Counts that follow from constants are computed from the constants, never typed.

### 10.1 Engine acceptance (`packages/engine/test/`)

The table is machine-read by `accept.p3c.coverage` with the rule of `accept.p3.coverage`, adapted: every row's first
column is exactly one back-ticked name matching `^accept\.p3c\.[a-z0-9-]+\.test\.ts$`, followed by a wave tag (`(W0)`,
`(W0h)`, `(W4b)`, `(W5b)`) or one item tag matching `\[(?:[SC]\d+[ab]?|R63d)\]`; one file per row. The second column,
**Arrives**, is the wave (`W0`, `W0h`, `W4a`, `W4b`, `W5b`) in which the file is written. A row is **pending** while
`P3C_CURRENT_WAVE` is earlier than its Arrives wave: the check then asserts only that the file is absent or, if present,
named by this row (and, like any test, passing); from its wave on the file must exist; at W7 every approved row must exist. A row tagged with an item
is required only when `P3C_APPROVED_ITEMS` holds that item; the rows of items not approved stay listed as designs and
must not exist as files. Appendix A rows are never required in P3c. `P3C_APPROVED_ITEMS` holds every approved id
(§8.5c), MUST items included, with the split ids `S17a`, `S36a`, `S36b`, `R63d`, and `C8` meaning the gate only (C8
proper needs its own §8.5 row); the web-only items ([S7], [S22], [S26], [S27], [S28], [C26]) have §10.2 rows and no
§10.1 row. Every file named `accept.p3c.*.test.ts` must be named by a row, this file included.

| Test | Arrives | Scenario and pass condition |
|---|---|---|
| `accept.p3c.p3-digests-templates.test.ts` (W0) | W0 | The 9 templates loaded as P3 worlds with the fixed script: the digest and per-kind counts over all event kinds, the per-10-second-window digests, the stored non-background event lines, the typed results and the normalised snapshot hash equal `goldens/p3-profile-digests.json` exactly; a mismatch names its world and window. §9.5 lists the only allowed changes. |
| `accept.p3c.p3-digests-labs-a.test.ts` (W0) | W0 | As the templates shard, for the 7 lab ids frozen in the golden for shard a (the first 7 names of `CCNA3_LAB_ORDER` at cad4ac9, `ccna3-ospf-dr-election` … `ccna3-acl-standard`), loaded as `loadScenario` loads them (60 s boot, solution, probes, 600 s); the shard never reads the live order. |
| `accept.p3c.p3-digests-labs-b.test.ts` (W0) | W0 | The 7 lab ids frozen for shard b (`ccna3-acl-extended` … `ccna3-qos-voice-first`). |
| `accept.p3c.p3-digests-labs-c.test.ts` (W0) | W0 | The 7 lab ids frozen for shard c (`ccna3-discover-neighbours` … `ccna3-script-inventory`). |
| `accept.p3c.p3-digests-guards.test.ts` (W0) | W0 | The P3 `addDevice` sandbox (pins CDP, `service timestamps`, extended logging) and two synthetic guard worlds: (1) an NF-C2960 with Vlan1 addressed and up and an NF-2911, probed with UDP 69 and 161 datagrams, a TFTP RRQ and an SNMP GET from a server: the **pass condition** is asserted from the live world on every run and never re-recorded (dormant switch: protocol unreachable; router: port unreachable; no `sockets` row); its digest entries move once, at W1b, when the probes start decoding as `tftp`/`snmp` (§9.5, re-recorded by the architect); (2) a dual-stack router pair with IPv6 static routes and pings: no next-header-89 PDU, no ff02::5 join, rib6 rows byte-identical. |
| `accept.p3c.p3-exports.test.ts` (W0) | W0 | Every CCNA 3 lab of cad4ac9 exported after load equals `goldens/p3-lab-exports.json` byte for byte (schema 1.3, `profile: 'P3'`). |
| `accept.p3c.lab-status-p3.test.ts` (W0) | W0 | The 21 CCNA 3 labs of cad4ac9: `evaluateLab` with every detail, unsolved at 60 s and solved at 710 s, equals `goldens/lab-status.p3.json`. |
| `accept.p3c.coverage.test.ts` (W0) | W0 | Every row of this table names exactly one file; every `accept.p3c.*.test.ts` file is named by a row (this one included); a row whose Arrives wave is later than `P3C_CURRENT_WAVE` is pending (its file absent, or present and named); every non-pending row of an approved id (§8.5c) exists, and no row of an unapproved item exists as a file; at W7 no row is pending. P3a's `accept.p3.coverage` and `P3_APPROVED_ITEMS` are untouched. |
| `accept.p3c.hot-path.test.ts` [S40] | W0h | The loop-storm 100 ms window equals `goldens/p3c-storm-window.json` (event count per kind and trace digest); the benchmark script exists and is excluded from every project. Wall time is recorded in the wave report, never asserted. |
| `accept.p3c.quiet-settle.test.ts` [S39] | W4a | Every lab world of `lab-status.p2` and `lab-status.p3` idles inside the first cap (byte-identical status); P2's EtherChannel wrong answer grades in fewer than the computed bound and reports `stopped: 'quiet'`; an OSPF world with a 40 s wait and an NTP world with retries are not cut short (their tables equal the uncapped run's). |
| `accept.p3c.demux-and-vlan-filter.test.ts` [C32] | W0h | `TraceFilter.vlans` selects exactly the events whose `PduSummary.vlan` is listed; the P2 WLC lab digests are unchanged with `frame` removed. |
| `accept.p3c.silence.test.ts` (W4b) | W4b | On the real (flipped) catalog, 600 s: every template and CCNA 1 lab (P1), CCNA 2 lab (P2) and CCNA 3 lab of cad4ac9 (P3) shows no `pduCreated`, `tableWrite`, `log` or `debug` attributable to `ospfv3`, `tftp`, `snmp-agent`, `snmp-manager`, no next-header-89 PDU, no UDP 69/161/162 PDU, no ff02::5/6 join, no drop with a P3c reason, no `storm-control` row, no frame with `meta.mirror`; a home router derives none of the P3c daemons; an NF-IPPHONE in a P2 world sends nothing. |
| `accept.p3c.ospf-multiarea.test.ts` [S4] | W4a | §3.1 exactly: R2's router-LSAs with B in both areas; the type 3s at U + 5 s and U + 15 s with their metrics; the type 4 for 3.3.3.3 into area 1 only; R1's `O IA` routes at U + 15 s and U + 25 s and `O*E2` via the type 4 at U + 25 s; R1's LSDB holds no area-0 type 1; `show ip ospf border-routers` exact lines (computed from the LSDB, no StateView member); the flush on a lost network (removed at T + 10 s); the ABR that loses area 0: R2's area-1 router-LSA without B at T2, and every `O IA` route and the `O*E2` default gone from R1 at **T2 + 5 s** (RFC 2328 §16.1–16.2: routing by the B bit), the flushes at T2 + 5 s + δ changing no route; an ABR without area 0 never summarises; the B bit follows D7 (a two-area router whose area-0 interface is down has no B); engine/pure parity of `interAreaRoutes`; `runToIdle` returns. |
| `accept.p3c.ospf-auth.test.ts` [S5] | W4a | Simple-auth Full; a type mismatch refused with its reason and debug line; a key mismatch refused; MD5 Full; a wrong MD5 key refused; a key changed after Full drops the adjacency at dead expiry (`runFor`); no MD5 key byte in any PDU while the simple key is visible; the digest equals an independently computed RFC 2328 D.4.3 vector; `runToIdle` returns in a mismatched world. |
| `accept.p3c.ospf-mtu.test.ts` [C7] | W4a | 1400 vs 1500 with pinned router ids, both orderings: lower-MTU side with the higher id → ExStart on it and Exchange on the other; higher-MTU side with the higher id → ExStart on both; exact states and debug line in each; `ip ospf mtu-ignore` on the lower side gives Full; a 9216-byte jumbo port against a 1500-byte router sticks the same way (the listed P3 change); a GRE tunnel still advertises its port MTU; `runToIdle` returns; `ip mtu` round-trips through export, reload and the clone. |
| `accept.p3c.ospfv3.test.ts` [S6] | W4a | §3.3: dual-stack Full on v2 and v3 independently; hellos from link-local to ff02::5, hop limit 1, NH 89; DR/BDR joins ff02::6 and leaves on losing the role; rib6 `O` rows via link-local next hops on the right interface, at link-up + 15 s (point-to-point); `OI` with [S4]; IPv6 ping end to end; failover after a cut at T + 5 s; `show ipv6 ospf neighbor` and `show ipv6 route` exact; silent when unconfigured; the P1/P2/P3 digest shards unchanged. |
| `accept.p3c.ospf-scale-multiarea.test.ts` [C8] | W4a | 50 routers in 3 areas with 2 ABRs and an ASBR, and a dual-stack variant: converged under the clone cap; a converged minute under a fixed event bound; SPF runs bounded by the throttle; no `action-budget` drop. (`gate` project.) |
| `accept.p3c.convergence.test.ts` [S8] | W4a | P3a §3.2's triangle: a direct cut settles `routing` at T + 5 s ± 10 ms; an indirect failure on a broadcast segment in [T + 30 s, T + 40 s] + 5 s; hello 5 / dead 20 measures less; an EIGRP pair with a feasible successor measures ≈ 0; the lab kind passes and fails at its boundaries; 3 runs byte-identical. |
| `accept.p3c.acl-ipv6.test.ts` [S11] | W4a | §3.6: the SYN denied with a family-6 rule and ICMPv6 1/1 (one per 500 ms); ping6 permitted; an explicit `deny ipv6 any any` breaks ND (the NS counted on the explicit row, the ping fails after the entry goes stale) and `nd-blocked` is reported; the implicit `nd-ns`/`nd-na` rows count when no explicit deny precedes them; `ipv6 access-class` refuses an SSH login over IPv6 with a `refused` row; family-4 keys and rows byte-identical. |
| `accept.p3c.ip-source-guard.test.ts` [S15] | W4a | After a DHCP binding the host pings; a hand-changed address drops `ip-source-guard` at step 7d; DHCP renewal still passes; the static `ip source binding` admits SRV1; with `port-security` a spoofed MAC drops; the option is refused without port security; without snooping nothing is filtered. |
| `accept.p3c.storm-control.test.ts` [S16] | W4a | A P1-profile loop with `storm-control broadcast level 1.00` bounds broadcast bytes per window to the threshold; window edges exact to the ns; hysteresis at `fall`; `pps` and `bps` units; `action shutdown` err-disables with cause `storm-control` and recovers; `action trap` logs once per exceedance; a row written once when the line is stored or the port comes up (state `forwarding`, `current` 0), then only on a state change or once per window with drops; with no traffic the row exists and keeps its first values; with no line the per-frame path is unchanged (the P1 storm window digest equal). |
| `accept.p3c.acl-workbench.test.ts` [S10] | W4a | In P3a §3.3's world: the PC1 SYN's drop rule resolves to row 10 and the stored configuration line; the echo request's provenance carries one permit chip "line 20 in Gi0/0"; `aclEvaluate` on the SYN gives the trail [10 match]; on PC2's SYN [10 miss `source`, 20 miss `protocol`, 30 match]; the worker's decision equals the daemon's row; `TraceFilter.reasons` selects exactly the listed drops. |
| `accept.p3c.mtu-df.test.ts` [S17a] | W4a | §3.8: `ping … size 1600 df-bit` across a 1500 link drops `mtu-exceeded` with ICMP 3/4 carrying 1500 to the source; without `df-bit` it drops "fragmentation is not simulated" with no ICMP; `ip mtu 1400` on the egress makes a 1450-byte ping fail; a 1500-byte ping passes unchanged; the ACL fragment rule and `fragments` keyword on crafted tuples; the "would exceed MTU" scan of every golden world finds nothing. |
| `accept.p3c.acl-advisor.test.ts` [S23] | W4a | Lab 15's unsolved world with the standard list inbound at the staff edge: `standard-near-source` naming the destinations it also cuts; the solved placement: no finding; the impact preview of a draft edit lists the changed flows exactly. |
| `accept.p3c.acl-extras.test.ts` [S12] | W4a | NAT with list 101 translates only TCP 80; `no ip unreachables` turns `U.U.U` into `.....`; the `log-input` line with interface and MAC; a `dscp ef` term matches EF only. |
| `accept.p3c.dai-acl.test.ts` [S14] | W4a | A static host passes by ARP ACL; `static` blocks a bound host absent from the list; `validate src-mac` drops an ARP whose sender MAC differs from the Ethernet source; the counters are written only once nonzero; the no-ACL path is byte-identical. |
| `accept.p3c.cdp-voice-vlan.test.ts` [S35] | W4a | §3.9: the phone learns VLAN 30 by CDP, tags its own frames, leases in VLAN 30; the PC stays untagged in VLAN 10 and receives no CDP; LLDP-MED gives the same result; a typed `voice vlan` wins; in a P2 world the phone sends nothing. |
| `accept.p3c.gre-recursion.test.ts` [S36a] | W4a | P3a §3.10 step 6's OSPF world: the flap is periodic and bounded under `runFor`; up again 10 s ± 1 ms after each down; one log per transition; a static fix stops the hold; `runToIdle` returns. |
| `accept.p3c.cdp-mismatch.test.ts` [S41] | W4a | A native-VLAN mismatch on a trunk and a duplex mismatch each log once (severity 4, original wording); the 60 s rate limit to the ns; no log when matched; no native check on access ports; the console prints them at level 4 in a P3 world. |
| `accept.p3c.gre-ipv6.test.ts` [S36b] | W4a | ping6 across Tunnel0 with one PduId end to end; Packet Too Big at the tunnel MTU; one IPv4 tunnel carrying both families at once; the IPsec VTI still refuses IPv6 with its message. |
| `accept.p3c.ppp-csu.test.ts` [C16] | W4a | R1–CSU–NF-INTERNET–CSU–R2 with CHAP up; one PduId per ping; HDLC through the same chain unchanged; the P1 template digests unchanged. |
| `accept.p3c.gre-keepalive.test.ts` [C17] | W4a | A peer's underlay cut detected in 30 s ± 1 ms (`keepalive 10 3`), the tunnel down `keepalive-missed` and back on the next reply; a key mismatch drops with its detail. |
| `accept.p3c.tftp.test.ts` [S29] | W4a | §3.4: backup to a server (bytes = the text, blocks = ⌊len/512⌋ + 1); restore merges; a lost DATA retransmitted after 2 s; a dead server ends the job at 12 s with `tftpTimeout`; `copy tftp: flash:` sends `tsize 0` and a file too big for flash is refused at the OACK with ERROR 3 and `flashFull`, no DATA moved; a switch copy wakes and re-sleeps the transport; a flash file survives a 1.4 export, reload and the clone; a document without one exports 1.3/1.2/1.1 byte-identically; the P1/P2 digests unchanged. |
| `accept.p3c.image.test.ts` [S30] | W4a | An image copy moves ⌈nominal / 1024⌉ bytes in ⌊bytes / 512⌋ + 1 DATA blocks (81 for 40 960 bytes: 80 full and an empty last one), both computed from the constants; the receiver's file carries `nominalBytes` from the image header and `dir` shows it; `boot system` and a reload run the new version; `show version`'s two lines in a P3 world; a P1/P2 world's `show version` byte-identical; a missing image halts in ROMMON; `verify /md5` equals the MD5 of the stored bytes. |
| `accept.p3c.password-recovery.test.ts` [S31] | W4a | §3.4 step 8 end to end; the journal replays the `cliBreak` exactly; the register survives export and reload in 1.4; a break on a vty is refused; a break outside the window does nothing. |
| `accept.p3c.snmp.test.ts` [S33] | W4a | §3.5: a walk of ifTable returns every interface in ifIndex order and ends at `endOfMibView`; GET of the system group exact; GET of an unknown object answers `noSuchObject`; GETBULK honours `nonRepeaters` and `maxRepetitions`; a wrong community answers nothing and sends `authenticationFailure` when enabled; the community ACL drops silently; SET sysName changes the hostname through the configure seam with `origin {via: 'snmp'}`; linkDown/linkUp traps reach the NMS and write `snmp-traps` rows; coldStart once at boot; `version 1` refused; the BER bytes equal the RFC 3416 golden examples; dormant and silent when unconfigured. |
| `accept.p3c.snmpv3.test.ts` [C23] | W4a | A wrong key draws a report; `authPriv` hides the varbinds in the bytes; `authNoPriv` shows them. |
| `accept.p3c.span.test.ts` [S34] | W4a | rx, tx and both counts exact; a VLAN source; the destination drops what it receives `span-destination`; copies carry `meta.mirror` and new PduIds; an oversubscribed destination drops copies `queue-full`; no copy when unconfigured; a P2 world byte-identical. |
| `accept.p3c.packet-seen.test.ts` [S38] | W4a | `packetSeen` passes for DSCP 46 after LLQ marking, for ESP only at the provider, for `absent` clear-text telnet after SSH-only, for a SPAN copy at the analyser port, and for `snmp.community == "NMS-RO"` in a `drive.snmp` window (a passive window with no poller sees no SNMP and fails); an invalid filter is refused at lab load. |
| `accept.p3c.playbook.test.ts` [C22] | W4a | The first run reports changed = N and the second changed = 0; a failed host does not stop the others; the recap lines exact; replay-exact. |
| `accept.p3c.debug-midline.test.ts` [R63d] | W4a | In a P3 world a debug line during a ping starts on its own line, also through a telnet relay; the P1 case is unchanged. |
| `accept.p3c.labs.test.ts` (W5b) | W5b | Every new lab and task: the unsolved world fails exactly the expected tasks, the solution passes all, each wrong-answer case fails its task; the lab documents round-trip (`lab-document`). |
| `accept.p3c.grader-bounded.test.ts` (W5b) | W5b | Every new lab's unsolved, solved and wrong-answer worlds return under `runToIdle` within the clone cap; an MD5 mismatch, a stuck ExStart from MTU, a storm-control err-disable, an unanswered TFTP server, an unanswered SNMP request each return in fewer than 5 000 events. |
| `accept.p3c.determinism.test.ts` (W5b) | W5b | Labs 08, 09, 30, 31, 39 and the edited labs 06, 07, 17, 20, 3 runs each: byte-identical trace and snapshot JSON. |

### 10.2 Web acceptance (`apps/web/test/`)

- `bundle.engine-imports.lint.test.ts` (W0h): no non-type import of `'@netforge/engine'` outside `src/bridge/worker/**`.
- [C32] `simmode.vlan-chip.test.tsx`; the strip without its dead guards.
- [S7] `route-path-model.test.ts` (a static loop gives `↻`, a missing route `∅`, ECMP fans out, a host's default
  gateway works, IPv6 by `lpm6Rows`); [S26] `neighbours-model.test.ts` (chips, holdtime ring, hollow glyph, "map from
  here"); the persisted-slice migration test.
- [S22] `concept.wan.model.test.ts`; [S28] `concept.yang.test.ts`; [C26] `concept.sdn.model.test.ts`.
- [S10] [S23] the inspector tests of W3b; [S10] `worker.acl-evaluate.parity.test.ts`.
- [S4] [S6] `routing.lsdb-model.summary.test.ts`, `overlays.ospf-model.abr.test.ts`.
- [S8] `timeline.convergence-panel.test.ts`; [S31] `terminal.break.test.tsx`; [S33] `desktop.snmp-manager.test.tsx`;
  [S27] `desktop.api-client.test.tsx` and `.world.test.tsx` (lab 38's topology; W3c); [S29] `inspector.services.tftp.test.tsx`;
  [S34] `netscope.span-shortcut.test.ts`; [S35] `desktop.phone-learned-vlan.test.tsx`; [C22] `automation.run-playbook.test.tsx` (W3c).

### 10.3 Gate G per wave (built bundle, real browser; rule 10)

| After | Script (all in the `netforge-preview` build) |
|---|---|
| W0 | Landing → "Start CCNA 3" → lesson 19 → its lab → Check (0 of 100), the solution typed, Check (100 of 100); every overlay toggled once; no console error (the P3a W8 script, as the baseline). |
| W0h | The W0 script on the split bundle, plus: open every concept tool, the automation workspace, a lab from the labs browser and a lesson with a video; the main chunk's size printed in the wave report; no console error and no unhandled rejection. |
| W1a–W1c | Load `ccna3-ospf-single-area`, apply the solution, Check passes; open the WAN, YANG and SDN tools; toggle the route-path overlay (pick a destination) and the neighbours overlay in a P3 world. |
| W2a, W2b | File → New (P3): R1–R2–R3 with two areas, see `O IA` routes after about a minute (with W2b); `ip verify source` and `storm-control` on a switch; `ping … size 1600 df-bit` shows the drop in the packet inspector. |
| W3a1–W3c | Type `show ip ospf border-routers`, `show ipv6 ospf neighbor`, `show storm-control`, `show monitor session`; open the ACL view and test a packet; send a break on a booting router's console and see ROMMON; open the SNMP manager on a server and walk a router. |
| W4b | The W3 script on the flipped catalog; every CCNA 3 lab of cad4ac9 opened and graded unsolved (0 of 100 each). |
| W5b, W6 | Each new lab opened, its solution applied, Check passes; one edited lab per area likewise. |
| W7 | Landing → "Start CCNA 3" (14 modules · 40 lessons · 26 labs) → lesson 08 → its lab → Check; every overlay of the View menu toggled once; every CCNA 3 lab opened and graded unsolved; no console error. |

---

## 11. CCNA 3 course plan (P3c)

The release is in place (D5): the 14 modules, the 40 frozen lesson ids and the 81 objectives stay; the course layer is
unchanged. This section lists only what changes, for the recommended plan. An item the product owner does not approve
leaves its lesson theory-only and its objective takes the fallback of §11.3.

### 11.1 Lessons that change

| Lesson | Change | Lab |
|---|---|---|
| 06 `default-routes-and-timers` | A paragraph and a panel how-to: measure convergence, then tune hello/dead and measure again [S8] | `ccna3-ospf-default-route` gains a convergence task |
| 07 `fixing-ospf` | "Does not model OSPF authentication yet" becomes instructions; authentication and MTU as two more reasons OSPF will not peer [S5] [C7] | `ccna3-troubleshoot-ospf` gains two faults and tasks |
| 08 `more-than-one-area` | The honesty paragraph becomes instructions; ABR, types 3 and 4, `O IA`, the Cisco ABR rule; type 7 stays theory [S4] | **new** `ccna3-ospf-multi-area` |
| 09 `ospf-for-ipv6` | The honesty paragraph becomes instructions; compare how v3 names neighbours (router ids) and links (link-local) [S6] | **new** `ccna3-ospf-ipv6` |
| 15 `standard-acls` | An "open the advisor" step [S23]; placement now traced to this lab (acl.6) | unchanged |
| 16 `extended-acls` | A short paragraph on ACLs and non-initial fragments [S17a] | unchanged |
| 17 `editing-and-reading-acls` | IPv6 lists and the ND tail; "Test a packet" [S10]; `log-input` and `no ip unreachables` [S12]; time-based lists stay theory (untaught:P4) | `ccna3-acl-edit-verify` gains an IPv6 part |
| 20 `guarding-the-access-layer` | "NetForge simulates neither yet" becomes instructions for IP source guard and storm control [S15] [S16]; an ARP ACL paragraph [S14] | `ccna3-dhcp-snooping-dai` gains two tasks |
| 21 `joining-distant-sites` | `[WAN explorer](concept:wan)`; "labels are shown in the explorer, not on the canvas" replaces the MPLS disclaimer [S22] | theory + `concept:wan` |
| 22 `point-to-point-links` | A note: PPP now runs through a CSU and the cloud in the sandbox [C16] | unchanged |
| 23 `private-paths-over-public-networks` | A `concept:wan` link (the VPN kinds) [S22] | theory |
| 24 `gre-tunnels` | The recursion hold replaces "looks again at the next change" [S36a]; keepalives and `tunnel key` [C17]; IPv6 over GRE [S36b]; DF and ICMP 3/4 [S17a] | unchanged |
| 28 `who-is-next-door` | The neighbours overlay [S26]; a phone learns its voice VLAN by CDP and LLDP-MED [S35]; the mismatch logs [S41] | unchanged (W-12) |
| 30 `watching-the-network` | "See it in NetForge" rewritten: SNMP v2c and v3 polling and traps, SPAN to an analyser [S33] [C23] [S34]; NetFlow stays theory (untaught:P4) | **new** `ccna3-watch-the-network` |
| 31 `looking-after-files-and-images` | File systems, backup and restore, image upgrade and password recovery become hands-on [S29] [S30] [S31] | **new** `ccna3-backup-and-upgrade` |
| 34 `finding-faults-across-layers` | A hint: CDP's mismatch logs [S41] | unchanged |
| 36 `software-defined-networking` | `[Controller explorer](concept:sdn)` [C26] | theory + `concept:sdn` |
| 38 `talking-to-devices-through-apis` | `[YANG browser](concept:yang)` [S28]; the API client app [S27]; NETCONF stays theory (C21 deferred) | unchanged |
| 39 `configuration-as-code` | "Planned for a later stage" becomes instructions [C22] | **new** `ccna3-playbook-vlans` |
| CCNA 2 lesson 08 (voice) | One sentence: a P3 world learns the voice VLAN by CDP; P2 worlds still set it by hand [S35] | unchanged |

Every rewritten paragraph passes `curriculum.ccna3.commands.test.ts` (every backticked command and fence line parses
against the grammar for the lesson's models); lessons stay ≤ 45 minutes; the theory files keep their owner split
(theory-a … theory-d). The five lessons that gain a lab also gain a verified hands-on video (X-5, 0.6 ew).

### 11.2 Labs

Category `ccna3-lab`, profile P3, a fixed seed, a reference solution, at least one wrong-answer case per new kind or
widened member (P3a §11.2 rules). New labs are inserted into `CCNA3_LAB_ORDER` in lesson order (D5).

| Lab | Lesson | Type | Owner (file) | Tasks and how they are graded |
|---|---|---|---|---|
| **08** `ccna3-ospf-multi-area` [S4] | 08 | build | ospf (`ccna3/ospf.ts`) | §3.1's chain plus a LAN router: interfaces in the right areas (`fact ospf.ifaceArea`); R2 is the ABR (`fact ospf.abr`); R1's `route {source: 'O', routeType: 'IA', metric}`; the LSDB synchronised per area (`fact ospf.lsdbSynced`); end-to-end `connectivity`. Text: "allow about a minute and a half" (45 s boot + 25 s for IA routes) |
| **09** `ccna3-ospf-ipv6` [S6] | 09 | build | ospf (`ccna3/ospf.ts`) | `ipv6 unicast-routing` (`config`); `ipv6 router ospf 1` with a router id (`fact ospfv3.routerId`); interfaces in area 0 (`fact ospfv3.ifaceArea`); `neighbor {protocol: 'ospfv3', state: 'full'}`; `route {family: 6, source: 'O'}`; IPv6 `connectivity` |
| **30** `ccna3-watch-the-network` [S33] [S34] [C23] [S38] | 30 | guided | svc (`ccna3/mgmt.ts`, new) | R1, SW1, NMS (server), an analyser PC: a read-only community limited by an ACL (`config`; `aclDecision` NMS permitted, PC denied); link traps to the NMS (`table snmp-traps where {trap: 'linkDown'}` after a `LabFault cut`, live); a SPAN session to the analyser (`config`; `packetSeen` at the analyser port for a probe PC1 → R1); an SNMPv3 user with authPriv (`config`); the community in clear on the wire (`packetSeen` at R1's NMS-facing port with filter `snmp.community == "NMS-RO"` and `drive: {snmp: {from: 'NMS', to: 'R1', community: 'NMS-RO', oid: '1.3.6.1.2.1.1.5.0'}, runMs: 10000}`: the clone's manager sends one GET, so the window contains SNMP traffic; the task text says the read-only community NMS-RO is the one seen) |
| **31** `ccna3-backup-and-upgrade` [S29] [S30] [S31] | 31 | guided | device (`ccna3/files.ts`, new) | R1, R2, SW1, SRV1: back up R1 and SW1 to SRV1 (`fact storage.file` on SRV1 `files:r1-confg`, `files:sw1-confg`); restore a broken line from the backup (`config`); upgrade R1's image (`fact device.imageVersion`, `config` `boot system`); recover R2's unknown secret (`config` `enable secret` changed, `fact device.configRegister` = 0x2102) |
| **39** `ccna3-playbook-vlans` [C22] | 39 | guided | auto (`ccna3/automation.ts`, between labs 38 and 40) | DEV1 (NF-DEVHOST) and three switches: write the inventory and a playbook in `files:`, run it twice (`table script-runs where {kind: 'playbook'}`, the second run with changed = 0); the VLANs exist on the three switches (`vlan`, headless-gradable) |
| 06 (+task) [S8] | 06 | — | ospf | "After the R1–R2 cable is cut, routing settles within 25 s": `convergence {fault: {cut: {a: 'R1', b: 'R2'}}, protocol: 'routing', only: 'ospf', withinMs: 25000}` |
| 07 (+2 faults) [S5] [C7] | 07 | — | ospf | An MD5 key typo on one end and an `ip mtu` mismatch on another link (router ids fixed so the lower-MTU side has the higher id: ExStart on it, Exchange on the other, §3.2): `neighbor {protocol: 'ospf', state: 'full'}` for each pair; minutes +10 |
| 17 (+part) [S11] | 17 | — | acl | A dual-stack R1: filter IPv6 web traffic (`aclDecision {family: 6}`), then break ND with `deny ipv6 any any` and fix it (IPv6 `connectivity`) |
| 20 (+2 tasks) [S15] [S16] | 20 | — | l2 | IP source guard on the access ports: ATTACKER's spoofed ping is dropped (`connectivity {expect: 'fail', droppedAt: 'SW1', dropReason: 'ip-source-guard'}`, `fact ipsg.enabled`); storm control on the uplink (`config` for the line, and `table storm-control where {kind: 'broadcast', rise: 100}`, which holds from the row written when the line is stored; no traffic needed, A-10, A-16; the task never reads `current`, `dropped` or `state`) |

**Counts.** 21 → **26 labs** (the recommended plan); four existing labs gain tasks and a version bump. Labs 08 and 09
carry the OSPF timing warning; lab 07's minutes rise. If S33 or S29 is cut, lab 30 or 31 is not built and lesson 30 or
31 stays theory; a lab whose item is cut never ships half-built.

### 11.3 Objective traceability

Every `'later:P3c'` row takes the value below (recommended plan). The "If the item is not approved" column is X-4's
rule: a describe-level objective whose lesson meets it becomes `'theory'`; a configure-level one is re-staged.

| Objective | Lesson | Item | P3c value | If the item is not approved |
|---|---|---|---|---|
| CCNA3.ospf.9 split into areas | 08 | S4 | `'lab'`, `ccna3-ospf-multi-area` | `'untaught:P5'` |
| CCNA3.ospf.14 LSA types 3 and 4 | 08 | S4 | `'lab'`, `ccna3-ospf-multi-area` | `'untaught:P5'` |
| CCNA3.ospf.10 OSPFv3 | 09 | S6 | `'lab'`, `ccna3-ospf-ipv6` | `'untaught:P5'` |
| CCNA3.ospf.16 authentication | 07 | S5 | `'lab'`, `ccna3-troubleshoot-ospf` | `'untaught:P5'` |
| CCNA3.acl.6 placement | 15 | retrace | `'lab'`, `ccna3-acl-standard` (and 16) | — (no item) |
| CCNA3.acl.10 IPv6 ACL | 17 | S11 | `'lab'`, `ccna3-acl-edit-verify` | `'untaught:P4'` |
| CCNA3.hardening.5 IP source guard | 20 | S15 | `'lab'`, `ccna3-dhcp-snooping-dai` | `'untaught:P4'` |
| CCNA3.hardening.6 storm control | 20 | S16 | `'lab'`, `ccna3-dhcp-snooping-dai` | `'untaught:P4'` |
| CCNA3.wan.1 compare WAN kinds | 21 | S22 | `'theory'` (with `concept:wan`) | `'theory'` |
| CCNA3.management.4 SNMPv2c | 30 | S33 | `'lab'`, `ccna3-watch-the-network` | `'untaught:P4'` |
| CCNA3.management.5 SNMPv3 | 30 | C23 | `'lab'`, `ccna3-watch-the-network` | `'untaught:P4'` |
| CCNA3.management.7 SPAN | 30 | S34 | `'lab'`, `ccna3-watch-the-network` | `'untaught:P4'` |
| CCNA3.management.9 files, backup, image | 31 | S29, S30 | `'lab'`, `ccna3-backup-and-upgrade` | `'untaught:P4'` |
| CCNA3.management.10 password recovery | 31 | S31 | `'lab'`, `ccna3-backup-and-upgrade` | `'untaught:P4'` |
| CCNA3.automation.4 browse a YANG model | 38 | S28 | `'theory'` (with `concept:yang`) | `'theory'` |
| CCNA3.automation.5 NETCONF | 38 | C21 (deferred) | `'theory'` | — |
| CCNA3.automation.6 run a playbook | 39 | C22 | `'lab'`, `ccna3-playbook-vlans` | `'untaught:P5'` |
| CCNA3.automation.8 controller-based, SDN, intent | 36 | C26 | `'theory'` (with `concept:sdn`) | `'theory'` |

Recommended plan: 14 `'lab'`, 4 `'theory'`, none `'later:P3c'`. P3a's §11.4 table is not edited (it is P3a's record);
`curriculum.ccna3.test.ts` and `objectives.ts` carry the new values, and W7 removes `'later:P3c'` from the union.

---

## 12. Deferred items and risks

### 12.1 Deferred (with the stage that should take them)

| Stage | Items |
|---|---|
| P4 (security track) | C15 PPPoE; C24 FTP; S17b fragmentation and reassembly (fragment-based evasion belongs with the security track); IPv6 over the IPsec VTI; plus P3a's P4 list (crypto maps, IKEv1, remote-access VPN, NetFlow/IPFIX, RSPAN, server AAA, 802.1X, time-based ACLs C10, C11, C12) |
| P5 (CCNP) | C14 PPP multilink; C21 NETCONF and XML for RESTCONF; C29 `usbflash0:`; C8 OSPF scale (only if its gate fails earlier); OSPF virtual links, `area range` (C5), stub/NSSA (C4), SHA key chains; OSPFv3 authentication and address families; the LSDB browser for v3; plus P3a's P5 list |
| never | C20 (invisible fair-queue default), C30 (clock drift) |
| P3b | unchanged (the platform; C31 deep links) |

**Deviations P3c adds** (each a row of the `docs/CATALOG.md` fidelity table when its wave reports it, and a lesson
sentence where a learner could notice): [S5] none (real keyed MD5 replaces a planned deviation); [S6] one OSPFv3 process,
no v3 authentication or address families; [S16] fixed 1 s windows evaluated on arrival; [S17a] an oversize datagram
with DF clear is dropped, not fragmented; [S29] TFTP octet mode only, the image is virtual; [S30] image versions behave
identically; [S31] routers only, break only in the boot window; [S33] v2c and v3 only, a MIB-II subset, no informs;
[S34] at most two local sessions, no RSPAN, a source VLAN copies rx only (Catalyst VSPAN accepts `both`); [S33] `ifType` 53 for every virtual interface (IANA: 131 tunnel, 135 l2vlan); [C7] a GRE tunnel's DBD advertises its port MTU 1500, not its IP MTU 1476; [S35] the phone speaks discovery only after hearing it (real phones send at
link-up); [S36b] the IPsec VTI carries IPv4 only; [C16] carrier loss is not propagated across a CSU relay (LCP echoes
find it); [C17] keepalives on GRE mode only. Removed: P2 deviation 7 (the hand-set phone VLAN) [S35], "GRE carries IPv4
only" [S36b], "PPP on direct cables only" [C16], "no GRE keepalives" [C17].

**P3a known items closed by P3c:** R63 (d) in P3 worlds; audit gap 8 for P3c daemons (D6; P3a's derivations stay as
recorded); the web chunk warning (H5; it may remain for pixi); the loop-storm runtime (H3, H4); S41.

### 12.2 Risks and mitigations

| Risk | Where it bites in P3c | Mitigation |
|---|---|---|
| **Scope (R1)** | 59.7 ew recommended (66.2 with contingency), uncalibrated; S6 alone is 5.8; process overhead is unpriced in the items | Each item is its own wave items; the contingency (which covers process overhead) is spent before any cut; S6 has a keep-or-cut checkpoint at the end of W2a; the cut order of §8.4 is complete; rule 27 records actuals |
| **The OSPF refactor and IPv6 plumbing** [S6] | A zero-diff refactor of a 1988-line closure; `ipv6.ts` changes in a daemon every P1/P2 IPv6 world uses | ⚑: the refactor runs alone in its owner's run with every OSPF acceptance test, the P3 lab shards, determinism and replay-exact; the l3 item runs every digest shard; absent requests leave every `ipv6.ts` path unchanged |
| **The hot path** [S40] | Optimisations on the dispatch path of every world; summary caching can leak mutated state across hops | ⚑, alone in W0h; byte-neutral by construction; caching keyed on the PDU mutation version; the storm-window digest, every digest shard and both lab-status goldens run by the item |
| **The built bundle** (H5) | Module evaluation order changes; P1's broken deploy was a circular import visible only in the bundle | W0h, before content; gate G plus a smoke of every lazy entry; the import lint; rule 12 |
| **The new P3 golden** (H1) | A new harness over CCNA 3 worlds (OSPF, CDP, NTP, syslog) costs slow-suite time and could be flaky if any world is load-dependent | Recorded from cad4ac9 unchanged and run 3× before commit; five shards; the `gate` tier keeps the per-wave slow run short; §9.5 lists every allowed change, entry by entry |
| **Lost designs** (D13) | §3.1, §3.3–§3.6 and the §10.1 rows are rewritten, not recovered; an implementer could find a gap | The adversarial review of this brief targets §3 first (§13); rule 7: an implementer who needs something not in §2/§3 stops and reports |
| **Help goldens** | `cli-help.p05` is generated on the real catalog, where P3 models already run `acl`, so P3c words land in it at W3a2 and at the W4b flip | `cli-help.p1` never moves; p05 regenerated with insertions only at exactly two sanctioned steps, diffed against §9.4's list and checked by the superset guard (D12, A-13) |
| **Storm control on the loop storm** [S16] | A per-frame check in eth-switch on the slowest test | One Map lookup when unconfigured; the storm-window digest; measured in the wave report |
| **Lab timing** [S4] [S6] | IA routes at link-up + 25 s; learners may Check too early | The lab text's timing warning; `settleMs` guidance (60 s covers it); the convergence panel [S8] |
| **Run length** (rule 22) | A builder item of 1–3 ew in one ≈ 90-minute run (P3a's fixer was killed at about 80 minutes) | The [S6] refactor and [S33] are split into two items; W3a and W5 are split; an item may continue across checkpointed runs |
| **Golden moves** (rule 9) | A ⚑ item moves a P3 golden entry and nobody owns the re-record | §9.5 names every allowed move with its wave; the re-record protocol of rule 9 (the builder reports, the reviewer checks, the architect re-records in the fix run) |
| **Process** | P3a's workflows were stopped six times by session ends | Rules 22 (≤ 6 builders, separate ≈ 90 min runs), 23 (a checkpoint after every run), 24 (AC preflight), 16 and 21 (no agent git; `master` stays at cad4ac9) |
| **Legal (R4)** | The MIB text, the OID arc, the playbook dialect, `show` layouts | IETF OIDs only and the RFC 5612 documentation arc; original wording; a legal review before W1b (M-22) |
| **Determinism (R5)** | New sequence numbers and ports | No new rng stream (§4.1); `accept.p3c.determinism` over every new and edited lab |

---

## 13. Review changes

Two adversarial reviews read the first draft against cad4ac9 on 2026-10-14: a **plan review** (wave coherence,
estimates, objective coverage, §9 completeness, the decision record, process and deploy discipline; 4 high, 12 medium,
8 low; ids P1–P24 below) and a **technical review** (code claims, contracts, RFC correctness, byte neutrality; 4 high, 9
medium, 14 low; ids T1–T27). Every finding was applied; where the architect's binding calls chose among the reviewer's
options, the row says which. Claims that depended on code were re-checked at cad4ac9 by the editor; where the check
disagreed with a review, the row says so.

### 13.1 Plan review

| Id | Sev. | Finding | What changed |
|---|---|---|---|
| P1 | high | The help-golden premise was false: `cli-help.p05` moves broadly, `cli-help.p1` must never move | D12 and §9.4 rewritten: p1 is a frozen floor and never moves; p05 is regenerated with additions only at exactly two sanctioned steps (W3a2 integrate, inside the W4b flip), checked by the superset guard; the additions listed per model family and wave; `P3C_APPROVED_MODES` for the four modes; D8's "keeps the help goldens" corrected; rule 14 runs `cli.grammar.help-goldens` and `cli.help-superset`; A-13 and M-21 are architect rulings |
| P2 | high | `accept.p3c.coverage` could not be green from W0; no machine-readable approved list; P3a's regex cannot read `S17a` | Architect call 2: coverage arrives in W0 with an **Arrives** column in §10.1 and `P3C_CURRENT_WAVE`; a pending row asserts only "absent, or present and passing and named"; W7 requires every approved row; §10.1 gains the coverage file's own row; §8.5c holds the Approved ids as a bold array read with `\b(?:[SC]\d+[ab]?\|R63d)\b` (rule 28, W0) |
| P3 | high | Four W3a cli builders shared files (`ip mtu`, host-shell grammar, `modes.ts`, the registries) | Architect call 3: W3a split into W3a1 (ospf, cli-routing, cli-acl, svc) and W3a2 (cli-management, cli-runtime) with a file-by-file ownership table; `ip mtu` owned by cli-routing, both ping forms and the host-shell grammar by cli-management; `cli/modes.ts` and the grammar, handler, show and debug registries are the architect's, stubbed in W0 with the four modes and one empty fragment per area (rule-18 table, §7 W0) |
| P4 | high | Course and lab pins missing from §9; `lessons.ts` had no owner | §9.2 W5b and W6 gain: `curriculum.ccna3.videos` (lesson 39's lab and sentence, lesson 38's sentence, minutes), `labs.ccna3.automation` (three automation labs, adjacency), `learn.landing` (26 labs, the new minutes), `accept.p3.lab-document` (15 + 20 + 26), `labs.ccna3.course` (thirteen files), `lessons.ts` `lab:` fields (course owner, W5b), README counts via `docs.w8-scope`; lab 39 lives in `automation.ts` (X-18) |
| P5 | medium | Same-run dependencies in W3b (web-desktop on http + auto) and W5 (course on the lab builders) | Web-desktop's [S27] and [C22] parts moved to W3c; W5 split into W5a (one lab file per builder) and W5b (course plumbing, `lab-versions`, the three W5 acceptance files) |
| P6 | medium | Ownership mismatches and missing rule-18 rows; three lessons without a builder; the W0 demux deletion broke capwap-wtp | §6 gives `src/netscope/*` to web-inspector; the rule-18 table names every edit by others (io's `schemaIdFor`, ospf's `ipv4.ts`, device's and svc's and http's `sim/simulation.ts`, svc's `vty.ts` (now svc-owned), svc's `grade.ts`, io's `lab-schema.ts`, media's eth-switch line); svc facts live in the new `sim/lab-checks/mgmt.ts`; lessons 16 and 23 assigned to theory-b and theory-c, CCNA 2 lesson 08 to the course docs builder; C32 (a) is one W0h change (contract and `capwap-wtp.ts:896`), W0 keeps the member |
| P7 | medium | §9.5 waves wrong ([S30] moves at W4b, [S35] TLV 9 at W1b, no phone in any golden world); P3-moving items not ⚑; no re-record protocol | Architect call 4: §9.5 is a table with the true wave per move (guard world 1 at W1b, S41 and S35-TLV 9 at W1b, the phone "none expected", S4 at W2b, R63 (d) at W3a2, S30 at W4b, labs at W5b); every item that moves P3 bytes is ⚑ (pdu run b, disc, acl [S11], ospf [S4], cli-management, cli-runtime, the flip); rule 9 gains the report → review → architect re-record protocol |
| P8 | medium | Positional shards and "appended" labs contradicted lesson order | Shards are keyed by lab id, the 21 names frozen in the golden per shard (D3, §10.1 rows); D5 and §11.2 say "inserted in lesson order", with the order pins listed in §9.2 W5b |
| P9 | medium | D1's stated reason for the `'P3c'` stage was inaccurate | Architect call 8: D1, §1.1 and X-15 now say the stage is needed only for the phone's reused `cdp`/`lldp` rows and stage-gated constants (new names are normalised away by the recorded vocabulary); the stage is kept |
| P10 | medium | The AC preflight accepted only BatteryStatus 2 and refused battery-less machines | Architect call 7: rule 24 accepts 2, 3, 6, 7, 8 or 9 on every battery, or no battery |
| P11 | medium | 90-minute runs against 1–3 ew items; process overhead unpriced | Rule 22: an item may continue across checkpointed runs; the [S6] refactor split into W1a and W1c parts, [S33] into agent (W2b) and manager (W3a1) items, W5's two svc labs split (lab 31 to device); process overhead covered by the review contingency (§8.4) and recorded by rule 27 |
| P12 | medium | MUST class did not match its definition; the cut order was incomplete | Architect call 11: three MUST kinds; the nine MUST-by-value items marked † with their value stated (9.6 ew); a complete six-step cut order naming every MUST item, with S6's checkpoint at step 3 |
| P13 | medium | Rule 14's flip list was incomplete | Rule 14 adds the help goldens, `accept.p3.determinism`, `accept.p3.replay-exact-ccna3`, `staged.world.p3c-parity`, `protocols.registry`, `device.catalog.p3`, `accept.p3.labs` with `lab-versions`, `accept.p3c.hot-path` |
| P14 | medium | `sendBreak` required in a types-only W0; no writer named; `FACT_AREAS`/`NEIGHBOR_AREAS` stubs missing | §2.9, §2.13: W0 adds both with a transition `?`; W3a2 cli-runtime writes `CliRuntime.sendBreak`; W3b web-shell removes the `?` and updates the fakes (§9.2 item 22); `FACT_AREAS` and `NEIGHBOR_AREAS` added to the W0 stub list (§2, §9.2 item 1) |
| P15 | medium | 85 rows all blocking W0, most of them technical | Architect call 9: §8.5a holds exactly the review's 12 product-owner questions, in plain words with a recommendation each and an empty Recorded column; every other row is an architect ruling in §8.5b with its decided value, Recorded "architect"; §8.5c holds the Approved ids |
| P16 | medium | Rule 21 against the live git configuration | Rule 21: the lead checks the tracking set-up before W0 and corrects `master`'s upstream if ever needed (at 2026-10-14 `git branch -vv` shows `master` already tracking `origin/master`, so the review's `refs/heads/p2` observation no longer holds); first push `git push -u origin p3c`; after each run `git ls-remote origin refs/heads/master refs/heads/p3` must equal cad4ac9; a pre-push hook only with the product owner's approval |
| P17 | low | A golden cannot hold the hash of its own commit | D3 and W0: headers name the source commit cad4ac9; the W0 wave report names the recording commit |
| P18 | low | Rule 16 relaxed silently | Rule 16 states the change from P3a (read-only git allowed) with its reason, and lists `fetch` and `config` among forbidden commands |
| P19 | low | The `gate` project's membership depended on wall time | Rule 25: `GATE_TESTS` is an explicit list; 60 s is only a review trigger |
| P20 | low | Estimates included work already done; course work thinly priced | S4 −0.2, R-sh −0.1, M-sh −0.2 moved into the contingency lines (MUST 42.5, recommended 59.7, every total with contingency unchanged: 47.3, 66.2, 82.9); §8 "Course work" states where each lesson rewrite is priced |
| P21 | low | "A model with a CLI shell" undefined | D6, §2.1, W4b: `model.cli.shell !== 'none'` (verified in `deriveCliSpec`, `define.ts:438-446`) |
| P22 | low | No point at which S6 should be cut | Architect call 11: a keep-or-cut checkpoint at the end of W2a (§7 W2a, §8.4 step 3, X-20) |
| P23 | low | §11.3 fallbacks broke X-4 for configure-level objectives | management.4, .9, .10 → `'untaught:P4'`; automation.6 → `'untaught:P5'` (X-19) |
| P24 | low | "Their three entries" ambiguous | §9.5 names `p3-profile-digests`, `lab-status.p3` and `p3-lab-exports` per lab |

### 13.2 Technical review

| Id | Sev. | Finding | What changed |
|---|---|---|---|
| T1 | high | Lab 20's storm-control task could not pass with no traffic | Architect call 6: the row is written once when the line is stored or the port comes up (D8, §2.6, §3.7, A-16); lab 20 grades the configuration plus that row; the stale-window caveat stated; the acceptance row checks it |
| T2 | high | Guard world 1 moves at W1b, which §9.5 forbade | Option (a): guard world 1's entries re-recorded by the architect in the W1b fix run (decode-only); its pass condition asserted separately and never re-recorded (D3, §9.2 item 14, §9.5, §10.1 row) |
| T3 | high | Help-golden migration wrong in both directions | As P1; the `ping`/`errdisable` sub-word lines dropped from §9.4 as not captured; D8's rationale corrected |
| T4 | high | §3.1 step 9 contradicted RFC 2328 §16.1–16.2; the B-flag rule change was unstated | Architect call 5: routes go at T2 + 5 s (step 9, §10.1 row, R-1); D7 states the B-flag change from `ospf.ts:1250`; W2b [S4] owns it in `desiredSelf` and scans the P3 golden worlds |
| T5 | medium | 40 960 bytes need 81 DATA blocks | §3.4 step 7 and `accept.p3c.image`: 81 blocks (80 full and an empty one), computed from the constants |
| T6 | medium | The MTU-mismatch outcome depends on router ids | Architect call 5: §3.2 states both outcomes; lab 07 gives the lower-MTU side the higher id; the acceptance row pins both orderings (R-16) |
| T7 | medium | The DBD MTU check changes saved P3 worlds (jumbo peers) | Architect call 5: real IOS behaviour, listed as a P3 behaviour change in D7, §4.3, §4.4 and product-owner question 4; tunnels keep advertising the port MTU (a listed fidelity gap, R-17, §12.1) |
| T8 | medium | `OspfStateView.borderRouters` would move single-area P3 goldens | The member is dropped; `show ip ospf border-routers` is computed in the CLI from the LSDB through the pure SPF (§2.6, §3.1 step 7, R-19); lab 06's digest entry guards the S4 item |
| T9 | medium | No mechanism for the flash-full pre-check or for `nominalBytes` | Architect call 6: the RFC 2349 `tsize` option with OACK and ERROR 3/8 in the `tftp` table; the 16-byte image header; `StoredFileMeta`/`StoredFileInput.nominalBytes` (OBM) as the runtime slot; `tftp.transfer.image` becomes a flag (§2.4, §2.9, §3.4, D10, M-23) |
| T10 | medium | SNMP contracts could not express RFC 3416 exceptions, `nonRepeaters` or the version | Architect call 6: `SnmpValue` gains the three exceptions; `snmp.op.nonRepeaters` (OBM); `HostAppRequest 'snmp'` carries `version` (and `maxRepetitions`, `nonRepeaters`) (§2.4, §2.8, M-26) |
| T11 | medium | Lab 30's clear-text community task used a window with no SNMP | Architect call 6: `packetSeen.drive` gains an `snmp` GET window; lab 30 asserts `snmp.community == "NMS-RO"` and its text names the community (§2.10, §11.2, M-25, `accept.p3c.packet-seen`) |
| T12 | medium | `cryptoSeq` restarting at 0 blocked re-adjacency | Architect call 5: `cryptoSeq = ⌊sim now / 1 s⌋` (§3.2 step 1, R-4) |
| T13 | medium | `tftp`/`snmp` are not new protocol names; the web reserved vocabulary must move; field tables need a stage | §2.3: only `ospf6` is a new `ProtoName`; §9.2 item 1: `RESERVED_PROTOCOL_VOCAB` loses tftp and snmp, its pin is ftp, smtp, pop3, imap; the four new field tables at `since: 'P3c'`; the dispatch rows keep `'P1'` |
| T14 | low | `STAGED_PROCESS_TABLES` cannot gain a row member with its own `since` | §2.1: a second row `{process: 'eth-switch', tables: ['storm-control'], since: 'P3c', requires: 'managed-switch'}`; `PROCESS_TABLES` unaffected |
| T15 | low | Missed or misnumbered pins | §9.2: `protocols.registry:161-163` both probes; `device.catalog.p3:136`; `staged.world.p3-parity:81`; `curriculum.ccna3.test:453` counts; the `'later:P3c'` rows run to line 242 (verified; the review's 231 and the draft's 229 were both short) |
| T16 | low | Lane rationale wrong; `TABLE_LANES` not forced; `MODE_PROMPTS` forced | Lane rationale corrected (`port-security`/`arp-inspection`); `TABLE_LANES` dropped from the forced list. Verified at cad4ac9: the record is `MODE_PROMPT: Readonly<Record<string, string>>` (`contracts/cli.ts:554`), so it is **not** forced either; W0 adds the four prompts as data (§2, §9.2 item 1) |
| T17 | low | `RunToIdleOptions` does not exist | §2.8 declares it as new with the additive `runToIdle(maxEvents?, opts?)`; `HOST_APP_PROCESS` moved to the sim-file items |
| T18 | low | Web type locations | §2.12: `OverlayId`/`RoutingOverlayToggle` in `canvas/overlays/registry.ts`; §6 marks the two loaders new |
| T19 | low | The S17a check should skip tunnel ports | §3.8 step 2: non-tunnel ports only (gre keeps D15); serial and PPP use the port MTU |
| T20 | low | The IPv6 route legend is a constant | §3.3 step 6: `O`/`OI`/`OE2` only with an `ipv6 router ospf` section |
| T21 | low | `show errdisable recovery` changes on P1/P2 | §4.4 lists it as a visible P1/P2 change with no golden move; §9.1 and §9.2 item 16 follow |
| T22 | low | No field for the LLDP-MED Capabilities TLV | `lldp.medCapabilities?` (subtype 1) in the field table and `LldpNeighbourRow` (OBM) |
| T23 | low | OSPFv3's interface id depended on S33's ifIndex | A shared pure `ifIndexOf` in `device/if-index.ts`, owned by W1a device, used by S6 and S33 |
| T24 | low | `DORMANT_TRANSPORT_OWNERS` wording | §4.3: the two `{service, lines}` matchers; `snmp-server host` alone does not wake; `SANCTIONED_EXT_REQUESTS`' comment gains tftp |
| T25 | low | Lab 17's IPv6 grading needs more than `family?` | §2.10: `acl.type` gains `'ipv6'`, `acl.entry` gains `'nd-na'` and `'nd-ns'`; the W3c adapter fills them |
| T26 | low | SPAN VLAN sources and `ifType` | Both listed: a CATALOG deviation row for rx-only VLAN sources (§3.5, §12.1) and the `ifType` 53 simplification |
| T27 | low | `config-register` as a stored line gave two sources | An immediate command writing the persistent register, never a `ConfigAst` line (D10, §3.4 step 8, §5, M-24) |

### 13.3 Editor's notes

- While splitting W3a, the editor found no CLI owner for [C17]'s `keepalive` and `tunnel key` and [S36b]'s tunnel
  `ipv6` lines; they are assigned to cli-routing in W3a1 with `cli/grammar/wan.ts`.
- Totals after review: MUST 42.5 ew (47.3 with contingency), recommended plan 59.7 (66.2), every candidate 74.9 (82.9);
  the totals with contingency are unchanged because the 0.5 ew of work already done moved into the contingency lines.

---

## 14. P3c exit gate record (written at W7)

---

## Appendix A. Designs of the items outside the recommended plan

Each block is added by exactly one named wave item **only if** the product owner approves it (rule 3); otherwise it is
never added, and its §10.1 row (listed here, never required in P3c) must not exist as a file.

**[S17b] Fragmentation and reassembly** (3.1 ew, +0.4 NAT virtual reassembly). Contracts: `MutationReason +=
'FragmentReassemble'`; `Pdu.fragmentAt(ctx, ipIndex, offset, length, more, cause)` (rewrites this PDU into its first
fragment, records `FragmentSplit`); `PduFactory.fragment(pdu, at, offset, length, more): Pdu` (a new PDU with
`meta.parent`); `ProcessCtx.fragment?` (OBM); `DropReason += 'reassembly-timeout'`; `LabPacketProbe.fragment?`;
`ICMP_TIME_EXCEEDED_REASSEMBLY`. Behaviour: the ipv4 codec gives `fragOffset > 0` a `payload` next layer and a first
fragment's transport checksum is "unknown"; `arp.sendVia` splits DF-clear oversize datagrams into 8-byte-aligned
fragments sharing one ARP resolution; for-me fragments reassemble in buffers keyed `src|dst|proto|id` (holes,
first-wins overlap, 15 s `ipv4-reasm:<key>` armed only while buffers exist, ICMP 11/1 when fragment 0 arrived, ≤ 64
buffers per device); transit routers never reassemble; NAT drops fragments it cannot translate (a deviation) unless
virtual reassembly is approved; tunnels keep D15's drop (A-12). Wave: one isolated l3 + pdu run after W3c, with the
full byte-guard set before and after. Row: `accept.p3c.fragmentation.test.ts` [S17b].

**[C8] OSPF scale proper** (1.5 ew, only if `accept.p3c.ospf-scale-multiarea` fails a bound): LSA body interning in
`protocols/ospf/lsdb.ts` (frozen bodies keyed by checksum and length), lazy `ospf-lsdb` rows, incremental inter-area
recomputation (RFC §16.5) with engine/pure parity. Lazy rows move P3 tableWrite counts and need their own §9.5 entries.

**[C14] PPP multilink** (2.0 ew, P5). LCP options MRRU (17) and endpoint discriminator (19); the `mp` layer (B/E bits,
24-bit sequence) under PPP protocol 0x003d; a virtual family `Multilink<n>` (encap `ppp`); `PppRow.bundle?`; IPCP on
the bundle; round-robin whole packets with MP sequence numbers (no fragmentation); the tail reorders and drops
`ppp-mp-lost` after a gap timer; queueing policies refused on `Multilink`. Row `accept.p3c.ppp-multilink.test.ts` [C14].

**[C15] PPPoE** (3.8 ew, P4). Codecs `pppoe-discovery` (0x8863: PADI, PADO, PADR, PADS, PADT with tags) and
`pppoe-session` (0x8864); `PppoeSessionRow {iface, sessionId, peerMac, state, acName}`; families `Dialer<n>` and
`Virtual-Access<n>`; a "ppp carrier" seam generalising `ppp.ts` from the serial line (≈ 0.8 ew, behaviour-neutral,
proved by `accept.p3.ppp-*`); IPCP address negotiation (`ip address negotiated`, `peer default ip address pool`, `ip
local pool`); MTU 1492. Row `accept.p3c.pppoe.test.ts` [C15].

**[C21] NETCONF and XML for RESTCONF** (2.3 ew, P5). `ConfigOrigin.via += 'netconf'`; `TCP_PORT_NETCONF = 830`; dispatch
`tcp.port 830 → netconf` under the SSH protection path (`ext.tcp.protect`, a new sanctioned user); a `netconf-log`
table; `protocols/netconf.ts` (`netconf-yang`, hello and capabilities, `]]>]]>` and chunked framing, `<get>`,
`<get-config>`, `<edit-config>` through `planYangWrite` and the configure seam, running datastore only); RESTCONF
`application/yang-data+xml`; a host-shell `netconf <host> <rpc-file>` client on NF-DEVHOST. Row
`accept.p3c.netconf.test.ts` [C21].

**[C24] FTP** (1.5 ew, P4). An `ftp` codec (command and reply lines), `protocols/ftp.ts` (server on NF-SERVER with
users, passive mode only, client on routers), `ip ftp username|password`, `copy … ftp://user:pass@host/file`, TCP 21
un-reserved. Row `accept.p3c.ftp.test.ts` [C24].

**[C29] `usbflash0:`** (0.5 ew, P5). `FileSystemId += 'usbflash0'` on models with a USB port, `TopologyFile.fs +=
'usbflash0'` (1.4), `copy running-config usbflash0:<f>`, `dir usbflash0:`; an always-inserted stick. Row inside
`accept.p3c.tftp.test.ts`.

**[C20]** is not designed further (never, W-9).
