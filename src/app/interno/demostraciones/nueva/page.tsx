import { PageContainer, PageHeader } from "@/components/states";
import {
  DEMO_DEFAULT_NAME,
  DEMO_PLAN,
  requirePlatformStaff,
} from "@/platform/billing";

import { createDemoAction } from "../actions";
import { DemoForm } from "./demo-form";

/** Creates a demonstration company for an existing account (WMS-44). */
export default async function NuevaDemostracionPage() {
  await requirePlatformStaff();
  return (
    <PageContainer>
      <title>Crear empresa de demostración · Consola interna</title>
      <PageHeader title="Crear empresa de demostración" />
      <p className="max-w-prose text-sm text-muted-foreground">
        La cuenta debe existir, tener su correo confirmado y no pertenecer a
        ninguna empresa: quedará como titular. Trae todos los módulos,{" "}
        {DEMO_PLAN.productLimit} productos, {DEMO_PLAN.users} usuarios y{" "}
        {DEMO_PLAN.days} días de vigencia, con datos ficticios. No recibe pagos,
        no manda órdenes por correo ni tiene API.
      </p>
      <DemoForm action={createDemoAction} defaultName={DEMO_DEFAULT_NAME} />
    </PageContainer>
  );
}
