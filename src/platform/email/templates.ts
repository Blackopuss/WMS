import type { EmailAttachment, EmailMessage } from "./send";

/** Spanish email copy. Plain text first: readable in every client. */

export function verificationEmail(input: {
  to: string;
  name: string;
  url: string;
  hours: number;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Confirma tu correo para WMS",
    actionUrl: input.url,
    text: [
      `Hola, ${input.name}:`,
      "",
      "Para activar tu cuenta de WMS, abre este enlace y entra con la contraseña que elegiste:",
      input.url,
      "",
      `El enlace vence en ${input.hours} horas.`,
      "Si no creaste esta cuenta, ignora este mensaje: sin la contraseña nadie puede activarla.",
    ].join("\n"),
  };
}

export function existingAccountEmail(input: {
  to: string;
  name: string;
  signInUrl: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Alguien intentó crear una cuenta con tu correo",
    actionUrl: input.signInUrl,
    text: [
      `Hola, ${input.name}:`,
      "",
      "Recibimos un intento de crear una cuenta nueva de WMS con este correo, pero ya tienes una.",
      "Si fuiste tú, inicia sesión con tu cuenta actual:",
      input.signInUrl,
      "Si no recuerdas su contraseña (o no la elegiste tú), usa «¿Olvidaste tu contraseña?» en esa pantalla.",
      "",
      "Si no fuiste tú, no necesitas hacer nada: tu cuenta no cambió.",
    ].join("\n"),
  };
}

export function passwordResetEmail(input: {
  to: string;
  name: string;
  url: string;
  minutes: number;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Restablece tu contraseña de WMS",
    actionUrl: input.url,
    text: [
      `Hola, ${input.name}:`,
      "",
      "Recibimos una solicitud para restablecer la contraseña de tu cuenta de WMS. Elige una nueva con este enlace:",
      input.url,
      "",
      `El enlace vence en ${input.minutes} minutos y solo funciona una vez.`,
      "Si no lo pediste, ignora este mensaje: tu contraseña no cambiará.",
    ].join("\n"),
  };
}

export function passwordChangedEmail(input: {
  to: string;
  name: string;
  recoverUrl: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Tu contraseña de WMS cambió",
    actionUrl: input.recoverUrl,
    text: [
      `Hola, ${input.name}:`,
      "",
      "La contraseña de tu cuenta de WMS se acaba de cambiar y cerramos todas tus sesiones abiertas.",
      "",
      "Si no fuiste tú, restablécela de inmediato con este enlace:",
      input.recoverUrl,
    ].join("\n"),
  };
}

export function mfaEnabledEmail(input: {
  to: string;
  name: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Activaste la verificación en dos pasos",
    text: [
      `Hola, ${input.name}:`,
      "",
      "Tu cuenta de WMS ahora pide un código de tu app de autenticación además de tu contraseña.",
      "",
      "Si no fuiste tú, cambia tu contraseña de inmediato y escríbenos.",
    ].join("\n"),
  };
}

export function backupCodeUsedEmail(input: {
  to: string;
  name: string;
  left: number;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Entraste con un código de recuperación",
    text: [
      `Hola, ${input.name}:`,
      "",
      "Se inició sesión en tu cuenta de WMS con un código de recuperación. Ese código ya no sirve.",
      input.left === 1
        ? "Te queda 1 código de recuperación."
        : `Te quedan ${input.left} códigos de recuperación.`,
      "Si perdiste tu teléfono, genera códigos nuevos en Configuración → Seguridad.",
      "",
      "Si no fuiste tú, cambia tu contraseña de inmediato.",
    ].join("\n"),
  };
}

export function backupCodesRegeneratedEmail(input: {
  to: string;
  name: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Generaste nuevos códigos de recuperación",
    text: [
      `Hola, ${input.name}:`,
      "",
      "Se generaron nuevos códigos de recuperación para tu cuenta de WMS. Los anteriores ya no sirven.",
      "",
      "Si no fuiste tú, cambia tu contraseña de inmediato.",
    ].join("\n"),
  };
}

export function mfaDisabledEmail(input: {
  to: string;
  name: string;
}): EmailMessage {
  return {
    to: input.to,
    subject: "Desactivaste la verificación en dos pasos",
    text: [
      `Hola, ${input.name}:`,
      "",
      "Tu cuenta de WMS ya no pide un código de tu app al iniciar sesión.",
      "",
      "Si no fuiste tú, cambia tu contraseña de inmediato y vuelve a activarla en Configuración → Seguridad.",
    ].join("\n"),
  };
}

export function invitationEmail(input: {
  to: string;
  organizationName: string;
  inviterName: string;
  roleLabels: string[];
  url: string;
  days: number;
}): EmailMessage {
  return {
    to: input.to,
    // Names are written by people: one line, bounded (security audit).
    subject: `${oneLine(input.inviterName, 60)} te invitó a ${oneLine(input.organizationName, 80)} en WMS`,
    actionUrl: input.url,
    text: [
      "Hola:",
      "",
      `${input.inviterName} te invitó a trabajar en «${input.organizationName}» en WMS como ${input.roleLabels.join(" y ")}.`,
      "Acepta la invitación con este enlace:",
      input.url,
      "",
      `El enlace vence en ${input.days} días y solo funciona una vez.`,
      "Si no esperabas esta invitación, ignora este mensaje.",
    ].join("\n"),
  };
}

/** A name as it may go into a subject: one line, without control characters. */
const oneLine = (text: string, max: number) =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * A purchase order for a supplier, with its PDF (CMP-06B). The supplier
 * is not a user of the system: the message says who sends it and answers
 * go to that person, never to the system.
 */
export function purchaseOrderEmail(input: {
  to: string;
  /** Who is greeted: the contact person, or the supplier. */
  greeting: string;
  organizationName: string;
  orderNumber: string;
  /** «20 de octubre de 2026», when the order says it. */
  expectedOn?: string | null;
  sender: { name: string; email: string };
  pdf: EmailAttachment;
}): EmailMessage {
  const company = oneLine(input.organizationName, 100);
  return {
    to: input.to,
    replyTo: input.sender.email,
    subject: `Orden de compra ${oneLine(input.orderNumber, 20)} de ${company}`,
    attachments: [input.pdf],
    text: [
      `Hola, ${oneLine(input.greeting, 120)}:`,
      "",
      `${company} te envía su orden de compra ${input.orderNumber}. Va adjunta en PDF.`,
      ...(input.expectedOn
        ? [`La esperamos para el ${input.expectedOn}.`]
        : []),
      "",
      `Para confirmarla o si tienes dudas, responde a este correo: le llega a ${oneLine(input.sender.name, 120)} (${input.sender.email}).`,
      "",
      `Este mensaje se envió desde WMS a nombre de ${company}. Si no esperabas esta orden, ignora el mensaje.`,
    ].join("\n"),
  };
}

/** Operations alert for whoever runs the server (PIL-04). */
export function operationsAlertEmail(input: {
  to: string;
  server: string;
  failed: string[];
  recovered: string[];
  stillFailing: string[];
}): EmailMessage {
  const list = (items: string[]) => items.map((item) => `- ${item}`);
  return {
    to: input.to,
    subject:
      input.failed.length > 0
        ? `Almacén: falla en el servidor (${input.server})`
        : `Almacén: el servidor se recuperó (${input.server})`,
    text: [
      ...(input.failed.length > 0
        ? ["Empezó a fallar:", ...list(input.failed), ""]
        : []),
      ...(input.recovered.length > 0
        ? ["Ya funciona otra vez:", ...list(input.recovered), ""]
        : []),
      ...(input.stillFailing.length > 0
        ? ["Sigue fallando:", ...list(input.stillFailing), ""]
        : []),
      "Estado en el servidor: curl -s localhost:3000/api/salud",
      "Registros: journalctl -u almacen-web -u almacen-worker -u almacen-respaldo -n 100",
      "",
      "Avisamos cuando algo empieza a fallar y cuando se recupera, no mientras siga igual.",
    ].join("\n"),
  };
}

/**
 * Notices of the app that a person asked to also get by mail (WMS-39B,
 * ADR 0060). The texts are the notices' own (one line, nothing the person
 * may not see); each leads to its screen. One mail gathers several.
 */
export function noticeEmail(input: {
  to: string;
  organizationName: string;
  items: { text: string; url: string }[];
  /** Notices left out of the list. */
  more: number;
  /** The list of notices of the app. */
  allUrl: string;
  /** Where the person stops getting them by mail. */
  settingsUrl: string;
}): EmailMessage {
  const company = oneLine(input.organizationName, 80);
  const total = input.items.length + input.more;
  const [first] = input.items;
  const subject =
    total === 1 && first
      ? `${company}: ${oneLine(first.text, 110)}`
      : `${company}: ${total} avisos nuevos`;
  return {
    to: input.to,
    subject,
    actionUrl: total === 1 && first ? first.url : input.allUrl,
    text: [
      "Hola:",
      "",
      total === 1
        ? `Tienes un aviso nuevo en ${company}:`
        : `Tienes ${total} avisos nuevos en ${company}:`,
      "",
      ...input.items.flatMap((item) => [
        `- ${oneLine(item.text, 300)}`,
        `  ${item.url}`,
      ]),
      ...(input.more > 0
        ? [
            "",
            `Y ${input.more} ${input.more === 1 ? "aviso más" : "avisos más"}: ${input.allUrl}`,
          ]
        : []),
      "",
      `Recibes este correo porque lo pediste en WMS. Para dejar de recibirlo: ${input.settingsUrl}`,
    ].join("\n"),
  };
}

/**
 * The daily summary of a person (WMS-39B, ADR 0060): what asks for
 * attention today, in sections already built by the modules (the platform
 * does not know what they are about). Never sent empty.
 */
export function dailyDigestEmail(input: {
  to: string;
  organizationName: string;
  /** «14 de noviembre de 2026». */
  dayLabel: string;
  sections: {
    title: string;
    lines: string[];
    /** Lines left out, and the screen that has them all. */
    more: number;
    url: string;
    note?: string;
  }[];
  settingsUrl: string;
}): EmailMessage {
  const company = oneLine(input.organizationName, 80);
  return {
    to: input.to,
    subject: `${company}: resumen del ${oneLine(input.dayLabel, 40)}`,
    actionUrl: input.sections[0]?.url,
    text: [
      "Hola:",
      "",
      `Esto pide atención hoy en ${company}:`,
      ...input.sections.flatMap((section) => [
        "",
        oneLine(section.title, 120),
        ...section.lines.map((line) => `- ${oneLine(line, 300)}`),
        section.more > 0
          ? `Y ${section.more} más: ${section.url}`
          : `Ver en WMS: ${section.url}`,
        ...(section.note ? [oneLine(section.note, 200)] : []),
      ]),
      "",
      `Recibes este resumen porque lo pediste en WMS. Para dejar de recibirlo: ${input.settingsUrl}`,
    ].join("\n"),
  };
}

/**
 * Alert of a suspicious access to the person's own account (WMS-68, ADR
 * 0064): a device or browser never seen before, or many wrong tries that
 * blocked it. No access links: only where to recover the password (no
 * token) and where to see the history.
 */
export function accessAlertEmail(input: {
  to: string;
  name: string;
  kind: "new_device" | "failed_attempts";
  /** «16 nov 2026, 10:42». */
  when: string;
  /** «Chrome en Android»; only for a new device. */
  device?: string;
  /** IP of the sign-in into their own account; only for a new device. */
  ipAddress?: string | null;
  recoverUrl: string;
  historyUrl: string;
}): EmailMessage {
  const name = oneLine(input.name, 80);
  const lines =
    input.kind === "new_device"
      ? [
          `Se inició sesión en tu cuenta de WMS desde un dispositivo o navegador que no habías usado: ${oneLine(input.device ?? "Otro navegador", 80)}.`,
          `Cuándo: ${input.when}.`,
          ...(input.ipAddress ? [`Dirección IP: ${input.ipAddress}.`] : []),
          "",
          "Si fuiste tú, no tienes que hacer nada.",
          "Si no fuiste tú, cambia tu contraseña de inmediato:",
        ]
      : [
          "Hubo muchos intentos fallidos de entrar a tu cuenta de WMS y la bloqueamos un rato para protegerla.",
          `Cuándo: ${input.when}.`,
          "",
          "Si fuiste tú, espera unos minutos e inténtalo de nuevo.",
          "Si no fuiste tú, tu cuenta sigue protegida; si crees que alguien conoce tu contraseña, cámbiala:",
        ];
  return {
    to: input.to,
    subject:
      input.kind === "new_device"
        ? "Nuevo inicio de sesión en tu cuenta de WMS"
        : "Intentos fallidos de entrar a tu cuenta de WMS",
    text: [
      `Hola, ${name}:`,
      "",
      ...lines,
      input.recoverUrl,
      "",
      `Revisa tus accesos en Configuración › Seguridad › Historial de accesos: ${input.historyUrl}`,
    ].join("\n"),
  };
}
