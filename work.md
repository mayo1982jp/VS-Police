# VS-Police 警察CPU強化 作業指示書 — 未実装の提案 4 / 5 / 6 / 8

> 本書は「提案1・2・3・7・9 実装済み（commit `8a33645`）」を前提とする。
> 原文の提案文は repo に残っていないため、現行コードの残存課題から
> AI が直接着手できる形に再構成した。番号は未実装分をそのまま保持する。
> 作業前に実装済み内容と論理が衝突しないか最終確認すること。

## 共通ルール

### 対象ファイル
- `VS-Police/app.js` … 本体（警察CPU）
- `tools/benchmark.js` … 自己対戦ベンチマーク（提案9 実装済み）

### 変更してはいけない前提
- 提案1: `maybeEndPolicePhase()` の `cpu_police` 手詰まり判定
- 提案2: `revealedClues.foundRound` と `index <= foundRound-2` 制約
- 提案3: 痕跡ゼロ時の条件付き再捜索（`REPEAT_SEARCH_MIN_AGE=2` / `REPEAT_SEARCH_RATIO=1.05`）
- 提案7: `chooseNextHeli()` の順序選択（ソルバー発動時は既定順）
- 提案9: `benchmark.js` の `--thief` / `--order` / 出力指標

### 共通の検証（各提案の完了条件に含める）
```powershell
node --check VS-Police/app.js
node --check tools/benchmark.js
node tools/benchmark.js --games 10 --thief all --order smart
node tools/benchmark.js --games 10 --thief all --order fixed
# 提案ごとの A/B が必要なら:
node tools/benchmark.js --games 20 --thief distance --order both --verbose
```
- 違法手・例外・無限ループが1件も出ないこと
- `trap` 以外の新理由で落ちていないこと
- ベンチマークの `police` 勝率 / `cap/search` / `avgR` を変更前後で記録すること

---

## 提案4: 終盤ソルバーの発動範囲と犯人モデルの精度向上

### 背景・現状
- `findForcedWinPlan()` / `minimaxEndgameSolve()` は `OLVER_MAX_PATHS = 500` かつ
  残りフェーズ・候補数・経路数の追加条件を満たす場合にしか発動しない
- 犯人側は `thiefExtend()` で「最も安全な移動1手」だけを残す近似（adversarial）
- ノード上限は `SOLVER_NODE_LIMIT=30000` / `MINIMAX_NODE_LIMIT=25000`
- このため中盤で勝ち筋が見えていてもソルバーが走らない局面がある

### 目的
終盤でない局面でも勝率最大化の探索が走るようにし、手詰まり・捕獲を増やす。

### 実装タスク
1. 発動条件の見直し
   - `SOLVER_MAX_PATHS` を 500 → 800/1000 前後に引き上げ（別定数化も可）
   - `remainingPhases <= 4 || candidateCount <= 6 || paths.length <= 40`
     のOR条件を、ベンチマークで効果のあった条件に緩和
   - 引き上げで1局あたり `ms/g` が過大にならないことを `benchmark.js` で確認
2. 犯人モデルの改善
   - 現状の「最安全1手」から、「安全上位2手＋手詰まり枝を警察勝ち」等を検討
   - `probability` 重み付きの expectimax 形にできるならそちらを優先
   - 手詰まり経路は従来どおり警察勝ちとして計数すること
3. 探索の効率化
   - `solverBeliefKey()` のメモ化キーを強化（`foundRound` 込みの署名で再利用）
   - `ABORT` 時のフォールバックが従来の `planJointActions` に戻ることを確認

### 完了条件
- [ ] 単体で経路数 500〜1000 程度の局面でソルバーが発動する
- [ ] `node tools/benchmark.js --games 20 --thief distance --order both`
      で勝率または `cap/search` が悪化していない
- [ ] ソルバーが走らない局面での通常プランと結果が変わらない

### リスク
- 経路数が多い局面で探索爆発 → ノード上限とタイムアウトに必ず上限を付ける
- 提案7との相互作用：ソルバー発動時は `chooseNextHeli()` が既定順を返す前提を守る

---

## 提案5: ヘリ共同プランの移動評価強化（将来カバーの先読み）

### 背景・現状
- `generateHeliActions()` の移動価値は `assignmentCapture()` × `MOVE_DISCOUNT=0.8`
  と `MOVE_DIST_PENALTY=0.01` / `FORCED_COVER_BONUS=0.30` のヒューリスティック
- `planJointActions()` は1ラウンド分の発見確率しか見ていない
- ヘリ同士の移動先重複・次ラウンドの捜索窓の重複を十分に避けられていない

### 目的
「今動いて、次ラウンドで新規に捜索できる高確率マス」を正しく評価し、
ヘリの張り付き・空回りを減らす。

### 実装タスク
1. 移動価値の2ラウンド化（`generateHeliActions()`）
   - 移動後の次ラウンド分布 `propagated.probs` に対する割当捕獲率を主スコアに
   - `MOVE_DISCOUNT` をラウンド残数に応じて減衰させる（終盤は割り引かない等）
   - 他ヘリの計画移動先と重複する移動はマイナス調整
2. 共同プランへの反映（`planJointActions()`）
   - 移動／捜索の混在プランを評価する際、翌ラウンドの
     `assignmentCapture(nextPositions, nextPost)` を加算
   - 優先順位: 今ラウンドの捕獲 → 翌ラウンドの捕獲 → 移動回数の少なさ
3. パラメータを定数化
   - 新規定数を `NEXT_ROUND_WEIGHT` 等として集約（マジックナンバー禁止）
   - ベンチマークで `search/g` が増えつつ `avgR` が下がる方向かを確認

### 完了条件
- [ ] 遠方に高確率マスがある局面で移動が選ばれることを単体確認
- [ ] ヘリ3機が同じ候補マスへ殺到しない（重複率の低下を `benchmark` で確認）
- [ ] 実ブラウザ `cpu_police` で R1〜R3 の CPU ターンが正常完了・コンソールエラーなし

### リスク
- 2ラウンド化で計算量が増える → `LOOKAHEAD_MAX_PATHS=12000` の上限を継承
- 提案3の条件付き再捜索と競合しないよう、再捜索候補との相対比較を残す

---

## 提案6: 相手モデルと混合分布の係数チューニング

### 背景・現状
- `opponentProbsFromPaths()` はヘリ現在位置で近似（過去位置履歴なし）
- 混合係数は固定: `MIX_COUNT=0.60` / `MIX_SUPPORT=0.25` / `MIX_OPPONENT=0.15`
- `OPP_STEP_WEIGHT=0.05`、`PROB_FLOOR=0.005`
- これらの係数は理論値ではなく、ベンチマークで検証されていない

### 目的
- `tools/benchmark.js` の犯人政策（`distance/edge/survival/human`）に対する
  警察勝率を最大化する係数に合わせる

### 実装タスク
1. 係数の外部化
   - `PI_WEIGHTS` 等のオブジェクトに集約し、一箇所でグリッドサーチ可能にする
   - 変更は `VS-Police/app.js` の定数定義部のみに閉じる
2. グリッドサーチの実施
   ```powershell
   node tools/benchmark.js --games 20 --thief all --order smart --json
   ```
   - `MIX_OPPONENT` を 0.05〜0.30、`OPP_STEP_WEIGHT` を 0.02〜0.10 で振る
   - 評価指標は総合勝率＋`cap/search`、次点で `avgR`
   - `survival`（逃げ広さ重視）で勝率が落ちる係数は不採用
3. 結果の記録
   - 最良係数と理由を `app.js` の定数コメントに残す
   - `benchmark.js` の出力サマリをコミットメッセージに含められる形で残す

### 完了条件
- [ ] 20局/政策で、変更前より総合警察勝率が悪化していない
- [ ] 係数変更が1箇所の定数定義で完結している
- [ ] 「ベンチマークで選んだ係数である」旨の根拠コメントが残っている

### リスク
- 過適合：`human` 政策1つに寄せすぎて他政策で不安定にならないこと
- 係数調整だけなので、推論の制約（提案2）自体は変更しない

---

## 提案8: 初期配置と序盤（痕跡ゼロ）カバレッジの最適化

### 背景・現状
- `chooseMinimaxHeliSetup()` は「全ビルへの最大捜索距離」の最小化が主目的
- 序盤は `posterior` がほぼ一様で、痕跡ゼロ＋未捜索優先だと
  遠くで痕跡が出てもヘリが寄らないことがある
- `INFO_GAIN_WEIGHT=0.45` は R11 で 0 に減衰する線形式だが、初期配置との整合は未検証

### 目的
序盤の情報収集と初手の捜索範囲を広げ、最初の痕跡を早く引く。

### 実装タスク
1. 初期配置の評価項目追加（`chooseMinimaxHeliSetup()`）
   - 最大捜索距離が最小の配置群の中で、中央寄り／互いに独立した配置を優先
   - 同点タイブレイクに `即時捜索可能マス数` と `次ラウンド到達性` を追加
   - 乱択プール（32通り）の中でも最小距離前提を維持すること
2. 序盤の探索改善（`generateHeliActions()` / `searchValueForCell()`）
   - 痕跡ゼロかつ R1〜R3 では `infoGain` の重みを一段上げる
   - 「未捜索マスへの移動」を捜索価値と同スケールで比較（提案5と連携）
   - 提案3の再捜索条件（2ラウンド・1.05倍）との順序を崩さない
3. 検証
   - `clue/g` と初回痕跡発見ラウンドの平均が改善するか `benchmark` で確認
   - `rep/g` が急増する調整は不採用

### 完了条件
- [ ] R1〜R2 での初回痕跡発見が早まる、または `clue/g` が上がる
- [ ] 初期配置の最大捜索距離が従来（2手）を超えていない
- [ ] 実ブラウザで `cpu_police` の初回配置＋R1 CPU ターンが正常表示

### リスク
- 初期配置の改変は全体勝率に大きく影響するため、提案6の係数調整と同時実施しない
- 序盤の情報重視が行き過ぎて捕獲手が遅れないこと

---

## 作業順序の推奨

1. **提案6**（係数チューニング）— 短期・低リスクで勝率を見える化
2. **提案5**（移動評価）— 提案6の後に共同プランの改善を確認しやすい
3. **提案8**（初期配置・序盤）— 提案5とセットで序盤の再現性を取る
4. **提案4**（ソルバー拡大）— 計算量が最大。最後に `ms/g` 制約下で実施

## 出力フォーマット（各提案の完了報告用）

```markdown
### 提案N 完了報告
- 変更ファイル: `VS-Police/app.js`（`関数名`）
- 変更内容: …
- 検証: `node tools/benchmark.js --games 20 --thief all --order both`
- 結果: 警察勝率 xx%（変更前 xx%）/ cap/search xx% / avgR x.xx / ms/g xxxx
- リスク・残課題: …
```
