import { defineHandler, getRequestHeader, getQuery, setResponseStatus } from "h3";
import { importCasFromEmail } from "../lib/cas-import";

// Manual trigger for the CAS portfolio import (same auth as the cron).
// The daily /api/import-emails run also calls this automatically; this
// endpoint exists so a new statement can be pulled on demand right after
// it arrives, and so failures can be retried without waiting a day.
// Append ?force=1 to reprocess even already-labeled/older statements.
export default defineHandler(async (event) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = getRequestHeader(event, "authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    setResponseStatus(event, 401);
    return { error: "unauthorized" };
  }

  try {
    const force = getQuery(event).force === "1";
    const summary = await importCasFromEmail({
      sinceDate: force ? "2000-01-01" : undefined,
      ignoreExistingLabels: force,
    });
    return { ok: true, ...summary };
  } catch (error) {
    console.error("[import-cas] failed:", error);
    setResponseStatus(event, 500);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
