import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const APPROVED_CORE = Object.freeze({
  name: "@ctliz/agent-intercom-core",
  version: "0.2.0",
  integrity: "sha512-bpifL9cc8cwMm74fpvjgRBarXMwn6BY4cST4ry6HrGtfpRTXyiJOtwfNnhORF6xTKwQNOWakxS1sZALczInvkQ==",
  resolved: "https://registry.npmjs.org/@ctliz/agent-intercom-core/-/agent-intercom-core-0.2.0.tgz",
});

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const devSpec = APPROVED_CORE.version;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    throw new Error(`${field} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`);
  }
}

export function verifyLocalProvenance() {
  const manifest = readJson(join(repositoryRoot, "package.json"));
  const lock = readJson(join(repositoryRoot, "package-lock.json"));
  const lockRoot = lock.packages?.[""];
  const lockedCore = lock.packages?.[`node_modules/${APPROVED_CORE.name}`];

  requireEqual(manifest.peerDependencies?.[APPROVED_CORE.name], APPROVED_CORE.version, "Core peer dependency");
  requireEqual(manifest.dependencies?.[APPROVED_CORE.name], undefined, "Core production dependency");
  requireEqual(manifest.peerDependenciesMeta?.[APPROVED_CORE.name]?.optional, undefined, "Core peer optionality");
  requireEqual(manifest.devDependencies?.[APPROVED_CORE.name], devSpec, "Core development provenance");
  requireEqual(lockRoot?.peerDependencies?.[APPROVED_CORE.name], APPROVED_CORE.version, "locked Core peer dependency");
  requireEqual(lockRoot?.devDependencies?.[APPROVED_CORE.name], devSpec, "locked Core development provenance");
  requireEqual(lockedCore?.version, APPROVED_CORE.version, "supplied Core version");
  requireEqual(lockedCore?.resolved, APPROVED_CORE.resolved, "supplied Core resolved URL");
  requireEqual(lockedCore?.integrity, APPROVED_CORE.integrity, "supplied Core artifact integrity");
  requireEqual(lockedCore?.dev, true, "supplied Core dependency class");
}

export function parseAndVerifyPublishedProvenance(jsonString) {
  const published = typeof jsonString === "string" ? JSON.parse(jsonString) : jsonString;
  requireEqual(published.version, APPROVED_CORE.version, "published Core version");
  requireEqual(published["dist.integrity"] ?? published.dist?.integrity, APPROVED_CORE.integrity, "published Core artifact integrity");
}

export function verifyPublishedProvenance(runner = spawnSync) {
  const result = runner("npm", [
    "view",
    `${APPROVED_CORE.name}@${APPROVED_CORE.version}`,
    "version",
    "dist.integrity",
    "--json",
  ], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect published Core ${APPROVED_CORE.version}: ${(result.stderr || result.stdout).trim()}`);
  }
  parseAndVerifyPublishedProvenance(result.stdout);
}

verifyLocalProvenance();
if (process.argv.includes("--published")) verifyPublishedProvenance();
