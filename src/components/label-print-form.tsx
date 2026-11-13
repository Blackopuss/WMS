import { Printer } from "lucide-react";

import { FormField } from "./form-field";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";

type Choice = { value: string; label: string };

/**
 * The form that downloads a PDF of labels (WMS-26): a plain GET form, not
 * next/form, because the answer is a file, not a screen. Size and codes
 * start on what the company chose; copies only where they make sense.
 * The options are made on the server and come as props.
 */
export function LabelPrintForm({
  id,
  action,
  hidden,
  formats,
  codes,
  defaults,
  copies,
  submitLabel,
}: {
  id: string;
  /** `/api/etiquetas/<tipo>`. */
  action: string;
  /** What is printed: `id`, `desde`, `producto`… */
  hidden: Record<string, string>;
  formats: Choice[];
  codes: Choice[];
  defaults: { format: string; codes: string };
  /** Show «Copias» (1 to `copies.max`). */
  copies?: { max: number };
  submitLabel: string;
}) {
  return (
    <form
      method="get"
      action={action}
      aria-label={submitLabel}
      className="grid gap-4 sm:grid-cols-2"
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormField id={`${id}-formato`} label="Tamaño">
        {(control) => (
          <NativeSelect
            {...control}
            name="formato"
            defaultValue={defaults.format}
          >
            {formats.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField id={`${id}-codigos`} label="Códigos">
        {(control) => (
          <NativeSelect
            {...control}
            name="codigos"
            defaultValue={defaults.codes}
          >
            {codes.map((code) => (
              <option key={code.value} value={code.value}>
                {code.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      {copies && (
        <FormField
          id={`${id}-copias`}
          label="Copias"
          hint={`De 1 a ${copies.max}.`}
        >
          {(control) => (
            <Input
              {...control}
              name="copias"
              type="number"
              inputMode="numeric"
              min={1}
              max={copies.max}
              defaultValue={1}
            />
          )}
        </FormField>
      )}
      <div className="flex items-end sm:col-span-2">
        <Button type="submit">
          <Printer aria-hidden="true" data-icon="inline-start" />
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * «Imprimir etiqueta» on the card of what it labels (WMS-26): a plain link
 * to the PDF, with the size and codes the company chose.
 */
export function PrintLabelLink({
  href,
  children = "Imprimir etiqueta",
}: {
  /** `/api/etiquetas/<tipo>?id=…`, made on the server. */
  href: string;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Printer aria-hidden="true" className="size-4" />
      {children}
    </a>
  );
}
