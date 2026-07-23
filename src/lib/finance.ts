import { supabase } from "@/integrations/supabase/client";
import { queryOptions } from "@tanstack/react-query";

export type Account = {
  id: string;
  name: string;
  kind: "bank" | "credit_card";
  balance: number;
  sort_order: number;
};

export type Category = {
  id: string;
  name: string;
  is_custom: boolean;
};

export type Transaction = {
  id: string;
  amount: number;
  kind: "expense" | "salary" | "card_payment";
  account_id: string;
  category_id: string | null;
  linked_account_id: string | null;
  note: string | null;
  occurred_at: string;
  created_at: string;
};

export type SpendingLimit = {
  id: string;
  category_id: string;
  monthly_limit: number;
};

export const accountsQuery = queryOptions({
  queryKey: ["accounts"],
  queryFn: async (): Promise<Account[]> => {
    const { data, error } = await supabase
      .from("accounts")
      .select("*")
      .order("sort_order");
    if (error) throw error;
    return (data ?? []) as Account[];
  },
});

export const categoriesQuery = queryOptions({
  queryKey: ["categories"],
  queryFn: async (): Promise<Category[]> => {
    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .order("is_custom")
      .order("name");
    if (error) throw error;
    return (data ?? []) as Category[];
  },
});

export const transactionsQuery = queryOptions({
  queryKey: ["transactions"],
  queryFn: async (): Promise<Transaction[]> => {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return (data ?? []) as Transaction[];
  },
});

// Range-scoped query for a single calendar month, independent of the
// `transactionsQuery` 200-row cap so browsing older months stays accurate.
export function monthTransactionsQuery(monthStart: Date) {
  const start = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
  const end = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  return queryOptions({
    queryKey: ["transactions", "range", start.toISOString()],
    queryFn: async (): Promise<Transaction[]> => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .gte("occurred_at", start.toISOString())
        .lt("occurred_at", end.toISOString())
        .order("occurred_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Transaction[];
    },
  });
}

export const spendingLimitsQuery = queryOptions({
  queryKey: ["spending_limits"],
  queryFn: async (): Promise<SpendingLimit[]> => {
    const { data, error } = await supabase.from("spending_limits").select("*");
    if (error) throw error;
    return (data ?? []) as SpendingLimit[];
  },
});

// Combines a `YYYY-MM-DD` date-input value with a time-of-day (defaults to
// now) into an ISO timestamp, so backdated entries still sort sensibly.
export function dateInputToISO(dateStr: string, timeSource: Date = new Date()): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(timeSource);
  dt.setFullYear(y, m - 1, d);
  return dt.toISOString();
}

export function isoToDateInput(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatINR(n: number, opts: { sign?: boolean } = {}) {
  const abs = Math.abs(n);
  const formatted = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(abs);
  const sign = opts.sign ? (n < 0 ? "-" : "+") : n < 0 ? "-" : "";
  return `${sign}₹${formatted}`;
}

export async function applyTransaction(args: {
  amount: number;
  kind: "expense" | "salary" | "card_payment";
  account_id: string;
  category_id?: string | null;
  linked_account_id?: string | null;
  note?: string | null;
  occurred_at?: string;
}) {
  const { error } = await supabase.rpc("apply_transaction", {
    p_amount: args.amount,
    p_kind: args.kind,
    p_account_id: args.account_id,
    p_category_id: (args.category_id ?? null) as unknown as string,
    p_linked_account_id: (args.linked_account_id ?? null) as unknown as string,
    p_note: (args.note ?? null) as unknown as string,
    p_occurred_at: args.occurred_at ?? new Date().toISOString(),
  });
  if (error) throw error;
}

export async function deleteTransaction(id: string) {
  const { error } = await supabase.rpc("delete_transaction", { p_txn_id: id });
  if (error) throw error;
}

// Restores a transaction that was just deleted (used for the delete/undo toast).
// Re-applies the same effect as a new row rather than reviving the original id.
export async function restoreTransaction(t: Transaction) {
  await applyTransaction({
    amount: Number(t.amount),
    kind: t.kind,
    account_id: t.account_id,
    category_id: t.category_id,
    linked_account_id: t.linked_account_id,
    note: t.note,
    occurred_at: t.occurred_at,
  });
}

// Edits an expense in place: reverses the original's balance effect, then
// re-applies the new values. Not atomic (two RPC calls), which is an
// acceptable tradeoff for a single-user app with no concurrent writers.
export async function editExpense(
  original: Transaction,
  updates: { amount: number; category_id: string | null; account_id: string; note: string | null; occurred_at: string },
) {
  await deleteTransaction(original.id);
  await applyTransaction({
    amount: updates.amount,
    kind: "expense",
    account_id: updates.account_id,
    category_id: updates.category_id,
    note: updates.note,
    occurred_at: updates.occurred_at,
  });
}

export async function addCategory(name: string) {
  const { data, error } = await supabase
    .from("categories")
    .insert({ name, is_custom: true })
    .select()
    .single();
  if (error) throw error;
  return data as Category;
}

export async function deleteCategory(id: string) {
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw error;
}


export async function setAccountBalance(id: string, balance: number) {
  const { error } = await supabase
    .from("accounts")
    .update({ balance })
    .eq("id", id);
  if (error) throw error;
}

export async function upsertLimit(category_id: string, monthly_limit: number) {
  const { error } = await supabase
    .from("spending_limits")
    .upsert({ category_id, monthly_limit }, { onConflict: "category_id" });
  if (error) throw error;
}
