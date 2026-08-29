import { NextResponse } from "next/server";
import { requireManagement, setAdmin, adminEmails, isOwner } from "@/lib/session";
import { listUsers, setUserStatus, deleteUser } from "@/lib/access";
import { disconnectInstance } from "@/lib/evolution";
import { sbDelete, sbSelect } from "@/lib/runtime-config";

/**
 * THE MANAGEMENT LIST SHIPPED EVERY PASSWORD HASH TO A BROWSER.
 *
 * `...u` spread the whole UserRecord, so this endpoint returned every account's
 * scrypt `passwordHash` and their home-stay coordinates - to any admin session,
 * over the network, into a browser's memory, its network log and whatever
 * extension is watching. Nothing in the admin UI has ever read either field;
 * they rode along because the spread was easier than a projection.
 *
 * An admin is trusted to manage accounts. That is not the same as being handed
 * offline-crackable material for every user, and `stayLat`/`stayLng` are where
 * a traveller sleeps - the single most sensitive value this product stores, and
 * the one the whole `stayShareConsentAt` gate exists to protect. A consent gate
 * on the shop-facing path means nothing if the admin path spreads it anyway.
 *
 * ALLOW-LIST, not a deny-list: a deny-list leaks every field added later, and
 * this record has grown four times since it was written.
 */
function publicUser(u: import("@/lib/access").UserRecord, role: string) {
  return {
    email: u.email,
    phone: u.phone,
    name: u.name,
    provider: u.provider,
    status: u.status,
    plan: u.plan,
    termsAcceptedAt: u.termsAcceptedAt,
    termsVersion: u.termsVersion,
    waRiskAcceptedAt: u.waRiskAcceptedAt,
    aiResponsibilityAcceptedAt: u.aiResponsibilityAcceptedAt,
    // The LABEL is what a human needs to recognise a traveller's stay. The
    // coordinates are not, so they do not leave the server.
    stayLabel: u.stayLabel,
    stayShareConsentAt: u.stayShareConsentAt,
    addedAt: u.addedAt,
    lastSeen: u.lastSeen,
    role,
  };
}

async function payload() {
  const [admins, users] = await Promise.all([adminEmails(), listUsers()]);
  return {
    users: users.map((u) =>
      publicUser(u, isOwner(u.email) ? "owner" : admins.includes(u.email) ? "admin" : "user")
    ),
    admins,
  };
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await payload());
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { email, action, status } = await req.json().catch(() => ({}));
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  if (action === "delete") {
    // Permanently erase the user: sever their WhatsApp link, delete their
    // account and their app data. The owner can never be erased.
    if (isOwner(String(email))) {
      return NextResponse.json({ error: "The owner cannot be erased." }, { status: 400 });
    }
    const target = String(email).toLowerCase();
    await disconnectInstance(target); // logout + delete WhatsApp everywhere
    // Purge the rows we key by their email so nothing about them remains.
    //
    // EACH TABLE NAMES THE USER DIFFERENTLY. bookings/searches use `user_email`,
    // feedback uses `reporter_email`, only wa_sessions uses `email`. The old
    // loop filtered `email=eq.` on all four, so three of the deletes hit a
    // column that does not exist - PostgREST 400s, sbDelete swallows it to
    // `false`, and the route returned 200 claiming an erasure that left the
    // user's bookings, searches and feedback fully intact. An "erase" that
    // silently keeps most of the data is worse than an honest failure.
    const userColumn: Record<string, string> = {
      bookings: "user_email",
      searches: "user_email",
      feedback: "reporter_email",
      wa_sessions: "email",
    };
    // Feedback has children (replies + images) keyed by feedback_id, not email,
    // so clear them first from the user's own feedback rows.
    const ownFeedback = await sbSelect<{ id: number }>(
      "feedback",
      `select=id&reporter_email=eq.${encodeURIComponent(target)}&limit=1000`
    ).catch(() => [] as { id: number }[]);
    if (ownFeedback.length) {
      const ids = ownFeedback.map((r) => r.id).join(",");
      await sbDelete("feedback_replies", `feedback_id=in.(${ids})`).catch(() => false);
      await sbDelete("feedback_images", `feedback_id=in.(${ids})`).catch(() => false);
    }
    const purge: Record<string, boolean> = {};
    for (const [table, col] of Object.entries(userColumn)) {
      purge[table] = await sbDelete(table, `${col}=eq.${encodeURIComponent(target)}`);
    }
    const userDeleted = await deleteUser(target);
    const failed = Object.entries(purge)
      .filter(([, ok]) => !ok)
      .map(([t]) => t);
    if (failed.length || !userDeleted) {
      // Report the truth: some rows could not be purged. The owner can retry.
      return NextResponse.json(
        {
          error: `Partial erase - could not purge: ${[
            ...failed,
            ...(userDeleted ? [] : ["app_users"]),
          ].join(", ")}. Retry, or check Supabase.`,
          ...(await payload()),
        },
        { status: 500 }
      );
    }
    return NextResponse.json(await payload());
  }

  if (action === "promote" || action === "demote") {
    // MEMBERSHIP OF MANAGEMENT IS THE OWNER'S DECISION, NOT A PEER ADMIN'S.
    //
    // This gate was `requireManagement`, so ANY admin could promote an
    // arbitrary email to admin and demote every other admin. The owner was
    // protected by the check below; nobody else was. And admin is not a
    // read-only role in this app - it opens the Key Vault, where an admin can
    // paste their own integration keys and read every masked setting, so one
    // compromised or disgruntled admin account converts into durable,
    // self-renewing privilege plus the removal of everyone who could revoke it.
    //
    // A promotion is also PERSISTENT (`ADMIN_EMAILS_EXTRA` in the vault), which
    // is exactly what makes it worth restricting: everything else on this route
    // is reversible by the owner, and this is the one action that can be used
    // to make the owner's next login the only way back.
    if (session.role !== "owner") {
      return NextResponse.json(
        { error: "Only the owner can add or remove admins." },
        { status: 403 }
      );
    }
    // The owner can never be demoted (setAdmin also refuses, belt and braces).
    if (isOwner(String(email)) && action === "demote") {
      return NextResponse.json({ error: "The owner cannot be demoted." }, { status: 400 });
    }
    // Read-back-and-verify, exactly like the status branch below: a role
    // change whose vault write failed must answer 500, not fall through to a
    // success payload that repaints the old role as the new one.
    const roleWrote = await setAdmin(String(email), action === "promote");
    if (!roleWrote) {
      return NextResponse.json(
        { error: "The role change did not persist. Check Supabase and retry." },
        { status: 500 }
      );
    }
  } else if (status === "active" || status === "blocked") {
    if (isOwner(String(email))) {
      return NextResponse.json({ error: "The owner cannot be blocked." }, { status: 400 });
    }
    // BLOCKING AN ADMIN HAS TO ACTUALLY STOP THEM, AND IT IS THE OWNER'S CALL.
    //
    // The panel offered Block on every non-owner row, this route wrote
    // status=blocked for admins too - and getSession only consulted status for
    // `user` sessions, so the write changed nothing. The owner saw a success
    // toast while a rogue admin kept the Key Vault, the user list and every
    // /api/admin/* route. Two halves to the fix: session.ts now refuses a
    // blocked session at every role below owner, and membership of management
    // stays the owner's decision here, for the same reason promote/demote is -
    // an admin who could block their peers could clear the room, and this is
    // now an action with teeth rather than a no-op.
    //
    // The owner therefore HAS a way to stop a rogue admin immediately (block
    // takes effect on their next request), separate from demoting them, which
    // only removes the extra privilege and leaves the account signed in.
    const target = String(email).trim().toLowerCase();
    const targetIsManagement = (await adminEmails()).includes(target);
    if (targetIsManagement && session.role !== "owner") {
      return NextResponse.json(
        { error: "Only the owner can block or unblock an admin." },
        { status: 403 }
      );
    }
    await setUserStatus(target, status);
    // AND THE ANSWER HAS TO BE TRUE. setUserStatus returns void and swallows
    // the durable write's result, so a failed upsert looked exactly like a
    // successful block. Read the list back (it comes from Supabase, not the
    // cache) and report what it actually says.
    const after = await payload();
    const row = after.users.find((u) => u.email === target);
    if (!row || row.status !== status) {
      return NextResponse.json(
        {
          error: `Could not ${status === "blocked" ? "block" : "unblock"} ${target} - the change did not persist. Check Supabase and retry.`,
          ...after,
        },
        { status: 500 }
      );
    }
    return NextResponse.json(after);
  } else {
    return NextResponse.json({ error: "Provide an action or status." }, { status: 400 });
  }
  return NextResponse.json(await payload());
}
