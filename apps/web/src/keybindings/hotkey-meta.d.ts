import '@tanstack/react-hotkeys';

/**
 * Extra metadata the cheat sheet renders. Declaration merging is the documented
 * extension point, so these travel with the registration and the overlay can
 * read them straight off the live registry rather than a parallel list.
 */
declare module '@tanstack/hotkeys' {
  interface HotkeyMeta {
    /** Section the binding appears under in the cheat sheet. */
    group?: 'Navigation' | 'Panels' | 'Help';
    /** How the chord reads to a human, e.g. `g d` or `Mod+K`. */
    label?: string;
  }
}
