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

import { parseAction, X_MIN, X_MAX, Y_MIN, Y_MAX } from './parse.js';
import { placeDot, replay } from './dots.js';
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
export const STATE_VERSION = 2;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export function defaultState() {
  return {
    version: STATE_VERSION,
    chapter: 1,
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
  const lastPlayedBy = parsed.lastPlayedBy && typeof parsed.lastPlayedBy === 'object'
    ? parsed.lastPlayedBy
    : {};

  // A log from another game (the old tower) has nothing to replay here. Start
  // over, but keep the cooldowns so nobody gets a free turn out of the switch.
  if (parsed.version !== STATE_VERSION) return { ...base, lastPlayedBy };

  return {
    version: STATE_VERSION,
    chapter: Number.isInteger(parsed.chapter) && parsed.chapter > 0 ? parsed.chapter : base.chapter,
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    hallOfFame: Array.isArray(parsed.hallOfFame) ? parsed.hallOfFame : [],
    lastPlayedBy,
  };
}

export function writeState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function bestDots(hallOfFame) {
  return hallOfFame.reduce((max, e) => (e.dots > max ? e.dots : max), 0);
}

// ---------------------------------------------------------------------------
// applying a move
// ---------------------------------------------------------------------------

/**
 * Replay the chapter so far, place the new dot, and fold the outcome back into
 * state. Returns a new state object; the input is not modified.
 *
 * @param {object} state
 * @param {{issue:number,user:string,x:number,y:number,at:string}} action
 */
export function applyPlay(state, action) {
  const history = replay(state.actions);

  // The stored log never contains a connecting move, so an inconsistent replay
  // means the rules no longer agree with the record they produced. Close the
  // chapter out honestly rather than pretending the line still stands.
  const drifted = !history.consistent;

  let chapter = state.chapter;
  let actions = state.actions;
  let hallOfFame = state.hallOfFame;
  let dots = history.dots;

  if (drifted) {
    if (history.dots.length > 0) {
      hallOfFame = recordChapter(hallOfFame, {
        chapter,
        dots: history.dots.length,
        connectedBy: history.dots[history.dots.length - 1].user,
        at: action.at,
        note: 'closed out after a rule change',
      });
    }
    chapter += 1;
    actions = [];
    dots = [];
  }

  const result = placeDot(dots, action);
  if (!result.ok) {
    return { rejected: result.code, state };
  }

  const previousBest = bestDots(hallOfFame);

  const next = {
    ...state,
    chapter,
    actions,
    hallOfFame,
    lastPlayedBy: { ...state.lastPlayedBy, [action.user]: action.at },
  };

  let connectedEntry = null;

  if (result.connected) {
    connectedEntry = {
      chapter: next.chapter,
      dots: result.dots.length,
      connectedBy: action.user,
      at: action.at,
    };
    next.hallOfFame = recordChapter(next.hallOfFame, connectedEntry);
    next.chapter += 1;
    // The next dot starts a fresh line from now.
    next.actions = [];
  } else {
    next.actions = [...actions, action];
  }

  // A connected chapter stays on the board, closed, until the next dot is
  // placed - that is the picture worth looking at.
  const view = buildView(next, result.dots, connectedEntry);

  return {
    state: next,
    view,
    connectedEntry,
    drifted,
    previousBest,
    recordBroken: !result.connected && result.dots.length > previousBest && previousBest > 0,
  };
}

function recordChapter(hallOfFame, entry) {
  return [...hallOfFame, entry]
    .sort((a, b) => (b.dots - a.dots) || (a.chapter - b.chapter))
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
    alt: 'Connecting the dots board',
    cta: (url) => `**[▶ Place a dot](${url})** — `
      + `open an issue with two integers: x (${X_MIN}–${X_MAX}) and y (${Y_MIN}–${Y_MAX}).`,
    statsHead: ['Chapter', 'Dots', 'Best ever'],
    connected: (c) => `> Chapter ${c.chapter} connected at ${c.dots} dots. `
      + `Closed by @${escapeMd(c.connectedBy)}. The next dot starts a new line from now.`,
    fameSummary: 'Hall of fame',
    fameHead: ['#', 'Chapter', 'Dots', 'Connected by'],
  },
  ja: {
    alt: 'Connecting the dots の盤面',
    cta: (url) => `**[▶ 点を打つ](${url})** — `
      + `x (${X_MIN}–${X_MAX}) と y (${Y_MIN}–${Y_MAX}) の整数 2 つを書いて issue を立てるだけ。`,
    statsHead: ['章', '点の数', '最高記録'],
    connected: (c) => `> Chapter ${c.chapter} は ${c.dots} 個の点でつながりました。`
      + `つないだのは @${escapeMd(c.connectedBy)}。次の点から、また「今」から新しい線が始まります。`,
    fameSummary: '殿堂入り',
    fameHead: ['#', '章', '点の数', 'つないだ人'],
  },
};

export const LANGUAGES = Object.keys(BOARD_TEXT);

export function buildBoardBlock(state, view, repo, lang = 'en') {
  const t = BOARD_TEXT[lang];
  if (!t) throw new Error(`no board wording for language "${lang}"`);

  const newIssue = `https://github.com/${repo}/issues/new?template=play.yml`;
  // camo caches aggressively; the query is what makes an updated board show up.
  const src = `assets/board.svg?v=${state.actions.length}-${state.chapter}`;

  const lines = [];
  lines.push(`[![${t.alt}](${src})](${newIssue})`);
  lines.push('');
  lines.push(t.cta(newIssue));
  lines.push('');
  lines.push(`| ${t.statsHead.join(' | ')} |`);
  lines.push('|---:|---:|---:|');
  lines.push(`| ${state.chapter} | ${state.actions.length} | ${view.best} |`);

  if (view.connectedEntry) {
    lines.push('');
    lines.push(t.connected(view.connectedEntry));
  }

  if (state.hallOfFame.length > 0) {
    lines.push('');
    lines.push(`<details><summary>${t.fameSummary}</summary>`);
    lines.push('');
    lines.push(`| ${t.fameHead.join(' | ')} |`);
    lines.push('|---:|---:|---:|:--|');
    state.hallOfFame.forEach((e, i) => {
      lines.push(`| ${i + 1} | ${e.chapter} | ${e.dots} | @${escapeMd(e.connectedBy)} |`);
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

export function writeArtifacts(state, view, { share }) {
  mkdirSync(dirname(PATHS.board), { recursive: true });
  writeFileSync(PATHS.board, `${renderBoard(view)}\n`);
  if (share) writeFileSync(PATHS.share, `${renderShare(view)}\n`);
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
  const file = join(dir, 'dots-reply.md');
  writeFileSync(file, body);
  return file;
}

const REJECTED_REPLY = {
  same_dot: [
    'That is where the line already ends.',
    '',
    'Pick any other point on the grid and open a new issue.',
    '',
    'そこは今の線の端と同じ点です。別の点を選んで issue を立て直してください。',
  ].join('\n'),
  off_grid: [
    'That point is off the grid.',
    '',
    `x runs from ${X_MIN} to ${X_MAX} and y from ${Y_MIN} to ${Y_MAX}.`,
    '',
    '盤面の外です。',
  ].join('\n'),
};

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function successReply(applied, action, repo) {
  const { view, connectedEntry, state } = applied;
  const lines = [];

  if (connectedEntry) {
    lines.push('## Connected / つながった');
    lines.push('');
    lines.push(`Your dot at (${action.x}, ${action.y}) touched the line: chapter `
      + `${connectedEntry.chapter} closes at **${connectedEntry.dots} dots**.`);
    lines.push('');
    lines.push(`Chapter ${state.chapter} starts from now with the next dot.`);
    lines.push('');
    lines.push(`(${action.x}, ${action.y}) で線がつながり、Chapter ${connectedEntry.chapter} は `
      + `${connectedEntry.dots} 個の点で完成しました。次の点から Chapter ${state.chapter} が始まります。`);
  } else {
    lines.push('## Placed / 点を打ちました');
    lines.push('');
    lines.push(`Dot at **(${action.x}, ${action.y})**. Chapter **${state.chapter}** now runs `
      + `**${plural(view.dots.length, 'dot')}** without touching itself.`);
    if (applied.recordBroken) {
      lines.push('');
      lines.push('That is a new record.');
    }
    lines.push('');
    lines.push(`(${action.x}, ${action.y}) に点を打ちました。Chapter ${state.chapter} は `
      + `${view.dots.length} 個の点が、まだどこにもつながらずに伸びています。`);
  }

  if (applied.drifted) {
    lines.push('');
    lines.push('> Note: replaying the stored line no longer holds up under the current rules. '
      + 'The previous chapter was closed out as a record and play resumed from a new one. / '
      + '前の章は記録として閉じ、新しい章から再開しています。');
  }

  lines.push('');
  lines.push(`![board](https://raw.githubusercontent.com/${repo}/main/assets/board.svg`
    + `?v=${state.actions.length}-${state.chapter})`);
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

  const action = { issue: issueNumber, user, x: parsed.x, y: parsed.y, at: parsed.at };
  const applied = applyPlay(state, action);

  if (applied.rejected) {
    setOutputs({
      skip: 'false',
      commit: 'false',
      close: 'true',
      reply_file: writeReply(REJECTED_REPLY[applied.rejected]),
    });
    return 0;
  }

  // The share card headlines a record, so refresh it when one is set or a
  // chapter connects - not on every single dot.
  const share = Boolean(applied.connectedEntry) || applied.recordBroken
    || !existsSync(PATHS.share);

  writeArtifacts(applied.state, applied.view, { share });

  refreshReadmes(applied.state, applied.view, repo);

  const summary = applied.connectedEntry
    ? `chapter ${applied.connectedEntry.chapter} connected at ${applied.connectedEntry.dots} dots`
    : plural(applied.view.dots.length, 'dot');

  setOutputs({
    skip: 'false',
    commit: 'true',
    close: 'true',
    reply_file: writeReply(successReply(applied, action, repo)),
    commit_message: `dots: #${issueNumber} (${parsed.x}, ${parsed.y}) ${summary} [skip ci]`,
  });
  return 0;
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  process.exit(run());
}
