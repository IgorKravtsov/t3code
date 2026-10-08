// @effect-diagnostics nodeBuiltinImport:off - Isolated Electron helpers exchange protected values through pipes rather than plaintext files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { exists } from "./t4-state.ts";
import { mergeT4Values } from "./t4-merge.ts";

export async function reencryptT4Credentials(
  source: string,
  destination: string,
  electron: string,
  temporary: string,
  options: { merge?: boolean; baseline?: string } = {},
) {
  const files: Array<{ path: string; document: Record<string, unknown> }> = [];
  const fields: Array<{
    ciphertext: string;
    key: string;
    replace: (value: string) => void;
  }> = [];
  const addField = (document: Record<string, unknown>, key: string, prefix = "") => {
    const value = document[key];
    if (typeof value !== "string" || !value.startsWith(prefix)) return;
    fields.push({
      ciphertext: value.slice(prefix.length),
      key,
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
  async function writeFiles() {
    for (const file of files) {
      const current: unknown =
        options.merge && (await exists(file.path))
          ? JSON.parse(await NodeFSP.readFile(file.path, "utf8"))
          : undefined;
      const document =
        options.merge && NodePath.basename(file.path) !== "connection-catalog.json"
          ? mergeT4Values(file.document, current, undefined)
          : file.document;
      await NodeFSP.writeFile(file.path, JSON.stringify(document, null, 2) + "\n", {
        mode: 0o600,
      });
    }
  }
  if (fields.length === 0) {
    await writeFiles();
    return;
  }
  const helper = await NodeFSP.mkdtemp(NodePath.join(temporary, "credentials-"));
  await NodeFSP.writeFile(
    NodePath.join(helper, "package.json"),
    JSON.stringify({ name: "t4-migration-helper", main: "main.cjs" }),
  );
  await NodeFSP.writeFile(
    NodePath.join(helper, "main.cjs"),
    `
const {app,safeStorage}=require('electron');
if(process.env.T4_HELPER_PIDFILE) require('node:fs').writeFileSync(process.env.T4_HELPER_PIDFILE,String(process.pid),{mode:0o600});
app.setName(process.env.T4_KEYRING_NAME);
app.setPath('userData',process.env.T4_HELPER_PROFILE);
let input='',started=false; process.stdin.setEncoding('utf8');
const run=async()=>{if(started)return;started=true;try{await app.whenReady();
if(!safeStorage.isEncryptionAvailable()) throw new Error('Keyring unavailable');
const values=await Promise.all(JSON.parse(input).map(async value=>{
if(process.env.T4_KEYRING_MODE!=='decrypt') return safeStorage.encryptString(value).toString('base64');
const bytes=Buffer.from(value,'base64');
try{return safeStorage.decryptString(bytes);}catch(error){
if(typeof safeStorage.decryptStringAsync!=='function') throw error;
return (await safeStorage.decryptStringAsync(bytes)).result;}
}));
process.stdout.write(JSON.stringify(values),()=>app.exit(0));
}catch(error){process.stderr.write(JSON.stringify({error:error.name,message:error.message}));app.exit(1);}};
process.stdin.on('data',chunk=>{input+=chunk;if(input.includes('\\n'))void run();});
process.stdin.on('end',()=>void run());
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
    // Electron chooses the keyring namespace from package metadata before running main.cjs.
    await NodeFSP.writeFile(
      NodePath.join(helper, "package.json"),
      JSON.stringify({ name, productName: name, main: "main.cjs" }),
    );
    await NodeFSP.mkdir(NodePath.join(helper, "profile"), { recursive: true });
    if (Effect.runSync(HostProcessPlatform) === "darwin") {
      // LaunchServices owns the graphical security session. An SSH-launched process cannot
      // request Keychain interaction. FIFOs carry plaintext in memory, never in regular files.
      const inputPipe = NodePath.join(helper, "input");
      const outputPipe = NodePath.join(helper, "output");
      const errors = NodePath.join(helper, "errors");
      const pidFile = NodePath.join(helper, "pid");
      for (const path of [inputPipe, outputPipe, pidFile]) await NodeFSP.rm(path, { force: true });
      const pipes = NodeChildProcess.spawnSync("mkfifo", ["-m", "600", inputPipe, outputPipe]);
      if (pipes.status !== 0)
        throw new Error("Could not create private pipes for Keychain migration.");
      const bundle = NodePath.resolve(electron, "..", "..", "..");
      const child = NodeChildProcess.spawn(
        "/usr/bin/open",
        [
          "-W",
          "-n",
          "-g",
          bundle,
          "--stdin",
          inputPipe,
          "--stdout",
          outputPipe,
          "--stderr",
          errors,
          "--env",
          `T4_KEYRING_NAME=${name}`,
          "--env",
          `T4_KEYRING_MODE=${mode}`,
          "--env",
          `T4_HELPER_PROFILE=${helperEnvironment.T4_HELPER_PROFILE}`,
          "--env",
          `T4_HELPER_PIDFILE=${pidFile}`,
          "--args",
          helper,
        ],
        // `open` forwards its own environment, so an inherited ELECTRON_RUN_AS_NODE would start plain Node.
        { stdio: "ignore", env: helperEnvironment },
      );
      const completed = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Keychain helper launch exited with ${code}`)),
        );
      });
      const timeoutController = new AbortController();
      const timeout = Effect.runPromise(Effect.sleep("2 minutes"), {
        signal: timeoutController.signal,
      }).then(() => {
        throw new Error("Allow Keychain access in the Mac system dialog, then retry migration.");
      });
      try {
        const result = await Promise.race([
          Promise.all([
            completed,
            NodeFSP.writeFile(inputPipe, JSON.stringify(input) + "\n"),
            NodeFSP.readFile(outputPipe, "utf8"),
          ]),
          timeout,
        ]);
        if (!result[2])
          throw new Error(
            `Keychain migration failed: ${(await NodeFSP.readFile(errors, "utf8")).slice(-1000)}`,
          );
        return JSON.parse(result[2]) as string[];
      } catch (error) {
        if (await exists(pidFile)) {
          const pid = Number(await NodeFSP.readFile(pidFile, "utf8"));
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              /* The helper already exited. */
            }
          }
        }
        child.kill("SIGTERM");
        throw error;
      } finally {
        timeoutController.abort();
      }
    }
    const result = NodeChildProcess.spawnSync(electron, [...switches, helper], {
      input: JSON.stringify(input) + "\n",
      encoding: "utf8",
      timeout: 60_000,
      env: { ...helperEnvironment, T4_KEYRING_NAME: name, T4_KEYRING_MODE: mode },
    });
    if (result.status !== 0)
      throw new Error(
        `Credential migration helper exited with ${result.status}: ${result.stderr.slice(-1000)}`,
      );
    return JSON.parse(result.stdout) as string[];
  }
  try {
    let plaintext: string[] | undefined;
    let sourceKeyring = "t3code";
    for (const name of ["t3code", "T3 Code (Nightly)", "T3 Code (Alpha)", "T3 Code"]) {
      try {
        plaintext = await transform(
          name,
          "decrypt",
          fields.map((field) => field.ciphertext),
        );
        sourceKeyring = name;
        break;
      } catch (cause) {
        if (name === "T3 Code") throw cause;
        /* Historical installs used different app names. */
      }
    }
    if (!plaintext)
      throw new Error(
        "Could not decrypt source credentials with the OS keyring. The source snapshot is preserved; retry from an unlocked graphical session.",
      );
    if (options.merge) {
      for (const [index, field] of fields.entries()) {
        if (field.key !== "encryptedCatalog") continue;
        const path = NodePath.join(destination, "connection-catalog.json");
        if (!(await exists(path))) continue;
        const current = JSON.parse(await NodeFSP.readFile(path, "utf8")) as {
          encryptedCatalog: string;
        };
        const [existing] = await transform("t4code", "decrypt", [current.encryptedCatalog]);
        let original: unknown;
        const baselinePath =
          options.baseline && NodePath.join(options.baseline, "connection-catalog.json");
        if (baselinePath && (await exists(baselinePath))) {
          const previous = JSON.parse(await NodeFSP.readFile(baselinePath, "utf8")) as {
            encryptedCatalog: string;
          };
          const [value] = await transform(sourceKeyring, "decrypt", [previous.encryptedCatalog]);
          original = JSON.parse(value!);
        }
        plaintext[index] = JSON.stringify(
          mergeT4Values(JSON.parse(plaintext[index]!), JSON.parse(existing!), original),
        );
      }
    }
    const encrypted = await transform("t4code", "encrypt", plaintext);
    fields.forEach((field, index) => field.replace(encrypted[index]!));
    await writeFiles();
  } finally {
    await NodeFSP.rm(helper, { recursive: true, force: true });
  }
}
