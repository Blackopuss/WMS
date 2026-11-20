import { Info } from "lucide-react";

/**
 * Said on every screen of a demonstration company (WMS-44, ADR 0089):
 * the data is fictitious. Discreet: one line, no actions.
 */
export function DemoNotice() {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/60 px-4 py-2 text-sm text-muted-foreground sm:px-6">
      <Info aria-hidden="true" className="size-4 shrink-0" />
      <p>
        <span className="font-medium text-foreground">
          Empresa de demostración:
        </span>{" "}
        los datos son ficticios.
      </p>
    </div>
  );
}
