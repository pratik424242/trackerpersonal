import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// One-way Zerodha portfolio sync via the official Kite Connect Personal API.
//
// Flow: the app hands the user a login URL; after they authenticate at
// Zerodha, the redirect carries a single-use `request_token` back to the
// Invested page, which posts it to /api/kite/sync. That request exchanges it
// for an access_token, pulls /portfolio/holdings, reconciles the rows into
// Supabase, and returns — the access_token (which can place orders!) is used
// in-flight and deliberately never stored anywhere.

const KITE_BASE = "https://api.kite.trade";
const KITE_VERSION = "3";

function creds(): { key: string; secret: string } | null {
  const key = process.env.KITE_API_KEY;
  const secret = process.env.KITE_API_SECRET;
  if (!key || !secret) return null;
  return { key, secret };
}

export function kiteConfigured(): boolean {
  return creds() !== null;
}

export function loginUrl(): string {
  const c = creds();
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${c!.key}`;
}

export type KiteHolding = {
  tradingsymbol?: string;
  trading_symbol?: string;
  isin: string | null;
  quantity: number;
  average_price: number;
  last_price: number;
};

// Exchanges the one-time request_token and immediately fetches holdings.
// Throws with a user-facing message on any Kite-side failure.
export async function exchangeAndFetchHoldings(requestToken: string): Promise<KiteHolding[]> {
  const c = creds();
  if (!c) throw new Error("Kite is not configured");
  const checksum = createHash("sha256").update(`${c.key}${requestToken}${c.secret}`).digest("hex");

  const res = await fetch(`${KITE_BASE}/session/token`, {
    method: "POST",
    headers: {
      "X-Kite-Version": KITE_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ api_key: c.key, request_token: requestToken, checksum }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json().catch(() => null)) as {
    status?: string;
    data?: { access_token?: string };
    message?: string;
    error_type?: string;
  } | null;
  if (!res.ok || body?.status !== "success" || !body.data?.access_token) {
    // Common cases: expired/used request_token, wrong checksum.
    throw new Error(
      body?.message ?? body?.error_type ?? `Kite session exchange failed (${res.status})`,
    );
  }
  const accessToken = body.data.access_token;

  const hRes = await fetch(`${KITE_BASE}/portfolio/holdings`, {
    headers: {
      "X-Kite-Version": KITE_VERSION,
      Authorization: `token ${c.key}:${accessToken}`,
    },
    signal: AbortSignal.timeout(15000),
  });
  const hBody = (await hRes.json().catch(() => null)) as {
    status?: string;
    data?: unknown[];
    message?: string;
  } | null;
  if (!hRes.ok || hBody?.status !== "success" || !Array.isArray(hBody.data)) {
    throw new Error(hBody?.message ?? `Kite holdings fetch failed (${hRes.status})`);
  }
  return hBody.data as KiteHolding[];
  // accessToken goes out of scope here — intentionally not persisted.
}

function supabaseServer(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key);
}

const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;

// Ownership split: Kite owns equities/ETFs/SGBs/bonds (quantities, true buy
// average, NSE symbol). Mutual funds stay owned by the monthly statement
// imports so Coin MFs held at Zerodha are never double-counted.
export type KiteSyncSummary = {
  total: number;
  synced: number;
  skippedMf: number;
  skippedNoIsin: number;
  removedSold: number;
  addedSecurities: number;
};

export async function reconcileHoldings(holdings: KiteHolding[]): Promise<KiteSyncSummary> {
  const supa = supabaseServer();
  const summary: KiteSyncSummary = {
    total: holdings.length,
    synced: 0,
    skippedMf: 0,
    skippedNoIsin: 0,
    removedSold: 0,
    addedSecurities: 0,
  };
  const today = new Date().toISOString().slice(0, 10);
  const SOURCE = "Zerodha · Kite";

  for (const item of holdings) {
    const symbol = (item.tradingsymbol ?? item.trading_symbol ?? "").toUpperCase();
    const isin =
      item.isin && ISIN_RE.test(item.isin.trim()) ? item.isin.trim().toUpperCase() : null;
    if (!symbol || !isin) {
      summary.skippedNoIsin++;
      continue;
    }
    if (isin.startsWith("INF")) {
      summary.skippedMf++;
      continue;
    }

    let kind = "other";
    if (/ETF/i.test(symbol)) kind = "etf";
    else if (isin.startsWith("INE")) kind = "equity";
    else if (isin.startsWith("IN9")) kind = "sgb";
    else if (/NCD|BOND|TBILL/i.test(symbol)) kind = "bond";

    const { data: ex } = await supa.from("securities").select("id").eq("isin", isin).maybeSingle();
    let secId: string;
    if (ex) {
      secId = ex.id as string;
      await supa.from("securities").update({ nse_symbol: symbol }).eq("id", secId);
    } else {
      const { data: created, error } = await supa
        .from("securities")
        .insert({ isin, name: symbol, kind, nse_symbol: symbol })
        .select("id")
        .single();
      if (error) throw error;
      secId = created.id as string;
      summary.addedSecurities++;
    }

    const existing = await supa
      .from("investments")
      .select("id")
      .eq("security_id", secId)
      .eq("source", SOURCE)
      .maybeSingle();

    if ((item.quantity ?? 0) <= 0) {
      // Fully sold: drop our row entirely instead of keeping a zero stub.
      if (existing?.data?.id) {
        await supa
          .from("investments")
          .delete()
          .eq("id", existing.data.id as string);
        summary.removedSold++;
      }
      continue;
    }

    const payload = {
      quantity: item.quantity,
      price: item.last_price,
      value: Math.round(item.last_price * item.quantity * 100) / 100,
      cost_value: Math.round(item.average_price * item.quantity * 100) / 100,
      as_of_date: today,
    };

    if (existing?.data?.id) {
      // Update without touching `hidden` — respect the user's choice.
      await supa
        .from("investments")
        .update(payload)
        .eq("id", existing.data.id as string);
    } else {
      await supa.from("investments").insert({ security_id: secId, source: SOURCE, ...payload });
    }
    summary.synced++;
  }

  return summary;
}
