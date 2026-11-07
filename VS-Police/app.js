/* ==========================================================
   VS Police - app.js
   警察 vs 逃走車 : パス＆プレイ / CPU対戦 両対応
   ========================================================== */
(function () {
    'use strict';

    /* ---------- 定数 ---------- */
    const B_SIZE = 5;          // ビル 5x5
    const I_SIZE = 4;          // 交差点 4x4
    const TOTAL_ROUNDS = 11;
    const HELI_DEFS = [
        { id: 'green',  label: '緑', color: '#4caf50' },
        { id: 'pink',   label: '桃', color: '#e91e63' },
        { id: 'yellow', label: '黄', color: '#ffc107' }
    ];

    /* ---------- シード付き乱数（再現性のある検証用） ---------- */
    // ?seed=123 で固定（startGame のたびに同じ初期値へ戻し、再現可能）。
    // ?seed=random と未指定時（通常プレイ）は startGame ごとに新しいシード。
    const SEED_PARAM = (typeof location !== 'undefined' && location.search)
        ? new URLSearchParams(location.search).get('seed')
        : null;
    function resolveInitialSeed() {
        const raw = SEED_PARAM;
        if (raw === 'random') return Date.now() >>> 0;
        if (raw != null && raw !== '' && Number.isFinite(Number(raw))) return Number(raw) >>> 0;
        return 0x1a2b3c4d;
    }
    const INITIAL_SEED = resolveInitialSeed();
    let rngState = INITIAL_SEED >>> 0;

    function seedRandom(seed) {
        rngState = seed >>> 0;
    }
    // mulberry32
    function rand() {
        rngState = (rngState + 0x6D2B79F5) >>> 0;
        let t = rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function randInt(n) {
        return Math.floor(rand() * n);
    }

    /* ---------- 状態 ---------- */
    let S = null;              // GameState (クロージャ内に閉じ込め DOM には露出しない)

    function createState(mode) {
        // mode: 'pvp' | '3pvp' | 'cpu' | 'cpu_police'
        const is3p = mode === '3pvp';
        return {
            mode,
            currentRound: 1,
            phase: 'SETUP_POLICE',
            winner: null,
            thief: {
                carX: null, carY: null,
                history: [],
                path: [],
                visited: new Set(),
            },
            police: {
                helis: HELI_DEFS.map((d, i) => ({
                    id: d.id, label: d.label, color: d.color, index: i,
                    x: null, y: null, hasActed: false,
                    owner: is3p ? (i < 2 ? 0 : 1) : 0,  // 3pvp: 緑桃=A(0), 黄=B(1)
                })),
                selected: 0,
                subPlayer: 0,   // 3pvp時の現在行動中の警察プレイヤー (0=A, 1=B)
            },
            buildings: Array.from({ length: B_SIZE }, (_, y) =>
                Array.from({ length: B_SIZE }, (_, x) => ({
                    x, y, isSearched: false, searchedRound: null,
                    clue: null, clueRevealed: false
                }))
            ),
            revealedClues: [],
            searchLog: [],       // 警察が行った捜索 { round, x, y, result: 'empty' | 'clue' }
            logs: [],
            transitioning: false,
        };
    }

    /* ---------- DOM ---------- */
    const $ = (sel) => document.querySelector(sel);
    let boardContainer, buildingsLayer, intersectionsLayer, searchlightLayer;
    let roundTrackEl, phaseLabelEl, turnLabelEl, logAreaEl, helpTextEl, cluesRevealedEl;
    let heliStatusEl, heliButtonsEl, hintBarEl, btnEndPoliceTurn;
    let blindOverlay, blindTitle, blindMessage, blindConfirmBtn;
    let splashScreen, gameoverModal, gameoverIcon, gameoverTitle, gameoverMessage;
    let routeModal, routeCanvas;
    let btnRotateClose;

    function cacheElements() {
        boardContainer     = $('#board-container');
        buildingsLayer     = $('#buildings-layer');
        intersectionsLayer = $('#intersections-layer');
        searchlightLayer   = $('#searchlight-layer');
        roundTrackEl    = $('#round-track');
        phaseLabelEl    = $('#phase-label');
        turnLabelEl     = $('#turn-label');
        logAreaEl       = $('#log-area');
        helpTextEl      = $('#help-text');
        cluesRevealedEl = $('#clues-revealed');
        heliStatusEl    = $('#heli-status');
        heliButtonsEl   = $('#heli-buttons');
        hintBarEl       = $('#hint-bar');
        btnEndPoliceTurn= $('#btn-end-police-turn');
        blindOverlay    = $('#blind-overlay');
        blindTitle      = $('#blind-title');
        blindMessage    = $('#blind-message');
        blindConfirmBtn = $('#blind-confirm-btn');
        splashScreen    = $('#splash-screen');
        gameoverModal   = $('#gameover-modal');
        gameoverIcon    = $('#gameover-icon');
        gameoverTitle   = $('#gameover-title');
        gameoverMessage = $('#gameover-message');
        routeModal      = $('#route-modal');
        routeCanvas     = $('#route-canvas');
        btnRotateClose  = $('#btn-rotate-close');
    }

    /* ---------- タッチフィードバック（Android のバイブレーション） ---------- */
    function buzz(pattern) {
        try {
            if (navigator.vibrate) navigator.vibrate(pattern);
        } catch (e) { /* 非対応環境では何もしない */ }
    }

    /* ---------- 盤面 DOM 生成 ---------- */
    function buildBoardDOM() {
        buildingsLayer.innerHTML = '';
        intersectionsLayer.innerHTML = '';
        for (let by = 0; by < B_SIZE; by++) {
            for (let bx = 0; bx < B_SIZE; bx++) {
                const el = document.createElement('div');
                el.className = 'building';
                el.dataset.bx = bx; el.dataset.by = by;
                el.style.gridColumn = String(bx * 2 + 1);
                el.style.gridRow    = String(by * 2 + 1);
                el.innerHTML = `<span class="coord">${bx},${by}</span>`;
                el.addEventListener('click', () => onBuildingClick(bx, by));
                buildingsLayer.appendChild(el);
            }
        }
        for (let iy = 0; iy < I_SIZE; iy++) {
            for (let ix = 0; ix < I_SIZE; ix++) {
                const el = document.createElement('div');
                el.className = 'intersection';
                el.dataset.ix = ix; el.dataset.iy = iy;
                el.style.gridColumn = String(ix * 2 + 2);
                el.style.gridRow    = String(iy * 2 + 2);
                el.addEventListener('click', () => onIntersectionClick(ix, iy));
                intersectionsLayer.appendChild(el);
            }
        }
    }

    /* ---------- ユーティリティ ---------- */
    const key = (x, y) => `${x},${y}`;
    function buildingEl(x, y) {
        return buildingsLayer.querySelector(`.building[data-bx="${x}"][data-by="${y}"]`);
    }
    function intersectionEl(ix, iy) {
        return intersectionsLayer.querySelector(`.intersection[data-ix="${ix}"][data-iy="${iy}"]`);
    }
    // 交差点 (ix,iy) に隣接する 4 ビル
    function adjacentBuildings(ix, iy) {
        return [
            { x: ix,     y: iy     },
            { x: ix + 1, y: iy     },
            { x: ix,     y: iy + 1 },
            { x: ix + 1, y: iy + 1 },
        ];
    }
    // 犯人の移動先候補 (マンハッタン距離1・盤面内・未訪問)
    function validCarMoves() {
        if (S.thief.carX == null) return [];
        const { carX: x, carY: y } = S.thief;
        const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
        const res = [];
        for (const [dx, dy] of dirs) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
            if (S.thief.visited.has(key(nx, ny))) continue;
            res.push({ x: nx, y: ny });
        }
        return res;
    }
    // ヘリの移動先候補 (マンハッタン距離1・盤面内・他ヘリなし)
    function validHeliMoves(heli) {
        if (heli.x == null) return [];
        const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
        const res = [];
        for (const [dx, dy] of dirs) {
            const nx = heli.x + dx, ny = heli.y + dy;
            if (nx < 0 || ny < 0 || nx >= I_SIZE || ny >= I_SIZE) continue;
            if (S.police.helis.some(h => h !== heli && h.x === nx && h.y === ny)) continue;
            res.push({ x: nx, y: ny });
        }
        return res;
    }
    // ヘリが捜索可能なビル（再捜索可）
    function searchableBuildings(heli) {
        if (heli.x == null) return [];
        return adjacentBuildings(heli.x, heli.y)
            .filter(b => b.x < B_SIZE && b.y < B_SIZE);
    }
    // ラウンドに対応する痕跡タイプ
    function clueTypeForRound(round) {
        if (round === 1) return 'YELLOW';
        if (round === 6) return 'RED';
        return 'BLUE';
    }
    const clueLabel = { YELLOW: '黄', RED: '赤', BLUE: '青' };

    /* ==========================================================
       事後分布推定（自己回避経路の列挙）
       犯人は同じビルに二度入れないため、痕跡・空振り捜索と整合する
       自己回避経路を全列挙し、現在位置（経路の終点）を数え上げる。
       ========================================================== */
    const POSTERIOR_CACHE = { key: null, result: null };

    function posteriorSignature(state) {
        const clues = (state.revealedClues || [])
            .map(c => `${c.x},${c.y},${c.type}`)
            .sort()
            .join(';');
        const empties = (state.searchLog || [])
            .filter(s => s.result === 'empty')
            .map(s => `${s.round},${s.x},${s.y}`)
            .sort()
            .join(';');
        return `${state.currentRound}|${clues}|${empties}`;
    }

    /* 返り値: { counts, total, probs, cells, visitProb, visitByIndex, infoGain }
       counts[cell] = そのマスで終わる整合経路数
       probs[cell]  = counts / total
       cells        = 確率降順の { x, y, p } 配列
       visitProb[ci]        = そのマスが過去（index <= R-2）に訪問された確率（痕跡がある確率）
       visitByIndex[ci*11+i]= そのマスが index i に訪問された確率
       infoGain[ci]         = そのマスを捜索したときの終点分布エントロピーの期待減少量（bit） */
    function thiefPosterior(state = S) {
        const N = B_SIZE * B_SIZE;
        const counts = new Float64Array(N);
        const emptyResult = {
            counts, total: 0, probs: new Float64Array(N), cells: [],
            visitProb: new Float64Array(N),
            visitByIndex: new Float64Array(N * 11),
            infoGain: new Float64Array(N),
        };
        if (!state || !state.currentRound) return emptyResult;

        const R = state.currentRound;
        const maxIdx = R - 1;              // 警察フェーズ R のときの経路インデックス
        if (maxIdx < 0) return emptyResult;

        // --- 痕跡チップの制約 ---
        // YELLOW = index 0, RED = index 5, BLUE = 1..4, 6..10。
        // 警察フェーズ R で存在し得るのは index <= R-2 の痕跡だけ。
        const clueAt = new Int16Array(N).fill(-1);
        const clueAllowed = [];            // 各痕跡で許される経路インデックスのビットマスク
        const clueMaxIdx = [];
        const seenClueCells = new Set();
        for (const c of state.revealedClues || []) {
            if (c.x < 0 || c.x >= B_SIZE || c.y < 0 || c.y >= B_SIZE) continue;
            const ci = c.y * B_SIZE + c.x;
            if (seenClueCells.has(ci)) continue;
            seenClueCells.add(ci);
            let allowedIndices;
            if (c.type === 'YELLOW') allowedIndices = [0];
            else if (c.type === 'RED') allowedIndices = [5];
            else allowedIndices = [1, 2, 3, 4, 6, 7, 8, 9, 10];
            let mask = 0;
            let maxAllowed = -1;
            for (const i of allowedIndices) {
                if (i <= maxIdx - 1) {
                    mask |= (1 << i);
                    if (i > maxAllowed) maxAllowed = i;
                }
            }
            // この時点で存在し得ない痕跡（不整合）は無視して防御的に進む
            if (mask === 0) continue;
            const clueIndex = clueAllowed.length;
            clueAllowed.push(mask);
            clueMaxIdx.push(maxAllowed);
            clueAt[ci] = clueIndex;
        }

        // --- 空振り捜索の制約 ---
        // ラウンド r に空振りしたビルは、index <= r-1 のどの時点でも
        // 犯人が滞在していなかった（滞在していれば痕跡が残っている）。
        const forbiddenUntil = new Int8Array(N).fill(-1);
        for (const s of state.searchLog || []) {
            if (s.result !== 'empty') continue;
            const i = s.round - 1;
            if (i < 0 || i > maxIdx) continue;
            const ci = s.y * B_SIZE + s.x;
            if (i > forbiddenUntil[ci]) forbiddenUntil[ci] = i;
        }

        // 黄チップがあれば開始マスは確定
        let forcedStart = -1;
        for (let ci = 0; ci < N; ci++) {
            if (clueAt[ci] >= 0 && (clueAllowed[clueAt[ci]] & 1)) {
                forcedStart = ci;
                break;
            }
        }

        const allCluesMask = clueAllowed.length === 0 ? 0 : (1 << clueAllowed.length) - 1;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        let total = 0;
        // タスク1用: 経路スタックと、訪問/捜索結果分岐の集計
        // outcomeCounts[(ci*5+cls)*N + endpoint]: cls 0=発見 1=黄 2=赤 3=青 4=空
        const pathStack = [];
        const visitCounts = new Float64Array(N);
        const visitByIndexCounts = new Float64Array(N * 11);
        const outcomeCounts = new Float64Array(N * 5 * N);

        function dfs(idx, pos, visitedMask, satisfiedMask) {
            pathStack.push(pos);
            // 満たせなくなる痕跡を枝刈り
            for (let k = 0; k < clueAllowed.length; k++) {
                if ((satisfiedMask & (1 << k)) === 0 && clueMaxIdx[k] < idx) { pathStack.pop(); return; }
            }
            if (idx === maxIdx) {
                if (satisfiedMask === allCluesMask) {
                    counts[pos] += 1;
                    total += 1;
                    // 過去訪問（痕跡）の集計
                    for (let i = 0; i < maxIdx; i++) {
                        const ci = pathStack[i];
                        visitCounts[ci] += 1;
                        visitByIndexCounts[ci * 11 + i] += 1;
                    }
                    // 捜索結果の分岐ごとに終点を集計（期待情報利得の計算用）
                    for (let c = 0; c < N; c++) {
                        let cls;
                        if (c === pos) cls = 0;
                        else {
                            const ii = pathStack.indexOf(c);
                            if (ii < 0 || ii >= maxIdx) cls = 4;
                            else if (ii === 0) cls = 1;
                            else if (ii === 5) cls = 2;
                            else cls = 3;
                        }
                        outcomeCounts[(c * 5 + cls) * N + pos] += 1;
                    }
                }
                pathStack.pop();
                return;
            }
            const x = pos % B_SIZE;
            const y = (pos / B_SIZE) | 0;
            const nextIdx = idx + 1;
            for (const [dx, dy] of dirs) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
                const np = ny * B_SIZE + nx;
                if (visitedMask & (1 << np)) continue;
                if (nextIdx <= forbiddenUntil[np]) continue;
                let ns = satisfiedMask;
                const clueIndex = clueAt[np];
                if (clueIndex >= 0) {
                    if ((clueAllowed[clueIndex] & (1 << nextIdx)) === 0) continue;
                    ns |= (1 << clueIndex);
                }
                dfs(nextIdx, np, visitedMask | (1 << np), ns);
            }
            pathStack.pop();
        }

        const startCandidates = [];
        if (forcedStart >= 0) startCandidates.push(forcedStart);
        else for (let ci = 0; ci < N; ci++) startCandidates.push(ci);
        for (const sp of startCandidates) {
            if (forbiddenUntil[sp] >= 0) continue;
            let sm = 0;
            const clueIndex = clueAt[sp];
            if (clueIndex >= 0) {
                if ((clueAllowed[clueIndex] & 1) === 0) continue;
                sm |= (1 << clueIndex);
            }
            dfs(0, sp, 1 << sp, sm);
        }

        const probs = new Float64Array(N);
        if (total > 0) {
            for (let i = 0; i < N; i++) probs[i] = counts[i] / total;
        } else {
            // 観測が矛盾している場合の防御的フォールバック。
            // 現在ラウンドに空振り済みのマスと痕跡マスだけを除外して一様分布にする。
            let n = 0;
            for (let ci = 0; ci < N; ci++) {
                if (clueAt[ci] >= 0) continue;
                if (maxIdx <= forbiddenUntil[ci]) continue;
                probs[ci] = 1;
                n++;
            }
            if (n === 0) {
                probs.fill(1 / N);
            } else {
                for (let i = 0; i < N; i++) if (probs[i] > 0) probs[i] = 1 / n;
            }
        }

        const cells = [];
        for (let ci = 0; ci < N; ci++) {
            if (probs[ci] > 0) {
                cells.push({ x: ci % B_SIZE, y: (ci / B_SIZE) | 0, p: probs[ci] });
            }
        }
        cells.sort((a, b) => b.p - a.p || a.y - b.y || a.x - b.x);

        // タスク1: 訪問確率と期待情報利得（total=0 のフォールバック時はすべて 0）
        const visitProb = new Float64Array(N);
        const visitByIndex = new Float64Array(N * 11);
        const infoGain = new Float64Array(N);
        if (total > 0) {
            for (let i = 0; i < N; i++) visitProb[i] = visitCounts[i] / total;
            for (let i = 0; i < N * 11; i++) visitByIndex[i] = visitByIndexCounts[i] / total;
            let hNow = 0;
            for (let i = 0; i < N; i++) {
                if (probs[i] > 0) hNow -= probs[i] * Math.log2(probs[i]);
            }
            for (let c = 0; c < N; c++) {
                let expected = 0;
                for (let cls = 0; cls < 5; cls++) {
                    const base = (c * 5 + cls) * N;
                    let clsTotal = 0;
                    for (let e = 0; e < N; e++) clsTotal += outcomeCounts[base + e];
                    if (clsTotal <= 0) continue;
                    const pCls = clsTotal / total;
                    if (cls === 0) continue; // 発見なら終点は確定（エントロピー 0）
                    let h = 0;
                    for (let e = 0; e < N; e++) {
                        const cnt = outcomeCounts[base + e];
                        if (cnt > 0) {
                            const p = cnt / clsTotal;
                            h -= p * Math.log2(p);
                        }
                    }
                    expected += pCls * h;
                }
                infoGain[c] = Math.max(0, hNow - expected);
            }
        }
        return { counts, total, probs, cells, visitProb, visitByIndex, infoGain };
    }

    function getPosterior(state = S) {
        const key = posteriorSignature(state);
        if (POSTERIOR_CACHE.key === key) return POSTERIOR_CACHE.result;
        const result = thiefPosterior(state);
        POSTERIOR_CACHE.key = key;
        POSTERIOR_CACHE.result = result;
        return result;
    }

    function inferredCandidates(state = S) {
        return getPosterior(state).cells.slice();
    }

    /* ==========================================================
       タスク2: 整合経路そのものの列挙と伝播分析
       終点集計では失われる「訪問済み集合」の情報を保持し、
       次ラウンドの分布・強制移動先・手詰まり確率を導く。
       ========================================================== */
    const PATHS_CACHE = { key: null, result: null };

    /* thiefPosterior と同じ制約で、整合する経路（セルindexの配列）を全て返す。 */
    function enumerateConsistentPaths(state = S) {
        const N = B_SIZE * B_SIZE;
        if (!state || !state.currentRound) return [];
        const R = state.currentRound;
        const maxIdx = R - 1;
        if (maxIdx < 0) return [];

        const clueAt = new Int16Array(N).fill(-1);
        const clueAllowed = [];
        const clueMaxIdx = [];
        const seenClueCells = new Set();
        for (const c of state.revealedClues || []) {
            if (c.x < 0 || c.x >= B_SIZE || c.y < 0 || c.y >= B_SIZE) continue;
            const ci = c.y * B_SIZE + c.x;
            if (seenClueCells.has(ci)) continue;
            seenClueCells.add(ci);
            let allowedIndices;
            if (c.type === 'YELLOW') allowedIndices = [0];
            else if (c.type === 'RED') allowedIndices = [5];
            else allowedIndices = [1, 2, 3, 4, 6, 7, 8, 9, 10];
            let mask = 0;
            let maxAllowed = -1;
            for (const i of allowedIndices) {
                if (i <= maxIdx - 1) {
                    mask |= (1 << i);
                    if (i > maxAllowed) maxAllowed = i;
                }
            }
            if (mask === 0) continue;
            clueAt[ci] = clueAllowed.length;
            clueAllowed.push(mask);
            clueMaxIdx.push(maxAllowed);
        }
        const forbiddenUntil = new Int8Array(N).fill(-1);
        for (const s of state.searchLog || []) {
            if (s.result !== 'empty') continue;
            const i = s.round - 1;
            if (i < 0 || i > maxIdx) continue;
            const ci = s.y * B_SIZE + s.x;
            if (i > forbiddenUntil[ci]) forbiddenUntil[ci] = i;
        }
        let forcedStart = -1;
        for (let ci = 0; ci < N; ci++) {
            if (clueAt[ci] >= 0 && (clueAllowed[clueAt[ci]] & 1)) { forcedStart = ci; break; }
        }
        const allCluesMask = clueAllowed.length === 0 ? 0 : (1 << clueAllowed.length) - 1;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const paths = [];
        const stack = [];

        function dfs(idx, pos, visitedMask, satisfiedMask) {
            stack.push(pos);
            for (let k = 0; k < clueAllowed.length; k++) {
                if ((satisfiedMask & (1 << k)) === 0 && clueMaxIdx[k] < idx) { stack.pop(); return; }
            }
            if (idx === maxIdx) {
                if (satisfiedMask === allCluesMask) paths.push(stack.slice());
                stack.pop();
                return;
            }
            const x = pos % B_SIZE;
            const y = (pos / B_SIZE) | 0;
            const nextIdx = idx + 1;
            for (const [dx, dy] of dirs) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
                const np = ny * B_SIZE + nx;
                if (visitedMask & (1 << np)) continue;
                if (nextIdx <= forbiddenUntil[np]) continue;
                let ns = satisfiedMask;
                const clueIndex = clueAt[np];
                if (clueIndex >= 0) {
                    if ((clueAllowed[clueIndex] & (1 << nextIdx)) === 0) continue;
                    ns |= (1 << clueIndex);
                }
                dfs(nextIdx, np, visitedMask | (1 << np), ns);
            }
            stack.pop();
        }

        const startCandidates = [];
        if (forcedStart >= 0) startCandidates.push(forcedStart);
        else for (let ci = 0; ci < N; ci++) startCandidates.push(ci);
        for (const sp of startCandidates) {
            if (forbiddenUntil[sp] >= 0) continue;
            let sm = 0;
            const clueIndex = clueAt[sp];
            if (clueIndex >= 0) {
                if ((clueAllowed[clueIndex] & 1) === 0) continue;
                sm |= (1 << clueIndex);
            }
            dfs(0, sp, 1 << sp, sm);
        }
        return paths;
    }

    /* 経路集合から次ラウンド分布・手詰まり・強制移動先を導く。 */
    function analyzeConsistentPaths(paths) {
        const N = B_SIZE * B_SIZE;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const nextCounts = new Float64Array(N);
        const endpointCounts = new Float64Array(N);
        const nextSetByEndpoint = new Map(); // endpoint ci -> Set(next ci)
        let trapCount = 0;
        for (const path of paths) {
            const endpoint = path[path.length - 1];
            endpointCounts[endpoint] += 1;
            const visited = new Set(path);
            const ex = endpoint % B_SIZE;
            const ey = (endpoint / B_SIZE) | 0;
            const moves = [];
            for (const [dx, dy] of dirs) {
                const nx = ex + dx;
                const ny = ey + dy;
                if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
                const np = ny * B_SIZE + nx;
                if (!visited.has(np)) moves.push(np);
            }
            if (moves.length === 0) { trapCount += 1; continue; }
            // 犯人が合法手から一様に選ぶ前提で次分布へ配分する
            const w = 1 / moves.length;
            let set = nextSetByEndpoint.get(endpoint);
            if (!set) { set = new Set(); nextSetByEndpoint.set(endpoint, set); }
            for (const m of moves) {
                nextCounts[m] += w;
                set.add(m);
            }
        }
        const nonTrap = paths.length - trapCount;
        const nextProbs = new Float64Array(N);
        if (nonTrap > 0) {
            for (let i = 0; i < N; i++) nextProbs[i] = nextCounts[i] / nonTrap;
        }
        const nextCells = [];
        for (let ci = 0; ci < N; ci++) {
            if (nextProbs[ci] > 0) {
                nextCells.push({ x: ci % B_SIZE, y: (ci / B_SIZE) | 0, p: nextProbs[ci] });
            }
        }
        nextCells.sort((a, b) => b.p - a.p || a.y - b.y || a.x - b.x);
        const forcedByEndpoint = new Map();
        for (const [endpoint, set] of nextSetByEndpoint) {
            if (set.size === 1) forcedByEndpoint.set(endpoint, [...set][0]);
        }
        return {
            total: paths.length,
            trapCount,
            trapProb: paths.length > 0 ? trapCount / paths.length : 0,
            endpointCounts,
            nextCounts,
            nextProbs,
            propagated: { probs: nextProbs, cells: nextCells, total: nonTrap, counts: nextCounts },
            forcedByEndpoint,
        };
    }

    function getPathAnalysis(state = S) {
        const key = posteriorSignature(state);
        if (PATHS_CACHE.key === key && PATHS_CACHE.result) return PATHS_CACHE.result;
        const paths = enumerateConsistentPaths(state);
        const analysis = analyzeConsistentPaths(paths);
        const result = { paths, analysis, propagated: analysis.propagated, forcedByEndpoint: analysis.forcedByEndpoint };
        PATHS_CACHE.key = key;
        PATHS_CACHE.result = result;
        return result;
    }

    /* ---------- ログ ---------- */
    const LOG_MAX = 200;
    function addLog(msg, cls = 'log-info') {
        S.logs.push({ msg, cls });
        const div = document.createElement('div');
        div.className = 'log-entry ' + cls;
        div.textContent = msg;
        logAreaEl.appendChild(div);
        // 長時間プレイでもDOMが膨らまないよう上限で先頭を剪定
        while (logAreaEl.children.length > LOG_MAX) {
            logAreaEl.removeChild(logAreaEl.firstChild);
        }
        logAreaEl.scrollTop = logAreaEl.scrollHeight;
    }

    /* ---------- 捜索結果バッジ「いない」 ---------- */
    let pendingSearchBadge = null; // { bx, by, timer }
    function showSearchResultBadge(bx, by) {
        // 既存の保留バッジがあればクリア
        if (pendingSearchBadge && pendingSearchBadge.timer) clearTimeout(pendingSearchBadge.timer);
        pendingSearchBadge = { bx, by, timer: null };
        applySearchBadgeDom();
        pendingSearchBadge.timer = setTimeout(() => {
            pendingSearchBadge = null;
            const existing = buildingsLayer.querySelector('.search-result-badge');
            if (existing) existing.remove();
        }, 2000);
    }
    function applySearchBadgeDom() {
        if (!pendingSearchBadge) return;
        const el = buildingEl(pendingSearchBadge.bx, pendingSearchBadge.by);
        if (!el) return;
        if (el.querySelector('.search-result-badge')) return;
        const badge = document.createElement('div');
        badge.className = 'search-result-badge';
        badge.textContent = 'いない';
        el.appendChild(badge);
    }

    /* ==========================================================
       描画
       ========================================================== */
    /* 犯人ビュー相当のフェーズかどうか（盤面に車・全経路を出す対象） */
    function isThiefViewPhase() {
        return (S.phase === 'ROUND_THIEF' || S.phase === 'SETUP_THIEF' || S.phase === 'GAME_OVER'
            || (S.mode === 'cpu_police' && S.phase === 'ROUND_POLICE'));
    }

    function render() {
        // 犯人ターン中は警察専用パネルを畳んで盤面優先のレイアウトに
        // （犯人ソロプレイの犯人フェーズも含まれる。警察ソロ＝cpuモードは警察ビュー維持）
        const thiefView = (S.phase === 'ROUND_THIEF' || S.phase === 'SETUP_THIEF')
            && S.mode !== 'cpu';
        document.body.classList.toggle('thief-view', thiefView);
        renderRoundTrack();
        renderPhaseIndicator();
        renderBoard();
        applySearchBadgeDom(); // renderBoard が DOM を再構築するため、バッジを再適用
        renderControlPanel();
        renderCluesRevealed();
        renderSearchlight();
    }

    function renderRoundTrack() {
        roundTrackEl.innerHTML = '';
        for (let r = 1; r <= TOTAL_ROUNDS; r++) {
            const step = document.createElement('div');
            step.className = 'round-step';
            if (r === 1) step.classList.add('r1');
            if (r === 6) step.classList.add('r6');
            if (r < S.currentRound) step.classList.add('done');
            if (r === S.currentRound && S.phase !== 'GAME_OVER') step.classList.add('active');
            step.textContent = String(r);
            // 痕跡タイプのドット
            const dot = document.createElement('span');
            dot.className = 'dot';
            const ct = clueTypeForRound(r);
            dot.style.background = ct === 'YELLOW' ? '#ffd54f' : ct === 'RED' ? '#ef5350' : '#42a5f5';
            step.appendChild(dot);
            roundTrackEl.appendChild(step);
        }
    }

    function renderPhaseIndicator() {
        const p = S.phase;
        let label = '', turn = '', cls = '';
        switch (p) {
            case 'SETUP_POLICE':   label = 'セットアップ'; turn = '🚁 ヘリ配置'; cls = 'setup'; break;
            case 'SETUP_THIEF_WAIT':label = '交代';        turn = '🙈 ブラインド'; cls = ''; break;
            case 'SETUP_THIEF':    label = 'セットアップ'; turn = '🚗 潜伏配置'; cls = 'thief'; break;
            case 'ROUND_POLICE':
                label = `Round ${S.currentRound}`;
                if (S.mode === '3pvp') {
                    turn = S.police.subPlayer === 0 ? '👮 警察Aのターン' : '👮 警察Bのターン';
                } else if (S.mode === 'cpu_police') {
                    turn = '🤖 警察CPU思考中';
                } else {
                    turn = '👮 警察ターン';
                }
                cls = 'police';
                break;
            case 'THIEF_WAIT':     label = `Round ${S.currentRound}`; turn = '🙈 ブラインド'; cls = ''; break;
            case 'ROUND_THIEF':    label = `Round ${S.currentRound}`; turn = '🚗 犯人ターン'; cls = 'thief'; break;
            case 'GAME_OVER':      label = '終了'; turn = S.winner === 'POLICE' ? '👮 警察勝利!' : '🚗 犯人勝利!'; cls = ''; break;
            default: label = '待機'; turn = '--';
        }
        phaseLabelEl.textContent = label;
        turnLabelEl.textContent = turn;
        turnLabelEl.className = 'turn-label ' + cls;
    }

    function renderBoard() {
        const isThiefView = isThiefViewPhase();
        const showCar = isThiefView || S.winner !== null;

        // ビル描画
        for (let by = 0; by < B_SIZE; by++) {
            for (let bx = 0; bx < B_SIZE; bx++) {
                const b = S.buildings[by][bx];
                const el = buildingEl(bx, by);
                if (!el) continue;
                // クラスリセット
                el.className = 'building';
                el.innerHTML = `<span class="coord">${bx},${by}</span>`;

                // 犯人ビュー / ゲームオーバー時は痕跡を可視化
                if (isThiefView && b.clue) {
                    const chip = document.createElement('div');
                    chip.className = 'clue-chip ' + b.clue.toLowerCase();
                    chip.textContent = clueLabel[b.clue];
                    el.appendChild(chip);
                    el.classList.add('thief-visited');
                    // 犯人ソロ: 未発見の痕跡はグレーアウトし、警察に発見された
                    // 痕跡は通常表示のまま赤線で囲んで区別する
                    if (S.mode === 'cpu_police') {
                        if (b.clueRevealed) {
                            el.classList.add('clue-discovered');
                        } else {
                            chip.classList.add('clue-undiscovered');
                            el.classList.add('thief-visited-undiscovered');
                        }
                    }
                }
                // 警察に開示された痕跡 (clueRevealed) は常時表示
                if (!isThiefView && b.clueRevealed) {
                    const chip = document.createElement('div');
                    chip.className = 'clue-chip ' + b.clue.toLowerCase();
                    chip.textContent = clueLabel[b.clue];
                    el.appendChild(chip);
                }
                // 捜索済みで痕跡未開示 (空)
                if (b.isSearched && !b.clueRevealed) {
                    el.classList.add('searched-empty');
                }
                // 犯人の車 (DOM に座標を埋め込まないよう、描画は犯人ビュー/終了時のみ)
                if (showCar && S.thief.carX === bx && S.thief.carY === by) {
                    const car = document.createElement('div');
                    car.className = 'car-icon';
                    car.textContent = '🚗';
                    // 犯人ソロ: 警察ターン中は車をグレーアウトする
                    // （犯人が操作するターンのみ通常表示）
                    if (S.mode === 'cpu_police' && S.phase === 'ROUND_POLICE') {
                        car.classList.add('car-grayed');
                    }
                    el.appendChild(car);
                    if (b.clue) {
                        // 車と痕跡が重なる場合は痕跡を上に
                        el.style.position = 'relative';
                    }
                }
                // 犯人発見演出
                if (S.winner === 'POLICE' && S.thief.carX === bx && S.thief.carY === by) {
                    el.classList.add('found-car');
                }

                // インタラクション: 捜索対象 (モード切替なしで常時表示)
                if (S.phase === 'ROUND_POLICE') {
                    const heli = S.police.helis[S.police.selected];
                    if (heli && !heli.hasActed && heli.x != null) {
                        const targets = searchableBuildings(heli);
                        if (targets.some(t => t.x === bx && t.y === by)) {
                            el.classList.add('searchable');
                        }
                    }
                }
                // インタラクション: 犯人の移動先
                if (S.phase === 'ROUND_THIEF') {
                    const moves = validCarMoves();
                    if (moves.some(m => m.x === bx && m.y === by)) {
                        el.classList.add('selectable-thief');
                    }
                }
                // インタラクション: 犯人の初期配置
                if (S.phase === 'SETUP_THIEF') {
                    if (!S.thief.visited.has(key(bx, by))) {
                        el.classList.add('selectable-setup');
                    }
                }
            }
        }

        // 交差点 + ヘリ描画
        for (let iy = 0; iy < I_SIZE; iy++) {
            for (let ix = 0; ix < I_SIZE; ix++) {
                const el = intersectionEl(ix, iy);
                if (!el) continue;
                el.className = 'intersection';
                el.innerHTML = '';
                const heli = S.police.helis.find(h => h.x === ix && h.y === iy);
                if (heli) {
                    const h = document.createElement('div');
                    h.className = 'heli ' + heli.id;
                    if (S.police.selected === heli.index && S.phase === 'ROUND_POLICE') h.classList.add('selected');
                    if (heli.hasActed) h.classList.add('acted');
                    h.textContent = '🚁';
                    h.title = `${heli.label}ヘリ` + (S.mode === '3pvp' ? ` (警察${heli.owner === 0 ? 'A' : 'B'})` : '');
                    // 3pvp: 所属バッジ
                    if (S.mode === '3pvp') {
                        const badge = document.createElement('span');
                        badge.className = 'heli-badge';
                        badge.textContent = heli.owner === 0 ? 'A' : 'B';
                        h.appendChild(badge);
                    }
                    h.addEventListener('click', (e) => {
                        e.stopPropagation();
                        onHeliSelect(heli.index);
                    });
                    el.appendChild(h);
                }
                // ヘリ配置 / 移動先候補
                if (S.phase === 'SETUP_POLICE') {
                    if (!heli) el.classList.add('setup-target');
                }
                if (S.phase === 'ROUND_POLICE') {
                    const cur = S.police.helis[S.police.selected];
                    if (cur && !cur.hasActed && cur.x != null) {
                        const moves = validHeliMoves(cur);
                        if (moves.some(m => m.x === ix && m.y === iy)) {
                            el.classList.add('move-target');
                        }
                    }
                }
            }
        }
    }

    function renderSearchlight() {
        searchlightLayer.innerHTML = '';
        if (S.phase !== 'ROUND_POLICE') return;
        const heli = S.police.helis[S.police.selected];
        if (!heli || heli.hasActed || heli.x == null) return;
        // 交差点の中心位置を計算してラジアルグラデーションを配置
        const inter = intersectionEl(heli.x, heli.y);
        if (!inter) return;
        const boardRect = boardContainer.getBoundingClientRect();
        const iRect = inter.getBoundingClientRect();
        const cx = iRect.left - boardRect.left + iRect.width / 2;
        const cy = iRect.top - boardRect.top + iRect.height / 2;
        const light = document.createElement('div');
        light.className = 'searchlight';
        const size = iRect.width * 5;
        light.style.width = size + 'px';
        light.style.height = size + 'px';
        light.style.left = (cx - size / 2) + 'px';
        light.style.top  = (cy - size / 2) + 'px';
        searchlightLayer.appendChild(light);
    }

    function renderControlPanel() {
        // 警察サブプレイヤー表示 (3pvpのみ)
        const subIndicator = document.getElementById('police-sub-indicator');
        if (subIndicator) {
            if (S.mode === '3pvp' && S.phase === 'ROUND_POLICE') {
                subIndicator.style.display = 'flex';
                subIndicator.innerHTML = `
                    <span class="sub-player ${S.police.subPlayer === 0 ? 'active' : ''}">👮 警察A <small>(緑+桃)</small></span>
                    <span class="sub-player ${S.police.subPlayer === 1 ? 'active' : ''}">👮 警察B <small>(黄)</small></span>`;
            } else {
                subIndicator.style.display = 'none';
            }
        }

        // ヘリステータス（行ごとタップして選択できる）
        heliStatusEl.innerHTML = '';
        S.police.helis.forEach((h, i) => {
            const row = document.createElement('div');
            row.className = 'heli-status-row';
            const pos = (h.x != null) ? `(${h.x},${h.y})` : '未配置';
            const ownerTag = (S.mode === '3pvp') ? `<small class="howner">${h.owner === 0 ? 'A' : 'B'}</small>` : '';
            row.innerHTML = `
                <span class="hicon ${h.id}"></span>
                <span class="hlabel">${h.label}ヘリ ${pos} ${ownerTag}</span>
                <span class="hstate ${h.hasActed ? 'acted' : 'ready'}">${h.hasActed ? '行動済' : '待機'}</span>`;
            const selectable = (S.phase === 'ROUND_POLICE' || S.phase === 'SETUP_POLICE') && !h.hasActed
                && !(S.mode === '3pvp' && S.phase === 'ROUND_POLICE' && h.owner !== S.police.subPlayer);
            if (selectable) {
                row.classList.add('tappable');
                if (S.police.selected === i) row.classList.add('is-selected');
                row.addEventListener('click', () => onHeliSelect(i));
            }
            heliStatusEl.appendChild(row);
            // ボタン
            const btn = heliButtonsEl.children[i];
            if (btn) {
                btn.classList.toggle('selected', S.police.selected === i);
                let dis = h.hasActed || (S.phase !== 'ROUND_POLICE' && S.phase !== 'SETUP_POLICE');
                if (S.mode === '3pvp' && S.phase === 'ROUND_POLICE' && h.owner !== S.police.subPlayer) dis = true;
                btn.disabled = dis;
            }
        });

        // 主アクションは「ターン終了」のみ（移動／捜索は盤面直接タップ）
        const inPolice = S.phase === 'ROUND_POLICE' && S.mode !== 'cpu_police';
        btnEndPoliceTurn.style.display = inPolice ? 'block' : 'none';
        if (inPolice) {
            const allActed = S.police.helis.every(h => h.hasActed);
            btnEndPoliceTurn.disabled = !allActed;
            btnEndPoliceTurn.textContent = allActed
                ? '🚁 警察ターン終了'
                : `🚁 警察ターン終了 (${S.police.helis.filter(h=>!h.hasActed).length}機 未行動)`;
        }

        // 盤面上部のヒントバー
        renderHintBar();
    }

    /* ヒントバー：現在の操作指示を盤面のすぐ側に大きく表示 */
    function renderHintBar() {
        helpTextEl.textContent = helpTextForPhase();
        hintBarEl.classList.remove('bar-police', 'bar-thief', 'bar-alert');
        const p = S.phase;
        const stuck = p === 'ROUND_THIEF' && validCarMoves().length === 0;
        if (stuck || p === 'GAME_OVER') hintBarEl.classList.add('bar-alert');
        else if (p === 'ROUND_THIEF' || p === 'SETUP_THIEF' || p === 'SETUP_THIEF_WAIT') hintBarEl.classList.add('bar-thief');
        else hintBarEl.classList.add('bar-police');
    }

    function helpTextForPhase() {
        switch (S.phase) {
            case 'SETUP_POLICE': {
                if (S.mode === 'cpu_police') return '🤖 警察CPUがヘリを配置中です…';
                const placed = S.police.helis.filter(h => h.x != null).length;
                return `交差点をタップしてヘリ配置 (${placed}/3)`;
            }
            case 'SETUP_THIEF':
                return 'ビルをタップして逃走車を潜伏';
            case 'ROUND_POLICE': {
                if (S.mode === 'cpu_police') return '🤖 警察CPUが捜索・移動を行っています…';
                const heli = S.police.helis[S.police.selected];
                const who = S.mode === '3pvp' ? (S.police.subPlayer === 0 ? '警察A' : '警察B') + 'さん、' : '';
                if (!heli) return who + '下のボタンでヘリを選択';
                if (heli.hasActed) return who + 'このヘリは行動済みです。他のヘリを選択してください。';
                if (heli.x == null) return who + 'ヘリを配置してください。';
                return who + '🟡 黄色く光る交差点＝移動 ／ 黄色く光るビル＝捜索をタップ';
            }
            case 'ROUND_THIEF': {
                const moves = validCarMoves();
                return moves.length === 0
                    ? '⚠️ 移動先がありません！'
                    : `🟢 光るビルをタップして移動（${moves.length}箇所）`;
            }
            case 'GAME_OVER':
                return 'ゲームが終了しました。';
            default:
                return '';
        }
    }

    function renderCluesRevealed() {
        cluesRevealedEl.innerHTML = '';
        if (S.revealedClues.length === 0) {
            cluesRevealedEl.innerHTML = '<span class="clue-empty">まだ痕跡は見つかっていません</span>';
            return;
        }
        S.revealedClues.forEach(c => {
            const badge = document.createElement('span');
            badge.className = 'clue-badge ' + c.type.toLowerCase();
            badge.textContent = `${clueLabel[c.type]} (${c.x},${c.y})`;
            cluesRevealedEl.appendChild(badge);
        });
    }

    /* ==========================================================
       イベントハンドラ
       ========================================================== */
    function onBuildingClick(bx, by) {
        if (S.phase === 'SETUP_THIEF') {
            buzz(12);
            setupThiefCar(bx, by);
            return;
        }
        if (S.phase === 'ROUND_POLICE') {
            // 犯人ソロプレイの警察フェーズは CPU の手番。盤面タップで横やりできないようロック
            if (S.mode === 'cpu_police' || S.transitioning) return;
            const heli = S.police.helis[S.police.selected];
            if (!heli || heli.hasActed || heli.x == null) return;
            const targets = searchableBuildings(heli);
            if (!targets.some(t => t.x === bx && t.y === by)) {
                // タッチ操作では「反応なし」が誤解を生むため軽くフィードバック
                addLog('そのビルは選んでいるヘリから捜索できません。🟡 光るビルをタップしてください。', 'log-alert');
                buzz([18, 26, 18]);
                return;
            }
            buzz(14);
            doSearch(heli, bx, by);
            return;
        }
        if (S.phase === 'ROUND_THIEF') {
            const moves = validCarMoves();
            if (!moves.some(m => m.x === bx && m.y === by)) {
                addLog('そのビルには移動できません。', 'log-alert');
                buzz([30, 40, 30]);
                return;
            }
            buzz(18);
            doMoveCar(bx, by);
            return;
        }
    }

    function onIntersectionClick(ix, iy) {
        if (S.phase === 'SETUP_POLICE') {
            buzz(12);
            setupHeli(ix, iy);
            return;
        }
        if (S.phase === 'ROUND_POLICE') {
            // CPU 手番中は移動・選択切替も不可
            if (S.mode === 'cpu_police' || S.transitioning) return;
            const heli = S.police.helis[S.police.selected];
            // その交差点にいるヘリ自体をタップ → 選択切替（タブレットで押しやすい）
            const parked = S.police.helis.find(h => h.x === ix && h.y === iy);
            if (parked && heli !== parked) { onHeliSelect(parked.index); return; }
            if (!heli || heli.hasActed || heli.x == null) return;
            const moves = validHeliMoves(heli);
            if (!moves.some(m => m.x === ix && m.y === iy)) {
                addLog('その交差点へは移動できません。🟡 黄色く光る交差点をタップしてください。', 'log-alert');
                buzz([18, 26, 18]);
                return;
            }
            buzz(14);
            doMoveHeli(heli, ix, iy);
            return;
        }
    }

    function onHeliSelect(index) {
        if (S.phase !== 'ROUND_POLICE' && S.phase !== 'SETUP_POLICE') return;
        if (S.phase === 'ROUND_POLICE' && (S.mode === 'cpu_police' || S.transitioning)) return;
        const heli = S.police.helis[index];
        if (!heli) return;
        if (S.phase === 'ROUND_POLICE') {
            if (heli.hasActed) { buzz([20, 30, 20]); return; }
            // 3pvp: 現在のサブプレイヤーのヘリのみ選択可
            if (S.mode === '3pvp' && heli.owner !== S.police.subPlayer) { buzz([20, 30, 20]); return; }
        }
        buzz(10);
        S.police.selected = index;
        render();
    }

    /* ==========================================================
       アクション実行
       ========================================================== */
    function setupHeli(ix, iy) {
        if (S.police.helis.some(h => h.x === ix && h.y === iy)) {
            addLog('その交差点には既にヘリがいます。', 'log-alert');
            return;
        }
        const heli = S.police.helis.find(h => h.x == null);
        if (!heli) return;
        heli.x = ix; heli.y = iy;
        addLog(`${heli.label}ヘリを (${ix},${iy}) に配置。`, 'log-police');
        // 次の未配置ヘリへ
        const next = S.police.helis.find(h => h.x == null);
        if (next) S.police.selected = next.index;
        render();
        if (!S.police.helis.some(h => h.x == null)) {
            // 全ヘリ配置完了
            afterPoliceSetup();
        }
    }

    function afterPoliceSetup() {
        if (S.mode === 'cpu') {
            cpuSetupCar();
            startRound(1);
        } else if (S.mode === 'cpu_police') {
            // 犯人ソロ: 警察配置はCPUが自動で行った後、犯人（プレイヤー）に潜伏配置させる
            S.phase = 'SETUP_THIEF';
            render();
        } else {
            switchPhase('SETUP_THIEF_WAIT');
        }
    }

    function setupThiefCar(bx, by) {
        S.thief.carX = bx; S.thief.carY = by;
        S.thief.visited.add(key(bx, by));
        S.thief.path.push({ round: 0, x: bx, y: by });
        // 警察ソロプレイでは潜伏位置をログに残さない（READ可能な情報漏洩防止）
        addLog(S.mode === 'cpu'
            ? '🤖 CPU が逃走車を潜伏させた（位置は秘密）。'
            : `逃走車を (${bx},${by}) に潜伏配置。`, 'log-thief');
        render();
        if (S.mode === 'cpu' || S.mode === 'cpu_police') {
            startRound(1);
        } else {
            showBlind(
                '犯人は画面を警察へ',
                '警察にターンを戻してください。Round 1 が開始します。',
                '👮 警察へ交代',
                () => { hideBlind(); startRound(1); }
            );
        }
    }

    function doMoveHeli(heli, ix, iy) {
        const old = `(${heli.x},${heli.y})`;
        heli.x = ix; heli.y = iy;
        heli.hasActed = true;
        addLog(`${heli.label}ヘリ ${old} → (${ix},${iy}) に移動。`, 'log-police');
        autoSelectNextHeli();
        render();
        maybeEndPolicePhase();
    }

    function doSearch(heli, bx, by) {
        heli.hasActed = true;
        const b = S.buildings[by][bx];
        b.isSearched = true;
        b.searchedRound = S.currentRound;
        addLog(`${heli.label}ヘリが (${bx},${by}) を捜索…`, 'log-police');
        if (S.thief.carX === bx && S.thief.carY === by) {
            // 発見!
            addLog(`🚨 逃走車を発見!! 警察の勝利!`, 'log-alert');
            buzz([90, 60, 90, 60, 200]);
            S.winner = 'POLICE';
            render();
            endGame('POLICE');
            return;
        }
        if (b.clue) {
            b.clueRevealed = true;
            addLog(`   → 痕跡「${clueLabel[b.clue]}」を発見!`, 'log-alert');
            buzz(50);
            if (!S.revealedClues.some(c => c.x === bx && c.y === by)) {
                S.revealedClues.push({ x: bx, y: by, type: b.clue });
            }
        } else {
            addLog(`   → 何もない (確定)。`, 'log-info');
            showSearchResultBadge(bx, by); // 「いない」バッジは空振りのときのみ（痕跡発見時はチップを隠さない）
        }
        // 警察CPUの事後分布推定用に捜索結果を記録
        S.searchLog.push({
            round: S.currentRound,
            x: bx, y: by,
            result: b.clue ? 'clue' : 'empty',
        });
        autoSelectNextHeli();
        render();
        maybeEndPolicePhase();
    }

    function autoSelectNextHeli() {
        const is3p = S.mode === '3pvp';
        if (is3p) {
            const nextSub = S.police.subPlayer === 0 ? 1 : 0;
            const nextHasUnacted = S.police.helis.some(h => !h.hasActed && h.x != null && h.owner === nextSub);
            const curHasUnacted = S.police.helis.some(h => !h.hasActed && h.x != null && h.owner === S.police.subPlayer);
            if (nextHasUnacted) {
                S.police.subPlayer = nextSub;
            } else if (!curHasUnacted) {
                // 全員行動済
            }
            const next = S.police.helis.find(h => !h.hasActed && h.x != null && h.owner === S.police.subPlayer);
            if (next) S.police.selected = next.index;
        } else {
            const next = S.police.helis.find(h => !h.hasActed && h.x != null);
            if (next) S.police.selected = next.index;
        }
    }

    function maybeEndPolicePhase() {
        if (S.transitioning) return;
        // ROUND_POLICE 時点では全ヘリ配置済みのはずなので hasActed のみで判定する
        const allActed = S.police.helis.every(h => h.hasActed);
        if (allActed && S.winner == null) {
            S.transitioning = true;
            render();
            setTimeout(() => {
                if (S.winner != null || S.phase !== 'ROUND_POLICE') { S.transitioning = false; return; }
                // 第11ラウンド警察フェーズ終了 → 犯人勝利（全モード共通）
                if (S.currentRound >= TOTAL_ROUNDS) {
                    S.transitioning = false;
                    addLog('第11ラウンドの警察フェーズ終了 — 逃走車は発見されず、犯人の勝利！', 'log-alert');
                    S.winner = 'THIEF';
                    endGame('THIEF');
                    return;
                }
                if (S.mode === 'cpu') {
                    cpuThiefTurn(() => { S.transitioning = false; });
                } else if (S.mode === 'cpu_police') {
                    // ブラインドなしで直接犯人ターンへ
                    S.phase = 'ROUND_THIEF';
                    S.transitioning = false;
                    render();
                } else {
                    switchPhase('THIEF_WAIT');
                    S.transitioning = false;
                }
            }, 900);
        }
    }

    function endPoliceTurnManually() {
        if (S.transitioning) return;
        if (S.phase !== 'ROUND_POLICE') return;
        if (!S.police.helis.every(h => h.hasActed)) {
            addLog('全てのヘリが行動してから終了してください。', 'log-alert');
            return;
        }
        // 第11ラウンド警察フェーズ終了 → 犯人勝利
        if (S.currentRound >= TOTAL_ROUNDS) {
            S.transitioning = true;
            addLog('第11ラウンドの警察フェーズ終了 — 逃走車は発見されず、犯人の勝利！', 'log-alert');
            S.winner = 'THIEF';
            endGame('THIEF');
            return;
        }
        S.transitioning = true;
        if (S.mode === 'cpu') cpuThiefTurn(() => { S.transitioning = false; });
        else { switchPhase('THIEF_WAIT'); S.transitioning = false; }
    }

    function doMoveCar(nx, ny) {
        const { carX: ox, carY: oy } = S.thief;
        const round = S.currentRound;
        const clue = clueTypeForRound(round);
        // 直前マスに痕跡を置く
        S.buildings[oy][ox].clue = clue;
        S.thief.history.push({ round, x: ox, y: oy, clueType: clue });
        // 移動
        S.thief.carX = nx; S.thief.carY = ny;
        S.thief.visited.add(key(nx, ny));
        S.thief.path.push({ round: round, x: nx, y: ny });
        // 警察ソロプレイでは移動先座標をログに出さない（警察プレイヤーが読めるため秘匿が必要）
        addLog(S.mode === 'cpu'
            ? `Round ${round}：逃走車が移動した（移動先は警察には伏せられる）。`
            : `逃走車が (${ox},${oy}) → (${nx},${ny}) へ移動。痕跡「${clueLabel[clue]}」を落下。`, 'log-thief');
        render();
        // 次のラウンドへ
        advanceRound();
    }

    function advanceRound() {
        if (S.currentRound >= TOTAL_ROUNDS) {
            // 11ラウンド終了 -> 犯人勝利
            S.winner = 'THIEF';
            endGame('THIEF');
            return;
        }
        // 手詰まりチェック (次の犯人フェーズで移動不可なら警察勝利)
        // ただし犯人フェーズ終了後なので、次は警察フェーズ。移動不可チェックは犯人フェーズ開始時に行う。
        startRound(S.currentRound + 1);
    }

    function startRound(r) {
        S.currentRound = r;
        S.police.helis.forEach(h => h.hasActed = false);
        S.police.subPlayer = 0;
        const firstReady = S.police.helis.find(h => h.x != null && (S.mode !== '3pvp' || h.owner === 0));
        if (firstReady) S.police.selected = firstReady.index;
        addLog(`=== Round ${r} 開始 ===`, 'log-info');
        if (S.mode === 'cpu_police') {
            // 警察CPUターンを自動実行
            S.phase = 'ROUND_POLICE';
            render();
            setTimeout(() => cpuPoliceTurn(), 800);
        } else {
            switchPhase('ROUND_POLICE');
        }
    }

    /* ==========================================================
       フェーズ移行 & ブラインドオーバーレイ
       ========================================================== */
    function switchPhase(nextPhase) {
        // ブラインドを挟むフェーズ
        if (nextPhase === 'SETUP_THIEF_WAIT') {
            const setupBlindTitle = S.mode === '3pvp' ? '警察A・Bは目を離してください' : '警察は目を離してください';
            showBlind(
                setupBlindTitle,
                '犯人が逃走車を潜伏させます。準備ができたらボタンを押してください。',
                '👀 見た! 犯人に交代',
                () => {
                    // 犯人ビューに切り替え
                    switchPhase('SETUP_THIEF');
                }
            );
            S.phase = 'SETUP_THIEF_WAIT';
            render();
            return;
        }
        if (nextPhase === 'THIEF_WAIT') {
            // 犯人フェーズ前に手詰まりチェック
            if (validCarMoves().length === 0) {
                addLog('⚠️ 逃走車は移動不可! 警察の勝利!', 'log-alert');
                S.winner = 'POLICE';
                endGame('POLICE');
                return;
            }
            const blindTitle3p = S.mode === '3pvp' ? '警察A・Bは目を離してください' : '警察は目を離してください';
            showBlind(
                blindTitle3p,
                '犯人が逃走車を移動させます。準備ができたらボタンを押してください。',
                '👀 見た! ターンを戻す',
                () => {
                    S.phase = 'ROUND_THIEF';
                    hideBlind();
                    render();
                }
            );
            S.phase = 'THIEF_WAIT';
            render();
            return;
        }
        // 犯人フェーズ終了 -> 警察へ交代
        if (S.phase === 'ROUND_THIEF' && nextPhase === 'ROUND_POLICE') {
            showBlind(
                '犯人は画面を警察へ',
                '警察にターンを戻してください。',
                '👮 警察へ交代',
                () => {
                    hideBlind();
                    S.phase = 'ROUND_POLICE';
                    render();
                }
            );
            return;
        }
        S.phase = nextPhase;
        if (nextPhase !== 'SETUP_THIEF_WAIT' && nextPhase !== 'THIEF_WAIT') {
            hideBlind();
        }
        render();
    }

    function showBlind(title, message, confirmLabel, cb) {
        blindTitle.textContent = title;
        blindMessage.textContent = message;
        blindConfirmBtn.textContent = confirmLabel;
        blindOverlay.classList.remove('hidden');
        blindConfirmBtn.onclick = () => { buzz(16); cb(); };
        // キーボードユーザーも即確定できるようフォーカスを運ぶ
        blindConfirmBtn.focus({ preventScroll: true });
    }
    function hideBlind() {
        blindOverlay.classList.add('hidden');
    }

    /* ==========================================================
       勝敗判定・ゲーム終了
       ========================================================== */
    function endGame(winner) {
        S.phase = 'GAME_OVER';
        S.winner = winner;
        hideBlind();
        render();
        buzz(winner === 'POLICE' ? [60, 50, 60, 50, 160] : [120, 80, 120]);
        // 全開示
        setTimeout(() => {
            gameoverModal.classList.remove('hidden');
            if (winner === 'POLICE') {
                gameoverIcon.textContent = '👮';
                gameoverTitle.textContent = '警察の勝利!';
                gameoverMessage.textContent = '逃走車を特定しました!';
            } else {
                gameoverIcon.textContent = '🚗';
                gameoverTitle.textContent = '犯人の勝利!';
                gameoverMessage.textContent = '11ラウンドにわたり逃走しきりました!';
            }
            // モーダル表示直後は操作ボタンへフォーカス
            const focusBtn = document.getElementById('btn-replay');
            if (focusBtn) focusBtn.focus({ preventScroll: true });
        }, 400);
    }

    /* ==========================================================
       CPU ロジック
       ========================================================== */
    function cpuSetupCar() {
        // ヘリの捜索圏に入るまでの移動数が最大のビルを選ぶ。
        // 同点はマンハッタン距離→壁際の順で決定的に。
        const helis = S.police.helis.filter(h => h.x != null);
        let best = null, bestScore = -Infinity;
        for (let by = 0; by < B_SIZE; by++) {
            for (let bx = 0; bx < B_SIZE; bx++) {
                let minSearch = Infinity, minMan = Infinity;
                for (const h of helis) {
                    const ds = searchDistanceForBuilding(bx, by, h.x, h.y);
                    if (ds < minSearch) minSearch = ds;
                    const dm = Math.abs(bx - h.x) + Math.abs(by - h.y);
                    if (dm < minMan) minMan = dm;
                }
                const edge = (bx === 0 || bx === B_SIZE - 1 || by === 0 || by === B_SIZE - 1) ? 1 : 0;
                const score = minSearch * 10 + minMan * 0.5 + edge * 0.2;
                if (score > bestScore) { bestScore = score; best = { x: bx, y: by }; }
            }
        }
        if (!best) best = { x: 0, y: 0 };
        S.thief.carX = best.x; S.thief.carY = best.y;
        S.thief.visited.add(key(best.x, best.y));
        S.thief.path.push({ round: 0, x: best.x, y: best.y });
        addLog(`🤖 CPU が逃走車を潜伏させた。`, 'log-thief');
    }

    function cpuThiefTurn(done) {
        // 手詰まりチェック
        const moves = validCarMoves();
        if (moves.length === 0) {
            addLog('⚠️ CPU 逃走車は移動不可! 警察の勝利!', 'log-alert');
            S.winner = 'POLICE';
            endGame('POLICE');
            if (done) done();
            return;
        }
        // ヘリから最も遠い未訪問ビルを選択
        const helis = S.police.helis.filter(h => h.x != null);
        let best = moves[0], bestScore = -Infinity;
        for (const m of moves) {
            let minDist = Infinity;
            for (const h of helis) {
                const d = Math.abs(m.x - h.x) + Math.abs(m.y - h.y);
                if (d < minDist) minDist = d;
            }
            // 壁際を好み、ヘリから遠い
            const edgeBonus = (m.x === 0 || m.x === B_SIZE - 1 || m.y === 0 || m.y === B_SIZE - 1) ? 1 : 0;
            const score = minDist + edgeBonus * 0.5;
            if (score > bestScore) { bestScore = score; best = m; }
        }
        // 少しランダム性（シード付き乱数で再現可能）
        if (rand() < 0.15 && moves.length > 1) {
            best = moves[randInt(moves.length)];
        }
        addLog(`🤖 CPU が思考中…`, 'log-info');
        setTimeout(() => {
            doMoveCar(best.x, best.y);
            if (done) done();
        }, 600);
    }

    /* ---------- 警察CPU (犯人ソロプレイ用) ---------- */

    /* ビル (bx,by) を捜索できる交差点までの最小移動数。
       ヘリの初期配置・犯人CPUの潜伏位置評価に使う。 */
    function searchDistanceForBuilding(bx, by, ix, iy) {
        let best = Infinity;
        const corners = [
            { x: bx,     y: by     },
            { x: bx - 1, y: by     },
            { x: bx,     y: by - 1 },
            { x: bx - 1, y: by - 1 },
        ];
        for (const c of corners) {
            if (c.x < 0 || c.y < 0 || c.x >= I_SIZE || c.y >= I_SIZE) continue;
            const d = Math.abs(c.x - ix) + Math.abs(c.y - iy);
            if (d < best) best = d;
        }
        return best;
    }

    function compareMinimaxSetup(a, b) {
        if (a.maxSearch !== b.maxSearch) return a.maxSearch - b.maxSearch;
        if (a.sumSearch !== b.sumSearch) return a.sumSearch - b.sumSearch;
        if (a.immediate !== b.immediate) return b.immediate - a.immediate;
        if (a.maxManhattan !== b.maxManhattan) return a.maxManhattan - b.maxManhattan;
        if (a.sumManhattan !== b.sumManhattan) return a.sumManhattan - b.sumManhattan;
        for (let i = 0; i < a.combo.length; i++) {
            if (a.combo[i].y !== b.combo[i].y) return a.combo[i].y - b.combo[i].y;
            if (a.combo[i].x !== b.combo[i].x) return a.combo[i].x - b.combo[i].x;
        }
        return 0;
    }

    /* C(16,3)=560 通りを全探索し、全候補の評価値を集める。 */
    function enumerateMinimaxSetups() {
        const intersections = [];
        for (let y = 0; y < I_SIZE; y++)
            for (let x = 0; x < I_SIZE; x++)
                intersections.push({ x, y });
        const all = [];
        let best = null;
        for (let a = 0; a < intersections.length; a++) {
            for (let b = a + 1; b < intersections.length; b++) {
                for (let c = b + 1; c < intersections.length; c++) {
                    const combo = [intersections[a], intersections[b], intersections[c]];
                    let maxSearch = 0, sumSearch = 0, immediate = 0;
                    let maxManhattan = 0, sumManhattan = 0;
                    for (let by = 0; by < B_SIZE; by++) {
                        for (let bx = 0; bx < B_SIZE; bx++) {
                            let dSearch = Infinity, dMan = Infinity;
                            for (const p of combo) {
                                const ds = searchDistanceForBuilding(bx, by, p.x, p.y);
                                if (ds < dSearch) dSearch = ds;
                                const dm = Math.abs(bx - p.x) + Math.abs(by - p.y);
                                if (dm < dMan) dMan = dm;
                            }
                            maxSearch = Math.max(maxSearch, dSearch);
                            sumSearch += dSearch;
                            if (dSearch === 0) immediate++;
                            maxManhattan = Math.max(maxManhattan, dMan);
                            sumManhattan += dMan;
                        }
                    }
                    const candidate = {
                        combo, maxSearch, sumSearch, immediate, maxManhattan, sumManhattan
                    };
                    all.push(candidate);
                    if (!best || compareMinimaxSetup(candidate, best) < 0) best = candidate;
                }
            }
        }
        return { all, best };
    }

    /* C(16,3)=560 通りを全探索し、全ビルへの最大捜索距離を最小化する。
       副次評価として合計距離・即時捜索可能数・マンハッタン距離も見る。 */
    function chooseMinimaxHeliSetup() {
        return enumerateMinimaxSetups().best;
    }

    /* タスク3改: 完全な最適（maxSearch=2, sumSearch=14）は同点が4通りしかなく、
       毎回ほぼ同じ配置に見える。そこで「最大捜索距離と即時捜索可能数は
       最適のまま、合計捜索距離は最適+1まで」の準最適プール（32通り）から
       シード付き乱数で一様に選ぶ。最悪到達距離と初手で捜せる範囲は
       最適値を保つため弱い配置にはならず、平均到達距離の悪化も
       1マスあたり最大 +0.04 に収まる（+2まで広げると実測で勝率が
       下がったため +1 に抑えた）。あわせてヘリ（色）への割当順も
       シャッフルし、見た目の繰り返しを減らす。 */
    const SETUP_SUM_TOLERANCE = 1;
    function chooseRandomMinimaxHeliSetup() {
        const { all, best } = enumerateMinimaxSetups();
        const pool = all.filter(c => c.maxSearch === best.maxSearch
            && c.immediate === best.immediate
            && c.sumSearch <= best.sumSearch + SETUP_SUM_TOLERANCE);
        const chosen = pool.length > 0 ? pool[randInt(pool.length)] : best;
        const combo = chosen.combo.slice();
        for (let i = combo.length - 1; i > 0; i--) {
            const j = randInt(i + 1);
            const tmp = combo[i];
            combo[i] = combo[j];
            combo[j] = tmp;
        }
        return { ...chosen, combo };
    }

    function cpuSetupHeli() {
        const setup = chooseRandomMinimaxHeliSetup();
        const positions = setup.combo;
        S.police.helis.forEach((h, i) => {
            h.x = positions[i].x;
            h.y = positions[i].y;
            addLog(`🤖 ${h.label}ヘリを (${h.x},${h.y}) に配置。`, 'log-police');
        });
        addLog(`🤖 警察CPU: minimax配置（全ビルへの最大捜索距離 ${setup.maxSearch}）`, 'log-info');
        render();
    }

    /* ---------- 事後分布を使った警察CPUの意思決定 ---------- */
    // タスク1: 情報利得の重み。infoGain は bit 単位（最大 log2(25)≈4.64）。
    // 痕跡ゼロでは発見確率が最大でも約7%しかなく、痕跡を引く速さは重要だが、
    // bit から勝率への換算は間接的なので重みは中程度に抑える（0.55 だと捜索の
    // 価値が移動の価値を常時上回り、ヘリが同じ窓に張り付いて同じマスを
    // 繰り返し捜索する不具合があった）。残りラウンドが減るほど情報を使う
    // 機会が減るので線形に減衰させ、R11 では 0 にする。
    const INFO_GAIN_WEIGHT = 0.45;
    // 移動で新しく捜索可能になるマス群の価値の係数。窓の外の候補は、誰かが
    // 移動しない限り永遠に捜索できないため、「次ラウンドにそのマスを捜索
    // できる選択肢」自体に価値を持たせる（planJointActions の統合スコアで使用）。
    const NEW_WINDOW_WEIGHT = 0.5;
    function infoWeightForRound(round) {
        return INFO_GAIN_WEIGHT * (TOTAL_ROUNDS - round) / (TOTAL_ROUNDS - 1);
    }
    // タスク3: 混合分布の係数。経路数比例だけだと「経路数の少ない歩き方」を
    // わざと選ぶ人間相手に系統的に外すため、一様分布（整合マス全体）と
    // 相手モデルを混ぜて下限を作る。
    const MIX_COUNT = 0.60;              // 経路数比例の事後分布
    const MIX_SUPPORT = 0.25;            // 整合マスへの一様分布
    const MIX_OPPONENT = 0.15;           // 相手モデル（逃走 prior で重み付けした経路分布）
    const PROB_FLOOR = 0.005;            // 整合マスの確率下限（完全な無視を防ぐ）
    const OPP_STEP_WEIGHT = 0.05;        // 相手モデルの1ステップあたり重み（弱く効かせる）
    const MOVE_DISCOUNT = 0.8;           // 次ラウンドの発見確率を今の価値に割り引く係数
    const MOVE_DIST_PENALTY = 0.01;      // 次候補から遠い移動へのペナルティ
    const FORCED_COVER_BONUS = 0.30;     // 強制移動先を新たに捜索可能にする移動の価値
    const ENDGAME_SEARCH_BONUS = 0.35;   // 終盤で候補マスを捜索する価値
    const ENDGAME_MOVE_BONUS = 0.08;     // 終盤で候補マスに近づく移動の価値
    // タスク4: 終盤ソルバーの発動上限（経路数が多い序盤では読み切れないため）
    const SOLVER_MAX_PATHS = 500;
    const SOLVER_NODE_LIMIT = 30000;     // 探索ノード数の上限（超えたら諦めて通常評価へ）
    const MINIMAX_NODE_LIMIT = 25000;    // 勝率ミニマックス探索のノード上限
    // 中盤2手先読み: 経路数がこれを超える局面では読まない（終盤はソルバー側が担当）
    const LOOKAHEAD_MAX_PATHS = 12000;
    const LOOKAHEAD_MARGIN = 0.03;       // 先読みが通常プランを覆すのに必要な差
    const WIN_VALUE = 1;                 // 先読み評価での「発見・手詰まり」の価値（勝率スケールに正規化）

    function postProb(post, x, y) {
        return post.probs[y * B_SIZE + x] || 0;
    }

    /* ヘリ群（交差点座標の配列）が分布 post に対して達成できる
       「1機につき隣接4マスのうち最大1マス」を条件とした最適割当の発見確率。
       findCurrentPhaseCoveragePlan の重み付き一般化。 */
    function assignmentCapture(positions, post) {
        if (!post || !post.probs || positions.length === 0) return 0;
        const options = positions.map(p => {
            const list = [null];
            for (const b of adjacentBuildings(p.x, p.y)) {
                if (b.x < 0 || b.y < 0 || b.x >= B_SIZE || b.y >= B_SIZE) continue;
                const pr = post.probs[b.y * B_SIZE + b.x] || 0;
                if (pr > 0) list.push({ cell: b.y * B_SIZE + b.x, p: pr });
            }
            return list;
        });
        let bestSum = 0;
        const used = new Set();
        function rec(i, sum) {
            if (i === options.length) {
                if (sum > bestSum) bestSum = sum;
                return;
            }
            for (const opt of options[i]) {
                if (opt === null) { rec(i + 1, sum); continue; }
                if (used.has(opt.cell)) continue;
                used.add(opt.cell);
                rec(i + 1, sum + opt.p);
                used.delete(opt.cell);
            }
        }
        rec(0, 0);
        return bestSum;
    }

    /* タスク3: 相手モデル分布。経路ごとに「ヘリから遠い・壁際・逃げ道が多い」
       ステップを選んだ経路ほど重くし、終点分布にする。ヘリの過去位置履歴は
       状態に無いため、現在のヘリ位置で近似する（係数は弱く、単独では
       経路数比例の分布を逆転させない）。 */
    function opponentProbsFromPaths(paths, helis) {
        const N = B_SIZE * B_SIZE;
        const probs = new Float64Array(N);
        if (!paths || paths.length === 0 || helis.length === 0) return null;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        let totalW = 0;
        for (const path of paths) {
            let w = 1;
            const prefix = new Set([path[0]]);
            for (let i = 1; i < path.length; i++) {
                const ci = path[i];
                const x = ci % B_SIZE;
                const y = (ci / B_SIZE) | 0;
                let minDist = Infinity;
                for (const h of helis) {
                    const d = Math.abs(x - h.x) + Math.abs(y - h.y);
                    if (d < minDist) minDist = d;
                }
                const edge = (x === 0 || x === B_SIZE - 1 || y === 0 || y === B_SIZE - 1) ? 1 : 0;
                let escape = 0;
                for (const [dx, dy] of dirs) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
                    if (!prefix.has(ny * B_SIZE + nx)) escape++;
                }
                w *= 1 + OPP_STEP_WEIGHT * (0.3 * minDist + 0.5 * edge + 0.25 * escape);
                prefix.add(ci);
            }
            probs[path[path.length - 1]] += w;
            totalW += w;
        }
        if (totalW <= 0) return null;
        for (let i = 0; i < N; i++) probs[i] /= totalW;
        return probs;
    }

    const DECISION_POST_CACHE = { key: null, result: null };

    /* 意思決定用の混合分布を作る（タスク3）。生の事後分布に
       visitProb / visitByIndex / infoGain と経路分析を付けて返す。 */
    function getDecisionPosterior(state = S) {
        const helis = (state.police ? state.police.helis : S.police.helis)
            .filter(h => h.x != null);
        const key = posteriorSignature(state) + '|'
            + helis.map(h => `${h.x},${h.y}`).join(';');
        if (DECISION_POST_CACHE.key === key && DECISION_POST_CACHE.result) {
            return DECISION_POST_CACHE.result;
        }
        const raw = getPosterior(state);
        const { paths, analysis } = getPathAnalysis(state);
        const N = B_SIZE * B_SIZE;
        const support = [];
        for (let ci = 0; ci < N; ci++) if (raw.probs[ci] > 0) support.push(ci);
        const opp = opponentProbsFromPaths(paths, helis);
        const probs = new Float64Array(N);
        for (let ci = 0; ci < N; ci++) {
            let p = MIX_COUNT * raw.probs[ci];
            if (support.length > 0 && raw.probs[ci] > 0) p += MIX_SUPPORT / support.length;
            if (opp) p += MIX_OPPONENT * opp[ci];
            probs[ci] = p;
        }
        // 整合マスに下限を作ってから正規化する
        let sum = 0;
        for (const ci of support) {
            if (probs[ci] < PROB_FLOOR) probs[ci] = PROB_FLOOR;
        }
        for (let ci = 0; ci < N; ci++) sum += probs[ci];
        if (sum > 0) for (let ci = 0; ci < N; ci++) probs[ci] /= sum;
        const cells = [];
        for (let ci = 0; ci < N; ci++) {
            if (probs[ci] > 0) {
                cells.push({ x: ci % B_SIZE, y: (ci / B_SIZE) | 0, p: probs[ci] });
            }
        }
        cells.sort((a, b) => b.p - a.p || a.y - b.y || a.x - b.x);
        const result = {
            ...raw,
            probs,
            cells,
            rawProbs: raw.probs,
            paths,
            pathAnalysis: analysis,
            propagated: analysis.propagated,
            forcedByEndpoint: analysis.forcedByEndpoint,
            mixed: true,
        };
        DECISION_POST_CACHE.key = key;
        DECISION_POST_CACHE.result = result;
        return result;
    }

    function isSearchedThisRound(x, y) {
        return S.buildings[y][x].searchedRound === S.currentRound;
    }

    /* 終盤判定: 残り警察フェーズ数×3手で候補を覆えるかを見積もる。 */
    function buildEndgameContext(post, activeHelis = S.police.helis.length) {
        const candidates = post.cells.filter(c => c.p > 0);
        const candidateKeys = new Set(candidates.map(c => c.y * B_SIZE + c.x));
        const remainingPhases = TOTAL_ROUNDS - S.currentRound + 1;
        const totalSearchActions = remainingPhases * activeHelis;
        const endgameActive = candidates.length > 0
            && candidates.length <= totalSearchActions
            && (remainingPhases <= 3 || candidates.length <= 3);
        return {
            candidates,
            candidateKeys,
            remainingPhases,
            totalSearchActions,
            canCoverAllEventually: candidates.length > 0 && candidates.length <= totalSearchActions,
            endgameActive,
        };
    }

    /* この警察フェーズの残り手数で候補全マスを捜索できるなら、
       候補とヘリの完全マッチングを返す（必中プラン）。 */
    function findCurrentPhaseCoveragePlan(helis, candidates) {
        if (candidates.length === 0 || candidates.length > helis.length) return null;
        const searchable = helis.map(h => {
            const set = new Set();
            for (const b of searchableBuildings(h)) {
                if (b.x < 0 || b.y < 0 || b.x >= B_SIZE || b.y >= B_SIZE) continue;
                set.add(b.y * B_SIZE + b.x);
            }
            return set;
        });
        // 捜索可能なヘリが少ない候補から割り当てる
        const sortedCandidates = candidates.slice().sort((a, b) => {
            const ca = a.y * B_SIZE + a.x;
            const cb = b.y * B_SIZE + b.x;
            let na = 0, nb = 0;
            for (const s of searchable) { if (s.has(ca)) na++; if (s.has(cb)) nb++; }
            return na - nb || b.p - a.p || a.y - b.y || a.x - b.x;
        });
        const assignment = new Array(helis.length).fill(null);
        const used = new Uint8Array(helis.length);
        function assignCandidate(k) {
            if (k >= sortedCandidates.length) return true;
            const c = sortedCandidates[k];
            const ck = c.y * B_SIZE + c.x;
            for (let i = 0; i < helis.length; i++) {
                if (used[i] || !searchable[i].has(ck)) continue;
                used[i] = 1;
                assignment[i] = c;
                if (assignCandidate(k + 1)) return true;
                used[i] = 0;
                assignment[i] = null;
            }
            return false;
        }
        if (!assignCandidate(0)) return null;
        const plan = new Map();
        helis.forEach((h, i) => {
            if (assignment[i]) {
                plan.set(h.index, {
                    type: 'search',
                    target: { x: assignment[i].x, y: assignment[i].y },
                    coverage: true,
                });
            }
        });
        return plan;
    }

    /* 再捜索の鮮度係数。空振りした直後のマスは「犯人がその後に立ち寄った」
       情報しか新しく得られず、同じ窓の同じマスを毎ラウンド捜索する価値はない。
       前回捜索から 1 ラウンド後は 0.5、2 ラウンド後は 0.85、3 ラウンド以上で
       元に戻る。終盤候補マス（今いる可能性で捜すマス）には適用しない。 */
    function searchFreshnessFactor(building) {
        if (!building || !building.isSearched || building.searchedRound == null) return 1;
        const age = S.currentRound - building.searchedRound;
        if (age <= 1) return 0.5;
        if (age === 2) return 0.85;
        return 1;
    }

    /* 1マスの捜索価値: 発見確率 + 情報利得（減衰）×鮮度 + 終盤ボーナス。 */
    function searchValueForCell(ci, post, endgame) {
        const x = ci % B_SIZE;
        const y = (ci / B_SIZE) | 0;
        let value = postProb(post, x, y);
        if (post.infoGain) value += infoWeightForRound(S.currentRound) * (post.infoGain[ci] || 0);
        const isEndgameCandidate = !!(endgame && endgame.candidateKeys.has(ci));
        if (!isEndgameCandidate) value *= searchFreshnessFactor(S.buildings[y][x]);
        if (isEndgameCandidate) value += ENDGAME_SEARCH_BONUS;
        return value;
    }

    /* 1機ぶんの候補手（捜索・移動）とその価値を列挙する。 */
    function generateHeliActions(heli, post, endgame) {
        const actions = [];
        for (const b of searchableBuildings(heli)) {
            if (b.x < 0 || b.y < 0 || b.x >= B_SIZE || b.y >= B_SIZE) continue;
            const building = S.buildings[b.y][b.x];
            if (building.clueRevealed) continue;          // 痕跡マスは現在位置になり得ない
            if (isSearchedThisRound(b.x, b.y)) continue;  // 同ラウンドの再捜索は無意味
            const ck = b.y * B_SIZE + b.x;
            // 痕跡が1つも出ていない間は、捜索済みマスを再捜索しない。
            // 未捜索マスは「過去に立ち寄ったか」の痕跡情報まで得られるが、
            // 捜索済みマスは直後だと現在位置の確認にしかならず情報が増えない。
            // カバー範囲を広げて最初の痕跡を引きにいく方針（tanaka の指定）。
            // 終盤候補マス（現在位置候補として捜すマス）は対象外。
            const isEndgameCandidate = !!(endgame && endgame.candidateKeys.has(ck));
            if (building.isSearched && S.revealedClues.length === 0 && !isEndgameCandidate) continue;
            const value = searchValueForCell(ck, post, endgame);
            actions.push({ type: 'search', target: { x: b.x, y: b.y }, cellKey: ck, value });
        }

        // タスク2: 移動価値 = 次ラウンド分布に対する最適割当発見確率の増分。
        // 「1機で最大1マス」を割当で数えるため、候補が1機の窓に固まる場合の
        // 過大評価が起きない。
        const propagated = post.propagated || null;
        const allPositions = S.police.helis
            .filter(h => h.x != null)
            .map(h => ({ x: h.x, y: h.y, index: h.index }));
        const baseCapture = propagated ? assignmentCapture(allPositions, propagated) : 0;
        // 強制移動先（この移動で新たに捜索可能になると価値が高い）
        const forcedTargets = new Set();
        if (post.forcedByEndpoint) {
            for (const nextCi of post.forcedByEndpoint.values()) forcedTargets.add(nextCi);
        }
        const searchableFrom = (ix, iy) => {
            const set = new Set();
            for (const b of adjacentBuildings(ix, iy)) {
                if (b.x >= 0 && b.y >= 0 && b.x < B_SIZE && b.y < B_SIZE) {
                    set.add(b.y * B_SIZE + b.x);
                }
            }
            return set;
        };
        const currentSearchable = searchableFrom(heli.x, heli.y);

        for (const m of validHeliMoves(heli)) {
            let value;
            if (propagated) {
                const afterPositions = allPositions.map(p =>
                    p.index === heli.index ? { x: m.x, y: m.y, index: p.index } : p);
                value = MOVE_DISCOUNT * (assignmentCapture(afterPositions, propagated) - baseCapture);
                // 強制移動先を新たにカバーできる場合のボーナス
                if (forcedTargets.size > 0 && propagated.probs) {
                    const afterSearchable = searchableFrom(m.x, m.y);
                    for (const fci of forcedTargets) {
                        if (afterSearchable.has(fci) && !currentSearchable.has(fci)) {
                            value += FORCED_COVER_BONUS * (propagated.probs[fci] || 0);
                        }
                    }
                }
                // 次候補から遠ざかる移動への小さなペナルティ
                let nearest = Infinity;
                for (const c of propagated.cells) {
                    const d = searchDistanceForBuilding(c.x, c.y, m.x, m.y);
                    if (d < nearest) nearest = d;
                }
                if (isFinite(nearest)) value -= MOVE_DIST_PENALTY * nearest;
            } else {
                value = 0;
            }
            if (endgame && endgame.candidateKeys.size > 0) {
                const adj = adjacentBuildings(m.x, m.y);
                for (const b of adj) {
                    if (endgame.candidateKeys.has(b.y * B_SIZE + b.x)) {
                        value += ENDGAME_MOVE_BONUS;
                        break;
                    }
                }
            }
            actions.push({ type: 'move', target: { x: m.x, y: m.y }, value });
        }

        if (actions.length === 0) {
            actions.push({ type: 'wait', target: { x: heli.x, y: heli.y }, value: 0 });
        }
        return actions;
    }

    /* 残り全機の行動の組合せを評価し、3機でカバーできる確率質量が
       最大になる割当を選ぶ。 */
    function planJointActions(helis, post, endgame) {
        if (helis.length === 0) return { actions: [], score: 0 };
        const actionLists = helis.map(h => generateHeliActions(h, post, endgame));
        let bestCombo = null;
        let bestScore = -Infinity;
        const chosen = new Array(helis.length);

        // 統合スコア: プラン全体を同じ物差しで評価する。
        // 旧方式（捜索は絶対値、移動は微小な差分を足し合わせる）では捜索が
        // 常時勝ち、ヘリが移動せず同じマスを繰り返し捜索していた。
        // ここでは「移動はプラン完了後の配置で決まる次ラウンドの価値」として
        // 葉でまとめて数える。R11 は次ラウンドが無いので移動の価値は 0。
        const futureFactor = S.currentRound >= TOTAL_ROUNDS ? 0 : 1;
        const allStartPositions = S.police.helis
            .filter(h => h.x != null)
            .map(h => ({ x: h.x, y: h.y, index: h.index }));
        const windowCellsOf = (positions) => {
            const set = new Set();
            for (const p of positions) {
                for (const b of adjacentBuildings(p.x, p.y)) {
                    if (b.x >= 0 && b.y >= 0 && b.x < B_SIZE && b.y < B_SIZE) {
                        set.add(b.y * B_SIZE + b.x);
                    }
                }
            }
            return set;
        };
        const startWindow = windowCellsOf(allStartPositions);

        function leafScore(searchScore, finalPosByIndex) {
            let score = searchScore;
            if (futureFactor && post.propagated) {
                const finalPositions = allStartPositions.map(p =>
                    finalPosByIndex.has(p.index) ? finalPosByIndex.get(p.index) : p);
                // 次ラウンド分布に対する最適割当の発見確率
                score += MOVE_DISCOUNT * assignmentCapture(finalPositions, post.propagated);
                // 新しく窓に入るマスを次ラウンドに捜索できる選択肢の価値
                const finalWindow = windowCellsOf(finalPositions);
                let newWindowValue = 0;
                for (const ci of finalWindow) {
                    if (!startWindow.has(ci)) newWindowValue += searchValueForCell(ci, post, endgame);
                }
                score += NEW_WINDOW_WEIGHT * newWindowValue;
            }
            return score;
        }

        function evaluate(idx, searchedKeys, moveTargets, searchScore, finalPosByIndex) {
            if (idx === helis.length) {
                const score = leafScore(searchScore, finalPosByIndex);
                if (score > bestScore + 1e-9) {
                    bestScore = score;
                    bestCombo = chosen.slice();
                }
                return;
            }
            for (const action of actionLists[idx]) {
                let nextSearched = searchedKeys;
                let nextMoves = moveTargets;
                let nextFinalPos = finalPosByIndex;
                let add = 0;
                if (action.type === 'search') {
                    if (searchedKeys.has(action.cellKey)) {
                        add = -0.02; // 同じマスの重複捜索は避ける
                    } else {
                        add = action.value;
                        nextSearched = new Set(searchedKeys);
                        nextSearched.add(action.cellKey);
                    }
                } else if (action.type === 'move') {
                    const mk = action.target.y * I_SIZE + action.target.x;
                    if (moveTargets.has(mk)) continue; // 同時に同じ交差点へは移動不可
                    nextMoves = new Set(moveTargets);
                    nextMoves.add(mk);
                    nextFinalPos = new Map(finalPosByIndex);
                    nextFinalPos.set(helis[idx].index, { x: action.target.x, y: action.target.y, index: helis[idx].index });
                    // 移動自体の価値は葉の統合スコアで数える（ここでは加算しない）
                }
                chosen[idx] = action;
                evaluate(idx + 1, nextSearched, nextMoves, searchScore + add, nextFinalPos);
            }
        }

        evaluate(0, new Set(), new Set(), 0, new Map());
        return { actions: bestCombo || [], score: bestScore };
    }

    /* ---------- タスク4: 終盤の必勝読み切りソルバー ----------
       belief（整合経路の集合）に対して
       「警察の共同手 → 捜索結果の全分岐 → 犯人の全合法手（ユニオン）」
       を終端まで辿り、どの分岐でも警察が勝てるプランを探す。
       犯人の手と捜索結果は全て universal に扱うため、見つかったプランは
       必勝である（健全性重視。見つからなければ通常評価にフォールバック）。 */
    function solverBeliefPost(paths) {
        const N = B_SIZE * B_SIZE;
        const counts = new Float64Array(N);
        for (const p of paths) counts[p[p.length - 1]] += 1;
        const probs = new Float64Array(N);
        if (paths.length > 0) {
            for (let i = 0; i < N; i++) probs[i] = counts[i] / paths.length;
        }
        const cells = [];
        for (let ci = 0; ci < N; ci++) {
            if (probs[ci] > 0) cells.push({ x: ci % B_SIZE, y: (ci / B_SIZE) | 0, p: probs[ci] });
        }
        cells.sort((a, b) => b.p - a.p || a.y - b.y || a.x - b.x);
        return { counts, total: paths.length, probs, cells };
    }

    /* ソルバー用の貪欲プラン: 確率の高い候補を重複なく捜索し、
       届かないヘリは候補へ近づく。post は評価対象の分布（現在/伝播）。 */
    function solverGreedyPlan(belief, positions, actingIdxs, post) {
        const work = positions.map(p => ({ x: p.x, y: p.y }));
        const usedCells = new Set();
        const plan = [];
        for (const hi of actingIdxs) {
            const pos = work[hi];
            let bestCell = null;
            let bestP = 0;
            for (const b of adjacentBuildings(pos.x, pos.y)) {
                if (b.x < 0 || b.y < 0 || b.x >= B_SIZE || b.y >= B_SIZE) continue;
                const ci = b.y * B_SIZE + b.x;
                if (usedCells.has(ci)) continue;
                const p = post.probs[ci] || 0;
                if (p > bestP) { bestP = p; bestCell = b; }
            }
            if (bestCell) {
                usedCells.add(bestCell.y * B_SIZE + bestCell.x);
                plan.push({ type: 'search', target: { x: bestCell.x, y: bestCell.y } });
                continue;
            }
            // 捜索できる候補がない: 候補に最も近づく合法移動
            let bestMove = null;
            let bestDist = Infinity;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = pos.x + dx;
                const ny = pos.y + dy;
                if (nx < 0 || ny < 0 || nx >= I_SIZE || ny >= I_SIZE) continue;
                if (work.some((w, wi) => wi !== hi && w.x === nx && w.y === ny)) continue;
                let d = Infinity;
                for (const c of post.cells) {
                    const dd = searchDistanceForBuilding(c.x, c.y, nx, ny);
                    if (dd < d) d = dd;
                }
                if (d < bestDist) { bestDist = d; bestMove = { x: nx, y: ny }; }
            }
            if (bestMove && bestDist < Infinity) {
                work[hi] = bestMove;
                plan.push({ type: 'move', target: bestMove });
            } else {
                plan.push({ type: 'wait', target: { x: pos.x, y: pos.y } });
            }
        }
        return plan;
    }

    /* ソルバー共通: belief の識別キー（メモ化用）。 */
    function solverBeliefKey(belief, positions, round, acting) {
        return belief.map(p => p.join(',')).sort().join('|')
            + '#' + positions.map(p => `${p.x},${p.y}`).join(';')
            + '#' + round + '#' + acting.join(',');
    }

    /* ソルバー共通: 候補プラン生成（現在分布への貪欲プラン、伝播分布への
       貪欲プラン、現在ラウンドのみ実状態の共同プラン）。 */
    function solverCandidatePlans(belief, positions, acting, round) {
        const plans = [];
        const seen = new Set();
        const addPlan = (plan) => {
            const k = JSON.stringify(plan.map(a => `${a.type}:${a.target.x},${a.target.y}`));
            if (!seen.has(k)) { seen.add(k); plans.push(plan); }
        };
        const post = solverBeliefPost(belief);
        addPlan(solverGreedyPlan(belief, positions, acting, post));
        const prop = analyzeConsistentPaths(belief).propagated;
        addPlan(solverGreedyPlan(belief, positions, acting, prop));
        if (round === S.currentRound) {
            const fakeHelis = acting.map(hi => ({
                index: hi, x: positions[hi].x, y: positions[hi].y, hasActed: false,
            }));
            const joint = planJointActions(fakeHelis, getDecisionPosterior(S), null);
            if (joint.actions && joint.actions.length === acting.length) {
                addPlan(joint.actions.map(a => ({
                    type: a.type, target: { x: a.target.x, y: a.target.y },
                })));
            }
        }
        return plans;
    }

    function findForcedWinPlan(remainingHelis) {
        const { paths } = getPathAnalysis(S);
        if (!paths || paths.length === 0) return null;
        const rawPost = getPosterior(S);
        const remainingPhases = TOTAL_ROUNDS - S.currentRound + 1;
        const candidateCount = rawPost.cells.length;
        // 発動条件: 経路が十分少ない終盤だけ（序盤は組み合わせが爆発するため）。
        const triggered = paths.length <= SOLVER_MAX_PATHS
            && (remainingPhases <= 4 || candidateCount <= 6 || paths.length <= 40);
        if (!triggered) return null;

        const allIdxs = S.police.helis.map(h => h.index);
        const actingIdxs = remainingHelis.map(h => h.index);
        const startPositions = S.police.helis.map(h => ({ x: h.x, y: h.y }));
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        let nodes = 0;
        const failMemo = new Set();
        const ABORT = { solverAbort: true };

        function applyActions(belief, positions, actions, k, round, acting) {
            if (++nodes > SOLVER_NODE_LIMIT) throw ABORT;
            if (k >= actions.length) {
                if (belief.length === 0) return true;
                if (round >= TOTAL_ROUNDS) return false;
                // 犯人フェーズ: 手詰まりの経路は警察の勝ち（除去）、
                // 残りは全合法手へ分岐したユニオンを次ラウンドの belief にする
                const nextBelief = [];
                for (const path of belief) {
                    const endpoint = path[path.length - 1];
                    const ex = endpoint % B_SIZE;
                    const ey = (endpoint / B_SIZE) | 0;
                    const visited = new Set(path);
                    for (const [dx, dy] of dirs) {
                        const nx = ex + dx;
                        const ny = ey + dy;
                        if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
                        const np = ny * B_SIZE + nx;
                        if (visited.has(np)) continue;
                        nextBelief.push(path.concat(np));
                    }
                }
                if (nextBelief.length === 0) return true;
                if (nextBelief.length > 2000) return false; // 組み合わせ爆発時は保守的に諦める
                return solveRound(nextBelief, positions, round + 1, allIdxs) !== null;
            }
            const hi = acting[k];
            const pos = positions[hi];
            const action = actions[k];
            if (action.type === 'wait') {
                return applyActions(belief, positions, actions, k + 1, round, acting);
            }
            if (action.type === 'move') {
                const t = action.target;
                if (t.x < 0 || t.y < 0 || t.x >= I_SIZE || t.y >= I_SIZE) return false;
                if (Math.abs(t.x - pos.x) + Math.abs(t.y - pos.y) !== 1) return false;
                if (positions.some((p, pi) => pi !== hi && p.x === t.x && p.y === t.y)) return false;
                const nextPositions = positions.slice();
                nextPositions[hi] = { x: t.x, y: t.y };
                return applyActions(belief, nextPositions, actions, k + 1, round, acting);
            }
            if (action.type === 'search') {
                const t = action.target;
                const adj = adjacentBuildings(pos.x, pos.y)
                    .some(b => b.x === t.x && b.y === t.y);
                if (!adj) return false;
                const tci = t.y * B_SIZE + t.x;
                // 捜索結果で belief を分岐する（発見した経路は勝ちとして除去）
                const branches = new Map();
                for (const path of belief) {
                    const endpoint = path[path.length - 1];
                    if (endpoint === tci) continue;
                    const ii = path.indexOf(tci);
                    let cls;
                    if (ii < 0 || ii >= path.length - 1) cls = 'empty';
                    else if (ii === 0) cls = 'Y';
                    else if (ii === 5) cls = 'R';
                    else cls = 'B';
                    if (!branches.has(cls)) branches.set(cls, []);
                    branches.get(cls).push(path);
                }
                for (const branch of branches.values()) {
                    if (!applyActions(branch, positions, actions, k + 1, round, acting)) {
                        return false;
                    }
                }
                return true;
            }
            return false;
        }

        function solveRound(belief, positions, round, acting) {
            if (++nodes > SOLVER_NODE_LIMIT) throw ABORT;
            if (belief.length === 0) return [];
            if (round > TOTAL_ROUNDS) return null;
            const key = solverBeliefKey(belief, positions, round, acting);
            if (failMemo.has(key)) return null;
            for (const plan of solverCandidatePlans(belief, positions, acting, round)) {
                if (applyActions(belief, positions, plan, 0, round, acting)) return plan;
            }
            failMemo.add(key);
            return null;
        }

        try {
            const plan = solveRound(paths, startPositions, S.currentRound, actingIdxs);
            if (!plan) return null;
            const map = new Map();
            actingIdxs.forEach((hi, i) => {
                if (plan[i]) map.set(hi, { ...plan[i], solver: true });
            });
            return map;
        } catch (e) {
            if (e === ABORT) return null;
            throw e;
        }
    }

    /* ---------- 終盤ソルバーの勝率ミニマックス化 ----------
       必勝ソルバー（AND-OR）で勝ち切れない局面でも、「警察の勝率」を最大化する
       手を選べるよう、belief に対する期待値探索を行う。
       - 警察ノード: 候補プランのうち勝率最大を選ぶ（max）
       - 捜索: 結果分岐（発見/黄/赤/青/空）の確率加重平均（chance）。
         枝の途中でも「残りの確率質量を全部足しても現在の最良値を超えない」
         場合は打ち切る（アルファベータ式の境界剪定）
       - 犯人ノード: 経路ごとに「次ラウンドに最も捜索されにくい移動」だけを
         残す近似の min（adversarial）。手詰まりの経路は警察の勝ちとして数える
       - 局面はメモ化して再利用する（transposition table） */
    function minimaxEndgameSolve(remainingHelis) {
        const { paths } = getPathAnalysis(S);
        if (!paths || paths.length === 0) return null;
        const rawPost = getPosterior(S);
        const remainingPhases = TOTAL_ROUNDS - S.currentRound + 1;
        const candidateCount = rawPost.cells.length;
        const triggered = paths.length <= SOLVER_MAX_PATHS
            && (remainingPhases <= 4 || candidateCount <= 6);
        if (!triggered) return null;

        const allIdxs = S.police.helis.map(h => h.index);
        const actingIdxs = remainingHelis.map(h => h.index);
        const startPositions = S.police.helis.map(h => ({ x: h.x, y: h.y }));
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        let nodes = 0;
        const memo = new Map();
        const ABORT = { minimaxAbort: true };

        // 犯人の adversarial 移動: その経路にとって最も安全な移動先だけ残す
        function thiefExtend(belief, positions) {
            let trapped = 0;
            const nextBelief = [];
            for (const path of belief) {
                const endpoint = path[path.length - 1];
                const ex = endpoint % B_SIZE;
                const ey = (endpoint / B_SIZE) | 0;
                const visited = new Set(path);
                const moves = [];
                for (const [dx, dy] of dirs) {
                    const nx = ex + dx;
                    const ny = ey + dy;
                    if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
                    const np = ny * B_SIZE + nx;
                    if (!visited.has(np)) moves.push(np);
                }
                if (moves.length === 0) { trapped += 1; continue; }
                // 安全さ = 最も近いヘリからの捜索距離が大きいほど安全
                let bestSafety = -Infinity;
                const safety = moves.map(m => {
                    const mx = m % B_SIZE;
                    const my = (m / B_SIZE) | 0;
                    let d = Infinity;
                    for (const p of positions) {
                        d = Math.min(d, searchDistanceForBuilding(mx, my, p.x, p.y));
                    }
                    if (d > bestSafety) bestSafety = d;
                    return d;
                });
                moves.forEach((m, i) => {
                    if (safety[i] === bestSafety) nextBelief.push(path.concat(m));
                });
            }
            return { nextBelief, trapFraction: belief.length > 0 ? trapped / belief.length : 0 };
        }

        function valueActions(belief, positions, actions, k, round, acting, alpha) {
            if (++nodes > MINIMAX_NODE_LIMIT) throw ABORT;
            if (belief.length === 0) return 1;
            if (k >= actions.length) {
                if (round >= TOTAL_ROUNDS) return 0;
                const { nextBelief, trapFraction } = thiefExtend(belief, positions);
                if (nextBelief.length === 0) return 1;
                if (nextBelief.length > 2000) {
                    // 爆発時は伝播分布への割当捕捉率で近似評価する
                    const post = solverBeliefPost(nextBelief.slice(0, 2000));
                    return trapFraction + (1 - trapFraction) * assignmentCapture(positions, post);
                }
                const sub = valueRound(nextBelief, positions, round + 1, allIdxs);
                return trapFraction + (1 - trapFraction) * sub;
            }
            const hi = acting[k];
            const pos = positions[hi];
            const action = actions[k];
            if (action.type === 'wait') {
                return valueActions(belief, positions, actions, k + 1, round, acting, alpha);
            }
            if (action.type === 'move') {
                const t = action.target;
                if (t.x < 0 || t.y < 0 || t.x >= I_SIZE || t.y >= I_SIZE) return 0;
                if (Math.abs(t.x - pos.x) + Math.abs(t.y - pos.y) !== 1) return 0;
                if (positions.some((p, pi) => pi !== hi && p.x === t.x && p.y === t.y)) return 0;
                const nextPositions = positions.slice();
                nextPositions[hi] = { x: t.x, y: t.y };
                return valueActions(belief, nextPositions, actions, k + 1, round, acting, alpha);
            }
            if (action.type === 'search') {
                const t = action.target;
                const adj = adjacentBuildings(pos.x, pos.y)
                    .some(b => b.x === t.x && b.y === t.y);
                if (!adj) return 0;
                const tci = t.y * B_SIZE + t.x;
                const total = belief.length;
                let hitCount = 0;
                const branches = new Map();
                for (const path of belief) {
                    const endpoint = path[path.length - 1];
                    if (endpoint === tci) { hitCount += 1; continue; }
                    const ii = path.indexOf(tci);
                    let cls;
                    if (ii < 0 || ii >= path.length - 1) cls = 'empty';
                    else if (ii === 0) cls = 'Y';
                    else if (ii === 5) cls = 'R';
                    else cls = 'B';
                    if (!branches.has(cls)) branches.set(cls, []);
                    branches.get(cls).push(path);
                }
                // 大きい枝から評価し、境界剪定を効かせる
                const branchList = [...branches.values()].sort((a, b) => b.length - a.length);
                let acc = hitCount / total; // 発見した分は勝ち
                let remainingMass = 1 - acc;
                for (const branch of branchList) {
                    const w = branch.length / total;
                    const v = valueActions(branch, positions, actions, k + 1, round, acting, alpha);
                    acc += w * v;
                    remainingMass -= w;
                    // 残りを全て勝っても alpha（現在の最良値）に届かないなら打ち切り
                    if (acc + remainingMass <= alpha) return acc + remainingMass;
                }
                return acc;
            }
            return 0;
        }

        function valueRound(belief, positions, round, acting) {
            if (++nodes > MINIMAX_NODE_LIMIT) throw ABORT;
            if (belief.length === 0) return 1;
            if (round > TOTAL_ROUNDS) return 0;
            const key = solverBeliefKey(belief, positions, round, acting);
            if (memo.has(key)) return memo.get(key);
            let best = -1;
            for (const plan of solverCandidatePlans(belief, positions, acting, round)) {
                const v = valueActions(belief, positions, plan, 0, round, acting, best);
                if (v > best) best = v;
                if (best >= 1) break;
            }
            const result = Math.max(0, best);
            memo.set(key, result);
            return result;
        }

        try {
            // 最上位ラウンドだけ、プランと勝率を両方返す
            let best = -1;
            let bestPlan = null;
            for (const plan of solverCandidatePlans(paths, startPositions, actingIdxs, S.currentRound)) {
                const v = valueActions(paths, startPositions, plan, 0, S.currentRound, actingIdxs, best);
                if (v > best) { best = v; bestPlan = plan; }
                if (best >= 1) break;
            }
            if (!bestPlan) return null;
            const map = new Map();
            actingIdxs.forEach((hi, i) => {
                if (bestPlan[i]) map.set(hi, { ...bestPlan[i], minimax: true, winProb: best });
            });
            return { plan: map, value: best };
        } catch (e) {
            if (e === ABORT) return null;
            throw e;
        }
    }

    /* ---------- 中盤2手先読み（タスク5: expectimax） ----------
       候補プランを「今ラウンドの捜索結果分岐 → 犯人移動 → 次ラウンドの
       最適割当捕捉見込み」まで実際に展開して評価する。情報利得は、痕跡分岐で
       belief が絞られる効果として自然に価値へ入る。犯人移動は一様（expectimax）
       とし、手詰まりは勝ちとして数える。 */
    function lookaheadEvaluatePlan(paths, startPositions, actingIdxs, actions, round) {
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        let calls = 0;
        const CALL_LIMIT = 4000;

        function leafAfterThief(belief, positions) {
            // belief は犯人移動後の経路集合。捕捉見込みは [0,1] に正規化し、
            // 発見・手詰まり（=1）と物差しをそろえる
            const post = solverBeliefPost(belief);
            const cap1 = assignmentCapture(positions, post);
            const prop = analyzeConsistentPaths(belief).propagated;
            const cap2 = assignmentCapture(positions, prop);
            return (cap1 + MOVE_DISCOUNT * cap2) / (1 + MOVE_DISCOUNT);
        }

        function rec(belief, positions, k) {
            if (++calls > CALL_LIMIT) return 0;
            if (belief.length === 0) return 0;
            if (k >= actions.length) {
                if (round >= TOTAL_ROUNDS) return 0;
                let trapped = 0;
                const nextBelief = [];
                for (const path of belief) {
                    const endpoint = path[path.length - 1];
                    const ex = endpoint % B_SIZE;
                    const ey = (endpoint / B_SIZE) | 0;
                    const visited = new Set(path);
                    let hasMove = false;
                    for (const [dx, dy] of dirs) {
                        const nx = ex + dx;
                        const ny = ey + dy;
                        if (nx < 0 || ny < 0 || nx >= B_SIZE || ny >= B_SIZE) continue;
                        const np = ny * B_SIZE + nx;
                        if (visited.has(np)) continue;
                        hasMove = true;
                        nextBelief.push(path.concat(np));
                    }
                    if (!hasMove) trapped += 1;
                }
                if (nextBelief.length === 0) return WIN_VALUE;
                const trapFraction = trapped / belief.length;
                return trapFraction * WIN_VALUE
                    + (1 - trapFraction) * leafAfterThief(nextBelief, positions);
            }
            const hi = actingIdxs[k];
            const pos = positions[hi];
            const action = actions[k];
            if (action.type === 'wait') return rec(belief, positions, k + 1);
            if (action.type === 'move') {
                const t = action.target;
                if (t.x < 0 || t.y < 0 || t.x >= I_SIZE || t.y >= I_SIZE) return -Infinity;
                if (Math.abs(t.x - pos.x) + Math.abs(t.y - pos.y) !== 1) return -Infinity;
                if (positions.some((p, pi) => pi !== hi && p.x === t.x && p.y === t.y)) return -Infinity;
                const nextPositions = positions.slice();
                nextPositions[hi] = { x: t.x, y: t.y };
                return rec(belief, nextPositions, k + 1);
            }
            if (action.type === 'search') {
                const t = action.target;
                const adj = adjacentBuildings(pos.x, pos.y)
                    .some(b => b.x === t.x && b.y === t.y);
                if (!adj) return -Infinity;
                const tci = t.y * B_SIZE + t.x;
                const total = belief.length;
                let hitCount = 0;
                const branches = new Map();
                for (const path of belief) {
                    const endpoint = path[path.length - 1];
                    if (endpoint === tci) { hitCount += 1; continue; }
                    const ii = path.indexOf(tci);
                    let cls;
                    if (ii < 0 || ii >= path.length - 1) cls = 'empty';
                    else if (ii === 0) cls = 'Y';
                    else if (ii === 5) cls = 'R';
                    else cls = 'B';
                    if (!branches.has(cls)) branches.set(cls, []);
                    branches.get(cls).push(path);
                }
                // 発見の価値には通常プランと同じ鮮度係数を掛け、捜索済みマスの
                // 繰り返し捜索が先読みでも過大評価されないようにする。
                // 痕跡がまだ出ていない間は、通常プランと同様に再捜索の発見価値を0にする
                const searchedBuilding = S.buildings[t.y][t.x];
                const freshness = (S.revealedClues.length === 0 && searchedBuilding.isSearched)
                    ? 0
                    : searchFreshnessFactor(searchedBuilding);
                let acc = (hitCount / total) * WIN_VALUE * freshness;
                for (const branch of branches.values()) {
                    acc += (branch.length / total) * rec(branch, positions, k + 1);
                }
                return acc;
            }
            return -Infinity;
        }

        return rec(paths, startPositions, 0);
    }

    /* 通常プラン（planJointActions の結果）を含む候補を先読み評価し、
       通常プランより十分に良いプランがあればその行動列を返す。 */
    function chooseLookaheadPlan(remainingHelis, heuristicActions) {
        if (S.currentRound < 2 || S.currentRound >= TOTAL_ROUNDS) return null;
        const { paths } = getPathAnalysis(S);
        if (!paths || paths.length === 0 || paths.length > LOOKAHEAD_MAX_PATHS) return null;
        const actingIdxs = remainingHelis.map(h => h.index);
        const startPositions = S.police.helis.map(h => ({ x: h.x, y: h.y }));

        const candidates = [];
        const seen = new Set();
        const addCandidate = (actions) => {
            if (!actions || actions.length !== actingIdxs.length) return;
            const k = JSON.stringify(actions.map(a => `${a.type}:${a.target.x},${a.target.y}`));
            if (!seen.has(k)) { seen.add(k); candidates.push(actions); }
        };
        addCandidate(heuristicActions.map(a => ({ type: a.type, target: { x: a.target.x, y: a.target.y } })));
        const post = solverBeliefPost(paths);
        addCandidate(solverGreedyPlan(paths, startPositions, actingIdxs, post));
        const prop = analyzeConsistentPaths(paths).propagated;
        addCandidate(solverGreedyPlan(paths, startPositions, actingIdxs, prop));

        let heuristicValue = null;
        let best = null;
        let bestValue = -Infinity;
        candidates.forEach((actions, i) => {
            const v = lookaheadEvaluatePlan(paths, startPositions, actingIdxs, actions, S.currentRound);
            if (i === 0) heuristicValue = v;
            if (v > bestValue) { bestValue = v; best = actions; }
        });
        if (!best || heuristicValue === null) return null;
        if (bestValue <= heuristicValue + LOOKAHEAD_MARGIN) return null;
        // 先読みは移動回数を減らす方向には覆さない（ヘリが張り付く退行の防止）。
        // 捜索先の改善や移動先の改善など、移動回数が同等以上の場合だけ採用する。
        const countMoves = (actions) => actions.filter(a => a.type === 'move').length;
        if (countMoves(best) < countMoves(candidates[0])) return null;
        return best;
    }

    function decidePoliceAction(heli) {
        if (!heli || heli.x == null || heli.hasActed) {
            return { type: 'wait', target: { x: heli ? heli.x : 0, y: heli ? heli.y : 0 } };
        }
        // 現在のヘリを先頭にした残り機リスト
        const remaining = [heli].concat(
            S.police.helis.filter(h => h !== heli && !h.hasActed && h.x != null)
        );
        const rawPost = getPosterior(S);
        const endgame = buildEndgameContext(rawPost, remaining.length);

        // 0) タスク4: 終盤ソルバーで必勝プランがあれば最優先
        const solverPlan = findForcedWinPlan(remaining);
        if (solverPlan && solverPlan.has(heli.index)) {
            return solverPlan.get(heli.index);
        }

        // 0.5) 終盤の勝率ミニマックス: 必勝はなくても勝率最大のプランを選ぶ
        const minimax = minimaxEndgameSolve(remaining);
        if (minimax && minimax.plan.has(heli.index)) {
            return minimax.plan.get(heli.index);
        }

        // 1) このフェーズで候補全マスを覆えるなら必中プランを優先
        if (endgame.candidates.length > 0 && endgame.candidates.length <= remaining.length) {
            const coveragePlan = findCurrentPhaseCoveragePlan(remaining, endgame.candidates);
            if (coveragePlan && coveragePlan.has(heli.index)) {
                return coveragePlan.get(heli.index);
            }
        }

        // 2) タスク3の混合分布で共同プランを評価する
        const post = getDecisionPosterior(S);

        const plan = planJointActions(
            remaining,
            post,
            endgame.endgameActive ? endgame : null
        );
        let chosen = plan.actions[0] || { type: 'wait', target: { x: heli.x, y: heli.y } };

        // 3) 中盤2手先読み: 通常プランより十分に良いプランがあれば差し替える
        if (plan.actions && plan.actions.length === remaining.length) {
            const lookahead = chooseLookaheadPlan(remaining, plan.actions);
            if (lookahead && lookahead[0]) chosen = lookahead[0];
        }
        return chosen;
    }

    function cpuPoliceTurn() {
        // 3機のヘリを順に行動させる (遅延付きで可視化)
        S.transitioning = true;
        let heliIdx = 0;
        function nextHeli() {
            if (S.winner != null) { S.transitioning = false; return; }
            if (heliIdx >= S.police.helis.length) {
                // 全機行動済 -> 犯人フェーズへ
                S.transitioning = false;
                maybeEndPolicePhase();
                return;
            }
            const heli = S.police.helis[heliIdx++];
            S.police.selected = heli.index;
            render();

            const action = decidePoliceAction(heli);
            setTimeout(() => {
                if (S.winner != null) { S.transitioning = false; return; }
                if (action.type === 'search') {
                    doSearch(heli, action.target.x, action.target.y);
                } else if (action.type === 'move') {
                    doMoveHeli(heli, action.target.x, action.target.y);
                } else {
                    heli.hasActed = true;
                    addLog(`${heli.label}ヘリは行動できませんでした。`, 'log-alert');
                    render();
                }
                if (S.winner == null) setTimeout(nextHeli, 700);
                else S.transitioning = false;
            }, 500);
        }
        nextHeli();
    }

    /* ==========================================================
       逃走ルート再生アニメ
       ========================================================== */
    let routePlayTimer = null; // 連打による多重再生チェーン防止用
    function showRouteReplay() {
        if (routePlayTimer) { clearTimeout(routePlayTimer); routePlayTimer = null; }
        routeModal.classList.remove('hidden');
        // devicePixelRatio に合わせて輪郭鮮明に描画
        const scale = Math.min(2, window.devicePixelRatio || 1);
        const LOGICAL = 400;
        routeCanvas.width = LOGICAL * scale;
        routeCanvas.height = LOGICAL * scale;
        const ctx = routeCanvas.getContext('2d');
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        const W = LOGICAL, H = LOGICAL;
        const cell = W / B_SIZE;
        // 背景
        ctx.fillStyle = '#2c3a4d';
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= B_SIZE; i++) {
            ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, H); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(W, i * cell); ctx.stroke();
        }
        const pts = S.thief.path.slice();
        if (pts.length === 0) return;
        const cxOf = (p) => p.x * cell + cell / 2;
        const cyOf = (p) => p.y * cell + cell / 2;
        // 全経路を薄く表示
        for (const p of pts) {
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            ctx.beginPath(); ctx.arc(cxOf(p), cyOf(p), 6, 0, Math.PI * 2); ctx.fill();
        }
        // アニメで経路を順に描く
        let idx = 0;
        const play = () => {
            if (routeModal.classList.contains('hidden')) return; // モーダルが閉じたら停止
            if (idx >= pts.length) return;
            const p = pts[idx];
            const cx = cxOf(p), cy = cyOf(p);
            if (idx > 0) {
                const prev = pts[idx - 1];
                const px = cxOf(prev), py = cyOf(prev);
                // マーカー（半径11px）と数字に線がかぶらないよう、
                // 線の両端を円の外側まで縮める
                const dx = cx - px, dy = cy - py;
                const len = Math.hypot(dx, dy) || 1;
                const inset = 13; // 円の半径 + 余白
                const ux = dx / len, uy = dy / len;
                ctx.strokeStyle = '#ffd166';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(px + ux * inset, py + uy * inset);
                ctx.lineTo(cx - ux * inset, cy - uy * inset);
                ctx.stroke();
            }
            // この地点を離れたラウンド = idx+1 (初期地点は Round 1 で離脱)
            const vacateRound = idx + 1;
            // 最終地点＝逃走車の現在地（離脱していない＝痕跡なし）
            const isLast = idx === pts.length - 1;
            const ct = isLast ? null : clueTypeForRound(vacateRound);

            if (ct === null) {
                // 最終位置: 番号ドットではなく車のアイコンを描画
                ctx.font = '26px sans-serif';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText('🚗', cx, cy);
                idx++;
                return;
            }

            const color = ct === 'YELLOW' ? '#ffd54f' : ct === 'RED' ? '#ef5350' : '#42a5f5';
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = '#000';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(vacateRound), cx, cy);
            idx++;
            routePlayTimer = setTimeout(play, 480);
        };
        routePlayTimer = setTimeout(play, 250);
    }

    /* ==========================================================
       初期化・イベント紐付け
       ========================================================== */
    let gameSeedCounter = 0;
    function startGame(mode) {
        // シード未指定（通常プレイ）と ?seed=random のときは、ゲームごとに
        // 違うシードにする。これをしないと初期配置などが毎回同じになる。
        // ?seed=数値 の検証時は従来どおり毎回同じシードで再現可能に保つ。
        if (SEED_PARAM == null || SEED_PARAM === 'random') {
            gameSeedCounter += 1;
            seedRandom((Date.now() + Math.imul(gameSeedCounter, 0x9E3779B9)) >>> 0);
        } else {
            seedRandom(INITIAL_SEED);
        }
        S = createState(mode);
        document.body.classList.remove('thief-view');
        splashScreen.classList.add('hidden');
        gameoverModal.classList.add('hidden');
        routeModal.classList.add('hidden');
        logAreaEl.innerHTML = '';
        buildBoardDOM();
        if (SEED_PARAM != null) {
            addLog(`乱数シード: ${INITIAL_SEED}`, 'log-info');
        }
        if (mode === 'cpu_police') {
            addLog('🚗 犯人ソロプレイを開始。あなたは逃走車の運転手です。', 'log-info');
            addLog('警察CPU: ヘリ3機を自動配置します…', 'log-police');
            cpuSetupHeli();
            // 犯人に潜伏配置フェーズへ
            S.phase = 'SETUP_THIEF';
            render();
        } else {
            addLog(mode === 'cpu' ? '🤖 警察ソロプレイを開始。あなたは警察です。'
                   : mode === '3pvp' ? '👥 3人対戦を開始。犯人1 vs 警察2 (A:緑+桃 / B:黄)'
                   : '👥 2人対戦を開始。', 'log-info');
            addLog('警察: 3機のヘリを交差点に配置してください。', 'log-police');
            render();
        }
    }

    function resetToSplash() {
        gameoverModal.classList.add('hidden');
        routeModal.classList.add('hidden');
        blindOverlay.classList.add('hidden');
        document.body.classList.remove('thief-view');
        splashScreen.classList.remove('hidden');
    }

    function bindEvents() {
        $('#btn-start-pvp').addEventListener('click', () => startGame('pvp'));
        $('#btn-start-3p').addEventListener('click', () => startGame('3pvp'));
        $('#btn-start-cpu').addEventListener('click', () => startGame('cpu'));
        $('#btn-start-cpu-police').addEventListener('click', () => startGame('cpu_police'));
        $('#btn-replay').addEventListener('click', () => startGame(S.mode));
        $('#btn-to-splash').addEventListener('click', resetToSplash);
        $('#btn-review-route').addEventListener('click', showRouteReplay);
        $('#btn-route-close').addEventListener('click', () => {
            if (routePlayTimer) { clearTimeout(routePlayTimer); routePlayTimer = null; }
            routeModal.classList.add('hidden');
        });
        $('#btn-route-play').addEventListener('click', showRouteReplay);

        // ヘリセレクト
        Array.from(heliButtonsEl.children).forEach((btn, i) => {
            btn.addEventListener('click', () => onHeliSelect(i));
        });
        btnEndPoliceTurn.addEventListener('click', () => { buzz(20); endPoliceTurnManually(); });

        // 横画面推奨ヒントの閉じる
        if (btnRotateClose) {
            btnRotateClose.addEventListener('click', () => {
                document.body.classList.add('rot-hint-off');
                buzz(12);
            });
        }

        // Esc でルート再生モーダルのみ閉じる（勝敗モーダルは誤閉じ防止に残す）
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && routeModal && !routeModal.classList.contains('hidden')) {
                if (routePlayTimer) { clearTimeout(routePlayTimer); routePlayTimer = null; }
                routeModal.classList.add('hidden');
            }
        });

        // ゲーム中の誤リロード・タブ閉じ防止（タブレットでのスワイプ事故など）
        window.addEventListener('beforeunload', (e) => {
            const inGame = S && S.phase !== 'GAME_OVER'
                && splashScreen && splashScreen.classList.contains('hidden');
            if (inGame) {
                e.preventDefault();
                e.returnValue = '';
            }
        });

        // タブレットでの長押し（コンテキストメニュー・選択UI）を抑止
        boardContainer.addEventListener('contextmenu', (e) => e.preventDefault());
        document.addEventListener('gesturestart', (e) => e.preventDefault());

        // 画面回転・リサイズ時は盤面座標基準の描画を作り直す
        let relayoutTimer = null;
        const relayout = () => {
            clearTimeout(relayoutTimer);
            relayoutTimer = setTimeout(() => {
                renderSearchlight();
                if (S && S.phase !== 'GAME_OVER') renderRoundTrack();
            }, 120);
        };
        window.addEventListener('resize', relayout);
        window.addEventListener('orientationchange', () => setTimeout(relayout, 260));
        if (window.visualViewport) window.visualViewport.addEventListener('resize', relayout);
    }

    function init() {
        cacheElements();
        bindEvents();
        // 盤面は startGame で生成
    }

    // 検証用デバッグフック（?debug=1 のときだけ公開）
    if (typeof window !== 'undefined' && typeof location !== 'undefined'
        && new URLSearchParams(location.search).get('debug') === '1') {
        window.__VS_POLICE_DEBUG__ = {
            getState: () => S,
            getPosterior: () => getPosterior(S),
            thiefPosterior,
            inferredCandidates: () => inferredCandidates(S),
            decidePoliceAction,
            chooseMinimaxHeliSetup,
            chooseRandomMinimaxHeliSetup,
            searchDistanceForBuilding,
            findCurrentPhaseCoveragePlan,
            buildEndgameContext,
            enumerateConsistentPaths,
            getPathAnalysis,
            getDecisionPosterior: () => getDecisionPosterior(S),
            assignmentCapture,
            findForcedWinPlan,
            minimaxEndgameSolve,
            lookaheadEvaluatePlan,
            chooseLookaheadPlan,
        };
    }

    // Node からのユニットテスト用エクスポート（ブラウザでは無効）
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            createState,
            thiefPosterior,
            getPosterior,
            inferredCandidates,
            searchDistanceForBuilding,
            chooseMinimaxHeliSetup,
            chooseRandomMinimaxHeliSetup,
            findCurrentPhaseCoveragePlan,
            enumerateConsistentPaths,
            analyzeConsistentPaths,
            getPathAnalysis,
            assignmentCapture,
            minimaxEndgameSolve,
            lookaheadEvaluatePlan,
            chooseLookaheadPlan,
        };
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }
})();
