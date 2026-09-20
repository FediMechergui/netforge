/**
 * `openDeviceSurface` (ARCHITECTURE-P1 §7 "Shell": one openDeviceSurface): the pure resolver and the store effects,
 * with the engine mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_MESSAGES } from '@netforge/engine';
import type { SimSnapshot } from '@netforge/engine';

const engineMock = vi.hoisted(() => ({
  cliCanOpen: vi.fn(async (_d: string, _v: string) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
  cliOpen: vi.fn(async (d: string, _v: string) => ({ id: `s_${d}`, device: d })),
}));
vi.mock('../src/bridge/client', () => ({ engine: engineMock }));

const { openDeviceSurface, resolveDeviceSurface, SURFACE_PANEL_TAB } = await import('../src/shared/openDeviceSurface');
const { store } = await import('../src/store/store');
const { GUI_PANELS } = await import('@netforge/engine');

const pc = { id: 'pc1', name: 'PC1', ports: [], cli: { shell: 'host', grammar: 'host' }, gui: ['desktop.ip-config', 'desktop.command-prompt'] };
const router = { id: 'r1', name: 'R1', ports: [], cli: { shell: 'nfos', grammar: 'nfos' }, gui: ['physical'] };
const home = { id: 'h1', name: 'HOME1', ports: [], cli: { shell: 'none', grammar: 'nfos' }, gui: ['home-router.setup'] };
const legacy = { id: 'x1', name: 'X1', ports: [] };

function load(): void {
  const snapshot = { now: 0, seed: 1, topologyVersion: 1, devices: [pc, router, home, legacy], links: [], inflight: [], sessions: [{ id: 's_r1' }], pduCount: 0, pendingEvents: 0 };
  store.getState().applyBatch({ epoch: 500, now: 0, events: [], playing: false, rate: 1, effectiveRate: 1, dropped: 0, snapshot: snapshot as unknown as SimSnapshot });
}

describe('resolveDeviceSurface', () => {
  it('maps every GUI panel to a tab or a window', () => {
    for (const id of GUI_PANELS) expect(SURFACE_PANEL_TAB[id]).toBeDefined();
    expect(resolveDeviceSurface(pc as never, 'desktop.ip-config')).toEqual({ kind: 'window', app: 'desktop.ip-config' });
    expect(resolveDeviceSurface(home as never, 'home-router.setup')).toEqual({ kind: 'tab', tab: 'wireless' });
    expect(resolveDeviceSurface(router as never, 'physical')).toEqual({ kind: 'tab', tab: 'physical' });
    expect(resolveDeviceSurface(router as never, 'config')).toEqual({ kind: 'tab', tab: 'config' });
  });

  it('refuses panels the device does not offer and consoles on shell-less devices', () => {
    expect(resolveDeviceSurface(router as never, 'desktop.wifi')).toMatchObject({ kind: 'unavailable' });
    const r = resolveDeviceSurface(home as never, 'console');
    expect(r.kind).toBe('unavailable');
    expect(r.kind === 'unavailable' && r.reason.startsWith(CLI_MESSAGES.noShell)).toBe(true);
    expect(r.kind === 'unavailable' && r.reason).toContain('Router setup');
  });

  it('picks a natural default without looking at the device kind', () => {
    expect(resolveDeviceSurface(pc as never, 'default')).toEqual({ kind: 'tab', tab: 'desktop' });
    expect(resolveDeviceSurface(router as never, 'default')).toEqual({ kind: 'console' });
    expect(resolveDeviceSurface(home as never, 'default')).toEqual({ kind: 'tab', tab: 'wireless' });
    // P0-shaped snapshots (no cli/gui) keep the console.
    expect(resolveDeviceSurface(legacy as never, 'default')).toEqual({ kind: 'console' });
    expect(resolveDeviceSurface(legacy as never, 'desktop.wifi')).toEqual({ kind: 'window', app: 'desktop.wifi' });
  });
});

describe('openDeviceSurface', () => {
  beforeEach(() => {
    load();
    engineMock.cliCanOpen.mockClear();
    engineMock.cliOpen.mockClear();
    store.getState().select(null);
    store.getState().setDockHeight(0);
    store.getState().setInspectorWidth(0);
  });

  it('opens a console once, then brings the same tab back', async () => {
    const out = await openDeviceSurface('r1', 'console');
    expect(out.ok).toBe(true);
    expect(engineMock.cliOpen).toHaveBeenCalledTimes(1);
    let st = store.getState();
    expect(st.terminals.some((t) => t.session === 's_r1' && t.title === 'R1')).toBe(true);
    expect(st.dockTab).toBe('terminal');
    expect(st.dockHeight).toBeGreaterThan(30);

    store.getState().setDockTab('events');
    await openDeviceSurface('r1', 'console');
    st = store.getState();
    expect(engineMock.cliOpen).toHaveBeenCalledTimes(1);
    expect(st.activeTerminal).toBe('s_r1');
    expect(st.dockTab).toBe('terminal');
  });

  it('reports refusals as a toast and an announcement', async () => {
    engineMock.cliCanOpen.mockResolvedValueOnce({ ok: false, reason: 'Nope.' });
    const out = await openDeviceSurface('pc1', 'console');
    expect(out).toEqual({ ok: false, reason: 'Nope.' });
    expect(store.getState().toastMessage?.text).toBe('Nope.');
    expect(store.getState().a11y.announcement?.text).toBe('Nope.');

    const gone = await openDeviceSurface('ghost', 'overview');
    expect(gone.ok).toBe(false);
    const none = await openDeviceSurface('h1', 'console');
    expect(none.ok).toBe(false);
    expect(engineMock.cliOpen).not.toHaveBeenCalled();
  });

  it('opens settings tabs with the device selected and the inspector shown', async () => {
    const out = await openDeviceSurface('h1', 'home-router.setup');
    expect(out).toEqual({ ok: true, surface: { kind: 'tab', tab: 'wireless' } });
    const st = store.getState();
    expect(st.selection).toEqual({ kind: 'device', id: 'h1' });
    expect(st.inspectorTab).toBe('wireless');
    expect(st.inspectorWidth).toBeGreaterThan(40);
  });

  it('opens Desktop apps in floating windows and keeps a port selection of the same device', async () => {
    store.getState().select({ kind: 'port', ref: { device: 'pc1', port: 'GigabitEthernet0' } });
    const out = await openDeviceSurface('pc1', 'desktop.command-prompt');
    expect(out.ok).toBe(true);
    const st = store.getState();
    expect(st.selection).toEqual({ kind: 'port', ref: { device: 'pc1', port: 'GigabitEthernet0' } });
    expect(st.inspectorTab).toBe('desktop');
    expect(st.desktopWindows.some((w) => w.device === 'pc1' && w.app === 'desktop.command-prompt')).toBe(true);
  });
});
