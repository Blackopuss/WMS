"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  FormField,
  PhotoCapture,
  PhotoGallery,
  type CapturedPhoto,
  type GalleryPhoto,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  discardProcessPhotoAction,
  stageAction,
  uploadProcessPhotoAction,
  type StageFormState,
} from "./actions";

/**
 * The process of a document on screen (WMS-74, ADR 0069), reusable by the
 * screen of each document: the big button of the next stage the person
 * can do (with the note, quantity or photos it asks), the line of stages
 * with «Esperando: …» and who has each one, and the trail. Everything is
 * checked again by the server; nothing here moves stock.
 */

type Evidence = "NONE" | "OPTIONAL" | "REQUIRED";

type Leaf = {
  stateId: string;
  name: string;
  status: "WAITING" | "READY" | "DONE" | "SKIPPED";
  statusLabel: string;
  area: string;
  operation: boolean;
  waitingText: string | null;
  takenByName: string | null;
  mine: boolean;
  doneByName: string | null;
  doneAt: Date | null;
  evidence: { note: Evidence; photo: Evidence; quantity: Evidence };
  canTake: boolean;
  canComplete: boolean;
  canRelease: boolean;
  canSkip: boolean;
  canBack: boolean;
  canAssign: boolean;
  nobody: boolean;
};

export type ProcessPanelView = {
  id: string;
  label: string;
  /** The screen of the document, refreshed too after an action (WMS-74B). */
  documentHref?: string;
  versionNumber: number;
  stages: {
    id: string;
    name: string;
    milestoneLabel: string;
    hasChildren: boolean;
    childOrder: "IN_ORDER" | "ANY";
    leaves: Leaf[];
  }[];
  next: Leaf | null;
  assignees: Record<string, { userId: string; name: string }[]>;
  steps: {
    id: string;
    actionLabel: string;
    stageName: string;
    actorName: string;
    assigneeName: string | null;
    note: string | null;
    quantityText: string | null;
    device: string | null;
    createdAt: Date;
    photos: GalleryPhoto[];
  }[];
  olderSteps: number;
  photoLimit: number;
};

const INITIAL: StageFormState = { answers: 0 };

const areaClass =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";
const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const optional = (rule: Evidence, label: string) =>
  rule === "OPTIONAL" ? `${label} (opcional)` : label;

function when(date: Date, timeZone: string) {
  return new Date(date).toLocaleString("es-MX", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
}

function Hidden({
  view,
  leaf,
  intent,
  idempotencyKey,
}: {
  view: ProcessPanelView;
  leaf: Leaf;
  intent: string;
  idempotencyKey: string;
}) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="stateId" value={leaf.stateId} />
      <input type="hidden" name="progressId" value={view.id} />
      {view.documentHref && (
        <input type="hidden" name="documentHref" value={view.documentHref} />
      )}
      <input
        type="hidden"
        name="idempotencyKey"
        value={`${idempotencyKey.slice(0, 30)}${intent.slice(0, 6)}`.slice(
          0,
          36,
        )}
      />
    </>
  );
}

export function ProcessPanel({
  view,
  selected,
  idempotencyKey,
  timeZone,
}: {
  view: ProcessPanelView;
  /** The stage chosen in the line (`?etapa=`), if it can be done. */
  selected: string | null;
  idempotencyKey: string;
  timeZone: string;
}) {
  const leaves = view.stages.flatMap((stage) => stage.leaves);
  const chosen =
    leaves.find(
      (leaf) =>
        leaf.stateId === selected &&
        (leaf.canComplete || leaf.canTake || leaf.canRelease),
    ) ?? view.next;
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [state, act, sending] = useActionState(
    async (previous: StageFormState, formData: FormData) => {
      // The trail keeps whether it came from the installed app.
      formData.set(
        "installed",
        window.matchMedia("(display-mode: standalone)").matches ? "1" : "0",
      );
      const answer = await stageAction(previous, formData);
      if (answer.ok) {
        setPhotos((list) => {
          for (const photo of list) URL.revokeObjectURL(photo.preview);
          return [];
        });
      }
      return answer;
    },
    INITIAL,
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
  const error = (field: StageFormState["field"]) =>
    state.field === field ? state.error : undefined;

  return (
    <div className="max-w-3xl space-y-6">
      {state.error && !state.field && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          {state.error}
        </p>
      )}

      {chosen && (
        <section
          aria-labelledby="siguiente"
          className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="siguiente" className="text-lg font-semibold">
            {chosen.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            {chosen.takenByName
              ? chosen.mine
                ? "La tienes tú."
                : `La tiene ${chosen.takenByName}.`
              : `Le toca a: ${chosen.area}.`}
          </p>
          {chosen.canComplete && (
            <form action={act} className="space-y-4" key={state.answers}>
              <Hidden
                view={view}
                leaf={chosen}
                intent="complete"
                idempotencyKey={idempotencyKey}
              />
              {chosen.evidence.note !== "NONE" && (
                <FormField
                  id="stage-note"
                  label={optional(chosen.evidence.note, "Nota")}
                  error={error("note")}
                >
                  {(control) => (
                    <textarea
                      {...control}
                      name="note"
                      rows={2}
                      maxLength={500}
                      defaultValue={state.ok ? "" : (state.values?.note ?? "")}
                      className={areaClass}
                    />
                  )}
                </FormField>
              )}
              {chosen.evidence.quantity !== "NONE" && (
                <FormField
                  id="stage-quantity"
                  label={optional(chosen.evidence.quantity, "Cantidad")}
                  error={error("quantity")}
                >
                  {(control) => (
                    <Input
                      {...control}
                      name="quantity"
                      inputMode="decimal"
                      autoComplete="off"
                      defaultValue={
                        state.ok ? "" : (state.values?.quantity ?? "")
                      }
                    />
                  )}
                </FormField>
              )}
              {chosen.evidence.photo !== "NONE" && (
                <PhotoCapture
                  id="stage-photos"
                  label={optional(chosen.evidence.photo, "Fotos")}
                  error={error("photos")}
                  photos={photos}
                  onPhotosChange={setPhotos}
                  upload={uploadProcessPhotoAction.bind(null, chosen.stateId)}
                  discard={discardProcessPhotoAction}
                  max={view.photoLimit}
                />
              )}
              <Button type="submit" size="lg" disabled={sending}>
                Terminar: {chosen.name}
              </Button>
            </form>
          )}
          <div className="flex flex-wrap gap-2">
            {chosen.canTake && (
              <form action={act}>
                <Hidden
                  view={view}
                  leaf={chosen}
                  intent="take"
                  idempotencyKey={idempotencyKey}
                />
                <Button type="submit" variant="outline" disabled={sending}>
                  Tomar
                </Button>
              </form>
            )}
            {chosen.canRelease && (
              <form action={act}>
                <Hidden
                  view={view}
                  leaf={chosen}
                  intent="release"
                  idempotencyKey={idempotencyKey}
                />
                <Button type="submit" variant="outline" disabled={sending}>
                  Liberar
                </Button>
              </form>
            )}
          </div>
          {(["skip", "back"] as const).map((intent) =>
            (intent === "skip" ? chosen.canSkip : chosen.canBack) ? (
              <details key={intent} open={error("reason") !== undefined}>
                <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">
                  {intent === "skip"
                    ? "Saltar esta etapa"
                    : "Regresar a la etapa anterior"}
                </summary>
                <form action={act} className="mt-3 space-y-3">
                  <Hidden
                    view={view}
                    leaf={chosen}
                    intent={intent}
                    idempotencyKey={idempotencyKey}
                  />
                  <FormField
                    id={`stage-${intent}-reason`}
                    label="Motivo"
                    error={error("reason")}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        name="reason"
                        maxLength={500}
                        autoComplete="off"
                        defaultValue={state.values?.reason ?? ""}
                      />
                    )}
                  </FormField>
                  <Button type="submit" variant="outline" disabled={sending}>
                    {intent === "skip" ? "Saltar" : "Regresar"}
                  </Button>
                </form>
              </details>
            ) : null,
          )}
        </section>
      )}

      <section aria-labelledby="etapas" className="space-y-3">
        <h2 id="etapas" className="text-lg font-semibold">
          Etapas
        </h2>
        <ol className="divide-y rounded-xl border bg-card">
          {view.stages.map((stage, index) => (
            <li key={stage.id} className="space-y-2 p-4 sm:px-5">
              <p className="text-sm text-muted-foreground">
                {index + 1}. {stage.milestoneLabel}
              </p>
              {stage.hasChildren && (
                <p className="font-medium">
                  {stage.name}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {stage.childOrder === "ANY"
                      ? "en cualquier orden"
                      : "en orden"}
                  </span>
                </p>
              )}
              <ul
                className={stage.hasChildren ? "space-y-2 pl-4" : "space-y-2"}
              >
                {stage.leaves.map((leaf) => (
                  <li key={leaf.stateId} className="space-y-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {leaf.name}
                      </span>
                      <Badge
                        variant={
                          leaf.status === "READY"
                            ? "default"
                            : leaf.status === "WAITING"
                              ? "outline"
                              : "secondary"
                        }
                      >
                        {leaf.statusLabel}
                      </Badge>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {leaf.operation ? "Se marca sola" : leaf.area}
                      {leaf.takenByName
                        ? ` · La tiene ${leaf.takenByName}`
                        : ""}
                      {leaf.doneByName && leaf.doneAt
                        ? ` · ${leaf.doneByName}, ${when(leaf.doneAt, timeZone)}`
                        : ""}
                    </p>
                    {leaf.waitingText && (
                      <p className="text-sm">{leaf.waitingText}</p>
                    )}
                    {leaf.nobody && (
                      <p
                        role="status"
                        className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
                      >
                        Nadie de tu equipo puede hacer esta etapa ({leaf.area}).
                        Dale ese rol a alguien de este almacén en Configuración
                        › Equipo, o cambia el área del proceso para los
                        documentos nuevos.
                      </p>
                    )}
                    {leaf.stateId !== chosen?.stateId &&
                      (leaf.canComplete || leaf.canTake) && (
                        <Link
                          href={`/procesos/${view.id}?etapa=${leaf.stateId}`}
                          className={linkClass}
                        >
                          Hacer esta etapa
                        </Link>
                      )}
                    {leaf.canAssign &&
                      (view.assignees[leaf.stateId]?.length ?? 0) > 0 && (
                        <form
                          action={act}
                          className="flex flex-wrap items-end gap-2"
                        >
                          <Hidden
                            view={view}
                            leaf={leaf}
                            intent="assign"
                            idempotencyKey={idempotencyKey}
                          />
                          <FormField
                            id={`assign-${leaf.stateId}`}
                            label="Asignar a"
                            error={error("assignee")}
                          >
                            {(control) => (
                              <NativeSelect
                                {...control}
                                name="assigneeUserId"
                                defaultValue=""
                                key={state.answers}
                              >
                                <option value="" disabled>
                                  Elige a alguien
                                </option>
                                {view.assignees[leaf.stateId]!.map((person) => (
                                  <option
                                    key={person.userId}
                                    value={person.userId}
                                  >
                                    {person.name}
                                  </option>
                                ))}
                              </NativeSelect>
                            )}
                          </FormField>
                          <Button
                            type="submit"
                            variant="outline"
                            disabled={sending}
                          >
                            Asignar
                          </Button>
                        </form>
                      )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">
          Versión {view.versionNumber} del proceso.
        </p>
      </section>

      {view.steps.length > 0 && (
        <section aria-labelledby="rastro" className="space-y-3">
          <h2 id="rastro" className="text-lg font-semibold">
            Historial
          </h2>
          <ul className="divide-y rounded-xl border bg-card">
            {view.steps.map((step) => (
              <li key={step.id} className="space-y-1 p-4 sm:px-5">
                <p className="text-sm">
                  <span className="font-medium">{step.actorName}</span>{" "}
                  {step.actionLabel.toLowerCase()} «{step.stageName}»
                  {step.assigneeName ? ` a ${step.assigneeName}` : ""}
                </p>
                <p className="text-sm text-muted-foreground">
                  {when(step.createdAt, timeZone)}
                  {step.device ? ` · ${step.device}` : ""}
                  {step.quantityText ? ` · Cantidad: ${step.quantityText}` : ""}
                </p>
                {step.note && (
                  <p className="text-sm [overflow-wrap:anywhere]">
                    {step.note}
                  </p>
                )}
                <PhotoGallery
                  photos={step.photos}
                  label={`${step.stageName}`}
                />
              </li>
            ))}
          </ul>
          {view.olderSteps > 0 && (
            <p className="text-sm text-muted-foreground">
              Se muestran los {view.steps.length} pasos más recientes; hay{" "}
              {view.olderSteps} anteriores.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
