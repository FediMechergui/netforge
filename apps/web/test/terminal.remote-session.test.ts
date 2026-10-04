/**
 * [S13] The terminal's remote session (ARCHITECTURE-P3 §6 "Terminal remote session", §3.14 steps 3–5, §10.2
 * "terminal.remote"; W3 web-shell).
 *
 * Under test, against the contract's `CliSessionView` (the vty-client and the runtime are other W2/W3 items): the chip
 * "remote: R1 via SSH" from `CliSessionView.remote`, on the console and in the dock's strip (where it replaces the
 * per-line "running" badge); when a typed line is relayed to a far end (a `telnet` / `ssh` job holds the session, or
 * the chip is up) and so prints no job line; masked input for the far end's password prompt (WILL ECHO) and the local
 * SSH password prompt, which arrive as a `secret` `CliInputRequest` exactly as a local password question does; and
 * the note `?` gives instead of the local grammar's help.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CliInputRequest, CliSessionView } from '@netforge/engine';

// xterm needs a browser; a server render of the tab never constructs it (effects do not run)
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('../src/bridge/client', () => ({ engine: {} }));
// the strip's "Open console…" menu positions itself in a layout effect, which a server render cannot run
vi.mock('../src/app/Menu', () => ({ Menu: () => null, MenuHeading: () => null, MenuItem: () => null }));
vi.mock('../src/store/store', () => {
  const state: Record<string, unknown> = {};
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { useStore } from '../src/store/store';
import { LineEditor, editorModeFor, jobStatusLine, type KeyEventLike } from '../src/terminal/line-editor';
import { REMOTE_CLIENT_PROCESS, REMOTE_HELP_NOTE, busyStatusLine, relaysRemote, remoteChipText } from '../src/terminal/remote-session';
import { TerminalPanel } from '../src/terminal/TerminalPanel';
import { TerminalTab } from '../src/terminal/TerminalTab';
import { device, snapshot } from './canvas-fixtures';

const setState = (useStore as unknown as { setState(p: Record<string, unknown>): void }).setState;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** A console session of PC1, as the runtime's `viewOf` builds it. */
function session(extra: Partial<CliSessionView> = {}): CliSessionView {
  return { id: 's_1', device: 'pc1', via: 'console', mode: 'user-exec', privilege: 1, prompt: 'PC1>', busy: false, history: [], grammar: 'host', ...extra };
}

/** PC1's session while it relays an SSH session on R1 (§3.14 step 4): the remote prompt, the client job, the chip. */
const RELAYING = session({ prompt: 'R1>', job: { process: 'vty-client', label: 'ssh' }, remote: 'R1 via SSH' });

const key = (k: string): KeyEventLike => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

function world(view: CliSessionView): void {
  setState({
    snapshot: snapshot([device('pc1', 0, 0, [])], [], { sessions: [view] }),
    terminals: [{ session: view.id, device: 'pc1', title: 'PC1' }],
    activeTerminal: view.id,
    setActiveTerminal: () => undefined,
  });
}

beforeEach(() => {
  setState({ snapshot: null, terminals: [], activeTerminal: null });
});

describe('the chip and the relay, from CliSessionView', () => {
  it('reads "remote: R1 via SSH" from CliSessionView.remote, and nothing without it', () => {
    expect(remoteChipText(RELAYING)).toBe('remote: R1 via SSH');
    expect(remoteChipText(session({ remote: 'SW1 via Telnet' }))).toBe('remote: SW1 via Telnet');
    expect(remoteChipText(session())).toBeUndefined();
    expect(remoteChipText(session({ remote: '  ' }))).toBeUndefined();
    expect(remoteChipText(undefined)).toBeUndefined();
  });

  it('knows a typed line goes to the far end: a telnet/ssh job holds the session (login prompts come first), or the chip is up', () => {
    expect(REMOTE_CLIENT_PROCESS).toBe('vty-client');
    expect(relaysRemote(RELAYING)).toBe(true);
    // the far end's login prompts arrive before its first device prompt sets the chip
    expect(relaysRemote(session({ prompt: 'Username: ', job: { process: 'vty-client', label: 'telnet' } }))).toBe(true);
    expect(relaysRemote(session({ job: { process: 'icmpv4', label: 'ping' }, busy: true }))).toBe(false);
    expect(relaysRemote(session())).toBe(false);
    expect(relaysRemote(undefined)).toBe(false);
  });

  it('prints the job line for a local job (the ssh command while it connects) and none for a relayed line', () => {
    expect(busyStatusLine(false, 'ssh')).toBe(jobStatusLine('ssh'));
    expect(busyStatusLine(false, 'ping')).toBe('ping is running — press Ctrl+C to stop it.');
    expect(busyStatusLine(true, 'ssh')).toBeUndefined();
    expect(REMOTE_HELP_NOTE).toMatch(/^% .*remote session/);
  });
});

describe('masked input', () => {
  // The runtime's relay question (cli/runtime.ts relayInputOf): the far end's password prompt while it echoes
  // (IAC WILL ECHO), or the vty-client's local SSH password prompt — both `cliRemote {input: 'secret'}`.
  const REMOTE_PASSWORD: CliInputRequest = { kind: 'secret', prompt: 'Password: ' };

  it('echoes nothing of a remote password, keeps it out of the history, and still sends it', () => {
    const ed = new LineEditor();
    ed.history.push('ssh -l admin 192.168.10.1');
    ed.setMode(editorModeFor(REMOTE_PASSWORD.kind));
    expect(ed.redrawAll(REMOTE_PASSWORD.prompt)).toEqual(['Password: ']);
    for (const ch of 's3cret?') expect(ed.handleKey(ch, key(ch))).toEqual({ type: 'edit', writes: [] });
    // Tab is not completion in an answer, and ↑ never recalls a command into it
    expect(ed.handleKey('\t', key('Tab'))).toEqual({ type: 'none', writes: [] });
    expect(ed.handleKey('\x1b[A', key('ArrowUp'))).toEqual({ type: 'none', writes: [] });
    expect(ed.handleKey('\r', key('Enter'))).toEqual({ type: 'submit', line: 's3cret?', writes: ['\r\n'] });
    expect(ed.history).toEqual(['ssh -l admin 192.168.10.1']);
  });

  it('shows the remote prompt again in the clear once the far end stops asking', () => {
    const ed = new LineEditor();
    ed.setMode(editorModeFor('secret'));
    ed.setMode(editorModeFor(undefined));
    expect(ed.redrawAll(RELAYING.prompt)).toEqual(['R1>']);
    expect(ed.handleKey('s', key('s'))).toEqual({ type: 'edit', writes: ['s\x1b[J'] });
  });
});

describe('the console and the dock strip', () => {
  it('the console shows the chip in a live region and names it in its label', () => {
    world(RELAYING);
    const html = renderToStaticMarkup(createElement(TerminalTab, { tab: { session: 's_1', device: 'pc1', title: 'PC1' }, active: true }));
    expect(html).toContain('aria-label="Console on PC1, remote: R1 via SSH"');
    expect(html).toContain('is-remote');
    expect(text(html)).toContain('remote: R1 via SSH');
    expect(/class="terminal-remote-chip" role="status" aria-live="polite">.*remote: R1 via SSH<\/span>/.test(html)).toBe(true);
    expect(html).toContain('class="terminal-xterm"');
  });

  it('a local console keeps its label and an empty chip region', () => {
    world(session());
    const html = renderToStaticMarkup(createElement(TerminalTab, { tab: { session: 's_1', device: 'pc1', title: 'PC1' }, active: true }));
    expect(html).toContain('aria-label="Console on PC1"');
    expect(html).not.toContain('is-remote');
    expect(html).toContain('<span class="terminal-remote-chip" role="status" aria-live="polite"></span>');
  });

  it('the strip shows the chip instead of the per-line "running" badge', () => {
    world({ ...RELAYING, busy: true });
    const remote = renderToStaticMarkup(createElement(TerminalPanel));
    expect(remote).toContain('<span class="terminal-chip-remote">remote: R1 via SSH</span>');
    expect(remote).not.toContain('terminal-chip-busy');
    expect(remote).toContain(', remote: R1 via SSH — middle-click to close');
    world(session({ busy: true, job: { process: 'icmpv4', label: 'ping' } }));
    const local = renderToStaticMarkup(createElement(TerminalPanel));
    expect(local).toContain('<span class="terminal-chip-busy">running</span>');
    expect(local).not.toContain('terminal-chip-remote');
  });
});
