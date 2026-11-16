/**
 * Photos of a record (WMS-37, ADR 0063): thumbnails that open the whole
 * photo. A thumbnail's address is a link made for this person that works
 * for a few minutes, so all of them load right away (no lazy loading);
 * opening the whole photo goes through `/api/archivos/<id>/ver`, which
 * makes a fresh link, so it works however long the screen stayed open.
 * Nothing is kept by the browser (the file answers `no-store`).
 */

export type GalleryPhoto = {
  fileId: string;
  url: string;
  width: number | null;
  height: number | null;
};

export function PhotoGallery({
  photos,
  label,
}: {
  photos: GalleryPhoto[];
  /** What they are photos of, for who cannot see them («INC-0001»). */
  label: string;
}) {
  if (photos.length === 0) return null;
  return (
    <ul aria-label={`Fotos de ${label}`} className="flex flex-wrap gap-2">
      {photos.map((photo, index) => (
        <li key={photo.fileId}>
          <a
            href={`/api/archivos/${photo.fileId}/ver`}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {/* A private file through its own link: not for next/image. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.url}
              alt={`Foto ${index + 1} de ${photos.length} de ${label} (abre la foto completa)`}
              width={photo.width ?? undefined}
              height={photo.height ?? undefined}
              decoding="async"
              className="size-24 rounded-lg border bg-muted object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}
