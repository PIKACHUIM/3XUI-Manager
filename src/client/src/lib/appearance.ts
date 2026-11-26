import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark";
export type ThemePreference = ThemeMode | "system";
export type ThemePreset = "minimal" | "tech" | "techLite" | "gold" | "cute" | "glass";

export interface ThemePresetOption {
  id: ThemePreset;
  zh: string;
  en: string;
  /** Short mood line shown under the name. */
  moodZh: string;
  moodEn: string;
  /** Background, surface and accent used by the swatch preview. */
  preview: readonly [string, string, string];
}

export const THEME_PRESETS: readonly ThemePresetOption[] = [
  { id: "minimal", zh: "简约纯白", en: "Minimal", moodZh: "明净留白 · 克制蓝", moodEn: "Clean white · calm blue", preview: ["#f5f7fa", "#ffffff", "#2873e8"] },
  { id: "tech", zh: "科技大气", en: "Tech", moodZh: "深海蓝 · 电子青", moodEn: "Deep sea · electric cyan", preview: ["#0c1726", "#17314b", "#38c7ee"] },
  { id: "techLite", zh: "科技简约", en: "Tech Lite", moodZh: "浅蓝底 · 精密线", moodEn: "Pale blue · fine lines", preview: ["#edf6fc", "#fafdff", "#087fbd"] },
  { id: "gold", zh: "黑金质感", en: "Black Gold", moodZh: "墨黑 · 琥珀金", moodEn: "Ink black · amber gold", preview: ["#1c1911", "#ffffff", "#f2a12e"] },
  { id: "cute", zh: "清爽可爱", en: "Fresh", moodZh: "薄荷绿 · 圆润", moodEn: "Mint green · rounded", preview: ["#effaf5", "#fbfffd", "#17836c"] },
  { id: "glass", zh: "透明炫酷", en: "Glass", moodZh: "紫雾 · 磨砂层", moodEn: "Violet haze · frosted", preview: ["#f0effb", "#ffffff", "#7260bf"] },
];

const MODE_KEY = "3xui-theme";
const PRESET_KEY = "3xui-preset";
const DEFAULT_PRESET: ThemePreset = "minimal";

export interface Appearance {
  /** What the user picked; "system" follows the OS. */
  preference: ThemePreference;
  /** The mode actually rendered. */
  mode: ThemeMode;
  preset: ThemePreset;
}

function systemMode(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolve(preference: ThemePreference): ThemeMode {
  return preference === "system" ? systemMode() : preference;
}

function read(): Appearance {
  let preference: ThemePreference = "system";
  let preset: ThemePreset = DEFAULT_PRESET;
  try {
    const savedMode = window.localStorage.getItem(MODE_KEY);
    if (savedMode === "light" || savedMode === "dark" || savedMode === "system") preference = savedMode;
    const savedPreset = window.localStorage.getItem(PRESET_KEY);
    if (THEME_PRESETS.some((option) => option.id === savedPreset)) preset = savedPreset as ThemePreset;
  } catch { /* Appearance preferences are optional. */ }
  return { preference, mode: resolve(preference), preset };
}

let snapshot: Appearance = read();
const listeners = new Set<() => void>();
let watching = false;

function applyToDocument(state: Appearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.preset = state.preset;
  root.dataset.mode = state.mode;
  root.style.colorScheme = state.mode;
}

function commit(next: Appearance) {
  snapshot = next;
  applyToDocument(next);
  listeners.forEach((listener) => listener());
}

function watchSystem() {
  if (watching || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  watching = true;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (snapshot.preference !== "system") return;
    const mode = resolve("system");
    if (mode !== snapshot.mode) commit({ ...snapshot, mode });
  });
}

applyToDocument(snapshot);

export function setThemePreference(preference: ThemePreference) {
  try { window.localStorage.setItem(MODE_KEY, preference); } catch { /* Appearance preferences are optional. */ }
  commit({ ...snapshot, preference, mode: resolve(preference) });
}

export function setThemePreset(preset: ThemePreset) {
  try { window.localStorage.setItem(PRESET_KEY, preset); } catch { /* Appearance preferences are optional. */ }
  commit({ ...snapshot, preset });
}

function subscribe(listener: () => void) {
  watchSystem();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
