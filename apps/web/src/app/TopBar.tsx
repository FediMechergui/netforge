/**
 * Top bar (spec §8.1): file · view · simulate · playback · rate · mode · theme · help.
 *
 * The View menu carries the wireless overlay toggles (store `overlays`, persisted; every overlay has a non-colour
 * channel on the canvas), the canvas scale used for radio distances (`engine.setCanvasScale`), the dock tabs from
 * the one registry and the pane toggles. The Help list is the `HOTKEYS` table the key handler implements.
 *
 * @since P2 `CoursesButton` is the door back to the course layer (learn/LearnShell): the lesson that was open,
 * or the landing page.
 */
import { DEFAULT_METRES_PER_UNIT } from '@netforge/engine';
import { engine, defaultSeed } from '../bridge/client';
import type { PlaybackMode } from '../bridge/protocol';
import { DOCK_MIN_HEIGHT, DOCK_OPEN_HEIGHT, DOCK_TABS, INSPECTOR_HIDDEN_BELOW, INSPECTOR_OPEN_WIDTH } from '../dock/registry';
import { showDockTab } from '../shared/openDeviceSurface';
import { store, useStore } from '../store/store';
import type { ConceptTool, WirelessOverlayState } from '../store/types';
import { FileMenu } from './FileMenu';
import { HOTKEYS } from './hotkeys';
import { Menu, MenuHeading, MenuItem, MenuSeparator } from './Menu';
import { PlaybackControls, reportError, runToIdle, stepEvent, stepOneMs, togglePlay } from './PlaybackControls';

export interface OverlayMenuEntry {
  readonly key: keyof WirelessOverlayState;
  readonly label: string;
  readonly hint: string;
}

/** Wireless overlay toggles, in menu order (exhaustive over `WirelessOverlayState`). */
export const OVERLAY_MENU: readonly OverlayMenuEntry[] = Object.freeze([
  { key: 'rangeRings', label: 'Radio range rings', hint: 'A dashed circle shows how far each radio reaches.' },
  { key: 'associationLines', label: 'Wireless connection lines', hint: 'A line from each client to its access point or tower, with a phase badge.' },
  { key: 'signalBars', label: 'Signal bars and levels', hint: 'Bar count and dBm next to each wireless connection.' },
  { key: 'radioBeams', label: 'Point-to-point radio beams', hint: 'A beam between paired bridge radios.' },
  { key: 'channelLabels', label: 'Channel labels', hint: 'Band and channel under each radio.' },
  { key: 'backgroundFrames', label: 'Background frames', hint: 'Animate keepalives and beacons as well.' },
]);

/** Canvas scale presets (metres per canvas unit). */
export const CANVAS_SCALE_PRESETS: readonly number[] = Object.freeze([0.1, 0.25, 0.5, 1, 2]);

export interface ConceptMenuEntry {
  readonly tool: ConceptTool;
  readonly label: string;
  readonly hint: string;
}

/** @since P1 Full-screen concept tools (§4.13); the canvas stays mounted behind them. */
export const CONCEPT_MENU: readonly ConceptMenuEntry[] = Object.freeze([
  { tool: 'subnetting', label: 'Subnetting workbench', hint: 'Masks, host counts and VLSM practice.' },
  { tool: 'ipv6', label: 'IPv6 explorer', hint: 'Compression steps and EUI-64 addresses.' },
]);

/** @since P1 What `stepToNext` reports when it found no matching event (§4.11 item 4). */
export function stepEndedText(ended: 'horizon' | 'maxEvents' | 'idle' | undefined): string {
  if (ended === 'idle') return 'Nothing else is scheduled, so there is no next event.';
  if (ended === 'maxEvents') return 'Many events went by without a match; step again to carry on.';
  return 'No matching event in the next 10 s.';
}

function Brand() {
  return (
    <span className="brand" title="NetForge — browser network simulator">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="4" cy="10" r="2.4" fill="var(--accent)" />
        <circle cx="16" cy="4.5" r="2.4" fill="var(--ok)" />
        <circle cx="16" cy="15.5" r="2.4" fill="var(--purple)" />
        <path d="M6 9.2 L14 5.4 M6 10.8 L14 14.6" stroke="var(--text-dim)" strokeWidth="1.5" fill="none" />
      </svg>
      NetForge
    </span>
  );
}

/**
 * @since P2 The way back into the course layer from the sandbox: the lesson you were reading if there is one,
 * the landing page otherwise. Absent in a shell whose store has no learn slice yet (transition rule).
 */
function CoursesButton() {
  const showLearn = useStore((s) => s.showLearn);
  const lessonId = useStore((s) => s.learn?.lessonId ?? null);
  if (showLearn === undefined) return null;
  return (
    <button type="button" className="btn btn-ghost" title="Theory, a video and the lab that goes with each lesson" onClick={() => showLearn(lessonId === null ? 'landing' : 'lesson')}>
      {lessonId === null ? 'Courses' : 'Back to the lesson'}
    </button>
  );
}

async function resetWithNewSeed(): Promise<void> {
  try {
    await engine.reset(defaultSeed());
    store.getState().select(null);
    store.getState().toast('Workspace reset with a fresh seed.');
  } catch (err) {
    reportError(err);
  }
}

async function applyCanvasScale(metresPerUnit: number): Promise<void> {
  try {
    await engine.setCanvasScale(metresPerUnit);
    store.getState().toast(`Canvas scale: 1 unit = ${metresPerUnit} m.`);
  } catch (err) {
    reportError(err);
  }
}

/**
 * @since P1 Switch playback mode (§4.11). Simulation mode pauses the clock, so the filters the chips hold are sent
 * with the switch and the sim-events list is brought up: the learner lands on the panel they are about to use.
 */
export async function applyPlaybackMode(mode: PlaybackMode): Promise<void> {
  try {
    await engine.setPlaybackMode(mode);
    if (mode === 'simulation') {
      const { list, breakOn } = store.getState().simMode;
      await engine.setSimFilters({ list, breakOn });
      showDockTab('sim-events');
      store.getState().toast('Simulation mode: the clock stops at the events you are watching.');
    } else {
      store.getState().toast('Real-time mode: the clock runs on.');
    }
  } catch (err) {
    reportError(err);
  }
}

/** @since P1 Advance to the next event matching the sim-events filter, or say why there was none. */
export async function stepToNextEvent(): Promise<void> {
  try {
    const result = await engine.stepToNext();
    if (result.stopped === null) store.getState().toast(stepEndedText(result.ended), 'warn');
  } catch (err) {
    reportError(err);
  }
}

/** @since P1 Grade the loaded lab now (§4.13); the Labs panel shows the task detail. */
export async function checkLabNow(): Promise<void> {
  try {
    const status = await engine.checkLab();
    if (status === null) store.getState().toast('No lab is loaded; open one from the Labs tab.', 'warn');
    else store.getState().toast(`Lab check: ${status.score} of ${status.total} points.`);
  } catch (err) {
    reportError(err);
  }
}

interface CheckItemProps {
  checked: boolean;
  label: string;
  hint: string;
  onToggle: () => void;
}

/** A menu entry that toggles in place (the menu stays open); state is shown by a glyph and by text. */
function CheckItem({ checked, label, hint, onToggle }: CheckItemProps) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} className="menu-item" title={hint} onClick={onToggle}>
      <span>
        <span aria-hidden="true">{checked ? '☑' : '☐'}</span> {label}
      </span>
      <span className="hint">{checked ? 'on' : 'off'}</span>
    </button>
  );
}

function ViewMenu() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const colourByFlow = useStore((s) => s.colourByFlow);
  const setColourByFlow = useStore((s) => s.setColourByFlow);
  const dockHeight = useStore((s) => s.dockHeight);
  const setDockHeight = useStore((s) => s.setDockHeight);
  const inspectorWidth = useStore((s) => s.inspectorWidth);
  const setInspectorWidth = useStore((s) => s.setInspectorWidth);
  const overlays = useStore((s) => s.overlays);
  const setOverlay = useStore((s) => s.setOverlay);
  const ready = useStore((s) => s.ready);
  const scale = useStore((s) => s.snapshot?.media?.metresPerUnit ?? DEFAULT_METRES_PER_UNIT);
  const view = useStore((s) => s.view);
  const conceptTool = useStore((s) => s.conceptTool);
  const setView = useStore((s) => s.setView);
  const dockHidden = dockHeight <= DOCK_MIN_HEIGHT;
  const inspectorHidden = inspectorWidth < INSPECTOR_HIDDEN_BELOW;

  return (
    <Menu label="View" title="Theme, panels and overlays">
      {(close) => (
        <>
          <MenuItem
            onSelect={() => {
              close();
              setTheme(theme === 'dark' ? 'light' : 'dark');
            }}
          >
            {theme === 'dark' ? '☼ Switch to light theme' : '☾ Switch to dark theme'}
          </MenuItem>
          <CheckItem
            checked={colourByFlow}
            label="Colour packets by conversation"
            hint="Packets of one conversation share a colour; their letters and shapes stay the same."
            onToggle={() => setColourByFlow(!colourByFlow)}
          />
          <MenuSeparator />
          <MenuHeading>Wireless overlays</MenuHeading>
          {OVERLAY_MENU.map((o) => (
            <CheckItem key={o.key} checked={overlays[o.key]} label={o.label} hint={o.hint} onToggle={() => setOverlay(o.key, !overlays[o.key])} />
          ))}
          <MenuHeading>Canvas scale</MenuHeading>
          {CANVAS_SCALE_PRESETS.map((m) => (
            <MenuItem
              key={m}
              disabled={!ready}
              hint={m === scale ? 'current' : undefined}
              onSelect={() => {
                close();
                if (m !== scale) void applyCanvasScale(m);
              }}
            >
              <span aria-hidden="true">{m === scale ? '●' : '○'}</span> 1 unit = {m} m
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuHeading>Concept tools</MenuHeading>
          {CONCEPT_MENU.map((c) => (
            <MenuItem
              key={c.tool}
              hint={view === 'concept' && conceptTool === c.tool ? 'open' : undefined}
              onSelect={() => {
                close();
                setView('concept', c.tool);
              }}
            >
              {c.label}
            </MenuItem>
          ))}
          {view === 'concept' && (
            <MenuItem
              onSelect={() => {
                close();
                setView('topology');
              }}
            >
              Back to the topology
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuHeading>Bottom dock</MenuHeading>
          {DOCK_TABS.map((t) => (
            <MenuItem
              key={t.id}
              hint={t.hotkey}
              onSelect={() => {
                close();
                showDockTab(t.id);
              }}
            >
              {t.label}
            </MenuItem>
          ))}
          <MenuItem
            onSelect={() => {
              close();
              setDockHeight(dockHidden ? DOCK_OPEN_HEIGHT : 0);
            }}
          >
            {dockHidden ? 'Show the dock' : 'Hide the dock'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              close();
              setInspectorWidth(inspectorHidden ? INSPECTOR_OPEN_WIDTH : 0);
            }}
          >
            {inspectorHidden ? 'Show the inspector' : 'Hide the inspector'}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function SimulateMenu() {
  const playing = useStore((s) => s.playing);
  const ready = useStore((s) => s.ready);
  const mode = useStore((s) => s.simMode.mode);
  const simulation = mode === 'simulation';
  return (
    <Menu label="Simulate" title="Clock and run control">
      {(close) => (
        <>
          <MenuItem
            hint="Space"
            disabled={!ready}
            onSelect={() => {
              close();
              void togglePlay();
            }}
          >
            {playing ? 'Pause' : 'Play'}
          </MenuItem>
          <MenuItem
            hint="."
            disabled={!ready}
            onSelect={() => {
              close();
              void stepEvent();
            }}
          >
            Step one event
          </MenuItem>
          <MenuItem
            disabled={!ready}
            onSelect={() => {
              close();
              void stepOneMs();
            }}
          >
            Advance 1 ms
          </MenuItem>
          <MenuItem
            disabled={!ready}
            onSelect={() => {
              close();
              void runToIdle();
            }}
          >
            Run to idle
          </MenuItem>
          <MenuSeparator />
          <MenuHeading>Simulation mode</MenuHeading>
          <CheckItem
            checked={simulation}
            label="Stop at the events I am watching"
            hint="Pauses the clock and steps event by event; breakpoints come from the Sim events tab."
            onToggle={() => void applyPlaybackMode(simulation ? 'realtime' : 'simulation')}
          />
          <MenuItem
            disabled={!ready || !simulation}
            onSelect={() => {
              close();
              void stepToNextEvent();
            }}
          >
            Step to the next matching event
          </MenuItem>
          <MenuItem
            disabled={!ready}
            onSelect={() => {
              close();
              void checkLabNow();
            }}
          >
            Check the lab now
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={!ready}
            onSelect={() => {
              close();
              void resetWithNewSeed();
            }}
          >
            Reset with a new seed
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function HelpMenu() {
  return (
    <Menu label="Help" align="right" title="Shortcuts">
      <MenuHeading>Keyboard</MenuHeading>
      <div className="help-list">
        {HOTKEYS.map((h) => (
          <span key={h.keys} style={{ display: 'contents' }}>
            <kbd>{h.keys}</kbd>
            <span>{h.action}</span>
          </span>
        ))}
      </div>
      <MenuSeparator />
      <MenuHeading>Getting started</MenuHeading>
      <div className="help-list" style={{ gridTemplateColumns: '1fr' }}>
        <span>
          Pick a device on the left, click the canvas to place it. Use the cable tool to join two ports, open a console
          or a settings panel from the inspector, configure addresses and ping. Press play to watch the frames travel.
          The canvas can also be driven from the keyboard: Tab into it and use the arrow keys.
        </span>
      </div>
    </Menu>
  );
}

export function TopBar() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const seed = useStore((s) => s.snapshot?.seed);

  return (
    <header className="topbar app-top">
      <Brand />
      <CoursesButton />
      <FileMenu />
      <ViewMenu />
      <SimulateMenu />
      <span className="sep" />
      <PlaybackControls />
      <span className="spacer" />
      <span className="mode-label" title="Fidelity mode and seed">
        mode <b>simulation</b>
        {seed !== undefined && (
          <>
            · seed <b className="mono">{seed}</b>
          </>
        )}
      </span>
      <button
        type="button"
        className="btn btn-icon btn-ghost"
        title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        aria-label="Toggle theme"
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? '☼' : '☾'}
      </button>
      <HelpMenu />
    </header>
  );
}
