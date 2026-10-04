/**
 * sim/lab-checks/automation.ts — the http area's checker adapter (ARCHITECTURE-P3 D5, D21, §2.10, §3.8; §0 rules 12 and
 * 20; §7 W3 "ospf, acl, l2, qos, disc, svc, http" and the approved [S32] fact). The registry (sim/lab-checks/facts.ts,
 * owned by sim) wires these entries into FACT_READERS; nothing here is read at module scope (rule 12).
 *
 * The RESTCONF changes and the JSON reading tasks of lab 38 are graded with the generic kinds (§2.10's table: the
 * effect with `vlan` / `config`, the request with `table restconf-log` and `whereOps`), so this area has no fact of
 * its own beyond the approved one:
 *   [S32] automation.lastRun  string  script-runs.state — the state of the newest run ('running', 'completed',
 *         'failed' or 'stopped'); subject: an optional file name ('inventory.py', compared exactly), which limits the
 *         runs to that script's. The newest run is the one started last (the higher run number on a tie). Absent when
 *         no run (of that file) is listed, or when the device keeps no `script-runs` table (it is not a programmable
 *         host). Live only: the grader never re-runs a script (§2.10).
 *
 * Nothing here draws randomness, advances time or emits trace.
 */
import type { LabFactName } from '../../contracts/scenario.js';
import type { ScriptRunRow } from '../../contracts/tables.js';
import type { FactContext, FactReader, FactReading } from './facts.js';

/** The number of a run id ('r12' → 12); -1 for any other id. */
function runNumber(run: string): number {
  const m = /^r([0-9]+)$/.exec(run);
  return m === null ? -1 : Number(m[1]);
}

/** Is `b` newer than `a`: started later, or at the same time with the higher run number? */
function newer(b: ScriptRunRow, a: ScriptRunRow): boolean {
  return b.startedAt > a.startedAt || (b.startedAt === a.startedAt && runNumber(b.run) > runNumber(a.run));
}

/** [S32] automation.lastRun (file header). */
function readLastRun(ctx: FactContext): FactReading {
  const rows = ctx.dev.tables.get<ScriptRunRow>('script-runs')?.rows() ?? [];
  let newest: ScriptRunRow | undefined;
  for (const r of rows) {
    if (ctx.subject !== undefined && r.file !== ctx.subject) continue;
    if (newest === undefined || newer(r, newest)) newest = r;
  }
  return { value: newest?.state };
}

/** FACT_READERS entries of the http area. */
export const AUTOMATION_FACT_READERS: Partial<Record<LabFactName, FactReader>> = {
  'automation.lastRun': { type: 'string', source: 'script-runs.state', read: readLastRun },
};
