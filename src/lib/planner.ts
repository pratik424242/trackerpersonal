import { supabase } from "@/integrations/supabase/client";
import { queryOptions } from "@tanstack/react-query";
import { formatINR } from "@/lib/finance";

// Plan mode is a food-decision layer on top of the ledger: it never moves
// account balances. Settings are a single row (id pinned to true); craving
// items are intentions, not transactions; the pool is an append-only event
// log so its balance is always derivable and every skip/withdraw/invest
// stays auditable. Scope is deliberately narrow — food choices, nothing
// else — mirroring the daily-discipline idea behind the Insights food card,
// which reads the same setting.

export type PlanSettings = {
  id: boolean;
  expected_income: number;
  monthly_budget: number;
  savings_goal: number;
  invest_threshold: number;
  food_daily_budget: number;
  updated_at: string;
};

export type PlanItemStatus = "pending" | "bought" | "skipped";

export type Necessity = "need" | "want";

export type PlanItem = {
  id: string;
  name: string;
  price: number;
  status: PlanItemStatus;
  necessity: Necessity;
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
  food_daily_budget: 300,
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

export async function savePlanSettings(s: { food_daily_budget: number; invest_threshold: number }) {
  const { error } = await supabase
    .from("plan_settings")
    .upsert({ id: true, ...s, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

export async function addPlanItem(name: string, price: number, necessity: Necessity) {
  const { data, error } = await supabase
    .from("plan_items")
    .insert({ name, price, necessity })
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
// Food spend aggregation

export const FOOD_CATEGORIES = ["Outside Food", "Office Food"];

export function foodCategoryIds(
  categories: ReadonlyArray<{ id: string; name: string }>,
): Set<string> {
  return new Set(categories.filter((c) => FOOD_CATEGORIES.includes(c.name)).map((c) => c.id));
}

// Sums food expenses over all time (or just one day when `day` is given).
export function sumFoodSpend(
  txns: ReadonlyArray<{
    kind: string;
    category_id: string | null;
    amount: number | string;
    occurred_at: string;
  }>,
  ids: Set<string>,
  day?: Date,
): number {
  let total = 0;
  for (const t of txns) {
    if (t.kind !== "expense" || !t.category_id || !ids.has(t.category_id)) continue;
    if (day && new Date(t.occurred_at).toDateString() !== day.toDateString()) continue;
    total += Number(t.amount);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Food affordability verdict
//
// Objective: keep daily eating discipline intact and catch cravings before
// they compound into an off-the-rails month.
//
//   Fits today's allowance (dailyBudget − spentToday)?
//     ├─ yes → is the month still on pace (≤ budget × days elapsed)?
//     │        ├─ yes → fine (wants) / safe (needs)
//     │        └─ no  → tight: month already running hot
//     └─ no  → does the month's ceiling still absorb it?
//              ├─ yes → tight: borrowing from the rest of the month
//              └─ no  → the food budget is exhausted
//
// Wants are judged strictly (any overshoot or hot pace pauses them with a
// skip-&-save nudge); needs get the honest numbers without guilt — you have
// to eat.

export type VerdictLevel = "safe" | "tight" | "later" | "no";

export type Verdict = {
  level: VerdictLevel;
  headline: string;
  details: string[];
};

export type FoodAffordInput = {
  price: number;
  necessity: Necessity;
  dailyBudget: number;
  spentToday: number;
  monthSpent: number;
  daysElapsed: number; // includes today
  daysInMonth: number;
};

export function assessFoodPurchase(input: FoodAffordInput): Verdict {
  const { price, necessity, dailyBudget: D, spentToday: T, monthSpent: M } = input;
  const daysElapsed = Math.max(1, input.daysElapsed);
  const daysLeft = Math.max(0, input.daysInMonth - daysElapsed);
  const todayLeft = Math.max(0, D - T);
  const overToday = price - todayLeft;
  const paceTarget = D * daysElapsed;
  const overPace = M + price - paceTarget;
  const monthCeiling = D * input.daysInMonth;
  const monthAfter = monthCeiling - (M + price);

  if (price <= todayLeft) {
    if (overPace <= 0) {
      return {
        level: "safe",
        headline:
          necessity === "want" ? "Fine — small next to your budget" : "Fits today's food budget",
        details: [
          `${formatINR(todayLeft - price)} of today's ${formatINR(D)} left after this`,
          `Month on pace: ${formatINR(M + price)} of ${formatINR(paceTarget)} through day ${daysElapsed}`,
        ],
      };
    }
    return {
      level: "tight",
      headline: "Fits today, but the month is running hot",
      details: [
        `This puts you ${formatINR(overPace)} past the month's pace (${formatINR(D)}/day)`,
        daysLeft > 0
          ? `${formatINR(monthCeiling - M - price)} of food money left for ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
          : "Last day of the month",
        necessity === "want"
          ? "A want on top of a hot month is exactly what the pause is for"
          : "If you have to eat, keep it lean",
      ],
    };
  }

  if (monthAfter >= 0) {
    return {
      level: "tight",
      headline:
        necessity === "want"
          ? `Worth pausing — ${formatINR(overToday)} over today's budget`
          : `Over today's budget by ${formatINR(overToday)}`,
      details: [
        `Only ${formatINR(todayLeft)} of today's ${formatINR(D)} was left`,
        `Borrows from other days — ${formatINR(monthCeiling - M - price)} of food money remains for ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        ...(necessity === "want"
          ? ["Skip it and the full amount lands in your invest pool instead"]
          : []),
      ],
    };
  }

  return {
    level: necessity === "want" ? "no" : "tight",
    headline: necessity === "want" ? "Off the plan" : "Month's food budget exhausted",
    details: [
      `${formatINR(Math.abs(monthAfter))} past the ${formatINR(monthCeiling)} monthly food ceiling`,
      "Nothing left to borrow from later days",
      necessity === "want"
        ? "Skip it and bank the full amount in your pool"
        : "If you must eat, cook something cheap at home",
    ],
  };
}
