import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.env.ALLOW_POSTGRES_INTEGRATION_TESTS !== "true" || !process.env.POSTGRES_TEST_ADMIN_URL) {
  console.error("Full coverage requires ALLOW_POSTGRES_INTEGRATION_TESTS=true and a disposable loopback POSTGRES_TEST_ADMIN_URL.");
  process.exitCode = 1;
} else {
  const root = process.cwd();
  const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const blobDirectory = await mkdtemp(path.join(os.tmpdir(), "cvg-vitest-coverage-"));
  const unitEnvironment = { ...process.env };
  delete unitEnvironment.ALLOW_POSTGRES_INTEGRATION_TESTS;
  delete unitEnvironment.POSTGRES_TEST_ADMIN_URL;
  try {
    await run(vitest, ["run", "--coverage", "--reporter=dot", "--reporter=blob", `--outputFile=${path.join(blobDirectory, "unit.json")}`], unitEnvironment);
    await run(vitest, ["run", "--config", "vitest.postgres.config.ts", "--coverage", "--reporter=dot", "--reporter=blob", `--outputFile=${path.join(blobDirectory, "postgres.json")}`]);
    await run(vitest, ["--coverage", "--merge-reports", blobDirectory]);
  } finally {
    await rm(blobDirectory, { recursive: true, force: true });
  }
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`Vitest coverage command failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}.`));
    });
  });
}
