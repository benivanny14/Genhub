"use client";

import { ThemeProvider } from "@/lib/ThemeProvider";
import { I18nProvider } from "@/lib/i18n";
import { CurrencyProvider } from "@/lib/currency";
import { ToastProvider } from "@/components/Toast";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import AgeVerification from "@/components/AgeVerification";
import Footer from "@/components/Footer";

export default function ClientProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <CurrencyProvider>
          <ToastProvider>
            <ConfirmProvider>
              <AgeVerification />
              {children}
              <Footer />
            </ConfirmProvider>
          </ToastProvider>
        </CurrencyProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
