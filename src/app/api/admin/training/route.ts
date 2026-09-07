import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { addTraining, listTraining, deleteTraining, updateTraining } from "@/lib/memory";
import {
  sbInsert,
  sbSelect,
  sbSelectStrict,
  sbDelete,
  sbUpdate,
  supabaseConfigured,
} from "@/lib/runtime-config";
import { chatVision } from "@/lib/ai";
import type { Role } from "@/lib/types";

// Teach the bargaining agents from real WhatsApp bargains - pasted text AND
// chat screenshots (the vision agent transcribes photos into dialogue).
//
// OWNER-ONLY TEXT ON THE OPS ROWS (audit F162). The Ops Center's bookmark,
// correction and misread-lesson actions write rows whose `text` embeds
// another traveller's shop and agent WhatsApp messages verbatim - the same
// class of content admin/data refuses a non-owner with "Conversation content
// is owner-only". This route handed those rows to any management session on
// first paint, and let that session PATCH or DELETE them (they feed
// coaching.ts on the live reply path, so losing one is a silent quality
// regression). The split is the one admin/data already uses: a non-owner
// admin keeps the id, note, source, provenance and the count - the Memory
// tile stays useful - and the text of every ops-authored row is withheld;
// writes to those rows are refused with the same 403.

const OWNER_ONLY_TEXT = "Conversation content is owner-only. Admins see counts, not transcripts.";

/** Rows the Ops Center authored FROM a traveller's thread (exemplar, correction, lesson). */
function isOpsTranscript(source: string | null | undefined): boolean {
  return (source ?? "").toLowerCase().startsWith("ops-");
}

/**
 * The refusal a non-owner gets for touching an ops-authored row, or null when
 * the write may proceed. The origin read is STRICT: a row whose source could
 * not be read is not assumed to be hand-taught.
 */
async function refuseOpsWrite(role: Role, id: number): Promise<NextResponse | null> {
  if (role === "owner") return null;
  const read = await sbSelectStrict<{ source: string | null }>(
    "agent_training",
    `select=source&id=eq.${id}&limit=1`
  );
  if ("error" in read) {
    if (read.error === "missing") return null;
    return NextResponse.json(
      { error: "Could not read the row's origin - nothing was changed. Try again." },
      { status: 503 }
    );
  }
  if (read.rows[0] && isOpsTranscript(read.rows[0].source)) {
    return NextResponse.json({ error: OWNER_ONLY_TEXT }, { status: 403 });
  }
  return null;
}

interface TrainingRow {
  id: number;
  text: string;
  note: string | null;
  source: string | null;
  created_at: string;
}

// Human-readable origin of a memory: WHERE the agent learned it from.
function originOf(source: string | null, note: string | null, addedBy: string | null): string {
  const s = (source || "").toLowerCase();
  const who = addedBy ? ` · ${addedBy}` : "";
  if (s === "whatsapp") return `Learned from a WhatsApp chat${who}`;
  if (s === "photo") return `From a screenshot${who}`;
  if (s === "funnel") return `From a live user negotiation${who}`;
  if (s === "training") return `Owner training session${who}`;
  if (s === "text") return `Pasted by hand${who}`;
  if (note) return `${note}${who}`;
  return addedBy ? `Added by ${addedBy}` : "Origin unknown";
}

async function allExamples(role: Role) {
  const durable = await sbSelect<TrainingRow & { added_by?: string | null }>(
    "agent_training",
    "select=id,text,note,source,added_by,created_at&order=created_at.desc&limit=100"
  );
  const mem = listTraining();
  const seen = new Set(durable.map((d) => d.text));
  return [
    ...durable.map((d) => {
      // The owner reads every row; a non-owner admin keeps everything about
      // an ops row EXCEPT the traveller's exchange (F162).
      const locked = role !== "owner" && isOpsTranscript(d.source);
      return {
        id: d.id,
        text: locked ? null : d.text,
        note: d.note ?? undefined,
        source: d.source ?? undefined,
        addedBy: d.added_by ?? undefined,
        origin: originOf(d.source, d.note, d.added_by ?? null),
        addedAt: Date.parse(d.created_at),
        locked,
      };
    }),
    ...mem
      .filter((m) => !seen.has(m.text))
      .map((m) => ({ ...m, origin: "This session (in-memory)", locked: false })),
  ];
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ examples: await allExamples(session.role) });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? "").trim();

  const images: { mime: string; base64: string }[] = [];
  for (const dataUrl of (body.images ?? []).slice(0, 5)) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl));
    if (m) images.push({ mime: m[1], base64: m[2] });
  }

  if (text.length < 20 && images.length === 0) {
    return NextResponse.json(
      { error: "Paste a real conversation (at least a few lines) or add screenshots." },
      { status: 400 }
    );
  }

  let transcribed = false;
  const pieces: { text: string; source: string }[] = [];
  if (text.length >= 20) pieces.push({ text, source: "text" });

  if (images.length > 0) {
    const { getPrompt } = await import("@/lib/prompts");
    const out = await chatVision(
      await getPrompt("transcribe"),
      "Transcribe this bargaining conversation exactly.",
      images
    );
    if (out && out.trim().length >= 20) {
      pieces.push({ text: out.trim(), source: "photo" });
      transcribed = true;
    } else if (pieces.length === 0) {
      return NextResponse.json(
        {
          error:
            "Could not read the screenshots (the vision agent needs a GEMINI_TOKEN in Admin -> Keys). Paste the conversation as text instead.",
        },
        { status: 400 }
      );
    }
  }

  // HONEST WRITES (audit M45). Every write here used to ignore the boolean
  // sbInsert / sbUpdate / sbDelete return, mutate the in-memory mirror
  // regardless, and answer with THAT list as proof - a list that reverts on
  // the next cold start. With Supabase configured the durable store is the
  // truth: a refused write is a 502 and memory is left alone. Without it
  // (demo mode) memory is the only store, and `persisted:false` says so.
  const durable = supabaseConfigured();
  const note = body.note ? String(body.note) : undefined;
  for (const p of pieces) {
    if (durable) {
      const landed = await sbInsert("agent_training", [
        { text: p.text.slice(0, 4000), note: note ?? null, added_by: session.email, source: p.source },
      ]);
      if (!landed) {
        return NextResponse.json(
          { ok: false, error: MEMORY_NOT_SAVED, examples: await allExamples(session.role) },
          { status: 502 }
        );
      }
    }
    addTraining(p.text, note);
  }

  return NextResponse.json({
    ok: true,
    persisted: durable,
    transcribed,
    examples: await allExamples(session.role),
  });
}

const MEMORY_NOT_SAVED =
  "The memory was not saved - Supabase refused the write. Nothing changed; check Admin -> Keys and retry.";

// Delete one learned example (owner full control over agent memory). ?id=<id>
export async function DELETE(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad id" }, { status: 400 });
  const refused = await refuseOpsWrite(session.role, id);
  if (refused) return refused;
  const durable = supabaseConfigured();
  if (durable && !(await sbDelete("agent_training", `id=eq.${id}`))) {
    return NextResponse.json(
      {
        ok: false,
        error: "The memory was not deleted - Supabase refused the write. It is still listed; retry.",
        examples: await allExamples(session.role),
      },
      { status: 502 }
    );
  }
  deleteTraining(id);
  return NextResponse.json({ ok: true, persisted: durable, examples: await allExamples(session.role) });
}

// Edit the text of one learned example. Body: { id, text }
export async function PATCH(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  const text = String(body.text ?? "").trim();
  if (!Number.isFinite(id) || text.length < 5) {
    return NextResponse.json({ error: "Need an id and some text." }, { status: 400 });
  }
  const refused = await refuseOpsWrite(session.role, id);
  if (refused) return refused;
  const durable = supabaseConfigured();
  if (durable && !(await sbUpdate("agent_training", `id=eq.${id}`, { text: text.slice(0, 4000) }))) {
    return NextResponse.json(
      {
        ok: false,
        error: "The edit was not saved - Supabase refused the write. The old text stands; retry.",
        examples: await allExamples(session.role),
      },
      { status: 502 }
    );
  }
  updateTraining(id, text);
  return NextResponse.json({ ok: true, persisted: durable, examples: await allExamples(session.role) });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
