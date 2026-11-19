import type { Metadata } from "next";

import { WarehouseCard } from "@/components";

import { UnsubscribeForm } from "./unsubscribe-form";

export const metadata: Metadata = {
  title: "Dejar de recibir avisos por correo",
  // The link travels in the URL: never send it to other sites.
  referrer: "no-referrer",
  robots: { index: false },
};

/**
 * Landing page of the link at the end of a mail of notices (WMS-88, ADR
 * 0084). Opening it changes nothing (mail scanners open links): only the
 * button does. It never says the person, the address or the company.
 */
export default async function BajaDeAvisosPage({
  searchParams,
}: PageProps<"/baja-de-avisos">) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t.slice(0, 100) : "";
  return (
    <WarehouseCard>
      <UnsubscribeForm token={token} />
    </WarehouseCard>
  );
}
