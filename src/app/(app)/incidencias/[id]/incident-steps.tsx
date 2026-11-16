"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";

import { FormField, PhotoCapture, type CapturedPhoto } from "@/components";
import { Button } from "@/components/ui/button";

import {
  incidentStepAction,
  discardIncidentPhotoAction,
  uploadIncidentPhotoAction,
  type StepState,
} from "../actions";

const areaClass =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

const INITIAL: StepState = { answers: 0 };

/**
 * The next step of an incident: «Atender» while it is open, then
 * «Resolver» (what was done) or «Descartar» (why); and a note for anybody
 * who may report. The server checks everything again.
 */
export function IncidentSteps({
  incidentId,
  status,
  manages,
  writesNotes,
  maxPhotos,
}: {
  incidentId: string;
  status: string;
  manages: boolean;
  writesNotes: boolean;
  maxPhotos: number;
}) {
  // Photos of the next note; kept while the note form is rebuilt.
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [closing, setClosing] = useState<"resolve" | "dismiss" | null>(null);
  const [startState, start, starting] = useActionState(
    incidentStepAction.bind(null, { incidentId, step: "start" }),
    INITIAL,
  );
  const [resolveState, resolve, resolving] = useActionState(
    incidentStepAction.bind(null, { incidentId, step: "resolve" }),
    INITIAL,
  );
  const [dismissState, dismiss, dismissing] = useActionState(
    incidentStepAction.bind(null, { incidentId, step: "dismiss" }),
    INITIAL,
  );
  const closeState = closing === "dismiss" ? dismissState : resolveState;
  const close = closing === "dismiss" ? dismiss : resolve;
  const sending = resolving || dismissing;
  const [noteState, note, noting] = useActionState(
    async (previous: StepState, formData: FormData) => {
      const answer = await incidentStepAction(
        { incidentId, step: "note" },
        previous,
        formData,
      );
      // Saved: the photos belong to the note now; the list starts over.
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
    for (const state of [startState, resolveState, dismissState, noteState]) {
      if (state.ok && state.message) toast.success(state.message);
    }
    // Once per answer of each form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    startState.answers,
    resolveState.answers,
    dismissState.answers,
    noteState.answers,
  ]);

  return (
    <div className="max-w-3xl space-y-4">
      {manages && (
        <section
          aria-label="Siguiente paso"
          className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
        >
          {startState.error && (
            <p role="alert" className="text-sm text-destructive">
              {startState.error}
            </p>
          )}
          {closing === null ? (
            <div className="flex flex-wrap gap-2">
              {status === "OPEN" && (
                <form action={start}>
                  <Button type="submit" disabled={starting}>
                    Atender
                  </Button>
                </form>
              )}
              <Button
                type="button"
                variant={status === "OPEN" ? "outline" : "default"}
                onClick={() => setClosing("resolve")}
              >
                Resolver
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setClosing("dismiss")}
              >
                Descartar
              </Button>
            </div>
          ) : (
            <form
              key={`${closing}-${closeState.answers}`}
              action={close}
              noValidate
              className="space-y-3"
            >
              <FormField
                id="closing-text"
                label={
                  closing === "resolve"
                    ? "¿Qué se hizo?"
                    : "¿Por qué se descarta?"
                }
                error={closeState.error}
              >
                {(control) => (
                  <textarea
                    {...control}
                    name="text"
                    rows={3}
                    maxLength={500}
                    defaultValue={closeState.text ?? ""}
                    autoFocus
                    className={areaClass}
                  />
                )}
              </FormField>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={sending}>
                  {closing === "resolve" ? "Resolver" : "Descartar"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setClosing(null)}
                >
                  Volver
                </Button>
              </div>
            </form>
          )}
        </section>
      )}
      {writesNotes && (
        <form
          key={`note-${noteState.answers}`}
          action={note}
          noValidate
          className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
        >
          <FormField
            id="note-text"
            label="Agregar una nota o fotos"
            error={noteState.error}
          >
            {(control) => (
              <textarea
                {...control}
                name="text"
                rows={2}
                maxLength={1000}
                defaultValue={noteState.ok ? "" : (noteState.text ?? "")}
                className={areaClass}
              />
            )}
          </FormField>
          <PhotoCapture
            id="note-photos"
            label="Fotos (opcional)"
            photos={photos}
            onPhotosChange={setPhotos}
            upload={uploadIncidentPhotoAction}
            discard={discardIncidentPhotoAction}
            max={maxPhotos}
          />
          <Button type="submit" variant="outline" disabled={noting}>
            Agregar nota
          </Button>
        </form>
      )}
    </div>
  );
}
