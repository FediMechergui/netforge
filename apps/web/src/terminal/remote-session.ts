/**
 * [S13] The terminal side of a remote session (ARCHITECTURE-P3 §6 "Terminal remote session", §3.14 steps 3–5, D14;
 * W3 web-shell). Pure and DOM-free.
 *
 * A console session that runs `telnet` or `ssh -l` relays a session on another device: while the client job holds it,
 * every line typed goes to the far end and the far end answers with its own output and prompt. The engine already
 * puts the far end's prompt into the session's `cliPrompt` events and asks for masked input through the same
 * `CliInputRequest` channel as a local password question (the vty-client's `cliRemote {input: 'secret'}`, both for
 * the local SSH password prompt and while a telnet server echoes, `IAC WILL ECHO`), so the line editor masks it as it
 * masks any secret answer. What the terminal adds:
 *  - the chip "remote: R1 via SSH", from `CliSessionView.remote` (set at the far end's first device prompt);
 *  - no "is running — press Ctrl+C" line after a relayed line: the far end answers with its prompt, as a direct
 *    console would, so a remote session reads like one;
 *  - `?` and Tab are not answered from the local device's grammar while relaying (it is not the far end's): Tab rings
 *    the bell and `?` prints one note.
 *
 * Wording is original.
 */
import type { CliSessionView } from '@netforge/engine';
import { jobStatusLine } from './line-editor';

/** The daemon whose job relays a remote session (the engine's `VTY_CLIENT_PROCESS`; a process name is a stable id). */
export const REMOTE_CLIENT_PROCESS = 'vty-client';

/** The note `?` prints while a remote session holds the console. */
export const REMOTE_HELP_NOTE = '% Help and completion are not available through a remote session here; type each command in full.';

/** The chip text of a session that runs a remote session (`remote: R1 via SSH`), or undefined. */
export function remoteChipText(view: Pick<CliSessionView, 'remote'> | undefined): string | undefined {
  const r = view?.remote?.trim();
  return r === undefined || r === '' ? undefined : `remote: ${r}`;
}

/**
 * Whether a line typed on this session now goes to a far end: a `telnet` / `ssh` job holds the session (its login
 * prompts come before the chip does), or the chip is up.
 */
export function relaysRemote(view: Pick<CliSessionView, 'remote' | 'job'> | undefined): boolean {
  if (view === undefined) return false;
  return view.remote !== undefined || view.job?.process === REMOTE_CLIENT_PROCESS;
}

/**
 * The status line the terminal prints when a line leaves the console busy: the job line of P1 for a local job
 * (ping, tracert, the `ssh` command itself while it connects), nothing for a line relayed to a far end (`relayed` is
 * `relaysRemote` of the session as it was when the line was typed).
 */
export function busyStatusLine(relayed: boolean, jobLabel: string): string | undefined {
  return relayed ? undefined : jobStatusLine(jobLabel);
}
