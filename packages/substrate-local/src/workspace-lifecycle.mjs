// Shared by the emitted Node loop and the local CLI. No task/PR completion inference.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const stateDir = root => join(root,'.open-autonomy','runner-state');
const leaseFile = (root,id) => {
 if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid workspace lease ID');
 return join(stateDir(root),'workspaces',`${id}.json`);
};
const canonical = path => existsSync(path) ? realpathSync(path) : join(canonical(dirname(resolve(path))),basename(path));
function atomic(file, value) {
 mkdirSync(dirname(file),{recursive:true});const tmp=`${file}.${randomUUID()}.tmp`;
 try {writeFileSync(tmp,JSON.stringify(value,null,2));renameSync(tmp,file);} finally {rmSync(tmp,{force:true});}
}
export function workspaceRecords(root) {
 const out=[];
 for(const category of ['workspaces','workspace-quarantine']) {
  const dir=join(stateDir(root),category);if(!existsSync(dir))continue;
  for(const name of readdirSync(dir).filter(n=>n.endsWith('.json'))) {
   const file=join(dir,name);
   try {
    const lease=JSON.parse(readFileSync(file,'utf8'));
    if(!lease || Array.isArray(lease) || !['open-autonomy.workspace-lease.v1','open-autonomy.workspace-lease.v2'].includes(lease.schema) || !['id','agent','branch','worktree','createdAt'].every(key=>typeof lease[key]==='string' && lease[key]) || (lease.schema.endsWith('.v2') && typeof lease.state!=='string'))throw new Error('Invalid lease');
    out.push({file,category,lease});
   }
   catch {out.push({file,category,lease:null});}
  }
 }
 return out;
}
function lockPath(root,target) {
 const path=canonical(target),common=git(root,['rev-parse','--path-format=absolute','--git-common-dir']);
 const locks=join(common,'oa-workspace-locks');mkdirSync(locks,{recursive:true});
 return join(locks,createHash('sha256').update(path).digest('hex'));
}
function processBirth(pid) {
 return execFileSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,TZ:'UTC',LC_ALL:'C'}}).trim();
}
export function workspaceLock(root,target) {
 const lock=lockPath(root,target),nonce=randomUUID(),temporary=`${lock}.${nonce}.tmp`;
 mkdirSync(temporary);
 try {
  atomic(join(temporary,'owner.json'),{pid:process.pid,birth:processBirth(process.pid),nonce,target:canonical(target)});
  renameSync(temporary,lock); // A published lock is nonempty and always has a complete owner.
 }catch(error){rmSync(temporary,{recursive:true,force:true});throw new Error(`Workspace is locked or lock publication failed: ${lock}; inspect owner.json and use workspace-unlock with its nonce after that owner exits. ${error.message}`);}
 return ()=>rmSync(lock,{recursive:true});
}
export function recoverWorkspaceLock(root,target,nonce) {
 const lock=lockPath(root,target);
 const readOwner=()=>JSON.parse(readFileSync(join(lock,'owner.json'),'utf8'));
 const owner=readOwner();
 if(!Number.isInteger(owner.pid)||owner.pid<=0||typeof owner.birth!=='string'||!owner.birth||typeof owner.nonce!=='string'||!owner.nonce||owner.target!==canonical(target)||!nonce||owner.nonce!==nonce)throw new Error('Invalid or changed lock owner; inspect its receipt.');
 let gone=false;
 try{process.kill(owner.pid,0);gone=processBirth(owner.pid)!==owner.birth;}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}
 if(!gone)throw new Error('Lock owner is still alive; it cannot be reclaimed.');
 // Prove death BEFORE taking the recovery gate; that owner can no longer release
 // the directory while recovery operates. Then recheck the immutable nonce.
 const gate=join(lock,'recovery');mkdirSync(gate);let removed=false;
 try {
  if(readOwner().nonce!==nonce)throw new Error('Lock was replaced; leave its new owner alone.');
  rmSync(lock,{recursive:true});removed=true;
 }finally{
  if(!removed) {try{if(readOwner().nonce===nonce)rmSync(gate,{recursive:true,force:true});}catch{/* A replacement owns its own directory. */}}
 }
}

function identity(root,path) {
 if(canonical(git(path,['rev-parse','--show-toplevel']))!==canonical(path))throw new Error('Not the worktree root');
 const common=git(path,['rev-parse','--path-format=absolute','--git-common-dir']);
 if(common!==git(root,['rev-parse','--path-format=absolute','--git-common-dir']))throw new Error('Different repository');
 return {common,gitDir:git(path,['rev-parse','--absolute-git-dir']),head:git(path,['rev-parse','HEAD']),branch:git(path,['symbolic-ref','--short','HEAD'])};
}
function token(gitDir,create=false) {
 const file=join(gitDir,'oa-workspace-generation');
 if(existsSync(file))return readFileSync(file,'utf8');
 if(!create)throw new Error('Workspace generation marker is missing.');
 const value=randomUUID(),tmp=`${file}.${value}.tmp`;
 try {writeFileSync(tmp,value,{flag:'wx'});linkSync(tmp,file);}finally{rmSync(tmp,{force:true});}
 return value;
}
export function prepareWorkspace(root,worktree,agent,branch) {
 const id=randomUUID(),path=canonical(worktree);
 const lease={schema:'open-autonomy.workspace-lease.v2',id,agent,branch,worktree:path,createdAt:new Date().toISOString(),state:'preparing'};
 atomic(leaseFile(root,id),lease);return lease;
}
export function bindWorkspace(root,lease,sessionId) {
 const current=identity(root,lease.worktree);
 if(current.branch!==lease.branch || (lease.generation && (current.gitDir!==lease.gitDir || token(current.gitDir)!==lease.generation)))throw new Error('Workspace generation changed during launch');
 const active={...lease,...current,generation:token(current.gitDir,!lease.generation),sessionId,state:sessionId?'active':'launching'};
 atomic(leaseFile(root,lease.id),active);return active;
}
export function releaseWorkspace(root,id,head,consumersRetired) {
 if(!consumersRetired)throw new Error('Retire the terminal, app, World and all other consumers first; pass --consumers-retired.');
 const file=leaseFile(root,id),lease=JSON.parse(readFileSync(file,'utf8'));
 const unlock=workspaceLock(root,lease.worktree);
 try {
  if(lease.schema!=='open-autonomy.workspace-lease.v2'||!['active','released'].includes(lease.state))throw new Error('Unresolved or legacy workspace requires owner recovery.');
  const current=identity(root,lease.worktree);
  if(current.gitDir!==lease.gitDir||current.branch!==lease.branch||token(current.gitDir)!==lease.generation)throw new Error('Workspace generation changed.');
  if(!head||current.head!==head)throw new Error('Specify the exact current HEAD.');
  if(git(lease.worktree,['status','--porcelain']))throw new Error('Workspace has uncommitted or untracked work.');
  atomic(file,{...lease,state:'released',releasedHead:head,releasedAt:new Date().toISOString(),consumersRetired:true});
 } finally {unlock();}
}
export function workspaceEffectReady(root,path,liveIds) {
 const initial=workspaceRecords(root);
 // Legacy effects without a workspace lease retain their existing accepted-control
 // behavior. Any recorded ownership, including malformed ownership, fences this path.
 if(initial.length===0)return true;
 if(initial.some(r=>!r.lease))return false;
 const peers=initial.filter(r=>r.lease.worktree===path);
 if(peers.length===0)return true;
 let unlock;try{unlock=workspaceLock(root,path);}catch{return false;}
 try {
  const records=workspaceRecords(root);if(records.some(r=>!r.lease))return false;
  const owners=records.filter(r=>r.lease.worktree===path);
  if(!owners.length||owners.some(r=>r.category!=='workspaces'||r.lease.schema!=='open-autonomy.workspace-lease.v2'||!['released','removing'].includes(r.lease.state)||!r.lease.consumersRetired||liveIds.has(r.lease.sessionId)))return false;
  const current=identity(root,path);
  return owners.every(r=>r.lease.gitDir===current.gitDir&&r.lease.branch===current.branch&&r.lease.generation===token(current.gitDir)&&r.lease.releasedHead===current.head)&&!git(path,['status','--porcelain']);
 }catch{return false;}finally{unlock();}
 // The durable effect marker itself holds the workspace during execution. Do not
 // hold this lock across an opaque effect: it may legitimately launch a peer there.
}
export async function reconcileReleasedWorkspaces(root,runner) {
 let sessions;try{sessions=await runner.list();}catch{return;}
 const live=new Set(sessions.map(s=>s.id));const handled=new Set();
 for(const record of workspaceRecords(root)) {
  const path=record.lease?.worktree;if(!path||handled.has(path))continue;handled.add(path);
  let unlock;try{unlock=workspaceLock(root,path);}catch{continue;}
  try {
   const records=workspaceRecords(root);
   // An unreadable owner cannot be proved unrelated. Keep it visible, never erase the fence.
   if(records.some(r=>!r.lease))continue;
   const peers=records.filter(r=>r.lease.worktree===path);
   if(peers.some(r=>r.category!=='workspaces'||r.lease.schema!=='open-autonomy.workspace-lease.v2'||!['released','removing'].includes(r.lease.state)||!r.lease.consumersRetired||live.has(r.lease.sessionId)))continue;
   const effects=join(stateDir(root),'effects'),quarantine=join(stateDir(root),'effect-quarantine');
   let pending=false;
   for(const dir of [effects,quarantine])if(existsSync(dir))for(const name of readdirSync(dir).filter(n=>n.endsWith('.json'))) {
    try {if(JSON.parse(readFileSync(join(dir,name),'utf8')).worktree===path)pending=true;}catch{pending=true;}
   }
   if(pending)continue;
   const first=peers[0]?.lease;if(!first)continue;
   if(!existsSync(path)) {
    const registered=git(root,['worktree','list','--porcelain','-z']).split('\0').includes(`worktree ${path}`);
    if(registered||peers.some(r=>r.lease.state!=='removing'||!r.lease.preservedRef||git(root,['rev-parse','--verify',r.lease.preservedRef])!==r.lease.releasedHead))continue;
   } else {
    const current=identity(root,path);
    if(peers.some(r=>r.lease.gitDir!==current.gitDir||r.lease.branch!==current.branch||r.lease.generation!==token(current.gitDir)||r.lease.releasedHead!==current.head))continue;
    if(git(path,['status','--porcelain']))continue;
    for(const peer of peers) {
     const ref=`refs/oa-workspaces/${peer.lease.id}/${current.head}`;
     git(root,['update-ref',ref,current.head]);
     atomic(peer.file,{...peer.lease,state:'removing',preservedRef:ref});
    }
    git(root,['worktree','remove',path]);
   }
   for(const peer of peers) {
    const removing=JSON.parse(readFileSync(peer.file,'utf8'));
    atomic(join(stateDir(root),'workspace-history',`${peer.lease.id}.json`),{...removing,state:'removed',removedAt:new Date().toISOString()});
    rmSync(peer.file);
   }
   console.log(`[runner] removed released workspace ${path}; branch and commit preserved`);
  }catch(error){console.error(`[runner] retained workspace ${path}: ${error.message}`);}finally{unlock();}
 }
}

export function discardUnlaunchedWorkspace(root,lease,created,createdBranch) {
 const file=leaseFile(root,lease.id);
 const saved=JSON.parse(readFileSync(file,'utf8'));
 if(saved.state!=='launching'||saved.sessionId)throw new Error('Launch may have consumers; retain its lease.');
 if(created) {
  const current=identity(root,saved.worktree);
  if(current.gitDir!==saved.gitDir||current.branch!==saved.branch||token(current.gitDir)!==saved.generation||git(saved.worktree,['status','--porcelain']))throw new Error('Unlaunched workspace changed; retain for recovery.');
  const peers=workspaceRecords(root).filter(r=>!r.lease||r.lease.worktree===saved.worktree);
  if(peers.length!==1)throw new Error('Other ownership fences this workspace.');
  git(root,['update-ref',`refs/oa-workspaces/${saved.id}/${current.head}`,current.head]);
  git(root,['worktree','remove',saved.worktree]);
  if(createdBranch)git(root,['update-ref','-d',`refs/heads/${saved.branch}`,current.head]);
 }
 atomic(join(stateDir(root),'workspace-history',`${saved.id}.json`),{...saved,state:'launch-refused',retiredAt:new Date().toISOString()});
 rmSync(file);
}
