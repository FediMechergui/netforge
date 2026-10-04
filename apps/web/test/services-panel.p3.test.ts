// Services panel, P3 sections (ARCHITECTURE-P3 §5.5, §5.7, §5.9 "Services panel", D19, D20, §3.7; §7 W3 web-inspector):
// the M15 time service (on/off writes `service ntp on|off`; stratum; clients served) and the [S25] syslog server (on/off
// writes `service syslog on|off`; a severity-filtered message table with number and name, the received stamp beside the
// message's own stamp). Each section shows only where the device runs the daemon.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SEC, createSimulation } from '@netforge/engine';
import type { DeviceSnapshot, StateView, SyslogMessageRow, TableSnapshot } from '@netforge/engine';

vi.mock('../src/bridge/client', () => ({ engine: { configure: vi.fn() } }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = { catalog: [] };
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import {
  NTP_SERVICE_LABEL,
  SERVICE_NTP_STRATUM,
  SYSLOG_FILTER_LEVELS,
  SYSLOG_SERVICE_LABEL,
  ServicesPanel,
  facilityText,
  filterSyslogRows,
  ntpServingOf,
  ntpSwitchCommands,
  runsProcess,
  severityText,
  syslogFilterText,
  syslogRowsOf,
  syslogSwitchCommands,
  timeServicesViewOf,
  type TimeServicesView,
} from '../src/inspector/ServicesPanel';
import type { CommandPlan } from '../src/gui/commands';
import { device } from './canvas-fixtures';

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function msg(seq: number, severity: number, message: string, over: Partial<SyslogMessageRow> = {}): SyslogMessageRow {
  return {
    key: String(seq),
    updatedAt: 0,
    seq,
    from: '10.0.0.1',
    facility: 23,
    severity,
    hostname: 'R1',
    stamp: 'Jan  6 08:10:03.123',
    message,
    receivedStamp: 'Jan  6 08:10:03.130',
    ...over,
  };
}

const MESSAGES: SyslogMessageRow[] = [
  msg(1, 3, '%LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down'),
  msg(2, 5, '%LINEPROTO-5-UPDOWN: Line protocol on Interface GigabitEthernet0/2, changed state to down'),
  msg(3, 4, '%SYS-4-CONFIG: something to warn about', { hostname: undefined, from: '10.0.0.2', stamp: '' }),
];

function table(name: string, rows: object[]): TableSnapshot {
  return { name: name as TableSnapshot['name'], title: name, columns: [], rows: rows as Record<string, unknown>[] };
}

const NTP_VIEW: StateView = { process: 'ntp', state: { peers: [], master: { stratum: 1 }, served: 12 } };
const SYSLOG_VIEW: StateView = { process: 'syslog-server', state: { listening: true, received: 3, malformed: 0 } };

function server(runningConfig: string, processes: StateView[], rows: SyslogMessageRow[] = []): DeviceSnapshot {
  return device('srv1', 0, 0, [], {
    name: 'SRV1',
    type: 'server.nfserver',
    category: 'computers',
    capabilities: ['server'],
    cli: { shell: 'host', grammar: 'host' },
    gui: ['services'],
    runningConfig,
    processes,
    tables: { cam: [], arp: [], rib: [], extra: [table('syslog-messages', rows)] },
  });
}

describe('the lines the time and syslog switches write', () => {
  it('service ntp on|off on the host shell; the ntp master lines on nfos', () => {
    expect(ntpSwitchCommands('host', true).commands).toEqual(['service ntp on']);
    expect(ntpSwitchCommands('host', false).commands).toEqual(['service ntp off']);
    expect(ntpSwitchCommands('nfos', true).commands).toEqual(['ntp master 1']);
    expect(ntpSwitchCommands('nfos', false).commands).toEqual(['no ntp master']);
    expect(SERVICE_NTP_STRATUM).toBe(1);
  });

  it('service syslog on|off on the host shell; the extension line on nfos', () => {
    expect(syslogSwitchCommands('host', true).commands).toEqual(['service syslog on']);
    expect(syslogSwitchCommands('host', false).commands).toEqual(['service syslog off']);
    expect(syslogSwitchCommands('nfos', true).commands).toEqual(['syslog-server enable']);
    expect(syslogSwitchCommands('nfos', false).commands).toEqual(['no syslog-server enable']);
  });

  it('reads the running config: ntp master (8 when no stratum), ntp servers, syslog-server enable', () => {
    expect(timeServicesViewOf('')).toEqual({ ntpServers: [], syslogEnabled: false });
    expect(timeServicesViewOf('ntp master 1\nsyslog-server enable\n')).toEqual({ ntpMaster: 1, ntpServers: [], syslogEnabled: true });
    expect(timeServicesViewOf('ntp master\n')).toEqual({ ntpMaster: 8, ntpServers: [], syslogEnabled: false });
    expect(timeServicesViewOf('ntp server 10.0.0.10\nntp server 10.0.0.11 prefer\n')).toEqual({ ntpServers: ['10.0.0.10', '10.0.0.11'], syslogEnabled: false });
    // a section's child never counts
    expect(timeServicesViewOf('interface Gi0/0\n ntp master 3\n')).toEqual({ ntpServers: [], syslogEnabled: false });
  });

  it('the ntp StateView: served and the master stratum', () => {
    expect(ntpServingOf({ processes: [NTP_VIEW] })).toEqual({ served: 12, masterStratum: 1 });
    expect(ntpServingOf({ processes: [] })).toEqual({ served: 0 });
    expect(runsProcess({ processes: [NTP_VIEW] }, 'ntp')).toBe(true);
    expect(runsProcess({ processes: [NTP_VIEW] }, 'syslog-server')).toBe(false);
  });
});

describe('the switches go through the device\'s own CLI, and the panel reads the result back', () => {
  it('service ntp on|off and service syslog on|off on a server', () => {
    const sim = createSimulation({ seed: 1 });
    sim.addDevice({ id: 'srv1', type: 'server.nfserver', name: 'SRV1', position: { x: 0, y: 0 } });
    sim.runFor(60 * SEC);
    const apply = (plan: CommandPlan): TimeServicesView => {
      const r = sim.configure('srv1', [...plan.commands], { ...plan.options });
      expect(r.ok).toBe(true);
      const d = sim.snapshot().devices.find((x) => x.id === 'srv1');
      return timeServicesViewOf(d?.runningConfig ?? '');
    };
    expect(apply(ntpSwitchCommands('host', true))).toEqual({ ntpMaster: SERVICE_NTP_STRATUM, ntpServers: [], syslogEnabled: false });
    expect(apply(syslogSwitchCommands('host', true))).toEqual({ ntpMaster: SERVICE_NTP_STRATUM, ntpServers: [], syslogEnabled: true });
    expect(apply(ntpSwitchCommands('host', false))).toEqual({ ntpServers: [], syslogEnabled: true });
    expect(apply(syslogSwitchCommands('host', false))).toEqual({ ntpServers: [], syslogEnabled: false });
  });
});

describe('[S25] the syslog message table', () => {
  it('severity as number and name, facility by name, the filter words', () => {
    expect(severityText(5)).toBe('5 notifications');
    expect(severityText(0)).toBe('0 emergencies');
    expect(severityText(9)).toBe('9');
    expect(facilityText(23)).toBe('local7');
    expect(facilityText(99)).toBe('99');
    expect(SYSLOG_FILTER_LEVELS).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(syslogFilterText(7)).toBe('7 debugging (every message)');
    expect(syslogFilterText(4)).toBe('4 warnings and more severe');
    expect(syslogFilterText(0)).toBe('0 emergencies only');
  });

  it('filters at a severity or more severe, newest first', () => {
    expect(filterSyslogRows(MESSAGES, 7).map((r) => r.seq)).toEqual([3, 2, 1]);
    expect(filterSyslogRows(MESSAGES, 4).map((r) => r.seq)).toEqual([3, 1]);
    expect(filterSyslogRows(MESSAGES, 3).map((r) => r.seq)).toEqual([1]);
    expect(filterSyslogRows(MESSAGES, 2)).toEqual([]);
    expect(syslogRowsOf(server('', [], MESSAGES)).length).toBe(3);
    expect(syslogRowsOf(device('x', 0, 0, []))).toEqual([]);
  });
});

describe('the rendered P3 sections', () => {
  it('a server running both daemons with both switched on', () => {
    const html = renderToStaticMarkup(createElement(ServicesPanel, { device: server('ntp master 1\nsyslog-server enable\n', [NTP_VIEW, SYSLOG_VIEW], MESSAGES) }));
    const t = text(html);
    expect(html).toContain(`aria-label="${NTP_SERVICE_LABEL}"`);
    expect(t).toContain("The time service is running: it answers time requests with this device's clock at stratum 1.");
    expect(t).toContain('Stop the time service');
    expect(t).toContain('Stratum 1');
    expect(t).toContain('Requests answered 12');
    expect(html).toContain(`aria-label="${SYSLOG_SERVICE_LABEL}"`);
    expect(t).toContain('The syslog server is running: it keeps every message sent to UDP port 514.');
    expect(t).toContain('Stop the syslog server');
    expect(t).toContain('Messages received: 3; newest first.');
    // the severity filter offers every level, number and name
    for (const n of SYSLOG_FILTER_LEVELS) expect(t).toContain(syslogFilterText(n));
    // one row: number, severity number and name, sender, the message stamp beside the received stamp, the text
    expect(t).toContain(
      '1 3 errors R1 10.0.0.1 · local7 Jan 6 08:10:03.123 Jan 6 08:10:03.130 %LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down',
    );
    // a message without a hostname shows its sender address; one without a stamp a dash
    expect(t).toContain('3 4 warnings 10.0.0.2 10.0.0.2 · local7 — Jan 6 08:10:03.130 %SYS-4-CONFIG');
    // newest first
    expect(t.indexOf('%SYS-4-CONFIG')).toBeLessThan(t.indexOf('%LINEPROTO-5-UPDOWN'));
    expect(t.indexOf('%LINEPROTO-5-UPDOWN')).toBeLessThan(t.indexOf('%LINK-3-UPDOWN'));
  });

  it('both switched off: start buttons, no stratum, an empty table', () => {
    const t = text(renderToStaticMarkup(createElement(ServicesPanel, { device: server('', [{ process: 'ntp', state: { peers: [], served: 0 } }, SYSLOG_VIEW]) })));
    expect(t).toContain('The time service is stopped: this device serves no time of its own.');
    expect(t).toContain('Start the time service');
    expect(t).toContain('Stratum —');
    expect(t).toContain('The syslog server is stopped');
    expect(t).toContain('Start the syslog server');
    expect(t).toContain('No message has arrived yet.');
  });

  it('a device without the daemons shows neither section', () => {
    const t = text(renderToStaticMarkup(createElement(ServicesPanel, { device: server('', []) })));
    expect(t).not.toContain(NTP_SERVICE_LABEL);
    expect(t).not.toContain(SYSLOG_SERVICE_LABEL);
    expect(t).toContain('This device offers no network services.');
  });
});
