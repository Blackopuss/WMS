import { Check } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  stepAfter,
  stepBefore,
  waitsForCatalog,
  type SetupAbilities,
  type SetupPlan,
  type SetupStepKey,
  type SetupStepStatus,
} from "@/modules/inventory";

type Action = { href: string; label: string };

type StepText = {
  title: string;
  body: string;
  actions: Action[];
};

/** Title, explanation and the one or two ways to do each step. */
function stepText(
  key: SetupStepKey,
  can: SetupAbilities,
  view: "home" | "full",
): StepText {
  switch (key) {
    case "almacen":
      return {
        title: "Revisa tu almacén",
        body: "Ponle el nombre y el código con los que lo conoce tu equipo. Si tienes más de un almacén o sucursal, agrégalos aquí.",
        actions: [
          { href: "/configuracion/almacenes", label: "Revisar almacenes" },
        ],
      };
    case "ubicaciones":
      return {
        title: "Crea tus ubicaciones",
        body: "Zonas, pasillos o estantes: donde guardas lo que tienes. Si todo está en un solo lugar, salta este paso y usa «General».",
        actions: [
          { href: "/ubicaciones", label: "Crear ubicaciones" },
          ...(can.changeLevels
            ? [{ href: "/ubicaciones/niveles", label: "Cambiar niveles" }]
            : []),
        ],
      };
    case "equipo":
      return {
        title: "Invita a tu equipo",
        body: "Cada persona entra con su propia cuenta y su rol: ve y hace solo lo que le toca.",
        actions: [{ href: "/configuracion/equipo", label: "Invitar personas" }],
      };
    case "operacion":
      return {
        title: "Elige cómo trabaja tu almacén",
        body: "Unas cuantas decisiones que cambian el recorrido de todos los días. Si no eliges, se queda lo usual y puedes cambiarlo después.",
        actions:
          view === "home"
            ? [
                {
                  href: "/configuracion/inicial?paso=operacion",
                  label: "Elegir cómo trabaja",
                },
              ]
            : [],
      };
    case "productos":
      return {
        title: "Trae tus productos",
        body: "Sube tu Excel y entran todos de una vez, o agrégalos uno por uno.",
        actions: [
          ...(can.importProducts
            ? [{ href: "/inventario/importar", label: "Subir Excel" }]
            : []),
          ...(can.createProduct
            ? [{ href: "/inventario/nuevo", label: "Agregar uno a mano" }]
            : []),
        ],
      };
    case "existencias":
      return {
        title: "Di cuánto tienes",
        body: "Captura lo que hay hoy de cada producto. Se hace una sola vez; el Excel de productos también puede traer sus existencias.",
        actions: [
          ...(can.openingBalance
            ? [
                {
                  href: "/movimientos/saldo-inicial",
                  label: "Capturar existencias",
                },
              ]
            : []),
          ...(can.importProducts
            ? [{ href: "/inventario/importar", label: "Subir Excel" }]
            : []),
        ],
      };
    case "movimiento":
      return {
        title: "Registra tu primer movimiento",
        body: "Lo que llega es una entrada; lo que sale o se usa, una salida.",
        actions: [
          ...(can.entry
            ? [{ href: "/movimientos/entrada", label: "Registrar entrada" }]
            : []),
          ...(can.exit
            ? [
                {
                  href: "/movimientos/salida-rapida",
                  label: "Registrar salida",
                },
              ]
            : []),
        ],
      };
  }
}

const STATUS_TEXT: Record<SetupStepStatus, string> = {
  done: "listo",
  skipped: "saltado",
  current: "siguiente paso",
  pending: "pendiente",
};

const textLink =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The setup guide (IMP-12, WMS-43): one guide, shown compact on Inicio
 * (only the open step, with a way to skip it and to see all) and whole in
 * Configuración › Configuración inicial (any step opens with `?paso=`).
 * What is done, skipped or next comes from `planSetupSteps`; nothing is
 * stored (ADR 0083). Every action is offered only to who may do it.
 */
export function SetupGuide({
  plan,
  open,
  can,
  view,
  hrefFor,
  settings,
  hasProducts,
}: {
  plan: SetupPlan;
  /** The step shown open. */
  open: SetupStepKey | null;
  can: SetupAbilities;
  view: "home" | "full";
  /** Address that opens a step in this same view. */
  hrefFor: (key: SetupStepKey) => string;
  /** The settings of «Cómo trabaja tu almacén» (full view only). */
  settings?: React.ReactNode;
  /** The catalog has products: stock and movements need one. */
  hasProducts: boolean;
}) {
  const total = plan.steps.length;
  return (
    <section
      id="configura"
      aria-labelledby="configura-titulo"
      className="rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
        <h2 id="configura-titulo" className="font-medium">
          Configura tu empresa
        </h2>
        <p className="text-sm text-muted-foreground tabular-nums">
          {plan.done} de {total} listos
        </p>
      </div>
      <ol className="divide-y">
        {plan.steps.map((step, index) => {
          const waits = waitsForCatalog(step.key, { hasProducts });
          const text = waits
            ? {
                ...stepText(step.key, can, view),
                body:
                  can.importProducts || can.createProduct
                    ? "Primero agrega tus productos: sin ellos no hay nada que capturar ni mover."
                    : "Todavía no hay productos en el catálogo. Pídele a quien lleva el inventario en tu empresa que los agregue.",
                actions: [],
              }
            : stepText(step.key, can, view);
          const isOpen = step.key === open;
          const next = stepAfter(plan, step.key);
          const previous = stepBefore(plan, step.key);
          const done = step.status === "done";
          return (
            <li
              key={step.key}
              aria-current={isOpen ? "step" : undefined}
              className="flex items-start gap-3 p-4 sm:px-5"
            >
              <span
                aria-hidden="true"
                className={`mt-2.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                  done
                    ? "bg-success/15 text-success"
                    : isOpen
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? <Check className="size-4" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                <p className="flex min-h-11 flex-wrap items-center gap-x-2">
                  {view === "full" && !isOpen ? (
                    <Link
                      href={hrefFor(step.key)}
                      className={`inline-flex min-h-11 items-center rounded-lg underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 ${
                        done ? "text-muted-foreground" : ""
                      }`}
                    >
                      {text.title}
                    </Link>
                  ) : (
                    <span
                      className={
                        isOpen
                          ? "font-medium"
                          : done
                            ? "text-muted-foreground"
                            : undefined
                      }
                    >
                      {text.title}
                    </span>
                  )}
                  {step.status === "skipped" ? (
                    <span className="text-sm text-muted-foreground">
                      (saltado)
                    </span>
                  ) : (
                    <span className="sr-only">
                      {` (${STATUS_TEXT[step.status]})`}
                    </span>
                  )}
                </p>
                {isOpen && (
                  <>
                    <p className="text-sm text-muted-foreground">{text.body}</p>
                    {text.actions.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {text.actions.map((action, position) => (
                          <Button
                            key={action.href + action.label}
                            asChild
                            variant={
                              position === 0 && !done ? "default" : "outline"
                            }
                          >
                            <Link href={action.href}>{action.label}</Link>
                          </Button>
                        ))}
                      </div>
                    )}
                    {view === "full" && step.key === "operacion" && settings}
                    <div className="flex flex-wrap gap-x-5">
                      {next && (
                        <Link href={hrefFor(next)} className={textLink}>
                          {done ? "Siguiente paso" : "Saltar este paso"}
                        </Link>
                      )}
                      {view === "full" && previous && (
                        <Link href={hrefFor(previous)} className={textLink}>
                          Paso anterior
                        </Link>
                      )}
                      {view === "home" && (
                        <Link
                          href="/configuracion/inicial"
                          className={textLink}
                        >
                          Ver todos los pasos
                        </Link>
                      )}
                    </div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
