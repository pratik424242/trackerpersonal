// Minimal hand-rolled Gmail REST client (no googleapis SDK) — just the
// handful of calls the email-import feature needs: refresh a token, search
// messages, fetch one, manage labels, and renew the push-notification watch.

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function getAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function gmailFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function listMessageIds(accessToken: string, query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q: query, maxResults: "25" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailFetch<{ messages?: { id: string }[]; nextPageToken?: string }>(
      accessToken,
      `/messages?${params}`,
    );
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < 50);
  return ids;
}

export type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  internalDate: string;
  payload: { headers: { name: string; value: string }[] } & GmailPart;
};

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(accessToken, `/messages/${id}?format=full`);
}

const labelIdCache = new Map<string, string>();

export async function ensureLabel(accessToken: string, name: string): Promise<string> {
  const cached = labelIdCache.get(name);
  if (cached) return cached;

  const data = await gmailFetch<{ labels: { id: string; name: string }[] }>(accessToken, "/labels");
  const existing = data.labels.find((l) => l.name === name);
  if (existing) {
    labelIdCache.set(name, existing.id);
    return existing.id;
  }

  const created = await gmailFetch<{ id: string }>(accessToken, "/labels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  labelIdCache.set(name, created.id);
  return created.id;
}

export async function addLabel(accessToken: string, messageId: string, labelId: string): Promise<void> {
  await gmailFetch(accessToken, `/messages/${messageId}/modify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });
}

// Renews the push-notification subscription (Gmail watch() subscriptions
// expire after 7 days). Safe to call repeatedly — each call just extends it.
export async function watchMailbox(accessToken: string, topicName: string): Promise<void> {
  await gmailFetch(accessToken, "/watch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topicName, labelIds: ["INBOX"], labelFilterAction: "include" }),
  });
}
