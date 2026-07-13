import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one embedded PostgreSQL — never boot it from
    // parallel workers.
    fileParallelism: false,
  },
});
