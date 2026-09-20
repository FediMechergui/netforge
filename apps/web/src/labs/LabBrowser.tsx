/**
 * Labs catalogue (ARCHITECTURE-P1 §4.13, §7 "Labs browser"): the scenarios `EngineApi.listScenarios` reports,
 * grouped by their topic, each with what it is about, how long it takes and a button that loads it.
 *
 * A lab whose `missingTypes` is non-empty is listed as unavailable with the equipment this build lacks, because
 * `loadScenario` would refuse it. Availability is shown as a lettered badge plus words, never colour alone, and
 * the whole list is ordinary buttons and headings, so it works from the keyboard and reads as a document.
 *
 * Presentational only: LabPanel owns the engine calls and passes the list in. Wording is original (§1.6).
 *
 * ponytail: no search box and no sort — fifteen labs in a handful of topics are read, not searched — and the
 * groups keep the order `listScenarios` gave them, which is the engine's own catalogue order.
 */
import type { ScenarioMeta } from '@netforge/engine';

/** Heading of a group of labs and the labs in it, in list order. */
export interface LabTopicGroup {
  readonly topic: string;
  readonly labs: readonly ScenarioMeta[];
}

/** Topic shown for a lab that names none. */
export const OTHER_TOPIC = 'Other labs';

/** Scenarios that are labs (a starting template is not one). */
export function isLab(meta: ScenarioMeta): boolean {
  return meta.category !== 'template';
}

/** Labs grouped by topic, topics and labs in the order `listScenarios` returned them. */
export function labsByTopic(scenarios: readonly ScenarioMeta[]): readonly LabTopicGroup[] {
  const groups = new Map<string, ScenarioMeta[]>();
  for (const meta of scenarios) {
    if (!isLab(meta)) continue;
    const topic = meta.topic ?? OTHER_TOPIC;
    const list = groups.get(topic);
    if (list === undefined) groups.set(topic, [meta]);
    else list.push(meta);
  }
  return [...groups].map(([topic, labs]) => ({ topic, labs }));
}

/** Whether this build can load a lab, with the reason when it cannot. */
export function labAvailability(meta: ScenarioMeta): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const missing = meta.missingTypes ?? [];
  if (missing.length === 0) return { ok: true };
  return { ok: false, reason: `This lab needs equipment this release does not have yet: ${missing.join(', ')}.` };
}

/** "25 min · 2 of 3 in difficulty" — the facts under a lab title, as words. */
export function labFacts(meta: ScenarioMeta): string {
  const parts: string[] = [];
  if (meta.estimatedMinutes !== undefined) parts.push(`about ${meta.estimatedMinutes} min`);
  if (meta.difficulty !== undefined) parts.push(`difficulty ${meta.difficulty} of 3`);
  if (meta.tasks !== undefined) parts.push(`${meta.tasks.length} task${meta.tasks.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export interface LabBrowserProps {
  readonly scenarios: readonly ScenarioMeta[];
  /** Lab currently loaded, so the list can say which one it is. */
  readonly activeName?: string | undefined;
  /** True while a lab is loading; every load button is disabled meanwhile. */
  readonly busy?: boolean;
  readonly onOpen: (meta: ScenarioMeta) => void;
}

export function LabBrowser({ scenarios, activeName, busy = false, onOpen }: LabBrowserProps) {
  const groups = labsByTopic(scenarios);
  if (groups.length === 0) return <p className="empty-hint">No labs are available in this release.</p>;
  return (
    <div className="dock-scroll">
      {groups.map((group) => (
        <section key={group.topic} aria-label={group.topic}>
          <div className="panel-title">{group.topic}</div>
          <ul className="help-list">
            {group.labs.map((meta) => {
              const availability = labAvailability(meta);
              const active = meta.name === activeName;
              const facts = labFacts(meta);
              return (
                <li key={meta.name}>
                  <div>
                    <strong>{meta.title}</strong>
                    {active && (
                      <span className="chip">
                        <span aria-hidden="true">▣ </span>open now
                      </span>
                    )}
                    {!availability.ok && (
                      <span className="chip">
                        <span aria-hidden="true">⊘ </span>unavailable
                      </span>
                    )}
                  </div>
                  <div className="dim">{meta.description}</div>
                  {facts !== '' && <div className="dim">{facts}</div>}
                  {availability.ok ? (
                    <button type="button" className="btn" disabled={busy} onClick={() => onOpen(meta)}>
                      {active ? `Reload ${meta.title}` : `Open ${meta.title}`}
                    </button>
                  ) : (
                    <p className="insp-note">
                      <span aria-hidden="true">⊘ </span>
                      {availability.reason}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
