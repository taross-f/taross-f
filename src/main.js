/**
 * Entry point invoked by the Actions workflow.
 *
 * Reads the issue out of the environment (never off the command line, so a
 * hostile issue body can never reach a shell), validates it, replays the stored
 * action log, applies the new move, and writes back state.json, the SVGs and the
 * README block. Everything it wants the workflow to do next comes back through
 * GITHUB_OUTPUT.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { parseAction, X_MIN, X_MAX } from './parse.js';
import { createWorld, dropBlock, replay } from './sim.js';
import { buildView, renderBoard, renderShare } from './render.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  state: join(ROOT, 'state.json'),
  readme: join(ROOT, 'README.md'),
  readmeJa: join(ROOT, 'README.ja.md'),
  board: join(ROOT, 'assets', 'board.svg'),
  share: join(ROOT, 'assets', 'share.svg'),
};

/** Every README the board is mirrored into, and the language each is written in. */
export const README_TARGETS = [
  { path: PATHS.readme, lang: 'en' },
  { path: PATHS.readmeJa, lang: 'ja' },
];

export const MARKER_START = '<!-- BOARD:START -->';
export const MARKER_END = '<!-- BOARD:END -->';
export const HALL_OF_FAME_SIZE = 5;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export function defaultState() {
  return {
    version: 1,
    round: 1,
    actions: [],
    hallOfFame: [],
    lastPlayedBy: {},
  };
}

export function readState(file) {
  if (!existsSync(file)) return defaultState();

  const raw = readFileSync(file, 'utf8').trim();
  if (raw === '') return defaultState();

  const parsed = JSON.parse(raw);
  const base = defaultState();
  return {
    version: parsed.version ?? base.version,
    round: Number.isInteger(parsed.round) && parsed.round > 0 ? parsed.round : base.round,
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    hallOfFame: Array.isArray(parsed.hallOfFame) ? parsed.hallOfFame : [],
    lastPlayedBy: parsed.lastPlayedBy && typeof parsed.lastPlayedBy === 'object'
      ? parsed.lastPlayedBy
      : {},
  };
}

export function writeState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function bestHeight(hallOfFame) {
  return hallOfFame.reduce((max, e) => (e.height > max ? e.height : max), 0);
}

// ---------------------------------------------------------------------------
// applying a move
// ---------------------------------------------------------------------------

/**
 * Replay the round so far, drop the new block, and fold the outcome back into
 * state. Returns a new state object; the input is not modified.
 *
 * @param {object} state
 * @param {{issue:number,user:string,x:number,at:string}} action
 */
export function applyPlay(state, action) {
  const history = replay(state.actions);

  // The stored log never contains a collapsing move, so a collapse here means
  // the simulator no longer agrees with the record it produced. Close the round
  // out honestly rather than pretending the board still stands.
  const drifted = history.collapsed;

  let world = history.world;
  let height = history.height;
  let round = state.round;
  let actions = state.actions;
  let hallOfFame = state.hallOfFame;

  if (drifted) {
    hallOfFame = recordRound(hallOfFame, {
      round,
      height: Math.round(height),
      blocks: world.bodies.length - 1,
      collapsedBy: history.turns[history.turns.length - 1].user,
      at: action.at,
      note: 'closed out after a simulator change',
    });
    round += 1;
    actions = [];
    world = createWorld();
    height = 0;
  }

  const previousBest = bestHeight(hallOfFame);
  const result = dropBlock(world, action, height);

  const next = {
    ...state,
    round,
    actions,
    hallOfFame,
    lastPlayedBy: { ...state.lastPlayedBy, [action.user]: action.at },
  };

  let collapseEntry = null;

  if (result.collapsed) {
    collapseEntry = {
      round: next.round,
      height: Math.round(result.height),
      blocks: result.world.bodies.length - 1,
      collapsedBy: action.user,
      at: action.at,
    };
    next.hallOfFame = recordRound(next.hallOfFame, collapseEntry);
    next.round += 1;
    next.actions = [];

    // The next round starts from an empty platform.
    world = createWorld();
    height = 0;
  } else {
    next.actions = [...actions, action];
    world = result.world;
    height = result.height;
  }

  const view = buildView(next, world, height, collapseEntry);

  // The share card celebrates a score, so it has to show the board that scored
  // it - not the empty platform that replaces it. The hall of fame is taken from
  // before this round was recorded so the dashed line is the record it was
  // measured against rather than a line drawn on top of itself.
  const shareView = collapseEntry
    ? buildView(
      { ...next, round: collapseEntry.round, actions: [action], hallOfFame },
      result.world,
      result.height,
      collapseEntry,
    )
    : view;

  return {
    state: next,
    world,
    height,
    view,
    shareView,
    result,
    collapseEntry,
    drifted,
    previousBest,
    recordBroken: !result.collapsed && result.height > previousBest && previousBest > 0,
  };
}

function recordRound(hallOfFame, entry) {
  return [...hallOfFame, entry]
    .sort((a, b) => (b.height - a.height) || (a.round - b.round))
    .slice(0, HALL_OF_FAME_SIZE);
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

/** Replace only the marked region; everything else in the README is untouched. */
export function replaceBoardBlock(readme, block) {
  const start = readme.indexOf(MARKER_START);
  const end = readme.indexOf(MARKER_END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `README is missing the ${MARKER_START} / ${MARKER_END} markers; refusing to guess where the board goes`,
    );
  }

  const before = readme.slice(0, start + MARKER_START.length);
  const after = readme.slice(end);
  return `${before}\n${block}\n${after}`;
}

function escapeMd(value) {
  return String(value).replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

/**
 * Wording for the generated block, per language. English is the primary
 * README; Japanese lives in README.ja.md and is reachable from the switcher.
 */
const BOARD_TEXT = {
  en: {
    alt: 'Tower board',
    cta: (url) => `**[▶ Drop a block](${url})** — `
      + `open an issue with one integer between ${X_MIN} and ${X_MAX}. That is the whole game.`,
    statsHead: ['Round', 'Height', 'Blocks', 'Best ever'],
    collapse: (c) => `> Round ${c.round} came down at ${escapeMd(c.height)} px `
      + `with ${c.blocks} blocks. Last drop by @${escapeMd(c.collapsedBy)}. A new round is underway.`,
    fameSummary: 'Hall of fame',
    fameHead: ['#', 'Round', 'Height', 'Blocks', 'Last drop'],
  },
  ja: {
    alt: 'タワーの盤面',
    cta: (url) => `**[▶ 1手打つ](${url})** — `
      + `x 座標 (${X_MIN}–${X_MAX}) を書いて issue を立てるだけ。`,
    statsHead: ['周回', '高さ', 'ブロック', '最高記録'],
    collapse: (c) => `> Round ${c.round} は ${escapeMd(c.height)} px / ${c.blocks} blocks で崩壊。`
      + `最後に置いたのは @${escapeMd(c.collapsedBy)}。新しい周回が始まっています。`,
    fameSummary: '殿堂入り',
    fameHead: ['#', '周回', '高さ', 'ブロック', '最後の一手'],
  },
};

export const LANGUAGES = Object.keys(BOARD_TEXT);

export function buildBoardBlock(state, view, repo, lang = 'en') {
  const t = BOARD_TEXT[lang];
  if (!t) throw new Error(`no board wording for language "${lang}"`);

  const newIssue = `https://github.com/${repo}/issues/new?template=play.yml`;
  // camo caches aggressively; the query is what makes an updated board show up.
  const src = `assets/board.svg?v=${state.actions.length}-${state.round}`;

  const lines = [];
  lines.push(`[![${t.alt}](${src})](${newIssue})`);
  lines.push('');
  lines.push(t.cta(newIssue));
  lines.push('');
  lines.push(`| ${t.statsHead.join(' | ')} |`);
  lines.push('|---:|---:|---:|---:|');
  lines.push(`| ${state.round} | ${Math.round(view.height)} px | ${view.blocks.length} `
    + `| ${Math.round(view.bestOverall)} px |`);

  if (view.collapsedBy) {
    lines.push('');
    lines.push(t.collapse(view.collapsedBy));
  }

  if (state.hallOfFame.length > 0) {
    lines.push('');
    lines.push(`<details><summary>${t.fameSummary}</summary>`);
    lines.push('');
    lines.push(`| ${t.fameHead.join(' | ')} |`);
    lines.push('|---:|---:|---:|---:|:--|');
    state.hallOfFame.forEach((e, i) => {
      lines.push(`| ${i + 1} | ${e.round} | ${e.height} px | ${e.blocks} `
        + `| @${escapeMd(e.collapsedBy)} |`);
    });
    lines.push('');
    lines.push('</details>');
  }

  return lines.join('\n');
}

/**
 * Rewrite the marked region in every README that exists.
 *
 * A translation that is present but stale is worse than no translation, so a
 * README that exists without markers is an error rather than a quiet skip.
 */
export function refreshReadmes(state, view, repo) {
  const updated = [];
  for (const { path, lang } of README_TARGETS) {
    if (!existsSync(path)) continue;
    const current = readFileSync(path, 'utf8');
    writeFileSync(path, replaceBoardBlock(current, buildBoardBlock(state, view, repo, lang)));
    updated.push(path);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export function writeArtifacts(state, view, { share, shareView }) {
  mkdirSync(dirname(PATHS.board), { recursive: true });
  writeFileSync(PATHS.board, `${renderBoard(view)}\n`);
  if (share) writeFileSync(PATHS.share, `${renderShare(shareView || view)}\n`);
  writeState(PATHS.state, state);
}

// ---------------------------------------------------------------------------
// workflow plumbing
// ---------------------------------------------------------------------------

function setOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  const text = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  if (file) appendFileSync(file, `${text}\n`);
  process.stdout.write(`${text}\n`);
}

function writeReply(body) {
  const dir = process.env.RUNNER_TEMP || tmpdir();
  const file = join(dir, 'tower-reply.md');
  writeFileSync(file, body);
  return file;
}

function successReply(applied, repo) {
  const { result, view, collapseEntry, state } = applied;
  const lines = [];

  if (collapseEntry) {
    lines.push('## Collapsed / 崩壊');
    lines.push('');
    lines.push(`Round ${collapseEntry.round} ended here, recorded at `
      + `**${collapseEntry.height} px / ${collapseEntry.blocks} blocks**.`);
    lines.push('');
    lines.push(`Round ${state.round} has started from an empty platform.`);
    lines.push('');
    lines.push(`Round ${collapseEntry.round} は ${collapseEntry.height} px / `
      + `${collapseEntry.blocks} blocks で終了。次の周回が始まっています。`);
  } else {
    lines.push('## Placed / 設置');
    lines.push('');
    lines.push(`Height **${Math.round(result.height)} px**, `
      + `**${view.blocks.length}** blocks, Round **${state.round}**.`);
    if (applied.recordBroken) {
      lines.push('');
      lines.push('That is a new record.');
    }
    lines.push('');
    lines.push(`高さ ${Math.round(result.height)} px、ブロック ${view.blocks.length} 個、`
      + `Round ${state.round}。`);
  }

  if (applied.drifted) {
    lines.push('');
    lines.push('> Note: replaying the stored log no longer stands up under the current '
      + 'simulator. The previous round was closed out as a record and play resumed from a '
      + 'new one. / 前の周回は記録として閉じ、新しい周回から再開しています。');
  }

  lines.push('');
  lines.push(`![board](https://raw.githubusercontent.com/${repo}/main/assets/board.svg`
    + `?v=${state.actions.length}-${state.round})`);
  lines.push('');
  lines.push(`盤面: https://github.com/${repo}#readme`);
  return lines.join('\n');
}

export function run(env = process.env) {
  const repo = env.GITHUB_REPOSITORY || 'taross-f/taross-f';
  const issueNumber = Number.parseInt(env.ISSUE_NUMBER || '', 10);

  let labels = [];
  try {
    labels = JSON.parse(env.ISSUE_LABELS || '[]');
  } catch {
    labels = [];
  }

  const state = readState(PATHS.state);
  const user = env.ISSUE_USER || '';
  const now = env.ISSUE_CREATED_AT || new Date().toISOString();

  const parsed = parseAction({
    body: env.ISSUE_BODY ?? '',
    labels,
    user,
    now,
    lastPlayedAt: state.lastPlayedBy[user] || null,
  });

  if (parsed.code === 'not_a_play') {
    setOutputs({ skip: 'true', commit: 'false', close: 'false' });
    return 0;
  }

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    setOutputs({
      skip: 'false',
      commit: 'false',
      close: 'true',
      reply_file: writeReply('Issue 番号を取得できませんでした。もう一度立て直してください。'),
    });
    return 0;
  }

  if (!parsed.ok) {
    setOutputs({
      skip: 'false',
      commit: 'false',
      close: 'true',
      reply_file: writeReply(parsed.reply),
    });
    return 0;
  }

  const action = { issue: issueNumber, user, x: parsed.x, at: parsed.at };
  const applied = applyPlay(state, action);

  // The share card headlines a record, so refresh it when one is set or a round
  // ends - not on every single drop.
  const share = Boolean(applied.collapseEntry) || applied.recordBroken
    || !existsSync(PATHS.share);

  writeArtifacts(applied.state, applied.view, { share, shareView: applied.shareView });

  refreshReadmes(applied.state, applied.view, repo);

  const summary = applied.collapseEntry
    ? `collapse at ${applied.collapseEntry.height}px by @${user}`
    : `height ${Math.round(applied.height)}px, ${applied.view.blocks.length} blocks`;

  setOutputs({
    skip: 'false',
    commit: 'true',
    close: 'true',
    reply_file: writeReply(successReply(applied, repo)),
    commit_message: `tower: #${issueNumber} x=${parsed.x} (${summary}) [skip ci]`,
  });
  return 0;
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  process.exit(run());
}
