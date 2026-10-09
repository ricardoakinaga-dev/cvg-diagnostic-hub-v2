// PROD-302: imported as the FIRST line of every operational entrypoint so that secrets mounted as files (NAME_FILE)
// are in process.env before any other module reads it. The app does the same in src/instrumentation.ts.
import { loadFileSecrets } from "../src/server/security/file-secrets";

const { loaded, expanded } = loadFileSecrets();
if (loaded.length > 0 || expanded.length > 0) {
  // Names only, never values.
  console.log(JSON.stringify({ event: "secrets.loaded", loaded, expanded }));
}
