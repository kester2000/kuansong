'use strict';
function decode(t){return String(t).replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(_,h,d)=>String.fromCodePoint(parseInt(h||d,h?16:10))).replace(/&(?:nbsp|emsp|ensp);/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');}
function plain(html){return decode(String(html).replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(?:tr|p|h\d|table)>/gi,'\n').replace(/<\/t[dh]>/gi,'\t').replace(/<[^>]*>/g,'')).replace(/\r/g,'');}
function htmlRows(html){return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match=>[...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell=>plain(cell[1]).replace(/\s+/g,' ').trim())).filter(r=>r.length);}
function num(text){const m=String(text??'').replace(/[−—]/g,'-').match(/[-+]?\d+(?:\.\d+)?/);return m?Number(m[0]):null;}
function row(observation,label){return observation.rows?.find(r=>label.test(r[0]||''))||null;}
function latestRoundRow(observation){return observation.rows?.filter(r=>/^R\s*\d+$/i.test(r[0]?.trim())).at(-1)||null;}
function options(text){const values={};let key;for(const line of String(text).split(/\r?\n/)){const format=line.match(/^\s*(?:-\s*)?格式[：:]\s*(\S+)/);if(format){key=format[1];continue;}const current=line.match(/^\s*(?:-\s*)?当前[：:](.*)$/);if(key&&current){if(Object.hasOwn(values,key))throw Error('Duplicate room option '+key);values[key]=current[1].trim();key=null;}}return values;}
function fromNative(message){let text='',html='',mentions=[];for(const s of message.segments||[]){if(s.type==='text')text+=s.text;if(s.type==='at'){text+=`[${s.player}号：@PLAYER_${s.player}]`;mentions.push(s.player);}if(s.type==='html')html+='\n'+s.text;}return {text:text+'\n'+plain(html),html,rows:htmlRows(html),mentions,private:message.to>=0};}
function newModel({players,self,options:config={},seed=1}){return {players,self,options:config,seed,round:1,phase:'',history:Array.from({length:players},()=>[]),active:Array(players).fill(true),scores:Array(players).fill(0),hp:null,ownActions:[],seen:[],actionSerial:0};}
function observePhase(model,text){const phase=text.match(/【当前阶段】\s*([^\n]+)/)?.[1];if(phase)model.phase=phase.replace(/（剩余时间[^）]*）/g,'').trim();const match=model.phase.match(/第\s*(\d+)\s*(?:\/\s*\d+\s*)?(?:回合|轮|局)/);if(match)model.round=Number(match[1]);}
function addHistory(model,round,choices){if(!Number.isInteger(round)||round<1||choices.length!==model.players)return false;model.roundHistory||={};if(model.roundHistory[round])return false;model.roundHistory[round]=choices;choices.forEach((a,i)=>{if(a!=null)model.history[i].push(a);});return true;}
function numberedValues(r,n,offset=1){if(!r||r.length<n+offset)return null;return r.slice(offset,offset+n).map(num);}
function acceptNumericRow(model,o,label,field){const values=numberedValues(row(o,label),model.players);if(values?.every(v=>v!=null)){model[field]=values;return true;}return false;}
function command(text,channel='private',why=''){return {text:String(text),channel,why};}
module.exports={decode,plain,htmlRows,num,row,latestRoundRow,options,fromNative,newModel,observePhase,addHistory,numberedValues,acceptNumericRow,command};
