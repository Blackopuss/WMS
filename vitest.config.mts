import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Every test process (including global setup) targets the test database,
// never development. tests/setup/test-db.ts double-checks the name.
process.env.DATABASE_NAME = process.env.DATABASE_TEST_NAME ?? "wms_test";
// Emails are captured in memory so tests can read them (PLT-03).
process.env.MAIL_DRIVER = "memory";
// Private files of tests go to a throwaway folder, never to ./storage.
process.env.FILE_STORAGE_DIR = path.join(tmpdir(), "almacen-test-storage");

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": src("./src"),
      // `server-only` throws outside React Server Components; tests are server code.
      "server-only": src("./tests/setup/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts", "tests/**/*.int.test.ts"],
          globalSetup: ["./tests/setup/global-db.ts"],
          // Tests share one database: run files one at a time.
          fileParallelism: false,
          // One file at a time, each in its own worker. On Windows, worker
          // threads: a forked worker sometimes died at start (exit
          // 0xC0000409) with no test failing. Everywhere else (CI runs on
          // Linux), child processes: with threads, Node 24 sometimes aborted
          // the whole run when a thread that had loaded WebAssembly (the
          // Prisma query compiler) was torn down («Check failed:
          // jit_page_->allocations_.erase(addr) == 1», exit 133, four times
          // in CI between 2026-11-11 and 2026-11-12, never a failing test).
          // A process that ends takes its own memory with it.
          pool: process.platform === "win32" ? "threads" : "forks",
          // Loops of 20–30 real database calls take a few seconds under load.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
