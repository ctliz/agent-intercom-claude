import { types as nodeUtilTypes } from "node:util";
import { BROKER_PROTECTED_PROVIDER_ROOT } from "@ctliz/agent-intercom-core/boss";

export const CLAUDE_BOSS_PROTECTED_PROVIDER_ID = "claude" as const;
export const CLAUDE_BOSS_PROTECTED_PROVIDER_PACKAGE = "@ctliz/agent-intercom-claude" as const;
export const CLAUDE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH =
  `${BROKER_PROTECTED_PROVIDER_ROOT}${CLAUDE_BOSS_PROTECTED_PROVIDER_ID}/provider.mjs` as const;
export const BOSS_PROTECTED_SERVICE_UNAVAILABLE = "BOSS_PROTECTED_SERVICE_UNAVAILABLE" as const;

const CLAUDE_BOSS_PROTECTED_PROVIDER_MODE = "0555" as const;
const CANONICAL_SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CANDIDATE_KEYS = [
  "adapterId",
  "providerPackage",
  "providerVersion",
  "providerDigest",
  "artifactPath",
  "artifactOwnerUid",
  "artifactOwnerGid",
  "artifactMode",
] as const;

export interface ClaudeBossProtectedProviderArtifactCandidate {
  adapterId: typeof CLAUDE_BOSS_PROTECTED_PROVIDER_ID;
  providerPackage: typeof CLAUDE_BOSS_PROTECTED_PROVIDER_PACKAGE;
  providerVersion: string;
  providerDigest: string;
  artifactPath: typeof CLAUDE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH;
  artifactOwnerUid: 0;
  artifactOwnerGid: 0;
  artifactMode: typeof CLAUDE_BOSS_PROTECTED_PROVIDER_MODE;
}

export type ClaudeBossProtectedServiceErrorCode =
  | "INVALID_CLAUDE_PROTECTED_PROVIDER_CANDIDATE"
  | typeof BOSS_PROTECTED_SERVICE_UNAVAILABLE;

export class ClaudeBossProtectedServiceError extends Error {
  readonly code: ClaudeBossProtectedServiceErrorCode;
  readonly path: string;

  constructor(code: ClaudeBossProtectedServiceErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ClaudeBossProtectedServiceError";
    this.code = code;
    this.path = path;
  }
}

function invalid(path: string, message: string): never {
  throw new ClaudeBossProtectedServiceError(
    "INVALID_CLAUDE_PROTECTED_PROVIDER_CANDIDATE",
    path,
    message,
  );
}

function assertExactOwnDataCandidate(value: unknown): asserts value is Record<string, unknown> {
  const path = "$candidate";
  if (
    typeof value !== "object"
    || value === null
    || nodeUtilTypes.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(path, "must be a non-proxy plain data object");
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CANDIDATE_KEYS.length
    || keys.some((key) => typeof key !== "string" || !CANDIDATE_KEYS.includes(key as typeof CANDIDATE_KEYS[number]))
  ) {
    invalid(path, "must contain exactly the canonical unsigned Claude provider candidate fields");
  }

  for (const key of CANDIDATE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) {
      invalid(`${path}.${key}`, "must be an own enumerable data property");
    }
  }
}

function ownValue(value: Record<string, unknown>, key: typeof CANDIDATE_KEYS[number]): unknown {
  return Object.getOwnPropertyDescriptor(value, key)!.value;
}

function readProviderVersion(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 128
    || /[\r\n\u2028\u2029]/.test(value)
    || !CANONICAL_SEMANTIC_VERSION.test(value)
  ) {
    invalid("$candidate.providerVersion", "must be a canonical semantic version");
  }
  return value;
}

function readProviderDigest(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) {
    invalid("$candidate.providerDigest", "must be a lowercase SHA-256 digest");
  }
  return value;
}

/**
 * Normalize an unsigned release candidate for the packaged Claude provider.
 * This parser cannot verify installation, signatures, service identities, or
 * authority. Its frozen result remains explicitly non-authoritative.
 */
export function parseClaudeBossProtectedProviderArtifactCandidate(
  value: unknown,
): Readonly<ClaudeBossProtectedProviderArtifactCandidate> {
  assertExactOwnDataCandidate(value);

  if (ownValue(value, "adapterId") !== CLAUDE_BOSS_PROTECTED_PROVIDER_ID) {
    invalid("$candidate.adapterId", "must identify the Claude provider");
  }
  if (ownValue(value, "providerPackage") !== CLAUDE_BOSS_PROTECTED_PROVIDER_PACKAGE) {
    invalid("$candidate.providerPackage", "must identify the canonical Claude package");
  }
  if (ownValue(value, "artifactPath") !== CLAUDE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH) {
    invalid("$candidate.artifactPath", "must equal the canonical protected Claude provider path");
  }
  if (ownValue(value, "artifactOwnerUid") !== 0 || ownValue(value, "artifactOwnerGid") !== 0) {
    invalid("$candidate.artifactOwnerUid", "must describe a root:root artifact");
  }
  if (ownValue(value, "artifactMode") !== CLAUDE_BOSS_PROTECTED_PROVIDER_MODE) {
    invalid("$candidate.artifactMode", "must be read/execute-only mode 0555");
  }

  return Object.freeze({
    adapterId: CLAUDE_BOSS_PROTECTED_PROVIDER_ID,
    providerPackage: CLAUDE_BOSS_PROTECTED_PROVIDER_PACKAGE,
    providerVersion: readProviderVersion(ownValue(value, "providerVersion")),
    providerDigest: readProviderDigest(ownValue(value, "providerDigest")),
    artifactPath: CLAUDE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
    artifactOwnerUid: 0,
    artifactOwnerGid: 0,
    artifactMode: CLAUDE_BOSS_PROTECTED_PROVIDER_MODE,
  });
}

/**
 * Production ensure is intentionally unavailable until a protected
 * provisioner supplies release and service identity facts outside caller data.
 * The request is never inspected while that provisioner is absent.
 */
export function ensureClaudeBossProtectedService(_request: unknown): never {
  throw new ClaudeBossProtectedServiceError(
    BOSS_PROTECTED_SERVICE_UNAVAILABLE,
    "$provisioner",
    "the protected Claude broker service provisioner is not installed",
  );
}
