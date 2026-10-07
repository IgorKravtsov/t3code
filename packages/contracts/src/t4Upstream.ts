/** Local T4 fork builds only: merging upstream T3 main into the fork branch and rebuilding. */
export interface T4UpstreamState {
  status:
    | "disabled"
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "conflicts"
    | "updating"
    | "error";
  /** "merge" brings in upstream main; "rebuild" installs fork commits made elsewhere. */
  kind: "merge" | "rebuild" | null;
  branch: string | null;
  commits: ReadonlyArray<{ sha: string; subject: string }>;
  totalCommits: number;
  conflicts: ReadonlyArray<string>;
  checkedAt: string | null;
  /** Progress while updating, the reason otherwise. */
  message: string | null;
  logPath: string | null;
}

export interface T4UpstreamBridge {
  getState: () => Promise<T4UpstreamState>;
  check: () => Promise<T4UpstreamState>;
  /** Merges, rebuilds, and relaunches T4. Refused while the merge would conflict. */
  update: () => Promise<T4UpstreamState>;
  onState: (listener: (state: T4UpstreamState) => void) => () => void;
}

// Augmented here rather than edited in ipc.ts, so daily upstream merges never touch that file.
declare module "./ipc.ts" {
  interface DesktopBridge {
    /** Present in local T4 fork builds. */
    t4Upstream?: T4UpstreamBridge;
  }
}
