-- Investments: money moved into the portfolio (SIP autopays, stock/MF
-- purchases) is a transfer to your own assets, not consumption — so it gets
-- its own kind that analytics exclude, exactly like settlements. The cash
-- movement is identical to an expense (out of the bank, or onto card debt),
-- so balances stay honest; only the semantics change.

ALTER TABLE public.transactions DROP CONSTRAINT transactions_kind_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_kind_check
  CHECK (kind IN ('expense','salary','card_payment','lent','repayment','investment'));

-- Backfill: every auto-imported debit categorized "Mutual Funds" was a
-- Zerodha SIP/purchase mislabeled as spending. Convert in place — the
-- balance effect is unchanged, so no account math moves.
UPDATE public.transactions t
SET kind = 'investment', category_id = NULL
FROM public.categories c
WHERE t.category_id = c.id
  AND t.kind = 'expense'
  AND c.name = 'Mutual Funds';

CREATE OR REPLACE FUNCTION public.apply_transaction(
  p_amount numeric,
  p_kind text,
  p_account_id uuid,
  p_category_id uuid,
  p_linked_account_id uuid,
  p_note text,
  p_occurred_at timestamptz,
  p_person text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_txn_id uuid;
  v_acc_kind text;
  v_linked_kind text;
BEGIN
  SELECT kind INTO v_acc_kind FROM public.accounts WHERE id = p_account_id;
  IF v_acc_kind IS NULL THEN RAISE EXCEPTION 'account not found'; END IF;

  IF p_kind IN ('lent','repayment') THEN
    IF p_person IS NULL OR btrim(p_person) = '' THEN
      RAISE EXCEPTION 'person name is required for lent/repayment';
    END IF;
    -- Settlements are never categorized and never touch a linked card.
    p_category_id := NULL;
    p_linked_account_id := NULL;
  END IF;

  IF p_kind = 'investment' THEN
    -- An investment isn't consumption: no category, no linked card.
    p_category_id := NULL;
    p_linked_account_id := NULL;
  END IF;

  INSERT INTO public.transactions (amount, kind, account_id, category_id, linked_account_id, note, occurred_at, person)
  VALUES (
    p_amount,
    p_kind,
    p_account_id,
    p_category_id,
    p_linked_account_id,
    p_note,
    COALESCE(p_occurred_at, now()),
    NULLIF(btrim(p_person), '')
  )
  RETURNING id INTO v_txn_id;

  IF p_kind IN ('expense','investment') THEN
    -- Identical cash flow for both: out of the bank, or onto card debt.
    IF v_acc_kind = 'bank' THEN
      UPDATE public.accounts SET balance = balance - p_amount WHERE id = p_account_id;
    ELSE
      UPDATE public.accounts SET balance = balance + p_amount WHERE id = p_account_id;
    END IF;
  ELSIF p_kind = 'salary' THEN
    IF v_acc_kind <> 'bank' THEN RAISE EXCEPTION 'salary must credit a bank account'; END IF;
    UPDATE public.accounts SET balance = balance + p_amount WHERE id = p_account_id;
  ELSIF p_kind = 'card_payment' THEN
    IF v_acc_kind <> 'bank' THEN RAISE EXCEPTION 'card payment source must be bank'; END IF;
    IF p_linked_account_id IS NULL THEN RAISE EXCEPTION 'linked card required'; END IF;
    SELECT kind INTO v_linked_kind FROM public.accounts WHERE id = p_linked_account_id;
    IF v_linked_kind <> 'credit_card' THEN RAISE EXCEPTION 'linked account must be a credit card'; END IF;
    UPDATE public.accounts SET balance = balance - p_amount WHERE id = p_account_id;
    UPDATE public.accounts SET balance = balance - p_amount WHERE id = p_linked_account_id;
  ELSIF p_kind = 'lent' THEN
    -- Same cash movement as an expense — out of the bank, or onto card debt
    -- when paid from a credit card — but recorded as a receivable.
    IF v_acc_kind = 'bank' THEN
      UPDATE public.accounts SET balance = balance - p_amount WHERE id = p_account_id;
    ELSE
      UPDATE public.accounts SET balance = balance + p_amount WHERE id = p_account_id;
    END IF;
  ELSIF p_kind = 'repayment' THEN
    -- Money returned by someone; credits the receiving bank account without
    -- ever counting as income.
    IF v_acc_kind <> 'bank' THEN RAISE EXCEPTION 'repayment must credit a bank account'; END IF;
    UPDATE public.accounts SET balance = balance + p_amount WHERE id = p_account_id;
  END IF;

  RETURN v_txn_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_transaction(p_txn_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  t public.transactions%ROWTYPE;
  v_acc_kind text;
BEGIN
  SELECT * INTO t FROM public.transactions WHERE id = p_txn_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT kind INTO v_acc_kind FROM public.accounts WHERE id = t.account_id;

  IF t.kind IN ('expense','investment') THEN
    IF v_acc_kind = 'bank' THEN
      UPDATE public.accounts SET balance = balance + t.amount WHERE id = t.account_id;
    ELSE
      UPDATE public.accounts SET balance = balance - t.amount WHERE id = t.account_id;
    END IF;
  ELSIF t.kind = 'salary' THEN
    UPDATE public.accounts SET balance = balance - t.amount WHERE id = t.account_id;
  ELSIF t.kind = 'card_payment' THEN
    UPDATE public.accounts SET balance = balance + t.amount WHERE id = t.account_id;
    IF t.linked_account_id IS NOT NULL THEN
      UPDATE public.accounts SET balance = balance + t.amount WHERE id = t.linked_account_id;
    END IF;
  ELSIF t.kind = 'lent' THEN
    IF v_acc_kind = 'bank' THEN
      UPDATE public.accounts SET balance = balance + t.amount WHERE id = t.account_id;
    ELSE
      UPDATE public.accounts SET balance = balance - t.amount WHERE id = t.account_id;
    END IF;
  ELSIF t.kind = 'repayment' THEN
    UPDATE public.accounts SET balance = balance - t.amount WHERE id = t.account_id;
  END IF;

  DELETE FROM public.transactions WHERE id = p_txn_id;
END;
$$;
