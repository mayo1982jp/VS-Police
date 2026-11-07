const mod = await import("./app.js");
const api = mod.default ?? mod;
const { STRONG_POLICE_SETUP, chooseStrongPoliceSetup, POLICE_INITIAL_COMBOS_ALL } = api;

console.log("=== 強い警察CPU minimax 初期配置全探索 結果 ===");
console.log("POLICE_INITIAL_COMBOS_ALL.length =", POLICE_INITIAL_COMBOS_ALL.length);
console.log("25C3 =", 25*24*23/6, "（期待値と一致するか確認）");
console.log("");

if (STRONG_POLICE_SETUP) {
    console.log("STRONG_POLICE_SETUP =");
    console.log("  combo (警察車初期位置 3ビル):");
    for (const cell of STRONG_POLICE_SETUP.combo) {
        console.log(`    (${cell.x},${cell.y})`);
    }
    console.log("  assign (ヘリ割り当て):", STRONG_POLICE_SETUP.assign);
    console.log("");
    console.log("→ この配置が犯人の最善応答値（評価関数）を最小化する配置");
} else {
    console.log("STRONG_POLICE_SETUP が undefined のまま → 初期化中にエラー");
}

console.log("");
console.log("=== 再計算確認（chooseStrongPoliceSetup() を直接呼び出し） ===");
const t0 = performance.now();
const rerun = chooseStrongPoliceSetup();
const dt = (performance.now() - t0).toFixed(2);
console.log("calculate time:", dt, "ms");
if (rerun) {
    console.log("結果（再計算）:");
    console.log("  combo:", rerun.combo.map(c => `(${c.x},${c.y})`).join(", "));
    console.log("  assign:", rerun.assign);
    console.log("  最善応答値（小さいほど良い）:", rerun.eval);
}
console.log("");
console.log("OK");
