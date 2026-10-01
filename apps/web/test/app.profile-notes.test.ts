// The defaults profile in the web at P3 W1 (ARCHITECTURE-P3 D2, §6, §7 W1 web-shell): `profileOfSnapshot` accepts 'P3';
// the "Classic defaults" chip stays P1-only; File → "Use current defaults" is enabled whenever the profile is below
// `LATEST_DEFAULTS_PROFILE` (still 'P2', so for P1 worlds only) with a hint from the `PROFILE_NOTES` data record; and
// `profileForCourse` keeps its rule until the W7 course flip (learn.course-profile.test.ts is unchanged).
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULTS_PROFILES, LATEST_DEFAULTS_PROFILE } from '@netforge/engine';
import type { DefaultsProfile, SimSnapshot } from '@netforge/engine';

const state = vi.hoisted((): Record<string, unknown> => ({}));
vi.mock('../src/bridge/client', () => ({ engine: {}, defaultSeed: () => 1, fmtSimTime: () => '' }));
vi.mock('../src/store/store', () => {
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state), {
    getState: () => state,
    setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
    subscribe: () => () => undefined,
  });
  return { useStore, store: useStore };
});

import { StatusBar, classicDefaultsChip } from '../src/app/StatusBar';
import { USE_CURRENT_DEFAULTS_LABEL } from '../src/app/FileMenu';
import {
  CURRENT_DEFAULTS_IN_USE,
  CURRENT_DEFAULTS_NEWER,
  PROFILE_NOTES,
  currentDefaultsItem,
  currentDefaultsToast,
  isBelowLatest,
  profileForCourse,
  profileNotesBetween,
  profileOfSnapshot,
} from '../src/learn/course-profile';

const world = (profile?: 'P2' | 'P3'): Pick<SimSnapshot, 'profile'> => (profile === undefined ? {} : { profile });

describe('the profile a snapshot reports', () => {
  it('reads P3 as written, beside P2, and P1 when absent', () => {
    expect(profileOfSnapshot(world('P3'))).toBe('P3');
    expect(profileOfSnapshot(world('P2'))).toBe('P2');
    expect(profileOfSnapshot(world())).toBe('P1');
    expect(profileOfSnapshot(null)).toBe('P1');
    expect(profileOfSnapshot({ profile: 'P4' as 'P3' })).toBe('P1');
  });

  it('keeps profileForCourse as it was until the course flip (D2)', () => {
    expect(profileForCourse('ccna1')).toBe('P1');
    expect(profileForCourse('ccna3')).toBe('P2');
    expect(profileForCourse(null)).toBe('P2');
  });
});

describe('the "Classic defaults" chip', () => {
  it('shows for P1 worlds only', () => {
    expect(classicDefaultsChip(world())?.label).toBe('Classic defaults');
    expect(classicDefaultsChip(world('P2'))).toBeNull();
    expect(classicDefaultsChip(world('P3'))).toBeNull();
    expect(classicDefaultsChip(null)).toBeNull();
  });

  function statusBarHtml(snapshot: Pick<SimSnapshot, 'profile'> | null): string {
    Object.assign(state, {
      ready: true,
      snapshot: snapshot === null ? null : { devices: [], links: [], pendingEvents: 0, pduCount: 0, seed: 1, ...snapshot },
      snapshotIndex: null,
      inflight: [],
      droppedEvents: 0,
      tool: 'select',
      addDeviceType: null,
      pendingCable: null,
      camera: { x: 0, y: 0, zoom: 1 },
      selection: null,
      eventsTruncated: 0,
      lab: null,
    });
    return renderToStaticMarkup(createElement(StatusBar));
  }

  it('is in the status bar of a P1 world and absent from P2 and P3 worlds', () => {
    expect(statusBarHtml(world())).toContain('data-testid="classic-defaults"');
    expect(statusBarHtml(world('P2'))).not.toContain('classic-defaults');
    expect(statusBarHtml(world('P3'))).not.toContain('classic-defaults');
    expect(statusBarHtml(null)).not.toContain('classic-defaults');
  });
});

describe('PROFILE_NOTES', () => {
  it('words every profile, the classic one adding nothing', () => {
    expect(Object.keys(PROFILE_NOTES).sort()).toEqual([...DEFAULTS_PROFILES].sort());
    expect(PROFILE_NOTES.P1).toEqual([]);
    for (const p of DEFAULTS_PROFILES.slice(1)) {
      expect(PROFILE_NOTES[p].length, p).toBeGreaterThan(0);
      for (const note of PROFILE_NOTES[p]) {
        expect(note.length, note).toBeGreaterThan(10);
        expect(note, note).toBe(note.trim());
        expect(note.endsWith('.'), note).toBe(false);
      }
    }
    expect(PROFILE_NOTES.P2[0]).toMatch(/spanning tree/);
    expect(PROFILE_NOTES.P3[0]).toMatch(/^CDP /);
  });

  it('names no vendor or product (original wording, D23)', () => {
    const banned = /cisco|\bios\b|catalyst|packet\s*tracer|wireshark|juniper|huawei/i;
    for (const note of Object.values(PROFILE_NOTES).flat()) expect(note, note).not.toMatch(banned);
  });

  it('lists the notes of every profile after the current one, up to the target', () => {
    expect(profileNotesBetween('P1', 'P2')).toEqual([...PROFILE_NOTES.P2]);
    expect(profileNotesBetween('P1', 'P3')).toEqual([...PROFILE_NOTES.P2, ...PROFILE_NOTES.P3]);
    expect(profileNotesBetween('P2', 'P3')).toEqual([...PROFILE_NOTES.P3]);
    expect(profileNotesBetween('P2', 'P2')).toEqual([]);
    expect(profileNotesBetween('P3', 'P2')).toEqual([]);
  });
});

describe('File → "Use current defaults"', () => {
  it('is enabled exactly for the profiles below LATEST_DEFAULTS_PROFILE', () => {
    expect(USE_CURRENT_DEFAULTS_LABEL).toBe('Use current defaults');
    for (const p of DEFAULTS_PROFILES) {
      const below = DEFAULTS_PROFILES.indexOf(p) < DEFAULTS_PROFILES.indexOf(LATEST_DEFAULTS_PROFILE);
      expect(isBelowLatest(p), p).toBe(below);
      expect(currentDefaultsItem(p).enabled, p).toBe(below);
    }
    // Before the W7 flip LATEST_DEFAULTS_PROFILE is 'P2', so only a P1 world is offered the move, as in P2.
    expect(currentDefaultsItem('P1', 'P2')).toEqual({
      enabled: true,
      hint: 'Keeps every device and setting. Adds: spanning tree on the switches; proxy ARP on router interfaces; controller discovery on lightweight access points.',
    });
    expect(currentDefaultsItem('P2', 'P2')).toEqual({ enabled: false, hint: CURRENT_DEFAULTS_IN_USE });
    expect(currentDefaultsItem('P3', 'P2')).toEqual({ enabled: false, hint: CURRENT_DEFAULTS_NEWER });
    expect(CURRENT_DEFAULTS_IN_USE).toBe('Already in use in this world.');
  });

  it('with P3 as the latest profile (the W7 flip), offers the move to P2 worlds too and lists the P3 notes', () => {
    expect(isBelowLatest('P2', 'P3')).toBe(true);
    expect(currentDefaultsItem('P2', 'P3')).toEqual({
      enabled: true,
      hint: `Keeps every device and setting. Adds: ${PROFILE_NOTES.P3.join('; ')}.`,
    });
    const fromClassic = currentDefaultsItem('P1', 'P3');
    expect(fromClassic.enabled).toBe(true);
    expect(fromClassic.hint).toBe(`Keeps every device and setting. Adds: ${[...PROFILE_NOTES.P2, ...PROFILE_NOTES.P3].join('; ')}.`);
    expect(currentDefaultsItem('P3', 'P3')).toEqual({ enabled: false, hint: CURRENT_DEFAULTS_IN_USE });
  });

  it('toasts what the move switched on', () => {
    expect(currentDefaultsToast(3, 'P1', 'P2')).toBe(
      'Current defaults in use: 3 devices kept their configuration. Added: spanning tree on the switches; proxy ARP on router interfaces; controller discovery on lightweight access points.',
    );
    expect(currentDefaultsToast(1, 'P2', 'P2')).toBe('Current defaults in use: 1 device kept its configuration.');
    const [from, to]: readonly DefaultsProfile[] = ['P2', 'P3'];
    expect(currentDefaultsToast(0, from ?? 'P2', to ?? 'P3')).toBe(`Current defaults in use: 0 devices kept their configuration. Added: ${PROFILE_NOTES.P3.join('; ')}.`);
  });
});
