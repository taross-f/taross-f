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
import { componentOf, linksAmong, placeDot, replay } from './dots.js';
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
  // means the rules no longer agree with the record they produced. Start the
  // chapter over rather than revealing a connection nobody actually made.
  const drifted = !history.consistent;

  const chapter = drifted ? state.chapter + 1 : state.chapter;
  const actions = drifted ? [] : state.actions;
  const dots = drifted ? [] : history.dots;

  const result = placeDot(dots, action);
  if (!result.ok) {
    return { rejected: result.code, state };
  }

  const next = {
    ...state,
    chapter,
    actions,
    lastPlayedBy: { ...state.lastPlayedBy, [action.user]: action.at },
  };

  let reveal = null;

  if (result.path) {
    const path = result.path.map((i) => result.dots[i]);
    const oldest = path.reduce((min, d) => (d.issue < min.issue ? d : min), path[0]);
    const entry = {
      chapter: next.chapter,
      dots: result.dots.length,
      pathDots: path.length,
      people: new Set(path.map((d) => d.user)).size,
      oldestIssue: oldest.issue,
      connectedBy: action.user,
      at: action.at,
    };
    // Everything the path's dots were quietly linked to, to show how much of
    // the scatter was part of it all along.
    const component = componentOf(result.dots, result.path[0]);
    reveal = { entry, path: result.path, links: linksAmong(result.dots, component) };

    next.hallOfFame = recordChapter(next.hallOfFame, entry);
    next.chapter += 1;
    // The next dot starts a fresh, empty grid.
    next.actions = [];
  } else {
    next.actions = [...actions, action];
  }

  // A connected chapter stays on the board, revealed, until the next dot is
  // placed - that is the picture worth looking at.
  const view = buildView(next, result.dots, reveal);

  return {
    state: next,
    view,
    connectedEntry: reveal ? reveal.entry : null,
    path: reveal ? reveal.path.map((i) => result.dots[i]) : null,
    drifted,
  };
}

/** Most recent first: this is a history of connections, not a leaderboard. */
function recordChapter(hallOfFame, entry) {
  return [entry, ...hallOfFame].slice(0, HALL_OF_FAME_SIZE);
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
    statsHead: ['Chapter', 'Dots placed', 'Connected so far'],
    connected: (c) => `> **Chapter ${c.chapter} connected.** ${c.pathDots} of its ${c.dots} dots, `
      + `placed by ${c.people} ${c.people === 1 ? 'person' : 'people'} and going back to `
      + `#${c.oldestIssue}, turned out to run edge to edge. The last piece was `
      + `@${escapeMd(c.connectedBy)}'s. The next dot starts an empty grid.`,
    fameSummary: 'Past connections',
    fameHead: ['Chapter', 'Dots placed', 'Dots on the path', 'People', 'Last piece'],
  },
  ja: {
    alt: 'Connecting the dots の盤面',
    cta: (url) => `**[▶ 点を打つ](${url})** — `
      + `x (${X_MIN}–${X_MAX}) と y (${Y_MIN}–${Y_MAX}) の整数 2 つを書いて issue を立てるだけ。`,
    statsHead: ['章', '打たれた点', 'これまでのつながり'],
    connected: (c) => `> **Chapter ${c.chapter} がつながりました。** ${c.dots} 個の点のうち `
      + `${c.pathDots} 個 (${c.people} 人が打った、古いものは #${c.oldestIssue}) が、`
      + `端から端までつながっていました。最後のピースは @${escapeMd(c.connectedBy)}。`
      + `次の点から、また空の盤面が始まります。`,
    fameSummary: 'これまでのつながり',
    fameHead: ['章', '打たれた点', 'つながった点', '人数', '最後のピース'],
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
  lines.push(`| ${state.chapter} | ${state.actions.length} | ${state.chapter - 1} |`);

  if (view.connectedEntry) {
    lines.push('');
    lines.push(t.connected(view.connectedEntry));
  }

  if (state.hallOfFame.length > 0) {
    lines.push('');
    lines.push(`<details><summary>${t.fameSummary}</summary>`);
    lines.push('');
    lines.push(`| ${t.fameHead.join(' | ')} |`);
    lines.push('|---:|---:|---:|---:|:--|');
    state.hallOfFame.forEach((e) => {
      lines.push(`| ${e.chapter} | ${e.dots} | ${e.pathDots} | ${e.people} `
        + `| @${escapeMd(e.connectedBy)} |`);
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
  occupied: [
    'There is already a dot there.',
    '',
    'Pick an empty point on the grid and open a new issue.',
    '',
    'そこにはもう点があります。空いている点を選んで issue を立て直してください。',
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

function ordinal(n) {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${tail}`;
}

function successReply(applied, action, repo) {
  const { view, connectedEntry, state, path } = applied;
  const lines = [];

  if (connectedEntry) {
    lines.push('## Connected / つながった');
    lines.push('');
    lines.push(`Your dot at **(${action.x}, ${action.y})** was the missing piece. `
      + `${path.length} dots, placed by ${connectedEntry.people} `
      + `${connectedEntry.people === 1 ? 'person' : 'people'}, `
      + 'turned out to run from the left edge to the right:');
    lines.push('');
    lines.push(`(${action.x}, ${action.y}) が最後のピースでした。打たれた時には誰も気づかなかった `
      + `${path.length} 個の点が、左端から右端までつながっていました。`);
    lines.push('');
    // Mentioning everyone on the path is the point: their dot, maybe weeks old,
    // just connected.
    path.forEach((d, i) => {
      const mark = d.issue === action.issue ? ' ← the last piece / 最後のピース' : '';
      lines.push(`${i + 1}. (${d.x}, ${d.y}) — #${d.issue} by @${d.user}${mark}`);
    });
    lines.push('');
    lines.push(`Chapter ${state.chapter} starts on an empty grid with the next dot. / `
      + `次の点から Chapter ${state.chapter} が空の盤面で始まります。`);
  } else {
    lines.push('## Placed / 点を打ちました');
    lines.push('');
    lines.push(`Dot at **(${action.x}, ${action.y})**, the ${ordinal(view.dots.length)} `
      + `in chapter ${state.chapter}. Nothing has connected yet — or nothing you can see.`);
    lines.push('');
    lines.push(`(${action.x}, ${action.y}) に点を打ちました。Chapter ${state.chapter} の `
      + `${view.dots.length} 個目です。まだ何もつながっていません — 見える範囲では。`);
  }

  if (applied.drifted) {
    lines.push('');
    lines.push('> Note: the stored chapter no longer replays under the current rules, so '
      + 'play resumed on a new, empty grid. / ルール変更のため、新しい空の盤面から再開しています。');
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

  // The share card shows a reveal, so refresh it when a chapter connects - not
  // on every single dot.
  const share = Boolean(applied.connectedEntry) || !existsSync(PATHS.share);

  writeArtifacts(applied.state, applied.view, { share });

  refreshReadmes(applied.state, applied.view, repo);

  const summary = applied.connectedEntry
    ? `chapter ${applied.connectedEntry.chapter} connected through ${applied.connectedEntry.pathDots} dots`
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
