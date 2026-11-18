'use strict';
/**
 * Read the opening "本局可能出现的区块" sheet and return the block pool.
 *
 * How it works: lgtbot draws every block from the same sprites, and this project
 * ships signature tables built from lgtbot's own per-block renders
 * (vendor/long-night/block-signatures.json, one set per texture). A tile in the
 * sheet is matched by its 9 cell fills + 9 centre icons + 12 inner edges, never
 * by OCR.
 *
 * The sheet is a table: normals first (ascending id), then exit blocks
 * (ascending id), which lets us validate the match as an ordered subsequence of
 * the mode pool. The texture (classic/retro/fresh) is chosen by whichever set
 * explains the whole sheet best.
 */
const path = require('node:path');
const png = require('./png.cjs');

const KERNEL = path.resolve(__dirname, '..', 'vendor', 'long-night');
const SIGNATURES = require(path.join(KERNEL, 'block-signatures.json'));
const BLOCKS = require(path.join(KERNEL, 'blocks.js'));

const TEXTURES = SIGNATURES.textures || { classic: SIGNATURES.blocks };
const UNIT = SIGNATURES.unit || 190;
const WALL = SIGNATURES.wall || 10;
const CELL = SIGNATURES.cell || 50;
const TOLERANCE = 60;

function l1(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** Scaling and anti-aliasing shift colours slightly; ignore anything that small. */
function delta(a, b) {
  const d = l1(a, b);
  return d <= TOLERANCE ? 0 : d;
}

function darkAt(image, x, y) {
  const i = (y * image.width + x) * 3;
  return image.data[i] < 70 && image.data[i + 1] < 70 && image.data[i + 2] < 70;
}

/**
 * Boards are framed by a dashed black border in every texture, while inner
 * walls may be brown (retro) or black (classic). So: find border rows, then pair
 * each top border with the bottom border one tile-height below.
 */
function detectBoards(image) {
  const { width, height } = image;
  const rowInk = [];
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x += 2) if (darkAt(image, x, y)) n++;
    rowInk.push(n / (width / 2));
  }
  const darkRows = [];
  for (let y = 0; y < height; y++) if (rowInk[y] > 0.3) darkRows.push(y);
  if (!darkRows.length) return { boards: [], textureWidth: 0 };

  // Columns from the first border row (its dashes cover each board's width).
  const top = darkRows[0];
  const has = [];
  for (let x = 0; x < width; x++) {
    let found = false;
    for (let y = top; y <= Math.min(top + 3, height - 1); y++) if (darkAt(image, x, y)) { found = true; break; }
    has.push(found);
  }
  const spans = [];
  let start = -1;
  let last = -1;
  for (let x = 0; x < width; x++) {
    if (has[x]) {
      if (start < 0) start = x;
      last = x;
    } else if (start >= 0 && x - last > 12) {
      spans.push([start, last]);
      start = -1;
    }
  }
  if (start >= 0) spans.push([start, last]);
  const columns = spans.filter(([a, b]) => b - a > 60);
  if (!columns.length) return { boards: [], textureWidth: 0 };

  const sortedWidths = columns.map(([a, b]) => b - a + 1).sort((a, b) => a - b);
  const tile = sortedWidths[Math.floor(sortedWidths.length / 2)];
  const nearDark = (y) => darkRows.some((row) => Math.abs(row - y) <= 8);

  const boards = [];
  let cursor = 0;
  while (cursor < darkRows.length) {
    const y0 = darkRows[cursor];
    if (boards.some((b) => y0 >= b.y0 - 4 && y0 <= b.y1 + 4)) { cursor++; continue; }
    if (!nearDark(y0 + tile)) { cursor++; continue; }
    const y1 = y0 + tile;
    for (const [x0, x1] of columns) {
      if (x1 - x0 + 1 < tile * 0.7) continue;
      boards.push({ x0, y0, x1, y1 });
    }
    while (cursor < darkRows.length && darkRows[cursor] <= y1 + 4) cursor++;
  }
  return { boards, tile };
}

function signatureOf(image, box) {
  const { width: w, height: h, data } = image;
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const sx = bw / UNIT;
  const sy = bh / UNIT;
  const at = (x, y) => {
    const px = Math.min(w - 1, Math.max(0, Math.round(x)));
    const py = Math.min(h - 1, Math.max(0, Math.round(y)));
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = (Math.min(h - 1, Math.max(0, py + dy)) * w + Math.min(w - 1, Math.max(0, px + dx))) * 3;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  const terrain = [];
  const icon = [];
  const edges = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const x = box.x0 + (WALL + CELL * c + CELL / 2) * sx;
      const y = box.y0 + (WALL + CELL * r + CELL / 2) * sy;
      const votes = {};
      for (const [dx, dy] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) {
        const p = at(x + dx * sx, y + dy * sy);
        votes[p.join(',')] = (votes[p.join(',')] || 0) + 1;
      }
      terrain.push(Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number));
      icon.push(at(x, y));
    }
  }
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) edges.push(at(box.x0 + (WALL + CELL * (c + 1)) * sx, box.y0 + (WALL + CELL * r + CELL / 2) * sy));
  }
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) edges.push(at(box.x0 + (WALL + CELL * c + CELL / 2) * sx, box.y0 + (WALL + CELL * (r + 1)) * sy));
  }
  return { terrain, icon, edges };
}

function compare(sig, template) {
  let distance = 0;
  for (let i = 0; i < 9; i++) {
    distance += delta(sig.terrain[i], template.terrain[i]) * 0.6;
    distance += delta(sig.icon[i], template.icon[i]) * 0.4;
  }
  for (let i = 0; i < 12; i++) distance += delta(sig.edges[i], template.edges[i]);
  return distance;
}

function rank(sig, texture = 'classic') {
  const table = TEXTURES[texture] || TEXTURES.classic;
  const scored = [];
  for (const [id, template] of Object.entries(table)) scored.push({ id, distance: compare(sig, template) });
  scored.sort((a, b) => a.distance - b.distance);
  return scored;
}

function numericId(id) {
  const m = String(id).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Pick one candidate per row so that ids strictly increase (the sheet is sorted).
 * Returns null when no increasing assignment exists.
 */
function solveGroup(rows, wantExit, pool) {
  const options = rows.map((list) => list.filter((o) => (wantExit ? /^E/.test(o.id) : !/^[ES]/.test(o.id)) && (!pool || pool.includes(o.id))));
  if (options.some((list) => !list.length)) return null;
  let layer = options[0].map((o) => ({ cost: o.distance, id: o.id, back: -1 }));
  const layers = [layer];
  for (let i = 1; i < options.length; i++) {
    const next = options[i].map((o) => {
      let best = null;
      for (let j = 0; j < layer.length; j++) {
        const prev = layer[j];
        if (!prev) continue;
        if (numericId(o.id) <= numericId(prev.id)) continue;
        if (!best || prev.cost < best.cost) best = { cost: prev.cost, back: j };
      }
      return best ? { cost: best.cost + o.distance, id: o.id, back: best.back } : null;
    });
    if (next.every((x) => !x)) return null;
    layer = next;
    layers.push(layer);
  }
  let pick = -1;
  for (let j = 0; j < layer.length; j++) if (layer[j] && (pick < 0 || layer[j].cost < layer[pick].cost)) pick = j;
  if (pick < 0) return null;
  const total = layer[pick].cost;
  const ids = [];
  let index = pick;
  for (let i = layers.length - 1; i >= 0; i--) {
    ids[i] = layers[i][index].id;
    index = layers[i][index].back;
  }
  return { ids, total };
}

/** Best globally-ordered assignment, optionally forbidding one candidate. */
function search(ranked, expected, pool, ban) {
  const rows = ranked.map((list, i) => (ban && ban.index === i ? list.filter((c) => c.id !== ban.id) : list));
  let best = null;
  for (let split = 0; split <= rows.length; split++) {
    const head = rows.slice(0, split);
    const tail = rows.slice(split);
    if (head.length !== expected.normals || tail.length !== expected.exits) continue;
    const normalPart = solveGroup(head, false, pool);
    if (!normalPart) continue;
    const exitPart = tail.length ? solveGroup(tail, true, pool) : { ids: [], total: 0 };
    if (!exitPart) continue;
    const total = normalPart.total + exitPart.total;
    if (!best || total < best.total) best = { total, ids: [...normalPart.ids, ...exitPart.ids] };
  }
  return best;
}

/**
 * @returns {{ok:boolean, ids:string[], normals:string[], exits:string[],
 *            tiles:Array, texture:string, confidence:'high'|'medium'|'low', warnings:string[]}}
 */
function readPool(buffer, options = {}) {
  const image = png.toRgb(png.decode(buffer));
  const warnings = [];
  const pool = options.pool ? String(options.pool).toUpperCase().match(/[ES]?\d+/g) || [] : null;
  const normalLimit=options.expanded?16:12,exitLimit=options.expanded?6:4;
  const poolNormals = pool ? pool.filter((id) => !/^E/.test(id)).length : normalLimit;
  const poolExits = pool ? pool.filter((id) => /^E/.test(id)).length : exitLimit;
  const expected = options.expected || { normals: Math.min(normalLimit, poolNormals), exits: Math.min(exitLimit, poolExits) };

  const detected = detectBoards(image);
  if (!detected.boards.length) {
    return { ok: false, ids: [], normals: [], exits: [], tiles: [], texture: null, confidence: 'low', warnings: ['没有在图片里找到区块表格（可能不是开局图，或渲染尺寸变了）。'] };
  }

  const wanted = expected.normals + expected.exits;
  let boards = detected.boards;
  if (boards.length > wanted) boards = boards.slice(0, wanted);
  if (boards.length < wanted) warnings.push(`图上只找到 ${boards.length} 个区块格子（本局应有 ${wanted} 个）。`);

  let best = null;
  for (const texture of Object.keys(TEXTURES)) {
    const ranked = boards.map((box) => rank(signatureOf(image, box), texture));
    const assignment = search(ranked, expected, pool, null);
    if (!assignment) continue;
    if (!best || assignment.total < best.assignment.total) best = { texture, ranked, assignment };
  }

  let tiles;
  if (best) {
    const margins = best.assignment.ids.map((id, i) => {
      const alternative = search(best.ranked, expected, pool, { index: i, id });
      return alternative ? Math.round(alternative.total - best.assignment.total) : 99999;
    });
    tiles = best.assignment.ids.map((id, i) => {
      const list = best.ranked[i];
      const chosen = list.find((c) => c.id === id) || { distance: 0 };
      return {
        id,
        distance: Math.round(chosen.distance),
        margin: margins[i],
        candidates: list.slice(0, 3).map((c) => c.id),
        position: i + 1,
      };
    });
  } else {
    warnings.push('无法排出符合“编号递增”的组合，退回逐个匹配，结果需要人工核对。');
    const ranked = boards.map((box) => rank(signatureOf(image, box), 'classic'));
    tiles = ranked.map((list, i) => ({
      id: list[0].id,
      distance: Math.round(list[0].distance),
      margin: Math.round((list[1] ? list[1].distance : list[0].distance * 2) - list[0].distance),
      candidates: list.slice(0, 3).map((c) => c.id),
      position: i + 1,
    }));
  }

  const ids = tiles.map((t) => t.id);
  const unique = new Set(ids).size === ids.length;
  if (!unique) warnings.push('识别出的区块编号有重复，可能有一块没读准。');
  const normals = ids.filter((id) => !/^E/.test(id));
  const exits = ids.filter((id) => /^E/.test(id));
  if (normals.length !== expected.normals) warnings.push(`普通区块读到 ${normals.length} 个（本局应有 ${expected.normals} 个）。`);
  if (exits.length !== expected.exits) warnings.push(`逃生舱读到 ${exits.length} 个（本局应有 ${expected.exits} 个）。`);

  const weak = tiles.filter((t) => t.margin < 150);
  if (weak.length) warnings.push(`有 ${weak.length} 块不是唯一解，建议人工核对：${weak.map((t) => `${t.position}号位 ${t.id}`).join('、')}。`);

  const confidence = !best || !unique ? 'low' : weak.length ? 'medium' : 'high';
  return {
    ok: !!best && unique,
    ids,
    normals,
    exits,
    tiles,
    texture: best ? best.texture : null,
    confidence,
    warnings,
    pool: ids.join(' '),
    imageWidth: image.width,
    imageHeight: image.height,
    blocks: BLOCKS.blocks.length,
  };
}

module.exports = { readPool, detectBoards, signatureOf, rank, compare, TEXTURES };
