import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "./presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

const FIRST = EnvironmentId.make("first");
const SECOND = EnvironmentId.make("second");
function entry(environmentId: EnvironmentId, label = environmentId as string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    enabled: true,
    profile: Option.none(),
  };
}
function config(pullRequests = false, cwd = "/workspace"): ServerConfig {
  return {
    cwd,
    environment: { capabilities: { pullRequests }, platform: { machine: "desktop" } },
  } as ServerConfig;
}
function harness() {
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [FIRST, entry(FIRST)],
      [SECOND, entry(SECOND)],
    ]),
  });
  const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(config()));
  const state = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  const full = createEnvironmentPresentationAtoms({
    catalogValueAtom: catalog,
    stateAtom: () => state,
    serverConfigValueAtom: configs,
  });
  const summaries = createEnvironmentSummaryAtoms({
    catalogValueAtom: catalog,
    presentationAtom: full.presentationAtom,
  });
  return { catalog, configs, state, full, ...summaries, registry: AtomRegistry.make() };
}

describe("environment summary subscriptions", () => {
  it("uses the server name for all summaries, including cached/offline names, without changing other machines", () => {
    const clients = [harness(), harness()];
    try {
      for (const h of clients) {
        const ids = h.registry.get(h.environmentIdsAtom);
        for (const label of ["Ноутбук M4 Air", "Host automatic name"]) {
          h.registry.set(h.configs(FIRST), {
            ...config(),
            environment: {
              ...config().environment,
              environmentId: FIRST,
              label,
              capabilities: { ...config().environment.capabilities, environmentName: true },
            },
          });
          expect(h.registry.get(h.identitiesAtom)).toEqual([
            { environmentId: FIRST, label },
            { environmentId: SECOND, label: "second" },
          ]);
          expect(h.registry.get(h.environmentsAtom)[0]?.environmentLabel).toBe(label);
          expect(h.registry.get(h.full.presentationAtom(FIRST))?.entry.target.label).toBe(label);
          expect(h.registry.get(h.environmentIdsAtom)).toBe(ids);
          expect(Option.getOrThrow(AsyncResult.value(h.registry.get(h.state))).phase).toBe(
            "available",
          );
        }
        const beforeRefresh = h.registry.get(h.full.presentationAtom(FIRST))?.entry;
        const currentConfig = h.registry.get(h.configs(FIRST))!;
        h.registry.set(h.configs(FIRST), { ...currentConfig, cwd: "/another-workspace" });
        expect(h.registry.get(h.full.presentationAtom(FIRST))?.entry).toBe(beforeRefresh);
        // The catalog still owns routes and credentials; renaming never reconnects it.
        expect(h.registry.get(h.catalog).entries.get(FIRST)?.target.label).toBe("first");
      }
    } finally {
      clients.forEach((h) => h.registry.dispose());
    }
  });
  it("tracks capabilities across environments, config loss and removal", () => {
    const h = harness();
    const stop = h.registry.subscribe(h.pullRequestsSupportedAtom, () => {});
    try {
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.configs(FIRST), config(true));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(true));
      h.registry.set(h.configs(FIRST), null);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.catalog, { isReady: true, entries: new Map([[FIRST, entry(FIRST)]]) });
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([FIRST]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([{ environmentId: FIRST, label: "first" }]);
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map([
          [SECOND, entry(SECOND)],
          [FIRST, entry(FIRST)],
        ]),
      });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([SECOND, FIRST]);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(false));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([]);
      expect(h.registry.get(h.environmentsAtom)).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});
