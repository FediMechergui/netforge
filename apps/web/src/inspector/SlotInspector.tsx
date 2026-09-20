/**
 * Slot inspector (selection `{kind:'slot', device, slot}`; ARCHITECTURE-P1 §7, D7): one chassis slot with its
 * accepted module types, the installed module and its generated ports, and the insert/remove controls of the
 * Physical tab (`SlotCard`), including the power-off gate.
 */
import type { DeviceId, SlotId } from '@netforge/engine';
import { store, useStore } from '../store/store';
import { openDeviceTab } from './DeviceInspector';
import { SlotCard, moduleName, useModuleCatalog, withArticle } from './ModulesPanel';
import { MODULE_FIT_LABELS, SLOT_TYPE_LABELS, deviceById, modulesForSlot, slotById } from './tabs';
import './inspector.css';

export function SlotInspector({ device: deviceId, slot: slotId }: { device: DeviceId; slot: SlotId }) {
  const device = useStore((s) => deviceById(s, deviceId));
  const slot = slotById(device, slotId);
  const modules = useModuleCatalog();

  if (device === undefined || slot === undefined) {
    return (
      <div className="insp fill">
        <div className="empty-hint">That module slot is no longer part of the topology.</div>
      </div>
    );
  }

  const fitting = modulesForSlot(slot, modules);
  const showPhysical = (): void => {
    store.getState().select({ kind: 'device', id: device.id });
    openDeviceTab('physical');
  };

  return (
    <div className="insp fill">
      <div className="insp-head">
        <div className="insp-title-row">
          <span className="insp-title">{slot.label}</span>
          <span className={`chip${slot.module !== undefined ? ' ok' : ''}`}>{slot.module !== undefined ? '■ occupied' : '□ empty'}</span>
        </div>
        <div className="insp-sub">
          <span>
            in{' '}
            <button type="button" className="link-btn" onClick={() => store.getState().select({ kind: 'device', id: device.id })}>
              {device.name}
            </button>
          </span>
          <span className="mono">{device.model}</span>
          <span>{SLOT_TYPE_LABELS[slot.type]}</span>
        </div>
        <div className="insp-actions">
          <button type="button" className="btn" onClick={showPhysical}>
            ▤ All slots of this device
          </button>
        </div>
      </div>
      <div className="insp-body">
        <section className="insp-section">
          <dl className="kv">
            <dt>Slot</dt>
            <dd className="mono">{slot.id}</dd>
            <dt>Accepts</dt>
            <dd>{slot.accepts.length === 0 ? 'nothing' : slot.accepts.map((f) => withArticle(MODULE_FIT_LABELS[f])).join(' or ')}</dd>
            <dt>Installed</dt>
            <dd className="mono">{moduleName(modules, slot.module) ?? 'nothing'}</dd>
            <dt>Fitting modules</dt>
            <dd>
              {fitting.length === 0
                ? 'none in the catalog'
                : fitting.map((m) => (
                    <div key={m.type}>
                      <span className="mono">{m.model}</span> <span className="dim">{m.description}</span>
                    </div>
                  ))}
            </dd>
          </dl>
        </section>
        <section className="insp-section">
          <SlotCard key={`${device.id}/${slot.id}`} device={device} slot={slot} modules={modules} />
        </section>
      </div>
    </div>
  );
}
