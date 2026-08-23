import { defineHandler, readBody, setResponseStatus } from "h3";
import { exchangeAndFetchHoldings, reconcileHoldings } from "../lib/kite";

// Completes a Zerodha portfolio sync: exchanges the one-time request_token
// for a session, pulls holdings, reconciles them into the investments table.
// The access_token lives only inside this request handler.
export default defineHandler(async (event) => {
  const body = (await readBody(event).catch(() => null)) as { request_token?: string } | null;
  const requestToken = body?.request_token?.trim();
  if (!requestToken) {
    setResponseStatus(event, 400);
    return { ok: false, error: "Missing request_token" };
  }

  try {
    const holdings = await exchangeAndFetchHoldings(requestToken);
    const summary = await reconcileHoldings(holdings);
    return { ok: true, ...summary };
  } catch (error) {
    console.error("[kite-sync] failed:", error);
    setResponseStatus(event, 400);
    return {
      ok: false,
      // Kite messages ("Token used or expired", etc.) are already user-facing.
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
