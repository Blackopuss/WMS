"use client";

import { Camera, CircleAlert, Flashlight, ScanLine } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import {
  CAMERA_PROBLEMS,
  cameraProblem,
  createReadFilter,
  scanFormats,
  singleCode,
  type CameraProblem,
} from "./scan-rules";

/** The Shape Detection API, not yet in TypeScript's DOM types. */
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
};
type BarcodeDetectorClass = {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
};
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

function detectorClass(): BarcodeDetectorClass | undefined {
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorClass })
    .BarcodeDetector;
}

/** Whether this browser can read codes with the camera (WMS-36). */
function canScan(): boolean {
  return (
    window.isSecureContext &&
    detectorClass() !== undefined &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

const noSubscription = () => () => {};

/**
 * Types a reading into a field the way a keyboard reader does (INV-29):
 * the value, an `input` event (React sees it as typed) and, in a one-line
 * field, Enter — handled by the field's own Enter handler or, if none
 * takes it, by the browser's implicit submission. In a list of serials
 * (textarea) the reading goes on a new line, which is what a reader's
 * Enter does there. `fill` only fills the field.
 */
function typeInto(
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  then: "enter" | "fill",
  focus = true,
) {
  // While the dialog stays open (continuous) focus stays in it.
  if (focus) field.focus();
  const setValue = (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      "value",
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  if (field instanceof HTMLTextAreaElement) {
    const before = field.value;
    const joint = before === "" || before.endsWith("\n") ? "" : "\n";
    setValue(`${before}${joint}${text}\n`);
    return;
  }
  setValue(text);
  if (then === "fill") return;
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  if (field.dispatchEvent(enter) && field.isConnected) {
    field.form?.requestSubmit();
  }
}

function fieldById(id: string) {
  const field = document.getElementById(id);
  return field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
    ? field
    : null;
}

/**
 * «Escanear» next to a field that takes codes (WMS-36, ADR 0049): opens
 * the back camera and types what it reads into that field, exactly like a
 * reader. It decides nothing; the server checks as always. Not painted
 * where the browser cannot read codes (Safari, Firefox, desktop Linux and
 * Windows): the field itself is the manual way.
 *
 * `continuous` keeps reading (quick exit, packing, serials) and counts;
 * otherwise one reading closes the camera.
 */
export function CameraScanButton({
  target,
  title = "Escanear con la cámara",
  continuous = false,
  then = "enter",
  className,
}: {
  /** Id of the input or textarea that receives the reading. */
  target: string;
  /** What is being scanned, for the dialog and the button's name. */
  title?: string;
  continuous?: boolean;
  then?: "enter" | "fill";
  className?: string;
}) {
  const supported = useSyncExternalStore(noSubscription, canScan, () => false);
  const [open, setOpen] = useState(false);
  /** One reading waiting for the dialog to close (single mode). */
  const pending = useRef<string | null>(null);

  if (!supported) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={className}
          aria-label={title}
        >
          <Camera aria-hidden="true" data-icon="inline-start" />
          Escanear
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-2rem)] max-h-[44rem] flex-col gap-3 sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          const text = pending.current;
          pending.current = null;
          const field = fieldById(target);
          if (!field) return;
          // Back to the field, as if the person had typed there.
          event.preventDefault();
          if (text !== null) typeInto(field, text, then);
          else field.focus();
        }}
      >
        <Scanner
          title={title}
          continuous={continuous}
          onRead={(text) => {
            if (continuous) {
              const field = fieldById(target);
              if (field) typeInto(field, text, then, false);
              return;
            }
            pending.current = text;
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

type Status =
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "problem"; problem: CameraProblem };

/** The camera itself: mounted only while the dialog is open. */
function Scanner({
  title,
  continuous,
  onRead,
  onClose,
}: {
  title: string;
  continuous: boolean;
  onRead: (text: string) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "starting" });
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [several, setSeveral] = useState(false);
  const [read, setRead] = useState<{ count: number; last: string | null }>({
    count: 0,
    last: null,
  });
  // The latest callbacks, without restarting the camera on each render.
  const handlers = useRef({ onRead, onClose });
  useEffect(() => {
    handlers.current = { onRead, onClose };
  });

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const accept = createReadFilter();
    const stop = () => {
      stopped = true;
      window.clearTimeout(timer);
      // The camera goes off: every track stopped, nothing kept.
      for (const each of stream?.getTracks() ?? []) each.stop();
      track.current = null;
      if (video.current) video.current.srcObject = null;
    };
    // Leaving the screen or the app turns the camera off.
    const onHidden = () => {
      if (document.visibilityState === "hidden") handlers.current.onClose();
    };
    document.addEventListener("visibilitychange", onHidden);

    async function start() {
      const Detector = detectorClass();
      if (!Detector) {
        setStatus({ kind: "problem", problem: "failed" });
        return;
      }
      try {
        const formats = scanFormats(await Detector.getSupportedFormats());
        if (formats.length === 0) {
          setStatus({ kind: "problem", problem: "failed" });
          return;
        }
        const detector = new Detector({ formats });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped || !video.current) {
          stop();
          return;
        }
        video.current.srcObject = stream;
        await video.current.play();
        track.current = stream.getVideoTracks()[0] ?? null;
        const capabilities = track.current?.getCapabilities?.() as
          TorchCapabilities | undefined;
        setHasTorch(capabilities?.torch === true);
        setStatus({ kind: "scanning" });

        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const found = await detector.detect(video.current);
            const one = singleCode(found.map((code) => code.rawValue));
            setSeveral("none" in one && one.none === "several");
            if ("code" in one && accept(one.code, performance.now())) {
              navigator.vibrate?.(60);
              setRead((prev) => ({ count: prev.count + 1, last: one.code }));
              handlers.current.onRead(one.code);
              if (!continuous) return;
            }
          } catch {
            // A frame that could not be read: try the next one.
          }
          if (!stopped) timer = window.setTimeout(tick, 120);
        };
        void tick();
      } catch (error) {
        if (stopped) return;
        stop();
        setStatus({
          kind: "problem",
          problem: cameraProblem(
            error instanceof Error ? error.name : undefined,
          ),
        });
      }
    }
    void start();
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      stop();
    };
  }, [continuous]);

  async function toggleTorch() {
    const next = !torchOn;
    try {
      await track.current?.applyConstraints({
        advanced: [{ torch: next } as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setHasTorch(false);
    }
  }

  const problem = status.kind === "problem" ? status.problem : null;
  return (
    <>
      <div className="space-y-1 pr-1">
        <DialogTitle className="text-lg">{title}</DialogTitle>
        <DialogDescription>
          {continuous
            ? "Apunta a un código a la vez; puedes leer varios seguidos."
            : "Apunta al código y espera a que lo lea."}
        </DialogDescription>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-muted">
        <video
          ref={video}
          muted
          playsInline
          aria-hidden="true"
          className="size-full object-cover"
        />
        {status.kind === "scanning" && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-[12%] top-1/2 h-[38%] -translate-y-1/2 overflow-hidden rounded-lg ring-3 ring-qr"
          >
            <span className="absolute inset-x-0 top-1/2 h-0.5 bg-primary motion-safe:animate-pulse" />
          </div>
        )}
        {status.kind === "starting" && (
          <p className="absolute inset-0 grid place-items-center p-4 text-center text-muted-foreground">
            Abriendo la cámara…
          </p>
        )}
        {problem && (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
          >
            <CircleAlert
              aria-hidden="true"
              className="size-8 text-destructive"
            />
            <p className="max-w-xs text-foreground">
              {CAMERA_PROBLEMS[problem]}
            </p>
          </div>
        )}
      </div>
      <p
        aria-live="polite"
        className="flex min-h-6 items-center gap-2 text-base [overflow-wrap:anywhere]"
      >
        {several ? (
          "Hay más de un código a la vista: acércate solo al que quieres."
        ) : read.last ? (
          <>
            <ScanLine aria-hidden="true" className="size-5 text-success" />
            <span>
              Leído: <span className="font-mono font-medium">{read.last}</span>
              {continuous &&
                (read.count === 1 ? " · 1 código" : ` · ${read.count} códigos`)}
            </span>
          </>
        ) : null}
      </p>
      <div className="flex gap-2">
        {hasTorch && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-14"
            aria-pressed={torchOn}
            onClick={() => void toggleTorch()}
          >
            <Flashlight aria-hidden="true" data-icon="inline-start" />
            Linterna
          </Button>
        )}
        <Button
          type="button"
          size="lg"
          className="min-h-14 flex-1 text-base"
          onClick={() => handlers.current.onClose()}
        >
          Cerrar
        </Button>
      </div>
    </>
  );
}
