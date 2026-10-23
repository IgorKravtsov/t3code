// @effect-diagnostics nodeBuiltinImport:off - Local signing drives the macOS security and codesign tools directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { exists } from "./t4-state.ts";

const IDENTITY_NAME = "T4 Code Local Signing";

function run(command: string, args: ReadonlyArray<string>, input?: string): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", input });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

/**
 * The Electron binary ships linker-signed as "Electron", so macOS refuses notifications the
 * renamed app posts as its own bundle id. Ad-hoc signing would fix the identifier but tie the
 * app's identity to each build's hash, re-prompting Keychain and notification access on every
 * update. A self-signed certificate kept in its own keychain gives every build the same identity
 * without touching the login keychain.
 */
async function ensureSigningKeychain(directory: string) {
  const keychain = NodePath.join(directory, "t4-signing.keychain-db");
  const passwordFile = NodePath.join(directory, "keychain-password");
  if (!(await exists(keychain)) || !(await exists(passwordFile))) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const password = NodeCrypto.randomBytes(24).toString("hex");
    const config = NodePath.join(directory, "cert.cnf");
    const key = NodePath.join(directory, "key.pem");
    const certificate = NodePath.join(directory, "cert.pem");
    const bundle = NodePath.join(directory, "identity.p12");
    await NodeFSP.writeFile(
      config,
      `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${IDENTITY_NAME}\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`,
    );
    try {
      // The system LibreSSL writes PKCS#12 that `security import` reads; OpenSSL 3 needs -legacy.
      run("/usr/bin/openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "36500",
        "-config",
        config,
        "-keyout",
        key,
        "-out",
        certificate,
      ]);
      run("/usr/bin/openssl", [
        "pkcs12",
        "-export",
        "-inkey",
        key,
        "-in",
        certificate,
        "-out",
        bundle,
        "-name",
        IDENTITY_NAME,
        "-passout",
        `pass:${password}`,
      ]);
      run("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
      run("/usr/bin/security", ["set-keychain-settings", keychain]);
      run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
      run("/usr/bin/security", [
        "import",
        bundle,
        "-k",
        keychain,
        "-P",
        password,
        "-T",
        "/usr/bin/codesign",
      ]);
      run("/usr/bin/security", [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        password,
        keychain,
      ]);
    } finally {
      await Promise.all([config, key, bundle].map((path) => NodeFSP.rm(path, { force: true })));
    }
    await NodeFSP.writeFile(passwordFile, password + "\n", { mode: 0o600 });
  }
  const password = (await NodeFSP.readFile(passwordFile, "utf8")).trim();
  run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
  const identity = /\b([0-9A-F]{40})\b "T4 Code Local Signing"/.exec(
    run("/usr/bin/security", ["find-identity", "-p", "codesigning", keychain]),
  )?.[1];
  if (!identity) throw new Error(`No "${IDENTITY_NAME}" identity in ${keychain}`);
  return { keychain, identity };
}

/** Signs the bundle and its helpers with the stable local identity, under their bundle ids. */
export async function signT4MacApp(app: string, signingDirectory: string) {
  const { keychain, identity } = await ensureSigningKeychain(signingDirectory);
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, "--keychain", keychain, app]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
}
