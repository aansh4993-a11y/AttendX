'use strict';

/* =========================================================
   Attendance Register — script.js
   Vanilla JS. No frameworks, no build step.
   ========================================================= */

const STORAGE_KEY_BASE = 'attendanceRegister.base';
const STORAGE_KEY_HISTORY = 'attendanceRegister.history';
const STORAGE_KEY_TARGET = 'attendanceRegister.target';
const STORAGE_KEY_THEME = 'attendanceRegister.theme';
const STORAGE_KEY_TIMETABLE = 'attendanceRegister.timetable';
const DEFAULT_TARGET = 75;
const DEFAULT_HELD = 8;
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // matches Date#getDay() index
const HEATMAP_CELL = 13;
const HEATMAP_GAP = 3;
const HEATMAP_MAX_DAYS = 182; // trailing ~6 months, keeps the grid scrollable but not endless
const EPS = 1e-9;

/** In-memory application state, mirrored to localStorage. */
const state = {
  base: { attended: 0, total: 0 },   // starting point before any daily record
  history: [],                       // [{ id, date, attendedToday, classesHeldToday, cumulativeAttended, cumulativeTotal, attendance, statusKind, status }]
  target: DEFAULT_TARGET,            // desired attendance benchmark, e.g. 80
  timetable: null                    // null = flat default; otherwise { sun,mon,tue,wed,thu,fri,sat: number }
};

let editingId = null;
let confirmCallback = null;
let toastTimer = null;

/* ---------------- DOM refs ---------------- */

const el = (id) => document.getElementById(id);

const dom = {
  currentPercent: el('current-percent'),
  statusChip: el('status-chip'),
  progressFill: el('progress-fill'),
  progressTrack: el('progress-track'),
  statAttended: el('stat-attended'),
  statTotal: el('stat-total'),
  verdictText: el('verdict-text'),

  targetSlider: el('target-slider'),
  targetValue: el('target-value'),
  progressTargetMarker: el('progress-target-marker'),
  progressTargetLabel: el('progress-target-label'),

  themeToggle: el('theme-toggle'),
  themeToggleIcon: el('theme-toggle-icon'),

  ttMon: el('tt-mon'),
  ttTue: el('tt-tue'),
  ttWed: el('tt-wed'),
  ttThu: el('tt-thu'),
  ttFri: el('tt-fri'),
  ttSat: el('tt-sat'),
  ttSun: el('tt-sun'),
  timetableError: el('timetable-error'),
  saveTimetableBtn: el('save-timetable-btn'),
  clearTimetableBtn: el('clear-timetable-btn'),

  heatmapEmpty: el('heatmap-empty'),
  heatmapScroll: el('heatmap-scroll'),
  heatmapMonths: el('heatmap-months'),
  heatmapGrid: el('heatmap-grid'),
  heatmapLegend: el('heatmap-legend'),

  setupCard: el('setup-card'),
  prevAttended: el('prev-attended'),
  prevTotal: el('prev-total'),
  setupError: el('setup-error'),
  saveSetupBtn: el('save-setup-btn'),

  todayDate: el('today-date'),
  todayAttended: el('today-attended'),
  todayHeld: el('today-held'),
  todayError: el('today-error'),
  todayForm: el('today-form'),
  saveTodayBtn: el('save-today-btn'),
  resetBtn: el('reset-btn'),

  plannerClasses: el('planner-classes'),
  plannerGrid: el('planner-grid'),

  emptyState: el('empty-state'),
  tableWrap: el('table-wrap'),
  historyBody: el('history-body'),
  clearHistoryBtn: el('clear-history-btn'),

  editOverlay: el('edit-overlay'),
  editDate: el('edit-date'),
  editAttended: el('edit-attended'),
  editHeld: el('edit-held'),
  editError: el('edit-error'),
  editSaveBtn: el('edit-save-btn'),
  editCancelBtn: el('edit-cancel-btn'),

  confirmOverlay: el('confirm-overlay'),
  confirmMessage: el('confirm-message'),
  confirmOkBtn: el('confirm-ok-btn'),
  confirmCancelBtn: el('confirm-cancel-btn'),

  toast: el('toast')
};

/* ---------------- Utilities ---------------- */

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoToDisplay(iso) {
  if (!iso || iso.indexOf('-') === -1) return iso || '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Parse an ISO date string as a local-time Date (avoids UTC/timezone shifts). */
function isoToLocalDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function localDateToISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isoAddDays(iso, n) {
  const d = isoToLocalDate(iso);
  d.setDate(d.getDate() + n);
  return localDateToISO(d);
}

function weekdayKeyForISO(iso) {
  return WEEKDAY_KEYS[isoToLocalDate(iso).getDay()];
}

/** getDefaultHeldForDate: timetable value for that date's weekday, falling back to the flat default. */
function getDefaultHeldForDate(iso) {
  if (state.timetable && iso) {
    const key = weekdayKeyForISO(iso);
    const v = state.timetable[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return DEFAULT_HELD;
}

function makeId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function clampNonNegative(n) {
  return Math.max(0, n);
}

function showToast(message, duration = 2600) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, duration);
}

/* ---------------- Theme (dark / light) ---------------- */

function getStoredTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY_THEME);
  } catch (err) {
    return null;
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  dom.themeToggle.setAttribute('aria-pressed', String(isDark));
  dom.themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  dom.themeToggleIcon.textContent = isDark ? '☀️' : '🌙';
  try {
    localStorage.setItem(STORAGE_KEY_THEME, theme);
  } catch (err) {
    console.error('Could not save theme preference:', err);
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

/* ---------------- Core calculations ---------------- */

/** calculateAttendance(attended, total) -> percentage (number), 0 when total is 0 */
function calculateAttendance(attended, total) {
  if (!total || total <= 0) return 0;
  return (attended / total) * 100;
}

/** Determine status kind using integer comparison — exact, since target is always a whole percent. */
function statusKindFor(attended, total, target) {
  if (!total || total <= 0) return null;
  const lhs = attended * 100;
  const rhs = total * target;
  if (lhs === rhs) return 'exact';
  return lhs < rhs ? 'below' : 'above';
}

/** Human-readable label for a status kind, at a given target. */
function statusLabelFor(kind, target) {
  if (kind === 'exact') return `Exactly ${target}%`;
  if (kind === 'below') return `Below ${target}%`;
  if (kind === 'above') return `Above ${target}%`;
  return 'No data';
}

function statusClass(kind) {
  return kind === 'below' || kind === 'exact' || kind === 'above' ? kind : '';
}

/** calculateClassesNeeded: consecutive classes to attend to reach the target %, assuming all are attended. */
function calculateClassesNeeded(attended, total, target) {
  if (total <= 0) return 0;
  const t = target / 100;
  if (t >= 1) return attended >= total ? 0 : Infinity;
  const raw = (t * total - attended) / (1 - t);
  let x = Math.ceil(raw - EPS);
  x = clampNonNegative(x);
  // Safety verification per spec §37 — nudge up if rounding left it just short.
  let guard = 0;
  while (x > 0 && (attended + x) / (total + x) < t - EPS && guard < 5) {
    x++; guard++;
  }
  return x;
}

/** calculateClassesCanSkip: classes that can be missed while staying at/above the target %. */
function calculateClassesCanSkip(attended, total, target) {
  if (total <= 0) return 0;
  const t = target / 100;
  if (t <= 0) return Infinity;
  const raw = (attended - t * total) / t;
  let x = Math.floor(raw + EPS);
  x = clampNonNegative(x);
  // Safety verification per spec §37 — pull back if rounding made it unsafe.
  let guard = 0;
  while (x > 0 && attended / (total + x) < t - EPS && guard < 5) {
    x--; guard++;
  }
  return x;
}

/** calculateFutureAttendance: hypothetical % if `attendedMore` of `classesMore` are attended tomorrow. */
function calculateFutureAttendance(attended, total, attendedMore, classesMore) {
  const newTotal = total + classesMore;
  if (newTotal <= 0) return 0;
  return ((attended + attendedMore) / newTotal) * 100;
}

/* ---------------- Persistence ---------------- */

function loadFromLocalStorage() {
  try {
    const rawBase = localStorage.getItem(STORAGE_KEY_BASE);
    const rawHistory = localStorage.getItem(STORAGE_KEY_HISTORY);
    const rawTarget = localStorage.getItem(STORAGE_KEY_TARGET);

    if (rawBase) {
      const parsed = JSON.parse(rawBase);
      if (typeof parsed.attended === 'number' && typeof parsed.total === 'number') {
        state.base = parsed;
      }
    }
    if (rawHistory) {
      const parsed = JSON.parse(rawHistory);
      if (Array.isArray(parsed)) state.history = parsed;
    }
    if (rawTarget) {
      const parsed = Number(JSON.parse(rawTarget));
      if (Number.isFinite(parsed)) {
        state.target = Math.min(95, Math.max(50, Math.round(parsed)));
      }
    }

    const rawTimetable = localStorage.getItem(STORAGE_KEY_TIMETABLE);
    if (rawTimetable) {
      const parsed = JSON.parse(rawTimetable);
      const valid = parsed && WEEKDAY_KEYS.every(k => typeof parsed[k] === 'number' && Number.isFinite(parsed[k]) && parsed[k] >= 0);
      state.timetable = valid ? parsed : null;
    }
  } catch (err) {
    console.error('Failed to load saved attendance data:', err);
    state.base = { attended: 0, total: 0 };
    state.history = [];
    state.target = DEFAULT_TARGET;
    state.timetable = null;
  }
}

function saveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY_BASE, JSON.stringify(state.base));
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(state.history));
    localStorage.setItem(STORAGE_KEY_TARGET, JSON.stringify(state.target));
    localStorage.setItem(STORAGE_KEY_TIMETABLE, JSON.stringify(state.timetable));
  } catch (err) {
    console.error('Failed to save attendance data:', err);
    showToast('Could not save — your browser storage may be full.');
  }
}

/* ---------------- Cumulative recomputation ---------------- */

/**
 * updateCumulativeAttendance: recomputes cumulative totals & status for every
 * record, walking the history in date order starting from the base. Must be
 * called after any add / edit / delete / base change so nothing drifts.
 */
function updateCumulativeAttendance() {
  state.history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let cumAttended = state.base.attended;
  let cumTotal = state.base.total;

  for (const record of state.history) {
    cumAttended += record.attendedToday;
    cumTotal += record.classesHeldToday;
    record.cumulativeAttended = cumAttended;
    record.cumulativeTotal = cumTotal;
    record.attendance = calculateAttendance(cumAttended, cumTotal);
    record.statusKind = statusKindFor(cumAttended, cumTotal, state.target);
    record.status = statusLabelFor(record.statusKind, state.target);
  }
}

function getLatestCumulative() {
  if (state.history.length === 0) {
    return { attended: state.base.attended, total: state.base.total };
  }
  const last = state.history[state.history.length - 1];
  return { attended: last.cumulativeAttended, total: last.cumulativeTotal };
}

/* ---------------- Validation ---------------- */

function validateInputs({ dateVal, attendedVal, heldVal }) {
  if (!dateVal) return 'Please select a date.';
  if (attendedVal === '' || heldVal === '' || attendedVal === null || heldVal === null) {
    return 'Please enter valid numbers.';
  }
  const attended = Number(attendedVal);
  const held = Number(heldVal);
  if (!Number.isFinite(attended) || !Number.isFinite(held)) {
    return 'Please enter valid numbers.';
  }
  if (!Number.isInteger(attended) || !Number.isInteger(held)) {
    return 'Please enter whole numbers.';
  }
  if (held <= 0) return 'Total classes must be greater than zero.';
  if (attended < 0) return 'Classes attended cannot be negative.';
  if (attended > held) return 'Classes attended cannot be greater than classes held.';
  return null;
}

function validateBase(prevAttendedVal, prevTotalVal) {
  const attended = Number(prevAttendedVal);
  const total = Number(prevTotalVal);
  if (!Number.isFinite(attended) || !Number.isFinite(total)) return 'Please enter valid numbers.';
  if (!Number.isInteger(attended) || !Number.isInteger(total)) return 'Please enter whole numbers.';
  if (attended < 0) return 'Previous classes attended cannot be negative.';
  if (total < 0) return 'Previous total classes cannot be negative.';
  if (attended > total) return 'Previous classes attended cannot be greater than previous total classes.';
  return null;
}

/* ---------------- Rendering ---------------- */

function renderDashboard() {
  const { attended, total } = getLatestCumulative();
  const target = state.target;
  const pct = calculateAttendance(attended, total);
  const hasData = total > 0;
  const kind = hasData ? statusKindFor(attended, total, target) : null;
  const status = hasData ? statusLabelFor(kind, target) : null;
  const cls = statusClass(kind);

  dom.currentPercent.textContent = hasData ? `${pct.toFixed(2)}%` : '0.00%';
  dom.statAttended.textContent = String(attended);
  dom.statTotal.textContent = String(total);

  dom.statusChip.className = 'status-chip' + (cls ? ' ' + cls : '');
  dom.statusChip.textContent = hasData ? status : 'No records yet';

  const fillPct = hasData ? Math.min(100, Math.max(0, pct)) : 0;
  dom.progressFill.style.width = fillPct + '%';
  dom.progressFill.className = 'progress-fill' + (cls ? ' ' + cls : '');
  dom.progressTrack.setAttribute('aria-valuenow', hasData ? pct.toFixed(0) : '0');

  dom.targetValue.textContent = `${target}%`;
  if (Number(dom.targetSlider.value) !== target) dom.targetSlider.value = String(target);
  dom.progressTargetMarker.style.left = target + '%';
  dom.progressTargetMarker.title = `${target}% target`;
  dom.progressTargetLabel.textContent = `${target}% target`;

  if (!hasData) {
    dom.verdictText.textContent = "Add today's attendance below to start tracking.";
  } else if (kind === 'below') {
    const needed = calculateClassesNeeded(attended, total, target);
    dom.verdictText.textContent =
      `⚠️ Your attendance is below ${target}%. Attend the next ${needed} class${needed === 1 ? '' : 'es'} consecutively to reach ${target}%.`;
  } else if (kind === 'exact') {
    dom.verdictText.textContent =
      `✅ Your attendance is exactly ${target}%. You are currently meeting your target — any missed class will drop you below it.`;
  } else {
    const skip = calculateClassesCanSkip(attended, total, target);
    dom.verdictText.textContent =
      `🎉 Your attendance is above ${target}%. You can leave ${skip} more lecture${skip === 1 ? '' : 's'} and still maintain at least ${target}%.`;
  }

  dom.setupCard.hidden = state.history.length !== 0;

  renderPlanner();
}

function updateTarget(newTarget) {
  const clamped = Math.min(95, Math.max(50, Math.round(newTarget)));
  if (clamped === state.target) return;
  state.target = clamped;
  updateCumulativeAttendance(); // every record's status label depends on the target
  saveToLocalStorage();
  renderDashboard();
  renderAttendanceHistory();
}

function renderPlanner() {
  const { attended, total } = getLatestCumulative();
  let n = parseInt(dom.plannerClasses.value, 10);
  if (!Number.isFinite(n) || n < 0) n = 0;

  const scenarios = [];
  const add = (label, attendedMore) => {
    const key = `${label}-${attendedMore}`;
    if (scenarios.some(s => s.key === key)) return;
    scenarios.push({ key, label, attendedMore });
  };

  add(`Attend all ${n}`, n);
  if (n > 0) {
    const threeQ = Math.ceil(n * 0.75);
    const half = Math.round(n * 0.5);
    if (threeQ < n) add(`Attend ${threeQ}`, threeQ);
    if (half > 0 && half !== threeQ) add(`Attend ${half}`, half);
  }
  add('Attend 0', 0);

  dom.plannerGrid.innerHTML = '';
  scenarios.forEach(s => {
    const pct = calculateFutureAttendance(attended, total, s.attendedMore, n);
    const kind = total + n > 0 ? statusKindFor(attended + s.attendedMore, total + n, state.target) : null;
    const cls = statusClass(kind);

    const item = document.createElement('div');
    item.className = 'planner-item';
    item.innerHTML = `
      <div class="planner-item-label">${s.label}</div>
      <div class="planner-item-value ${cls}">${pct.toFixed(2)}%</div>
    `;
    dom.plannerGrid.appendChild(item);
  });
}

function renderAttendanceHistory() {
  const hasHistory = state.history.length > 0;
  dom.emptyState.hidden = hasHistory;
  dom.tableWrap.hidden = !hasHistory;
  if (!hasHistory) {
    dom.historyBody.innerHTML = '';
  } else {
    const rows = [...state.history].reverse(); // newest first
    dom.historyBody.innerHTML = rows.map(r => {
      const cls = statusClass(r.statusKind);
      return `
        <tr data-id="${r.id}">
          <td>${isoToDisplay(r.date)}</td>
          <td>${r.attendedToday}</td>
          <td>${r.classesHeldToday}</td>
          <td>${r.cumulativeAttended}</td>
          <td>${r.cumulativeTotal}</td>
          <td>${r.attendance.toFixed(2)}%</td>
          <td><span class="status-pill ${cls}">${r.status}</span></td>
          <td>
            <div class="row-actions">
              <button type="button" class="btn btn-ghost btn-small" data-action="edit" data-id="${r.id}">Edit</button>
              <button type="button" class="btn btn-danger-ghost btn-small" data-action="delete" data-id="${r.id}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderHeatmap();
}

/* ---------------- Heatmap ---------------- */

/** Builds a Sunday-aligned, Saturday-padded run of ISO dates covering the visible window. */
function buildHeatmapDays() {
  const sortedDates = state.history.map(r => r.date).sort();
  const earliest = sortedDates[0];
  const today = todayISO();
  const windowStart = isoAddDays(today, -(HEATMAP_MAX_DAYS - 1));
  const start = earliest > windowStart ? earliest : windowStart; // later of the two (string compare works for ISO dates)

  const gridStart = isoAddDays(start, -isoToLocalDate(start).getDay()); // back up to the preceding Sunday

  const days = [];
  let cursor = gridStart;
  while (cursor <= today) {
    days.push(cursor);
    cursor = isoAddDays(cursor, 1);
  }
  while (isoToLocalDate(days[days.length - 1]).getDay() !== 6) {
    days.push(isoAddDays(days[days.length - 1], 1)); // pad out to Saturday so every week column is full
  }
  return { days, today };
}

function renderHeatmap() {
  const hasHistory = state.history.length > 0;
  dom.heatmapEmpty.hidden = hasHistory;
  dom.heatmapScroll.hidden = !hasHistory;
  dom.heatmapLegend.hidden = !hasHistory;
  if (!hasHistory) {
    dom.heatmapGrid.innerHTML = '';
    dom.heatmapMonths.innerHTML = '';
    return;
  }

  const recordMap = new Map(state.history.map(r => [r.date, r]));
  const { days, today } = buildHeatmapDays();

  dom.heatmapGrid.innerHTML = days.map(iso => {
    if (iso > today) return `<div class="heatmap-cell future" aria-hidden="true"></div>`;
    const record = recordMap.get(iso);
    if (!record) {
      return `<div class="heatmap-cell none" title="${isoToDisplay(iso)} — no record"></div>`;
    }
    const ratio = record.classesHeldToday > 0 ? record.attendedToday / record.classesHeldToday : 0;
    const bucket = ratio >= 1 ? 'full' : ratio <= 0 ? 'missed' : 'partial';
    const title = `${isoToDisplay(iso)} — ${record.attendedToday}/${record.classesHeldToday} classes attended`;
    return `<div class="heatmap-cell ${bucket}" title="${title}"></div>`;
  }).join('');

  const colWidth = HEATMAP_CELL + HEATMAP_GAP;
  const weekCount = days.length / 7;
  let lastMonth = null;
  let labelsHtml = '';
  for (let w = 0; w < weekCount; w++) {
    const firstDayOfWeek = days[w * 7];
    const monthIdx = isoToLocalDate(firstDayOfWeek).getMonth();
    if (monthIdx !== lastMonth) {
      const label = isoToLocalDate(firstDayOfWeek).toLocaleDateString('en-US', { month: 'short' });
      labelsHtml += `<span class="heatmap-month-label" style="left:${w * colWidth}px">${label}</span>`;
      lastMonth = monthIdx;
    }
  }
  dom.heatmapMonths.innerHTML = labelsHtml;
}

/* ---------------- Actions ---------------- */

function resetToday() {
  const iso = todayISO();
  dom.todayDate.value = iso;
  dom.todayAttended.value = '';
  dom.todayHeld.value = String(getDefaultHeldForDate(iso));
  dom.todayError.textContent = '';
}

function addDailyAttendance() {
  dom.todayError.textContent = '';
  const dateVal = dom.todayDate.value;
  const attendedVal = dom.todayAttended.value;
  const heldVal = dom.todayHeld.value;

  const error = validateInputs({ dateVal, attendedVal, heldVal });
  if (error) {
    dom.todayError.textContent = error;
    return;
  }

  const attendedToday = parseInt(attendedVal, 10);
  const classesHeldToday = parseInt(heldVal, 10);

  const existing = state.history.find(r => r.date === dateVal);
  if (existing) {
    showConfirm(
      'Attendance for this date already exists. Do you want to replace it?',
      () => commitDailyAttendance(dateVal, attendedToday, classesHeldToday, existing.id)
    );
    return;
  }

  commitDailyAttendance(dateVal, attendedToday, classesHeldToday, null);
}

function commitDailyAttendance(dateVal, attendedToday, classesHeldToday, replaceId) {
  if (replaceId) {
    state.history = state.history.filter(r => r.id !== replaceId);
  }
  state.history.push({
    id: makeId(),
    date: dateVal,
    attendedToday,
    classesHeldToday
  });

  updateCumulativeAttendance();
  saveToLocalStorage();
  renderDashboard();
  renderAttendanceHistory();
  resetToday();
  showToast(replaceId ? 'Attendance updated for that date.' : "Today's attendance saved.");
}

function saveSetup() {
  dom.setupError.textContent = '';
  const error = validateBase(dom.prevAttended.value, dom.prevTotal.value);
  if (error) {
    dom.setupError.textContent = error;
    return;
  }
  state.base = {
    attended: parseInt(dom.prevAttended.value, 10),
    total: parseInt(dom.prevTotal.value, 10)
  };
  updateCumulativeAttendance();
  saveToLocalStorage();
  renderDashboard();
  renderAttendanceHistory();
  showToast('Starting point saved.');
}

/* ---------------- Weekly timetable ---------------- */

function readTimetableInputs() {
  return {
    sun: dom.ttSun.value, mon: dom.ttMon.value, tue: dom.ttTue.value, wed: dom.ttWed.value,
    thu: dom.ttThu.value, fri: dom.ttFri.value, sat: dom.ttSat.value
  };
}

function validateTimetable(values) {
  for (const key of WEEKDAY_KEYS) {
    const n = Number(values[key]);
    if (values[key] === '' || !Number.isFinite(n)) return 'Please enter a number for every day.';
    if (!Number.isInteger(n)) return 'Please enter whole numbers.';
    if (n < 0) return 'Classes per day cannot be negative.';
  }
  return null;
}

function saveTimetable() {
  dom.timetableError.textContent = '';
  const raw = readTimetableInputs();
  const error = validateTimetable(raw);
  if (error) {
    dom.timetableError.textContent = error;
    return;
  }
  const timetable = {};
  WEEKDAY_KEYS.forEach(key => { timetable[key] = parseInt(raw[key], 10); });
  state.timetable = timetable;
  saveToLocalStorage();
  dom.todayHeld.value = String(getDefaultHeldForDate(dom.todayDate.value || todayISO()));
  showToast('Weekly timetable saved.');
}

function clearTimetable() {
  state.timetable = null;
  saveToLocalStorage();
  dom.ttMon.value = '8'; dom.ttTue.value = '8'; dom.ttWed.value = '8';
  dom.ttThu.value = '8'; dom.ttFri.value = '8'; dom.ttSat.value = '0'; dom.ttSun.value = '0';
  dom.timetableError.textContent = '';
  dom.todayHeld.value = String(getDefaultHeldForDate(dom.todayDate.value || todayISO()));
  showToast('Back to the flat 8-classes default.');
}

function deleteAttendanceRecord(id) {
  const record = state.history.find(r => r.id === id);
  if (!record) return;
  showConfirm(
    `Delete the record for ${isoToDisplay(record.date)}? This will recalculate all later cumulative totals.`,
    () => {
      state.history = state.history.filter(r => r.id !== id);
      updateCumulativeAttendance();
      saveToLocalStorage();
      renderDashboard();
      renderAttendanceHistory();
      showToast('Record deleted.');
    }
  );
}

function openEditModal(id) {
  const record = state.history.find(r => r.id === id);
  if (!record) return;
  editingId = id;
  dom.editDate.value = record.date;
  dom.editAttended.value = String(record.attendedToday);
  dom.editHeld.value = String(record.classesHeldToday);
  dom.editError.textContent = '';
  dom.editOverlay.hidden = false;
  dom.editAttended.focus();
}

function closeEditModal() {
  dom.editOverlay.hidden = true;
  editingId = null;
}

function editAttendanceRecord() {
  if (!editingId) return;
  dom.editError.textContent = '';

  const dateVal = dom.editDate.value;
  const attendedVal = dom.editAttended.value;
  const heldVal = dom.editHeld.value;

  const error = validateInputs({ dateVal, attendedVal, heldVal });
  if (error) {
    dom.editError.textContent = error;
    return;
  }

  const conflict = state.history.find(r => r.date === dateVal && r.id !== editingId);
  if (conflict) {
    dom.editError.textContent = 'Another record already exists for this date.';
    return;
  }

  const record = state.history.find(r => r.id === editingId);
  record.date = dateVal;
  record.attendedToday = parseInt(attendedVal, 10);
  record.classesHeldToday = parseInt(heldVal, 10);

  updateCumulativeAttendance();
  saveToLocalStorage();
  renderDashboard();
  renderAttendanceHistory();
  closeEditModal();
  showToast('Record updated.');
}

function clearHistory() {
  if (state.history.length === 0) return;
  showConfirm(
    'Are you sure you want to clear your entire attendance history? This cannot be undone.',
    () => {
      state.history = [];
      updateCumulativeAttendance();
      saveToLocalStorage();
      renderDashboard();
      renderAttendanceHistory();
      showToast('Attendance history cleared.');
    }
  );
}

/* ---------------- Confirm dialog (generic) ---------------- */

function showConfirm(message, onConfirm) {
  dom.confirmMessage.textContent = message;
  confirmCallback = onConfirm;
  dom.confirmOverlay.hidden = false;
  dom.confirmOkBtn.focus();
}

function closeConfirm() {
  dom.confirmOverlay.hidden = true;
  confirmCallback = null;
}

/* ---------------- Event wiring ---------------- */

function wireEvents() {
  dom.saveSetupBtn.addEventListener('click', saveSetup);
  dom.saveTodayBtn.addEventListener('click', addDailyAttendance);
  dom.resetBtn.addEventListener('click', resetToday);
  dom.clearHistoryBtn.addEventListener('click', clearHistory);

  dom.todayDate.addEventListener('change', () => {
    dom.todayHeld.value = String(getDefaultHeldForDate(dom.todayDate.value));
  });

  dom.saveTimetableBtn.addEventListener('click', saveTimetable);
  dom.clearTimetableBtn.addEventListener('click', clearTimetable);

  dom.plannerClasses.addEventListener('input', renderPlanner);

  dom.targetSlider.addEventListener('input', (e) => {
    updateTarget(parseInt(e.target.value, 10));
  });

  dom.themeToggle.addEventListener('click', toggleTheme);

  dom.todayForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDailyAttendance();
    }
  });

  dom.historyBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (btn.getAttribute('data-action') === 'edit') openEditModal(id);
    if (btn.getAttribute('data-action') === 'delete') deleteAttendanceRecord(id);
  });

  dom.editSaveBtn.addEventListener('click', editAttendanceRecord);
  dom.editCancelBtn.addEventListener('click', closeEditModal);
  dom.editOverlay.addEventListener('click', (e) => {
    if (e.target === dom.editOverlay) closeEditModal();
  });
  dom.editOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); editAttendanceRecord(); }
    if (e.key === 'Escape') closeEditModal();
  });

  dom.confirmOkBtn.addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });
  dom.confirmCancelBtn.addEventListener('click', closeConfirm);
  dom.confirmOverlay.addEventListener('click', (e) => {
    if (e.target === dom.confirmOverlay) closeConfirm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!dom.confirmOverlay.hidden) closeConfirm();
      if (!dom.editOverlay.hidden) closeEditModal();
    }
  });
}

/* ---------------- Init ---------------- */

function init() {
  loadFromLocalStorage();
  updateCumulativeAttendance();

  const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(currentTheme);

  const iso = todayISO();
  dom.todayDate.value = iso;
  dom.todayHeld.value = String(getDefaultHeldForDate(iso));
  dom.targetSlider.value = String(state.target);

  if (state.timetable) {
    dom.ttSun.value = String(state.timetable.sun);
    dom.ttMon.value = String(state.timetable.mon);
    dom.ttTue.value = String(state.timetable.tue);
    dom.ttWed.value = String(state.timetable.wed);
    dom.ttThu.value = String(state.timetable.thu);
    dom.ttFri.value = String(state.timetable.fri);
    dom.ttSat.value = String(state.timetable.sat);
  }

  wireEvents();
  renderDashboard();
  renderAttendanceHistory();
}

document.addEventListener('DOMContentLoaded', init);
