import { encode as encodeQr } from "uqr";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_CONTENT,
  codesOf,
  namesOutsideText,
  objectsAreWhereTheTableSays,
  pageSizesOf,
  textsOf,
} from "../../../tests/setup/pdf";
import {
  LABEL_CODE_IDS,
  LABEL_FORMATS,
  LABEL_FORMAT_IDS,
  buildLabelsPdf,
  isLabelCodes,
  isLabelFormat,
  type LabelContent,
} from "./labels";

// WMS-26 (ADR 0047): what is drawn on a label is what was asked, and a
// scanner reads it back.

const qrOf = (code: string) => encodeQr(code, { ecc: "M", border: 0 }).data;

const labels: LabelContent[] = [
  {
    code: "A-01-03",
    title: "Estante 3",
    lines: ["Zona A › Pasillo 1 › Estante 3", "Almacén Central"],
  },
  {
    code: "7501234567890",
    title: "Tornillo hexagonal",
    lines: ["Clave TOR-001"],
  },
  { code: "C-0001", title: "Tarima C-0001" },
];

describe("buildLabelsPdf", () => {
  it("draws each code as a barcode and a QR code that read back", () => {
    for (const format of LABEL_FORMAT_IDS) {
      const file = buildLabelsPdf(labels, {
        format,
        codes: "both",
        title: "Etiquetas",
      });
      expect(objectsAreWhereTheTableSays(file), format).toBe(true);
      const drawn = codesOf(file);
      const barcodes = drawn.flatMap((page) => page.barcodes);
      const qrs = drawn.flatMap((page) => page.qrs);
      expect(barcodes, format).toEqual(labels.map((label) => label.code));
      expect(qrs, format).toEqual(labels.map((label) => qrOf(label.code)));
      // The code is always written, besides what a person reads.
      const text = textsOf(file).join("\n");
      for (const label of labels) {
        expect(text).toContain(label.code);
        expect(text).toContain(label.title);
      }
      expect(text).toContain("Zona A › Pasillo 1 › Estante 3");
    }
  });

  it("puts ten labels on a letter sheet and one on each single label", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      code: `C-${String(index + 1).padStart(4, "0")}`,
      title: `Tarima ${index + 1}`,
    }));
    const sheet = buildLabelsPdf(many, {
      format: "letter_10",
      codes: "both",
      title: "x",
    });
    expect(pageSizesOf(sheet)).toEqual([
      [612, 792],
      [612, 792],
    ]);
    expect(codesOf(sheet).map((page) => page.barcodes.length)).toEqual([10, 2]);
    const single = buildLabelsPdf(many.slice(0, 3), {
      format: "100x50",
      codes: "both",
      title: "x",
    });
    // 100 × 50 mm in points.
    expect(pageSizesOf(single)).toEqual(Array(3).fill([283.46, 141.73]));
    expect(
      pageSizesOf(
        buildLabelsPdf(many.slice(0, 1), {
          format: "100x150",
          codes: "both",
          title: "x",
        }),
      ),
    ).toEqual([[283.46, 425.2]]);
  });

  it("draws only the symbols asked, and a QR when the barcode cannot hold the code", () => {
    const bars = codesOf(
      buildLabelsPdf(labels, {
        format: "100x50",
        codes: "barcode",
        title: "x",
      }),
    );
    expect(bars.flatMap((page) => page.barcodes)).toHaveLength(3);
    expect(bars.flatMap((page) => page.qrs)).toHaveLength(0);
    const qr = codesOf(
      buildLabelsPdf(labels, { format: "100x50", codes: "qr", title: "x" }),
    );
    expect(qr.flatMap((page) => page.barcodes)).toHaveLength(0);
    expect(qr.flatMap((page) => page.qrs)).toHaveLength(3);

    // «Ñ» is not in Code 128: that label carries the QR, and its text.
    const accented = buildLabelsPdf([{ code: "LOTE-ÑU", title: "Lote" }], {
      format: "letter_10",
      codes: "barcode",
      title: "x",
    });
    expect(codesOf(accented)[0]).toEqual({
      barcodes: [],
      qrs: [qrOf("LOTE-ÑU")],
    });
    expect(textsOf(accented)[0]).toContain("LOTE-ÑU");
  });

  it("keeps long texts inside the label and holds nothing that runs", () => {
    const file = buildLabelsPdf(
      [
        {
          code: "X-1",
          title:
            "Un nombre de producto muy largo que no cabe en dos renglones de una etiqueta pequeña de ninguna manera",
          lines: ["/JavaScript (app.alert(1)) /OpenAction << /S /Launch >>"],
        },
      ],
      { format: "100x50", codes: "both", title: "/AA /JS" },
    );
    const [page] = textsOf(file);
    expect(page!.split("\n").filter((line) => line.includes("…")).length).toBe(
      2,
    );
    expect(namesOutsideText(file)).not.toMatch(ACTIVE_CONTENT);
    expect(objectsAreWhereTheTableSays(file)).toBe(true);
  });

  it("knows its formats and symbols, and nothing else", () => {
    expect(LABEL_FORMAT_IDS).toEqual(["letter_10", "100x50", "100x150"]);
    expect(LABEL_CODE_IDS).toEqual(["both", "barcode", "qr"]);
    expect(isLabelFormat("letter_10")).toBe(true);
    expect(isLabelFormat("toString")).toBe(false);
    expect(isLabelCodes("qr")).toBe(true);
    expect(isLabelCodes("")).toBe(false);
    expect(LABEL_FORMATS.letter_10.columns * LABEL_FORMATS.letter_10.rows).toBe(
      10,
    );
    expect(() =>
      buildLabelsPdf([], { format: "100x50", codes: "both", title: "x" }),
    ).toThrow();
  });
});
