import type { SettingDefinition } from "@/platform/settings";

/**
 * Settings of shared terminals (WMS-38, ADR 0061 §10). Shown and changed
 * on the terminals screen (not in Operación: one way to change each
 * thing). Pure data: the role sets themselves live in `platform/auth`
 * (`PIN_ROLE_SETS`), which reads the value on every request;
 * settings.test.ts checks both lists agree.
 */
export const PIN_ROLES: SettingDefinition = {
  key: "platform.terminal.pin_roles",
  module: null,
  area: "Terminales compartidas",
  label: "Quién puede entrar con PIN",
  options: [
    {
      value: "floor",
      label: "Almacenistas y montacarguistas",
      help: "Solo el personal de piso.",
    },
    {
      value: "floor_supervision",
      label: "Piso y supervisión",
      help: "Además Supervisor de almacén y Almacén.",
    },
    {
      value: "without_mfa",
      label: "Todos los que no usan verificación en dos pasos",
      help: "Además Comprador, Consulta y Gerencia. Titulares y administradores nunca.",
    },
  ],
  defaultValue: "floor",
};

export const PIN_LENGTH: SettingDefinition = {
  key: "platform.terminal.pin_length",
  module: null,
  area: "Terminales compartidas",
  label: "Largo del PIN",
  options: [
    { value: "6", label: "6 dígitos", help: "Lo recomendado." },
    {
      value: "5",
      label: "5 dígitos",
      help: "Más rápido de escribir, pero diez veces más fácil de adivinar.",
    },
  ],
  defaultValue: "6",
};

export const IDLE_MINUTES: SettingDefinition = {
  key: "platform.terminal.idle_minutes",
  module: null,
  area: "Terminales compartidas",
  label: "Cerrar la sesión sin actividad después de",
  options: [
    { value: "2", label: "2 minutos", help: "Para pantallas muy concurridas." },
    { value: "5", label: "5 minutos", help: "Lo recomendado." },
    { value: "10", label: "10 minutos", help: "Para tareas largas." },
    { value: "15", label: "15 minutos", help: "El máximo." },
  ],
  defaultValue: "5",
};

export const TERMINAL_SETTINGS: readonly SettingDefinition[] = [
  PIN_ROLES,
  PIN_LENGTH,
  IDLE_MINUTES,
];
