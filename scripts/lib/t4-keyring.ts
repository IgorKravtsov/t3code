// @effect-diagnostics nodeBuiltinImport:off - Isolated Electron helpers exchange protected values through pipes rather than plaintext files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { exists } from "./t4-state.ts";

export async function reencryptT4Credentials(
  source: string,
  destination: string,
  electron: string,
  temporary: string,
) {
  const files: Array<{ path: string; document: Record<string, unknown> }> = [];
  const fields: Array<{ ciphertext: string; replace: (value: string) => void }> = [];
  const addField = (document: Record<string, unknown>, key: string, prefix = "") => {
    const value = document[key];
    if (typeof value !== "string" || !value.startsWith(prefix)) return;
    fields.push({
      ciphertext: value.slice(prefix.length),
      replace: (encrypted) => {
        document[key] = prefix + encrypted;
      },
    });
  };
  for (const name of ["connection-catalog.json", "saved-environments.json", "clerk-tokens.json"]) {
    const path = NodePath.join(source, name);
    if (!(await exists(path))) continue;
    const document = JSON.parse(await NodeFSP.readFile(path, "utf8")) as Record<string, unknown>;
    files.push({ path: NodePath.join(destination, name), document });
    if (name === "connection-catalog.json") addField(document, "encryptedCatalog");
    else if (name === "clerk-tokens.json") {
      for (const key of Object.keys(document)) addField(document, key, "enc:");
    } else if (Array.isArray(document.records)) {
      for (const record of document.records) {
        if (typeof record === "object" && record !== null) addField(record, "encryptedBearerToken");
      }
    }
  }
  if (fields.length === 0) return;
  const helper = await NodeFSP.mkdtemp(NodePath.join(temporary, "credentials-"));
  await NodeFSP.writeFile(
    NodePath.join(helper, "package.json"),
    JSON.stringify({ name: "t4-migration-helper", main: "main.cjs" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(helper, "main.cjs"),
    `
const {app,safeStorage}=require('electron');
app.setName(process.env.T4_KEYRING_NAME);
app.setPath('userData',process.env.T4_HELPER_PROFILE);
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',async()=>{try{await app.whenReady();
if(!safeStorage.isEncryptionAvailable()) throw new Error('Keyring unavailable');
const values=await Promise.all(JSON.parse(input).map(async value=>{
if(process.env.T4_KEYRING_MODE!=='decrypt') return safeStorage.encryptString(value).toString('base64');
const bytes=Buffer.from(value,'base64');
try{return safeStorage.decryptString(bytes);}catch(error){
if(typeof safeStorage.decryptStringAsync!=='function') throw error;
return (await safeStorage.decryptStringAsync(bytes)).result;}
}));
process.stdout.write(JSON.stringify(values));app.exit(0);
}catch{process.stderr.write('Credential migration failed; unlock the OS keyring and retry.');app.exit(1);}});
`,
  );
  const helperEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    T4_HELPER_PROFILE: NodePath.join(helper, "profile"),
  };
  delete helperEnvironment.ELECTRON_RUN_AS_NODE;
  const switches: string[] = [];
  if (Effect.runSync(HostProcessPlatform) === "linux") {
    if (helperEnvironment.WAYLAND_DISPLAY && !helperEnvironment.DISPLAY)
      switches.push("--ozone-platform=wayland");
    const settingsPath = NodePath.join(source, "desktop-settings.json");
    const preference: unknown = (await exists(settingsPath))
      ? JSON.parse(await NodeFSP.readFile(settingsPath, "utf8")).linuxPasswordStore
      : undefined;
    const explicit =
      typeof preference === "string" &&
      ["gnome-libsecret", "kwallet", "kwallet5", "kwallet6"].includes(preference)
        ? preference
        : undefined;
    const backend =
      explicit ??
      (helperEnvironment.XDG_CURRENT_DESKTOP?.split(":").includes("KDE")
        ? undefined
        : "gnome-libsecret");
    if (backend) switches.push(`--password-store=${backend}`);
  }
  async function transform(name: string, mode: string, input: string[]) {
    await NodeFSP.mkdir(NodePath.join(helper, "profile"), { recursive: true });
    const result = NodeChildProcess.spawnSync(electron, [...switches, helper], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...helperEnvironment, T4_KEYRING_NAME: name, T4_KEYRING_MODE: mode },
    });
    if (result.status !== 0)
      throw new Error(
        "Could not migrate protected credentials. Unlock the OS keyring and retry; the original snapshot is preserved.",
      );
    return JSON.parse(result.stdout) as string[];
  }
  try {
    let plaintext: string[] | undefined;
    for (const name of ["T3 Code (Nightly)", "T3 Code (Alpha)", "T3 Code", "t3code"]) {
      try {
        plaintext = await transform(
          name,
          "decrypt",
          fields.map((field) => field.ciphertext),
        );
        break;
      } catch {
        /* Historical installs used different app names. */
      }
    }
    if (!plaintext)
      throw new Error(
        "Could not decrypt source credentials with the OS keyring. The source snapshot is preserved; retry from an unlocked graphical session.",
      );
    const encrypted = await transform("T4 Code", "encrypt", plaintext);
    fields.forEach((field, index) => field.replace(encrypted[index]!));
    for (const file of files)
      await NodeFSP.writeFile(file.path, JSON.stringify(file.document, null, 2) + "\n", {
        mode: 0o600,
      });
  } finally {
    await NodeFSP.rm(helper, { recursive: true, force: true });
  }
}
