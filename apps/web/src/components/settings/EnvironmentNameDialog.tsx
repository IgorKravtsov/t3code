import { useState } from "react";
import { AuthSettingsWriteScope, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";

export function EnvironmentNameDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const canWriteSettings = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [name, setName] = useState(props.serverConfig?.settings.environmentName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock =
    props.serverConfig === null
      ? "Connect to this environment to rename it."
      : props.serverConfig.environment.capabilities.environmentName !== true
        ? "Update this environment's server to rename it."
        : !canWriteSettings
          ? "Your session cannot change this environment's settings."
          : null;

  async function save(value: string) {
    if (lock !== null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await update({
        environmentId: props.environmentId,
        input: { patch: { environmentName: value.trim() } },
      });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      props.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename environment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename environment</DialogTitle>
            <DialogDescription>
              This name appears in every client connected to this machine. Leave it empty to use its
              detected name.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Environment name"
            autoFocus
            maxLength={200}
            value={name}
            placeholder={props.serverConfig?.environment.label ?? "My laptop"}
            disabled={lock !== null || saving}
            onChange={(event) => setName(event.target.value)}
          />
          {lock || error ? (
            <p role="alert" className="mt-2 text-sm text-muted-foreground">
              {lock ?? error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={lock !== null || saving}
              onClick={() => {
                void save("");
              }}
            >
              Use detected name
            </Button>
            <Button type="submit" disabled={lock !== null || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
