# NetForge

A browser-based network simulation and visualization platform. Every piece of protocol state —
the MAC table filling, the ARP request flooding, the TTL decrementing — is a first-class visual
object you can watch, pause, scrub and inspect byte by byte.

Status: **P1 — CCNA 1: complete (2026-09-20).** The protocol stack (DHCP, DNS, TCP, HTTP, IPv6/SLAAC,
traceroute), the CCNA 1 lab set and NetScope all ship. The binding briefs are `docs/ARCHITECTURE.md`
(P0) and `docs/ARCHITECTURE-P1.md` (P0.5 and P1; the later one wins where they differ).

## What it does

- **A real protocol stack, simulated event by event.** Ethernet and 802.11 framing, ARP, IPv4 and IPv6 with
  SLAAC and neighbour discovery, ICMP, UDP, TCP (congestion control, retransmission, TIME_WAIT), DHCP with
  relay, DNS, HTTP, and traceroute in both UDP and ICMP modes.
- **54 device models** — routers, switches, multilayer switches, access points, radios, servers, phones, hubs
  — configured through a CLI whose grammar is data, not code.
- **NetScope**, a capture view with display filters, follow-stream, protocol statistics and pcap/pcapng export
  that re-imports byte for byte.
- **15 CCNA 1 labs** that grade themselves: each task asserts against structured state, and grading runs in a
  throwaway clone so it never perturbs the learner's run.
- **Deterministic to the byte.** Same seed, same trace — which is what makes the labs gradeable and the
  acceptance suite meaningful.

## Layout

```
packages/engine   deterministic discrete-event simulation core (pure TypeScript, no DOM)
apps/web          React + PixiJS + xterm.js client; the engine runs in a Web Worker
docs/             spec (netforge-spec.md), the binding briefs (ARCHITECTURE*.md) and the device catalogue (CATALOG.md)
```

## Device catalogue

54 device models in 16 palette categories, plus 9 installable modules. Every model is data
(`packages/engine/src/device/catalog/*.ts`, derived with `defineModel` and checked by `validateCatalog`);
no engine or UI code branches on the device kind — behaviour comes from capabilities and per-port roles.
Model names follow `NF-…` and `docs/CATALOG.md`.

| Category | Models |
|---|---|
| Routers | NF-1941, NF-2911, NF-4331, NF-4451, NF-RTR-EMPTY (modular: module slots) |
| Switches | NF-C2960-8TC, NF-C2960, NF-C2960-48TT, NF-C2960-24PG, NF-C9200-48P |
| Multilayer switches | NF-C3650-24, NF-C9300-48U (switched or routed ports, SVIs, loopbacks) |
| Data centre | NF-N9K-48X, NF-N9K-32F |
| Legacy | NF-HUB-4, NF-HUB-8, NF-COAX-TAP, NF-REPEATER, NF-BRIDGE-2, NF-BRIDGE-4 (shared half-duplex segments, CSMA/CD) |
| Security | NF-FW-5506, NF-NGFW-1120, NF-IDS-SENSOR |
| Wireless | NF-AP-2600, NF-AP-1832, NF-AP-1562, NF-AP-9120, NF-WLC-3504 |
| Home / SOHO | NF-HOMEROUTER, NF-HOMEROUTER-AX, NF-SMART-TV |
| Radios | NF-RADIO-PTP5, NF-RADIO-PTP60, NF-CELL-TOWER |
| WAN / ISP | NF-DSL-MODEM, NF-CABLE-MODEM, NF-FIBER-ONT, NF-CSU-DSU, NF-INTERNET |
| Computers | NF-PC, NF-PC-WIFI, NF-LAPTOP |
| Servers | NF-SERVER, NF-SERVER-RACK |
| Mobile | NF-SMARTPHONE, NF-TABLET, NF-TABLET-LTE |
| Voice | NF-IPPHONE |
| Peripherals | NF-PRINTER |
| IoT | NF-IOT-SENSOR, NF-IP-CAMERA, NF-THERMOSTAT, NF-SMART-PLUG, NF-IOT-GATEWAY |

Modules: NF-EHWIC-2T, NF-EHWIC-4ESG, NF-NIM-2T, NF-NIM-ES2-4, NF-NIM-2GE (port modules, inserted while the
device is powered off), NF-SFP-1G-SX, NF-SFP-1G-LX, NF-SFP-10G-SR (transceivers), NF-WLAN-CARD (host expansion).

Media: copper straight-through and crossover, console (rollover) and USB console, multimode/single-mode/PON
fibre, serial DCE/DTE, coax, phone line and point-to-point radio, plus Wi-Fi and cellular over the air. Each
cable is validated with an explanation; MACs are stable per device id (the same after reload and in any build
order).

## Templates

File → New from template:

| Template | What it shows |
|---|---|
| Two PCs and a switch | ARP and MAC learning on one subnet |
| PC, router, PC | a ping through the gateway, TTL down by one |
| Three routers in a row | static routes between two hosts |
| Home Wi-Fi | a laptop scanning, joining a WPA2 network and exchanging keys |
| Hub and collisions | one collision domain; simultaneous senders collide and back off |
| Serial pair with clocking | the DCE clock rate bringing the line protocol up; keepalives |
| Multilayer switch routed port | `no switchport`, a routed port and a loopback on a multilayer switch |
| Radio bridge between two LANs | two point-to-point radios 10 km apart joining two LANs |
| Cellular phones | smartphones attaching to a tower and reaching a server behind it |

## Develop

```bash
npm install          # once, from the repository root (workspaces)
npm run dev          # http://localhost:5173
npm test             # engine unit, scenario, acceptance and determinism tests
npm run typecheck    # engine and web
npm run build        # typecheck, then the production web build
```

The five checks every change keeps green, from the repository root:

```bash
npx tsc -p packages/engine/tsconfig.json
npx vitest run --root packages/engine
cd apps/web && npx tsc -p tsconfig.json
npx vitest run --root apps/web
npx vite build          # in apps/web
```

## Ground rules

- The engine never touches wall-clock time or `Math.random` — same seed, same inputs, same run.
- Nothing mutates a packet without recording a `Mutation` (that log *is* the provenance view).
- The UI only ever renders `stateSnapshot()` data; there is no separate display model.
- Device behaviour comes from catalog data (capabilities, port roles, CLI grammar), never from the device
  kind; the kind only picks a default icon.
- All CLI help text, error messages, `show` output wording, icons and lab text are original. Device models
  are `NF-…` names (mapping and data in `docs/CATALOG.md`).
