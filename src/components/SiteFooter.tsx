"use client";

// Global footer: the human behind the product + legal links. Rendered on the
// idle home screen, /deals, /profile and the public landing page. Founder
// contacts come from one constant (src/lib/founder.ts) so they never drift.

import { FOUNDER } from "@/lib/founder";
import { BrandMark } from "./BrandMark";
import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";
import { openCookiePanel } from "@/lib/cookies/client";

export function SiteFooter() {
  const { t } = useI18n();
  return (
    <footer className="mt-10 border-t border-line pb-6 pt-6">
      <div className="mx-auto max-w-md px-1">
        <div className="flex items-center gap-2.5">
          <BrandMark size={30} />
          <div>
            <div className="text-[13px] font-extrabold text-strong">WheelDeal</div>
            <div className="text-[11px] text-faint">
              {t("Your personal AI rental negotiator")}
            </div>
          </div>
        </div>

        <div className="surface mt-4 rounded-blob p-3.5">
          <div className="text-[12px] font-extrabold text-strong">
            {t("Built by a solo founder - and I reply personally")}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-soft">
            {t("Questions, ideas or something felt off? Reach me directly - a real person reads every message.")}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <a
              href={`mailto:${FOUNDER.email}`}
              className="chip flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-strong"
            >
              <Icon name="send" className="h-3.5 w-3.5 text-brandblue" />
              {t("Email me")}
            </a>
            <a
              href={FOUNDER.xUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="chip flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-strong"
            >
              <Icon name="chat" className="h-3.5 w-3.5 text-brandblue" />
              @{FOUNDER.x}
            </a>
            <a
              href={FOUNDER.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="chip flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-strong"
            >
              <Icon name="user" className="h-3.5 w-3.5 text-brandblue" />
              LinkedIn
            </a>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between text-[11px] font-bold text-faint">
          <div className="flex gap-3">
            <a href="/guides" className="hover:text-soft">
              {t("Guides")}
            </a>
            <a href="/terms" className="hover:text-soft">
              {t("Terms")}
            </a>
            <a href="/privacy" className="hover:text-soft">
              {t("Privacy")}
            </a>
            {/* WITHDRAWAL HAS TO BE AS EASY AS CONSENT. A banner you answer
                once and can never reach again is not a choice, it is a
                one-way door - so the panel lives behind a permanent link in
                the one piece of chrome that renders on every screen the
                footer reaches. A button rather than a link to /cookies: the
                policy page explains, this REOPENS the actual switches. */}
            <button
              type="button"
              onClick={openCookiePanel}
              className="font-bold hover:text-soft"
            >
              {t("Cookies")}
            </button>
          </div>
          <span>© {new Date().getFullYear()} WheelDeal</span>
        </div>
      </div>
    </footer>
  );
}
