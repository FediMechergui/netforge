# NetForge device & media catalog (P0.5, updated through P3a)

The shipped catalog is built at stage P3 (`CATALOG_STAGE`), and `LATEST_DEFAULTS_PROFILE` is `'P3'` since the CCNA 3
course flip: File → New and every CCNA 3 lab open a P3 world, CCNA 1 lessons and templates a P1 world and CCNA 2
lessons a P2 world; a file saved before P3a keeps its profile (P1 or P2) until "Use current defaults" upgrades it. A P3
daemon does nothing in a P1 or P2 world until a line configures it (the silence rule); what a P3 world adds by default
is listed under "P3 per model" below.

All model names, descriptions, icons and strings are original (spec §1.6). Model ids follow
`<category>.<model>`; display names follow `NF-<class>`. The "comparable class" column is a
generic description so learners can translate to real equipment — never a vendor product name.

Port naming follows the conventional long/short scheme already used in P0
(`GigabitEthernet0/1` / `Gi0/1`). New families: `TenGigabitEthernet` (`Te`),
`FortyGigabitEthernet` (`Fo`), `Ethernet` (`Et`, 10 Mb legacy), `Serial` (`Se`),
`Console` (`Con`), `Aux`, `Coax` (`Cx`), `Phone` (`Ph`, RJ11 DSL line), `Fiber` (`Fb`, PON/ONT),
`Usb` (`Usb`), `Wlan` (`Wl`, a Wi-Fi radio), `Radio` (`Rd`, point-to-point radio), `Cellular` (`Ce`).

## Capabilities (drive behaviour, CLI scoping, inspector tabs and palette grouping)

The "Daemons" column lists what each capability contributes by build stage (`CAPABILITY_PROCESSES`); a model runs the
union over its expanded capabilities, in `PROCESS_ORDER`. Items in brackets name the approved P3a items ([S13] remote
terminal, [S18] GRE, [S19] PPP, [S24]/[S25] logging and syslog, [S32] scripting, [C1] EIGRP, [C13] site-to-site
IPsec); the rest of each P3 list is the MUST plan.

| Capability | Meaning | Daemons |
|---|---|---|
| `host` | End-system IP stack, host shell, desktop GUI | arp, ipv4, icmpv4, host; P1: ipv6, nd, icmpv6, udp, tcp, dhcp-client, dns-client, http-client, traceroute; P2: dhcpv6-client; P3: vty-client [S13] (the `telnet` and `ssh -l` client), traffic (the traffic generator, its `flows` table and the Traffic desktop app) |
| `server` | `host` + service daemons | host daemons; P1: dhcp-server, dns-server, http-server; P3: ntp (the NTP server role), syslog-server [S25] (the syslog viewer in Services) |
| `switching` | Transparent bridging on switch ports | eth-switch; P1: arp, ipv4, icmpv4, host (the management address) |
| `routing` | Forwards IPv4 between routed interfaces, router CLI | hdlc, arp, ipv4, icmpv4; P1: ipv6, nd, icmpv6, udp, tcp, dhcp-client, dhcp-server, dns-client, dns-server, http-server, traceroute; P2: nat, dhcpv6-client, dhcpv6-server, hsrp; P3: ppp [S19], cdp, lldp, acl, gre [S18] (the tunnel owner, also of [C13]'s IPsec mode), vty and vty-client [S13], logger [S24], ntp, ospf, eigrp [C1], ike [C13], restconf |
| `layer3-switch` | `switching` on switchports + `routing` on routed ports / SVIs | eth-switch + routing daemons (implies both) |
| `managed-switch` | VLAN-aware bridge with VLAN database, DTP, spanning tree, EtherChannel, port security (P2) | switching daemons; P2: vlan, dtp, etherchannel, stp; P3: cdp, lldp, acl, udp and tcp (dormant until a P3 service line is configured on the switch, D22), vty and vty-client [S13], logger [S24], ntp, restconf; the snooping tables `dhcp-snooping` and `arp-inspection` |
| `lightweight-ap` | Access point managed by a controller over CAPWAP (P2) | wifi-ap daemons; P2: capwap-wtp, udp, dhcp-client; no P3 daemon (it bridges CDP and never runs it) |
| `wireless-controller` | Controller appliance: CAPWAP controller and VLAN-aware bridge, no spanning tree (P2) | switching daemons; P2: vlan, udp, capwap-ac; P3: cdp, logger [S24], ntp |
| `repeater` | Physical-layer repeat to all other ports, shared collision domain | — (the link layer's collision domain repeats the bits; no daemon) |
| `wifi-ap` | Owns BSSs on its Wlan radios, bridges wired ↔ wireless | wlan-ap, eth-switch (the wired ↔ wireless bridge), arp, ipv4, icmpv4, host (the management address); all P0.5 |
| `wifi-client` | Can associate a Wlan radio to an SSID | wlan-client |
| `radio-bridge` | Point-to-point radio link between two peers | eth-switch (P0.5) |
| `cellular-cell` | Serves Cellular clients within range, backhaul on Ethernet | eth-switch (P0.5) |
| `cellular-client` | Attaches a Cellular radio to a cell | cell-client |
| `modem` | Bridges an access line (phone/coax/fibre/serial) to Ethernet | eth-switch (P0.5) |
| `cloud` | Internet/ISP abstraction (transparent bridge or provider mode) | eth-switch (P0.5) |
| `firewall` | Routing appliance (zone policies arrive in P4) | routing daemons |
| `nat-gateway` | Home router WAN/LAN translation (implies `routing`) | P2: nat (silent until the home-router panel writes its lines) |
| `dhcp-server` | Hands out addresses on its LAN (home routers, servers; P1) | P1: udp, dhcp-server |
| `poe-source` / `poe-powered` | PoE budget and powered devices (behaviour P2+) | — |
| `modular` | Has slots; modules add ports; hot-swap requires power off | — |
| `programmable` | `host` + the NF-Py script host and the automation workspace; scripts live in the host's `files:` store (P3, [S32]) | host daemons; P3: script-host (its `script-runs` table and the Automation desktop app) |

## Network devices

| Id | Name | Category | Comparable class | Ports | Capabilities |
|---|---|---|---|---|---|
| router.nf1941 | NF-1941 | Routers | Small branch router, modular | Gi0/0–0/1, 2 × EHWIC slots, Console, Aux | routing, modular |
| router.nf2911 | NF-2911 | Routers | Branch router (P0) | Gi0/0–0/1, Se0/0/0–0/0/1, Console | routing |
| router.nf4331 | NF-4331 | Routers | Mid-size services router | Gi0/0/0–0/0/2 (0/0/2 SFP), 2 × NIM slots, Console, Aux | routing, modular |
| router.nf4451 | NF-4451 | Routers | Enterprise edge router | Gi0/0/0–0/0/3, Te0/1/0–0/1/1 (SFP+), 3 × NIM slots, Console | routing, modular |
| router.nfgeneric | NF-RTR-EMPTY | Routers | Teaching chassis, all slots empty | Console, 8 × generic slots | routing, modular |
| switch.nfc2960-8 | NF-C2960-8TC | Switches | Compact 8-port access switch | Fa0/1–0/8, Gi0/1 (combo) | switching, managed-switch |
| switch.nfc2960 | NF-C2960 | Switches | 24-port access switch (P0) | Fa0/1–0/24, Gi0/1–0/2 | switching, managed-switch |
| switch.nfc2960-48 | NF-C2960-48TT | Switches | 48-port access switch | Fa0/1–0/48, Gi0/1–0/2 | switching, managed-switch |
| switch.nfc2960-24pg | NF-C2960-24PG | Switches | 24-port gigabit PoE+ switch | Gi0/1–0/24 (PoE+), Gi0/25–0/28 (SFP) | switching, poe-source, managed-switch |
| switch.nfc9200-48 | NF-C9200-48P | Switches | 48-port gigabit PoE access switch with 10G uplinks | Gi1/0/1–1/0/48 (PoE+), Te1/1/1–1/1/4 | switching, poe-source, managed-switch |
| mlswitch.nfc3650-24 | NF-C3650-24 | Multilayer switches | 24-port L3 switch | Gi1/0/1–1/0/24, Gi1/1/1–1/1/4 (SFP) | layer3-switch, managed-switch |
| mlswitch.nfc9300-48 | NF-C9300-48U | Multilayer switches | 48-port L3 switch, 10G uplinks | Gi1/0/1–1/0/48, Te1/1/1–1/1/8 | layer3-switch, poe-source, managed-switch |
| dcswitch.nfn9k-48 | NF-N9K-48X | Data centre | Top-of-rack leaf | Et1/1–1/48 (10G), Fo1/49–1/54 (40G) | layer3-switch, managed-switch |
| dcswitch.nfn9k-32 | NF-N9K-32F | Data centre | Spine | Fo1/1–1/32 (40G) | layer3-switch, managed-switch |
| hub.nfhub4 | NF-HUB-4 | Legacy | 4-port 10 Mb hub | Et0–Et3 | repeater |
| hub.nfhub8 | NF-HUB-8 | Legacy | 8-port 10 Mb hub | Et0–Et7 | repeater |
| hub.nfcoax | NF-COAX-TAP | Legacy | Thin-coax multiport transceiver | Cx0–Cx3 | repeater |
| repeater.nfrep | NF-REPEATER | Legacy | 2-port signal repeater | Et0–Et1 | repeater |
| bridge.nfbr2 | NF-BRIDGE-2 | Legacy | 2-port learning bridge | Et0–Et1 | switching |
| bridge.nfbr4 | NF-BRIDGE-4 | Legacy | 4-port learning bridge | Et0–Et3 | switching |
| wlc.nfwlc3504 | NF-WLC-3504 | Legacy | Earlier wireless LAN controller kept for older projects: an end system that manages no access points (the NF-WLC-9800 does) | Gi0/1–0/4, Console | host |
| firewall.nfasa5506 | NF-FW-5506 | Security | Small stateful firewall appliance | Gi1/1–1/8, Console | firewall, routing |
| firewall.nfngfw1120 | NF-NGFW-1120 | Security | Next-generation firewall | Gi1/1–1/8, Gi1/9–1/12 (SFP), Console | firewall, routing |
| ids.nfsensor | NF-IDS-SENSOR | Security | Network IDS sensor | Gi0/0 (mgmt), Gi0/1–0/2 (monitor) | host |
| ap.nfap-auto | NF-AP-2600 | Wireless | Autonomous dual-band access point | Gi0 (PoE-powered), Wl0 (2.4 GHz), Wl1 (5 GHz) | wifi-ap, poe-powered |
| ap.nfap-lw | NF-AP-1832 | Wireless | Lightweight AP: joins an NF-WLC-9800 over CAPWAP (P2 worlds boot with `capwap enable` and a DHCP address on Vlan1; P1 worlds keep it autonomous) | Gi0, Wl0, Wl1 | wifi-ap, poe-powered, lightweight-ap |
| ap.nfap-mesh | NF-AP-1562 | Wireless | Outdoor mesh AP | Gi0, Wl0, Wl1 | wifi-ap |
| ap.nfap-ax | NF-AP-9120 | Wireless | Wi-Fi 6/6E AP | Gi0, Wl0 (2.4), Wl1 (5), Wl2 (6 GHz) | wifi-ap, poe-powered |
| wlc.nfwlc9800 | NF-WLC-9800 | Wireless | Wireless LAN controller (P2): lightweight APs join it over CAPWAP; controller interfaces and WLANs from its Controller panel; switches client traffic into VLANs through Capwap0 | Gi0/1–0/4 (intrinsic trunks), Console, Capwap0 (auto) | switching, wireless-controller |
| wrouter.nfhome | NF-HOMEROUTER | Home & SOHO | Home wireless router | Internet (WAN), Gi1–Gi4 (LAN), Wl0 (2.4), Wl1 (5) | wifi-ap, switching, routing, dhcp-server, nat-gateway |
| wrouter.nfhome-ax | NF-HOMEROUTER-AX | Home & SOHO | Wi-Fi 6 home router | Internet, Gi1–Gi4, Wl0, Wl1, Wl2 | same |
| radio.nfptp5 | NF-RADIO-PTP5 | Radios | 5 GHz outdoor point-to-point bridge (≤ 15 km) | Gi0, Rd0 | radio-bridge |
| radio.nfptp60 | NF-RADIO-PTP60 | Radios | 60 GHz short-range high-capacity bridge (≤ 1 km) | Gi0, Rd0 | radio-bridge |
| cell.nftower | NF-CELL-TOWER | Radios | Cellular base station (LTE/5G) | Gi0 (backhaul), Ce0 | cellular-cell |
| modem.nfdsl | NF-DSL-MODEM | WAN & ISP | DSL modem | Gi0 (LAN), Ph0 (phone line) | modem |
| modem.nfcable | NF-CABLE-MODEM | WAN & ISP | Cable modem | Gi0 (LAN), Cx0 (coax) | modem |
| modem.nfont | NF-FIBER-ONT | WAN & ISP | Fibre optical network terminal | Gi0 (LAN), Fb0 (PON) | modem |
| csu.nfcsu | NF-CSU-DSU | WAN & ISP | Serial line unit | Se0 (DTE side), Se1 (line) | modem |
| cloud.nfinternet | NF-INTERNET | WAN & ISP | Internet / ISP cloud | Gi0–Gi7, Ph0–Ph3, Cx0–Cx3, Fb0–Fb3, Se0–Se3 | cloud |

## End devices

| Id | Name | Category | Ports | Capabilities |
|---|---|---|---|---|
| pc.nfpc | NF-PC | Computers | Gi0 | host |
| pc.nfpc-wifi | NF-PC-WIFI | Computers | Gi0, Wl0 | host, wifi-client |
| laptop.nflaptop | NF-LAPTOP | Computers | Gi0, Wl0, Usb0 (USB-A, console terminal) | host, wifi-client |
| pc.nfdevhost | NF-DEVHOST | Computers | Gi0 | host, programmable |
| server.nfserver | NF-SERVER | Servers | Gi0, Gi1 | server |
| server.nfrack | NF-SERVER-RACK | Servers | Gi0–Gi3, Te0–Te1 | server |
| phone.nfsmartphone | NF-SMARTPHONE | Mobile | Wl0, Ce0 | host, wifi-client, cellular-client |
| tablet.nftablet | NF-TABLET | Mobile | Wl0 | host, wifi-client |
| tablet.nftablet-lte | NF-TABLET-LTE | Mobile | Wl0, Ce0 | host, wifi-client, cellular-client |
| ipphone.nfphone | NF-IPPHONE | Voice | Fa0 (network, PoE-powered), Fa1 (PC pass-through) | host, switching, poe-powered |
| printer.nfprinter | NF-PRINTER | Peripherals | Fa0, Wl0 | host, wifi-client |
| tv.nfsmarttv | NF-SMART-TV | Home & SOHO | Fa0, Wl0 | host, wifi-client |
| iot.nfsensor | NF-IOT-SENSOR | IoT | Wl0 | host, wifi-client |
| iot.nfcamera | NF-IP-CAMERA | IoT | Fa0 (PoE-powered) | host, poe-powered |
| iot.nfthermostat | NF-THERMOSTAT | IoT | Wl0 | host, wifi-client |
| iot.nfplug | NF-SMART-PLUG | IoT | Wl0 | host, wifi-client |
| iot.nfgateway | NF-IOT-GATEWAY | IoT | Gi0, Wl0 | host, wifi-client |

NF-DEVHOST (P3, the second catalog flip) is the developer workstation of the automation lessons: a host with one
gigabit adapter whose `programmable` capability adds the NF-Py script host (`python <file>`, `type`, `del`, `dir` in
its shell; the `script-runs` table) and the Automation desktop app. Its scripts are kept in the host's `files:` store,
which is saved with the topology. It runs no TFTP. Like every model listed here (NF-WLC-9800 included), it is in the
model inputs of every build stage; `programmable` brings the script host and the Automation app from P3 only, so a
catalog derived at an earlier stage (the P1 and P2 test catalogs) lists NF-DEVHOST as a plain host, with the daemons,
tables and desktop apps NF-PC has at that stage. Its shell offers `python`, `python3`, `type`, `del` and `dir` only
where the script host runs, so such a host lists none of them, like NF-PC (the commands are scoped by
`CommandSpec.requiresAnyProcess`, ruling R60). The store holds at most 256 files, each with a name of at most 255
characters and at most 1 048 576 characters of text (the schema 1.3 bounds, ruling R20).

## P3 per model (stage P3; what a P3 world adds)

Every model below derives these daemons, tables and families at stage P3 (the shipped catalog). In a P1 or P2 world
they stay silent until configured; a P3 world adds exactly the defaults of the "P3 defaults" column (D2): CDP on, the
two visible `service timestamps debug|log datetime msec` lines ([S24]) and extended logging ([S25]).

| Models | P3 defaults (P3 world) | Tunnel interfaces | P3 daemons | P3 tables |
|---|---|---|---|---|
| Routers: router.nf1941, router.nf2911, router.nf4331, router.nf4451, router.nfgeneric; firewalls: firewall.nfasa5506, firewall.nfngfw1120 (they run the router OS) | CDP on (`cdpDefault`); the two `service timestamps` lines | `interface Tunnel<n>` ([S18], [C13]) | ppp, cdp, lldp, acl, gre, vty, vty-client, logger, ntp, ospf, eigrp, ike, restconf | ppp, cdp-neighbours, lldp-neighbours, acl, tunnels, vty-logins, ntp-peers, clock, ospf-interfaces, ospf-neighbors, ospf-lsdb, eigrp-neighbors, eigrp-topology, ipsec-sa, restconf-log |
| Multilayer and data-centre switches: mlswitch.nfc3650-24, mlswitch.nfc9300-48, dcswitch.nfn9k-48, dcswitch.nfn9k-32 | as routers | `interface Tunnel<n>` | as routers | as routers, plus dhcp-snooping and arp-inspection |
| Managed access switches: switch.nfc2960-8, switch.nfc2960, switch.nfc2960-48, switch.nfc2960-24pg, switch.nfc9200-48 | CDP on; the two `service timestamps` lines | — | cdp, lldp, acl, udp, tcp, vty, vty-client, logger, ntp, restconf (udp and tcp stay dormant, answering "protocol unreachable" as in P2, until `ntp server`, `ntp master`, `restconf` with `ip http secure-server`, `logging host`, a `transport input` line other than `none` under `line vty` or `crypto key generate rsa` is configured, or the switch's own CLI opens a `telnet`/`ssh` session; D22, R17, R27) | dhcp-snooping, arp-inspection, cdp-neighbours, lldp-neighbours, acl, sockets, vty-logins, ntp-peers, clock, restconf-log |
| Wireless controller: wlc.nfwlc9800 | CDP on; the two `service timestamps` lines | — | cdp, logger, ntp | cdp-neighbours, ntp-peers, clock |
| Home routers: wrouter.nfhome, wrouter.nfhome-ax | none (`nat-gateway`, no CLI) | — | the routing rows above, all silent: the home-router panel writes none of their lines | as routers |
| Servers: server.nfserver, server.nfrack | none | — | vty-client, ntp, syslog-server, traffic | ntp-peers, clock, syslog-messages, flows |
| NF-DEVHOST: pc.nfdevhost | none | — | vty-client, traffic, script-host | flows, script-runs |
| Every other host (computers, mobiles, IP phone, printer, smart TV, IoT, NF-IDS-SENSOR, NF-WLC-3504) | none | — | vty-client, traffic | flows |
| Hubs, repeater, bridges, access points (the lightweight AP included), radios, cell tower, modems, CSU/DSU, Internet cloud | none | — | none | none |

Desktop apps: every host gains the Traffic generator (`desktop.traffic`), and NF-DEVHOST the Automation workspace
(`desktop.automation`). Network devices boot with an unset clock (`*` in `show clock`) and hosts and servers with true
time (D19). `show controllers` is listed by `?` on the routing models and the Internet cloud, whose serial ports carry
the router serial grammar; every other network-OS model accepts it unlisted (rulings R58 (d), R59 (b)). PPP ([S19]) runs
on direct serial cables only: NF-CSU-DSU and the Internet cloud's serial access lines stay HDLC (D17).

## Modules (slots on `modular` routers)

| Id | Name | Adds | Fits |
|---|---|---|---|
| mod.ehwic-2t | NF-EHWIC-2T | 2 × serial (Se0/<slot>/0–1) | EHWIC |
| mod.ehwic-4esg | NF-EHWIC-4ESG | 4 × gigabit switchports | EHWIC |
| mod.nim-2t | NF-NIM-2T | 2 × serial | NIM |
| mod.nim-es2-4 | NF-NIM-ES2-4 | 4 × gigabit switchports | NIM |
| mod.nim-2ge | NF-NIM-2GE | 2 × gigabit routed ports | NIM |
| mod.sfp-1g-sx | NF-SFP-1G-SX | fibre MM transceiver for an SFP cage | SFP |
| mod.sfp-1g-lx | NF-SFP-1G-LX | fibre SM transceiver | SFP |
| mod.sfp-10g-sr | NF-SFP-10G-SR | 10G fibre MM transceiver | SFP+ |
| mod.wlan-card | NF-WLAN-CARD | Wl0 radio | host expansion |

## Media (cables) and wireless

| Media | Connects | Max length | Notes |
|---|---|---|---|
| copper-straight | ethernet ↔ ethernet (MDI ↔ MDI-X) | 100 m | auto-MDIX ports accept either copper cable |
| copper-crossover | MDI ↔ MDI or MDI-X ↔ MDI-X | 100 m | |
| console | console/aux ↔ ethernet (host terminal) | 15 m | rollover; out-of-band CLI only; exactly one device console line per cable |
| usb-console | usb (host terminal) ↔ console | 5 m | USB plug on the computer; mini-USB, USB-C or RJ-45 console socket on the device |
| serial-dce / serial-dte | serial ↔ serial | 15 m | the end plugged with the DCE connector must set `clock rate` |
| fiber-mm | ethernet (SFP) ↔ ethernet (SFP) | 550 m (1G), 300 m (10G) | LC connectors |
| fiber-sm | ethernet (SFP) ↔ ethernet (SFP) | 10 km | |
| fiber-pon | fibre (ONT) ↔ fibre (cloud) | 20 km | |
| coax | coax ↔ coax | 185 m (10BASE2 segment) / 500 m (cable plant) | shared medium when several taps share it |
| phone | phone ↔ phone | 5 km (DSL loop) | |
| auto | picks the correct one | — | toggle off for cable-type lessons |
| wifi (association) | wlan ↔ wlan (AP) | from RF model | not a cable; created by SSID + security + RSSI |
| radio (PtP) | radio ↔ radio | model range | not a cable; created by pairing two radio bridges on the same channel/key |
| cellular (attach) | cellular ↔ cell tower | tower range | not a cable |

## Fidelity table (deliberate deviations)

Behaviour that exam questions test is exact. Each row below is a deliberate difference from real equipment, recorded by
the stage brief that built the feature (ARCHITECTURE-P2 §12.2 R2, ARCHITECTURE-P3 §12.2 R2 and the wave rulings it
cites). "Lesson" names the lesson that says so where a learner could notice it.

### P2 (CCNA 2)

| # | Deviation | Lesson |
|---|---|---|
| P2-1 | `dynamic auto` never initiates DTP. | — |
| P2-2 | DTP, VTP and PAgP use original NF formats. | — |
| P2-3 | Per-VLAN spanning tree sends IEEE-format BPDUs plus an NF TLV on trunks instead of the vendor format. | — |
| P2-4 | No automatic edge detection. | — |
| P2-5 | Spanning tree ages information at hello granularity. | — |
| P2-6 | EtherChannel load balancing folds the five varying MAC octets (or the IPv4 octets) modulo the member count instead of 8 buckets. | — |
| P2-7 | The voice VLAN is set on the IP phone by hand (no discovery-protocol voice VLAN; [S35] is P3c). | — |
| P2-8 | Access ports only answer DTP; they never advertise on a timer. | — |
| P2-9 | One WLAN per radio. | — |
| P2-10 | The controller clamps the TCP MSS instead of fragmenting. | — |
| P2-11 | A per-VLAN spanning-tree instance cap of 128. | — |
| P2-12 | No "suspend individual" platform option: LACP members without a partner always run individual. | — |
| P2-13 | The extended system id cannot be switched off. | — |
| P2-14 | Association and the 4-way handshake are answered by the AP and reported to the controller (local MAC), not answered by the controller (split MAC). | CCNA 2 lesson 25 |
| P2-15 | The controller bridges client DHCP instead of proxying it to the interface's DHCP server. | — |
| P2-16 | The CAPWAP DTLS session is a simulated state; protected control messages are still shown decoded. | CCNA 2 lesson 25 |

### P3a (CCNA 3)

Numbers 1-28 are ARCHITECTURE-P3 §12.2 R2's own; the bracketed rows belong to the approved items; rows marked W were
recorded by the waves' rulings. Lesson numbers are CCNA 3 lessons.

| # | Deviation | Lesson |
|---|---|---|
| 1 | OSPF sends one extra hello 1 s after a new neighbour is heard (D9; real routers may wait up to one hello interval). | 02, 07 |
| 2 | OSPF acknowledges directly and at once (no delayed acknowledgements). | — |
| 3 | One OSPF process per device (a second `router ospf` is refused). | — |
| 4 | Full SPF only, no LSA group pacing. | — |
| 5 | The database-description sequence number is deterministic. | — |
| 6 | A serial port's routing bandwidth is 1544 kb/s while `show interfaces` shows the clock rate. | 05, 34 |
| 7 | At equal administrative distance across protocols the lower metric wins (real routers keep the first installed). | — |
| 8 | NAT's use of an access list is not counted in `show access-lists`. | 18 |
| 9 | DHCP snooping never inserts option 82 (`no ip dhcp snooping information option` is stored only). | 20 |
| 10 | DAI requires the binding's port to match the ARP's port. | 20 |
| 11 | The RSA key is a configuration line: replaying `crypto key generate rsa` regenerates it, `crypto key zeroize rsa` removes it. | 19 |
| 12 | ACL log aggregation is fixed at 5 minutes. | 17 |
| 13 | The existing administrative-down log keeps severity 3 in every profile (existing messages never change, D4). | 29 |
| 14 | No default WFQ on slow serial lines: FIFO with the 256-frame cap ([C20] is P3c). | 26 |
| 15 | The traffic generator's receiver is a discard sink on UDP 9. | 27 |
| 16 | TLS is a simulated state with no handshake bytes; its segments show a "Protected (TLS, simulated)" banner. | 38, 40 |
| 17 | CDP uses an original NF format (the name only is kept), and its rows are removed at link-down. | 28 |
| 18 | No hardware calendar: network devices boot unset and reset at reload (hosts and servers boot with true time). | 29 |
| 19 | NTP steps the clock on the first valid reply (real clients filter several polls and slew). | 29 |
| 20 | RESTCONF serves a curated model (IETF modules and `nf-native`) with no candidate datastore. | 38 |
| 21 | The queueing sandbox schedules WFQ as flow DRR. | 26 |
| 22 | OSPF sends an extra hello at once when an interface's DR or BDR changes. | 03 |
| 23 | No ICMP for an outbound ACL deny of a packet NAT has already translated (its source is now the router's own address). | 18 |
| 24 | CDP and LLDP run on Ethernet ports only (real CDP also runs on serial HDLC links). | 28 |
| 25 | A managed switch's UDP and TCP stay dormant ("protocol unreachable") until a P3 service line is configured on it (D22). | 19 |
| 26 | An unsynchronised NTP client re-polls on a fixed 1-32 s schedule. | 29 |
| 27 | PAT keeps a host's ICMP echo id, so while a PAT row is alive the router's own ping to the same server collides with it (P2 behaviour kept: a fix would move P2 digests; R47). | — |
| 28 | A console-opened `vty` session takes the login rule of the first `line vty` section only (R56). | 19 |
| [S13] | `access-class` refuses a login with a TCP reset after the handshake; SSH cryptography is simulated (clear version strings, then a payload XORed with a per-packet FNV-1a keystream over the segment's endpoints, decoded under a banner; R38); a managed switch answers vty only after a P3 line (`transport input`, an RSA key) wakes its transport. | 13, 15, 19 |
| [S13] W | No remote interrupt: Ctrl+C ends a remote session (R38). `exec-timeout` is stored and shown but never closes a session, and there is no login lockout ([C11] is P4). | 19 |
| [S18] | No GRE keepalives (`keepalive` and `tunnel key` on a tunnel are [C17], P3c) and no fragmentation: a packet larger than the tunnel MTU (1476, or a smaller `ip mtu`) drops `mtu-exceeded`, with ICMP 3/4 when DF is set (D15). | 24 |
| [S19] | PPP runs on direct serial cables only (NF-CSU-DSU and the Internet cloud stay HDLC); magic numbers and challenges are deterministic; a failed authentication retries every 10 s; no CDPCP or link-quality monitoring. | 22 |
| [S19] W | A PAP peer and a CHAP peer resend every 2 s, at most 10 times, then fail (R37, R43). | — |
| [S20]/[S21] | CBWFQ is scheduled by DRR; the LLQ policer's burst is 200 ms; queueing policies attach to physical ports only; switch QoS queues and trust (`mls qos`) are not modelled. | 27 |
| [S20] W | Control traffic (HDLC keepalives, PPP control frames, CDP, LLDP, BPDUs) bypasses the class queues and is never classified or counted by a policy (R33); in a P3 world a serial control frame is committed ahead of queued data on a FIFO port, while P1 and P2 worlds keep the plain FIFO, where a saturating load can starve the keepalives (R43). | — |
| [S32] | NF-Py is a teaching subset of Python 3: whole numbers below 2⁵³, no classes and no `with`, the modules `json`, `requests`, `time`, `sys` and `math` only; the host's `files:` store holds at most 256 files (R20). | 40 |
| W | RESTCONF bodies are JSON only and every answer is JSON whatever `Accept` asks for; query parameters are ignored; every refused login answers 401, a user without privilege 15 included. | 38 |
| W | The data-formats playground reads YAML 1.2 (`yes` and `no` are strings) and only a subset of it: anchors, aliases, tags and several documents in one text are refused. | 37 |
| [C1] | EIGRP answers a new neighbour's hello at once; update, query and reply packets are unicast to each neighbour (hellos multicast); load and reliability are the constants 1 and 255; no automatic summarisation (`auto-summary` refused). A DHCP-learned default keeps the P1 display `D*` [254/0] while EIGRP routes also show `D`: the distance and the legend sentence tell them apart (D11). | 10 |
| [C13] | IPsec cryptography is simulated (real headers, the payload shown decoded under an "Encrypted (ESP, simulated)" banner, FNV-1a proofs and ICVs; the key is in no byte); one fixed proposal; no rekey, lifetime or dead-peer detection; sequence numbers are shown but not checked against a replay window; crossing initiations are resolved by the lower tunnel source address, whose end resends its request at once after a retransmission (R54); VTI only (crypto maps, IKEv1 and remote-access VPN are P4). | 23, 25 |
