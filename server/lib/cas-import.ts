import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addLabel, ensureLabel, getAccessToken, getMessage } from "./gmail-client";

// Monthly CDSL Consolidated Account Statement (CAS) — one email per month
// from eCAS@cdslstatement.com with a PAN-password-protected PDF containing
// every demat holding and mutual fund folio across both depositories. The
// statement is a full snapshot, so each import replaces `investments`
// wholesale and appends to `portfolio_snapshots`.

const CAS_SENDER = "ecds@cdslstatement.com";
const CAS_SENDER_ALT = "eCAS@cdslstatement.com";
const CAS_LABEL = "LedgerCASImported";

// The PDF password is derived from the holder's PAN; different statement
// generations have used raw/upper/lower variants, so try all three.
function passwordCandidates(): string[] {
  const p = process.env.CAS_PDF_PASSWORD ?? "";
  if (!p) return [];
  return [...new Set([p, p.toUpperCase(), p.toLowerCase()])];
}

export type CasHolding = {
  isin: string;
  name: string;
  kind: "equity" | "etf" | "mutual_fund" | "sgb" | "bond" | "other";
  quantity: number;
  price: number;
  value: number;
};

export type CasParseResult = {
  asOfDate: string | null; // YYYY-MM-DD
  dpLabel: string | null; // e.g. "Zerodha · 1208160144469581"
  reportedTotal: number | null;
  holdings: CasHolding[];
};

const ISIN_RE = /\b(IN[0-9A-Z]{2}[0-9A-Z]{7}[0-9])\b/;
const NUM_RE = /^\d{1,3}(?:,\d{2,3})*\.\d{1,4}$|^\d+\.\d{1,4}$/;

// ISIN → kind. INF = mutual fund units; INE = equity (ETFs refine by name);
// IN9 = SGB/gold bonds; rest treated as other.
function kindFor(isin: string, name: string): CasHolding["kind"] {
  if (isin.startsWith("INF")) return "mutual_fund";
  if (/\betf\b/i.test(name)) return "etf";
  if (isin.startsWith("IN9")) return "sgb";
  if (isin.startsWith("INE")) return "equity";
  if (/\bbond\b|debenture|NCD/i.test(name)) return "bond";
  return "other";
}

// pdf.js is a large ESM bundle — loaded lazily so cold starts that never
// touch investments don't pay for it.
export type PdfToken = { x: number; s: string };
export type PdfLine = { y: number; parts: PdfToken[] };

async function extractPdfLines(pdfBytes: Uint8Array): Promise<PdfLine[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  let lastErr: unknown = null;
  for (const password of passwordCandidates()) {
    try {
      doc = await pdfjs.getDocument({
        data: pdfBytes,
        password,
        useSystemFonts: true,
        isEvalSupported: false,
      }).promise;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!doc)
    throw new Error(
      `could not decrypt CAS PDF: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
    );

  const lines: PdfLine[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // Reconstruct visual rows by y-coordinate, tokens kept with x so the
    // parser can tell the name column from the numeric columns.
    const rows = new Map<number, PdfToken[]>();
    for (const item of tc.items) {
      if (!("str" in item) || !item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x: item.transform[4], s: item.str.trim() });
    }
    for (const [, parts] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
      lines.push({
        y: p * 100000 + parts[0].x,
        parts: parts.filter((t) => t.s).sort((a, b) => a.x - b.x),
      });
    }
  }
  return lines;
}

function parseNumber(tok: string): number | null {
  const t = tok.replace(/,/g, "");
  if (!NUM_RE.test(tok)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Parses the extracted CAS text into holdings. The holdings table lives
// under "HOLDING STATEMENT AS ON ...". Every holding anchors on its ISIN row:
//   <ISIN> <mid-name...> <qty> [-- ...] <free-bal> <price> <value>
// where name-column tokens sit far left and numeric columns far right. The
// numeric-column x positions are consistent page-wide, so a single global
// threshold cleanly separates wrapped scheme names (anywhere in the left
// band, on any row) from table data — no fragile line-distance heuristics.
export function parseCasText(lines: PdfLine[]): CasParseResult {
  const lineText = (l: PdfLine) =>
    l.parts
      .map((p) => p.s)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  const flat = lines.map(lineText).join("\n");

  const asOfMatch = flat.match(/as on (\d{2})-(\d{2})-(\d{4})/i);
  const asOfDate = asOfMatch ? `${asOfMatch[3]}-${asOfMatch[2]}-${asOfMatch[1]}` : null;

  let dpLabel: string | null = null;
  const boJoin = flat.match(/\b(120816\d{10})\b/);
  const dpSplit = flat.match(/DP\s*Id\s*:?\s*(\d{8}).{0,40}?Client\s*Id\s*:?\s*(\d{8})/is);
  const dpName = flat.match(
    /DP\s*Name\s*:\s*([A-Z][A-Z .&]+(?:LIMITED|LTD|SECURITIES|BROKING)[A-Z ]*)/i,
  );
  const boId = boJoin?.[1] ?? (dpSplit ? `${dpSplit[1]}${dpSplit[2]}` : null);
  if (boId) dpLabel = `${dpName?.[1]?.trim().replace(/\s*DP\s*ID:?$/i, "") ?? "CDSL"} · ${boId}`;

  const totalMatches = [
    ...flat.matchAll(/[`₹]\s*((?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{2})\s+as on/g),
  ].map((m) => Number(m[1].replace(/,/g, "")));
  const reportedTotal = totalMatches.length > 0 ? totalMatches[totalMatches.length - 1] : null;

  // Scope to the holdings section only — transaction rows carry ISINs too.
  const headerIdx = lines.findIndex((l) => /holding statement as on/i.test(lineText(l)));
  let scope = headerIdx >= 0 ? lines.slice(headerIdx + 1) : lines;
  const footerIdx = scope.findIndex((l) => /^portfolio value|^for any queries/i.test(lineText(l)));
  if (footerIdx >= 0) scope = scope.slice(0, footerIdx);

  const isBoundary = (l: string) =>
    /^(page\b|central depository|a wing|for any queries|portfolio value|holding statement)/i.test(
      l,
    );
  const hasDevanagari = (s: string) => /[\u0900-\u097F]/.test(s);

  // ISIN rows: contain an ISIN plus at least three numeric columns.
  const isNumTok = (s: string) => parseNumber(s) !== null;
  type Row = { idx: number; isin: string; nums: number[] };
  const rows: Row[] = [];
  for (let i = 0; i < scope.length; i++) {
    const parts = scope[i].parts;
    const isinPart = parts.find((p) => ISIN_RE.test(p.s));
    if (!isinPart) continue;
    const nums = parts
      .slice(parts.indexOf(isinPart) + 1)
      .filter((p) => p.s !== "--" && p.s !== "-")
      .map((p) => parseNumber(p.s))
      .filter((n): n is number => n !== null);
    if (nums.length >= 3) rows.push({ idx: i, isin: isinPart.s.match(ISIN_RE)![1], nums });
  }
  if (rows.length === 0) return { asOfDate, dpLabel, reportedTotal, holdings: [] };

  // Global left edge of the first numeric column (quantity), minus margin —
  // everything left of this belongs to the name column.
  let numColX = Infinity;
  for (const r of rows) {
    const parts = scope[r.idx].parts;
    const isinPart = parts.find((p) => ISIN_RE.test(p.s))!;
    for (const p of parts.slice(parts.indexOf(isinPart) + 1)) {
      if (parseNumber(p.s) !== null && p.x < numColX) numColX = p.x;
    }
  }
  const nameColMaxX = numColX - 10;

  const isHeaderToken = (s: string) =>
    /^(isin|security|particulars|market price|face value|value|current bal|frozen bal|pledge bal|pledge setup|free bal|stamp duty|transaction date|op\.? ?bal|cl\.? ?bal|credit|debit|cr\.?|dr\.?|account details|summary of investments|details|notes|about cdsl|\(+.*\)+)$/i.test(
      s.trim(),
    );
  const endsCorporate = (l: string) =>
    /(?:ltd|pvt|limited|amc|management|co)\.?[\s)*]*$/i.test(l.trim());
  const isNameWorthy = (s: string) =>
    /[A-Za-z]{3}/.test(s) && !isHeaderToken(s) && !hasDevanagari(s) && !/^\d+$/.test(s.trim());

  // Each holding's full name assembles from three zones around its ISIN row:
  //   prefix — lines above, up to and including the '#' AMC/Scheme separator
  //            line (only its post-'#' tail). May pass through corporate
  //            continuation lines (e.g. "MIRAE ASSET IM (I) PVT" above
  //            "LTD#MIRAE...") but never the previous holding's suffix.
  //   bridge — plain lines between the '#' line and the ISIN row (long
  //            scheme names wrap there, e.g. ICICI's).
  //   mid    — left-band tokens sitting on the ISIN row itself.
  //   suffix — at most one plain line directly below (e.g. "GROWTH",
  //            "SUBDIVISION"); anything corporate-ending or '#'-bearing
  //            below is the next holding's header instead.
  const SCHEME_WORD = /^(growth|option|direct|plan|opt|gr|idcw|payout|bonus)/i;
  const allCapsShort = (s: string) =>
    /^[-A-Z0-9 .&()/]{3,40}$/.test(s.trim()) && s.trim().split(/\s+/).length <= 5;
  const holdings: CasHolding[] = [];
  const seenIsins = new Set<string>();

  for (const r of rows) {
    if (seenIsins.has(r.isin)) continue;

    const prefix: string[] = [];
    let headIdx = -1;
    for (let j = r.idx - 1; j >= Math.max(0, r.idx - 4); j--) {
      const parts = scope[j].parts;
      const text = lineText(scope[j]);
      if (!text || isBoundary(text)) break;
      const hashIdx = parts.findIndex((p) => p.s.includes("#"));
      if (hashIdx >= 0) {
        // Post-'#' tail only — the pre-'#' AMC fragment ("LTD", "LIMITED")
        // belongs to the same company name and is re-captured by the peek.
        const hashPart = parts[hashIdx];
        const preText = hashPart.s.replace(/#.*$/, "").trim();
        const tail = [hashPart.s.replace(/^.*#/, ""), ...parts.slice(hashIdx + 1).map((p) => p.s)]
          .join(" ")
          .trim();
        if (isNameWorthy(tail)) prefix.unshift(tail);
        headIdx = j;
        // A peek above only makes sense when '#' glued onto a bare corporate
        // stub ("LTD#MIRAE…") — i.e. the company name wrapped and its head
        // sits one line higher. A full "X AMC LTD#Y MF-" head needs nothing
        // from above and must not swallow the previous holding's dangling
        // suffix.
        const peekAllowed =
          preText === "" ||
          (preText.split(/\s+/).length <= 2 && /(?:ltd|pvt|limited|co)\.?$/i.test(preText));
        if (peekAllowed && headIdx - 1 >= 0) {
          const peekText = lineText(scope[headIdx - 1]);
          if (
            peekText &&
            !isBoundary(peekText) &&
            !/\d/.test(peekText) &&
            !scope[headIdx - 1].parts.some((p) => p.s.includes("#")) &&
            isNameWorthy(peekText) &&
            (endsCorporate(peekText) ||
              (allCapsShort(peekText) &&
                peekText.trim().split(/\s+/).length >= 2 &&
                !SCHEME_WORD.test(peekText)))
          ) {
            prefix.unshift(peekText);
          }
        }
        break;
      }
      if (/\d/.test(text) || ISIN_RE.test(text)) break;
      if (!isNameWorthy(text)) break;
      prefix.unshift(text);
      if (!endsCorporate(text)) break;
    }

    if (headIdx >= 0) {
      // One peek above the '#' line: a wrapped company-name piece.
      if (headIdx - 1 >= 0) {
        const peekText = lineText(scope[headIdx - 1]);
        if (
          peekText &&
          !isBoundary(peekText) &&
          !/\d/.test(peekText) &&
          !scope[headIdx - 1].parts.some((p) => p.s.includes("#")) &&
          isNameWorthy(peekText) &&
          (endsCorporate(peekText) || (allCapsShort(peekText) && !SCHEME_WORD.test(peekText)))
        ) {
          prefix.unshift(peekText);
        }
      }
      // Bridge lines between the '#' line and the ISIN row.
      for (let j = headIdx + 1; j < r.idx; j++) {
        const bText = lineText(scope[j]);
        if (!bText || /\d/.test(bText) || scope[j].parts.some((p) => p.s.includes("#"))) break;
        if (isNameWorthy(bText)) prefix.push(bText);
      }
    }

    const parts = scope[r.idx].parts;
    const isinPart = parts.find((p) => ISIN_RE.test(p.s))!;
    const mid: string[] = [];
    for (const p of parts.slice(parts.indexOf(isinPart) + 1)) {
      if (p.x >= nameColMaxX || isNumTok(p.s) || p.s === "--" || p.s === "-") continue;
      if (isNameWorthy(p.s)) mid.push(p.s.replace(/#/g, " ").trim());
    }

    const suffix: string[] = [];
    const below = scope[r.idx + 1];
    if (below) {
      const bText = lineText(below);
      const bHash = below.parts.some((p) => p.s.includes("#"));
      if (
        bText &&
        !bHash &&
        !isBoundary(bText) &&
        !/\d/.test(bText) &&
        !endsCorporate(bText) &&
        isNameWorthy(bText)
      ) {
        suffix.push(
          ...below.parts.filter((p) => isNameWorthy(p.s)).map((p) => p.s.replace(/#/g, " ").trim()),
        );
        // A second wrapped line joins only when it visibly continues the
        // scheme (leading hyphen or scheme words), never an unrelated block.
        const below2 = scope[r.idx + 2];
        if (below2) {
          const t2 = lineText(below2);
          if (/^\s*-/.test(t2) || /^(plan|growth|option|opt|direct|idcw)\b/i.test(t2.trim())) {
            const ok2 =
              !t2.includes("#") &&
              !isBoundary(t2) &&
              !/\d/.test(t2) &&
              !endsCorporate(t2) &&
              isNameWorthy(t2);
            if (ok2) {
              suffix.push(...below2.parts.filter((p) => isNameWorthy(p.s)).map((p) => p.s.trim()));
            }
          }
        }
      }
    }

    // Collapse duplicated fragments/words ("MIRAE ASSET IM (I) PVT" captured
    // by both the walk and the peek leaves adjacent repeats).
    const allFrags = [...prefix, ...mid, ...suffix];
    const deduped: string[] = [];
    for (const f of allFrags) {
      if (deduped.length && deduped[deduped.length - 1].toLowerCase() === f.toLowerCase()) continue;
      deduped.push(f);
    }
    let name = deduped.join(" ").replace(/\s+/g, " ").trim();
    for (let k = 0; k < 3; k++) {
      name = name.replace(/(\b(?:[\w&.(),/-]+\s+){0,4}[\w&.(),/-]+)\s+\1\b/gi, "$1");
    }
    name = name.replace(/\s+/g, " ").trim();
    const value = r.nums[r.nums.length - 1];
    const price = r.nums[r.nums.length - 2];
    const qty = r.nums[0];

    holdings.push({
      isin: r.isin,
      name: name || r.isin,
      kind: kindFor(r.isin, name),
      quantity: qty,
      price,
      value,
    });
    seenIsins.add(r.isin);
  }

  return { asOfDate, dpLabel, reportedTotal, holdings };
}

function supabaseServer(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, key);
}

// Same claim guard as bank imports — a PK insert on imported_email_messages
// means only one concurrent run can process a given CAS message id.
const CLAIM_STALE_MS = 30 * 60 * 1000;

async function claimMessage(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { error } = await supabase
    .from("imported_email_messages")
    .insert({ gmail_message_id: `cas:${id}` });
  if (!error) return true;
  if (error.code !== "23505") throw error;
  const { data: existing } = await supabase
    .from("imported_email_messages")
    .select("imported_at")
    .eq("gmail_message_id", `cas:${id}`)
    .single();
  if (!(
    existing && Date.now() - new Date(existing.imported_at as string).getTime() > CLAIM_STALE_MS
  ))
    return false;
  await supabase.from("imported_email_messages").delete().eq("gmail_message_id", `cas:${id}`);
  const { error: retryErr } = await supabase
    .from("imported_email_messages")
    .insert({ gmail_message_id: `cas:${id}` });
  return !retryErr;
}

async function releaseClaim(supabase: SupabaseClient, id: string): Promise<void> {
  await supabase.from("imported_email_messages").delete().eq("gmail_message_id", `cas:${id}`);
}

async function fetchAttachmentBase64(
  accessToken: string,
  msgId: string,
): Promise<{ data: string } | null> {
  const msg = await getMessage(accessToken, msgId);
  let att: { filename: string; body: { attachmentId?: string; size?: number } } | undefined;
  const walk = (p: never | Record<string, unknown>): void => {
    const parts = (p as { parts?: unknown[] }).parts ?? [];
    if ((p as { filename?: string }).filename?.toLowerCase().endsWith(".pdf"))
      att = p as typeof att;
    for (const part of parts) walk(part as never);
  };
  walk(msg.payload as never);
  if (!att?.body?.attachmentId) return null;
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${att.body.attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`attachment fetch failed: ${res.status}`);
  return (await res.json()) as { data: string };
}

export type CasImportSummary = {
  checked: number;
  imported: number;
  skippedUpToDate: number;
  failed: number;
  unrecognized: number;
};

// Searches unlabeled CAS emails, parses the newest statement PDF, and
// replaces the investments snapshot. Older statements are labeled without
// parsing once a newer or equal-period snapshot exists.
export async function importCasFromEmail(
  options: { sinceDate?: string; ignoreExistingLabels?: boolean } = {},
): Promise<CasImportSummary> {
  const accessToken = await getAccessToken();
  const labelId = await ensureLabel(accessToken, CAS_LABEL);

  const sinceDate =
    options.sinceDate ||
    process.env.CAS_IMPORT_START_DATE ||
    new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const labelFilter = options.ignoreExistingLabels ? "" : ` -label:${CAS_LABEL}`;
  const query = `(from:${CAS_SENDER} OR from:${CAS_SENDER_ALT})${labelFilter} after:${sinceDate.replace(/-/g, "/")}`;
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`;
  const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } }).then(
    (r) => r.json(),
  );
  const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);

  const summary: CasImportSummary = {
    checked: ids.length,
    imported: 0,
    skippedUpToDate: 0,
    failed: 0,
    unrecognized: 0,
  };
  if (ids.length === 0) return summary;

  const supabase = supabaseServer();

  // Newest first; only the newest unlabeled statement needs parsing unless
  // it fails — anything older is stale by definition.
  const currentAsOf = async (): Promise<string | null> => {
    const { data } = await supabase
      .from("portfolio_snapshots")
      .select("as_of_date")
      .order("as_of_date", { ascending: false })
      .limit(1);
    return data?.[0]?.as_of_date ?? null;
  };

  for (let idx = 0; idx < ids.length; idx++) {
    const id = ids[idx];
    const claimed = await claimMessage(supabase, id);
    // Force runs may legitimately revisit already-claimed messages.
    if (!claimed && !options.ignoreExistingLabels) continue;

    try {
      const existing = await currentAsOf();
      const att = await fetchAttachmentBase64(accessToken, id);
      if (!att) {
        await releaseClaim(supabase, id);
        summary.unrecognized++;
        continue;
      }
      const bytes = new Uint8Array(Buffer.from(att.data, "base64"));

      let parsed: CasParseResult;
      try {
        const lines = await extractPdfLines(bytes);
        parsed = parseCasText(lines);
      } catch (e) {
        // Wrong/missing password or corrupt file — leave unlabeled so the
        // next run retries (e.g. after CAS_PDF_PASSWORD gets fixed).
        await releaseClaim(supabase, id);
        console.error("[cas-import] parse failed:", e instanceof Error ? e.message : e);
        summary.failed++;
        continue;
      }

      if (parsed.holdings.length === 0 || !parsed.asOfDate) {
        await releaseClaim(supabase, id);
        summary.unrecognized++;
        console.error("[cas-import] no holdings recognized in message", id);
        continue;
      }

      // Strictly older than what's stored → stale, mark processed only.
      // Equal dates re-persist: idempotent for dupes, and lets a forced
      // re-import refresh security names after parser fixes.
      if (existing && parsed.asOfDate < existing) {
        summary.skippedUpToDate++;
      } else {
        await persistSnapshot(supabase, parsed);
        summary.imported++;
      }

      await addLabel(accessToken, id, labelId);
    } catch (e) {
      await releaseClaim(supabase, id);
      console.error("[cas-import] failed for message", id, e);
      summary.failed++;
    }
  }

  return summary;
}

async function persistSnapshot(supabase: SupabaseClient, parsed: CasParseResult): Promise<void> {
  const asOf = parsed.asOfDate!;
  const source = parsed.dpLabel ?? "CAS";

  // Upsert securities by ISIN — names/kinds refresh when CDSL renames things.
  const securityIds = new Map<string, string>();
  for (const h of parsed.holdings) {
    const { data: existing } = await supabase
      .from("securities")
      .select("id")
      .eq("isin", h.isin)
      .maybeSingle();
    if (existing) {
      await supabase
        .from("securities")
        .update({ name: h.name, kind: h.kind })
        .eq("id", existing.id as string);
      securityIds.set(h.isin, existing.id as string);
      continue;
    }
    const { data: created, error } = await supabase
      .from("securities")
      .insert({ isin: h.isin, name: h.name, kind: h.kind })
      .select("id")
      .single();
    if (error) throw error;
    securityIds.set(h.isin, created.id as string);
  }

  // Full-snapshot replace of the *mutual fund* rows only. Stocks, ETFs and
  // SGBs are owned by the Zerodha Kite sync and must survive statement
  // imports — a CAS import once wiped the user's equity holding this way.
  const mfRowIds: string[] = [];
  {
    const PAGE = 200;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("investments")
        .select("id,security_id")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      const secIds = [...new Set(data.map((r) => r.security_id as string))];
      const { data: secs } = await supabase.from("securities").select("id,kind").in("id", secIds);
      const mfSet = new Set(
        (secs ?? []).filter((s) => s.kind === "mutual_fund").map((s) => s.id as string),
      );
      for (const r of data) if (mfSet.has(r.security_id as string)) mfRowIds.push(r.id as string);
      if (data.length < PAGE) break;
    }
  }
  for (const id of mfRowIds) {
    const { error } = await supabase.from("investments").delete().eq("id", id);
    if (error) throw error;
  }

  const rows = parsed.holdings.map((h) => ({
    security_id: securityIds.get(h.isin)!,
    source,
    quantity: h.quantity,
    price: h.price,
    value: h.value,
    as_of_date: asOf,
  }));
  const { error: insErr } = await supabase.from("investments").insert(rows);
  if (insErr) throw insErr;

  const total = parsed.reportedTotal ?? rows.reduce((s, r) => s + r.value!, 0);
  const { error: snapErr } = await supabase
    .from("portfolio_snapshots")
    .upsert(
      { as_of_date: asOf, total_value: total, holdings_count: rows.length, source: "cas" },
      { onConflict: "as_of_date" },
    );
  if (snapErr) throw snapErr;

  const drift =
    parsed.reportedTotal != null ? total - rows.reduce((s, r) => s + r.value!, 0) : null;
  console.log(
    `[cas-import] snapshot ${asOf}: ${rows.length} holdings, total ₹${total}` +
      (drift != null && Math.abs(drift) > 1
        ? ` (⚠ parsed sum differs from reported by ₹${drift.toFixed(2)})`
        : ""),
  );
}
