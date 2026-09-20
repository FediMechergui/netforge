/**
 * Right-hand inspector (spec §8.4): switches on the store selection — device,
 * link, port, packet or terminal session — and shows a hint when nothing is
 * selected.
 */
import { useEffect } from 'react';
import type { DeviceId, PduId, SessionId } from '@netforge/engine';
import { useDevice, useSession } from '../store/selectors';
import { store, useStore } from '../store/store';
import { DeviceInspector } from './DeviceInspector';
import { AssociationInspector } from './AssociationInspector';
import { LinkInspector } from './LinkInspector';
import { PacketInspector, revealDockTab, usePduJson } from './PacketInspector';
import { PortInspector } from './PortInspector';
import { SlotInspector } from './SlotInspector';
import './inspector.css';

export function Inspector() {
  const selection = useStore((s) => s.selection);
  if (!selection) return <NothingSelected />;
  switch (selection.kind) {
    case 'device':
      return <DeviceSelection id={selection.id} />;
    case 'link':
      return <LinkInspector key={selection.id} id={selection.id} />;
    case 'port':
      return <PortInspector key={`${selection.ref.device}/${selection.ref.port}`} port={selection.ref} />;
    case 'pdu':
      return <PduSelection key={selection.id} id={selection.id} />;
    case 'session':
      return <SessionSelection id={selection.id} />;
    case 'association':
      return <AssociationInspector key={selection.id} id={selection.id} />;
    case 'slot':
      return <SlotInspector key={`${selection.device}/${selection.slot}`} device={selection.device} slot={selection.slot} />;
    default:
      return <NothingSelected />;
  }
}

function NothingSelected() {
  const hasDevices = useStore((s) => (s.snapshot?.devices.length ?? 0) > 0);
  return (
    <div className="insp fill">
      <div className="empty-hint">
        <h3>Nothing selected</h3>
        {hasDevices
          ? 'Click a device, a cable or a port on the canvas to see its live state here.'
          : 'Drag a device from the palette onto the canvas to start building a network.'}
        <ul>
          <li>Devices show their ports, configuration, tables and running daemons.</li>
          <li>Cables show why they are up or down and let you add loss or delay.</li>
          <li>Pick a packet in the Packets tab to open its layers and bytes.</li>
        </ul>
      </div>
    </div>
  );
}

function DeviceSelection({ id }: { id: DeviceId }) {
  const device = useDevice(id);
  if (!device) {
    return (
      <div className="insp fill">
        <div className="empty-hint">That device is no longer part of the topology.</div>
      </div>
    );
  }
  return <DeviceInspector device={device} />;
}

function PduSelection({ id }: { id: PduId }) {
  const { pdu, missing } = usePduJson(id);
  const setInspectedPdu = useStore((s) => s.setInspectedPdu);
  const inspected = useStore((s) => s.inspectedPdu);

  useEffect(() => {
    if (!pdu) return;
    const sel = store.getState().selection;
    if (sel?.kind === 'pdu' && sel.id === id) setInspectedPdu(pdu);
  }, [pdu, id, setInspectedPdu]);

  if (inspected && inspected.id === id) {
    return (
      <div className="insp fill">
        <div className="insp-body">
          <PacketInspector pdu={inspected} />
        </div>
      </div>
    );
  }
  return (
    <div className="insp fill">
      <div className="empty-hint">
        {missing
          ? `Packet #${id} is no longer held by the engine (a reset or reload clears packet history).`
          : `Loading packet #${id}…`}
      </div>
    </div>
  );
}

function SessionSelection({ id }: { id: SessionId }) {
  const session = useSession(id);
  const device = useDevice(session?.device);
  if (!session) {
    return (
      <div className="insp fill">
        <div className="empty-hint">That terminal session has been closed.</div>
      </div>
    );
  }
  return (
    <div className="insp fill">
      <div className="insp-head">
        <div className="insp-title-row">
          <span className="insp-title">Session {session.id}</span>
          <span className="chip">{session.via}</span>
        </div>
        <div className="insp-sub">
          <span>
            on{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => store.getState().select({ kind: 'device', id: session.device })}
            >
              {device?.name ?? session.device}
            </button>
          </span>
          <span className="mono">{session.prompt}</span>
          {session.busy && <span className="chip warn">⧗ running a command</span>}
        </div>
        <div className="insp-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              store.getState().setActiveTerminal(session.id);
              revealDockTab('terminal');
            }}
          >
            Show terminal
          </button>
        </div>
      </div>
      <div className="insp-body">
        <section className="insp-section">
          <dl className="kv">
            <dt>Mode</dt>
            <dd className="mono">{session.mode}</dd>
            <dt>Privilege</dt>
            <dd className="mono">{session.privilege}</dd>
            {session.iface !== undefined && (
              <>
                <dt>Interface</dt>
                <dd className="mono">{session.iface}</dd>
              </>
            )}
            <dt>History</dt>
            <dd className="mono">
              {session.history.length === 0 ? 'no commands yet' : session.history.slice(-10).map((h, i) => <div key={i}>{h}</div>)}
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
