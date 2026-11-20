import { CircleAlert } from "lucide-react";

export type RoleOption = { id: string; label: string };

const ROLE_HINTS: Record<string, string> = {
  administrator: "Opera todo y administra al equipo. No contrata ni cobra.",
  warehouse: "Productos, ubicaciones, movimientos y conteos.",
  buyer: "Proveedores, órdenes de compra, recepciones y costos.",
  viewer: "Solo consulta. No ve precios ni costos.",
  supervisor:
    "Reparte y revisa las tareas, recibe mercancía y corrige existencias.",
  operator:
    "Recibe, guarda, surte y cuenta. No corrige existencias ni ve costos.",
  forklift: "Solo ve y hace las tareas de mover que le tocan.",
  manager: "Ve y descarga todo, incluidos costos. No cambia nada.",
  production_operator:
    "Reporta lo que produce y pide producción. No crea órdenes ni ve costos.",
  production_supervisor:
    "Manda las órdenes de su área y decide las solicitudes. No ve costos.",
  quality_inspector:
    "Cuenta, inspecciona y libera lo producido. No produce ni ve costos.",
};

/** Role choices as large checkboxes; several roles join their permissions. */
export function RoleCheckboxes({
  options,
  defaultSelected = [],
  error,
  idPrefix,
  legend = "Roles",
  note = "Puedes elegir varios: sus permisos se suman y la persona ocupa un solo lugar.",
}: {
  options: RoleOption[];
  defaultSelected?: string[];
  error?: string;
  idPrefix: string;
  legend?: string;
  note?: string;
}) {
  const errorId = error ? `${idPrefix}-roles-error` : undefined;
  return (
    <fieldset aria-describedby={errorId} className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <p className="text-sm text-muted-foreground">{note}</p>
      <div className="grid gap-2">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input
              type="checkbox"
              name="roles"
              value={option.id}
              defaultChecked={defaultSelected.includes(option.id)}
              className="mt-0.5 size-5 shrink-0 accent-primary outline-none"
            />
            <span className="min-w-0">
              <span className="block font-medium">{option.label}</span>
              <span className="block text-sm text-muted-foreground">
                {ROLE_HINTS[option.id]}
              </span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-sm text-destructive"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </fieldset>
  );
}
