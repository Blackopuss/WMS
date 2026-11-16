import { describe, expect, it } from "vitest";

import {
  FILE_CONTENT_SECURITY_POLICY,
  fileResponseHeaders,
} from "./file-response";

describe("fileResponseHeaders", () => {
  it("muestra en la página solo una imagen", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(
        fileResponseHeaders({ name: "foto.jpg", contentType: type, size: 10 })[
          "content-disposition"
        ],
      ).toMatch(/^inline;/);
    }
    for (const type of [
      "text/csv; charset=utf-8",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/html",
    ]) {
      expect(
        fileResponseHeaders({ name: "x.csv", contentType: type, size: 10 })[
          "content-disposition"
        ],
      ).toMatch(/^attachment;/);
    }
  });

  it("nunca adivina el tipo, no se incrusta en otro sitio y no se guarda", () => {
    expect(
      fileResponseHeaders({
        name: "Foto «daño» 1.jpg",
        contentType: "image/jpeg",
        size: 42,
      }),
    ).toEqual({
      "content-type": "image/jpeg",
      "content-length": "42",
      "content-disposition": `inline; filename="Foto__da_o__1.jpg"; filename*=UTF-8''Foto%20%C2%ABda%C3%B1o%C2%BB%201.jpg`,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
    });
  });

  it("la política de los archivos no deja correr ni cargar nada", () => {
    expect(FILE_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(FILE_CONTENT_SECURITY_POLICY).toContain("sandbox");
    expect(FILE_CONTENT_SECURITY_POLICY).not.toContain("script-src");
  });
});
