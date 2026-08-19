import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CommandCenterContribution } from "./contributions";
import { createCommandCenterRegistry, type CommandCenterRegistry } from "./registry";
import { filterMayaRestrictedCommandRegistration } from "@/maya-restricted/policy";

const CommandCenterRegistryContext = createContext<CommandCenterRegistry | null>(null);

export function CommandCenterProvider({
  children,
  mayaRestricted,
}: {
  children: ReactNode;
  mayaRestricted: boolean;
}) {
  const registry = useMemo<CommandCenterRegistry>(
    () =>
      createCommandCenterRegistry((registration) =>
        mayaRestricted ? filterMayaRestrictedCommandRegistration(registration) : registration,
      ),
    [mayaRestricted],
  );

  return (
    <CommandCenterRegistryContext.Provider value={registry}>
      {children}
    </CommandCenterRegistryContext.Provider>
  );
}

function useCommandCenterRegistry(): CommandCenterRegistry {
  const registry = useContext(CommandCenterRegistryContext);
  if (!registry) throw new Error("CommandCenterProvider is required");
  return registry;
}

export function useCommandCenterContributions() {
  const registry = useCommandCenterRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

export function useCommandCenterActions(input: {
  sourceId: string;
  enabled: boolean;
  actions: readonly CommandCenterContribution[];
}): void {
  const registry = useCommandCenterRegistry();
  const ownerRef = useRef({ sourceId: input.sourceId, token: Symbol(input.sourceId) });
  if (ownerRef.current.sourceId !== input.sourceId) {
    ownerRef.current = { sourceId: input.sourceId, token: Symbol(input.sourceId) };
  }
  const owner = ownerRef.current;

  useEffect(() => {
    if (!input.enabled) {
      registry.remove(owner);
      return;
    }
    registry.replace({ owner, contributions: input.actions });
    return () => registry.remove(owner);
  }, [input.actions, input.enabled, owner, registry]);
}
