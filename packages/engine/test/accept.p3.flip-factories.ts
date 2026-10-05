/**
 * test/accept.p3.flip-factories.ts — the daemon registry of the W4 catalog flip, for the W4 qa acceptance rows built on
 * `staged.world` before the flip (ARCHITECTURE-P3 §0 rule 14, §7 W4). Not a test file. Owner: W4 qa (qa-eigrp-vty).
 *
 * §7 W4 step 2 registers the seven MUST daemons (ospf, acl, cdp, lldp, ntp, restconf, traffic) and the eight approved
 * ones (ppp, gre, vty, vty-client, logger, syslog-server, eigrp, ike) in `protocols/index.ts`. Until then a world built on
 * `staged.world` at stage P3 runs only the P3 daemons its overlay names; laying `P3_FLIP_FACTORIES` over the registry
 * gives it exactly the daemons a flipped P3 world runs (CDP in the P3 profile, the logger, the hidden vty listeners …),
 * so a row that passes here passes unchanged against the real catalog after the flip (rule 14 runs it again then).
 * ([S32] script-host joins at the W6 flip.)
 */
import type { ProcessName } from '../src/contracts/ids.js';
import type { ProcessFactory } from '../src/contracts/process.js';
import { createAcl } from '../src/protocols/acl.js';
import { createCdp } from '../src/protocols/cdp.js';
import { createEigrp } from '../src/protocols/eigrp.js';
import { createGre } from '../src/protocols/gre.js';
import { createIke } from '../src/protocols/ike.js';
import { createLldp } from '../src/protocols/lldp.js';
import { createLogger } from '../src/protocols/logger.js';
import { createNtp } from '../src/protocols/ntp.js';
import { createOspf } from '../src/protocols/ospf.js';
import { createPpp } from '../src/protocols/ppp.js';
import { createRestconf } from '../src/protocols/restconf.js';
import { createSyslogServer } from '../src/protocols/syslog-server.js';
import { createTraffic } from '../src/protocols/traffic.js';
import { createVtyClient } from '../src/protocols/vty-client.js';
import { createVty } from '../src/protocols/vty.js';

/** Every approved P3 daemon of the W4 flip with its real factory, in the §2.1 final daemon order. */
export const P3_FLIP_FACTORIES: Readonly<Record<ProcessName, ProcessFactory>> = Object.freeze({
  ppp: createPpp,
  cdp: createCdp,
  lldp: createLldp,
  acl: createAcl,
  gre: createGre,
  vty: createVty,
  'vty-client': createVtyClient,
  logger: createLogger,
  ntp: createNtp,
  'syslog-server': createSyslogServer,
  ospf: createOspf,
  eigrp: createEigrp,
  ike: createIke,
  restconf: createRestconf,
  traffic: createTraffic,
});
