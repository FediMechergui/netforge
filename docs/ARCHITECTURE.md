# NetForge — P0 architecture and build rules

> **Next builds (P0.5 catalog/media/wireless and P1 CCNA 1):** the binding brief is
> [`docs/ARCHITECTURE-P1.md`](ARCHITECTURE-P1.md). Its decisions, protocols, module map and
> migration list extend this document and win wherever the two differ; the engine rules below
> stay in force.

Source spec: `docs/netforge-spec.md` (copied from the original brief). This document is the
**binding brief for P0 (Foundation)**. Read the contract files it points to before writing code —
they are the interfaces every module compiles against.

**P0 exit criterion (spec §19):** *two PCs and a switch; ping works; you can watch the ARP.* We
also ship a router so IPv4 forwarding, TTL decrement and static routes are real from day one.

## Decisions that differ from the spec (deliberate)

| Spec | P0 reality | Why |
|---|---|---|
| Rust→WASM core (§3.2) | Pure TypeScript package `packages/engine`, zero DOM deps | Rust toolchain not available; engine stays portable/headless so it can be ported later |
| SharedArrayBuffer ring (§3.3) | Comlink RPC + batched structured-clone messages | No COOP/COEP headers needed; revisit at 10k in-flight packets |
| Timing wheel + heap (§4.1) | Binary heap keyed `(at, seq)` | Sufficient for P0; interface allows swapping |
| Fixed-point metrics (R5) | Integer ns time; `number` used for everything else | JS doubles are deterministic across engines for integer arithmetic |

## Non-negotiable engine rules

1. **Determinism (G4).** Inside `packages/engine`: no `Math.random`, no `Date.now`, no
   `performance.now`, no `new Date()`, no `setTimeout`. All randomness via `Rng` sub-streams
   split by stable labels. All ordering via `(at, seq)`; never depend on object identity or
   `Set` semantics for ordering (Map insertion order is fine — it is deterministic).
2. **SimTime is an integer.** Round after any division. `assertSimTime` in debug paths.
3. **Provenance invariant (§4.5).** `Pdu` bytes/layers are private; `mutate()`/`corrupt()` are the
   only write paths and they append a `Mutation`. No module may construct a `Pdu` except via
   `PduFactory`.
4. **`stateSnapshot()` is the only UI truth (§4.8).** No parallel display model anywhere.
5. **Every state-machine transition emits a `DebugEvent`** via `ctx.debug(category, …)`.
6. **Counters are real.** `show interfaces` reads `PortCounters`; nothing is faked.
7. **Legal (§1.6).** Command *syntax* may mirror IOS. All help strings, error messages, banner
   text, `show` output wording, device names and icons are ORIGINAL. Device models are
   `NF-PC`, `NF-C2960`, `NF-2911`. OS family string is `"nfos"`. Never write "Cisco" or "IOS"
   in user-facing strings.
8. **Tests are part of the deliverable.** Every engine module ships vitest tests next to it or in
   `packages/engine/test/`. Determinism test: run a scenario 3× with the same seed and compare
   the full trace JSON byte-for-byte.
9. **Contracts are frozen for implementers.** If a contract in `src/contracts/` is wrong, an agent
   may make the *minimal* additive fix (add an optional field, add a union member) and MUST list
   it in its report. Never remove or rename contract members.

## Module map and ownership (P0)

Each module has ONE owner during the parallel build. Owners create only files under their paths
(plus tests). Cross-module needs are met through the contracts.

### `packages/engine/src/`

| Path | Owner | Delivers |
|---|---|---|
| `contracts/*` | architect (done) | All interfaces. `addr.ts`, `time.ts` carry small pure helpers. |
| `core/prng.ts` | core | `Rng` impl (xoshiro128** or similar, u32 state, FNV-1a label hashing), `createRng(seed)`, `rngFactory`. |
| `core/scheduler.ts` | core | `Scheduler` impl: binary heap on `(at, seq)`, `cancel` via tombstone set, `advanceTo`. |
| `core/table.ts` | core | Generic `Table<R>` impl backed by `Map`, emitting `tableWrite`/`tableExpire` to the `TraceSink` given via `TableOptions` (exports `createTable: TableFactory`), plus `lpm(rib, dst)`. |
| `pdu/pdu.ts` | pdu | `PduImpl` class implementing `Pdu` (private bytes/layers; `mutate` re-encodes per the contract's re-encode rule; `encapsulate` pushes an outer layer and re-decodes; `clone`; `corrupt`; `summary`; `toJSON`). |
| `pdu/codecs/{ethernet,arp,ipv4,icmpv4,payload}.ts`, `pdu/codecs/registry.ts` | pdu | `Codec`s: Ethernet II (+FCS CRC-32, padding to 64), ARP, IPv4 (options ignored but length-correct, header checksum), ICMPv4 echo/reply/dest-unreachable/time-exceeded (quoting original), raw payload. `decode` chains by ethertype/protocol. |
| `pdu/factory.ts` | pdu | `PduFactory` impl with monotonic ids supplied by the simulation. |
| `pdu/checksum.ts` | pdu | Internet checksum (RFC 1071), CRC-32 (IEEE 802.3, table-driven). |
| `device/catalog.ts` | device | `DeviceCatalog` with the three P0 models + port specs + short-name expansion (`Gi0/0`, `g0/0`, `fa0/1`, `Fa 0/1`, `GigabitEthernet 0/0`). |
| `device/device.ts` | device | `DeviceRuntime` impl: boot, ports, tables, process instantiation + demux, action application (send → link model, deliver, request, drop, timer, cliOutput, setPortL3, log), config application (delta → `onConfig`), startup/running config, reload, power. |
| `link/link.ts` | link | `LinkModel`: cable validation with explanations (media vs port kinds, straight vs crossover with auto-MDIX, length), link up/down derivation, `transmit(from, pdu, at)` scheduling `txComplete`/`frameArrival` with serialization/propagation/impairments, `frameTx` trace, in-flight tracking for snapshots. |
| `protocols/eth-switch.ts` | protocols-l2 | Transparent bridging: learn (CAM, ageing 300 s via a sweep timer), forward/filter/flood, broadcast/multicast handling, VLAN 1 only. Debug category `ethernet switching`. |
| `protocols/arp.ts` | protocols-l3 | ARP daemon: cache with timeouts, request/reply, gratuitous ARP on address config, pending queue with retries (3 × 1 s) then `arp-unresolved` drop, `arp.sendVia` request handling (encapsulates IPv4 in Ethernet and sends). Debug category `arp`. |
| `protocols/ipv4.ts` | protocols-l3 | IPv4 daemon: address config → `setPortL3` + connected/local routes in RIB, static routes (`ip route`), receive (checksum, for-me → deliver `icmpv4`; else forward if `ipForwarding`), forwarding (LPM, TTL decrement via `ctx.mutate` with cause = matched route, `ttl-expired` → `icmp.error`, `no-route` → `icmp.error` unreachable), `ipv4.send` request (route + `arp.sendVia`). Debug categories `ip packet`, `ip routing`. |
| `protocols/icmpv4.ts` | protocols-l3 | ICMP daemon: echo reply, error generation (quoting original), and the **ping job** (per-session state machine: send N requests spaced 1 s or on reply, 2 s timeout, prints `!`/`.`/`U` style progress with original wording, final stats line, `cliDone`). Debug category `ip icmp`. |
| `protocols/host.ts` | protocols-l3 | Host-side glue for PCs: consumes the GLOBAL `ip default-gateway <gw>` delta (context `[]`) → `rib.set({key:'0.0.0.0/0', network:'0.0.0.0', prefixLen:0, source:'S', nextHop:gw, ad:1, metric:0, isDefault:true, updatedAt: now})`; `no ip default-gateway` deletes it. Never emits `setPortL3`. (Small.) |
| `protocols/index.ts` | protocols-l3 | Registry: name → factory, used by the catalog. |
| `cli/config-ast.ts` | cli | `ConfigAst` impl (query, set/unset, render with canonical order/indent, filters, diff, clone, parse from text). |
| `cli/grammar.ts` | cli | The P0 command table (`CommandSpec[]`): see "P0 CLI surface" below. |
| `cli/parser.ts` | cli | Tokenizer, prefix matching with ambiguity detection, arg validation, `?` help and tab completion, error column. |
| `cli/runtime.ts` | cli | `CliRuntime` impl: sessions, modes, prompts, handler registry, `exec/complete/help/interrupt`, blocking on jobs, busy output routing. |
| `cli/handlers/*.ts` | cli | Handlers grouped: `exec.ts` (enable/disable/exit/end/configure/ping/show/copy/write/reload/clear), `config.ts` (hostname/interface/ip/no shutdown/ip route/banner/enable secret), `show.ts` (output templates). |
| `trace/ring.ts` | core | `TraceRing` impl. |
| `io/schema.ts` | io | zod schemas for `Topology`, `NetforgeManifest`; `parseTopology(json)` with readable errors. |
| `io/netforge-file.ts` | io | `.netforge` zip write/read with `fflate` (manifest.json, topology.json, configs/*.cfg, README.md) + plain JSON save/load. |
| `sim/simulation.ts` | sim | `Simulation` facade wiring everything: id generation (`d_xxxx`, `l_xxxx` from the rng), device/link lifecycle, run loop, snapshot assembly, PDU registry, fault injection (cable-cut, port-flap, power-loss, link-impairment). |
| `sim/scenarios.ts` | sim | Builders used by tests and the UI "New from template" menu: `twoPcsAndSwitch()`, `pcRouterPc()`, `threeRouters()` — each returns a `Topology` (with startup configs) — plus `SCENARIOS: {name,title,description,build}[]`. |

### `apps/web/src/`

| Path | Owner | Delivers |
|---|---|---|
| `bridge/protocol.ts` | architect (done) | `EngineApi`, `EngineBatch`. |
| `bridge/engine.worker.ts`, `bridge/client.ts` | web-shell | Worker hosting `Simulation`, clock loop (`setInterval` slices, rate × wall), batching; Comlink client singleton with typed helpers. |
| `store/types.ts` | architect (done) | Store shape. |
| `store/store.ts`, `store/selectors.ts` | web-shell | zustand store; selectors (`useDevice(id)`, `useSelectedDevice`, `useInflight`). |
| `app/*` | web-shell | `App.tsx`, layout (top bar, palette, canvas slot, inspector slot, bottom dock), playback controls (play/pause/step/rate), file menu (new/open/save `.netforge` via File System Access API or download), theme, keyboard shortcuts, toast. `main.tsx`, `styles.css`. |
| `canvas/*` | web-canvas | PixiJS v8 scene: devices (original vector icons drawn with Graphics), ports, cables (bezier, coloured by media, dashed when down), selection/hover, drag-move (→ `moveDevice`), cabling tool (click port → click port, validation feedback with reason text), packet capsules interpolated from `inflight` tuples, drop markers with reason tags, pan/zoom, LOD (hide port labels when zoomed out). |
| `terminal/*` | web-terminal | xterm.js panel with a proper line editor (history, ^A/^E/^W/^U/^C, `?` inline help, Tab completion, ^Shift+6 interrupt), prompt rendering, streaming output, tabs per session, "open console" from a device. |
| `inspector/*` | web-inspector | Right-hand inspector: Overview, Ports (table + live LEDs), Config (running-config text + diff vs startup), Tables (CAM/ARP/RIB with flash/fade + countdown), Processes (state views); Packet inspector (layer cards + hex view with field highlight); **Provenance timeline** (§9.3) for the selected PDU family (parent chain); Events/Packets dock tabs. |

## Cross-module protocols (how the pieces talk)

### Run loop (Simulation)
`step()` pops one `SimEvent` and dispatches by kind:
`frameArrival` → `linkModel.onFrameArrival(pdu.id, {device,port}, at)` then `device.onFrameArrival(port, pdu, corrupted, at)`;
`txComplete` → `linkModel.onTxComplete(ref, at)`; `timer` → `device.onTimer(process, key, at)`;
`boot` → `device.onBoot(at)`; `linkState` (faults) → `linkModel.recompute(link, at, reason)` then
`device.onPortOper(...)` for each returned port; `userCommand` → `cli.exec`; `fault` → fault handler.
Devices reach the link model only through `DeviceRuntimeDeps.transmit` and `DeviceRuntimeDeps.onPortAdmin`
(the sim implements the latter as `recompute` + fan-out of `onPortOper` to both ends).

### Frame arrival pipeline (device runtime)
1. `frameArrival` event → port counters (`inPackets`, `inBytes`, `lastInput`); if `!adminUp` → `inDrops`, drop `port-admin-down`; else if `!operUp` or not booted → `inDrops`, drop `link-down`.
2. If `corrupted` or FCS mismatch (`ethernet.fcsValid === false`) → `crcErrors`, `inErrors`, drop `fcs-error`. Runt/giant checks.
3. The frame arrives as a `Pdu` already decoded; the runtime does NOT re-decode.
3a. On hosts/routers (`model.kind !== 'switch' && model.kind !== 'hub'`): if `ethernet.dst` is neither the
   ingress port's MAC nor broadcast/multicast → `inDrops++`, drop `'not-for-me'`. Switches/hubs skip this.
4. Demux: choose the process whose `handles` matches (ethertype-specific beats generic).
   Switch: `eth-switch` handles `{layer:'ethernet'}`. Host/router: `arp` handles 0x0806, `ipv4` 0x0800; anything else → drop `unsupported-ethertype`.
5. Apply returned actions via `applyActions` — depth-first, in returned order (deliver/request may yield more actions); per-event budget of 1000 actions.

### Sending
`send` action → `LinkModel.transmit(portRef, pdu, now)`; on `ok:true` the runtime bumps
`outPackets/outBytes` and `lastOutput`, on `ok:false` it bumps `outDrops` (the link model already emitted
the `link-down` drop). `transmit` queues on the port (`tx.queue`), computes `txStart/txEnd/arrive`,
schedules `txComplete` at `txEnd` and `frameArrival` at `arrive` on the peer port, and emits `frameTx`.
Impairments are decided at `transmit` time using the link's rng sub-stream: five draws per frame, always
in the order loss → corrupt → jitter → corrupt-offset → corrupt-bit (every frame, whatever the settings
or outcome). When a cable goes down or is removed, frames still on it have their `frameArrival` cancelled
and get a `link-down` drop on the link. `bandwidthBps` caps the serialization rate.

### Config flow
CLI handler → `ctx.config(line, negate, context?)` → `DeviceRuntime.applyConfigLine` → `ConfigAst.set/unset`
→ `ConfigDelta` → every process's `onConfig` (in `model.processes` order) → actions applied after ALL
processes have seen the delta. Interface `shutdown`/`no shutdown` also goes through config; the runtime
updates `adminUp`, emits `portState` and a syslog `log` with original wording, then calls
`deps.onPortAdmin` → `LinkModel.recompute` → `onPortOper` on both ends → `Process.onLinkChange`.

Ownership of config lines (every model): `ipv4` handles context `[['interface',<port>]]` / line
`['ip','address',A,M]` → `setPortL3` + C/L routes (+ `arp.gratuitous` if the port is up); `host` handles
context `[]` / line `['ip','default-gateway',GW]` → static default route in the RIB. No process watches a
root-level `ip address`. The PC shell's `ip address A M [GW]` is a pure CLI-side expansion into those two
lines (see "P0 CLI surface"), so `show running-config` and `.netforge` round-trip with no PC-specific parsing.

### Ping flow (the P0 acceptance path)
`ping 10.0.0.2` → handler validates → `ctx.request('icmpv4', {kind:'icmp.ping', …})` → `ctx.block()`.
icmpv4 job: `ctx.sourceFor(target)` (no route → print an original "no route to host" line, `cliDone`);
build `[ipv4, icmpv4, payload]` with `ipv4.src/dst/protocol/ttl` set, `meta.flow`, `meta.tag = 'ping#n'`;
issue `request ipv4 {kind:'ipv4.send'}` → ipv4 routes: `lpm(dst)` → connected → next-hop = dst, else
next-hop = route.nextHop; `request arp {kind:'arp.sendVia', cause: <route line>}` → arp: cache hit →
`ctx.encapsulate(pdu, {proto:'ethernet', …})` + `send`; miss → queue the packet, `newPdu` ARP request
with `meta.triggeredBy = pdu.id`, broadcast it, retry 3 × 1 s, then drop queued packets `arp-unresolved`.
Replies flow back up: ethernet demux → ipv4 (`isLocalDestination`) → deliver icmpv4 → job matches id/seq →
`consume` + `cliOutput '!'`; timeout → `'.'`; ICMP unreachable → `'U'`. After N or abort → stats line →
`cliDone`. Output wording is original (not the vendor's "Success rate is …" — e.g.
`Sent 5, received 5, lost 0 (0% loss), round-trip min/avg/max = 1/1/2 ms`).
Forwarding at a router: ipv4 `ctx.mutate(pdu, 'ipv4.ttl', ttl-1, 'TtlDecrement', cause = matched route line)`,
then `arp.sendVia` rewrites `ethernet.src/dst` via `MacRewrite` mutations. The PduId never changes across
hops, so the §9.3 timeline shows `+ethernet` at the origin, `ipv4.ttl 128→127` / `ethernet.src|dst ✎` at
the router.

### Tables → UI
`Table.set/delete/expire` emit `tableWrite`/`tableExpire` trace events; the store turns them into
`TableFlash`es and the inspector flashes/fades rows. Rows with `expiresAt` show a countdown ring.

### Animation
UI keeps `inflight` from `frameTx` events (and the snapshot's `inflight` list on resync; identity is
`(pdu.id, link)`). Capsule position at `now` = `(now - txStart) / (arrive - txStart)` along the cable
from `from` to `to`; trail length ∝ `(txEnd - txStart)`. A `drop` event with `link` spawns a marker
mid-cable; with `device` spawns it at the device. Shape by `pdu.proto`: `arp` diamond, `icmpv4` rounded
capsule, other hexagon.

Visibility comes from the worker clock, not the canvas: real wire times are microseconds, so the worker
runs at `rate × wall` only while no frame is in flight; while any frame is on a cable it clamps sim
advance so each in-flight frame takes ≥ `ClockPolicy.minTransitWallMs` (default 400 ms) of wall time,
and sub-steps to `nextEventTime()` when idle so no `frameTx` is skipped inside a slice. Idle waits
(ping's 1 s spacing, ARP retries, CAM ageing) still run at `rate`. `EngineBatch.effectiveRate` reports
the actual mapping; the canvas extrapolates `now` between batches with it. See `bridge/protocol.ts`.

`topologyChanged` with `op:'move'` does NOT bump `topologyVersion` and needs no snapshot refetch (the
canvas already knows the position it dragged to); `add`/`remove` do.

## P0 CLI surface (grammar.ts must cover exactly this; more is fine if tested)

User EXEC: `enable`, `exit`/`logout`, `ping <ip>` (5 echoes, 2 s timeout, 100 B), `show …` subset
(`show ip interface brief`, `show interfaces [<if>]`, `show arp`, `show ip arp`, `show mac address-table`,
`show ip route`, `show version`, `show running-config`, `show startup-config`, `show history`), `traceroute` (P1 — reject with original "not available" message for now).
Priv EXEC: all above + `disable`, `configure terminal`, `copy running-config startup-config`,
`write [memory]`, `erase startup-config`, `reload`, `clear arp-cache`, `clear mac address-table dynamic`,
`debug arp|ip icmp|ip packet|ethernet switching`, `undebug all`, `no debug all`, `show running-config | section|include|exclude|begin <x>`.
Global config: `hostname <name>`, `interface <if>`, `ip route <net> <mask> <next-hop|if>`,
`no ip route …`, `banner motd <rest>`, `enable secret <word>`, `end`, `exit`, `do <exec command>`.
Interface config: `ip address <a> <mask>`, `no ip address`, `shutdown`, `no shutdown`,
`description <rest>`, `duplex auto|full|half`, `speed auto|10|100|1000`, `mac-address <mac>` (extension), `end`, `exit`.
PC (NF-PC) uses the same shell with a reduced grammar: `ip address <a> <mask> [<gateway>]`, `no ip address`,
`ipconfig`, `ping`, `arp -a`, `show …`. PCs boot straight into a single mode `user-exec` at privilege 15
with prompt `PC1>` (a simple "host shell"; no `enable`/`configure`). The PC `ip address A M [GW]` handler
MUST write, via `ctx.config(line, negate, context)`:
```
ctx.config(['ip','address',A,M], false, [['interface','GigabitEthernet0']])   // same shape as a router
ctx.config(['ip','default-gateway',GW], false, [])                             // only when GW given
```
`no ip address` unsets both. Canonical PC running-config therefore renders as
`interface GigabitEthernet0` / ` ip address A M` / `ip default-gateway GW`. `ipconfig` renders
`ports[].l3.ipv4` plus `config.get('ip.default-gateway')`.

Every `?` help string and every error/show wording must be original.

## Build & test commands

```
npm install                # once, root
npm run typecheck          # both packages
npm test                   # engine vitest
npm run dev                # web on http://localhost:5173
```

## Definition of done for P0

- `npm run typecheck` and `npm test` pass; ≥ 1 test per module; scenario test `twoPcsAndSwitch`:
  configure IPs via CLI, `ping` from PC1 to PC2 returns 5/5 with **exactly** this observable sequence
  in the trace: ARP request broadcast → switch floods → PC2 replies → switch learns both MACs →
  echo request/reply ×5 → CAM has 2 entries, ARP caches have 1 entry each.
- Scenario `pcRouterPc`: PC → router → PC ping succeeds; TTL decrements once (provenance shows
  `ipv4.ttl 128→127` with cause = matched route); router `show ip route` lists 2 C + 2 L routes.
- Determinism test passes (3 identical runs).
- Web: drop 2 PCs + 1 switch from the palette, cable them, open consoles, configure, ping; packets
  animate; ARP diamond visibly broadcasts; CAM/ARP tables flash as rows appear; provenance panel
  shows the ARP → ICMP chain; save to `.netforge` and reload restores everything.
