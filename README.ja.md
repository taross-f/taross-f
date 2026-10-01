# 🧱 Shared Tower — Issue を立てるだけ。それ以外の準備は不要。

[English](README.md) · **日本語**

みんなで 1 本のタワーを積み上げます。Issue に x 座標をひとつ書くと、下の盤面にブロックが 1 個落ちてきます。
崩したらその周回のスコアが殿堂入りし、次の周回が空の土台から始まります。

<!-- BOARD:START -->
[![タワーの盤面](assets/board.svg?v=13-1)](https://github.com/taross-f/taross-f/issues/new?template=play.yml)

**[▶ 1手打つ](https://github.com/taross-f/taross-f/issues/new?template=play.yml)** — x 座標 (140–340) を書いて issue を立てるだけ。

| 周回 | 高さ | ブロック | 最高記録 |
|---:|---:|---:|---:|
| 1 | 97 px | 13 | 97 px |
<!-- BOARD:END -->

## 遊び方

1. **[Issue を立てる](https://github.com/taross-f/taross-f/issues/new?template=play.yml)** — ラベル `play` は自動で付きます
2. 本文に **140 〜 340 の整数** を 1 つだけ書く — これが投下する x 座標です
3. 1 分ほどで GitHub Actions が物理シミュレーションを回し、盤面 SVG と README を更新して Issue に返信します

| ルール | |
|:--|:--|
| 土台 | `x = 140` 〜 `340` の 200px。ここから外れたら落下 |
| ブロックの形 | Issue 番号から決まります。**選べません** |
| スコア | 一番高いブロックの頂点の高さ |
| 崩壊 | ブロックが台から落ちる、または高さが前ターンより 20px 以上減ったら |
| 連投 | 同じ人は 10 分に 1 回まで |

崩壊するとその周回のスコアが記録され、ブロックが片付けられて次の周回が始まります。

一手として扱うかどうかを決めているのは **ラベル `play` だけ** です。タイトルは一切読んでいません。
ラベルがない Issue は普通の Issue としてそのまま放置されます。本文は **最初に現れる整数** を拾うので、
`250` も `x=250` も `２５０` もすべて同じ意味になります。

## 仕組み

外部サービスも DB も使っていません。状態は `state.json` の **行動ログだけ** で、盤面は毎回そのログを
最初からリプレイして復元しています。

| | |
|:--|:--|
| `src/rng.js` | 決定論 PRNG (xorshift32)。`Math.random()` は使いません |
| `src/sim.js` | 固定ステップ (1/120s) の 2D 剛体シミュレータ。SAT + インパルスソルバ |
| `src/render.js` | 盤面 → SVG。`<script>` なしの静止 1 枚 |
| `src/parse.js` | Issue 本文 → 座標 or 却下理由 |
| `src/main.js` | Actions から呼ばれる入口 |

```sh
npm test          # 決定論性・崩壊判定・リプレイ一致・SVG 健全性
npm run demo      # 30手ぶん流して assets/demo/ に SVG を出力
```

同じ行動ログからは必ず同じ盤面が再現されます。シミュレータを変更するとリプレイも変わる — それを
検出するためのゴールデンテストです。
