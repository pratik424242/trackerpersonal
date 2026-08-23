import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Inbox, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { formatINR, investmentsQuery, portfolioSnapshotsQuery } from "@/lib/finance";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/investments")({
  head: () => ({
    meta: [
      { title: "Investments — Ledger" },
      {
        name: "description",
        content: "Mutual funds and stocks, imported from monthly CAS statements.",
      },
    ],
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(investmentsQuery),
      context.queryClient.ensureQueryData(portfolioSnapshotsQuery),
    ]),
  component: InvestmentsPage,
});

// Live pricing overlay — CAS values render instantly from Supabase; this
// refines them with today's NAV / quotes once fetched.
type LiveRow = {
  id: string;
  isin: string;
  name: string;
  kind: string;
  nseSymbol: string | null;
  quantity: number;
  casPrice: number | null;
  costValue: number | null;
  hidden: boolean;
  livePrice?: number;
  priceSource: "nav" | "quote" | "cas";
  priceDate?: string;
  value: number;
  changePct: number | null;
};
type LiveResponse = {
  asOfDate: string | null;
  casTotal: number;
  liveTotal: number;
  investedTotal: number;
  holdings: LiveRow[];
};

function useLivePrices() {
  return useQuery<LiveResponse>({
    queryKey: ["investments", "live"],
    queryFn: async () => {
      const res = await fetch("/api/investments");
      if (!res.ok) throw new Error(`live prices failed (${res.status})`);
      return (await res.json()) as LiveResponse;
    },
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}

// Kite sync availability — cheap GET, cached for the session.
function useKite() {
  const qc = useQueryClient();
  const status = useQuery<{ configured: boolean; url?: string }>({
    queryKey: ["kite", "login"],
    queryFn: async () => {
      const res = await fetch("/api/kite-login");
      if (!res.ok) throw new Error("kite status failed");
      return (await res.json()) as { configured: boolean; url?: string };
    },
    staleTime: Infinity,
    retry: false,
  });

  const sync = useMutation({
    mutationFn: async (requestToken: string) => {
      const res = await fetch("/api/kite-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_token: requestToken }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
        synced?: number;
        removedSold?: number;
      } | null;
      if (!res.ok || !body?.ok) throw new Error(body?.error ?? `sync failed (${res.status})`);
      return body;
    },
    onSuccess: (body) => {
      let msg = `Zerodha synced · ${body.synced ?? 0} holding(s) updated`;
      if ((body.removedSold ?? 0) > 0) msg += `, ${body.removedSold} sold position(s) cleared`;
      toast.success(msg);
      qc.invalidateQueries({ queryKey: ["investments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { status, sync };
}

const KIND_LABELS: Record<string, string> = {
  mutual_fund: "Mutual Funds",
  etf: "ETFs",
  equity: "Stocks",
  sgb: "Gold Bonds",
  bond: "Bonds",
  other: "Other",
};
// ETFs trade like stocks; they share a tab.
function tabForKind(kind: string): string {
  if (kind === "equity" || kind === "etf") return "equity";
  return kind;
}
const TAB_LABELS: Record<string, string> = {
  all: "All",
  mutual_fund: "Mutual Funds",
  equity: "Stocks",
  sgb: "Gold Bonds",
  bond: "Bonds",
  other: "Other",
};

const TAB_KEY = "ledger:investedTab";

// CAS names carry AMC boilerplate ("HDFC AMC LTD HDFC MF- <scheme>"); the
// scheme after the last "MF-" is what's worth showing.
function prettyName(name: string): string {
  const idx = name.toUpperCase().lastIndexOf("MF-");
  const scheme = idx >= 0 ? name.slice(idx + 3).trim() : name.trim();
  return scheme || name;
}

function pctStr(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function InvestmentsPage() {
  const qc = useQueryClient();
  const { data: holdings = [], isLoading } = useQuery(investmentsQuery);
  const { data: snapshots = [] } = useQuery(portfolioSnapshotsQuery);
  const live = useLivePrices();
  const kite = useKite();

  // Returning from the Kite login redirect: /investments?request_token=…
  // (or ?status=error). Sync immediately, then strip the query so a refresh
  // never replays a consumed token.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get("request_token");
    const status = params.get("status");
    if (!requestToken && !status) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (requestToken) {
      kite.sync.mutate(requestToken);
    } else {
      toast.error("Zerodha login was cancelled or failed.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [tab, setTab] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    return window.localStorage.getItem(TAB_KEY) ?? "all";
  });
  const [showHidden, setShowHidden] = useState(false);

  function selectTab(id: string) {
    setTab(id);
    try {
      window.localStorage.setItem(TAB_KEY, id);
    } catch {
      /* private mode */
    }
  }

  const liveById = useMemo(() => {
    const m = new Map<string, LiveRow>();
    for (const r of live.data?.holdings ?? []) m.set(r.id, r);
    return m;
  }, [live.data]);

  // Supabase rows render instantly; the live endpoint overlays NAVs/quotes,
  // invested totals, and the hidden flags.
  const rows = useMemo(
    () =>
      holdings.map((h) => {
        const l = liveById.get(h.id);
        const value = l?.value ?? h.value ?? (h.price ?? 0) * h.quantity;
        return {
          id: h.id,
          securityId: h.security_id,
          source: h.source,
          name: prettyName(h.security.name),
          kind: h.security.kind as string,
          quantity: h.quantity,
          price: l?.livePrice ?? h.price ?? 0,
          priceSource: l?.priceSource ?? ("cas" as const),
          priceDate: l?.priceDate,
          nseSymbol: l?.nseSymbol ?? null,
          value,
          costValue: l?.costValue ?? (h.cost_value != null ? Number(h.cost_value) : null),
          changePct: l?.changePct ?? null,
          hidden: h.hidden,
          isLive: l != null,
        };
      }),
    [holdings, liveById],
  );

  const hiddenRows = useMemo(() => rows.filter((r) => r.hidden), [rows]);
  const visibleRows = useMemo(() => rows.filter((r) => !r.hidden), [rows]);

  // Tabs derive from what's actually held, so the bar never shows empties.
  const tabs = useMemo(() => {
    const ids = [...new Set(visibleRows.map((r) => tabForKind(r.kind)))];
    return ["all", ...ids];
  }, [visibleRows]);

  const tabRows = useMemo(
    () => (tab === "all" ? visibleRows : visibleRows.filter((r) => tabForKind(r.kind) === tab)),
    [visibleRows, tab],
  );

  const total = visibleRows.reduce((s, r) => s + r.value, 0);
  const invested =
    live.data?.investedTotal || visibleRows.reduce((s, r) => s + (r.costValue ?? 0), 0);
  const overallPct = invested > 0 ? ((total - invested) / invested) * 100 : null;
  const overallGain = invested > 0 ? total - invested : null;

  // Month-over-month from snapshot history (CAS lands monthly).
  const history = [...snapshots].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const prevSnapshot = history.length >= 2 ? history[history.length - 2] : null;
  const momDelta = prevSnapshot ? total - Number(prevSnapshot.total_value) : null;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof tabRows>();
    for (const r of tabRows) {
      const g = tabForKind(r.kind);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(r);
    }
    // Biggest group first so the dominant holding type leads.
    return [...map.entries()].sort(
      (a, b) => b[1].reduce((s, r) => s + r.value, 0) - a[1].reduce((s, r) => s + r.value, 0),
    );
  }, [tabRows]);

  const [showAllHistory, setShowAllHistory] = useState(false);

  const setHiddenMut = useMutation({
    mutationFn: async ({ id, hidden }: { id: string; hidden: boolean }) => {
      const { error } = await supabase.from("investments").update({ hidden }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      toast.success("Portfolio updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-44 rounded bg-muted animate-pulse" />
        <div className="h-40 rounded-xl bg-muted/50 animate-pulse" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-16 flex flex-col items-center gap-3 text-center text-sm text-muted-foreground">
        <Inbox className="size-6 text-muted-foreground/50" aria-hidden="true" />
        <p>No investments yet.</p>
        <p className="text-xs max-w-xs">
          Your monthly CDSL statement (eCAS email) is imported automatically. It may take until the
          next statement arrives — or trigger an import manually from the server.
        </p>
      </div>
    );
  }

  const visibleHistory = showAllHistory ? history : history.slice(-6);

  return (
    <div className="space-y-6 md:space-y-10">
      <section>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Portfolio</p>
          <div className="flex items-center gap-2">
            {hiddenRows.length > 0 && (
              <span className="tnum text-[11px] text-muted-foreground">
                {hiddenRows.length} hidden
              </span>
            )}
            {kite.status.data?.configured && (
              <button
                onClick={() => {
                  if (kite.status.data?.url) window.location.href = kite.status.data.url;
                }}
                disabled={kite.sync.isPending}
                aria-label="Sync holdings from Zerodha"
                className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`size-3.5 ${kite.sync.isPending ? "animate-spin" : ""}`} />
                {kite.sync.isPending ? "Syncing…" : "Sync Zerodha"}
              </button>
            )}
          </div>
        </div>
        <p className="tnum mt-2 text-4xl md:text-6xl font-semibold tracking-tight">
          {formatINR(total)}
        </p>
        <p className="mt-2 text-xs md:text-sm text-muted-foreground tnum">
          {invested > 0 && (
            <>
              Invested {formatINR(invested)} ·{" "}
              <span
                className={
                  overallPct != null && overallPct >= 0
                    ? "text-[color:var(--success)]"
                    : "text-destructive"
                }
              >
                {overallGain != null ? `${formatINR(overallGain, { sign: true })} ` : ""}
                {pctStr(overallPct)}
              </span>
              {" · "}
            </>
          )}
          {asOfText(live.data?.asOfDate ?? holdings[0]?.as_of_date ?? null)}
          {momDelta != null && (
            <>
              {" · "}
              <span className={momDelta >= 0 ? "text-[color:var(--success)]" : "text-destructive"}>
                {formatINR(momDelta, { sign: true })}
              </span>{" "}
              since last statement
            </>
          )}
          {visibleRows.some((r) => r.isLive) && (
            <> · prices {live.isFetching ? "updating…" : "live"}</>
          )}
        </p>
      </section>

      {tabs.length > 2 && (
        <div className="-mx-2 overflow-x-auto scrollbar-none">
          <div className="flex gap-2 px-2 pb-1">
            {tabs.map((t) => (
              <button
                key={t}
                onClick={() => selectTab(t)}
                className={`shrink-0 h-8 px-3.5 rounded-full text-xs border transition-colors ${
                  tab === t
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                }`}
              >
                {TAB_LABELS[t] ?? t}
              </button>
            ))}
          </div>
        </div>
      )}

      {grouped.map(([kind, kindRows]) => {
        const kindTotal = kindRows.reduce((s, r) => s + r.value, 0);
        const kindCost = kindRows.reduce((s, r) => s + (r.costValue ?? 0), 0);
        const kindPct = kindCost > 0 ? ((kindTotal - kindCost) / kindCost) * 100 : null;
        return (
          <section key={kind}>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                {TAB_LABELS[kind] ?? KIND_LABELS[kind] ?? kind}
              </h2>
              <span className="tnum text-xs text-muted-foreground">
                {kindPct != null && (
                  <span
                    className={kindPct >= 0 ? "text-[color:var(--success)]" : "text-destructive"}
                  >
                    {pctStr(kindPct)} ·{" "}
                  </span>
                )}
                {formatINR(kindTotal)}
              </span>
            </div>
            <ul className="divide-y divide-border/60">
              {kindRows.map((r) => (
                <HoldingRow
                  key={r.id}
                  row={r}
                  onHide={(id) => setHiddenMut.mutate({ id, hidden: true })}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {history.length >= 2 && (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              History
            </h2>
            {history.length > 6 && (
              <button
                onClick={() => setShowAllHistory((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {showAllHistory ? "Show less" : `All ${history.length}`}
              </button>
            )}
          </div>
          <div className="rounded-xl border border-border/70 bg-surface p-4 md:p-5">
            <ul className="space-y-2.5">
              {visibleHistory.map((s) => {
                const v = Number(s.total_value);
                const max = Math.max(...history.map((x) => Number(x.total_value)));
                return (
                  <li key={s.id} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-xs text-muted-foreground tnum">
                      {new Date(s.as_of_date + "T00:00:00").toLocaleDateString("en-IN", {
                        month: "short",
                        year: "2-digit",
                      })}
                    </span>
                    <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="tnum text-sm w-24 text-right">{formatINR(v)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      {hiddenRows.length > 0 && (
        <section>
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <EyeOff className="size-3.5" />
            Hidden folios ({hiddenRows.length})
          </button>
          {showHidden && (
            <ul className="mt-2 divide-y divide-border/60 rounded-xl border border-border/70 bg-surface px-3">
              {hiddenRows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{r.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate tnum">{r.source}</p>
                  </div>
                  <button
                    onClick={() => setHiddenMut.mutate({ id: r.id, hidden: false })}
                    className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Eye className="size-3.5" /> Unhide
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function asOfText(asOf: string | null): string {
  if (!asOf) return "";
  return `CAS as of ${new Date(asOf + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
}

type Row = {
  id: string;
  securityId: string;
  source: string;
  name: string;
  kind: string;
  quantity: number;
  price: number;
  priceSource: "nav" | "quote" | "cas";
  priceDate?: string;
  nseSymbol: string | null;
  value: number;
  costValue: number | null;
  changePct: number | null;
  hidden: boolean;
  isLive: boolean;
};

function HoldingRow({ row, onHide }: { row: Row; onHide: (id: string) => void }) {
  const qc = useQueryClient();
  const [editingSymbol, setEditingSymbol] = useState(false);
  const [symbol, setSymbol] = useState("");

  const symbolMut = useMutation({
    mutationFn: async () => {
      const sym = symbol.trim().toUpperCase();
      if (!/^[A-Z0-9]{2,20}$/.test(sym)) throw new Error("Enter a valid NSE symbol");
      const { error } = await supabase
        .from("securities")
        .update({ nse_symbol: sym })
        .eq("id", row.securityId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      setEditingSymbol(false);
      setSymbol("");
      toast.success("Live quote enabled");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Gain vs invested cost when known; otherwise day-change vs statement price.
  const gain = row.costValue != null && row.costValue > 0 ? row.value - row.costValue : null;
  const gainPct = gain != null && row.costValue ? (gain / row.costValue) * 100 : null;
  const good = (gainPct ?? row.changePct ?? 0) >= 0;

  return (
    <li className="group flex items-center gap-4 py-3 -mx-2 px-2 rounded-md hover:bg-muted/40 transition-all">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{row.name}</div>
        <div className="text-xs text-muted-foreground truncate tnum">
          {row.quantity.toLocaleString("en-IN", { maximumFractionDigits: 3 })} units @ ₹
          {row.price.toLocaleString("en-IN", { maximumFractionDigits: 4 })}
          {row.priceSource === "nav" && row.priceDate ? ` · NAV ${row.priceDate}` : ""}
          {row.priceSource === "quote" ? " · live" : ""}
          {row.priceSource === "cas" ? " · CAS" : ""}
          {(row.kind === "equity" || row.kind === "etf") && !row.nseSymbol && !editingSymbol && (
            <button
              onClick={() => setEditingSymbol(true)}
              className="ml-1.5 underline underline-offset-2 hover:text-foreground"
            >
              set NSE symbol
            </button>
          )}
          {editingSymbol && (
            <span className="ml-1.5 inline-flex items-center gap-1">
              <input
                autoFocus
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && symbol.trim() && symbolMut.mutate()}
                placeholder="e.g. APLAPOLLO"
                className="w-28 bg-muted/50 border border-border rounded px-1.5 py-0.5 outline-none focus:border-primary"
              />
              <button
                onClick={() => symbolMut.mutate()}
                disabled={symbolMut.isPending}
                className="text-primary"
              >
                save
              </button>
              <button
                onClick={() => {
                  setEditingSymbol(false);
                  setSymbol("");
                }}
                className="text-muted-foreground"
              >
                ×
              </button>
            </span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="tnum text-sm font-medium">{formatINR(row.value)}</div>
        {(gainPct != null || row.changePct != null) && (
          <div
            className={`tnum text-xs ${good ? "text-[color:var(--success)]" : "text-destructive"}`}
          >
            {gain != null && `${formatINR(gain, { sign: true })} · `}
            {gainPct != null ? pctStr(gainPct) : pctStr(row.changePct)}
          </div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onHide(row.id);
        }}
        aria-label="Hide this folio"
        className="shrink-0 p-2 -mr-2 opacity-60 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
      >
        <EyeOff className="size-4" />
      </button>
    </li>
  );
}
