import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { taskId, acceptorId } = await req.json();

    if (!taskId || !acceptorId) {
      return new Response(
        JSON.stringify({ error: "taskId and acceptorId are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Use service role client to bypass RLS for atomic operations
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Run everything in a single transaction via rpc, or use sequential
    // operations with SELECT FOR UPDATE SKIP LOCKED semantics.
    // Supabase JS does not expose raw transactions; use a stored procedure
    // or perform the lock via a raw query through the REST SQL endpoint.
    // We use the Postgres function approach via rpc.

    const { data, error } = await supabase.rpc("match_task_atomic", {
      p_task_id: taskId,
      p_acceptor_id: acceptorId,
    });

    if (error) {
      console.error("match_task_atomic error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!data || data.success === false) {
      return new Response(
        JSON.stringify({ error: data?.reason ?? "Task could not be matched" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ success: true, task: data.task }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
