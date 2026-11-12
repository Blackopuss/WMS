"use client";

import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  Loader2,
  Pencil,
  Plus,
} from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  archiveLocationAction,
  createLocationAction,
  editLocationAction,
  moveLocationAction,
  restoreLocationAction,
  setLocationLimitsAction,
  type LimitValues,
  type LocationFormState,
} from "./actions";

/** A place where a location can go, with the levels it accepts (built in the server). */
export type PlaceOption = {
  /** "" = directly in the warehouse. */
  id: string;
  label: string;
  /** Value = depth of the level. */
  levels: { value: string; label: string }[];
};

/** Uses a person may give a location, built in the server. */
export type TypeOption = { value: string; label: string };

/** A category a location may be limited to, built in the server. */
export type CategoryOption = { id: string; name: string };

const EMPTY_LIMITS: LimitValues = {
  maxUnits: "",
  maxWeight: "",
  maxVolume: "",
  products: "",
  categoryIds: [],
};

const EMPTY_VALUES = {
  name: "",
  level: "",
  parentId: "",
  code: "",
  type: "STORAGE",
  limits: EMPTY_LIMITS,
};

const hasLimits = (limits: LimitValues) =>
  Boolean(
    limits.maxUnits ||
    limits.maxWeight ||
    limits.maxVolume ||
    limits.products.trim() ||
    limits.categoryIds.length > 0,
  );

const SUMMARY =
  "-m-1 flex min-h-11 cursor-pointer items-center rounded-md p-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Capacity and restrictions of a location (WMS-22B), in the add and edit
 * dialogs: how much it may hold and what it admits. Everything is optional.
 */
function LimitFields({
  prefix,
  categories,
  values,
  errors,
  answers,
}: {
  prefix: string;
  categories: CategoryOption[];
  values: LimitValues;
  errors: LocationFormState["fieldErrors"];
  answers: number;
}) {
  const amount = (
    name: "maxUnits" | "maxWeight" | "maxVolume",
    label: string,
  ) => (
    <FormField id={`${prefix}-${name}`} label={label} error={errors[name]}>
      {(control) => (
        <Input
          {...control}
          name={name}
          defaultValue={values[name]}
          key={`${name}-${values[name]}-${answers}`}
          inputMode="decimal"
          autoComplete="off"
          maxLength={20}
        />
      )}
    </FormField>
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Vacío = sin límite. Cuenta todo lo que hay dentro, también en sus
        ubicaciones.
      </p>
      {/* One per row: the dialog is narrow and an error needs its line. */}
      <div className="grid gap-3">
        {amount("maxUnits", "Unidades")}
        {amount("maxWeight", "Peso (kg)")}
        {amount("maxVolume", "Volumen (m³)")}
      </div>
      {categories.length > 0 && (
        <fieldset
          className="space-y-2"
          aria-describedby={
            errors.categoryIds ? `${prefix}-categories-error` : undefined
          }
        >
          <legend className="text-sm font-medium">
            Solo admite estas categorías
          </legend>
          <div className="grid max-h-40 gap-1 overflow-y-auto rounded-lg border p-2">
            {categories.map((category) => (
              <label
                key={category.id}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
              >
                <input
                  type="checkbox"
                  name="categoryIds"
                  value={category.id}
                  defaultChecked={values.categoryIds.includes(category.id)}
                  key={`${category.id}-${answers}`}
                  className="size-5 shrink-0 accent-primary outline-none"
                />
                <span className="min-w-0 break-words">{category.name}</span>
              </label>
            ))}
          </div>
          {errors.categoryIds && (
            <p
              id={`${prefix}-categories-error`}
              className="text-sm text-destructive"
            >
              {errors.categoryIds}
            </p>
          )}
        </fieldset>
      )}
      <FormField
        id={`${prefix}-products`}
        label="Solo admite estos productos"
        hint="Sus claves, una por línea. Sin nada marcado ni escrito, admite cualquiera."
        error={errors.products}
      >
        {(control) => (
          <textarea
            {...control}
            name="products"
            defaultValue={values.products}
            key={`products-${answers}`}
            rows={2}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm"
          />
        )}
      </FormField>
    </div>
  );
}

/** True when a refused form has a problem in its capacity or restrictions. */
const limitProblem = (errors: LocationFormState["fieldErrors"]) =>
  Boolean(
    errors.maxUnits ||
    errors.maxWeight ||
    errors.maxVolume ||
    errors.products ||
    errors.categoryIds,
  );

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      {message}
    </div>
  );
}

function Submit({
  pending,
  children,
  busy,
}: {
  pending: boolean;
  children: string;
  busy: string;
}) {
  return (
    <Button type="submit" disabled={pending}>
      {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
      {pending ? busy : children}
    </Button>
  );
}

/**
 * Adds a location. The person first says where it goes; the levels
 * offered are the ones that fit there.
 */
export function AddLocationDialog({
  places,
  types,
  categories,
  insideId = "",
  insideName,
}: {
  places: PlaceOption[];
  types: TypeOption[];
  categories: CategoryOption[];
  /** Place preselected when the dialog opens from a row. */
  insideId?: string;
  /** Name of that row: the trigger becomes its small «add inside» button. */
  insideName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [placeId, setPlaceId] = useState(insideId);
  // React resets a form after its action; the answers count how many came
  // back so the select is rebuilt showing the place the person had chosen.
  // The count travels in the state: a setState after an await commits on
  // its own, before the answer, and would rebuild it with the old values.
  const [state, formAction, pending] = useActionState(
    async (
      prev: LocationFormState & { answers: number },
      formData: FormData,
    ) => {
      const next = await createLocationAction(prev, formData);
      if (next.done) {
        toast.success("Ubicación agregada.");
        setOpen(false);
      }
      return { ...next, answers: prev.answers + 1 };
    },
    {
      fieldErrors: {},
      values: { ...EMPTY_VALUES, parentId: insideId },
      answers: 0,
    },
  );
  const { answers } = state;
  const place = places.find((option) => option.id === placeId) ?? places[0];
  const levels = place?.levels ?? [];
  const prefix = `add-${insideId || "root"}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {insideName ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Agregar dentro de ${insideName}`}
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : (
          <Button>
            <Plus aria-hidden="true" data-icon="inline-start" />
            Agregar ubicación
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Agregar ubicación</DialogTitle>
          <DialogDescription>
            Ponle el nombre que usan en tu almacén. Dentro de cada ubicación van
            los niveles que siguen después del suyo.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} noValidate className="space-y-5">
          <FormError message={state.formError} />
          <FormField
            id={`${prefix}-parent`}
            label="¿Dónde va?"
            error={state.fieldErrors.parentId}
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="parentId"
                defaultValue={placeId}
                key={`place-${answers}`}
                onChange={(event) => setPlaceId(event.target.value)}
              >
                {places.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField
            id={`${prefix}-level`}
            label="Nivel"
            error={state.fieldErrors.level}
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="level"
                defaultValue={
                  levels.some((level) => level.value === state.values.level)
                    ? state.values.level
                    : levels[0]?.value
                }
                // The levels depend on the place: start over when it changes.
                key={`${placeId}-${state.values.level}-${answers}`}
              >
                {levels.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField
            id={`${prefix}-name`}
            label="Nombre"
            hint="Por ejemplo: Bodega, Pasillo 3, Estante A."
            error={state.fieldErrors.name}
          >
            {(control) => (
              <Input
                {...control}
                name="name"
                defaultValue={state.values.name}
                key={`name-${state.values.name}-${String(state.done)}`}
                maxLength={60}
                autoComplete="off"
                required
              />
            )}
          </FormField>
          <CodeAndType
            prefix={prefix}
            types={types}
            values={state.values}
            errors={state.fieldErrors}
            answers={answers}
          />
          {/* Rarely set: folded unless something was typed or refused. */}
          <details
            className="rounded-lg border p-3"
            open={
              hasLimits(state.values.limits) || limitProblem(state.fieldErrors)
            }
          >
            <summary className={SUMMARY}>
              Capacidad y restricciones (opcional)
            </summary>
            <div className="mt-3">
              <LimitFields
                prefix={prefix}
                categories={categories}
                values={state.values.limits}
                errors={state.fieldErrors}
                answers={answers}
              />
            </div>
          </details>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancelar
              </Button>
            </DialogClose>
            <Submit pending={pending} busy="Guardando…">
              Agregar
            </Submit>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Code and use of a location, in the add and edit dialogs. */
function CodeAndType({
  prefix,
  types,
  values,
  errors,
  answers,
  stagingFixed = false,
}: {
  prefix: string;
  types: TypeOption[];
  values: LocationFormState["values"];
  errors: LocationFormState["fieldErrors"];
  answers: number;
  /** The staging location keeps its use: it is changed elsewhere. */
  stagingFixed?: boolean;
}) {
  return (
    <>
      <FormField
        id={`${prefix}-code`}
        label="Código (opcional)"
        hint="Lo que se escanea para confirmar el lugar, por ejemplo A-01-03."
        error={errors.code}
      >
        {(control) => (
          <Input
            {...control}
            name="code"
            defaultValue={values.code}
            key={`code-${values.code}-${answers}`}
            maxLength={30}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        )}
      </FormField>
      {stagingFixed ? (
        <p className="text-sm text-muted-foreground">
          Uso: Preparación. Se cambia en Configuración › Operación.
          <input type="hidden" name="type" value="STAGING" />
        </p>
      ) : (
        <FormField id={`${prefix}-type`} label="Uso" error={errors.type}>
          {(control) => (
            <NativeSelect
              {...control}
              name="type"
              defaultValue={values.type || "STORAGE"}
              key={`type-${values.type}-${answers}`}
            >
              {types.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      )}
    </>
  );
}

/** Change the name, code or use of one location, move it or archive it. */
export function EditLocationDialog({
  location,
  types,
  categories,
  destinations,
  canUpdate,
  canArchive,
}: {
  location: {
    id: string;
    name: string;
    levelName: string;
    code: string;
    type: string;
    isStaging: boolean;
    parentId: string;
    /** Locations directly inside it. */
    children: number;
    /** Its capacity and restrictions today (WMS-22B). */
    limits: LimitValues;
  };
  types: TypeOption[];
  categories: CategoryOption[];
  /** Places this location could be moved to (its current one included). */
  destinations: { id: string; label: string }[];
  canUpdate: boolean;
  canArchive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const empty: LocationFormState = {
    fieldErrors: {},
    values: {
      ...EMPTY_VALUES,
      name: location.name,
      code: location.code,
      type: location.type,
      parentId: location.parentId,
    },
  };
  const [editState, editAction, editing] = useActionState(
    async (
      prev: LocationFormState & { answers: number },
      formData: FormData,
    ) => {
      const next = await editLocationAction(location.id, prev, formData);
      if (next.done) {
        toast.success("Cambios guardados.");
        setOpen(false);
      }
      return { ...next, answers: prev.answers + 1 };
    },
    { ...empty, answers: 0 },
  );
  const [moveState, moveAction, moving] = useActionState(
    async (prev: LocationFormState, formData: FormData) => {
      const next = await moveLocationAction(location.id, prev, formData);
      if (next.done) {
        toast.success(`${location.name} se movió.`);
        setOpen(false);
      }
      return next;
    },
    empty,
  );
  const [limitState, limitAction, limiting] = useActionState(
    async (
      prev: LocationFormState & { answers: number },
      formData: FormData,
    ) => {
      const next = await setLocationLimitsAction(location.id, prev, formData);
      if (next.done) {
        toast.success("Capacidad y restricciones guardadas.");
        setOpen(false);
      }
      return { ...next, answers: prev.answers + 1 };
    },
    {
      fieldErrors: {},
      values: { ...EMPTY_VALUES, limits: location.limits },
      answers: 0,
    },
  );
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiving, startArchive] = useTransition();

  function archive() {
    setArchiveError(null);
    startArchive(async () => {
      const result = await archiveLocationAction(location.id);
      if (result.ok) {
        toast.success(`${location.name} se archivó.`);
        setOpen(false);
      } else {
        setArchiveError(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Cambiar ${location.name}`}
        >
          <Pencil aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{location.name}</DialogTitle>
          <DialogDescription>
            {location.levelName}.{" "}
            {location.children === 0
              ? "No tiene ubicaciones dentro."
              : location.children === 1
                ? "Tiene una ubicación dentro."
                : `Tiene ${location.children} ubicaciones dentro.`}
          </DialogDescription>
        </DialogHeader>
        {canUpdate && (
          <form action={editAction} noValidate className="space-y-3">
            <FormError message={editState.formError} />
            <FormField
              id={`edit-${location.id}-name`}
              label="Nombre"
              error={editState.fieldErrors.name}
            >
              {(control) => (
                <Input
                  {...control}
                  name="name"
                  defaultValue={editState.values.name}
                  key={`name-${editState.values.name}-${editState.answers}`}
                  maxLength={60}
                  autoComplete="off"
                  required
                />
              )}
            </FormField>
            <CodeAndType
              prefix={`edit-${location.id}`}
              types={types}
              values={editState.values}
              errors={editState.fieldErrors}
              answers={editState.answers}
              stagingFixed={location.isStaging}
            />
            <Submit pending={editing} busy="Guardando…">
              Guardar cambios
            </Submit>
          </form>
        )}
        {canUpdate && (
          // Rarely changed: folded unless it has something or was refused.
          <details
            className="border-t pt-4"
            open={
              hasLimits(limitState.values.limits) ||
              limitProblem(limitState.fieldErrors) ||
              Boolean(limitState.formError)
            }
          >
            <summary className={SUMMARY}>Capacidad y restricciones</summary>
            <form action={limitAction} noValidate className="mt-3 space-y-4">
              <FormError message={limitState.formError} />
              <LimitFields
                prefix={`limits-${location.id}`}
                categories={categories}
                values={limitState.values.limits}
                errors={limitState.fieldErrors}
                answers={limitState.answers}
              />
              <Submit pending={limiting} busy="Guardando…">
                Guardar capacidad
              </Submit>
            </form>
          </details>
        )}
        {canUpdate && destinations.length > 1 && (
          <form
            action={moveAction}
            noValidate
            className="space-y-3 border-t pt-5"
          >
            <FormError message={moveState.formError} />
            <FormField
              id={`move-${location.id}`}
              label="Mover a"
              hint={
                location.children > 0
                  ? "Se mueve con todo lo que tiene dentro."
                  : undefined
              }
              error={moveState.fieldErrors.parentId}
            >
              {(control) => (
                <NativeSelect
                  {...control}
                  name="parentId"
                  defaultValue={moveState.values.parentId}
                  key={`place-${moveState.values.parentId}`}
                >
                  {destinations.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <Submit pending={moving} busy="Moviendo…">
              Mover
            </Submit>
          </form>
        )}
        {canArchive && (
          <div className="space-y-3 border-t pt-5">
            <p className="text-sm text-muted-foreground">
              Archivarla la quita de tus listas sin borrar su historial. Puedes
              reactivarla después.
            </p>
            {archiveError && (
              <p role="alert" className="text-sm text-destructive">
                {archiveError}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={archive}
              disabled={archiving}
            >
              {archiving ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Archive aria-hidden="true" data-icon="inline-start" />
              )}
              {archiving ? "Archivando…" : "Archivar ubicación"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Brings an archived location back. */
export function RestoreLocation({
  locationId,
  name,
}: {
  locationId: string;
  name: string;
}) {
  const [pending, startTransition] = useTransition();

  function restore() {
    startTransition(async () => {
      const result = await restoreLocationAction(locationId);
      if (result.ok) toast.success(`${name} volvió a tus ubicaciones.`);
      else toast.error(result.error);
    });
  }

  return (
    <Button
      variant="outline"
      onClick={restore}
      disabled={pending}
      aria-label={`Reactivar ${name}`}
    >
      {pending ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <ArchiveRestore aria-hidden="true" data-icon="inline-start" />
      )}
      Reactivar
    </Button>
  );
}
