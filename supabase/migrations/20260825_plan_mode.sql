-- Plan mode: a virtual planning layer kept fully separate from the ledger.
-- The user states expected income, usual monthly budget and a savings goal,
-- then parks intended purchases on a wishlist. Each purchase gets an
-- affordability verdict against the plan and this month's actuals. Money
-- "saved by not buying" (skipping an affordable purchase) accumulates in a
-- virtual pool; when it reaches the invest threshold (default 1000) it's
-- marked invested. None of this moves account balances — the pool is a
-- discipline tracker, like the food-budget score, so balances stay honest
-- and real cash flow stays in `transactions`.

CREATE TABLE public.plan_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  expected_income numeric NOT NULL DEFAULT 0 CHECK (expected_income >= 0),
  monthly_budget numeric NOT NULL DEFAULT 0 CHECK (monthly_budget >= 0),
  savings_goal numeric NOT NULL DEFAULT 0 CHECK (savings_goal >= 0),
  invest_threshold numeric NOT NULL DEFAULT 1000 CHECK (invest_threshold > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_settings TO anon, authenticated;
GRANT ALL ON public.plan_settings TO service_role;
ALTER TABLE public.plan_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open plan_settings" ON public.plan_settings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  price numeric NOT NULL CHECK (price > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','bought','skipped')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_items TO anon, authenticated;
GRANT ALL ON public.plan_items TO service_role;
ALTER TABLE public.plan_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open plan_items" ON public.plan_items FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.plan_pool_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount numeric NOT NULL CHECK (amount <> 0),
  kind text NOT NULL CHECK (kind IN ('skip','manual','withdraw','invest')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plan_pool_events TO anon, authenticated;
GRANT ALL ON public.plan_pool_events TO service_role;
ALTER TABLE public.plan_pool_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open plan_pool_events" ON public.plan_pool_events FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.plan_settings;
ALTER PUBLICATION supabase_realtime ADD TABLE public.plan_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.plan_pool_events;
