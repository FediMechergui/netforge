/**
 * The one way to open something about a device (ARCHITECTURE-P1 §7 "Shell": one openDeviceSurface).
 *
 * Canvas double-clicks, inspector buttons, the keyboard outline, menus and Desktop app launchers all call
 * `openDeviceSurface(device, surface)` instead of wiring terminals, inspector tabs and floating windows
 * themselves. A surface is:
 *   - 'console'            a console session in the Terminal dock tab (an existing tab for the device is reused);
 *   - an `InspectorTab`    that tab of the inspector, with the device selected;
 *   - a `GuiPanelId`       a Desktop app in a floating window (desktop-app panels) or the inspector tab that hosts
 *                          a settings panel;
 *   - 'default'            the device's natural surface: its Desktop, else its console, else its first settings
 *                          panel, else the overview.
 * Nothing here branches on `DeviceSnapshot.kind`: the decision uses `cli.shell`, `gui` and the panel vocabulary.
 * Hidden panes are revealed (a collapsed dock opens, a hidden inspector gets its width back) and every outcome is
 * announced to screen readers.
 */
import { CLI_MESSAGES, GUI_PANELS } from '@netforge/engine';
import type { DeviceId, DeviceSnapshot, GuiPanelId } from '@netforge/engine';
import { engine } from '../bridge/client';
import { DOCK_MIN_HEIGHT, DOCK_OPEN_HEIGHT, INSPECTOR_HIDDEN_BELOW, INSPECTOR_OPEN_WIDTH } from '../dock/registry';
import { selectDevice } from '../store/selectors';
import { store } from '../store/store';
import type { DockTab, InspectorTab } from '../store/types';
import { GUI_PANEL_VOCAB } from '../vocab/categories';

export type DeviceSurface = 'default' | 'console' | InspectorTab | GuiPanelId;

/** What `surface` means for a given device. */
export type ResolvedSurface =
  | { readonly kind: 'console' }
  | { readonly kind: 'tab'; readonly tab: InspectorTab }
  | { readonly kind: 'window'; readonly app: GuiPanelId }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type SurfaceOutcome = { readonly ok: true; readonly surface: ResolvedSurface } | { readonly ok: false; readonly reason: string };

/** Inspector tab that hosts each GUI panel (settings panels of network appliances share the 'wireless' tab). */
export const SURFACE_PANEL_TAB: Readonly<Record<GuiPanelId, InspectorTab>> = Object.freeze({
  physical: 'physical',
  'desktop.ip-config': 'desktop',
  'desktop.wifi': 'desktop',
  'desktop.cellular': 'desktop',
  'desktop.command-prompt': 'desktop',
  'desktop.web-browser': 'desktop',
  services: 'services',
  'wireless.ap': 'wireless',
  'home-router.setup': 'wireless',
  'radio.link': 'wireless',
  'cell.tower': 'wireless',
  'modem.status': 'wireless',
});

const INSPECTOR_TABS: readonly InspectorTab[] = ['overview', 'ports', 'config', 'tables', 'processes', 'physical', 'desktop', 'wireless', 'services'];

function isGuiPanel(s: string): s is GuiPanelId {
  return (GUI_PANELS as readonly string[]).includes(s);
}

function isInspectorTab(s: string): s is InspectorTab {
  return (INSPECTOR_TABS as readonly string[]).includes(s);
}

type SurfaceDevice = Pick<DeviceSnapshot, 'name' | 'cli' | 'gui'>;

function hasShell(device: SurfaceDevice): boolean {
  return device.cli === undefined || device.cli.shell !== 'none';
}

/** Where the settings of a device without a command line live, for the refusal text. */
function settingsHint(device: SurfaceDevice): string {
  const panel = (device.gui ?? []).find((g) => GUI_PANEL_VOCAB[g].placement === 'inspector-tab');
  return panel === undefined ? '' : ` Its settings are under ${GUI_PANEL_VOCAB[panel].label} in the inspector.`;
}

/** Pure: decide what opening `surface` on `device` does. */
export function resolveDeviceSurface(device: SurfaceDevice, surface: DeviceSurface): ResolvedSurface {
  if (surface === 'console') {
    return hasShell(device) ? { kind: 'console' } : { kind: 'unavailable', reason: `${CLI_MESSAGES.noShell}${settingsHint(device)}` };
  }
  if (surface === 'default') {
    const gui = device.gui ?? [];
    if (gui.some((g) => GUI_PANEL_VOCAB[g].placement === 'desktop-app')) return { kind: 'tab', tab: 'desktop' };
    if (hasShell(device)) return { kind: 'console' };
    const settings = gui.find((g) => GUI_PANEL_VOCAB[g].placement === 'inspector-tab');
    return { kind: 'tab', tab: settings === undefined ? 'overview' : SURFACE_PANEL_TAB[settings] };
  }
  // 'physical' and 'services' are both panels and tabs: the panel rules below give the same tab.
  if (isGuiPanel(surface)) {
    if (device.gui !== undefined && !device.gui.includes(surface)) {
      return { kind: 'unavailable', reason: `${device.name} has no ${GUI_PANEL_VOCAB[surface].label} panel.` };
    }
    if (GUI_PANEL_VOCAB[surface].placement === 'desktop-app') return { kind: 'window', app: surface };
    return { kind: 'tab', tab: SURFACE_PANEL_TAB[surface] };
  }
  if (isInspectorTab(surface)) return { kind: 'tab', tab: surface };
  return { kind: 'unavailable', reason: `There is nothing called "${String(surface)}" to open.` };
}

/** Bring a dock tab to the front, opening the dock when it is collapsed. */
export function showDockTab(tab: DockTab): void {
  const st = store.getState();
  st.setDockTab(tab);
  if (st.dockHeight <= DOCK_MIN_HEIGHT) st.setDockHeight(DOCK_OPEN_HEIGHT);
}

/** Show the inspector when it was dragged shut. */
export function showInspector(): void {
  const st = store.getState();
  if (st.inspectorWidth < INSPECTOR_HIDDEN_BELOW) st.setInspectorWidth(INSPECTOR_OPEN_WIDTH);
}

function selectDeviceFor(device: DeviceId): void {
  const st = store.getState();
  const sel = st.selection;
  // A port or slot of the same device stays selected: it already shows that device.
  const keeps = sel !== null && ((sel.kind === 'device' && sel.id === device) || (sel.kind === 'port' && sel.ref.device === device) || (sel.kind === 'slot' && sel.device === device));
  if (!keeps) st.select({ kind: 'device', id: device });
}

const pendingConsoles = new Map<DeviceId, Promise<SurfaceOutcome>>();

async function openConsoleFor(device: DeviceId, name: string): Promise<SurfaceOutcome> {
  const existing = store.getState().terminals.find((t) => t.device === device);
  if (existing !== undefined) {
    store.getState().setActiveTerminal(existing.session);
    showDockTab('terminal');
    store.getState().announce(`Console of ${name} is in front.`);
    return { ok: true, surface: { kind: 'console' } };
  }
  const running = pendingConsoles.get(device);
  if (running !== undefined) return running;
  const task = (async (): Promise<SurfaceOutcome> => {
    const can = await engine.cliCanOpen(device, 'console');
    if (!can.ok) return { ok: false, reason: can.reason };
    const view = await engine.cliOpen(device, 'console');
    store.getState().addTerminal({ session: view.id, device, title: name });
    showDockTab('terminal');
    store.getState().announce(`Console of ${name} opened.`);
    return { ok: true, surface: { kind: 'console' } };
  })();
  pendingConsoles.set(device, task);
  try {
    return await task;
  } finally {
    pendingConsoles.delete(device);
  }
}

/**
 * Open `surface` on `device`. Resolves with the outcome; refusals and engine errors are also shown as a toast, so
 * callers may ignore the result.
 */
export async function openDeviceSurface(device: DeviceId, surface: DeviceSurface = 'default'): Promise<SurfaceOutcome> {
  const fail = (reason: string): SurfaceOutcome => {
    store.getState().toast(reason, 'warn');
    store.getState().announce(reason);
    return { ok: false, reason };
  };
  const snap = selectDevice(store.getState(), device);
  if (snap === undefined) return fail('That device is no longer in the workspace.');
  const resolved = resolveDeviceSurface(snap, surface);
  switch (resolved.kind) {
    case 'unavailable':
      return fail(resolved.reason);
    case 'console': {
      try {
        const out = await openConsoleFor(device, snap.name);
        return out.ok ? out : fail(out.reason);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    case 'tab': {
      selectDeviceFor(device);
      const st = store.getState();
      st.setInspectorTab(resolved.tab);
      showInspector();
      st.announce(`${snap.name}: ${resolved.tab} tab.`);
      return { ok: true, surface: resolved };
    }
    case 'window': {
      selectDeviceFor(device);
      const st = store.getState();
      st.setInspectorTab('desktop');
      st.openDesktopWindow(device, resolved.app);
      st.announce(`${GUI_PANEL_VOCAB[resolved.app].label} opened on ${snap.name}.`);
      return { ok: true, surface: resolved };
    }
  }
}
