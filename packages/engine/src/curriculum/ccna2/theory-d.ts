/**
 * curriculum/ccna2/theory-d.ts — plain-language theory for the wireless part of CCNA 2 (lessons 25-28, module
 * "Wireless at scale"), keyed by the lesson ids of `ccna2/lessons.ts`. `theory-a.ts` carries 01-11, `theory-b.ts`
 * 12-21 and `theory-c.ts` 22-24 and 29-34; `theory.ts` merges the four (ARCHITECTURE-P2 §7 W7 course, §11.1, §11.3).
 *
 * Same shape, voice and markdown subset as the other three parts and `curriculum/ccna1/theory-a.ts`: five fixed
 * sections — the idea in one breath, why it exists, how it actually works, what trips people up, and what to see in
 * NetForge — markdown limited to headings, lists, emphasis, code and fenced code, no raw markup, original wording and
 * no vendor names. CAPWAP, DTLS, SAE, EAP and RADIUS are CCNA vocabulary and appear as names only.
 *
 * Two rules the bodies keep, both pinned by `test/curriculum.ccna2.commands.test.ts`:
 * - every command in backticks parses in `GRAMMAR` on a model the lesson names: lesson 27 the models of its lab
 *   `ccna2-wlc-wlan`; the lab-less lessons the models listed for them in that test (25: NF-WLC-9800, NF-AP-1832 and
 *   NF-C2960; 26: NF-AP-2600 and NF-AP-1832; 28: NF-WLC-9800 and NF-AP-1832), plus any model a body names itself
 *   (26 names NF-AP-9120 for its 6 GHz radio, 28 names NF-LAPTOP);
 * - every address line printed for lesson 27 is a line of its lab's reference solution. That holds for the
 *   controller's own `address`, `gateway` and `dhcp-server` lines too, which that test's pattern does not catch (a
 *   pin of its own in `test/curriculum.test.ts`): every line of the fenced block of lesson 27 is a line of the staff
 *   interface and WLAN of `sim/scenarios/ccna2/wireless.ts`, and the laptop line is the lab's `ip address dhcp Wlan0`.
 *   No lesson prints the interface address the controller keeps for itself, because the lab never types it.
 *
 * The controller has no command line (its panel writes these lines through `configure`, D17), so its lines are shown
 * as what the panel writes, never as something to type at a prompt; the access point, the switch and the laptop have
 * prompts.
 *
 * What NetForge simplifies is said plainly where a learner could look for it (§11.1, D17, §8.5):
 * - lesson 25: the access point answers association and the key handshake itself and then reports the client to the
 *   controller, the DTLS protection is shown, not computed, and roaming and local switching are theory only (C5 and
 *   C6 are not built);
 * - lesson 26 runs theory-only ([S12] channel-plan lab not built): radios are compared by their primary channel, and
 *   partial overlap exists only in 2.4 GHz and only while the neighbour has clients (`link/rf/channels.ts`);
 * - lesson 28 runs theory-only ([S11] enterprise security not built): personal security only, and the handshake
 *   compares a tag rather than computing keys.
 *
 * ponytail: the `md(...)` join of the other parts, so a line of markdown is a line of source and a backtick never
 * needs escaping.
 */
import type { LessonTheoryMap } from '../../contracts/curriculum.js';

/** One lesson body from its lines (the labs build `instructions` the same way). */
const md = (...lines: string[]): string => lines.join('\n');

/** Lesson bodies 25-28. Keys match ids in `ccna2/lessons.ts`, in teaching order. */
export const THEORY_D: LessonTheoryMap = {
  'ccna2-25-controllers-and-lightweight-aps': md(
    '## The idea in one breath',
    '',
    'A lightweight access point keeps the radio work and leaves the rest to a controller. They talk over CAPWAP: a protected control channel for configuring the access point, and a data channel carrying client frames to the controller.',
    '',
    '## Why it exists',
    '',
    'Ten autonomous access points are ten configurations to keep in step, with no view of who is connected where. A controller makes them one system: a WLAN is written once and pushed to every access point that joins, and channels and power are tuned in one place.',
    '',
    '## How it actually works',
    '',
    '**Joining.** The access point gets an address, usually by DHCP, then asks every controller it was given, or broadcasts on its subnet (DHCP or DNS can also name one). It joins one that answers (NetForge takes the first), and the pair walks through fixed states: discovery, a secure session, join, configure, a data check, run. Control uses UDP port 5246, encrypted with DTLS; client data uses 5247. Echoes every 30 seconds keep the link; three missed ones restart discovery.',
    '',
    '**Split MAC.** The 802.11 MAC work is split in two. The access point keeps the real-time half: beacons, probe responses, acknowledgements, retransmissions and encryption on the air. The controller takes the management half: authentication and association, security policy, channel and power plans, and roaming.',
    '',
    '**Central switching.** By default every client frame rides the data channel to the controller, which unwraps it into its WLAN\'s VLAN. So the access point sits on an access port in its own VLAN, and the controller on a trunk, `switchport mode trunk` on the switch. NetForge does not build local switching at a branch.',
    '',
    '**Roaming.** The client, not the network, decides when to move: as its signal fades, it reassociates with a stronger access point broadcasting the same network name. Behind one controller it stays in its WLAN\'s VLAN, so it keeps its address and sessions; controllers of one mobility group pass the client between them.',
    '',
    '## What trips people up',
    '',
    '- A lightweight access point without a controller serves no clients.',
    '- The access point VLAN is not a client VLAN: client frames cross its port only inside the tunnel.',
    '- NetForge simplifies three things. The access point answers association and the key handshake itself, then reports the client to the controller. The encryption is shown, not computed: protected control messages are still decoded for study. Roaming is theory only.',
    '',
    '## See it in NetForge',
    '',
    'An **NF-AP-1832** boots as a lightweight access point:',
    '',
    '- `show capwap` says whether CAPWAP is on, which controllers it asks and the state reached.',
    '- `capwap controller 192.168.99.5` names a controller instead of broadcasting; `no capwap enable` makes the access point autonomous.',
    '- `debug capwap` prints each join step; the **Processes** tab draws them as a history strip.',
    '- An **NF-WLC-9800** has no command line: its **Controller** tab lists joined access points and their clients.',
    '- The packet inspector marks control messages after the join as protected; a client frame\'s **Provenance** tab shows the tunnel wrapped and unwrapped.',
  ),

  'ccna2-26-channels-and-overlap': md(
    '## The idea in one breath',
    '',
    'Access points on the same channel that hear each other take turns; on channels that partly overlap they spoil each other\'s frames. A channel plan gives neighbours channels that do not overlap, and reuses a channel only out of earshot.',
    '',
    '## Why it exists',
    '',
    'A building needs many access points, and their cells must overlap a little, about 10 to 20 percent, so a moving client is never out of range. Where cells overlap, the radios hear each other. On one channel they share the airtime, as if one access point served both rooms. On overlapping channels it is worse: each hears the other as noise that nobody waits for, and frames are lost.',
    '',
    '## How it actually works',
    '',
    '**2.4 GHz.** Channels 1 to 13 (1 to 11 in some countries) sit 5 MHz apart, but a transmission is about 20 MHz wide, so channels fewer than five numbers apart overlap. Only three fit side by side: 1, 6 and 11. Lay them out like a honeycomb so that no two neighbours share one, and keep the width at 20 MHz.',
    '',
    '**5 GHz.** The 20 MHz channels, 36, 40, 44, 48 and on to 165, do not overlap, and there are more than twenty. Wider channels bond neighbours: 40 MHz takes two, 80 MHz four and 160 MHz eight, so each client gets more speed and the plan fewer channels. Some channels must give way to radar.',
    '',
    '**6 GHz.** Used only by Wi-Fi 6E devices and newer, it adds 1200 MHz: 59 channels of 20 MHz, numbered 1, 5, 9 and on to 233, or 14 of 80 MHz. Wide channels fit without a reuse puzzle, but older clients never see the band.',
    '',
    'Power belongs to the plan too: a cell no larger than needed keeps the next access point on the same channel out of earshot.',
    '',
    '## What trips people up',
    '',
    '- Channels 1 and 3 are not different enough: in 2.4 GHz, the closer two channels are, the more they interfere.',
    '- More power is not more coverage. A loud access point reaches clients that cannot answer as loudly, and carries its channel into cells that reuse it.',
    '- NetForge compares radios by main channel only: a 40 MHz channel on 36 does not overlap one on 40 here, as it would on air. Partial overlap counts only in 2.4 GHz and only while the neighbour has clients, and radar is not modelled.',
    '',
    '## See it in NetForge',
    '',
    'Place two **NF-AP-2600** access points ten metres apart; `Wlan0` is the 2.4 GHz radio and `Wlan1` the 5 GHz one:',
    '',
    '- `show wireless` gives the band, channel, width and power of each radio.',
    '- Under `interface Wlan0`, `channel 6` moves the radio and `channel auto` picks the quietest channel it hears.',
    '- Under `interface Wlan1`, `channel-width 40` bonds two channels; `tx-power 11` shrinks either cell.',
    '- An **NF-AP-9120** adds `Wlan2`, a 6 GHz radio: `channel 37` there reaches only the newest clients.',
  ),

  'ccna2-27-wlans-on-a-controller': md(
    '## The idea in one breath',
    '',
    'On a controller, a WLAN is a network name with its security, attached to a controller interface, and a controller interface is a VLAN with an address and a gateway. The controller pushes the WLAN to every access point that joins and switches its clients into that VLAN.',
    '',
    '## Why it exists',
    '',
    'The access points should not need to know how the wired network is divided. The controller keeps that in one place: one WLAN can land staff in VLAN 20 and another guests in VLAN 30, through the same access points and over the same trunk.',
    '',
    '## How it actually works',
    '',
    'Three things are created, in this order:',
    '',
    '1. **The management interface.** Every controller has one. Access points join the controller on it, so it needs a VLAN, an address and a gateway they can reach.',
    '2. **A controller interface for each client VLAN**: a name, the VLAN, an address of the controller in that subnet, the gateway of the subnet and its DHCP server.',
    '3. **The WLAN**: a number, a profile name, the network name clients see, the security, the passphrase and the interface it maps to.',
    '',
    'A client then joins as on any access point: it scans, authenticates, associates and finishes the key handshake, and only then do its frames cross the tunnel into the VLAN.',
    '',
    'In the lab, the controller panel writes these lines for the staff network:',
    '',
    '```',
    'wlc-interface STAFF-IF',
    ' vlan 20',
    ' address 192.168.20.5 255.255.255.0',
    ' gateway 192.168.20.1',
    ' dhcp-server 192.168.20.1',
    'wlan 1 STAFF LabNet',
    ' security wpa2-psk',
    ' interface STAFF-IF',
    ' no shutdown',
    '```',
    '',
    'The switch port of the controller is a trunk carrying the management VLAN and every client VLAN. The access point stays on an access port of its own VLAN, because its clients travel inside the tunnel.',
    '',
    '## What trips people up',
    '',
    '- A WLAN that names no interface uses the management interface, so its clients land in the access point VLAN.',
    '- A client VLAN missing from the trunk of the controller: the laptop associates but never gets an address.',
    '- A real controller relays client DHCP requests to the DHCP server of the interface. NetForge records that server but bridges the requests into the VLAN, so a server or relay there must answer, as R1 does in the lab.',
    '- A WLAN reaches the access points only while it is enabled, and changing its name or security drops its clients.',
    '- NetForge gives each radio one WLAN: the lowest-numbered one offered on its band.',
    '',
    '## See it in NetForge',
    '',
    'WLC1 is an **NF-WLC-9800** with no command line: its **Controller** tab has the Interfaces and WLANs pages.',
    '',
    '- `show capwap` on LAP1, an **NF-AP-1832**, shows the controller, the state and how many WLANs it received.',
    '- On LAPTOP1, `wifi connect LabNet key quiet-meadow-27`, then `ip address dhcp Wlan0`; `ipconfig /all` shows a lease in `192.168.20.0/24`.',
    '- The Clients page lists the laptop with its VLAN and interface.',
    '- `show interfaces trunk` on SW1 shows VLANs 20 and 99 crossing the trunk of the controller.',
  ),

  'ccna2-28-securing-a-wlan': md(
    '## The idea in one breath',
    '',
    'Personal security gives everyone one shared passphrase; enterprise security makes each user or device prove who it is to an authentication server. Both end with keys that encrypt the frames of each client separately. They differ in what is checked before a client may send.',
    '',
    '## Why it exists',
    '',
    'A radio delivers every frame to anyone in range, so an open network lets anyone join and anyone read. A shared passphrase fixes that for a home or a small office, but it cannot tell people apart, and when one person leaves everyone needs a new one. A company needs a login per person that can be switched off alone and shows up in a log.',
    '',
    '## How it actually works',
    '',
    'WEP is broken, and WPA with TKIP was a stopgap. WPA2 encrypts with AES (CCMP) and is the minimum today; WPA3 is the current generation.',
    '',
    '**Personal.** In WPA2 personal, the network name and passphrase give both sides the same master key. A four-way handshake proves that each side holds it, without sending it, and derives fresh keys for the session. Anyone who records a handshake can still guess passphrases offline, as fast as their computer allows. WPA3 personal starts with SAE instead: every guess needs a live exchange with the access point, and traffic recorded today stays unreadable even if the passphrase leaks later.',
    '',
    '**Enterprise.** 802.1X has three roles: the client (supplicant), the access point or controller (authenticator) and a RADIUS server (authentication server). The client runs EAP through the authenticator to the server, with a certificate (EAP-TLS) or a username and password inside a protected tunnel (PEAP), and nothing else passes until the server agrees. The server then hands the authenticator a key for that client alone, and the same four-way handshake follows. WPA3 enterprise adds a stricter 192-bit mode.',
    '',
    '## What trips people up',
    '',
    '- Hiding the network name or listing allowed hardware addresses is not security: both travel in plain sight.',
    '- "WPA2" alone does not say personal or enterprise; ask which.',
    '- A short passphrase undoes WPA2 personal, because the guessing happens offline.',
    '- A WLAN that allows only WPA3 shuts out older clients.',
    '- NetForge builds personal security only, so enterprise security is theory here. The handshake frames are real in the trace, but no key is computed and no frame is encrypted: the access point compares a tag made from the network name and the passphrase.',
    '',
    '## See it in NetForge',
    '',
    'On an **NF-WLC-9800**, the WLANs page of the **Controller** tab writes the security of a WLAN:',
    '',
    '```',
    'wlan 1 CAMPUS Campus-Net',
    ' security wpa3-sae',
    ' passphrase long-river-stones-81',
    '```',
    '',
    '- An **NF-AP-1832** working on its own takes the same choice under `interface Wlan0`, for example `security wpa2-psk`.',
    '- `debug wireless` on the access point prints each step of a join; a wrong passphrase ends it at the handshake.',
    '- `wifi connect Campus-Net key long-river-stones-81` on an **NF-LAPTOP** joins the network, and `wifi list` shows it.',
  ),
};
