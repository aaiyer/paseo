import { usePathname } from "expo-router";
import { useMemo } from "react";

import { useSessionStore } from "@/stores/session-store";
import { parseServerIdFromPathname } from "@/utils/host-routes";
import { resolveMayaRestrictedRoutedServer } from "./policy";

export function useMayaRestrictedRoutedServer(): boolean {
  const pathname = usePathname();
  const routeServerId = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  return useSessionStore((state) =>
    resolveMayaRestrictedRoutedServer(
      routeServerId,
      routeServerId ? { [routeServerId]: state.sessions[routeServerId]?.serverInfo } : {},
    ),
  );
}
