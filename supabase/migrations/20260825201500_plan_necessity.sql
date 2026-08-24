-- Plan mode v2: the affordability engine now distinguishes needs from wants.
-- A need only asks "is there budget/cash room?" — a want is judged against
-- the month's free cash (income − budget − savings goal) so small impulse
-- purchases can't hide behind leftover budget. Existing items default to
-- 'want', the stricter lens.

ALTER TABLE public.plan_items ADD COLUMN necessity text NOT NULL DEFAULT 'want';
ALTER TABLE public.plan_items ADD CONSTRAINT plan_items_necessity_check
  CHECK (necessity IN ('need','want'));
