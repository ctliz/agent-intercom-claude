import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temp = mkdtempSync(join(tmpdir(), "claude-intercom-monitor-pack-"));
try {
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], {
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const filename = JSON.parse(packed.stdout)[0]?.filename;
  if (!filename) throw new Error("npm pack did not return an archive");

  const archive = gunzipSync(readFileSync(join(temp, filename)));
  const paths = new Set();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nul = header.indexOf(0);
    paths.add(header.subarray(0, nul === -1 ? 100 : nul).toString("utf8"));
    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  for (const path of [
    "package/.claude-plugin/plugin.json",
    "package/monitors/monitors.json",
    "package/dist/inbox-monitor.mjs",
  ]) {
    if (!paths.has(path)) throw new Error(`packed adapter is missing ${path}`);
  }
  console.log("Verified packed Claude plugin Monitor files");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
