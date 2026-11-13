import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageContainer, PageHeader } from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notificationTypes } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { getNotificationPreferences } from "@/platform/notifications";

import { setNotificationPreferenceAction } from "./actions";

export const metadata: Metadata = { title: "Avisos que recibo" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * What notices the person receives (WMS-39, ADR 0057): each type of the
 * modules the company has, on or off. Only the person's own choice; there
 * is one channel today (inside the app).
 */
export default async function AvisosPreferenciasPage() {
  // Every member chooses for themselves.
  const access = await getModuleAccess();
  const preferences = await getNotificationPreferences(
    { organizationId: access.organization.id, userId: access.user.id },
    notificationTypes,
    (moduleId) => access.moduleState(moduleId) !== "none",
  );

  return (
    <PageContainer>
      <Link href="/configuracion" className={backClass}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        Configuración
      </Link>
      <PageHeader title="Avisos que recibo" />
      <ul className="max-w-3xl divide-y rounded-xl border bg-card">
        {preferences.map((preference) => (
          <li
            key={preference.key}
            className="flex flex-wrap items-center gap-3 p-4 sm:px-5"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {preference.label}
                <Badge variant={preference.enabled ? "secondary" : "outline"}>
                  {preference.enabled ? "Lo recibo" : "No lo recibo"}
                </Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                {preference.description}
              </p>
            </div>
            <form action={setNotificationPreferenceAction}>
              <input type="hidden" name="type" value={preference.key} />
              <input
                type="hidden"
                name="enabled"
                value={preference.enabled ? "0" : "1"}
              />
              <Button type="submit" variant="outline">
                {preference.enabled ? "Dejar de recibir" : "Volver a recibir"}
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </PageContainer>
  );
}
