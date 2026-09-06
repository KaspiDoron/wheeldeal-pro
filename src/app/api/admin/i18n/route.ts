import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getConfigExact } from "@/lib/runtime-config";
import { readOverrides, setOverride, MAX_OVERRIDES_PER_LANG } from "@/lib/i18n-overrides";
// NOTE: `@/lib/i18n` is deliberately NOT imported here. It is a "use client"
// module carrying the whole React provider, and the language list it exports is
// already available to the admin panel, which is itself a client component.
// Pulling it into a route handler would drag hooks into the server bundle to
// re-send a constant the caller already has.

export const dynamic = "force-dynamic";

const LANG_RX = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * TRANSLATION REPAIR - Wave C / M23.
 *
 * A machine translation that reads wrong in the target language used to be
 * unfixable without a deploy: the owner could change the English source (which
 * changes it for everyone) or ship code. This is the third option.
 *
 * Admin-gated and never polled - opened by a human who has been told a string
 * is wrong.
 */
export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const lang = new URL(req.url).searchParams.get("lang")?.trim() ?? "";
  if (!LANG_RX.test(lang)) {
    return NextResponse.json({ error: "Invalid language." }, { status: 400 });
  }

  const [overrides, rawMachine] = await Promise.all([
    readOverrides(lang),
    getConfigExact(`I18N_${lang}`).catch(() => undefined),
  ]);

  let machine: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(rawMachine ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      machine = parsed as Record<string, string>;
    }
  } catch {
    /* an unreadable machine cache is an empty one - corrections still show */
  }

  // Both sides travel, because a correction is only judgeable NEXT TO the
  // machine output it replaces. Showing the override alone would not tell the
  // owner whether it is still needed after a re-translation.
  return NextResponse.json({
    lang,
    overrides,
    machineCount: Object.keys(machine).length,
    // Only the entries the owner has corrected carry their machine counterpart -
    // shipping the whole dictionary would be megabytes on an admin screen.
    machineFor: Object.fromEntries(
      Object.keys(overrides).map((k) => [k, machine[k] ?? ""])
    ),
    limit: MAX_OVERRIDES_PER_LANG,
  });
}

/**
 * Set or clear one correction. An empty `text` clears it, which is how the
 * owner reverts to the machine translation without a second verb.
 */
export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const lang = String(body.lang ?? "").trim();
  if (!LANG_RX.test(lang)) {
    return NextResponse.json({ error: "Invalid language." }, { status: 400 });
  }
  // English is the source. "Correcting" it here would write a row that nothing
  // reads, which is worse than refusing - it looks like it worked.
  if (lang === "en") {
    return NextResponse.json(
      { error: "English is the source language - edit the string in the code instead." },
      { status: 400 }
    );
  }

  const res = await setOverride(lang, String(body.source ?? ""), String(body.text ?? ""));
  if (!res.ok) {
    // HONEST WRITE. A store that did not answer, or a write that did not land,
    // is not the owner's mistake: 502 says "nothing changed, try again", where
    // a 400 would send them hunting for a typo in a correct correction.
    return NextResponse.json({ error: res.error }, { status: res.kind === "store" ? 502 : 400 });
  }
  return NextResponse.json({ ok: true, count: res.count });
}
