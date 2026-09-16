// THE COOKIE POLICY - GENERATED, NOT WRITTEN.
//
// The table on this page is `COOKIE_MANIFEST`, rendered. It is not a
// description of the manifest and it is not a document somebody keeps in sync
// with the manifest: it IS the manifest, so the sentence "these are the cookies
// we use" is true by construction rather than by diligence.
//
// That matters because this is the single most reliably-stale page on any
// website. A cookie policy is written once, at launch, by whoever is closest to
// the legal deadline, and then the product ships forty more releases. Here a
// new `localStorage.setItem` fails cookies.test.ts until it is declared in the
// manifest, and the moment it is declared it appears on this page with the
// purpose and duration whoever declared it had to write down.
//
// Server component: nothing here needs a browser, so it renders as static HTML
// and is indexable. The one interactive element - the button that reopens the
// live preferences panel - is a small client island.

import Link from "next/link";
import type { Metadata } from "next";
import {
  CATEGORY_COPY,
  COOKIE_CATEGORIES,
  COOKIE_POLICY_VERSION,
  entriesFor,
  type CookieCategory,
} from "@/lib/cookies/manifest";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import { CookieSettingsButton } from "@/components/CookieSettingsButton";
import { CookieGate } from "@/components/CookieGate";

export const metadata: Metadata = {
  title: "Cookie Policy - WheelDeal",
  description:
    "Every cookie and browser-storage key WheelDeal uses, what each one is for, how long it lasts, and how to turn the optional ones off.",
  alternates: { canonical: "/cookies" },
  robots: { index: true, follow: true },
};

export default async function CookiesPage() {
  const { getConfig } = await import("@/lib/runtime-config");
  const operator = (await getConfig("OPERATOR_NAME").catch(() => "")) || "the Operator";

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <Link href="/" className="text-[13px] font-bold text-brandblue">
        ← Back
      </Link>

      {/* THE REQUIRED DECISION, when the middleware sent them here. Renders
          nothing otherwise, so this stays an ordinary public policy page for
          everyone else - crawlers included. */}
      <CookieGate />

      <header className="mt-4">
        <h1 className="text-lg font-extrabold text-strong">🍪 Cookie Policy</h1>
        <p className="text-[11px] text-faint">Version {COOKIE_POLICY_VERSION}</p>
      </header>

      <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-soft">
        <p>
          This page lists every cookie and every piece of browser storage {operator} uses in
          WheelDeal, what each one is for, and how long it lasts. It is generated directly from
          the app&apos;s own code, so it cannot fall out of date with what the app actually does.
        </p>
        <p>
          <b className="text-strong">Only the first group is set without asking you.</b> Nothing
          in the Preferences, Analytics or Advertising groups is stored until you say yes, and
          turning a group off deletes what is already stored in it on this device. You can change
          your mind at any time - the button below reopens the same panel you saw when you first
          arrived, and the link in the footer of the app does the same.
        </p>
        <CookieSettingsButton />
      </div>

      <div className="mt-5 space-y-4">
        {COOKIE_CATEGORIES.map((category: CookieCategory) => {
          const entries = entriesFor(category);
          const copy = CATEGORY_COPY[category];
          return (
            <section key={category} className="surface rounded-blob p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[14px] font-extrabold text-strong">{copy.title}</h2>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-extrabold ${
                    category === "necessary"
                      ? "bg-savings-soft text-savings"
                      : "bg-card2 text-faint"
                  }`}
                >
                  {category === "necessary" ? "Always on" : "Off until you allow it"}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-soft">{copy.blurb}</p>
              <p className="mt-1 text-[11px] font-bold leading-snug text-faint">
                {copy.consequence}
              </p>

              <ul className="mt-3 space-y-2">
                {entries.map((e) => (
                  <li key={`${e.medium}:${e.name}`} className="rounded-2xl bg-card2 p-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <code className="break-all font-accent text-[11.5px] font-bold text-strong">
                        {e.name}
                      </code>
                      <span className="text-[10px] font-bold uppercase tracking-wide text-faint">
                        {e.medium === "cookie"
                          ? "cookie"
                          : e.medium === "localStorage"
                            ? "local storage"
                            : "session storage"}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                          e.party === "first"
                            ? "bg-card text-faint"
                            : "bg-warn-soft text-warn"
                        }`}
                      >
                        {e.party === "first" ? "Set by WheelDeal" : `Set by ${e.party}`}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-soft">{e.purpose}</p>
                    <p className="mt-1 text-[11px] font-bold text-faint">Kept: {e.duration}</p>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {/* THE OTHER HALF OF THE ANALYTICS DISCLOSURE. Naming the cookie says
          where the id lives; this says what is recorded against it. Generated
          from the server's own allow-list, which is the list the collection
          endpoint enforces - an event the endpoint would accept and this page
          does not name cannot exist. */}
      <section className="surface mt-4 rounded-blob p-4">
        <h2 className="text-[14px] font-extrabold text-strong">
          If you turn Analytics on, this is the complete list of what is recorded
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-soft">
          Nothing else. The server accepts these events and silently drops anything else, so this
          list is not a summary - it is the filter itself.
        </p>
        <ul className="mt-2 space-y-1">
          {Object.entries(ANALYTICS_EVENTS).map(([name, description]) => (
            <li key={name} className="text-[12px] leading-relaxed text-soft">
              <code className="font-accent text-[11px] font-bold text-strong">{name}</code>
              {" - "}
              {description}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[12px] leading-relaxed text-soft">
          Each record carries the screen you were on with the address stripped down to its shape
          (a search term, a hotel name or a booking reference is removed before anything is
          stored), the time, and the random id above. It is kept with the rest of your account
          data, it is included in the copy you can download from Profile, and deleting your
          account deletes it.
        </p>
      </section>

      <section className="surface mt-4 rounded-blob p-4">
        <h2 className="text-[14px] font-extrabold text-strong">Turning things off elsewhere</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-soft">
          Your browser can block or delete cookies for any site, including this one - the
          Preferences and Analytics groups above are all first-party, so clearing site data
          removes them. Advertising cookies belong to Google and are set on Google&apos;s own
          domains, which is why WheelDeal cannot delete them for you; what it can do, and does, is
          never load Google&apos;s script in the first place unless you allow it.
        </p>
      </section>

      <div className="mt-4 text-[12px] text-faint">
        See also our{" "}
        <Link href="/privacy" className="font-bold text-brandblue underline">
          Privacy Policy
        </Link>{" "}
        and{" "}
        <Link href="/terms" className="font-bold text-brandblue underline">
          Terms of Use
        </Link>
        .
      </div>
    </main>
  );
}
