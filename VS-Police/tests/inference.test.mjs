// 事後分布・minimax 初期配置の検証テスト
// 実行: node VS-Police/tests/inference.test.mjs
const mod = await import("../app.js");
const api = mod.default ?? mod;
const {
    thiefPosterior,
    chooseMinimaxHeliSetup,
    searchDistanceForBuilding,
    findCurrentPhaseCoveragePlan,
} = api;

const B = 5;
const N = B * B;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function idx(x, y) { return y * B + x; }
function xy(i) { return { x: i % B, y: (i / B) | 0 }; }

function clueAllowedIndices(type, maxIdx) {
    let all;
    if (type === "YELLOW") all = [0];
    else if (type === "RED") all = [5];
    else all = [1, 2, 3, 4, 6, 7, 8, 9, 10];
    return new Set(all.filter(i => i <= maxIdx - 1));
}

// 独立実装: すべての自己回避経路を素朴に列挙する
function brutePosterior(state) {
    const R = state.currentRound;
    const maxIdx = R - 1;
    const counts = new Array(N).fill(0);

    const clues = [];
    const seen = new Set();
    for (const c of state.revealedClues || []) {
        const ci = idx(c.x, c.y);
        if (seen.has(ci)) continue;
        seen.add(ci);
        const allowed = clueAllowedIndices(c.type, maxIdx);
        if (allowed.size > 0) clues.push({ ci, allowed });
    }
    const empties = (state.searchLog || []).filter(s => s.result === "empty");
    const emptyByRound = new Map();
    for (const s of empties) {
        if (!emptyByRound.has(s.round)) emptyByRound.set(s.round, new Set());
        emptyByRound.get(s.round).add(idx(s.x, s.y));
    }

    const path = [];
    const visited = new Set();
    let total = 0;

    function rec() {
        const at = path.length - 1;
        // 痕跡の制約: 痕跡マスは許可されたインデックスでのみ通れる
        for (const cl of clues) {
            if (path[at] === cl.ci && !cl.allowed.has(at)) return;
        }
        // 空振りの制約: ラウンド r に空振りしたマスは index <= r-1 では通れない
        for (const [round, cells] of emptyByRound) {
            if (at <= round - 1 && cells.has(path[at])) return;
        }
        if (at === maxIdx) {
            // すべての痕跡が許可インデックスで訪問済みか
            for (const cl of clues) {
                if (!path.some((p, i) => p === cl.ci && cl.allowed.has(i))) return;
            }
            counts[path[at]]++;
            total++;
            return;
        }
        const { x, y } = xy(path[at]);
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= B || ny >= B) continue;
            const np = idx(nx, ny);
            if (visited.has(np)) continue;
            visited.add(np);
            path.push(np);
            rec();
            path.pop();
            visited.delete(np);
        }
    }

    for (let s = 0; s < N; s++) {
        visited.add(s);
        path.push(s);
        rec();
        path.pop();
        visited.delete(s);
    }

    const probs = new Array(N).fill(0);
    if (total > 0) for (let i = 0; i < N; i++) probs[i] = counts[i] / total;
    return { counts, total, probs };
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomConsistentState(R, rnd) {
    // まずランダムな自己回避経路を1本作る
    const path = [];
    let pos = Math.floor(rnd() * N);
    path.push(pos);
    const visited = new Set([pos]);
    for (let i = 1; i < R; i++) {
        const { x, y } = xy(pos);
        const cand = [];
        for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= B || ny >= B) continue;
            const np = idx(nx, ny);
            if (!visited.has(np)) cand.push(np);
        }
        if (cand.length === 0) break;
        pos = cand[Math.floor(rnd() * cand.length)];
        path.push(pos);
        visited.add(pos);
    }
    const maxIdx = path.length - 1;

    const revealedClues = [];
    // 存在し得る痕跡（index <= maxIdx-1）をランダムに開示
    for (let i = 0; i <= maxIdx - 1; i++) {
        if (rnd() < 0.35) {
            const { x, y } = xy(path[i]);
            let type = "BLUE";
            if (i === 0) type = "YELLOW";
            else if (i === 5) type = "RED";
            revealedClues.push({ x, y, type });
        }
    }

    // 空振り捜索: そのラウンド以前に一度も通っていないマスだけ
    const searchLog = [];
    for (let r = 1; r <= R; r++) {
        if (rnd() < 0.5) {
            const prefix = new Set(path.slice(0, r)); // index 0..r-1
            const safe = [];
            for (let ci = 0; ci < N; ci++) if (!prefix.has(ci)) safe.push(ci);
            if (safe.length > 0) {
                const ci = safe[Math.floor(rnd() * safe.length)];
                const { x, y } = xy(ci);
                searchLog.push({ round: r, x, y, result: "empty" });
            }
        }
    }
    // 痕跡発見ログ（後方互換の確認用、分布には影響しない）
    for (const c of revealedClues) {
        const ci = idx(c.x, c.y);
        const i = path.indexOf(ci);
        if (i >= 0) searchLog.push({ round: Math.min(R, i + 2), x: c.x, y: c.y, result: "clue" });
    }

    return { currentRound: R, revealedClues, searchLog };
}

function compareDistribution(a, b) {
    let maxDiff = 0;
    for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, Math.abs(a.probs[i] - b.probs[i]));
    return maxDiff;
}

let failures = 0;
function assert(cond, msg) {
    if (!cond) { failures++; console.log("FAIL:", msg); }
}

console.log("=== 1. 基本ケース ===");
{
    const st = { currentRound: 1, revealedClues: [], searchLog: [] };
    const p = thiefPosterior(st);
    assert(p.total === 25, `R1 total=25 (got ${p.total})`);
    assert(p.cells.length === 25, `R1 cells=25 (got ${p.cells.length})`);
    const probs = new Set(Array.from(p.probs).map(v => v.toFixed(6)));
    assert(probs.size === 1 && Math.abs(Number([...probs][0]) - 0.04) < 1e-9, "R1 uniform 1/25");
}

{
    const st = {
        currentRound: 2,
        revealedClues: [{ x: 2, y: 2, type: "YELLOW" }],
        searchLog: [],
    };
    const p = thiefPosterior(st);
    assert(p.total === 4, `yellow R2 total=4 (got ${p.total})`);
    const nz = [];
    for (let i = 0; i < N; i++) if (p.probs[i] > 0) nz.push(xy(i));
    const expected = [[2, 1], [2, 3], [1, 2], [3, 2]].map(([x, y]) => `${x},${y}`).sort();
    const got = nz.map(c => `${c.x},${c.y}`).sort();
    assert(JSON.stringify(got) === JSON.stringify(expected), `yellow R2 neighbors (got ${got})`);
    assert(p.probs[idx(2, 2)] === 0, "yellow cell itself p=0");
}

{
    // 赤チップ R7: index5 に (2,2) を通過 → 現在地は隣接4マスだけ
    const st = {
        currentRound: 7,
        revealedClues: [{ x: 2, y: 2, type: "RED" }],
        searchLog: [],
    };
    const p = thiefPosterior(st);
    const nz = [];
    for (let i = 0; i < N; i++) if (p.probs[i] > 0) nz.push(xy(i));
    const allowed = new Set(["2,1", "2,3", "1,2", "3,2"]);
    assert(nz.length > 0 && nz.every(c => allowed.has(`${c.x},${c.y}`)), `red R7 only neighbors (got ${nz.map(c => `${c.x},${c.y}`)})`);
    assert(p.probs[idx(2, 2)] === 0, "red cell itself p=0");
    const sum = nz.reduce((s, c) => s + p.probs[idx(c.x, c.y)], 0);
    assert(Math.abs(sum - 1) < 1e-9, "red R7 normalized");
}

{
    // 空振りは「そのラウンド以前に一度も滞在していない」ことを示す
    const st = {
        currentRound: 3,
        revealedClues: [],
        searchLog: [{ round: 3, x: 0, y: 0, result: "empty" }],
    };
    const p = thiefPosterior(st);
    assert(p.probs[idx(0, 0)] === 0, "empty R3 cell p=0");
    // 独立実装と一致するか
    const b = brutePosterior(st);
    assert(p.total === b.total, `empty R3 total ${p.total} vs ${b.total}`);
    assert(compareDistribution(p, b) < 1e-12, "empty R3 distribution matches brute force");
}

console.log("=== 2. ランダムな整合シナリオで独立実装と比較 ===");
{
    const rnd = mulberry32(123456789);
    let scenarios = 0;
    for (let R = 1; R <= 7; R++) {
        for (let k = 0; k < 30; k++) {
            const st = randomConsistentState(R, rnd);
            const p = thiefPosterior(st);
            const b = brutePosterior(st);
            scenarios++;
            assert(p.total === b.total, `R${R} #${k} total ${p.total} vs ${b.total}`);
            if (p.total === b.total && p.total > 0) {
                const diff = compareDistribution(p, b);
                assert(diff < 1e-12, `R${R} #${k} distribution diff ${diff}`);
            }
        }
    }
    console.log(`compared ${scenarios} scenarios (R=1..7)`);
}

console.log("=== 2b. 終盤ラウンド (R=8..11) の独立実装比較 ===");
{
    const rnd = mulberry32(987654321);
    let scenarios = 0;
    for (let R = 8; R <= 11; R++) {
        for (let k = 0; k < 5; k++) {
            const st = randomConsistentState(R, rnd);
            const p = thiefPosterior(st);
            const b = brutePosterior(st);
            scenarios++;
            assert(p.total === b.total, `R${R} #${k} total ${p.total} vs ${b.total}`);
            if (p.total === b.total && p.total > 0) {
                const diff = compareDistribution(p, b);
                assert(diff < 1e-12, `R${R} #${k} distribution diff ${diff}`);
            }
        }
    }
    console.log(`compared ${scenarios} late-round scenarios (R=8..11)`);
}

console.log("=== 3. minimax 初期配置 ===");
{
    const setup = chooseMinimaxHeliSetup();
    console.log("combo:", setup.combo.map(p => `(${p.x},${p.y})`).join(" "));
    console.log("maxSearch:", setup.maxSearch, "sumSearch:", setup.sumSearch, "immediate:", setup.immediate);
    assert(setup.maxSearch === 2, `minimax maxSearch=2 (got ${setup.maxSearch})`);
    const keys = new Set(setup.combo.map(p => `${p.x},${p.y}`));
    assert(keys.size === 3, "minimax has 3 distinct intersections");
    for (const p of setup.combo) {
        assert(p.x >= 0 && p.x < 4 && p.y >= 0 && p.y < 4, "minimax in bounds");
    }
    // 全ビルが最大2手以内で捜索可能
    for (let by = 0; by < B; by++) {
        for (let bx = 0; bx < B; bx++) {
            const d = Math.min(...setup.combo.map(p => searchDistanceForBuilding(bx, by, p.x, p.y)));
            assert(d <= 2, `building (${bx},${by}) search distance ${d} <= 2`);
        }
    }
}

console.log("=== 3b. 現フェーズ必中カバレッジ計画 ===");
{
    const helis = [
        { index: 0, x: 0, y: 1 },
        { index: 1, x: 1, y: 0 },
        { index: 2, x: 2, y: 2 },
    ];
    const candidates = [{ x: 0, y: 1, p: 0.5 }, { x: 1, y: 0, p: 0.5 }];
    const plan = findCurrentPhaseCoveragePlan(helis, candidates);
    assert(plan !== null, "coverage plan found");
    assert(plan.get(0).target.x === 0 && plan.get(0).target.y === 1, "heli 0 assigned (0,1)");
    assert(plan.get(1).target.x === 1 && plan.get(1).target.y === 0, "heli 1 assigned (1,0)");
    assert(!plan.has(2), "unneeded heli not assigned");

    const impossible = findCurrentPhaseCoveragePlan(
        [{ index: 0, x: 2, y: 2 }, { index: 1, x: 1, y: 1 }, { index: 2, x: 0, y: 0 }],
        [{ x: 4, y: 4, p: 1 }]
    );
    assert(impossible === null, "coverage plan null when unreachable");

    const tooMany = findCurrentPhaseCoveragePlan(helis, [
        { x: 0, y: 1, p: 0.3 }, { x: 1, y: 0, p: 0.3 },
        { x: 2, y: 2, p: 0.2 }, { x: 3, y: 3, p: 0.2 },
    ]);
    assert(tooMany === null, "coverage plan null when candidates > helis");
}

console.log("=== 4. 性能（最悪ケース） ===");
{
    const cases = [
        { name: "R11 no clues", st: { currentRound: 11, revealedClues: [], searchLog: [] } },
        { name: "R11 yellow only", st: { currentRound: 11, revealedClues: [{ x: 2, y: 2, type: "YELLOW" }], searchLog: [] } },
        { name: "R11 yellow+red+blue", st: { currentRound: 11, revealedClues: [
            { x: 2, y: 2, type: "YELLOW" },
            { x: 1, y: 2, type: "RED" },
            { x: 0, y: 2, type: "BLUE" },
        ], searchLog: [] } },
        { name: "R11 with 6 empty searches", st: { currentRound: 11, revealedClues: [
            { x: 2, y: 2, type: "YELLOW" },
        ], searchLog: [
            { round: 3, x: 0, y: 0, result: "empty" },
            { round: 4, x: 0, y: 1, result: "empty" },
            { round: 5, x: 0, y: 2, result: "empty" },
            { round: 6, x: 0, y: 3, result: "empty" },
            { round: 7, x: 0, y: 4, result: "empty" },
            { round: 8, x: 1, y: 0, result: "empty" },
        ] } },
    ];
    for (const c of cases) {
        const t0 = performance.now();
        const p = thiefPosterior(c.st);
        const dt = performance.now() - t0;
        console.log(`${c.name}: ${dt.toFixed(1)}ms, paths=${p.total}, nonzero=${p.cells.length}`);
        assert(dt < 2000, `${c.name} under 2s (got ${dt.toFixed(1)}ms)`);
    }
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
