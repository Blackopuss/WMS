import { NotFoundContent } from "./not-found-content";

/** An address that does not exist: outside every layout with a <main>. */
export default function NotFound() {
  return (
    <main id="contenido" className="min-h-dvh bg-background">
      <NotFoundContent />
    </main>
  );
}
