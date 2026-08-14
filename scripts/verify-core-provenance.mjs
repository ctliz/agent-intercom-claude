import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const APPROVED_CORE = Object.freeze({
  name: "@dataforxyz/agent-intercom-core",
  version: "0.1.0",
  commit: "aad1985e125516b318181560293145bf2507cc6d",
  integrity: "sha512-ycbxwD+OrwmDK+vJ3Mei7WKxbYI9GDEGoGQbXQwhgaT8twRmR3ny8WzEXei6NaIITDtEbWk3Qd0U5ZmQsE35mg==",
});

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const devSpec = `git+https://github.com/ctliz/agent-intercom-core.git#${APPROVED_CORE.commit}`;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    throw new Error(`${field} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`);
  }
}

function verifyLocalProvenance() {
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
  requireEqual(lockedCore?.resolved, devSpec, "supplied Core commit");
  requireEqual(lockedCore?.integrity, APPROVED_CORE.integrity, "supplied Core artifact integrity");
  requireEqual(lockedCore?.dev, true, "supplied Core dependency class");
}

function verifyPublishedProvenance() {
  const result = spawnSync("npm", [
    "view",
    `${APPROVED_CORE.name}@${APPROVED_CORE.version}`,
    "version",
    "dist.integrity",
    "gitHead",
    "--json",
  ], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to inspect published Core ${APPROVED_CORE.version}: ${(result.stderr || result.stdout).trim()}`);
  }
  const published = JSON.parse(result.stdout);
  requireEqual(published.version, APPROVED_CORE.version, "published Core version");
  requireEqual(published["dist.integrity"] ?? published.dist?.integrity, APPROVED_CORE.integrity, "published Core artifact integrity");
  requireEqual(published.gitHead, APPROVED_CORE.commit, "published Core commit");
}

verifyLocalProvenance();
if (process.argv.includes("--published")) verifyPublishedProvenance();
