'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const driverHash=file=>crypto.createHash('sha256').update(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n')).digest('hex');
function tree(dir){const out={};function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(e.name==='.git')continue;const f=path.join(p,e.name);if(e.isDirectory())walk(f);else out[path.relative(dir,f).replaceAll('\\','/')]=hash(f);}}walk(dir);return out;}
function record(framework,base=__dirname){
 const info={createdAt:new Date().toISOString(),binary:hash(path.join(base,'native/arena-engine')),driver:driverHash(path.join(base,'native/driver.cc')),driverHashFormat:'UTF-8 with LF newlines (CRLF normalization only)',source:tree(path.join(base,'native/source')),framework:tree(framework),recipe:fs.readFileSync(path.join(base,'build.sh'),'utf8'),scope:'Same game rules; deterministic seed and standalone framework hooks. Generated translation unit omits only batch presentation waiting and retains its RNG draw. Truth export is audit-only.'};
 fs.writeFileSync(path.join(base,'build-info.json'),JSON.stringify(info,null,2)+'\n');return info;
}
function verify(base=__dirname){
 const info=JSON.parse(fs.readFileSync(path.join(base,'build-info.json')));
 for(const [key,file] of [['binary','native/arena-engine'],['driver','native/driver.cc']])if(info[key]!==(key==='driver'?driverHash:hash)(key==='binary'&&process.env.ARENA_NATIVE_ENGINE?process.env.ARENA_NATIVE_ENGINE:path.join(base,file)))throw Error('Referee '+key+' differs from build-info.json; rebuild before self-play');
 return info;
}
if(require.main===module){if(process.argv[2]==='record')console.log(JSON.stringify({binary:record(path.resolve(process.argv[3])).binary}));else console.log(JSON.stringify({binary:verify().binary}));}
module.exports={record,verify};
