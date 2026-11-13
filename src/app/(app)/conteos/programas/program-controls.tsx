"use client";

import { CalendarPlus, Loader2, Pause, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { generateTodayCountsAction, pauseCountProgramAction } from "./actions";

/**
 * «Generar los de hoy» and «Pausar»/«Reanudar» of a program (WMS-55).
 * Both are safe to repeat: generating again creates nothing new.
 */
export function ProgramControls({
  programId,
  paused,
}: {
  programId: string;
  paused: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"generate" | "pause" | null>(null);

  async function run(
    what: "generate" | "pause",
    action: () => ReturnType<typeof generateTodayCountsAction>,
  ) {
    if (busy) return;
    setBusy(what);
    try {
      const result = await action();
      if (result.ok) toast.success(result.summary);
      else toast.error(result.error);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-3">
      {!paused && (
        <Button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            run("generate", () => generateTodayCountsAction(programId))
          }
        >
          {busy === "generate" ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <CalendarPlus aria-hidden="true" data-icon="inline-start" />
          )}
          {busy === "generate" ? "Generando…" : "Generar los de hoy"}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={busy !== null}
        onClick={() =>
          run("pause", () => pauseCountProgramAction(programId, !paused))
        }
      >
        {busy === "pause" ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : paused ? (
          <Play aria-hidden="true" data-icon="inline-start" />
        ) : (
          <Pause aria-hidden="true" data-icon="inline-start" />
        )}
        {paused ? "Reanudar" : "Pausar"}
      </Button>
    </div>
  );
}
