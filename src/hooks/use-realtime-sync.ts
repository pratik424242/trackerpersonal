import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useRealtimeSync() {
  const qc = useQueryClient();
  useEffect(() => {
    const channel = supabase
      .channel("finance-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, () => {
        qc.invalidateQueries({ queryKey: ["transactions"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "accounts" }, () => {
        qc.invalidateQueries({ queryKey: ["accounts"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "categories" }, () => {
        qc.invalidateQueries({ queryKey: ["categories"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "spending_limits" }, () => {
        qc.invalidateQueries({ queryKey: ["spending_limits"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "investments" }, () => {
        qc.invalidateQueries({ queryKey: ["investments"] });
      })
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "portfolio_snapshots" },
        () => {
          qc.invalidateQueries({ queryKey: ["portfolio_snapshots"] });
        },
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_settings" }, () => {
        qc.invalidateQueries({ queryKey: ["plan_settings"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_items" }, () => {
        qc.invalidateQueries({ queryKey: ["plan_items"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_pool_events" }, () => {
        qc.invalidateQueries({ queryKey: ["plan_pool_events"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [qc]);
}
