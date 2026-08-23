-- Folio-level hiding: lets the user park holdings they don't want counted
-- in portfolio totals or lists (e.g. a folio being wound down) without
-- deleting the row or losing its history.
ALTER TABLE public.investments ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
