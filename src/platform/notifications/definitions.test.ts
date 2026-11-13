import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_TEXT_MAX,
  assertValidNotificationTypes,
  noticeText,
} from "./definitions";

describe("notification types (WMS-39)", () => {
  it("rejects bad or repeated keys", () => {
    expect(() =>
      assertValidNotificationTypes([{ key: "Bad key", label: "x" }]),
    ).toThrow();
    expect(() =>
      assertValidNotificationTypes([
        { key: "a.b", label: "x" },
        { key: "a.b", label: "y" },
      ]),
    ).toThrow();
    expect(() =>
      assertValidNotificationTypes([{ key: "a.b", label: " " }]),
    ).toThrow();
    expect(() =>
      assertValidNotificationTypes([
        { key: "inventory.task_assigned", label: "Tarea" },
      ]),
    ).not.toThrow();
  });

  it("keeps the text in one short line", () => {
    expect(noticeText("  Hola\n\tmundo  ")).toBe("Hola mundo");
    const long = noticeText("a".repeat(NOTIFICATION_TEXT_MAX + 50));
    expect(long).toHaveLength(NOTIFICATION_TEXT_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(noticeText("\n\n")).toBe("");
  });
});
