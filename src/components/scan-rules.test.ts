import { describe, expect, it } from "vitest";

import {
  CAMERA_PROBLEMS,
  cameraProblem,
  createReadFilter,
  scanFormats,
  singleCode,
} from "./scan-rules";

describe("scanFormats (WMS-36)", () => {
  it("asks for what labels and products carry, only if the browser reads it", () => {
    expect(
      scanFormats([
        "aztec",
        "qr_code",
        "ean_13",
        "code_128",
        "upc_a",
        "pdf417",
      ]),
    ).toEqual(["code_128", "ean_13", "upc_a", "qr_code"]);
    expect(scanFormats([])).toEqual([]);
  });

  it("covers Code 128 and QR, which WMS-26 prints, and EAN/UPC", () => {
    const all = scanFormats([
      "code_128",
      "qr_code",
      "ean_13",
      "ean_8",
      "upc_a",
      "upc_e",
    ]);
    expect(all).toHaveLength(6);
  });
});

describe("singleCode", () => {
  it("takes the one code in view, trimmed", () => {
    expect(singleCode([" A-01-03 "])).toEqual({ code: "A-01-03" });
    // The same label read twice in one frame is still one code.
    expect(singleCode(["C-0001", "C-0001"])).toEqual({ code: "C-0001" });
  });

  it("takes nothing when two different codes are in view", () => {
    expect(singleCode(["A-01-03", "A-01-04"])).toEqual({ none: "several" });
    expect(singleCode(["", "  "])).toEqual({ none: "nothing" });
    expect(singleCode([])).toEqual({ none: "nothing" });
  });
});

describe("createReadFilter", () => {
  it("delivers a label once while it stays in view", () => {
    const accept = createReadFilter(1000);
    expect(accept("7501234567890", 0)).toBe(true);
    // Still in front of the camera, frame after frame, for seconds.
    for (let t = 120; t <= 3000; t += 120) {
      expect(accept("7501234567890", t)).toBe(false);
    }
  });

  it("delivers it again after it was out of view for the gap", () => {
    const accept = createReadFilter(1000);
    expect(accept("SKU-1", 0)).toBe(true);
    expect(accept("SKU-1", 500)).toBe(false);
    // Taken away and shown again 1 s later: a second reading, as with a
    // reader.
    expect(accept("SKU-1", 1600)).toBe(true);
  });

  it("delivers different labels one after another", () => {
    const accept = createReadFilter(1000);
    expect(accept("S-001", 0)).toBe(true);
    expect(accept("S-002", 200)).toBe(true);
    expect(accept("S-001", 400)).toBe(false);
    expect(accept("S-003", 600)).toBe(true);
  });
});

describe("cameraProblem", () => {
  it("names each failure of getUserMedia", () => {
    expect(cameraProblem("NotAllowedError")).toBe("denied");
    expect(cameraProblem("NotFoundError")).toBe("no_camera");
    expect(cameraProblem("OverconstrainedError")).toBe("no_camera");
    expect(cameraProblem("NotReadableError")).toBe("busy");
    expect(cameraProblem("TypeError")).toBe("failed");
    expect(cameraProblem(undefined)).toBe("failed");
  });

  it("always offers typing the code instead", () => {
    for (const text of Object.values(CAMERA_PROBLEMS)) {
      expect(text).toMatch(/escribe el código en el campo\.$/i);
    }
  });
});
