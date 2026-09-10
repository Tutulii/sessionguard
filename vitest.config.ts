import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx", "shared/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    maxWorkers: 4,
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["server/**/*.ts", "shared/**/*.ts"],
    },
  },
});
