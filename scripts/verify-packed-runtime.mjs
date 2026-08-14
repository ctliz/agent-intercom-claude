import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const corePackage = "@ctliz/agent-intercom-core";
const coreDevSpec = "git+https://github.com/ctliz/agent-intercom-core.git#37e074970e2a9de32a16fc325607c3b476b0bd45";
const coreConsumers = new Set([
  "broker.mjs",
  "cci.mjs",
  "ccim.mjs",
  "claude-server.mjs",
  "worker-daemon.mjs",
]);
const bundles = [...coreConsumers, "inbox-monitor.mjs"];

function tarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end === -1 || end > offset + length ? offset + length : end).toString("utf8");
}

function readTarEntries(archivePath) {
  const archive = gunzipSync(readFileSync(archivePath));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size)) throw new Error(`Invalid tar size for ${path}`);
    const contentOffset = offset + 512;
    entries.set(path, archive.subarray(contentOffset, contentOffset + size));
    offset = contentOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function createPackageArchive(temp) {
  const result = spawnSync("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    temp,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_cache: join(temp, "npm-cache") },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  const packed = JSON.parse(result.stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
    throw new Error("npm pack did not report exactly one package archive");
  }
  return join(temp, packed[0].filename);
}

const archiveArgument = process.argv.indexOf("--archive");
const suppliedArchive = archiveArgument === -1 ? undefined : process.argv[archiveArgument + 1];
if (archiveArgument !== -1 && !suppliedArchive) throw new Error("--archive requires a package tarball path");
const temp = suppliedArchive ? undefined : mkdtempSync(join(tmpdir(), "claude-intercom-pack-check-"));

try {
  const archivePath = suppliedArchive ? resolve(suppliedArchive) : createPackageArchive(temp);
  const entries = readTarEntries(archivePath);
  const manifestEntry = entries.get("package/package.json");
  if (!manifestEntry) throw new Error("Packed adapter is missing package.json");
  const manifest = JSON.parse(manifestEntry.toString("utf8"));
  if (manifest.peerDependencies?.[corePackage] !== "0.1.0") throw new Error("Packed adapter must require Core peer 0.1.0");
  if (manifest.peerDependenciesMeta?.[corePackage]?.optional === true) throw new Error("Packed Core peer must not be optional");
  if (manifest.dependencies?.[corePackage] !== undefined) throw new Error("Packed adapter must not install a private Core dependency");
  if (manifest.devDependencies?.[corePackage] !== coreDevSpec) throw new Error("Packed adapter lost the approved Core build commit");
  if ([...entries.keys()].some((path) => path.includes("node_modules/@ctliz/agent-intercom-core/"))) {
    throw new Error("Packed adapter contains a private Core module tree");
  }

  // 1. Assert Claude Plugin manifest exists and is valid
  const pluginEntry = entries.get("package/.claude-plugin/plugin.json");
  if (!pluginEntry) throw new Error("Packed adapter is missing .claude-plugin/plugin.json");
  const plugin = JSON.parse(pluginEntry.toString("utf8"));
  if (plugin.name !== "claude-intercom") throw new Error(`Unexpected plugin name: ${plugin.name}`);

  // 2. Assert Plugin -> MCP configuration exists and points to real dist bundle
  if (typeof plugin.mcpServers !== "string") throw new Error("plugin.json missing mcpServers declaration");
  const mcpRelPath = plugin.mcpServers.replace(/^\.\//, "");
  const mcpEntry = entries.get(`package/${mcpRelPath}`);
  if (!mcpEntry) throw new Error(`Packed adapter missing plugin mcpServers file: ${mcpRelPath}`);
  const mcpConfig = JSON.parse(mcpEntry.toString("utf8"));
  const claudeServerArg = mcpConfig.mcpServers?.["claude-intercom"]?.args?.[0];
  if (!claudeServerArg || !claudeServerArg.includes("/dist/claude-server.mjs")) {
    throw new Error(`MCP config does not reference dist/claude-server.mjs: ${claudeServerArg}`);
  }

  // 3. Assert Plugin -> Monitors configuration exists and points to real dist bundle
  if (typeof plugin.monitors !== "string") throw new Error("plugin.json missing monitors declaration");
  const monitorsRelPath = plugin.monitors.replace(/^\.\//, "");
  const monitorsEntry = entries.get(`package/${monitorsRelPath}`);
  if (!monitorsEntry) throw new Error(`Packed adapter missing plugin monitors file: ${monitorsRelPath}`);
  const monitorsConfig = JSON.parse(monitorsEntry.toString("utf8"));
  if (!Array.isArray(monitorsConfig) || monitorsConfig.length === 0) {
    throw new Error("monitors.json is empty or not an array");
  }
  const inboxMonitor = monitorsConfig.find((m) => m.name === "intercom-inbox");
  if (!inboxMonitor || !inboxMonitor.command?.includes("/dist/inbox-monitor.mjs")) {
    throw new Error(`monitors.json missing intercom-inbox command referencing dist/inbox-monitor.mjs: ${JSON.stringify(inboxMonitor)}`);
  }

  // 4. Assert Plugin -> Skills & Commands exist in packed archive
  if (typeof plugin.skills !== "string") throw new Error("plugin.json missing skills declaration");
  const skillEntry = entries.get("package/skills/claude-intercom/SKILL.md");
  if (!skillEntry) throw new Error("Packed adapter missing skills/claude-intercom/SKILL.md");

  if (typeof plugin.commands !== "string") throw new Error("plugin.json missing commands declaration");
  const commandEntry1 = entries.get("package/commands/intercom.md");
  const commandEntry2 = entries.get("package/commands/intercom-id.md");
  if (!commandEntry1 || !commandEntry2) throw new Error("Packed adapter missing commands markdown files");

  // 5. Assert all dist bundles exist and adhere to Core externalization
  for (const bundle of bundles) {
    const entry = entries.get(`package/dist/${bundle}`);
    if (!entry) throw new Error(`Packed adapter is missing dist/${bundle}`);
    const source = entry.toString("utf8");
    if (source.includes("node_modules/@ctliz/agent-intercom-core/") || /var POLICY_SEMANTICS_VERSION\s*=/.test(source)) {
      throw new Error(`Packed dist/${bundle} embeds a private Core copy`);
    }
    if (coreConsumers.has(bundle) && !/from ["']@ctliz\/agent-intercom-core(?:\/[A-Za-z/-]+)?["']/.test(source)) {
      throw new Error(`Packed dist/${bundle} does not retain its Core peer import`);
    }
  }

  console.log(`Verified complete plugin+MCP+monitors+dist chain and ${bundles.length} packed bundles using Core peer 0.1.0`);
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
