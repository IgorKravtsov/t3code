// @effect-diagnostics nodeBuiltinImport:off - Signs a throwaway bundle with the real macOS tools.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { signT4MacApp } from "./t4-codesign.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

async function fakeApp(directory: string) {
  const app = NodePath.join(directory, "Fake T4.app");
  await NodeFSP.mkdir(NodePath.join(app, "Contents", "MacOS"), { recursive: true });
  await NodeFSP.copyFile("/usr/bin/true", NodePath.join(app, "Contents", "MacOS", "Fake T4"));
  await NodeFSP.writeFile(
    NodePath.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fake T4</string>
<key>CFBundleIdentifier</key><string>com.t4tools.t4code.test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  return app;
}

function signature(app: string) {
  return NodeChildProcess.spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", app], {
    encoding: "utf8",
  }).stderr;
}

it.effect("signs the app under its bundle id with the same local identity on every build", () =>
  Effect.gen(function* () {
    // Only macOS has codesign; the Linux build ships unsigned.
    if ((yield* HostProcess.Platform) !== "darwin") return;
    yield* Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-codesign-test-"));
      temporary.push(directory);
      const signing = NodePath.join(directory, "signing");
      const first = await fakeApp(NodePath.join(directory, "one"));
      await signT4MacApp(first, signing);
      const second = await fakeApp(NodePath.join(directory, "two"));
      await signT4MacApp(second, signing);

      const details = signature(first);
      expect(details).toContain("Identifier=com.t4tools.t4code.test");
      expect(details).toContain("Authority=T4 Code Local Signing");
      expect(details).toContain("Info.plist entries=");
      const requirement = (app: string) =>
        NodeChildProcess.spawnSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8" })
          .stdout;
      expect(requirement(second)).toBe(requirement(first));
      expect(requirement(first)).toContain("certificate leaf");
    });
  }),
);
