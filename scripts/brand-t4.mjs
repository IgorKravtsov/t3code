#!/usr/bin/env node
// Build-only branding. Storage keys, remote addresses and migration source identities stay compatible.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";
import { encodePngIco } from "./lib/icon-export.ts";

const root = NodePath.resolve(process.argv[2] ?? ".");
const svg = await NodeFSP.readFile(NodePath.join(root, "assets/t4/mark.svg"), "utf8");
const mark = /<path d="([^"]+)"/.exec(svg)[1];
const legacyFiles = new Set([
  "apps/desktop/src/app/DesktopLegacyLocalStorage.ts",
  "apps/desktop/src/app/DesktopUserData.ts",
]);
async function rewrite(directory) {
  for (const entry of await NodeFSP.readdir(NodePath.join(root, directory), {
    withFileTypes: true,
  })) {
    const relative = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) await rewrite(relative);
    else if (/\.(tsx?|html|svg|xml|webmanifest)$/.test(entry.name) && !legacyFiles.has(relative)) {
      const original = await NodeFSP.readFile(NodePath.join(root, relative), "utf8");
      const branded = original.replace(/\bT3\b/g, "T4").replace(/M33\.4509[^"\n]+/g, mark);
      if (branded !== original) await NodeFSP.writeFile(NodePath.join(root, relative), branded);
    }
  }
}
for (const directory of [
  "apps/web/src",
  "apps/web/public",
  "apps/desktop/src",
  "apps/desktop/resources/dmg",
  "apps/mobile/src",
  "apps/mobile/assets/widget",
  "packages/client-runtime/src",
  "apps/server/src",
  "apps/mobile/modules/t3-agent-notifications/android/src/main/res/drawable",
])
  await rewrite(directory);
for (const name of ["apps/web/index.html", "apps/mobile/app.config.ts"]) {
  const path = NodePath.join(root, name);
  await NodeFSP.writeFile(path, (await NodeFSP.readFile(path, "utf8")).replace(/\bT3\b/g, "T4"));
}

// Every channel uses the same T4 mark. The upstream SVGs/exports in the source checkout are untouched.
const image = async (size, mac = false) => {
  const icon = await sharp(Buffer.from(svg))
    .resize(mac ? 824 : size)
    .png()
    .toBuffer();
  return mac
    ? sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00000000" } })
        .composite([{ input: icon, left: 100, top: 100 }])
        .png()
        .toBuffer()
    : icon;
};
const ico = async (sizes) => {
  return encodePngIco(
    await Promise.all(sizes.map(async (size) => ({ size, contents: await image(size) }))),
  );
};
const outputs = {
  prod: ["black", "t3-black"],
  nightly: ["nightly", "nightly"],
  dev: ["blueprint", "blueprint"],
};
for (const [directory, [prefix, webPrefix]] of Object.entries(outputs)) {
  const base = NodePath.join(root, "assets", directory);
  await NodeFSP.writeFile(NodePath.join(base, `${prefix}-universal-1024.png`), await image(1024));
  await NodeFSP.writeFile(NodePath.join(base, `${prefix}-ios-1024.png`), await image(1024));
  await NodeFSP.writeFile(NodePath.join(base, `${prefix}-macos-1024.png`), await image(1024, true));
  await NodeFSP.writeFile(
    NodePath.join(base, `${webPrefix}-windows.ico`),
    await ico([16, 24, 32, 48, 64, 128, 256]),
  );
  await NodeFSP.writeFile(
    NodePath.join(base, `${webPrefix}-web-favicon.ico`),
    await ico([16, 32, 48]),
  );
  for (const size of [16, 32])
    await NodeFSP.writeFile(
      NodePath.join(base, `${webPrefix}-web-favicon-${size}x${size}.png`),
      await image(size),
    );
  await NodeFSP.writeFile(
    NodePath.join(base, `${webPrefix}-web-apple-touch-180.png`),
    await image(180),
  );
  const layer = NodePath.join(base, "app-icon.icon/Assets/text.svg");
  await NodeFSP.writeFile(
    layer,
    `<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><path d="${mark}" fill="white"/></svg>\n`,
  );
}
for (const directory of ["apps/web/public", "apps/marketing/public"]) {
  await NodeFSP.writeFile(NodePath.join(root, directory, "favicon.ico"), await ico([16, 32, 48]));
  for (const size of [16, 32])
    await NodeFSP.writeFile(
      NodePath.join(root, directory, `favicon-${size}x${size}.png`),
      await image(size),
    );
  await NodeFSP.writeFile(NodePath.join(root, directory, "apple-touch-icon.png"), await image(180));
}
await NodeFSP.writeFile(NodePath.join(root, "assets/prod/logo.svg"), svg);
await NodeFSP.mkdir(NodePath.join(root, "apps/desktop/resources"), { recursive: true });
await NodeFSP.writeFile(NodePath.join(root, "apps/desktop/resources/icon.png"), await image(1024));
const wordmark = `<svg viewBox="15.5309 37 94.3941 56.96" xmlns="http://www.w3.org/2000/svg"><path d="${mark}" fill="white"/></svg>`;
const androidMark = async (size, monochrome = false) => {
  const foreground = await sharp(Buffer.from(wordmark))
    .resize(Math.round(size * 0.48))
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: monochrome ? "#00000000" : "#16151d",
    },
  })
    .composite([{ input: foreground, gravity: "centre" }])
    .png()
    .toBuffer();
};
for (const name of [
  "android-icon-mark.png",
  "android-notification-icon.png",
  "android-icon-foreground.png",
])
  await NodeFSP.writeFile(
    NodePath.join(root, "apps/mobile/assets", name),
    await androidMark(432, true),
  );
for (const variant of ["prod", "nightly", "dev"])
  await NodeFSP.writeFile(
    NodePath.join(root, "apps/mobile/assets", `android-splash-icon-${variant}.png`),
    await androidMark(1152),
  );
for (const variant of ["nightly", "dev"])
  await NodeFSP.writeFile(
    NodePath.join(root, "apps/mobile/assets", `android-icon-background-${variant}.png`),
    await sharp({ create: { width: 432, height: 432, channels: 4, background: "#16151d" } })
      .png()
      .toBuffer(),
  );
console.log("T4 labels, vector wordmarks and application icons generated.");
