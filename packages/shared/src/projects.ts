/** A folder Harv works on as a project (project mode: Harv behaves like Claude Code there). */
export interface Project {
  id: string;
  name: string;
  /** Full Windows path of the project folder. */
  path: string;
}

export type ProjectClientMessage =
  /** Adds an existing folder as a project (`name` defaults to the folder's name). */
  | { type: 'project.add'; path: string; name?: string }
  /** Forgets a project (its folder and chats stay). */
  | { type: 'project.remove'; id: string }
  /** Binds a chat to a project, or back to plain assistant mode with null. */
  | { type: 'chat.setProject'; tabId: string; projectId: string | null };

export type ProjectServerMessage =
  | { type: 'projects'; projects: Project[] }
  /** A chat's project changed (from the dashboard or Harv's start_project / open_project tools). */
  | { type: 'chat.project'; tabId: string; projectId: string | null }
  | { type: 'project.error'; message: string };
