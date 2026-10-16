// CORS, JSON responses and the database client for words-api.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { ApiError, MESSAGES } from "./core/errors.js";

// Set ALLOWED_ORIGINS to the production site; only local development is allowed by default.
const DEFAULT_ORIGINS = "http://localhost:8765";
const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? DEFAULT_ORIGINS).split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function errorResponse(req: Request, e: unknown): Response {
  if (e instanceof ApiError) return json(req, e.status, { error: e.code, message: e.message, details: e.details });
  console.error(e);
  return json(req, 500, { error: "server_error", message: "Something went wrong." });
}

let client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!client) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  return client;
}

/**
 * Call a public.svc_* function. SQL errors raised with ops.fail() carry the
 * error code as the message and the HTTP status as the hint; they become ApiErrors.
 */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) {
    const status = Number(error.hint);
    if (status >= 400 && status < 600) {
      const code = error.message;
      const detail = error.details || undefined;
      // A detail on a known code is extra context; on custom codes it is the message.
      const message = MESSAGES[code as keyof typeof MESSAGES] ?? detail ?? code;
      throw new ApiError(status, code, message, MESSAGES[code as keyof typeof MESSAGES] ? detail : undefined);
    }
    console.error(fn, error);
    throw new ApiError(500, "server_error", "Something went wrong.");
  }
  return data as T;
}
