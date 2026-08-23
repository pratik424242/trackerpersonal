import { defineHandler } from "h3";
import { createClient } from "@supabase/supabase-js";

// Enriches stored CAS holdings with live pricing:
//   mutual funds → today's NAV from AMFI's official daily file (free)
//   equities/ETFs with an NSE symbol set → Yahoo Finance last trade
// Anything without a live source keeps its statement-day price/value.
//
// Authless by design, matching the rest of this single-user app (all
// Supabase tables are already anon-readable).

type Holding = {
  id: string;
  quantity: number;
  price: number | null;
  value: number | null;
  cost_value: number | null;
  hidden: boolean;
  as_of_date: string;
  source: string;
  security_id: string;
  securities: { isin: string; name: string; kind: string; nse_symbol: string | null } | null;
};

// AMFI publishes all NAVs in one semicolon-delimited file daily.
const AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt";
let amfiCache: { at: number; byIsin: Map<string, { nav: number; date: string }> } | null = null;
const AMFI_TTL_MS = 12 * 60 * 60 * 1000;

async function amfiByIsin(): Promise<Map<string, { nav: number; date: string }>> {
  if (amfiCache && Date.now() - amfiCache.at < AMFI_TTL_MS) return amfiCache.byIsin;
  const res = await fetch(AMFI_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`amfi fetch failed: ${res.status}`);
  const text = await res.text();
  const byIsin = new Map<string, { nav: number; date: string }>();
  // The file mixes several column layouts (some rows carry extra empty or
  // scheme-code columns), so instead of fixed positions: ISINs are any field
  // matching the pattern, NAV is the last standalone positive number in the
  // row (the scheme code sits before the name, NAV after), and the date is
  // the dd-MMM-yyyy field.
  for (const line of text.split("\n")) {
    if (!line.includes(";")) continue;
    const cols = line.split(";").map((c) => c.trim());
    const isins = cols.filter((c) => /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/.test(c));
    if (isins.length === 0) continue;
    let nav: number | null = null;
    let date = "";
    for (const c of cols) {
      if (/^\d{1,6}(\.\d{1,4})?$/.test(c)) {
        const n = Number(c);
        if (n > 0) nav = n;
      } else if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(c)) {
        date = c;
      }
    }
    if (nav === null || nav <= 0) continue;
    for (const isin of isins) byIsin.set(isin, { nav, date });
  }
  amfiCache = { at: Date.now(), byIsin };
  return byIsin;
}

async function yahooQuote(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (personal ledger)" },
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    return null; // best-effort only — CAS value remains the fallback
  }
}

export default defineHandler(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { error: "missing supabase config" };
  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from("investments")
    .select("*, securities(isin,name,kind,nse_symbol)");
  if (error) return { error: error.message };
  const holdings = (data ?? []) as Holding[];
  if (holdings.length === 0) {
    return { asOfDate: null, casTotal: 0, liveTotal: null, holdings: [] };
  }

  let amfi: Map<string, { nav: number; date: string }> | null = null;
  try {
    amfi = await amfiByIsin();
  } catch (e) {
    console.error("[investments] amfi unavailable:", e instanceof Error ? e.message : e);
  }

  // Hidden folios are returned (so the UI can offer unhide) but excluded
  // from every total and from quote fetching.
  const visible = holdings.filter((h) => !h.hidden);

  // Equities first so Yahoo lookups run concurrently, bounded.
  const quoteTargets = visible.filter(
    (h) =>
      h.securities &&
      h.securities.nse_symbol &&
      (h.securities.kind === "equity" || h.securities.kind === "etf"),
  );
  const quotes = new Map<string, number>();
  await Promise.all(
    quoteTargets.map(async (h) => {
      const q = await yahooQuote(h.securities!.nse_symbol!);
      if (q !== null) quotes.set(h.securities!.nse_symbol!, q);
    }),
  );

  const asOfDate = holdings[0].as_of_date;
  let casTotal = 0;
  let liveTotal = 0;
  let investedTotal = 0;

  const rows = holdings.map((h) => {
    const sec = h.securities ?? { isin: "?", name: "?", kind: "other", nse_symbol: null };
    const casValue = h.value ?? (h.price != null ? h.price * h.quantity : 0);
    let livePrice: number | undefined;
    let priceSource: "nav" | "quote" | "cas" = "cas";
    let priceDate: string | undefined;

    if (!h.hidden) {
      casTotal += casValue;
      if (h.cost_value != null) investedTotal += Number(h.cost_value);

      if (sec.kind === "mutual_fund" && amfi?.get(sec.isin)) {
        const entry = amfi.get(sec.isin)!;
        livePrice = entry.nav;
        priceSource = "nav";
        priceDate = entry.date;
      } else if (sec.nse_symbol && quotes.has(sec.nse_symbol)) {
        livePrice = quotes.get(sec.nse_symbol);
        priceSource = "quote";
      }
    }

    const value = livePrice !== undefined ? livePrice * h.quantity : casValue;
    if (!h.hidden) liveTotal += value;

    return {
      id: h.id,
      isin: sec.isin,
      name: sec.name,
      kind: sec.kind,
      nseSymbol: sec.nse_symbol,
      source: h.source,
      quantity: h.quantity,
      hidden: h.hidden,
      costValue: h.cost_value != null ? Number(h.cost_value) : null,
      casPrice: h.price,
      casValue,
      livePrice,
      priceSource,
      priceDate,
      value,
      changePct:
        livePrice !== undefined && h.price ? ((livePrice - h.price) / h.price) * 100 : null,
    };
  });

  rows.sort((a, b) => Number(b.hidden) - Number(a.hidden) || b.value - a.value);

  return {
    asOfDate,
    casTotal: Math.round(casTotal * 100) / 100,
    liveTotal: Math.round(liveTotal * 100) / 100,
    investedTotal: Math.round(investedTotal * 100) / 100,
    holdings: rows,
  };
});
