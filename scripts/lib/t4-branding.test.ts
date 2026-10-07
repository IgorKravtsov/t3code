// @effect-diagnostics nodeBuiltinImport:off - Exercise the build-only asset exporter in an isolated directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import sharp from "sharp";
import { expect, it } from "@effect/vitest";

it("renders T4 icons and labels while preserving migration identities and protocol storage keys", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-brand-test-"));
  const repository = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
  try {
    for (const name of [
      "apps/web/src",
      "apps/web/public",
      "apps/desktop/src/app",
      "apps/desktop/resources/dmg",
      "apps/mobile/src",
      "apps/mobile/assets/widget",
      "packages/client-runtime/src",
      "apps/server/src",
      "apps/marketing/public",
      "apps/mobile/modules/t3-agent-notifications/android/src/main/res/drawable",
      "assets/t4",
      ...["prod", "nightly", "dev"].map((variant) => `assets/${variant}/app-icon.icon/Assets`),
    ])
      await NodeFSP.mkdir(NodePath.join(directory, name), { recursive: true });
    await NodeFSP.copyFile(
      NodePath.join(repository, "assets/t4/mark.svg"),
      NodePath.join(directory, "assets/t4/mark.svg"),
    );
    await NodeFSP.writeFile(
      NodePath.join(directory, "apps/web/index.html"),
      "<title>T3 Code</title>",
    );
    await NodeFSP.writeFile(
      NodePath.join(directory, "apps/mobile/app.config.ts"),
      'const appName="T3 Code";',
    );
    await NodeFSP.writeFile(
      NodePath.join(directory, "apps/web/src/label.ts"),
      'export const name="T3 Code"; export const key="t3code:themes:v1";',
    );
    const legacy = NodePath.join(directory, "apps/desktop/src/app/DesktopLegacyLocalStorage.ts");
    await NodeFSP.writeFile(legacy, 'const source="T3 Code (Alpha)"; const origin="t3code://app";');
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(repository, "scripts/brand-t4.mjs"), directory],
        { stdio: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      );
      let errors = "";
      child.stderr.on("data", (chunk) => {
        errors += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors))));
    });
    expect(
      await NodeFSP.readFile(NodePath.join(directory, "apps/web/index.html"), "utf8"),
    ).toContain("T4 Code");
    expect(
      await NodeFSP.readFile(NodePath.join(directory, "apps/mobile/app.config.ts"), "utf8"),
    ).toContain("T4 Code");
    expect(await NodeFSP.readFile(NodePath.join(directory, "apps/web/src/label.ts"), "utf8")).toBe(
      'export const name="T4 Code"; export const key="t3code:themes:v1";',
    );
    expect(await NodeFSP.readFile(legacy, "utf8")).toContain("T3 Code (Alpha)");
    const image = await sharp(NodePath.join(directory, "assets/prod/black-universal-1024.png"))
      .resize(128)
      .ensureAlpha()
      .raw()
      .toBuffer();
    expect([...image.subarray((89 * 128 + 96) * 4, (89 * 128 + 96) * 4 + 3)]).toEqual([
      245, 243, 255,
    ]);
    expect([...image.subarray((89 * 128 + 83) * 4, (89 * 128 + 83) * 4 + 3)]).toEqual([22, 21, 29]);
    const mac = await sharp(
      NodePath.join(directory, "assets/nightly/nightly-macos-1024.png"),
    ).metadata();
    expect([mac.width, mac.height, mac.hasAlpha]).toEqual([1024, 1024, true]);
    const ico = await NodeFSP.readFile(NodePath.join(directory, "apps/web/public/favicon.ico"));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 15_000);
