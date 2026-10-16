/**
 * @netforge/engine/web — the named helpers the web app's main thread reads beyond `/pure` and `/contracts`
 * (ARCHITECTURE-P3C §7 W0h web-shell, the bundle split; D11).
 *
 * The main thread never imports the bare `@netforge/engine` for a value (apps/web/test/bundle.engine-imports.lint.test.ts):
 * the full entry evaluates every daemon, codec, grammar fragment, scenario and course, and put them all in the main
 * chunk. The engine worker (apps/web/src/bridge/worker/**) still imports the full entry. The main thread reads:
 *   - `@netforge/engine/pure`       stateless helpers (address maths, the display filter, formatters, automation);
 *   - `@netforge/engine/contracts`  contract constants and helpers (src/contracts/index.ts);
 *   - `@netforge/engine/curriculum` the course catalogue, loaded lazily (src/curriculum-entry.ts);
 *   - `@netforge/engine/web`        this file: the few implementation constants and helpers the UI shares with the
 *                                   engine (labels, limits, key builders, the file reader and writer, the PDU builder
 *                                   the packet inspector re-encodes a leg with).
 *
 * Rules: re-exports only, each by name (never `export *`), so that what the main chunk pulls in stays visible and a
 * name added here is a reviewed decision. Every name is also exported by the main entry, from the same module, so a
 * value is the same object whichever entry a caller used. No module is evaluated here that the main entry does not
 * evaluate; nothing here changes an engine byte.
 */

// capture
export { CAPTURE_QUERY_SCAN_BUDGET } from './capture/store.js';

// cli: the configuration walker and the grammar's labels and limits that the GUI forms reuse
export { walkConfigText } from './cli/config-text.js';
export { DNS_RECORD_TYPES } from './cli/grammar/dns.js';
export { SERVICE_POOL_NAME } from './cli/grammar/services.js';
export { WLC_ARG_LIMITS } from './cli/grammar/wlc.js';

// core
export { isVlanId, parseVlanList } from './core/vlan-list.js';

// io: the topology file and its limits
export { readNetforge, topologyFromJson, topologyToJson, writeNetforge } from './io/netforge-file.js';
export {
  MAX_DISTANCE_M,
  MAX_TOPOLOGY_FILE_CHARS,
  MAX_TOPOLOGY_FILE_NAME_CHARS,
  MAX_TOPOLOGY_FILES_PER_DEVICE,
  isTopologyFileName,
} from './io/schema.js';

// link
export { checkCable } from './link/cabling.js';
export { inflightKey } from './link/inflight.js';
export { BAND_GENERATIONS, mcsRateBps } from './link/rf/mcs.js';

// pdu
export { SYSLOG_FACILITY_NAMES, SYSLOG_SEVERITY_NAMES } from './pdu/codecs/syslog.js';
export { createPduFactory } from './pdu/factory.js';

// protocols: display codes, defaults and the pure planners the desktop apps and the inspector share
export { routeSourceCode } from './protocols/ipv4.js';
export { NTP_MASTER_DEFAULT_STRATUM } from './protocols/ntp.js';
export { SCRIPT_HOST_NAME } from './protocols/script-host.js';
export { TRAFFIC_VOICE_PRESETS, planTrafficFlow } from './protocols/traffic.js';
export { vtySshCrypt, vtySshKey, vtyText } from './protocols/vty.js';

// qos
export { QOS_CLASS_DEFAULT, qosDscpText } from './qos/config.js';

// timeline
export { laneOfTable } from './timeline/lanes.js';
