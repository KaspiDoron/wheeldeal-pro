import { cleanQuery, searchGuides } from "@/lib/guides/search";
import { categoryOf, marketOf } from "@/lib/traffic/subid";
import { SearchAds, SearchRelatedSlot } from "@/components/traffic/SearchAds";

// THE RESULTS PAGE - and it has to genuinely be one.
//
// A visitor lands here by typing in the box below, or by tapping a related-
// search term on a guide. Either way Google's policy for search ads applies:
// ads may appear only beside REAL results for a query the visitor actually
// made, and never more ads than results. So the list below is a real search of
// this site's own guides (lib/guides/search.ts), rendered on the server, and
// its length is what <SearchAds> is allowed to ask for. An off-topic query gets
// an honest "nothing found" and no ads at all.
//
// NOINDEX, ON PURPOSE. A search results page is not content; letting it into
// an index creates infinite thin URLs, which is precisely the "low value
// content" signal the guides were written to get away from. It is not in
// robots.txt's disallow list, because a crawler has to be able to fetch the
// page to SEE the noindex.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Search the guides - WheelDeal",
  description: "Search WheelDeal's guides to renting a scooter, motorbike or car abroad.",
  robots: { index: false, follow: true },
};

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const query = cleanQuery(first(params.q));
  const market = marketOf(first(params.m) ?? "");
  const category = categoryOf(first(params.c) ?? "");
  const hits = query ? searchGuides(query) : [];
  // Google appends its own click token when a visitor arrives by tapping a
  // related-search term. Its presence is the ONLY thing that lets the term be
  // stored: it marks the words as Google's, generated from a public article,
  // rather than something a person typed. Absent, nothing about the query is
  // kept - the safe direction if Google ever renames the parameter.
  const fromUnit = typeof first(params.afdToken) === "string";

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      {/* Plain anchors throughout, never next/link: this document makes its one
          search-ads request, so every way out of it is a real page load - see
          the same note on the guide page. */}
      <a href="/guides" className="text-[13px] font-bold text-brandblue">
        ← All guides
      </a>

      <h1 className="mt-4 text-[22px] font-extrabold leading-tight text-strong">
        {query ? <>Results for &ldquo;{query}&rdquo;</> : "Search the guides"}
      </h1>

      {/* The box starts EMPTY on purpose. The current query is shown in the
          heading; pre-filling a search box is a pattern the ads policy names,
          because it manufactures the look of intent. */}
      <form action="/search" method="get" role="search" className="mt-4 flex gap-2">
        <input type="hidden" name="m" value={market} />
        <input type="hidden" name="c" value={category} />
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

      {query && <SearchAds query={query} resultCount={hits.length} market={market} category={category} fromUnit={fromUnit} />}

      {query && hits.length > 0 && (
        <section className="mt-6" aria-label="Results">
          <p className="text-[11px] font-bold uppercase tracking-wide text-faint">
            {hits.length} {hits.length === 1 ? "guide" : "guides"} from WheelDeal
          </p>
          <ol className="mt-3 space-y-3">
            {hits.map((h) => (
              <li key={h.slug}>
                {/* A plain anchor, not next/link: the guide carries its own ad
                    request and Google allows one per document, so the hop from
                    here to there should be a real page load. */}
                <a
                  href={`/guides/${h.slug}`}
                  className="block rounded-2xl border-2 border-line bg-card p-4 transition hover:border-brandblue/50"
                >
                  <span className="block text-[15px] font-extrabold text-strong">{h.title}</span>
                  <span className="mt-1 block text-[13px] leading-relaxed text-soft">{h.excerpt}</span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}

      {query && hits.length === 0 && (
        <section className="mt-6 rounded-2xl border-2 border-line bg-card p-4">
          <h2 className="text-[15px] font-extrabold text-strong">Nothing in the guides matches that</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-soft">
            The guides cover rental prices, deposits and paperwork, licences and insurance, safety, and
            negotiating with shops. Try one of those, or{" "}
            <a href="/guides" className="font-bold text-brandblue underline">
              browse all of them
            </a>
            .
          </p>
        </section>
      )}

      {query && hits.length > 0 && <SearchRelatedSlot />}
    </main>
  );
}
