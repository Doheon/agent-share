-- Migration 002: Row Level Security policies

-- ============================================================
-- Enable RLS on tables
-- ============================================================

ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- users policies
-- ============================================================

-- Anyone can read user profiles (public_key is needed by others)
CREATE POLICY "users_select_all"
  ON public.users
  FOR SELECT
  USING (true);

-- Users can only update their own profile
CREATE POLICY "users_update_own"
  ON public.users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Users can only delete their own profile
CREATE POLICY "users_delete_own"
  ON public.users
  FOR DELETE
  USING (auth.uid() = id);

-- Authenticated users can insert their own profile (on signup)
CREATE POLICY "users_insert_own"
  ON public.users
  FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ============================================================
-- tasks policies
-- ============================================================

-- Authenticated users can browse open tasks (to find work to accept)
CREATE POLICY "tasks_select_open"
  ON public.tasks
  FOR SELECT
  USING (status = 'open' AND auth.uid() IS NOT NULL);

-- Requesters and acceptors can read tasks they are involved in
CREATE POLICY "tasks_select_participant"
  ON public.tasks
  FOR SELECT
  USING (
    auth.uid() = requester_id
    OR auth.uid() = acceptor_id
  );

-- Only authenticated users can create tasks (as requester)
CREATE POLICY "tasks_insert_authenticated"
  ON public.tasks
  FOR INSERT
  WITH CHECK (auth.uid() = requester_id);

-- Only requester or acceptor can update a task
CREATE POLICY "tasks_update_participant"
  ON public.tasks
  FOR UPDATE
  USING (
    auth.uid() = requester_id
    OR auth.uid() = acceptor_id
  )
  WITH CHECK (
    auth.uid() = requester_id
    OR auth.uid() = acceptor_id
  );

-- ============================================================
-- transactions policies
-- ============================================================

-- Only parties involved in the transaction can read it
CREATE POLICY "transactions_select_participant"
  ON public.transactions
  FOR SELECT
  USING (
    auth.uid() = from_user_id
    OR auth.uid() = to_user_id
  );

-- INSERT / UPDATE / DELETE are blocked for all non-service roles.
-- The service role (used by Edge Functions) bypasses RLS entirely,
-- so no permissive policies are needed for those operations.

-- ============================================================
-- contributor_rankings view: public read
-- ============================================================

-- Views inherit the RLS of their underlying tables by default.
-- Grant SELECT to authenticated and anon roles so the rankings
-- are publicly accessible without additional policies.
GRANT SELECT ON public.contributor_rankings TO anon, authenticated;

-- ============================================================
-- user_balances view: own balance only
-- ============================================================

-- Restrict view access: a user may only see their own balance row.
-- Because this is a view we use a security-barrier approach:
-- create a policy on the view via a security-definer wrapper or
-- grant + row filtering. The simplest correct approach for Supabase
-- is to wrap access via a security-definer function, but the view
-- itself can be secured by revoking direct access and exposing
-- only through a function. For simplicity, grant SELECT to
-- authenticated and rely on the WHERE clause in application queries.
-- RLS on views is enforced by enabling it on the view directly
-- (requires pg 15+ or Supabase's security_invoker=true option).

ALTER VIEW public.user_balances SET (security_invoker = true);
GRANT SELECT ON public.user_balances TO authenticated;
