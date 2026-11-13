import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  PackageCheck,
  PackageOpen,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageContainer, PageHeader, ReadOnlyNotice } from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import {
  countMyTasks,
  countOrdersToPack,
  countExpiringLots,
  countUnplacedStock,
  getDaySummary,
  getFirstSteps,
  listLowStock,
  listRecentMovements,
} from "@/modules/inventory";
import { listPurchaseOrders } from "@/modules/purchasing";
import { moduleRegistry } from "@/modules/registry";
import {
  getModuleAccess,
  getPlanOverview,
  renewalDaysLeft,
  renewalText,
  usageLevel,
} from "@/platform/billing";

import { DaySummaryBlock } from "./day-summary";
import { FirstStepsGuide } from "./first-steps-guide";

export const metadata: Metadata = { title: "Inicio" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** How many of each list fit at a glance. */
const SHOWN = 5;

/**
 * Home (INV-35, WMS-08): what needs attention today — first what each
 * role executes (its tasks, what arrives, what is stuck), then products to
 * restock and what moved last. The plan shows up only when it needs attention (KISS). Each
 * block appears only for who may see its section; all of it is read from
 * the same services as those sections.
 */
export default async function InicioPage() {
  const access = await getModuleAccess();
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const moduleState = access.moduleState("inventory");
  const inventory = moduleState !== "none";
  const showLow =
    inventory &&
    access.can("inventory.minimum.read") &&
    access.can("inventory.stock.read");
  const showMovements = inventory && access.can("inventory.movement.read");
  const showPlan = access.can("platform.plan.read");
  // The guide of first use (IMP-12) is for a company that can still be
  // set up: with the plan in read-only nothing of it could be done.
  const showGuide =
    moduleState === "active" && access.can("inventory.product.read");

  // WMS-08: what each role does first — its tasks, what arrives, what is
  // stuck — read from the same services as Tareas and Recepción.
  const showTasks = inventory && access.can("inventory.task.read");
  const showIncoming =
    access.moduleState("purchasing") !== "none" &&
    access.can("purchasing.receipt.read");

  // WMS-73: what the day has done so far, for who runs or supervises.
  const showSummary = inventory && access.can("inventory.summary.read");
  const summary = showSummary ? await getDaySummary(actor) : null;

  const [low, movements, plan, firstSteps, tasks, incoming] = await Promise.all(
    [
      showLow ? listLowStock(actor) : null,
      showMovements ? listRecentMovements(actor, { limit: SHOWN }) : null,
      showPlan ? getPlanOverview(moduleRegistry, actor.organizationId) : null,
      showGuide ? getFirstSteps(actor) : null,
      showTasks ? countMyTasks(actor) : null,
      showIncoming ? listPurchaseOrders(actor, { toReceive: true }) : null,
    ],
  );
  // WMS-72: only for who sees stock and can put it away, and only if any.
  const unplaced =
    inventory &&
    access.can("inventory.stock.read") &&
    access.allows("inventory.transfer.create")
      ? await countUnplacedStock(actor)
      : 0;
  // WMS-21: lots with stock that expired or are about to; only if any.
  const expiring =
    inventory && access.can("inventory.stock.read")
      ? await countExpiringLots(actor)
      : 0;
  // WMS-15: orders waiting to be packed, for who packs, only if any.
  const toPack =
    inventory &&
    access.can("inventory.outbound.read") &&
    access.allows("inventory.outbound.pack")
      ? await countOrdersToPack(actor)
      : 0;
  const executes = access.can("inventory.task.execute");
  const supervises = access.can("inventory.task.create");
  const today: {
    href: string;
    label: string;
    count: number;
    icon: LucideIcon;
    alert?: boolean;
  }[] = [
    ...(tasks && executes
      ? [
          {
            href: "/tareas?vista=mine",
            label: "Mis tareas",
            count: tasks.mine,
            icon: ClipboardList,
          },
          {
            href: "/tareas?vista=available",
            label: "Tareas disponibles",
            count: tasks.available,
            icon: ClipboardList,
          },
        ]
      : []),
    ...(tasks && supervises && tasks.blocked > 0
      ? [
          {
            href: "/tareas?vista=open",
            label: "Tareas con problema",
            count: tasks.blocked,
            icon: TriangleAlert,
            alert: true,
          },
        ]
      : []),
    ...(toPack > 0
      ? [
          {
            href: "/pedidos?estado=por-empacar",
            label: "Pedidos por empacar",
            count: toPack,
            icon: PackageCheck,
          },
        ]
      : []),
    ...(incoming
      ? [
          {
            href: "/recepcion",
            label: "Órdenes por recibir",
            count: incoming.total,
            icon: PackageOpen,
          },
        ]
      : []),
  ];

  const canEnter = access.allows("inventory.entry.create");
  const canExit = access.allows("inventory.exit.create");
  // With an empty catalog there is nothing to move yet: the guide below
  // says where to start, and these would only lead to an empty search.
  const emptyCatalog = firstSteps !== null && !firstSteps.hasProducts;
  const actions =
    (canEnter || canExit) && !emptyCatalog ? (
      <>
        {canEnter && (
          <Button asChild>
            <Link href="/movimientos/entrada">
              <ArrowDownToLine aria-hidden="true" data-icon="inline-start" />
              Registrar entrada
            </Link>
          </Button>
        )}
        {canExit && (
          <Button asChild variant="outline">
            <Link href="/movimientos/salida-rapida">
              <ArrowUpFromLine aria-hidden="true" data-icon="inline-start" />
              Registrar salida
            </Link>
          </Button>
        )}
      </>
    ) : undefined;
  const nothing = !low && !movements && !plan && !summary && today.length === 0;
  const products = plan?.products;
  const level = products ? usageLevel(products.used, products.limit) : "ok";
  // Day to day the plan is noise: it shows up only when it needs attention,
  // and in its last 15 days (founder, 2026-11-01).
  const daysLeft =
    plan?.status === "active" ? renewalDaysLeft(plan.validUntil) : null;
  const planNotice =
    plan?.status === "read_only"
      ? "Tu plan ya no está vigente: todo queda en solo lectura."
      : daysLeft !== null && plan?.validUntil
        ? renewalText(daysLeft, plan.validUntil)
        : products && products.limit !== null && level !== "ok"
          ? level === "full"
            ? `Llegaste al límite de tu plan: ${products.used.toLocaleString("es-MX")} de ${products.limit.toLocaleString("es-MX")} productos.`
            : `Ya usas ${products.used.toLocaleString("es-MX")} de ${products.limit.toLocaleString("es-MX")} productos de tu plan.`
          : null;

  return (
    <PageContainer>
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title={`Hola, ${access.user.name.split(" ")[0]}`}
        description={access.organization.name}
        actions={actions}
      />

      {planNotice && (
        <Link
          href="/configuracion/plan"
          className="flex min-h-11 items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm outline-none hover:bg-warning/15 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <CircleAlert
            aria-hidden="true"
            className={`mt-0.5 size-4 shrink-0 ${level === "full" || plan?.status === "read_only" || daysLeft === 0 ? "text-destructive" : "text-warning"}`}
          />
          <span className="flex-1">{planNotice}</span>
          {/* Not the primary blue: too little contrast on the warning tint. */}
          <span className="font-medium underline underline-offset-4">
            Ver mi plan
          </span>
        </Link>
      )}

      {unplaced > 0 && (
        <Link
          href="/inventario/sin-acomodar"
          className="flex min-h-11 items-center gap-2 rounded-xl border bg-card p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex-1">
            {unplaced === 1
              ? "1 producto sin acomodar."
              : `${unplaced.toLocaleString("es-MX")} productos sin acomodar.`}
          </span>
          <span className="font-medium text-primary">Ver cuáles</span>
        </Link>
      )}

      {expiring > 0 && (
        <Link
          href="/inventario/por-caducar"
          className="flex min-h-11 items-center gap-2 rounded-xl border bg-card p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex-1">
            {expiring === 1
              ? "1 lote por caducar."
              : `${expiring.toLocaleString("es-MX")} lotes por caducar.`}
          </span>
          <span className="font-medium text-primary">Ver cuáles</span>
        </Link>
      )}

      {nothing && (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground sm:p-5">
          Tu cuenta todavía no tiene secciones asignadas en esta empresa. Pide
          al titular o a un administrador que te dé un rol.
        </p>
      )}

      {firstSteps && !firstSteps.complete && (
        <FirstStepsGuide
          steps={firstSteps}
          can={{
            importProducts: access.allows("inventory.import.create"),
            createProduct: access.allows("inventory.product.create"),
            createLocation: access.allows("inventory.location.create"),
            openingBalance: access.allows("inventory.opening.create"),
            entry: canEnter,
            exit: canExit,
          }}
        />
      )}

      {today.length > 0 && (
        <section aria-labelledby="inicio-hoy" className="space-y-3">
          <h2 id="inicio-hoy" className="font-medium">
            Para hoy
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {today.map(({ href, label, count, icon: Icon, alert }) => (
              <li key={href + label}>
                <Link
                  href={href}
                  className={`flex min-h-24 flex-col justify-between gap-2 rounded-xl border p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 ${alert ? "border-warning/40 bg-warning/10" : "bg-card"}`}
                >
                  <Icon
                    aria-hidden="true"
                    className={`size-5 ${alert ? "text-warning" : "text-primary"}`}
                  />
                  <span>
                    <span className="block text-2xl font-semibold tabular-nums">
                      {count.toLocaleString("es-MX")}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {label}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary && (
        <DaySummaryBlock
          summary={summary}
          links={{
            movements: showMovements,
            tasks: showTasks,
            orders: access.can("inventory.outbound.read"),
          }}
        />
      )}

      <div className="grid gap-4">
        {low && (
          <section
            aria-labelledby="inicio-bajos"
            className="rounded-xl border bg-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-4 border-b px-4 py-2 sm:px-5">
              <h2
                id="inicio-bajos"
                className="flex items-center gap-2 font-medium"
              >
                Existencias bajas
                {low.total > 0 && (
                  <Badge variant="warning">
                    {low.total.toLocaleString("es-MX")}
                  </Badge>
                )}
              </h2>
              {low.total > 0 && (
                <Link href="/inventario/bajas" className={linkClass}>
                  Ver todas
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              )}
            </div>
            {low.total === 0 ? (
              <p className="flex items-start gap-2 p-4 text-sm text-muted-foreground sm:px-5">
                <CircleCheck
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-success"
                />
                {low.withMinimum === 0
                  ? "Pon un mínimo en un producto y aquí te avisamos cuando se esté acabando."
                  : "Todo está por encima de su mínimo."}
              </p>
            ) : (
              <ul className="divide-y">
                {low.items.slice(0, SHOWN).map((item) => (
                  <li key={item.productId}>
                    <Link
                      href={`/inventario/${item.productId}`}
                      className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                    >
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                        {item.name}
                      </span>
                      <span className="flex items-center gap-2 text-sm tabular-nums">
                        <Badge variant={item.empty ? "destructive" : "warning"}>
                          {item.empty ? "Agotado" : "Bajo"}
                        </Badge>
                        <span className="text-muted-foreground">
                          {item.stockLabel} de {item.minimumLabel}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {movements && (
          <section
            aria-labelledby="inicio-movimientos"
            className="rounded-xl border bg-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-4 border-b px-4 py-2 sm:px-5">
              <h2 id="inicio-movimientos" className="font-medium">
                Últimos movimientos
              </h2>
              {movements.length > 0 && (
                <Link href="/movimientos" className={linkClass}>
                  Ver historial
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              )}
            </div>
            {movements.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground sm:px-5">
                Todavía no hay movimientos.
              </p>
            ) : (
              <ul className="divide-y">
                {movements.map((movement) => {
                  const [first] = movement.lines;
                  return (
                    <li key={movement.id} className="space-y-1 p-4 sm:px-5">
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                        <Badge variant="secondary">{movement.typeLabel}</Badge>
                        {movement.reversedByMovementId && (
                          <Badge variant="outline">Reversado</Badge>
                        )}
                        <span>
                          <time dateTime={movement.createdAt.toISOString()}>
                            {formatDateTime(movement.createdAt)}
                          </time>
                          {" · "}
                          {movement.authorName ??
                            "Alguien que ya no está en el equipo"}
                        </span>
                      </p>
                      {first && (
                        <p className="flex items-start gap-2 [overflow-wrap:anywhere]">
                          {first.direction === "IN" ? (
                            <ArrowDownToLine
                              aria-hidden="true"
                              className="mt-1 size-4 shrink-0 text-success"
                            />
                          ) : (
                            <ArrowUpFromLine
                              aria-hidden="true"
                              className="mt-1 size-4 shrink-0 text-muted-foreground"
                            />
                          )}
                          <span>
                            <span className="sr-only">
                              {first.direction === "IN"
                                ? "Entran"
                                : "Salen"}{" "}
                            </span>
                            <span className="font-medium tabular-nums">
                              {first.quantity}
                            </span>{" "}
                            de {first.productName}
                            {movement.lines.length > 1 && (
                              <span className="text-muted-foreground">
                                {" "}
                                y{" "}
                                {movement.type === "TRANSFER" &&
                                movement.lines.length === 2
                                  ? `entran a ${movement.lines[1]!.location}`
                                  : movement.lines.length === 2
                                    ? "1 línea más"
                                    : `${movement.lines.length - 1} líneas más`}
                              </span>
                            )}
                          </span>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </PageContainer>
  );
}
