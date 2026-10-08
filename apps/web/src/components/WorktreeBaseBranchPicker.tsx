import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import { usePaginatedBranches } from "../state/queries";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { BranchPicker, BranchPickerRefItem } from "./BranchPicker";
import { resolveBranchTriggerLabel, sanitizeNewRefName } from "./BranchToolbar.logic";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Button } from "./ui/button";
import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";

const CUSTOM_REF_ITEM_PREFIX = "__custom_ref__:";

/**
 * Select a future worktree's base without changing the project's current checkout.
 * Without the start-from-origin switch the picker is for a stored default: it lists
 * origin/<name> refs beside local ones and accepts a typed ref that is not listed.
 */
export function WorktreeBaseBranchPicker({
  environmentId,
  cwd,
  value,
  onValueChange,
  startFromOrigin,
  onStartFromOriginChange,
  placeholder,
  disabled = false,
  id,
  "aria-label": ariaLabel,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  value: string;
  onValueChange: (branch: string) => void;
  startFromOrigin?: boolean;
  onStartFromOriginChange?: (checked: boolean) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const originControl =
    startFromOrigin !== undefined && onStartFromOriginChange
      ? { checked: startFromOrigin, onCheckedChange: onStartFromOriginChange }
      : undefined;
  const freeform = originControl === undefined;
  const branches = usePaginatedBranches(
    { environmentId, cwd, query: sanitizeNewRefName(deferredQuery) },
    { includeMatchingRemoteRefs: freeform },
  );
  const selectedRefQuery = useEnvironmentQuery(
    cwd && value && !freeform
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd, query: value, limit: 10 },
        })
      : null,
  );
  const selectedRef =
    branches.refs.find((branch) => branch.name === value) ??
    selectedRefQuery.data?.refs.find((branch) => branch.name === value);
  const label = freeform
    ? value || placeholder || "Select ref"
    : resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: value || null,
        resolvedActiveBranchIsRemote: selectedRef ? selectedRef.isRemote === true : null,
        startFromOrigin: startFromOrigin ?? false,
      });
  const branchByName = useMemo(
    () => new Map(branches.refs.map((branch) => [branch.name, branch])),
    [branches.refs],
  );
  const customRef =
    freeform && deferredQuery && !branchByName.has(deferredQuery) ? deferredQuery : null;
  const items = [
    ...(customRef ? [`${CUSTOM_REF_ITEM_PREFIX}${customRef}`] : []),
    ...branchByName.keys(),
  ];
  const hasNextPage = branches.data?.nextCursor != null;
  const statusText =
    branches.error ??
    (branches.isPending && branches.data === null
      ? "Loading refs..."
      : branches.isFetchingNextPage
        ? "Loading more refs..."
        : hasNextPage
          ? `Showing ${branches.refs.length} of ${branches.data?.totalCount} refs`
          : null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const select = (item: string) => {
    onValueChange(
      item.startsWith(CUSTOM_REF_ITEM_PREFIX) ? item.slice(CUSTOM_REF_ITEM_PREFIX.length) : item,
    );
    handleOpenChange(false);
  };
  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={value || null}
      query={query}
      resultsQuery={deferredQuery}
      onQueryChange={setQuery}
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      onSelectItem={select}
      hasNextPage={hasNextPage}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={statusText}
      originControl={originControl}
      popupProps={{ align: "start", side: "bottom", className: "flex w-80 flex-col" }}
      getItemType={(item) => (item.startsWith(CUSTOM_REF_ITEM_PREFIX) ? "custom-ref" : "branch")}
      renderItem={(name, index) => {
        if (name.startsWith(CUSTOM_REF_ITEM_PREFIX)) {
          return (
            <ComboboxItem
              hideIndicator
              key={name}
              index={index}
              value={name}
              onClick={() => select(name)}
            >
              <span className="truncate">Use &quot;{customRef}&quot;</span>
            </ComboboxItem>
          );
        }
        const branch = branchByName.get(name);
        return branch ? (
          <BranchPickerRefItem
            branch={branch}
            projectCwd={cwd}
            index={index}
            onClick={() => select(branch.name)}
          />
        ) : null;
      }}
    >
      <ComboboxTrigger
        id={id}
        aria-label={ariaLabel}
        disabled={disabled || !cwd}
        render={<Button variant="outline" size="sm" />}
        className="w-full justify-between "
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <MiddleTruncate value={label} className="flex-1 text-left" />
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </ComboboxTrigger>
    </BranchPicker>
  );
}
