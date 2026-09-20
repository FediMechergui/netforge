/**
 * Desktop "Mobile data" app (ARCHITECTURE-P1 §7 Desktop tab, §3.8). One card per cellular adapter: the attach
 * phase from the `cell-client` StateView, the serving tower, signal bars and rate from the cellular association
 * in `SimSnapshot.media`, the adapter address, and a switch that turns mobile data on or off through
 * `EngineApi.configure` (gui/commands `portAdminCommands`). Wording is original (§1.6).
 */
import { useId, useState } from 'react';
import type { AssociationSnapshot, DeviceSnapshot, PortSnapshot } from '@netforge/engine';
import { useStore } from '../../store/store';
import { portAdminCommands } from '../../gui/commands.js';
import { deviceGrammar } from '../../gui/forms.js';
import {
  DeviceGone,
  FormStatus,
  InfoRow,
  SignalBars,
  deviceBusyReason,
  formatRate,
  outcomeMessages,
  portRefName,
  processPortRow,
  processState,
  submitPlan,
  useDeviceById,
} from '../shared.js';
import type { DesktopAppProps } from '../shared.js';

/** Cellular client daemon (StateView `{ ports: CellClientPortView[] }`). */
export const CELL_CLIENT = 'cell-client';

/** Cellular adapters of a device: cellular ports in the UE role (radio mode 'ue'). */
export function cellularAdapters(device: Pick<DeviceSnapshot, 'ports'>): readonly PortSnapshot[] {
  return device.ports.filter((p) => p.kind === 'cellular' && (p.role === 'cellular' || p.radio?.mode === 'ue'));
}

/** Sentence for a cellular adapter (glyph + words). `towerName` is the display name of the serving tower. */
export function cellularStateText(opts: {
  adminUp: boolean;
  phase?: string | undefined;
  state?: string | undefined;
  towerName?: string | undefined;
  reason?: string | null | undefined;
}): { glyph: string; text: string } {
  if (!opts.adminUp) return { glyph: '⊘', text: 'Mobile data is off.' };
  const phase = opts.phase ?? opts.state;
  switch (phase) {
    case 'attached':
      return { glyph: '✓', text: opts.towerName !== undefined ? `Connected through ${opts.towerName}.` : 'Connected to the mobile network.' };
    case 'attaching':
      return { glyph: '…', text: 'Connecting to the tower.' };
    case 'searching':
      return { glyph: '…', text: 'Searching for a tower.' };
    case 'detached':
      return { glyph: '✕', text: `No service${reasonText(opts.reason)}. Searching again shortly.` };
    case 'disabled':
      return { glyph: '⊘', text: 'Mobile data is off.' };
    default:
      return { glyph: '○', text: 'Waiting for the adapter to start.' };
  }
}

function reasonText(reason: string | null | undefined): string {
  if (reason === null || reason === undefined || reason === '') return '';
  if (reason === 'out-of-range') return ' (out of range)';
  if (reason === 'power-off' || reason === 'radio-down' || reason === 'tower-down') return ' (the tower is not transmitting)';
  return ` (${reason})`;
}

export function CellularApp({ deviceId }: DesktopAppProps) {
  const device = useDeviceById(deviceId);
  if (device === undefined) return <DeviceGone />;
  const adapters = cellularAdapters(device);
  if (adapters.length === 0) return <p className="desk-empty">This device has no mobile data adapter.</p>;
  return (
    <div className="desk-app">
      {adapters.map((p) => (
        <CellularCard key={p.id} device={device} port={p} />
      ))}
    </div>
  );
}

function CellularCard({ device, port }: { device: DeviceSnapshot; port: PortSnapshot }) {
  const uid = useId();
  const association = useStore((s) => findCellAssociation(s.snapshot?.media?.associations, device.id, port.id));
  const towerName = useStore((s) => {
    const row = processPortRow(processState(device, CELL_CLIENT), port.id);
    const tower = row?.['tower'];
    if (typeof tower === 'string' && tower !== '') return portRefName(s.snapshot, s.snapshotIndex, tower);
    if (association?.ap !== undefined) return portRefName(s.snapshot, s.snapshotIndex, association.ap);
    return undefined;
  });
  const row = processPortRow(processState(device, CELL_CLIENT), port.id);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<readonly string[]>([]);
  const blocked = deviceBusyReason(device);

  const status = cellularStateText({
    adminUp: port.adminUp,
    phase: typeof row?.['phase'] === 'string' ? (row['phase'] as string) : undefined,
    state: association?.state,
    towerName,
    reason: typeof row?.['reason'] === 'string' ? (row['reason'] as string) : undefined,
  });

  const toggle = async (): Promise<void> => {
    setBusy(true);
    const outcome = await submitPlan(device.id, portAdminCommands(deviceGrammar(device), port.id, !port.adminUp));
    setBusy(false);
    setOk(outcome.ok);
    setMessages(outcome.ok ? [port.adminUp ? 'Mobile data turned off.' : 'Mobile data turned on.'] : outcomeMessages(outcome));
  };

  const attached = association !== undefined && association.state === 'attached';

  return (
    <section className="desk-card" aria-labelledby={`${uid}-title`}>
      <h3 id={`${uid}-title`} className="desk-heading">
        {port.id}
      </h3>
      <p className="desk-state" role="status">
        <span aria-hidden="true">{status.glyph} </span>
        {status.text}
      </p>
      {attached && (
        <p className="desk-signal">
          <SignalBars bars={association.bars} />
          <span>
            {association.rssiDbm} dBm · {formatRate(association.rateBps)} · about {Math.round(association.distanceM)} m from the tower
          </span>
        </p>
      )}
      <dl className="desk-info">
        <InfoRow label="Address">
          <span className="desk-mono">{port.l3.ipv4 !== undefined ? `${port.l3.ipv4.address}/${port.l3.ipv4.prefixLen}` : 'no address'}</span>
        </InfoRow>
        <InfoRow label="Physical address">
          <span className="desk-mono">{port.mac}</span>
        </InfoRow>
      </dl>
      <div className="desk-actions">
        <button type="button" className="btn" aria-pressed={port.adminUp} disabled={busy || blocked !== undefined} onClick={() => void toggle()}>
          {port.adminUp ? 'Turn mobile data off' : 'Turn mobile data on'}
        </button>
      </div>
      {blocked !== undefined && <p className="desk-note">{blocked}</p>}
      <FormStatus ok={ok} messages={messages} />
    </section>
  );
}

function findCellAssociation(list: readonly AssociationSnapshot[] | undefined, device: string, port: string): AssociationSnapshot | undefined {
  if (list === undefined) return undefined;
  return list.find((a) => a.tech === 'cellular' && a.station.device === device && a.station.port === port);
}
