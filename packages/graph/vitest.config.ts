// Unit tests: no database needed.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/*.int.test.ts", "**/node_modules/**"],
  },
});
