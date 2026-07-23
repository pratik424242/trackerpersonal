import { defineHandler, getRequestHeader, setResponseStatus } from "h3";
import { importTransactionsFromEmail } from "../lib/import-transactions";
import { getAccessToken, watchMailbox } from "../lib/gmail-client";

// Daily safety net (Vercel Cron): re-runs the same import as the push
// webhook, so anything a dropped/missed push ever left behind is caught
// within 24h — and renews the Gmail watch() subscription, which otherwise
// expires after 7 days. This is the only thing keeping the push webhook
// alive long-term, and it's fully automatic — nothing to reconfigure.
export default defineHandler(async (event) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = getRequestHeader(event, "authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
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
      console.error("[import-emails] watch renewal failed:", watchError);
    }
  }

  try {
    const summary = await importTransactionsFromEmail();
    return { ok: true, watchRenewed, watchError, ...summary };
  } catch (error) {
    console.error("[import-emails] import failed:", error);
    setResponseStatus(event, 500);
    return { ok: false, watchRenewed, watchError, error: error instanceof Error ? error.message : String(error) };
  }
});
