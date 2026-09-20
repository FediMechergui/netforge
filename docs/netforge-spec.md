# NetForge — Technical Specification

**A browser-based network simulation and visualization platform**

Version 1.0 (draft) · Working title: NetForge

---

## 0. How to read this document

| Section | Audience |
|---|---|
| 1–2 | Product, curriculum designers |
| 3–7 | Backend / simulation engineers |
| 8–11 | Frontend / UX / graphics engineers |
| 12–15 | Platform & integration engineers |
| 16–21 | Everyone |

A note on scope interpretation: "CCNB" is read throughout as **CCNP** (Enterprise track: ENCOR + ENARSI). "Various cybersec levels" is read as the Cisco security ladder: Junior Cybersecurity Analyst → CyberOps Associate → Network Security → Ethical Hacker. If either reading is wrong, sections 2.4–2.7 are the ones to rewrite.

---

## 1. Product overview

### 1.1 Vision

A network runs on invisible state. Students fail CCNA not because they can't type `switchport mode trunk`, but because they cannot *see* the MAC address table filling, the spanning tree electing a root, the TTL decrementing, the NAT table rewriting a source port. NetForge makes every piece of that state a first-class visual object that can be watched, paused, scrubbed backwards, and inspected byte-by-byte.

The product is three things layered on one engine:

1. **A sandbox** — an infinite canvas where any supported device can be dropped, cabled, configured through a real-looking CLI, and made to pass traffic.
2. **A visualizer** — a rendering layer that turns protocol state into animation, overlays, and interactive diagrams.
3. **A courseware system** — authored labs with automatic grading, mapped objective-by-objective to CCNA 1–3, CCNP, and the security track.

### 1.2 Goals

- **G1** Run entirely in a browser with no install, no plugins, no local VM. Offline-capable via service worker.
- **G2** Packet-level fidelity sufficient to build and troubleshoot every topology in the target curricula.
- **G3** Every protocol state machine is observable and steppable, not just its outcome.
- **G4** Deterministic replay: the same topology + same seed + same inputs = byte-identical run, every time. This is what makes automatic grading trustworthy.
- **G5** 500 devices / 5,000 links at 60 fps on a mid-range laptop.
- **G6** An authoring path so instructors can build labs without writing code.

### 1.3 Non-goals

- Not a production network emulator. Real vendor images (IOS-XE, NX-OS binaries) are out of scope; NetForge reimplements behaviour, it does not execute vendor firmware.
- Not a penetration-testing tool. Attack modules are simulated inside the sandbox and emit no real network traffic (see §11.6).
- Not a replacement for hardware racks at the CCIE tier. Fidelity ceiling is stated explicitly in §4.3.

### 1.4 Personas

| Persona | Need | Primary surface |
|---|---|---|
| **Maya**, CCNA student, week 3 | "Why did my ping fail?" | Simulation mode, packet inspector, guided labs |
| **Dev**, CCNP candidate | BGP path selection practice | Sandbox, large topologies, CLI speed |
| **Rae**, SOC analyst trainee | Recognise an ARP poisoning attack in logs | Security range, SIEM view, attack replay |
| **Prof. Adeyemi**, instructor | Author + auto-grade 40 submissions | Authoring studio, gradebook, LMS sync |
| **Kim**, self-learner | Understand subnetting *conceptually* | Concept visualizers, standalone from topology |

### 1.5 Competitive position

| | Packet Tracer | GNS3 / EVE-NG | **NetForge** |
|---|---|---|---|
| Install required | Yes | Yes + images | No |
| Fidelity | Abstracted | Real firmware | Abstracted, higher than PT |
| Visualization | Basic packet envelope | None | Core product |
| Time travel / scrub | No | No | Yes |
| Auto-grading | PTA files | No | Yes, richer assertions |
| Security range | Minimal | BYO VMs | Built in |
| Collaboration | Multiuser hack | No | CRDT real-time |
| Extensibility | Closed | Any image | Plugin SDK, WASM device modules |

### 1.6 Legal and IP constraints (read before writing a single line of CLI code)

- **Cisco IOS command syntax** is functional/factual and broadly reimplementable, but do **not** copy help strings, banner text, error messages, or documentation verbatim. Write original strings that are functionally equivalent.
- Do **not** ship Cisco device icons, logos, or the Packet Tracer look. Commission an original icon set.
- "CCNA", "CCNP", "Cisco" are trademarks. Marketing may state *alignment with* exam objectives; it may not imply endorsement, affiliation, or certification.
- Ship an original device naming scheme (e.g. `NF-2911`, `NF-C2960`) with a mapping table in docs so learners can translate.
- Curriculum objective text must be paraphrased, not copied from official blueprints.

---

## 2. Curriculum coverage

Each course below lists the **capabilities the engine must possess**. Section 6 is the flat protocol matrix; this section is the pedagogical grouping and the source of truth for the traceability matrix (§12.7).

### 2.1 CCNA 1 — Introduction to Networks

| Topic cluster | Engine requirements |
|---|---|
| OSI / TCP-IP models | Layered PDU object with per-layer inspection; encapsulation animation |
| Physical layer & media | Copper straight/crossover, fibre SM/MM, serial, console, coax; cable-type validation with error feedback; attenuation & distance limits |
| Ethernet & framing | Full 802.3 frame, preamble/SFD/FCS, FCS error injection, min/max frame size, padding |
| MAC addressing & switching | CAM table with ageing timers, flooding, unicast/broadcast/multicast handling, collision domains (hub device), CSMA/CD on shared media |
| ARP | Request/reply, cache with timers, gratuitous ARP, proxy ARP, ARP for default gateway |
| IPv4 addressing | Classful legacy, CIDR, VLSM, subnetting workbench, private/public, loopback/APIPA/link-local |
| IPv6 addressing | Global unicast, link-local, unique local, multicast (solicited-node), EUI-64, SLAAC, ND (NS/NA/RS/RA), DAD |
| Transport layer | TCP three-way handshake, four-way close, sequence/ack arithmetic, windowing, retransmit, UDP; port numbers, sockets, netstat-equivalent |
| Application layer | DNS (A/AAAA/CNAME/MX/PTR, recursion, caching, TTL), DHCPv4 DORA + DHCPv6 stateful/stateless, HTTP/HTTPS, FTP/TFTP, SMTP/POP3/IMAP, Telnet/SSH, NTP, SNMP, Syslog |
| Basic device config | Hostname, banners, passwords, `service password-encryption`, SSH keys, `enable secret`, save/erase config, IOS boot process |
| Troubleshooting | `ping`, extended ping, `traceroute`, `show ip interface brief`, `debug` subsystem |
| Home/SOHO | Wireless router GUI device, NAT/PAT, DHCP pool, SSID/WPA2 |

### 2.2 CCNA 2 — Switching, Routing and Wireless Essentials

| Topic cluster | Engine requirements |
|---|---|
| Switch config | Port security (static/sticky/dynamic, violation modes shutdown/restrict/protect, err-disable + recovery), speed/duplex/auto-negotiation, MDIX |
| VLANs | 802.1Q tagging, native VLAN, access/trunk/dynamic, DTP, allowed-VLAN lists, voice VLAN, VLAN database, VTP v1/2/3 |
| Inter-VLAN routing | Legacy (router-per-VLAN), router-on-a-stick subinterfaces, L3 switch SVIs + routed ports |
| STP | 802.1D, PVST+, Rapid PVST+, MST; root/designated/alternate/backup/root-guard/BPDU-guard/PortFast/loop-guard; topology change events; per-VLAN root election |
| EtherChannel | PAgP, LACP, static; load-balancing algorithms, misconfiguration detection |
| Wireless | WLC + lightweight AP + autonomous AP, CAPWAP tunnels, SSID/WLAN profiles, RF channels & overlap, 2.4/5/6 GHz, WPA2/WPA3-PSK & Enterprise, roaming, client association state machine |
| Routing concepts | Directly connected, static (next-hop / exit-interface / fully specified), default, floating static, host routes, recursive lookup, longest prefix match, administrative distance, load balancing |
| IPv6 routing | Static IPv6, link-local next hops, dual stack |
| DHCP | Server, client, relay (`ip helper-address`), excluded addresses, bindings, DHCPv6 |
| NAT | Static, dynamic pool, PAT (interface & pool), inside/outside/local/global terminology visualizer, port forwarding |
| Redundancy | HSRPv1/v2 (also spec'd here for continuity with CCNP) |

### 2.3 CCNA 3 — Enterprise Networking, Security and Automation

| Topic cluster | Engine requirements |
|---|---|
| OSPF | OSPFv2 single & multi-area, OSPFv3, DR/BDR election, network types (broadcast, p2p, NBMA), hello/dead timers, cost & reference bandwidth, passive-interface, router-id, LSA types 1–5 & 7, LSDB browser, SPF tree animation, authentication |
| EIGRP | (CCNA-level + CCNP depth) neighbour table, topology table, successor/feasible successor, metric composition, stub, summarisation, unequal-cost load balancing |
| ACLs | Standard/extended, numbered/named, IPv4/IPv6, wildcard masks with a bit-level visualizer, `established`, time-based, placement guidance, ACL hit counters, logging |
| Network security concepts | CIA triad, threat/vulnerability/exploit, attack taxonomy, defence-in-depth layers, AAA, 802.1X |
| Device hardening | SSH only, unused port shutdown, DHCP snooping, DAI, IP source guard, BPDU guard, storm control, native VLAN change, `switchport nonegotiate` |
| WAN | Leased line, PPP (LCP/NCP/CHAP/PAP), HDLC, broadband (DSL/cable/fibre), MPLS conceptual overlay, Metro Ethernet, VPN concepts, GRE tunnels, site-to-site IPsec |
| QoS | Classification & marking (CoS, DSCP, IPP), queuing (FIFO, WFQ, CBWFQ, LLQ), policing vs shaping, congestion animation |
| Network management | CDP, LLDP, NTP stratum hierarchy, Syslog severity levels, SNMPv2c/v3, NetFlow/IPFIX, SPAN/RSPAN, IOS file system, image backup/upgrade, password recovery |
| Automation | REST API device simulation, JSON/XML/YAML parser playground, Python scripting sandbox, Ansible-style playbook runner, NETCONF/RESTCONF simulated endpoints, YANG model browser, controller-based networking concepts (SDN, intent-based) |

### 2.4 CCNP Enterprise (ENCOR + ENARSI)

| Topic cluster | Engine requirements |
|---|---|
| Advanced OSPF | Virtual links, stub/NSSA/totally-stubby, route filtering (LSA type-3 filter, distribute-list), summarisation, OSPF over NBMA |
| Advanced EIGRP | Named mode, wide metrics, route filtering, offset lists, authentication, EIGRP for IPv6 |
| BGP | eBGP/iBGP, peer groups, path attributes (weight, local-pref, AS-path, origin, MED, communities), best-path algorithm visualizer, route reflectors, confederations (conceptual), prefix-lists, route-maps, AS-path filters, BGP for IPv6 |
| Route redistribution | Between any pair of IGPs, seed metrics, route-maps, tagging, loop prevention, sub-optimal routing demonstration |
| Policy routing | PBR, IP SLA + object tracking, VRF-lite |
| Multicast | IGMPv2/v3, PIM-DM/SM, RP (static, BSR, Auto-RP), shared vs source trees, RPF check visualizer |
| High availability | HSRP/VRRP/GLBP full config, StackWise/VSS conceptual, NSF/GR conceptual, first-hop redundancy failover animation |
| Overlays | GRE, IPsec (IKEv1/v2, transform sets, crypto maps), DMVPN phases 1–3, LISP conceptual, VXLAN/EVPN conceptual with data-plane animation |
| Campus | Layer 2/3 boundary design, SD-Access fabric overlay (conceptual, animated), wireless CAPWAP deep dive, FlexConnect |
| Services | Advanced QoS (hierarchical policies, AutoQoS), NAT64, DNS64, NTP authentication |
| Automation (ENCOR) | EEM applets, Guest Shell concept, Python on-box, REST/NETCONF/RESTCONF depth, Cisco DNA-Center-style controller mock with northbound API |
| Troubleshooting (ENARSI) | Conditional debugs, packet-tracer-style path trace, `show` output diffing, fault-injection labs |

### 2.5 Junior Cybersecurity Analyst / Cybersecurity Essentials

- CIA triad, threat actors, attack surface visualizations
- Malware taxonomy sandbox (simulated propagation animation across a topology)
- Social engineering scenario branches (non-technical, dialogue-based)
- Cryptography playground: symmetric/asymmetric, hashing, digital signatures, PKI/certificate chains, TLS handshake visualizer
- Access control models (DAC/MAC/RBAC/ABAC) with an interactive matrix
- Basic hardening checklists as gradeable tasks

### 2.6 CyberOps Associate

| Topic cluster | Engine requirements |
|---|---|
| Windows/Linux endpoints | Simulated host shells (`ps`, `netstat`, `tasklist`, journal/Event Viewer mock), file permissions, process tree viewer |
| Network monitoring | Full pcap engine, protocol dissectors, session reconstruction, NetFlow record generation |
| Attack analysis | Scan detection, exploit kill-chain walkthrough, Diamond Model & MITRE ATT&CK mapping panel |
| Protocols & vulnerabilities | ARP/DHCP/DNS/HTTP/ICMP abuse scenarios, tunnelling & exfiltration detection |
| Security monitoring | IDS/IPS with a Snort-compatible rule subset, alert triage queue, false-positive tuning exercise |
| Data & logs | Syslog aggregation, SIEM query language (SQL-like), dashboards, timeline correlation |
| Incident response | NIST 800-61 phased playbook workflow, evidence collection, chain-of-custody form, IR report generator |

### 2.7 Network Security / Ethical Hacker

| Topic cluster | Engine requirements |
|---|---|
| Secure device access | AAA local/RADIUS/TACACS+, role-based CLI views, privilege levels, SSH hardening, control-plane policing |
| Layer 2 security | Full DHCP snooping / DAI / IPSG / port security / storm control / PVLAN, plus the attacks they stop (see §11) |
| Firewalls | Stateless ACL, stateful zone-based firewall (zones, zone-pairs, class/policy maps), NGFW mock with app-ID & URL filtering, state table viewer |
| IPS | Signature and anomaly modes, inline vs promiscuous, tuning |
| VPN | Site-to-site IPsec (IKEv1/v2 phase visualizer), remote-access SSL VPN, crypto negotiation step-through |
| Endpoint | AV/EDR mock, host firewall, application allow-listing |
| Cryptography | Full playground (shared with §2.5) + key exchange (DH group animation), PKI CA hierarchy builder, cert lifecycle |
| Offensive (Ethical Hacker) | Recon (simulated `nmap`, DNS enumeration, OSINT mock), scanning & enumeration, simulated exploitation against deliberately vulnerable sandbox hosts, privilege escalation puzzles, post-exploitation, reporting. **All simulated — see §11.6 safety boundary.** |

### 2.8 Traceability

Every engine feature carries a `objectives: []` tag referencing a curriculum node ID (e.g. `CCNA2.5.3`, `ENCOR.3.1.2`). The build pipeline generates a coverage report; any objective with zero mapped features or zero mapped labs fails CI as a `coverage-gap` warning.

---

## 3. System architecture

### 3.1 High level

```
┌──────────────────────────────────────────────────────────────┐
│  BROWSER                                                     │
│                                                              │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │ UI Shell   │  │ Visualization│  │ CLI Terminals       │   │
│  │ (React/TS) │  │ (WebGL/GPU)  │  │ (xterm.js)          │   │
│  └─────┬──────┘  └──────┬───────┘  └──────────┬──────────┘   │
│        │  state store (immer + selectors)     │              │
│  ┌─────┴───────────────────────────────────────┴──────────┐  │
│  │  Engine Bridge (typed RPC, SharedArrayBuffer ring)     │  │
│  └─────┬──────────────────────────────────────────────────┘  │
│        │                                                     │
│  ┌─────┴───────────── WEB WORKER ─────────────────────────┐  │
│  │  SIMULATION CORE (Rust → WASM)                         │  │
│  │  ├ Event scheduler   ├ Device runtime  ├ PDU codecs    │  │
│  │  ├ Protocol daemons  ├ Link model      ├ Trace ring    │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS / WSS
┌───────────────────────────┴──────────────────────────────────┐
│  BACKEND                                                     │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Identity │ │ Content   │ │ Grading  │ │ Collab (CRDT)  │  │
│  │ + LMS/LTI│ │ (labs,    │ │ (headless│ │ WebSocket hub  │  │
│  │          │ │ courses)  │ │  engine) │ │                │  │
│  └──────────┘ └───────────┘ └──────────┘ └────────────────┘  │
│      Postgres · Object storage · Redis · Job queue           │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Why the engine is Rust/WASM and not TypeScript

- Deterministic integer/float behaviour across browsers (critical for G4).
- Packed struct memory layout → 500-device topologies fit in a few MB and traverse without GC pauses.
- The *same* compiled core runs server-side (native binary) for headless grading — one implementation, no drift between "what the student saw" and "what the grader scored."
- Measured target: ≥ 1M simulated events/sec single-threaded.

### 3.3 Client architecture

| Layer | Responsibility | Tech |
|---|---|---|
| Shell | Routing, panels, docking, theming, command palette | React 18, TypeScript |
| State | UI state only; sim state is mirrored read-only | Zustand + immer |
| Canvas | Topology rendering, packet animation, overlays | PixiJS v8 (WebGL2, WebGPU when available) |
| Panels | Tables, inspectors, charts | React + a custom virtualised table; visx/ECharts for charts |
| Terminal | Device console/SSH sessions | xterm.js + custom addon for syntax highlight & `?` help |
| Editor | Config files, Python/Ansible sandbox, rule authoring | Monaco |
| Bridge | Worker RPC, snapshot diffing, backpressure | Comlink-style typed channel + SharedArrayBuffer ring buffer for the packet trace stream |
| Persistence | Local autosave, offline labs | IndexedDB + Service Worker |

**Rendering strategy.** Topology is drawn in a single WebGL scene graph with instanced sprites for devices and a signed-distance-field shader for cables (lets cables glow, pulse, and show directional flow without per-frame geometry rebuilds). Packets are GPU-instanced quads driven by a per-packet `(startTime, endTime, pathIndex)` tuple uploaded once — animation is interpolated on the GPU, so 10,000 in-flight packets cost almost nothing on the CPU.

### 3.4 Backend services

| Service | Purpose | Notes |
|---|---|---|
| **Identity** | Accounts, orgs, classes, roles | OIDC; LTI 1.3 for LMS |
| **Content** | Courses, labs, versioning, media | Immutable published versions; drafts are mutable |
| **Grading** | Runs headless engine against submissions | Queue-backed; hard CPU/time caps per job |
| **Collab** | Real-time topology co-editing, instructor "join session" | Yjs over WebSocket, per-doc awareness |
| **Telemetry** | Learning analytics, misconception detection | Event stream → warehouse; privacy rules in §17 |
| **Registry** | Device/plugin catalog | Signed WASM plugin modules |

Datastores: Postgres (relational + JSONB for lab definitions), S3-compatible object store (`.netforge` files, pcaps, media), Redis (sessions, presence, rate limits).

### 3.5 Deployment

- Fully static client bundle on CDN; backend in containers behind an API gateway.
- **Offline/desktop mode**: the same bundle wrapped in Tauri, with a local SQLite store and a bundled grading binary — for institutions with no reliable internet.
- **Self-host**: single-compose deployment for universities with data-residency requirements.

---

## 4. Simulation engine

### 4.1 Discrete-event core

The engine is a discrete-event simulator. There is no fixed tick. State advances by pulling the earliest event from a priority queue.

```rust
struct Event {
    at: SimTime,        // u64 nanoseconds since epoch 0
    seq: u64,           // monotonic tiebreaker — guarantees total order
    target: EntityId,   // device, interface, or process
    kind: EventKind,
}

enum EventKind {
    FrameArrival { pdu: PduHandle, ingress: PortId },
    TimerFire { timer: TimerId },
    LinkStateChange { up: bool },
    ProcessWake { pid: ProcessId, reason: WakeReason },
    UserCommand { session: SessionId, line: String },
    FaultInject { fault: FaultId },
}
```

Queue implementation: a hierarchical timing wheel for near-term events (< 1 s horizon, O(1) insert) with a spillover binary heap for long timers (ageing timers, NTP intervals, certificate expiry). Ties are broken by `seq`, never by insertion order of a hash map — this is the single most important determinism rule in the codebase.

### 4.2 Time model

- **SimTime** is `u64` nanoseconds. Nanosecond resolution is required to make serialization delay on a 10 Gbps link meaningful (a 64-byte frame = 51.2 ns).
- **Wall clock decoupling.** A scheduler thread maps SimTime → wall time via a rate multiplier: `0` (paused), `0.001×` … `10000×`, plus `step-event`, `step-packet`, and `run-to-breakpoint`.
- **Delay components**, all modelled explicitly so students can see where latency comes from:
  - *Serialization* = `frame_bits / interface_bps`
  - *Propagation* = `cable_length_m / (0.66 × c)` for copper, `/(0.67 × c)` for fibre
  - *Queuing* = derived from the egress queue discipline (§4.7)
  - *Processing* = per-device-class constant with optional jitter
- **Determinism (G4).** All randomness comes from a single splittable PRNG seeded from the scenario. Each entity gets a deterministically derived sub-stream (`seed ⊕ hash(entity_id)`), so adding a device never perturbs the random sequence of existing devices. Sources of randomness: CSMA/CD backoff, OSPF/EIGRP hello jitter, STP timer skew, configured loss/corruption, RF fading, attacker tool timing.

### 4.3 Fidelity modes

| Mode | Behaviour | Use case |
|---|---|---|
| **Realtime** | Control-plane convergence runs at high multiplier; data-plane frames animated but sampled (not every frame is drawn) | Building topologies, config practice |
| **Simulation** | Every PDU is an inspectable object; the run pauses at each user-selected protocol event | Learning, troubleshooting |
| **Turbo** | No rendering, no trace ring, maximum speed | Grading, convergence tests, instructor pre-flight |
| **Forensic** | Full byte-accurate serialization of every PDU into the pcap ring | Security labs, packet analysis |

Declared fidelity ceiling (publish this honestly in docs): NetForge models control-plane *behaviour and timing*, not vendor-specific ASIC microarchitecture, exact IOS bug-for-bug output, hardware queue depths, or platform-specific TCAM exhaustion. Where a real device would behave differently in a way that matters pedagogically, the docs say so.

### 4.4 Device model

```
Device
├─ chassis: ChassisSpec        (slots, power, default modules)
├─ modules: [Module]           (NIM/HWIC/SFP — hot-swap requires power off)
├─ ports: [Port]               (PhysicalPort | LogicalPort)
├─ storage: { flash: FS, nvram: Blob, ram: RunningConfig }
├─ os: OsImage { family, version, feature_set }
├─ processes: [Process]        (protocol daemons, see §4.8)
├─ tables: DeviceTables        (CAM, ARP, RIB, FIB, NAT, STP, ...)
├─ clock: DeviceClock          (offset + drift → makes NTP labs real)
├─ cpu: CpuModel               (utilisation budget → CPU-exhaustion attacks)
└─ trace: TraceSink
```

**Port model.** Each physical port has: media type, admin state, oper state, negotiated speed/duplex, MTU, MAC, queue set, counters (in/out packets, bytes, errors, CRC, runts, giants, collisions, drops), and an optional `err-disabled` reason. Counters are real, derived from actual simulated frames — `show interfaces` is never faked.

**Storage.** `flash:` is a simulated filesystem supporting `dir`, `copy`, `delete`, `format`. IOS images are objects with feature sets; copying a wrong-feature image and reloading actually loses features. NVRAM holds `startup-config`. `running-config` lives in RAM and is lost on reload — students must feel that.

### 4.5 PDU model

A PDU is a tree of decoded layers plus a byte buffer. Both representations are maintained; the byte buffer is authoritative.

```rust
struct Pdu {
    id: PduId,
    bytes: Bytes,               // authoritative wire image
    layers: SmallVec<[Layer;6]>,// decoded views with byte offsets
    meta: PduMeta,              // birth time, origin, colour tag, flow id
    provenance: Vec<Mutation>,  // ← every field change, with who/when/why
}

struct Mutation {
    at: SimTime,
    device: DeviceId,
    reason: MutationReason,     // TtlDecrement, MacRewrite, NatTranslate,
                                // VlanTagPush, Encrypt, FragmentSplit, ...
    field: FieldPath,           // "ipv4.ttl"
    before: FieldValue,
    after: FieldValue,
}
```

The `provenance` vector is the backbone of the headline visualization (§9.3). Nothing mutates a packet without appending a Mutation. This is enforced by making the layer fields private and mutation the only write path — an architectural invariant, not a convention.

Supported encapsulations must round-trip: Ethernet II · 802.3/LLC/SNAP · 802.1Q · 802.1ad (QinQ) · PPP · HDLC · Frame Relay (legacy) · ARP · IPv4 (incl. options, fragmentation) · IPv6 (+ extension headers) · ICMPv4/v6 · TCP (options: MSS, SACK, WS, timestamps) · UDP · GRE · IPsec AH/ESP · CAPWAP · VXLAN · 802.11 (mgmt/ctrl/data) · CDP · LLDP · STP/RSTP/MST BPDU · DTP · VTP · LACP/PAgP · HSRP/VRRP/GLBP · routing protocol PDUs (RIP, EIGRP, OSPFv2/v3, BGP, PIM, IGMP) · DHCPv4/v6 · DNS · HTTP · TLS record layer (headers real, crypto simulated) · NTP · SNMP · Syslog · NetFlow v5/v9/IPFIX · RADIUS · TACACS+ · EAPOL.

### 4.6 Link and media model

| Media | Parameters modelled |
|---|---|
| Cat5e/6 copper | Max 100 m, crossover/straight correctness (with auto-MDIX override), attenuation → error rate beyond spec |
| Fibre MM/SM | Distance limits, wavelength/SFP compatibility, Tx/Rx pair crossing |
| Serial (DCE/DTE) | Clock rate required on DCE; no clock = line protocol down (a classic lab) |
| Console/AUX | Out-of-band access only |
| Coax + hub | Shared collision domain, CSMA/CD with exponential backoff, collision animation |
| Wireless | See §4.9 |

Per-link injectable impairments: bandwidth cap, added latency, jitter distribution, loss %, duplication %, reorder %, corruption % (flips bits → FCS failures), MTU. Every impairment is a first-class UI control (a "cable condition" panel) because half of troubleshooting pedagogy is *manufacturing* faults.

### 4.7 Queueing and QoS

Every egress port owns a queue set. Disciplines: FIFO, PQ, CQ, WFQ, CBWFQ, LLQ, WRED. Policers (single/dual rate, token bucket) and shapers (leaky bucket with a shaping buffer) are modelled with visible token levels — the QoS visualizer (§9.9) draws the buckets filling and draining.

### 4.8 Process model (protocol daemons)

Each protocol runs as a cooperative state machine, not a thread:

```rust
trait Process {
    fn id(&self) -> ProcessId;
    fn on_pdu(&mut self, ctx: &mut Ctx, pdu: &Pdu, port: PortId) -> Vec<Action>;
    fn on_timer(&mut self, ctx: &mut Ctx, t: TimerId) -> Vec<Action>;
    fn on_config(&mut self, ctx: &mut Ctx, delta: &ConfigDelta) -> Vec<Action>;
    fn state_snapshot(&self) -> StateView;   // ← drives the UI, always
    fn debug_events(&self) -> &[DebugEvent]; // ← drives `debug` output
}
```

Two rules make the whole product work:

1. **`state_snapshot()` is the only way the UI learns anything.** No parallel "display model." What you see in the visualizer is the actual simulator state, so it can never lie.
2. **Every state-machine transition emits a `DebugEvent`.** `debug ip ospf adj` output and the animated OSPF neighbour state machine are two renderings of the same event stream.

### 4.9 Wireless / RF model

- **Propagation**: log-distance path-loss with configurable exponent per material; walls/floors placed in the physical view carry attenuation values (drywall 3 dB, concrete 12 dB, etc.).
- **Channels**: full 2.4 GHz (1–13, overlap modelled), 5 GHz (UNII bands, DFS), 6 GHz. Co-channel and adjacent-channel interference reduce throughput realistically.
- **Rates**: MCS table per 802.11a/b/g/n/ac/ax; SNR → MCS selection → actual throughput.
- **Client state machine**: scan → authenticate → associate → (EAP) → DHCP → data, each step visible.
- **Roaming**: RSSI-triggered, with 802.11r fast transition option.
- **CAPWAP**: control & data tunnels between AP and WLC, split-MAC behaviour, FlexConnect local switching.
- **Heatmap**: live RSSI/SNR raster over the floor plan, recomputed on AP move (§9.8).

### 4.10 Internet / WAN cloud

A parameterised "Internet" entity that can be:
- **Transparent** (a simple L2 bridge for early labs),
- **Provider cloud** (configurable BGP AS, latency matrix between attachment points, public IP allocation), or
- **Full multi-AS mesh** (auto-generated ISP topology for CCNP BGP labs, with an internal view that can be opened).

Public services (root DNS, NTP pool, a handful of web/mail servers, a simulated CA, an "attacker C2" host for security labs) are prebuilt inside it.

### 4.11 Fault injection

A structured fault API used by both instructors and the scenario engine:

| Fault class | Examples |
|---|---|
| Physical | Cable cut, port flap (with frequency), power loss, module failure |
| Config | Apply a pre-written broken config fragment (mismatched duplex, wrong VLAN, shifted subnet mask, wrong OSPF area, ACL deny-any at the top) |
| Control plane | Suppress hellos, corrupt a BPDU, inject a bogus route, MD5 key mismatch |
| Performance | CPU spike, memory exhaustion, buffer starvation, interface congestion |
| Security | Any attack from §11 as a scheduled event |

Faults are schedulable (`at t=30s`) and can be hidden from the student — the basis of every troubleshooting lab.

### 4.12 Performance budget

| Metric | Target | Hard ceiling |
|---|---|---|
| Devices per topology | 500 | 2,000 |
| Links | 5,000 | 20,000 |
| Events/sec (Turbo) | 1,000,000 | — |
| In-flight animated packets | 10,000 @ 60 fps | 50,000 (LOD degrades to flow-rate glow) |
| Cold start to interactive | < 2.5 s | 5 s |
| Topology open (200 devices) | < 800 ms | 2 s |
| Memory, 500-device topology | < 600 MB | 1.5 GB |
| Trace ring | 500 MB configurable, oldest-evicted | — |

Level-of-detail: beyond ~150 visible devices, individual packet sprites are replaced by animated flow intensity on cables; zooming in restores per-packet rendering for the visible subgraph only.

---

## 5. Device and component catalog

### 5.1 Network devices

| Class | Models | Key capabilities |
|---|---|---|
| **Routers** | Branch (2 GE, 2 slots), Mid (4 GE, 4 slots), Enterprise edge (8 GE + 10 GE uplinks), ISR-class with voice/security modules | Full L3, NAT, ACL, VPN, QoS, zone firewall, IP SLA, VRF-lite |
| **Switches — L2** | 8/24/48-port FE & GE, PoE variants | VLAN, STP family, EtherChannel, port security, DHCP snooping, DAI, storm control |
| **Switches — L3** | 24/48-port multilayer, stackable | Everything above + SVI, routed ports, all IGPs, HSRP/VRRP/GLBP, multicast |
| **Switches — DC** | Spine/leaf class | VXLAN/EVPN, FEX conceptual, vPC conceptual |
| **Firewalls** | Stateful appliance + NGFW | Zones, policies, NAT, VPN, IPS module, app-ID, URL filter, user identity |
| **Wireless** | WLC, lightweight AP, autonomous AP, mesh AP, home wireless router | §4.9 |
| **WAN** | CSU/DSU, modem (DSL/cable), fibre ONT, MPLS PE mock | PPP, HDLC, broadband auth (PPPoE) |
| **Legacy** | Hub, bridge, repeater | For collision/broadcast domain teaching |
| **Security** | IDS/IPS sensor, NAC appliance, SIEM collector, jump host | §11 |
| **Specialty** | Load balancer, WAN accelerator, proxy, VPN concentrator, IP phone, DHCP/DNS/AAA appliance | |

### 5.2 End devices and servers

PC (Windows-like shell + GUI apps), Laptop (with wireless NIC), Smartphone/Tablet, IP Phone, Printer, Server (multi-role: HTTP/HTTPS, DNS, DHCP, TFTP/FTP, SMTP/POP3/IMAP, NTP, Syslog, AAA/RADIUS/TACACS+, SNMP manager, CA, SIEM, file share), IoT devices (sensor, actuator, smart appliance, camera) with an IoT gateway and a rules engine, and a **Generic Programmable Device** running the Python sandbox for automation labs.

Each end device exposes: a desktop GUI (IP config, browser, terminal, e-mail client, file manager, Wireshark-lite), a command shell, and a config panel.

### 5.3 Cables and connectors

Straight-through, crossover, rollover/console, serial DCE, serial DTE, fibre (MM/SM, LC/SC), coax, phone line, USB, and **auto-select** (picks the correct cable, with a toggle to disable for cable-type teaching).

### 5.4 Physical-view objects

Racks (with U positions and cable management), wiring closets, buildings, floors, rooms, walls with materials, patch panels, power strips/UPS, and a distance-aware cable-run tool that refuses runs exceeding media limits and explains why.

---

## 6. Protocol coverage matrix

Legend: **F** = full simulation · **B** = behavioural (correct state machine & timing, simplified internals) · **C** = conceptual (visualized, not packet-accurate)

| Layer | Protocols |
|---|---|
| **L1** | Ethernet PHY **F**, autonegotiation **F**, MDIX **F**, SFP compatibility **F**, PoE negotiation **B**, 802.11 PHY **B**, DSL/DOCSIS **C**, SONET/SDH **C** |
| **L2** | Ethernet II/802.3 **F**, 802.1Q **F**, QinQ **F**, STP/RSTP/MST/PVST+ **F**, EtherChannel PAgP/LACP **F**, CDP **F**, LLDP **F**, DTP **F**, VTP v1/2/3 **F**, PPP+LCP/NCP/PAP/CHAP **F**, HDLC **F**, PPPoE **B**, Frame Relay **B**, 802.1X/EAPOL **F**, ARP/RARP/GARP **F**, 802.11 mgmt/ctrl/data **B**, CAPWAP **B**, VXLAN **B**, LLDP-MED **B** |
| **L3** | IPv4 **F** (options, fragmentation, ToS/DSCP), IPv6 **F** (ext headers, ND, SLAAC, DAD, RA), ICMPv4/v6 **F**, IGMPv2/v3 **F**, RIPv1/v2/RIPng **F**, EIGRP + named mode **F**, OSPFv2/v3 **F**, IS-IS **B**, BGP-4 + MP-BGP **F**, PIM-DM/SM/SSM **B**, HSRPv1/v2 **F**, VRRPv2/v3 **F**, GLBP **F**, GRE **F**, IPsec AH/ESP + IKEv1/v2 **B** (headers real, crypto simulated), NAT/PAT/NAT64 **F**, MPLS **C**, LISP **C**, SD-Access **C** |
| **L4** | TCP **F** (handshake, teardown, seq/ack, sliding window, Nagle, SACK, fast retransmit, congestion control — Reno & CUBIC), UDP **F**, QUIC **C** |
| **L5–7** | DNS **F**, DHCPv4/v6 **F**, HTTP/1.1 **F**, HTTP/2 **C**, TLS 1.2/1.3 handshake **B**, FTP/TFTP **F**, SMTP/POP3/IMAP **F**, Telnet **F**, SSHv2 **B**, SNMP v1/2c/3 **F**, Syslog **F**, NTPv4 **F**, NetFlow v5/v9/IPFIX **F**, RADIUS **F**, TACACS+ **F**, LDAP **B**, NETCONF/RESTCONF **B**, SMB **C**, RTP/SIP **B** |

---

## 7. CLI emulation subsystem

The CLI is where students spend 70% of their time. It must feel right or nothing else matters.

### 7.1 Architecture

```
keystroke → Terminal (xterm.js)
          → Line editor (history, ^A/^E/^W/^U, ^C, ^Z, ^Shift+6)
          → Completion engine  ──┐
          → Parser (grammar)     ├─ shares the command tree
          → Validator            │
          → Command node         ┘
          → Config AST mutation  →  ConfigDelta  →  Process.on_config()
          → Renderer (show-command output templates)
```

### 7.2 Command grammar

Commands are declared as data, not code — a tree of nodes with typed arguments, mode constraints, privilege levels, and handlers:

```yaml
- path: [interface, <if-name>]
  mode: config
  privilege: 15
  help: "Configure an interface"
  arg:
    if-name:
      type: interface-ref
      completion: dynamic:interfaces
      error_if_missing: "Invalid interface reference"
  enters_mode: config-if
  objectives: [CCNA1.10.2]
```

This yields, for free: context-sensitive `?` help, tab completion, `%` error messages with a caret pointing at the offending token, per-mode command availability, and machine-readable documentation. It also makes adding CCNP commands a content task rather than an engineering task.

### 7.3 Modes and access

User EXEC → Privileged EXEC → Global config → sub-modes (interface, subinterface, line, router, vlan, class-map, policy-map, crypto, zone, zone-pair, key-chain, route-map, prefix-list, ip-sla, event-manager, wlan, …). Privilege levels 0–15, role-based CLI views, `enable secret` with hash types, AAA-driven authentication, and login banners.

Access paths: console (via console cable from a PC terminal), Telnet, SSH, AUX, and a web GUI on devices that have one. Each path has its own line config, session limits, timeouts, and ACL restrictions — so "I locked myself out with an ACL" is a reproducible lesson.

### 7.4 Configuration as an AST

`running-config` is not a string. It is a structured tree that renders to text. This gives:

- **Correct ordering and indentation** for free.
- **`show running-config | section|include|exclude|begin`** implemented as tree queries.
- **Config diff** between any two points in time, rendered side-by-side with additions/removals highlighted — a genuinely new teaching tool. ("What did I change between when it worked and now?")
- **Grading assertions** against structure instead of regex (§12.4).
- **Rollback** to any checkpoint.

### 7.5 `show` and `debug`

`show` commands read from live `state_snapshot()` data through output templates, so output can never drift from reality. Every `show` output row carries hidden metadata linking it back to the object it describes — clicking a row in the terminal highlights the corresponding device/port/route in the topology. (This is one of the small features students will love most.)

`debug` subscribes to the `DebugEvent` stream with filters, conditional debugging (`debug condition interface`), and a rate limiter that mimics a real device drowning in output — including the lesson of `undebug all`.

### 7.6 Quality-of-life additions beyond a real device

These are opt-in and clearly marked as non-standard, so students know what won't exist on real hardware:

- Inline syntax linting (a wavy underline before you hit enter)
- "Explain this command" hover panel with the objective reference
- Command history search across sessions
- A **safe mode** that warns before commands that will disconnect your own session
- Paste-a-config with per-line validation results

---

## 8. User interface

### 8.1 Layout

```
┌─ Top bar: file · edit · view · simulate · [▶ ‖ ⏭] · speed · mode · share · help ─┐
├────────┬──────────────────────────────────────────────┬───────────────────────┤
│        │                                              │                       │
│ Tool   │            WORKSPACE CANVAS                  │   INSPECTOR           │
│ palette│   (logical / physical / overlay views)       │   (context-sensitive) │
│        │                                              │                       │
│ Devices│                                              │   selected device:    │
│ Cables │                                              │    tables, ports,     │
│ Notes  │                                              │    config, counters   │
│ Shapes │                                              │                       │
│ Attacks│                                              │                       │
├────────┴──────────────────────────────────────────────┴───────────────────────┤
│ BOTTOM DOCK (tabbed, resizable, tear-off to second monitor)                    │
│ Terminal · Packet list · Timeline · Event log · Tables · Charts · Tasks        │
└───────────────────────────────────────────────────────────────────────────────┘
```

Panels are dockable and tear-off (a real second-monitor workflow: topology on one screen, terminal + packet list on the other). Layout presets: *Learn*, *Build*, *Troubleshoot*, *Analyse*, *Exam*.

### 8.2 Workspace views

| View | Purpose |
|---|---|
| **Logical** | The classic topology graph. Auto-layout options: force-directed, hierarchical (core/distribution/access), tiered-by-subnet, circular. Manual positioning always wins and is preserved. |
| **Physical** | Geographic → building → floor → rack → device-front. Cable runs measured in metres; racks show real U placement; device front panels show live port LEDs (link/activity/speed colours, err-disabled amber). |
| **Overlay** | Any visualization from §9 painted onto the logical view. |
| **Concept** | Full-screen standalone visualizers not tied to a topology (subnetting workbench, crypto playground, OSI explorer). |

### 8.3 Interaction model

- **Cabling**: drag from port to port; invalid combinations are rejected *with an explanation*, not just a red X. Auto-cable mode for beginners.
- **Multi-select**: rubber band, shift-click, "select all like this", and bulk config apply ("set these 12 ports to access VLAN 20").
- **Templates**: save a configured device as a template; stamp it repeatedly.
- **Containers**: group devices into a collapsible cluster (a whole branch office collapses to one icon).
- **Command palette** (`Ctrl+K`): every action, device, and lab reachable by typing.
- **Annotations**: text, shapes, arrows, freehand, sticky notes, and an *instructor laser pointer* in collaborative sessions.
- **Undo/redo**: unlimited, including config changes, with a visual history tree.

### 8.4 Device inspector

Tabs, all live: **Overview** (model, uptime, CPU, memory graphs) · **Ports** (table + front-panel graphic) · **Config** (AST-backed editor with diff) · **Tables** (CAM/ARP/RIB/FIB/NAT/STP/neighbours — filterable, sortable, cross-linked to topology) · **Counters** (charts) · **Logs** · **Processes** (running daemons with state) · **Physical** (modules, drag-in NICs, power switch).

### 8.5 Design language

- Dark and light themes, both fully specified; dark is default (packet animation reads better on dark).
- Colour is **never** the only encoding — STP port roles get icons *and* colour, VLANs get a pattern *and* colour. Colourblind-safe palettes (Okabe–Ito derived) for all semantic colours.
- Motion has meaning: nothing animates decoratively. Packet motion = actual traversal, pulse = state change, shake = error.
- Typography: one humanist sans for UI, one monospace with clear `0/O`, `1/l/I` for CLI and hex.
- All animation respects `prefers-reduced-motion`, degrading to discrete state transitions with a "step" control.

---

## 9. The visualization system

This is the product's reason to exist. Each visualizer below is a **module** implementing a common interface (`subscribe(stateSelector) → render(frame)`), registered against a protocol and a set of curriculum objectives, so labs can auto-open the right one.

### 9.1 Packet animation (the baseline)

Packets travel along cables as shaped, coloured capsules. Encoding:

| Visual property | Meaning |
|---|---|
| Shape | L2 frame type (rounded = Ethernet data, hexagon = control/BPDU, diamond = ARP) |
| Colour | Protocol family, or flow ID when "colour by conversation" is on |
| Size | Frame size (log-scaled, clamped) |
| Trail length | Serialization time on this link |
| Pulse | Payload is encrypted |
| Cracked texture | FCS error / corruption |
| Fading out | Dropped — with a floating reason tag ("TTL expired", "ACL 101 deny", "no route") |

Speed is proportional to real simulated timing, so a 64 Kbps serial link visibly crawls next to a 10 Gbps uplink. This single detail teaches bandwidth better than any diagram.

**Drop visualization** deserves special emphasis: every dropped packet spawns a brief marker at the drop point with the reason, and the drop is clickable to jump to the exact rule/table entry responsible.

### 9.2 Encapsulation / OSI view

Click any in-flight packet → it expands into a stacked "lasagna" of layers. Each layer is a card with its fields, sized proportionally to its byte count, with the corresponding bytes highlighted in a synchronized hex view. Animating between hops shows headers being pushed on and popped off — the 802.1Q tag physically sliding into place at a trunk port is a 3-second animation that replaces twenty minutes of whiteboard.

An "OSI ladder" mode draws the classic 7-layer columns for source and destination, with the packet descending, crossing, and ascending.

### 9.3 Header provenance ("what changed and who changed it") — flagship feature

A horizontal timeline of hops. Under each hop, only the header fields that **changed at that hop** are shown, as before → after pairs, colour-coded by mutation reason, with the responsible config line quoted and clickable.

```
  PC1 ──────► SW1 ──────► R1 ──────► R2 ──────► ISP ──────► Server
              │           │          │          │
        +802.1Q tag   src MAC ✎   ttl 63→62   src IP ✎ NAT
        vlan 20       dst MAC ✎   ttl 64→63   src port 49152→61003
                                              ▸ ip nat inside source
                                                list 1 interface g0/1 overload
```

Nothing else on the market answers "why does my packet look different over here?" visually. This panel is built directly from `Pdu.provenance` (§4.5), so it is exhaustive by construction.

### 9.4 Table visualizers

Live, animated, cross-linked. When a table row is written, it flashes; when a row ages out, it fades with a countdown ring showing remaining TTL.

- **MAC address table**: entries appear as frames arrive, with a ghost arrow back to the source port. A "flood" event lights up every port the frame was copied to.
- **ARP cache**: paired with an animated request/reply sequence and the broadcast flood it caused.
- **Routing table**: sortable, with a **longest-prefix-match explainer** — enter a destination IP and the table animates the match, showing each candidate prefix as a binary bit comparison, eliminating losers, and declaring a winner with AD/metric tie-breaks shown.
- **FIB/adjacency**: side-by-side with the RIB to teach control vs data plane.
- **NAT translation table**: with the inside-local/inside-global/outside-local/outside-global quadrant diagram, filling in live as a packet traverses. This diagram, animated, fixes the single most confused topic in CCNA 2.
- **STP, neighbour, multicast, DHCP binding, TCAM/ACL hit** tables, all with the same treatment.

### 9.5 Protocol state machines

For every stateful protocol, an interactive state diagram: current state highlighted, legal transitions as edges, the *triggering PDU* animating along the edge as it fires, and a history strip of past transitions with timestamps.

Covered: OSPF neighbour (Down→Init→2-Way→ExStart→Exchange→Loading→Full, with DR/BDR election shown), EIGRP DUAL, BGP FSM (Idle→Connect→Active→OpenSent→OpenConfirm→Established), STP port states (with the 30-second forward-delay timer visualized as a draining bar), TCP FSM, PPP LCP/NCP, DHCP DORA, 802.1X, IKE phase 1/2, 802.11 association, and CAPWAP join.

### 9.6 Topology overlays

| Overlay | What it draws |
|---|---|
| **VLAN** | Access ports tinted by VLAN; trunks striped with the allowed-VLAN list as chips; native VLAN flagged; VLAN mismatches pulse red |
| **Spanning tree** | Root bridge crowned; port roles labelled (R/D/A/B) with role icons; blocked ports crossed; the active tree drawn as solid links and blocked links as dashed; per-VLAN selector; **topology change events replay as a wave** propagating from the change point |
| **OSPF** | Areas as translucent zones; ABRs/ASBRs badged; adjacency links weighted by cost; a separate **LSDB graph** showing every LSA as a node with type-coloured edges; **SPF tree animation** that runs Dijkstra step-by-step from the selected router |
| **EIGRP** | Topology table as a graph with successors bold, feasible successors dashed, and the feasibility condition shown as an inequality that evaluates live |
| **BGP** | AS-path ribbons between autonomous systems; a **best-path decision table** that walks the 13 tie-break steps in order, eliminating routes and showing exactly which step decided |
| **Routing (any)** | Colour every device by which next-hop it would use for a chosen destination — instantly reveals routing loops and black holes as colour discontinuities |
| **Broadcast/collision domains** | Translucent blobs; adding a switch visibly splits collision domains, adding a router splits broadcast domains |
| **Subnets** | Each subnet shaded with its CIDR label; overlapping/misconfigured subnets flagged |
| **QoS** | Links coloured by utilisation; queues drawn as stacked bars at egress ports |
| **Multicast** | Distribution tree, RPF interface highlighted, (*,G) vs (S,G) toggle |
| **Security** | Trust zones, firewall policies as gates, encrypted segments as armoured pipes, and the attack-path graph (§11.5) |

### 9.7 Timeline and time travel

A scrubber across the bottom of the screen showing the whole run:

- **Event lanes** per protocol (OSPF adjacency changes, STP topology changes, link flaps, ACL denies, security alerts).
- **Scrub backwards and forwards.** All tables, all state, all packet positions reconstruct to that instant. Implemented as periodic full snapshots (every N events, delta-compressed) plus forward replay from the nearest snapshot — replay is exact because the engine is deterministic (G4).
- **Bookmarks** on interesting moments, with notes; sharable as a deep link (`/lab/42?t=00:01:23.456&focus=R2`).
- **Compare mode**: two timeline positions side by side, showing what changed in every table between them.
- **Convergence measurement**: select an event ("link down"), and the timeline measures and annotates time-to-reconvergence for every protocol involved. Students can then tune hello/dead timers and *see* the number drop.

### 9.8 Wireless visualizers

RF heatmap over the floor plan (RSSI or SNR, with a legend and a dBm probe tool), channel-overlap spectrum chart, per-client association timeline with roaming handoffs marked, airtime utilisation pie per AP, and a co-channel interference overlay that highlights offending AP pairs.

### 9.9 Concept visualizers (topology-independent)

Full-screen interactive tools, usable standalone and linkable from labs:

- **Subnetting workbench**: an address rendered as 32 draggable bits; move the mask boundary and watch network/host portions, usable hosts, ranges, broadcast, and wildcard mask update live. Includes VLSM mode (a treemap of an address block being carved up, with waste shown as hatched area) and a practice generator with instant checking.
- **IPv6 explorer**: abbreviation rules animated (leading-zero drop, `::` collapse) with a validity checker, EUI-64 derivation stepped bit by bit, and an address-type classifier.
- **Binary/hex converter** with place-value scaffolding.
- **Wildcard mask builder**: write an intent ("all odd /26 subnets in 10.1.0.0/16"), see the mask.
- **TCP ladder diagram**: sequence/ack numbers on a swimlane with a live window-size graph, retransmission and fast-recovery events marked, and a congestion-window plot.
- **Cryptography playground**: symmetric encryption byte-by-byte, DH key exchange as the paint-mixing analogy *and* the modular arithmetic, RSA sign/verify, hash avalanche demo (flip one bit, watch the digest scramble), certificate chain builder, full TLS 1.3 handshake walkthrough.
- **CSMA/CD & CSMA/CA simulator**: adjustable station count, watch collisions and backoff, plot throughput vs load.
- **Queueing sandbox**: adjust arrival rate and service rate, watch a queue build and drop, with latency histogram.
- **Encapsulation sandbox**: build a packet by hand, field by field, and watch validation.

### 9.10 Charts and telemetry

Per-interface throughput/errors/drops, per-device CPU/memory, end-to-end latency and jitter histograms, packet-loss over time, convergence times, and a flow table (top talkers) fed by the simulated NetFlow exporter. All charts share a synchronized cursor with the timeline scrubber.

### 9.11 Export

Every visualization exports as PNG, SVG (vector, for reports), or **animated MP4/GIF with a recorded scrub path** — so a student can submit "here is my OSPF converging" as evidence, and an instructor can build a lecture clip in thirty seconds.

---

## 10. Packet capture and analysis

A built-in analyser ("NetScope") modelled on Wireshark's mental model, because CyberOps students must transfer this skill to the real tool.

- **Capture points**: any interface, any device, or a virtual SPAN/RSPAN session; promiscuous mode on a hub or a tapped link.
- **Display filters** with Wireshark-compatible syntax (`ip.addr == 10.0.0.1 && tcp.flags.syn == 1`), full autocompletion, and a filter builder for beginners.
- **Three-pane layout**: packet list / decoded tree / hex+ASCII, with bidirectional highlight linking.
- **Follow stream** (TCP/UDP/HTTP) with reassembly.
- **Statistics**: protocol hierarchy, conversations, endpoints, IO graph, flow graph, expert info.
- **Import/export real pcap/pcapng** — students can open captures from real networks, and export NetForge captures into Wireshark. This is a major credibility feature and a small amount of work given §4.5.
- **Annotation & submission**: mark packets, add comments, export an annotated report for grading.

---

## 11. Cybersecurity subsystem

### 11.1 The Cyber Range

A range is a topology plus: a target set (deliberately vulnerable simulated hosts/services), an attacker workstation, defensive tooling, a scoring monitor, and a scenario script. Ranges support red-only, blue-only, purple (both sides visible), and instructor-vs-class modes.

### 11.2 Attack library (all simulated)

| Category | Attacks |
|---|---|
| **Reconnaissance** | Ping sweep, port scan (SYN/connect/UDP/FIN/Xmas), OS fingerprinting, banner grabbing, DNS zone transfer & enumeration, SNMP walk with default community, CDP/LLDP information leak, OSINT mock |
| **Layer 2** | MAC flooding → CAM overflow, ARP spoofing/poisoning → MITM, DHCP starvation, rogue DHCP server, VLAN hopping (switch spoofing & double tagging), STP root hijack, CDP flood, rogue AP / evil twin, deauthentication flood |
| **Layer 3/4** | IP/MAC spoofing, ICMP redirect abuse, smurf, SYN flood, fragmentation attacks, TCP session hijacking, RST injection |
| **Application** | DNS cache poisoning, DNS tunnelling, HTTP injection scenarios, credential stuffing against a mock login, password spraying, brute force with a visible rate/lockout interaction |
| **Malware** | Worm propagation across the topology (animated infection spread with per-host infection timing), ransomware scenario, botnet C2 beaconing with jittered intervals, data exfiltration over DNS/ICMP/HTTPS |
| **Denial of service** | Volumetric flood, amplification/reflection (DNS, NTP), resource exhaustion (CPU/memory/state table), distributed via a simulated botnet |
| **Wireless** | WPA handshake capture + offline-cracking *simulation*, PMKID scenario, karma/evil twin, jamming |

### 11.3 Defensive tooling

Zone-based and NGFW policy editors with a visual rule matrix and shadow-rule detection · IDS/IPS with a Snort-rule-compatible subset (write, load, test, tune rules against live traffic) · a SIEM with log ingestion from every device, a query language, saved searches, correlation rules, dashboards, and an alert queue with triage states · NetFlow analytics for anomaly detection · a honeypot device · a NAC/802.1X posture-check flow · endpoint protection mock with quarantine actions.

### 11.4 Attack visualization

Attacks are *only* worth simulating if they are legible. Each attack ships with a dedicated visualization:

- **ARP poisoning**: the victim's ARP cache is shown side by side with reality; the attacker's forged replies animate in; the traffic path visibly bends through the attacker, who is drawn reading the (now plaintext) payload. Enabling DAI mid-attack shows the forged replies being dropped at the switch, and the path snapping back.
- **CAM overflow**: the MAC table fills with a visible counter approaching capacity; on overflow the switch starts flooding, drawn as every frame duplicating to all ports; enabling port security caps the table and err-disables the attacking port.
- **VLAN hopping / double tagging**: the two tags drawn as nested envelopes, the outer one stripped at the trunk, the inner one delivering the frame into the victim VLAN.
- **DDoS**: link utilisation bars saturating, queue depth graphs pinning, legitimate packets (drawn in a distinct colour) being dropped in the noise — with a rate-limit control that visibly restores them.
- **Kill chain panel**: every attack action lands on a MITRE ATT&CK-mapped kill-chain board, building a timeline the student later uses to write the incident report.

### 11.5 Attack-path / risk graph

A computed graph of reachability and trust: nodes are assets, edges are "can reach on port X", with exploitable paths from untrusted zones to crown-jewel assets highlighted. Applying a firewall rule or segmenting a VLAN removes edges in real time — the clearest possible argument for defence in depth.

### 11.6 Safety boundary (non-negotiable)

- The simulation engine has **no network egress**. Simulated attack tools operate exclusively on in-memory simulated entities and cannot emit a packet onto the host's real network. This is enforced architecturally: the WASM sandbox is instantiated without any host networking import, and the desktop build has no raw-socket capability.
- Attack modules contain **no real exploit code, payloads, or shellcode**. An "exploit" is a scenario state transition keyed to a simulated vulnerability, not an artifact that could be lifted and reused.
- Password-cracking exercises operate on generated fixtures with known plaintexts and simulated timing; no real cracking engine ships.
- Every range opens with an ethics/scope gate on first use per course, and the reporting templates require legal-authorisation fields — the professional habit, taught as part of the workflow.
- Content moderation: user-authored ranges are sandboxed identically; the plugin SDK cannot request network capabilities.

---

## 12. Courseware and assessment engine

### 12.1 Lab types

| Type | Description |
|---|---|
| **Guided** | Step-by-step with inline checks; the next step unlocks on success |
| **Build** | "Construct this topology to spec" — graded on the finished state |
| **Troubleshoot** | Broken network + a fault the student must find and fix; graded on the fix, with the diagnostic path recorded |
| **Design** | Open-ended with requirements and constraints; rubric-graded, partially automatic |
| **Challenge/exam** | Timed, no hints, single submission |
| **Concept** | Uses a §9.9 visualizer with embedded questions, no topology |
| **Cyber range** | §11.1, with red/blue scoring |

### 12.2 Lab anatomy

```
Lab
├─ metadata     { title, course, objectives[], difficulty, est_minutes, tags }
├─ initial      { topology, configs, device_states, faults[] }
├─ instructions { markdown + embedded media + interactive hints (tiered) }
├─ tasks[]      { description, assertions[], points, dependencies[], hint_cost }
├─ scoring      { total, partial_credit_policy, time_bonus, attempt_penalty }
├─ solution     { reference_config, walkthrough_video, annotated_timeline }
└─ telemetry    { what to record for analytics }
```

### 12.3 Real-time feedback

The completion percentage updates live as the student works (togglable by the instructor for exams). Each task shows ✓ / ✗ / partial with a short explanation on hover. Tiered hints cost points and are logged, which converts hints from a loophole into a measured signal.

### 12.4 Assertion language

Assertions run against structured state, never scraped text. A YAML DSL covers the common cases and drops to a sandboxed JS expression for the rest:

```yaml
tasks:
  - id: vlan-trunk
    description: "Configure a trunk between SW1 and SW2 carrying VLANs 10, 20, 99"
    points: 10
    assertions:
      - config: { device: SW1, path: "interface.Gi0/1.switchport.mode", equals: trunk }
      - config: { device: SW1, path: "interface.Gi0/1.switchport.trunk.allowed_vlans",
                  set_equals: [10, 20, 99] }
      - state:  { device: SW1, table: stp, where: { vlan: 10, port: Gi0/1 },
                  field: role, equals: designated }
      - connectivity: { from: PC1, to: PC3, protocol: icmp, expect: success,
                        max_latency_ms: 50 }
      - negative: { description: "VLAN 30 must not traverse the trunk",
                    connectivity: { from: PC-A, to: PC-B, expect: fail } }
      - path: { from: PC1, to: SRV1, must_traverse: [SW1, R1], must_not_traverse: [R2] }
      - counters: { device: R1, interface: Gi0/0, field: acl_denies, greater_than: 0 }
      - timing: { event: ospf_full_adjacency, all_pairs: true, within_seconds: 60 }
```

Assertion categories: `config` (AST path), `state` (any table/daemon snapshot), `connectivity` (injects real test traffic in Turbo mode), `path` (traceroute-level route verification), `counters`, `timing`, `security` (e.g. "the attack no longer succeeds"), `negative` (must *not* work — catches "permit any any"), and `rubric` (manual, surfaced to the instructor).

Every assertion carries an optional `feedback_on_fail` string and a `misconception` tag used by analytics.

### 12.5 Grading pipeline

1. Student submits → `.netforge` file uploaded.
2. Job queued; headless native engine loads it in Turbo mode with the lab's seed.
3. Assertions evaluated; connectivity assertions run injected traffic.
4. Score + per-task feedback + a replayable trace returned.
5. Hard caps: 30 s CPU, 1 GB memory, no egress. Timeout = graded on static assertions only, flagged for review.

Because the grader is the same engine binary the student ran, "it worked on my machine" cannot happen (G4).

### 12.6 Authoring studio

Instructors build labs without code: construct the topology in the normal workspace, click **"Capture as initial state"**, then **"Capture as solution"** after solving it. The studio *diffs* the two states and **proposes assertions automatically** — the instructor accepts, edits, or deletes them, and assigns points. This is the difference between a lab taking 20 minutes to author and taking a day.

Also included: fault injection UI, instruction editor with live preview, objective tagging with coverage warnings, difficulty calibration from pilot-run data, versioning, and a lab marketplace with moderation.

### 12.7 Analytics

Per-student: time on task, command sequences, error frequency by command, hint usage, misconception tags, mastery estimate per objective (Bayesian knowledge tracing). Per-class: heat map of objectives by difficulty, commonly missed tasks, suggested reteach topics. Per-lab: discrimination index, completion rate, time distribution — so bad labs get identified and fixed.

### 12.8 Certification-exam practice mode

Timed, item-banked, weighted to published exam domains, with lockdown (no hints, no external visualizers, single attempt), a post-exam review that replays every decision, and a readiness score per domain.

---

## 13. Data model and file formats

### 13.1 `.netforge` container

A ZIP archive:

```
manifest.json        schema version, app version, checksum, created/modified
topology.json        devices, links, positions, physical layout
configs/             <device-id>.cfg  (rendered text, for human diffing)
configs-ast/         <device-id>.json (authoritative structured config)
state/               optional runtime snapshot for resuming mid-run
activity.json        lab definition (if this is a lab)
solution/            reference state (encrypted for student-facing copies)
assets/              images, floor plans, custom icons
captures/            embedded pcapng files
README.md
```

### 13.2 Topology schema (excerpt)

```json
{
  "schema": "netforge.topology/1.0",
  "devices": [{
    "id": "d_7f3a", "type": "router.nf2911", "name": "R1",
    "position": { "logical": [340, 180], "physical": { "rack": "r1", "u": 12 } },
    "modules": [{ "slot": 0, "type": "nim-2ge" }],
    "os": { "family": "nfos", "version": "15.7(3)M" },
    "power": true
  }],
  "links": [{
    "id": "l_02c1",
    "a": { "device": "d_7f3a", "port": "GigabitEthernet0/0" },
    "b": { "device": "d_91bb", "port": "GigabitEthernet1/0/1" },
    "media": "copper-straight", "length_m": 3,
    "impairments": { "loss_pct": 0, "latency_ms": 0, "jitter_ms": 0 }
  }],
  "seed": 20260913,
  "objectives": ["CCNA2.3.1"]
}
```

### 13.3 Interoperability

- **Import**: Packet Tracer `.pkt`/`.pka` (best-effort topology + config translation, with a fidelity report listing anything unmapped), GNS3 project topology, Cisco VIRL/CML YAML, plain config bundles, CSV device lists.
- **Export**: `.netforge`, config bundle, pcapng, SVG/PNG topology diagram, Visio-compatible VSDX, Markdown/PDF network documentation (auto-generated: topology diagram + addressing table + per-device config + interface inventory).
- **Auto-documentation** is a genuinely useful side benefit: students learn that documentation is an artifact of the design, not an afterthought.

---

## 14. APIs and extensibility

### 14.1 REST / GraphQL

`/api/v1/` — courses, labs, submissions, grades, users, classes, topologies. Full OpenAPI spec; GraphQL for analytics dashboards.

### 14.2 Simulation control API

An automation surface for research, CI, and advanced labs:

```
POST /sim/sessions                     create a headless session
POST /sim/{id}/topology                load a topology
POST /sim/{id}/devices/{dev}/cli       send CLI commands, get output
GET  /sim/{id}/devices/{dev}/state     structured state snapshot
POST /sim/{id}/run                     { until_event | duration | steps }
GET  /sim/{id}/capture                 stream pcapng
POST /sim/{id}/faults                  inject faults
GET  /sim/{id}/assertions/evaluate     run an assertion set
WS   /sim/{id}/events                  live event stream
```

This same API backs the **in-product Python sandbox**, so automation labs are not fake: a student's Python script really does drive the simulated devices (via NETCONF/RESTCONF/SSH mocks or this API), and the results really are the network's state.

### 14.3 Plugin SDK

Third parties can ship: device models (WASM modules implementing the `Device` trait), protocol daemons, visualization modules (React + a typed state selector), assertion types, and lab packs. Plugins are signed, capability-scoped (no network, no filesystem, memory-capped), and reviewed before appearing in the registry.

### 14.4 LMS integration

LTI 1.3 + Deep Linking + Assignment & Grade Services for Canvas/Moodle/Blackboard; SCORM packaging for legacy systems; roster sync; grade passback; SSO via OIDC/SAML.

---

## 15. Collaboration and classroom

- **Real-time co-editing** of a topology (Yjs CRDT): cursors, selections, per-user colour, presence list, and per-device edit locking to prevent two people fighting over one config.
- **Multi-user topologies**: each student owns one device in a shared network — the fastest way to teach that networking is a team sport, and to create genuinely social troubleshooting labs.
- **Instructor tools**: live grid view of every student's workspace, one-click join/take-over, broadcast a topology or a step to the class, spotlight a student's screen, freeze all workspaces for attention, and push a fault to everyone simultaneously.
- **Voice/screen**: out of scope; integrate with whatever the institution uses.
- **Async**: comment threads pinned to devices, links, or timeline moments; version history with named checkpoints.

---

## 16. Accessibility, internationalisation, platform

**Accessibility (WCAG 2.2 AA, targeting AAA for text):**
- Full keyboard operation including topology navigation (arrow-key traversal of the graph, `Enter` to inspect, keyboard cabling mode).
- Screen-reader support: every visualization has a textual equivalent — the topology is exposed as a navigable tree, tables are semantic, and animations have a "describe what just happened" live region. Packet animation announces as a structured sequence.
- No colour-only encoding anywhere (§8.5); a colourblind simulator built into the dev tools to test overlays.
- Text scaling to 200% without layout breakage; `prefers-reduced-motion` honoured throughout.
- Captions and transcripts on all instructional media.

**Internationalisation:** full UI translation (launch: EN, ES, FR, PT, AR, ZH, HI, DE, JA), RTL layout support, locale-aware numbers/dates. **CLI commands and protocol output stay in English** — that is the professional reality, and localising them would harm transfer. Help text, explanations, and lab instructions localise.

**Platform support:** Chrome/Edge 110+, Firefox 110+, Safari 16.4+ (WebGL2 minimum, WebGPU used when present). Tablet support with a touch-optimised layout (pinch zoom, long-press context menu, on-screen CLI keyboard with a command-fragment bar). Phone: view/review only, not authoring. Desktop app via Tauri for offline and lab-environment use.

---

## 17. Platform security and privacy

- OIDC auth, short-lived JWTs, refresh rotation, MFA for instructor/admin roles.
- Strict tenant isolation; row-level security in Postgres.
- All uploaded `.netforge` files are untrusted input: schema-validated, size-capped, and parsed in a sandboxed worker. Imported plugin WASM is capability-gated and never granted host access.
- Student data: FERPA/GDPR-aligned. Minimal collection, documented retention, export and deletion endpoints, clear separation between *learning analytics* (retained, pseudonymised) and *identifiable records* (access-controlled).
- Analytics are opt-out per institution; instructors see their own classes only.
- The cyber-range safety boundary of §11.6 is a security requirement, not just a product one, and is covered by dedicated tests in CI (a test asserts the WASM instance has zero networking imports).

---

## 18. Testing and validation

| Layer | Approach |
|---|---|
| **Protocol conformance** | A golden corpus of pcaps from real hardware; the engine must produce byte-equivalent PDUs for the same inputs. RFC-derived test vectors per protocol. |
| **Behavioural** | Scenario tests: "build this topology, run 60 s, assert convergence and table contents." Hundreds of these, one per curriculum objective. |
| **Determinism** | Every scenario runs 3× with the same seed; any byte difference fails the build. Also run cross-platform (x86/ARM, native/WASM) to catch float drift. |
| **CLI** | Property tests over the command grammar; a fuzzer that types random token sequences and asserts no panic and a sensible error. |
| **Visual** | Screenshot regression per visualizer across themes and colourblind palettes. |
| **Performance** | Benchmark topologies (50/200/500/2000 devices) with budget assertions from §4.12; fails CI on regression. |
| **Accessibility** | axe-core in CI, plus scripted screen-reader walkthroughs of core flows each release. |
| **Curriculum coverage** | The traceability job (§2.8) fails on objectives with no feature or no lab. |
| **Expert review** | Every protocol module signed off by a CCIE-level reviewer against real hardware behaviour before it leaves beta. This is the credibility gate; budget for it. |

---

## 19. Roadmap

| Phase | Duration | Scope | Exit criterion |
|---|---|---|---|
| **P0 — Foundation** | 4 mo | DES core, device/PDU/link model, Ethernet + IPv4 + ARP + ICMP, CLI framework, canvas, basic packet animation, save/load | Two PCs and a switch; ping works; you can watch the ARP |
| **P1 — CCNA 1** | 4 mo | Full L2 switching, TCP/UDP, DHCP/DNS/HTTP, IPv6 basics, subnetting workbench, encapsulation + provenance visualizers, simulation mode, packet analyser | Every CCNA 1 objective has a working lab |
| **P2 — CCNA 2** | 5 mo | VLANs/trunking/VTP, STP family, EtherChannel, inter-VLAN routing, static routing, NAT, wireless + WLC/RF, overlays for VLAN/STP, timeline & time travel | CCNA 2 complete; first classroom pilot |
| **P3 — CCNA 3 + platform** | 5 mo | OSPF/EIGRP, ACLs, WAN/PPP, QoS, management protocols, automation sandbox, assessment engine, authoring studio, LTI, collaboration | Full CCNA; instructors authoring their own labs |
| **P4 — Security track** | 5 mo | Cyber range, attack library + visualizations, firewalls/IPS/SIEM, VPN/IPsec, crypto playground, IR workflow, ATT&CK mapping | CyberOps Associate + Network Security complete |
| **P5 — CCNP** | 6 mo | BGP, redistribution, multicast, advanced OSPF/EIGRP, DMVPN, VRF, HA, VXLAN/SD-Access conceptual, ENARSI troubleshooting labs | CCNP Enterprise coverage |
| **P6 — Scale & ecosystem** | ongoing | Plugin SDK, marketplace, mobile, PT/GNS3 import, exam mode, analytics depth, i18n expansion | Third-party content shipping |

Roughly 29 months to full stated scope. Sequencing rationale: the visualization differentiators land in P1–P2 so the product is distinctive before it is complete, and the assessment engine lands in P3 so pilots can prove learning outcomes before the expensive P4/P5 content build.

---

## 20. Risks and open questions

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Scope.** This spec describes 3+ years of work. | Critical | Phase gates with real usage data; P1–P2 must stand alone as a product. Be willing to cut CCNP. |
| R2 | **Protocol fidelity debt.** Subtle behavioural differences from real IOS erode instructor trust fast. | High | The golden-pcap corpus (§18) and CCIE sign-off gate; publish an honest fidelity matrix. |
| R3 | **Browser performance ceiling** at 500+ devices with full visualization. | High | LOD strategy, WASM core, GPU-driven animation; benchmark gates in CI from P0. |
| R4 | **Cisco IP exposure** (§1.6). | High | Legal review before public beta; original strings, icons, and naming from day one — retrofitting this is far more expensive. |
| R5 | **Determinism breaking** under WASM/native float differences. | Medium | Integer time and fixed-point metrics; ban floats in any path that affects control-plane decisions. |
| R6 | **Content volume.** ~300 quality labs is its own project. | High | Authoring studio (§12.6) as a first-class product; community marketplace; seed with a paid author cohort. |
| R7 | **Security misuse perception.** An "attack platform" in schools draws scrutiny. | Medium | §11.6 boundary, documented and independently audited; ethics gating; clear marketing. |
| R8 | **Time-travel memory cost** in long sessions. | Medium | Delta snapshots + replay rather than full state retention; configurable history budget. |
| R9 | **Curriculum drift** as exam blueprints change. | Medium | Objective tags as data, not code; coverage report makes gaps visible within a day of a blueprint update. |

**Open questions for the product team:**

1. **Business model** — institutional site licence, freemium individual, or free-with-paid-content? This decides whether the marketplace is central or peripheral.
2. **Vendor neutrality** — Cisco-syntax-only, or a pluggable syntax layer (Juniper/Arista/FRR) later? Designing the command grammar as data (§7.2) keeps the door open cheaply; committing now would be premature.
3. **Real-device bridging** — should the sim be able to connect to a real interface or a container running FRR? Powerful, but it punches a hole through §11.6 and needs a very deliberate design.
4. **AI tutoring** — an assistant that watches the trace and explains *why* a ping failed is an obvious fit for this data model, but it needs its own spec and its own guardrails against doing the work for the student.
5. **Fidelity ceiling** — is CCIE-level a stated future goal or an explicit non-goal? Answer it publicly, either way.

---

## 21. Glossary

**AST** — abstract syntax tree; here, the structured form of a device configuration. **CAM table** — a switch's MAC address table. **CRDT** — conflict-free replicated data type, the basis of real-time co-editing. **DES** — discrete-event simulation. **FIB** — forwarding information base (data plane), derived from the RIB (control plane). **LOD** — level of detail. **PDU** — protocol data unit; a frame/packet/segment. **Provenance** — the recorded list of every mutation applied to a PDU. **Turbo mode** — headless maximum-speed simulation used for grading. **`.netforge`** — the project file format (§13.1).

---

*End of specification.*
