import { defineHandler, getQuery, setResponseStatus } from "h3";
import { importTransactionsFromEmail } from "../lib/import-transactions";

// Google Pub/Sub push target. Fires within seconds of a new bank email
// arriving. The push payload itself (emailAddress/historyId) is ignored —
// it's treated purely as a "go check for new mail" trigger, and the actual
// work reuses the same label-based search as the daily fallback, so a
// missed or duplicate push can never double-import anything.
export default defineHandler(async (event) => {
  const secret = process.env.GMAIL_WEBHOOK_SECRET;
  if (!secret || getQuery(event).secret !== secret) {
    setResponseStatus(event, 401);
    return { error: "unauthorized" };
  }

  try {
    const summary = await importTransactionsFromEmail();
    return { ok: true, ...summary };
  } catch (error) {
    console.error("[gmail-webhook] import failed:", error);
    setResponseStatus(event, 500);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
