'use strict';

/* =========================================================
   Attendance Register — script.js
   Vanilla JS. No frameworks, no build step.
   ========================================================= */

const REQUIRED_PCT = 75;
const STORAGE_KEY_BASE = 'attendanceRegister.base';
const STORAGE_KEY_HISTORY = 'attendanceRegister.history';
const EPS = 1e-9;

/** In-memory application state, mirrored to localStorage. */
const state = {
  base: { attended: 0, total: 0 },   // starting point before any daily record
  history: []                        // [{ id, date, attendedToday, classesHeldToday, cumulativeAttended, cumulativeTotal, attendance, status }]
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

/* ---------------- Core calculations ---------------- */

/** calculateAttendance(attended, total) -> percentage (number), 0 when total is 0 */
function calculateAttendance(attended, total) {
  if (!total || total <= 0) return 0;
  return (attended / total) * 100;
}

/** Determine status using integer comparison to avoid float drift. */
function statusFor(attended, total) {
  if (!total || total <= 0) return 'No data';
  const lhs = attended * 4;
  const rhs = total * 3; // 0.75 * total, scaled by 4
  if (Math.abs(lhs - rhs) < EPS) return 'Exactly 75%';
  return lhs < rhs ? 'Below 75%' : 'Above 75%';
}

function statusClass(status) {
  if (status === 'Below 75%') return 'below';
  if (status === 'Exactly 75%') return 'exact';
  if (status === 'Above 75%') return 'above';
  return '';
}

/** calculateClassesNeeded: consecutive classes to attend to reach 75%, assuming all are attended. */
function calculateClassesNeeded(attended, total) {
  if (total <= 0) return 0;
  const raw = (0.75 * total - attended) / 0.25;
  let x = Math.ceil(raw - EPS);
  x = clampNonNegative(x);
  // Safety verification per spec §37 — nudge up if rounding left it just short.
  let guard = 0;
  while (x > 0 && (attended + x) / (total + x) < 0.75 - EPS && guard < 5) {
    x++; guard++;
  }
  return x;
}

/** calculateClassesCanSkip: classes that can be missed while staying at/above 75%. */
function calculateClassesCanSkip(attended, total) {
  if (total <= 0) return 0;
  const raw = (attended - 0.75 * total) / 0.75;
  let x = Math.floor(raw + EPS);
  x = clampNonNegative(x);
  // Safety verification per spec §37 — pull back if rounding made it unsafe.
  let guard = 0;
  while (x > 0 && attended / (total + x) < 0.75 - EPS && guard < 5) {
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
  } catch (err) {
    console.error('Failed to load saved attendance data:', err);
    state.base = { attended: 0, total: 0 };
    state.history = [];
  }
}

function saveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY_BASE, JSON.stringify(state.base));
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(state.history));
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
    record.status = statusFor(cumAttended, cumTotal);
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
  const pct = calculateAttendance(attended, total);
  const hasData = total > 0;
  const status = hasData ? statusFor(attended, total) : null;
  const cls = statusClass(status);

  dom.currentPercent.textContent = hasData ? `${pct.toFixed(2)}%` : '0.00%';
  dom.statAttended.textContent = String(attended);
  dom.statTotal.textContent = String(total);

  dom.statusChip.className = 'status-chip' + (cls ? ' ' + cls : '');
  dom.statusChip.textContent = hasData ? status : 'No records yet';

  const fillPct = hasData ? Math.min(100, Math.max(0, pct)) : 0;
  dom.progressFill.style.width = fillPct + '%';
  dom.progressFill.className = 'progress-fill' + (cls ? ' ' + cls : '');
  dom.progressTrack.setAttribute('aria-valuenow', hasData ? pct.toFixed(0) : '0');

  if (!hasData) {
    dom.verdictText.textContent = "Add today's attendance below to start tracking.";
  } else if (status === 'Below 75%') {
    const needed = calculateClassesNeeded(attended, total);
    dom.verdictText.textContent =
      `⚠️ Your attendance is below 75%. Attend the next ${needed} class${needed === 1 ? '' : 'es'} consecutively to reach 75%.`;
  } else if (status === 'Exactly 75%') {
    dom.verdictText.textContent =
      '✅ Your attendance is exactly 75%. You are currently meeting the minimum requirement — any missed class will drop you below it.';
  } else {
    const skip = calculateClassesCanSkip(attended, total);
    dom.verdictText.textContent =
      `🎉 Your attendance is above 75%. You can leave ${skip} more lecture${skip === 1 ? '' : 's'} and still maintain at least 75%.`;
  }

  dom.setupCard.hidden = state.history.length !== 0;

  renderPlanner();
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
    const status = total + n > 0 ? statusFor(attended + s.attendedMore, total + n) : 'No data';
    const cls = statusClass(status);

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
    return;
  }

  const rows = [...state.history].reverse(); // newest first
  dom.historyBody.innerHTML = rows.map(r => {
    const cls = statusClass(r.status);
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

/* ---------------- Actions ---------------- */

function resetToday() {
  dom.todayDate.value = todayISO();
  dom.todayAttended.value = '';
  dom.todayHeld.value = '8';
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

  dom.plannerClasses.addEventListener('input', renderPlanner);

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

  dom.todayDate.value = todayISO();
  dom.todayHeld.value = '8';

  wireEvents();
  renderDashboard();
  renderAttendanceHistory();
}

document.addEventListener('DOMContentLoaded', init);
