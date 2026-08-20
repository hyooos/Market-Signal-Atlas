import "server-only";
import { Redis } from "@upstash/redis";

let client: Redis | null | undefined;

/**
 * Returns null when no store is configured so callers can fall back to the
 * deterministic "pending" state instead of throwing in local/demo setups.
 */
export function getKv(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}
