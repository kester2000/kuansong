'use strict';
const {E,A}=require('./kernel.cjs'),{compare}=require('./level-score.cjs');
// Conservative ordinary-game envelope. No terminal map or private enemy data.
// Includes coin transfer and prior escapes as conservative score intervals;
// unsupported inputs are
// explicitly reported instead of silently inventing a score or probability.
function assess(input,target,escape,capture){
 const fail=reason=>({available:false,reason});
 if(!escape?.confirmed||!capture?.confirmed)return fail('两条路线尚未同时证实');
 const {built}=input,self=built.self,config=built.views[self].model.config,status=A.status(built),rules=config.roomRules||{};
 if(status.filter(p=>p.alive).length!==2||!status[target?.target]?.alive)return fail('不是最后两名存活者的终局选择');
 if(config.event!=='NONE'||config.brawl||rules.大乱斗==='开启'||rules.BOSS&&rules.BOSS!=='无'||Number(rules.炸弹)>0)return fail('特殊规则终局尚未建模');
 if(status.some(p=>!p.alive&&!/^被\d+号捕捉$/.test(p.reason)&&!/逃生/.test(p.reason)))return fail('存在其他退场，需补充计分事件');
 const base=status.map(()=>0);
 for(const p of status)if(!p.alive&&/^被\d+号捕捉$/.test(p.reason)){const catcher=Number(p.reason.match(/^被(\d+)号捕捉$/)[1]);if(!status[catcher])return fail('捕捉记录不全');base[catcher]+=100;base[p.id]-=100;}
 // At most floor(n/3)^2 blocks, each +2 plus first-visit +3, and
 // at most 38 exploration points. The envelopes include route exploration.
 const bonus=5*Math.floor(config.size/3)**2+38;
 const maxCoins=Math.floor(config.size/3)**2*Math.max(0,...E.pool(config).map(b=>b.cells.filter(c=>c.attach==='COIN').length));
 const exited=status.filter(p=>!p.alive&&/逃生/.test(p.reason)).length;
 const envelope=base.map((s,i)=>{const p=status[i],escaped=!p.alive&&/逃生/.test(p.reason);
  return [s+(escaped?150:0),s+bonus+(escaped?Math.min(250,100+50*exited):0)+(p.alive||escaped?30*maxCoins:0)];});
 const e=envelope.map(s=>[...s]),c=envelope.map(s=>[...s]);
 e[self]=e[self].map(s=>s+Math.min(250,150+50*exited));c[self]=c[self].map(s=>s+100);
 // Capture transfers all held coins, so the victim retains none. The
 // captor's upper bound already permits every coin on the physical board.
 c[target.target]=[base[target.target]-100,base[target.target]-100+bonus];
 return {available:true,...compare(e,c,self),scores:{escape:e,capture:c},method:'全体原参赛者最终名次区间；不将候选频次当概率',absoluteDelta:null,
  reason:'同一局两方案的等级分期望项和倍率相同，比较名次即可；缺少历史等级分和计分场次，不虚报绝对增量'};
}
module.exports={assess};
