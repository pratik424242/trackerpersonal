import { supabase } from "@/integrations/supabase/client";
import { queryOptions } from "@tanstack/react-query";
import { formatINR } from "@/lib/finance";

// Plan mode is a virtual layer on top of the ledger: it never moves account
// balances. Settings are a single row (id is pinned to true); wishlist items
// are intentions, not transactions; the pool is an append-only event log so
// its balance is always derivable and every skip/withdraw/invest stays
// auditable.

export type PlanSettings = {
  id: boolean;
  expected_income: number;
  monthly_budget: number;
  savings_goal: number;
  invest_threshold: number;
  updated_at: string;
};

export type PlanItemStatus = "pending" | "bought" | "skipped";

export type PlanItem = {
  id: string;
  name: string;
  price: number;
  status: PlanItemStatus;
  note: string | null;
  created_at: string;
  decided_at: string | null;
};

export type PlanPoolEventKind = "skip" | "manual" | "withdraw" | "invest";

export type PlanPoolEvent = {
  id: string;
  amount: number;
  kind: PlanPoolEventKind;
  note: string | null;
  created_at: string;
};

export const DEFAULT_PLAN_SETTINGS: Omit<PlanSettings, "updated_at"> = {
  id: true,
  expected_income: 0,
  monthly_budget: 0,
  savings_goal: 0,
  invest_threshold: 1000,
};

export const planSettingsQuery = queryOptions({
  queryKey: ["plan_settings"],
  queryFn: async (): Promise<PlanSettings | null> => {
    const { data, error } = await supabase
      .from("plan_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as PlanSettings | null;
  },
});

export const planItemsQuery = queryOptions({
  queryKey: ["plan_items"],
  queryFn: async (): Promise<PlanItem[]> => {
    const { data, error } = await supabase
      .from("plan_items")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as PlanItem[];
  },
});

export const planPoolEventsQuery = queryOptions({
  queryKey: ["plan_pool_events"],
  queryFn: async (): Promise<PlanPoolEvent[]> => {
    const { data, error } = await supabase
      .from("plan_pool_events")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as PlanPoolEvent[];
  },
});

export async function savePlanSettings(s: {
  expected_income: number;
  monthly_budget: number;
  savings_goal: number;
  invest_threshold: number;
}) {
  const { error } = await supabase
    .from("plan_settings")
    .upsert({ id: true, ...s, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

export async function addPlanItem(name: string, price: number) {
  const { data, error } = await supabase
    .from("plan_items")
    .insert({ name, price })
    .select()
    .single();
  if (error) throw error;
  return data as PlanItem;
}

export async function decidePlanItem(id: string, status: Exclude<PlanItemStatus, "pending">) {
  const { error } = await supabase
    .from("plan_items")
    .update({ status, decided_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deletePlanItem(id: string) {
  const { error } = await supabase.from("plan_items").delete().eq("id", id);
  if (error) throw error;
}

export async function addPoolEvent(amount: number, kind: PlanPoolEventKind, note?: string | null) {
  const { error } = await supabase
    .from("plan_pool_events")
    .insert({ amount, kind, note: note ?? null });
  if (error) throw error;
}

export function poolBalance(events: ReadonlyArray<{ amount: number | string }>): number {
  return events.reduce((s, e) => s + Number(e.amount), 0);
}

export function investedFromPlan(events: readonly PlanPoolEvent[]): {
  total: number;
  rounds: number;
} {
  let total = 0;
  let rounds = 0;
  for (const e of events) {
    if (e.kind === "invest") {
      total += Math.abs(Number(e.amount));
      rounds++;
    }
  }
  return { total, rounds };
}

// ---------------------------------------------------------------------------
// Affordability verdict
//
// Three lenses over one purchase, checked in order:
//   Budget lens   — does it fit inside this month's untouched budget?
//   Surplus lens  — even if above budget, can it absorb into the free cash
//                   left after this month's spending while the savings goal
//                   still holds?
//   Horizon lens  — otherwise, how many months of planned surplus until it's
//                   affordable?
// Actuals (salary/expenses already logged this month) take priority over the
// stated expectations when they exist — the plan bends to reality.

export type VerdictLevel = "safe" | "tight" | "later" | "no";

export type Verdict = {
  level: VerdictLevel;
  headline: string;
  details: string[];
  monthsAway?: number;
};

export type AffordInput = {
  price: number;
  settings: Pick<PlanSettings, "expected_income" | "monthly_budget" | "savings_goal">;
  spentThisMonth: number;
  incomeThisMonth: number;
  isCurrentMonth: boolean;
  daysLeftInMonth: number;
};

export function assessPurchase(input: AffordInput): Verdict {
  const { price, settings, spentThisMonth, incomeThisMonth, isCurrentMonth } = input;

  const income = isCurrentMonth && incomeThisMonth > 0 ? incomeThisMonth : settings.expected_income;
  const remainingBudget = Math.max(0, settings.monthly_budget - spentThisMonth);
  const plannedSurplus = settings.expected_income - settings.monthly_budget - settings.savings_goal;
  // Free cash right now without breaking this month's savings promise.
  const freeNow = Math.max(0, income - spentThisMonth - settings.savings_goal);

  if (price > income && income > 0) {
    return {
      level: "no",
      headline: "Beyond a month's income",
      details: [
        `Costs ${formatINR(price)} vs ${formatINR(income)} monthly income`,
        "Only realistic as a loan, or a longer-horizon goal",
      ],
    };
  }

  if (price <= remainingBudget) {
    const perDay =
      input.daysLeftInMonth > 0 ? (remainingBudget - price) / input.daysLeftInMonth : 0;
    const details = [
      `Fits inside ${formatINR(remainingBudget)} of unused budget`,
      `Savings goal of ${formatINR(settings.savings_goal)} stays intact`,
    ];
    if (isCurrentMonth && remainingBudget - price >= 0) {
      details.push(`${formatINR(perDay)}/day left for the rest of the month`);
    }
    return { level: "safe", headline: "Safe to buy", details };
  }

  if (price <= freeNow) {
    return {
      level: "tight",
      headline: "Doable, but tight",
      details: [
        `Above your usual ${formatINR(settings.monthly_budget)} budget by ${formatINR(price - remainingBudget)}`,
        `Dips into surplus — savings goal of ${formatINR(settings.savings_goal)} still holds`,
        `Leaves ${formatINR(freeNow - price)} of free cash this month`,
      ],
    };
  }

  if (plannedSurplus > 0) {
    const shortfall = Math.max(0, price - freeNow);
    const monthsAway = Math.max(1, Math.ceil(shortfall / plannedSurplus));
    const eta = new Date();
    eta.setMonth(eta.getMonth() + monthsAway);
    return {
      level: "later",
      headline:
        monthsAway === 1
          ? `Affordable next month (~${formatINR(plannedSurplus)}/mo spare)`
          : `Affordable in ~${monthsAway} months`,
      details: [
        `Short ${formatINR(shortfall)} today without touching your goal`,
        `${formatINR(plannedSurplus)}/mo planned surplus → around ${eta.toLocaleString("en-IN", { month: "long", year: "numeric" })}`,
        "Or buy now and accept missing this month's goal",
      ],
      monthsAway,
    };
  }

  return {
    level: "no",
    headline: "Not with this plan",
    details: [
      plannedSurplus === 0
        ? "Your plan leaves no surplus — income covers budget + goal exactly"
        : "Your plan overspends: budget + goal exceed income",
      "Lower the budget/goal, or wait for higher income",
    ],
  };
}
