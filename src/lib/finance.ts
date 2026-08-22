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

export type TransactionKind = "expense" | "salary" | "card_payment" | "lent" | "repayment";

// Settlement kinds: money moved on behalf of another person. Neither is
// personal spending nor income, so analytics must exclude both.
export const SETTLEMENT_KINDS: readonly TransactionKind[] = ["lent", "repayment"];
export const isSettlement = (kind: string): kind is TransactionKind =>
  kind === "lent" || kind === "repayment";

export type Transaction = {
  id: string;
  amount: number;
  kind: TransactionKind;
  account_id: string;
  category_id: string | null;
  linked_account_id: string | null;
  note: string | null;
  person: string | null;
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
    const { data, error } = await supabase.from("accounts").select("*").order("sort_order");
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

// All-time settlement entries (lent/repayment), independent of month windows
// and the recent-200 cap — computing who still owes what needs the complete
// history. Settlements are rare relative to expenses, so this stays small.
export const receivablesQuery = queryOptions({
  queryKey: ["transactions", "receivables"],
  queryFn: async (): Promise<Transaction[]> => {
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .in("kind", ["lent", "repayment"])
      .order("occurred_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as Transaction[];
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
  kind: TransactionKind;
  account_id: string;
  category_id?: string | null;
  linked_account_id?: string | null;
  note?: string | null;
  person?: string | null;
  occurred_at?: string;
}) {
  const { error } = await supabase.rpc("apply_transaction", {
    p_amount: args.amount,
    p_kind: args.kind,
    p_account_id: args.account_id,
    p_category_id: (args.category_id ?? null) as unknown as string,
    p_linked_account_id: (args.linked_account_id ?? null) as unknown as string,
    p_note: (args.note ?? null) as unknown as string,
    p_person: (args.person ?? null) as unknown as string,
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
    person: t.person,
    occurred_at: t.occurred_at,
  });
}

// Edits a transaction in place: reverses the original's balance effect,
// then re-applies the new values. `kind` may be overridden to convert
// between kinds (e.g. an expense that was actually lent to someone, or an
// auto-imported credit that was actually a repayment). Not atomic (two RPC
// calls), which is an acceptable tradeoff for a single-user app with no
// concurrent writers.
export async function editTransaction(
  original: Transaction,
  updates: {
    amount: number;
    kind?: TransactionKind;
    category_id: string | null;
    account_id: string;
    linked_account_id: string | null;
    note: string | null;
    person?: string | null;
    occurred_at: string;
  },
) {
  await deleteTransaction(original.id);
  await applyTransaction({
    amount: updates.amount,
    kind: updates.kind ?? original.kind,
    account_id: updates.account_id,
    category_id: updates.category_id,
    linked_account_id: updates.linked_account_id,
    note: updates.note,
    person: updates.person ?? null,
    occurred_at: updates.occurred_at,
  });
}

// Settles two entries on the same account against each other — e.g. a
// salary credit that was actually a correction of an earlier expense —
// collapsing them into a single entry for the difference instead of leaving
// both sitting in the ledger forever. Deletes both originals and, unless
// they cancel out exactly, applies one new entry for the net amount under
// the resulting sign's kind. card_payment is excluded: it already touches
// two accounts at once. Settlements (lent/repayment) are excluded too:
// they're already neutral pairs with their own receivable history, and
// collapsing them would erase who-owes-what.
export async function netTransactions(
  a: Transaction,
  b: Transaction,
  opts: { category_id: string | null; note: string | null },
) {
  if (a.account_id !== b.account_id) {
    throw new Error("Can only net two entries on the same account");
  }
  if (
    a.kind === "card_payment" ||
    b.kind === "card_payment" ||
    isSettlement(a.kind) ||
    isSettlement(b.kind)
  ) {
    throw new Error("Card payments and settlements can't be netted");
  }

  const signed = (t: Transaction) => (t.kind === "salary" ? Number(t.amount) : -Number(t.amount));
  const net = signed(a) + signed(b);

  await deleteTransaction(a.id);
  await deleteTransaction(b.id);

  if (Math.abs(net) < 0.005) return; // cancels out exactly — nothing left to record

  await applyTransaction({
    amount: Math.abs(net),
    kind: net > 0 ? "salary" : "expense",
    account_id: a.account_id,
    category_id: opts.category_id,
    note: opts.note,
    occurred_at: new Date().toISOString(),
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
  const { error } = await supabase.from("accounts").update({ balance }).eq("id", id);
  if (error) throw error;
}

export async function upsertLimit(category_id: string, monthly_limit: number) {
  const { error } = await supabase
    .from("spending_limits")
    .upsert({ category_id, monthly_limit }, { onConflict: "category_id" });
  if (error) throw error;
}

export type Receivable = {
  person: string;
  lent: number;
  repaid: number;
  outstanding: number; // > 0 → they still owe this much
};

// Groups settlement entries into per-person totals. Person names are free
// text, so grouping is case- and whitespace-insensitive while keeping the
// most recent spelling for display.
export function receivablesByPerson(
  settlements: ReadonlyArray<{ kind: string; amount: number | string; person: string | null }>,
): Receivable[] {
  const map = new Map<string, Receivable>();
  for (const t of settlements) {
    if (!isSettlement(t.kind) || !t.person) continue;
    const key = t.person.trim().replace(/\s+/g, " ").toLowerCase();
    let r = map.get(key);
    if (!r) {
      r = { person: t.person.trim(), lent: 0, repaid: 0, outstanding: 0 };
      map.set(key, r);
    }
    if (t.kind === "lent") r.lent += Number(t.amount);
    else r.repaid += Number(t.amount);
    r.outstanding = r.lent - r.repaid;
  }
  // Most owed first; fully-settled people sink to the bottom.
  return [...map.values()].sort((a, b) => b.outstanding - a.outstanding || b.lent - a.lent);
}

// Distinct person names ever used in settlements — feeds autocomplete.
export function knownPeople(
  settlements: ReadonlyArray<{ kind: string; amount: number | string; person: string | null }>,
): { name: string; outstanding: number }[] {
  return receivablesByPerson(settlements).map((r) => ({
    name: r.person,
    outstanding: r.outstanding,
  }));
}

export function totalOutstanding(
  settlements: ReadonlyArray<{ kind: string; amount: number | string; person: string | null }>,
): number {
  return receivablesByPerson(settlements)
    .filter((r) => r.outstanding > 0)
    .reduce((s, r) => s + r.outstanding, 0);
}
