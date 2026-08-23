-- Investments: holdings tracked from monthly CAS statements (CDSL/NSDL
-- consolidated account statements). The statement is a full snapshot of
-- every demat holding and mutual fund folio, so `investments` is replaced
-- wholesale on each import rather than diffed — the snapshot history lives
-- in `portfolio_snapshots`.

CREATE TABLE public.securities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  isin text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('equity','etf','mutual_fund','sgb','bond','other')),
  nse_symbol text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.securities TO anon, authenticated;
GRANT ALL ON public.securities TO service_role;
ALTER TABLE public.securities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open securities" ON public.securities FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.investments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  security_id uuid NOT NULL REFERENCES public.securities(id) ON DELETE CASCADE,
  -- Where the units sit: "Zerodha · <BO ID>" for demat, "<RTA> · Folio X" for paper MFs.
  source text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  price numeric,
  value numeric,
  as_of_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (security_id, source)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.investments TO anon, authenticated;
GRANT ALL ON public.investments TO service_role;
ALTER TABLE public.investments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open investments" ON public.investments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date date NOT NULL UNIQUE,
  total_value numeric NOT NULL,
  holdings_count int NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'cas',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_snapshots TO anon, authenticated;
GRANT ALL ON public.portfolio_snapshots TO service_role;
ALTER TABLE public.portfolio_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "open snapshots" ON public.portfolio_snapshots FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.securities;
ALTER PUBLICATION supabase_realtime ADD TABLE public.investments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.portfolio_snapshots;
