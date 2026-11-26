import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { CSSProperties } from "react";
import { say, type Locale } from "../lib/i18n";
import { setThemePreference, setThemePreset, THEME_PRESETS, useAppearance, type ThemePreference } from "../lib/appearance";

const MODES: ReadonlyArray<{ id: ThemePreference; zh: string; en: string; icon: typeof Sun }> = [
  { id: "light", zh: "浅色", en: "Light", icon: Sun },
  { id: "dark", zh: "深色", en: "Dark", icon: Moon },
  { id: "system", zh: "跟随系统", en: "System", icon: Monitor },
];

/** Mode switch plus the six theme presets; shared by the header popover and the display settings tab. */
export function AppearancePanel({ locale }: { locale: Locale }) {
  const { preference, preset } = useAppearance();
  return <div className="appearance-panel">
    <div className="appearance-section">
      <div className="appearance-label">{say(locale, "明暗模式", "Mode")}</div>
      <div className="mode-tabs" role="radiogroup" aria-label={say(locale, "明暗模式", "Mode")}>
        {MODES.map(({ id, zh, en, icon: Icon }) => <button key={id} type="button" role="radio" aria-checked={preference === id} className={preference === id ? "active" : ""} onClick={() => setThemePreference(id)}><Icon size={14} />{say(locale, zh, en)}</button>)}
      </div>
    </div>
    <div className="appearance-section">
      <div className="appearance-label">{say(locale, "界面主题", "Theme")}</div>
      <div className="preset-grid" role="radiogroup" aria-label={say(locale, "界面主题", "Theme")}>
        {THEME_PRESETS.map((option) => <button key={option.id} type="button" role="radio" aria-checked={preset === option.id} className={`preset-card ${preset === option.id ? "selected" : ""}`} onClick={() => setThemePreset(option.id)}>
          <span className="preset-preview" aria-hidden="true" style={{ "--pv-bg": option.preview[0], "--pv-surface": option.preview[1], "--pv-accent": option.preview[2] } as CSSProperties}>
            <span className="preset-preview-side" />
            <span className="preset-preview-body"><i /><i /><i /></span>
          </span>
          <span className="preset-copy"><b>{say(locale, option.zh, option.en)}</b><small>{say(locale, option.moodZh, option.moodEn)}</small></span>
          <span className="preset-check" aria-hidden="true"><Check size={12} /></span>
        </button>)}
      </div>
    </div>
  </div>;
}
