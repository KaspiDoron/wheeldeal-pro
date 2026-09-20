import Link from "next/link";
import { notFound } from "next/navigation";
import { GUIDES, guideBySlug, GUIDE_CATEGORY_LABELS, type GuideBlock } from "@/lib/guides";
import { resolveSiteOrigin } from "@/lib/site";
import { TrafficPlacement } from "@/components/traffic/TrafficPlacement";
import { guideTargeting } from "@/lib/traffic/targeting";

// Statically generated from the same array the hub and the sitemap read, so a
// guide cannot be listed without existing or exist without being listed.
export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) return { title: "Guide - WheelDeal" };
  return {
    title: `${guide.title} - WheelDeal`,
    description: guide.summary,
    robots: { index: true, follow: true },
  };
}

// One renderer per block kind - the exhaustive switch IS the content model.
// The table wraps in its own horizontal scroller (the repo's wide-element
// rule): the PAGE never scrolls sideways, only the table.
function Block({ block }: { block: GuideBlock }) {
  switch (block.kind) {
    case "p":
      return <p className="mt-2 text-[14px] leading-relaxed text-soft">{block.text}</p>;
    case "list":
      return (
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-soft">
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      );
    case "callout":
      return (
        <p className="mt-3 rounded-2xl border-2 border-brandblue/30 bg-brandblue-soft px-4 py-3 text-[13.5px] font-bold leading-relaxed text-strong">
          {block.text}
        </p>
      );
    case "table":
      return (
        <div className="mt-3 overflow-x-auto overscroll-x-contain rounded-2xl border-2 border-line">
          <table className="w-full min-w-[420px] text-left text-[13px] leading-relaxed">
            <thead>
              <tr className="bg-card2">
                {block.headers.map((h) => (
                  <th key={h} className="px-3 py-2 font-extrabold text-strong">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-line">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-2 text-soft">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) notFound();

  const origin = await resolveSiteOrigin();
  const url = `${origin}/guides/${guide.slug}`;
  // Article + BreadcrumbList (+ FAQPage when the guide carries one) - the
  // structured data derives from the SAME object as the visible page, so the
  // markup cannot describe content that is not there.
  const jsonLd: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: guide.title,
      description: guide.summary,
      dateModified: guide.updated,
      mainEntityOfPage: url,
      author: { "@type": "Organization", name: "WheelDeal" },
      publisher: { "@type": "Organization", name: "WheelDeal" },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Guides", item: `${origin}/guides` },
        { "@type": "ListItem", position: 2, name: guide.title, item: url },
      ],
    },
  ];
  if (guide.faq && guide.faq.length > 0) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: guide.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  const related = guide.related
    .map((s) => guideBySlug(s))
    .filter((g): g is NonNullable<typeof g> => Boolean(g));
  // What this article is about, in the two dimensions traffic is reported by.
  const targeting = guideTargeting(guide.slug);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 pb-safe">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Link href="/guides" className="text-[13px] font-bold text-brandblue">
        ← All guides
      </Link>
      <p className="mt-4 text-[11px] font-extrabold uppercase tracking-wide text-faint">
        {GUIDE_CATEGORY_LABELS[guide.category]}
      </p>
      <h1 className="mt-1 text-[26px] font-extrabold leading-tight text-strong">{guide.title}</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-soft">{guide.summary}</p>
      <p className="mt-1 text-[11px] font-bold text-faint">Updated {guide.updated}</p>

      {guide.sections.map((s) => (
        <section key={s.heading} className="mt-6">
          <h2 className="text-[17px] font-extrabold text-strong">{s.heading}</h2>
          {s.blocks.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </section>
      ))}

      {guide.faq && guide.faq.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[17px] font-extrabold text-strong">Common questions</h2>
          {guide.faq.map((f) => (
            <div key={f.q} className="mt-3">
              <h3 className="text-[14px] font-extrabold text-strong">{f.q}</h3>
              <p className="mt-1 text-[14px] leading-relaxed text-soft">{f.a}</p>
            </div>
          ))}
        </section>
      )}

      <p className="mt-8 rounded-2xl bg-brandblue-soft px-4 py-3 text-[13px] font-bold leading-relaxed text-brandblue">
        WheelDeal&rsquo;s agents message rental shops near your hotel and haggle
        on your behalf, so you see the real local price instead of the tourist
        one.{" "}
        <Link href="/welcome" className="underline">
          See how it works
        </Link>
        .
      </p>

      {/* THE ONE MONETISED PLACEMENT, AFTER THE ARTICLE - never inside it and
          never above it. The ads policy wants the unit "complementary, not the
          focus", and a reader who came for the price table should reach the
          price table first. It renders nothing at all without advertising
          consent, so for most readers this line is simply not on the page. */}
      <TrafficPlacement placement="guide-inline" market={targeting.market} category={targeting.category} />

      {related.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[15px] font-extrabold text-strong">Related guides</h2>
          <ul className="mt-3 space-y-2">
            {related.map((r) => (
              <li key={r.slug}>
                {/* A plain anchor, deliberately not next/link. Each guide makes
                    its own search-ads request and Google allows ONE per
                    document; a soft navigation would keep this document alive
                    and make the next guide's request a second one on the same
                    page. These pages are static, so a real load is cheap. */}
                <a
                  href={`/guides/${r.slug}`}
                  className="block rounded-2xl border-2 border-line bg-card p-3 transition hover:border-brandblue/50"
                >
                  <span className="block text-[13.5px] font-extrabold text-strong">{r.title}</span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-soft">
                    {r.summary}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
