import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { toast } from "sonner";
import {
  categoriesQuery,
  formatINR,
  monthTransactionsQuery,
  spendingLimitsQuery,
  upsertLimit,
} from "@/lib/finance";

export const Route = createFileRoute("/insights")({
  head: () => ({
    meta: [
      { title: "Insights — Ledger" },
      { name: "description", content: "Monthly spending summary and category limits." },
    ],
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(categoriesQuery),
      context.queryClient.ensureQueryData(spendingLimitsQuery),
      context.queryClient.ensureQueryData(monthTransactionsQuery(new Date())),
    ]),
  component: InsightsPage,
});

function monthStart(offset: number) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
}

function InsightsPage() {
  const [monthOffset, setMonthOffset] = useState(0);
  const isCurrentMonth = monthOffset === 0;

  const som = monthStart(monthOffset);
  const soLastMonth = monthStart(monthOffset - 1);

  const { data: categories = [] } = useQuery(categoriesQuery);
  const { data: limits = [] } = useQuery(spendingLimitsQuery);
  const { data: thisMonth = [], isLoading: loadingThis } = useQuery(monthTransactionsQuery(som));
  const { data: lastMonth = [] } = useQuery(monthTransactionsQuery(soLastMonth));

  const monthSpend = thisMonth.filter((t) => t.kind === "expense").reduce((s, t) => s + Number(t.amount), 0);
  const monthIncome = thisMonth.filter((t) => t.kind === "salary").reduce((s, t) => s + Number(t.amount), 0);
  const lastMonthSpend = lastMonth.filter((t) => t.kind === "expense").reduce((s, t) => s + Number(t.amount), 0);
  const savings = monthIncome - monthSpend;

  const today = new Date();
  const dayOfMonth = isCurrentMonth ? today.getDate() : new Date(som.getFullYear(), som.getMonth() + 1, 0).getDate();
  const daysInLastMonth = new Date(som.getFullYear(), som.getMonth(), 0).getDate();
  const avgPerDay = dayOfMonth > 0 ? monthSpend / dayOfMonth : 0;
  const lastAvgPerDay = lastMonthSpend / daysInLastMonth;
  const pace =
    isCurrentMonth && lastMonthSpend > 0
      ? ((monthSpend - (lastMonthSpend * dayOfMonth) / daysInLastMonth) / ((lastMonthSpend * dayOfMonth) / daysInLastMonth)) * 100
      : 0;

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of thisMonth) {
      if (t.kind !== "expense" || !t.category_id) continue;
      map.set(t.category_id, (map.get(t.category_id) ?? 0) + Number(t.amount));
    }
    return map;
  }, [thisMonth]);

  const byCategoryLast = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of lastMonth) {
      if (t.kind !== "expense" || !t.category_id) continue;
      map.set(t.category_id, (map.get(t.category_id) ?? 0) + Number(t.amount));
    }
    return map;
  }, [lastMonth]);

  const limitByCat = useMemo(
    () => Object.fromEntries(limits.map((l) => [l.category_id, l.monthly_limit])),
    [limits],
  );

  const rows = categories
    .map((c) => ({
      c,
      spent: byCategory.get(c.id) ?? 0,
      lastSpent: byCategoryLast.get(c.id) ?? 0,
      limit: limitByCat[c.id] ?? 0,
    }))
    .filter((r) => r.spent > 0 || r.limit > 0 || r.lastSpent > 0)
    .sort((a, b) => b.spent - a.spent);

  const monthName = som.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const lastMonthName = soLastMonth.toLocaleString("en-IN", { month: "long" });

  const spendDelta = monthSpend - lastMonthSpend;
  const spendDeltaPct = lastMonthSpend > 0 ? (spendDelta / lastMonthSpend) * 100 : 0;

  return (
    <div className="space-y-6 md:space-y-10">
      <section>
        <div className="flex items-center justify-between">
          <button
            onClick={() => setMonthOffset((o) => o - 1)}
            aria-label="Previous month"
            className="p-2 -ml-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ChevronLeft className="size-4" />
          </button>
          <p className="text-xs uppercase tracking-wider text-muted-foreground tnum">{monthName}</p>
          <button
            onClick={() => setMonthOffset((o) => Math.min(0, o + 1))}
            disabled={isCurrentMonth}
            aria-label="Next month"
            className="p-2 -mr-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-0 disabled:pointer-events-none"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Metric label="Spent" value={formatINR(monthSpend)} loading={loadingThis} />
          <Metric label="Earned" value={formatINR(monthIncome)} loading={loadingThis} />
        </div>
        <div className="mt-3 rounded-xl border border-border/70 bg-surface p-4 md:p-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Savings margin</p>
          <p className={`tnum mt-2 text-2xl md:text-3xl font-semibold ${savings < 0 ? "text-destructive" : "text-[color:var(--success)]"}`}>
            {formatINR(savings, { sign: true })}
          </p>
          {monthIncome > 0 && (
            <p className="mt-1 text-xs text-muted-foreground tnum">
              {Math.round((savings / monthIncome) * 100)}% of income
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          vs {lastMonthName}
        </h2>
        <div className="rounded-xl border border-border/70 bg-surface p-4 md:p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Spend delta</p>
              <p className={`tnum mt-1 text-2xl font-semibold ${spendDelta > 0 ? "text-destructive" : "text-[color:var(--success)]"}`}>
                {formatINR(spendDelta, { sign: true })}
              </p>
            </div>
            {lastMonthSpend > 0 && (
              <span className={`tnum text-sm ${spendDelta > 0 ? "text-destructive" : "text-[color:var(--success)]"}`}>
                {spendDeltaPct > 0 ? "+" : ""}{spendDeltaPct.toFixed(1)}%
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/50">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Avg / day</p>
              <p className="tnum mt-1 text-lg font-medium">{formatINR(avgPerDay)}</p>
              <p className="tnum mt-0.5 text-xs text-muted-foreground">was {formatINR(lastAvgPerDay)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Pace</p>
              <p className={`tnum mt-1 text-lg font-medium ${pace > 0 ? "text-destructive" : "text-[color:var(--success)]"}`}>
                {isCurrentMonth && lastMonthSpend > 0 ? `${pace > 0 ? "+" : ""}${pace.toFixed(0)}%` : "—"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isCurrentMonth ? "vs same day last month" : "current month only"}
              </p>
            </div>
          </div>
        </div>
      </section>

      <CalendarSection key={som.toISOString()} transactions={thisMonth} categories={categories} som={som} monthName={monthName} />

      <section>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">By category</h2>
        {rows.length === 0 ? (
          <div className="py-6 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
            <Inbox className="size-5 text-muted-foreground/50" aria-hidden="true" />
            No spending this month yet.
          </div>
        ) : (
          <ul className="space-y-4">
            {rows.map((r) => (
              <CategoryRow
                key={r.c.id}
                categoryId={r.c.id}
                name={r.c.name}
                spent={r.spent}
                lastSpent={r.lastSpent}
                limit={r.limit}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface p-4 md:p-5">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      {loading ? (
        <div className="mt-2 h-6 md:h-7 w-20 rounded bg-muted animate-pulse" />
      ) : (
        <p className="tnum mt-2 text-xl md:text-2xl font-semibold">{value}</p>
      )}
    </div>
  );
}

function CategoryRow({
  categoryId,
  name,
  spent,
  lastSpent,
  limit,
}: {
  categoryId: string;
  name: string;
  spent: number;
  lastSpent: number;
  limit: number;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(limit || ""));

  const mut = useMutation({
    mutationFn: () => upsertLimit(categoryId, Number(val) || 0),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["spending_limits"] });
      setEditing(false);
      toast.success("Limit saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  const over = limit > 0 && spent > limit;

  return (
    <li>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm">{name}</span>
        <div className="flex items-baseline gap-2">
          <span className="tnum text-sm font-medium">{formatINR(spent)}</span>
          {editing ? (
            <>
              <span className="text-muted-foreground text-xs">/ ₹</span>
              <input
                autoFocus
                value={val}
                onChange={(e) => setVal(e.target.value.replace(/[^0-9.]/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && mut.mutate()}
                className="tnum w-20 bg-muted/50 border border-border rounded px-1.5 py-0.5 text-right text-xs outline-none focus:border-primary"
              />
              <button onClick={() => mut.mutate()} className="text-xs text-primary">Save</button>
            </>
          ) : (
            <button
              onClick={() => { setVal(String(limit || "")); setEditing(true); }}
              className="tnum text-xs text-muted-foreground hover:text-foreground"
            >
              / {limit > 0 ? formatINR(limit) : "set limit"}
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${over ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${limit > 0 ? pct : 0}%` }}
        />
      </div>
      {lastSpent > 0 && (
        <p className="mt-1.5 text-[11px] text-muted-foreground tnum">
          last month {formatINR(lastSpent)}
          {spent > 0 && (
            <span className={spent > lastSpent ? "text-destructive ml-1.5" : "text-[color:var(--success)] ml-1.5"}>
              ({spent > lastSpent ? "+" : ""}{(((spent - lastSpent) / lastSpent) * 100).toFixed(0)}%)
            </span>
          )}
        </p>
      )}
    </li>
  );
}

type Txn = { id: string; amount: number | string; kind: string; category_id: string | null; occurred_at: string; note: string | null };
type Cat = { id: string; name: string };

function CalendarSection({
  transactions,
  categories,
  som,
  monthName,
}: {
  transactions: Txn[];
  categories: Cat[];
  som: Date;
  monthName: string;
}) {
  const today = new Date();
  const todayKey = today.toDateString();
  const daysInMonth = new Date(som.getFullYear(), som.getMonth() + 1, 0).getDate();
  const firstWeekday = som.getDay(); // 0=Sun

  const catName = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.name])) as Record<string, string>,
    [categories],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, { total: number; items: Txn[] }>();
    for (const t of transactions) {
      if (t.kind !== "expense") continue;
      const key = new Date(t.occurred_at).toDateString();
      const entry = map.get(key) ?? { total: 0, items: [] };
      entry.total += Number(t.amount);
      entry.items.push(t);
      map.set(key, entry);
    }
    return map;
  }, [transactions]);

  const maxDay = Math.max(1, ...Array.from(byDay.values()).map((v) => v.total));

  const initialSelected = som.getFullYear() === today.getFullYear() && som.getMonth() === today.getMonth() ? todayKey : null;
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSelected);

  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(som.getFullYear(), som.getMonth(), d));

  const selectedDate = selectedKey ? new Date(selectedKey) : null;
  const selectedEntry = selectedKey ? byDay.get(selectedKey) : undefined;

  const intensity = (total: number) => {
    if (total === 0) return 0;
    const r = total / maxDay;
    if (r < 0.15) return 1;
    if (r < 0.35) return 2;
    if (r < 0.6) return 3;
    if (r < 0.85) return 4;
    return 5;
  };
  const bgClass = ["bg-muted/40", "bg-primary/15", "bg-primary/30", "bg-primary/50", "bg-primary/70", "bg-primary"];

  return (
    <section>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Calendar</h2>
        <span className="tnum text-xs text-muted-foreground">{monthName}</span>
      </div>
      <div className="rounded-xl border border-border/70 bg-surface p-4">
        <div className="grid grid-cols-7 gap-1 mb-2">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i} className="text-[10px] text-center uppercase tracking-wider text-muted-foreground">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((date, i) => {
            if (!date) return <div key={i} />;
            const key = date.toDateString();
            const entry = byDay.get(key);
            const total = entry?.total ?? 0;
            const level = intensity(total);
            const isToday = key === todayKey;
            const isSelected = key === selectedKey;
            const isFuture = date > today;
            return (
              <button
                key={i}
                onClick={() => setSelectedKey(key)}
                disabled={isFuture}
                className={`aspect-square rounded-md flex flex-col items-center justify-center gap-0.5 transition-all
                  ${isFuture ? "opacity-30" : bgClass[level]}
                  ${isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-surface" : ""}
                  ${isToday && !isSelected ? "ring-1 ring-foreground/40" : ""}
                  hover:brightness-110`}
              >
                <span className={`tnum text-[11px] leading-none ${level >= 4 ? "text-primary-foreground" : ""}`}>
                  {date.getDate()}
                </span>
                {total > 0 && (
                  <span className={`tnum text-[9px] leading-none ${level >= 4 ? "text-primary-foreground/90" : "text-muted-foreground"}`}>
                    {total >= 1000 ? `${(total / 1000).toFixed(total >= 10000 ? 0 : 1)}k` : Math.round(total)}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {selectedDate && (
          <div className="mt-4 pt-4 border-t border-border/50">
            <div className="flex items-baseline justify-between mb-3">
              <p className="text-sm font-medium">
                {selectedDate.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
              </p>
              <p className="tnum text-sm font-semibold">{formatINR(selectedEntry?.total ?? 0)}</p>
            </div>
            {!selectedEntry || selectedEntry.items.length === 0 ? (
              <p className="text-xs text-muted-foreground">No expenses on this day.</p>
            ) : (
              <ul className="space-y-2">
                {selectedEntry.items
                  .slice()
                  .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
                  .map((t) => (
                    <li key={t.id} className="flex items-baseline justify-between gap-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate">
                          {t.category_id ? catName[t.category_id] ?? "Uncategorized" : "Uncategorized"}
                          {t.note && <span className="text-muted-foreground"> · {t.note}</span>}
                        </p>
                      </div>
                      <span className="tnum text-sm">{formatINR(Number(t.amount))}</span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
