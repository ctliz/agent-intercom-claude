import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  BOSS_CAPABILITY_FEATURE_DIGEST,
  BOSS_RUN_FEATURE_CONTRACT,
  BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH,
  BROKER_FEATURE_ATTESTATION_VERSION,
  BROKER_PROTECTED_PROVIDER_ROOT,
  INTERCOM_BASE_PROTOCOL_VERSION,
} from "@dataforxyz/agent-intercom-core/boss";
import {
  BOSS_ADVERTISEMENT_ENABLED,
  brokerCapabilityAdvertisement,
} from "../broker/boss-contracts.ts";
import {
  BOSS_PROTECTED_SERVICE_UNAVAILABLE,
  CLAUDE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
  CLAUDE_BOSS_PROTECTED_PROVIDER_ID,
  CLAUDE_BOSS_PROTECTED_PROVIDER_PACKAGE,
  ClaudeBossProtectedServiceError,
  ensureClaudeBossProtectedService,
  parseClaudeBossProtectedProviderArtifactCandidate,
} from "./protected-service.ts";
import {
  CLAUDE_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
  startClaudeBossProtectedProvider,
} from "./entry.ts";

const repositoryRoot = new URL("..", import.meta.url);
const generatedProviderUrl = new URL("provider/provider.mjs", repositoryRoot);
const buildScriptUrl = new URL("scripts/build-protected-provider.mjs", repositoryRoot);
const ordinaryDistNames = [
  "broker.mjs",
  "cci.mjs",
  "ccim.mjs",
  "claude-server.mjs",
  "inbox-monitor.mjs",
  "worker-daemon.mjs",
];

function generatedProviderBytes(): Buffer {
  return readFileSync(generatedProviderUrl);
}

function ordinaryDistSnapshot(): Record<string, Buffer> {
  const distUrl = new URL("dist/", repositoryRoot);
  assert.deepEqual(readdirSync(distUrl).filter((name) => name.endsWith(".mjs")).sort(), ordinaryDistNames);
  return Object.fromEntries(ordinaryDistNames.map((name) => [name, readFileSync(join(distUrl.pathname, name))]));
}

function providerCandidate(): Record<string | symbol, unknown> {
  return {
    adapterId: CLAUDE_BOSS_PROTECTED_PROVIDER_ID,
    providerPackage: CLAUDE_BOSS_PROTECTED_PROVIDER_PACKAGE,
    providerVersion: "0.10.0",
    providerDigest: createHash("sha256").update(generatedProviderBytes()).digest("hex"),
    artifactPath: CLAUDE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
    artifactOwnerUid: 0,
    artifactOwnerGid: 0,
    artifactMode: "0555",
  };
}

function expectCandidateInvalid(value: unknown): ClaudeBossProtectedServiceError {
  let observed: unknown;
  try {
    parseClaudeBossProtectedProviderArtifactCandidate(value);
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof ClaudeBossProtectedServiceError);
  assert.equal(observed.code, "INVALID_CLAUDE_PROTECTED_PROVIDER_CANDIDATE");
  return observed;
}

test("normalizes only the canonical unsigned non-authoritative Claude provider candidate", () => {
  assert.equal(
    CLAUDE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
    `${BROKER_PROTECTED_PROVIDER_ROOT}claude/provider.mjs`,
  );
  const candidate = providerCandidate();
  const snapshot = structuredClone(candidate);
  const parsed = parseClaudeBossProtectedProviderArtifactCandidate(candidate);

  assert.deepEqual(candidate, snapshot);
  assert.deepEqual(parsed, candidate);
  assert.deepEqual(Reflect.ownKeys(parsed), [
    "adapterId", "providerPackage", "providerVersion", "providerDigest",
    "artifactPath", "artifactOwnerUid", "artifactOwnerGid", "artifactMode",
  ]);
  assert.ok(Object.isFrozen(parsed));
  assert.equal(Object.hasOwn(parsed, "signature"), false);
  assert.equal(Object.hasOwn(parsed, "attestationKeyId"), false);
});

test("rejects substitution, writable artifacts, noncanonical versions, and non-lowercase digests", () => {
  const mutations: Array<[string, unknown]> = [
    ["adapterId", "codex"],
    ["providerPackage", "@attacker/agent-intercom-claude"],
    ["providerVersion", "01.0.0"],
    ["providerVersion", "1.0.0-01"],
    ["providerVersion", "latest"],
    ...["\n", "\r", "\u2028", "\u2029"].map((terminator) => ["providerVersion", `1.2.3${terminator}`] as [string, unknown]),
    ["providerDigest", "A".repeat(64)],
    ["providerDigest", "a".repeat(63)],
    ...["\n", "\r", "\u2028", "\u2029"].map((terminator) => ["providerDigest", `${"a".repeat(64)}${terminator}`] as [string, unknown]),
    ["artifactPath", "/usr/lib/agent-intercom/providers/claude/../evil/provider.mjs"],
    ["artifactPath", "/tmp/claude/provider.mjs"],
    ["artifactOwnerUid", 1000],
    ["artifactOwnerGid", 1000],
    ["artifactMode", "0755"],
  ];

  for (const [field, replacement] of mutations) {
    const candidate = providerCandidate();
    candidate[field] = replacement;
    expectCandidateInvalid(candidate);
  }
});

test("never accepts caller-supplied attestation, trust, identity, credential, or installation facts", () => {
  for (const forbidden of [
    "version",
    "userWritable",
    "authoritative",
    "signature",
    "attestationKeyId",
    "trustedReleaseKeys",
    "ownerUid",
    "brokerServiceUid",
    "controllerServiceUid",
    "identityKeyId",
    "brokerGeneration",
    "serviceCapability",
    "credential",
    "installed",
  ]) {
    const candidate = providerCandidate();
    candidate[forbidden] = forbidden === "installed" ? true : "attacker-controlled";
    expectCandidateInvalid(candidate);
  }
});

test("rejects proxies, inheritance, accessors, symbols, and non-data fields without getter execution", () => {
  let invoked = false;
  const proxied = new Proxy(providerCandidate(), {
    get() { invoked = true; throw new Error("must not read proxy"); },
    getOwnPropertyDescriptor() { invoked = true; throw new Error("must not inspect proxy"); },
    getPrototypeOf() { invoked = true; throw new Error("must not inspect proxy"); },
    ownKeys() { invoked = true; throw new Error("must not enumerate proxy"); },
  });
  expectCandidateInvalid(proxied);
  assert.equal(invoked, false);

  expectCandidateInvalid(Object.create(providerCandidate()));

  const accessor = providerCandidate();
  Object.defineProperty(accessor, "providerVersion", {
    enumerable: true,
    get() { invoked = true; throw new Error("must not invoke getter"); },
  });
  expectCandidateInvalid(accessor);
  assert.equal(invoked, false);

  const symbol = providerCandidate();
  symbol[Symbol("authority")] = true;
  expectCandidateInvalid(symbol);

  const hidden = providerCandidate();
  Object.defineProperty(hidden, "providerDigest", {
    enumerable: false,
    value: hidden.providerDigest,
  });
  expectCandidateInvalid(hidden);
});

test("production ensure reports unavailability before hostile request inspection", () => {
  let invoked = false;
  const request = new Proxy({}, {
    get() { invoked = true; throw new Error("must not inspect request"); },
    getOwnPropertyDescriptor() { invoked = true; throw new Error("must not inspect request"); },
    getPrototypeOf() { invoked = true; throw new Error("must not inspect request"); },
    ownKeys() { invoked = true; throw new Error("must not enumerate request"); },
  });

  assert.throws(
    () => ensureClaudeBossProtectedService(request),
    (error: unknown) => error instanceof ClaudeBossProtectedServiceError
      && error.code === BOSS_PROTECTED_SERVICE_UNAVAILABLE
      && error.path === "$provisioner",
  );
  assert.equal(invoked, false);
});

test("generated provider is deterministic and leaves ordinary dist bytes unchanged", async () => {
  const { buildProtectedProvider } = await import(buildScriptUrl.href) as {
    buildProtectedProvider(): string;
  };
  const ordinaryBefore = ordinaryDistSnapshot();
  const committed = generatedProviderBytes();
  const firstOutput = buildProtectedProvider();
  const first = generatedProviderBytes();
  const secondOutput = buildProtectedProvider();
  const second = generatedProviderBytes();

  assert.deepEqual(first, committed);
  assert.deepEqual(second, first);
  assert.equal(firstOutput, first.toString("utf8"));
  assert.equal(secondOutput, firstOutput);
  assert.deepEqual(ordinaryDistSnapshot(), ordinaryBefore);
  const source = second.toString("utf8");
  assert.doesNotMatch(source, /\/home\/|\/Users\/|[A-Z]:\\/);
  assert.doesNotMatch(source, /\/usr\/lib\/agent-intercom|\/run\/agent-intercom|\/var\/lib\/agent-intercom/);
});

test("source and generated provider expose the same immutable dormant build identity", async () => {
  const generated = await import(generatedProviderUrl.href) as typeof import("./entry.ts");
  assert.deepEqual(Object.keys(generated).sort(), [
    "CLAUDE_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY",
    "startClaudeBossProtectedProvider",
  ]);
  assert.deepEqual(
    generated.CLAUDE_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
    CLAUDE_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
  );

  for (const identity of [
    CLAUDE_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
    generated.CLAUDE_BOSS_PROTECTED_PROVIDER_BUILD_IDENTITY,
  ]) {
    assert.ok(Object.isFrozen(identity));
    assert.ok(Object.isFrozen(identity.supportedBaseProtocolVersions));
    assert.ok(Object.isFrozen(identity.supportedFeatures));
    assert.ok(Object.isFrozen(identity.supportedFeatures[0]));
    assert.equal(identity.contractVersion, "claude.boss-protected-provider.v1");
    assert.equal(identity.adapterId, "claude");
    assert.equal(identity.providerPackage, "@dataforxyz/agent-intercom-claude");
    assert.equal(identity.authoritative, false);
    assert.equal(identity.providerStartAvailable, false);
    assert.equal(identity.bossAdvertisementEnabled, false);
    assert.deepEqual(identity.supportedBaseProtocolVersions, [INTERCOM_BASE_PROTOCOL_VERSION]);
    assert.deepEqual(identity.supportedFeatures, [{
      version: BROKER_FEATURE_ATTESTATION_VERSION,
      feature: BOSS_RUN_FEATURE_CONTRACT.feature,
      featureVersion: BOSS_RUN_FEATURE_CONTRACT.version,
      semanticsHash: BOSS_RUN_FEATURE_CONTRACT.semanticsHash,
      controlEnvelopeVersion: BOSS_RUN_FEATURE_CONTRACT.controlEnvelopeVersion,
      capabilityDigest: BOSS_CAPABILITY_FEATURE_DIGEST,
    }]);
    assert.equal(identity.protocolFeatureContractHash, BOSS_RUN_PROTOCOL_FEATURE_CONTRACT_HASH);
  }
});

test("provider has zero runtime imports or integration and start fails before request inspection", async () => {
  const source = readFileSync(new URL("provider/entry.ts", repositoryRoot), "utf8");
  const generatedSource = generatedProviderBytes().toString("utf8");
  for (const value of [source, generatedSource]) {
    assert.doesNotMatch(value, /^\s*import\s/m);
    assert.doesNotMatch(value, /\brequire\s*\(/);
    assert.doesNotMatch(value, /\bimport\s*\(/);
    assert.doesNotMatch(value, /node:(?:fs|child_process|net|process|os)/);
    assert.doesNotMatch(value, /systemctl|\.listen\(|\.connect\(|\.kill\(|\.spawn\(|broker\/(?:broker|spawn|paths|ownership)/);
  }

  const generated = await import(generatedProviderUrl.href) as typeof import("./entry.ts");
  for (const start of [startClaudeBossProtectedProvider, generated.startClaudeBossProtectedProvider]) {
    let invoked = false;
    const request = Object.defineProperty({}, "ownerUid", {
      enumerable: true,
      get() { invoked = true; throw new Error("must not inspect start request"); },
    });
    assert.throws(
      () => start(request),
      (error: unknown) => typeof error === "object"
        && error !== null
        && (error as { code?: unknown }).code === "BOSS_PROTECTED_PROVIDER_START_UNAVAILABLE",
    );
    assert.equal(invoked, false);
  }
});

test("protected-provider packaging does not activate or advertise Boss", () => {
  assert.equal(BOSS_ADVERTISEMENT_ENABLED, false);
  assert.deepEqual(brokerCapabilityAdvertisement(), {
    baseProtocolVersion: 3,
    features: [],
  });
});
