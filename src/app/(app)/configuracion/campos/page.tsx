import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { changesCompanyConfig } from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPE_LABELS,
  MAX_CUSTOM_FIELDS,
  MAX_CUSTOM_OPTIONS,
  listCustomFieldSetup,
  type CustomFieldEntity,
} from "@/platform/custom-fields";

import {
  addOptionAction,
  fieldStatusAction,
  moveFieldAction,
  optionStatusAction,
  renameOptionAction,
  updateFieldAction,
} from "./actions";
import {
  ActionButton,
  AddFieldForm,
  EditFieldForm,
  OptionLabelForm,
} from "./field-forms";
import { WholeCompanyNotice } from "../whole-company-notice";

export const metadata: Metadata = { title: "Campos personalizados" };

/** The entity in the address: `?de=productos`. */
const SLUGS: Record<string, CustomFieldEntity> = {
  productos: "PRODUCT",
  ubicaciones: "LOCATION",
  proveedores: "SUPPLIER",
};
const SLUG_OF = Object.fromEntries(
  Object.entries(SLUGS).map(([slug, entity]) => [entity, slug]),
) as Record<CustomFieldEntity, string>;

/**
 * Custom fields (WMS-58): what the company adds to its products,
 * locations and suppliers. For who edits the business configuration.
 */
export default async function CamposPage({
  searchParams,
}: PageProps<"/configuracion/campos">) {
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
  if (!access.can("platform.organization.update")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  // Only the entities of the modules the company has.
  const entities = (
    Object.keys(CUSTOM_FIELD_ENTITIES) as CustomFieldEntity[]
  ).filter((entity) => access.hasModule(CUSTOM_FIELD_ENTITIES[entity].module));
  const { de } = await searchParams;
  const entity =
    (typeof de === "string" && SLUGS[de] && entities.includes(SLUGS[de])
      ? SLUGS[de]
      : entities[0]) ?? null;
  if (!entity) {
    return (
      <PageContainer>
        {back}
        <PageHeader title="Campos personalizados" />
        <p className="text-sm text-muted-foreground">
          Tu empresa no tiene activo un módulo con campos personalizados.
        </p>
      </PageContainer>
    );
  }
  const info = CUSTOM_FIELD_ENTITIES[entity];
  const [setup, wholeCompany] = await Promise.all([
    listCustomFieldSetup(
      { organizationId: access.organization.id, userId: access.user.id },
      entity,
    ),
    // WMS-93: a field applies to every warehouse; someone limited only reads.
    changesCompanyConfig(access.organization.id, access.user.id),
  ]);
  const writable = access.moduleState(info.module) === "active" && wholeCompany;
  const fields = setup.ok ? setup.fields : [];
  const inUse = fields.filter((field) => !field.archived);
  const archived = fields.filter((field) => field.archived);
  const types = Object.entries(CUSTOM_FIELD_TYPE_LABELS).map(
    ([value, label]) => ({ value, label }),
  );
  const full = setup.ok && setup.active >= MAX_CUSTOM_FIELDS;

  const fieldCard = (field: (typeof fields)[number], index: number) => (
    <li key={field.id} className="space-y-4 p-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium [overflow-wrap:anywhere]">{field.label}</h3>
        <span className="text-sm text-muted-foreground">{field.typeLabel}</span>
        {field.required && <Badge variant="secondary">Obligatorio</Badge>}
        {field.archived && <Badge variant="warning">Archivado</Badge>}
      </div>
      {field.inUse > 0 && (
        <p className="text-sm text-muted-foreground tabular-nums">
          {field.inUse === 1
            ? `Lo tiene 1 ${info.one}.`
            : `Lo tienen ${field.inUse.toLocaleString("es-MX")} ${info.label.toLowerCase()}.`}
        </p>
      )}
      {writable && !field.archived && (
        <details className="rounded-lg border p-3">
          <summary className="-m-1 flex min-h-11 cursor-pointer items-center rounded-md p-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Cambiar nombre u obligatorio
          </summary>
          <div className="mt-3">
            <EditFieldForm
              id={`field-${field.id}`}
              action={updateFieldAction.bind(null, field.id)}
              label={field.label}
              required={field.required}
            />
          </div>
        </details>
      )}
      {writable && !field.archived && field.type === "CHOICE" && (
        <details className="rounded-lg border p-3">
          <summary className="-m-1 flex min-h-11 cursor-pointer items-center rounded-md p-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Opciones (
            {field.options.filter((option) => !option.archived).length})
          </summary>
          <ul className="mt-3 space-y-3">
            {field.options.map((option) => (
              <li key={option.id} className="space-y-2">
                {option.archived ? (
                  <p className="text-sm">
                    {option.label}{" "}
                    <span className="text-muted-foreground">(archivada)</span>
                  </p>
                ) : (
                  <OptionLabelForm
                    id={`option-${option.id}`}
                    action={renameOptionAction.bind(null, option.id)}
                    label={option.label}
                    inputLabel={`Nombre de la opción ${option.label}`}
                    submit="Guardar"
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  <ActionButton
                    action={optionStatusAction.bind(
                      null,
                      option.id,
                      !option.archived,
                    )}
                  >
                    {option.archived
                      ? `Ofrecer «${option.label}» otra vez`
                      : `Ya no ofrecer «${option.label}»`}
                  </ActionButton>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 border-t pt-4">
            <OptionLabelForm
              id={`new-option-${field.id}`}
              action={addOptionAction.bind(null, field.id)}
              inputLabel="Opción nueva"
              submit="Agregar opción"
            />
            <p className="mt-2 text-sm text-muted-foreground">
              Hasta {MAX_CUSTOM_OPTIONS} opciones. Una que ya no ofreces se
              conserva en lo que ya la tiene.
            </p>
          </div>
        </details>
      )}
      {writable && (
        <div className="flex flex-wrap gap-2">
          {!field.archived && index > 0 && (
            <ActionButton action={moveFieldAction.bind(null, field.id, "up")}>
              Subir
            </ActionButton>
          )}
          {!field.archived && index < inUse.length - 1 && (
            <ActionButton action={moveFieldAction.bind(null, field.id, "down")}>
              Bajar
            </ActionButton>
          )}
          <ActionButton
            action={fieldStatusAction.bind(null, field.id, !field.archived)}
          >
            {field.archived ? "Reactivar" : "Archivar"}
          </ActionButton>
        </div>
      )}
    </li>
  );

  return (
    <PageContainer>
      {back}
      {!writable && (
        <ReadOnlyNotice
          module={info.module === "inventory" ? "Inventario" : "Compras"}
        />
      )}
      <PageHeader title="Campos personalizados" />
      {!wholeCompany && <WholeCompanyNotice />}
      {entities.length > 1 && (
        <nav aria-label="Para qué" className="flex flex-wrap gap-2">
          {entities.map((each) => (
            <Link
              key={each}
              href={`/configuracion/campos?de=${SLUG_OF[each]}`}
              aria-current={each === entity ? "page" : undefined}
              className="inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:border-primary aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground"
            >
              {CUSTOM_FIELD_ENTITIES[each].label}
            </Link>
          ))}
        </nav>
      )}
      {!setup.ok && (
        <p role="alert" className="text-sm text-destructive">
          {setup.error}
        </p>
      )}

      <section
        aria-labelledby="en-uso"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <div className="border-b p-4 sm:px-5">
          <h2 id="en-uso" className="font-medium">
            {info.label}: campos en uso ({inUse.length} de {MAX_CUSTOM_FIELDS})
          </h2>
        </div>
        {inUse.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            Todavía no hay campos. Los que agregues aparecen al crear o editar
            cada {info.one}, en su ficha
            {entity === "PRODUCT" ? ", en los filtros y en Excel" : ""}.
          </p>
        ) : (
          <ul className="divide-y">{inUse.map(fieldCard)}</ul>
        )}
      </section>

      {writable && (
        <section
          aria-labelledby="agregar"
          className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="agregar" className="font-medium">
            Agregar campo
          </h2>
          {full ? (
            <p className="text-sm text-muted-foreground">
              Ya tienes {MAX_CUSTOM_FIELDS} campos en uso. Archiva uno para
              agregar otro.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Un campo obligatorio se pide al crear o editar cada {info.one};
                los que ya existen no cambian hasta que los edites. El tipo no
                se puede cambiar después.
              </p>
              <AddFieldForm key={entity} entity={entity} types={types} />
            </>
          )}
        </section>
      )}

      {archived.length > 0 && (
        <section
          aria-labelledby="archivados"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <div className="border-b p-4 sm:px-5">
            <h2 id="archivados" className="font-medium">
              Archivados
            </h2>
            <p className="text-sm text-muted-foreground">
              No aparecen en ningún lado, pero sus datos se conservan.
            </p>
          </div>
          <ul className="divide-y">{archived.map(fieldCard)}</ul>
        </section>
      )}
    </PageContainer>
  );
}
