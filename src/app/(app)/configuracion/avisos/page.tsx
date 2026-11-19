import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notificationTypes } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import {
  companySendsNoticeEmails,
  getNotificationPreferences,
  type NotificationPreferenceView,
} from "@/platform/notifications";

import { setNotificationPreferenceAction } from "./actions";

export const metadata: Metadata = { title: "Avisos que recibo" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** «Lo recibo en la app y por correo», «No lo recibo»… */
function receivedLabel(preference: NotificationPreferenceView): string {
  if (preference.emailOnly) {
    return preference.email ? "Lo recibo por correo" : "No lo recibo";
  }
  if (!preference.enabled) return "No lo recibo";
  return preference.email ? "En la app y por correo" : "En la app";
}

function ToggleForm({
  type,
  channel,
  enabled,
  label,
}: {
  type: string;
  channel: "app" | "email";
  enabled: boolean;
  label: string;
}) {
  return (
    <form action={setNotificationPreferenceAction}>
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="enabled" value={enabled ? "1" : "0"} />
      <Button type="submit" variant="outline">
        {label}
      </Button>
    </form>
  );
}

/**
 * What notices the person receives (WMS-39, ADR 0057): each type of the
 * modules the company has, on or off, and whether it also arrives by mail
 * (WMS-39B, ADR 0060; off unless the person asks, and only while the
 * company keeps the channel on). Only the person's own choice.
 */
export default async function AvisosPreferenciasPage() {
  // Every member chooses for themselves.
  const access = await getModuleAccess();
  const [all, byMail] = await Promise.all([
    getNotificationPreferences(
      { organizationId: access.organization.id, userId: access.user.id },
      notificationTypes,
      (moduleId) => access.moduleState(moduleId) !== "none",
    ),
    companySendsNoticeEmails(access.organization.id),
  ]);
  const preferences = all.filter(
    (preference) =>
      (preference.visibleWith.length === 0 ||
        preference.visibleWith.some((permission) => access.can(permission))) &&
      // A summary only by mail does not exist while mail is off.
      (byMail || !preference.emailOnly),
  );

  return (
    <PageContainer>
      <Link href="/configuracion" className={backClass}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        Configuración
      </Link>
      <PageHeader title="Avisos que recibo" />
      {!byMail ? (
        <p className="max-w-3xl text-sm text-muted-foreground">
          Tu empresa no manda avisos por correo: solo los ves aquí en la app.
        </p>
      ) : null}
      <ul className="max-w-3xl divide-y rounded-xl border bg-card">
        {preferences.map((preference) => {
          const on = preference.emailOnly
            ? preference.email
            : preference.enabled;
          return (
            <li
              key={preference.key}
              className="flex flex-wrap items-center gap-3 p-4 sm:px-5"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {preference.label}
                  <Badge variant={on ? "secondary" : "outline"}>
                    {receivedLabel(preference)}
                  </Badge>
                </p>
                <p className="text-sm text-muted-foreground">
                  {preference.description}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {preference.emailOnly ? (
                  <ToggleForm
                    type={preference.key}
                    channel="email"
                    enabled={!preference.email}
                    label={
                      preference.email
                        ? "Dejar de recibir"
                        : "Recibir por correo"
                    }
                  />
                ) : (
                  <>
                    {byMail && preference.enabled && !preference.appOnly ? (
                      <ToggleForm
                        type={preference.key}
                        channel="email"
                        enabled={!preference.email}
                        label={
                          preference.email
                            ? "Dejar de recibir por correo"
                            : "Recibir también por correo"
                        }
                      />
                    ) : null}
                    <ToggleForm
                      type={preference.key}
                      channel="app"
                      enabled={!preference.enabled}
                      label={
                        preference.enabled
                          ? "Dejar de recibir"
                          : "Volver a recibir"
                      }
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </PageContainer>
  );
}
