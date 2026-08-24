import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Pencil,
  PiggyBank,
  Target,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { formatINR, monthTransactionsQuery } from "@/lib/finance";
import {
  addPlanItem,
  addPoolEvent,
  assessPurchase,
  decidePlanItem,
  DEFAULT_PLAN_SETTINGS,
  deletePlanItem,
  investedFromPlan,
  planItemsQuery,
  planPoolEventsQuery,
  planSettingsQuery,
  poolBalance,
  savePlanSettings,
  type PlanItem,
  type PlanPoolEvent,
  type PlanSettings,
  type Necessity,
  type Verdict,
  type VerdictLevel,
} from "@/lib/planner";

const numInput =
  "tnum w-full bg-muted/50 border border-border rounded-md px-3 py-2 text-right text-sm outline-none focus:border-primary transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

// Self-contained entry point for plan mode: a floating action button that
// lives on the Insights page and opens the whole planning interface as an
// overlay. Deliberately not a route — planning stays one tap away but never
// mixes into the ledger's navigation.
export function PlanFab() {
  const [open, setOpen] = useState(false);
  const { data: settings } = useQuery(planSettingsQuery);
  const { data: events = [] } = useQuery(planPoolEventsQuery);

  const threshold = Number(settings?.invest_threshold ?? DEFAULT_PLAN_SETTINGS.invest_threshold);
  const readyToInvest = poolBalance(events) >= threshold;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed z-30 right-4 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] md:right-8 md:bottom-8 inline-flex items-center gap-2 h-12 pl-4 pr-5 rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:shadow-xl hover:opacity-95 active:scale-95 transition-all"
        aria-label="Open purchase planner"
      >
        <Target className="size-5" aria-hidden="true" />
        <span className="text-sm font-medium">Plan</span>
        {readyToInvest && (
          <span className="absolute -top-1 -right-1 flex size-3.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--success)] opacity-60" />
            <span className="relative inline-flex size-3.5 rounded-full bg-[color:var(--success)] ring-2 ring-background" />
          </span>
        )}
      </button>
      {open && <PlannerModal onClose={() => setOpen(false)} />}
    </>
  );
}

function PlannerModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: settings = null } = useQuery(planSettingsQuery);
  const { data: items = [] } = useQuery(planItemsQuery);
  const { data: events = [] } = useQuery(planPoolEventsQuery);
  const { data: monthTxns = [] } = useQuery(monthTransactionsQuery(new Date()));

  const spentThisMonth = monthTxns
    .filter((t) => t.kind === "expense")
    .reduce((s, t) => s + Number(t.amount), 0);
  const incomeThisMonth = monthTxns
    .filter((t) => t.kind === "salary")
    .reduce((s, t) => s + Number(t.amount), 0);

  const effective: Pick<PlanSettings, "expected_income" | "monthly_budget" | "savings_goal"> =
    settings ?? DEFAULT_PLAN_SETTINGS;
  const configured =
    effective.expected_income > 0 || effective.monthly_budget > 0 || effective.savings_goal > 0;
  const threshold = Number(settings?.invest_threshold ?? DEFAULT_PLAN_SETTINGS.invest_threshold);

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeftInMonth = daysInMonth - now.getDate();

  const assess = (price: number, necessity: Necessity): Verdict =>
    assessPurchase({
      price,
      settings: effective,
      necessity,
      spentThisMonth,
      incomeThisMonth,
      isCurrentMonth: true,
      daysLeftInMonth,
    });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["plan_settings"] });
    qc.invalidateQueries({ queryKey: ["plan_items"] });
    qc.invalidateQueries({ queryKey: ["plan_pool_events"] });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end md:items-center justify-center bg-background/70 backdrop-blur-sm px-0 md:px-4"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-2xl md:rounded-xl border border-border bg-surface p-5 md:p-6 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] md:pb-6 space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium">Purchase planner</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Check before you buy · skipped purchases fund your investments
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close planner"
            className="p-1 -m-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <PlanSetup
          configured={configured}
          settings={effective}
          threshold={threshold}
          onSaved={invalidate}
        />

        {configured && (
          <>
            <AffordChecker assess={assess} onAdded={invalidate} />
            <WishlistSection items={items} assess={assess} onChanged={invalidate} />
            <PoolSection events={events} threshold={threshold} onChanged={invalidate} />
          </>
        )}
      </div>
    </div>
  );
}

function PlanSetup({
  configured,
  settings,
  threshold,
  onSaved,
}: {
  configured: boolean;
  settings: Pick<PlanSettings, "expected_income" | "monthly_budget" | "savings_goal">;
  threshold: number;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(!configured);
  const [income, setIncome] = useState(configured ? String(settings.expected_income) : "");
  const [budget, setBudget] = useState(configured ? String(settings.monthly_budget) : "");
  const [goal, setGoal] = useState(configured ? String(settings.savings_goal) : "");
  const [investAt, setInvestAt] = useState(String(threshold));

  const mut = useMutation({
    mutationFn: () =>
      savePlanSettings({
        expected_income: Number(income) || 0,
        monthly_budget: Number(budget) || 0,
        savings_goal: Number(goal) || 0,
        invest_threshold: Number(investAt) || 1000,
      }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
      toast.success("Plan saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const overCommitted =
    Number(income || 0) > 0 && Number(income || 0) < Number(budget || 0) + Number(goal || 0);

  if (!editing) {
    return (
      <section className="rounded-xl border border-border/70 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Monthly plan</p>
          <button
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3" /> Edit
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
          {[
            ["Income", settings.expected_income],
            ["Budget", settings.monthly_budget],
            ["Save", settings.savings_goal],
          ].map(([label, val]) => (
            <div key={label as string} className="rounded-lg bg-muted/40 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </dt>
              <dd className="tnum mt-0.5 text-sm font-semibold">{formatINR(Number(val))}</dd>
            </div>
          ))}
        </dl>
        <p className="tnum mt-3 pt-3 border-t border-border/50 text-xs text-muted-foreground">
          Spare after budget &amp; goal:{" "}
          <span
            className={
              settings.expected_income - settings.monthly_budget - settings.savings_goal < 0
                ? "text-destructive font-medium"
                : "text-[color:var(--success)] font-medium"
            }
          >
            {formatINR(settings.expected_income - settings.monthly_budget - settings.savings_goal, {
              sign: true,
            })}
            /mo
          </span>{" "}
          · invest pool at {formatINR(threshold)}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {configured ? "Edit monthly plan" : "Set up your monthly plan"}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Expected income /mo</span>
          <input
            autoFocus={!configured}
            inputMode="decimal"
            value={income}
            onChange={(e) => setIncome(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            className={numInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Usual spending budget</span>
          <input
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            className={numInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Savings goal /mo</span>
          <input
            inputMode="decimal"
            value={goal}
            onChange={(e) => setGoal(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0"
            className={numInput}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Invest pool at</span>
          <input
            inputMode="decimal"
            value={investAt}
            onChange={(e) => setInvestAt(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="1000"
            className={numInput}
          />
        </label>
      </div>
      {overCommitted && (
        <p className="text-xs text-destructive">
          Budget + savings exceed income — purchases will rarely be affordable.
        </p>
      )}
      <button
        onClick={() => mut.mutate()}
        disabled={mut.isPending}
        className="w-full h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
      >
        {mut.isPending ? "Saving…" : configured ? "Save plan" : "Start planning"}
      </button>
    </section>
  );
}

const VERDICT_STYLES: Record<VerdictLevel, { text: string; dot: string; label: string }> = {
  safe: {
    text: "text-[color:var(--success)]",
    dot: "bg-[color:var(--success)]",
    label: "Safe",
  },
  tight: {
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-600 dark:bg-amber-400",
    label: "Tight",
  },
  later: { text: "text-primary", dot: "bg-primary", label: "Later" },
  no: { text: "text-destructive", dot: "bg-destructive", label: "Can't" },
};

function AffordChecker({
  assess,
  onAdded,
}: {
  assess: (price: number, necessity: Necessity) => Verdict;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  // Wants default — the stricter lens — so casual spends must be justified
  // against free cash rather than waved through on leftover budget.
  const [necessity, setNecessity] = useState<Necessity>("want");

  const n = Number(price) || 0;
  const verdict = n > 0 ? assess(n, necessity) : null;

  const addMut = useMutation({
    mutationFn: () => addPlanItem(name.trim(), n, necessity),
    onSuccess: () => {
      onAdded();
      setName("");
      setPrice("");
      toast.success("Added to wishlist");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border/70 p-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">Can I afford it?</p>
      <div className="mt-3 flex items-baseline justify-center gap-1">
        <span className="text-3xl text-muted-foreground/60 tnum">₹</span>
        <input
          autoFocus
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0"
          aria-label="Purchase price"
          className="tnum w-full max-w-[12ch] bg-transparent text-center text-4xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/30"
        />
      </div>

      <div className="mt-3 flex justify-center gap-1">
        {(
          [
            ["want", "Want", "judged against free cash"],
            ["need", "Need", "judged against budget room"],
          ] as const
        ).map(([value, label, title]) => (
          <button
            key={value}
            onClick={() => setNecessity(value)}
            title={title}
            className={`h-7 px-3.5 rounded-full text-xs border transition-colors ${
              necessity === value
                ? "bg-foreground text-background border-foreground"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && n > 0 && addMut.mutate()}
        placeholder="What is it? (optional)"
        aria-label="Purchase name"
        className="mt-3 w-full h-9 px-3 rounded-md bg-muted/50 border border-border text-sm text-center outline-none focus:border-primary transition-colors"
      />

      {verdict && (
        <div className="mt-4 rounded-lg border border-border/70 bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <span
              className={`size-2 shrink-0 rounded-full ${VERDICT_STYLES[verdict.level].dot}`}
              aria-hidden="true"
            />
            <p className={`text-sm font-semibold ${VERDICT_STYLES[verdict.level].text}`}>
              {verdict.headline}
            </p>
          </div>
          <ul className="tnum mt-2 space-y-1">
            {verdict.details.map((d) => (
              <li key={d} className="text-xs text-muted-foreground">
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={() => addMut.mutate()}
        disabled={!name.trim() || n <= 0 || addMut.isPending}
        className="mt-3 w-full h-10 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/40 disabled:opacity-50 disabled:pointer-events-none transition-colors"
      >
        {addMut.isPending ? "Adding…" : "Add to wishlist"}
      </button>
    </section>
  );
}

function WishlistSection({
  items,
  assess,
  onChanged,
}: {
  items: PlanItem[];
  assess: (price: number, necessity: Necessity) => Verdict;
  onChanged: () => void;
}) {
  const pending = items.filter((i) => i.status === "pending");
  const decided = items.filter((i) => i.status !== "pending");

  const delMut = useMutation({ mutationFn: deletePlanItem });

  async function skip(item: PlanItem) {
    const v = assess(Number(item.price), item.necessity);
    const affordable = v.level === "safe" || v.level === "tight";
    await decidePlanItem(item.id, "skipped");
    if (affordable) {
      // The definition of the pool: affordable-but-not-bought money.
      await addPoolEvent(Number(item.price), "skip", item.name);
      toast.success(`${formatINR(Number(item.price))} moved to your pool`);
    } else {
      toast("Dismissed — wasn't affordable anyway");
    }
    onChanged();
  }

  async function bought(item: PlanItem) {
    await decidePlanItem(item.id, "bought");
    toast.success("Marked bought — log it in Journal if you haven't");
    onChanged();
  }

  function remove(item: PlanItem) {
    delMut.mutate(item.id, { onSuccess: onChanged });
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-muted-foreground">Wishlist</h3>
        {decided.length > 0 && (
          <span className="text-[11px] text-muted-foreground tnum">
            {decided.filter((i) => i.status === "bought").length} bought ·{" "}
            {decided.filter((i) => i.status === "skipped").length} skipped
          </span>
        )}
      </div>

      {pending.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          Nothing planned yet — check a price above and save it here.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/70 px-4">
          {pending.map((item) => {
            const v = assess(Number(item.price), item.necessity);
            const style = VERDICT_STYLES[v.level];
            const affordable = v.level === "safe" || v.level === "tight";
            return (
              <li key={item.id} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm truncate">
                    {item.name}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground/70 align-middle">
                      {item.necessity}
                    </span>
                  </span>
                  <span className="tnum text-sm font-medium shrink-0">
                    {formatINR(Number(item.price))}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className={`text-[11px] ${style.text}`}>{v.headline}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => bought(item)}
                      className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] text-muted-foreground hover:text-[color:var(--success)] hover:bg-muted/60 transition-colors"
                    >
                      <Check className="size-3" /> Bought
                    </button>
                    <button
                      onClick={() => skip(item)}
                      title={
                        affordable
                          ? `Move ${formatINR(Number(item.price))} to your pool`
                          : "Dismiss without adding to the pool"
                      }
                      className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] transition-colors ${
                        affordable
                          ? "text-[color:var(--success)] hover:bg-[color:var(--success)]/10"
                          : "text-muted-foreground hover:bg-muted/60"
                      }`}
                    >
                      <PiggyBank className="size-3" />
                      {affordable ? "Skip & save" : "Skip"}
                    </button>
                    <button
                      onClick={() => remove(item)}
                      aria-label={`Remove ${item.name}`}
                      className="h-7 w-7 grid place-items-center rounded-md text-muted-foreground/60 hover:text-destructive transition-colors"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PoolSection({
  events,
  threshold,
  onChanged,
}: {
  events: PlanPoolEvent[];
  threshold: number;
  onChanged: () => void;
}) {
  const [manualMode, setManualMode] = useState<"add" | "withdraw" | null>(null);
  const [amount, setAmount] = useState("");

  const balance = poolBalance(events);
  const pct = Math.min(100, (balance / threshold) * 100);
  const ready = balance >= threshold;
  const { total: investedTotal, rounds } = investedFromPlan(events);

  const eventMut = useMutation({
    mutationFn: (args: { amount: number; kind: "manual" | "withdraw" }) =>
      addPoolEvent(args.amount, args.kind),
    onSuccess: (_d, vars) => {
      onChanged();
      setManualMode(null);
      setAmount("");
      toast.success(
        vars.kind === "manual"
          ? `${formatINR(vars.amount)} added to pool`
          : `${formatINR(-vars.amount)} taken out`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const investMut = useMutation({
    mutationFn: () => addPoolEvent(-threshold, "invest"),
    onSuccess: () => {
      onChanged();
      toast.success(`${formatINR(threshold)} marked invested`, {
        description: "Log the real transfer under Journal → Invest",
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const KIND_META: Record<string, { label: string; icon: typeof PiggyBank }> = {
    skip: { label: "Skipped purchase", icon: PiggyBank },
    manual: { label: "Manual top-up", icon: ArrowDownToLine },
    withdraw: { label: "Taken out", icon: ArrowUpFromLine },
    invest: { label: "Invested", icon: TrendingUp },
  };

  return (
    <section className="rounded-xl border border-border/70 p-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Skipped-spending pool
      </p>
      <p
        className={`tnum mt-2 text-3xl font-semibold ${ready ? "text-[color:var(--success)]" : ""}`}
      >
        {formatINR(Math.max(0, balance))}
      </p>

      <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${ready ? "bg-[color:var(--success)]" : "bg-primary"}`}
          style={{ width: `${Math.max(balance > 0 ? 2 : 0, pct)}%` }}
        />
      </div>
      <p className="tnum mt-1.5 text-xs text-muted-foreground">
        {ready
          ? `Ready — ${formatINR(threshold)} can be invested`
          : `${formatINR(Math.max(0, threshold - balance))} to go until it auto-suggests investing`}
      </p>

      <button
        onClick={() => investMut.mutate()}
        disabled={!ready || investMut.isPending}
        className={`mt-3 w-full h-10 rounded-lg text-sm font-medium transition-all ${
          ready
            ? "bg-primary text-primary-foreground hover:opacity-90 active:scale-[0.99]"
            : "border border-border text-muted-foreground opacity-60 cursor-default"
        }`}
      >
        {investMut.isPending
          ? "Investing…"
          : ready
            ? `Invest ${formatINR(threshold)}`
            : `Invest at ${formatINR(threshold)}`}
      </button>

      <div className="mt-3 pt-3 border-t border-border/50">
        {manualMode === null ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setManualMode("add")}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            >
              <ArrowDownToLine className="size-3" /> Add unspent
            </button>
            <button
              onClick={() => setManualMode("withdraw")}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-xs border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            >
              <ArrowUpFromLine className="size-3" /> Take out
            </button>
            {rounds > 0 && (
              <span className="ml-auto text-[11px] text-muted-foreground tnum">
                {formatINR(investedTotal)} invested · {rounds} round{rounds === 1 ? "" : "s"}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Escape") setManualMode(null);
                if (e.key === "Enter") submitManual();
              }}
              placeholder="Amount"
              aria-label="Amount"
              className={`${numInput} flex-1 text-left`}
            />
            <button
              onClick={submitManual}
              disabled={eventMut.isPending}
              className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
            >
              Done
            </button>
            <button
              onClick={() => setManualMode(null)}
              aria-label="Cancel"
              className="h-9 w-9 grid place-items-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
      </div>

      {events.length > 0 && (
        <ul className="mt-3 divide-y divide-border/50">
          {events.slice(0, 5).map((e) => {
            const meta = KIND_META[e.kind];
            const Icon = meta.icon;
            const negative = Number(e.amount) < 0;
            return (
              <li key={e.id} className="flex items-center gap-2 py-2 text-xs">
                <Icon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <span className="truncate text-muted-foreground">
                  {meta.label}
                  {e.note ? ` · ${e.note}` : ""}
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground/70 tnum">
                  {new Date(e.created_at).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                  })}
                </span>
                <span
                  className={`tnum shrink-0 font-medium ${negative ? "" : "text-[color:var(--success)]"}`}
                >
                  {negative ? "−" : "+"}
                  {formatINR(Math.abs(Number(e.amount)))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  function submitManual() {
    const n = Number(amount) || 0;
    if (n <= 0) return toast.error("Enter an amount");
    if (manualMode === "withdraw" && n > balance)
      return toast.error(`Pool only has ${formatINR(balance)}`);
    if (manualMode === null) return;
    eventMut.mutate({
      amount: manualMode === "add" ? n : -n,
      kind: manualMode === "add" ? "manual" : "withdraw",
    });
  }
}
