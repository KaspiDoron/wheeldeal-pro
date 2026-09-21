import Link from "next/link";
import { GUIDES, GUIDE_CATEGORY_LABELS, type GuideCategory } from "@/lib/guides";

// The public guides hub. Crawlable, outside the middleware matcher, and listed
// in the sitemap - see src/lib/guides/index.ts for why this exists at all.
// Grouped by category so twenty guides read as a library, not a wall.
export const metadata = {
  title: "Rental guides - WheelDeal",
  description:
    "Honest, practical guides to renting a scooter or car in Southeast Asia: what prices are real, what deposits are normal, and what to check before you ride away.",
  robots: { index: true, follow: true },
};

const CATEGORY_ORDER: GuideCategory[] = [
  "prices",
  "negotiation-logistics",
  "deposits-paperwork",
  "licence-insurance",
  "risk-safety",
];

export default function GuidesPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <Link href="/welcome" className="text-[13px] font-bold text-brandblue">
        ← WheelDeal
      </Link>
      <h1 className="mt-4 text-[26px] font-extrabold leading-tight text-strong">
        Renting a scooter or car abroad, without the guesswork
      </h1>
      <p className="mt-2 text-[14px] leading-relaxed text-soft">
        Everything below is the same ground our agents negotiate on every day -
        real price bands, the deposits that are normal, and the handful of things
        genuinely worth checking before you ride away. No paid rankings and no
        &ldquo;top 10 shops&rdquo; - nobody pays to be mentioned here. Some pages
        end with sponsored search suggestions; they are labelled, and they only
        appear if you allowed advertising cookies.
      </p>
      {/* THE SITE'S SEARCH BOX. A plain GET form, no script: it submits exactly
          what the reader types to /search, which answers with real results from
          these guides. It starts empty on purpose - a pre-filled search box is a
          pattern the ads policy names, because it manufactures intent. */}
      <form action="/search" method="get" role="search" className="mt-5 flex gap-2">
        <input
          type="search"
          name="q"
          required
          maxLength={120}
          autoComplete="off"
          aria-label="Search the guides"
          placeholder="Deposits, prices, licences..."
          className="min-w-0 flex-1 rounded-2xl border-2 border-line bg-card px-4 py-3 text-[16px] text-strong"
        />
        <button type="submit" className="rounded-2xl bg-brandblue px-4 py-3 text-[14px] font-extrabold text-white">
          Search
        </button>
      </form>
      {CATEGORY_ORDER.map((cat) => {
        const inCat = GUIDES.filter((g) => g.category === cat);
        if (inCat.length === 0) return null;
        return (
          <section key={cat} className="mt-8">
            <h2 className="text-[13px] font-extrabold uppercase tracking-wide text-faint">
              {GUIDE_CATEGORY_LABELS[cat]}
            </h2>
            <ul className="mt-3 space-y-3">
              {inCat.map((g) => (
                <li key={g.slug}>
                  <Link
                    href={`/guides/${g.slug}`}
                    className="block rounded-2xl border-2 border-line bg-card p-4 transition hover:border-brandblue/50"
                  >
                    <span className="block text-[15px] font-extrabold text-strong">{g.title}</span>
                    <span className="mt-1 block text-[13px] leading-relaxed text-soft">
                      {g.summary}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
