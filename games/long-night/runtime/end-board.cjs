'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {candidatePanels}=require('./candidate-panels.cjs');
function snapshotHtml(data,casePanels){
 data=structuredClone(data);if(data.report)data.report.historyMaps=require('./history-maps.cjs').historyMaps(data);
 if(data.candidateKey&&data.report){
  const cases=candidatePanels(data.report,data.command,{includeProjection:true});
  if(cases.length>1)data.report.candidateCases=cases;
 }
 const source=fs.readFileSync(path.join(__dirname,'dashboard.html'),'utf8');
 const script=source.split('<script>')[1].split('async function tick()')[0];
 const context={structuredClone,document:{getElementById:()=>null},data:structuredClone(data),casePanels};
 vm.createContext(context);vm.runInContext(script+(casePanels?` ;count=casePanels.length;output='<div class="maps">'+casePanels.map(p=>'<section><h2>假设 '+p.number+' · '+esc(p.result)+'</h2>'+mapSvg(p.cells,p.n,null,false,'',p.alignment,p.markers,p.births)+'</section>').join('')+'</div>';`:';output=playerPanel(data);count=mapGroups(selectedMaps(data)).length;'),context,{timeout:3000});
 if(!context.count)throw Error('没有可发送的看板地图');
 const css=pathToFileURL(path.join(__dirname,'map-assets/tools-map.css')).href;
 const head=source.slice(source.indexOf('<head>')+6,source.indexOf('</head>')).replace('href="/map-assets/tools-map.css"','href="'+css+'"');
 const legend=casePanels?'<p>●＝双方当前位置　➜＝本步预计落脚　★＝计划目标</p>':data.reviewMarks?.length?'<p>箭头＝本次指令　★＝行动目标　◇＝对手可能位置　▧＝反馈更新的区块</p>':'';
 return {html:'<!doctype html><html><head>'+head+'<style>.review-mark{position:absolute;left:1px;top:1px;z-index:10;background:#172338;color:#ffe681;padding:0 2px;border-radius:2px;font:bold 16px/1.1 sans-serif}</style></head><body><header><h1>'+(casePanels?'对手位置逐案推演':'行动前的推断地图')+'</h1>'+legend+'</header><main>'+context.output+'</main></body></html>',height:Math.max(900,Math.ceil(context.count/2)*780+120)};
}
module.exports={snapshotHtml};

