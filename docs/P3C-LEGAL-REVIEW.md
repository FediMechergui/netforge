# P3c legal pre-review (decision Q10)

**What this is.** A structured pre-review the architect prepared on 2026-10-16 for the product owner's legal reviewer.
It covers the four items decision Q10 names, which W1b and later waves build, plus three related points the reviewer
may want to see. It is **not legal advice**. For each item it states what NetForge ships, the source it relies on, the
risk the architect sees, and the mitigation already in the design (ARCHITECTURE-P3C, ARCHITECTURE-P3 rule 6 and D23).
The reviewer records a decision in the last column. Nothing marked "Change" may ship until the change is made.

**Standing rules this builds on** (ARCHITECTURE-P3 rule 6, D23; carried into P3c):
- Names, help, errors, `show` output, log messages, lab text and lesson text are original wording.
- Every device is an `NF-…` model.
- No vendor or product name appears in lesson text, help, `show` output or logs.
- `validateCatalog` (`BANNED_VENDOR_WORDS`) and the CLI legal test enforce the banned-word lists in code.

## 1. The four Q10 items

| # | Item (where it ships) | What NetForge does | Source relied on | Risk the architect sees | Mitigation in the design | Architect's recommendation | Reviewer's decision |
|---|---|---|---|---|---|---|---|
| L1 | **SNMP object identifiers** ([S33]; `automation/mib/model.ts`, W1b; the agent in W2b) | Answers SNMP v2c for a small MIB-II subset: system, interfaces, ifName, ipForwarding, and the four standard traps. Every object uses the IETF-standard OID. `sysObjectID.0` returns `1.3.6.1.4.1.32473.1.<model index>`. | IETF standards (RFC 1213 / RFC 3418 / RFC 2863 / RFC 3416). Private Enterprise Number 32473 is the number RFC 5612 reserves **for documentation**. | **Low** for the IETF OIDs: they are published standard identifiers that any implementation uses. **Low to medium** for 32473: RFC 5612 reserves it for documentation and examples, not for a product's own identity, so using it inside a shipped simulator stretches its stated purpose. No vendor's arc (for example `1.3.6.1.4.1.9`) is used anywhere. | IETF OIDs only, no vendor arc (§3.5). | **Change (cheap):** request NetForge's own Private Enterprise Number from IANA (free, a web form) and use it for `sysObjectID`. If none is obtained before W2b, keep 32473 and record it as a known simplification. || Approved as recommended: keep 32473 until NetForge has its own IANA number; the product owner requests it, then one constant changes (2026-10-16) |
| L2 | **MIB text** (the same module; what `snmpwalk` and the SNMP manager app show) | Object names (`sysDescr`, `ifInOctets`, …) and values. `sysDescr.0` is original text naming the NF model and NF-OS version. No MIB module file, `DESCRIPTION` clause or other RFC prose is copied. | The names and OIDs come from the IETF standards above. The descriptions shown to learners are written for NetForge. | **Low.** Standard object names are identifiers the protocol requires. The risk would be copying RFC or vendor MIB description prose, which the design does not do. | Original wording (rule 6). The data module holds names, OIDs, types and access only. | **Approve**, on condition that every learner-visible description is original wording (checked in the W1b review). || Approved (2026-10-16) |
| L3 | **Playbook language** ([C22]; `automation/playbook/model.ts` W1b, the `playbook` command W3b, lab 39) | A small YAML play format of NetForge's own: inventory, plays, tasks, `nf.*` modules, a run recap. It runs over RESTCONF and is idempotent. | YAML (an open specification). The idea of declarative plays is a common pattern. | **Low.** File formats and the idea of a playbook are functional. The risks are trademark use (for example "Ansible", a Red Hat trademark) and copying another tool's module names or documentation. | Module names are `nf.*`, and no vendor tool is named. D23 allows "Ansible-style" only as a descriptive phrase. | **Approve**, and **avoid "Ansible" altogether** in learner-visible text, saying "playbook" or "automation playbook" instead. Remove the "Ansible-style" allowance from D23 for P3c content. || Approved; no "Ansible" in learner-visible text (2026-10-16) |
| L4 | **New `show` layouts and CLI wording** ([S4] [S5] [S6] [S11] [S15] [S16] [S29]–[S31] [S33] [S34] [S41]: `show ip ospf border-routers`, `show ipv6 ospf …`, `show storm-control`, `show ip verify source`, `dir`, `show version` lines, `show monitor`, `copy` progress, ROMMON prompts, …) | Learners type industry-standard command words (needed to teach the CCNA syllabus) and get output in NetForge's own layout and wording. | The command vocabulary taught by the CCNA syllabus. The layouts are NetForge's. | **Medium, and already accepted in P1–P3a.** CLI command syntax that mirrors a vendor's has been litigated (a 2016 US jury found for the defendant on fair use and related defences in a well-known case about CLI commands; the case is not settled law everywhere). The real risk is copying help text, output layouts or messages verbatim. | Rule 6 / D23: original wording for help, errors, `show` output and logs. The CLI legal test and banned-word lists. `NF-…` model names. A ROMMON prompt in NetForge's own form. | **Approve**, with the same checks as P3a. In the W3a review, compare each new `show` layout and message against the rule (layout and wording original; only teaching facts such as the column *meanings* match the syllabus). || Approved, with the per-wave original-wording check (2026-10-16) |

## 2. Related points (not in Q10; for the reviewer's awareness)

| # | Point | Observation | Recommendation | Reviewer's decision |
|---|---|---|---|---|
| L5 | **"CCNA" in course names** (live since P1: "CCNA 1/2/3") | "CCNA" is a certification trademark of its owner. NetForge uses it descriptively to say which syllabus a course follows. | Ask the reviewer whether nominative use is acceptable as is. If not, rename to "Networking 1/2/3 (follows the CCNA syllabus)" and add a non-affiliation line to the landing page. Not P3c-specific. || Approved: keep "CCNA" as a descriptive syllabus name (2026-10-16) |
| L6 | **New lesson videos** (X-5, `Lesson.labVideo?`) | Links and embeds of public YouTube videos. Nothing is re-hosted. The P3a verification rule applies: oEmbed 200, embedding allowed, no sponsor segment, no vendor in the title or channel. | **Approve**, same rule as P3a. Embedding uses the platform's own player and terms. || Approved (2026-10-16) |
| L7 | **Protocol names and wire formats** (OSPFv2/v3, SNMP, TFTP, LLDP-MED: all IETF/IEEE published) | Published standards, implemented from the RFCs. CDP-style TLVs stay in NetForge's own format (P2 D8). | **Approve.** No change from P3a practice. || Approved (2026-10-16) |

## 3. What the build does meanwhile

- W1b may start. L1 is a constant in one place (`sysObjectID`), so changing the number later is a one-line edit.
  L2–L4 are enforced by the existing rule 6 tests and by each wave's review.
- The architect adds two checks to the P3c exit gate (W7):
  - no "Ansible" in learner-visible text (L3);
  - the `sysObjectID` arc is the one this review decides (L1).
- If the reviewer marks any row "Change", the change becomes a named item in the next wave and the exit gate checks it.

## 4. Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Legal reviewer | Fedi Mechergui (product owner, acting as reviewer) | 2026-10-16 | Approved and signed |
| Product owner | Fedi Mechergui | 2026-10-16 | Approved and signed |
