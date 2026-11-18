'use strict';
/**
 * Read-only game dashboard. It never starts an inference and never sends a
 * message: everything shown comes from the artifacts part1 writes while it
 * collects a game (data/dash/<session>.json) and from the journal on disk.
 *
 *   GET /health                    liveness counters
 *   GET /api/state                 sessions + stats (what the page draws)
 *   GET /api/session?session=g…    one session artifact
 *   GET /api/save?session=g…       the journal as a downloadable save file
 *   GET /api/image?file=…          a picture from data/images
 *   GET /                          the page
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const store = require('./storage.cjs');
const artifact = require('./artifact.cjs');
const BLOCKS = require('./game.cjs').module('vendor/long-night/blocks.js');

const NAMES = new Map(BLOCKS.blocks.map((block) => [block.id, block.name]));

function nameOf(id) {
  return NAMES.get(String(id)) || '';
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const decisionFormat = require('./game.cjs').module('runtime/decision-format.cjs');
const { candidatePanels } = require('./game.cjs').module('runtime/candidate-panels.cjs');
const PAGE = fs.readFileSync(path.join(require('./game.cjs').assets, 'dashboard.html'), 'utf8').replace('</head>','<style>'+decisionFormat.css+'</style></head>');
const matches = require('./matches.cjs');
const strategyVersion = require('./game.cjs').module('night-strategist/suggest.cjs').VERSION;

function createDashboard({ bot, state, config, logger = console.log, status = () => ({}) }) {
  const startedAt = Date.now();

  function enrich(session) {
    const data = artifact.load(session);
    if (!data) return null;
    const group = state.data?.groups?.[session.replace(/^g/, '')];
    const self = group?.self == null ? null : Number(group.self);
    const pool = data.pool ? { ...data.pool, blocks: (data.pool.ids || []).map((id) => ({ id, name: nameOf(id), cells: BLOCKS.blocks.find(b => b.id === String(id))?.cells || [] })) } : null;
    const report = data.report ? {
      ...data.report,
      historyMaps: require('./history-maps.cjs').historyMaps(data),
      players: (data.report.players || []).map(p => ({...p, slots:(p.slots||[]).map(slot=>({...slot,blocks:(slot.ids||[]).map(id=>({id,name:nameOf(id),cells:BLOCKS.blocks.find(b=>b.id===String(id))?.cells||[]}))}))})),
      slots: (data.report.slots || []).map((slot) => ({ ...slot, blocks: (slot.ids || []).map((id) => ({ id, name: nameOf(id), cells: BLOCKS.blocks.find(b => b.id === String(id))?.cells || [] })) })),
    } : null;
    if (report) {
      report.players = report.players.map(p => ({...p, self: self != null && p.id === self}));
      if (self == null || report.self !== self) {
        report.primary = null; report.alternatives = []; report.board = null;
        report.position = null; report.slots = []; report.text = '';
        report.warnings = [self == null ? '本人编号待确认；不会将默认视角当作本人。' : '身份已确认，等待该身份的新推理报告。'];
      }
      report.self = self;
      const turn=bot.turns?.get(String(session.replace(/^g/,'')));
      const latest=data.decisions?.at(-1);
      if(latest?.report?.self===self&&latest.report.suggestion){
        const s=latest.report.suggestion;
        const action=data.actions?.filter(a=>a.decisionAt===latest.at).at(-1);
        const context=action||{round:s.tactic?.round??turn?.round??((latest.report.status?.round||0)+1),
          step:s.tactic?.steps!=null?s.tactic.steps+1:turn?.steps?.length!=null?turn.steps.length+1:1,
          direction:decisionFormat.selectedCommand(s)};
        report.decisionView={key:latest.at,title:decisionFormat.title(context),
          html:decisionFormat.renderReason(latest.report,{round:context.round,action}),sent:!!action};
        const cases=candidatePanels(latest.report,context.direction,{includeProjection:true});
        if(cases.length>1)report.candidateCases=cases;
      }
      report.actionable=!!(turn&&!turn.sent&&!group?.ended);
      if(!report.actionable){
        report.primary=null;report.alternatives=[];
        report.actionStatus=group?.ended?'对局已结束':'等待本人行动提示；以下地图为推理记录';
        report.warnings=[report.actionStatus,...(report.warnings||[])];
      }

    }
    return { ...data, self, decisions: undefined, pool, report, ended: !!group?.ended };
  }

  function snapshot() {
    let cache = null;
    try { cache = require('./game.cjs').module('night-strategist/cache.cjs').stats(); } catch { /* optional */ }
    const sessions = (() => {
      try { return artifact.list().map((row) => enrich(row.session)).filter(row=>row&&!row.archived); } catch { return []; }
    })();
    return {
      ok: true,
      uptimeMs: Date.now() - startedAt,
      connected: !!status().connected,
      selfId: bot.selfId || null,
      mode: config.behavior.mode,
      strategyVersion,
      stats: bot.stats,
      cache,
      sessions,
      matches: matches.list(),
      groups: Object.entries((state.data && state.data.groups) || {}).map(([groupId, info]) => ({
        groupId, session: info.session, self: info.self == null ? null : Number(info.self), ended: !!info.ended, updatedAt: info.updatedAt || null,
      })),
      recent: (bot.recent || []).slice(0, 20),
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if(url.pathname==='/sim'){
        const root=process.env.LN_ARENA_RUNS||path.resolve(__dirname, '../private/data/arena-runs');
        const runs=fs.existsSync(root)?fs.readdirSync(root).filter(n=>/^[a-zA-Z0-9_-]+$/.test(n)&&fs.existsSync(path.join(root,n,'report.json'))).sort((a,b)=>fs.statSync(path.join(root,b,'report.json')).mtimeMs-fs.statSync(path.join(root,a,'report.json')).mtimeMs):[];
        const run=url.searchParams.get('run')||runs[0];
        if(!run||!runs.includes(run))return json(res,404,{ok:false,runs});
        const file=path.join(root,run,url.searchParams.get('format')==='json'?'report.json':'report.html');
        res.writeHead(200,{'content-type':file.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(fs.readFileSync(file));
      }
      if(url.pathname==='/api/events'){
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
        const send=()=>res.write('data: update\n\n');
        artifact.updates.on('change',send);send();
        const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
        res.on('close',()=>{clearInterval(heartbeat);artifact.updates.off('change',send);});
        return;
      }
      if (url.pathname.startsWith('/map-assets/')) {
        const root=path.resolve(require('./game.cjs').assets,'map-assets');
        const file=path.resolve(root,decodeURIComponent(url.pathname.slice('/map-assets/'.length)));
        if (!file.startsWith(root+path.sep) || !['.css','.png'].includes(path.extname(file)) || !fs.existsSync(file)) return json(res,404,{ok:false});
        res.writeHead(200,{'content-type':file.endsWith('.css')?'text/css; charset=utf-8':'image/png'});
        return res.end(fs.readFileSync(file));
      }
      if (url.pathname === '/health') {
        return json(res, 200, { ok: true, uptimeMs: Date.now() - startedAt, connected: !!status().connected, selfId: bot.selfId || null, stats: bot.stats, strategyVersion });
      }
      if (url.pathname === '/api/match') {
        const id = String(url.searchParams.get('id') || '');
        const record = matches.read(id);
        if (!record) return json(res, 404, {ok:false});
        res.writeHead(200, {'content-type':'application/json; charset=utf-8', 'content-disposition':`attachment; filename="${id}.json"`, 'cache-control':'no-store'});
        return res.end(record);
      }
      if (url.pathname === '/api/state') return json(res, 200, snapshot());

      if (url.pathname === '/probability' || url.pathname === '/api/block-probability') {
        const probability=require('./probability.cjs');
        const record=probability.readRecord(String(url.searchParams.get('id')||''));
        if(!record)return json(res,404,{ok:false,message:'没有这局历史复盘'});
        const inputs=[0,1,2].map(i=>String(url.searchParams.get('b'+i)||''));
        if((inputs[1]||inputs[2])&&!inputs[0])return json(res,400,{ok:false,message:'请先选择位置 A'});
        if(inputs[2]&&!inputs[1])return json(res,400,{ok:false,message:'请先选择位置 B，再展开位置 C'});
        const ids=inputs.filter(Boolean);
        try {
          if(url.pathname.startsWith('/api/'))return json(res,200,{ok:true,...probability.calculate(record,ids)});
          const html=probability.render(record,ids);
          res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(html);
        }catch(error){return json(res,400,{ok:false,message:error.message});}
      }

      if (url.pathname === '/history' || url.pathname === '/history/') {
        const html=require('./history.cjs').render(matches.list(),path.join(store.dataDir(),'matches'));
        res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' });
        return res.end(html);
      }

      if (url.pathname === '/api/session') {
        const session = String(url.searchParams.get('session') || '');
        const data = enrich(session);
        return data ? json(res, 200, { ok: true, session: data }) : json(res, 404, { ok: false, message: '没有这一局' });
      }

      if (url.pathname === '/api/save') {
        const session = String(url.searchParams.get('session') || '');
        const journal = store.load(session);
        if (!journal) return json(res, 404, { ok: false, message: '没有这一局' });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${session}.json"`,
          'cache-control': 'no-store',
        });
        return res.end(JSON.stringify(journal, null, 2));
      }

      if (url.pathname === '/api/review') {
        const session = String(url.searchParams.get('session') || '');
        const data = artifact.load(session);
        const file = data && data.review && data.review.path;
        const dir = path.join(store.dataDir(), 'reviews');
        if (!file || path.dirname(path.resolve(file)) !== path.resolve(dir) || !fs.existsSync(file)) {
          return json(res, 404, { ok: false, message: '没有复盘' });
        }
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(file, 'utf8'));
      }

      if (url.pathname === '/api/image') {
        const name = path.basename(String(url.searchParams.get('file') || ''));
        const dir = path.join(store.dataDir(), 'images');
        const file = path.join(dir, name);
        if (!name || path.dirname(file) !== dir) return json(res, 400, { ok: false });
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, message: '没有这张图' });
        const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=60' });
        return res.end(fs.readFileSync(file));
      }

      if (url.pathname.startsWith('/report/')) {
        const id = decodeURIComponent(url.pathname.slice('/report/'.length)).replace(/\.html$/, '');
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return json(res, 400, { ok: false, message: 'bad id' });
        const file = path.join(store.dataDir(), 'matches', id + '.html');
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, message: '没有这一局复盘' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(file));
      }

      if (url.pathname === '/') {
        res.writeHead(302, { location: '/live', 'cache-control': 'no-store' });
        return res.end();
      }

      if (url.pathname === '/live' || url.pathname === '/live/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(PAGE);
      }

      // The board is read-only by design: no inference / reply endpoints.
      return json(res, 404, { ok: false, message: 'not found' });
    } catch (error) {
      logger(`看板请求失败 ${url.pathname}: ${error.message}`);
      return json(res, 500, { ok: false, message: error.message });
    }
  });

  return {
    server,
    listen(port = 8787, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(`http://${host}:${address.port}/`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createDashboard, nameOf };
