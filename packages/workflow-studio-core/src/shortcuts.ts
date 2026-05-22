export const SHORTCUTS = {
  undo: 'mod+z',
  redo: 'mod+shift+z',
  copy: 'mod+c',
  paste: 'mod+v',
  cut: 'mod+x',
  delete: ['delete', 'backspace'],
  selectAll: 'mod+a',
  clearSelection: 'escape',
  alignLeft: 'mod+alt+left',
  alignRight: 'mod+alt+right',
  alignTop: 'mod+alt+up',
  alignBottom: 'mod+alt+down',
  autoArrangeSelection: 'mod+shift+a',
  toggleYamlPreview: 'mod+/',
  toggleGridSnap: "mod+'",
  // Single-letter canvas shortcuts (react-hotkeys-hook is configured with
  // enableOnFormTags:false, so these don't fire while typing in the inspector).
  modePan: 'p',
  modeSelect: 's',
  fitView: 'f',
  toggleInteractive: 't',
  toggleGrid: 'g',
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;
