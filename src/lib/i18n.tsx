"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { translations, type Locale } from "@/lib/translations";

export { translations, type Locale };

interface I18nContextType {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType>({
  locale: "en",
  setLocale: () => {},
  t: (key: string) => key,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("genhub-locale") as Locale | null;
    if (saved && (saved === "en" || saved === "sw")) {
      setLocaleState(saved);
    }
  }, []);

  function setLocale(l: Locale) {
    setLocaleState(l);
    if (mounted) {
      localStorage.setItem("genhub-locale", l);
    }
  }

  function t(key: string, params?: Record<string, string | number>): string {
    const entry = translations[key];
    if (!entry) return key;
    let text = entry[locale] || entry.en || key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      });
    }
    return text;
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}
