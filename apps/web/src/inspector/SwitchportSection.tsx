/**
 * Port inspector, switching section (ARCHITECTURE-P2 §5.5 "Port inspector, switching section"; §6 web file map;
 * §7 W3 web-inspector). For a bridged port of a VLAN-aware device it shows the switchport mode (configured and
 * operating, with the trunk negotiation status), the access and voice VLANs, the trunk's native VLAN, allowed and
 * active lists, the VLANs the port forwards in, the spanning-tree role and state per VLAN (from the `stp` rows),
 * channel membership (from `PortL2View.channel` and the `etherchannel` rows) and the port-security state (from the
 * `port-security` row). A quick action writes `switchport mode access` + `switchport access vlan <v>` through
 * headless `configure` with the canonical lines of gui/commands.ts (D9): the change lands in the running config
 * exactly as if it had been typed.
 *
 * Everything here reads the snapshot only: `PortSnapshot.l2` (absent = the default view of a VLAN-aware device,
 * §2.8) and the generic extra tables (`tables.extra`), so no P1 snapshot changes. Nothing branches on the device
 * kind: the section applies by port role and by the device being VLAN-aware (its catalog entry, or the `vlans` table
 * it declares). Every state keeps a text channel next to its glyph. Wording is original (§0 rule 6).
 */
import { useId, useState } from 'react';
import { DEFAULT_SWITCHPORT, isVlanAware, isVlanId, parseVlanList } from '@netforge/engine';
import type {
  ChannelMemberState,
  DeviceId,
  DeviceModel,
  DeviceSnapshot,
  PortId,
  PortL2View,
  PortSnapshot,
  SimTime,
  StpRole,
  StpState,
  SwitchportConfig,
  SwitchportMode,
  TableSnapshot,
} from '@netforge/engine';
import { engine, fmtSimTime } from '../bridge/client';
import { switchportAccessCommands } from '../gui/commands';
import { mapConfigureResult } from '../gui/forms';
import type { SubmitOutcome } from '../gui/forms';
import { store } from '../store/store';
import { toastError } from './PacketInspector';
import './inspector.css';

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Display names of the configured switchport modes. */
export const SWITCHPORT_MODE_LABELS: Readonly<Record<SwitchportMode, string>> = Object.freeze({
  access: 'access (fixed)',
  trunk: 'trunk (fixed)',
  'dynamic-auto': 'dynamic auto (trunks only if the other end asks)',
  'dynamic-desirable': 'dynamic desirable (asks the other end to trunk)',
});

/** Glyph + text of a spanning-tree port state (the glyph is the non-colour channel). */
export const STP_STATE_GLYPHS: Readonly<Record<StpState, { glyph: string; text: string }>> = Object.freeze({
  forwarding: { glyph: '●', text: 'forwarding' },
  learning: { glyph: '◐', text: 'learning (fills the MAC table, no traffic yet)' },
  listening: { glyph: '◔', text: 'listening (no traffic yet)' },
  blocking: { glyph: '✕', text: 'blocking (loop avoided here)' },
  discarding: { glyph: '✕', text: 'discarding (loop avoided here)' },
  disabled: { glyph: '○', text: 'disabled' },
});

/** Display names of the spanning-tree port roles. */
export const STP_ROLE_LABELS: Readonly<Record<StpRole, string>> = Object.freeze({
  root: 'root port (towards the root bridge)',
  designated: 'designated port',
  alternate: 'alternate port (backup path to the root)',
  backup: 'backup port (backup for a designated port)',
  disabled: 'disabled',
});

/** Display names of the channel member states. */
export const CHANNEL_STATE_LABELS: Readonly<Record<ChannelMemberState, string>> = Object.freeze({
  bundled: 'bundled (carries traffic)',
  waiting: 'waiting for the other end',
  suspended: 'suspended (no traffic)',
  individual: 'individual (works as a separate port)',
  down: 'down',
});

/** Display names of the port-security states. */
export const SECURITY_STATUS_LABELS: Readonly<Record<'secure-up' | 'secure-down' | 'secure-shutdown', string>> = Object.freeze({
  'secure-up': 'secure, up',
  'secure-down': 'secure, link down',
  'secure-shutdown': 'shut by a violation (err-disabled)',
});

// ── snapshot readers (pure) ──────────────────────────────────────────────────

/** Rows of an extra table of the snapshot, by name; empty when the device does not carry the table. */
export function extraTableRows(device: Pick<DeviceSnapshot, 'tables'>, name: string): readonly Record<string, unknown>[] {
  const t: TableSnapshot | undefined = device.tables.extra?.find((x) => x.name === name);
  return t === undefined ? [] : t.rows;
}

/** True when the snapshot carries an extra table of this name (the model declares it). */
export function hasExtraTable(device: Pick<DeviceSnapshot, 'tables'>, name: string): boolean {
  return device.tables.extra?.some((x) => x.name === name) === true;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** One spanning-tree instance the port takes part in. */
export interface StpPortFact {
  readonly vlan: number;
  readonly role: StpRole;
  readonly state: StpState;
  readonly protocol: string;
  readonly cost: number | undefined;
  readonly edge: boolean;
  readonly inconsistent: string | undefined;
  readonly bpduGuard: boolean;
  readonly stateSince: SimTime | undefined;
  readonly nextTransitionAt: SimTime | undefined;
}

/** Trunk negotiation facts of the port (its `dtp` row). */
export interface DtpFact {
  readonly status: string;
  readonly neighborMode: string | undefined;
  readonly neighbor: string | undefined;
}

/** Port-security facts of the port (its `port-security` row, else the `PortL2View.security` summary). */
export interface SecurityFact {
  readonly status: 'secure-up' | 'secure-down' | 'secure-shutdown';
  readonly count: number;
  readonly max: number;
  readonly violations: number;
  readonly violation: string | undefined;
  readonly sticky: boolean | undefined;
  readonly lastViolationMac: string | undefined;
}

/** Channel facts: membership of this port, or, for a Port-channel, its members. */
export interface ChannelFact {
  readonly group: number;
  readonly bundle: PortId;
  readonly state: ChannelMemberState;
  readonly protocol: string | undefined;
  readonly mode: string | undefined;
  readonly reason: string | undefined;
}

/** What the section shows for one port. */
export interface SwitchportFacts {
  readonly config: SwitchportConfig;
  readonly oper: 'access' | 'trunk';
  /** True when the snapshot carried no `l2` view: the port runs the default settings. */
  readonly defaults: boolean;
  /** Trunk: VLANs allowed AND existing. */
  readonly active: string | undefined;
  /** VLANs the port forwards in (spanning tree), when spanning tree runs on any of its VLANs. */
  readonly forwarding: string | undefined;
  readonly dtp: DtpFact | undefined;
  readonly stp: readonly StpPortFact[];
  readonly channel: ChannelFact | undefined;
  /** Members of this Port-channel (empty unless the port is a channel). */
  readonly members: readonly ChannelFact[];
  readonly security: SecurityFact | undefined;
}

function channelFactOf(row: Record<string, unknown>): ChannelFact | undefined {
  const group = num(row['group']);
  const bundle = str(row['bundle']);
  const state = str(row['state']) as ChannelMemberState | undefined;
  if (group === undefined || bundle === undefined || state === undefined) return undefined;
  return { group, bundle, state, protocol: str(row['protocol']), mode: str(row['mode']), reason: str(row['reason']) };
}

/** The spanning-tree instances of `port`, in ascending VLAN order. */
export function stpFactsOf(device: Pick<DeviceSnapshot, 'tables'>, port: PortId): readonly StpPortFact[] {
  const out: StpPortFact[] = [];
  for (const row of extraTableRows(device, 'stp')) {
    if (row['port'] !== port) continue;
    const vlan = num(row['vlan']);
    const role = str(row['role']) as StpRole | undefined;
    const state = str(row['state']) as StpState | undefined;
    if (vlan === undefined || role === undefined || state === undefined) continue;
    out.push({
      vlan,
      role,
      state,
      protocol: str(row['protocol']) ?? 'stp',
      cost: num(row['cost']),
      edge: row['edge'] === true,
      inconsistent: str(row['inconsistent']),
      bpduGuard: row['bpduGuard'] === true,
      stateSince: num(row['stateSince']),
      nextTransitionAt: num(row['nextTransitionAt']),
    });
  }
  return out.sort((a, b) => a.vlan - b.vlan);
}

/**
 * Switching facts of `port` from the snapshot. Undefined when the port is not a bridged port (role `switched` or
 * `channel`). Without an `l2` view the port runs the defaults (`DEFAULT_SWITCHPORT`, operating as access).
 */
export function switchportFacts(device: Pick<DeviceSnapshot, 'tables'>, port: Pick<PortSnapshot, 'id' | 'role' | 'l2'>): SwitchportFacts | undefined {
  if (port.role !== 'switched' && port.role !== 'channel') return undefined;
  const l2: PortL2View | undefined = port.l2;
  const config = l2?.config ?? DEFAULT_SWITCHPORT;
  const dtpRow = extraTableRows(device, 'dtp').find((r) => r['port'] === port.id);
  const dtp: DtpFact | undefined =
    dtpRow === undefined ? undefined : { status: str(dtpRow['status']) ?? 'waiting', neighborMode: str(dtpRow['neighborMode']), neighbor: str(dtpRow['neighbor']) };
  const channelRows = extraTableRows(device, 'etherchannel');
  const own = channelRows.find((r) => r['port'] === port.id);
  const channel: ChannelFact | undefined =
    own !== undefined ? channelFactOf(own) : l2?.channel !== undefined ? { ...l2.channel, protocol: undefined, mode: undefined, reason: undefined } : undefined;
  const members = port.role === 'channel' ? channelRows.filter((r) => r['bundle'] === port.id).map(channelFactOf).filter((c): c is ChannelFact => c !== undefined) : [];
  const secRow = extraTableRows(device, 'port-security').find((r) => r['port'] === port.id);
  let security: SecurityFact | undefined;
  if (secRow !== undefined) {
    security = {
      status: (str(secRow['status']) as SecurityFact['status'] | undefined) ?? 'secure-up',
      count: num(secRow['count']) ?? 0,
      max: num(secRow['max']) ?? 1,
      violations: num(secRow['violations']) ?? 0,
      violation: str(secRow['violation']),
      sticky: typeof secRow['sticky'] === 'boolean' ? secRow['sticky'] : undefined,
      lastViolationMac: str(secRow['lastViolationMac']),
    };
  } else if (l2?.security !== undefined) {
    security = { ...l2.security, violation: undefined, sticky: undefined, lastViolationMac: undefined };
  }
  return {
    config,
    oper: l2?.oper ?? 'access',
    defaults: l2 === undefined,
    active: l2?.active,
    forwarding: l2?.forwarding,
    dtp,
    stp: stpFactsOf(device, port.id),
    channel,
    members,
    security,
  };
}

/**
 * Whether the switching section applies: a bridged port (`switched` or `channel`) of a VLAN-aware device — one whose
 * catalog entry runs the `vlan` daemon, or whose snapshot carries the `vlans` table, or whose port carries an `l2`
 * view. Learning bridges, access points and phones (P1-style bridges) show nothing.
 */
export function switchportSectionApplies(
  device: Pick<DeviceSnapshot, 'tables'>,
  port: Pick<PortSnapshot, 'role' | 'l2'>,
  model?: Pick<DeviceModel, 'processes'>,
): boolean {
  if (port.role !== 'switched' && port.role !== 'channel') return false;
  if (port.l2 !== undefined) return true;
  if (hasExtraTable(device, 'vlans')) return true;
  return model !== undefined && isVlanAware(model);
}

/** Readable VLAN list: '1-4094' → 'all', '' → 'none', else the canonical text. */
export function vlanListText(list: string): string {
  if (list === '1-4094') return 'all (1-4094)';
  if (list === '') return 'none';
  return list;
}

/** Error text for the quick action's VLAN input, undefined when it is a VLAN id. */
export function checkAccessVlan(text: string): string | undefined {
  const t = text.trim();
  if (!/^\d+$/.test(t) || !isVlanId(Number(t))) return 'Enter a VLAN number from 1 to 4094.';
  return undefined;
}

/** Number of VLANs in a canonical list (for the "n VLANs" note). */
export function vlanCount(list: string): number {
  return parseVlanList(list)?.length ?? 0;
}

// ── quick action ─────────────────────────────────────────────────────────────

/** The engine surface the quick action needs (a mock in tests). */
export interface SwitchportApi {
  configure?: typeof engine.configure;
}

/** Message when this build's bridge has no configure call. */
export const MSG_SWITCHPORT_UNAVAILABLE = 'This build cannot apply switching settings from the inspector.';

/**
 * Apply "access port in VLAN v" through headless configure. Returns the mapped outcome (field errors under `mode`
 * and `accessVlan`); a bridge failure becomes a general message instead of an exception.
 */
export async function applySwitchportAccess(api: SwitchportApi, device: DeviceId, port: PortId, vlan: string): Promise<SubmitOutcome> {
  const plan = switchportAccessCommands(port, vlan);
  if (api.configure === undefined) {
    return Object.freeze({ ok: false, reverted: false, fieldErrors: {}, general: Object.freeze([MSG_SWITCHPORT_UNAVAILABLE]), skipped: 0 });
  }
  try {
    const result = await api.configure(device, [...plan.commands], { ...plan.options });
    return mapConfigureResult(plan, result);
  } catch (err) {
    const detail = err instanceof Error && err.message !== '' ? ` ${err.message}` : '';
    return Object.freeze({ ok: false, reverted: false, fieldErrors: {}, general: Object.freeze([`The simulator did not accept the request.${detail}`]), skipped: 0 });
  }
}

// ── component ────────────────────────────────────────────────────────────────

function ChannelText({ c }: { c: ChannelFact }) {
  return (
    <>
      <span className="mono">{c.bundle}</span> (group {c.group}
      {c.protocol !== undefined && `, ${c.protocol}`}
      {c.mode !== undefined && ` ${c.mode}`}) · {CHANNEL_STATE_LABELS[c.state]}
      {c.reason !== undefined && c.reason !== '' && <div className="dim">{c.reason}</div>}
    </>
  );
}

function StpRows({ facts, now }: { facts: readonly StpPortFact[]; now: SimTime | undefined }) {
  return (
    <>
      {facts.map((f) => {
        const st = STP_STATE_GLYPHS[f.state];
        const pending = f.nextTransitionAt !== undefined && (now === undefined || f.nextTransitionAt > now);
        return (
          <div key={f.vlan}>
            <span className="mono">VLAN {f.vlan}</span>: {STP_ROLE_LABELS[f.role]},{' '}
            <span aria-hidden="true">{st.glyph} </span>
            {st.text}
            {f.edge && ' · edge port'}
            {f.protocol === 'stp' && ' · classic timers'}
            {f.cost !== undefined && <span className="dim"> · cost {f.cost}</span>}
            {f.inconsistent !== undefined && <span className="chip warn tiny"> ▲ {f.inconsistent} inconsistent</span>}
            {f.bpduGuard && <span className="dim"> · BPDU guard</span>}
            {pending && f.nextTransitionAt !== undefined && <div className="dim">next state change at {fmtSimTime(f.nextTransitionAt)}</div>}
          </div>
        );
      })}
    </>
  );
}

export interface SwitchportSectionProps {
  device: DeviceSnapshot;
  port: PortSnapshot;
  /** Extrapolated sim time for the "next state change" note; omitted = always shown when pending. */
  now?: SimTime;
  /** Engine surface (defaults to the worker bridge). */
  api?: SwitchportApi;
}

/** The "Switching" section of the port inspector. Renders nothing for a port the section does not apply to. */
export function SwitchportSection({ device, port, now, api }: SwitchportSectionProps) {
  const uid = useId();
  const facts = switchportFacts(device, port);
  const [vlan, setVlan] = useState<string>('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (facts === undefined) return null;

  const cfg = facts.config;
  const dynamic = cfg.mode === 'dynamic-auto' || cfg.mode === 'dynamic-desirable';
  const canEdit = port.role === 'switched' && device.power && device.booted;
  const inputId = `${uid}-access-vlan`;

  const onQuickAccess = async (): Promise<void> => {
    const bad = checkAccessVlan(vlan);
    setError(bad);
    if (bad !== undefined) return;
    setBusy(true);
    try {
      const outcome = await applySwitchportAccess(api ?? engine, device.id, port.id, vlan);
      if (outcome.ok) {
        store.getState().toast(`${port.short} on ${device.name} is now an access port in VLAN ${vlan.trim()}.`, 'info');
        setVlan('');
      } else {
        const msg = outcome.fieldErrors['accessVlan'] ?? outcome.fieldErrors['mode'] ?? outcome.general[0] ?? 'The device did not accept the change.';
        setError(msg);
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="insp-section" aria-label="Switching">
      <div className="panel-title">Switching</div>
      <dl className="kv">
        <dt>Mode</dt>
        <dd>
          {SWITCHPORT_MODE_LABELS[cfg.mode]}
          {facts.defaults && <span className="dim"> · default settings</span>}
          <div className="dim">
            operating as {facts.oper === 'trunk' ? 'a trunk' : 'an access port'}
            {facts.dtp !== undefined && (
              <>
                {' '}
                · negotiation {facts.dtp.status}
                {facts.dtp.neighborMode !== undefined && `, other end ${facts.dtp.neighborMode}`}
              </>
            )}
            {dynamic && facts.dtp === undefined && ' · nothing negotiated yet'}
            {!cfg.negotiate && ' · negotiation off'}
          </div>
        </dd>
        <dt>Access VLAN</dt>
        <dd className="mono">
          {cfg.accessVlan}
          {facts.oper === 'trunk' && <span className="dim"> (unused while trunking)</span>}
        </dd>
        {cfg.voiceVlan !== undefined && (
          <>
            <dt>Voice VLAN</dt>
            <dd className="mono">{cfg.voiceVlan}</dd>
          </>
        )}
        {(facts.oper === 'trunk' || cfg.mode === 'trunk') && (
          <>
            <dt>Native VLAN</dt>
            <dd className="mono">
              {cfg.nativeVlan} <span className="dim">(carried untagged)</span>
            </dd>
            <dt>Allowed VLANs</dt>
            <dd className="mono">{vlanListText(cfg.allowed)}</dd>
            {facts.active !== undefined && (
              <>
                <dt>Active VLANs</dt>
                <dd className="mono">
                  {vlanListText(facts.active)} <span className="dim">(allowed and existing)</span>
                </dd>
              </>
            )}
          </>
        )}
        {facts.forwarding !== undefined && (
          <>
            <dt>Forwarding in</dt>
            <dd className="mono">{vlanListText(facts.forwarding)}</dd>
          </>
        )}
        <dt>Spanning tree</dt>
        <dd>
          {facts.stp.length === 0 ? (
            <span className="dim">{facts.channel?.state === 'bundled' ? 'runs on the bundle, not on this member' : 'not running on this port'}</span>
          ) : (
            <StpRows facts={facts.stp} now={now} />
          )}
        </dd>
        {facts.channel !== undefined && (
          <>
            <dt>Channel</dt>
            <dd>
              <ChannelText c={facts.channel} />
            </dd>
          </>
        )}
        {port.role === 'channel' && (
          <>
            <dt>Members</dt>
            <dd>
              {facts.members.length === 0 ? (
                <span className="dim">no member port yet</span>
              ) : (
                facts.members.map((m) => (
                  <div key={m.bundle + m.state + String(m.group)}>
                    <ChannelText c={m} />
                  </div>
                ))
              )}
            </dd>
          </>
        )}
        <dt>Port security</dt>
        <dd>
          {facts.security === undefined ? (
            <span className="dim">off</span>
          ) : (
            <>
              {SECURITY_STATUS_LABELS[facts.security.status]} · {facts.security.count} of {facts.security.max} address
              {facts.security.max === 1 ? '' : 'es'} learned
              {facts.security.violation !== undefined && ` · on violation: ${facts.security.violation}`}
              {facts.security.sticky === true && ' · sticky'}
              <div className={facts.security.violations > 0 ? 'chip warn tiny' : 'dim'}>
                {facts.security.violations} violation{facts.security.violations === 1 ? '' : 's'}
                {facts.security.lastViolationMac !== undefined && ` · last from ${facts.security.lastViolationMac}`}
              </div>
            </>
          )}
        </dd>
      </dl>
      {canEdit && (
        <form
          className="insp-actions"
          aria-label="Quick action: access port"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void onQuickAccess();
          }}
        >
          <label htmlFor={inputId}>Access VLAN</label>
          <input
            id={inputId}
            className="input"
            inputMode="numeric"
            placeholder="10"
            value={vlan}
            aria-invalid={error !== undefined}
            aria-describedby={error !== undefined ? `${inputId}-err` : undefined}
            onChange={(e) => {
              setVlan(e.target.value);
              setError(undefined);
            }}
            disabled={busy}
          />
          <button type="submit" className="btn" disabled={busy || vlan.trim() === ''} title="Writes switchport mode access and switchport access vlan">
            {busy ? 'Applying…' : 'Make an access port'}
          </button>
          {error !== undefined && (
            <div id={`${inputId}-err`} className="insp-note" role="alert">
              ⚠ {error}
            </div>
          )}
        </form>
      )}
    </section>
  );
}
