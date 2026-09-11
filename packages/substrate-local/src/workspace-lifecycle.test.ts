import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compileLocal } from './emit';
import { prepareWorkspace, bindWorkspace, releaseWorkspace, reconcileReleasedWorkspaces, workspaceRecords, workspaceLock, recoverWorkspaceLock, discardUnlaunchedWorkspace, workspaceEffectReady } from './workspace-lifecycle.mjs';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const git=(root:string,...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const empty={async list(){return [];}};
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'oa-workspace-release-')));roots.push(root);
 git(root,'init','-q','-b','main');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');
 const output=compileLocal({schema:'autonomy.ir.v1',targets:['local'],codeHost:'local-git',agents:{worker:{behavior:'worker',capabilities:['tasks:converse'],triggers:[]}},policy:{box:{}},resources:[]});
 for(const [path,content]of Object.entries(output.generated)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content);}
 writeFileSync(join(root,'.gitignore'),'.worktrees/\n.open-autonomy/runner-state/\n');
 git(root,'add','.');git(root,'commit','-qm','base');
 const path=join(root,'.worktrees','task');
 const intent=prepareWorkspace(root,path,'worker','task');git(root,'worktree','add','-b','task',path,'main');
 const lease=bindWorkspace(root,intent,'session');
 return{root,path,lease,head:git(path,'rev-parse','HEAD')};
}
test('missing provider entry never releases a workspace; compiled CLI release preserves unpushed commits',async()=>{
 const{root,path,lease}=fixture();writeFileSync(join(path,'work'),'unpublished');git(path,'add','work');git(path,'commit','-qm','work');const head=git(path,'rev-parse','HEAD');
 await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);
 const release=spawnSync('bun',['scripts/runner.ts','workspace-release',lease.id,'--head',head,'--consumers-retired'],{cwd:root,encoding:'utf8'});expect(release.status,release.stderr).toBe(0);
 // Execute the emitted helper under Node, as the emitted scheduler does.
 const code="import {reconcileReleasedWorkspaces} from './scripts/workspace-lifecycle.mjs'; await reconcileReleasedWorkspaces(process.cwd(),{async list(){return []}});";
 const result=spawnSync('node',['--input-type=module','-e',code],{cwd:root,encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
 expect(existsSync(path)).toBe(false);expect(git(root,'rev-parse','task')).toBe(head);
 const receipt=JSON.parse(readFileSync(join(root,'.open-autonomy','runner-state','workspace-history',`${lease.id}.json`),'utf8'));
 expect(git(root,'rev-parse',receipt.preservedRef)).toBe(head);
});
test('all peers, provider consumers and pending effects fence released work',async()=>{
 const{root,path,lease,head}=fixture();const peer=bindWorkspace(root,prepareWorkspace(root,path,'reviewer','task'),'review-session');
 releaseWorkspace(root,lease.id,head,true);await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);
 releaseWorkspace(root,peer.id,head,true);await reconcileReleasedWorkspaces(root,{async list(){return[{id:'review-session'}];}});expect(existsSync(path)).toBe(true);
 const effects=join(root,'.open-autonomy','runner-state','effects');mkdirSync(effects);writeFileSync(join(effects,'effect.json'),JSON.stringify({worktree:path}));await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);
 rmSync(effects,{recursive:true});await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(false);
});
test('dirty state, missing consumer release and moved HEAD retain the checkout',async()=>{
 const{root,path,lease,head}=fixture();expect(()=>releaseWorkspace(root,lease.id,head,false)).toThrow();
 writeFileSync(join(path,'work'),'keep');expect(()=>releaseWorkspace(root,lease.id,head,true)).toThrow();rmSync(join(path,'work'));
 releaseWorkspace(root,lease.id,head,true);writeFileSync(join(path,'work'),'new commit');git(path,'add','work');git(path,'commit','-qm','new');await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);
 releaseWorkspace(root,lease.id,git(path,'rev-parse','HEAD'),true);await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(false);
});
test('a replacement checkout cannot be bound or removed using its predecessor lease',async()=>{
 const{root,path,lease,head}=fixture();releaseWorkspace(root,lease.id,head,true);git(root,'worktree','remove',path);git(root,'worktree','add',path,'task');
 expect(()=>bindWorkspace(root,lease,'late-session')).toThrow();await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);
});
test('malformed, legacy and quarantined owners remain cleanup fences',async()=>{
 const{root,path,lease,head}=fixture();releaseWorkspace(root,lease.id,head,true);const dir=join(root,'.open-autonomy','runner-state','workspaces');
 writeFileSync(join(dir,'unknown.json'),'{}');await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);expect(workspaceRecords(root).some(r=>r.lease===null)).toBe(true);rmSync(join(dir,'unknown.json'));
 const q=join(root,'.open-autonomy','runner-state','workspace-quarantine');mkdirSync(q);writeFileSync(join(q,'old.json'),JSON.stringify({...lease,schema:'open-autonomy.workspace-lease.v1'}));await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);
});
test('creation and unknown launch intents retain ownership without a session ID',async()=>{
 const{root,path}=fixture();const intent=prepareWorkspace(root,path,'reviewer','task');expect(workspaceRecords(root).some(r=>r.lease?.id===intent.id)).toBe(true);
 bindWorkspace(root,intent,'');await reconcileReleasedWorkspaces(root,empty);expect(existsSync(path)).toBe(true);expect(()=>releaseWorkspace(root,intent.id,git(path,'rev-parse','HEAD'),true)).toThrow();
});
test('refused launch preserves its exact commit and removes only its own newly created branch',()=>{
 const{root}=fixture();const path=join(root,'.worktrees','refused');const intent=prepareWorkspace(root,path,'worker','refused');git(root,'worktree','add','-b','refused',path,'main');const lease=bindWorkspace(root,intent,'');const head=git(path,'rev-parse','HEAD');
 discardUnlaunchedWorkspace(root,lease,true,true);expect(existsSync(path)).toBe(false);expect(()=>git(root,'rev-parse','--verify','refs/heads/refused')).toThrow();expect(git(root,'rev-parse',`refs/oa-workspaces/${lease.id}/${head}`)).toBe(head);
});
test('live lock cannot be recovered and a crashed owner has an explicit recovery receipt',()=>{
 const{root,path}=fixture();const unlock=workspaceLock(root,path);const locks=join(root,'.git','oa-workspace-locks');const lock=join(locks,readdirSync(locks)[0]!);const owner=JSON.parse(readFileSync(join(lock,'owner.json'),'utf8'));
 expect(()=>recoverWorkspaceLock(root,path,owner.nonce)).toThrow('still alive');unlock();
 const source=new URL('./workspace-lifecycle.mjs',import.meta.url).href;
 const child=spawnSync('node',['--input-type=module','-e',`import {workspaceLock} from ${JSON.stringify(source)};workspaceLock(process.argv[1],process.argv[2]);`,root,path],{encoding:'utf8'});expect(child.status,child.stderr).toBe(0);
 const retired=JSON.parse(readFileSync(join(lock,'owner.json'),'utf8'));recoverWorkspaceLock(root,path,retired.nonce);const release=workspaceLock(root,path);release();
});

test('effects require matching released generation, no live peer and no unknown ownership',()=>{
 const{root,path,lease,head}=fixture();expect(workspaceEffectReady(root,path,new Set())).toBe(false);
 releaseWorkspace(root,lease.id,head,true);expect(workspaceEffectReady(root,path,new Set())).toBe(true);expect(workspaceEffectReady(root,path,new Set(['session']))).toBe(false);
 git(root,'worktree','remove',path);git(root,'worktree','add',path,'task');expect(workspaceEffectReady(root,path,new Set())).toBe(false);
});
test('lock recovery preserves a live owner across timezones and a replacement acquired during recovery',()=>{
 const{root,path}=fixture();let unlock=workspaceLock(root,path);const locks=join(root,'.git','oa-workspace-locks'),lock=join(locks,readdirSync(locks)[0]!);
 const source=new URL('./workspace-lifecycle.mjs',import.meta.url).href,owner=JSON.parse(readFileSync(join(lock,'owner.json'),'utf8'));
 const result=spawnSync('node',['--input-type=module','-e',`import {recoverWorkspaceLock} from ${JSON.stringify(source)};recoverWorkspaceLock(process.argv[1],process.argv[2],process.argv[3]);`,root,path,owner.nonce],{encoding:'utf8',env:{...process.env,TZ:'Asia/Tokyo',LC_ALL:'C'}});
 expect(result.status).not.toBe(0);expect(result.stderr).toContain('still alive');unlock();
 const child=spawnSync('node',['--input-type=module','-e',`import {workspaceLock} from ${JSON.stringify(source)};workspaceLock(process.argv[1],process.argv[2]);`,root,path],{encoding:'utf8'});expect(child.status).toBe(0);
 const retired=JSON.parse(readFileSync(join(lock,'owner.json'),'utf8')),original=fs.mkdirSync;
 const spy=spyOn(fs,'mkdirSync').mockImplementation(((target:fs.PathLike,options?:fs.MakeDirectoryOptions)=>{
  if(String(target)===join(lock,'recovery')){rmSync(lock,{recursive:true});unlock=workspaceLock(root,path);}
  return original(target,options);
 }) as typeof fs.mkdirSync);
 try{expect(()=>recoverWorkspaceLock(root,path,retired.nonce)).toThrow('replaced');}finally{spy.mockRestore();}
 const replacement=JSON.parse(readFileSync(join(lock,'owner.json'),'utf8'));expect(replacement.pid).toBe(process.pid);expect(replacement.nonce).not.toBe(retired.nonce);unlock();
});
