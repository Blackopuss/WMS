/**
 * «Hace 2 minutos», for the warning of a repeated entry (WMS-71). Pure:
 * whole minutes since it happened, never negative.
 */
export function agoText(minutesAgo: number): string {
  const minutes = Math.max(0, Math.floor(minutesAgo));
  if (minutes < 1) return "Hace menos de un minuto";
  if (minutes < 60) {
    return minutes === 1 ? "Hace 1 minuto" : `Hace ${minutes} minutos`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const whole = hours === 1 ? "Hace 1 hora" : `Hace ${hours} horas`;
  if (rest === 0) return whole;
  return `${whole} y ${rest === 1 ? "1 minuto" : `${rest} minutos`}`;
}
