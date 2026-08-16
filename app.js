'use strict';

/* ========== ストレージ ========== */
const store = {
  load(key, fallback) {
    try {
      const raw = localStorage.getItem('lifelog.' + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  save(key, value) {
    localStorage.setItem('lifelog.' + key, JSON.stringify(value));
    if (key !== 'settings' && !syncing) scheduleBackup();
  },
};

let workouts = store.load('workouts', []);   // {id, datetime, parts[], exercise, sets, reps, weight, memo}
let lasers = store.load('lasers', []);       // {id, datetime, part}
let meals = store.load('meals', []);         // {id, date, time, mealType, name, protein}
let privates = store.load('privates', []);   // {id, datetime} プライベート記録(射精日)
let tombstones = store.load('tombstones', {}); // {id: 削除日時} 端末間同期で削除を伝えるための履歴
let syncing = false; // マージ保存中はscheduleBackupを抑止
let settings = Object.assign(
  {
    proteinGoalMin: 100, proteinGoalMax: 110, laserMinDays: 7, laserMaxDays: 14,
    gistToken: '', gistId: '', lastBackupAt: '', lastBackupHash: '',
  },
  store.load('settings', {})
);

const WORKOUT_PARTS = ['胸', '背中', '脚', '肩', '腕', '腹'];
const LASER_PARTS = ['腕', '左足', '右足'];
const MEAL_TYPES = ['朝食', '昼食', '夕食', '間食'];
const PART_COLORS = { '胸': '#ef4444', '背中': '#3b82f6', '脚': '#f59e0b', '肩': '#8b5cf6', '腕': '#10b981', '腹': '#ec4899' };
const LASER_COLORS = { '腕': '#10b981', '左足': '#3b82f6', '右足': '#f59e0b' };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = (sel) => document.querySelector(sel);

/* ========== 日付ユーティリティ ========== */
function pad(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toDatetimeLocal(d) { return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${day})`;
}
function fmtDatetime(iso) {
  const d = new Date(iso);
  return `${fmtDate(toDateStr(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function daysBetween(dateStr, todayStr) {
  const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUTC(todayStr) - toUTC(dateStr)) / 86400000);
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return toDateStr(new Date(y, m - 1, d + n));
}
const today = () => toDateStr(new Date());

/* ========== 共通UI ========== */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function buildChips(container, parts, single) {
  container.innerHTML = '';
  parts.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p;
    b.dataset.part = p;
    b.addEventListener('click', () => {
      if (single) {
        container.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
        b.classList.add('selected');
      } else {
        b.classList.toggle('selected');
      }
    });
    container.appendChild(b);
  });
}
function selectedChips(container) {
  return [...container.querySelectorAll('.chip.selected')].map((c) => c.dataset.part);
}

function recordItem(title, detail, badges, onDelete) {
  const item = document.createElement('div');
  item.className = 'record-item';
  const body = document.createElement('div');
  body.className = 'record-body';
  const t = document.createElement('div');
  t.className = 'record-title';
  badges.forEach((bg) => {
    const s = document.createElement('span');
    s.className = 'badge';
    s.textContent = bg;
    t.appendChild(s);
  });
  t.appendChild(document.createTextNode(title));
  body.appendChild(t);
  if (detail) {
    const dt = document.createElement('div');
    dt.className = 'record-detail';
    dt.textContent = detail;
    body.appendChild(dt);
  }
  item.appendChild(body);
  const del = document.createElement('button');
  del.className = 'del-btn';
  del.textContent = '🗑';
  del.setAttribute('aria-label', '削除');
  del.addEventListener('click', () => {
    if (confirm('この記録を削除しますか?')) onDelete();
  });
  item.appendChild(del);
  return item;
}

/* ========== カレンダー ========== */
function buildLegend(container, colors) {
  container.innerHTML = '';
  Object.entries(colors).forEach(([name, color]) => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'cal-dot';
    dot.style.background = color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(name));
    container.appendChild(item);
  });
}

// marksFor(dateStr) が返す色の配列をドットとして日付セルに描画する
function renderCalendar(titleEl, gridEl, cal, marksFor, selected, onSelect) {
  titleEl.textContent = `${cal.y}年${cal.m + 1}月`;
  gridEl.innerHTML = '';
  ['日', '月', '火', '水', '木', '金', '土'].forEach((d) => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    gridEl.appendChild(el);
  });
  const firstDow = new Date(cal.y, cal.m, 1).getDay();
  const daysInMonth = new Date(cal.y, cal.m + 1, 0).getDate();
  for (let i = 0; i < firstDow; i++) gridEl.appendChild(document.createElement('div'));
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${cal.y}-${pad(cal.m + 1)}-${pad(d)}`;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day';
    if (dateStr === today()) cell.classList.add('today');
    if (dateStr === selected) cell.classList.add('selected');
    const num = document.createElement('div');
    num.className = 'cal-num';
    num.textContent = d;
    cell.appendChild(num);
    const dots = document.createElement('div');
    dots.className = 'cal-dots';
    marksFor(dateStr).slice(0, 4).forEach((color) => {
      const s = document.createElement('span');
      s.className = 'cal-dot';
      s.style.background = color;
      dots.appendChild(s);
    });
    cell.appendChild(dots);
    cell.addEventListener('click', () => onSelect(dateStr));
    gridEl.appendChild(cell);
  }
}

const nowDate = new Date();
const wCal = { y: nowDate.getFullYear(), m: nowDate.getMonth() };
const lCal = { y: nowDate.getFullYear(), m: nowDate.getMonth() };
let wCalSelected = '';
let lCalSelected = '';

function shiftMonth(cal, diff, render) {
  cal.m += diff;
  if (cal.m < 0) { cal.m = 11; cal.y--; }
  if (cal.m > 11) { cal.m = 0; cal.y++; }
  render();
}

/* ========== タブ切り替え ========== */
const TAB_TITLES = { workout: '💪 筋トレ', laser: '✨ 脱毛', meal: '🍗 食事', private: '🔒 プライベート', settings: '⚙️ 設定' };
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    $('#tab-' + btn.dataset.tab).classList.add('active');
    $('#header-title').textContent = TAB_TITLES[btn.dataset.tab];
    if (btn.dataset.tab === 'settings') renderSettings();
    window.scrollTo(0, 0);
  });
});

/* ========== 筋トレ ========== */
buildChips($('#w-parts'), WORKOUT_PARTS, false);
$('#w-datetime').value = toDatetimeLocal(new Date());

WORKOUT_PARTS.forEach((p) => {
  const opt = document.createElement('option');
  opt.value = p;
  opt.textContent = p;
  $('#w-filter-part').appendChild(opt);
});

$('#workout-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const parts = selectedChips($('#w-parts'));
  if (parts.length === 0) { toast('部位を選択してください'); return; }
  workouts.push({
    id: uid(),
    datetime: $('#w-datetime').value,
    parts,
    exercise: $('#w-exercise').value.trim(),
    sets: $('#w-sets').value ? Number($('#w-sets').value) : null,
    reps: $('#w-reps').value ? Number($('#w-reps').value) : null,
    weight: $('#w-weight').value ? Number($('#w-weight').value) : null,
    memo: $('#w-memo').value.trim(),
  });
  store.save('workouts', workouts);
  $('#w-exercise').value = '';
  $('#w-sets').value = '';
  $('#w-reps').value = '';
  $('#w-weight').value = '';
  $('#w-memo').value = '';
  toast('筋トレを記録しました');
  renderWorkout();
});

$('#w-exercise').addEventListener('change', () => {
  // 過去に同じ種目があれば直近のセット・回数・重量を自動補完
  const name = $('#w-exercise').value.trim();
  if (!name) return;
  const past = [...workouts].reverse().find((w) => w.exercise === name);
  if (past) {
    if (past.sets != null && !$('#w-sets').value) $('#w-sets').value = past.sets;
    if (past.reps != null && !$('#w-reps').value) $('#w-reps').value = past.reps;
    if (past.weight != null && !$('#w-weight').value) $('#w-weight').value = past.weight;
    if (selectedChips($('#w-parts')).length === 0) {
      $('#w-parts').querySelectorAll('.chip').forEach((c) => {
        if (past.parts.includes(c.dataset.part)) c.classList.add('selected');
      });
    }
  }
});

$('#w-filter-part').addEventListener('change', renderWorkout);
$('#w-filter-month').addEventListener('change', renderWorkout);

buildLegend($('#w-cal-legend'), PART_COLORS);
$('#w-cal-prev').addEventListener('click', () => shiftMonth(wCal, -1, renderWorkoutCalendar));
$('#w-cal-next').addEventListener('click', () => shiftMonth(wCal, 1, renderWorkoutCalendar));

function renderWorkoutCalendar() {
  renderCalendar(
    $('#w-cal-title'), $('#w-calendar'), wCal,
    (dateStr) => {
      const parts = new Set();
      workouts.forEach((w) => { if (w.datetime.slice(0, 10) === dateStr) w.parts.forEach((p) => parts.add(p)); });
      return WORKOUT_PARTS.filter((p) => parts.has(p)).map((p) => PART_COLORS[p]);
    },
    wCalSelected,
    (dateStr) => {
      wCalSelected = wCalSelected === dateStr ? '' : dateStr;
      renderWorkoutCalendar();
    }
  );
  const detail = $('#w-cal-detail');
  detail.innerHTML = '';
  if (!wCalSelected) return;
  const recs = workouts
    .filter((w) => w.datetime.slice(0, 10) === wCalSelected)
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
  const head = document.createElement('div');
  head.className = 'date-group';
  head.textContent = `${fmtDate(wCalSelected)} の記録`;
  detail.appendChild(head);
  if (recs.length === 0) {
    detail.insertAdjacentHTML('beforeend', '<div class="empty">記録がありません</div>');
    return;
  }
  recs.forEach((w) => {
    const parts = [];
    if (w.sets != null || w.reps != null || w.weight != null) {
      parts.push([
        w.sets != null ? `${w.sets}セット` : '',
        w.reps != null ? `${w.reps}回` : '',
        w.weight != null ? `${w.weight}kg` : '',
      ].filter(Boolean).join(' × '));
    }
    if (w.memo) parts.push(w.memo);
    detail.appendChild(recordItem(w.exercise, parts.join(' / '), w.parts, () => {
      workouts = workouts.filter((x) => x.id !== w.id);
      markDeleted(w.id);
      store.save('workouts', workouts);
      renderWorkout();
    }));
  });
}

function renderWorkout() {
  renderWorkoutCalendar();
  // ステータス: 最終トレーニング日からの経過日数
  const status = $('#workout-status');
  if (workouts.length === 0) {
    status.innerHTML = '<div class="big">記録なし</div><div class="sub">最初のトレーニングを記録しましょう</div>';
  } else {
    const lastDate = workouts.map((w) => w.datetime.slice(0, 10)).sort().at(-1);
    const days = daysBetween(lastDate, today());
    const label = days === 0 ? '今日トレーニング済み 🎉' : `最終トレーニングから ${days}日経過`;
    status.innerHTML = `<div class="big">${label}</div><div class="sub">最終: ${fmtDate(lastDate)}</div>`;
  }

  // 種目サジェスト
  const names = [...new Set(workouts.map((w) => w.exercise).filter(Boolean))];
  $('#w-exercise-list').innerHTML = names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');

  // 月フィルタの選択肢を更新
  const monthSel = $('#w-filter-month');
  const months = [...new Set(workouts.map((w) => w.datetime.slice(0, 7)))].sort().reverse();
  const cur = monthSel.value;
  monthSel.innerHTML = '<option value="">全期間</option>' +
    months.map((m) => `<option value="${m}">${m.replace('-', '年')}月</option>`).join('');
  if (months.includes(cur)) monthSel.value = cur;

  // 一覧
  const partFilter = $('#w-filter-part').value;
  const monthFilter = monthSel.value;
  const list = $('#workout-list');
  list.innerHTML = '';
  const filtered = workouts
    .filter((w) => (!partFilter || w.parts.includes(partFilter)) && (!monthFilter || w.datetime.startsWith(monthFilter)))
    .sort((a, b) => b.datetime.localeCompare(a.datetime));

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">記録がありません</div>';
    return;
  }
  let lastGroup = '';
  filtered.forEach((w) => {
    const date = w.datetime.slice(0, 10);
    if (date !== lastGroup) {
      lastGroup = date;
      const g = document.createElement('div');
      g.className = 'date-group';
      g.textContent = fmtDate(date);
      list.appendChild(g);
    }
    const detailParts = [];
    if (w.sets != null || w.reps != null || w.weight != null) {
      detailParts.push([
        w.sets != null ? `${w.sets}セット` : '',
        w.reps != null ? `${w.reps}回` : '',
        w.weight != null ? `${w.weight}kg` : '',
      ].filter(Boolean).join(' × '));
    }
    if (w.memo) detailParts.push(w.memo);
    list.appendChild(recordItem(w.exercise, detailParts.join(' / '), w.parts, () => {
      workouts = workouts.filter((x) => x.id !== w.id);
      markDeleted(w.id);
      store.save('workouts', workouts);
      renderWorkout();
    }));
  });
}

/* ========== 脱毛 ========== */
buildChips($('#l-parts'), LASER_PARTS, true);
$('#l-datetime').value = toDatetimeLocal(new Date());

$('#laser-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const part = selectedChips($('#l-parts'))[0];
  if (!part) { toast('部位を選択してください'); return; }
  lasers.push({ id: uid(), datetime: $('#l-datetime').value, part });
  store.save('lasers', lasers);
  toast(`${part}を記録しました`);
  renderLaser();
});

buildLegend($('#l-cal-legend'), LASER_COLORS);
$('#l-cal-prev').addEventListener('click', () => shiftMonth(lCal, -1, renderLaserCalendar));
$('#l-cal-next').addEventListener('click', () => shiftMonth(lCal, 1, renderLaserCalendar));

function renderLaserCalendar() {
  renderCalendar(
    $('#l-cal-title'), $('#l-calendar'), lCal,
    (dateStr) => {
      const parts = new Set();
      lasers.forEach((l) => { if (l.datetime.slice(0, 10) === dateStr) parts.add(l.part); });
      return LASER_PARTS.filter((p) => parts.has(p)).map((p) => LASER_COLORS[p]);
    },
    lCalSelected,
    (dateStr) => {
      lCalSelected = lCalSelected === dateStr ? '' : dateStr;
      renderLaserCalendar();
    }
  );
  const detail = $('#l-cal-detail');
  detail.innerHTML = '';
  if (!lCalSelected) return;
  const recs = lasers
    .filter((l) => l.datetime.slice(0, 10) === lCalSelected)
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
  const head = document.createElement('div');
  head.className = 'date-group';
  head.textContent = `${fmtDate(lCalSelected)} の記録`;
  detail.appendChild(head);
  if (recs.length === 0) {
    detail.insertAdjacentHTML('beforeend', '<div class="empty">記録がありません</div>');
    return;
  }
  recs.forEach((l) => {
    detail.appendChild(recordItem(fmtDatetime(l.datetime), '', [l.part], () => {
      lasers = lasers.filter((x) => x.id !== l.id);
      markDeleted(l.id);
      store.save('lasers', lasers);
      renderLaser();
    }));
  });
}

function renderLaser() {
  renderLaserCalendar();
  const cards = $('#laser-cards');
  cards.innerHTML = '';
  const min = settings.laserMinDays;
  const max = settings.laserMaxDays;

  LASER_PARTS.forEach((part) => {
    const records = lasers.filter((l) => l.part === part).sort((a, b) => b.datetime.localeCompare(a.datetime));
    const card = document.createElement('div');
    card.className = 'laser-card';

    const info = document.createElement('div');
    info.className = 'laser-info';
    const title = document.createElement('div');
    title.className = 'laser-part';
    title.textContent = part;
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'laser-meta';
    const state = document.createElement('div');
    state.className = 'laser-state';

    if (records.length === 0) {
      meta.textContent = '記録なし';
      state.textContent = '最初の記録を追加しましょう';
    } else {
      const lastDate = records[0].datetime.slice(0, 10);
      const days = daysBetween(lastDate, today());
      meta.textContent = `前回: ${fmtDate(lastDate)}(${days}日前) / 次回目安: ${fmtDate(addDays(lastDate, min))}〜${fmtDate(addDays(lastDate, max))}`;
      if (days < min) {
        card.classList.add('state-ok');
        state.textContent = `✅ あと${min - days}日で目安期間`;
      } else if (days <= max) {
        card.classList.add('state-soon');
        state.textContent = '🔔 目安期間です(実施推奨)';
      } else {
        card.classList.add('state-over');
        state.textContent = `⚠️ 目安を${days - max}日超過`;
      }
    }
    info.appendChild(meta);
    info.appendChild(state);
    card.appendChild(info);

    const quick = document.createElement('button');
    quick.className = 'laser-quick';
    quick.textContent = '今日で記録';
    quick.addEventListener('click', () => {
      lasers.push({ id: uid(), datetime: toDatetimeLocal(new Date()), part });
      store.save('lasers', lasers);
      toast(`${part}を今日の日付で記録しました`);
      renderLaser();
    });
    card.appendChild(quick);
    cards.appendChild(card);
  });

  // 履歴
  const list = $('#laser-list');
  list.innerHTML = '';
  const sorted = [...lasers].sort((a, b) => b.datetime.localeCompare(a.datetime));
  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty">記録がありません</div>';
    return;
  }
  sorted.forEach((l) => {
    list.appendChild(recordItem(fmtDatetime(l.datetime), '', [l.part], () => {
      lasers = lasers.filter((x) => x.id !== l.id);
      markDeleted(l.id);
      store.save('lasers', lasers);
      renderLaser();
    }));
  });
}

/* ========== 食事 ========== */
$('#m-date').value = today();
$('#m-list-date').value = today();
buildChips($('#m-types'), MEAL_TYPES, true);

// 現在時刻から分類の初期値を推定
function defaultMealType(hour) {
  if (hour >= 4 && hour < 11) return '朝食';
  if (hour >= 11 && hour < 15) return '昼食';
  if (hour >= 17 && hour < 22) return '夕食';
  return '間食';
}
{
  const now = new Date();
  $('#m-time').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const def = defaultMealType(now.getHours());
  $('#m-types').querySelectorAll('.chip').forEach((c) => {
    if (c.dataset.part === def) c.classList.add('selected');
  });
}

$('#meal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const mealType = selectedChips($('#m-types'))[0];
  if (!mealType) { toast('分類を選択してください'); return; }
  meals.push({
    id: uid(),
    date: $('#m-date').value,
    time: $('#m-time').value || '',
    mealType,
    name: $('#m-name').value.trim(),
    protein: Number($('#m-protein').value),
  });
  store.save('meals', meals);
  $('#m-name').value = '';
  $('#m-protein').value = '';
  toast('食事を記録しました');
  renderMeal();
});

// 食品名を選ぶと前回のタンパク質量を自動補完
$('#m-name').addEventListener('change', () => {
  const name = $('#m-name').value.trim();
  if (!name || $('#m-protein').value) return;
  const past = [...meals].reverse().find((m) => m.name === name);
  if (past) $('#m-protein').value = past.protein;
});

$('#m-list-date').addEventListener('change', renderMeal);
$('#m-date').addEventListener('change', () => {
  $('#m-list-date').value = $('#m-date').value;
  renderMeal();
});

function mealTotals() {
  const totals = {};
  meals.forEach((m) => { totals[m.date] = (totals[m.date] || 0) + m.protein; });
  return totals;
}
function round1(n) { return Math.round(n * 10) / 10; }

function renderMeal() {
  const totals = mealTotals();
  const goalMin = settings.proteinGoalMin;
  const goalMax = settings.proteinGoalMax;
  const selDate = $('#m-list-date').value || today();
  const total = round1(totals[selDate] || 0);

  // ステータス
  const status = $('#meal-status');
  let diffText;
  if (total < goalMin) diffText = `目標まであと <b>${round1(goalMin - total)}g</b>`;
  else if (total <= goalMax) diffText = '🎯 目標達成!';
  else diffText = `目標上限を <b>${round1(total - goalMax)}g</b> 超過`;
  const pct = Math.min(100, (total / goalMin) * 100);
  status.innerHTML = `
    <div class="sub">${fmtDate(selDate)} の合計タンパク質</div>
    <div class="big">${total}g <span style="font-size:0.9rem;color:var(--text-sub)">/ ${goalMin}〜${goalMax}g</span></div>
    <div class="sub">${diffText}</div>
    <div class="progress"><div class="${total > goalMax ? 'over' : ''}" style="width:${pct}%"></div></div>
  `;

  // 食品サジェスト(頻度順、名前ありの記録のみ)
  const freq = {};
  meals.forEach((m) => { if (m.name) freq[m.name] = (freq[m.name] || 0) + 1; });
  const names = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  $('#m-name-list').innerHTML = names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');

  // よく使う食品のクイック追加チップ(上位6件)
  const quick = $('#m-quick-foods');
  quick.innerHTML = '';
  names.slice(0, 6).forEach((n) => {
    const past = [...meals].reverse().find((m) => m.name === n);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quick-food';
    b.textContent = `${n} ${past.protein}g`;
    b.addEventListener('click', () => {
      $('#m-name').value = n;
      $('#m-protein').value = past.protein;
    });
    quick.appendChild(b);
  });

  // 直近30日グラフ
  const chart = $('#meal-chart');
  chart.innerHTML = '';
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(addDays(today(), -i));
  const maxVal = Math.max(goalMax * 1.15, ...days.map((d) => totals[d] || 0));

  const goalLine = document.createElement('div');
  goalLine.className = 'goal-line';
  goalLine.style.bottom = `${(goalMin / maxVal) * 100}%`;
  const goalLabel = document.createElement('span');
  goalLabel.className = 'goal-label';
  goalLabel.textContent = `${goalMin}g`;
  goalLine.appendChild(goalLabel);
  chart.appendChild(goalLine);

  days.forEach((d, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';
    const v = totals[d] || 0;
    const bar = document.createElement('div');
    bar.className = 'bar' + (v >= goalMin ? ' goal-met' : '');
    bar.style.height = `${(v / maxVal) * 100}%`;
    bar.title = `${fmtDate(d)}: ${round1(v)}g`;
    wrap.appendChild(bar);
    if (i % 7 === 5 || i === 29) {
      const label = document.createElement('div');
      label.className = 'bar-label';
      label.textContent = d.slice(5).replace('-', '/');
      wrap.appendChild(label);
    }
    chart.appendChild(wrap);
  });

  // 選択日の一覧(分類ごとにグループ化・小計付き)
  const list = $('#meal-list');
  list.innerHTML = '';
  const dayMeals = meals.filter((m) => m.date === selDate);
  if (dayMeals.length === 0) {
    list.innerHTML = '<div class="empty">この日の記録がありません</div>';
    return;
  }
  [...MEAL_TYPES, 'その他'].forEach((type) => {
    const group = dayMeals
      .filter((m) => (m.mealType || 'その他') === type)
      .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    if (group.length === 0) return;
    const subtotal = round1(group.reduce((sum, m) => sum + m.protein, 0));
    const g = document.createElement('div');
    g.className = 'date-group';
    g.textContent = `${type}  ${subtotal}g`;
    list.appendChild(g);
    group.forEach((m) => {
      const title = m.name || `${m.protein}g`;
      const detail = m.name ? [m.time, `${m.protein}g`].filter(Boolean).join(' / ') : (m.time || '');
      list.appendChild(recordItem(title, detail, [], () => {
        meals = meals.filter((x) => x.id !== m.id);
        markDeleted(m.id);
        store.save('meals', meals);
        renderMeal();
      }));
    });
  });
}

/* ========== プライベート記録 ========== */
$('#p-datetime').value = toDatetimeLocal(new Date());

const pCal = { y: nowDate.getFullYear(), m: nowDate.getMonth() };
let pCalSelected = '';
$('#p-cal-prev').addEventListener('click', () => shiftMonth(pCal, -1, renderPrivateCalendar));
$('#p-cal-next').addEventListener('click', () => shiftMonth(pCal, 1, renderPrivateCalendar));

$('#p-quick').addEventListener('click', () => {
  privates.push({ id: uid(), datetime: toDatetimeLocal(new Date()) });
  store.save('privates', privates);
  toast('記録しました');
  renderPrivate();
});

$('#private-form').addEventListener('submit', (e) => {
  e.preventDefault();
  privates.push({ id: uid(), datetime: $('#p-datetime').value });
  store.save('privates', privates);
  toast('記録しました');
  renderPrivate();
});

function renderPrivateCalendar() {
  renderCalendar(
    $('#p-cal-title'), $('#p-calendar'), pCal,
    (dateStr) => privates.some((p) => p.datetime.slice(0, 10) === dateStr) ? ['var(--accent)'] : [],
    pCalSelected,
    (dateStr) => {
      pCalSelected = pCalSelected === dateStr ? '' : dateStr;
      renderPrivateCalendar();
    }
  );
  const detail = $('#p-cal-detail');
  detail.innerHTML = '';
  if (!pCalSelected) return;
  const recs = privates
    .filter((p) => p.datetime.slice(0, 10) === pCalSelected)
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
  const head = document.createElement('div');
  head.className = 'date-group';
  head.textContent = `${fmtDate(pCalSelected)} の記録`;
  detail.appendChild(head);
  if (recs.length === 0) {
    detail.insertAdjacentHTML('beforeend', '<div class="empty">記録がありません</div>');
    return;
  }
  recs.forEach((p) => {
    detail.appendChild(recordItem(fmtDatetime(p.datetime), '', [], () => {
      privates = privates.filter((x) => x.id !== p.id);
      markDeleted(p.id);
      store.save('privates', privates);
      renderPrivate();
    }));
  });
}

function renderPrivate() {
  renderPrivateCalendar();
  const status = $('#private-status');
  if (privates.length === 0) {
    status.innerHTML = '<div class="big">記録なし</div>';
  } else {
    const lastDate = privates.map((p) => p.datetime.slice(0, 10)).sort().at(-1);
    const days = daysBetween(lastDate, today());
    const label = days === 0 ? '今日記録済み' : `前回から ${days}日経過`;
    status.innerHTML = `<div class="big">${label}</div><div class="sub">前回: ${fmtDate(lastDate)}</div>`;
  }
  const list = $('#private-list');
  list.innerHTML = '';
  const sorted = [...privates].sort((a, b) => b.datetime.localeCompare(a.datetime));
  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty">記録がありません</div>';
    return;
  }
  sorted.forEach((p) => {
    list.appendChild(recordItem(fmtDatetime(p.datetime), '', [], () => {
      privates = privates.filter((x) => x.id !== p.id);
      markDeleted(p.id);
      store.save('privates', privates);
      renderPrivate();
    }));
  });
}

// タブの表示/非表示(この端末のみ・同期されない)
function applyPrivateVisibility() {
  $('#nav-private').hidden = !settings.showPrivate;
  if (!settings.showPrivate && $('#tab-private').classList.contains('active')) {
    document.querySelector('.nav-btn[data-tab="workout"]').click();
  }
}
$('#s-show-private').addEventListener('change', (e) => {
  settings.showPrivate = e.target.checked;
  store.save('settings', settings);
  applyPrivateVisibility();
});

/* ========== 自動バックアップ(GitHub Gist) ========== */
const BACKUP_FILENAME = 'lifelog-backup.json';
let backupTimer = null;

function backupData() {
  // トークン等の秘匿情報はバックアップに含めない
  return {
    workouts, lasers, meals, privates, tombstones,
    settingsUpdatedAt: settings.settingsUpdatedAt || '',
    settings: {
      proteinGoalMin: settings.proteinGoalMin,
      proteinGoalMax: settings.proteinGoalMax,
      laserMinDays: settings.laserMinDays,
      laserMaxDays: settings.laserMaxDays,
    },
  };
}

// 並び順の違いに影響されない比較用文字列(同期の要否判定に使用)
function canonical(data) {
  const byId = (a, b) => a.id.localeCompare(b.id);
  return JSON.stringify({
    w: [...(data.workouts || [])].sort(byId),
    l: [...(data.lasers || [])].sort(byId),
    m: [...(data.meals || [])].sort(byId),
    p: [...(data.privates || [])].sort(byId),
    t: Object.keys(data.tombstones || {}).sort(),
    s: data.settings || null,
    su: data.settingsUpdatedAt || '',
  });
}

function markDeleted(id) {
  tombstones[id] = new Date().toISOString();
  store.save('tombstones', tombstones);
}

// リモートのバックアップを取り込み、記録ID単位で統合する
function applyMerge(remote) {
  const before = canonical(backupData());
  const allTomb = Object.assign({}, remote.tombstones || {}, tombstones);
  const cutoff = addDays(today(), -180); // 半年前の削除履歴は破棄
  Object.keys(allTomb).forEach((id) => {
    if ((allTomb[id] || '').slice(0, 10) < cutoff) delete allTomb[id];
  });
  const mergeRecords = (local, remoteList) => {
    const m = new Map();
    (remoteList || []).forEach((r) => { if (r && r.id) m.set(r.id, r); });
    local.forEach((r) => m.set(r.id, r));
    return [...m.values()].filter((r) => !allTomb[r.id]);
  };
  workouts = mergeRecords(workouts, remote.workouts);
  lasers = mergeRecords(lasers, remote.lasers);
  meals = mergeRecords(meals, remote.meals);
  privates = mergeRecords(privates, remote.privates);
  tombstones = allTomb;
  if (remote.settings && (remote.settingsUpdatedAt || '') > (settings.settingsUpdatedAt || '')) {
    Object.assign(settings, remote.settings);
    settings.settingsUpdatedAt = remote.settingsUpdatedAt;
  }
  if (canonical(backupData()) !== before) {
    syncing = true;
    store.save('workouts', workouts);
    store.save('lasers', lasers);
    store.save('meals', meals);
    store.save('privates', privates);
    store.save('tombstones', tombstones);
    store.save('settings', settings);
    syncing = false;
    renderAll();
    return true;
  }
  return false;
}

function gistHeaders() {
  return { Authorization: 'token ' + settings.gistToken, Accept: 'application/vnd.github+json' };
}

async function findBackupGist() {
  const res = await fetch('https://api.github.com/gists?per_page=100', { headers: gistHeaders() });
  if (!res.ok) return '';
  const list = await res.json();
  const hit = list.find((g) => g.files && g.files[BACKUP_FILENAME]);
  return hit ? hit.id : '';
}

// 同期: リモートを取得→統合→差分があればアップロード
async function runBackup(manual) {
  if (!settings.gistToken) {
    if (manual) toast('先にトークンを設定してください');
    return;
  }
  try {
    if (!settings.gistId) settings.gistId = await findBackupGist();

    // 1. リモート取得と統合
    let remoteCanon = null;
    if (settings.gistId) {
      const res = await fetch('https://api.github.com/gists/' + settings.gistId, { headers: gistHeaders() });
      if (res.status === 404) {
        settings.gistId = '';
      } else if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      } else {
        const gist = await res.json();
        const file = gist.files[BACKUP_FILENAME];
        if (file) {
          const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
          try {
            const remote = JSON.parse(text);
            applyMerge(remote);
            remoteCanon = canonical(remote);
          } catch { /* 壊れたバックアップは無視して上書き */ }
        }
      }
    }

    // 2. 統合後のデータがリモートと異なればアップロード
    const data = backupData();
    if (canonical(data) !== remoteCanon) {
      const content = JSON.stringify(Object.assign({ version: 2, exportedAt: new Date().toISOString() }, data), null, 2);
      const payload = JSON.stringify({
        description: 'ライフログ自動バックアップ',
        public: false,
        files: { [BACKUP_FILENAME]: { content } },
      });
      let res = null;
      if (settings.gistId) {
        res = await fetch('https://api.github.com/gists/' + settings.gistId, { method: 'PATCH', headers: gistHeaders(), body: payload });
        if (res.status === 404) { settings.gistId = ''; res = null; }
      }
      if (!res) {
        res = await fetch('https://api.github.com/gists', { method: 'POST', headers: gistHeaders(), body: payload });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      settings.gistId = (await res.json()).id;
    }

    settings.lastBackupAt = new Date().toISOString();
    store.save('settings', settings);
    renderBackupStatus();
    if (manual) toast('同期しました');
  } catch (err) {
    // オフライン時などは静かに諦め、次回の記録時・起動時に再試行される
    if (manual) toast('同期失敗: ' + err.message);
    renderBackupStatus(err.message);
  }
}

function scheduleBackup() {
  if (!settings.gistToken) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => runBackup(false), 3000);
}

function renderBackupStatus(error) {
  const el = $('#s-backup-status');
  if (!settings.gistToken) {
    el.textContent = '未設定: 下にトークンを入れて「有効化」を押してください';
    return;
  }
  let text = '✅ 有効';
  if (settings.lastBackupAt) text += ` / 最終同期: ${fmtDatetime(settings.lastBackupAt)}`;
  if (error) text += ` / ⚠️ ${error}`;
  el.textContent = text;
}

$('#s-backup-save').addEventListener('click', () => {
  const token = $('#s-gist-token').value.trim();
  if (!token) { toast('トークンを入力してください'); return; }
  settings.gistToken = token;
  settings.gistId = '';
  store.save('settings', settings);
  $('#s-gist-token').value = '';
  renderBackupStatus();
  runBackup(true);
});

$('#s-backup-now').addEventListener('click', () => runBackup(true));

$('#s-backup-off').addEventListener('click', () => {
  if (!settings.gistToken) { toast('自動バックアップは未設定です'); return; }
  if (!confirm('自動バックアップ・同期を解除しますか?(GitHub上のバックアップ自体は残ります)')) return;
  settings.gistToken = '';
  settings.gistId = '';
  settings.lastBackupAt = '';
  store.save('settings', settings);
  renderBackupStatus();
  toast('解除しました');
});

/* ========== 設定 ========== */
function renderSettings() {
  $('#s-goal-min').value = settings.proteinGoalMin;
  $('#s-goal-max').value = settings.proteinGoalMax;
  $('#s-laser-min').value = settings.laserMinDays;
  $('#s-laser-max').value = settings.laserMaxDays;
  $('#s-data-summary').textContent =
    `保存件数: 筋トレ ${workouts.length}件 / 脱毛 ${lasers.length}件 / 食事 ${meals.length}件`;
  $('#s-show-private').checked = !!settings.showPrivate;
  renderBackupStatus();
}

$('#s-save-goal').addEventListener('click', () => {
  const min = Number($('#s-goal-min').value);
  const max = Number($('#s-goal-max').value);
  if (!min || !max || min > max) { toast('目標値を確認してください'); return; }
  settings.proteinGoalMin = min;
  settings.proteinGoalMax = max;
  settings.settingsUpdatedAt = new Date().toISOString();
  store.save('settings', settings);
  scheduleBackup();
  toast('目標を保存しました');
  renderMeal();
});

$('#s-save-laser').addEventListener('click', () => {
  const min = Number($('#s-laser-min').value);
  const max = Number($('#s-laser-max').value);
  if (!min || !max || min > max) { toast('日数を確認してください'); return; }
  settings.laserMinDays = min;
  settings.laserMaxDays = max;
  settings.settingsUpdatedAt = new Date().toISOString();
  store.save('settings', settings);
  scheduleBackup();
  toast('サイクルを保存しました');
  renderLaser();
});

$('#s-export').addEventListener('click', () => {
  const data = Object.assign({ version: 1, exportedAt: new Date().toISOString() }, backupData());
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lifelog-backup-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('エクスポートしました');
});

$('#s-import').addEventListener('click', () => $('#s-import-file').click());
$('#s-import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.workouts) || !Array.isArray(data.lasers) || !Array.isArray(data.meals)) {
        throw new Error('invalid format');
      }
      if (!confirm(`現在のデータを上書きします。\n筋トレ ${data.workouts.length}件 / 脱毛 ${data.lasers.length}件 / 食事 ${data.meals.length}件\nよろしいですか?`)) return;
      workouts = data.workouts;
      lasers = data.lasers;
      meals = data.meals;
      privates = data.privates || [];
      tombstones = data.tombstones || {};
      if (data.settings) {
        settings = Object.assign(settings, data.settings);
        settings.settingsUpdatedAt = new Date().toISOString();
      }
      store.save('tombstones', tombstones);
      store.save('privates', privates);
      store.save('workouts', workouts);
      store.save('lasers', lasers);
      store.save('meals', meals);
      store.save('settings', settings);
      renderAll();
      toast('インポートしました');
    } catch {
      toast('ファイルの形式が正しくありません');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

/* ========== 初期化 ========== */
function renderAll() {
  renderWorkout();
  renderLaser();
  renderMeal();
  renderPrivate();
  renderSettings();
}
renderAll();
applyPrivateVisibility();
scheduleBackup(); // 起動時に他端末の記録と同期(オフライン中の変更の追いつきも兼ねる)

// PWAがバックグラウンドから復帰したときも同期
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleBackup();
});

// Service Worker 登録
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン非対応環境では無視 */ });
  });
}
