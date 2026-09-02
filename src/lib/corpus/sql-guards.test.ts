import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// THE TWO SQL FILES ARE PASTED BY HAND BY AN OWNER, so their guarantees cannot
// be executed here - there is no Postgres in this suite. Where a source read is
// the only instrument available, each assertion pins the GUARANTEE and also
// pins the ABSENCE of the unguarded shape, because "the guard exists somewhere
// in the file" is not the same claim as "no unguarded copy exists".

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** The same file with `--` comments stripped. A prose line SAYING the file does
 *  not do X must not be what satisfies (or breaks) an assertion about X. */
const readSql = (p: string) => read(p).replace(/--.*$/gm, "");

describe("the pgvector block cannot break a database that lacks pgvector", () => {
  const schema = read("supabase/schema.sql");

  it("the table is created ONLY inside a pg_extension branch", () => {
    const start = schema.indexOf("do $$", schema.indexOf("SEMANTIC RETRIEVAL SIDECAR"));
    expect(start).toBeGreaterThan(-1);
    const block = schema.slice(start);
    // The guard is the FIRST thing in the block and returns before any DDL.
    const guard = block.indexOf("pg_extension where extname = 'vector'");
    const create = block.indexOf("create table if not exists public.corpus_embeddings");
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
    expect(block.slice(guard, create)).toMatch(/raise notice/);
    expect(block.slice(guard, create)).toMatch(/\breturn;/);
  });

  it("there is no create-table or vector type OUTSIDE that block", () => {
    // A `vector(768)` column reached by an unguarded `alter table` would error
    // on a database without the extension and could abort the rest of an
    // 1839-line paste, costing the owner tables they already had.
    const occurrences = schema.split("corpus_embeddings").length - 1;
    const start = schema.indexOf("SEMANTIC RETRIEVAL SIDECAR");
    const inside = schema.slice(start).split("corpus_embeddings").length - 1;
    expect(inside).toBe(occurrences);
    expect(schema.slice(0, start)).not.toMatch(/vector\(/);
  });

  it("it never attempts `create extension` itself", () => {
    // Enabling an extension is an owner decision made in the dashboard; a
    // failed create inside a long paste is expensive. Same reason retention.sql
    // does not install pg_cron.
    expect(readSql("supabase/schema.sql")).not.toMatch(/create\s+extension/i);
    expect(schema).toMatch(/Database -> Extensions/);
  });

  it("the unique index that makes the enqueue idempotent is shipped with it", () => {
    // sbInsertClaim reads a 409 as "already enqueued". No unique index, no 409,
    // and every turn inserts a duplicate the backfill then pays to embed.
    expect(schema).toMatch(
      /create unique index if not exists corpus_embeddings_identity_idx\s+on public\.corpus_embeddings \(embed_model, source_table, source_id\)/
    );
  });

  it("the queue index is partial on the null vector", () => {
    expect(schema).toMatch(/corpus_embeddings_queue_idx[\s\S]{0,120}where embedding is null/);
  });

  it("the ANN index degrades to a notice rather than failing the paste", () => {
    // hnsw needs pgvector 0.5.0+; ivfflat is the fallback; an exact scan is
    // fine below ~50k rows. None of those is worth aborting the file for.
    const block = schema.slice(schema.indexOf("SEMANTIC RETRIEVAL SIDECAR"));
    expect(block).toMatch(/using hnsw/);
    expect(block).toMatch(/using ivfflat/);
    expect(block).toMatch(/exception when others then/);
  });

  it("RLS is on, with no policy - the deny-all posture, inside the branch too", () => {
    expect(schema).toMatch(
      /alter table public\.corpus_embeddings enable row level security/
    );
    expect(readSql("supabase/schema.sql")).not.toMatch(/create policy/i);
  });
});

describe("the retention delete cannot abort prune_old_rows", () => {
  const retention = read("supabase/retention.sql");

  it("the corpus delete is guarded by to_regclass and uses dynamic SQL", () => {
    // The table exists ONLY inside schema.sql's pg_extension branch, so on a
    // database without pgvector a bare delete raises "relation does not exist"
    // AT EXECUTION and aborts the whole function - stopping retention for every
    // other table at once. `execute` is never resolved against the catalogue,
    // so the missing relation is simply never looked up.
    expect(retention).toMatch(/if to_regclass\('public\.corpus_embeddings'\) is not null then/);
    expect(retention).toMatch(
      /execute 'delete from public\.corpus_embeddings where created_at < \$1' using cutoff_mid;/
    );
  });

  it("NO unguarded delete from the sidecar exists anywhere in the file", () => {
    // The assertion that matters: one guarded copy plus one unguarded copy is
    // exactly as broken as one unguarded copy.
    const bare = retention.match(/^\s*delete from public\.corpus_embeddings/gm);
    expect(bare).toBeNull();
  });

  it("it prunes on the MID window, so it never extends a source's horizon", () => {
    // The sidecar copies text. 180 days is at or inside every source window
    // (vendor_replies is mid, agent_events is short), so nothing it copies
    // lives longer because it was copied.
    const line = retention.slice(retention.indexOf("to_regclass('public.corpus_embeddings')"));
    expect(line.slice(0, 400)).toMatch(/using cutoff_mid/);
  });

  it("the delete lives in prune_old_rows itself, not a separate sweeper", () => {
    // The function body is a fixed list, so a table not named in it is never
    // pruned at all - and a separate sweeper is one more thing that can quietly
    // stop running.
    const fnStart = retention.indexOf("create or replace function public.prune_old_rows");
    const fnEnd = retention.indexOf("$$;", fnStart);
    const body = retention.slice(fnStart, fnEnd);
    expect(body).toContain("corpus_embeddings");
  });
});
