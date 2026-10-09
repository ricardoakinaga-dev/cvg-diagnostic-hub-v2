import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import type { LifecycleRule } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { hardenBucket, lifecycleRules, objectUrl, policyAllowsAnonymous, verifyBucket, type BucketHardeningOptions } from "./bucket-hardening";

const options: BucketHardeningOptions = { bucket: "cvg-attachments", noncurrentVersionDays: 30 };

interface FakeBucket {
  exists?: boolean;
  versioning?: string;
  encryption?: string;
  rules?: LifecycleRule[];
  policy?: string;
  objectEncryption?: string;
}

function fakeClient(bucket: FakeBucket) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof HeadBucketCommand) {
      if (bucket.exists === false) throw new Error("NotFound");
      return {};
    }
    if (command instanceof GetBucketVersioningCommand) return { Status: bucket.versioning };
    if (command instanceof GetBucketEncryptionCommand) {
      if (!bucket.encryption) throw new Error("ServerSideEncryptionConfigurationNotFoundError");
      return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: bucket.encryption } }] } };
    }
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      if (!bucket.rules) throw new Error("NoSuchLifecycleConfiguration");
      return { Rules: bucket.rules };
    }
    if (command instanceof GetBucketPolicyCommand) {
      if (!bucket.policy) throw new Error("NoSuchBucketPolicy");
      return { Policy: bucket.policy };
    }
    if (command instanceof HeadObjectCommand) return bucket.objectEncryption ? { ServerSideEncryption: bucket.objectEncryption } : {};
    return {};
  });
  return { send };
}

const hardened: FakeBucket = { versioning: "Enabled", encryption: "AES256", rules: lifecycleRules(options), objectEncryption: "AES256" };
const privateProbe = { anonymousGet: async () => 403 };

describe("bucket hardening (PROD-307, D-050)", () => {
  it("creates a missing bucket and applies versioning, default encryption and the lifecycle, without expiring current objects", async () => {
    const client = fakeClient({ exists: false });
    const result = await hardenBucket(client, options);

    expect(result.created).toBe(true);
    const commands = client.send.mock.calls.map(([command]) => command);
    expect(commands.some((command) => command instanceof CreateBucketCommand)).toBe(true);
    const versioning = commands.find((command): command is PutBucketVersioningCommand => command instanceof PutBucketVersioningCommand);
    expect(versioning?.input.VersioningConfiguration?.Status).toBe("Enabled");
    const encryption = commands.find((command): command is PutBucketEncryptionCommand => command instanceof PutBucketEncryptionCommand);
    expect(encryption?.input.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe("AES256");
    const lifecycle = commands.find((command): command is PutBucketLifecycleConfigurationCommand => command instanceof PutBucketLifecycleConfigurationCommand);
    const rules = lifecycle?.input.LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(1);
    for (const rule of rules) {
      expect(rule.Expiration?.Days).toBeUndefined();
      expect(rule.Expiration?.Date).toBeUndefined();
      expect(rule.Transitions).toBeUndefined();
    }
    expect(rules[0]?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(30);
    expect(rules[0]?.Expiration?.ExpiredObjectDeleteMarker).toBe(true);
  });

  it("is idempotent on an existing bucket", async () => {
    const client = fakeClient({});
    const result = await hardenBucket(client, options);
    expect(result.created).toBe(false);
    expect(client.send.mock.calls.some(([command]) => command instanceof CreateBucketCommand)).toBe(false);
  });

  it("accepts a bucket that matches the contract and removes its probe object", async () => {
    const client = fakeClient(hardened);
    const verification = await verifyBucket(client, options, privateProbe);

    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    expect(verification.report).toMatchObject({ versioning: "Enabled", encryption: "AES256", policy: "none", anonymousGetStatus: 403, probeObjectEncryption: "AES256", lifecycle: { noncurrentVersionDays: 30, ruleCount: 1 } });
    const commands = client.send.mock.calls.map(([command]) => command);
    const put = commands.find((command): command is PutObjectCommand => command instanceof PutObjectCommand);
    const remove = commands.find((command): command is DeleteObjectCommand => command instanceof DeleteObjectCommand);
    expect(put?.input.Key?.startsWith(".cvg-bucket-probe/")).toBe(true);
    expect(remove?.input.Key).toBe(put?.input.Key);
  });

  it("rejects a lifecycle that expires current objects by age (the attachment stays until the PROD-501 purge)", async () => {
    const client = fakeClient({ ...hardened, rules: [...lifecycleRules(options), { ID: "expire-after-24-months", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 730 } }] });
    const verification = await verifyBucket(client, options, privateProbe);

    expect(verification.ok).toBe(false);
    expect(verification.problems).toEqual([expect.stringMatching(/expire-after-24-months.*objetos correntes.*D-050/)]);
  });

  it("rejects a lifecycle with a storage-class transition, a missing noncurrent rule or a different retention", async () => {
    const client = fakeClient({ ...hardened, rules: [{ ID: "tier", Status: "Enabled", Filter: { Prefix: "" }, Transitions: [{ Days: 730, StorageClass: "GLACIER" }] }] });
    const verification = await verifyBucket(client, options, privateProbe);

    expect(verification.ok).toBe(false);
    expect(verification.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/tier.*transição/),
      "sem regra de expiração de versões não correntes"
    ]));
    const drifted = await verifyBucket(fakeClient({ ...hardened, rules: lifecycleRules({ ...options, noncurrentVersionDays: 5 }) }), options, privateProbe);
    expect(drifted.problems).toEqual(["versões não correntes expiram em 5 dias; configurado 30"]);
  });

  it("rejects a bucket without versioning, without default encryption or with an unencrypted object", async () => {
    const client = fakeClient({ versioning: "Suspended", rules: lifecycleRules(options) });
    const verification = await verifyBucket(client, options, privateProbe);

    expect(verification.ok).toBe(false);
    expect(verification.problems).toEqual(expect.arrayContaining([
      "versionamento Suspended; esperado Enabled",
      "sem criptografia padrão no bucket (SSE)",
      "objeto gravado sem criptografia em repouso (x-amz-server-side-encryption ausente)"
    ]));
  });

  it("rejects a public bucket policy and an anonymous read that succeeds", async () => {
    const publicPolicy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: ["*"] }, Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::cvg-attachments/*"] }] });
    const client = fakeClient({ ...hardened, policy: publicPolicy });
    const verification = await verifyBucket(client, options, { anonymousGet: async () => 200 });

    expect(verification.ok).toBe(false);
    expect(verification.report.policy).toBe("public");
    expect(verification.problems).toEqual(expect.arrayContaining([
      "a policy do bucket concede acesso anônimo",
      "leitura anônima respondeu 200; esperado 403"
    ]));
  });

  it("treats an explicit private policy as private", async () => {
    const privatePolicy = JSON.stringify({ Statement: { Effect: "Allow", Principal: { AWS: "arn:aws:iam::1:user/cvg" }, Action: "s3:*", Resource: "*" } });
    const client = fakeClient({ ...hardened, policy: privatePolicy });
    const verification = await verifyBucket(client, options, privateProbe);
    expect(verification.report.policy).toBe("private");
    expect(verification.ok).toBe(true);
  });

  it("reports a missing bucket without touching it", async () => {
    const client = fakeClient({ exists: false });
    const verification = await verifyBucket(client, options, privateProbe);
    expect(verification.ok).toBe(false);
    expect(verification.problems).toEqual(["bucket não existe ou não está acessível"]);
    expect(client.send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it("reports an unreadable lifecycle, a failed probe write and keeps going", async () => {
    const base = fakeClient({ ...hardened, rules: undefined });
    const client = { send: vi.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) throw new Error("AccessDenied: no write");
      if (command instanceof DeleteObjectCommand) throw new Error("AccessDenied: no delete");
      return base.send(command);
    }) };
    const verification = await verifyBucket(client, options, privateProbe);

    expect(verification.ok).toBe(false);
    expect(verification.report.lifecycle.ruleCount).toBe(0);
    expect(verification.problems).toEqual(expect.arrayContaining([
      "sem regra de expiração de versões não correntes",
      expect.stringMatching(/objeto de prova: AccessDenied/)
    ]));
    expect(client.send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
  });

  it("validates its options", async () => {
    await expect(hardenBucket(fakeClient({}), { ...options, noncurrentVersionDays: 0 })).rejects.toThrow(/STORAGE_NONCURRENT_VERSION_DAYS/);
    await expect(verifyBucket(fakeClient({}), { ...options, noncurrentVersionDays: 99999 })).rejects.toThrow(/STORAGE_NONCURRENT_VERSION_DAYS/);
    await expect(hardenBucket(fakeClient({}), { ...options, bucket: " " })).rejects.toThrow(/STORAGE_BUCKET/);
  });

  it("recognises anonymous principals and unparseable policies", () => {
    expect(policyAllowsAnonymous(undefined)).toBe(false);
    expect(policyAllowsAnonymous(JSON.stringify({ Statement: [{ Effect: "Allow", Principal: "*" }] }))).toBe(true);
    expect(policyAllowsAnonymous(JSON.stringify({ Statement: [{ Effect: "Deny", Principal: "*" }] }))).toBe(false);
    expect(policyAllowsAnonymous("not json")).toBe(true);
    expect(policyAllowsAnonymous(JSON.stringify({ Statement: ["malformed", null, { Effect: "Allow", Principal: { Service: "x" } }] }))).toBe(false);
    expect(policyAllowsAnonymous(JSON.stringify({ Statement: { Effect: "Allow", Principal: { AWS: ["arn:aws:iam::1:user/a", "*"] } } }))).toBe(true);
  });

  it("builds the anonymous probe URL in both addressing styles", () => {
    expect(objectUrl("http://storage:9000", "cvg-attachments", ".cvg-bucket-probe/x", true)).toBe("http://storage:9000/cvg-attachments/.cvg-bucket-probe/x");
    expect(objectUrl("https://s3.example.org/", "cvg-attachments", "k", false)).toBe("https://cvg-attachments.s3.example.org/k");
  });
});
