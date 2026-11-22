/**
 * 家庭行事曆與生活相簿前端主程式（全修正整合版）
 * 請將以下兩組設定替換為你自己的 LIFF ID 與 GAS 部署網址 (/exec)
 */
const CONFIG = {
  LIFF_ID: '2012740107-BWMenJbV',
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycbwuKl5ZZD5OlEM9oND5WEtFKOudhO8cTqJkegxjKfm0_uQ0J3kkGI8qIWtcGpePTk0rsg/exec',
  PAGE_SIZE: 20,
};

// 高對比自動標籤調色盤（同標籤透過雜湊永遠固定對應同一色碼）
const TAG_COLOR_PALETTE = [
  '#2563eb', '#059669', '#d97706', '#7c3aed',
  '#dc2626', '#0891b2', '#db2777', '#4f46e5',
  '#65a30d', '#ea580c', '#9333ea', '#0d9488',
  '#e11d48', '#0284c7', '#ca8a04', '#475569',
];

const RELOGIN_COOLDOWN_KEY = 'family_hub_relogin_ts';

// ============================================================================
// 應用程式狀態
// ============================================================================
const nowDate = new Date();
const state = {
  idToken: '',
  user: null,
  usersMap: {},
  currentTab: 'calendar',
  isReloggingIn: false,

  // 行事曆狀態
  viewYear: nowDate.getFullYear(),
  viewMonth: nowDate.getMonth() + 1,
  selectedDate: toDateStr(nowDate),
  selectedTagFilter: '',
  existingTags: [],      // 整份試算表目前已存在的標籤清單
  modalSelectedTags: [], // 行程編輯彈窗中已勾選的多選標籤（依順序，第 1 個決定月曆底色）
  monthEvents: [],
  photoDates: new Set(),
  dayThumbnails: {},

  // 相簿狀態
  albumPosts: [],
  albumPage: 1,
  albumHasMore: false,
  albumLoadedOnce: false,
  albumFilter: null,
  albumKeyword: '',
  albumAuthorId: '',
  albumTotal: 0,
  albumReqSeq: 0,

  // 編輯與燈箱暫存
  editingPost: null,
  lightboxOriginalUrl: '',
  confirmResolver: null,
};

// ============================================================================
// 初始化、LIFF 登入與 PC 過期憑證自動重登機制
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  initApp();
});

async function initApp() {
  showScreen('loading', '正在連線 LINE 驗證身分...');
  try {
    await liff.init({ liffId: CONFIG.LIFF_ID });

    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: window.location.href });
      return;
    }

    state.idToken = liff.getIDToken();
    if (!state.idToken) {
      throw new Error('無法取得 LINE ID Token，請確認 LIFF Scopes 已勾選 openid。');
    }

    // 啟動時即檢查 id_token 是否已過期（PC 久置重開常見情境）
    if (isIdTokenExpired(state.idToken)) {
      const triggered = triggerRelogin(false);
      if (triggered) return;
      throw new Error('LINE 登入憑證已過期，請點擊下方「重新登入 LINE」。');
    }

    await verifyMemberAndBoot();
  } catch (err) {
    console.error(err);
    showScreen('error', err.message || 'LIFF 初始化失敗，請點擊「重新登入 LINE」。');
  }
}

async function verifyMemberAndBoot() {
  showScreen('loading', '正在確認親友存取權限...');
  const res = await apiCall('getMe', {});

  if (!res.ok) {
    if (res.code === 'UNAUTHORIZED') {
      if (triggerRelogin(false)) return;
      throw new Error('LINE 登入憑證已過期或無效，請點擊下方「重新登入 LINE」。');
    }
    if (res.code === 'PENDING_APPROVAL') {
      const u = (res.data && res.data.user) || {};
      document.getElementById('pending-name').textContent = u.display_name || '新成員';
      const avatar = document.getElementById('pending-avatar');
      if (u.avatar_url) {
        avatar.src = u.avatar_url;
        avatar.classList.remove('hidden');
      }
      showScreen('pending');
      return;
    }
    throw new Error(res.message || '驗證失敗');
  }

  // 成功登入後清除重登冷卻紀錄
  try { sessionStorage.removeItem(RELOGIN_COOLDOWN_KEY); } catch (_) {}

  state.user = res.data.user;
  state.usersMap = res.data.usersMap || {};
  renderHeaderProfile();
  renderAlbumMemberFilter();
  showScreen('app');

  const params = new URLSearchParams(window.location.search);
  const initTab = params.get('tab') === 'album' ? 'album' : 'calendar';
  const editPostId = params.get('editPost');

  await switchTab(initTab);

  if (editPostId) {
    await openAlbumEditById(editPostId);
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
  }
}

/**
 * 解析 JWT payload 檢查 id_token 是否已過期（提前 60 秒視為過期）
 */
function isIdTokenExpired(token) {
  if (!token) return true;
  try {
    let exp = 0;
    if (typeof liff !== 'undefined' && typeof liff.getDecodedIDToken === 'function') {
      const decoded = liff.getDecodedIDToken();
      if (decoded && decoded.exp) exp = Number(decoded.exp);
    }
    if (!exp) {
      const parts = token.split('.');
      if (parts.length !== 3) return true;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const payload = JSON.parse(atob(padded));
      exp = Number(payload.exp || 0);
    }
    if (!exp) return false;
    return (Date.now() / 1000) >= (exp - 60);
  } catch (e) {
    return false;
  }
}

/**
 * 清除舊憑證並重新導向 LINE 登入（manual=true 時忽略冷卻保護）
 */
function triggerRelogin(manual = false) {
  if (state.isReloggingIn) return true;

  if (!manual) {
    try {
      const lastTs = Number(sessionStorage.getItem(RELOGIN_COOLDOWN_KEY) || '0');
      // 15 秒內若已自動重登過仍失敗，停止自動跳轉避免無限迴圈，改由使用者手動點擊
      if (lastTs && Date.now() - lastTs < 15000) {
        return false;
      }
      sessionStorage.setItem(RELOGIN_COOLDOWN_KEY, String(Date.now()));
    } catch (_) {}
  }

  state.isReloggingIn = true;
  showScreen('loading', 'LINE 登入憑證已過期，正在為你重新登入...');

  try {
    if (typeof liff !== 'undefined') {
      if (!liff.isInClient()) {
        if (liff.isLoggedIn()) {
          liff.logout();
        }
        liff.login({ redirectUri: window.location.href });
        return true;
      }
      // 手機 LINE App 內建瀏覽器直接重載即可向 LINE Client 取新 Token
      window.location.reload();
      return true;
    }
  } catch (err) {
    console.error('重登失敗:', err);
  }

  state.isReloggingIn = false;
  return false;
}

// ============================================================================
// API 呼叫（自動攔截過期憑證）
// ============================================================================
async function apiCall(action, payload = {}) {
  if (isIdTokenExpired(state.idToken)) {
    if (triggerRelogin(false)) {
      return { ok: false, code: 'UNAUTHORIZED', message: '正在重新登入 LINE...' };
    }
  }

  const response = await fetch(CONFIG.GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action,
      idToken: state.idToken,
      payload,
    }),
  });

  if (!response.ok) {
    throw new Error('伺服器回應異常（HTTP ' + response.status + '）');
  }

  const data = await response.json();
  if (!data.ok && data.code === 'UNAUTHORIZED') {
    if (!triggerRelogin(false)) {
      showScreen('error', 'LINE 登入憑證已過期或無效，請點擊下方「重新登入 LINE」。');
    }
  }
  return data;
}

// ============================================================================
// 分頁切換與畫面顯示
// ============================================================================
function showScreen(name, message) {
  document.getElementById('screen-loading').classList.toggle('hidden', name !== 'loading');
  document.getElementById('screen-pending').classList.toggle('hidden', name !== 'pending');
  document.getElementById('screen-error').classList.toggle('hidden', name !== 'error');
  document.getElementById('app-shell').classList.toggle('hidden', name !== 'app');

  if (name === 'loading' && message) {
    document.getElementById('loading-text').textContent = message;
  }
  if (name === 'error' && message) {
    document.getElementById('error-desc').textContent = message;
  }
}

function renderHeaderProfile() {
  document.getElementById('my-name').textContent = state.user.display_name || '成員';
  const img = document.getElementById('my-avatar');
  const fallback = document.getElementById('my-avatar-fallback');
  if (state.user.avatar_url) {
    img.src = state.user.avatar_url;
    img.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    fallback.classList.remove('hidden');
  }
}

async function switchTab(tab) {
  state.currentTab = tab;
  document.getElementById('view-calendar').classList.toggle('hidden', tab !== 'calendar');
  document.getElementById('view-album').classList.toggle('hidden', tab !== 'album');

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const headerIcon = document.getElementById('header-icon');
  const headerText = document.getElementById('header-text');
  if (tab === 'calendar') {
    headerIcon.className = 'fa-regular fa-calendar-days';
    headerText.textContent = '家庭行事曆';
    await loadCalendarMonth(state.viewYear, state.viewMonth);
  } else {
    headerIcon.className = 'fa-regular fa-images';
    headerText.textContent = '生活相簿';
    if (!state.albumLoadedOnce) {
      await loadAlbumPosts(1, false);
    }
  }
}

// ============================================================================
// 分頁 1：行事曆邏輯與多標籤篩選
// ============================================================================
async function loadCalendarMonth(year, month) {
  state.viewYear = year;
  state.viewMonth = month;
  document.getElementById('cal-month-label').textContent = `${year} 年 ${month} 月`;

  try {
    const res = await apiCall('getMonthEvents', { year, month });
    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '載入行程失敗', 'error');
      return;
    }

    state.monthEvents = (res.data.events || []).map((ev) => ({
      ...ev,
      tags: parseTags(ev.tags !== undefined ? ev.tags : ev.tag),
    }));
    state.existingTags = parseTags(res.data.allTags || []);
    state.photoDates = new Set(res.data.photoDates || []);
    state.dayThumbnails = res.data.dayThumbnails || {};

    renderCalendarTagFilter();
    renderCalendarGrid();
    renderSelectedDayPanel();
  } catch (err) {
    showToast('無法連線取得行程資料', 'error');
  }
}

function renderCalendarTagFilter() {
  const bar = document.getElementById('cal-tag-filter');
  if (!bar) return;
  bar.innerHTML = '';

  const counts = {};
  const monthTagOrder = [];
  state.monthEvents.forEach((ev) => {
    parseTags(ev.tags !== undefined ? ev.tags : ev.tag).forEach((t) => {
      if (!counts[t]) monthTagOrder.push(t);
      counts[t] = (counts[t] || 0) + 1;
    });
  });

  // 確保切換月份後若目前仍有篩選中的標籤，仍保留於篩選列方便解除
  if (state.selectedTagFilter && !counts[state.selectedTagFilter]) {
    monthTagOrder.push(state.selectedTagFilter);
  }

  // 若本月無標籤但全表已有標籤，顯示全表標籤方便快速查看
  const displayTags = monthTagOrder.length > 0 ? monthTagOrder : state.existingTags;

  bar.appendChild(
    createFilterChip('', '全部', '#1e293b', state.monthEvents.length, state.selectedTagFilter === '')
  );

  displayTags.forEach((tagName) => {
    const isActive = state.selectedTagFilter === tagName;
    const count = counts[tagName] || 0;
    bar.appendChild(
      createFilterChip(tagName, tagName, getTagColor(tagName), count, isActive)
    );
  });
}

function createFilterChip(value, label, color, count, isActive) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'filter-chip' + (isActive ? ' active' : '');
  if (isActive) {
    btn.style.backgroundColor = color;
  } else if (value) {
    btn.style.borderColor = color;
    btn.style.color = color;
  }

  if (value) {
    const dot = document.createElement('span');
    dot.className = 'filter-dot';
    dot.style.backgroundColor = color;
    btn.appendChild(dot);
  }

  const text = document.createElement('span');
  text.textContent = label;
  btn.appendChild(text);

  if (count > 0 || value === '') {
    const num = document.createElement('span');
    num.className = 'filter-count';
    num.textContent = `(${count})`;
    btn.appendChild(num);
  }

  btn.addEventListener('click', () => {
    state.selectedTagFilter = (state.selectedTagFilter === value) ? '' : value;
    renderCalendarTagFilter();
    renderCalendarGrid();
    renderSelectedDayPanel();
  });

  return btn;
}

function renderCalendarGrid() {
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  const firstDay = new Date(state.viewYear, state.viewMonth - 1, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(state.viewYear, state.viewMonth, 0).getDate();
  const prevMonthDays = new Date(state.viewYear, state.viewMonth - 1, 0).getDate();
  const todayStr = toDateStr(new Date());

  const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    let cellDate;
    let isOtherMonth = false;

    if (i < startWeekday) {
      const day = prevMonthDays - startWeekday + i + 1;
      cellDate = new Date(state.viewYear, state.viewMonth - 2, day);
      isOtherMonth = true;
    } else if (i >= startWeekday + daysInMonth) {
      const day = i - (startWeekday + daysInMonth) + 1;
      cellDate = new Date(state.viewYear, state.viewMonth, day);
      isOtherMonth = true;
    } else {
      const day = i - startWeekday + 1;
      cellDate = new Date(state.viewYear, state.viewMonth - 1, day);
    }

    const dateStr = toDateStr(cellDate);
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (isOtherMonth) cell.classList.add('other-month');
    if (dateStr === todayStr) cell.classList.add('today');
    if (dateStr === state.selectedDate) cell.classList.add('selected');

    const topRow = document.createElement('div');
    topRow.className = 'cal-cell-top';

    const dayNum = document.createElement('span');
    dayNum.className = 'cal-day-num';
    dayNum.textContent = String(cellDate.getDate());
    topRow.appendChild(dayNum);

    if (state.photoDates.has(dateStr)) {
      const cam = document.createElement('i');
      cam.className = 'fa-solid fa-camera cal-camera-badge';
      cam.title = '當天有生活相簿';
      topRow.appendChild(cam);
    }
    cell.appendChild(topRow);

    // 單日所有行程項目全部顯示（底色取第一個標籤顏色，文字優先標題、無標題顯示標籤）
    const dayEvents = getEventsForDate(dateStr);
    if (dayEvents.length > 0) {
      const bars = document.createElement('div');
      bars.className = 'cal-bars';
      dayEvents.forEach((ev) => {
        const bar = document.createElement('div');
        bar.className = 'cal-bar';
        bar.style.backgroundColor = getEventPrimaryColor(ev);
        bar.textContent = getEventDisplayLabel(ev);
        bar.title = getEventDisplayLabel(ev);
        bars.appendChild(bar);
      });
      cell.appendChild(bars);
    }

    cell.addEventListener('click', () => {
      state.selectedDate = dateStr;
      if (isOtherMonth) {
        loadCalendarMonth(cellDate.getFullYear(), cellDate.getMonth() + 1);
      } else {
        renderCalendarGrid();
        renderSelectedDayPanel();
      }
    });

    grid.appendChild(cell);
  }
}

function getEventsForDate(dateStr) {
  return state.monthEvents.filter((ev) => {
    const end = ev.end_date || ev.start_date;
    const inDate = ev.start_date <= dateStr && end >= dateStr;
    if (!inDate) return false;
    if (state.selectedTagFilter) {
      const tags = parseTags(ev.tags !== undefined ? ev.tags : ev.tag);
      return tags.includes(state.selectedTagFilter);
    }
    return true;
  });
}

function renderSelectedDayPanel() {
  const dateStr = state.selectedDate;
  document.getElementById('selected-date-label').textContent = dateStr;
  document.getElementById('selected-date-sub').textContent = getWeekdayLabel(dateStr);

  const listEl = document.getElementById('day-events-list');
  listEl.innerHTML = '';

  const dayEvents = getEventsForDate(dateStr);
  if (dayEvents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    if (state.selectedTagFilter) {
      empty.textContent = `這天沒有「${state.selectedTagFilter}」相關行程`;
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'link-btn';
      clearBtn.style.marginLeft = '6px';
      clearBtn.textContent = '顯示全部';
      clearBtn.addEventListener('click', () => {
        state.selectedTagFilter = '';
        renderCalendarTagFilter();
        renderCalendarGrid();
        renderSelectedDayPanel();
      });
      empty.appendChild(clearBtn);
    } else {
      empty.textContent = '這天還沒有安排行程';
    }
    listEl.appendChild(empty);
  } else {
    dayEvents.forEach((ev) => {
      const tags = parseTags(ev.tags !== undefined ? ev.tags : ev.tag);
      const primaryColor = getEventPrimaryColor(ev);
      const card = document.createElement('div');
      card.className = 'event-card';
      card.style.borderLeftColor = primaryColor;

      const top = document.createElement('div');
      top.className = 'event-card-top';

      const badges = document.createElement('div');
      badges.className = 'event-badges';

      tags.forEach((t) => {
        const tagBadge = document.createElement('span');
        tagBadge.className = 'tag-badge';
        tagBadge.style.backgroundColor = getTagColor(t);
        tagBadge.textContent = t;
        badges.appendChild(tagBadge);
      });

      const timeBadge = document.createElement('span');
      timeBadge.className = 'time-badge';
      const rangeText = ev.end_date && ev.end_date !== ev.start_date
        ? `${ev.start_date.slice(5)} 至 ${ev.end_date.slice(5)}`
        : (ev.start_time ? ev.start_time : '全天');
      timeBadge.textContent = rangeText;
      badges.appendChild(timeBadge);

      const editIcon = document.createElement('i');
      editIcon.className = 'fa-regular fa-pen-to-square muted';
      top.appendChild(badges);
      top.appendChild(editIcon);
      card.appendChild(top);

      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = getEventDisplayLabel(ev);
      card.appendChild(title);

      if (ev.content) {
        const content = document.createElement('p');
        content.className = 'event-content';
        content.textContent = ev.content;
        card.appendChild(content);
      }

      if (ev.linked_media_count > 0) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'event-linked-pill';
        pill.innerHTML = '<i class="fa-regular fa-images"></i>';
        const span = document.createElement('span');
        span.textContent = `關聯相簿（${ev.linked_media_count} 則媒體）`;
        pill.appendChild(span);
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          jumpToAlbumFilter({
            type: 'event',
            value: ev.event_id,
            label: `行程相簿：${getEventDisplayLabel(ev)}`,
          });
        });
        card.appendChild(pill);
      }

      card.addEventListener('click', () => openEventModal(ev));
      listEl.appendChild(card);
    });
  }

  // 當日生活相簿縮圖條
  const photosBox = document.getElementById('day-photos-section');
  const strip = document.getElementById('day-thumbs-strip');
  const thumbs = state.dayThumbnails[dateStr] || [];
  strip.innerHTML = '';

  if (thumbs.length === 0) {
    photosBox.classList.add('hidden');
  } else {
    photosBox.classList.remove('hidden');
    thumbs.forEach((m) => {
      const item = document.createElement('div');
      item.className = 'strip-item';
      appendMediaThumbElement(item, m, dateStr);
      strip.appendChild(item);
    });
  }
}

// ============================================================================
// 行程新增 / 編輯 / 刪除彈窗（多選既有標籤＋新增標籤）
// ============================================================================
function renderModalTagUI() {
  const selectedWrap = document.getElementById('ev-selected-tags');
  const chipsWrap = document.getElementById('ev-tag-chips');
  if (!selectedWrap || !chipsWrap) return;

  // 1. 已選擇的標籤區（第 1 個決定月曆底色，點 X 可移除）
  selectedWrap.innerHTML = '';
  if (state.modalSelectedTags.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'selected-tags-empty';
    empty.textContent = '尚未選擇標籤（可點下方既有標籤快選，或輸入新標籤）';
    selectedWrap.appendChild(empty);
  } else {
    state.modalSelectedTags.forEach((tag, idx) => {
      const pill = document.createElement('span');
      pill.className = 'selected-tag-pill';
      pill.style.backgroundColor = getTagColor(tag);

      const text = document.createElement('span');
      text.textContent = tag;
      pill.appendChild(text);

      if (idx === 0) {
        const mark = document.createElement('span');
        mark.className = 'selected-tag-primary-mark';
        mark.textContent = '底色';
        pill.appendChild(mark);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'selected-tag-remove';
      removeBtn.setAttribute('aria-label', `移除標籤 ${tag}`);
      removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      removeBtn.addEventListener('click', () => {
        state.modalSelectedTags = state.modalSelectedTags.filter((t) => t !== tag);
        renderModalTagUI();
      });
      pill.appendChild(removeBtn);

      selectedWrap.appendChild(pill);
    });
  }

  // 2. 既有標籤快選區（整份試算表既有標籤 + 本次編輯新增的標籤）
  chipsWrap.innerHTML = '';
  const allChoices = parseTags([...state.existingTags, ...state.modalSelectedTags]);

  allChoices.forEach((tag) => {
    const color = getTagColor(tag);
    const isSelected = state.modalSelectedTags.includes(tag);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-chip' + (isSelected ? ' active' : '');
    if (isSelected) {
      btn.style.backgroundColor = color;
    } else {
      btn.style.borderColor = color;
      btn.style.color = color;
    }

    if (isSelected) {
      const check = document.createElement('i');
      check.className = 'fa-solid fa-check fa-2xs';
      btn.appendChild(check);
    } else {
      const dot = document.createElement('span');
      dot.className = 'tag-chip-dot';
      dot.style.backgroundColor = color;
      btn.appendChild(dot);
    }

    const label = document.createElement('span');
    label.textContent = tag;
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      if (isSelected) {
        state.modalSelectedTags = state.modalSelectedTags.filter((t) => t !== tag);
      } else {
        state.modalSelectedTags.push(tag);
      }
      renderModalTagUI();
    });

    chipsWrap.appendChild(btn);
  });
}

function addTagsFromInput() {
  const input = document.getElementById('ev-tag-new-input');
  if (!input) return;
  const newTags = parseTags(input.value);
  if (newTags.length === 0) return;

  newTags.forEach((t) => {
    if (!state.modalSelectedTags.includes(t)) {
      state.modalSelectedTags.push(t);
    }
    if (!state.existingTags.includes(t)) {
      state.existingTags.push(t);
    }
  });
  input.value = '';
  renderModalTagUI();
}

function openEventModal(ev = null) {
  const isEdit = Boolean(ev);
  document.getElementById('modal-event-title').textContent = isEdit ? '編輯行程' : '新增行程';
  document.getElementById('ev-id').value = isEdit ? ev.event_id : '';
  document.getElementById('ev-title').value = isEdit ? (ev.title || '') : '';
  document.getElementById('ev-start-date').value = isEdit ? ev.start_date : state.selectedDate;
  document.getElementById('ev-end-date').value = isEdit ? (ev.end_date || ev.start_date) : state.selectedDate;
  document.getElementById('ev-start-time').value = isEdit ? (ev.start_time || '') : '';
  document.getElementById('ev-content').value = isEdit ? (ev.content || '') : '';

  const newTagInput = document.getElementById('ev-tag-new-input');
  if (newTagInput) newTagInput.value = '';

  if (isEdit) {
    state.modalSelectedTags = parseTags(ev.tags !== undefined ? ev.tags : ev.tag);
  } else {
    state.modalSelectedTags = state.selectedTagFilter ? [state.selectedTagFilter] : [];
  }
  renderModalTagUI();

  const delBtn = document.getElementById('btn-delete-event');
  const metaEl = document.getElementById('ev-meta-info');
  if (isEdit) {
    delBtn.classList.remove('hidden');
    const updater = state.usersMap[ev.updated_by]?.display_name || ev.updated_by || '成員';
    metaEl.textContent = `最後編輯：${updater}（${ev.updated_at || ''}）`;
    metaEl.classList.remove('hidden');
  } else {
    delBtn.classList.add('hidden');
    metaEl.classList.add('hidden');
  }

  openModal('modal-event');
}

async function handleSaveEvent(e) {
  e.preventDefault();
  // 若使用者輸入了新標籤文字但直接按儲存，先自動收進已選清單
  addTagsFromInput();

  const btn = document.getElementById('btn-save-event');
  const title = document.getElementById('ev-title').value.trim();
  const tags = parseTags(state.modalSelectedTags);
  const startDate = document.getElementById('ev-start-date').value;
  const endDate = document.getElementById('ev-end-date').value || startDate;

  if (!startDate) {
    showToast('請選擇開始日期', 'error');
    return;
  }
  if (!title && tags.length === 0) {
    showToast('標題與標籤請至少填寫其中一項', 'error');
    return;
  }
  if (endDate < startDate) {
    showToast('結束日期不可早於開始日期', 'error');
    return;
  }

  const payload = {
    event_id: document.getElementById('ev-id').value,
    title,
    tags,
    tag: tags.join(','),
    start_date: startDate,
    end_date: endDate,
    start_time: document.getElementById('ev-start-time').value,
    content: document.getElementById('ev-content').value,
  };

  btn.disabled = true;
  try {
    const res = await apiCall('saveEvent', payload);
    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '儲存失敗', 'error');
      return;
    }
    closeModal('modal-event');
    showToast(payload.event_id ? '行程已更新' : '已新增行程', 'success');

    state.selectedDate = payload.start_date;
    const [y, m] = payload.start_date.split('-').map(Number);
    await loadCalendarMonth(y, m);
  } catch (err) {
    showToast('儲存過程發生網路錯誤', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleDeleteEvent() {
  const eventId = document.getElementById('ev-id').value;
  if (!eventId) return;

  const ok = await showConfirm('刪除行程', '確定要刪除這筆行程嗎？若相簿曾關聯此行程，關聯標籤也會一併解除。');
  if (!ok) return;

  const btn = document.getElementById('btn-delete-event');
  btn.disabled = true;
  try {
    const res = await apiCall('deleteEvent', { event_id: eventId });
    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '刪除失敗', 'error');
      return;
    }
    closeModal('modal-event');
    showToast('行程已刪除', 'success');
    await loadCalendarMonth(state.viewYear, state.viewMonth);
  } catch (err) {
    showToast('刪除失敗，請稍後再試', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============================================================================
// 分頁 2：生活相簿邏輯（含關鍵字搜尋與成員篩選）
// ============================================================================
function renderAlbumMemberFilter() {
  const bar = document.getElementById('album-member-filter');
  if (!bar) return;
  bar.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'member-chip' + (!state.albumAuthorId ? ' active' : '');
  allBtn.innerHTML = '<span class="member-chip-icon"><i class="fa-solid fa-users"></i></span><span>全部成員</span>';
  allBtn.addEventListener('click', () => {
    if (!state.albumAuthorId) return;
    state.albumAuthorId = '';
    renderAlbumMemberFilter();
    loadAlbumPosts(1, false);
  });
  bar.appendChild(allBtn);

  const activeUsers = Object.values(state.usersMap || {}).filter((u) => u.role === 'active');
  activeUsers.forEach((u) => {
    const isActive = state.albumAuthorId === u.user_id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'member-chip' + (isActive ? ' active' : '');

    if (u.avatar_url) {
      const img = document.createElement('img');
      img.className = 'member-chip-avatar';
      img.src = u.avatar_url;
      img.alt = u.display_name || '成員';
      btn.appendChild(img);
    } else {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'member-chip-icon';
      iconWrap.innerHTML = '<i class="fa-solid fa-user"></i>';
      btn.appendChild(iconWrap);
    }

    const nameSpan = document.createElement('span');
    nameSpan.textContent = u.display_name || '成員';
    btn.appendChild(nameSpan);

    btn.addEventListener('click', () => {
      state.albumAuthorId = isActive ? '' : u.user_id;
      renderAlbumMemberFilter();
      loadAlbumPosts(1, false);
    });

    bar.appendChild(btn);
  });
}

function resetAllAlbumFilters() {
  state.albumFilter = null;
  state.albumKeyword = '';
  state.albumAuthorId = '';
  const input = document.getElementById('album-search-input');
  if (input) input.value = '';
  const clearBtn = document.getElementById('btn-clear-search');
  if (clearBtn) clearBtn.classList.add('hidden');
  renderAlbumMemberFilter();
}

async function jumpToAlbumFilter(filterObj) {
  resetAllAlbumFilters();
  state.albumFilter = filterObj;
  state.albumLoadedOnce = true;
  await switchTab('album');
  await loadAlbumPosts(1, false);
}

async function loadAlbumPosts(page = 1, append = false) {
  const reqId = ++state.albumReqSeq;
  const listEl = document.getElementById('album-list');
  const loadMoreBtn = document.getElementById('btn-load-more');

  updateAlbumFilterBar(false);

  if (!append) {
    listEl.innerHTML = '<div class="empty-hint">載入相簿中...</div>';
  } else {
    loadMoreBtn.disabled = true;
  }

  const payload = { page, pageSize: CONFIG.PAGE_SIZE };
  if (state.albumFilter) {
    if (state.albumFilter.type === 'event') payload.linkedEventId = state.albumFilter.value;
    if (state.albumFilter.type === 'date') payload.postDate = state.albumFilter.value;
    if (state.albumFilter.type === 'post') payload.postId = state.albumFilter.value;
  }
  if (state.albumKeyword) payload.keyword = state.albumKeyword;
  if (state.albumAuthorId) payload.authorId = state.albumAuthorId;

  try {
    const res = await apiCall('getAlbumPosts', payload);
    if (reqId !== state.albumReqSeq) return;

    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '載入相簿失敗', 'error');
      return;
    }

    const posts = res.data.posts || [];
    state.albumPage = res.data.page || page;
    state.albumTotal = Number(res.data.total || 0);
    state.albumHasMore = Boolean(res.data.hasMore);
    state.albumLoadedOnce = true;

    if (append) {
      state.albumPosts = state.albumPosts.concat(posts);
    } else {
      state.albumPosts = posts;
    }

    updateAlbumFilterBar(true);
    renderAlbumList();
  } catch (err) {
    if (reqId === state.albumReqSeq) {
      showToast('無法連線取得相簿資料', 'error');
    }
  } finally {
    if (reqId === state.albumReqSeq) {
      loadMoreBtn.disabled = false;
    }
  }
}

function updateAlbumFilterBar(showCount) {
  const filterBar = document.getElementById('album-filter-bar');
  const labelEl = document.getElementById('album-filter-label');
  const parts = [];

  if (state.albumFilter) parts.push(state.albumFilter.label);
  if (state.albumAuthorId) {
    const name = state.usersMap[state.albumAuthorId]?.display_name || '成員';
    parts.push(`上傳者：${name}`);
  }
  if (state.albumKeyword) parts.push(`關鍵字「${state.albumKeyword}」`);

  if (parts.length === 0) {
    filterBar.classList.add('hidden');
    return;
  }

  const suffix = showCount ? `（共 ${state.albumTotal} 篇）` : '（搜尋中...）';
  labelEl.textContent = parts.join(' ＋ ') + suffix;
  filterBar.classList.remove('hidden');
}

function renderAlbumList() {
  const listEl = document.getElementById('album-list');
  const loadMoreWrap = document.getElementById('album-load-more-wrap');
  listEl.innerHTML = '';

  if (state.albumPosts.length === 0) {
    const hasFilter = Boolean(state.albumFilter || state.albumKeyword || state.albumAuthorId);
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = hasFilter
      ? '找不到符合條件的生活相簿紀錄'
      : '目前還沒有照片或影片，直接在 LINE 傳給官方帳號就會出現在這裡！';
    listEl.appendChild(empty);
    loadMoreWrap.classList.add('hidden');
    return;
  }

  state.albumPosts.forEach((post) => {
    const card = document.createElement('article');
    card.className = 'post-card';

    const header = document.createElement('div');
    header.className = 'post-header';

    const authorWrap = document.createElement('div');
    authorWrap.className = 'post-author';
    if (post.author && post.author.avatar_url) {
      const av = document.createElement('img');
      av.className = 'avatar-sm';
      av.src = post.author.avatar_url;
      av.alt = post.author.display_name || '成員';
      authorWrap.appendChild(av);
    } else {
      const avIcon = document.createElement('i');
      avIcon.className = 'fa-solid fa-circle-user fa-2x muted';
      authorWrap.appendChild(avIcon);
    }

    const authorMeta = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'post-author-name';
    nameEl.textContent = (post.author && post.author.display_name) || '成員';
    const dateEl = document.createElement('div');
    dateEl.className = 'post-date-label';
    dateEl.textContent = `${post.post_date}（${getWeekdayLabel(post.post_date)}）`;
    authorMeta.appendChild(nameEl);
    authorMeta.appendChild(dateEl);
    authorWrap.appendChild(authorMeta);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.title = '編輯貼文與關聯行程';
    editBtn.innerHTML = '<i class="fa-regular fa-pen-to-square"></i>';
    editBtn.addEventListener('click', () => openAlbumEditModal(post));

    header.appendChild(authorWrap);
    header.appendChild(editBtn);
    card.appendChild(header);

    if (post.linked_event) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'post-event-pill';
      pill.innerHTML = '<i class="fa-regular fa-calendar-check"></i>';
      const label = document.createElement('span');
      label.textContent = `${getEventDisplayLabel(post.linked_event)}（${post.linked_event.start_date}）`;
      pill.appendChild(label);
      pill.addEventListener('click', async () => {
        const targetDate = post.linked_event.start_date;
        state.selectedDate = targetDate;
        state.selectedTagFilter = '';
        const [y, m] = targetDate.split('-').map(Number);
        state.viewYear = y;
        state.viewMonth = m;
        await switchTab('calendar');
      });
      card.appendChild(pill);
    }

    if (post.caption) {
      const cap = document.createElement('p');
      cap.className = 'post-caption';
      cap.textContent = post.caption;
      card.appendChild(cap);
    }

    const media = post.media || [];
    if (media.length > 0) {
      const grid = document.createElement('div');
      const cls = media.length === 1 ? 'count-1' : (media.length === 2 || media.length === 4 ? 'count-2' : 'count-many');
      grid.className = `media-grid ${cls}`;

      media.forEach((m) => {
        const tile = document.createElement('div');
        tile.className = 'media-tile';
        appendMediaThumbElement(tile, m, post.post_date);
        grid.appendChild(tile);
      });
      card.appendChild(grid);
    }

    listEl.appendChild(card);
  });

  loadMoreWrap.classList.toggle('hidden', !state.albumHasMore);
}

function appendMediaThumbElement(container, media, dateLabel) {
  const isVideo = media.media_type === 'video';
  const thumbId = isVideo ? (media.thumb_file_id || media.drive_file_id) : media.drive_file_id;
  const thumbUrl = getDriveThumbUrl(thumbId, 400);
  const originalUrl = getDriveViewUrl(media.drive_file_id);

  const img = document.createElement('img');
  img.src = thumbUrl;
  img.loading = 'lazy';
  img.alt = isVideo ? '影片縮圖' : '生活照片縮圖';

  img.onerror = () => {
    img.remove();
    const fallback = document.createElement('div');
    fallback.className = 'video-fallback-bg';
    fallback.innerHTML = isVideo
      ? '<i class="fa-solid fa-film fa-lg"></i>'
      : '<i class="fa-regular fa-image fa-lg"></i>';
    container.prepend(fallback);
  };
  container.appendChild(img);

  if (isVideo) {
    const overlay = document.createElement('div');
    overlay.className = 'video-overlay';
    overlay.innerHTML = '<div class="video-play-circle"><i class="fa-solid fa-play"></i></div><span class="video-tag">影片</span>';
    container.appendChild(overlay);

    container.addEventListener('click', () => {
      openExternalUrl(originalUrl);
    });
  } else {
    container.addEventListener('click', () => {
      openLightbox(media.drive_file_id, dateLabel);
    });
  }
}

// ============================================================================
// 相簿編輯彈窗
// ============================================================================
async function openAlbumEditById(postId) {
  let target = state.albumPosts.find((p) => p.post_id === postId);
  if (!target) {
    const res = await apiCall('getAlbumPosts', { postId, page: 1, pageSize: 1 });
    if (res.ok && res.data.posts && res.data.posts.length > 0) {
      target = res.data.posts[0];
    }
  }
  if (target) {
    await openAlbumEditModal(target);
  } else {
    showToast('找不到該篇相簿貼文', 'info');
  }
}

async function openAlbumEditModal(post) {
  state.editingPost = JSON.parse(JSON.stringify(post));
  document.getElementById('post-id').value = post.post_id;
  document.getElementById('post-date').value = post.post_date;
  document.getElementById('post-caption').value = post.caption || '';

  renderEditPostMediaGrid();
  openModal('modal-post');

  await loadNearbyEventsSelect(post.post_date, post.linked_event_id, post.linked_event);
}

async function loadNearbyEventsSelect(centerDate, currentLinkedId, currentLinkedObj) {
  const select = document.getElementById('post-linked-event');
  select.innerHTML = '<option value="">載入前後 14 天行程中...</option>';
  select.disabled = true;

  try {
    const res = await apiCall('getNearbyEvents', { centerDate });
    const events = (res.ok && res.data.events) ? res.data.events : [];

    select.innerHTML = '<option value="">不關聯行程</option>';

    if (currentLinkedId && !events.some((e) => e.event_id === currentLinkedId) && currentLinkedObj) {
      const opt = document.createElement('option');
      opt.value = currentLinkedObj.event_id;
      opt.textContent = `${currentLinkedObj.start_date}｜${getEventDisplayLabel(currentLinkedObj)}`;
      select.appendChild(opt);
    }

    events.forEach((ev) => {
      const opt = document.createElement('option');
      opt.value = ev.event_id;
      const tags = parseTags(ev.tags !== undefined ? ev.tags : ev.tag);
      const tagPrefix = tags.length > 0 ? `[${tags.join('、')}] ` : '';
      const labelText = ev.title ? `${tagPrefix}${ev.title}` : tags.join('、');
      opt.textContent = `${ev.start_date}｜${labelText}`;
      select.appendChild(opt);
    });

    select.value = currentLinkedId || '';
  } catch (err) {
    select.innerHTML = '<option value="">不關聯行程</option>';
  } finally {
    select.disabled = false;
  }
}

function renderEditPostMediaGrid() {
  const grid = document.getElementById('post-edit-media-grid');
  grid.innerHTML = '';
  const mediaList = (state.editingPost && state.editingPost.media) || [];

  mediaList.forEach((m) => {
    const box = document.createElement('div');
    box.className = 'edit-media-item';

    const img = document.createElement('img');
    const thumbId = m.media_type === 'video' ? (m.thumb_file_id || m.drive_file_id) : m.drive_file_id;
    img.src = getDriveThumbUrl(thumbId, 400);
    img.alt = '縮圖';
    box.appendChild(img);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'edit-media-del';
    delBtn.title = '刪除此檔案';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    delBtn.addEventListener('click', () => handleDeleteSingleMedia(m.media_id));
    box.appendChild(delBtn);

    grid.appendChild(box);
  });
}

async function handleSavePost(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-save-post');
  const payload = {
    post_id: document.getElementById('post-id').value,
    post_date: document.getElementById('post-date').value,
    caption: document.getElementById('post-caption').value,
    linked_event_id: document.getElementById('post-linked-event').value,
  };

  btn.disabled = true;
  try {
    const res = await apiCall('updateAlbumPost', payload);
    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '儲存失敗', 'error');
      return;
    }
    closeModal('modal-post');
    showToast('相簿已更新', 'success');
    await loadAlbumPosts(1, false);
  } catch (err) {
    showToast('更新失敗，請稍後再試', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleDeleteSingleMedia(mediaId) {
  const ok = await showConfirm('刪除檔案', '確定要刪除這個照片／影片嗎？（原檔會移至 Google 雲端硬碟垃圾桶保留 30 天）');
  if (!ok) return;

  try {
    const res = await apiCall('deleteMedia', { media_id: mediaId });
    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '刪除失敗', 'error');
      return;
    }
    showToast('已移除該檔案', 'success');

    if (res.data.post_deleted) {
      closeModal('modal-post');
    } else if (state.editingPost) {
      state.editingPost.media = state.editingPost.media.filter((m) => m.media_id !== mediaId);
      renderEditPostMediaGrid();
    }
    await loadAlbumPosts(1, false);
  } catch (err) {
    showToast('刪除失敗，請稍後再試', 'error');
  }
}

async function handleDeleteEntirePost() {
  const postId = document.getElementById('post-id').value;
  if (!postId) return;

  const ok = await showConfirm('刪除整篇相簿', '確定要刪除這篇貼文與裡面所有的照片／影片嗎？（檔案會移至雲端硬碟垃圾桶）');
  if (!ok) return;

  const btn = document.getElementById('btn-delete-post');
  btn.disabled = true;
  try {
    const res = await apiCall('deleteAlbumPost', { post_id: postId });
    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '刪除失敗', 'error');
      return;
    }
    closeModal('modal-post');
    showToast('已刪除整篇貼文', 'success');
    await loadAlbumPosts(1, false);
  } catch (err) {
    showToast('刪除失敗，請稍後再試', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ============================================================================
// 大圖燈箱（修正關閉時誤觸 onerror 問題）與外部原檔開啟
// ============================================================================
function openLightbox(driveFileId, dateLabel) {
  state.lightboxOriginalUrl = getDriveViewUrl(driveFileId);
  document.getElementById('lightbox-info').textContent = dateLabel ? `${dateLabel} 照片預覽` : '照片預覽';

  const img = document.getElementById('lightbox-img');
  const spinner = document.getElementById('lightbox-spinner');

  // 先清除舊監聽再重設圖片
  img.onload = null;
  img.onerror = null;
  img.classList.add('hidden');
  spinner.classList.remove('hidden');

  const targetUrl = getDriveThumbUrl(driveFileId, 1200);
  img.onload = () => {
    spinner.classList.add('hidden');
    img.classList.remove('hidden');
  };
  img.onerror = () => {
    // 若已關閉燈箱則忽略任何殘餘事件
    if (document.getElementById('modal-lightbox').classList.contains('hidden')) return;
    spinner.classList.add('hidden');
    showToast('預覽載入失敗，請直接點擊下方開啟原檔', 'error');
  };
  img.src = targetUrl;

  document.getElementById('modal-lightbox').classList.remove('hidden');
}

function closeLightbox() {
  const img = document.getElementById('lightbox-img');
  // 務必先卸載 onload / onerror 再移除 src，避免觸發錯誤提示
  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');
  img.classList.add('hidden');
  document.getElementById('modal-lightbox').classList.add('hidden');
}

function openExternalUrl(url) {
  if (typeof liff !== 'undefined' && liff.isInClient()) {
    liff.openWindow({ url, external: true });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ============================================================================
// 暱稱編輯、自訂確認框、Toast 與標籤配色／文字工具
// ============================================================================
async function handleSaveProfile(e) {
  e.preventDefault();
  const name = document.getElementById('profile-name-input').value.trim();
  if (!name) return;

  const btn = document.getElementById('btn-save-profile');
  btn.disabled = true;
  try {
    const res = await apiCall('updateMyName', { display_name: name });
    if (!res.ok) {
      if (res.code !== 'UNAUTHORIZED') showToast(res.message || '更新暱稱失敗', 'error');
      return;
    }
    state.user.display_name = name;
    if (state.usersMap[state.user.user_id]) {
      state.usersMap[state.user.user_id].display_name = name;
    }
    state.albumPosts.forEach((p) => {
      if (p.created_by === state.user.user_id && p.author) {
        p.author.display_name = name;
      }
    });

    renderHeaderProfile();
    renderAlbumMemberFilter();
    if (state.albumLoadedOnce) {
      updateAlbumFilterBar(true);
      renderAlbumList();
    }
    closeModal('modal-profile');
    showToast('暱稱已更新', 'success');
  } catch (err) {
    showToast('網路錯誤，請稍後再試', 'error');
  } finally {
    btn.disabled = false;
  }
}

function showConfirm(title, message) {
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    openModal('modal-confirm');
  });
}

function resolveConfirm(val) {
  closeModal('modal-confirm');
  if (state.confirmResolver) {
    state.confirmResolver(val);
    state.confirmResolver = null;
  }
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const iconMap = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    info: 'fa-circle-info',
  };
  el.innerHTML = `<i class="fa-solid ${iconMap[type] || iconMap.info}"></i>`;
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s';
    setTimeout(() => el.remove(), 260);
  }, 2800);
}

function parseTags(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw !== null && raw !== undefined) {
    list = String(raw).split(/[,，、]+/);
  }
  const seen = new Set();
  const out = [];
  list.forEach((item) => {
    const t = String(item || '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  });
  return out;
}

/**
 * 確定性 FNV-1a 雜湊：相同標籤永遠對應同一顏色
 */
function getTagColor(tagName) {
  const s = String(tagName || '').trim();
  if (!s) return '#64748b';
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return TAG_COLOR_PALETTE[(hash >>> 0) % TAG_COLOR_PALETTE.length];
}

/**
 * 月曆與卡片底色：使用第一個標籤的顏色，無標籤時退回中性灰
 */
function getEventPrimaryColor(ev) {
  const tags = parseTags(ev.tags !== undefined ? ev.tags : ev.tag);
  return tags.length > 0 ? getTagColor(tags[0]) : '#64748b';
}

/**
 * 顯示文字：有填標題顯示標題，否則顯示標籤名稱
 */
function getEventDisplayLabel(ev) {
  const title = String(ev.title || '').trim();
  if (title) return title;
  const tags = parseTags(ev.tags !== undefined ? ev.tags : ev.tag);
  if (tags.length > 0) return tags.join('、');
  return '（未命名行程）';
}

function getDriveThumbUrl(fileId, width) {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`;
}

function getDriveViewUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getWeekdayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const names = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return names[new Date(y, m - 1, d).getDay()];
}

// ============================================================================
// 全域事件綁定
// ============================================================================
function bindEvents() {
  // 重試、重登與重整
  document.getElementById('btn-retry-auth').addEventListener('click', () => verifyMemberAndBoot());
  document.getElementById('btn-reload-app').addEventListener('click', () => window.location.reload());
  const reloginBtn = document.getElementById('btn-relogin-app');
  if (reloginBtn) {
    reloginBtn.addEventListener('click', () => triggerRelogin(true));
  }

  // PC 久置後切回分頁時，自動檢查憑證是否已過期
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && isIdTokenExpired(state.idToken)) {
      triggerRelogin(false);
    }
  });

  // 底部雙分頁
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 月份切換
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    const prev = new Date(state.viewYear, state.viewMonth - 2, 1);
    loadCalendarMonth(prev.getFullYear(), prev.getMonth() + 1);
  });
  document.getElementById('btn-next-month').addEventListener('click', () => {
    const next = new Date(state.viewYear, state.viewMonth, 1);
    loadCalendarMonth(next.getFullYear(), next.getMonth() + 1);
  });
  document.getElementById('btn-today').addEventListener('click', () => {
    const now = new Date();
    state.selectedDate = toDateStr(now);
    loadCalendarMonth(now.getFullYear(), now.getMonth() + 1);
  });

  // 新增行程與查看當日相簿
  document.getElementById('fab-add-event').addEventListener('click', () => openEventModal(null));
  document.getElementById('btn-add-event-inline').addEventListener('click', () => openEventModal(null));
  document.getElementById('btn-view-day-album').addEventListener('click', () => {
    jumpToAlbumFilter({
      type: 'date',
      value: state.selectedDate,
      label: `當日相簿：${state.selectedDate}`,
    });
  });

  // 行程表單互動（開始日期連動＋新增標籤按鈕與 Enter 鍵）
  document.getElementById('ev-start-date').addEventListener('change', (e) => {
    const endInput = document.getElementById('ev-end-date');
    if (!endInput.value || endInput.value < e.target.value) {
      endInput.value = e.target.value;
    }
  });
  const addTagBtn = document.getElementById('btn-add-tag');
  const newTagInput = document.getElementById('ev-tag-new-input');
  if (addTagBtn) {
    addTagBtn.addEventListener('click', addTagsFromInput);
  }
  if (newTagInput) {
    newTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTagsFromInput();
      }
    });
  }
  document.getElementById('form-event').addEventListener('submit', handleSaveEvent);
  document.getElementById('btn-delete-event').addEventListener('click', handleDeleteEvent);

  // 相簿搜尋、成員篩選與載入更多
  let albumSearchTimer = null;
  const searchInput = document.getElementById('album-search-input');
  const clearSearchBtn = document.getElementById('btn-clear-search');

  if (searchInput && clearSearchBtn) {
    searchInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      clearSearchBtn.classList.toggle('hidden', !val);

      clearTimeout(albumSearchTimer);
      albumSearchTimer = setTimeout(() => {
        if (state.albumKeyword === val) return;
        state.albumKeyword = val;
        loadAlbumPosts(1, false);
      }, 400);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(albumSearchTimer);
        state.albumKeyword = searchInput.value.trim();
        loadAlbumPosts(1, false);
      }
    });

    clearSearchBtn.addEventListener('click', () => {
      clearTimeout(albumSearchTimer);
      searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      if (state.albumKeyword) {
        state.albumKeyword = '';
        loadAlbumPosts(1, false);
      }
      searchInput.focus();
    });
  }

  document.getElementById('btn-clear-filter').addEventListener('click', () => {
    clearTimeout(albumSearchTimer);
    resetAllAlbumFilters();
    loadAlbumPosts(1, false);
  });
  document.getElementById('btn-load-more').addEventListener('click', () => {
    loadAlbumPosts(state.albumPage + 1, true);
  });
  document.getElementById('post-date').addEventListener('change', (e) => {
    if (e.target.value && state.editingPost) {
      loadNearbyEventsSelect(
        e.target.value,
        document.getElementById('post-linked-event').value,
        state.editingPost.linked_event
      );
    }
  });
  document.getElementById('form-post').addEventListener('submit', handleSavePost);
  document.getElementById('btn-delete-post').addEventListener('click', handleDeleteEntirePost);

  // 暱稱編輯
  document.getElementById('btn-profile').addEventListener('click', () => {
    document.getElementById('profile-name-input').value = state.user?.display_name || '';
    openModal('modal-profile');
  });
  document.getElementById('form-profile').addEventListener('submit', handleSaveProfile);

  // 燈箱
  document.getElementById('btn-close-lightbox').addEventListener('click', closeLightbox);
  document.getElementById('btn-open-original').addEventListener('click', () => {
    if (state.lightboxOriginalUrl) openExternalUrl(state.lightboxOriginalUrl);
  });

  // 確認框
  document.getElementById('btn-confirm-cancel').addEventListener('click', () => resolveConfirm(false));
  document.getElementById('btn-confirm-ok').addEventListener('click', () => resolveConfirm(true));

  // 通用關閉按鈕與點擊遮罩關閉
  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  ['modal-event', 'modal-post', 'modal-profile'].forEach((id) => {
    document.getElementById(id).addEventListener('click', (e) => {
      if (e.target.id === id) closeModal(id);
    });
  });

  // Esc 鍵依層級關閉最上層彈窗
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('modal-confirm').classList.contains('hidden')) {
      resolveConfirm(false);
    } else if (!document.getElementById('modal-lightbox').classList.contains('hidden')) {
      closeLightbox();
    } else {
      ['modal-event', 'modal-post', 'modal-profile'].forEach(closeModal);
    }
  });
}
