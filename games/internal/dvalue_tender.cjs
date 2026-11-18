'use strict';
const {integers,equilibrium,weighted,clamp}=require('./math.cjs'),{command,addHistory}=require('./observation.cjs');
const opt=(s,key,fallback)=>Number(s.options[key]??fallback);
function init(s){s.coins=Array(2).fill(opt(s,'金币',30));s.wins=[0,0];return s;}
function observe(s,o){const rows=[...o.text.matchAll(/(\d+)\s*\|\s*(\d+)\s+(\d+)\s*[=<>]\s*(\d+)\s+(\d+)\s*\|\s*(\d+)/g)];rows.forEach((m,i)=>addHistory(s,i+1,[+m[3],+m[4]]));const r=rows.at(-1);if(r){s.wins=[+r[1],+r[6]];s.coins=[+r[2],+r[5]];s.completed=rows.length;}}
function terminal(round,wins,rounds){const need=Math.floor(rounds/2)+1;if(round===rounds)return wins[0]===wins[1]?null:Math.sign(wins[0]-wins[1]);if(round===rounds+3)return Math.sign(wins[0]-wins[1]);if((round<rounds&&Math.max(...wins)>=need)||(round>rounds&&Math.max(...wins)>=need+1))return Math.sign(wins[0]-wins[1]);return null;}
function evaluate(coins,wins,round,rounds){const end=terminal(round,wins,rounds);if(end!=null)return end;const left=(round<rounds?rounds:rounds+3)-round,lead=wins[0]-wins[1];if(lead>left)return 1;if(-lead>left)return-1;const advantage=(coins[0]-coins[1])/(coins[0]+coins[1]+4);return Math.tanh((lead+left*advantage*.85)/(Math.sqrt(left)+.5))*.97;}
function decide(s,random=Math.random){const me=s.self,other=1-me,round=s.roundsPlayed??s.completed??0,rounds=opt(s,'回合数',9),coins=[s.coins[me],s.coins[other]],wins=[s.wins[me],s.wins[other]];if(coins.some(x=>!Number.isFinite(x)||x<0))return null;
 const ours=integers(coins[0],32,[coins[1]+1,Math.ceil(coins[0]/Math.max(1,rounds-round))]),theirs=integers(coins[1],32,[coins[0]+1]);
 const matrix=ours.map(a=>theirs.map(b=>{const c=[...coins],w=[...wins];if(a>b){c[0]-=a-b;w[0]++;}if(b>a){c[1]-=b-a;w[1]++;}return evaluate(c,w,round+1,rounds);}));
 const result=equilibrium(matrix,1600),p=result.p;
 const amount=weighted(ours,p,random);return command(amount,'private','剩余预算与胜场的混合策略，避免固定出价被针对');}
function validate(s,a){return a.channel==='private'&&/^\d+$/.test(a.text)&&+a.text>=0&&+a.text<=s.coins[s.self];}
module.exports={id:'dvalue_tender',name:'差值投标',init,observe,decide,validate,terminal,evaluate};
