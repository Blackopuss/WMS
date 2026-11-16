/**
 * A storage size for people (WMS-67): «850 KB», «12.4 MB», «1.2 GB». The
 * storage quota counts KiB; 1 GB here is 1024 × 1024 KiB.
 */
export function formatStorageSize(kib: number): string {
  const value = Math.max(0, kib);
  const format = (n: number) =>
    n.toLocaleString("es-MX", { maximumFractionDigits: 1 });
  if (value < 1024) return `${format(value)} KB`;
  if (value < 1024 * 1024) return `${format(value / 1024)} MB`;
  return `${format(value / (1024 * 1024))} GB`;
}
