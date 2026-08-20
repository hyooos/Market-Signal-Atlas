import "server-only";
import { getKv } from "@/lib/kv";
import type { EvidenceConfidence, LiveReaction, LiveReviewItem, LiveSignal } from "@/lib/types";

const REVIEW_QUEUE_KEY = "live:review:queue";
const REVIEW_ITEM_PREFIX = "live:review:";
const REACTION_PREFIX = "live:reaction:";

interface DailyBar {
  date: string;
  close: number;
  volume: number;
}

async function fetchDailyBars(symbol: string): Promise<DailyBar[]> {
  const end = Math.floor(Date.now() / 1000) + 86_400;
  const start = end - 120 * 86_400;
  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d&events=history`,
    { headers: { "User-Agent": "MarketSignalAtlasHackathon/1.0" }, cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Market data ${symbol}: ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`No market data for ${symbol}`);
  const quote = result.indicators?.quote?.[0];
  const timestamps: number[] = result.timestamp ?? [];
  return timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close: quote?.close?.[index],
      volume: quote?.volume?.[index],
    }))
    .filter((row): row is DailyBar => Number.isFinite(row.close) && Number.isFinite(row.volume));
}

/** Aligns a timestamp to the trading session it should be scored against: same day if before the 4pm ET close, otherwise the next session. */
function easternSession(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  if (get("hour") >= 16) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function primaryMapping(topic: string): { asset: string; benchmark: string; coverage: "Direct" | "Policy" | "Proxy" } {
  if (topic === "Tesla & EV") return { asset: "TSLA", benchmark: "QQQ", coverage: "Direct" };
  if (topic === "Technology policy") return { asset: "NVDA", benchmark: "QQQ", coverage: "Proxy" };
  return { asset: "SPY", benchmark: "QQQ", coverage: "Policy" };
}

/** Single-call classifier: mirrors the offline batch prompt in scripts/prepare-ai-batch.mjs. Returns null on any failure so callers fall back to the deterministic topic guess. */
async function classifySignal(text: string): Promise<{ isSignal: boolean; topic: string; confidence: EvidenceConfidence; reason: string } | null> {
  if (process.env.ENABLE_LIVE_AI !== "true" || !process.env.OPENAI_API_KEY) return null;
  try {
    const model = process.env.OPENAI_MODEL || "gpt-5.4-nano";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions:
          "Classify a public post for an evidence-first signal-monitoring product. Return only one JSON object with keys: isSignal (boolean), topic (one of: Tesla & EV, Technology policy, Trade & tariffs, Economy & rates, Public statement), confidence (Low, Medium, or High), reason (one sentence). A signal must contain a concrete policy, company, market, or industry claim. Do not invent facts.",
        input: JSON.stringify({ text }),
        max_output_tokens: 200,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    const raw = payload.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { isSignal?: boolean; topic?: string; confidence?: EvidenceConfidence; reason?: string };
    if (typeof parsed.isSignal !== "boolean" || !parsed.topic) return null;
    return {
      isSignal: parsed.isSignal,
      topic: parsed.topic,
      confidence: parsed.confidence ?? "Medium",
      reason: parsed.reason ?? "",
    };
  } catch {
    return null;
  }
}

async function computeAbnormalReturn(asset: string, benchmark: string, publishedAt: string) {
  const [assetBars, benchmarkBars] = await Promise.all([fetchDailyBars(asset), fetchDailyBars(benchmark)]);
  const eventSession = easternSession(publishedAt);
  const assetIndex = assetBars.findIndex((bar) => bar.date >= eventSession);
  if (assetIndex < 21) return null; // not enough trailing history for a 20-session volume average
  if (assetBars[assetIndex]?.date !== eventSession) return null; // the aligned session hasn't printed a close yet
  const benchmarkIndex = benchmarkBars.findIndex((bar) => bar.date === eventSession);
  if (benchmarkIndex < 1) return null;

  const assetBase = assetBars[assetIndex - 1].close;
  const benchmarkBase = benchmarkBars[benchmarkIndex - 1].close;
  const abnormalReturn1D =
    ((assetBars[assetIndex].close / assetBase - 1) - (benchmarkBars[benchmarkIndex].close / benchmarkBase - 1)) * 100;
  const trailingVolume = assetBars.slice(assetIndex - 20, assetIndex).map((bar) => bar.volume);
  const meanVolume = trailingVolume.reduce((sum, value) => sum + value, 0) / trailingVolume.length;
  const volumeMultiple = meanVolume ? assetBars[assetIndex].volume / meanVolume : 0;

  return {
    eventSession,
    abnormalReturn1D: Math.round(abnormalReturn1D * 100) / 100,
    volumeMultiple: Math.round(volumeMultiple * 100) / 100,
  };
}

/**
 * Runs one live signal through classify -> map -> (human review gate) -> compute.
 * Safe to call repeatedly (e.g. every cron tick): it no-ops once a signal is
 * already computed or sitting in the review queue.
 */
export async function processLiveSignal(signal: LiveSignal): Promise<void> {
  const kv = getKv();
  if (!kv) return;

  const [existingReaction, existingReview] = await Promise.all([
    kv.get(`${REACTION_PREFIX}${signal.id}`),
    kv.get(`${REVIEW_ITEM_PREFIX}${signal.id}`),
  ]);
  if (existingReaction || existingReview) return;

  const classified = await classifySignal(signal.text);
  const topic = classified?.topic || signal.topic;
  const confidence: EvidenceConfidence = classified?.confidence ?? "Medium";
  const mapping = primaryMapping(topic);

  const needsReview = classified ? classified.confidence === "Low" || classified.isSignal === false : mapping.coverage === "Proxy";
  if (needsReview) {
    const review: LiveReviewItem = {
      id: signal.id,
      text: signal.text,
      publishedAt: signal.publishedAt,
      sourceUrl: signal.sourceUrl,
      topic,
      asset: mapping.asset,
      confidence,
      reason: classified?.reason ?? "Rule-based mapping produced a proxy (indirect) asset link.",
      flaggedAt: new Date().toISOString(),
      status: "pending",
    };
    await kv.set(`${REVIEW_ITEM_PREFIX}${signal.id}`, review);
    await kv.sadd(REVIEW_QUEUE_KEY, signal.id);
    return;
  }

  try {
    const computed = await computeAbnormalReturn(mapping.asset, mapping.benchmark, signal.publishedAt);
    if (!computed) return; // aligned trading session hasn't closed yet; try again on the next cron tick
    const reaction: LiveReaction = {
      asset: mapping.asset,
      benchmark: mapping.benchmark,
      coverage: mapping.coverage,
      confidence,
      eventSession: computed.eventSession,
      abnormalReturn1D: computed.abnormalReturn1D,
      volumeMultiple: computed.volumeMultiple,
      computedAt: new Date().toISOString(),
    };
    await kv.set(`${REACTION_PREFIX}${signal.id}`, reaction);
  } catch {
    // Market data provider hiccup; leave the signal pending and retry next tick.
  }
}

export async function attachComputedReactions(signals: LiveSignal[]): Promise<LiveSignal[]> {
  const kv = getKv();
  if (!kv || !signals.length) return signals;
  const results = await Promise.all(
    signals.map(async (signal) => {
      const [reaction, review] = await Promise.all([
        kv.get<LiveReaction>(`${REACTION_PREFIX}${signal.id}`),
        kv.get<LiveReviewItem>(`${REVIEW_ITEM_PREFIX}${signal.id}`),
      ]);
      return { ...signal, reaction: reaction ?? null, reviewStatus: review?.status ?? null };
    }),
  );
  return results;
}

export async function listReviewQueue(): Promise<LiveReviewItem[]> {
  const kv = getKv();
  if (!kv) return [];
  const ids = await kv.smembers(REVIEW_QUEUE_KEY);
  if (!ids.length) return [];
  const items = await Promise.all(ids.map((id) => kv.get<LiveReviewItem>(`${REVIEW_ITEM_PREFIX}${id}`)));
  return items.filter((item): item is LiveReviewItem => Boolean(item) && item?.status === "pending");
}

export async function resolveReviewItem(id: string, decision: "approved" | "rejected"): Promise<void> {
  const kv = getKv();
  if (!kv) return;
  const item = await kv.get<LiveReviewItem>(`${REVIEW_ITEM_PREFIX}${id}`);
  if (!item) return;
  await kv.set(`${REVIEW_ITEM_PREFIX}${id}`, { ...item, status: decision });
  await kv.srem(REVIEW_QUEUE_KEY, id);
  if (decision === "approved") {
    const mapping = primaryMapping(item.topic);
    try {
      const computed = await computeAbnormalReturn(mapping.asset, mapping.benchmark, item.publishedAt);
      if (computed) {
        const reaction: LiveReaction = {
          asset: mapping.asset,
          benchmark: mapping.benchmark,
          coverage: mapping.coverage,
          confidence: item.confidence,
          eventSession: computed.eventSession,
          abnormalReturn1D: computed.abnormalReturn1D,
          volumeMultiple: computed.volumeMultiple,
          computedAt: new Date().toISOString(),
        };
        await kv.set(`${REACTION_PREFIX}${id}`, reaction);
      }
    } catch {
      // Leave it approved-but-pending; the next cron tick (or another manual approve) will retry the price fetch.
    }
  }
}
