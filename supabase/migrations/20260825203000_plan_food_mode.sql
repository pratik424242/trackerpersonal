-- Plan mode v3: the planner is scoped to food choices only. Verdicts are
-- judged against a configurable daily food budget (replacing the hardcoded
-- ₹300 from the Insights food card, which now reads this setting). Income /
-- budget / savings-goal columns stay in the schema unused — they cost
-- nothing and avoid a destructive migration.

ALTER TABLE public.plan_settings ADD COLUMN food_daily_budget numeric NOT NULL DEFAULT 300 CHECK (food_daily_budget > 0);
