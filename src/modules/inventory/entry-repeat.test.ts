import { describe, expect, it } from "vitest";

import { agoText } from "./entry-repeat";

describe("agoText", () => {
  it("says how long ago in minutes and hours", () => {
    expect(agoText(0)).toBe("Hace menos de un minuto");
    expect(agoText(-3)).toBe("Hace menos de un minuto");
    expect(agoText(1)).toBe("Hace 1 minuto");
    expect(agoText(2.9)).toBe("Hace 2 minutos");
    expect(agoText(59)).toBe("Hace 59 minutos");
    expect(agoText(60)).toBe("Hace 1 hora");
    expect(agoText(61)).toBe("Hace 1 hora y 1 minuto");
    expect(agoText(119)).toBe("Hace 1 hora y 59 minutos");
    expect(agoText(120)).toBe("Hace 2 horas");
  });
});
