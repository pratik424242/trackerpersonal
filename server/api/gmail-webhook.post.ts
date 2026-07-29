import { defineHandler, getQuery, setResponseStatus } from "h3";
import { importTransactionsFromEmail } from "../lib/import-transactions";
import { getAccessToken, watchMailbox } from "../lib/gmail-client";

// Google Pub/Sub push target. Fires within seconds of a new bank email
// arriving. The push payload itself (emailAddress/historyId) is ignored —
// it's treated purely as a "go check for new mail" trigger, and the actual
// work reuses the same label-based search as the daily fallback, so a
// missed or duplicate push can never double-import anything.
//
// Also renews the Gmail watch() subscription on every trigger, not just
// the daily cron — watch() expires after 7 days, and with a bank email
// arriving far more than once a day, piggybacking the renewal here means
// far more chances to keep it alive than the once-a-day cron alone gives.
export default defineHandler(async (event) => {
  const secret = process.env.GMAIL_WEBHOOK_SECRET;
  if (!secret || getQuery(event).secret !== secret) {
    setResponseStatus(event, 401);
    return { error: "unauthorized" };
  }

  const topic = process.env.GOOGLE_PUBSUB_TOPIC;
  let watchRenewed = false;
  let watchError: string | undefined;
  if (topic) {
    try {
      const accessToken = await getAccessToken();
      await watchMailbox(accessToken, topic);
      watchRenewed = true;
    } catch (error) {
      watchError = error instanceof Error ? error.message : String(error);
      console.error("[gmail-webhook] watch renewal failed:", watchError);
    }
  }

  try {
    const summary = await importTransactionsFromEmail();
    return { ok: true, watchRenewed, watchError, ...summary };
  } catch (error) {
    console.error("[gmail-webhook] import failed:", error);
    setResponseStatus(event, 500);
    return { ok: false, watchRenewed, watchError, error: error instanceof Error ? error.message : String(error) };
  }
});
