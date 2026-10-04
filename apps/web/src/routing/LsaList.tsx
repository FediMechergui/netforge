/**
 * routing/LsaList.tsx — [S2] the LSA list of the link-state browser (ARCHITECTURE-P3 §6; spec §9.7).
 *
 * One row per LSA of the chosen router and area (`lsdb-model.ts` `LsaListEntry`, database order): type, link-state
 * id, advertising router, LIVE age (the panel re-renders each second), sequence number in hex, checksum, and the
 * marks as words — `self` for an LSA this router originated, `MaxAge` for one being flushed — so no mark is colour
 * alone. Each row is focusable and selects its LSA on a click, Enter or Space; the selected row carries
 * `aria-current`.
 */
import type { KeyboardEvent } from 'react';
import { LSA_MAXAGE_MARK, LSA_SELF_MARK, type LsaListEntry } from './lsdb-model';

export interface LsaListProps {
  readonly entries: readonly LsaListEntry[];
  readonly selected?: string;
  onSelect(key: string): void;
}

/** The marks of an entry as chips (text, never colour alone). */
function Marks({ entry }: { entry: LsaListEntry }) {
  return (
    <>
      {entry.self && <span className="chip accent">{LSA_SELF_MARK}</span>}
      {entry.maxAge && <span className="chip warn">{LSA_MAXAGE_MARK}</span>}
    </>
  );
}

export function LsaList({ entries, selected, onSelect }: LsaListProps) {
  if (entries.length === 0) {
    return <p className="ls-empty">This router holds no link-state advertisement for the area yet.</p>;
  }
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, key: string): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(key);
    }
  };
  return (
    <table className="table ls-list" aria-label="Link-state advertisements">
      <thead>
        <tr>
          <th scope="col">Type</th>
          <th scope="col">Link-state id</th>
          <th scope="col">Advertising router</th>
          <th scope="col">Age (s)</th>
          <th scope="col">Sequence</th>
          <th scope="col">Checksum</th>
          <th scope="col">Marks</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr
            key={e.key}
            className={`${e.key === selected ? 'is-selected' : ''}${e.maxAge ? ' ls-maxage' : ''}`}
            tabIndex={0}
            aria-current={e.key === selected ? 'true' : undefined}
            onClick={() => onSelect(e.key)}
            onKeyDown={(ev) => onKey(ev, e.key)}
          >
            <td>{e.scope === 'as' ? `${e.typeLabel} (AS)` : e.typeLabel}</td>
            <td className="mono">{e.lsid}</td>
            <td className="mono">{e.advName}</td>
            <td className="num">{e.age}</td>
            <td className="mono">{e.seqHex}</td>
            <td className="mono">{e.checksumHex}</td>
            <td>
              <Marks entry={e} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
