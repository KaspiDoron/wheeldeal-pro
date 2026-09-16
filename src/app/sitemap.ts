import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site";

// Only the pages a signed-out visitor (and therefore a crawler) can actually
// reach. Listing a gated route would advertise a redirect to /login as content,
// which is exactly the "low value content" an AdSense reviewer rejects.
//
// Kept in step with `src/middleware.ts`: every path here is OUTSIDE that
// matcher, so none of them bounces to /login.
const PUBLIC_PATHS = [
  { path: "/welcome", priority: 1, changeFrequency: "weekly" as const },
  { path: "/guides", priority: 0.9, changeFrequency: "monthly" as const },
  { path: "/pricing", priority: 0.8, changeFrequency: "monthly" as const },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" as const },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" as const },
  // The cookie policy is public, indexable and linked from the banner every
  // visitor sees - a crawler finding it only through a bottom sheet is a
  // crawler that does not find it.
  { path: "/cookies", priority: 0.3, changeFrequency: "yearly" as const },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await resolveSiteOrigin();
  const { GUIDES } = await import("@/lib/guides");
  return [
    ...PUBLIC_PATHS.map(({ path, priority, changeFrequency }) => ({
      url: `${origin}${path}`,
      changeFrequency,
      priority,
    })),
    // DERIVED FROM THE GUIDES THEMSELVES, never a second hand-kept list: a
    // sitemap that can disagree with the pages it advertises is worse than no
    // sitemap, because a crawler that hits a 404 from it discounts the rest.
    ...GUIDES.map((g) => ({
      url: `${origin}/guides/${g.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
