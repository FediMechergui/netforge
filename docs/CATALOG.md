# NetForge device & media catalog (P0.5)

All model names, descriptions, icons and strings are original (spec §1.6). Model ids follow
`<category>.<model>`; display names follow `NF-<class>`. The "comparable class" column is a
generic description so learners can translate to real equipment — never a vendor product name.

Port naming follows the conventional long/short scheme already used in P0
(`GigabitEthernet0/1` / `Gi0/1`). New families: `TenGigabitEthernet` (`Te`),
`FortyGigabitEthernet` (`Fo`), `Ethernet` (`Et`, 10 Mb legacy), `Serial` (`Se`),
`Console` (`Con`), `Aux`, `Coax` (`Cx`), `Phone` (`Ph`, RJ11 DSL line), `Fiber` (`Fb`, PON/ONT),
`Usb` (`Usb`), `Wlan` (`Wl`, a Wi-Fi radio), `Radio` (`Rd`, point-to-point radio), `Cellular` (`Ce`).

## Capabilities (drive behaviour, CLI scoping, inspector tabs and palette grouping)

| Capability | Meaning | Daemons |
|---|---|---|
| `host` | End-system IP stack, host shell, desktop GUI | arp, ipv4, icmpv4, host (+ P1: udp, tcp, dhcp-client, dns-client, http-client, ipv6…) |
| `server` | `host` + service daemons (P1: dhcp-server, dns-server, http-server) | host daemons + services |
| `switching` | Transparent bridging on switch ports | eth-switch |
| `routing` | Forwards IPv4 between routed interfaces, router CLI | arp, ipv4, icmpv4 |
| `layer3-switch` | `switching` on switchports + `routing` on routed ports / SVIs | eth-switch + routing daemons |
| `repeater` | Physical-layer repeat to all other ports, shared collision domain | hub |
| `wifi-ap` | Owns BSSs on its Wlan radios, bridges wired ↔ wireless | wlan-ap (+ eth-switch for the bridge) |
| `wifi-client` | Can associate a Wlan radio to an SSID | wlan-client |
| `radio-bridge` | Point-to-point radio link between two peers | radio |
| `cellular-cell` | Serves Cellular clients within range, backhaul on Ethernet | cell |
| `cellular-client` | Attaches a Cellular radio to a cell | cell-client |
| `modem` | Bridges an access line (phone/coax/fibre/serial) to Ethernet | modem |
| `cloud` | Internet/ISP abstraction (transparent bridge or provider mode) | cloud |
| `firewall` | Routing appliance (zone policies arrive in P4) | routing daemons |
| `nat-gateway` | Home router WAN/LAN translation (NAT arrives in P2; model is ready) | — |
| `dhcp-server` | Hands out addresses on its LAN (home routers, servers; P1) | dhcp-server |
| `poe-source` / `poe-powered` | PoE budget and powered devices (behaviour P2+) | — |
| `modular` | Has slots; modules add ports; hot-swap requires power off | — |

## Network devices

| Id | Name | Category | Comparable class | Ports | Capabilities |
|---|---|---|---|---|---|
| router.nf1941 | NF-1941 | Routers | Small branch router, modular | Gi0/0–0/1, 2 × EHWIC slots, Console, Aux | routing, modular |
| router.nf2911 | NF-2911 | Routers | Branch router (P0) | Gi0/0–0/1, Se0/0/0–0/0/1, Console | routing |
| router.nf4331 | NF-4331 | Routers | Mid-size services router | Gi0/0/0–0/0/2 (0/0/2 SFP), 2 × NIM slots, Console, Aux | routing, modular |
| router.nf4451 | NF-4451 | Routers | Enterprise edge router | Gi0/0/0–0/0/3, Te0/1/0–0/1/1 (SFP+), 3 × NIM slots, Console | routing, modular |
| router.nfgeneric | NF-RTR-EMPTY | Routers | Teaching chassis, all slots empty | Console, 8 × generic slots | routing, modular |
| switch.nfc2960-8 | NF-C2960-8TC | Switches | Compact 8-port access switch | Fa0/1–0/8, Gi0/1 (combo) | switching |
| switch.nfc2960 | NF-C2960 | Switches | 24-port access switch (P0) | Fa0/1–0/24, Gi0/1–0/2 | switching |
| switch.nfc2960-48 | NF-C2960-48TT | Switches | 48-port access switch | Fa0/1–0/48, Gi0/1–0/2 | switching |
| switch.nfc2960-24pg | NF-C2960-24PG | Switches | 24-port gigabit PoE+ switch | Gi0/1–0/24 (PoE+), Gi0/25–0/28 (SFP) | switching, poe-source |
| switch.nfc9200-48 | NF-C9200-48P | Switches | 48-port gigabit PoE access switch with 10G uplinks | Gi1/0/1–1/0/48 (PoE+), Te1/1/1–1/1/4 | switching, poe-source |
| mlswitch.nfc3650-24 | NF-C3650-24 | Multilayer switches | 24-port L3 switch | Gi1/0/1–1/0/24, Gi1/1/1–1/1/4 (SFP) | layer3-switch |
| mlswitch.nfc9300-48 | NF-C9300-48U | Multilayer switches | 48-port L3 switch, 10G uplinks | Gi1/0/1–1/0/48, Te1/1/1–1/1/8 | layer3-switch, poe-source |
| dcswitch.nfn9k-48 | NF-N9K-48X | Data centre | Top-of-rack leaf | Et1/1–1/48 (10G), Fo1/49–1/54 (40G) | layer3-switch |
| dcswitch.nfn9k-32 | NF-N9K-32F | Data centre | Spine | Fo1/1–1/32 (40G) | layer3-switch |
| hub.nfhub4 | NF-HUB-4 | Legacy | 4-port 10 Mb hub | Et0–Et3 | repeater |
| hub.nfhub8 | NF-HUB-8 | Legacy | 8-port 10 Mb hub | Et0–Et7 | repeater |
| hub.nfcoax | NF-COAX-TAP | Legacy | Thin-coax multiport transceiver | Cx0–Cx3 | repeater |
| repeater.nfrep | NF-REPEATER | Legacy | 2-port signal repeater | Et0–Et1 | repeater |
| bridge.nfbr2 | NF-BRIDGE-2 | Legacy | 2-port learning bridge | Et0–Et1 | switching |
| bridge.nfbr4 | NF-BRIDGE-4 | Legacy | 4-port learning bridge | Et0–Et3 | switching |
| firewall.nfasa5506 | NF-FW-5506 | Security | Small stateful firewall appliance | Gi1/1–1/8, Console | firewall, routing |
| firewall.nfngfw1120 | NF-NGFW-1120 | Security | Next-generation firewall | Gi1/1–1/8, Gi1/9–1/12 (SFP), Console | firewall, routing |
| ids.nfsensor | NF-IDS-SENSOR | Security | Network IDS sensor | Gi0/0 (mgmt), Gi0/1–0/2 (monitor) | host |
| ap.nfap-auto | NF-AP-2600 | Wireless | Autonomous dual-band access point | Gi0 (PoE-powered), Wl0 (2.4 GHz), Wl1 (5 GHz) | wifi-ap, poe-powered |
| ap.nfap-lw | NF-AP-1832 | Wireless | Lightweight AP (behaves autonomous until controllers arrive in P2) | Gi0, Wl0, Wl1 | wifi-ap, poe-powered |
| ap.nfap-mesh | NF-AP-1562 | Wireless | Outdoor mesh AP | Gi0, Wl0, Wl1 | wifi-ap |
| ap.nfap-ax | NF-AP-9120 | Wireless | Wi-Fi 6/6E AP | Gi0, Wl0 (2.4), Wl1 (5), Wl2 (6 GHz) | wifi-ap, poe-powered |
| wlc.nfwlc3504 | NF-WLC-3504 | Wireless | Wireless LAN controller (control plane in P2) | Gi0/1–0/4, Console | host |
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
