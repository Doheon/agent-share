-- Migration 003: match_task_atomic stored procedure
-- Used by the match-task Edge Function to atomically lock and accept a task.
-- Runs SELECT FOR UPDATE SKIP LOCKED to prevent concurrent acceptance.

CREATE OR REPLACE FUNCTION public.match_task_atomic(
  p_task_id    UUID,
  p_acceptor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_task        public.tasks%ROWTYPE;
  v_balance     INTEGER;
  v_tx_id       UUID;
BEGIN
  -- Lock the task row exclusively; skip if already locked by another session
  SELECT * INTO v_task
  FROM public.tasks
  WHERE id = p_task_id
  FOR UPDATE SKIP LOCKED;

  -- If no row returned, another session is processing it or it doesn't exist
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Task is being processed by another session or does not exist');
  END IF;

  -- Task must be in 'open' state
  IF v_task.status <> 'open' THEN
    RETURN jsonb_build_object('success', false, 'reason', format('Task is not open (current status: %s)', v_task.status));
  END IF;

  -- Acceptor cannot be the requester
  IF v_task.requester_id = p_acceptor_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Acceptor cannot be the requester');
  END IF;

  -- Check requester balance (income - frozen >= credit_amount)
  SELECT COALESCE(income.total, 0) - COALESCE(frozen.total, 0)
  INTO v_balance
  FROM (SELECT 1) base
  LEFT JOIN (
    SELECT SUM(amount) AS total
    FROM public.transactions
    WHERE to_user_id = v_task.requester_id
      AND status IN ('released', 'signup_bonus')
  ) income ON true
  LEFT JOIN (
    SELECT SUM(amount) AS total
    FROM public.transactions
    WHERE from_user_id = v_task.requester_id
      AND status = 'escrowed'
  ) frozen ON true;

  IF v_balance IS NULL OR v_balance < v_task.credit_amount THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Requester has insufficient balance');
  END IF;

  -- Update task to running
  UPDATE public.tasks
  SET
    status      = 'running',
    acceptor_id = p_acceptor_id,
    accepted_at = NOW(),
    updated_at  = NOW()
  WHERE id = p_task_id;

  -- Insert escrowed transaction
  INSERT INTO public.transactions (task_id, from_user_id, to_user_id, amount, status)
  VALUES (p_task_id, v_task.requester_id, p_acceptor_id, v_task.credit_amount, 'escrowed')
  RETURNING id INTO v_tx_id;

  RETURN jsonb_build_object(
    'success', true,
    'task', jsonb_build_object(
      'id',          p_task_id,
      'acceptor_id', p_acceptor_id,
      'status',      'running',
      'tx_id',       v_tx_id
    )
  );
END;
$$;

-- Revoke public execute; only service role (via Edge Functions) should call this
REVOKE EXECUTE ON FUNCTION public.match_task_atomic(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.match_task_atomic(UUID, UUID) TO service_role;
