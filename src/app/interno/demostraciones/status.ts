import type { DemoCompanyView } from "@/platform/billing";

/** How a demonstration is doing, in words (WMS-44). */
export function demoStatusText(
  demo: Pick<DemoCompanyView, "status" | "validUntil">,
  now: Date,
): string {
  if (demo.status === "PREPARING") return "Preparando";
  if (demo.status === "FAILED") return "No se pudo preparar";
  if (demo.validUntil && demo.validUntil <= now) {
    return "Vencida (solo lectura)";
  }
  return "Lista";
}
