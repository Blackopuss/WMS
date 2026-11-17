import Link from "next/link";

export type PendingNotice = { href: string; text: string };

/**
 * What waits in the warehouse (to inspect, to put away, about to expire…)
 * as one card with a row per notice (WMS-78B): several loose cards pushed
 * the content of the screen below the fold on a phone. Renders nothing
 * when there is nothing to say.
 */
export function PendingNotices({
  label,
  notices,
}: {
  label: string;
  notices: readonly (PendingNotice | false | null | undefined)[];
}) {
  const shown = notices.filter((notice): notice is PendingNotice =>
    Boolean(notice),
  );
  if (shown.length === 0) return null;
  return (
    <ul
      aria-label={label}
      className="divide-y overflow-hidden rounded-xl border bg-card"
    >
      {shown.map((notice) => (
        <li key={notice.href}>
          <Link
            href={notice.href}
            className="flex min-h-11 items-center gap-2 p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <span className="flex-1">{notice.text}</span>
            <span className="font-medium text-primary">Ver cuáles</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
