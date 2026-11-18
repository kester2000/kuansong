'use strict';
const fs=require('node:fs'),path=require('node:path');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Only completed on-disk archives are eligible. Do not read dashboard
// artifacts or active sessions here, even when the same group has older games.
function entries(records,directory){
 return records.filter(r=>r&&/^[A-Za-z0-9_-]+$/.test(r.id)&&Number.isFinite(Date.parse(r.endedAt))
  &&fs.existsSync(path.join(directory,r.id+'.html')))
  .sort((a,b)=>Date.parse(b.endedAt)-Date.parse(a.endedAt)||b.id.localeCompare(a.id));
}
function render(records,directory){
 const rows=entries(records,directory);
 const modes={CLASSIC:'经典',TWIST:'幻变',WILD:'狂野',CRAZY:'疯狂',BUTTON:'按钮',TRAP:'陷阱',OPEN:'空旷',SILENT:'无声'};
 const stamp=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>历史对局 · 长夜</title><style>
 :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0c1320;color:#e7eef8;font:16px/1.6 system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:36px 20px 60px}header{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:26px}h1{font-size:28px;margin:0 0 6px}p{margin:0;color:#a9bad0}.refresh{color:#b8d8ff;border:1px solid #35485e;padding:6px 14px;border-radius:8px;text-decoration:none;white-space:nowrap}.games{list-style:none;padding:0;margin:0;display:grid;gap:12px}.game{display:grid;grid-template-columns:1fr auto;gap:5px 18px;padding:20px;background:#19283c;border:1px solid #2b3d54;border-radius:12px;color:inherit;text-decoration:none}.game:hover,.game:focus-visible{border-color:#91bdf5;background:#203149;outline:2px solid #91bdf5;outline-offset:2px}.mode{font-weight:700;font-size:18px}.result{color:#c3dfb5}.stamp{font-size:14px;color:#a9bad0}.open{grid-column:2;grid-row:1 / 3;align-self:center;color:#b8d8ff;white-space:nowrap}.empty{background:#19283c;border-radius:12px;padding:28px}.note{font-size:13px;margin-top:20px}@media(max-width:500px){main{padding:24px 12px}h1{font-size:24px}.game{padding:16px;gap:6px 10px}.stamp{font-size:12px}.mode{font-size:16px}.open{font-size:14px}}
 </style></head><body><main><header><div><h1>历史对局</h1><p>${rows.length} 场已存档对局 · 最新在前</p></div><a class="refresh" href="/history">刷新目录</a></header>
 ${rows.length?'<ol class="games">'+rows.map(r=>'<li><a class="game" href="/report/'+encodeURIComponent(r.id)+'.html"><span class="mode">'+esc(modes[r.mode]||r.mode||'长夜')+' <span class="result">· '+esc(r.result||'已结束')+'</span></span><time class="stamp" datetime="'+esc(r.endedAt)+'">存档于 '+esc(stamp(r.endedAt))+'</time><span class="open">查看复盘 →</span></a></li>').join('')+'</ol>':'<p class="empty">还没有已结束的对局复盘。</p>'}
 <p class="note">时间为北京时间。这里仅收录已结束的对局复盘。</p></main></body></html>`;
}
module.exports={entries,render};
