/**
 * Every keyboard binding in the app, as data.
 *
 * The cheat sheet renders from the live registry rather than from this file, so
 * the two cannot drift — but keeping the table declarative is what lets the
 * prefix guard below be a test instead of a code review.
 */

import { formatHotkeySequence, type Hotkey } from '@tanstack/hotkeys';
import { Feature } from '@betterdb/shared';

export type BindingGroup = 'Navigation' | 'Panels' | 'Help';

export interface NavChord {
  /** Keys pressed after the leader. `['d']` means `g d`. */
  keys: readonly Hotkey[];
  path: string;
  name: string;
  /**
   * Licence gate, mirroring the `requiredFeature` the sidebar passes to
   * NavItem. A chord for a feature the licence does not cover is never
   * registered, so the keyboard cannot reach a route the mouse cannot.
   */
  requiredFeature?: Feature;
  /** Mirrors the sidebar's `hasVectorSearch` guard. */
  requiresVectorSearch?: boolean;
  /** Mirrors the sidebar's `demoLocked`, which renders an inert label. */
  demoLocked?: boolean;
  /** Routes the sidebar shows in only one of the two deployment modes. */
  availableIn?: 'cloud' | 'self-hosted';
}

/**
 * Everything `availableChords` needs to reach the same verdict the sidebar
 * reaches for the matching nav item.
 */
export interface ChordGates {
  hasFeature: (feature: Feature) => boolean;
  hasVectorSearch: boolean;
  isDemo: boolean;
  isCloud: boolean;
}

/**
 * The leader every navigation chord starts with.
 *
 * Keys are the library's canonical uppercase names — they identify the key, not
 * the character it produces, so the user still presses lowercase `g`.
 */
export const NAV_LEADER: Hotkey = 'G';

/**
 * Navigation chords.
 *
 * A terminal chord cannot also be the prefix of a longer one — `g a` fires the
 * moment `a` lands, so `g a c` could never complete. `v` and `y` are therefore
 * reserved as prefixes and have no single-key chord of their own.
 * `bindings.test.ts` enforces this.
 */
export const NAV_CHORDS: readonly NavChord[] = [
  { keys: ['D'], path: '/', name: 'Dashboard' },
  { keys: ['S'], path: '/slowlog', name: 'Slow log' },
  { keys: ['L'], path: '/latency', name: 'Latency' },
  { keys: ['U'], path: '/cluster', name: 'Cluster' },
  {
    keys: ['A'],
    path: '/anomalies',
    name: 'Anomalies',
    requiredFeature: Feature.ANOMALY_DETECTION,
  },
  { keys: ['M'], path: '/monitor', name: 'Monitor' },
  { keys: ['C'], path: '/clients', name: 'Clients' },
  {
    keys: ['K'],
    path: '/key-analytics',
    name: 'Key analytics',
    requiredFeature: Feature.KEY_ANALYTICS,
  },
  { keys: ['F'], path: '/forecasting', name: 'Forecasting' },
  { keys: ['W'], path: '/webhooks', name: 'Webhooks', demoLocked: true },
  { keys: ['H'], path: '/helper', name: 'AI helper', availableIn: 'self-hosted' },
  {
    keys: ['B'],
    path: '/bulk-delete',
    name: 'Bulk delete',
    requiredFeature: Feature.BULK_DELETE,
    demoLocked: true,
  },
  {
    keys: ['P'],
    path: '/cache-proposals',
    name: 'Cache proposals',
    requiredFeature: Feature.CACHE_INTELLIGENCE,
  },
  {
    keys: ['I'],
    path: '/inference-latency',
    name: 'Inference latency',
    requiresVectorSearch: true,
  },
  { keys: ['R'], path: '/migration', name: 'Migration' },
  { keys: ['O'], path: '/audit', name: 'Audit log' },
  {
    keys: ['N'],
    path: '/workspace/members',
    name: 'Members',
    availableIn: 'cloud',
    demoLocked: true,
  },
  { keys: [','], path: '/settings', name: 'Settings', demoLocked: true },
  { keys: ['V', 'S'], path: '/vector-search', name: 'Vector search', requiresVectorSearch: true },
  { keys: ['V', 'A'], path: '/vector-ai', name: 'Vector AI', requiresVectorSearch: true },
  { keys: ['V', 'C'], path: '/ai-cache-memory', name: 'AI cache memory' },
  { keys: ['V', 'T'], path: '/ai-traces', name: 'AI traces' },
  { keys: ['Y', 'C'], path: '/client-analytics', name: 'Client analytics' },
  { keys: ['Y', 'D'], path: '/client-analytics/deep-dive', name: 'Client analytics deep dive' },
] as const;

/** The full sequence for a chord, leader included. */
export function sequenceFor(chord: NavChord): Hotkey[] {
  return [NAV_LEADER, ...chord.keys];
}

/**
 * How a chord reads to a human. Delegates to the library's formatter rather
 * than joining by hand, so display stays consistent with how it renders every
 * other binding.
 */
export function labelFor(chord: NavChord): string {
  return formatHotkeySequence(sequenceFor(chord));
}

/**
 * The chord that reaches a route, if it has one.
 *
 * Looked up by path rather than passed in as a prop, so a nav item's hint and
 * the binding that actually fires come from the same row and cannot drift.
 */
export function chordForPath(path: string): NavChord | undefined {
  return NAV_CHORDS.find((chord) => {
    return chord.path === path;
  });
}

/**
 * The chords this session can actually use.
 *
 * Gated chords are filtered out rather than redirected: the sidebar sends an
 * unlicensed click to /settings, but a chord that navigated straight to the
 * gated route bypassed that gate entirely and dropped the user on a blank page
 * behind an upgrade prompt. Not registering is the honest equivalent of the
 * link not being there.
 *
 * The licence is only one of four gates the sidebar applies. Demo mode, the
 * vector-search capability and the cloud/self-hosted split each hide nav items
 * too, and a chord that ignored them reached a route the mouse could not.
 */
export function availableChords(gates: ChordGates): NavChord[] {
  return NAV_CHORDS.filter((chord) => {
    if (chord.requiredFeature !== undefined && !gates.hasFeature(chord.requiredFeature)) {
      return false;
    }
    if (chord.requiresVectorSearch === true && !gates.hasVectorSearch) {
      return false;
    }
    if (chord.demoLocked === true && gates.isDemo) {
      return false;
    }
    if (chord.availableIn === 'cloud' && !gates.isCloud) {
      return false;
    }
    if (chord.availableIn === 'self-hosted' && gates.isCloud) {
      return false;
    }
    return true;
  });
}
