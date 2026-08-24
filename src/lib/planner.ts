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
// Affordability verdict (v2 — goal-first)
//
// Objective: protect the savings goal, then judge a purchase by what it
// actually costs *the plan*, not by whether leftover budget can absorb it.
//
//   Hard gate (both kinds): free cash now = income − spent − savingsGoal.
//   Past that line you're into "wait N months" or "not with this plan".
//
//   Need  — essentials compete for budget room: fits remaining budget → fine;
//           above it → tight (dips into surplus).
//   Want  — discretionary cash is scarce by definition, so a want is judged
//           by its share of the plan's monthly free cash (expectedIncome −
//           budget − goal). A want burning a big slice gets paused even when
//           it "fits" — a ₹1000 croissant against ₹5000 of real slack should
//           never read as "no problem".
// Actuals (salary/expenses already logged this month) take priority over the
// stated expectations when they exist — the plan bends to reality.

export type VerdictLevel = "safe" | "tight" | "later" | "no";

export type Verdict = {
  level: VerdictLevel;
  headline: string;
  details: string[];
  monthsAway?: number;
};

// A want consuming more than this share of monthly free cash gets flagged.
const WANT_FREE_CASH_SHARE = 0.15;

export type AffordInput = {
  price: number;
  settings: Pick<PlanSettings, "expected_income" | "monthly_budget" | "savings_goal">;
  necessity: Necessity;
  spentThisMonth: number;
  incomeThisMonth: number;
  isCurrentMonth: boolean;
  daysLeftInMonth: number;
};

export function assessPurchase(input: AffordInput): Verdict {
  const { price, settings, necessity, spentThisMonth, incomeThisMonth, isCurrentMonth } = input;

  const income = isCurrentMonth && incomeThisMonth > 0 ? incomeThisMonth : settings.expected_income;
  const remainingBudget = Math.max(0, settings.monthly_budget - spentThisMonth);
  // Planned free cash per month after executing the whole plan.
  const spare = settings.expected_income - settings.monthly_budget - settings.savings_goal;
  // Free cash right now without breaking this month's savings promise.
  const freeNow = Math.max(0, income - spentThisMonth - settings.savings_goal);
  const daysLeft = Math.max(1, input.daysLeftInMonth);

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

  if (price > freeNow) {
    if (spare > 0) {
      const monthsAway = Math.max(1, Math.ceil((price - freeNow) / spare));
      const eta = new Date();
      eta.setMonth(eta.getMonth() + monthsAway);
      return {
        level: "later",
        headline:
          monthsAway === 1
            ? `Affordable next month (~${formatINR(spare)}/mo spare)`
            : `Affordable in ~${monthsAway} months`,
        details: [
          `Short ${formatINR(price - freeNow)} today without touching your goal`,
          `${formatINR(spare)}/mo planned surplus → around ${eta.toLocaleString("en-IN", { month: "long", year: "numeric" })}`,
          "Or buy now and accept missing this month's goal",
        ],
        monthsAway,
      };
    }
    return {
      level: "no",
      headline: "Not with this plan",
      details: [
        spare === 0
          ? "Your plan leaves no surplus — income covers budget + goal exactly"
          : "Your plan overspends: budget + goal exceed income",
        `Only ${formatINR(freeNow)} of goal-safe cash is left this month`,
      ],
    };
  }

  // Past this point the purchase keeps the savings goal intact — the only
  // question is how much of the plan's breathing room it consumes.
  if (necessity === "need") {
    if (price <= remainingBudget) {
      const perDay = (remainingBudget - price) / daysLeft;
      return {
        level: "safe",
        headline: "Safe to buy",
        details: [
          `Fits inside ${formatINR(remainingBudget)} of unused budget`,
          `${formatINR(perDay)}/day left after this, for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}`,
          `Savings goal of ${formatINR(settings.savings_goal)} stays intact`,
        ],
      };
    }
    return tightAboveBudget({ price, remainingBudget, settings, freeNow });
  }

  // --- want ---
  if (spare <= 0) {
    return {
      level: "tight",
      headline: "Worth pausing on",
      details: [
        "Your plan has no free cash — every want eats next month's slack",
        `Buying leaves ${formatINR(Math.max(0, freeNow - price))} of goal-safe cash`,
        "Widen the gap (lower budget or higher income) before wants fit easily",
      ],
    };
  }

  const sharePct = Math.round((price / spare) * 100);

  if (price > remainingBudget) {
    const base = tightAboveBudget({ price, remainingBudget, settings, freeNow });
    return {
      ...base,
      details: [`Uses ${sharePct}% of your ${formatINR(spare)}/mo free cash`, ...base.details],
    };
  }

  if (sharePct > WANT_FREE_CASH_SHARE * 100) {
    return {
      level: "tight",
      headline: `Worth pausing on — ${sharePct}% of free cash`,
      details: [
        `${formatINR(price)} burns ${sharePct}% of your ${formatINR(spare)}/mo free cash`,
        `After buying: ${formatINR(freeNow - price)} left before the goal is at risk`,
        "Skip it and the full amount lands in your invest pool instead",
      ],
    };
  }

  const perDay = (remainingBudget - price) / daysLeft;
  return {
    level: "safe",
    headline: "Fine — small next to your plan",
    details: [
      `Only ${sharePct}% of your ${formatINR(spare)}/mo free cash`,
      `${formatINR(perDay)}/day of budget left for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}`,
    ],
  };
}

function tightAboveBudget(args: {
  price: number;
  remainingBudget: number;
  settings: Pick<PlanSettings, "monthly_budget" | "savings_goal">;
  freeNow: number;
}): Verdict {
  const { price, remainingBudget, settings, freeNow } = args;
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
