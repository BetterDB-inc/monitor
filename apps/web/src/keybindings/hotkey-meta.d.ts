import '@tanstack/react-hotkeys';

/**
 * Extra metadata the cheat sheet renders. Declaration merging is the documented
 * extension point, so these travel with the registration and the overlay can
 * read them straight off the live registry rather than a parallel list.
 */
declare module '@tanstack/hotkeys' {
  interface HotkeyMeta {
    /**
     * Section the binding appears under in the cheat sheet.
     *
     * Deliberately no `label`: every registration view carries its own `hotkey`
     * or `sequence`, so the display string is derived with the library's
     * `formatForDisplay` at render time. A stored label would be a second copy
     * to keep in step, and would not adapt per platform.
     */
    group?: 'Navigation' | 'Panels' | 'View' | 'Help';
  }
}
