import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Called by Supabase cron (pg_cron) every 5 minutes via HTTP invoke.
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const releaseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/release-credit`;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const results = {
      autoApproved: 0,
      timedOut: 0,
      errors: [] as string[],
    };

    // ----------------------------------------------------------------
    // 1. Auto-approve tasks in 'review' for more than 48 hours
    // ----------------------------------------------------------------
    const { data: staleReviews, error: reviewErr } = await supabase
      .from("tasks")
      .select("id")
      .eq("status", "review")
      .lt("diff_received_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

    if (reviewErr) {
      console.error("Error fetching stale reviews:", reviewErr);
      results.errors.push(`fetch stale reviews: ${reviewErr.message}`);
    } else if (staleReviews && staleReviews.length > 0) {
      for (const task of staleReviews) {
        try {
          const res = await fetch(releaseUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${serviceKey}`,
              "apikey": serviceKey,
            },
            body: JSON.stringify({ taskId: task.id, action: "approve" }),
          });

          if (!res.ok) {
            const body = await res.text();
            console.error(`Auto-approve failed for task ${task.id}:`, body);
            results.errors.push(`auto-approve ${task.id}: ${body}`);
          } else {
            results.autoApproved++;
          }
        } catch (err) {
          console.error(`Auto-approve fetch error for task ${task.id}:`, err);
          results.errors.push(`auto-approve fetch ${task.id}: ${String(err)}`);
        }
      }
    }

    // ----------------------------------------------------------------
    // 2. Cancel tasks stuck in 'running' for more than 30 minutes
    // ----------------------------------------------------------------
    const { data: timedOutTasks, error: timeoutErr } = await supabase
      .from("tasks")
      .select("id")
      .eq("status", "running")
      .lt("accepted_at", new Date(Date.now() - 30 * 60 * 1000).toISOString());

    if (timeoutErr) {
      console.error("Error fetching timed-out tasks:", timeoutErr);
      results.errors.push(`fetch timed-out tasks: ${timeoutErr.message}`);
    } else if (timedOutTasks && timedOutTasks.length > 0) {
      for (const task of timedOutTasks) {
        // Update escrowed transaction to refunded
        const { error: txErr } = await supabase
          .from("transactions")
          .update({ status: "refunded" })
          .eq("task_id", task.id)
          .eq("status", "escrowed");

        if (txErr) {
          console.error(`Refund transaction failed for task ${task.id}:`, txErr);
          results.errors.push(`refund ${task.id}: ${txErr.message}`);
          continue;
        }

        // Update task status to cancelled
        const { error: taskErr } = await supabase
          .from("tasks")
          .update({ status: "cancelled" })
          .eq("id", task.id)
          .eq("status", "running"); // guard against race

        if (taskErr) {
          console.error(`Cancel task failed for task ${task.id}:`, taskErr);
          results.errors.push(`cancel ${task.id}: ${taskErr.message}`);
          continue;
        }

        results.timedOut++;
      }
    }

    return new Response(JSON.stringify({ success: true, ...results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected error in auto-approve:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
