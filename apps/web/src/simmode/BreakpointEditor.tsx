/**
 * simmode/BreakpointEditor.tsx — builds the `stopOn` filter of simulation mode and drives the run that uses it
 * (ARCHITECTURE-P1 §4.11 items 2–3, §10.2 `accept.p1.sim-mode-dhcp-offer`). The presets are whole filters: "First
 * address offer" is exactly `{kinds:['frameTx'], protos:['dhcp'], tags:['dhcp-offer']}`, and the chips below
 * refine any of them.
 *
 * The editor holds no state — the panel owns the selection, the armed flag and the engine calls — so the same
 * chip rows serve the list filter and the breakpoint (§16: every control is a button, reachable by Tab, and the
 * stop banner is a live region so a screen reader hears where the run stopped).
 *
 * ponytail: arming and running are two buttons over one filter, instead of a breakpoint list; a lab needs one
 * breakpoint at a time, and the chips already compose "or" inside a row.
 */
import type { DeviceId } from '@netforge/engine';
import type { StopInfo } from '../bridge/protocol';
import { fmtSimTime } from '../bridge/client';
import { FilterChips, type ChipDevice } from './FilterChips';
import {
  BREAKPOINT_PRESETS,
  buildTraceFilter,
  chipsFromFilter,
  describeFilter,
  hasChips,
  presetOf,
  stopReasonText,
  toggleChip,
  type ChipGroup,
  type ChipSelection,
} from './sim-events-client';

export interface BreakpointEditorProps {
  id: string;
  selection: ChipSelection;
  onSelection(next: ChipSelection): void;
  /** The breakpoint is armed: the worker was given this filter as `stopOn`. */
  armed: boolean;
  onArm(next: boolean): void;
  /** Run forward until the breakpoint matches. */
  onRun(): void;
  busy: boolean;
  devices: readonly ChipDevice[];
  tags: readonly string[];
  deviceName(id: DeviceId): string;
}

export function BreakpointEditor({ id, selection, onSelection, armed, onArm, onRun, busy, devices, tags, deviceName }: BreakpointEditorProps) {
  const filter = buildTraceFilter(selection);
  const ready = hasChips(selection);
  const current = presetOf(filter);
  const onToggle = (group: ChipGroup, value: string): void => onSelection(toggleChip(selection, group, value));

  return (
    <div className="insp-section" id={id} role="group" aria-label="Breakpoint">
      <div className="dock-toolbar" role="group" aria-label="Ready-made breakpoints">
        <span className="mode-label">Stop when</span>
        {BREAKPOINT_PRESETS.map((p) => {
          const on = current?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className={`chip chip-toggle${on ? '' : ' is-off'}`}
              aria-pressed={on}
              title={p.help}
              onClick={() => onSelection(chipsFromFilter(p.filter))}
            >
              {on ? '●' : '○'} {p.label}
            </button>
          );
        })}
      </div>

      <FilterChips
        idPrefix={`${id}-chips`}
        selection={selection}
        onToggle={onToggle}
        onBackground={(next) => onSelection({ ...selection, background: next })}
        devices={devices}
        tags={tags}
        maxHeight={140}
      />

      <div className="dock-toolbar">
        <span className="dock-hint">{ready ? describeFilter(filter, deviceName) : 'Pick at least one chip to set a breakpoint.'}</span>
        <span className="fill" />
        <button type="button" className={`btn${armed ? ' is-active' : ''}`} aria-pressed={armed} disabled={!ready} onClick={() => onArm(!armed)}>
          {armed ? 'Breakpoint on' : 'Breakpoint off'}
        </button>
        <button type="button" className="btn btn-primary" disabled={!armed || busy} onClick={onRun}>
          Run to the breakpoint
        </button>
      </div>
    </div>
  );
}

export interface StopBannerProps {
  stopped: StopInfo | null;
  /** One line describing the event the run stopped on. */
  text: string;
  /** Shown instead when a run or a step found no match. */
  note: string | null;
  onReveal(): void;
}

/** Where the clock stopped and why (§4.11 item 3). Announced politely so the message is not missed. */
export function StopBanner({ stopped, text, note, onReveal }: StopBannerProps) {
  const empty = stopped === null && note === null;
  // The region is mounted from the start and only its contents change, so the message is announced (§16).
  return (
    <div className={`dock-toolbar reason-box${empty ? ' is-empty' : ''}`} role="status" aria-live="polite">
      {empty ? null : stopped === null ? (
        <span>⏹ {note}</span>
      ) : (
        <>
          <span>
            ⏸ {stopReasonText(stopped.reason)} at <span className="mono">{fmtSimTime(stopped.event.t)}</span>
          </span>
          <span className="dock-hint">{text}</span>
          <span className="fill" />
          <button type="button" className="btn btn-ghost" onClick={onReveal}>
            Show the event
          </button>
        </>
      )}
    </div>
  );
}
