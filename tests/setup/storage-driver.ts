import { afterAll } from "vitest";

import { startFakeS3 } from "./fake-s3";

// WMS-67 (ADR 0070): with TEST_FILE_STORAGE=s3, every integration file runs
// against the fake S3 server (signatures checked) instead of the disk:
//   TEST_FILE_STORAGE=s3 npx vitest run --project integration tests/platform/files.int.test.ts
// Without it nothing changes: the disk of vitest.config.mts.
if (process.env.TEST_FILE_STORAGE === "s3") {
  const fake = await startFakeS3();
  Object.assign(process.env, fake.env(), { FILE_STORAGE_DRIVER: "s3" });
  afterAll(() => fake.close());
}
