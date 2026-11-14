import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import { webhookEventTypes } from "@/modules/registry";
import {
  API_CAPABILITIES,
  API_KEY_LIFETIMES,
  DEFAULT_KEY_REQUESTS_PER_MINUTE,
  WEBHOOKS_LIMITED_MESSAGE,
  companyRequestsPerMinute,
  listApiKeys,
  listWebhookEndpoints,
} from "@/platform/api";
import { can, loadSubject } from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import { getActiveFacility, listFacilities } from "@/platform/locations";

import {
  EndpointCommands,
  EndpointForm,
  KeyForm,
  RevokeKeyButton,
} from "./forms";

export const metadata: Metadata = { title: "API y webhooks" };

const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const KEY_STATE = {
  active: { label: "Activa", variant: "success" },
  expired: { label: "Caducó", variant: "warning" },
  revoked: { label: "Revocada", variant: "secondary" },
} as const;

const DELIVERY_STATE = {
  PENDING: "En camino",
  DELIVERED: "Entregado",
  FAILED: "Falló",
  SKIPPED: "No se mandó",
} as const;

/**
 * API keys and webhook destinations of the company (WMS-60, ADR 0058),
 * for who has `platform.api.manage` (titular and Administración). Secrets
 * are shown once, when created; this page never has them.
 */
export default async function ApiPage() {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/configuracion"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
    </Link>
  );
  if (!access.can("platform.api.manage")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const [keys, hooks, facilities, active, subject, companyRate] =
    await Promise.all([
      listApiKeys(actor),
      listWebhookEndpoints(actor),
      access.hasModule("inventory")
        ? listFacilities(actor)
        : Promise.resolve([]),
      access.hasModule("inventory")
        ? getActiveFacility(actor)
        : Promise.resolve(null),
      loadSubject(actor.organizationId, actor.userId),
      companyRequestsPerMinute(actor.organizationId),
    ]);
  // Only what the person could give: a key never has more than its creator.
  const capabilities = API_CAPABILITIES.filter((each) =>
    each.permissions.every((permission) => can(subject, permission)),
  ).map((each) => ({ key: each.key, label: each.label }));
  const events = webhookEventTypes
    .filter((type) => access.moduleState(type.module) !== "none")
    .map((type) => ({
      key: type.key,
      label: type.label,
      description: type.description,
    }));
  const endpoints = hooks.endpoints;
  const labelOf = new Map(
    webhookEventTypes.map((type) => [type.key, type.label]),
  );

  return (
    <PageContainer>
      {back}
      <PageHeader title="API y webhooks" />
      <p>
        <a href="/api/v1/openapi.json" className={linkClass}>
          Ver la documentación de la API (OpenAPI)
        </a>
      </p>

      <section aria-labelledby="llaves" className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="llaves" className="text-lg font-semibold">
            Llaves
          </h2>
          {active && capabilities.length > 0 && (
            <KeyForm
              capabilities={capabilities}
              facilities={facilities.map((each) => ({
                id: each.id,
                name: each.name,
              }))}
              defaultFacilityId={active.id}
              lifetimes={[...API_KEY_LIFETIMES]}
              defaultRate={Math.min(
                DEFAULT_KEY_REQUESTS_PER_MINUTE,
                companyRate,
              )}
              companyRate={companyRate}
            />
          )}
        </div>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay llaves.
          </p>
        ) : (
          <ul className="space-y-3">
            {keys.map((key) => (
              <li
                key={key.id}
                className="space-y-3 rounded-xl border bg-card p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{key.name}</p>
                  <code className="text-sm text-muted-foreground">
                    {key.prefix}…
                  </code>
                  <Badge variant={KEY_STATE[key.state].variant}>
                    {KEY_STATE[key.state].label}
                  </Badge>
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="inline text-muted-foreground">Puede: </dt>
                    <dd className="inline">
                      {key.capabilities.map((each) => each.label).join(", ")}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Almacén: </dt>
                    <dd className="inline">
                      {key.facilityName}
                      {key.facilityOnly ? " (solo ese)" : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">
                      Llamadas por minuto:{" "}
                    </dt>
                    <dd className="inline">{key.requestsPerMinute}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">
                      Último uso:{" "}
                    </dt>
                    <dd className="inline">
                      {key.lastUsedAt
                        ? formatDateTime(key.lastUsedAt)
                        : "Nunca"}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">La creó: </dt>
                    <dd className="inline">
                      {key.createdByName ??
                        "Alguien que ya no está en la empresa"}
                    </dd>
                  </div>
                  {key.expiresAt && (
                    <div>
                      <dt className="inline text-muted-foreground">Caduca: </dt>
                      <dd className="inline">
                        {formatDateTime(key.expiresAt)}
                      </dd>
                    </div>
                  )}
                </dl>
                {key.state === "active" && (
                  <RevokeKeyButton keyId={key.id} name={key.name} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="webhooks" className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="webhooks" className="text-lg font-semibold">
            Webhooks
          </h2>
          {!hooks.limited && events.length > 0 && (
            <EndpointForm events={events} />
          )}
        </div>
        {hooks.limited ? (
          <p className="text-sm text-muted-foreground">
            {WEBHOOKS_LIMITED_MESSAGE}
          </p>
        ) : endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay destinos.
          </p>
        ) : (
          <ul className="space-y-3">
            {endpoints.map((endpoint) => (
              <li
                key={endpoint.id}
                className="space-y-3 rounded-xl border bg-card p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {endpoint.url}
                  </p>
                  <Badge
                    variant={
                      endpoint.status === "ACTIVE" ? "success" : "warning"
                    }
                  >
                    {endpoint.status === "ACTIVE"
                      ? "Activo"
                      : endpoint.pausedByFailures
                        ? "En pausa por fallas"
                        : "En pausa"}
                  </Badge>
                </div>
                {endpoint.description && (
                  <p className="text-sm text-muted-foreground">
                    {endpoint.description}
                  </p>
                )}
                <p className="text-sm">
                  <span className="text-muted-foreground">Recibe: </span>
                  {endpoint.events
                    .map((key) => labelOf.get(key) ?? key)
                    .join(", ")}
                </p>
                {endpoint.deliveries.length > 0 && (
                  <details>
                    <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
                      Últimas entregas
                    </summary>
                    <ul className="divide-y text-sm">
                      {endpoint.deliveries.map((delivery) => (
                        <li
                          key={delivery.id}
                          className="flex flex-wrap gap-x-3 gap-y-1 py-2"
                        >
                          <span>
                            {labelOf.get(delivery.eventType) ??
                              delivery.eventType}
                          </span>
                          <span className="font-medium">
                            {DELIVERY_STATE[delivery.status]}
                          </span>
                          <span className="text-muted-foreground">
                            {formatDateTime(
                              delivery.lastAttemptAt ?? delivery.createdAt,
                            )}
                            {delivery.attempts > 1
                              ? ` · ${delivery.attempts} intentos`
                              : ""}
                            {delivery.lastStatusCode
                              ? ` · ${delivery.lastStatusCode}`
                              : ""}
                          </span>
                          {delivery.reason &&
                            delivery.status !== "DELIVERED" && (
                              <span className="basis-full text-muted-foreground">
                                {delivery.reason}
                              </span>
                            )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <EndpointCommands
                  endpointId={endpoint.id}
                  paused={endpoint.status === "PAUSED"}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
