import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Inbox, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  accountsQuery,
  addCategory,
  applyTransaction,
  categoriesQuery,
  dateInputToISO,
  deleteCategory,
  deleteTransaction,
  editExpense,
  formatINR,
  isoToDateInput,
  restoreTransaction,
  transactionsQuery,
  type Account,
  type Transaction,
} from "@/lib/finance";

const LAST_ACCOUNT_KEY = "ledger:lastAccountId";
const todayInput = () => isoToDateInput(new Date().toISOString());

export const Route = createFileRoute("/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(accountsQuery),
      context.queryClient.ensureQueryData(categoriesQuery),
      context.queryClient.ensureQueryData(transactionsQuery),
    ]),
  component: Journal,
});

function Journal() {
  const qc = useQueryClient();
  const { data: accounts = [] } = useQuery(accountsQuery);
  const { data: categories = [] } = useQuery(categoriesQuery);
  const { data: transactions = [] } = useQuery(transactionsQuery);

  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCat, setNewCat] = useState("");
  const [manageCats, setManageCats] = useState(false);
  const [confirmCatId, setConfirmCatId] = useState<string | null>(null);
  const [filterAccountId, setFilterAccountId] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [dateStr, setDateStr] = useState(todayInput);
  const [editingTxn, setEditingTxn] = useState<Transaction | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedStoredAccount = useRef(false);

  const activeAccountId = accountId ?? accounts[0]?.id ?? null;

  // Default to whichever payment source was used last session (still a
  // visible, overridable choice — just saves a tap on repeat entries).
  useEffect(() => {
    if (appliedStoredAccount.current || accountId || accounts.length === 0) return;
    appliedStoredAccount.current = true;
    const stored = window.localStorage.getItem(LAST_ACCOUNT_KEY);
    if (stored && accounts.some((a) => a.id === stored)) setAccountId(stored);
  }, [accounts, accountId]);

  function selectAccount(id: string) {
    setAccountId(id);
    window.localStorage.setItem(LAST_ACCOUNT_KEY, id);
  }

  // Fade+slide new rows into the ledger instead of popping in silently.
  const seenIds = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(transactions.map((t) => t.id));
    if (seenIds.current) {
      const fresh = new Set<string>();
      for (const id of currentIds) if (!seenIds.current.has(id)) fresh.add(id);
      if (fresh.size > 0) {
        setFreshIds(fresh);
        const timer = setTimeout(() => setFreshIds(new Set()), 260);
        seenIds.current = currentIds;
        return () => clearTimeout(timer);
      }
    }
    seenIds.current = currentIds;
  }, [transactions]);

  const logMut = useMutation({
    mutationFn: applyTransaction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      setAmount("");
      setCategoryId(null);
      setNote("");
      setNoteOpen(false);
      setDateOpen(false);
      setDateStr(todayInput());
      amountRef.current?.focus();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delMut = useMutation({ mutationFn: deleteTransaction });
  const restoreMut = useMutation({
    mutationFn: restoreTransaction,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleDelete(t: Transaction) {
    delMut.mutate(t.id, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["accounts"] });
      },
      onError: (e: Error) => toast.error(e.message),
    });
    toast(`Deleted ${formatINR(Number(t.amount))}`, {
      action: { label: "Undo", onClick: () => restoreMut.mutate(t) },
    });
    setEditingTxn(null);
  }

  const editMut = useMutation({
    mutationFn: (args: { original: Transaction; amount: number; category_id: string | null; account_id: string; note: string | null; occurred_at: string }) =>
      editExpense(args.original, args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      setEditingTxn(null);
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addCatMut = useMutation({
    mutationFn: addCategory,
    onSuccess: (cat) => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      setCategoryId(cat.id);
      setNewCat("");
      setShowAddCat(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const delCatMut = useMutation({
    mutationFn: deleteCategory,
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      if (categoryId === id) setCategoryId(null);
      toast.success("Category deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function handleCategoryClick(id: string) {
    if (!manageCats) {
      setCategoryId(id);
      return;
    }
    if (confirmCatId === id) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setConfirmCatId(null);
      delCatMut.mutate(id);
      return;
    }
    setConfirmCatId(id);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmCatId(null), 2500);
  }

  function submit() {
    const n = Number(amount);
    if (!n || n <= 0) return toast.error("Enter an amount");
    if (!categoryId) return toast.error("Pick a category");
    if (!activeAccountId) return toast.error("Pick a payment source");
    logMut.mutate({
      amount: n,
      kind: "expense",
      account_id: activeAccountId,
      category_id: categoryId,
      note: noteOpen && note.trim() ? note.trim() : null,
      occurred_at: dateOpen ? dateInputToISO(dateStr) : undefined,
    });
  }

  const accountsById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a])) as Record<string, Account>,
    [accounts],
  );
  const catsById = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.name])),
    [categories],
  );
  const filteredTxns = useMemo(
    () => (filterAccountId ? transactions.filter((t) => t.account_id === filterAccountId || t.linked_account_id === filterAccountId) : transactions),
    [transactions, filterAccountId],
  );

  return (
    <div className="space-y-6 md:space-y-10">
      {/* Quick add */}
      <section>
        <div className="rounded-xl border border-border/70 bg-surface px-4 py-5 md:px-6 md:py-10">
          <div className="flex items-baseline justify-center gap-1">
            <span className="text-3xl md:text-5xl text-muted-foreground/60 tnum">₹</span>
            <input
              ref={amountRef}
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="0"
              className="tnum w-full max-w-[16ch] bg-transparent text-center text-5xl md:text-7xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/30"
              aria-label="Amount"
            />
          </div>

          {/* Categories */}
          <div className="mt-5 md:mt-8 -mx-2 overflow-x-auto scrollbar-none">
            <div className="flex gap-2 px-2 pb-1">
              {categories.map((c) => (
                <div key={c.id} className="relative shrink-0">
                  <Chip
                    active={categoryId === c.id}
                    danger={manageCats && confirmCatId === c.id}
                    onClick={() => handleCategoryClick(c.id)}
                  >
                    <span className={manageCats ? "pr-4" : ""}>
                      {manageCats && confirmCatId === c.id ? "Confirm?" : c.name}
                    </span>
                  </Chip>
                  {manageCats && confirmCatId !== c.id && (
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-destructive">
                      <X className="size-3.5" />
                    </span>
                  )}
                </div>
              ))}
              <button
                onClick={() => setShowAddCat(true)}
                className="shrink-0 h-9 w-9 grid place-items-center rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors"
                aria-label="Add category"
              >
                <Plus className="size-4" />
              </button>
              <button
                onClick={() => {
                  setManageCats((v) => !v);
                  setConfirmCatId(null);
                }}
                className={`shrink-0 h-9 w-9 grid place-items-center rounded-lg border transition-colors ${
                  manageCats
                    ? "border-destructive/60 text-destructive"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
                }`}
                aria-label={manageCats ? "Done managing categories" : "Manage categories"}
              >
                {manageCats ? <X className="size-4" /> : <Pencil className="size-3.5" />}
              </button>
            </div>
          </div>

          {showAddCat && (
            <div className="mt-3 flex items-center gap-2">
              <input
                autoFocus
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && newCat.trim() && addCatMut.mutate(newCat.trim())}
                placeholder="New category"
                className="flex-1 h-9 px-3 rounded-md bg-muted/50 border border-border text-sm outline-none focus:border-primary"
              />
              <button
                onClick={() => setShowAddCat(false)}
                className="h-9 w-9 grid place-items-center rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          )}

          {/* Payment source */}
          <div className="mt-4 md:mt-6 flex flex-wrap gap-2">
            {accounts.map((a) => (
              <Chip key={a.id} active={activeAccountId === a.id} onClick={() => selectAccount(a.id)}>
                {a.name}
              </Chip>
            ))}
          </div>

          {/* Optional, collapsed by default so the fast path never grows */}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNoteOpen((v) => !v)}
              className={`shrink-0 h-7 px-2.5 inline-flex items-center gap-1.5 rounded-full text-xs border transition-colors ${
                noteOpen ? "border-primary/60 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <StickyNote className="size-3" /> Note
            </button>
            <button
              type="button"
              onClick={() => setDateOpen((v) => !v)}
              className={`shrink-0 h-7 px-2.5 inline-flex items-center gap-1.5 rounded-full text-xs border transition-colors ${
                dateOpen ? "border-primary/60 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <CalendarDays className="size-3" /> {dateOpen ? "Backdated" : "Today"}
            </button>
          </div>
          {noteOpen && (
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Add a note (optional)"
              className="mt-2 w-full h-9 px-3 rounded-md bg-muted/50 border border-border text-sm outline-none focus:border-primary"
            />
          )}
          {dateOpen && (
            <input
              type="date"
              value={dateStr}
              max={todayInput()}
              onChange={(e) => setDateStr(e.target.value)}
              className="tnum mt-2 h-9 px-3 rounded-md bg-muted/50 border border-border text-sm outline-none focus:border-primary"
            />
          )}

          {/* Log */}
          <button
            onClick={submit}
            disabled={logMut.isPending}
            className="mt-5 md:mt-8 w-full h-11 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity active:scale-[0.99]"
          >
            {logMut.isPending ? "Logging…" : "Log expense"}
          </button>
        </div>
      </section>

      {/* Ledger */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Recent</h2>
          <span className="text-xs text-muted-foreground tnum">
            {filteredTxns.length} of {transactions.length}
          </span>
        </div>
        <div className="mb-3 -mx-2 overflow-x-auto scrollbar-none">
          <div className="flex gap-2 px-2 pb-1">
            <FilterChip active={filterAccountId === null} onClick={() => setFilterAccountId(null)}>
              All
            </FilterChip>
            {accounts.map((a) => (
              <FilterChip key={a.id} active={filterAccountId === a.id} onClick={() => setFilterAccountId(a.id)}>
                {a.name}
              </FilterChip>
            ))}
          </div>
        </div>
        <ul className="divide-y divide-border/60">
          {filteredTxns.map((t) => {
            const acc = accountsById[t.account_id];
            const catName = t.category_id ? catsById[t.category_id] : null;
            const isCredit = t.kind === "salary";
            const isExpense = t.kind === "expense";
            const isUncategorized = isExpense && !t.category_id;
            const label =
              t.kind === "salary"
                ? "Salary"
                : t.kind === "card_payment"
                ? `Payment → ${t.linked_account_id ? accountsById[t.linked_account_id]?.name : "Card"}`
                : catName ?? "Uncategorized";
            return (
              <li
                key={t.id}
                onClick={() => isExpense && setEditingTxn(t)}
                className={`group flex items-center gap-4 py-3 -mx-2 px-2 rounded-md transition-all ${
                  isExpense ? "cursor-pointer hover:bg-muted/40" : ""
                } ${freshIds.has(t.id) ? "animate-ledger-in" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium truncate">
                    {isUncategorized && (
                      <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    )}
                    <span className={`truncate ${isUncategorized ? "text-muted-foreground" : ""}`}>{label}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {acc?.name}
                    {t.note ? ` · ${t.note}` : ""} · {new Date(t.occurred_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                  </div>
                </div>
                <div className={`tnum text-sm font-medium ${isCredit ? "text-[color:var(--success)]" : "text-foreground"}`}>
                  {isCredit ? "+" : "−"}{formatINR(Number(t.amount))}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(t);
                  }}
                  className="shrink-0 p-2.5 -mr-2.5 opacity-60 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  aria-label="Delete"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            );
          })}

          {filteredTxns.length === 0 && (
            <li className="py-14 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
              <Inbox className="size-5 text-muted-foreground/50" aria-hidden="true" />
              {transactions.length === 0 ? "No entries yet." : "No entries for this account."}
            </li>
          )}
        </ul>
      </section>

      {editingTxn && (
        <EditTransactionModal
          txn={editingTxn}
          accounts={accounts}
          categories={categories}
          onClose={() => setEditingTxn(null)}
          onSave={(updates) => editMut.mutate({ original: editingTxn, ...updates })}
          onDelete={() => handleDelete(editingTxn)}
          saving={editMut.isPending}
        />
      )}
    </div>
  );
}

function EditTransactionModal({
  txn,
  accounts,
  categories,
  onClose,
  onSave,
  onDelete,
  saving,
}: {
  txn: Transaction;
  accounts: Account[];
  categories: { id: string; name: string }[];
  onClose: () => void;
  onSave: (updates: { amount: number; category_id: string | null; account_id: string; note: string | null; occurred_at: string }) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const [amount, setAmount] = useState(String(Number(txn.amount)));
  const [categoryId, setCategoryId] = useState(txn.category_id);
  const [accountId, setAccountId] = useState(txn.account_id);
  const [note, setNote] = useState(txn.note ?? "");
  const [dateStr, setDateStr] = useState(isoToDateInput(txn.occurred_at));

  function save() {
    const n = Number(amount);
    if (!n || n <= 0) return toast.error("Enter an amount");
    if (!categoryId) return toast.error("Pick a category");
    onSave({
      amount: n,
      category_id: categoryId,
      account_id: accountId,
      note: note.trim() || null,
      occurred_at: dateInputToISO(dateStr, new Date(txn.occurred_at)),
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end md:items-center justify-center bg-background/70 backdrop-blur-sm px-0 md:px-4" onClick={onClose}>
      <div
        className="w-full md:max-w-md rounded-t-2xl md:rounded-xl border border-border bg-surface p-5 md:p-6 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] md:pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-medium">Edit expense</p>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex items-baseline justify-center gap-1 mb-5">
          <span className="text-2xl text-muted-foreground/60 tnum">₹</span>
          <input
            autoFocus
            aria-label="Edit amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            className="tnum w-full max-w-[10ch] bg-transparent text-center text-4xl font-semibold tracking-tight outline-none"
          />
        </div>

        <div className="-mx-1 overflow-x-auto scrollbar-none mb-3">
          <div className="flex gap-2 px-1 pb-1">
            {categories.map((c) => (
              <Chip key={c.id} active={categoryId === c.id} onClick={() => setCategoryId(c.id)}>
                {c.name}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {accounts.map((a) => (
            <Chip key={a.id} active={accountId === a.id} onClick={() => setAccountId(a.id)}>
              {a.name}
            </Chip>
          ))}
        </div>

        <div className="flex flex-col gap-2 mb-5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-9 px-3 rounded-md bg-muted/50 border border-border text-sm outline-none focus:border-primary"
          />
          <input
            type="date"
            value={dateStr}
            max={todayInput()}
            onChange={(e) => setDateStr(e.target.value)}
            className="tnum h-9 px-3 rounded-md bg-muted/50 border border-border text-sm outline-none focus:border-primary"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onDelete}
            className="h-10 px-4 rounded-lg border border-destructive/40 text-destructive text-sm hover:bg-destructive/10 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 h-8 px-3 rounded-full text-xs border transition-colors ${
        active
          ? "bg-foreground text-background border-foreground"
          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  danger,
  onClick,
  children,
}: {
  active: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 h-9 px-3.5 rounded-lg text-sm border transition-colors ${
        danger
          ? "bg-destructive text-destructive-foreground border-destructive"
          : active
          ? "bg-primary text-primary-foreground border-primary"
          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
      }`}
    >
      {children}
    </button>
  );
}
