import { describe, expect, it } from "vitest";

import { formatStorageSize } from "./storage-size";

describe("formatStorageSize", () => {
  it("says KB, MB or GB with one decimal at most", () => {
    expect(formatStorageSize(0)).toBe("0 KB");
    expect(formatStorageSize(850)).toBe("850 KB");
    expect(formatStorageSize(1536)).toBe("1.5 MB");
    expect(formatStorageSize(5 * 1024 * 1024)).toBe("5 GB");
    expect(formatStorageSize(1.25 * 1024 * 1024)).toBe("1.3 GB");
  });
});
