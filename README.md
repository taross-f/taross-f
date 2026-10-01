# 🧱 Shared Tower — open an issue. There is no other setup.

**English** · [日本語](README.ja.md)

Everyone stacks onto one shared tower. Put a single x coordinate in an issue and a block drops onto
the board below. Knock the tower over and its score goes to the hall of fame, then the next round
starts from an empty platform.

<!-- BOARD:START -->
[![Tower board](assets/board.svg?v=13-1)](https://github.com/taross-f/taross-f/issues/new?template=play.yml)

**[▶ Drop a block](https://github.com/taross-f/taross-f/issues/new?template=play.yml)** — open an issue with one integer between 140 and 340. That is the whole game.

| Round | Height | Blocks | Best ever |
|---:|---:|---:|---:|
| 1 | 97 px | 13 | 97 px |
<!-- BOARD:END -->

## How to play

1. **[Open an issue](https://github.com/taross-f/taross-f/issues/new?template=play.yml)** — the `play` label is applied for you
2. Write one **integer between 140 and 340** in the body — the x coordinate you are dropping at
3. Within a minute GitHub Actions runs the physics, updates the board SVG and this README, and replies on your issue

| Rule | |
|:--|:--|
| Platform | 200px wide, from `x = 140` to `340`. Leave it and you fall |
| Block shape | Derived from the issue number. **You do not get to choose** |
| Score | Height of the highest corner of any block |
| Collapse | A block leaves the platform, or the tower loses 20px or more against the previous turn |
| Cooldown | One drop per player every 10 minutes |

On a collapse the round's score is recorded, the blocks are cleared, and a new round begins.

Only the `play` label decides whether an issue is a move — the title is never read, and an issue
without the label is left alone as an ordinary issue. In the body the **first integer wins**, so
`250`, `x=250` and `２５０` all mean the same thing.

## How it works

No external services and no database. The only state is the **action log** in `state.json`; the
board is rebuilt by replaying that log from scratch on every run.

| | |
|:--|:--|
| `src/rng.js` | Deterministic PRNG (xorshift32). `Math.random()` is never used |
| `src/sim.js` | Fixed-step (1/120s) 2D rigid body simulator. SAT + impulse solver |
| `src/render.js` | Board → SVG. A single still frame, no `<script>` |
| `src/parse.js` | Issue body → coordinate, or a reason to reject it |
| `src/main.js` | Entry point called from Actions |

```sh
npm test          # determinism, collapse rules, replay agreement, SVG safety
npm run demo      # play 30 scripted turns and write the SVGs to assets/demo/
```

The same action log always rebuilds the same board. Change the simulator and the replay changes with
it — which is exactly what the golden tests are there to catch.

---

<a href="https://github.com/anuraghazra/github-readme-stats">
  <img align="left" src="https://github-readme-stats.vercel.app/api?username=taross-f&count_private=true&show_icons=true&&theme=dark" />
</a>
<a href="https://github.com/anuraghazra/github-readme-stats">
  <img align="left" src="https://github-readme-stats.vercel.app/api/top-langs/?username=taross-f&&theme=dark" />
</a>
