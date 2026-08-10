export interface ShortcutEntry {
  id: string;
  keys: string;
  i18nKey: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: "searchEverywhere", keys: "Double Shift", i18nKey: "settings.shortcuts.searchEverywhere" },
  { id: "globalTextSearch", keys: "Ctrl + Shift + F", i18nKey: "settings.shortcuts.globalTextSearch" },
  { id: "newSession", keys: "Ctrl + N", i18nKey: "settings.shortcuts.newSession" },
  { id: "toggleSidebar", keys: "Ctrl + B", i18nKey: "settings.shortcuts.toggleSidebar" },
  { id: "closeTab", keys: "Ctrl + W", i18nKey: "settings.shortcuts.closeTab" },
  { id: "nextTab", keys: "Ctrl + Tab", i18nKey: "settings.shortcuts.nextTab" },
  { id: "openSettings", keys: "Ctrl + ,", i18nKey: "settings.shortcuts.openSettings" },
  { id: "clearInput", keys: "Ctrl + L", i18nKey: "settings.shortcuts.clearInput" },
  { id: "voiceInput", keys: "Ctrl + Shift + V", i18nKey: "settings.shortcuts.voiceInput" },
];

const keysById = new Map(SHORTCUTS.map((s) => [s.id, s.keys]));

export function getKeysForAction(id: string): string | undefined {
  return keysById.get(id);
}
