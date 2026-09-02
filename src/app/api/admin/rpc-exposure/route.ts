import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";

// IS THE DANGEROUS RPC ACTUALLY LOCKED, ON THE DATABASE THIS APP IS TALKING TO?
//
// `prune_old_rows` is SECURITY DEFINER, and PostgreSQL hands EXECUTE to PUBLIC
// by default - which Supabase then exposes over PostgREST to `anon`, the key
// that ships inside every browser. supabase/retention.sql revokes it as part of
// creating it, but a database set up before that change still has the hole and
// nothing in the app could tell the owner which one they are running.
//
// So ASK, the same way an attacker would: call the RPC with the ANON key and a
// retention window of 100 years. If the revoke is in place PostgREST refuses
// before any SQL runs. If it is NOT in place the function does execute - and
// deletes nothing, because no row in this database is a century old. That is
// what makes this probe honest AND safe to run from an admin screen: it
// measures the real permission on the real project rather than asserting that
// a file was pasted somewhere.
//
// Three outcomes, and "unknown" is a real one: without the anon key on the
// server there is no way to test the anon path, and a green light that means
// "we did not check" is exactly the kind of reassurance this codebase refuses
// to ship.
//
// W9: THE PROBE NOW COVERS TABLES, NOT JUST THE ONE RPC. The app's own 55
// tables all carry RLS, but that is only ever asserted about the SQL files in
// this repo - a table created by anything else (Evolution's Prisma migrations
// pointed at the app's Supabase, per the old GUIDE instructions, is exactly
// how it happens) arrives with the default anon grants and no RLS, and every
// static assertion stays green while travellers' private chats sit readable
// under the publishable key. `GET /rest/v1/` with the anon key returns
// PostgREST's OpenAPI document listing every relation THAT ROLE can see - the
// same enumeration an attacker would run first.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!url) {
    return NextResponse.json({
      state: "unknown",
      detail: "Supabase is not configured here, so there is nothing to probe.",
    });
  }
  if (!anon) {
    return NextResponse.json({
      state: "unknown",
      detail:
        "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set on the server, so the anon path cannot be tested from here. Re-run supabase/retention.sql (it revokes the grant as part of creating the function) to be certain.",
    });
  }

  const headers = {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
    "Content-Type": "application/json",
  };

  // Probe 1: the SECURITY DEFINER rpc.
  let rpc: { state: string; detail: string };
  try {
    const res = await fetch(`${url}/rest/v1/rpc/prune_old_rows`, {
      method: "POST",
      headers,
      // 100 years: matches no row, so an EXPOSED function deletes nothing.
      body: JSON.stringify({ retain_days: 36500 }),
      cache: "no-store",
    });
    if (res.ok) {
      rpc = {
        state: "exposed",
        detail:
          "ANYONE HOLDING THE PUBLIC ANON KEY CAN CALL prune_old_rows AND DELETE YOUR HISTORY. Open the Supabase SQL editor and run supabase/retention.sql (or supabase/security-fix.sql for the one-line repair) now.",
      };
    } else if (res.status === 401) {
      // 401 IS NOT A REFUSAL, IT IS A REJECTED KEY - and reading it as "locked"
      // was this probe manufacturing the exact reassurance it exists to refuse.
      //
      // PostgREST answers 401 when the apikey is missing, malformed, revoked or
      // from a DIFFERENT project: the request never reached a permission
      // decision, so it says nothing whatever about whether the grant on
      // prune_old_rows was revoked. A database with the hole WIDE OPEN answers
      // 401 to a bad key exactly as a locked one does. The tables probe below
      // already called the same status "unknown"; the two cannot both be right.
      //
      // 403 is the real refusal (authenticated, then denied), and 404 is
      // PostgREST declining to name a function this role cannot execute - and a
      // bad key could never reach either, because it would have 401'd first.
      rpc = {
        state: "unknown",
        detail:
          "The anon key was REJECTED outright (401), so this proves nothing about the grant - a wide-open database answers a bad key the same way. Set NEXT_PUBLIC_SUPABASE_ANON_KEY to the current publishable key for THIS project and re-check.",
      };
    } else if ([403, 404].includes(res.status)) {
      // 403 = authenticated and then denied; 404 = PostgREST will not even name
      // a function this role cannot execute. Both are real refusals.
      rpc = {
        state: "locked",
        detail: `The anon key cannot call prune_old_rows (Supabase answered ${res.status}).`,
      };
    } else {
      const body = await res.text().catch(() => "");
      rpc = {
        state: "unknown",
        detail: `Supabase answered ${res.status}, which is neither a refusal nor a success: ${body.slice(0, 160)}`,
      };
    }
  } catch (e) {
    rpc = {
      state: "unknown",
      detail: `Could not reach Supabase to check: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  // Probe 2 (W9): which RELATIONS can the anon role even see? PostgREST's
  // root document is an OpenAPI schema enumerating them - for a database
  // where every table has RLS and no policy, the correct answer is NONE.
  // Any name here (Evolution's "Message"/"Chat"/"Contact" being the known
  // offenders) is a table the publishable browser key can query.
  let tables: { state: string; exposed: string[]; detail: string };
  try {
    const res = await fetch(`${url}/rest/v1/`, { headers, cache: "no-store" });
    if (!res.ok) {
      tables = {
        state: "unknown",
        exposed: [],
        detail:
          res.status === 401
            ? "The anon key was REJECTED outright (401) - it is missing, revoked, or from another project, so nothing here was measured. Set NEXT_PUBLIC_SUPABASE_ANON_KEY and re-check."
            : `The anon key could not list the API schema (Supabase answered ${res.status}).`,
      };
    } else {
      const doc = (await res.json().catch(() => null)) as {
        paths?: Record<string, unknown>;
        definitions?: Record<string, unknown>;
      } | null;
      const names = Object.keys(doc?.paths ?? {})
        .filter((p) => p.startsWith("/") && p !== "/" && !p.startsWith("/rpc/"))
        .map((p) => p.slice(1))
        .sort();
      tables = names.length
        ? {
            state: "exposed",
            exposed: names,
            detail:
              `The public anon key can see ${names.length} relation(s): ${names.slice(0, 12).join(", ")}` +
              (names.length > 12 ? ", ..." : "") +
              ". Every app table carries RLS with no policies, so these are FOREIGN tables (Evolution's message store being the known way this happens) - move that service to its own database, or enable RLS / revoke anon on each.",
          }
        : {
            state: "clean",
            exposed: [],
            detail: "The anon key sees zero relations - RLS is doing its job.",
          };
    }
  } catch (e) {
    tables = {
      state: "unknown",
      exposed: [],
      detail: `Could not enumerate the anon-visible schema: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  // The combined verdict keeps the original top-level shape the admin panel
  // reads: worst-of, so a clean rpc can never paint over an exposed table.
  const state =
    rpc.state === "exposed" || tables.state === "exposed"
      ? "exposed"
      : rpc.state === "locked" && tables.state === "clean"
        ? "locked"
        : "unknown";
  return NextResponse.json({
    state,
    detail: `RPC: ${rpc.detail} Tables: ${tables.detail}`,
    rpc,
    tables,
  });
}
