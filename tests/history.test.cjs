'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {entries,render}=require('../framework/history.cjs');
test('directory contains only completed archives with a report, newest first',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'night-history-'));
 const names=['old','new','active'];for(const name of names)fs.writeFileSync(path.join(dir,name+'.html'),'report');
 t.after(()=>{for(const name of names)fs.unlinkSync(path.join(dir,name+'.html'));fs.rmdirSync(dir);});
 const records=[{id:'old',endedAt:'2026-11-05T01:00:00Z'},{id:'active'},{id:'new',endedAt:'2026-11-05T02:00:00Z'},
  {id:'missing',endedAt:'2026-11-05T03:00:00Z'},{id:'../live',endedAt:'2026-11-05T03:00:00Z'}];
 assert.deepEqual(entries(records,dir).map(r=>r.id),['new','old']);
 const html=render(records,dir);assert(!html.includes('/live'));assert(!html.includes('/report/active'));
 assert(html.indexOf('/report/new.html')<html.indexOf('/report/old.html'));
});
test('empty history is a usable page without live-session links',()=>{
 const html=render([],os.tmpdir());assert(html.includes('还没有已结束的对局复盘'));assert(!html.includes('/live'));
});
