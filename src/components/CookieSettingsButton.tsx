"use client";

// The one interactive island on the otherwise-static /cookies page, and the
// row in Profile -> Your data. Both do the same thing: ask CookieConsent to
// open its panel.
//
// It dispatches an event rather than importing the panel because the panel is
// already mounted once in the root layout and owns the live state (the current
// grants, the inventory, the in-flight save). A second instance would be a
// second source of truth for what the traveller has agreed to.

import { useI18n } from "@/lib/i18n";
import { openCookiePanel } from "@/lib/cookies/client";

export function CookieSettingsButton({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={openCookiePanel}
      className={
        className ??
        "btn btn-ghost mt-2 block w-full rounded-2xl py-2.5 text-center text-[13px] font-extrabold"
      }
    >
      🍪 {label ?? t("Change my cookie choices")}
    </button>
  );
}
