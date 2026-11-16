import { Info } from "lucide-react";
import type { Metadata } from "next";

import { PROPOSED_TIERS } from "@/platform/billing";

import { formatCount, formatMoney, SITE, TIER_PRICES } from "../content";
import { CtaBand, PageHero, Section } from "../sections";
import { PriceCalculator } from "./price-calculator";

export const metadata: Metadata = {
  title: "Precios",
  description:
    "Precio mensual según cuántos productos manejas. Inventario incluido; Compras, Producción y Calidad opcionales. Sin permanencia.",
};

/** Producción and Calidad cost the same in every tier. */
const FLAT = TIER_PRICES[0]!;

const TIERS = PROPOSED_TIERS.map((tier, index) => ({
  ...tier,
  ...TIER_PRICES[index]!,
}));

const FAQ = [
  {
    question: "¿Qué cuenta como producto activo?",
    answer:
      "Cada producto de tu catálogo que no esté archivado. Una caja y su pieza son el mismo producto con dos presentaciones. Los archivados no cuentan.",
  },
  {
    question: "¿Qué pasa si llego al límite?",
    answer:
      "Puedes seguir trabajando con lo que ya tienes; para dar de alta más productos cambias al siguiente nivel o archivas lo que ya no vendes.",
  },
  {
    question: "¿Puedo contratar Calidad sin Producción?",
    answer:
      "No. Calidad revisa lo que produces, así que se contrata junto con Producción. Producción sí se puede contratar sola.",
  },
  {
    question: "¿Puedo quitar un módulo después?",
    answer:
      "Sí. Nada se borra: tus órdenes, recepciones, recetas y lo demás quedan para consultar y exportar, y si lo vuelves a activar sigues donde te quedaste.",
  },
  {
    question: "¿Puedo cambiar de plan a medio mes?",
    answer: `Sí. Escríbenos a ${SITE.contactEmail} y lo cambiamos; te decimos la diferencia antes de aplicarlo.`,
  },
  {
    question: "¿Hay permanencia?",
    answer:
      "No. Pagas por adelantado los meses que acordemos, por transferencia, y nada se cobra solo. Si no renuevas, tu cuenta queda en modo consulta para que veas y descargues tu información.",
  },
  {
    question: "¿Necesitan más personas o más productos?",
    answer: `Escríbenos a ${SITE.contactEmail} y armamos un plan a tu medida.`,
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero eyebrow="Precios" title="Pagas según el tamaño de tu catálogo">
        Inventario siempre incluido. Agrega Compras, Producción y Calidad cuando
        los necesites. Sin permanencia y con tus datos siempre exportables.
      </PageHero>

      <Section className="pt-12 sm:pt-16">
        <div data-reveal>
          <PriceCalculator tiers={TIERS} />
        </div>
        <p className="mt-6 flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Precios de lanzamiento en pesos mexicanos; lo que ves es lo que pagas.
          Pueden ajustarse antes de la apertura; el precio que contrates se
          respeta mientras tengas tu plan.
        </p>
      </Section>

      <Section className="bg-card/60">
        <h2 className="text-3xl font-semibold tracking-tight" data-reveal>
          Todos los niveles
        </h2>
        <p className="mt-3 text-muted-foreground" data-reveal>
          Inventario y Compras cambian según tus productos activos; Producción y
          Calidad cuestan lo mismo en cualquier nivel.
        </p>
        <div
          className="mt-8 overflow-x-auto rounded-2xl border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-reveal
          role="region"
          aria-label="Precio mensual por nivel"
          // Scrolls sideways on a phone: keyboard users can reach it too.
          tabIndex={0}
        >
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">
              Precio mensual por nivel de productos activos
            </caption>
            <thead className="border-b bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  Productos activos
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  Personas incluidas
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  Inventario
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  + Compras
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  Inventario y Compras
                </th>
              </tr>
            </thead>
            <tbody className="divide-y tabular-nums">
              {TIERS.map((tier) => (
                <tr
                  key={tier.productLimit}
                  className="transition-colors hover:bg-muted/40"
                >
                  <th scope="row" className="px-5 py-4 font-semibold">
                    Hasta {formatCount(tier.productLimit)}
                  </th>
                  <td className="px-5 py-4">{tier.users}</td>
                  <td className="px-5 py-4 text-right">
                    {formatMoney(tier.inventory)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    {formatMoney(tier.purchasing)}
                  </td>
                  <td className="px-5 py-4 text-right font-semibold">
                    {formatMoney(tier.inventory + tier.purchasing)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul data-reveal="stagger" className="mt-6 grid gap-4 md:grid-cols-2">
          <FlatPrice
            name="Producción"
            amount={FLAT.production}
            text="Recetas con versiones y órdenes de producción que apartan sus materiales. Se suma a cualquier nivel."
          />
          <FlatPrice
            name="Calidad"
            amount={FLAT.quality}
            text="Planes de inspección por producto y catálogo de defectos. Se contrata junto con Producción."
          />
        </ul>
      </Section>

      <Section>
        <div className="grid gap-10 lg:grid-cols-[0.8fr_2fr]">
          <h2 className="text-3xl font-semibold tracking-tight" data-reveal>
            Preguntas frecuentes
          </h2>
          <div
            data-reveal="stagger"
            className="divide-y rounded-2xl border bg-card"
          >
            {FAQ.map((item) => (
              <details key={item.question} className="group px-5">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                  {item.question}
                  <span
                    aria-hidden="true"
                    className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-lg leading-none transition-transform duration-300 group-open:rotate-45 motion-reduce:transition-none"
                  >
                    +
                  </span>
                </summary>
                <p className="pb-5 text-muted-foreground">{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}

function FlatPrice({
  name,
  amount,
  text,
}: {
  name: string;
  amount: number;
  text: string;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-2xl border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-lg font-semibold">{name}</h3>
        <p className="font-semibold tabular-nums">
          + {formatMoney(amount)}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            al mes
          </span>
        </p>
      </div>
      <p className="text-sm text-muted-foreground">{text}</p>
    </li>
  );
}
