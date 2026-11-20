import "server-only";

import { notify } from "@/platform/notifications";
import { forOrganization } from "@/server";

import type { AutomationAction } from "./definitions";
import { RULE_FIRED_NOTICE } from "./notices";

/**
 * «Avisar» (WMS-64, ADR 0092): the action of the platform. The notice goes
 * to the chosen roles and people, but only to who holds the permission to
 * read what the trigger describes and reaches its place (the same filter of
 * every notice, ADR 0084), with their preferences and their mail. It names
 * the rule, the line of the fact and the note; never costs.
 */
export const NOTIFY_ACTION: AutomationAction = {
  key: "platform.notify",
  module: null,
  label: "Avisar",
  description:
    "Un aviso en la campana (y por correo a quien lo pidió) a los roles o personas que elijas que puedan ver eso.",
  permissions: [],
  options: [
    { key: "roles", label: "A los roles", kind: "roles", optional: true },
    { key: "people", label: "A las personas", kind: "people", optional: true },
    { key: "note", label: "Nota", kind: "text", optional: true },
  ],
  check(options) {
    const roles = Array.isArray(options.roles) ? options.roles : [];
    const people = Array.isArray(options.people) ? options.people : [];
    return roles.length === 0 && people.length === 0
      ? "Elige al menos un rol o una persona."
      : null;
  },
  async run(context) {
    const { organizationId, subject, options, rule } = context;
    const roles = (Array.isArray(options.roles) ? options.roles : []).map(
      String,
    );
    const people = (Array.isArray(options.people) ? options.people : []).map(
      String,
    );
    const note = typeof options.note === "string" ? options.note : "";
    const text = `${rule.name}: ${subject.summary}${note ? ` · ${note}` : ""}`;
    const place = {
      ...(subject.facilityId ? { facilityId: subject.facilityId } : {}),
      ...(subject.locationIds.length > 0
        ? { locationIds: subject.locationIds }
        : {}),
      // A figure of the whole company: only who sees the whole company.
      ...(subject.facilityId === null ? { wholeCompany: true } : {}),
    };
    const key = `automation:${context.run.id}:${context.run.index}`;
    const sent = await forOrganization(organizationId).$transaction(
      async (tx) => {
        let count = 0;
        if (roles.length > 0) {
          count += (
            await notify(tx, RULE_FIRED_NOTICE, {
              organizationId,
              actorUserId: null,
              to: { permissions: [context.readPermission], roles, ...place },
              text,
              href: subject.href,
              key,
            })
          ).sent;
        }
        if (people.length > 0) {
          count += (
            await notify(tx, RULE_FIRED_NOTICE, {
              organizationId,
              actorUserId: null,
              to: {
                userIds: people,
                permissions: [context.readPermission],
                ...place,
              },
              text,
              href: subject.href,
              key,
            })
          ).sent;
        }
        return count;
      },
    );
    return {
      kind: "done",
      line:
        sent === 0
          ? "Nadie más que avisar: ya lo sabían o nadie de esos roles alcanza ese lugar."
          : sent === 1
            ? "Se avisó a 1 persona."
            : `Se avisó a ${sent} personas.`,
    };
  },
};
