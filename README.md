# 🧱 Shared Tower — Issue を立てるだけ。それ以外の準備は不要。

みんなで 1 本のタワーを積み上げるゲームです。Issue に x 座標をひとつ書くと、ブロックが 1 個落ちてきます。
崩したら記録を残して次の周回へ。**Open an issue with one number — that is the whole game.**

<!-- BOARD:START -->
[![Tower board](assets/board.svg?v=10-1)](https://github.com/taross-f/taross-f/issues/new?template=play.yml)

**[▶ 1手打つ / Drop a block](https://github.com/taross-f/taross-f/issues/new?template=play.yml)** — x 座標 (140–340) を書いて issue を立てるだけ。

| Round | Height | Blocks | Best ever |
|---:|---:|---:|---:|
| 1 | 120 px | 10 | 120 px |
<!-- BOARD:END -->

## 遊び方 / How to play

1. **[Issue を立てる](https://github.com/taross-f/taross-f/issues/new?template=play.yml)**（ラベル `play` は自動で付きます）
2. 本文に落としたい **x 座標（140〜340 の整数）** を 1 つだけ書く
3. 数十秒待つと GitHub Actions が物理シミュレーションを回し、盤面 SVG と README を更新して Issue に結果を返します

| ルール | |
|:--|:--|
| 土台 | `x = 140` 〜 `340` の 200px。ここから外れたら落下 |
| ブロックの形 | Issue 番号から決まります。**選べません** |
| スコア | 一番高いブロックの頂点の高さ |
| 崩壊 | ブロックが台から落ちる、または高さが前ターンより 20px 以上減ったら |
| 連投 | 同じ人は 10 分に 1 回まで |

崩壊するとその周回のスコアが殿堂入りに記録され、ブロックが片付けられて次の周回が始まります。

## 仕組み / How it works

外部サービスも DB も使っていません。状態は `state.json` の**行動ログだけ**で、盤面は毎回リプレイして復元します。

| | |
|:--|:--|
| `src/rng.js` | 決定論 PRNG (xorshift32)。`Math.random()` は使いません |
| `src/sim.js` | 固定ステップ (1/120s) の 2D 剛体シミュレータ。SAT + インパルスソルバ |
| `src/render.js` | 盤面 → SVG（`<script>` なしの静止 1 枚） |
| `src/parse.js` | Issue 本文 → 座標 or 却下理由 |
| `src/main.js` | Actions から呼ばれる入口 |

```sh
npm test          # 決定論性・崩壊判定・リプレイ一致・SVG 健全性
npm run demo      # 30手ぶん流して assets/demo/ に SVG を出力
```

同じ行動ログからは必ず同じ盤面が再現されます。シミュレータを変更するとリプレイが変わるため、テストがそれを検出します。

---

<a href="https://github.com/anuraghazra/github-readme-stats">
  <img align="left" src="https://github-readme-stats.vercel.app/api?username=taross-f&count_private=true&show_icons=true&&theme=dark" />
</a>
<a href="https://github.com/anuraghazra/github-readme-stats">
  <img align="left" src="https://github-readme-stats.vercel.app/api/top-langs/?username=taross-f&&theme=dark" />
</a>
