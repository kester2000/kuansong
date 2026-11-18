'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('archive keeps the referee event time for terminal score broadcasts and refreshes',t=>{
 const priorDataDir=process.env.LN_DATA_DIR,priorPackage=process.env.LGT_GAME_PACKAGE;
 const dataDir=fs.mkdtempSync(path.join(__dirname,'tmp-ended-at-'));
 process.env.LN_DATA_DIR=dataDir;
 process.env.LGT_GAME_PACKAGE=path.resolve(__dirname,'../../long_night_player');
 t.after(()=>{
  if(priorDataDir===undefined)delete process.env.LN_DATA_DIR;else process.env.LN_DATA_DIR=priorDataDir;
  if(priorPackage===undefined)delete process.env.LGT_GAME_PACKAGE;else process.env.LGT_GAME_PACKAGE=priorPackage;
  fs.rmSync(dataDir,{recursive:true,force:true});
 });
 const sessions=path.join(dataDir,'sessions');fs.mkdirSync(sessions,{recursive:true});
 fs.writeFileSync(path.join(sessions,'gtest.json'),JSON.stringify({version:2,base:{config:{mode:'TWIST'}},view:0,messages:[
  {id:'m1',view:0,text:'游戏结束，公布分数：\n@0号：208',source:{key:'group:404556587',time:1794053769}},
 ]}));
 const artifact=require('../framework/artifact.cjs');artifact.save=()=>{};
 const matches=require('../framework/matches.cjs');
 const actualEndedAt=new Date(1794053769*1000).toISOString();
 const id=matches.save('gtest',{endedAt:'2026-11-07T12:16:10.000Z',actualEndedAt,terminalText:'游戏结束，公布分数：'});
 assert.equal(JSON.parse(matches.read(id)).actualEndedAt,actualEndedAt);
 matches.save('gtest',{endedAt:'2026-11-07T12:20:00.000Z',actualEndedAt:'2026-11-07T12:19:59.000Z',terminalText:'later score update',refresh:true});
 assert.equal(JSON.parse(matches.read(id)).actualEndedAt,actualEndedAt);
});
