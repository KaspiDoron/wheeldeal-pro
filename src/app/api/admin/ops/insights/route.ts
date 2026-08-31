import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { buildInsightsRollup } from "@/lib/ops/insights";

export const dynamic = "force-dynamic";

// The de-identified commercial rollup, materialised on demand (owner only -
// same gate as every cross-user ops surface). The honesty rules of the ops
// panels apply: an unreadable store answers unreadable, never an empty rollup.
export async function GET() {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await buildInsightsRollup());
}
