"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useRef,
  useState,
  useTransition,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

import { PhotoCapture, type CapturedPhoto } from "@/components/photo-capture";
import { CameraScanButton } from "@/components/camera-scan";
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
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

import {
  assignTaskAction,
  blockTaskAction,
  changeTaskEquipmentAction,
  cancelTaskAction,
  deliverTaskAction,
  discardTaskPhotoAction,
  releaseTaskAction,
  uploadTaskPhotoAction,
  taskStepAction,
  type TaskStepState,
} from "../actions";

/** Runs an action, says how it went and repaints with the new state. */
function useTaskAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<TaskStepState>, done?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result.ok) {
        toast.success(result.summary);
        done?.();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };
  return { pending, error, run };
}

/**
 * The next step of the person who has the task, as one big button: take
 * it or confirm the pick up (WMS-07); the delivery is `DeliverStep`.
 * Repeating a step is harmless: the service answers that it was already
 * done.
 */
export function TaskStep({
  taskId,
  step,
  label,
}: {
  taskId: string;
  step: "accept" | "pickUp";
  label: string;
}) {
  const { pending, error, run } = useTaskAction();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        className="min-h-14 w-full text-base sm:w-auto sm:min-w-72"
        disabled={pending}
        onClick={() => run(() => taskStepAction(taskId, step))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A dialog that asks why before doing something (problem, cancel). */
function ReasonDialog({
  trigger,
  title,
  description,
  label,
  confirm,
  destructive,
  submit,
}: {
  trigger: string;
  title: string;
  description: string;
  label: string;
  confirm: string;
  destructive?: boolean;
  submit: (reason: string) => Promise<TaskStepState>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, error, run } = useTaskAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-12 w-full sm:w-auto">
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => submit(reason),
              () => {
                setOpen(false);
                setReason("");
              },
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="task-reason">{label}</Label>
            <Input
              id="task-reason"
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "task-reason-error" : undefined}
              autoComplete="off"
            />
            {error && (
              <p
                id="task-reason-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Volver
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={pending}
            >
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReportProblem({ taskId }: { taskId: string }) {
  return (
    <ReasonDialog
      trigger="Reportar un problema"
      title="¿Qué impide hacer la tarea?"
      description="La tarea se detiene y tu supervisor la revisa. No se mueve nada."
      label="Qué pasó"
      confirm="Reportar problema"
      submit={(reason) => blockTaskAction(taskId, reason)}
    />
  );
}

export function CancelTask({ taskId }: { taskId: string }) {
  return (
    <ReasonDialog
      trigger="Cancelar tarea"
      title="¿Cancelar esta tarea?"
      description="Nadie la podrá hacer y no se moverá nada. Queda registrado quién la canceló y por qué."
      label="Por qué se cancela"
      confirm="Cancelar tarea"
      destructive
      submit={(reason) => cancelTaskAction(taskId, reason)}
    />
  );
}

/** A task with a problem goes back to available. */
export function ReleaseTask({ taskId }: { taskId: string }) {
  const { pending, error, run } = useTaskAction();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
        onClick={() => run(() => releaseTaskAction(taskId))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Liberar para que otra persona la tome
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Who has it, while nobody took it yet. */
export function AssignTask({
  taskId,
  assignedToUserId,
  people,
}: {
  taskId: string;
  assignedToUserId: string | null;
  people: { id: string; name: string }[];
}) {
  const [chosen, setChosen] = useState(assignedToUserId ?? "");
  const { pending, error, run } = useTaskAction();
  return (
    <form
      noValidate
      className="flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => assignTaskAction(taskId, chosen));
      }}
    >
      <div className="flex-1 space-y-2">
        <Label htmlFor="assign-to">Quién la hace</Label>
        <NativeSelect
          id="assign-to"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
          aria-describedby={error ? "assign-error" : undefined}
        >
          <option key="" value="">
            Cualquiera (disponible)
          </option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </NativeSelect>
        {error && (
          <p
            id="assign-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </div>
      {/* Shown once something changed: a disabled «Guardar» said nothing
          about why (WMS-78B, KISS). */}
      {(pending || chosen !== (assignedToUserId ?? "")) && (
        <Button
          type="submit"
          variant="outline"
          className="min-h-11"
          disabled={pending}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          Guardar
        </Button>
      )}
    </form>
  );
}

/**
 * WMS-42: the equipment the person uses for a task that asks for a type,
 * scanned (lector or camera) or chosen from the available ones; with it,
 * take the task or change the one in use. The server checks it again.
 */
export function EquipmentStep({
  taskId,
  mode,
  label,
  typeName,
  choices,
}: {
  taskId: string;
  mode: "accept" | "change";
  label: string;
  typeName: string;
  choices: { code: string; name: string }[];
}) {
  const [code, setCode] = useState("");
  const { pending, error, run } = useTaskAction();
  const inputId = `equipment-${mode}`;
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const typed = new FormData(event.currentTarget).get("equipmentCode");
        run(
          () =>
            mode === "accept"
              ? taskStepAction(taskId, "accept", String(typed ?? ""))
              : changeTaskEquipmentAction(taskId, String(typed ?? "")),
          () => setCode(""),
        );
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={inputId}>
          {mode === "accept" ? `¿Con qué ${typeName}?` : `Otro ${typeName}`}
        </Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            name="equipmentCode"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            list={`${inputId}-list`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={40}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ""}`}
          />
          <CameraScanButton target={inputId} title="Escanear el equipo" />
        </div>
        <datalist id={`${inputId}-list`}>
          {choices.map((choice) => (
            <option key={choice.code} value={choice.code}>
              {choice.name}
            </option>
          ))}
        </datalist>
        <p id={`${inputId}-hint`} className="text-sm text-muted-foreground">
          {choices.length === 0
            ? `No hay un ${typeName} libre en servicio en este almacén.`
            : `Escanea su etiqueta o escribe su código. Libres: ${choices
                .slice(0, 6)
                .map((choice) => choice.code)
                .join(", ")}${choices.length > 6 ? "…" : ""}.`}
        </p>
        {error && (
          <p
            id={`${inputId}-error`}
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </div>
      <Button
        type="submit"
        size={mode === "accept" ? "lg" : "default"}
        variant={mode === "accept" ? "default" : "outline"}
        className={
          mode === "accept"
            ? "min-h-14 w-full text-base sm:w-auto sm:min-w-72"
            : "min-h-12 w-full sm:w-auto"
        }
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : label}
      </Button>
    </form>
  );
}

/** What the photo field says, by what the company asks (WMS-37B). */
export function taskPhotoLabel(mode: "optional" | "required") {
  return mode === "required"
    ? "Foto de dónde lo dejaste"
    : "Foto de dónde lo dejaste (opcional)";
}

/**
 * The photo of where the load was left (WMS-37B, ADR 0076): taken right
 * before the last tap, uploaded at once and linked by the delivery. Kept
 * by the parent, so a refused delivery keeps what was taken.
 */
export function TaskPhotoField({
  taskId,
  mode,
  max,
  photos,
  onPhotosChange,
  error,
}: {
  taskId: string;
  mode: "optional" | "required";
  max: number;
  photos: CapturedPhoto[];
  onPhotosChange: Dispatch<SetStateAction<CapturedPhoto[]>>;
  error?: string;
}) {
  return (
    <PhotoCapture
      id="task-photos"
      label={taskPhotoLabel(mode)}
      hint="Queda como prueba de dónde quedó la mercancía."
      error={error}
      photos={photos}
      onPhotosChange={onPhotosChange}
      upload={uploadTaskPhotoAction.bind(null, taskId)}
      discard={discardTaskPhotoAction}
      max={max}
    />
  );
}

/**
 * The last step: left where it was going, with the photo of where it was
 * left when the company asks for it — the same big button, no extra
 * screen (WMS-37B). A refusal about the photos is said next to the photo
 * field, which takes the focus.
 */
export function DeliverStep({
  taskId,
  label,
  photoMode,
  maxPhotos,
}: {
  taskId: string;
  label: string;
  photoMode: "off" | "optional" | "required";
  maxPhotos: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [problem, setProblem] = useState<{
    error: string;
    photos: boolean;
  } | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const refuse = (error: string, aboutPhotos: boolean) => {
    setProblem({ error, photos: aboutPhotos });
    if (aboutPhotos) field.current?.focus();
  };
  const deliver = () => {
    if (photoMode === "required" && photos.length === 0) {
      refuse("Toma una foto de dónde la dejaste.", true);
      return;
    }
    setProblem(null);
    startTransition(async () => {
      const result = await deliverTaskAction(
        taskId,
        photos.map((photo) => photo.fileId),
      );
      if (result.ok) {
        toast.success(result.summary);
        router.refresh();
      } else {
        refuse(result.error, result.field === "photos");
      }
    });
  };
  const photoError = problem?.photos ? problem.error : undefined;
  return (
    <div className="space-y-3">
      {photoMode !== "off" && (
        <div ref={field} tabIndex={-1} className="rounded-lg outline-none">
          <TaskPhotoField
            taskId={taskId}
            mode={photoMode}
            max={maxPhotos}
            photos={photos}
            onPhotosChange={setPhotos}
            error={photoError}
          />
        </div>
      )}
      <Button
        type="button"
        size="lg"
        className="min-h-14 w-full text-base sm:w-auto sm:min-w-72"
        disabled={pending}
        onClick={deliver}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : label}
      </Button>
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem.photos ? "Revisa la foto antes de entregar." : problem.error}
        </p>
      )}
    </div>
  );
}
