"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/**
 * The label of a container, big and easy to read out or copy (WMS-53).
 * Printing it: «Imprimir etiqueta» (WMS-26).
 */
export function CopyCode({ code }: { code: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p
        className="font-mono text-2xl font-semibold tracking-wide [overflow-wrap:anywhere]"
        aria-label={`Etiqueta ${code}`}
      >
        {code}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            toast.success("Etiqueta copiada.");
          } catch {
            toast.error("No se pudo copiar. Selecciónala y cópiala a mano.");
          }
        }}
      >
        <Copy aria-hidden="true" data-icon="inline-start" />
        Copiar etiqueta
      </Button>
    </div>
  );
}
