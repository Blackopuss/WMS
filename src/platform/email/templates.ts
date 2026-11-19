import { htmlEmail, type HtmlBlock } from "./html";
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
  /**
   * Links to stop every notice by mail without signing in (WMS-88): the
   * page for the body, the one-click address for List-Unsubscribe.
   */
  unsubscribe?: { pageUrl: string; oneClickUrl: string };
}): EmailMessage {
  const company = oneLine(input.organizationName, 80);
  const total = input.items.length + input.more;
  const [first] = input.items;
  const subject =
    total === 1 && first
      ? `${company}: ${oneLine(first.text, 110)}`
      : `${company}: ${total} avisos nuevos`;
  const intro =
    total === 1
      ? `Tienes un aviso nuevo en ${company}:`
      : `Tienes ${total} avisos nuevos en ${company}:`;
  const moreText =
    input.more > 0
      ? `Y ${input.more} ${input.more === 1 ? "aviso más" : "avisos más"}`
      : null;
  const why = "Recibes este correo porque lo pediste en WMS.";
  return {
    to: input.to,
    subject,
    actionUrl: total === 1 && first ? first.url : input.allUrl,
    text: [
      "Hola:",
      "",
      intro,
      "",
      ...input.items.flatMap((item) => [
        `- ${oneLine(item.text, 300)}`,
        `  ${item.url}`,
      ]),
      ...(moreText ? ["", `${moreText}: ${input.allUrl}`] : []),
      "",
      `${why} Para dejar de recibirlo: ${input.settingsUrl}`,
      ...unsubscribeLines(input.unsubscribe?.pageUrl),
    ].join("\n"),
    html: htmlEmail({
      title: subject,
      blocks: [
        { kind: "paragraph", text: "Hola:" },
        { kind: "paragraph", text: intro },
        {
          kind: "items",
          items: input.items.map((item) => ({
            text: oneLine(item.text, 300),
            url: item.url,
          })),
        },
        ...(moreText
          ? [{ kind: "link" as const, text: moreText, url: input.allUrl }]
          : []),
      ],
      footer: footerLines(why, input.settingsUrl, input.unsubscribe?.pageUrl),
    }),
    ...oneClickHeader(input.unsubscribe?.oneClickUrl),
  };
}

/**
 * The one-click header only with a full web address: without the address
 * of the app (BETTER_AUTH_URL, development) the mail goes out without it
 * instead of failing (review of WMS-88).
 */
function oneClickHeader(url: string | undefined): { unsubscribeUrl?: string } {
  return url && /^https?:\/\/[^/\s]/.test(url) ? { unsubscribeUrl: url } : {};
}

function unsubscribeLines(url: string | undefined): string[] {
  return url
    ? [`Para dejar de recibir todos los avisos por correo sin entrar: ${url}`]
    : [];
}

function footerLines(
  why: string,
  settingsUrl: string,
  unsubscribeUrl: string | undefined,
) {
  return [
    {
      text: `${why} Elige cuáles recibes en`,
      url: settingsUrl,
      linkText: "Avisos que recibo",
    },
    ...(unsubscribeUrl
      ? [
          {
            text: "O deja de recibir todos los avisos por correo sin entrar:",
            url: unsubscribeUrl,
            linkText: "Darme de baja",
          },
        ]
      : []),
  ];
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
  /**
   * Links to stop every notice by mail without signing in (WMS-88): the
   * page for the body, the one-click address for List-Unsubscribe.
   */
  unsubscribe?: { pageUrl: string; oneClickUrl: string };
}): EmailMessage {
  const company = oneLine(input.organizationName, 80);
  const subject = `${company}: resumen del ${oneLine(input.dayLabel, 40)}`;
  const why = "Recibes este resumen porque lo pediste en WMS.";
  const blocks: HtmlBlock[] = [
    { kind: "paragraph", text: "Hola:" },
    { kind: "paragraph", text: `Esto pide atención hoy en ${company}:` },
  ];
  for (const section of input.sections) {
    blocks.push({ kind: "heading", text: oneLine(section.title, 120) });
    blocks.push({
      kind: "items",
      items: section.lines.map((line) => ({ text: oneLine(line, 300) })),
    });
    blocks.push({
      kind: "link",
      text: section.more > 0 ? `Y ${section.more} más` : "Ver en WMS",
      url: section.url,
    });
    if (section.note) {
      blocks.push({ kind: "note", text: oneLine(section.note, 200) });
    }
  }
  return {
    to: input.to,
    subject,
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
      `${why} Para dejar de recibirlo: ${input.settingsUrl}`,
      ...unsubscribeLines(input.unsubscribe?.pageUrl),
    ].join("\n"),
    html: htmlEmail({
      title: subject,
      blocks,
      footer: footerLines(why, input.settingsUrl, input.unsubscribe?.pageUrl),
    }),
    ...oneClickHeader(input.unsubscribe?.oneClickUrl),
  };
}

/** What an access alert is about (WMS-68). */
export type AccessAlertKind =
  | "new_device"
  | "password_new_device"
  | "failed_attempts"
  | "code_locked"
  | "pin_locked";

/**
 * Alert of a suspicious access to the person's own account (WMS-68, ADR
 * 0064). No access links: only where to recover the password (no token)
 * and where to see the history. The IP only where it is the person's own
 * account being entered from a new device.
 */
export function accessAlertEmail(input: {
  to: string;
  name: string;
  kind: AccessAlertKind;
  /** «16 nov 2026, 10:42». */
  when: string;
  /** «Chrome en Android». */
  device: string;
  ipAddress?: string | null;
  recoverUrl: string;
  historyUrl: string;
}): EmailMessage {
  const name = oneLine(input.name, 80);
  const device = oneLine(input.device, 80);
  const when = `Cuándo: ${input.when}.`;
  const ip =
    input.ipAddress &&
    input.kind !== "failed_attempts" &&
    input.kind !== "code_locked" &&
    input.kind !== "pin_locked"
      ? [`Dirección IP: ${input.ipAddress}.`]
      : [];
  const body: Record<AccessAlertKind, { subject: string; lines: string[] }> = {
    new_device: {
      subject: "Nuevo inicio de sesión en tu cuenta de WMS",
      lines: [
        `Se inició sesión en tu cuenta de WMS desde un dispositivo o navegador que no habías usado: ${device}.`,
        when,
        ...ip,
        "",
        "Si fuiste tú, no tienes que hacer nada.",
        "Si no fuiste tú, cambia tu contraseña de inmediato:",
      ],
    },
    password_new_device: {
      subject: "Alguien escribió tu contraseña de WMS",
      lines: [
        `Alguien escribió bien tu contraseña de WMS desde un dispositivo o navegador que no habías usado (${device}), pero no pasó el código de verificación.`,
        when,
        ...ip,
        "",
        "Si fuiste tú, no tienes que hacer nada.",
        "Si no fuiste tú, alguien conoce tu contraseña: cámbiala de inmediato:",
      ],
    },
    failed_attempts: {
      subject: "Intentos fallidos de entrar a tu cuenta de WMS",
      lines: [
        "Hubo muchos intentos fallidos de entrar a tu cuenta de WMS y la bloqueamos un rato para protegerla.",
        when,
        "",
        "Si fuiste tú, espera unos minutos e inténtalo de nuevo.",
        "Si no fuiste tú, tu cuenta sigue protegida; si crees que alguien conoce tu contraseña, cámbiala:",
      ],
    },
    code_locked: {
      subject: "Alguien tiene tu contraseña de WMS",
      lines: [
        "Alguien escribió bien tu contraseña de WMS pero falló muchas veces el código de verificación, y bloqueamos tu cuenta un rato.",
        when,
        "",
        "Si fuiste tú, espera unos minutos e inténtalo de nuevo.",
        "Si no fuiste tú, alguien conoce tu contraseña: cámbiala de inmediato:",
      ],
    },
    pin_locked: {
      subject: "Bloqueamos tu PIN de WMS",
      lines: [
        "Alguien escribió muchas veces un PIN equivocado a tu nombre en una terminal compartida y lo bloqueamos un rato. Tu cuenta y tu contraseña no cambiaron.",
        when,
        "",
        "Si fuiste tú, espera unos minutos o entra con tu contraseña desde tu propio dispositivo para desbloquearlo.",
        "Si no fuiste tú, cambia tu PIN en Configuración › Mi PIN. Para recuperar tu contraseña:",
      ],
    },
  };
  const { subject, lines } = body[input.kind];
  return {
    to: input.to,
    subject,
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
