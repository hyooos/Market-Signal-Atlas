"use client";

import { useEffect, useState } from "react";
import type { LiveReviewItem } from "@/lib/types";

export default function ReviewPage() {
  const [items, setItems] = useState<LiveReviewItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/review", { cache: "no-store" });
        if (!response.ok) throw new Error("Failed to load review queue");
        const payload = (await response.json()) as { items: LiveReviewItem[] };
        if (cancelled) return;
        setItems(payload.items);
        setError(null);
      } catch {
        if (!cancelled) setError("Review queue could not be loaded. Is Vercel KV connected?");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const decide = async (id: string, decision: "approved" | "rejected") => {
    setBusyId(id);
    try {
      await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      setItems((prev) => (prev ?? []).filter((item) => item.id !== id));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 20px", fontFamily: "inherit" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: "#14224f" }}>Human review queue</h1>
      <p style={{ color: "#5a6478", fontSize: 13, marginTop: 6, marginBottom: 28 }}>
        Only low-confidence or ambiguous-mapping signals land here. Everything else is classified and mapped automatically.
      </p>
      {error && <p style={{ color: "#e0433f" }}>{error}</p>}
      {items === null && !error && <p style={{ color: "#5a6478" }}>Loading…</p>}
      {items?.length === 0 && <p style={{ color: "#5a6478" }}>Queue is empty — nothing needs a human right now.</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {items?.map((item) => (
          <article
            key={item.id}
            style={{ border: "1px solid #dfe6e0", borderRadius: 14, padding: 18, background: "#fff", boxShadow: "0 8px 20px rgba(20,34,79,0.06)" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11, color: "#7a86a0", marginBottom: 8 }}>
              <span>{new Date(item.publishedAt).toLocaleString()}</span>
              <span>confidence: {item.confidence}</span>
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "#1c2434", margin: "0 0 10px" }}>{item.text}</p>
            <p style={{ fontSize: 12, color: "#5a6478", margin: "0 0 4px" }}>
              Guessed topic: <strong>{item.topic}</strong> · candidate asset: <strong>{item.asset}</strong>
            </p>
            <p style={{ fontSize: 12, color: "#7a86a0", margin: "0 0 14px" }}>{item.reason}</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                disabled={busyId === item.id}
                onClick={() => decide(item.id, "approved")}
                style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", background: "#2454e0", color: "#fff", fontWeight: 700, cursor: "pointer" }}
              >
                Approve
              </button>
              <button
                disabled={busyId === item.id}
                onClick={() => decide(item.id, "rejected")}
                style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "1px solid #dfe6e0", background: "#fff", color: "#5a6478", fontWeight: 700, cursor: "pointer" }}
              >
                Reject
              </button>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
