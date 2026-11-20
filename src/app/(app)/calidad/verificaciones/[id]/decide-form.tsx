"use client";

import { Loader2 } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useFocusFirstError } from "@/components/focus-first-error";
import { FormField } from "@/components/form-field";
import { PhotoCapture, type CapturedPhoto } from "@/components/photo-capture";
import { SerialsField } from "@/components/serials-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { InspectionView } from "@/modules/quality";

import {
  checkInspectionDecisionAction,
  decideInspectionAction,
  discardInspectionPhotoAction,
  uploadInspectionPhotoAction,
  type DecideInspectionState,
} from "../../actions";

const areaClass =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

const EMPTY: DecideInspectionState = { values: {}, answers: 0 };

/**
 * The decision of a verification (ADR 0091), in one form: the points of
 * the plan, how many were counted and where each part goes, what is
 * missing and why, the defects found and the photos. Counted plus missing
 * is what was expected; empty means none.
 */
export function DecideForm({
  view,
  places,
  idempotencyKey,
}: {
  view: InspectionView;
  places: { id: string; path: string }[];
  idempotencyKey: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [state, action, pending] = useActionState(
    async (previous: DecideInspectionState, formData: FormData) => {
      try {
        return await decideInspectionAction(
          { inspectionId: view.id, idempotencyKey },
          previous,
          formData,
        );
      } catch (error) {
        unstable_rethrow(error);
        const found = await checkInspectionDecisionAction(idempotencyKey).catch(
          () => null,
        );
        if (found) {
          return {
            ...previous,
            ok: true,
            summary: "La verificación sí se decidió.",
            answers: previous.answers + 1,
          };
        }
        return {
          ...previous,
          error:
            "No supimos si la verificación se decidió. Recarga la página antes de volver a enviarla.",
          answers: previous.answers + 1,
        };
      }
    },
    EMPTY,
  );
  useFocusFirstError(formRef, state);
  useEffect(() => {
    if (state.ok) {
      toast.success(state.summary ?? "Se decidió la verificación.");
      router.refresh();
    }
  }, [state, router]);

  const value = (name: string) => state.values[name] ?? "";
  const error = (name: string) => state.fieldErrors?.[name];
  const bySerial = view.tracking === "SERIAL";
  const sampleWithoutSize =
    view.sampling.mode === "sample" && view.sampleSizeLabel === null;

  return (
    <form
      ref={formRef}
      action={action}
      noValidate
      className="max-w-3xl space-y-6 rounded-xl border bg-card p-4 sm:p-5"
    >
      <p className="text-sm text-muted-foreground">
        Se esperan {view.expectedLabel}. Cuenta todo; la calidad se revisa{" "}
        {view.sampling.mode === "full"
          ? "en todo lo contado"
          : view.sampleSizeLabel
            ? `en una muestra de ${view.sampleSizeLabel}`
            : "en una muestra"}
        .
      </p>

      <div key={state.answers} className="space-y-6">
        {view.plan && view.plan.points.length > 0 && (
          <fieldset className="space-y-4">
            <legend className="font-medium">
              Puntos del plan (versión {view.plan.number})
            </legend>
            {view.plan.points.map((point) => {
              const name = `a:${point.id}`;
              const label = `${point.label}${point.required ? "" : " (opcional)"}${point.photo ? " · pide foto" : ""}`;
              return (
                <FormField
                  key={point.id}
                  id={name}
                  label={label}
                  error={error(name)}
                >
                  {(control) =>
                    point.kind === "CHECK" ? (
                      <NativeSelect
                        {...control}
                        name={name}
                        defaultValue={value(name)}
                        className="max-w-48"
                      >
                        <option value="">Elige</option>
                        <option value="yes">Sí</option>
                        <option value="no">No</option>
                      </NativeSelect>
                    ) : point.kind === "CHOICE" ? (
                      <NativeSelect
                        {...control}
                        name={name}
                        defaultValue={value(name)}
                        className="max-w-sm"
                      >
                        <option value="">Elige</option>
                        {point.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : point.kind === "NUMBER" ? (
                      <Input
                        {...control}
                        name={name}
                        inputMode="decimal"
                        autoComplete="off"
                        defaultValue={value(name)}
                        className="max-w-48"
                      />
                    ) : (
                      <textarea
                        {...control}
                        name={name}
                        rows={2}
                        maxLength={500}
                        defaultValue={value(name)}
                        className={areaClass}
                      />
                    )
                  }
                </FormField>
              );
            })}
          </fieldset>
        )}

        <fieldset className="space-y-4">
          <legend className="font-medium">Lo que se contó</legend>
          {error("outcomes") && (
            <p className="text-sm text-destructive">{error("outcomes")}</p>
          )}
          {view.outcomes.map((outcome) => (
            <div
              key={outcome.value}
              className="space-y-3 rounded-lg border p-3"
            >
              <FormField
                id={`q:${outcome.value}`}
                label={outcome.label}
                error={error(`q:${outcome.value}`)}
              >
                {(control) => (
                  <Input
                    {...control}
                    name={`q:${outcome.value}`}
                    inputMode="decimal"
                    autoComplete="off"
                    defaultValue={value(`q:${outcome.value}`)}
                    className="max-w-48"
                  />
                )}
              </FormField>
              {outcome.value !== "AVAILABLE" && (
                <FormField
                  id={`r:${outcome.value}`}
                  label="Por qué"
                  error={error(`r:${outcome.value}`)}
                >
                  {(control) => (
                    <Input
                      {...control}
                      name={`r:${outcome.value}`}
                      maxLength={300}
                      defaultValue={value(`r:${outcome.value}`)}
                    />
                  )}
                </FormField>
              )}
              {places.length > 0 && (
                <FormField
                  id={`l:${outcome.value}`}
                  label="Dónde quedan"
                  error={error(`l:${outcome.value}`)}
                >
                  {(control) => (
                    <NativeSelect
                      {...control}
                      name={`l:${outcome.value}`}
                      defaultValue={value(`l:${outcome.value}`)}
                      className="max-w-full"
                    >
                      <option value="">Aquí mismo</option>
                      {places.map((place) => (
                        <option key={place.id} value={place.id}>
                          {place.path}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
              )}
              {bySerial && (
                <SerialsField
                  id={`s:${outcome.value}`}
                  name={`s:${outcome.value}`}
                  label="Sus series"
                  error={error(`s:${outcome.value}`)}
                  defaultValue={value(`s:${outcome.value}`)}
                  rows={2}
                />
              )}
            </div>
          ))}
        </fieldset>

        {view.causes.length > 0 && (
          <fieldset className="space-y-4">
            <legend className="font-medium">Lo que no está</legend>
            <p className="text-sm text-muted-foreground">
              Si contaste menos de lo esperado, di qué pasó con lo que falta.
              Pide foto.
            </p>
            {view.causes.map((cause) => (
              <div
                key={cause.value}
                className="space-y-3 rounded-lg border p-3"
              >
                <FormField
                  id={`mq:${cause.value}`}
                  label={cause.label}
                  error={error(`mq:${cause.value}`)}
                >
                  {(control) => (
                    <Input
                      {...control}
                      name={`mq:${cause.value}`}
                      inputMode="decimal"
                      autoComplete="off"
                      defaultValue={value(`mq:${cause.value}`)}
                      className="max-w-48"
                    />
                  )}
                </FormField>
                <FormField
                  id={`mr:${cause.value}`}
                  label="Qué pasó"
                  error={error(`mr:${cause.value}`)}
                >
                  {(control) => (
                    <Input
                      {...control}
                      name={`mr:${cause.value}`}
                      maxLength={300}
                      defaultValue={value(`mr:${cause.value}`)}
                    />
                  )}
                </FormField>
                {bySerial && (
                  <SerialsField
                    id={`ms:${cause.value}`}
                    name={`ms:${cause.value}`}
                    label="Sus series"
                    error={error(`ms:${cause.value}`)}
                    defaultValue={value(`ms:${cause.value}`)}
                    rows={2}
                  />
                )}
              </div>
            ))}
          </fieldset>
        )}

        {sampleWithoutSize && (
          <FormField
            id="checked"
            label="Cuántas revisaste"
            error={error("checked")}
          >
            {(control) => (
              <Input
                {...control}
                name="checked"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={value("checked")}
                className="max-w-48"
              />
            )}
          </FormField>
        )}

        {view.defects.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="font-medium">
              Defectos encontrados (opcional)
            </legend>
            {error("defects") && (
              <p className="text-sm text-destructive">{error("defects")}</p>
            )}
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-wrap gap-3">
                <div className="min-w-0 flex-1 basis-56">
                  <NativeSelect
                    name={`d:${index}`}
                    aria-label={`Defecto ${index + 1}`}
                    defaultValue={value(`d:${index}`)}
                  >
                    <option value="">Sin defecto</option>
                    {view.defects.map((defect) => (
                      <option key={defect.id} value={defect.id}>
                        {defect.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <Input
                  name={`dq:${index}`}
                  aria-label={`Piezas con el defecto ${index + 1}`}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Piezas"
                  defaultValue={value(`dq:${index}`)}
                  className="w-32"
                />
              </div>
            ))}
          </fieldset>
        )}
      </div>

      <PhotoCapture
        id="inspection-photos"
        name="photos"
        label="Fotos"
        hint={
          view.photoRequiredForReject
            ? "Obligatoria si falta algo, al rechazar o al poner en cuarentena."
            : "Obligatoria si falta algo de lo esperado."
        }
        error={error("photos")}
        photos={photos}
        onPhotosChange={setPhotos}
        upload={(formData) => uploadInspectionPhotoAction(view.id, formData)}
        discard={discardInspectionPhotoAction}
        max={10}
      />

      {state.error && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">{state.error}</p>
          {state.overCapacity && (
            <Button
              type="submit"
              name="acceptCapacity"
              value="1"
              variant="outline"
              className="min-h-11"
            >
              Guardar de todos modos
            </Button>
          )}
        </div>
      )}

      <Button
        type="submit"
        size="lg"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Confirmar
      </Button>
    </form>
  );
}
