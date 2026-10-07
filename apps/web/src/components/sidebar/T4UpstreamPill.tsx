import type { T4UpstreamBridge, T4UpstreamState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";

function t4UpstreamTitle(state: T4UpstreamState): string {
  const commits = `${state.totalCommits} new ${state.kind === "rebuild" ? state.branch : "T3"} commit${state.totalCommits === 1 ? "" : "s"}`;
  switch (state.status) {
    case "checking":
      return "Checking T3 main…";
    case "up-to-date":
      return "T4 includes the latest T3 main";
    case "available":
      return state.kind === "rebuild" ? `${commits} to build` : `${commits} merge cleanly`;
    case "conflicts":
      return `${commits} conflict with ${state.branch}`;
    case "updating":
      return "Updating T4…";
    case "error":
      return "T4 update failed";
    default:
      return "T3 main not checked yet";
  }
}

/** Local T4 fork builds: shows upstream T3 changes and merges them when they apply cleanly. */
export function T4UpstreamPill() {
  const bridge = isElectron ? window.desktopBridge?.t4Upstream : undefined;
  return bridge ? <T4UpstreamControl bridge={bridge} /> : null;
}

function T4UpstreamControl({ bridge }: { readonly bridge: T4UpstreamBridge }) {
  const [state, setState] = useState<T4UpstreamState | null>(null);
  useEffect(() => {
    let active = true;
    void bridge.getState().then((initial) => active && setState(initial));
    const unsubscribe = bridge.onState(setState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  if (!state || state.status === "disabled") return null;
  const busy = state.status === "checking" || state.status === "updating";
  const attention = state.status === "available" || state.status === "conflicts";
  const title = t4UpstreamTitle(state);

  const update = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      state.kind === "rebuild"
        ? `Build ${state.branch} and restart T4 when the build finishes?`
        : `Merge T3 main into ${state.branch}, rebuild, and restart T4 when the build finishes?`,
    );
    if (confirmed) setState(await bridge.update());
  };

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={title}
              className={cn(
                "relative inline-flex size-8 cursor-pointer items-center justify-center rounded-full outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2",
                attention
                  ? "bg-sidebar-control-surface text-sidebar-foreground"
                  : "text-(--sidebar-icon-color) hover:text-sidebar-foreground",
              )}
            />
          }
        >
          <PullRequestGlyph.merged className="size-4" />
          {attention ? (
            <span
              className={cn(
                "absolute top-1 right-1 size-2 rounded-full",
                state.status === "conflicts" ? "bg-destructive" : "bg-primary",
              )}
            />
          ) : null}
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" width="lg">
          <div className="flex max-h-[min(32rem,calc(100vh-6rem))] flex-col gap-3 text-sm">
            <div>
              <div className="font-medium">{title}</div>
              {state.message ? (
                <div className="mt-1 text-xs break-words text-muted-foreground">
                  {state.message}
                </div>
              ) : null}
              {state.logPath && (state.status === "updating" || state.status === "error") ? (
                <div className="mt-1 text-xs break-all text-muted-foreground">
                  Log: {state.logPath}
                </div>
              ) : null}
              {state.checkedAt && !busy ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  Checked {new Date(state.checkedAt).toLocaleString()}
                </div>
              ) : null}
            </div>
            {state.conflicts.length > 0 ? (
              <div>
                <div className="text-xs font-medium text-destructive">
                  Resolve these conflicts in {state.branch} before updating:
                </div>
                <ul className="mt-1 space-y-0.5 font-mono text-xs break-all">
                  {state.conflicts.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {state.commits.length > 0 ? (
              <ul className="min-h-0 space-y-1 overflow-y-auto text-xs">
                {state.commits.map((commit) => (
                  <li key={commit.sha} className="flex gap-2">
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {commit.sha.slice(0, 7)}
                    </span>
                    <span>{commit.subject}</span>
                  </li>
                ))}
                {state.totalCommits > state.commits.length ? (
                  <li className="text-muted-foreground">
                    and {state.totalCommits - state.commits.length} more
                  </li>
                ) : null}
              </ul>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void bridge.check().then(setState)}
              >
                Check now
              </Button>
              <Button
                size="sm"
                disabled={state.status !== "available"}
                onClick={() => void update()}
              >
                {state.kind === "rebuild" ? "Rebuild" : "Merge & rebuild"}
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
