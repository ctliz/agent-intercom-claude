import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url);

test("published package contains only the intended protected-provider source and artifact", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")) as {
    files: string[];
  };
  const providerRules = manifest.files.filter((path) => path.replace(/^!/, "").startsWith("provider/"));

  assert.deepEqual(providerRules, [
    "provider/protected-service.ts",
    "provider/provider.mjs",
    "!provider/entry.ts",
  ]);
  assert.ok(manifest.files.includes("!scripts/build-protected-provider.mjs"));
  assert.equal(providerRules.some((path) => path.includes("*")), false);
  assert.ok(existsSync(new URL("provider/protected-service.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/provider.mjs", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/entry.ts", repositoryRoot)));
  assert.ok(existsSync(new URL("provider/protected-service.test.ts", repositoryRoot)));
});

test("protected provider is neither an executable nor an ordinary build entry", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")) as {
    main: string;
    bin: Record<string, string>;
    scripts: Record<string, string>;
  };
  const ordinaryBuild = readFileSync(new URL("scripts/build.mjs", repositoryRoot), "utf8");

  assert.equal(manifest.main, "dist/claude-server.mjs");
  assert.equal(Object.values(manifest.bin).includes("provider/provider.mjs"), false);
  assert.doesNotMatch(ordinaryBuild, /protected-provider|provider\/provider\.mjs|provider\/entry\.ts/);
  assert.equal(manifest.scripts.build, "node scripts/build.mjs");
  assert.equal(manifest.scripts.prepare, "npm run build");
  assert.equal(manifest.scripts.prepack, "npm run build:protected-provider");
});

test("package manifest and plugin definition maintain consistent MCP, monitors, skills, and commands paths", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")) as {
    files: string[];
  };

  assert.ok(manifest.files.includes(".claude-plugin/**/*"));
  assert.ok(manifest.files.includes(".mcp.json"));
  assert.ok(manifest.files.includes("monitors/**/*"));
  assert.ok(manifest.files.includes("skills/**/*"));
  assert.ok(manifest.files.includes("commands/**/*"));
  assert.ok(manifest.files.includes("dist/**/*"));

  const plugin = JSON.parse(readFileSync(new URL(".claude-plugin/plugin.json", repositoryRoot), "utf8")) as {
    name: string;
    skills: string;
    commands: string;
    monitors: string;
    mcpServers: string;
  };

  assert.equal(plugin.name, "claude-intercom");
  assert.ok(existsSync(new URL(plugin.monitors, repositoryRoot)));
  assert.ok(existsSync(new URL(plugin.mcpServers, repositoryRoot)));
  assert.ok(existsSync(new URL(plugin.skills, repositoryRoot)));
  assert.ok(existsSync(new URL(plugin.commands, repositoryRoot)));

  const monitors = JSON.parse(readFileSync(new URL(plugin.monitors, repositoryRoot), "utf8")) as Array<{
    name: string;
    command: string;
  }>;
  const inboxMonitor = monitors.find((m) => m.name === "intercom-inbox");
  assert.ok(inboxMonitor, "monitors.json must define intercom-inbox");
  assert.match(inboxMonitor.command, /dist\/inbox-monitor\.mjs/);

  const mcpConfig = JSON.parse(readFileSync(new URL(plugin.mcpServers, repositoryRoot), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.ok(mcpConfig.mcpServers["claude-intercom"], ".mcp.json must define claude-intercom");
  assert.match(mcpConfig.mcpServers["claude-intercom"].args[0], /dist\/claude-server\.mjs/);

  assert.ok(existsSync(new URL("skills/claude-intercom/SKILL.md", repositoryRoot)));
  assert.ok(existsSync(new URL("commands/intercom.md", repositoryRoot)));
  assert.ok(existsSync(new URL("commands/intercom-id.md", repositoryRoot)));
});
