import { createClient } from "@supabase/supabase-js";
import { addLabel, ensureLabel, getAccessToken, getMessage, listMessageIds } from "./gmail-client";
import { extractBody } from "./extract-body";
import { parseBankEmail } from "./bank-parsers";

const SENDERS = ["alerts@hdfcbank.bank.in", "credit_cards@icici.bank.in"];

const IMPORTED_LABEL = "LedgerImported";
const UNRECOGNIZED_LABEL = "LedgerUnrecognized";

// Card/account last-4-digits -> the `accounts.name` row this app already has.
const LAST4_TO_ACCOUNT: Record<string, string> = {
  "0702": "Bank",
  "2149": "HDFC",
  "9008": "ICICI",
};

function supabaseServer() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key);
}

export type ImportSummary = {
  checked: number;
  imported: number;
  unrecognized: number;
  failed: number;
};

// Searches for unlabeled mail from known bank senders, parses each one,
// inserts a matching expense, and labels the email so it's never
// re-processed. Never touches history/credits — only debit alerts, since
// crediting the wrong account automatically is a worse failure mode than
// leaving it for manual entry.
export async function importTransactionsFromEmail(): Promise<ImportSummary> {
  const accessToken = await getAccessToken();
  const [importedLabelId, unrecognizedLabelId] = await Promise.all([
    ensureLabel(accessToken, IMPORTED_LABEL),
    ensureLabel(accessToken, UNRECOGNIZED_LABEL),
  ]);

  // Never scans mail from before the feature was turned on, so a first run
  // can't flood the ledger with years of history. Override by setting
  // EMAIL_IMPORT_START_DATE=YYYY-MM-DD if a backfill is ever wanted.
  const sinceDate = process.env.EMAIL_IMPORT_START_DATE || new Date().toISOString().slice(0, 10);
  const senderQuery = SENDERS.map((s) => `from:${s}`).join(" OR ");
  const query = `(${senderQuery}) -label:${IMPORTED_LABEL} -label:${UNRECOGNIZED_LABEL} after:${sinceDate.replace(/-/g, "/")}`;

  const ids = await listMessageIds(accessToken, query);

  const supabase = supabaseServer();
  const { data: accounts, error: accErr } = await supabase.from("accounts").select("id,name");
  if (accErr) throw accErr;
  const accountIdByName = new Map((accounts ?? []).map((a) => [a.name, a.id as string]));

  const summary: ImportSummary = { checked: ids.length, imported: 0, unrecognized: 0, failed: 0 };

  for (const id of ids) {
    const msg = await getMessage(accessToken, id);
    const from = msg.payload.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    const body = extractBody(msg.payload);
    const parsed = parseBankEmail(from, body);

    if (!parsed || parsed.direction !== "debit") {
      await addLabel(accessToken, id, unrecognizedLabelId);
      summary.unrecognized++;
      continue;
    }

    const accountName = LAST4_TO_ACCOUNT[parsed.last4];
    const accountId = accountName ? accountIdByName.get(accountName) : undefined;
    if (!accountId) {
      await addLabel(accessToken, id, unrecognizedLabelId);
      summary.unrecognized++;
      continue;
    }

    const occurredAt = new Date(Number(msg.internalDate)).toISOString();
    const { error } = await supabase.rpc("apply_transaction", {
      p_amount: parsed.amountRupees,
      p_kind: "expense",
      p_account_id: accountId,
      p_category_id: null as unknown as string,
      p_linked_account_id: null as unknown as string,
      p_note: parsed.note,
      p_occurred_at: occurredAt,
    });

    if (error) {
      console.error(`[import-emails] apply_transaction failed for message ${id}:`, error.message);
      summary.failed++;
      continue; // leave unlabeled so the next run retries it
    }

    await addLabel(accessToken, id, importedLabelId);
    summary.imported++;
  }

  return summary;
}
