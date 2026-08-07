import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addLabel, ensureLabel, getAccessToken, getMessage, listMessageIds } from "./gmail-client";
import { extractBody } from "./extract-body";
import { parseBankEmail } from "./bank-parsers";

// Domain-level, not exact addresses — HDFC in particular sends alerts from
// several different sub-addresses depending on alert type (alerts@,
// nachautoemailer@ for NACH mandate debits, etc.), and a narrower exact-match
// list silently drops a whole class of mail from the search itself, before
// parsing ever gets a chance to run.
const SENDERS = ["hdfcbank.bank.in", "icici.bank.in"];

const IMPORTED_LABEL = "LedgerImported";
const UNRECOGNIZED_LABEL = "LedgerUnrecognized";

// Card/account last-4-digits -> the `accounts.name` row this app already has.
const LAST4_TO_ACCOUNT: Record<string, string> = {
  "0702": "Bank",
  "2149": "HDFC",
  "9008": "ICICI",
};

// Recurring merchant VPAs that are reliably always the same category, so
// those specific imports skip the "uncategorized, tap to fix" step. Keyed
// lowercase; only exact matches apply — anything else still lands
// uncategorized rather than guessing.
const VPA_TO_CATEGORY: Record<string, string> = {
  "paytm-31109533@ptybl": "Office Food",
  "gpay-12199745072@okbizaxis": "Outside Food",
};

// Same idea, but for merchants whose note doesn't come through as a stable
// exact VPA (e.g. ICICI's "Info:" field sometimes reduces to just a bare
// merchant name like "zerodha") — matched by substring against the note
// instead. Checked after the exact-VPA map.
const NOTE_KEYWORD_TO_CATEGORY: Array<[RegExp, string]> = [
  [/zerodha/i, "Mutual Funds"],
  // NACH mandate debits toward Zerodha route through the NSE/BSE clearing
  // corp rather than naming Zerodha directly — same mandate (UMRN
  // HDFC7022403244000773) every time, confirmed with the user.
  [/indian clearing corp/i, "Mutual Funds"],
];

function categoryFromNoteKeyword(note: string): string | undefined {
  return NOTE_KEYWORD_TO_CATEGORY.find(([pattern]) => pattern.test(note))?.[1];
}

// Credits (money received) can only be auto-imported as `kind: 'salary'` —
// that's the only transaction type this schema allows to credit a bank
// account. Tagging every credit with this category instead of leaving it
// uncategorized keeps them visibly distinct from real salary (which stays
// category-less) in the ledger label and in Insights, without needing a
// schema change to add a real "income" type.
const OTHER_INCOME_CATEGORY = "Other Income";

// A UPI payment from your own bank account that's actually paying off one
// of your own credit cards isn't a plain expense — it needs the app's
// "Clear card bill" double-entry (reduces Bank *and* the card's debt
// together). Recording it as a plain expense would silently understate the
// card's debt.
function looksLikeCardBillPayment(note: string): boolean {
  return /card\s*bill|bill\s*pay|creditcard.*bill|\bcc\s*-?\s*pay\b|\bcc\s*-?\s*bill\b/i.test(note);
}

// The bill-payment payee text reliably names the bank being paid (e.g.
// "ICICI Bank Credit Card Bill", "HDFC Bank Credit Card Bill") — enough to
// resolve which of this app's credit card accounts it's for. Only exact,
// unambiguous name matches count; anything else is left for manual entry
// via Accounts -> Clear bill rather than guessed at.
const CREDIT_CARD_ACCOUNT_NAMES = ["HDFC", "ICICI"];
function detectBillPaymentCardName(note: string): string | null {
  const matches = CREDIT_CARD_ACCOUNT_NAMES.filter((name) => new RegExp(name, "i").test(note));
  return matches.length === 1 ? matches[0] : null;
}

// A concurrent-processing guard, independent of the Gmail labels. Labels
// alone aren't safe against two runs (e.g. a manual trigger racing a
// just-renewed push notification) both listing the same unlabeled message
// before either has finished labeling it — this happened in practice and
// double-imported. Claiming a message id here first, atomically via the
// table's primary key, means only one concurrent run can ever proceed to
// apply_transaction for a given message.
const CLAIM_STALE_MS = 10 * 60 * 1000; // long enough to cover a real in-flight run, short enough that a crashed run doesn't block the message forever

async function claimMessage(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { error } = await supabase.from("imported_email_messages").insert({ gmail_message_id: id });
  if (!error) return true;
  if (error.code !== "23505") throw error;

  const { data: existing } = await supabase
    .from("imported_email_messages")
    .select("imported_at")
    .eq("gmail_message_id", id)
    .single();
  const isStale = existing && Date.now() - new Date(existing.imported_at as string).getTime() > CLAIM_STALE_MS;
  if (!isStale) return false;

  await supabase.from("imported_email_messages").delete().eq("gmail_message_id", id);
  const { error: retryErr } = await supabase.from("imported_email_messages").insert({ gmail_message_id: id });
  return !retryErr;
}

async function releaseClaim(supabase: SupabaseClient, id: string): Promise<void> {
  await supabase.from("imported_email_messages").delete().eq("gmail_message_id", id);
}

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

export type ImportOptions = {
  // YYYY-MM-DD. Defaults to today (never scans history) unless
  // EMAIL_IMPORT_START_DATE is set.
  sinceDate?: string;
  // Re-processes mail even if already labeled Imported/Unrecognized. Only
  // meant for one-off manual backfills — the normal cron/webhook path
  // always leaves this off so it never reprocesses anything.
  ignoreExistingLabels?: boolean;
};

// Searches for unlabeled mail from known bank senders, parses each one,
// inserts a matching transaction, and labels the email so it's never
// re-processed. Credits only auto-import when they land on the bank
// account (the only kind that can be credited as 'salary') — a credit
// hitting a credit card, or one this app can't map to a known account,
// is left for manual entry rather than guessed at.
export async function importTransactionsFromEmail(options: ImportOptions = {}): Promise<ImportSummary> {
  const accessToken = await getAccessToken();
  const [importedLabelId, unrecognizedLabelId] = await Promise.all([
    ensureLabel(accessToken, IMPORTED_LABEL),
    ensureLabel(accessToken, UNRECOGNIZED_LABEL),
  ]);

  // Bounded rolling window, not "today" — a fixed "today" cutoff sounds
  // safe but actually breaks the daily cron's whole job: if a push
  // notification is ever missed, the fallback cron runs on a *later*
  // calendar day and "today" would already have rolled past the missed
  // message, silently losing it forever instead of catching it. A rolling
  // window still bounds a cold start (never floods in years of history)
  // while actually giving the fallback something to catch. Already-
  // processed mail is skipped via labels regardless of window size, so
  // widening this is free. Override via `sinceDate` or
  // EMAIL_IMPORT_START_DATE=YYYY-MM-DD for a one-off backfill further back.
  const ROLLING_WINDOW_DAYS = 7;
  const sinceDate =
    options.sinceDate ||
    process.env.EMAIL_IMPORT_START_DATE ||
    new Date(Date.now() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const senderQuery = SENDERS.map((s) => `from:${s}`).join(" OR ");
  const labelFilter = options.ignoreExistingLabels ? "" : ` -label:${IMPORTED_LABEL} -label:${UNRECOGNIZED_LABEL}`;
  const query = `(${senderQuery})${labelFilter} after:${sinceDate.replace(/-/g, "/")}`;

  const ids = await listMessageIds(accessToken, query);

  const supabase = supabaseServer();
  const [{ data: accounts, error: accErr }, { data: categories, error: catErr }] = await Promise.all([
    supabase.from("accounts").select("id,name,kind"),
    supabase.from("categories").select("id,name"),
  ]);
  if (accErr) throw accErr;
  if (catErr) throw catErr;
  const accountIdByName = new Map((accounts ?? []).map((a) => [a.name, a.id as string]));
  const bankAccountKindByName = new Map((accounts ?? []).map((a) => [a.name, a.kind as string]));
  const categoryIdByName = new Map((categories ?? []).map((c) => [c.name, c.id as string]));

  let otherIncomeCategoryId = categoryIdByName.get(OTHER_INCOME_CATEGORY);
  if (!otherIncomeCategoryId) {
    const { data: created, error: createCatErr } = await supabase
      .from("categories")
      .insert({ name: OTHER_INCOME_CATEGORY, is_custom: true })
      .select("id")
      .single();
    if (createCatErr) throw createCatErr;
    otherIncomeCategoryId = created.id as string;
    categoryIdByName.set(OTHER_INCOME_CATEGORY, otherIncomeCategoryId);
  }

  const summary: ImportSummary = { checked: ids.length, imported: 0, unrecognized: 0, failed: 0 };

  for (const id of ids) {
    const claimed = await claimMessage(supabase, id);
    if (!claimed) {
      // A concurrent run already has this one — it'll get labeled by
      // whichever run finishes, so it just won't show up unlabeled next time.
      continue;
    }

    const msg = await getMessage(accessToken, id);
    const from = msg.payload.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    const body = extractBody(msg.payload);
    const parsed = parseBankEmail(from, body);

    if (!parsed) {
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
    let rpcArgs: Record<string, unknown>;

    if (parsed.direction === "credit") {
      // Only a 'bank' account can be credited as salary (the RPC itself
      // enforces this) — a credit hitting a credit card (e.g. a refund) has
      // no safe automatic handling here, so it's left for manual entry.
      if (bankAccountKindByName.get(accountName!) !== "bank") {
        await addLabel(accessToken, id, unrecognizedLabelId);
        summary.unrecognized++;
        continue;
      }
      rpcArgs = {
        p_amount: parsed.amountRupees,
        p_kind: "salary",
        p_account_id: accountId,
        p_category_id: otherIncomeCategoryId,
        p_linked_account_id: null as unknown as string,
        p_note: parsed.note,
        p_occurred_at: occurredAt,
      };
    } else if (looksLikeCardBillPayment(parsed.note)) {
      const cardName = detectBillPaymentCardName(parsed.note);
      const cardAccountId = cardName ? accountIdByName.get(cardName) : undefined;
      if (!cardAccountId) {
        // Bill payment we can't confidently attribute to one of the known
        // cards — leave it for manual entry rather than guess.
        await addLabel(accessToken, id, unrecognizedLabelId);
        summary.unrecognized++;
        continue;
      }
      rpcArgs = {
        p_amount: parsed.amountRupees,
        p_kind: "card_payment",
        p_account_id: accountId,
        p_category_id: null as unknown as string,
        p_linked_account_id: cardAccountId,
        p_note: parsed.note,
        p_occurred_at: occurredAt,
      };
    } else {
      const categoryName =
        (parsed.vpa ? VPA_TO_CATEGORY[parsed.vpa.toLowerCase()] : undefined) ?? categoryFromNoteKeyword(parsed.note);
      const categoryId = categoryName ? categoryIdByName.get(categoryName) : undefined;
      rpcArgs = {
        p_amount: parsed.amountRupees,
        p_kind: "expense",
        p_account_id: accountId,
        p_category_id: (categoryId ?? null) as unknown as string,
        p_linked_account_id: null as unknown as string,
        p_note: parsed.note,
        p_occurred_at: occurredAt,
      };
    }

    const { error } = await supabase.rpc("apply_transaction", rpcArgs);

    if (error) {
      console.error(`[import-emails] apply_transaction failed for message ${id}:`, error.message);
      summary.failed++;
      await releaseClaim(supabase, id); // leave unlabeled and unclaimed so the next run retries it
      continue;
    }

    await addLabel(accessToken, id, importedLabelId);
    summary.imported++;
  }

  return summary;
}
