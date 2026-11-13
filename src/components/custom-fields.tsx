import { FormField } from "./form-field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";

/**
 * Custom fields of a company (WMS-58): the same inputs in every form of
 * an entity (product, location, supplier) and the same lines in its card.
 * The fields come built from the server; nothing here knows the platform.
 */

/** A field as a form shows it (built in the server). */
export type CustomFieldInputView = {
  key: string;
  label: string;
  type: "TEXT" | "NUMBER" | "DATE" | "CHOICE" | "BOOLEAN";
  required: boolean;
  /** Options of a list (value = option id). */
  options: { value: string; label: string }[];
};

/**
 * The inputs of the custom fields, named `cf.<key>`. `remount` changes
 * with every answer of the form, so each input shows what was sent.
 */
export function CustomFieldInputs({
  fields,
  values,
  errors,
  remount,
  idPrefix = "",
  columns = 2,
}: {
  fields: readonly CustomFieldInputView[];
  values: Record<string, string>;
  errors?: Record<string, string>;
  remount: string;
  idPrefix?: string;
  /** One column inside a dialog; two in a page form. */
  columns?: 1 | 2;
}) {
  if (fields.length === 0) return null;
  return (
    <div className={columns === 2 ? "grid gap-5 sm:grid-cols-2" : "space-y-5"}>
      {fields.map((field) => {
        const id = `${idPrefix}cf-${field.key}`;
        const name = `cf.${field.key}`;
        const value = values[field.key] ?? "";
        const key = `${id}-${remount}`;
        return (
          <FormField
            key={field.key}
            id={id}
            label={field.required ? field.label : `${field.label} (opcional)`}
            error={errors?.[field.key]}
          >
            {(control) =>
              field.type === "CHOICE" || field.type === "BOOLEAN" ? (
                <NativeSelect
                  {...control}
                  key={key}
                  name={name}
                  defaultValue={value}
                >
                  <option value="">Sin elegir</option>
                  {(field.type === "BOOLEAN"
                    ? [
                        { value: "si", label: "Sí" },
                        { value: "no", label: "No" },
                      ]
                    : field.options
                  ).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  {...control}
                  key={key}
                  name={name}
                  defaultValue={value}
                  type={field.type === "DATE" ? "date" : "text"}
                  inputMode={field.type === "NUMBER" ? "decimal" : undefined}
                  maxLength={field.type === "TEXT" ? 200 : 40}
                  autoComplete="off"
                />
              )
            }
          </FormField>
        );
      })}
    </div>
  );
}

/** Filled custom fields of a record, as lines of a card's list. */
export function CustomFieldFacts({
  values,
  itemClassName,
}: {
  values: readonly { key: string; label: string; text: string }[];
  itemClassName?: string;
}) {
  return values.map((value) => (
    <div key={value.key} className={itemClassName}>
      <dt className="text-sm text-muted-foreground">{value.label}</dt>
      <dd className="font-medium [overflow-wrap:anywhere]">{value.text}</dd>
    </div>
  ));
}
