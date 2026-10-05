import { globalIgnores } from "eslint/config";
import next from "eslint-config-next";

const config = [
  // Local verification artifacts are already excluded from Git; generated
  // coverage scripts and disposable dependency probes are not project source.
  globalIgnores([".data/**", "coverage/**", "playwright-report/**", "test-results/**", ".next-*/**", ".next-visual-baseline/**"]),
  ...next
];

export default config;
