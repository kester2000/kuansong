'use strict';

// Count assignments that survive slot-domain filtering, distinct block IDs,
// and the exit quota. Later cross-block evidence and spawn likelihoods still
// have to be applied; these counts alone are not posterior probabilities.
function countCandidatePlacements(solution, exitCount) {
  if (!solution || solution.irregular) throw new Error('需要规则区块布局');
  return solution.phases.map(phase => {
    const domains = phase.domains.map(domain => [...new Set(domain.map(m => m.id))])
      .sort((a, b) => a.length - b.length);
    const ids = [...new Set(domains.flat())];
    const bits = new Map(ids.map((id, i) => [id, 1n << BigInt(i)]));
    let counts = new Map([[0n, 1n]]);
    for (const domain of domains) {
      const next = new Map();
      for (const [used, ways] of counts) for (const id of domain) {
        const bit = bits.get(id);
        if (used & bit) continue;
        const key = used | bit;
        next.set(key, (next.get(key) || 0n) + ways);
      }
      counts = next;
    }
    const exits = ids.filter(id => id.startsWith('E')).map(id => bits.get(id));
    let total = 0n;
    for (const [used, ways] of counts) {
      if (exitCount == null || exits.filter(bit => used & bit).length === exitCount) total += ways;
    }
    return {pr: phase.pr, pc: phase.pc, count: total};
  });
}
module.exports = {countCandidatePlacements};
