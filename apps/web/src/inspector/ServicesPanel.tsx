/**
 * Services panel (ARCHITECTURE-P1 §6 "Host shell expansions (P1)", §7 "Browser and Services", D9): the web,
 * name and address services a server offers, as forms.
 *
 * Every form builds the canonical lines of §6 and sends them through `EngineApi.configure`, so the device's own
 * CLI checks them and a refused line comes back on the field that produced it (the wireless panels' `submitPlan`
 * / `runPanelSubmit` / `SettingsField` do exactly this, and are reused here). A server runs the HOST shell, whose
 * `service …` expansions write those very lines; a device on the nfos grammar gets the `ip …` lines themselves.
 * What is running is read back out of the running config (`walkConfigText`), with the daemons' own counters
 * beside it.
 *
 * Sections appear only for daemons the device actually runs (`DeviceSnapshot.processes`), so nothing here
 * branches on the device kind. States are words plus a glyph, never colour. Wording is original (§1.6).
 *
 * ponytail: both grammars are built because §6 names both line forms, but the host shell has no expansion for
 * `ip host` or `ip dhcp excluded-address`, so those two forms are shown only where they can be written; the
 * address service keeps ONE pool (`SERVICE_POOL_NAME` on the host shell), which is what a one-subnet lab needs.
 */
import { useId, useState } from 'react';
import { DNS_DEFAULT_TTL_S, DNS_RECORD_TYPES, SERVICE_POOL_NAME, walkConfigText } from '@netforge/engine';
import type { CliGrammar, DeviceSnapshot } from '@netforge/engine';
import { engine } from '../bridge/client';
import { PANEL_CONFIGURE_OPTIONS } from '../gui/commands';
import type { CommandPlan, FieldSpan, PlanLine, Token } from '../gui/commands';
import { checkIpv4, checkMask, deviceGrammar, normalizeIpv4, normalizeMask } from '../gui/forms';
import type { FormErrors } from '../gui/forms';
import { SettingsField, deviceNotReadyReason, fieldError, runPanelSubmit, useSubmitState } from './WirelessPanel';

// ── plan building ────────────────────────────────────────────────────────────

function makeLine(tokens: readonly Token[], indent = 0): PlanLine {
  const spans: FieldSpan[] = [];
  let text = ' '.repeat(indent);
  tokens.forEach(([t, f], i) => {
    if (i > 0) text += ' ';
    const start = text.length;
    text += t;
    spans.push({ start, end: text.length, field: f });
  });
  return { text, indent, spans };
}

function planOf(grammar: CliGrammar, lines: readonly PlanLine[]): CommandPlan {
  return { grammar, commands: lines.map((l) => l.text), lines: [...lines], options: PANEL_CONFIGURE_OPTIONS[grammar] };
}

/** Free text as one token per word, all attributed to `field`. */
function words(text: string, field: string): Token[] {
  return text
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => [w, field] as Token);
}

// ── the lines each service form writes ───────────────────────────────────────

/** The three services this panel switches on and off. */
export type ServiceKind = 'http' | 'dns' | 'dhcp';

/** Daemon behind each service. */
export const SERVICE_PROCESS: Readonly<Record<ServiceKind, string>> = Object.freeze({
  http: 'http-server',
  dns: 'dns-server',
  dhcp: 'dhcp-server',
});

/** Name of each service in the panel. */
export const SERVICE_LABEL: Readonly<Record<ServiceKind, string>> = Object.freeze({
  http: 'Web service',
  dns: 'Name service',
  dhcp: 'Address service',
});

/** `service http on` / `ip http server` and their off forms. The address service is switched by its pool. */
export function serviceSwitchCommands(grammar: CliGrammar, kind: 'http' | 'dns', on: boolean): CommandPlan {
  // No form field carries these lines, so a refusal belongs in the panel's reason box, not in `fieldErrors`.
  const f = null;
  if (grammar === 'host') return planOf(grammar, [makeLine([['service', f], [kind, f], [on ? 'on' : 'off', f]])]);
  const line: Token[] = [['ip', f], [kind, f], ['server', f]];
  return planOf(grammar, [makeLine(on ? line : [['no', f], ...line])]);
}

/** One page the device serves. */
export interface HttpPageForm {
  path: string;
  text: string;
}

/** `service http page /a Some text` / `ip http page /a Some text`, or their `no` form (the path alone). */
export function httpPageCommands(grammar: CliGrammar, form: HttpPageForm, remove = false): CommandPlan {
  const head: Token[] = grammar === 'host' ? [['service', 'page.path'], ['http', 'page.path']] : [['ip', 'page.path'], ['http', 'page.path']];
  const tokens: Token[] = [...head, ['page', 'page.path'], [form.path.trim(), 'page.path']];
  if (remove) return planOf(grammar, [makeLine([['no', 'page.path'], ...tokens])]);
  // One token, not one per word: the grammar takes the rest of the line verbatim, so the spacing a student
  // typed is what the browser app will be served.
  return planOf(grammar, [makeLine([...tokens, [form.text.trim(), 'page.text']])]);
}

/** One record of the zone the device answers for. */
export interface DnsRecordForm {
  name: string;
  type: string;
  data: string;
  /** Seconds, empty for the daemon's default. */
  ttl: string;
}

/** `service dns record NAME TYPE DATA TTL` / `ip dns record …`, or their `no` form (the same four values). */
export function dnsRecordCommands(grammar: CliGrammar, form: DnsRecordForm, remove = false): CommandPlan {
  const head: Token[] = grammar === 'host' ? [['service', 'record.name'], ['dns', 'record.name']] : [['ip', 'record.name'], ['dns', 'record.name']];
  const ttl = form.ttl.trim();
  const tokens: Token[] = [
    ...head,
    ['record', 'record.name'],
    [form.name.trim(), 'record.name'],
    [form.type.trim().toUpperCase(), 'record.type'],
    [form.data.trim(), 'record.data'],
  ];
  if (ttl !== '' || remove) tokens.push([ttl === '' ? String(DNS_DEFAULT_TTL_S) : ttl, 'record.ttl']);
  return planOf(grammar, [makeLine(remove ? [['no', 'record.name'], ...tokens] : tokens)]);
}

/** A name the device resolves locally. */
export interface HostEntryForm {
  name: string;
  address: string;
}

/** `ip host NAME A` (nfos only: the host shell has no expansion for it), or its `no` form. */
export function hostEntryCommands(form: HostEntryForm, remove = false): CommandPlan {
  const tokens: Token[] = [['ip', 'host.name'], ['host', 'host.name'], [form.name.trim(), 'host.name']];
  if (remove) return planOf('nfos', [makeLine([['no', 'host.name'], ...tokens])]);
  return planOf('nfos', [makeLine([...tokens, ...words(form.address, 'host.address')])]);
}

/** The subnet the device leases addresses from. */
export interface DhcpPoolForm {
  network: string;
  mask: string;
  /** Default gateway handed to the clients; empty for none. */
  router: string;
}

/**
 * `service dhcp pool NET MASK [GW]` on the host shell; on nfos the pool section itself
 * (`ip dhcp pool SERVICE` + `network` + `default-router`), which is what that expansion writes.
 */
export function dhcpPoolCommands(grammar: CliGrammar, form: DhcpPoolForm, poolName: string = SERVICE_POOL_NAME): CommandPlan {
  const network = normalizeIpv4(form.network) ?? form.network.trim();
  const mask = normalizeMask(form.mask) ?? form.mask.trim();
  const router = form.router.trim() === '' ? '' : normalizeIpv4(form.router) ?? form.router.trim();
  if (grammar === 'host') {
    const tokens: Token[] = [['service', 'pool.network'], ['dhcp', 'pool.network'], ['pool', 'pool.network'], [network, 'pool.network'], [mask, 'pool.mask']];
    if (router !== '') tokens.push([router, 'pool.router']);
    return planOf(grammar, [makeLine(tokens)]);
  }
  const lines: PlanLine[] = [
    makeLine([['ip', 'pool.network'], ['dhcp', 'pool.network'], ['pool', 'pool.network'], [poolName, 'pool.network']]),
    makeLine([['network', 'pool.network'], [network, 'pool.network'], [mask, 'pool.mask']], 1),
  ];
  if (router !== '') lines.push(makeLine([['default-router', 'pool.router'], [router, 'pool.router']], 1));
  return planOf(grammar, lines);
}

/** Stop leasing: `service dhcp off` on the host shell, `no ip dhcp pool NAME` on nfos. */
export function dhcpStopCommands(grammar: CliGrammar, poolName: string = SERVICE_POOL_NAME): CommandPlan {
  const f = null;
  if (grammar === 'host') return planOf(grammar, [makeLine([['service', f], ['dhcp', f], ['off', f]])]);
  return planOf(grammar, [makeLine([['no', f], ['ip', f], ['dhcp', f], ['pool', f], [poolName, f]])]);
}

/** Addresses kept out of every pool. */
export interface ExcludedForm {
  low: string;
  /** Last address of a range; empty for a single address. */
  high: string;
}

/** `ip dhcp excluded-address LOW [HIGH]` (nfos only), or its `no` form. */
export function excludedCommands(form: ExcludedForm, remove = false): CommandPlan {
  const low = normalizeIpv4(form.low) ?? form.low.trim();
  const high = form.high.trim() === '' ? '' : normalizeIpv4(form.high) ?? form.high.trim();
  const tokens: Token[] = [['ip', 'excluded.low'], ['dhcp', 'excluded.low'], ['excluded-address', 'excluded.low'], [low, 'excluded.low']];
  if (high !== '') tokens.push([high, 'excluded.high']);
  return planOf('nfos', [makeLine(remove ? [['no', 'excluded.low'], ...tokens] : tokens)]);
}

// ── what the device is running ───────────────────────────────────────────────

/** One page of the web service, as the configuration holds it. */
export interface PageEntry {
  readonly path: string;
  readonly text: string;
}

/** Everything the panel shows about the three services. */
export interface ServicesView {
  readonly http: { readonly enabled: boolean; readonly pages: readonly PageEntry[] };
  readonly dns: { readonly enabled: boolean; readonly records: readonly DnsRecordForm[]; readonly hosts: readonly HostEntryForm[] };
  readonly dhcp: { readonly pool: (DhcpPoolForm & { readonly name: string }) | null; readonly excluded: readonly ExcludedForm[] };
}

/** Everything after the first `count` whitespace-separated words of a config line, spacing kept. */
function restOfLine(raw: string, count: number): string {
  const text = raw.trim();
  let i = 0;
  for (let n = 0; n < count; n++) {
    while (i < text.length && !/\s/.test(text[i] as string)) i++;
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  }
  return text.slice(i);
}

/** Read the service state out of a rendered running config (§6 lines only; negated lines are ignored). */
export function servicesViewOf(runningConfig: string): ServicesView {
  // Page bodies are read from the raw line: the grammar takes the rest of the line verbatim, and so must this.
  const rawLines = runningConfig.split('\n');
  let httpEnabled = false;
  let dnsEnabled = false;
  const pages: PageEntry[] = [];
  const records: DnsRecordForm[] = [];
  const hosts: HostEntryForm[] = [];
  const excluded: ExcludedForm[] = [];
  let pool: (DhcpPoolForm & { name: string }) | null = null;
  for (const l of walkConfigText(runningConfig)) {
    if (l.negate) continue;
    const t = l.tokens;
    if (l.context.length === 0) {
      if (t[0] !== 'ip') continue;
      if (t[1] === 'http' && t[2] === 'server') httpEnabled = true;
      else if (t[1] === 'http' && t[2] === 'page' && t[3] !== undefined) pages.push({ path: t[3], text: restOfLine(rawLines[l.lineNo - 1] ?? '', 4) });
      else if (t[1] === 'dns' && t[2] === 'server') dnsEnabled = true;
      else if (t[1] === 'dns' && t[2] === 'record' && t[3] !== undefined) {
        records.push({ name: t[3], type: t[4] ?? 'A', data: t[5] ?? '', ttl: t[6] ?? '' });
      } else if (t[1] === 'host' && t[2] !== undefined) hosts.push({ name: t[2], address: t.slice(3).join(' ') });
      else if (t[1] === 'dhcp' && t[2] === 'excluded-address' && t[3] !== undefined) excluded.push({ low: t[3], high: t[4] ?? '' });
      else if (t[1] === 'dhcp' && t[2] === 'pool' && t[3] !== undefined) pool = { name: t[3], network: '', mask: '', router: '' };
      continue;
    }
    const head = l.context[0] ?? [];
    if (pool === null || head[0] !== 'ip' || head[1] !== 'dhcp' || head[2] !== 'pool' || head[3] !== pool.name) continue;
    if (t[0] === 'network') pool = { ...pool, network: t[1] ?? '', mask: t[2] ?? '' };
    else if (t[0] === 'default-router') pool = { ...pool, router: t[1] ?? '' };
  }
  return { http: { enabled: httpEnabled, pages }, dns: { enabled: dnsEnabled, records, hosts }, dhcp: { pool, excluded } };
}

/** True when the device runs the daemon behind `kind`. */
export function runsService(device: Pick<DeviceSnapshot, 'processes'>, kind: ServiceKind): boolean {
  return device.processes.some((p) => p.process === SERVICE_PROCESS[kind]);
}

/** State line of a service: a glyph and words, never colour alone. */
export function serviceStateText(on: boolean): { readonly glyph: string; readonly text: string } {
  return on ? { glyph: '●', text: 'running' } : { glyph: '○', text: 'stopped' };
}

// ── client-side checks ───────────────────────────────────────────────────────

/** Longest page path the grammar takes. */
const PATH_MAX = 120;

/** Messages for the add-a-page form. */
export function validatePage(form: HttpPageForm): FormErrors {
  const errors: FormErrors = {};
  const path = form.path.trim();
  if (!path.startsWith('/')) errors['page.path'] = 'A page path starts with a slash, for example /status.';
  else if (path.length > PATH_MAX) errors['page.path'] = `A page path is at most ${PATH_MAX} characters.`;
  else if (/[?#\s]/.test(path)) errors['page.path'] = 'A page path has no spaces, no query and no fragment.';
  if (form.text.trim() === '') errors['page.text'] = 'Give the text this device should serve at that path.';
  return errors;
}

/** Messages for the add-a-record form. */
export function validateRecord(form: DnsRecordForm): FormErrors {
  const errors: FormErrors = {};
  if (form.name.trim() === '') errors['record.name'] = 'Give the name this record answers for.';
  if (form.data.trim() === '') errors['record.data'] = 'Give the address or the target name of the record.';
  else if (form.type === 'A') {
    const bad = checkIpv4(form.data);
    if (bad !== undefined) errors['record.data'] = bad;
  }
  const ttl = form.ttl.trim();
  if (ttl !== '' && !/^\d{1,6}$/.test(ttl)) errors['record.ttl'] = 'A cache time is a whole number of seconds.';
  else if (ttl !== '' && Number(ttl) > 604_800) errors['record.ttl'] = 'A cache time is at most 604800 seconds (one week).';
  return errors;
}

/** Messages for the local-name form. */
export function validateHostEntry(form: HostEntryForm): FormErrors {
  const errors: FormErrors = {};
  if (form.name.trim() === '') errors['host.name'] = 'Give the name to resolve.';
  const bad = checkIpv4(form.address);
  if (bad !== undefined) errors['host.address'] = bad;
  return errors;
}

/** Messages for the address-pool form. */
export function validatePool(form: DhcpPoolForm): FormErrors {
  const errors: FormErrors = {};
  const network = checkIpv4(form.network);
  if (network !== undefined) errors['pool.network'] = network;
  const mask = checkMask(form.mask);
  if (mask !== undefined) errors['pool.mask'] = mask;
  if (form.router.trim() !== '') {
    const router = checkIpv4(form.router);
    if (router !== undefined) errors['pool.router'] = router;
  }
  return errors;
}

/** Messages for the excluded-addresses form. */
export function validateExcluded(form: ExcludedForm): FormErrors {
  const errors: FormErrors = {};
  const low = checkIpv4(form.low);
  if (low !== undefined) errors['excluded.low'] = low;
  if (form.high.trim() !== '') {
    const high = checkIpv4(form.high);
    if (high !== undefined) errors['excluded.high'] = high;
  }
  return errors;
}

// ── panel ────────────────────────────────────────────────────────────────────

const EMPTY_PAGE: HttpPageForm = { path: '', text: '' };
const EMPTY_RECORD: DnsRecordForm = { name: '', type: 'A', data: '', ttl: '' };
const EMPTY_HOST: HostEntryForm = { name: '', address: '' };
const EMPTY_EXCLUDED: ExcludedForm = { low: '', high: '' };

export function ServicesPanel({ device }: { device: DeviceSnapshot }) {
  const uid = useId();
  const grammar = deviceGrammar(device);
  const view = servicesViewOf(device.runningConfig);
  const submit = useSubmitState(device.id);
  const notReady = deviceNotReadyReason(device);
  const disabled = notReady !== undefined || submit.busy;

  const [page, setPage] = useState<HttpPageForm>(EMPTY_PAGE);
  const [record, setRecord] = useState<DnsRecordForm>(EMPTY_RECORD);
  const [host, setHost] = useState<HostEntryForm>(EMPTY_HOST);
  // The pool form opens on what the device already leases from, so editing one value keeps the others.
  const [pool, setPool] = useState<DhcpPoolForm>(() => ({ network: view.dhcp.pool?.network ?? '', mask: view.dhcp.pool?.mask ?? '', router: view.dhcp.pool?.router ?? '' }));
  const [excluded, setExcluded] = useState<ExcludedForm>(EMPTY_EXCLUDED);

  const send = async (errors: FormErrors, build: () => CommandPlan, done?: () => void): Promise<void> => {
    const result = await submit.run(() => runPanelSubmit(engine, device.id, errors, build));
    if (result?.outcome?.ok === true) done?.();
  };

  // Which field inputs this device actually gets: a refusal mapped to any other field would otherwise have
  // nowhere to appear, so the reason box below picks those up.
  const onScreen = new Set<string>();
  const shownError = (key: string): string | undefined => {
    onScreen.add(key);
    return fieldError(submit, key);
  };

  const sections: JSX.Element[] = [];

  if (runsService(device, 'http')) {
    const state = serviceStateText(view.http.enabled);
    sections.push(
      <section key="http" className="insp-section" aria-label={SERVICE_LABEL.http}>
        <div className="panel-title">{SERVICE_LABEL.http}</div>
        <p className="insp-note">
          <span aria-hidden="true">{state.glyph} </span>
          The web service is {state.text}. It answers requests for the pages listed below.
        </p>
        <div className="insp-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => void send({}, () => serviceSwitchCommands(grammar, 'http', !view.http.enabled))}
          >
            {view.http.enabled ? 'Stop the web service' : 'Start the web service'}
          </button>
        </div>
        <table className="table">
          <caption className="dim">Pages this device serves.</caption>
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Text</th>
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            {view.http.pages.length === 0 ? (
              <tr>
                <td colSpan={3}>No page has been published yet; requests get the built-in page.</td>
              </tr>
            ) : (
              view.http.pages.map((p) => (
                <tr key={p.path}>
                  <th scope="row" className="mono">
                    {p.path}
                  </th>
                  <td>{p.text}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled}
                      aria-label={`Remove the page ${p.path}`}
                      onClick={() => void send({}, () => httpPageCommands(grammar, { path: p.path, text: '' }, true))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <dl className="kv">
          <SettingsField label="Path" error={shownError('page.path')} hint="Starts with a slash, for example /status.">
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={page.path}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setPage({ ...page, path: e.target.value });
                  submit.clearField('page.path');
                }}
              />
            )}
          </SettingsField>
          <SettingsField label="Text to serve" error={shownError('page.text')}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input"
                value={page.text}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                onChange={(e) => {
                  setPage({ ...page, text: e.target.value });
                  submit.clearField('page.text');
                }}
              />
            )}
          </SettingsField>
        </dl>
        <div className="insp-actions">
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => void send(validatePage(page), () => httpPageCommands(grammar, page), () => setPage(EMPTY_PAGE))}
          >
            Publish this page
          </button>
        </div>
      </section>,
    );
  }

  if (runsService(device, 'dns')) {
    const state = serviceStateText(view.dns.enabled);
    sections.push(
      <section key="dns" className="insp-section" aria-label={SERVICE_LABEL.dns}>
        <div className="panel-title">{SERVICE_LABEL.dns}</div>
        <p className="insp-note">
          <span aria-hidden="true">{state.glyph} </span>
          The name service is {state.text}. It answers lookups for the records listed below.
        </p>
        <div className="insp-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => void send({}, () => serviceSwitchCommands(grammar, 'dns', !view.dns.enabled))}
          >
            {view.dns.enabled ? 'Stop the name service' : 'Start the name service'}
          </button>
        </div>
        <table className="table">
          <caption className="dim">Records this device answers with.</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Value</th>
              <th scope="col">Cache time</th>
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            {view.dns.records.length === 0 ? (
              <tr>
                <td colSpan={5}>No record has been added yet.</td>
              </tr>
            ) : (
              view.dns.records.map((r) => (
                <tr key={`${r.name} ${r.type} ${r.data}`}>
                  <th scope="row" className="mono">
                    {r.name}
                  </th>
                  <td className="mono">{r.type}</td>
                  <td className="mono">{r.data}</td>
                  <td className="mono">{r.ttl === '' ? String(DNS_DEFAULT_TTL_S) : r.ttl} s</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled}
                      aria-label={`Remove the record for ${r.name}`}
                      onClick={() => void send({}, () => dnsRecordCommands(grammar, r, true))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <dl className="kv">
          <SettingsField label="Name" error={shownError('record.name')} hint="The full name, for example www.lab.nf.">
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={record.name}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setRecord({ ...record, name: e.target.value });
                  submit.clearField('record.name');
                }}
              />
            )}
          </SettingsField>
          <SettingsField label="Type" error={shownError('record.type')}>
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className="select"
                value={record.type}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                onChange={(e) => {
                  setRecord({ ...record, type: e.target.value });
                  submit.clearField('record.type');
                }}
              >
                {DNS_RECORD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </SettingsField>
          <SettingsField label="Value" error={shownError('record.data')} hint="An address for A and AAAA, a target name for CNAME, NS and PTR.">
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={record.data}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setRecord({ ...record, data: e.target.value });
                  submit.clearField('record.data');
                }}
              />
            )}
          </SettingsField>
          <SettingsField label="Cache time (seconds)" error={shownError('record.ttl')} hint={`Leave it empty for ${DNS_DEFAULT_TTL_S} seconds.`}>
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={record.ttl}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                inputMode="numeric"
                onChange={(e) => {
                  setRecord({ ...record, ttl: e.target.value });
                  submit.clearField('record.ttl');
                }}
              />
            )}
          </SettingsField>
        </dl>
        <div className="insp-actions">
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => void send(validateRecord(record), () => dnsRecordCommands(grammar, record), () => setRecord(EMPTY_RECORD))}
          >
            Add this record
          </button>
        </div>

        {grammar === 'nfos' && (
          <>
            <div className="panel-title">Names this device resolves for itself</div>
            <table className="table">
              <tbody>
                {view.dns.hosts.length === 0 ? (
                  <tr>
                    <td>No local name has been set.</td>
                  </tr>
                ) : (
                  view.dns.hosts.map((h) => (
                    <tr key={h.name}>
                      <th scope="row" className="mono">
                        {h.name}
                      </th>
                      <td className="mono">{h.address}</td>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          disabled={disabled}
                          aria-label={`Remove the local name ${h.name}`}
                          onClick={() => void send({}, () => hostEntryCommands(h, true))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <dl className="kv">
              <SettingsField label="Local name" error={shownError('host.name')}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    className="input mono"
                    value={host.name}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setHost({ ...host, name: e.target.value });
                      submit.clearField('host.name');
                    }}
                  />
                )}
              </SettingsField>
              <SettingsField label="Address" error={shownError('host.address')}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    className="input mono"
                    value={host.address}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setHost({ ...host, address: e.target.value });
                      submit.clearField('host.address');
                    }}
                  />
                )}
              </SettingsField>
            </dl>
            <div className="insp-actions">
              <button
                type="button"
                className="btn"
                disabled={disabled}
                onClick={() => void send(validateHostEntry(host), () => hostEntryCommands(host), () => setHost(EMPTY_HOST))}
              >
                Add this name
              </button>
            </div>
          </>
        )}
      </section>,
    );
  }

  if (runsService(device, 'dhcp')) {
    const current = view.dhcp.pool;
    const state = serviceStateText(current !== null && current.network !== '');
    sections.push(
      <section key="dhcp" className="insp-section" aria-label={SERVICE_LABEL.dhcp}>
        <div className="panel-title">{SERVICE_LABEL.dhcp}</div>
        <p className="insp-note">
          <span aria-hidden="true">{state.glyph} </span>
          {current === null || current.network === ''
            ? 'The address service is stopped: it has no subnet to lease from yet.'
            : `The address service is ${state.text}, leasing from ${current.network} ${current.mask}${current.router === '' ? '' : ` with gateway ${current.router}`} (pool ${current.name}).`}
        </p>
        <dl className="kv">
          <SettingsField label="Network address" error={shownError('pool.network')} hint="The subnet to lease from, for example 192.168.1.0.">
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={pool.network}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setPool({ ...pool, network: e.target.value });
                  submit.clearField('pool.network');
                }}
              />
            )}
          </SettingsField>
          <SettingsField label="Subnet mask" error={shownError('pool.mask')} hint="Dotted, or a prefix such as /24.">
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={pool.mask}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setPool({ ...pool, mask: e.target.value });
                  submit.clearField('pool.mask');
                }}
              />
            )}
          </SettingsField>
          <SettingsField label="Gateway for the clients" error={shownError('pool.router')} hint="Leave it empty to hand out no gateway.">
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                className="input mono"
                value={pool.router}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setPool({ ...pool, router: e.target.value });
                  submit.clearField('pool.router');
                }}
              />
            )}
          </SettingsField>
        </dl>
        <div className="insp-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => void send(validatePool(pool), () => dhcpPoolCommands(grammar, pool, current?.name ?? SERVICE_POOL_NAME))}
          >
            Lease from this subnet
          </button>
          {current !== null && (
            <button type="button" className="btn" disabled={disabled} onClick={() => void send({}, () => dhcpStopCommands(grammar, current.name))}>
              Stop the address service
            </button>
          )}
        </div>

        {grammar === 'nfos' && (
          <>
            <div className="panel-title">Addresses never handed out</div>
            <table className="table">
              <tbody>
                {view.dhcp.excluded.length === 0 ? (
                  <tr>
                    <td>Nothing is held back.</td>
                  </tr>
                ) : (
                  view.dhcp.excluded.map((x) => (
                    <tr key={`${x.low} ${x.high}`}>
                      <th scope="row" className="mono">
                        {x.low}
                        {x.high === '' ? '' : ` – ${x.high}`}
                      </th>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          disabled={disabled}
                          aria-label={`Hand out ${x.low} again`}
                          onClick={() => void send({}, () => excludedCommands(x, true))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <dl className="kv">
              <SettingsField label="First address to keep back" error={shownError('excluded.low')}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    className="input mono"
                    value={excluded.low}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setExcluded({ ...excluded, low: e.target.value });
                      submit.clearField('excluded.low');
                    }}
                  />
                )}
              </SettingsField>
              <SettingsField label="Last address of the range" error={shownError('excluded.high')} hint="Leave it empty to keep back a single address.">
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    className="input mono"
                    value={excluded.high}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => {
                      setExcluded({ ...excluded, high: e.target.value });
                      submit.clearField('excluded.high');
                    }}
                  />
                )}
              </SettingsField>
            </dl>
            <div className="insp-actions">
              <button
                type="button"
                className="btn"
                disabled={disabled}
                onClick={() => void send(validateExcluded(excluded), () => excludedCommands(excluded), () => setExcluded(EMPTY_EXCLUDED))}
              >
                Keep these back
              </button>
            </div>
          </>
        )}
      </section>,
    );
  }

  if (sections.length === 0) return <div className="empty-hint">This device offers no network services.</div>;

  // Everything the device refused that no input on screen can show: lines that belong to no field, plus any
  // field this device has no input for. Without this a refused "Start the web service" would say nothing.
  const outcome = submit.outcome;
  const reasons =
    outcome === null
      ? []
      : [...outcome.general, ...Object.entries(outcome.fieldErrors).filter(([k]) => !onScreen.has(k)).map(([, m]) => m)];

  return (
    <div id={`${uid}-services`}>
      {notReady !== undefined && <div className="insp-note">{notReady}</div>}
      {sections}
      {submit.outcome !== null && !submit.outcome.ok && reasons.length > 0 && (
        <div className="reason-box" role="alert">
          {reasons.map((m, i) => (
            <div key={i}>
              <span aria-hidden="true">✖ </span>
              {m}
            </div>
          ))}
        </div>
      )}
      {submit.outcome !== null && submit.outcome.ok && (
        <div className="reason-box ok" role="status">
          <span aria-hidden="true">✔ </span>
          The device accepted the change.
        </div>
      )}
    </div>
  );
}
