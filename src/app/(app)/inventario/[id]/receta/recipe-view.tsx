import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type {
  RecipeInputView,
  RecipeOutputView,
  RecipeVersionView,
} from "@/modules/production";

/**
 * What a recipe version says, to read (WMS-27): for how much, its
 * materials and what comes out. No costs: the share is a percent.
 */
export function RecipeLines({
  version,
  headingLevel = "h3",
}: {
  version: RecipeVersionView;
  headingLevel?: "h2" | "h3";
}) {
  const Heading = headingLevel;
  return (
    <div className="space-y-4">
      <div>
        <Heading className="text-sm font-medium text-muted-foreground">
          Materiales para {version.baseLabel}
        </Heading>
        {version.inputs.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Todavía no tiene materiales.
          </p>
        ) : (
          <ul className="mt-1 divide-y">
            {version.inputs.map((line) => (
              <InputRow key={line.id} line={line} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <Heading className="text-sm font-medium text-muted-foreground">
          Lo que sale
        </Heading>
        {version.outputs.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Todavía no dice qué sale.
          </p>
        ) : (
          <ul className="mt-1 divide-y">
            {version.outputs.map((line) => (
              <OutputRow key={line.id} line={line} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Flags({
  line,
}: {
  line: { archived: boolean; unitChanged: boolean };
}) {
  if (line.archived) return <Badge variant="warning">Archivado</Badge>;
  if (line.unitChanged)
    return <Badge variant="warning">Cambió su unidad</Badge>;
  return null;
}

function ProductName({
  id,
  name,
  sku,
}: {
  id: string;
  name: string;
  sku: string;
}) {
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      <Link
        href={`/inventario/${id}`}
        className="rounded font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {name}
      </Link>{" "}
      <span className="text-sm text-muted-foreground">{sku}</span>
    </span>
  );
}

function InputRow({ line }: { line: RecipeInputView }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <ProductName id={line.productId} name={line.name} sku={line.sku} />
      <span className="text-right tabular-nums">
        <Flags line={line} />{" "}
        <span className="font-medium">{line.quantityLabel}</span>
        {line.capturedLabel && (
          <span className="text-sm text-muted-foreground">
            {" "}
            ({line.capturedLabel})
          </span>
        )}
        {line.scrapPercent && (
          <span className="block text-sm text-muted-foreground">
            Merma esperada {line.scrapPercent} %
          </span>
        )}
      </span>
    </li>
  );
}

function OutputRow({ line }: { line: RecipeOutputView }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <ProductName id={line.productId} name={line.name} sku={line.sku} />
      <span className="text-right tabular-nums">
        <Flags line={line} />{" "}
        <span className="font-medium">{line.quantityLabel}</span>
        <span className="block text-sm text-muted-foreground">
          {line.costShare} % del costo
        </span>
      </span>
    </li>
  );
}
