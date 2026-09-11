export interface WorkspaceIntent {schema: string; id: string; agent: string; branch: string; worktree: string; createdAt: string; state: string; sessionId?: string;}
export function workspaceRecords(root: string): Array<{file:string;category:string;lease:WorkspaceIntent|null}>;
export function workspaceLock(root: string, target: string): () => void;
export function prepareWorkspace(root: string, worktree: string, agent: string, branch: string): WorkspaceIntent;
export function bindWorkspace(root:string, lease:WorkspaceIntent, sessionId:string): WorkspaceIntent;
export function releaseWorkspace(root:string,id:string,head:string,consumersRetired:boolean):void;
export function reconcileReleasedWorkspaces(root:string,runner:{list():Promise<Array<{id:string}>>}):Promise<void>;
export function discardUnlaunchedWorkspace(root:string,lease:WorkspaceIntent,created:boolean,createdBranch:boolean):void;
export function recoverWorkspaceLock(root:string,target:string,nonce:string):void;
export function workspaceEffectReady(root:string,path:string,liveIds:Set<string>):boolean;
