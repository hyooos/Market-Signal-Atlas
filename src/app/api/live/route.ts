import { NextResponse } from "next/server";
import { getLivePayload } from "@/lib/live";
import { processLiveSignal } from "@/lib/liveReaction";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await getLivePayload();
  // Idempotent: no-ops for signals already computed or already queued for review.
  await Promise.all(payload.signals.map((signal) => processLiveSignal(signal)));
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=3600" },
  });
}

