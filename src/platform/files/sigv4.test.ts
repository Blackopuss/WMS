import { describe, expect, it } from "vitest";

import {
  amzDateOf,
  canonicalPath,
  canonicalQuery,
  sha256Hex,
  signV4,
  uriEncode,
} from "./sigv4";

// WMS-67 (ADR 0070): the signature against the public vectors of AWS. The
// S3 ones come from «Signature Calculations for the Authorization Header»
// (Amazon S3 API reference, examples with `AKIAIOSFODNN7EXAMPLE`); the
// generic ones from the Signature Version 4 test suite (`get-vanilla`).

const S3_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const EMPTY = sha256Hex("");
const S3 = {
  region: "us-east-1",
  service: "s3",
  amzDate: "20130524T000000Z",
  credentials: S3_CREDENTIALS,
};

describe("signV4 (public vectors of S3)", () => {
  it("GET object with a range", () => {
    const signed = signV4({
      ...S3,
      method: "GET",
      path: canonicalPath("/test.txt"),
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        Range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY,
    });
    expect(signed.signedHeaders).toBe(
      "host;range;x-amz-content-sha256;x-amz-date",
    );
    expect(signed.signature).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("PUT object with a body and a character to encode in the key", () => {
    const body = "Welcome to Amazon S3.";
    const hash = sha256Hex(body);
    expect(hash).toBe(
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    );
    const signed = signV4({
      ...S3,
      method: "PUT",
      path: canonicalPath("/test$file.text"),
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": hash,
      },
      payloadHash: hash,
    });
    expect(signed.canonicalRequest.split("\n")[1]).toBe("/test%24file.text");
    expect(signed.signature).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("GET bucket lifecycle (a query parameter without value)", () => {
    const signed = signV4({
      ...S3,
      method: "GET",
      path: "/",
      query: [["lifecycle", ""]],
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        "x-amz-date": "20130524T000000Z",
        "x-amz-content-sha256": EMPTY,
      },
      payloadHash: EMPTY,
    });
    expect(signed.signature).toBe(
      "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });

  it("GET bucket (list objects, query in any order)", () => {
    const signed = signV4({
      ...S3,
      method: "GET",
      path: "/",
      query: [
        ["prefix", "J"],
        ["max-keys", "2"],
      ],
      headers: {
        Host: "examplebucket.s3.amazonaws.com",
        "x-amz-date": "20130524T000000Z",
        "x-amz-content-sha256": EMPTY,
      },
      payloadHash: EMPTY,
    });
    expect(signed.canonicalRequest.split("\n")[2]).toBe("max-keys=2&prefix=J");
    expect(signed.signature).toBe(
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("signV4 (Signature Version 4 test suite)", () => {
  const SUITE = {
    region: "us-east-1",
    service: "service",
    amzDate: "20150830T123600Z",
    credentials: {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    },
    payloadHash: EMPTY,
    headers: {
      Host: "example.amazonaws.com",
      "X-Amz-Date": "20150830T123600Z",
    },
  };

  it("get-vanilla", () => {
    const signed = signV4({ ...SUITE, method: "GET", path: "/" });
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY,
      ].join("\n"),
    );
    expect(signed.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("get-vanilla-query-order-key-case", () => {
    const signed = signV4({
      ...SUITE,
      method: "GET",
      path: "/",
      query: [
        ["Param2", "value2"],
        ["Param1", "value1"],
      ],
    });
    expect(signed.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });
});

describe("encoding", () => {
  it("encodes what RFC 3986 reserves, keeps the unreserved", () => {
    expect(uriEncode("a-b_c.d~e")).toBe("a-b_c.d~e");
    expect(uriEncode("a b/c!*'()")).toBe("a%20b%2Fc%21%2A%27%28%29");
    expect(uriEncode("ñ")).toBe("%C3%B1");
    expect(canonicalPath("/bucket/org id/file")).toBe("/bucket/org%20id/file");
    expect(
      canonicalQuery([
        ["b", "2"],
        ["a", "x y"],
      ]),
    ).toBe("a=x%20y&b=2");
  });

  it("formats the date of the request", () => {
    expect(amzDateOf(new Date("2026-11-16T09:08:07.123Z"))).toBe(
      "20261116T090807Z",
    );
  });
});
