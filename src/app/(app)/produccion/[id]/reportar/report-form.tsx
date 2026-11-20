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
import type { ReportPreview } from "@/modules/production";

import {
  checkReportAction,
  discardReportPhotoAction,
  reportProductionAction,
  uploadReportPhotoAction,
  type ReportFormState,
} from "../../reportes/actions";

const areaClass =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

const EMPTY: ReportFormState = {
  values: {
    good: "",
    bad: "",
    badReason: "",
    materialSerials: {},
    outputSerials: {},
    outputExpiry: {},
  },
  answers: 0,
};

/**
 * The report (WMS-29): «Hice», the bad pieces with their reason, the
 * serials when a material or what is made goes by serial, the expiry of a
 * lot that carries one, and the photo. The recipe is consumed by itself.
 * A lost answer is checked by its key before trying again (INV-22).
 */
export function ReportForm({
  preview,
  idempotencyKey,
}: {
  preview: ReportPreview;
  idempotencyKey: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [state, action, pending] = useActionState(
    async (previous: ReportFormState, formData: FormData) => {
      try {
        return await reportProductionAction(
          { orderId: preview.orderId, idempotencyKey },
          previous,
          formData,
        );
      } catch (error) {
        unstable_rethrow(error);
        const found = await checkReportAction(idempotencyKey).catch(() => null);
        if (found) {
          return {
            ...previous,
            ok: true,
            reportId: found.reportId,
            summary: "El reporte sí se guardó.",
            answers: previous.answers + 1,
          };
        }
        return {
          ...previous,
          error:
            "No supimos si el reporte se guardó. Revisa la orden antes de volver a enviarlo.",
          answers: previous.answers + 1,
        };
      }
    },
    EMPTY,
  );
  useFocusFirstError(formRef, state);
  useEffect(() => {
    if (state.ok && state.reportId) {
      toast.success(state.summary ?? "Se guardó el reporte.");
      router.push(`/produccion/reportes/${state.reportId}`);
    }
  }, [state, router]);

  const field = (name: string) =>
    state.fieldErrors?.[name as keyof typeof state.fieldErrors];
  const serialMaterials = preview.materials.filter((line) => line.bySerial);
  const short = preview.materials.filter((line) => !line.enough);

  return (
    <form
      ref={formRef}
      action={action}
      className="max-w-3xl space-y-5 rounded-xl border bg-card p-4 sm:p-5"
      noValidate
    >
      <div className="space-y-1 text-sm">
        <p className="font-medium [overflow-wrap:anywhere]">
          {preview.productName}
        </p>
        <p className="text-muted-foreground">
          Falta: {preview.leftText}
          {preview.fitsText !== null &&
            ` · Con el material a tu alcance alcanza para ${preview.fitsText}`}
        </p>
        {short.length > 0 && (
          <p className="text-muted-foreground">
            No alcanza para todo lo que falta:{" "}
            {short.map((line) => line.productName).join(", ")}.
          </p>
        )}
      </div>

      <div key={state.answers} className="space-y-5">
        <FormField id="good" label="Hice (buenas)" error={field("good")}>
          {(control) => (
            <Input
              {...control}
              name="good"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={state.values.good}
              className="max-w-48"
            />
          )}
        </FormField>
        <FormField
          id="bad"
          label="Piezas malas (opcional)"
          hint="No entran al almacén; su material sí se descuenta."
          error={field("bad")}
        >
          {(control) => (
            <Input
              {...control}
              name="bad"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={state.values.bad}
              className="max-w-48"
            />
          )}
        </FormField>
        <FormField
          id="badReason"
          label="Por qué salieron malas"
          error={field("badReason")}
        >
          {(control) => (
            <textarea
              {...control}
              name="badReason"
              rows={2}
              maxLength={300}
              defaultValue={state.values.badReason}
              className={areaClass}
            />
          )}
        </FormField>

        {serialMaterials.map((line) => (
          <SerialsField
            key={line.lineId}
            id={`material-${line.lineId}`}
            name={`material:${line.lineId}`}
            label={`Series de ${line.productName} que se usan`}
            error={field(`serials:${line.lineId}`)}
            defaultValue={state.values.materialSerials[line.lineId] ?? ""}
            rows={3}
          />
        ))}
        {preview.outputs.map((output) => (
          <div key={output.outputId} className="space-y-4">
            {output.bySerial && (
              <SerialsField
                id={`output-${output.outputId}`}
                name={`output:${output.outputId}`}
                label={`Series de ${output.productName} que hiciste`}
                error={field(`serials:${output.outputId}`)}
                defaultValue={state.values.outputSerials[output.outputId] ?? ""}
                rows={3}
              />
            )}
            {output.lotExpiry && output.lotExpiry !== "NONE" && (
              <FormField
                id={`expiry-${output.outputId}`}
                label={`Caducidad del lote de ${output.productName}${output.lotExpiry === "OPTIONAL" ? " (opcional)" : ""}`}
                error={field(`expiry:${output.outputId}`)}
              >
                {(control) => (
                  <Input
                    {...control}
                    type="date"
                    name={`expiry:${output.outputId}`}
                    defaultValue={
                      state.values.outputExpiry[output.outputId] ?? ""
                    }
                    className="max-w-56"
                  />
                )}
              </FormField>
            )}
          </div>
        ))}
      </div>

      {preview.photoMode !== "off" && (
        <PhotoCapture
          id="report-photos"
          label={
            preview.photoMode === "required"
              ? "Foto de lo que hiciste"
              : "Foto de lo que hiciste (opcional)"
          }
          hint="Queda como prueba de lo que se reportó."
          error={field("photos")}
          photos={photos}
          onPhotosChange={setPhotos}
          upload={uploadReportPhotoAction}
          discard={discardReportPhotoAction}
          max={5}
        />
      )}

      {state.error && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">{state.error}</p>
          {state.shortages && state.shortages.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {state.shortages.map((line) => (
                <li key={line.productName}>
                  {line.productName}: se necesitan {line.needed}, a tu alcance
                  hay {line.reachable}.
                </li>
              ))}
            </ul>
          )}
          {state.fitsText && (
            <p>Con lo que hay alcanza para {state.fitsText}.</p>
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
        Guardar reporte
      </Button>
    </form>
  );
}
