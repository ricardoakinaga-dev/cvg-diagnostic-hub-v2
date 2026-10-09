import { closeRuntimeStore, getRuntimeStoreAsync } from "../src/server/store/runtime";
import { closeRateLimitBackend } from "../src/server/security/rate-limit";
import { issueResetLinkByEmail, parseResetLinkArgs } from "../src/server/security/password-reset";
import { loadFileSecrets } from "../src/server/security/file-secrets";
// PROD-302: secrets mounted as files (NAME_FILE) are read before anything touches process.env.
loadFileSecrets();

/** Break-glass for an operator with the database credential (PROD-202): issues a one-time reset link. */
async function main(): Promise<void> {
  const { email } = parseResetLinkArgs(process.argv.slice(2));
  const store = await getRuntimeStoreAsync();
  const { userId, resetUrl, expiresAt } = await issueResetLinkByEmail(store, email);
  // The JSON event carries no secret: the link goes to the operator on its own line (the Compose service has no log driver).
  console.log(JSON.stringify({ event: "password_reset_link.issued", userId, expiresAt }));
  console.log(`Link de redefinição (uso único, expira em ${expiresAt}):`);
  console.log(resetUrl);
}

void main()
  .catch((error: unknown) => {
    console.error(JSON.stringify({ event: "password_reset_link.failed", message: error instanceof Error ? error.message : "PASSWORD_RESET_LINK_FAILED" }));
    process.exitCode = 1;
  })
  .finally(async () => { await closeRuntimeStore(); await closeRateLimitBackend(); });
