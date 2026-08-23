import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Inbox } from "lucide-react";
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

const KIND_LABELS: Record<string, string> = {
  mutual_fund: "Mutual funds",
  etf: "ETFs",
  equity: "Stocks",
  sgb: "Gold bonds",
  bond: "Bonds",
  other: "Other",
};
const KIND_ORDER = ["mutual_fund", "etf", "equity", "sgb", "bond", "other"];

// CAS names carry the AMC boilerplate ("HDFC AMC LTD HDFC MF- <scheme>");
// the scheme after the last "MF-" is what's worth showing.
function prettyName(name: string): string {
  const idx = name.toUpperCase().lastIndexOf("MF-");
  const scheme = idx >= 0 ? name.slice(idx + 3).trim() : name.trim();
  return scheme || name;
}

function InvestmentsPage() {
  const { data: holdings = [], isLoading } = useQuery(investmentsQuery);
  const { data: snapshots = [] } = useQuery(portfolioSnapshotsQuery);
  const live = useLivePrices();
  const [showAllHistory, setShowAllHistory] = useState(false);

  const liveById = useMemo(() => {
    const m = new Map<string, LiveRow>();
    for (const r of live.data?.holdings ?? []) m.set(r.id, r);
    return m;
  }, [live.data]);

  const rows = useMemo(
    () =>
      holdings
        .map((h) => {
          const l = liveById.get(h.id);
          const value = l?.value ?? h.value ?? (h.price ?? 0) * h.quantity;
          return {
            id: h.id,
            securityId: h.security_id,
            name: prettyName(h.security.name),
            kind: h.security.kind as string,
            nseSymbol: h.security.nse_symbol,
            source: h.source,
            quantity: h.quantity,
            price: l?.livePrice ?? h.price ?? 0,
            priceSource: l?.priceSource ?? ("cas" as const),
            priceDate: l?.priceDate,
            value,
            changePct: l?.changePct ?? null,
            isLive: l != null,
          };
        })
        .sort((a, b) => b.value - a.value),
    [holdings, liveById],
  );

  const total = rows.reduce((s, r) => s + r.value, 0);
  const asOf = live.data?.asOfDate ?? holdings[0]?.as_of_date ?? null;

  // Month-over-month from snapshot history (CAS lands monthly).
  const history = [...snapshots].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  const prevSnapshot = history.length >= 2 ? history[history.length - 2] : null;
  const momDelta = prevSnapshot ? total - Number(prevSnapshot.total_value) : null;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!map.has(r.kind)) map.set(r.kind, []);
      map.get(r.kind)!.push(r);
    }
    return [...map.entries()].sort((a, b) => KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]));
  }, [rows]);

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
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Portfolio</p>
        <p className="tnum mt-2 text-4xl md:text-6xl font-semibold tracking-tight">
          {formatINR(total)}
        </p>
        <p className="mt-2 text-xs md:text-sm text-muted-foreground tnum">
          {asOf
            ? `CAS as of ${new Date(asOf + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`
            : ""}
          {momDelta != null && (
            <>
              {" · "}
              <span className={momDelta >= 0 ? "text-[color:var(--success)]" : "text-destructive"}>
                {formatINR(momDelta, { sign: true })}
              </span>{" "}
              since last statement
            </>
          )}
          {rows.some((r) => r.isLive) && <> · prices {live.isFetching ? "updating…" : "live"}</>}
        </p>
      </section>

      {visibleHistory.length >= 2 && (
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

      {grouped.map(([kind, kindRows]) => {
        const kindTotal = kindRows.reduce((s, r) => s + r.value, 0);
        return (
          <section key={kind}>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                {KIND_LABELS[kind] ?? kind}
              </h2>
              <span className="tnum text-xs text-muted-foreground">
                {total > 0 ? Math.round((kindTotal / total) * 100) : 0}% · {formatINR(kindTotal)}
              </span>
            </div>
            <ul className="divide-y divide-border/60">
              {kindRows.map((r) => (
                <HoldingRow key={r.id} row={r} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

type Row = {
  id: string;
  securityId: string;
  name: string;
  kind: string;
  nseSymbol: string | null;
  quantity: number;
  price: number;
  priceSource: "nav" | "quote" | "cas";
  priceDate?: string;
  value: number;
  changePct: number | null;
};

function HoldingRow({ row }: { row: Row }) {
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
        {row.changePct != null && (
          <div
            className={`tnum text-xs ${row.changePct >= 0 ? "text-[color:var(--success)]" : "text-destructive"}`}
          >
            {row.changePct >= 0 ? "+" : ""}
            {row.changePct.toFixed(2)}%
          </div>
        )}
      </div>
    </li>
  );
}
