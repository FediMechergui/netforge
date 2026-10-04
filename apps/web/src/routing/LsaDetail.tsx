/**
 * routing/LsaDetail.tsx — [S2] the LSA detail of the link-state browser (ARCHITECTURE-P3 §6; spec §9.7).
 *
 * The header (type, ids, age, sequence, checksum, length, scope), the body in words (a router's links with their
 * costs, a network's attached routers, an external route's metric), "the same in every router of this area: yes/no"
 * with each router's copy (same, older, newer, missing — words, never colour alone), and "show the packets that
 * carried it": the `ospf-lsa.*` display filter, handed to `onShowPackets` (the panel opens NetScope with it).
 */
import type { LsaDetailModel, LsaHolding } from './lsdb-model';

export interface LsaDetailProps {
  readonly detail: LsaDetailModel;
  /** Open NetScope on the packets that carried this LSA; absent = the filter is shown as text only. */
  onShowPackets?(filter: string): void;
}

const HOLDING_WORD: Readonly<Record<LsaHolding, string>> = Object.freeze({
  same: 'same copy',
  older: 'older copy',
  newer: 'newer copy',
  missing: 'missing',
});

const HOLDING_CHIP: Readonly<Record<LsaHolding, string>> = Object.freeze({ same: 'ok', older: 'warn', newer: 'warn', missing: 'err' });

function Body({ detail }: { detail: LsaDetailModel }) {
  const b = detail.body;
  switch (b.kind) {
    case 'router':
      return (
        <div className="ls-body">
          <p>
            Flags: <span className="mono">{b.flags}</span>
          </p>
          {b.links.length === 0 ? (
            <p className="ls-empty">No links.</p>
          ) : (
            <ul className="ls-links" aria-label="Router links">
              {b.links.map((l, i) => (
                <li key={`${l.kind}|${l.id}|${l.data}|${i}`}>{l.text}</li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'network':
      return (
        <div className="ls-body">
          <p>
            Network: <span className="mono">{b.prefix ?? b.mask ?? 'unknown mask'}</span>
          </p>
          <p>Attached routers ({b.attached.length}):</p>
          <ul className="ls-links" aria-label="Attached routers">
            {b.attached.map((a) => (
              <li key={a.rid} className="mono">
                {a.name}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'external':
      return (
        <div className="ls-body">
          <p>
            Destination: <span className="mono">{b.prefix ?? b.mask ?? 'unknown mask'}</span>
          </p>
          <p>
            Metric <span className="mono">{b.metric}</span> ({b.metricType === 'E2' ? 'type 2: the cost inside the area is not added' : 'type 1'}), forwarding
            address <span className="mono">{b.forward}</span>, tag <span className="mono">{b.tag}</span>
          </p>
        </div>
      );
    default:
      return null;
  }
}

export function LsaDetail({ detail, onShowPackets }: LsaDetailProps) {
  const a = detail.agreement;
  return (
    <section className="ls-detail" aria-label={`${detail.entry.typeLabel} LSA ${detail.entry.lsid} from ${detail.entry.advRouter}`}>
      <h3 className="ls-heading">
        {detail.entry.typeLabel} LSA <span className="mono">{detail.entry.lsid}</span>
        {detail.entry.self && <span className="chip accent">self</span>}
        {detail.entry.maxAge && <span className="chip warn">MaxAge</span>}
      </h3>
      <dl className="ls-header">
        {detail.header.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
      <Body detail={detail} />
      <div className="ls-agreement">
        <p>
          {detail.agreementLabel}:{' '}
          <strong className={`chip ${a.same ? 'ok' : 'err'}`} data-agreement={a.word}>
            {a.word}
          </strong>
        </p>
        <ul className="ls-holders" aria-label="Copies held by each router">
          {a.routers.map((r) => (
            <li key={r.device}>
              {r.name}: <span className={`chip ${HOLDING_CHIP[r.holding]}`}>{HOLDING_WORD[r.holding]}</span>
              {r.seqHex !== undefined && r.holding !== 'same' && <span className="mono"> {r.seqHex}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="ls-packets">
        {onShowPackets !== undefined && (
          <button type="button" className="btn" onClick={() => onShowPackets(detail.filter)}>
            Show the packets that carried it
          </button>
        )}
        <code className="ls-filter" title="NetScope display filter">
          {detail.filter}
        </code>
      </div>
    </section>
  );
}
