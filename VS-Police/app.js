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
    // ?seed=123 で固定、?seed=random でページ読み込みごとにランダム。
    // 未指定時は固定シード。startGame のたびに同じ初期値へ戻す。
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

    /* 返り値: { counts, total, probs, cells }
       counts[cell] = そのマスで終わる整合経路数
       probs[cell]  = counts / total
       cells        = 確率降順の { x, y, p } 配列 */
    function thiefPosterior(state = S) {
        const N = B_SIZE * B_SIZE;
        const counts = new Float64Array(N);
        const emptyResult = { counts, total: 0, probs: new Float64Array(N), cells: [] };
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

        function dfs(idx, pos, visitedMask, satisfiedMask) {
            // 満たせなくなる痕跡を枝刈り
            for (let k = 0; k < clueAllowed.length; k++) {
                if ((satisfiedMask & (1 << k)) === 0 && clueMaxIdx[k] < idx) return;
            }
            if (idx === maxIdx) {
                if (satisfiedMask === allCluesMask) {
                    counts[pos] += 1;
                    total += 1;
                }
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
        return { counts, total, probs, cells };
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

    /* C(16,3)=560 通りを全探索し、全ビルへの最大捜索距離を最小化する。
       副次評価として合計距離・即時捜索可能数・マンハッタン距離も見る。 */
    function chooseMinimaxHeliSetup() {
        const intersections = [];
        for (let y = 0; y < I_SIZE; y++)
            for (let x = 0; x < I_SIZE; x++)
                intersections.push({ x, y });
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
                    if (!best || compareMinimaxSetup(candidate, best) < 0) best = candidate;
                }
            }
        }
        return best;
    }

    function cpuSetupHeli() {
        const setup = chooseMinimaxHeliSetup();
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
    const SEARCH_INFO_BONUS = 0.06;      // 未捜索ビルを開ける情報価値
    const MOVE_DISCOUNT = 0.8;           // 移動して次ラウンドに捜索する価値の割引
    const MOVE_INFO_WEIGHT = 0.02;       // 移動先の未捜索ビル1つあたりの情報価値
    const MOVE_DIST_PENALTY = 0.01;      // 候補から遠い移動へのペナルティ
    const MOVE_APPROACH_BONUS = 0.10;    // 候補に1手近づく価値
    const ENDGAME_SEARCH_BONUS = 0.35;   // 終盤で候補マスを捜索する価値
    const ENDGAME_MOVE_BONUS = 0.08;     // 終盤で候補マスに近づく移動の価値

    function postProb(post, x, y) {
        return post.probs[y * B_SIZE + x] || 0;
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

    /* 候補が多すぎて覆えない場合の1手先読み。
       犯人CPUの「ヘリから遠い・壁際を好む」方針で候補を再重み付けする。 */
    function applyThiefEscapePrior(post) {
        const candidates = post.cells.filter(c => c.p > 0);
        if (candidates.length <= 1) return post;
        const helis = S.police.helis.filter(h => h.x != null);
        if (helis.length === 0) return post;
        const probs = new Float64Array(B_SIZE * B_SIZE);
        let total = 0;
        for (const c of candidates) {
            let minDist = Infinity;
            for (const h of helis) {
                const d = Math.abs(c.x - h.x) + Math.abs(c.y - h.y);
                if (d < minDist) minDist = d;
            }
            const edge = (c.x === 0 || c.x === B_SIZE - 1 || c.y === 0 || c.y === B_SIZE - 1) ? 1 : 0;
            const weight = c.p * (1 + 0.06 * (minDist + edge * 0.5));
            probs[c.y * B_SIZE + c.x] = weight;
            total += weight;
        }
        if (total <= 0) return post;
        const cells = [];
        for (let ci = 0; ci < probs.length; ci++) {
            if (probs[ci] > 0) {
                probs[ci] /= total;
                cells.push({ x: ci % B_SIZE, y: (ci / B_SIZE) | 0, p: probs[ci] });
            }
        }
        cells.sort((a, b) => b.p - a.p || a.y - b.y || a.x - b.x);
        return { ...post, probs, cells, priorAdjusted: true };
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
            let value = postProb(post, b.x, b.y);
            if (!building.isSearched) value += SEARCH_INFO_BONUS;
            if (endgame && endgame.candidateKeys.has(ck)) value += ENDGAME_SEARCH_BONUS;
            actions.push({ type: 'search', target: { x: b.x, y: b.y }, cellKey: ck, value });
        }

        const currentAdj = adjacentBuildings(heli.x, heli.y)
            .filter(b => b.x >= 0 && b.y >= 0 && b.x < B_SIZE && b.y < B_SIZE);
        let currentCoverage = 0, currentUnsearched = 0;
        for (const b of currentAdj) {
            currentCoverage += postProb(post, b.x, b.y);
            if (!S.buildings[b.y][b.x].isSearched) currentUnsearched++;
        }
        let currentNearest = Infinity;
        for (const c of post.cells) {
            if (c.p <= 0) continue;
            const d = searchDistanceForBuilding(c.x, c.y, heli.x, heli.y);
            if (d < currentNearest) currentNearest = d;
        }
        if (!isFinite(currentNearest)) currentNearest = 0;

        for (const m of validHeliMoves(heli)) {
            const adj = adjacentBuildings(m.x, m.y)
                .filter(b => b.x >= 0 && b.y >= 0 && b.x < B_SIZE && b.y < B_SIZE);
            let coverage = 0, unsearched = 0;
            for (const b of adj) {
                coverage += postProb(post, b.x, b.y);
                if (!S.buildings[b.y][b.x].isSearched) unsearched++;
            }
            let nearest = Infinity;
            for (const c of post.cells) {
                if (c.p <= 0) continue;
                const d = searchDistanceForBuilding(c.x, c.y, m.x, m.y);
                if (d < nearest) nearest = d;
            }
            if (!isFinite(nearest)) nearest = 0;
            let value = MOVE_DISCOUNT * (coverage - currentCoverage)
                + MOVE_INFO_WEIGHT * (unsearched - currentUnsearched)
                - MOVE_DIST_PENALTY * nearest
                + MOVE_APPROACH_BONUS * Math.max(0, currentNearest - nearest);
            if (endgame && endgame.candidateKeys.size > 0) {
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

        function evaluate(idx, searchedKeys, moveTargets, score) {
            if (idx === helis.length) {
                if (score > bestScore + 1e-9) {
                    bestScore = score;
                    bestCombo = chosen.slice();
                }
                return;
            }
            for (const action of actionLists[idx]) {
                let add = 0;
                let nextSearched = searchedKeys;
                let nextMoves = moveTargets;
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
                    add = action.value;
                    nextMoves = new Set(moveTargets);
                    nextMoves.add(mk);
                } else {
                    add = action.value;
                }
                chosen[idx] = action;
                evaluate(idx + 1, nextSearched, nextMoves, score + add);
            }
        }

        evaluate(0, new Set(), new Set(), 0);
        return { actions: bestCombo || [], score: bestScore };
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

        // 1) このフェーズで候補全マスを覆えるなら必中プランを優先
        if (endgame.candidates.length > 0 && endgame.candidates.length <= remaining.length) {
            const coveragePlan = findCurrentPhaseCoveragePlan(remaining, endgame.candidates);
            if (coveragePlan && coveragePlan.has(heli.index)) {
                return coveragePlan.get(heli.index);
            }
        }

        // 2) 候補が残り手数に収まるなら候補を意識した評価、
        //    収まらないなら1手先読みで候補を絞る
        let post = rawPost;
        if (!endgame.canCoverAllEventually) post = applyThiefEscapePrior(rawPost);

        const plan = planJointActions(
            remaining,
            post,
            endgame.endgameActive ? endgame : null
        );
        return plan.actions[0] || { type: 'wait', target: { x: heli.x, y: heli.y } };
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
                ctx.strokeStyle = '#ffd166';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(cxOf(prev), cyOf(prev));
                ctx.lineTo(cx, cy);
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
    function startGame(mode) {
        seedRandom(INITIAL_SEED);
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
            searchDistanceForBuilding,
            findCurrentPhaseCoveragePlan,
            buildEndgameContext,
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
            findCurrentPhaseCoveragePlan,
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
