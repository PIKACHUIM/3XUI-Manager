export const TRANSLATED_LOCALES = ["zh-TW", "ja", "ko", "de", "es", "pt", "it", "ar", "ru", "fr"] as const;

export type TranslatedLocale = (typeof TRANSLATED_LOCALES)[number];

export type LocaleRow = readonly [string, string, string, string, string, string, string, string, string, string];

export function expandRows<T extends string>(
  rows: Record<string, LocaleRow>,
): Record<TranslatedLocale, Record<T, string>> {
  return Object.fromEntries(TRANSLATED_LOCALES.map((code, index) => [
    code,
    Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row[index]])),
  ])) as Record<TranslatedLocale, Record<T, string>>;
}
