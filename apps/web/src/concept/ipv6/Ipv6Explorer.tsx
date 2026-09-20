/**
 * IPv6 explorer (ARCHITECTURE-P1 §4.13, §7 "Concept views", §10.2): the view over concept/ipv6/model.ts.
 * Three panes, one at a time:
 *
 *  - **Shorten or write out** — the stepwise walk between a full address and its RFC 5952 text, one numbered
 *    step per rule with what it changed and why; the direction is a choice, so the same address can be walked
 *    both ways.
 *  - **Interface id (EUI-64)** — a MAC and a /64 prefix walked to an address, including the two bit patterns of
 *    the universal/local bit before and after the flip.
 *  - **What kind of address** — the type, the block that defines it, the interface id and, for a multicast
 *    group, its flags, scope and well-known name, plus where a prefix length splits the address.
 *
 * The steps shown are exactly the model's steps (§10.2 pins its vectors); nothing is recomputed here. Each step
 * carries a number and a ✓ / · mark for "this rule changed something", so nothing depends on colour, and every
 * control is a labelled input or button. Wording is original (§1.6).
 *
 * ponytail: one address at a time, and the EUI-64 pane refuses anything but a /64 prefix, because that is the
 * only prefix length an interface id fills.
 */
import { useId, useMemo, useState } from 'react';
import {
  classifyIpv6,
  eui64Steps,
  ipv6CompressionSteps,
  ipv6ExpansionSteps,
  ipv6PrefixView,
  type Ipv6Classification,
  type Ipv6Step,
} from './model';

/** Panes of the explorer. */
export type Ipv6Pane = 'shorten' | 'eui64' | 'identify';

/** Pane names in display order. */
export const IPV6_PANES: readonly { readonly id: Ipv6Pane; readonly label: string }[] = Object.freeze([
  { id: 'shorten', label: 'Shorten or write out' },
  { id: 'eui64', label: 'Interface id (EUI-64)' },
  { id: 'identify', label: 'What kind of address' },
]);

/** The §10.2 compression vector, which the explorer opens on. */
export const DEFAULT_IPV6_INPUT = '2001:0db8:0000:0000:0000:ff00:0042:8329';
/** MAC the EUI-64 pane opens on. */
export const DEFAULT_EUI64_MAC = '02:4e:59:e8:af:01';
/** Prefix the EUI-64 pane opens on. */
export const DEFAULT_EUI64_PREFIX = 'fe80::';

export function Ipv6Explorer() {
  const [pane, setPane] = useState<Ipv6Pane>('shorten');
  const uid = useId();
  return (
    <div className="dock-panel">
      <div className="dock-toolbar" role="group" aria-label="IPv6 panes">
        {IPV6_PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            id={`${uid}-tab-${p.id}`}
            aria-pressed={pane === p.id}
            aria-controls={`${uid}-pane`}
            className={`tab${pane === p.id ? ' is-active' : ''}`}
            onClick={() => setPane(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="dock-scroll" id={`${uid}-pane`} aria-labelledby={`${uid}-tab-${pane}`}>
        {pane === 'shorten' && <ShortenPane />}
        {pane === 'eui64' && <Eui64Pane />}
        {pane === 'identify' && <IdentifyPane />}
      </div>
    </div>
  );
}

/** The model's steps as a numbered table; `changed` is shown as a mark plus words. */
export function StepTable({ steps, caption }: { steps: readonly Ipv6Step[]; caption: string }) {
  return (
    <table className="table">
      <caption className="dim">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Step</th>
          <th scope="col">Rule</th>
          <th scope="col">Result</th>
          <th scope="col">What it did</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s, i) => (
          <tr key={`${s.rule}-${i}`}>
            <th scope="row">
              <span aria-hidden="true">{s.changed ? '✓ ' : '· '}</span>
              {i + 1}
            </th>
            <td>
              {s.title}
              <div className="dim">{s.changed ? 'changed the address' : 'nothing to do'}</div>
            </td>
            <td className="mono">{s.after}</td>
            <td className="dim">{s.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── shorten / write out ──────────────────────────────────────────────────────

export function ShortenPane() {
  const uid = useId();
  const [text, setText] = useState(DEFAULT_IPV6_INPUT);
  const [direction, setDirection] = useState<'shorten' | 'expand'>('shorten');
  // Both walks are pure and cheap; keeping the compression one apart keeps its zero-run report typed.
  const compression = useMemo(() => ipv6CompressionSteps(text), [text]);
  const expansion = useMemo(() => ipv6ExpansionSteps(text), [text]);
  const result = direction === 'shorten' ? compression : expansion;
  const runs = compression.ok ? compression : null;
  return (
    <>
      <div className="desk-field">
        <label htmlFor={`${uid}-addr`}>IPv6 address</label>
        <input
          id={`${uid}-addr`}
          className="input mono"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!result.ok}
          aria-describedby={result.ok ? undefined : `${uid}-addr-err`}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="desk-field">
        <label htmlFor={`${uid}-dir`}>Walk</label>
        <select id={`${uid}-dir`} className="select" value={direction} onChange={(e) => setDirection(e.target.value === 'expand' ? 'expand' : 'shorten')}>
          <option value="shorten">to the shortest form</option>
          <option value="expand">to all eight groups</option>
        </select>
      </div>
      {!result.ok ? (
        <p id={`${uid}-addr-err`} className="insp-note" role="alert">
          <span aria-hidden="true">⚠ </span>
          {result.error}
        </p>
      ) : (
        <>
          <StepTable steps={result.steps} caption={direction === 'shorten' ? 'From what you typed to the shortest legal spelling.' : 'From what you typed to all eight groups written out.'} />
          <table className="table">
            <tbody>
              <tr>
                <th scope="row">All eight groups</th>
                <td className="mono">{result.expanded}</td>
              </tr>
              <tr>
                <th scope="row">Shortest form</th>
                <td className="mono">{result.canonical}</td>
              </tr>
              {runs !== null && (
                <tr>
                  <th scope="row">Runs of zero groups</th>
                  <td className="mono">
                    {runs.zeroRuns.length === 0
                      ? 'none'
                      : runs.zeroRuns.map((r) => `${r.length} group${r.length === 1 ? '' : 's'} from position ${r.start + 1}`).join('; ')}
                  </td>
                </tr>
              )}
              {runs !== null && (
                <tr>
                  <th scope="row">Replaced by ::</th>
                  <td className="mono">
                    {runs.compressed === null
                      ? 'nothing — :: needs a run of at least two zero groups'
                      : `${runs.compressed.length} groups from position ${runs.compressed.start + 1}`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// ── EUI-64 ───────────────────────────────────────────────────────────────────

export function Eui64Pane() {
  const uid = useId();
  const [mac, setMac] = useState(DEFAULT_EUI64_MAC);
  const [prefix, setPrefix] = useState(DEFAULT_EUI64_PREFIX);
  const result = useMemo(() => eui64Steps(mac, prefix), [mac, prefix]);
  return (
    <>
      <div className="desk-field">
        <label htmlFor={`${uid}-mac`}>MAC address of the interface</label>
        <input id={`${uid}-mac`} className="input mono" value={mac} spellCheck={false} autoComplete="off" onChange={(e) => setMac(e.target.value)} />
      </div>
      <div className="desk-field">
        <label htmlFor={`${uid}-prefix`}>Prefix (/64)</label>
        <input id={`${uid}-prefix`} className="input mono" value={prefix} spellCheck={false} autoComplete="off" onChange={(e) => setPrefix(e.target.value)} />
        <span className="dim">fe80:: gives the link-local address the interface builds for itself.</span>
      </div>
      {!result.ok ? (
        <p className="insp-note" role="alert">
          <span aria-hidden="true">⚠ </span>
          {result.error}
        </p>
      ) : (
        <>
          <table className="table">
            <caption className="dim">Each step of the walk from the MAC to the address.</caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Rule</th>
                <th scope="col">Result</th>
                <th scope="col">What it did</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.map((s, i) => (
                <tr key={s.rule}>
                  <th scope="row">{i + 1}</th>
                  <td>{s.title}</td>
                  <td className="mono">{s.value}</td>
                  <td className="dim">{s.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="table">
            <caption className="dim">The seventh bit of the first byte, before and after the flip.</caption>
            <tbody>
              <tr>
                <th scope="row">First byte before</th>
                <td className="mono">
                  {result.flip.byteBefore} = {result.flip.bitsBefore}
                </td>
              </tr>
              <tr>
                <th scope="row">First byte after</th>
                <td className="mono">
                  {result.flip.byteAfter} = {result.flip.bitsAfter}
                </td>
              </tr>
              <tr>
                <th scope="row">The MAC itself</th>
                <td>{result.flip.macLocallyAdministered ? 'is locally administered' : 'carries a manufacturer prefix'}</td>
              </tr>
              <tr>
                <th scope="row">Interface id</th>
                <td className="mono">{result.interfaceId}</td>
              </tr>
              <tr>
                <th scope="row">Address</th>
                <td className="mono">{result.address}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// ── classify ─────────────────────────────────────────────────────────────────

export function IdentifyPane() {
  const uid = useId();
  const [text, setText] = useState('fe80::4e:59ff:fee8:af01');
  const [prefixLen, setPrefixLen] = useState(64);
  const result = useMemo(() => classifyIpv6(text), [text]);
  return (
    <>
      <div className="desk-field">
        <label htmlFor={`${uid}-addr`}>IPv6 address</label>
        <input
          id={`${uid}-addr`}
          className="input mono"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!result.ok}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="desk-field">
        <label htmlFor={`${uid}-len`}>Prefix length to split at</label>
        <input
          id={`${uid}-len`}
          className="input mono"
          type="number"
          min={0}
          max={128}
          value={prefixLen}
          onChange={(e) => setPrefixLen(Math.min(128, Math.max(0, Math.trunc(Number(e.target.value)) || 0)))}
        />
      </div>
      {!result.ok ? (
        <p className="insp-note" role="alert">
          <span aria-hidden="true">⚠ </span>
          {result.error}
        </p>
      ) : (
        <ClassificationReport value={result.value} prefixLen={prefixLen} />
      )}
    </>
  );
}

function ClassificationReport({ value, prefixLen }: { value: Ipv6Classification; prefixLen: number }) {
  const split = ipv6PrefixView(value.address, prefixLen);
  const m = value.multicast;
  return (
    <>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">Address</th>
            <td className="mono">{value.address}</td>
          </tr>
          <tr>
            <th scope="row">All eight groups</th>
            <td className="mono">{value.expanded}</td>
          </tr>
          <tr>
            <th scope="row">Kind</th>
            <td>
              {value.type} <span className="dim">({value.description})</span>
            </td>
          </tr>
          <tr>
            <th scope="row">Defined by the block</th>
            <td className="mono">{value.range}</td>
          </tr>
          <tr>
            <th scope="row">Reach</th>
            <td>{value.scope}</td>
          </tr>
          <tr>
            <th scope="row">Interface id</th>
            <td className="mono">
              {value.interfaceId ?? 'not a 64-bit interface id'}
              {value.eui64Like && <span className="dim"> (built from a MAC: it carries the ff:fe marker)</span>}
            </td>
          </tr>
        </tbody>
      </table>
      {m !== null && (
        <table className="table">
          <caption className="dim">This is a multicast group.</caption>
          <tbody>
            <tr>
              <th scope="row">Scope</th>
              <td>
                {m.scope} <span className="mono">(field value {m.scopeValue})</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Flags</th>
              <td>
                <span aria-hidden="true">{m.flags.transient ? '✓ ' : '· '}</span>T temporary,{' '}
                <span aria-hidden="true">{m.flags.prefixBased ? '✓ ' : '· '}</span>P built on a unicast prefix,{' '}
                <span aria-hidden="true">{m.flags.rendezvous ? '✓ ' : '· '}</span>R carries a meeting-point address
              </td>
            </tr>
            <tr>
              <th scope="row">Known group</th>
              <td>{m.wellKnown ?? 'not one of the standard groups'}</td>
            </tr>
            {m.solicitedNodeSuffix !== null && (
              <tr>
                <th scope="row">Listens for</th>
                <td className="mono">addresses ending in {m.solicitedNodeSuffix}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <table className="table">
        <caption className="dim">Where /{prefixLen} splits the address.</caption>
        <tbody>
          <tr>
            <th scope="row">Network</th>
            <td className="mono">{split.cidr}</td>
          </tr>
          <tr>
            <th scope="row">Network written out</th>
            <td className="mono">{split.expandedNetwork}</td>
          </tr>
          <tr>
            <th scope="row">Prefix covers</th>
            <td>
              {split.prefixNibbles} hex digit{split.prefixNibbles === 1 ? '' : 's'}
              {split.splitsNibble ? ', and ends inside the next one' : ' exactly'}
            </td>
          </tr>
          <tr>
            <th scope="row">Bits left for hosts</th>
            <td className="mono">{split.hostBits}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
