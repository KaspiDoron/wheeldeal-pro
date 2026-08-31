import { NextResponse } from "next/server";
import { requireManagement, requireOwner } from "@/lib/session";
import { getConfig, sbSelectStrict, setConfig } from "@/lib/runtime-config";
import { wabaConfig, wabaBlockReason, WABA_BLOCK_LABELS } from "@/lib/waba/config";
import { governorVerdict } from "@/lib/waba/governor";
import { parseTransportMode } from "@/lib/wa/transports";

export const dynamic = "force-dynamic";

// THE ARCHITECTURE TOGGLES - the no-redeploy switchboard the modular-transport
// design promised. Exactly these keys, validated per key: an owner tapping a
// card must not be able to typo the product into an unknown state, and no
// other config key is writable through this route (the Key Vault remains the
// door for everything else).
const ARCHITECTURE_KEYS = {
  TRANSPORT_MODE: {
    validate: (v: string) => v === "" || parseTransportMode(v) === v,
    hint: "evolution | waba-first | waba-fallback (empty = evolution)",
  },
  WABA_ENABLED: { validate: onOffOrEmpty, hint: "on | off" },
  WABA_DRY_RUN: { validate: onOffOrEmpty, hint: "on | off (default ON - off means REALLY send)" },
  WABA_KILL: { validate: onOffOrEmpty, hint: "on = halt all company-number first contact NOW" },
  CLOUD_API_ENABLED: { validate: onOffOrEmpty, hint: "on | off (legacy owner-number sender)" },
} as const;

function onOffOrEmpty(v: string): boolean {
  return v === "" || v === "on" || v === "off";
}

/** The stored value of every architecture toggle, for the card's readout. */
async function architectureState() {
  const entries = await Promise.all(
    (Object.keys(ARCHITECTURE_KEYS) as (keyof typeof ARCHITECTURE_KEYS)[]).map(async (k) => {
      // FAIL DARK, like every other read on this screen. An unreadable vault
      // used to collapse into "" and render as "unset (default)" - which for
      // WABA_KILL reads as "not killed" and for TRANSPORT_MODE as "evolution".
      // On the one card an owner opens to confirm what is live, a vault
      // brownout looked identical to a healthy Evolution-only deployment.
      let value = "";
      let unreadable = false;
      try {
        value = (await getConfig(k)) ?? "";
      } catch {
        unreadable = true;
      }
      return { key: k, value, unreadable, hint: ARCHITECTURE_KEYS[k].hint };
    })
  );
  return entries;
}

/**
 * Flip one architecture toggle. OWNER only - these switches start and stop
 * live senders, which is above the management tier.
 *
 * HONEST WRITES (the repo's rule for every admin toggle): the response echoes
 * what the vault now actually HOLDS (a fresh read-back), never what was
 * requested - and a write that did not persist says so instead of rendering a
 * happy toggle that resets on the next deploy.
 */
export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    key?: unknown;
    value?: unknown;
    action?: unknown;
    number?: unknown;
  };

  // THE PARTNER OPT-IN, WHICH EXISTED ONLY AS A COMMENT.
  //
  // admitLead refuses a cold template to any shop without `opted_in_at`, and
  // the only writer of that column was an agency messaging the business number
  // FIRST. So on funding day, with every key pasted and the flags flipped,
  // every dispatchHandoff would answer `fallback-legacy/not-opted-in` and 100%
  // of traffic would silently stay on Evolution - with no way to fix it but a
  // hand-written INSERT. The "or the partner form" that schema.sql and
  // leads.ts both promise is this.
  //
  // OWNER only, like every switch on this route: it authorises a cold template
  // to a business on a rented account.
  if (String(body.action ?? "") === "opt-in") {
    const number = String(body.number ?? "").trim();
    const { nationalTail } = await import("@/lib/wa/phone-key");
    const tail = nationalTail(number);
    if (!tail) return NextResponse.json({ error: "Not a usable phone number." }, { status: 400 });
    const { recordAgencyOptIn, agencyOptedIn } = await import("@/lib/waba/leads");
    const wrote = await recordAgencyOptIn(tail, number);
    // HONEST WRITE: the read-back is the answer, never the request.
    const stored = await agencyOptedIn(tail);
    return NextResponse.json({
      ok: wrote && stored,
      optedIn: stored,
      tail,
      ...(stored
        ? {}
        : {
            warning:
              "The opt-in did not persist - waba_agencies is unwritable or has not been migrated.",
          }),
      architecture: await architectureState(),
    });
  }

  const key = String(body.key ?? "");
  const value = String(body.value ?? "").trim().toLowerCase();
  const spec = (ARCHITECTURE_KEYS as Record<string, { validate: (v: string) => boolean; hint: string }>)[key];
  if (!spec) {
    return NextResponse.json(
      { error: `unknown toggle - this route writes only: ${Object.keys(ARCHITECTURE_KEYS).join(", ")}` },
      { status: 400 }
    );
  }
  if (!spec.validate(value)) {
    return NextResponse.json({ error: `invalid value for ${key} - expected ${spec.hint}` }, { status: 400 });
  }

  const wrote = await setConfig(key, value);
  const stored = (await getConfig(key).catch(() => undefined)) ?? "";
  return NextResponse.json({
    ok: wrote.ok && stored === value,
    key,
    // What the vault holds NOW - the card renders this, not the request.
    stored,
    persistent: wrote.persistent,
    ...(wrote.error ? { warning: wrote.error } : {}),
    architecture: await architectureState(),
  });
}

/**
 * The Business Platform console's data. Admin only, bounded reads, no polling.
 *
 * FAIL DARK. `null` means unreadable and the panel renders a dash; it never
 * renders as zero. This repo has twice shipped a surface that reported "all
 * good" because its reads failed to `[]`, and on this screen a false green
 * means "the official number is fine" while it is being restricted.
 */
type Maybe<T> = T | null;

interface LeadRow {
  id: number;
  state: string;
  lane: string | null;
  agency_name: string | null;
  agency_tail: string;
  user_email: string;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  link_tapped_at: string | null;
  traveller_inbound_at: string | null;
  handed_off_at: string | null;
  terminal_reason: string | null;
  error_code: number | null;
  preview: string | null;
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const c = await wabaConfig();
  const blocked = wabaBlockReason(c);
  const degraded: string[] = [];

  const read = await sbSelectStrict<LeadRow>(
    "waba_leads",
    "select=*&order=created_at.desc&limit=200"
  );
  let leads: Maybe<LeadRow[]> = null;
  if ("error" in read) {
    if (read.error === "unavailable") degraded.push("lead ledger");
    else leads = [];
  } else {
    leads = read.rows;
  }

  const agRead = await sbSelectStrict<{
    agency_tail: string;
    agency_name: string | null;
    window_expires_at: string | null;
    template_capped_until: string | null;
    last_template_at: string | null;
    sent_total: number;
    tapped_total: number;
    replied_total: number;
  }>("waba_agencies", "select=*&order=updated_at.desc&limit=200");
  let agencies: Maybe<typeof agRead extends { rows: infer R } ? R : never> = null;
  if ("error" in agRead) {
    if (agRead.error === "unavailable") degraded.push("agency state");
    else agencies = [] as never;
  } else {
    agencies = agRead.rows as never;
  }

  // THE FUNNEL. `tapped` is the column that says whether the message WORKED -
  // delivered and read only say it arrived. No other surface in this product
  // has that signal. EXACT COUNTS, not .length over the newest-200 slice -
  // the exact busy-day-plateaus-at-the-cap defect the Command tab was
  // rewritten to eliminate; the 200-row read stays only for the ledger list
  // below, which is labelled as recent. Dry runs are excluded the same way
  // the governor excludes them (null = pre-migration = counted).
  const { sbCountDark } = await import("@/lib/runtime-config");
  const stageCount = (filter: string) =>
    sbCountDark("waba_leads", `${filter}&dry_run=not.is.true`).then(
      (n) => (n === null ? sbCountDark("waba_leads", filter) : n)
    );
  const [sent, delivered, readN, tapped, travellerContacted, handedOff, held, failed] =
    await Promise.all([
      stageCount("sent_at=not.is.null"),
      stageCount("delivered_at=not.is.null"),
      stageCount("read_at=not.is.null"),
      stageCount("link_tapped_at=not.is.null"),
      stageCount("traveller_inbound_at=not.is.null"),
      stageCount("handed_off_at=not.is.null"),
      stageCount("state=eq.held"),
      stageCount("state=eq.failed"),
    ]);
  const funnel =
    sent === null && delivered === null && handedOff === null
      ? null
      : {
          sent,
          delivered,
          read: readN,
          tapped,
          travellerContacted,
          handedOff,
          held,
          failed,
        };

  const gov = await governorVerdict();

  const { resolveSiteOrigin } = await import("@/lib/site");
  const origin = await resolveSiteOrigin();

  return NextResponse.json({
    generatedAt: Date.now(),
    // THE TWO URLS THE OWNER MUST PASTE INTO META, on the screen instead of in
    // somebody's memory. Resolved from the vaulted APP_DOMAIN so a domain move
    // needs no redeploy here either - and `linkBaseMatches` catches the silent
    // killer: an approved template's button base that does not EQUAL
    // WABA_LINK_BASE is rejected by Meta on every single send, with nothing on
    // any screen to explain why.
    setup: {
      callbackUrl: `${origin}/api/webhooks/waba`,
      expectedLinkBase: `${origin}/h`,
      linkBaseMatches: c.linkBase === `${origin}/h`,
    },
    connection: {
      enabled: c.enabled,
      dryRun: c.dryRun,
      provider: c.provider,
      // Credentials are reported as PRESENT or ABSENT, never echoed. An admin
      // surface has no reason to hand back a key it was given.
      hasKey: Boolean(c.apiKey),
      senderConfigured: Boolean(c.senderId),
      template: c.templateFirstContact || null,
      reengageTemplate: c.templateReengage || null,
      linkBase: c.linkBase || null,
      blocked,
      blockedLabel: blocked ? WABA_BLOCK_LABELS[blocked] : null,
    },
    // ENGINE TRUTH: every code path that can put a message on WhatsApp, and
    // whether it can do so RIGHT NOW. The owner's rule is one sentence - only
    // Evolution sends until real WABA credentials arrive - and until this
    // existed there was no single place that could confirm it. The second
    // official sender (lib/whatsapp.ts) in particular was off only because two
    // Key Vault fields happened to be blank, which is not something a person
    // can see from any screen.
    senders: [
      {
        id: "evolution",
        label: "Evolution (per-user WhatsApp session)",
        live: true,
        detail: "The only live sender. Every traveller message goes out from their own linked number.",
      },
      {
        id: "waba-handoff",
        label: "Business-number handoff (Part 12)",
        live: c.enabled && !c.dryRun && blocked === null,
        detail: !c.enabled
          ? "Off - WABA_ENABLED is not on."
          : blocked
            ? WABA_BLOCK_LABELS[blocked]
            : c.dryRun
              ? "Flag on, but WABA_DRY_RUN is on - composes and records, sends nothing."
              : "LIVE - the official number makes first contact.",
      },
      await (async () => {
        // Its OWN switch (CLOUD_API_ENABLED), deliberately not WABA_ENABLED:
        // rehearsing the handoff lane must never arm this ungoverned sender.
        const wa = await import("@/lib/whatsapp");
        const live = await wa.whatsappConfigured();
        const creds = await wa.whatsappCredentialsPresent();
        return {
          id: "cloud-api",
          label: "Meta Cloud API direct sender (legacy)",
          live,
          detail: live
            ? "LIVE - CLOUD_API_ENABLED is on and Cloud API credentials are set."
            : creds
              ? "Off - credentials ARE set, but CLOUD_API_ENABLED is not on. This is the intended state."
              : "Off - CLOUD_API_ENABLED is not on, and no credentials are set.",
        };
      })(),
    ],
    // The architecture toggles the POST below accepts, with their STORED
    // values - so the card renders what the vault holds, not what it hopes.
    architecture: await architectureState(),
    governor: gov,
    funnel,
    leads,
    agencies,
    degraded,
  });
}
