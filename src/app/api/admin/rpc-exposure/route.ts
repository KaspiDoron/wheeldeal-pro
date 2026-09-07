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
  // root document is an OpenAPI schema enumerating them. Any name that is
  // NOT one of the app's own tables (Evolution's "Message"/"Chat"/"Contact"
  // being the known offenders) is a foreign table the publishable browser
  // key can query, and that is the alarm.
  //
  // THE LISTING MEASURES GRANTS, NOT RLS (audit F190). This probe used to
  // report EVERY path in the document as an exposed relation, on the premise
  // that a database where every table has RLS and no policy lists NONE. It
  // does not: PostgREST filters the document by table GRANTS, and Supabase's
  // default privileges grant anon on every table created from the SQL editor
  // - which is how schema.sql is run - so on a correctly configured project
  // the document names all ~57 app tables, the verdict went red every time
  // with a remedy that did not apply ("move that service to its own
  // database"), RUNBOOK's launch-gate line could never be ticked, and a real
  // foreign relation hid inside a 57-name list. RLS blocks ROWS. So the app's
  // own tables (the erasure registry's CI-pinned list: registeredTables +
  // EXCLUDED_TABLES, which wave9-erasure.test.ts proves matches every
  // `create table` in the SQL files) are split out of the foreign set, and
  // RLS on them is MEASURED below rather than inferred.
  let tables: { state: string; exposed: string[]; detail: string };
  /** The app's own tables the anon role is GRANTED (expected under Supabase defaults). */
  let granted: string[] = [];
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
      const { registeredTables, EXCLUDED_TABLES } = await import("@/lib/privacy/user-tables");
      const own = new Set<string>([...registeredTables(), ...Object.keys(EXCLUDED_TABLES)]);
      const visible = Object.keys(doc?.paths ?? {})
        .filter((p) => p.startsWith("/") && p !== "/" && !p.startsWith("/rpc/"))
        .map((p) => p.slice(1))
        .sort();
      granted = visible.filter((n) => own.has(n));
      const names = visible.filter((n) => !own.has(n));
      tables = names.length
        ? {
            state: "exposed",
            exposed: names,
            detail:
              `The public anon key can see ${names.length} FOREIGN relation(s): ${names.slice(0, 12).join(", ")}` +
              (names.length > 12 ? ", ..." : "") +
              ". None of these is an app table (Evolution's message store being the known way this happens) - move that service to its own database, or enable RLS / revoke anon on each.",
          }
        : granted.length
          ? {
              // Filled in by probe 3 - the listing alone cannot say.
              state: "unknown",
              exposed: [],
              detail: "",
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

  // Probe 3 (F190): MEASURE RLS on the app's own tables, the way an attacker
  // would - read a row with the anon key. The listing above says anon is
  // granted on them; only a row read says whether RLS holds. The three
  // highest-value tables are probed (a transcript, an account, a vault row):
  // a 200 carrying zero rows is RLS holding, a 200 carrying a row is a REAL
  // breach named by table, 401 stays "unknown" exactly as above, and 403/404
  // are refusals (no grant after all). This is what turns "granted" into a
  // measured verdict instead of a green light that means "we did not check".
  const HIGH_VALUE: { table: string; column: string }[] = [
    { table: "whatsapp_messages", column: "wa_message_id" },
    { table: "app_users", column: "email" },
    { table: "app_config", column: "key" },
  ];
  if (tables.state === "unknown" && tables.detail === "" && granted.length) {
    const leaking: string[] = [];
    const held: string[] = [];
    let rejected = false;
    let netError: string | null = null;
    for (const { table, column } of HIGH_VALUE) {
      if (!granted.includes(table)) continue;
      try {
        const res = await fetch(`${url}/rest/v1/${table}?select=${column}&limit=1`, {
          headers,
          cache: "no-store",
        });
        if (res.status === 401) {
          rejected = true;
          break;
        }
        if (res.ok) {
          const rows = (await res.json().catch(() => [])) as unknown[];
          (Array.isArray(rows) && rows.length > 0 ? leaking : held).push(table);
        } else {
          held.push(table);
        }
      } catch (e) {
        netError = e instanceof Error ? e.message : "network error";
        break;
      }
    }
    if (leaking.length) {
      tables = {
        state: "exposed",
        exposed: leaking,
        detail: `RLS IS NOT HOLDING on ${leaking.join(", ")}: the public anon key read a row. Open the Supabase SQL editor and re-run supabase/schema.sql (it enables RLS on every app table with no policies), then re-check.`,
      };
    } else if (rejected) {
      tables = {
        state: "unknown",
        exposed: [],
        detail:
          "The anon key was REJECTED outright (401) on the row read, so RLS was not measured - a wide-open table answers a bad key the same way. Set NEXT_PUBLIC_SUPABASE_ANON_KEY to the current publishable key for THIS project and re-check.",
      };
    } else if (netError) {
      tables = {
        state: "unknown",
        exposed: [],
        detail: `Could not measure RLS with the anon key: ${netError}`,
      };
    } else {
      tables = {
        state: "guarded",
        exposed: [],
        detail:
          `The anon key is granted on ${granted.length} of the app's own tables (Supabase's default privilege on tables created from the SQL editor) and no foreign relation is visible. RLS was MEASURED to hold on ${held.join(", ")} - zero rows for the anon key. ` +
          "To remove the grants as well: revoke all on all tables in schema public from anon (the app never reads with the anon key).",
      };
    }
  }

  // The combined verdict keeps the original top-level shape the admin panel
  // reads: worst-of, so a clean rpc can never paint over an exposed table.
  // "guarded" (granted, RLS measured to hold) is the expected state of a
  // Supabase project set up from the SQL editor and counts as locked; it
  // stays a distinct tables.state so the detail can say what was measured.
  const tablesSafe = tables.state === "clean" || tables.state === "guarded";
  const state =
    rpc.state === "exposed" || tables.state === "exposed"
      ? "exposed"
      : rpc.state === "locked" && tablesSafe
        ? "locked"
        : "unknown";
  return NextResponse.json({
    state,
    detail: `RPC: ${rpc.detail} Tables: ${tables.detail}`,
    rpc,
    tables,
  });
}
