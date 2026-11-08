#!/usr/bin/env node
/* ==========================================================
   VS Police - 自己対戦ベンチマーク（提案9）
   警察CPUの意思決定関数をブラウザと同じコードで動かし、
   犯人側の複数政策に対して勝率・捕獲ラウンド・捜索効率を測る。

   使い方:
     node tools/benchmark.js --games 20 --thief all --order both
     node tools/benchmark.js --games 50 --thief survival --order smart
     node tools/benchmark.js --games 10 --thief distance --order fixed --seed 123

   オプション:
     --games N     政策ごとの対局数（既定 20）
     --thief NAME  random|distance|edge|survival|human|all（既定 all）
     --order MODE  smart|fixed|both（既定 smart）
     --seed N      基準シード（既定 0x1a2b3c4d）
     --verbose     1局ごとの結果を表示
     --json        JSONで出力
   ========================================================== */

/* 出力指標:
   勝率 / 捕獲・手詰まりの内訳 / 平均終了ラウンド / 捜索・痕跡・再捜索回数 /
   smart が既定順と違うヘリを選んだ回数（--order both で提案7を比較） */
'use strict';

const path = require('path');
const engine = require(path.join(__dirname, '..', 'VS-Police', 'app.js'));

const B_SIZE = 5;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const POLICIES = ['random', 'distance', 'edge', 'survival', 'human'];

/* ---------- 引数 ---------- */
function usage() {
    console.log(`Usage: node tools/benchmark.js [options]

  --games N      対局数/政策（既定 20）
  --thief NAME   random|distance|edge|survival|human|all（既定 all）
  --order MODE   smart|fixed|both（既定 smart）
  --seed N       基準シード（既定 0x1a2b3c4d）
  --verbose      1局ごとの結果を表示
  --json         JSONで出力
  --help         このヘルプ`);
}

function parseArgs(argv) {
    const opts = {
        games: 20,
        thief: 'all',
        order: 'smart',
        seed: 0x1a2b3c4d,
        verbose: false,
        json: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--games') {
            const n = Number(argv[++i]);
            if (!Number.isFinite(n) || n < 1) throw new Error('--games は1以上の数値を指定してください');
            opts.games = Math.floor(n);
        } else if (arg === '--thief') {
            opts.thief = String(argv[++i] || '');
        } else if (arg === '--order') {
            opts.order = String(argv[++i] || '');
        } else if (arg === '--seed') {
            const n = Number(argv[++i]);
            if (!Number.isFinite(n)) throw new Error('--seed は数値を指定してください');
            opts.seed = n >>> 0;
        } else if (arg === '--verbose') {
            opts.verbose = true;
        } else if (arg === '--json') {
            opts.json = true;
        } else if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        } else {
            throw new Error(`不明な引数: ${arg}`);
        }
    }
    if (opts.thief !== 'all' && !POLICIES.includes(opts.thief)) {
        throw new Error(`--thief は ${POLICIES.join('|')}|all のいずれかです`);
    }
    if (!['smart', 'fixed', 'both'].includes(opts.order)) {
        throw new Error('--order は smart|fixed|both のいずれかです');
    }
    return opts;
}

/* ---------- 乱数（犯人側の政策用。警察CPU側は app.js のシード付き乱数） ---------- */
function mulberry32(seed) {
    let state = seed >>> 0;
    return function () {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function key(x, y) { return `${x},${y}`; }
function edgeOf(x, y) { return (x === 0 || x === B_SIZE - 1 || y === 0 || y === B_SIZE - 1) ? 1 : 0; }
function allCells() {
    const cells = [];
    for (let y = 0; y < B_SIZE; y++) {
        for (let x = 0; x < B_SIZE; x++) cells.push({ x, y });
    }
    return cells;
}

/* 現在の訪問済み集合を考慮した、移動先から到達できる未訪問マス数。 */
function reachableUnvisited(state, sx, sy) {
    const blocked = new Set(state.thief.visited);
    blocked.add(key(sx, sy));
    const seen = new Set([key(sx, sy)]);
    const stack = [[sx, sy]];
    let count = 0;
    while (stack.length > 0) {
        const [x, y] = stack.pop();
        for (const [dx, dy] of DIRS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
            const k = key(nx, ny);
            if (blocked.has(k) || seen.has(k)) continue;
            seen.add(k);
            count += 1;
            stack.push([nx, ny]);
        }
    }
    return count;
}

function unvisitedNeighbors(state, x, y) {
    let count = 0;
    for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
        if (!state.thief.visited.has(key(nx, ny))) count += 1;
    }
    return count;
}

function legalCarMoves(state) {
    if (state.thief.carX == null) return [];
    const moves = [];
    for (const [dx, dy] of DIRS) {
        const nx = state.thief.carX + dx;
        const ny = state.thief.carY + dy;
        if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
        if (state.thief.visited.has(key(nx, ny))) continue;
        moves.push({ x: nx, y: ny });
    }
    return moves;
}

/* ---------- 犯人側の政策 ---------- */
function chooseThiefStart(state, policy, rng) {
    const helis = state.police.helis;
    const cells = allCells();
    if (policy === 'random') {
        return cells[Math.floor(rng() * cells.length)];
    }
    const scored = cells.map(c => {
        let minSearch = Infinity;
        let minMan = Infinity;
        for (const h of helis) {
            const ds = engine.searchDistanceForBuilding(c.x, c.y, h.x, h.y);
            if (ds < minSearch) minSearch = ds;
            const dm = Math.abs(c.x - h.x) + Math.abs(c.y - h.y);
            if (dm < minMan) minMan = dm;
        }
        const edge = edgeOf(c.x, c.y);
        const escape = unvisitedNeighbors(state, c.x, c.y);
        let score;
        if (policy === 'distance') {
            score = minSearch * 10 + minMan * 0.5 + edge * 0.2;
        } else if (policy === 'edge') {
            score = edge * 10 + minSearch * 2 + minMan * 0.5;
        } else if (policy === 'survival') {
            score = escape * 2 + minSearch * 1.5 + edge * 0.2;
        } else { // human
            score = minSearch * 2 + minMan * 0.5 + escape * 0.5 + edge * 0.3;
        }
        return { cell: c, score };
    });
    if (policy === 'human') return sampleSoftmax(scored, 1.4, rng).cell;
    return pickMax(scored, rng).cell;
}

function chooseThiefMove(state, policy, rng) {
    const moves = legalCarMoves(state);
    if (moves.length === 0) return null;
    if (policy === 'random') return moves[Math.floor(rng() * moves.length)];

    const helis = state.police.helis;
    const scored = moves.map(m => {
        let minDist = Infinity;
        for (const h of helis) {
            const d = Math.abs(m.x - h.x) + Math.abs(m.y - h.y);
            if (d < minDist) minDist = d;
        }
        const edge = edgeOf(m.x, m.y);
        const escape = unvisitedNeighbors(state, m.x, m.y);
        // 移動先を訪問済みにした状態で、さらに先へ逃げられる広さ。
        const reach = reachableUnvisited(state, m.x, m.y);
        let score;
        if (policy === 'distance') {
            score = minDist + edge * 0.5;
        } else if (policy === 'edge') {
            score = edge * 10 + minDist + escape * 0.2;
        } else if (policy === 'survival') {
            score = reach * 1.5 + minDist * 2 + escape * 1.0 + edge * 0.2;
        } else { // human
            score = reach * 1.0 + minDist * 1.5 + escape * 0.8 + edge * 0.2;
        }
        return { cell: m, score };
    });
    if (policy === 'human') return sampleSoftmax(scored, 1.5, rng).cell;
    return pickMax(scored, rng).cell;
}

function pickMax(scored, rng) {
    let best = scored[0];
    for (const s of scored) {
        if (s.score > best.score + 1e-9) best = s;
    }
    const ties = scored.filter(s => Math.abs(s.score - best.score) <= 1e-9);
    return ties[Math.floor(rng() * ties.length)];
}

function sampleSoftmax(scored, temp, rng) {
    let maxScore = -Infinity;
    for (const s of scored) if (s.score > maxScore) maxScore = s.score;
    let sum = 0;
    const weights = scored.map(s => {
        const w = Math.exp((s.score - maxScore) / Math.max(0.01, temp));
        sum += w;
        return w;
    });
    let r = rng() * sum;
    for (let i = 0; i < scored.length; i++) {
        r -= weights[i];
        if (r <= 0) return scored[i];
    }
    return scored[scored.length - 1];
}

/* ---------- 警察側の行動適用（DOMなし） ---------- */
function applyPoliceSearch(state, heli, x, y, stats) {
    if (!engine.searchableBuildings(heli).some(b => b.x === x && b.y === y)) {
        throw new Error(`違法な捜索: heli=${heli.label} target=(${x},${y})`);
    }
    const b = state.buildings[y][x];
    if (b.isSearched) stats.repeatSearches += 1;
    b.isSearched = true;
    b.searchedRound = state.currentRound;
    heli.hasActed = true;
    stats.searches += 1;

    if (state.thief.carX === x && state.thief.carY === y) {
        return { winner: 'POLICE', reason: 'capture', round: state.currentRound };
    }
    if (b.clue) {
        b.clueRevealed = true;
        if (!state.revealedClues.some(c => c.x === x && c.y === y)) {
            state.revealedClues.push({
                x, y, type: b.clue, foundRound: state.currentRound,
            });
            stats.clues += 1;
        }
        state.searchLog.push({ round: state.currentRound, x, y, result: 'clue' });
    } else {
        state.searchLog.push({ round: state.currentRound, x, y, result: 'empty' });
    }
    return null;
}

function applyPoliceMove(state, heli, x, y) {
    if (!engine.validHeliMoves(heli).some(m => m.x === x && m.y === y)) {
        throw new Error(`違法な移動: heli=${heli.label} target=(${x},${y})`);
    }
    heli.x = x;
    heli.y = y;
    heli.hasActed = true;
}

/* ---------- 1局シミュレーション ---------- */
function simulateGame(policy, seed, orderMode, verbose) {
    const state = engine.createState('cpu_police');
    engine.resetCaches();
    engine.seedRandom(seed);
    engine.setState(state);

    // 警察CPUの初期配置（ブラウザと同じ関数）
    const setup = engine.chooseRandomMinimaxHeliSetup();
    state.police.helis.forEach((h, i) => {
        h.x = setup.combo[i].x;
        h.y = setup.combo[i].y;
        h.hasActed = false;
    });

    const rng = mulberry32((seed ^ 0x9E3779B9) >>> 0);
    const start = chooseThiefStart(state, policy, rng);
    state.thief.carX = start.x;
    state.thief.carY = start.y;
    state.thief.visited.add(key(start.x, start.y));
    state.thief.path.push({ round: 0, x: start.x, y: start.y });

    const stats = { searches: 0, clues: 0, orderChanges: 0, repeatSearches: 0 };
    let lastResult = null;

    for (let round = 1; round <= 11; round++) {
        state.currentRound = round;
        state.phase = 'ROUND_POLICE';
        state.police.helis.forEach(h => { h.hasActed = false; });

        // 警察フェーズ
        let guard = 0;
        while (state.police.helis.some(h => !h.hasActed)) {
            if (++guard > 10) throw new Error('警察フェーズが進みません');
            const remaining = state.police.helis.filter(h => !h.hasActed);
            let heli = remaining[0];
            if (orderMode !== 'fixed') {
                heli = engine.chooseNextHeli(remaining) || remaining[0];
                if (heli !== remaining[0]) stats.orderChanges += 1;
            }
            if (process.env.BENCH_DEBUG_ORDER) {
                console.error(`  R${state.currentRound} rem=${remaining.map(h => h.label).join(',')}`
                    + ` pick=${heli.label} paths=${engine.getPathAnalysis(state).paths.length}`);
            }
            state.police.selected = heli.index;
            const action = engine.decidePoliceAction(heli);
            if (!action) {
                heli.hasActed = true;
                continue;
            }
            if (action.type === 'search') {
                lastResult = applyPoliceSearch(state, heli, action.target.x, action.target.y, stats);
            } else if (action.type === 'move') {
                applyPoliceMove(state, heli, action.target.x, action.target.y);
            } else {
                heli.hasActed = true;
            }
            if (lastResult && lastResult.winner === 'POLICE') break;
        }
        if (lastResult && lastResult.winner === 'POLICE') break;

        // 第11ラウンド終了時点で未発見なら犯人の勝利
        if (round >= 11) {
            lastResult = { winner: 'THIEF', reason: 'survived', round: 11 };
            break;
        }

        // 犯人フェーズ開始時の手詰まり（提案1のゲーム本体修正と同じ判定）
        if (legalCarMoves(state).length === 0) {
            lastResult = { winner: 'POLICE', reason: 'trap', round };
            break;
        }

        // 犯人フェーズ
        const move = chooseThiefMove(state, policy, rng);
        if (!move) {
            lastResult = { winner: 'POLICE', reason: 'trap', round };
            break;
        }
        const oldX = state.thief.carX;
        const oldY = state.thief.carY;
        state.buildings[oldY][oldX].clue = engine.clueTypeForRound(round);
        state.thief.history.push({
            round, x: oldX, y: oldY, clueType: engine.clueTypeForRound(round),
        });
        state.thief.carX = move.x;
        state.thief.carY = move.y;
        state.thief.visited.add(key(move.x, move.y));
        state.thief.path.push({ round, x: move.x, y: move.y });
    }

    if (!lastResult) {
        lastResult = { winner: 'THIEF', reason: 'survived', round: 11 };
    }

    if (verbose) {
        console.log(`  ${policy}/${orderMode} seed=${seed >>> 0} -> ${lastResult.winner} `
            + `(${lastResult.reason}, R${lastResult.round}) searches=${stats.searches} `
            + `clues=${stats.clues} orderChanges=${stats.orderChanges} repeats=${stats.repeatSearches}`);
    }

    engine.setState(null);
    return {
        policy,
        order: orderMode,
        seed: seed >>> 0,
        winner: lastResult.winner,
        reason: lastResult.reason,
        round: lastResult.round,
        searches: stats.searches,
        clues: stats.clues,
        orderChanges: stats.orderChanges,
        repeatSearches: stats.repeatSearches,
    };
}

/* ---------- 集計 ---------- */
function summarize(policy, order, results, elapsedMs) {
    const games = results.length;
    let policeWins = 0;
    let thiefWins = 0;
    let captureWins = 0;
    let trapWins = 0;
    let totalRound = 0;
    let totalSearches = 0;
    let totalClues = 0;
    let totalOrderChanges = 0;
    let totalRepeatSearches = 0;
    for (const r of results) {
        totalRound += r.round;
        totalSearches += r.searches;
        totalClues += r.clues;
        totalOrderChanges += r.orderChanges;
        totalRepeatSearches += r.repeatSearches;
        if (r.winner === 'POLICE') {
            policeWins += 1;
            if (r.reason === 'capture') captureWins += 1;
            else trapWins += 1;
        } else {
            thiefWins += 1;
        }
    }
    return {
        policy,
        order,
        games,
        policeWins,
        thiefWins,
        captureWins,
        trapWins,
        policeWinRate: games > 0 ? policeWins / games : 0,
        thiefWinRate: games > 0 ? thiefWins / games : 0,
        captureRate: policeWins > 0 ? captureWins / policeWins : 0,
        avgRound: games > 0 ? totalRound / games : 0,
        avgSearches: games > 0 ? totalSearches / games : 0,
        avgClues: games > 0 ? totalClues / games : 0,
        avgOrderChanges: games > 0 ? totalOrderChanges / games : 0,
        avgRepeatSearches: games > 0 ? totalRepeatSearches / games : 0,
        capturePerSearch: totalSearches > 0 ? captureWins / totalSearches : 0,
        cluePerSearch: totalSearches > 0 ? totalClues / totalSearches : 0,
        avgMs: games > 0 ? elapsedMs / games : 0,
    };
}

function pct(v) { return `${(v * 100).toFixed(1)}%`; }

function printSummary(summary, opts) {
    if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    console.log('');
    console.log('=== VS Police 警察CPU 自己対戦ベンチマーク ===');
    console.log(`seed=${opts.seed >>> 0}  games/policy=${opts.games}  order=${opts.order}`);
    console.log('');
    console.log('policy    order  police    capture  trap   thief    avgR   search/g  clue/g  rep/g  ordΔ/g  cap/search  ms/g');
    console.log('--------------------------------------------------------------------------------------------------------');
    for (const s of summary) {
        console.log(
            `${s.policy.padEnd(9)} ${s.order.padEnd(6)} `
            + `${pct(s.policeWinRate).padStart(7)}  ${String(s.captureWins).padStart(7)}  ${String(s.trapWins).padStart(4)}  `
            + `${pct(s.thiefWinRate).padStart(7)}  ${s.avgRound.toFixed(2).padStart(5)}  `
            + `${s.avgSearches.toFixed(1).padStart(8)}  ${s.avgClues.toFixed(2).padStart(6)}  `
            + `${s.avgRepeatSearches.toFixed(1).padStart(5)}  `
            + `${s.avgOrderChanges.toFixed(2).padStart(6)}  `
            + `${pct(s.capturePerSearch).padStart(10)}  ${s.avgMs.toFixed(0).padStart(5)}`
        );
    }
    console.log('');
    console.log('capture = 捜索で発見, trap = 手詰まり, rep/g = 再捜索/局, ordΔ/g = smartが既定順と違うヘリを選んだ回数/局, cap/search = 捜索1回あたりの捕獲率');
}

/* ---------- メイン ---------- */
function main() {
    let opts;
    try {
        opts = parseArgs(process.argv);
    } catch (e) {
        console.error(`エラー: ${e.message}`);
        usage();
        process.exit(1);
    }

    const policies = opts.thief === 'all' ? POLICIES.slice() : [opts.thief];
    const orders = opts.order === 'both' ? ['smart', 'fixed'] : [opts.order];
    const summary = [];

    for (const policy of policies) {
        for (const order of orders) {
            const results = [];
            const started = Date.now();
            if (!opts.json && opts.games >= 10) {
                process.stderr.write(`[${policy}/${order}] ${opts.games} games `);
            }
            for (let i = 0; i < opts.games; i++) {
                const seed = (opts.seed + Math.imul(i + 1, 0x9E3779B9)) >>> 0;
                results.push(simulateGame(policy, seed, order, opts.verbose));
                if (!opts.json && opts.games >= 10) process.stderr.write('.');
            }
            if (!opts.json && opts.games >= 10) process.stderr.write('\n');
            summary.push(summarize(policy, order, results, Date.now() - started));
        }
    }

    printSummary(summary, opts);
}

try {
    main();
} catch (e) {
    console.error('ベンチマーク失敗:', e);
    process.exit(1);
}
