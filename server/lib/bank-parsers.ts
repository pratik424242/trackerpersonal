// Parsers for the bank transaction-alert emails this app auto-imports.
// Each bank's template varies (and sometimes has multiple sub-formats for
// the same sender), so parsers try known patterns in turn and return null
// if nothing matches rather than guessing.

export type ParsedTxn = {
  amountRupees: number;
  direction: "debit" | "credit";
  last4: string;
  note: string;
  // The raw payee VPA, when one was identifiable — used for merchant ->
  // category auto-mapping. Not always the same as `note`, which may add a
  // payee name or get reworded per bank.
  vpa?: string;
};

function toAmount(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function toDirection(word: string): "debit" | "credit" {
  return word.toLowerCase().startsWith("credit") ? "credit" : "debit";
}

export function parseHdfc(text: string): ParsedTxn | null {
  // Credit card UPI, e.g.
  // "Rs.63.00 has been debited from your RuPay Credit Card (ending 2149)"
  // "Paid to paytm-31109533@ptybl"
  let m = text.match(
    /Rs\.?\s*([\d,]+\.\d{2})\s+has\s+been\s+(debited|credited)\s+from\s+your\s+[^(\n]*\(ending\s*(\d{4})\)/i,
  );
  if (m) {
    const paidTo = text.match(/Paid\s+to\s+(.+?)(?=\s*(?:\n|Date\s*:|UPI\s+Transaction|$))/i);
    const vpa = paidTo ? paidTo[1].trim() : undefined;
    return {
      amountRupees: toAmount(m[1]),
      direction: toDirection(m[2]),
      last4: m[3],
      note: vpa ?? "",
      vpa,
    };
  }

  // Bank account UPI, e.g.
  // "Rs.5700.00 is debited from your account ending 0702 towards VPA
  //  9647793131@ptyes (Manoj Goel) on 23-07-26."
  m = text.match(
    /Rs\.?\s*([\d,]+\.\d{2})\s+is\s+(debited|credited)\s+from\s+your\s+account\s+ending\s*(\d{4})\s+towards\s+VPA\s+(\S+?)(?:\s*\(([^)]+)\))?[\s.]/i,
  );
  if (m) {
    const vpa = m[4];
    const name = m[5];
    return {
      amountRupees: toAmount(m[1]),
      direction: toDirection(m[2]),
      last4: m[3],
      note: name ? `${name} (${vpa})` : vpa,
      vpa,
    };
  }

  // Bank account credit/debit (long form), e.g.
  // "Rs.1.00 has been successfully credited to your HDFC Bank account
  //  ending in 0702." ... "Sender: Nitya Mall (VPA: 7048908508@ybl)"
  m = text.match(
    /Rs\.?\s*([\d,]+\.\d{2})\s+has\s+been\s+successfully\s+(credited|debited)\s+(?:to|from)\s+your\s+[^.]*?ending\s+in\s+(\d{4})/i,
  );
  if (m) {
    const sender = text.match(/Sender:\s*([^(]+?)\s*\(VPA:\s*([^)]+)\)/i);
    const name = sender ? sender[1].trim() : undefined;
    const vpa = sender ? sender[2].trim() : undefined;
    return {
      amountRupees: toAmount(m[1]),
      direction: toDirection(m[2]),
      last4: m[3],
      note: name && vpa ? `${name} (${vpa})` : name ?? vpa ?? "",
      vpa,
    };
  }

  // Credit card merchant debit ("A payment was made using your Credit
  // Card"), naming the merchant directly rather than a VPA in parens, e.g.
  // "Rs. 160.00 has been debited from your HDFC Bank Credit Card ending
  //  2149 towards SWIGGYFOOD on 08 Aug, 2026 at 19:37:38."
  m = text.match(
    /Rs\.?\s*([\d,]+\.\d{2})\s+has\s+been\s+(debited|credited)\s+from\s+your\s+HDFC\s+Bank\s+Credit\s+Card\s+ending\s+(\d{4})\s+towards\s+(.+?)\s+on\s+\d{1,2}\s+[A-Za-z]{3},?\s+\d{4}/i,
  );
  if (m) {
    return {
      amountRupees: toAmount(m[1]),
      direction: toDirection(m[2]),
      last4: m[3],
      note: m[4].trim(),
    };
  }

  // Interbank NEFT/RTGS credit ("New Deposit Alert"), e.g. salary paid in
  // by direct transfer rather than UPI:
  // "You have received a credit in your HDFC Bank account.
  //  Details of the transaction:
  //   Amount received: INR 40,611.21
  //   Account: XX0702
  //   Reference Details: A2AINT01-GOLDMAN SACHS SERVICES PRIVATE LIMITED-..."
  m = text.match(
    /Amount\s+received:\s*INR\s*([\d,]+\.\d{2})[\s\S]{0,200}?Account:\s*X{0,2}(\d{4})[\s\S]{0,300}?Reference\s+Details:\s*([^\n]+)/i,
  );
  if (m) {
    return {
      amountRupees: toAmount(m[1]),
      direction: "credit",
      last4: m[2],
      note: m[3].trim(),
    };
  }

  // NACH mandate debit, sent from a different sub-address
  // (nachautoemailer@hdfcbank.bank.in) than the usual InstaAlerts mail, e.g.
  // "Rs.500.00 has been debited from HDFC Bank Account Number
  //  XXXXXXXXXX0702 towards INDIAN CLEARING CORP LTD/TWF178 with UMRN
  //  HDFC7022403244000773 on 04-Aug-2026."
  m = text.match(
    /Rs\.?\s*([\d,]+\.\d{2})\s+has\s+been\s+debited\s+from\s+HDFC\s+Bank\s+Account\s+Number\s+X*(\d{4})\s+towards\s+(.+?)\s+with\s+UMRN/i,
  );
  if (m) {
    return {
      amountRupees: toAmount(m[1]),
      direction: "debit",
      last4: m[2],
      note: m[3].trim(),
    };
  }

  // ACH/NACH mandate debit (e.g. a SIP autopay), e.g.
  // "Rs. INR 5,500.00 is deducted from your account ending XX0702 and
  //  added to ACH D- ZERODHA BROKING LTD-R3U9UC8YSM4N7 account on
  //  03-AUG-2026." — a different template from the UPI alerts above,
  // used for standing-instruction debits rather than one-off payments.
  m = text.match(
    /Rs\.?\s*INR\s*([\d,]+\.\d{2})\s+is\s+deducted\s+from\s+your\s+account\s+ending\s+X{0,2}(\d{4})\s+and\s+added\s+to\s+(.+?)\s+account\s+on\s+\d{2}-[A-Z]{3}-\d{4}/i,
  );
  if (m) {
    const payee = m[3].trim().replace(/^ACH\s*[A-Z]-\s*/i, "");
    return {
      amountRupees: toAmount(m[1]),
      direction: "debit",
      last4: m[2],
      note: payee,
    };
  }

  return null;
}

export function parseIcici(text: string): ParsedTxn | null {
  // "Your ICICI Bank Credit Card XX9008 has been used for a transaction of
  //  INR 1,512.00 on Jul 19, 2026 at 08:48:49. Info: UPI-204848542556-MAAN RES."
  const m = text.match(
    /ICICI\s+Bank\s+Credit\s+Card\s+XX(\d{4})\s+has\s+been\s+used\s+for\s+a\s+transaction\s+of\s+INR\s*([\d,]+\.\d{2})/i,
  );
  if (!m) return null;

  const infoMatch = text.match(/Info:\s*([^\n.]+)/i);
  let note = infoMatch ? infoMatch[1].trim() : "";
  // Strip the "UPI-<ref>-" / "POS-<ref>-" prefix, keep just the merchant tail.
  note = note.replace(/^(UPI|POS)-\d+-/i, "").trim();

  return {
    amountRupees: toAmount(m[2]),
    direction: "debit",
    last4: m[1],
    note: note || "ICICI transaction",
  };
}

export function parseBankEmail(fromHeader: string, text: string): ParsedTxn | null {
  const from = fromHeader.toLowerCase();
  if (from.includes("hdfcbank")) return parseHdfc(text);
  if (from.includes("icici")) return parseIcici(text);
  return null;
}
