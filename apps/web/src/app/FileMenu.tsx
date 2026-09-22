/**
 * File menu (spec §13.1): new, new from template, open / save `.netforge`
 * (zip via the engine's io module), save as plain JSON. Saving uses the File
 * System Access API when the browser offers it and a download otherwise.
 *
 * P0.5: the template list is `ScenarioMeta[]` from the worker, grouped by category (templates first, then course
 * labs, then any other category) with level and topic words as a second line. Entries whose device types this build
 * lacks (`missingTypes`) are listed but disabled with the reason. A failed load (`TopologyLoadError`) reports its
 * per-device problems; the workspace is unchanged in that case. Saving a project that holds Wi-Fi passphrases or
 * radio pairing keys shows a notice, because those are stored as plain text in the file.
 *
 * P2 (ARCHITECTURE-P2 D2; W2 web-shell): "New (empty)" builds the world with the profile of the course context
 * (`profileForCourse(learn.lastCourse)`: classic defaults after a CCNA 1 lesson, current ones otherwise), and
 * "Use current defaults" (`engine.useCurrentDefaults`) moves a classic world — a template, a saved file, a CCNA 1
 * lab — to the current defaults in place, keeping every device, cable and configuration.
 */
import { useRef, useState } from 'react';
import {
  NETFORGE_FORMAT_VERSION,
  readNetforge,
  topologyFromJson,
  topologyToJson,
  writeNetforge,
  type NetforgeManifest,
  type ScenarioMeta,
  type Topology,
  type TopologyLoadProblem,
} from '@netforge/engine';
import { defaultSeed, engine } from '../bridge/client';
import type { EngineError } from '../bridge/errors';
import { profileForCourse, profileOfSnapshot } from '../learn/course-profile';
import { store, useStore } from '../store/store';
import { Menu, MenuHeading, MenuItem, MenuSeparator } from './Menu';
import { reportError } from './PlaybackControls';

const APP_ID = 'netforge/0.5.0';
/** Problems listed in a load failure message; the rest are counted. */
const LOAD_PROBLEMS_SHOWN = 3;

interface SavePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;
}

async function saveBytes(name: string, bytes: Uint8Array | string, mime: string, ext: string): Promise<boolean> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const w = window as unknown as SavePickerWindow;
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'NetForge project', accept: { [mime]: [ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      // fall through to the download path
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

function projectName(t: Topology): string {
  if (t.lab?.name) return t.lab.name.replace(/[^\w.-]+/g, '_').toLowerCase() || 'topology';
  const first = t.devices[0]?.name ?? 'topology';
  const base = t.devices.length > 1 ? `${first}+${t.devices.length - 1}` : first;
  return base.replace(/[^\w.-]+/g, '_').toLowerCase() || 'topology';
}

const SECRET_LINE = /^\s*(passphrase|peer-key)\s+\S/m;

/** Whether saved configs carry Wi-Fi passphrases or radio pairing keys (plain text in the file). */
export function topologyHasSecrets(t: Pick<Topology, 'devices'>): boolean {
  return t.devices.some((d) => (d.config !== undefined && SECRET_LINE.test(d.config)) || (d.runningConfig !== undefined && SECRET_LINE.test(d.runningConfig)));
}

const SECRET_NOTICE = 'This project keeps Wi-Fi passphrases and radio pairing keys as plain text. Share the file with care.';

/** Save the current topology as a `.netforge` archive. Exported for the Ctrl+S hotkey. */
export async function saveNetforge(): Promise<void> {
  if (!store.getState().ready) return;
  try {
    const topology = await engine.exportTopology();
    const iso = new Date().toISOString();
    const manifest: NetforgeManifest = {
      format: NETFORGE_FORMAT_VERSION,
      app: APP_ID,
      created: iso,
      modified: iso,
    };
    const bytes = writeNetforge({ manifest, topology, configs: {} });
    const ok = await saveBytes(`${projectName(topology)}.netforge`, bytes, 'application/zip', '.netforge');
    if (!ok) return;
    if (topologyHasSecrets(topology)) store.getState().toast(`Saved. ${SECRET_NOTICE}`, 'warn');
    else store.getState().toast(`Saved ${topology.devices.length} devices, ${topology.links.length} links.`);
  } catch (err) {
    reportError(err);
  }
}

export async function saveJson(): Promise<void> {
  if (!store.getState().ready) return;
  try {
    const topology = await engine.exportTopology();
    const text = topologyToJson(topology);
    const ok = await saveBytes(`${projectName(topology)}.json`, text, 'application/json', '.json');
    if (!ok) return;
    if (topologyHasSecrets(topology)) store.getState().toast(`Saved as JSON. ${SECRET_NOTICE}`, 'warn');
    else store.getState().toast('Saved topology as JSON.');
  } catch (err) {
    reportError(err);
  }
}

function problemText(p: TopologyLoadProblem): string {
  const where = p.device !== undefined ? `device ${p.device}: ` : p.link !== undefined ? `link ${p.link}: ` : '';
  return `${where}${p.message}`;
}

/** Readable text of a load failure, listing the first problems of a `TopologyLoadError`. */
export function loadFailureText(what: string, err: unknown): string {
  const e = err as Partial<EngineError> | undefined;
  const problems = e !== undefined && e !== null && Array.isArray(e.problems) ? e.problems : [];
  if (problems.length === 0) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${what} could not be opened: ${msg}`;
  }
  const shown = problems.slice(0, LOAD_PROBLEMS_SHOWN).map(problemText).join('; ');
  const more = problems.length > LOAD_PROBLEMS_SHOWN ? ` (and ${problems.length - LOAD_PROBLEMS_SHOWN} more)` : '';
  const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
  return `${what} could not be opened, ${count}: ${shown}${more}. Your workspace was left as it was.`;
}

async function openFile(file: File): Promise<void> {
  let topology: Topology;
  try {
    if (/\.json$/i.test(file.name)) {
      topology = topologyFromJson(await file.text());
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      topology = readNetforge(bytes).topology;
    }
  } catch (err) {
    store.getState().toast(loadFailureText(file.name, err), 'error');
    return;
  }
  try {
    await engine.pause();
    const snap = await engine.loadTopology(topology);
    store.getState().select(null);
    store.getState().toast(`Opened ${file.name}: ${snap.devices.length} devices, ${snap.links.length} links.`);
  } catch (err) {
    store.getState().toast(loadFailureText(file.name, err), 'error');
  }
}

async function newEmpty(): Promise<void> {
  try {
    // D2: the empty world takes the defaults of the course the learner is in (classic after a CCNA 1 lesson).
    await engine.reset(defaultSeed(), profileForCourse(store.getState().learn.lastCourse));
    store.getState().select(null);
    store.getState().setTool('select');
    store.getState().toast('New empty workspace.');
  } catch (err) {
    reportError(err);
  }
}

/** The menu label of the profile move (exported so the menu and its test agree on the wording). */
export const USE_CURRENT_DEFAULTS_LABEL = 'Use current defaults';

/**
 * @since P2 Move the world to the current defaults (D2): the worker exports it, keeps a multilayer switch routing,
 * marks it a current-defaults world and reloads it. Devices, cables and configurations stay; the epoch changes.
 */
export async function useCurrentDefaults(): Promise<void> {
  if (!store.getState().ready) return;
  try {
    await engine.pause();
    const snap = await engine.useCurrentDefaults();
    store.getState().select(null);
    store.getState().toast(`Current defaults in use: ${snap.devices.length} devices kept their configuration; spanning tree now runs on the switches.`);
  } catch (err) {
    reportError(err);
  }
}

async function newFromTemplate(meta: ScenarioMeta): Promise<void> {
  try {
    await engine.pause();
    const snap = await engine.loadScenario(meta.name);
    store.getState().select(null);
    store.getState().setTool('select');
    store.getState().toast(`Template "${meta.title}": ${snap.devices.length} devices, ${snap.links.length} links.`);
  } catch (err) {
    store.getState().toast(loadFailureText(`"${meta.title}"`, err), 'error');
  }
}

// ── template list ────────────────────────────────────────────────────────────

export interface ScenarioGroup {
  readonly category: string;
  readonly label: string;
  readonly items: readonly ScenarioMeta[];
}

const CATEGORY_ORDER: readonly string[] = ['template', 'ccna1-lab'];

function categoryLabel(category: string, items: readonly ScenarioMeta[]): string {
  if (category === 'template') return 'Templates';
  const course = items.find((m) => m.course !== undefined)?.course;
  if (category === 'ccna1-lab') return course !== undefined ? `Labs: ${course}` : 'Course labs';
  const words = category.replace(/[-_]+/g, ' ').trim();
  return words === '' ? 'Other' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Group scenarios by category: templates, course labs, then other categories alphabetically; list order kept inside. */
export function groupScenarios(list: readonly ScenarioMeta[]): ScenarioGroup[] {
  const byCategory = new Map<string, ScenarioMeta[]>();
  for (const m of list) {
    const key = typeof m.category === 'string' && m.category !== '' ? m.category : 'template';
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(m);
    else byCategory.set(key, [m]);
  }
  const rank = (c: string): number => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  return [...byCategory.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, items]) => ({ category, label: categoryLabel(category, items), items }));
}

const LEVEL_TEXT: Readonly<Record<1 | 2 | 3, string>> = { 1: 'Level 1 of 3', 2: 'Level 2 of 3', 3: 'Level 3 of 3' };

/** Second line of a template entry: description, then level, topic words and time, or why it is unavailable. */
export function scenarioSubtitle(m: ScenarioMeta): string {
  if (m.missingTypes !== undefined && m.missingTypes.length > 0) {
    return `Not available in this build: needs ${m.missingTypes.join(', ')}.`;
  }
  const facts: string[] = [];
  if (m.difficulty !== undefined) facts.push(LEVEL_TEXT[m.difficulty]);
  if (m.estimatedMinutes !== undefined) facts.push(`about ${m.estimatedMinutes} min`);
  if (m.topic !== undefined) facts.push(m.topic);
  else if (m.tags !== undefined && m.tags.length > 0) facts.push(m.tags.slice(0, 3).join(', '));
  return facts.length > 0 ? `${m.description} (${facts.join(' · ')})` : m.description;
}

export function FileMenu() {
  const ready = useStore((s) => s.ready);
  const profile = useStore((s) => profileOfSnapshot(s.snapshot));
  const fileInput = useRef<HTMLInputElement>(null);
  const [scenarios, setScenarios] = useState<ScenarioMeta[] | null>(null);

  const refreshScenarios = (): void => {
    if (!ready) return;
    engine
      .listScenarios()
      .then(setScenarios)
      .catch(() => setScenarios([]));
  };

  const groups = scenarios === null ? [] : groupScenarios(scenarios);

  return (
    <>
      <Menu label="File" onOpen={refreshScenarios} title="New, open and save projects">
        {(close) => (
          <>
            <MenuItem
              onSelect={() => {
                close();
                void newEmpty();
              }}
              disabled={!ready}
            >
              New (empty)
            </MenuItem>
            {scenarios === null && (
              <>
                <MenuHeading>New from template</MenuHeading>
                <MenuItem onSelect={() => undefined} disabled>
                  Loading templates…
                </MenuItem>
              </>
            )}
            {scenarios !== null && scenarios.length === 0 && (
              <>
                <MenuHeading>New from template</MenuHeading>
                <MenuItem onSelect={() => undefined} disabled>
                  No templates available
                </MenuItem>
              </>
            )}
            {groups.map((g) => (
              <div key={g.category} role="group" aria-label={g.label}>
                <MenuHeading>{g.label}</MenuHeading>
                {g.items.map((sc) => {
                  const missing = sc.missingTypes !== undefined && sc.missingTypes.length > 0;
                  return (
                    <MenuItem
                      key={sc.name}
                      sub={scenarioSubtitle(sc)}
                      disabled={!ready || missing}
                      onSelect={() => {
                        close();
                        void newFromTemplate(sc);
                      }}
                    >
                      {missing ? `${sc.title} (unavailable)` : sc.title}
                    </MenuItem>
                  );
                })}
              </div>
            ))}
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                close();
                fileInput.current?.click();
              }}
              disabled={!ready}
              hint="Ctrl+O"
            >
              Open .netforge / .json…
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                void saveNetforge();
              }}
              disabled={!ready}
              hint="Ctrl+S"
            >
              Save .netforge
            </MenuItem>
            <MenuItem
              onSelect={() => {
                close();
                void saveJson();
              }}
              disabled={!ready}
            >
              Save as JSON
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                close();
                void useCurrentDefaults();
              }}
              disabled={!ready || profile === 'P2'}
              sub={
                profile === 'P2'
                  ? 'Already in use in this world.'
                  : 'Keep every device and setting; switch on the defaults of the later courses, spanning tree first.'
              }
            >
              {USE_CURRENT_DEFAULTS_LABEL}
            </MenuItem>
          </>
        )}
      </Menu>
      <input
        ref={fileInput}
        type="file"
        accept=".netforge,.json,application/zip,application/json"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openFile(f);
        }}
      />
    </>
  );
}

/** Programmatic "open" for the Ctrl+O hotkey: clicks the hidden file input if mounted. */
export function requestOpenFile(): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*=".netforge"]');
  input?.click();
}
