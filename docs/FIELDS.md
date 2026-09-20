# Canonical layer field names — P0.5 and P1 codecs

Extends the P0 table in `packages/engine/src/contracts/pdu.ts` (ethernet, arp, ipv4, icmpv4,
payload — unchanged). Same rules apply: codecs decode/encode EXACTLY these keys, processes use
EXACTLY these keys, derived fields (lengths, checksums, FCS, padding) are always recomputed by
`encode()`, outer codecs pass `next.length` as an upper bound, and every value is a
`FieldValue` (number | string | boolean | Uint8Array | null). Addresses use canonical string
forms (MAC `aa:bb:cc:dd:ee:ff`, IPv4 dotted, IPv6 RFC 5952 compressed lowercase).

## Link layer

| Proto | Fields |
|---|---|
| `hdlc` | address (u8, default 0x0f unicast / 0x8f broadcast), control (u8, default 0x00), protocol (u16: 0x0800 IPv4, 0x86dd IPv6, 0x8035 keepalive/SLARP), fcs (u16 decode-only), fcsValid (decode-only). Serial frames carry no MAC addresses. |
| `dot11` | frameType (`'mgmt'`/`'ctrl'`/`'data'`), subtype (string: `beacon`, `probe-req`, `probe-resp`, `auth`, `deauth`, `assoc-req`, `assoc-resp`, `reassoc-req`, `disassoc`, `ack`, `rts`, `cts`, `data`, `qos-data`), toDs (bool), fromDs (bool), retry (bool), protected (bool), duration (u16), addr1 (MAC, receiver), addr2 (MAC, transmitter), addr3 (MAC, BSSID or DA/SA per DS bits), seq (u12), fcs (u32 decode-only), fcsValid (decode-only). |
| `dot11-mgmt` | ssid (string), bssid (MAC), channel (u8), band (`'2.4'`/`'5'`/`'6'`), beaconIntervalMs (u16), capability (u16), rates (string, comma-separated Mb/s), security (`'open'`/`'wpa2-psk'`/`'wpa3-sae'`/`'wpa2-ent'`), authAlgorithm (u16: 0 open, 3 SAE), authSeq (u16), statusCode (u16), reasonCode (u16), aid (u16), rssiDbm (i16, simulated, decode-only annotation). |
| `llc` | dsap (u8, 0xaa), ssap (u8, 0xaa), control (u8, 0x03), oui (u24, 0), type (u16 ethertype) — the LLC/SNAP header that follows a dot11 data header. |
| `eapol` | version (u8, 2), packetType (u8: 3 key), keyType (`'pairwise'`/`'group'`), handshakeStep (u8 1–4, simulated), replayCounter (u64 as number), mic (bool valid, simulated), keyData (Uint8Array, simulated). Crypto is simulated; headers are real (spec §4.5). |
| `radio` | Point-to-point radio bridges carry Ethernet frames unchanged; no extra layer. |
| `cell` | Cellular attach is behavioural; user-plane packets are carried as raw IP (`ipv4`/`ipv6` as outermost layer) between the device and the tower. |

## Network layer

| Proto | Fields |
|---|---|
| `ipv6` | version (6), trafficClass (u8, default 0), flowLabel (u20, default 0), payloadLength (derived), nextHeader (u8, REQUIRED from builder), hopLimit (u8, default 64 hosts / 255 routers-originated NDP), src (Ipv6Address, REQUIRED), dst (Ipv6Address, REQUIRED). Extension headers decode as their own layers (`ipv6-hopopts`, `ipv6-frag`: nextHeader, offset, more, id). |
| `icmpv6` | type (u8), code (u8), checksum (derived, pseudo-header), checksumValid (decode-only); echo (128/129): id (u16), seq (u16); NS (135)/NA (136): target (Ipv6Address), routerFlag, solicitedFlag, overrideFlag (bool, NA only), sourceLla / targetLla (MAC option, optional); RS (133): sourceLla; RA (134): managedFlag, otherFlag (bool), prefix (Ipv6Address), prefixLen (u8), validLifetimeS, preferredLifetimeS (u32), mtu (u32, optional), sourceLla; dest-unreachable (1) / time-exceeded (3) / packet-too-big (2, mtu): unused/mtu then nested quoted `ipv6` layer like ICMPv4. |

## Transport layer

| Proto | Fields |
|---|---|
| `udp` | srcPort (u16, REQUIRED), dstPort (u16, REQUIRED), length (derived), checksum (derived, pseudo-header over IPv4/IPv6; 0 allowed on IPv4 decode), checksumValid (decode-only). Next layer chosen by well-known port (see table below), else `payload`. |
| `tcp` | srcPort, dstPort (u16), seq (u32), ack (u32), dataOffset (derived), flags (string of letters in fixed order `FSRPAUEC`, e.g. `'S'`, `'SA'`, `'A'`, `'PA'`, `'FA'`, `'R'`), window (u16), checksum (derived, pseudo-header), checksumValid (decode-only), urgentPointer (u16, default 0), mss (u16, option, optional), windowScale (u8, option, optional), sackPermitted (bool, option), sackBlocks (string `"l1-r1,l2-r2"`, option), timestamp (u32, option), timestampEcho (u32, option). Next layer by well-known port when the segment carries payload. |

## Application layer

| Proto | Fields |
|---|---|
| `dhcp` | op (u8: 1 request, 2 reply), htype (1), hlen (6), hops (u8), xid (u32), secs (u16), broadcastFlag (bool), ciaddr, yiaddr, siaddr, giaddr (Ipv4Address, default 0.0.0.0), chaddr (MAC), messageType (string `DISCOVER`/`OFFER`/`REQUEST`/`DECLINE`/`ACK`/`NAK`/`RELEASE`/`INFORM`), requestedIp, serverId (Ipv4Address, optional), leaseTimeS, renewalTimeS, rebindingTimeS (u32, optional), subnetMask, router, dnsServers (string comma-separated), domainName (string), hostname (string), parameterRequestList (string comma-separated codes), clientId (string hex, optional). |
| `dns` | id (u16), qr (bool), opcode (u4), aa, tc, rd, ra (bool), rcode (u4: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN), questions (string: `name TYPE` entries joined by `;`, e.g. `www.lab.nf A`), answers / authorities / additionals (string: `name TYPE ttl data` entries joined by `;`, e.g. `www.lab.nf A 300 10.0.0.80`). Record types in P1: A, AAAA, CNAME, MX (`pref host`), PTR, NS, SOA. Names are lowercase, no trailing dot. |
| `http` | kind (`'request'`/`'response'`), method (string, request), target (string, request), version (`'HTTP/1.1'`), status (u16, response), reason (string, response), headers (string, `Name: value` lines joined by `\n`), body (string, UTF-8). Encoded as real HTTP/1.1 text; a message split across TCP segments is reassembled by the socket layer, not the codec (the codec decodes what one segment holds and sets `error: 'partial'` when incomplete). |
| `tftp` / `ftp` / `smtp` / `pop3` / `telnet` / `ssh` / `ntp` / `syslog` / `snmp` | Reserved for later P1 slices; until implemented, their ports decode as `payload`. |

## Well-known ports used for decode dispatch

| Port | Transport | Next layer |
|---|---|---|
| 53 | udp, tcp | dns |
| 67, 68 | udp | dhcp |
| 80, 8080 | tcp | http |
| 69 | udp | tftp (reserved) |
| 123 | udp | ntp (reserved) |
| 514 | udp | syslog (reserved) |
| 23 | tcp | telnet (reserved) |
| 22 | tcp | ssh (reserved) |

Dispatch checks the destination port first, then the source port (replies from a server come
FROM the well-known port).

## Constants to add to contracts

- Ethertypes: `ETHERTYPE_IPV6 = 0x86dd` (exists), `ETHERTYPE_EAPOL = 0x888e`.
- IP protocol numbers: `IPPROTO_ICMPV6 = 58`, `IPPROTO_TCP = 6` and `IPPROTO_UDP = 17` (exist).
- HDLC protocol values: `HDLC_PROTO_IPV4 = 0x0800`, `HDLC_PROTO_IPV6 = 0x86dd`, `HDLC_PROTO_KEEPALIVE = 0x8035`.
- ICMPv6 types: `ICMPV6_DEST_UNREACHABLE = 1`, `ICMPV6_PACKET_TOO_BIG = 2`, `ICMPV6_TIME_EXCEEDED = 3`, `ICMPV6_ECHO_REQUEST = 128`, `ICMPV6_ECHO_REPLY = 129`, `ICMPV6_RS = 133`, `ICMPV6_RA = 134`, `ICMPV6_NS = 135`, `ICMPV6_NA = 136`.
- ICMPv4 additions: `ICMP_UNREACH_PORT = 3` (traceroute end, UDP to a closed port).
- Default hop limits: `IPV6_DEFAULT_HOP_LIMIT = 64`, NDP messages use 255.
- Ephemeral port range: `EPHEMERAL_PORT_MIN = 49152`, `EPHEMERAL_PORT_MAX = 65535` (allocated from the host's rng sub-stream, deterministic).
- TCP defaults: MSS 1460 (IPv4) / 1440 (IPv6), initial window 65535, initial RTO 1 s, max retransmissions 5, TIME_WAIT 2×MSL with MSL = 30 s (shortened to 2 s in simulation mode is NOT allowed — keep real timers; the UI clock policy handles visibility).
- DHCP: lease default 86 400 s, T1 = 50 %, T2 = 87.5 %, client retransmit 4 s doubling to 64 s.
- DNS: client timeout 2 s, 2 retries, resolver cache honours record TTL.
