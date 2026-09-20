/**
 * Bottom-dock terminal tab (spec §8.1): a strip of open consoles, an "Open console…"
 * menu over the snapshot's devices, and one live xterm per session. Hidden consoles stay
 * mounted (display:none) so their scrollback and line state survive tab switches.
 */
import type { DeviceSnapshot, SessionId } from '@netforge/engine';
import { Menu, MenuHeading, MenuItem } from '../app/Menu';
import { engine } from '../bridge/client';
import { store, useStore } from '../store/store';
import { TerminalTab } from './TerminalTab';
import './terminal.css';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function openConsole(device: DeviceSnapshot): Promise<void> {
  try {
    const view = await engine.cliOpen(device.id, 'console');
    store.getState().addTerminal({ session: view.id, device: device.id, title: device.name });
  } catch (err) {
    store.getState().toast(`Could not open a console on ${device.name}: ${errorText(err)}`, 'error');
  }
}

function closeConsole(session: SessionId): void {
  void engine.cliClose(session).catch(() => undefined);
  store.getState().removeTerminal(session);
}

function deviceStatus(d: DeviceSnapshot): string {
  if (!d.power) return `${d.model} · powered off`;
  if (!d.booted) return `${d.model} · starting up`;
  return `${d.model} · ready`;
}

function OpenConsoleMenu({ devices }: { devices: readonly DeviceSnapshot[] }) {
  const sorted = [...devices].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <Menu label="Open console…" align="right" className="terminal-open-menu" title="Open a console session on a device">
      {(close) =>
        sorted.length === 0 ? (
          <MenuHeading>No devices on the canvas yet</MenuHeading>
        ) : (
          <>
            <MenuHeading>Connect to</MenuHeading>
            {sorted.map((d) => (
              <MenuItem
                key={d.id}
                sub={deviceStatus(d)}
                onSelect={() => {
                  close();
                  void openConsole(d);
                }}
              >
                {d.name}
              </MenuItem>
            ))}
          </>
        )
      }
    </Menu>
  );
}

const NO_DEVICES: readonly DeviceSnapshot[] = [];

export function TerminalPanel() {
  const terminals = useStore((s) => s.terminals);
  const activeTerminal = useStore((s) => s.activeTerminal);
  const setActiveTerminal = useStore((s) => s.setActiveTerminal);
  const devices = useStore((s) => s.snapshot?.devices) ?? NO_DEVICES;
  const sessions = useStore((s) => s.snapshot?.sessions);

  return (
    <div className="terminal-panel">
      <div className="terminal-strip">
        <div className="terminal-tabs" role="tablist" aria-label="Open consoles">
          {terminals.map((t) => {
            const isActive = t.session === activeTerminal;
            const name = devices.find((d) => d.id === t.device)?.name ?? t.title;
            const busy = sessions?.find((s) => s.id === t.session)?.busy === true;
            return (
              <div key={t.session} className={`terminal-chip ${isActive ? 'is-active' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className="terminal-chip-label"
                  title={`Console on ${name} (session ${t.session}) — middle-click to close`}
                  onClick={() => setActiveTerminal(t.session)}
                  onAuxClick={(e) => {
                    if (e.button === 1) closeConsole(t.session);
                  }}
                >
                  <span className="terminal-chip-name">{name}</span>
                  <span className="terminal-chip-id">{t.session}</span>
                  {busy && <span className="terminal-chip-busy">running</span>}
                </button>
                <button
                  type="button"
                  className="terminal-chip-close"
                  aria-label={`Close the console on ${name}`}
                  title="Close this console"
                  onClick={() => closeConsole(t.session)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <div className="terminal-actions">
          <OpenConsoleMenu devices={devices} />
        </div>
      </div>
      <div className="terminal-body">
        {terminals.map((t) => (
          <TerminalTab key={t.session} tab={t} active={t.session === activeTerminal} />
        ))}
        {terminals.length === 0 && (
          <div className="terminal-empty">
            <p className="terminal-empty-title">No console is open.</p>
            <p>
              {devices.length === 0
                ? 'Place a device on the canvas, then open its console from here.'
                : 'Choose a device under “Open console…” to start a command-line session.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
