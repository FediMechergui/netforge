/**
 * Physical tab (ARCHITECTURE-P1 §7 "Slots panel", D7, §3.11): a hardware overview of the chassis (ports by type and
 * connector, base MAC, power budget) and one card per module slot. Modules are inserted and removed through
 * `engine.insertModule` / `engine.removeModule`; both answer with a HardwareResult whose message is shown next to
 * the slot. Modules are not hot-swappable, so while the device is on every slot action is disabled and the gate
 * message (HARDWARE_MESSAGES wording) explains why, with a shortcut to switch the device off.
 *
 * `SlotCard` is shared with the slot inspector (`SlotInspector.tsx`).
 */
import { useId, useState } from 'react';
import type { DeviceSnapshot, HardwareResult, ModuleModel, ModuleType, PortSnapshot, SlotSnapshot } from '@netforge/engine';
import { engine } from '../bridge/client';
import type { EngineApi } from '../bridge/protocol';
import { store, useStore } from '../store/store';
import { portKindLabel } from '../vocab/categories';
import { toastError } from './PacketInspector';
import { PortLed, portStatus } from './PortInspector';
import {
  MODULE_FIT_LABELS,
  SLOT_TYPE_LABELS,
  SLOT_TYPE_NAMES,
  hardwareResultText,
  modulePortSummary,
  modulePowerGate,
  moduleModel,
  modulesForSlot,
  slotCableCount,
  slotPorts,
} from './tabs';
import type { HardwareMessageValues } from './tabs';
import './inspector.css';

// ── engine actions ──────────────────────────────────────────────────────────

/** The part of the engine API the slot actions use (tests pass a mock). */
export type HardwareApi = Pick<EngineApi, 'insertModule' | 'removeModule'>;

export type ModuleChange = { readonly op: 'insert'; readonly module: ModuleType } | { readonly op: 'remove' };

/** Shown when the worker offers no module operations. */
export const MSG_MODULES_UNAVAILABLE = 'This build cannot change modules yet: the hardware service is not connected.';

/** Insert or remove a module. Resolves with the engine's HardwareResult; rejects only on transport failures. */
export async function applyModuleChange(api: HardwareApi, device: DeviceSnapshot['id'], slot: SlotSnapshot['id'], change: ModuleChange): Promise<HardwareResult> {
  if (change.op === 'insert') {
    if (typeof api.insertModule !== 'function') throw new Error(MSG_MODULES_UNAVAILABLE);
    return api.insertModule(device, slot, change.module);
  }
  if (typeof api.removeModule !== 'function') throw new Error(MSG_MODULES_UNAVAILABLE);
  return api.removeModule(device, slot);
}

/** Placeholder values for HARDWARE_MESSAGES of a slot action. */
export function slotMessageValues(
  device: Pick<DeviceSnapshot, 'model' | 'name'>,
  slot: Pick<SlotSnapshot, 'id' | 'type'>,
  moduleName: string | undefined,
): HardwareMessageValues {
  return {
    model: device.model,
    device: device.name,
    slot: slot.id,
    slotType: SLOT_TYPE_NAMES[slot.type],
    ...(moduleName !== undefined ? { module: moduleName } : {}),
  };
}

/** Display name of a module type ("NF-EHWIC-2T"), the raw id when the module catalog does not know it. */
export function moduleName(modules: readonly ModuleModel[], type: ModuleType | undefined): string | undefined {
  if (type === undefined) return undefined;
  return moduleModel(modules, type)?.model ?? type;
}

const NO_MODULES: readonly ModuleModel[] = Object.freeze([]);

/** The module catalog from the store (empty until the engine has sent it). */
export function useModuleCatalog(): readonly ModuleModel[] {
  return useStore((s) => s.modules ?? NO_MODULES);
}

async function switchOff(device: Pick<DeviceSnapshot, 'id'>): Promise<void> {
  try {
    await engine.setPower(device.id, false);
  } catch (err) {
    toastError(err);
  }
}

// ── slot card ───────────────────────────────────────────────────────────────

/** "an interface card", "a network module", "an SFP transceiver". */
export function withArticle(label: string): string {
  return `${/^(?:[aeiou]|SFP)/i.test(label) ? 'an' : 'a'} ${label}`;
}

const cardStyle = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
  marginBottom: 8,
} as const;

/** One module slot: what it accepts, what is installed, and insert/remove controls behind the power gate. */
export function SlotCard({
  device,
  slot,
  modules,
  showDetailsLink = false,
}: {
  device: DeviceSnapshot;
  slot: SlotSnapshot;
  modules: readonly ModuleModel[];
  showDetailsLink?: boolean;
}) {
  const ids = useId();
  const fitting = modulesForSlot(slot, modules);
  const [choice, setChoice] = useState<ModuleType>('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installed = slot.module !== undefined ? moduleModel(modules, slot.module) : undefined;
  const installedName = moduleName(modules, slot.module);
  const gate = modulePowerGate(device);
  const ports = slotPorts(device, slot);
  const cables = slotCableCount(device, slot);
  const selected = fitting.some((m) => m.type === choice) ? choice : '';
  const accepts = slot.accepts.map((f) => withArticle(MODULE_FIT_LABELS[f])).join(' or ');

  const run = async (change: ModuleChange, name: string | undefined): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await applyModuleChange(engine, device.id, slot.id, change);
      if (result.ok) {
        setChoice('');
        setConfirmRemove(false);
        store
          .getState()
          .toast(
            change.op === 'insert'
              ? `${name ?? 'Module'} is now in ${slot.label} of ${device.name}.`
              : `${name ?? 'The module'} was taken out of ${slot.label} of ${device.name}.`,
            'info',
          );
      } else {
        setError(hardwareResultText(result, slotMessageValues(device, slot, name)) ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const select = (sel: Parameters<ReturnType<typeof store.getState>['select']>[0]): void => store.getState().select(sel);

  return (
    <div style={cardStyle} role="group" aria-labelledby={`${ids}-title`}>
      <div className="insp-title-row">
        <span id={`${ids}-title`} className="panel-title" style={{ margin: 0 }}>
          {slot.label}
        </span>
        <span className={`chip${slot.module !== undefined ? ' ok' : ''}`}>
          {slot.module !== undefined ? '■ occupied' : '□ empty'}
        </span>
      </div>
      <div className="insp-sub">
        <span>{SLOT_TYPE_LABELS[slot.type]}</span>
        <span className="mono">{slot.id}</span>
        <span>takes {accepts === '' ? 'nothing' : accepts}</span>
        {showDetailsLink && (
          <button type="button" className="link-btn" onClick={() => select({ kind: 'slot', device: device.id, slot: slot.id })}>
            details
          </button>
        )}
      </div>
      {slot.cage !== undefined && (
        <div className="insp-note">
          This cage feeds{' '}
          <button type="button" className="link-btn" onClick={() => select({ kind: 'port', ref: { device: device.id, port: slot.cage as string } })}>
            {slot.cage}
          </button>
          ; a fibre cable needs a transceiver here.
        </div>
      )}

      {slot.module !== undefined ? (
        <>
          <dl className="kv">
            <dt>Module</dt>
            <dd>
              <span className="mono">{installedName}</span>
              {installed !== undefined && <div className="dim">{installed.description}</div>}
            </dd>
            {installed !== undefined && (
              <>
                <dt>Adds</dt>
                <dd>{modulePortSummary(installed)}</dd>
              </>
            )}
            {ports.length > 0 && (
              <>
                <dt>Ports</dt>
                <dd>
                  {ports.map((p) => (
                    <div key={p.id}>
                      <button type="button" className="link-btn mono" onClick={() => select({ kind: 'port', ref: { device: device.id, port: p.id } })}>
                        {p.short}
                      </button>{' '}
                      <PortLed status={portStatus(p, device)} />
                      {p.link !== undefined && <span className="dim"> · cabled</span>}
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>
          {confirmRemove ? (
            <div className="reason-box" role="alertdialog" aria-labelledby={`${ids}-confirm`}>
              <div id={`${ids}-confirm`}>
                ▲ Taking {installedName} out also unplugs {cables} cable{cables === 1 ? '' : 's'} from its ports. Take it out anyway?
              </div>
              <div className="insp-actions">
                <button type="button" className="btn" disabled={busy || gate !== undefined} onClick={() => void run({ op: 'remove' }, installedName)}>
                  {busy ? 'Removing…' : '⏏ Take it out'}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <div className="insp-actions">
              <button
                type="button"
                className="btn"
                disabled={busy || gate !== undefined}
                title={gate}
                aria-describedby={gate !== undefined ? `${ids}-gate` : undefined}
                onClick={() => {
                  if (cables > 0) setConfirmRemove(true);
                  else void run({ op: 'remove' }, installedName);
                }}
              >
                {busy ? 'Removing…' : '⏏ Remove module'}
              </button>
            </div>
          )}
        </>
      ) : fitting.length === 0 ? (
        <div className="insp-note">No module in the catalog fits this slot.</div>
      ) : (
        <div className="insp-actions">
          <label htmlFor={`${ids}-module`} className="dim">
            Module
          </label>
          <select
            id={`${ids}-module`}
            className="input"
            value={selected}
            disabled={busy || gate !== undefined}
            onChange={(e) => {
              setChoice(e.target.value);
              setError(null);
            }}
          >
            <option value="">Choose a module…</option>
            {fitting.map((m) => (
              <option key={m.type} value={m.type}>
                {m.model} — {modulePortSummary(m)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={busy || gate !== undefined || selected === ''}
            title={gate}
            aria-describedby={gate !== undefined ? `${ids}-gate` : undefined}
            onClick={() => void run({ op: 'insert', module: selected }, moduleName(modules, selected))}
          >
            {busy ? 'Inserting…' : '⤓ Insert'}
          </button>
        </div>
      )}
      {selected !== '' && slot.module === undefined && (
        <div className="insp-note">{moduleModel(modules, selected)?.description}</div>
      )}
      {gate !== undefined && (
        <div id={`${ids}-gate`} className="insp-note">
          ⏻ {gate}
        </div>
      )}
      {error !== null && (
        <div className="reason-box" role="alert">
          ✖ {error}
        </div>
      )}
    </div>
  );
}

// ── hardware overview ───────────────────────────────────────────────────────

/** One row of the port summary: ports sharing a kind and connector. */
export interface PortGroupSummary {
  readonly key: string;
  readonly kind: string;
  readonly connector: string | undefined;
  readonly count: number;
  readonly fromModules: number;
}

/** Physical ports grouped by kind and connector, in first-seen (canonical) order; virtual interfaces are left out. */
export function portGroups(ports: readonly Pick<PortSnapshot, 'kind' | 'connector' | 'virtual' | 'slot' | 'module'>[]): readonly PortGroupSummary[] {
  const groups = new Map<string, { kind: string; connector: string | undefined; count: number; fromModules: number }>();
  for (const p of ports) {
    if (p.virtual === true || p.kind === 'virtual') continue;
    const connector = p.connector !== undefined && p.connector !== 'none' ? p.connector : undefined;
    const key = `${p.kind}|${connector ?? ''}`;
    const g = groups.get(key) ?? { kind: p.kind, connector, count: 0, fromModules: 0 };
    g.count += 1;
    if (p.module !== undefined) g.fromModules += 1;
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({ key, ...g }));
}

function PoeSummary({ ports }: { ports: readonly PortSnapshot[] }) {
  let supplyPorts = 0;
  let supplyW = 0;
  let draw: NonNullable<NonNullable<PortSnapshot['poe']>['pd']> | undefined;
  for (const p of ports) {
    if (p.poe?.pse !== undefined) {
      supplyPorts += 1;
      supplyW = Math.max(supplyW, p.poe.pse.maxW);
    }
    if (p.poe?.pd !== undefined && draw === undefined) draw = p.poe.pd;
  }
  if (supplyPorts === 0 && draw === undefined) return null;
  return (
    <>
      <dt>Power over Ethernet</dt>
      <dd>
        {supplyPorts > 0 && (
          <div>
            {supplyPorts} port{supplyPorts === 1 ? '' : 's'} can power attached devices (up to {supplyW} W each)
          </div>
        )}
        {draw !== undefined && <div>can run from its network cable ({draw.drawW} W)</div>}
      </dd>
    </>
  );
}

/** The Physical tab body. */
export function ModulesPanel({ device }: { device: DeviceSnapshot }) {
  const modules = useModuleCatalog();
  const [switching, setSwitching] = useState(false);
  const slots = device.slots ?? [];
  const groups = portGroups(device.ports);
  const gate = modulePowerGate(device);
  const virtualCount = device.ports.filter((p) => p.virtual === true || p.kind === 'virtual').length;

  const powerOff = async (): Promise<void> => {
    setSwitching(true);
    try {
      await switchOff(device);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <>
      <section className="insp-section" aria-label="Hardware">
        <div className="panel-title">Hardware</div>
        <dl className="kv">
          <dt>Model</dt>
          <dd className="mono">{device.model}</dd>
          <dt>Power</dt>
          <dd>{device.power ? (device.booted ? '● on' : '▲ on, starting') : '○ off'}</dd>
          {device.baseMac !== undefined && (
            <>
              <dt>Base MAC</dt>
              <dd className="mono">{device.baseMac}</dd>
            </>
          )}
          <dt>Ports</dt>
          <dd>
            {groups.length === 0
              ? 'none'
              : groups.map((g) => (
                  <div key={g.key}>
                    {g.count} × {portKindLabel(g.kind)}
                    {g.connector !== undefined && <span className="dim"> ({g.connector})</span>}
                    {g.fromModules > 0 && <span className="dim"> · {g.fromModules} from modules</span>}
                  </div>
                ))}
            {virtualCount > 0 && (
              <div className="dim">
                plus {virtualCount} virtual interface{virtualCount === 1 ? '' : 's'}
              </div>
            )}
          </dd>
          <PoeSummary ports={device.ports} />
        </dl>
      </section>
      <section className="insp-section" aria-label="Module slots">
        <div className="panel-title">
          Module slots <span className="dim">{slots.length === 0 ? '' : `${slots.filter((s) => s.module !== undefined).length} / ${slots.length} used`}</span>
        </div>
        {slots.length === 0 ? (
          <div className="insp-note">This model has no module slots; its ports are built in.</div>
        ) : (
          <>
            {gate !== undefined ? (
              <div className="reason-box">
                ⏻ {gate}
                <div className="insp-actions">
                  <button type="button" className="btn" disabled={switching} onClick={() => void powerOff()}>
                    {switching ? 'Switching off…' : '⏻ Switch off now'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="insp-note">○ The device is off, so modules can be added or taken out. Switch it on again to use them.</div>
            )}
            {modules.length === 0 && <div className="insp-note">The module catalog has not arrived from the engine yet.</div>}
            {slots.map((slot) => (
              <SlotCard key={`${device.id}/${slot.id}`} device={device} slot={slot} modules={modules} showDetailsLink />
            ))}
          </>
        )}
      </section>
    </>
  );
}
