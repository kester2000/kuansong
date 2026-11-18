#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
require('./build-info.cjs').verify();
const args=process.argv.slice(2),flags={};while(args.length){const k=args.shift();if(!k.startsWith('--'))throw Error('invalid option '+k);flags[k.slice(2)]=args.shift();}
const number=(k,d,min,max)=>{const v=Number(flags[k]??d);if(!Number.isInteger(v)||v<min||v>max)throw Error(k+' out of range');return v;};
const games=number('games',20,1,100000),workers=number('workers',2,1,4),budgetMs=number('budget-ms',40,5,6000),seed=number('seed',710001,1,2147000000),gameMs=number('game-ms',180000,1000,600000);
const scenario={mode:flags.mode||'TWIST',players:number('players',2,2,8),size:number('size',9,9,12),rounds:number('rounds',20,3,40),silent:flags.silent==='true',event:flags.event||'NONE',target:flags.target||'PREVIOUS',expandedPool:flags.expanded==='true',portalChaos:flags['portal-chaos']==='true',dark:flags.dark==='true',brawl:flags.brawl==='true',pointCapture:flags['point-capture']!=='false',deliberate:flags.deliberate==='true',bombs:number('bombs',0,0,3),boss:flags.boss?flags.boss.split(','):[],hidden:flags.hidden||'关闭',stopInfo:flags['stop-info']||'无'};
require('./game.cjs').validateScenario(scenario);
const out=path.resolve(flags.out||path.join(__dirname,'../../../private/data/arena-runs',new Date().toISOString().replace(/[:.]/g,'-')));
if(fs.existsSync(out))throw Error('Use a new output directory to keep versions and seeds separate');
fs.mkdirSync(path.join(out,'games'),{recursive:true});
const snapshot=path.join(out,'snapshot'),root=path.resolve(__dirname,'..');fs.mkdirSync(snapshot);
for(const part of ['night-strategist','vendor','runtime','host.cjs','index.cjs'])fs.cpSync(path.join(root,part),path.join(snapshot,part),{recursive:true});
fs.cpSync(__dirname,path.join(snapshot,'fast-arena'),{recursive:true,filter:p=>!p.includes(path.sep+'runs')&&!p.includes(path.sep+'source')});
const hashes={};function hashFiles(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())hashFiles(p);else hashes[path.relative(snapshot,p)]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}hashFiles(snapshot);
const manifest={startedAt:new Date().toISOString(),revision:process.env.ARENA_REVISION||null,games,workers,budgetMs,gameMs,seed,scenario,policy:require('../night-strategist/suggest.cjs').VERSION,source:JSON.parse(fs.readFileSync(path.join(__dirname,'provenance.json'))),hashes,note:'Self-play is not a measurement of live win rate. Budget is per decision, see budgetMs. No forced stop fallback; unfinished games excluded from score averages.'};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
let next=0,finished=0,aborted=false;const results=[],pool=[],active=new Map(),start=Date.now();
function write(){
 const complete=results.filter(r=>r.complete),elapsed=(Date.now()-start)/1000;
 const report={status:finished===games?(results.some(r=>r.failed)?'failed':'complete'):'running',policy:manifest.policy,scenario,budgetMs,requested:games,finished,timeouts:results.reduce((n,r)=>n+(r.timeouts||0),0),retries:results.reduce((n,r)=>n+(r.retries||0),0),completed:complete.length,truncated:results.filter(r=>r.truncated).length,failed:results.filter(r=>r.failed).length,elapsedSeconds:elapsed,gamesPerHour:elapsed?finished*3600/elapsed:0,completedPerHour:elapsed?complete.length*3600/elapsed:0,meanScores:Array.from({length:scenario.players},(_,i)=>complete.length?complete.reduce((n,r)=>n+r.scores[i],0)/complete.length:null),active:[...active.values()],results};
 report.cleanCompleted=complete.filter(r=>!r.timeouts).length;
 report.policyTimeoutGames=results.filter(r=>r.timeouts>0).length;
 report.failureReasons=results.filter(r=>!r.complete).reduce((counts,r)=>{const reason=r.reason||r.error||'unknown';counts[reason]=(counts[reason]||0)+1;return counts;},{});
 fs.writeFileSync(path.join(out,'report.json.tmp'),JSON.stringify(report,null,2));fs.renameSync(path.join(out,'report.json.tmp'),path.join(out,'report.json'));
 fs.writeFileSync(path.join(out,'report.html'),`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>长夜模拟</title><style>body{font:16px system-ui;background:#101b29;color:#e3edfa;padding:24px}pre{white-space:pre-wrap}</style><h1>长夜快速自对战</h1><p>完成 ${finished}/${games} · 正常结算 ${complete.length} · 截断 ${report.truncated} · 失败 ${report.failed}</p><p>有效吞吐 ${report.completedPerHour.toFixed(1)} 局/小时 · 推理预算 ${budgetMs}ms · 并发 ${workers}</p><p>当前策略自对战；缩短推理预算不等同于线上完整预算。截断和失败不计入均分。</p><pre>${JSON.stringify({...report,results:results.slice(-20)},null,2).replaceAll('&','&amp;').replaceAll('<','&lt;')}</pre>`);
}
function dispatch(child){if(next>=games){child.disconnect();return;}const id=next++,job={id,seed:seed+id,scenario,budgetMs,maxActions:600,maxTurnSteps:80,out};active.set(child.pid,{id,seed:job.seed});child.gameTimedOut=false;write();child.send(job);child.deadline=setTimeout(()=>{child.gameTimedOut=true;child.kill();},gameMs);}
function spawn(i){
 const child=cp.fork(path.join(snapshot,'fast-arena/worker.cjs'),[],{env:{...process.env,LN_DATA_DIR:path.join(out,'worker-'+i)},stdio:['ignore','inherit','inherit','ipc']});pool.push(child);
 child.on('message',m=>{if(m.type==='progress'){active.set(child.pid,{...active.get(child.pid),round:m.round,step:m.step});write();return;}if(m.type!=='done')return;clearTimeout(child.deadline);active.delete(child.pid);results.push(m.summary);finished++;console.log(JSON.stringify(m.summary));write();dispatch(child);});
 child.on('exit',(code,signal)=>{clearTimeout(child.deadline);if(active.has(child.pid)){const job=active.get(child.pid);active.delete(child.pid);aborted=true;results.push({...job,failed:true,reason:child.gameTimedOut?'game-wall-time-cap':'worker-exit',exitCode:code,signal});finished++;write();console.error('Worker failed; saved failure and continuing with a fresh worker');aborted=false;if(next<games)spawn(i);else write();}});
 dispatch(child);
}

for(let i=0;i<Math.min(workers,games);i++)spawn(i);
