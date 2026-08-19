import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions } from "@/git/use-actions";
import { useSessionStore } from "@/stores/session-store";
import { isMayaRestrictedServerInfo } from "@/maya-restricted/policy";

interface WorkspaceActionsProps {
  serverId: string;
  cwd: string;
}

export function WorkspaceActions({ serverId, cwd }: WorkspaceActionsProps) {
  const mayaRestricted = useSessionStore((state) =>
    isMayaRestrictedServerInfo(state.sessions[serverId]?.serverInfo),
  );
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  return mayaRestricted ? null : <GitActionsSplitButton gitActions={gitActions} />;
}
