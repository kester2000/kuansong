'use strict';
// This supervisor never connects to QQ or edits/promotes a policy.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {review}=require('./auto-review.cjs');
const DEFAULT_ROOT=path.resolve(__dirname,'../../../private/data/arena-runs/continuous');
// 90% ordinary two-player TWIST batches, 5% silent TWIST, 5% rotating
// secondary features/modes. Full-budget batches remain within the main mode.
const PLAN=Array.from({length:20},(_,i)=>i===9?{mode:'TWIST',silent:true}:
 [3,8,13,18].includes(i)?{mode:'TWIST',budgetMs:6000,games:1}:{mode:'TWIST'});
const SECONDARY=[{mode:'TWIST',deliberate:true},{mode:'CLASSIC'},{mode:'SILENT'},{mode:'TWIST',players:3}];
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function save(file,data){fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2)+'\n');fs.renameSync(file+'.tmp',file);}
function scenario(sequence){return {players:2,budgetMs:500,games:2,...PLAN[sequence%PLAN.length],
 ...(sequence%PLAN.length===19?SECONDARY[Math.floor(sequence/PLAN.length)%SECONDARY.length]:{})};}
function pending(root,items){return items.filter(b=>!require('./coarse-review.cjs').done(read(path.join(root,'reviews',b.id+'.json'),{})?.status));}
function evidenceLimitGiB(value){const n=Number(value);return Number.isFinite(n)&&n>=1&&n<=64?n:16;}
function gate({availableBytes,pendingCount,errorStreak,usedBytes,maxEvidenceGiB=16}){
 if(availableBytes<5*1024**3)return 'disk-free-below-5GiB';
 const limit=evidenceLimitGiB(maxEvidenceGiB);if(usedBytes>=limit*1024**3)return 'evidence-at-'+limit+'GiB';
 // Review throughput must not throttle game generation. Keep every pending
 // game and stop only for actual storage or infrastructure constraints.
 if(errorStreak>=3)return 'three-consecutive-infrastructure-errors';
 return null;
}
function loadIndex(root){const f=path.join(root,'batches.jsonl');return fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
function record(root,item){fs.appendFileSync(path.join(root,'batches.jsonl'),JSON.stringify(item)+'\n');}
function seal(root,item,exitCode,reason=null){
 const report=read(path.join(item.dir,'report.json'),null);
 let screening=null,error=null;
 try{if(report){screening=review(item.dir);require('./coarse-review.cjs').record(root,item);require('./case-review.cjs').record(root,item);}}catch(e){error=e.message;}
 return {...item,endedAt:new Date().toISOString(),exitCode,
  status:reason?'interrupted':exitCode!==0||!report||report.status==='running'?'failed':'finished',
  reason,reportStatus:report?.status??'missing',completed:report?.completed??0,
  cleanCompleted:report?.cleanCompleted??0,failed:report?.failed??0,truncated:report?.truncated??0,
  timeouts:report?.timeouts??0,findings:screening?.findings?.length??null,screeningError:error,
  reviewStatus:'pending',deploymentStatus:'not-applicable'};
}
function snapshot(repo,root,revision){
 const dest=path.join(root,'versions',revision),marker=path.join(dest,'.ready');
 if(fs.existsSync(marker))return dest;
 fs.mkdirSync(dest,{recursive:true});
 const subtree=cp.execFileSync('git',['-C',repo,'rev-parse','--show-prefix'],{encoding:'utf8'}).trim();
 const tree=subtree?revision+':'+subtree.replace(/\/$/,''):revision;
 const gitRoot=cp.execFileSync('git',['-C',repo,'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
 const archive=cp.execFileSync('git',['-C',gitRoot,'archive',tree,'night-strategist','vendor','runtime','fast-arena','host.cjs','index.cjs'],{maxBuffer:128*1024**2});
 cp.execFileSync('tar',['-x','-C',dest],{input:archive});
 fs.writeFileSync(marker,revision+'\n');return dest;
}
function acquire(root){
 const lock=path.join(root,'supervisor.lock');
 try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  const old=read(lock,{});if(!Number.isInteger(old.pid)||old.pid<=0)throw Error('invalid lock; inspect before removal');
  try{process.kill(old.pid,0);throw Error('supervisor already running: '+old.pid);}catch(err){if(err.code!=='ESRCH')throw err;}
  fs.unlinkSync(lock);fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
 }
 return ()=>fs.unlinkSync(lock);
}
async function run({root=process.env.ARENA_CONTINUOUS_ROOT||DEFAULT_ROOT,repo=path.resolve(__dirname,'..'),once=false}={}){
 fs.mkdirSync(root,{recursive:true});for(const d of ['runs','versions','reviews'])fs.mkdirSync(path.join(root,d),{recursive:true});
 const unlock=acquire(root),stateFile=path.join(root,'state.json');
 const state=read(stateFile,{sequence:0,startedAt:new Date().toISOString(),errorStreak:0});
 let stopping=false,child=null,wake=null;
 const signal=()=>{stopping=true;child?.kill('SIGTERM');wake?.();};
 process.on('SIGTERM',signal);process.on('SIGINT',signal);
 const publish=()=>save(path.join(root,'status.json'),{...state,pid:process.pid,heartbeatAt:new Date().toISOString()});
 const wait=ms=>new Promise(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},ms);wake=()=>{clearTimeout(timer);wake=null;resolve();};});
 const pulse=setInterval(publish,10000);
 try{
  if(state.active){
   // A killed process never counts as a successful game. Existing checkpoints survive.
   if(!loadIndex(root).some(b=>b.id===state.active.id))record(root,seal(root,state.active,null,'supervisor-restarted'));
   state.active=null;save(stateFile,state);
  }
  while(!stopping){
   const items=loadIndex(root),disk=fs.statfsSync(root),usedBytes=Number(cp.execFileSync('du',['-sb',root],{encoding:'utf8'}).split(/\s/)[0]);
   const maxEvidenceGiB=evidenceLimitGiB(process.env.ARENA_EVIDENCE_LIMIT_GIB);
   const pause=gate({availableBytes:disk.bavail*disk.bsize,pendingCount:pending(root,items).length,errorStreak:state.errorStreak,usedBytes,maxEvidenceGiB});
   // A reviewed incident can explicitly acknowledge/release an infrastructure circuit breaker.
   const ack=read(path.join(root,'operator.json'),{});
   if(state.errorStreak>=3&&ack.resumeAfter===state.lastBatch){state.errorStreak=0;save(stateFile,state);}
   const dirty=cp.execFileSync('git',['-C',repo,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();
   state.status=pause||dirty?'paused':'preparing';state.pauseReason=pause||(dirty?'tracked-source-not-committed':null);
   state.pendingBatches=pending(root,items).length;state.usedBytes=usedBytes;state.maxEvidenceGiB=maxEvidenceGiB;publish();
   if(pause||dirty){if(once)return;await wait(60000);continue;}
   const revision=cp.execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
   const version=snapshot(repo,root,revision),seq=state.sequence++,s=scenario(seq);
   const id='batch-'+String(seq).padStart(7,'0'),dir=path.join(root,'runs',id);
   const seed=500000000+seq*10;if(seed>800000000)throw Error('discovery seed range exhausted');
   const item={id,sequence:seq,dir,revision,seed,split:'discovery',scenario:s,startedAt:new Date().toISOString()};
   state.active=item;state.status='running';state.pauseReason=null;save(stateFile,state);publish();
   const fd=fs.openSync(path.join(root,'runs',id+'.log'),'w');
   const argv=[path.join(version,'fast-arena/run.cjs'),'--out',dir,'--mode',s.mode,'--players',String(s.players),'--games',String(s.games),'--workers','1','--rounds','20','--budget-ms',String(s.budgetMs),'--game-ms',s.budgetMs===6000?'600000':'300000','--seed',String(seed),'--silent',String(!!s.silent),'--deliberate',String(!!s.deliberate)];
   let code;
   try{code=await new Promise((resolve,reject)=>{child=cp.spawn(process.execPath,argv,{stdio:['ignore',fd,fd],env:{...process.env,ARENA_REVISION:revision}});child.once('error',reject);child.once('exit',resolve);});}
   finally{fs.closeSync(fd);child=null;}
   const done=seal(root,item,code,stopping?'service-stopped':null);record(root,done);
   state.errorStreak=done.status==='failed'||done.status==='interrupted'||done.failed>0||done.screeningError?state.errorStreak+1:0;
   state.lastBatch=id;state.active=null;state.status=stopping?'stopped':'between-batches';save(stateFile,state);publish();
   console.log(JSON.stringify(done));if(once)break;await wait(15000);
  }
 }finally{clearInterval(pulse);process.off('SIGTERM',signal);process.off('SIGINT',signal);unlock();}
}
if(require.main===module)run({once:process.argv.includes('--once')}).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={PLAN,scenario,gate,read,save,pending,loadIndex,seal,acquire,run,DEFAULT_ROOT,evidenceLimitGiB};
