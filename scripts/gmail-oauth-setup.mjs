// One-time setup script: exchanges a Google OAuth consent for a long-lived
// refresh token, used by the email-import feature (server/lib/gmail-client.ts).
//
// Usage:
//   node scripts/gmail-oauth-setup.mjs <client_id> <client_secret>
//
// Requires the OAuth client's "Authorized redirect URIs" (Google Cloud
// Console -> APIs & Services -> Credentials) to include:
//   http://localhost:8085/oauth-callback
//
// Prints a refresh token at the end — save it as GOOGLE_REFRESH_TOKEN.
// Re-run any time to get a new one (each run supersedes the last).

import http from "node:http";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/gmail-oauth-setup.mjs <client_id> <client_secret>");
  process.exit(1);
}

const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent"); // forces a refresh_token every run

console.log("\nOpen this URL, sign in with the Gmail account to import from, and approve access:\n");
console.log(authUrl.toString());
console.log(
  "\n(You'll likely see a 'Google hasn't verified this app' warning — that's expected for a personal " +
    "project not submitted for verification. Click 'Advanced' -> 'Go to <app name> (unsafe)' to continue.)\n",
);
console.log(`Waiting for the redirect on http://localhost:${PORT} ...`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth-callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    res.writeHead(400, { "content-type": "text/plain" }).end(`Authorization failed: ${error ?? "no code"}`);
    console.error(`\nAuthorization failed: ${error ?? "no code returned"}`);
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok || !data.refresh_token) {
      res.writeHead(500, { "content-type": "text/plain" }).end("Token exchange failed — check the terminal.");
      console.error("\nToken exchange failed:", JSON.stringify(data, null, 2));
      if (!data.refresh_token) {
        console.error(
          "\nNo refresh_token in the response. This usually means the account already granted access " +
            "without 'prompt=consent' sticking — try revoking access at https://myaccount.google.com/permissions " +
            "and re-running this script.",
        );
      }
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { "content-type": "text/plain" }).end("Success — you can close this tab.");
    console.log("\nGOOGLE_REFRESH_TOKEN=" + data.refresh_token);
    console.log("\nSave that as an env var (locally in .env, and in Vercel's project settings). Done.");
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
