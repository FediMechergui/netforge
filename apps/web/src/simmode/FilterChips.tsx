/**
 * simmode/FilterChips.tsx — the chip rows that compose a `TraceFilter` (ARCHITECTURE-P1 §4.11, §7 "Sim-mode
 * list"). One presentational component serves both the event list and the breakpoint editor; all state lives in
 * the caller, and every chip is a plain button, so Tab and Enter reach all of them (§16).
 *
 * Non-colour channels (§7): a chip carries ● / ○ for on / off, event kinds carry their vocabulary label, and
 * protocols carry the badge letter and the shape name from `vocab/protocols.ts` — no second vocabulary is
 * invented here and no meaning rests on colour alone.
 *
 * ponytail: no counts of its own, no search box — the kind rows come straight from the vocabulary's groups, and
 * device and message chips are the ones the caller found in the loaded rows.
 */
import type { DeviceId } from '@netforge/engine';
import { KNOWN_PROTOS, PROTOCOL_VOCAB, protocolLabel, protocolVocab } from '../vocab/protocols';
import { TRACE_KIND_GROUP_LABELS, TRACE_KIND_VOCAB, isTraceKind, traceKindsInGroup, type TraceKindGroup } from '../vocab/trace-kinds';
import { CHIP_GROUP_LABELS, chipIsOn, type ChipGroup, type ChipSelection } from './sim-events-client';

/** Kind rows in display order (the vocabulary's own grouping). */
const KIND_GROUPS: readonly TraceKindGroup[] = ['packets', 'media', 'tables', 'state', 'cli', 'diagnostics'];

/** A device the device chips offer. */
export interface ChipDevice {
  id: DeviceId;
  name: string;
}

/** Tooltip of one chip: what it does, plus the non-colour channel it is drawn with. */
export function chipTitle(group: ChipGroup, value: string, on: boolean): string {
  const verb = on ? 'Stop matching' : 'Match';
  switch (group) {
    case 'kinds': {
      if (!isTraceKind(value)) return `${verb} ${value}`;
      const v = TRACE_KIND_VOCAB[value];
      return `${verb} “${v.label}”. ${v.help}`;
    }
    case 'protos': {
      const v = protocolVocab(value);
      return `${verb} ${v.label}. ${v.hint} Drawn as a ${v.shape} badged ${v.letter}.`;
    }
    case 'devices':
      return `${verb} events that mention ${value}`;
    default:
      return `${verb} packets tagged ${value}`;
  }
}

function Chip({
  group,
  value,
  text,
  on,
  onToggle,
}: {
  group: ChipGroup;
  value: string;
  text: string;
  on: boolean;
  onToggle(group: ChipGroup, value: string): void;
}) {
  return (
    <button
      type="button"
      className={`chip chip-toggle${on ? '' : ' is-off'}`}
      aria-pressed={on}
      title={chipTitle(group, value, on)}
      onClick={() => onToggle(group, value)}
    >
      {on ? '●' : '○'} {text}
    </button>
  );
}

export interface FilterChipsProps {
  /** Prefix for the row ids this component labels its groups with. */
  idPrefix: string;
  selection: ChipSelection;
  onToggle(group: ChipGroup, value: string): void;
  /** Toggles `TraceFilter.includeBackground`. */
  onBackground(next: boolean): void;
  devices: readonly ChipDevice[];
  tags: readonly string[];
  /** Matching rows per trace kind in the loaded page, shown on the kind chips. */
  counts?: ReadonlyMap<string, number>;
  /** Height of the scrolling chip area in CSS pixels. */
  maxHeight?: number;
}

export function FilterChips({ idPrefix, selection, onToggle, onBackground, devices, tags, counts, maxHeight = 160 }: FilterChipsProps) {
  const rowId = (name: string): string => `${idPrefix}-${name}`;
  return (
    <div style={{ maxHeight, overflowY: 'auto' }}>
      {KIND_GROUPS.map((g) => {
        const kinds = traceKindsInGroup(g);
        if (kinds.length === 0) return null;
        const id = rowId(`kind-${g}`);
        return (
          <div className="dock-toolbar" key={g} role="group" aria-labelledby={id}>
            <span className="mode-label" id={id}>
              {CHIP_GROUP_LABELS.kinds}: {TRACE_KIND_GROUP_LABELS[g]}
            </span>
            {kinds.map((k) => {
              const n = counts?.get(k);
              return (
                <Chip
                  key={k}
                  group="kinds"
                  value={k}
                  text={n === undefined ? TRACE_KIND_VOCAB[k].label : `${TRACE_KIND_VOCAB[k].label} ${n}`}
                  on={chipIsOn(selection, 'kinds', k)}
                  onToggle={onToggle}
                />
              );
            })}
          </div>
        );
      })}

      <div className="dock-toolbar" role="group" aria-labelledby={rowId('protos')}>
        <span className="mode-label" id={rowId('protos')}>
          {CHIP_GROUP_LABELS.protos}
        </span>
        {KNOWN_PROTOS.map((p) => (
          <Chip
            key={p}
            group="protos"
            value={p}
            text={`${PROTOCOL_VOCAB[p].letter} ${protocolLabel(p)}`}
            on={chipIsOn(selection, 'protos', p)}
            onToggle={onToggle}
          />
        ))}
      </div>

      <div className="dock-toolbar" role="group" aria-labelledby={rowId('devices')}>
        <span className="mode-label" id={rowId('devices')}>
          {CHIP_GROUP_LABELS.devices}
        </span>
        {devices.length === 0 ? (
          <span className="dock-hint">No devices yet.</span>
        ) : (
          devices.map((d) => (
            <Chip key={d.id} group="devices" value={d.id} text={d.name} on={chipIsOn(selection, 'devices', d.id)} onToggle={onToggle} />
          ))
        )}
      </div>

      <div className="dock-toolbar" role="group" aria-labelledby={rowId('tags')}>
        <span className="mode-label" id={rowId('tags')}>
          {CHIP_GROUP_LABELS.tags}
        </span>
        {tags.length === 0 ? (
          <span className="dock-hint">Tagged messages appear here once the run produces them.</span>
        ) : (
          tags.map((t) => <Chip key={t} group="tags" value={t} text={t} on={chipIsOn(selection, 'tags', t)} onToggle={onToggle} />)
        )}
        <button
          type="button"
          className={`chip chip-toggle${selection.background ? '' : ' is-off'}`}
          aria-pressed={selection.background}
          title={selection.background ? 'Leave keepalives and beacons out again' : 'Also match keepalives and beacons'}
          onClick={() => onBackground(!selection.background)}
        >
          {selection.background ? '●' : '○'} Keepalives
        </button>
      </div>
    </div>
  );
}
