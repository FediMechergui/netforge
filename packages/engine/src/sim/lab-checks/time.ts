/**
 * sim/lab-checks/time.ts — the svc area's checker adapter (ARCHITECTURE-P3 D5, D19, D20, §2.10, §3.7, §5.5, §5.7; §0
 * rules 12 and 20; §7 W3 "ospf, acl, l2, qos, disc, svc, http" and the approved [S25] item: "the time adapter gains
 * the `logging.*` facts"). The registry (sim/lab-checks/facts.ts, owned by sim) wires these entries into FACT_READERS;
 * nothing here is read at module scope (rule 12).
 *
 * Facts, each with its source (rule 20) — the device clock is graded from the ntp daemon's `clock` row, never from the
 * runtime's clock or a StateView:
 *   ntp.synced      boolean  ntp-peers.selected — a row in state `sys-peer` exists (the clock follows a server). A
 *                            device that keeps an `ntp-peers` table but has no sys-peer reads false (an `ntp master`
 *                            with no server too: it serves its own clock and follows nobody); a model with no such
 *                            table has no value.
 *   ntp.peer        address  ntp-peers.address of the sys-peer row (compared through the identities, so a lab writes the
 *                            server's device NAME); absent while no row is the sys-peer.
 *   ntp.stratum     number   clock.stratum — the device's own stratum (its server's plus one, or the `ntp master`
 *                            stratum); absent without the row or when the row has none (a `clock set` clock).
 *   clock.source    string   clock.source — 'ntp', 'master' or 'user'; without the row, the model's boot clock (catalog;
 *                            ruling R41): 'host' for hosts and servers, which boot with true time (§3.7), else 'unset'
 *                            (the clock was never set).
 *   clock.offsetMs  number   clock.offsetMs — the displayed clock minus true time in whole milliseconds (the floor, as
 *                            the row splits it); absent without the row.
 *   [S24] logging.buffered  string  configuration — the level keyword the buffer keeps ('debugging' … 'emergencies'),
 *                            read with the logger's own reader (`loggingConfigOf`: on by default at debugging, `logging
 *                            buffered [<size>] [<level>]`); absent when a stored `no logging buffered` turns it off.
 *   [S25] logging.trap      string  configuration — the level keyword of `logging trap <0-7|keyword>` (a number is read as
 *                            its keyword, so `logging trap 4` and `logging trap warnings` both read 'warnings');
 *                            'informational' without the line (§5.7). Read with the logger's own syslog reader
 *                            (`syslogConfigOf(root).trap`, ruling R41), so the grader and the sender never disagree.
 * None of these facts takes a subject; one given is ignored.
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import type { DeviceRuntime } from '../../contracts/device.js';
import type { LabFactName } from '../../contracts/scenario.js';
import type { ClockRow, NtpPeerRow, TableName } from '../../contracts/tables.js';
import { isHostClock } from '../../device/process-ctx.js';
import { LOGGER_LEVEL_NAMES, loggingConfigOf, syslogConfigOf } from '../../protocols/logger.js';
import type { FactContext, FactReader, FactReading } from './facts.js';

/** The rows of `table` on `dev`, or undefined when its model keeps no such table. */
function tableRows<R>(dev: DeviceRuntime, table: TableName): R[] | undefined {
  return dev.tables.get(table)?.rows() as R[] | undefined;
}

/** The `ntp-peers` row the clock follows, or undefined (and whether the device keeps the table at all). */
function sysPeer(dev: DeviceRuntime): { readonly kept: boolean; readonly row: NtpPeerRow | undefined } {
  const rows = tableRows<NtpPeerRow>(dev, 'ntp-peers');
  return { kept: rows !== undefined, row: rows?.find((r) => r.selected === 'sys-peer') };
}

/** The ntp daemon's one `clock` row (key 'clock'), or undefined while the clock was never set. */
function clockRow(dev: DeviceRuntime): ClockRow | undefined {
  return tableRows<ClockRow>(dev, 'clock')?.find((r) => r.key === 'clock');
}

function readNtpSynced(ctx: FactContext): FactReading {
  const peer = sysPeer(ctx.dev);
  return { value: peer.kept ? peer.row !== undefined : undefined };
}

function readNtpPeer(ctx: FactContext): FactReading {
  return { value: sysPeer(ctx.dev).row?.address };
}

function readNtpStratum(ctx: FactContext): FactReading {
  return { value: clockRow(ctx.dev)?.stratum };
}

/** The clock row's source, else the model's boot clock (ruling R41: 'host' on a host or server, else 'unset'). */
function readClockSource(ctx: FactContext): FactReading {
  const row = clockRow(ctx.dev);
  if (row !== undefined) return { value: row.source };
  return { value: isHostClock(ctx.dev.model.capabilities ?? []) ? 'host' : 'unset' };
}

function readClockOffsetMs(ctx: FactContext): FactReading {
  return { value: clockRow(ctx.dev)?.offsetMs };
}

/** [S24] The buffered level keyword, absent while buffering is off. */
function readLoggingBuffered(ctx: FactContext): FactReading {
  const buffered = loggingConfigOf(ctx.dev.running.root).buffered;
  return { value: buffered.enabled ? LOGGER_LEVEL_NAMES[buffered.level] : undefined };
}

/** [S25] The trap level keyword (ruling R41: the logger's own `syslogConfigOf`; informational without the line). */
function readLoggingTrap(ctx: FactContext): FactReading {
  return { value: LOGGER_LEVEL_NAMES[syslogConfigOf(ctx.dev.running.root).trap] };
}

/** FACT_READERS entries of the svc area. */
export const TIME_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'ntp.synced': { type: 'boolean', source: 'ntp-peers.selected', read: readNtpSynced },
  'ntp.peer': { type: 'address', source: 'ntp-peers.address', read: readNtpPeer },
  'ntp.stratum': { type: 'number', source: 'clock.stratum', read: readNtpStratum },
  'clock.source': { type: 'string', source: "clock.source, else the model's boot clock (catalog)", read: readClockSource },
  'clock.offsetMs': { type: 'number', source: 'clock.offsetMs', read: readClockOffsetMs },
  'logging.buffered': { type: 'string', source: 'configuration', read: readLoggingBuffered },
  'logging.trap': { type: 'string', source: 'configuration', read: readLoggingTrap },
};
