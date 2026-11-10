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

const EMPTY_VALUES = {
  name: "",
  level: "",
  parentId: "",
  code: "",
  type: "STORAGE",
};

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
  insideId = "",
  insideName,
}: {
  places: PlaceOption[];
  types: TypeOption[];
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
      <DialogContent>
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
  };
  types: TypeOption[];
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
      <DialogContent>
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
