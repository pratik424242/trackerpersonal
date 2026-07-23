
-- Accounts
CREATE TABLE public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bank','credit_card')),
  balance numeric NOT NULL DEFAULT 0,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO anon, authenticated;
GRANT ALL ON public.accounts TO service_role;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open accounts" ON public.accounts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Categories
CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  is_custom boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categories TO anon, authenticated;
GRANT ALL ON public.categories TO service_role;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open categories" ON public.categories FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Transactions
CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount numeric NOT NULL CHECK (amount > 0),
  kind text NOT NULL CHECK (kind IN ('expense','salary','card_payment')),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  linked_account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO anon, authenticated;
GRANT ALL ON public.transactions TO service_role;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open transactions" ON public.transactions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE INDEX transactions_occurred_at_idx ON public.transactions (occurred_at DESC);

-- Spending limits
CREATE TABLE public.spending_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL UNIQUE REFERENCES public.categories(id) ON DELETE CASCADE,
  monthly_limit numeric NOT NULL CHECK (monthly_limit >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spending_limits TO anon, authenticated;
GRANT ALL ON public.spending_limits TO service_role;
ALTER TABLE public.spending_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open limits" ON public.spending_limits FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.accounts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.categories;
ALTER PUBLICATION supabase_realtime ADD TABLE public.spending_limits;

-- Atomic apply/reverse of a transaction on balances
CREATE OR REPLACE FUNCTION public.apply_transaction(
  p_amount numeric,
  p_kind text,
  p_account_id uuid,
  p_category_id uuid,
  p_linked_account_id uuid,
  p_note text,
  p_occurred_at timestamptz
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

  INSERT INTO public.transactions (amount, kind, account_id, category_id, linked_account_id, note, occurred_at)
  VALUES (p_amount, p_kind, p_account_id, p_category_id, p_linked_account_id, p_note, COALESCE(p_occurred_at, now()))
  RETURNING id INTO v_txn_id;

  IF p_kind = 'expense' THEN
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

  IF t.kind = 'expense' THEN
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
  END IF;

  DELETE FROM public.transactions WHERE id = p_txn_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_transaction(numeric, text, uuid, uuid, uuid, text, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_transaction(uuid) TO anon, authenticated;
