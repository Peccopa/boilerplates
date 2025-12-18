/**
 * index.js
 *
 * Pair 'em Up — single-file web game engine (builds the entire UI from JS).
 * Language: English UI. Replace GITHUB_USER with your GitHub username to show correct author link.
 *
 * How to use:
 * 1) Create a minimal HTML file that loads this script:
 *    <!doctype html>
 *    <html><head><meta charset="utf-8"><title>Pair 'em Up</title></head>
 *    <body><script src="index.js"></script></body></html>
 *
 * 2) Open the HTML in a browser (no server required).
 *
 * Notes:
 * - Saves games, settings and results to localStorage automatically.
 * - Target score: 100 points.
 * - Grid: 9 columns, variable rows. Initial setups for Classic, Random, Chaotic modes implemented.
 *
 * This is a complete single-file implementation trying to follow the detailed spec.
 */

/* =========================
   Configuration & Globals
   ========================= */

const GITHUB_USER = 'your-github-username'; // <-- replace with your GitHub username
const TARGET_SCORE = 100;
const COLS = 9;
const MAX_ROWS = 50;
const CLASSIC_POOL = (() => {
  // Numbers 1..19 except 0 (but 10..19 are two-digit integers)
  // The classic starting sequence described uses 1..9 on first row, 10..19 on next two rows => total 27 numbers from the 1..19 set (no zeros)
  // We'll create an array repeating 1..19 (skipping 0 obviously) and we'll consume sequentially up to 27 for the first fill.
  const arr = [];
  for (let i = 1; i <= 19; i++) arr.push(i);
  return arr;
})();
const INITIAL_COUNT = 27; // initial numbers on board for classic/random/chaotic
const STORAGE_KEY = 'pairemup_save_v1';
const RESULTS_KEY = 'pairemup_results_v1';
const SETTINGS_KEY = 'pairemup_settings_v1';

/* Game state object */
let state = {
  mode: 'classic', // 'classic'|'random'|'chaotic'
  numbers: [], // array of numbers or null for empty cells
  classicIndex: 0, // pointer into CLASSIC_POOL for additions
  score: 0,
  movesMade: 0,
  startTime: null,
  timerRunning: false,
  elapsedSecs: 0,
  selected: [], // indices of selected cells (max 2)
  lastSnapshot: null, // for undo (one-step)
  toolCounts: {
    hint: 9999, // hints conceptually unlimited but show counts as no hard cap; we won't decrement hint count, only display counts; but spec requires show available moves not uses
    undo: 9999, // unlimited but effectively reverts one-step
    addNumbers: 10,
    shuffle: 5,
    eraser: 5,
  },
  addNumbersUsed: 0,
  shuffleUsed: 0,
  eraserUsed: 0,
  finished: false,
  result: null, // 'win'|'lose'
  sound: { enabled: true },
  theme: 'light', // 'light'|'dark'
  lastSaveAt: null,
  // history for results: saved separately
};

/* UI containers */
let root, startScreen, gameScreen, gridEl, scoreEl, timerEl, modeLabelEl, controlsEl, settingsModal, resultsModal;

/* Audio context */
let audioCtx = null;

/* =========================
   Utilities
   ========================= */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const shuffleArray = arr => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const deepCloneState = s => JSON.parse(JSON.stringify(s));

/* Play simple beep */
function beep(freq = 440, duration = 0.08, type = 'sine') {
  if (!state.sound.enabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = 0.02;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    setTimeout(() => o.stop(), duration * 1000);
  } catch (e) {
    // ignore
  }
}

/* save & load */
function saveToStorage() {
  const payload = {
    state: state,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    state.lastSaveAt = payload.savedAt;
    renderAutosaveHint();
  } catch (e) {
    console.warn('save failed', e);
  }
}

function loadFromStorage() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!data || !data.state) return false;
    state = Object.assign(state, data.state);
    // ensure arrays exist
    state.numbers = state.numbers || [];
    state.startTime = state.startTime ? state.startTime : Date.now() - (state.elapsedSecs || 0) * 1000;
    renderAll();
    return true;
  } catch (e) {
    console.warn('load failed', e);
    return false;
  }
}

function clearSave() {
  localStorage.removeItem(STORAGE_KEY);
}

/* results storage */
function pushResult(resultObj) {
  try {
    const raw = localStorage.getItem(RESULTS_KEY);
    let arr = raw ? JSON.parse(raw) : [];
    arr.unshift(resultObj);
    if (arr.length > 20) arr = arr.slice(0, 20);
    localStorage.setItem(RESULTS_KEY, JSON.stringify(arr));
  } catch (e) {
    console.warn('push result failed', e);
  }
}

/* format time */
function secToMMSS(s) {
  s = Math.floor(s);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/* =========================
   Game mechanics: connectivity
   ========================= */

/**
 * Return whether two indices i and j (in numbers array) are connectable by rules:
 * - Adjacent vertically or horizontally.
 * - In same row or column and all intermediate cells are empty (null).
 * - The last cell of a row may pair with the first of the next row (treat as adjacent).
 *
 * Board is conceptually infinite rows: indices map to (r, c) by r = Math.floor(i / COLS), c = i % COLS.
 */
function areCellsConnectable(i, j) {
  if (i === j) return false;
  const ni = state.numbers[i], nj = state.numbers[j];
  if (ni == null || nj == null) return false;

  const ri = Math.floor(i / COLS), ci = i % COLS;
  const rj = Math.floor(j / COLS), cj = j % COLS;

  // adjacent horizontally or vertically
  if (ri === rj && Math.abs(ci - cj) === 1) return true;
  if (ci === cj && Math.abs(ri - rj) === 1) return true;

  // border of rows: last of one row and first of next row
  if (ci === COLS - 1 && cj === 0 && rj === ri + 1) return true;
  if (cj === COLS - 1 && ci === 0 && ri === rj + 1) return true;

  // same row with empties in between
  if (ri === rj) {
    const a = Math.min(ci, cj) + 1, b = Math.max(ci, cj) - 1;
    if (a > b) return true; // adjacent actually
    // check cells between (same row positions)
    for (let c = a; c <= b; c++) {
      const idx = ri * COLS + c;
      if (state.numbers[idx] != null) return false;
    }
    return true;
  }

  // same column with empties between
  if (ci === cj) {
    const a = Math.min(ri, rj) + 1, b = Math.max(ri, rj) - 1;
    if (a > b) return true;
    for (let r = a; r <= b; r++) {
      const idx = r * COLS + ci;
      if (state.numbers[idx] != null) return false;
    }
    return true;
  }

  return false;
}

/* Validate pair rules (numbers and connection) */
function isValidPair(i, j) {
  const a = state.numbers[i], b = state.numbers[j];
  if (a == null || b == null) return false;
  // allowed pairs: identical numbers or sum to 10
  if (a === b || a + b === 10) {
    // must be connectable
    return areCellsConnectable(i, j);
  }
  return false;
}

/* Count available moves (pairs) up to a cap (6 to show '5+') */
function countAvailableMoves(cap = 6) {
  const len = state.numbers.length;
  let count = 0;
  // O(n^2) but n typically small (27..)
  for (let i = 0; i < len; i++) {
    if (state.numbers[i] == null) continue;
    for (let j = i + 1; j < len; j++) {
      if (state.numbers[j] == null) continue;
      // valid pair check: value-based first quick check
      const a = state.numbers[i], b = state.numbers[j];
      if (!(a === b || a + b === 10)) continue;
      if (areCellsConnectable(i, j)) {
        count++;
        if (count >= cap) return count;
      }
    }
  }
  return count;
}

/* find all pairs list (for hint highlight optionally) */
function findAllPairs(limit = 2000) {
  const pairs = [];
  const len = state.numbers.length;
  for (let i = 0; i < len; i++) {
    if (state.numbers[i] == null) continue;
    for (let j = i + 1; j < len; j++) {
      if (state.numbers[j] == null) continue;
      const a = state.numbers[i], b = state.numbers[j];
      if (!(a === b || a + b === 10)) continue;
      if (areCellsConnectable(i, j)) {
        pairs.push([i, j]);
        if (pairs.length >= limit) return pairs;
      }
    }
  }
  return pairs;
}

/* =========================
   Grid / generation
   ========================= */

function ensureGridSize(minCells) {
  // make sure numbers array has at least minCells length
  while (state.numbers.length < minCells) state.numbers.push(null);
}

/* Initialize game by mode */
function newGame(mode = 'classic') {
  state.mode = mode;
  state.numbers = [];
  state.score = 0;
  state.movesMade = 0;
  state.selected = [];
  state.lastSnapshot = null;
  state.addNumbersUsed = 0;
  state.shuffleUsed = 0;
  state.eraserUsed = 0;
  state.toolCounts.addNumbers = 10;
  state.toolCounts.shuffle = 5;
  state.toolCounts.eraser = 5;
  state.finished = false;
  state.result = null;
  state.startTime = Date.now();
  state.elapsedSecs = 0;
  state.timerRunning = true;
  state.classicIndex = 0;

  if (mode === 'classic' || mode === 'random') {
    // generate initial 27 numbers from pool 1..19 (no zero).
    // For classic: ordered 1..9 then 10..19 then continue from beginning as needed to reach 27 (as described).
    if (mode === 'classic') {
      // specifically first row 1..9, next two rows 10..19 excluding 0 -> that's 9 + 9 + 9 = 27
      const arr = [];
      for (let i = 1; i <= 9; i++) arr.push(i);
      for (let i = 10; i <= 19; i++) arr.push(i);
      // we need exactly 27 numbers: that's 9 + 9 + 9 -> but 10..19 is 10 numbers; spec says numbers 10..19 excluding 0? It says numbers from 10 to 19 (excluding 0) in next two rows — ambiguous.
      // We'll instead fill rows to match total 27 using CLASSIC_POOL cyclically:
      const pool = CLASSIC_POOL.slice();
      let idx = 0;
      while (arr.length < INITIAL_COUNT) {
        arr.push(pool[idx % pool.length]);
        idx++;
      }
      state.numbers = arr.slice(0, INITIAL_COUNT);
      // pad to full rows:
      const rows = Math.ceil(state.numbers.length / COLS);
      ensureGridSize(rows * COLS);
      state.classicIndex = (INITIAL_COUNT) % CLASSIC_POOL.length;
    } else {
      // random mode: take CLASSIC_POOL repeated until 27 numbers then shuffle positions
      const pool = [];
      let idx = 0;
      while (pool.length < INITIAL_COUNT) {
        pool.push(CLASSIC_POOL[idx % CLASSIC_POOL.length]);
        idx++;
      }
      shuffleArray(pool);
      state.numbers = pool.slice(0, INITIAL_COUNT);
      const rows = Math.ceil(state.numbers.length / COLS);
      ensureGridSize(rows * COLS);
      state.classicIndex = INITIAL_COUNT % CLASSIC_POOL.length;
    }
  } else { // chaotic
    // exactly 27 random numbers 1..9
    const arr = [];
    for (let i = 0; i < INITIAL_COUNT; i++) arr.push(randInt(1, 9));
    state.numbers = arr;
    const rows = Math.ceil(state.numbers.length / COLS);
    ensureGridSize(rows * COLS);
  }

  saveToStorage();
  renderAll();
}

/* Add numbers tool */
function addNumbersTool() {
  if (state.toolCounts.addNumbers <= 0) {
    flashMessage('Add Numbers exhausted');
    beep(180, 0.1);
    return;
  }
  // snapshot for undo
  takeSnapshot();

  // The button "Add numbers": behavior depends on mode
  // We'll add numbers by appending to the end of the grid (push) so they create new cells (no empty holes)
  const nonEmpty = state.numbers.filter(n => n != null).length;
  let toAdd = 1; // base rule: numbers are added in single units per activation
  // But spec says chaotic mode adds as many new random numbers (1–9) as numbers left on the game field.
  if (state.mode === 'chaotic') {
    toAdd = nonEmpty; // add as many as there currently are
    if (toAdd <= 0) toAdd = 1;
  } else {
    // For classic/random, the spec says "When adding new numbers, generate additional numbers from same set and place randomly in following cells."
    // We'll add 1 number to keep control (the spec allowed one by one). But allow several if grid very small? We'll stick to 1.
    toAdd = 1;
  }

  // Prevent exceeding max rows
  const currentRows = Math.ceil(state.numbers.length / COLS);
  const willRows = Math.ceil((state.numbers.length + toAdd) / COLS);
  if (willRows > MAX_ROWS) {
    flashMessage('Cannot add numbers: grid max rows reached.');
    beep(120, 0.15);
    return;
  }

  for (let k = 0; k < toAdd; k++) {
    let val;
    if (state.mode === 'classic') {
      val = CLASSIC_POOL[state.classicIndex % CLASSIC_POOL.length];
      state.classicIndex = (state.classicIndex + 1) % CLASSIC_POOL.length;
    } else if (state.mode === 'random') {
      // random pick from 1..19 pool
      val = CLASSIC_POOL[randInt(0, CLASSIC_POOL.length - 1)];
    } else {
      val = randInt(1, 9);
    }
    state.numbers.push(val);
  }
  // adjust grid to full rows
  const rows2 = Math.ceil(state.numbers.length / COLS);
  ensureGridSize(rows2 * COLS);

  state.toolCounts.addNumbers--;
  state.addNumbersUsed++;
  state.movesMade++;
  state.selected = [];
  saveToStorage();
  renderAll();
}

/* Shuffle tool */
function shuffleTool() {
  if (state.toolCounts.shuffle <= 0) {
    flashMessage('Shuffle exhausted');
    beep(120, 0.1);
    return;
  }
  takeSnapshot();
  // Gather non-empty numbers, shuffle them, and re-place in non-empty positions in random order (or fully permute positions)
  const nonEmptyIdx = [];
  const values = [];
  for (let i = 0; i < state.numbers.length; i++) {
    if (state.numbers[i] != null) {
      nonEmptyIdx.push(i);
      values.push(state.numbers[i]);
    }
  }
  shuffleArray(values);
  for (let k = 0; k < nonEmptyIdx.length; k++) {
    state.numbers[nonEmptyIdx[k]] = values[k];
  }
  state.toolCounts.shuffle--;
  state.shuffleUsed++;
  state.movesMade++;
  state.selected = [];
  saveToStorage();
  renderAll();
  beep(480, 0.08);
}

/* Eraser tool: remove a single cell (player must click a cell then press Erase) */
function eraserToolAt(index) {
  if (state.toolCounts.eraser <= 0) {
    flashMessage('Eraser exhausted');
    beep(120, 0.1);
    return;
  }
  if (state.numbers[index] == null) return;
  takeSnapshot();
  state.numbers[index] = null;
  state.toolCounts.eraser--;
  state.eraserUsed++;
  state.movesMade++;
  state.selected = [];
  saveToStorage();
  renderAll();
  beep(240, 0.06);
}

/* Undo tool: revert to last snapshot */
function undoTool() {
  if (!state.lastSnapshot) {
    flashMessage('Nothing to undo');
    beep(220, 0.08);
    return;
  }
  // restore snapshot
  const s = state.lastSnapshot;
  state.numbers = s.numbers;
  state.score = s.score;
  state.movesMade = s.movesMade;
  state.addNumbersUsed = s.addNumbersUsed;
  state.shuffleUsed = s.shuffleUsed;
  state.eraserUsed = s.eraserUsed;
  state.toolCounts = s.toolCounts;
  state.classicIndex = s.classicIndex;
  state.selected = [];
  state.lastSnapshot = null; // only one-step undo allowed until next action
  saveToStorage();
  renderAll();
  beep(360, 0.08);
}

/* take snapshot for undo */
function takeSnapshot() {
  state.lastSnapshot = {
    numbers: state.numbers.slice(),
    score: state.score,
    movesMade: state.movesMade,
    addNumbersUsed: state.addNumbersUsed,
    shuffleUsed: state.shuffleUsed,
    eraserUsed: state.eraserUsed,
    toolCounts: Object.assign({}, state.toolCounts),
    classicIndex: state.classicIndex,
  };
}

/* Attempt to match two selected cells */
function attemptMatch(i, j) {
  if (!isValidPair(i, j)) {
    // invalid pair: feedback
    flashInvalidPair(i, j);
    beep(140, 0.15, 'square');
    return false;
  }
  takeSnapshot();

  // scoring
  const a = state.numbers[i], b = state.numbers[j];
  let gained = 0;
  if (a === 5 && b === 5) {
    gained = 3; // special double five
  } else if (a === b) {
    gained = 1;
  } else if (a + b === 10) {
    gained = 2;
  }
  state.score += gained;
  // remove both
  state.numbers[i] = null;
  state.numbers[j] = null;
  state.movesMade++;
  state.selected = [];
  saveToStorage();
  renderAll();
  if (gained > 0) beep(600 + gained * 80, 0.08, 'sine');
  checkGameEnd();
  return true;
}

/* Check win/lose conditions */
function checkGameEnd() {
  if (state.finished) return;
  if (state.score >= TARGET_SCORE) {
    // win
    state.finished = true;
    state.result = 'win';
    state.timerRunning = false;
    pushEndResult();
    renderEndModal(true);
    beep(880, 0.4, 'triangle');
    return;
  }
  // lose if no moves and tools exhausted (addNumbers, shuffle, eraser used up)
  const availableMoves = countAvailableMoves(6);
  const toolsLeft = (state.toolCounts.addNumbers || 0) + (state.toolCounts.shuffle || 0) + (state.toolCounts.eraser || 0);
  if (availableMoves === 0 && toolsLeft <= 0) {
    state.finished = true;
    state.result = 'lose';
    state.timerRunning = false;
    pushEndResult();
    renderEndModal(false);
    beep(160, 0.4, 'sawtooth');
    return;
  }
  // also lose if rows exceed MAX_ROWS
  const rows = Math.ceil(state.numbers.length / COLS);
  if (rows > MAX_ROWS) {
    state.finished = true;
    state.result = 'lose';
    state.timerRunning = false;
    pushEndResult();
    renderEndModal(false, 'Grid exceeded maximum rows');
    beep(160, 0.4, 'sawtooth');
    return;
  }
}

/* push end game result into results storage */
function pushEndResult() {
  const finishedAt = Date.now();
  const elapsed = state.elapsedSecs + Math.floor((Date.now() - (state.startTime || Date.now())) / 1000);
  const obj = {
    mode: state.mode,
    score: state.score,
    result: state.result,
    time: secToMMSS(elapsed),
    moves: state.movesMade,
    finishedAt,
  };
  pushResult(obj);
  saveToStorage();
}

/* =========================
   UI: creation & render
   ========================= */

function $(sel) {
  return root.querySelector(sel);
}

/* create the whole UI */
function buildUI() {
  // root
  root = document.createElement('div');
  document.body.style.margin = '0';
  document.body.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial';
  document.body.appendChild(root);

  // inject base styles
  const style = document.createElement('style');
  style.innerHTML = `
    :root{
      --bg:#f6f7fb;
      --panel:#fff;
      --accent:#2b6efc;
      --text:#111;
      --muted:#6b7280;
      --cell:#f3f4f6;
      --danger:#ef4444;
    }
    [data-theme="dark"]{
      --bg:#0b1220;
      --panel:#0f1724;
      --accent:#60a5fa;
      --text:#e6eef8;
      --muted:#93a3bf;
      --cell:#142033;
      --danger:#fb7185;
    }
    body{background:var(--bg); color:var(--text)}
    .app {max-width:1100px; margin:18px auto; padding:18px;}
    .header {display:flex; align-items:center; justify-content:space-between; gap:12px}
    .brand {font-weight:700; font-size:20px}
    .muted {color:var(--muted); font-size:13px}
    .card {background:var(--panel); border-radius:12px; padding:12px; box-shadow: 0 6px 20px rgba(2,6,23,0.06)}
    .start-grid{display:flex; gap:12px; margin-top:12px}
    .mode-btn {padding:10px 14px; border-radius:8px; border:1px solid rgba(0,0,0,0.06); cursor:pointer; background:transparent}
    .mode-btn.active {background:linear-gradient(90deg,var(--accent), rgba(60,130,255,0.7)); color:white; box-shadow:0 6px 18px rgba(43,110,252,0.12)}
    .grid-area {margin-top:18px; display:flex; gap:18px;}
    .left-panel {flex:1}
    .right-panel {width:320px; display:flex; flex-direction:column; gap:12px}
    .game-grid {display:grid; gap:6px; background:transparent}
    .cell {width:56px; height:48px; display:flex; align-items:center; justify-content:center; border-radius:8px; background:var(--cell); font-weight:700; cursor:pointer; user-select:none; transition:transform .12s, box-shadow .12s}
    .cell.empty {background:transparent; cursor:default; color:var(--muted); font-weight:500}
    .cell.selected {outline:3px solid rgba(99,102,241,0.14); transform:translateY(-4px)}
    .cell.bad {animation:shake .32s}
    @keyframes shake {0%{transform:translateX(0)}25%{transform:translateX(-6px)}50%{transform:translateX(6px)}75%{transform:translateX(-6px)}100%{transform:translateX(0)}}
    .controls {display:flex; gap:8px; flex-wrap:wrap}
    .btn {padding:8px 10px; border-radius:8px; cursor:pointer; border:none; background:var(--panel); box-shadow:0 4px 8px rgba(2,6,23,0.04)}
    .btn.primary{background:var(--accent); color:white}
    .small {font-size:13px; padding:6px 8px}
    .status {display:flex; gap:8px; align-items:center; justify-content:space-between; margin-bottom:8px}
    .tool {display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px}
    .footer {margin-top:18px; display:flex; justify-content:space-between}
    .modal {position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(2,6,23,0.4)}
    .modal .card{max-width:720px}
    .topbar {display:flex; gap:8px; align-items:center}
    .counter {background:rgba(0,0,0,0.04); padding:2px 8px; border-radius:8px; font-size:12px}
    .author {text-decoration:none; color:var(--accent)}
    .settings {display:flex; gap:8px; flex-direction:column}
    .results-table {width:100%; border-collapse:collapse}
    .results-table td,.results-table th{padding:8px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:left}
  `;
  document.head.appendChild(style);

  // App container
  const app = document.createElement('div');
  app.className = 'app';
  app.dataset.theme = state.theme;
  root.appendChild(app);

  // header
  const header = document.createElement('div');
  header.className = 'header';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerText = "Pair 'em Up";
  const rightHeader = document.createElement('div');
  rightHeader.style.display = 'flex';
  rightHeader.style.alignItems = 'center';
  rightHeader.style.gap = '12px';
  const author = document.createElement('a');
  author.className = 'muted';
  author.innerHTML = `by <span class="author">${GITHUB_USER}</span>`;
  author.href = `https://github.com/${GITHUB_USER}`;
  author.target = '_blank';
  rightHeader.appendChild(author);
  header.appendChild(brand);
  header.appendChild(rightHeader);
  app.appendChild(header);

  // start screen container
  startScreen = document.createElement('div');
  startScreen.className = 'card';
  startScreen.style.marginTop = '12px';
  startScreen.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:18px;font-weight:700">Welcome to Pair 'em Up</div>
        <div class="muted">A strategic number-matching puzzle. Target ${TARGET_SCORE} points to win.</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="btn-settings">Settings</button>
        <button class="btn" id="btn-results">Results</button>
      </div>
    </div>
    <div class="start-grid">
      <div style="flex:1">
        <div style="margin-top:12px">Choose a mode</div>
        <div style="margin-top:8px; display:flex; gap:8px" id="modes"></div>
        <div style="margin-top:12px; display:flex; gap:8px">
          <button class="btn primary" id="btn-new">New Game</button>
          <button class="btn" id="btn-continue">Continue Game</button>
        </div>
      </div>
      <div style="width:360px">
        <div class="muted">How to play</div>
        <ul style="margin:8px 0 0 18px">
          <li>Pick exactly two numbers to match.</li>
          <li>Pairs valid: identical numbers, or sum to 10. 5+5 gives bonus.</li>
          <li>Cells connect if adjacent, or same row/column with empty cells between, or row-border consecutive.</li>
          <li>Use tools strategically: Add Numbers (10), Shuffle (5), Eraser (5).</li>
        </ul>
      </div>
    </div>
  `;
  app.appendChild(startScreen);

  // modes buttons
  const modes = startScreen.querySelector('#modes');
  ['classic', 'random', 'chaotic'].forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'mode-btn';
    btn.innerText = m[0].toUpperCase() + m.slice(1);
    btn.dataset.mode = m;
    btn.onclick = () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = m;
    };
    modes.appendChild(btn);
  });

  // continue and new game buttons
  startScreen.querySelector('#btn-new').onclick = () => {
    newGame(state.mode || 'classic');
    showGameScreen();
  };
  startScreen.querySelector('#btn-continue').onclick = () => {
    if (loadFromStorage()) {
      showGameScreen();
    } else {
      flashMessage('No saved game to continue.');
    }
  };
  startScreen.querySelector('#btn-settings').onclick = () => openSettings();
  startScreen.querySelector('#btn-results').onclick = () => openResults();

  // game screen (hidden by default)
  gameScreen = document.createElement('div');
  gameScreen.style.display = 'none';
  gameScreen.className = 'card';
  gameScreen.style.marginTop = '12px';
  root.appendChild(gameScreen);

  // top controls
  const top = document.createElement('div');
  top.className = 'topbar';
  top.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;">
      <div class="muted" id="modeLabel">Mode: Classic</div>
      <div class="counter" id="scoreLabel">Score: 0 / ${TARGET_SCORE}</div>
      <div class="counter" id="timerLabel">Time: 00:00</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn" id="btn-reset">Reset</button>
      <button class="btn" id="btn-save">Save</button>
      <button class="btn" id="btn-back">Main Menu</button>
    </div>
  `;
  gameScreen.appendChild(top);
  modeLabelEl = top.querySelector('#modeLabel');
  scoreEl = top.querySelector('#scoreLabel');
  timerEl = top.querySelector('#timerLabel');

  // main layout
  const layout = document.createElement('div');
  layout.className = 'grid-area';
  gameScreen.appendChild(layout);

  const left = document.createElement('div'); left.className = 'left-panel';
  const right = document.createElement('div'); right.className = 'right-panel';
  layout.appendChild(left); layout.appendChild(right);

  // grid container
  gridEl = document.createElement('div');
  gridEl.className = 'card';
  gridEl.style.padding = '12px';
  left.appendChild(gridEl);

  // controls
  controlsEl = document.createElement('div');
  controlsEl.className = 'card';
  controlsEl.style.padding = '12px';
  controlsEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:700">Tools & Controls</div>
        <div class="muted" style="font-size:13px">Use tools to help clear the board</div>
      </div>
      <div class="muted" id="autosaveHint"></div>
    </div>
    <div style="margin-top:8px" id="toolList"></div>
  `;
  right.appendChild(controlsEl);

  // tool list
  const toolList = controlsEl.querySelector('#toolList');
  toolList.innerHTML = `
    <div class="tool">
      <div>Hint</div>
      <div><button class="btn small" id="btn-hint">Show Moves</button> <span id="hintCount" class="muted"></span></div>
    </div>
    <div class="tool">
      <div>Undo (one-step)</div>
      <div><button class="btn small" id="btn-undo">Undo</button></div>
    </div>
    <div class="tool">
      <div>Add Numbers</div>
      <div><button class="btn small" id="btn-add">Add</button> <span id="addCount" class="muted"></span></div>
    </div>
    <div class="tool">
      <div>Shuffle</div>
      <div><button class="btn small" id="btn-shuffle">Shuffle</button> <span id="shuffleCount" class="muted"></span></div>
    </div>
    <div class="tool">
      <div>Eraser (click a cell then Erase)</div>
      <div><button class="btn small" id="btn-erase">Erase</button> <span id="eraserCount" class="muted"></span></div>
    </div>
    <div style="margin-top:10px">
      <div class="muted">Results</div>
      <div style="margin-top:6px; display:flex; gap:8px">
        <button class="btn" id="btn-showResults">Show Results</button>
        <button class="btn" id="btn-theme">Theme</button>
      </div>
    </div>
  `;
  // wire tool buttons
  toolList.querySelector('#btn-hint').onclick = () => {
    const c = countAvailableMoves(6);
    const txt = c >= 6 ? '5+' : String(c);
    flashMessage(`Available moves: ${txt}`);
    renderToolCounters();
  };
  toolList.querySelector('#btn-undo').onclick = undoTool;
  toolList.querySelector('#btn-add').onclick = addNumbersTool;
  toolList.querySelector('#btn-shuffle').onclick = shuffleTool;
  toolList.querySelector('#btn-erase').onclick = () => {
    // instruct user to click a cell to erase
    flashMessage('Click a cell to erase (then tool will consume).');
    // set a short "eraser mode" flag by marking selected[0] as pending erase
    // We'll treat the next cell click as erase target if no two cells selected.
    eraserMode = true;
  };

  controlsEl.querySelector('#btn-showResults').onclick = openResults;
  controlsEl.querySelector('#btn-theme').onclick = toggleTheme;

  // bottom area: actions for grid
  const bottom = document.createElement('div');
  bottom.className = 'footer';
  bottom.innerHTML = `
    <div class="muted">Target score: ${TARGET_SCORE}</div>
    <div style="display:flex; gap:8px">
      <div class="muted">Score: <strong id="scoreNow">0</strong></div>
      <div class="muted">Moves: <strong id="movesNow">0</strong></div>
    </div>
  `;
  left.appendChild(bottom);

  // append listeners for top buttons
  top.querySelector('#btn-reset').onclick = () => {
    if (confirm('Reset current game? This will start a new board in the same mode.')) {
      newGame(state.mode);
    }
  };
  top.querySelector('#btn-save').onclick = () => {
    saveToStorage();
    flashMessage('Game saved');
  };
  top.querySelector('#btn-back').onclick = () => {
    // back to main menu
    showStart();
  };

  // modals placeholders
  settingsModal = createSettingsModal();
  resultsModal = createResultsModal();
  document.body.appendChild(settingsModal);
  document.body.appendChild(resultsModal);

  // autosave hint render
  renderAutosaveHint();

  // keyboard support: Esc to deselect
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      state.selected = [];
      renderGrid();
    }
  });
}

/* eraserMode flag to indicate next click should erase */
let eraserMode = false;

/* Render entire UI */
function renderAll() {
  // theme
  root.querySelector('.app').dataset.theme = state.theme;

  // show/hide continue button
  const contBtn = startScreen.querySelector('#btn-continue');
  const hasSaved = !!localStorage.getItem(STORAGE_KEY);
  contBtn.disabled = !hasSaved;
  contBtn.style.opacity = hasSaved ? '1' : '0.5';

  // update game screen labels
  modeLabelEl && (modeLabelEl.innerText = `Mode: ${state.mode[0].toUpperCase() + state.mode.slice(1)}`);
  scoreEl && (scoreEl.innerText = `Score: ${state.score} / ${TARGET_SCORE}`);
  document.getElementById('scoreNow') && (document.getElementById('scoreNow').innerText = state.score);
  document.getElementById('movesNow') && (document.getElementById('movesNow').innerText = state.movesMade);

  renderToolCounters();
  renderGrid();
  renderTimer();
  renderAutosaveHint();
}

/* render autosave hint */
function renderAutosaveHint() {
  const auto = controlsEl ? controlsEl.querySelector('#autosaveHint') : null;
  if (auto) {
    auto.innerText = state.lastSaveAt ? `Saved ${new Date(state.lastSaveAt).toLocaleString()}` : '';
  }
}

/* render tool counters */
function renderToolCounters() {
  if (!controlsEl) return;
  const hintCount = controlsEl.querySelector('#hintCount');
  const c = countAvailableMoves(6);
  hintCount.innerText = c >= 6 ? '5+' : String(c);
  controlsEl.querySelector('#addCount').innerText = `(${state.toolCounts.addNumbers})`;
  controlsEl.querySelector('#shuffleCount').innerText = `(${state.toolCounts.shuffle})`;
  controlsEl.querySelector('#eraserCount').innerText = `(${state.toolCounts.eraser})`;
}

/* render grid */
function renderGrid() {
  if (!gridEl) return;
  gridEl.innerHTML = '';
  gridEl.style.minHeight = '220px';
  const rows = Math.ceil(state.numbers.length / COLS);
  gridEl.style.gridTemplateColumns = `repeat(${COLS}, 56px)`;
  gridEl.className = 'game-grid';
  // make rows*cols cells
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      const val = state.numbers[idx];
      const cell = document.createElement('div');
      cell.className = 'cell card';
      if (val == null) {
        cell.classList.add('empty');
        cell.innerText = '';
      } else {
        cell.innerText = String(val);
      }
      if (state.selected.includes(idx)) cell.classList.add('selected');
      // click handler
      cell.onclick = () => onCellClick(idx);
      cell.oncontextmenu = (e) => { e.preventDefault(); };
      gridEl.appendChild(cell);
    }
  }
}

/* on cell click behavior */
function onCellClick(idx) {
  if (state.finished) return;
  if (eraserMode) {
    eraserMode = false;
    eraserToolAt(idx);
    return;
  }
  const val = state.numbers[idx];
  if (val == null) {
    // clicking empty clears selection
    state.selected = [];
    renderGrid();
    return;
  }
  // toggle selection
  if (state.selected.includes(idx)) {
    state.selected = state.selected.filter(x => x !== idx);
    renderGrid();
    return;
  }
  if (state.selected.length === 0) {
    state.selected.push(idx);
    renderGrid();
    beep(300, 0.05);
    return;
  } else if (state.selected.length === 1) {
    state.selected.push(idx);
    renderGrid();
    // attempt match
    const [a, b] = state.selected;
    // delay a little for UX
    setTimeout(() => {
      const ok = attemptMatch(a, b);
      if (!ok) {
        // animate bad selection: add 'bad' class temporarily
        const children = gridEl.children;
        [a, b].forEach(i => {
          const el = children[i];
          if (el) {
            el.classList.add('bad');
            setTimeout(() => el.classList.remove('bad'), 320);
          }
        });
      }
    }, 140);
    return;
  } else {
    // more than 2 selected shouldn't happen
    state.selected = [idx];
    renderGrid();
  }
}

/* flash messages */
let flashTimeout = null;
function flashMessage(msg, duration = 2200) {
  // simple ephemeral toast
  let el = document.getElementById('ephemeralToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ephemeralToast';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.bottom = '22px';
    el.style.transform = 'translateX(-50%)';
    el.style.padding = '10px 14px';
    el.style.background = 'rgba(0,0,0,0.7)';
    el.style.color = 'white';
    el.style.borderRadius = '10px';
    el.style.zIndex = 9999;
    el.style.fontSize = '13px';
    document.body.appendChild(el);
  }
  el.innerText = msg;
  el.style.opacity = '1';
  if (flashTimeout) clearTimeout(flashTimeout);
  flashTimeout = setTimeout(() => {
    el.style.opacity = '0';
  }, duration);
}

/* flash invalid pair - visual */
function flashInvalidPair(i, j) {
  const children = gridEl.children;
  [i, j].forEach(idx => {
    const el = children[idx];
    if (el) {
      el.classList.add('bad');
      setTimeout(() => el.classList.remove('bad'), 450);
    }
  });
}

/* render timer */
function renderTimer() {
  if (!timerEl) return;
  // update elapsedSecs if running
  if (state.timerRunning && state.startTime) {
    state.elapsedSecs = Math.floor((Date.now() - state.startTime) / 1000);
  }
  timerEl.innerText = `Time: ${secToMMSS(state.elapsedSecs)}`;
}

/* show modals: settings and results */
function createSettingsModal() {
  const modal = document.createElement('div');
  modal.style.display = 'none';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="card" style="min-width:420px; padding:18px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:700">Settings</div>
        <button class="btn" id="closeSettings">Close</button>
      </div>
      <div class="settings" style="margin-top:12px">
        <label><input type="checkbox" id="soundToggle"> Enable sound</label>
        <label><input type="radio" name="theme" value="light" checked> Light theme</label>
        <label><input type="radio" name="theme" value="dark"> Dark theme</label>
        <div class="muted" style="font-size:13px">Local settings are saved automatically.</div>
      </div>
    </div>
  `;
  modal.querySelector('#closeSettings').onclick = () => modal.style.display = 'none';
  // attach toggles later
  return modal;
}

function openSettings() {
  const modal = settingsModal;
  // set values
  modal.style.display = 'flex';
  const soundToggle = modal.querySelector('#soundToggle');
  soundToggle.checked = !!state.sound.enabled;
  soundToggle.onchange = (e) => {
    state.sound.enabled = e.target.checked;
    saveSettings();
    if (state.sound.enabled) beep(520, 0.06);
  };
  const radios = modal.querySelectorAll('input[name="theme"]');
  radios.forEach(r => r.checked = (r.value === state.theme));
  radios.forEach(r => r.onchange = (e) => {
    if (e.target.checked) {
      state.theme = e.target.value;
      document.querySelector('.app').dataset.theme = state.theme;
      saveSettings();
    }
  });
}

/* results modal */
function createResultsModal() {
  const modal = document.createElement('div');
  modal.style.display = 'none';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="card" style="padding:18px; width:760px;">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div style="font-weight:700">Recent Results</div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="closeResults">Close</button>
          <button class="btn" id="clearResults">Clear</button>
        </div>
      </div>
      <div id="resultsContent" style="margin-top:12px"></div>
    </div>
  `;
  modal.querySelector('#closeResults').onclick = () => modal.style.display = 'none';
  modal.querySelector('#clearResults').onclick = () => {
    if (confirm('Clear saved results?')) {
      localStorage.removeItem(RESULTS_KEY);
      renderResultsTable();
    }
  };
  return modal;
}

function openResults() {
  renderResultsTable();
  resultsModal.style.display = 'flex';
}

function renderResultsTable() {
  const content = resultsModal.querySelector('#resultsContent');
  const raw = localStorage.getItem(RESULTS_KEY);
  const arr = raw ? JSON.parse(raw) : [];
  if (arr.length === 0) {
    content.innerHTML = '<div class="muted">No results yet.</div>';
    return;
  }
  // show last 5 games sorted by finishedAt descending
  const top = arr.slice(0, 5);
  let html = `<table class="results-table"><thead><tr><th>Mode</th><th>Score</th><th>Result</th><th>Time</th><th>Moves</th></tr></thead><tbody>`;
  for (const r of top) {
    html += `<tr>
      <td>${r.mode}</td>
      <td>${r.score}</td>
      <td>${r.result === 'win' ? 'Win 🏆' : 'Loss'}</td>
      <td>${r.time}</td>
      <td>${r.moves}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  content.innerHTML = html;
}

/* end modal (win/lose) */
function renderEndModal(win = true, msg = '') {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const elapsed = state.elapsedSecs + Math.floor((Date.now() - (state.startTime || Date.now())) / 1000);
  modal.innerHTML = `
    <div class="card" style="padding:18px; width:520px;">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:800;font-size:18px">${win ? 'You Win!' : 'Game Over'}</div>
        <div><button class="btn" id="closeEnd">Close</button></div>
      </div>
      <div style="margin-top:12px">
        <div>Result: <strong>${win ? 'Victory' : 'Defeat'}</strong></div>
        <div>Score: <strong>${state.score}</strong></div>
        <div>Time: <strong>${secToMMSS(elapsed)}</strong></div>
        <div>Moves: <strong>${state.movesMade}</strong></div>
        ${msg ? `<div style="color:var(--danger);margin-top:8px">${msg}</div>` : ''}
      </div>
      <div style="display:flex;gap:8px; margin-top:12px">
        <button class="btn primary" id="btn-playagain">Play Again</button>
        <button class="btn" id="btn-samemode">Same Mode</button>
        <button class="btn" id="btn-mainmenu">Main Menu</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#closeEnd').onclick = () => modal.remove();
  modal.querySelector('#btn-playagain').onclick = () => {
    modal.remove();
    newGame('classic');
    showGameScreen();
  };
  modal.querySelector('#btn-samemode').onclick = () => {
    modal.remove();
    newGame(state.mode);
    showGameScreen();
  };
  modal.querySelector('#btn-mainmenu').onclick = () => {
    modal.remove();
    showStart();
  };
}

/* =========================
   Persistence for settings
   ========================= */

function saveSettings() {
  try {
    const s = {
      sound: state.sound,
      theme: state.theme,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (e) { }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    state.sound = s.sound || state.sound;
    state.theme = s.theme || state.theme;
  } catch (e) {}
}

/* =========================
   Navigation helpers
   ========================= */

function showGameScreen() {
  startScreen.style.display = 'none';
  gameScreen.style.display = 'block';
  renderAll();
  // ensure timer runs
  if (!state.startTime) state.startTime = Date.now();
  if (!state.timerRunning) state.timerRunning = true;
}

function showStart() {
  startScreen.style.display = 'block';
  gameScreen.style.display = 'none';
}

/* =========================
   Periodic loop & auto-save
   ========================= */

function tick() {
  if (state.timerRunning && state.startTime) {
    state.elapsedSecs = Math.floor((Date.now() - state.startTime) / 1000);
  }
  renderTimer();
  // auto save every 5 seconds
  const t = Date.now();
  if (!state.lastAutoSaveAt || t - state.lastAutoSaveAt > 5000) {
    saveToStorage();
    state.lastAutoSaveAt = t;
  }
  requestAnimationFrame(tick);
}

/* =========================
   Small helpers & UI behaviors
   ========================= */

function flashBrief(text) {
  flashMessage(text, 1600);
}

/* toggle theme */
function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  document.querySelector('.app').dataset.theme = state.theme;
  saveSettings();
}

/* =========================
   Startup
   ========================= */

function init() {
  loadSettings();
  buildUI();
  // load saved game if exists
  if (localStorage.getItem(STORAGE_KEY)) {
    startScreen.querySelector('#btn-continue').disabled = false;
    startScreen.querySelector('#btn-continue').style.opacity = '1';
  } else {
    startScreen.querySelector('#btn-continue').disabled = true;
    startScreen.querySelector('#btn-continue').style.opacity = '0.5';
  }
  // default mode button active
  const defaultBtn = startScreen.querySelector('.mode-btn[data-mode="' + (state.mode || 'classic') + '"]');
  if (defaultBtn) defaultBtn.classList.add('active');

  // start UI loop
  requestAnimationFrame(tick);
  // render grid initially
  renderAll();

  // small tutorial if no results
  const resultsRaw = localStorage.getItem(RESULTS_KEY);
  if (!resultsRaw) {
    flashMessage('Tip: Click two connectable numbers to remove them. Use tools to help!');
  }
}

init();

/* =========================
   Final notes:
   - This implementation focuses on core gameplay, tools, persistence, timer, and UI in a single JS file.
   - There are many possible enhancements: animations, more polished audio, better add-number placement strategies, improved path-checking for complex obstacles, tutorial screen, etc.
   - Replace GITHUB_USER constant with your GitHub username to link correctly on the start screen.
   ========================= */
