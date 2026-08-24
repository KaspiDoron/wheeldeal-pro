import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import {
  hostOccupancy,
  inviteHeadroom,
  drainAlarm,
  dbLatency,
  pagerDigest,
  worstState,
  WATCHED_KINDS,
  type ChokeState,
} from "@/lib/chokepoints";

// THE CHOKE-POINT PANEL'S DATA (Wave 7, SCALING.md).
//
// Separate from /api/admin/health on purpose. That route is the ROLL CALL -
// "is each service answering" - and it already spends an 8s budget on six
// upstreams. This one answers a different question: "which ceiling are we
// closest to". Its four readings are the four ceilings SCALING.md orders, and
// each carries a threshold, because a number with no threshold beside it is a
// number the owner has to know the ceiling by heart to read.
//
// GET  - the readings.
// POST {action:"digest"} - email the same readings to the signed-in owner,
//        which is the cheap answer to "the three kinds that should page
//        someone are read by nobody". No external error tracker, no new
//        dependency, no new bill: the existing email lib, on demand.

interface Reading {
  id: string;
  label: string;
  state: ChokeState;
  value: string;
  detail: string;
}

async function collect() {
  const now = Date.now();
  const { sbSelect, sbSelectDark, sbCountDark } = await import("@/lib/runtime-config");

  // 1) EVOLUTION HOST OCCUPANCY - the ceiling whose failure mode is a ban.
  //    Read ONCE and used twice: occupancy (paired now) and invite headroom
  //    (how many more testers the fleet could hold if they all linked).
  const fleet = await (async () => {
    try {
      const { hostCapacity } = await import("@/lib/evolution");
      return await hostCapacity();
    } catch {
      return { cap: 0, hosts: [] as { url: string; users: number }[], users: 0, capacity: 0 };
    }
  })();
  const occupancy = hostOccupancy(fleet.hosts, fleet.cap);

  // 1b) INVITED TESTERS vs FLEET CAPACITY - "can I invite 40 more?" as a
  //     number on a screen. The two ceilings live in different modules and
  //     the owner was doing this arithmetic by hand before every invite wave.
  const invites = await (async () => {
    try {
      const { betaAllowlist, BETA_ALLOWLIST_MAX } = await import("@/lib/allowlist");
      const list = await betaAllowlist();
      return inviteHeadroom(list.length, fleet.hosts.length, fleet.cap, BETA_ALLOWLIST_MAX);
    } catch {
      return inviteHeadroom(0, 0, 0, 0);
    }
  })();

  // 2) DRAIN HEARTBEAT - nothing sends unless something pings.
  const lastPing = await sbSelect<{ created_at: string }>(
    "agent_events",
    "select=created_at&kind=eq.cron-ping&order=created_at.desc&limit=1"
  ).catch(() => []);
  const drain = drainAlarm(lastPing[0]?.created_at ?? null, now);

  // 3) DATABASE ROUND TRIP - the PostgREST pool queues before it errors, so
  //    latency is the early symptom and the 504s are the late one. Measured on
  //    a single-row read through the SAME client every request uses.
  const t0 = Date.now();
  const probe = await sbSelectDark<{ id: number }>("agent_events", "select=id&limit=1");
  const db = dbLatency(probe === null ? null : Date.now() - t0);

  // 4) THE KINDS THAT SHOULD PAGE SOMEONE.
  const sinceIso = new Date(now - 24 * 3600_000).toISOString();
  const watched = await Promise.all(
    WATCHED_KINDS.map(async (kind) => {
      const [count, newest] = await Promise.all([
        sbCountDark(
          "agent_events",
          `kind=eq.${encodeURIComponent(kind)}&created_at=gte.${encodeURIComponent(sinceIso)}`
        ),
        sbSelect<{ created_at: string }>(
          "agent_events",
          `select=created_at&kind=eq.${encodeURIComponent(kind)}&order=created_at.desc&limit=1`
        ).catch(() => []),
      ]);
      return { kind: kind as string, count, newestAt: newest[0]?.created_at ?? null };
    })
  );
  const pager = pagerDigest(watched, now);

  const readings: Reading[] = [
    {
      id: "hosts",
      label: "WhatsApp host occupancy",
      state: occupancy.state,
      value: occupancy.pct === null ? "-" : `${occupancy.users}/${occupancy.capacity} (${occupancy.pct}%)`,
      detail: occupancy.detail,
    },
    {
      id: "invites",
      label: "Invited testers vs fleet capacity",
      state: invites.state,
      value:
        invites.capacity === 0
          ? `${invites.invited}/-`
          : `${invites.invited}/${invites.capacity}`,
      detail: invites.detail,
    },
    {
      id: "drain",
      label: "Queue drain heartbeat",
      state: drain.state,
      value: drain.ageMs === null ? "never" : `${Math.round(drain.ageMs / 60_000)}m ago`,
      detail: drain.detail,
    },
    {
      id: "db",
      label: "Database round trip",
      state: db.state,
      value: db.ms === null ? "-" : `${db.ms}ms`,
      detail: db.detail,
    },
    {
      id: "pager",
      label: "Events that should page someone (24h)",
      state: pager.state,
      value: pager.events
        .map((e) => `${e.kind.replace(/^wa-|^media-/, "")}: ${e.count24h === null ? "?" : e.count24h}`)
        .join(" · "),
      detail: pager.headline,
    },
  ];

  return {
    readings,
    overall: worstState(readings.map((r) => r.state)),
    hotHosts: occupancy.hot,
    watched: pager.events,
    checkedAt: new Date(now).toISOString(),
  };
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await collect());
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "digest") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const snapshot = await collect();
  const { sendEmail } = await import("@/lib/email");
  const rows = snapshot.readings
    .map(
      (r) =>
        `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${r.label}</b></td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${r.state.toUpperCase()}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${r.value}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #eee">${r.detail}</td></tr>`
    )
    .join("");
  const out = await sendEmail({
    to: [session.email],
    subject: `WheelDeal choke points - ${snapshot.overall.toUpperCase()}`,
    html:
      `<h2 style="font-family:system-ui">WheelDeal choke points</h2>` +
      `<p style="font-family:system-ui">Snapshot at ${snapshot.checkedAt}. Overall: <b>${snapshot.overall.toUpperCase()}</b>.</p>` +
      `<table style="font-family:system-ui;font-size:14px;border-collapse:collapse">${rows}</table>` +
      `<p style="font-family:system-ui;font-size:12px;color:#666">Sent on demand from Admin -> Keys. This is not an error tracker; it is the counts that already exist, delivered somewhere you will read them.</p>`,
  });

  return NextResponse.json({
    // A SEND THAT DID NOT SEND MUST NOT REPORT SUCCESS. `sendEmail` no-ops
    // when no provider is configured, and reporting that as "sent" would be
    // the same class of lie the email health probe just stopped telling.
    ok: out.sent,
    detail: out.sent
      ? `Digest emailed to ${session.email}${out.provider ? ` via ${out.provider}` : ""}.`
      : out.reason === "unconfigured"
        ? "No email provider is configured, so nothing was sent. Set GMAIL_USER + GMAIL_APP_PASSWORD (or Brevo/Resend) below."
        : `The email provider refused it: ${out.error ?? "unknown error"}`,
  });
}

// maxDuration: the host-occupancy read talks to Evolution, which can be slow.
export const maxDuration = 60;
