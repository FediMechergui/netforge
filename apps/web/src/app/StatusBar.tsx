/**
 * Bottom status bar: counts, pending events, dropped/left-out trace warnings, tool and selection summary,
 * canvas scale and camera zoom. Device names are looked up through the snapshot index.
 *
 * P2 (ARCHITECTURE-P2 D2; W2 web-shell): a world built with the classic ('P1') defaults — a saved file, a template, a
 * CCNA 1 lab, a sandbox opened from a CCNA 1 lesson — shows the "Classic defaults" chip; File → "Use current
 * defaults" moves it on. A world with the current defaults shows nothing, so the common case stays quiet.
 */
import type { Selection, SimSnapshot } from '@netforge/engine';
import { selectDevice } from '../store/selectors';
import { useStore } from '../store/store';

/** @since P2 The chip of a classic-defaults world, or null for a world with the current defaults (or none yet). */
export function classicDefaultsChip(snapshot: Pick<SimSnapshot, 'profile'> | null | undefined): { readonly label: string; readonly hint: string } | null {
  if (snapshot === null || snapshot === undefined || snapshot.profile === 'P2') return null;
  return {
    label: 'Classic defaults',
    hint: 'This world keeps the defaults of the first course: no spanning tree until you switch it on. File → "Use current defaults" brings in the newer ones.',
  };
}

function selectionText(sel: Selection | null, deviceName: (id: string) => string): string {
  if (!sel) return 'nothing selected';
  switch (sel.kind) {
    case 'device':
      return `device ${deviceName(sel.id)}`;
    case 'link':
      return `link ${sel.id}`;
    case 'port':
      return `port ${deviceName(sel.ref.device)} · ${sel.ref.port}`;
    case 'pdu':
      return `packet #${sel.id}`;
    case 'session':
      return `console ${sel.id}`;
    case 'association':
      return `wireless connection ${sel.id}`;
    case 'slot':
      return `slot ${sel.slot} of ${deviceName(sel.device)}`;
  }
}

export function StatusBar() {
  const ready = useStore((s) => s.ready);
  const devices = useStore((s) => s.snapshot?.devices.length ?? 0);
  const links = useStore((s) => s.snapshot?.links.length ?? 0);
  const pending = useStore((s) => s.snapshot?.pendingEvents ?? 0);
  const pduCount = useStore((s) => s.snapshot?.pduCount ?? 0);
  const inflight = useStore((s) => s.inflight.length);
  const dropped = useStore((s) => s.droppedEvents);
  const tool = useStore((s) => s.tool);
  const addDeviceType = useStore((s) => s.addDeviceType);
  const pendingCable = useStore((s) => s.pendingCable);
  const zoom = useStore((s) => s.camera.zoom);
  const seed = useStore((s) => s.snapshot?.seed);
  const selection = useStore((s) => s.selection);
  const truncated = useStore((s) => s.eventsTruncated);
  const metresPerUnit = useStore((s) => s.snapshot?.media?.metresPerUnit);
  const snapshot = useStore((s) => s.snapshot);
  const snapshotIndex = useStore((s) => s.snapshotIndex);
  const classic = classicDefaultsChip(snapshot);

  const deviceName = (id: string): string => selectDevice({ snapshot, snapshotIndex }, id)?.name ?? id;

  let toolText: string;
  if (tool === 'add-device') toolText = `place ${addDeviceType ?? 'device'} — click the canvas`;
  else if (tool === 'cable') toolText = pendingCable ? `cable from ${deviceName(pendingCable.from.device)} · ${pendingCable.from.port} — pick the other port` : 'cable — click a port';
  else if (tool === 'pan') toolText = 'pan';
  else toolText = 'select';

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="item" title="Engine state">
        <span className={ready ? 'ok' : 'warn'}>{ready ? '●' : '○'}</span> {ready ? 'engine ready' : 'engine starting'}
      </span>
      <span className="item">
        devices <b>{devices}</b>
      </span>
      <span className="item">
        links <b>{links}</b>
      </span>
      <span className="item" title="Scheduler events waiting">
        pending <b>{pending}</b>
      </span>
      <span className="item" title="Frames currently animating">
        on wire <b>{inflight}</b>
      </span>
      <span className="item" title="PDUs created so far">
        pdus <b>{pduCount}</b>
      </span>
      {seed !== undefined && (
        <span className="item" title="Simulation seed">
          seed <b>{seed}</b>
        </span>
      )}
      {classic !== null && (
        <span className="item" title={classic.hint} data-testid="classic-defaults">
          {classic.label}
        </span>
      )}
      {dropped > 0 && (
        <span className="item warn" title="The trace ring overflowed; some events never reached the UI">
          ⚠ {dropped} trace events dropped
        </span>
      )}
      {truncated > 0 && (
        <span className="item warn" title="Busy batches were trimmed; the Events tab shows the newest events only">
          ⚠ {truncated} events left out
        </span>
      )}
      <span className="spacer" />
      <span className="item ellipsis" title="Active tool">
        {toolText}
      </span>
      <span className="item ellipsis" title="Selection">
        {selectionText(selection, deviceName)}
      </span>
      {metresPerUnit !== undefined && (
        <span className="item" title="Canvas scale used for wireless distances">
          1 unit = <b>{metresPerUnit}</b> m
        </span>
      )}
      <span className="item" title="Canvas zoom">
        <b>{Math.round(zoom * 100)}%</b>
      </span>
    </footer>
  );
}
