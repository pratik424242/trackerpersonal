import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  accountsQuery,
  applyTransaction,
  formatINR,
  receivablesQuery,
  setAccountBalance,
  totalOutstanding,
  type Account,
} from "@/lib/finance";

export const Route = createFileRoute("/accounts")({
  head: () => ({
    meta: [
      { title: "Accounts — Ledger" },
      { name: "description", content: "Net worth and account balances." },
    ],
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(accountsQuery),
      context.queryClient.ensureQueryData(receivablesQuery),
    ]),
  component: AccountsPage,
});

function AccountsPage() {
  const { data: accounts = [] } = useQuery(accountsQuery);
  const { data: settlements = [] } = useQuery(receivablesQuery);

  const banks = accounts.filter((a) => a.kind === "bank");
  const cards = accounts.filter((a) => a.kind === "credit_card");
  const bankTotal = banks.reduce((s, b) => s + b.balance, 0);
  const debt = cards.reduce((s, c) => s + c.balance, 0);
  const owed = totalOutstanding(settlements);
  const netWorth = bankTotal - debt + owed;

  return (
    <div className="space-y-6 md:space-y-10">
      <section>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Net worth</p>
        <p
          className={`tnum mt-2 text-4xl md:text-6xl font-semibold tracking-tight ${netWorth < 0 ? "text-destructive" : ""}`}
        >
          {formatINR(netWorth)}
        </p>
        <p className="mt-2 text-xs md:text-sm text-muted-foreground tnum">
          {formatINR(bankTotal)} across {banks.length} bank account{banks.length === 1 ? "" : "s"} ·{" "}
          {formatINR(debt)} owed on cards
          {owed > 0 && <> · {formatINR(owed)} owed by others</>}
        </p>
      </section>

      {banks.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Bank accounts
            </h2>
            <span className="tnum text-xs text-muted-foreground">{formatINR(bankTotal)}</span>
          </div>
          <div className="space-y-3">
            {banks.map((a) => (
              <AccountCard key={a.id} account={a} banks={banks} />
            ))}
          </div>
        </section>
      )}

      {cards.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Credit cards
            </h2>
            <span className="tnum text-xs text-muted-foreground">{formatINR(debt)} owed</span>
          </div>
          <div className="space-y-3">
            {cards.map((a) => (
              <AccountCard key={a.id} account={a} banks={banks} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function AccountCard({ account, banks }: { account: Account; banks: Account[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(account.balance));
  const [modal, setModal] = useState<null | "salary" | "clear" | "transfer">(null);
  const [amount, setAmount] = useState("");
  const [otherId, setOtherId] = useState<string | null>(null);

  const isCard = account.kind === "credit_card";
  const label = isCard ? "Outstanding" : "Balance";
  // The counterparty for clear/transfer: every bank except this card. Salary
  // always credits the card it's opened on.
  const counterparties = banks.filter((b) => b.id !== account.id);
  const activeOtherId = otherId ?? counterparties[0]?.id ?? null;
  const activeOther = banks.find((b) => b.id === activeOtherId) ?? null;

  const saveMut = useMutation({
    mutationFn: () => setAccountBalance(account.id, Number(value) || 0),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      setEditing(false);
      toast.success("Balance updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const actionMut = useMutation({
    mutationFn: async () => {
      const n = Number(amount);
      if (!n || n <= 0) throw new Error("Enter an amount");
      if (modal === "salary") {
        await applyTransaction({
          amount: n,
          kind: "salary",
          account_id: account.id,
          note: "Salary",
        });
      } else if (modal === "clear" && activeOther) {
        await applyTransaction({
          amount: n,
          kind: "card_payment",
          account_id: activeOther.id,
          linked_account_id: account.id,
          note: `Cleared ${account.name}`,
        });
      } else if (modal === "transfer" && activeOther) {
        await applyTransaction({
          amount: n,
          kind: "transfer",
          account_id: account.id,
          linked_account_id: activeOther.id,
          note: null,
        });
      } else {
        throw new Error("Pick an account first");
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      setModal(null);
      setAmount("");
      setOtherId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="rounded-xl border border-border/70 bg-surface p-4 md:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{account.name}</p>
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            {isCard ? "Liability" : "Asset"}
          </p>
        </div>
        {editing ? (
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground text-sm">₹</span>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
              className="tnum w-32 bg-muted/50 border border-border rounded-md px-2 py-1 text-right text-sm outline-none focus:border-primary"
            />
            <button onClick={() => saveMut.mutate()} className="text-xs text-primary px-2">
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs text-muted-foreground px-1"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setValue(String(account.balance));
              setEditing(true);
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Adjust
          </button>
        )}
      </div>

      <div className="mt-4 flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span
          className={`tnum text-2xl font-semibold ${isCard && account.balance > 0 ? "text-destructive" : ""}`}
        >
          {formatINR(account.balance)}
        </span>
      </div>

      <div className="mt-4 flex gap-2">
        {!isCard && (
          <button
            onClick={() => setModal("salary")}
            className="flex-1 h-9 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30"
          >
            Add salary
          </button>
        )}
        {!isCard && counterparties.length > 0 && (
          <button
            onClick={() => setModal("transfer")}
            className="flex-1 h-9 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30"
          >
            Transfer
          </button>
        )}
        {isCard && (
          <button
            onClick={() => setModal("clear")}
            disabled={counterparties.length === 0}
            className="flex-1 h-9 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 disabled:opacity-50"
          >
            Clear bill
          </button>
        )}
      </div>

      {modal && (
        <div className="mt-4 rounded-lg border border-border p-4 bg-background/40">
          <p className="text-xs text-muted-foreground mb-3">
            {modal === "salary"
              ? `Credit salary to ${account.name}`
              : modal === "clear"
                ? `Pay ${account.name} from ${activeOther?.name ?? "…"}`
                : `Move money from ${account.name} to ${activeOther?.name ?? "…"}`}
          </p>
          {(modal === "clear" || modal === "transfer") && counterparties.length > 1 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {counterparties.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setOtherId(b.id)}
                  className={`shrink-0 h-8 px-3 rounded-full text-xs border transition-colors ${
                    activeOtherId === b.id
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">₹</span>
            <input
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && actionMut.mutate()}
              placeholder="0"
              className="tnum flex-1 bg-muted/50 border border-border rounded-md px-3 py-2 text-right text-sm outline-none focus:border-primary"
            />
            <button
              onClick={() => actionMut.mutate()}
              disabled={actionMut.isPending}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-60"
            >
              Confirm
            </button>
            <button onClick={() => setModal(null)} className="text-xs text-muted-foreground px-2">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
