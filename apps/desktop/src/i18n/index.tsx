import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { localeMessages, supportedLocales, type AppLocale, type MessageKey } from "./locales";

const STORAGE_KEY = "aivs.interface-locale";
type Variables = Record<string, string | number>;

interface I18nContextValue {
  locale: AppLocale;
  direction: "ltr" | "rtl";
  setLocale: (locale: AppLocale) => void;
  t: (key: MessageKey, variables?: Variables) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function initialLocale(): AppLocale {
  const saved = localStorage.getItem(STORAGE_KEY) as AppLocale | null;
  if (saved && supportedLocales.some((item) => item.code === saved)) return saved;
  const browser = navigator.language;
  if (browser.toLowerCase().startsWith("zh-tw") || browser.toLowerCase().startsWith("zh-hk")) return "zh-TW";
  const exact = supportedLocales.find((item) => browser.toLowerCase().startsWith(item.code.toLowerCase()));
  return exact?.code ?? "zh-CN";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(initialLocale);
  const direction = supportedLocales.find((item) => item.code === locale)?.direction ?? "ltr";
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    localStorage.setItem(STORAGE_KEY, locale);
  }, [locale, direction]);
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    direction,
    setLocale: setLocaleState,
    t: (key, variables) => {
      const selected = localeMessages[locale] as Partial<Record<MessageKey, string>>;
      const fallback = locale === "zh-CN" ? localeMessages["zh-CN"] : localeMessages.en;
      let text = selected[key] ?? (fallback as Partial<Record<MessageKey, string>>)[key] ?? localeMessages["zh-CN"][key];
      for (const [name, replacement] of Object.entries(variables ?? {})) text = text.replaceAll(`{${name}}`, String(replacement));
      return text;
    },
  }), [locale, direction]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}

export { supportedLocales };
export type { AppLocale };
