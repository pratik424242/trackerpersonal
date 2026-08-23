import { defineHandler } from "h3";
import { kiteConfigured, loginUrl } from "../lib/kite";

// The Invested page asks for this to decide whether to show the sync button
// and where to send the user. No secrets leave the server — only api_key,
// which is public by design.
export default defineHandler(async () => {
  if (!kiteConfigured()) return { configured: false };
  return { configured: true, url: loginUrl() };
});
