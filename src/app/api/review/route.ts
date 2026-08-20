import { listReviewQueue, resolveReviewItem } from "@/lib/liveReaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ items: await listReviewQueue() });
}

export async function POST(request: Request) {
  let id = "";
  let decision: "approved" | "rejected" | undefined;
  try {
    const body = (await request.json()) as { id?: string; decision?: string };
    id = body.id ?? "";
    decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : undefined;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!id || !decision) return Response.json({ error: "id and decision are required" }, { status: 400 });
  await resolveReviewItem(id, decision);
  return Response.json({ ok: true });
}
