-- Migration 001: Core schema
-- users, tasks, transactions tables
-- user_balances and contributor_rankings views
-- updated_at auto-update trigger

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Tables
-- ============================================================

-- users table (extends auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- tasks table
CREATE TABLE IF NOT EXISTS public.tasks (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requester_id        UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  acceptor_id         UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','running','review','approved','rejected','cancelled')),
  encrypted_blob_url  TEXT,
  encrypted_aes_key   TEXT,
  diff_result         TEXT,
  credit_amount       INTEGER NOT NULL CHECK (credit_amount > 0),
  prompt              TEXT,
  allowed_hosts       TEXT[],
  accepted_at         TIMESTAMPTZ,
  diff_received_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- transactions table
CREATE TABLE IF NOT EXISTS public.transactions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     UUID REFERENCES public.tasks(id) ON DELETE RESTRICT,
  from_user_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  to_user_id  UUID REFERENCES public.users(id) ON DELETE RESTRICT,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  status      TEXT NOT NULL
                CHECK (status IN ('escrowed','released','refunded','signup_bonus')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Indexes for common query patterns
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tasks_requester_id   ON public.tasks(requester_id);
CREATE INDEX IF NOT EXISTS idx_tasks_acceptor_id    ON public.tasks(acceptor_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status         ON public.tasks(status);
CREATE INDEX IF NOT EXISTS idx_transactions_from    ON public.transactions(from_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to      ON public.transactions(to_user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_task    ON public.transactions(task_id);

-- ============================================================
-- Views
-- ============================================================

-- user_balances: total balance per user
-- Income  = released + signup_bonus (received as to_user_id)
-- Frozen  = escrowed (sent as from_user_id, not yet settled)
-- Balance = income - frozen
CREATE OR REPLACE VIEW public.user_balances AS
SELECT
  u.id AS user_id,
  COALESCE(income.total, 0) AS income,
  COALESCE(frozen.total, 0) AS frozen,
  COALESCE(income.total, 0) - COALESCE(frozen.total, 0) AS balance
FROM public.users u
LEFT JOIN (
  SELECT to_user_id, SUM(amount) AS total
  FROM public.transactions
  WHERE status IN ('released', 'signup_bonus')
  GROUP BY to_user_id
) income ON income.to_user_id = u.id
LEFT JOIN (
  SELECT from_user_id, SUM(amount) AS total
  FROM public.transactions
  WHERE status = 'escrowed'
  GROUP BY from_user_id
) frozen ON frozen.from_user_id = u.id;

-- contributor_rankings: total released earnings per contributor (acceptor)
CREATE OR REPLACE VIEW public.contributor_rankings AS
SELECT
  to_user_id AS user_id,
  SUM(amount) AS total_earned,
  COUNT(*) AS tasks_completed,
  ROW_NUMBER() OVER (ORDER BY SUM(amount) DESC) AS rank
FROM public.transactions
WHERE status = 'released'
GROUP BY to_user_id
ORDER BY total_earned DESC;

-- ============================================================
-- updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON public.tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
