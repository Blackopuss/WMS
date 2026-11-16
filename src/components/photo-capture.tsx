"use client";

import { Camera } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { Button } from "./ui/button";

/**
 * Taking photos as evidence (WMS-37, ADR 0063). «Tomar foto» opens the
 * back camera of the phone (the file picker on a computer); the browser
 * reduces the photo and encodes it again as JPEG with a canvas — smaller,
 * already turned the right way and without metadata (the server removes
 * them again, it does not trust this) — and uploads it right away with the
 * Server Action of the screen. The form sends only the ids it got back
 * (hidden fields `name`).
 *
 * The list lives in the parent (`photos` + `onPhotosChange`) so a form
 * that is rebuilt after a refused answer keeps what was taken.
 */

export type CapturedPhoto = {
  fileId: string;
  /** A `blob:` address of the reduced photo, only in this browser. */
  preview: string;
};

export type PhotoUploadResult =
  { ok: true; fileId: string } | { ok: false; error: string };

/** Longest side of what is uploaded, and its JPEG quality. */
const MAX_SIDE = 1600;
const QUALITY = 0.82;

async function reduce(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", QUALITY),
    );
    if (!blob) throw new Error("no blob");
    return blob;
  } finally {
    bitmap.close();
  }
}

export function PhotoCapture({
  id,
  label,
  hint,
  error,
  name = "photoIds",
  photos,
  onPhotosChange,
  upload,
  discard,
  max,
}: {
  id: string;
  label: string;
  hint?: string;
  /** What the server said of the photos when the form was refused. */
  error?: string;
  name?: string;
  photos: CapturedPhoto[];
  onPhotosChange: Dispatch<SetStateAction<CapturedPhoto[]>>;
  upload: (formData: FormData) => Promise<PhotoUploadResult>;
  /** Removes a photo taken and not saved, so it stops counting. */
  discard: (fileId: string) => Promise<unknown>;
  max: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // The previews are freed when the form goes away.
  const kept = useRef(photos);
  useEffect(() => {
    kept.current = photos;
  }, [photos]);
  useEffect(
    () => () => {
      for (const photo of kept.current) URL.revokeObjectURL(photo.preview);
    },
    [],
  );

  async function take(files: FileList | null) {
    const chosen = [...(files ?? [])].slice(
      0,
      Math.max(0, max - photos.length),
    );
    if (chosen.length === 0) return;
    setBusy(true);
    setProblem(null);
    let added = 0;
    for (const file of chosen) {
      setStatus("Subiendo foto…");
      let blob: Blob;
      try {
        blob = await reduce(file);
      } catch {
        setProblem(
          "No pudimos leer esa foto. Tómala otra vez con la cámara del teléfono.",
        );
        continue;
      }
      const data = new FormData();
      data.set("photo", blob, "foto.jpg");
      let result: PhotoUploadResult;
      try {
        result = await upload(data);
      } catch {
        setProblem(
          "No se pudo subir la foto. Revisa la conexión e inténtalo otra vez.",
        );
        continue;
      }
      if (!result.ok) {
        setProblem(result.error);
        continue;
      }
      const preview = URL.createObjectURL(blob);
      onPhotosChange((list) => [...list, { fileId: result.fileId, preview }]);
      added++;
    }
    setStatus(
      added === 0
        ? ""
        : added === 1
          ? "Se agregó la foto."
          : `Se agregaron ${added} fotos.`,
    );
    setBusy(false);
  }

  function remove(fileId: string, position: number) {
    onPhotosChange((list) => {
      const gone = list.find((photo) => photo.fileId === fileId);
      if (gone) URL.revokeObjectURL(gone.preview);
      return list.filter((photo) => photo.fileId !== fileId);
    });
    setStatus(`Se quitó la foto ${position}.`);
    // Not saved yet: it goes from the server too. If that fails, it goes
    // away by itself the next day.
    void discard(fileId).catch(() => {});
  }

  // What the browser found and what the server said, both if there are.
  const shown = [problem, error].filter(Boolean).join(" ");
  const describedBy =
    [hint && `${id}-hint`, shown && `${id}-error`].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy}
      className="space-y-2"
    >
      <p id={`${id}-label`} className="text-sm font-medium">
        {label}
      </p>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {photos.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {photos.map((photo, index) => (
            <li key={photo.fileId} className="space-y-1">
              {/* A local blob: preview of what was just taken. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.preview}
                alt={`Foto ${index + 1} de ${photos.length}`}
                className="aspect-square w-full rounded-lg border bg-muted object-cover"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 w-full"
                onClick={() => remove(photo.fileId, index + 1)}
              >
                Quitar
              </Button>
              <input type="hidden" name={name} value={photo.fileId} />
            </li>
          ))}
        </ul>
      )}
      {photos.length < max ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="min-h-11"
        >
          <Camera aria-hidden="true" />
          {busy
            ? "Subiendo foto…"
            : photos.length > 0
              ? "Tomar otra foto"
              : "Tomar foto"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Ya tiene {max} fotos, el máximo.
        </p>
      )}
      <input
        ref={input}
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = event.currentTarget.files;
          void take(files).finally(() => {
            if (input.current) input.current.value = "";
          });
        }}
      />
      <p aria-live="polite" className="sr-only">
        {status}
      </p>
      {shown && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {shown}
        </p>
      )}
    </div>
  );
}
