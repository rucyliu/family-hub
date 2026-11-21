/**
 * 請將以下兩組設定替換為你自己的 LIFF ID 與 GAS 部署網址 (/exec)
 */
const CONFIG = {
  LIFF_ID: '2012740107-BWMenJbV',
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycbxzEXBgWZOKJHHwI9NCE_QYeJ0hlUyuG2Hfa0JoxiRDIcFLEEVieTS1HKRenGImDmbU/exec',
  PAGE_SIZE: 20,
  PRESET_TAGS: [
    { name: '共同', color: '#2563eb' },
    { name: 'Miro', color: '#059669' },
    { name: '媽', color: '#d97706' },
    { name: '瑞', color: '#7c3aed' },
    { name: 'Wan', color: '#dc2626' },
    { name: '煮煮', color: '#475569' },
  ],
};

// ============================================================================
// 應用程式狀態
// ============================================================================
const nowDate = new Date();
const state = {
  idToken: '',
  user: null,
  usersMap: {},
  currentTab: 'calendar',

  // 行事曆狀態
  viewYear: nowDate.getFullYear(),
  viewMonth: nowDate.getMonth() + 1,
  selectedDate: toDateStr(nowDate),
  monthEvents: [],
  photoDates: new Set(),
  dayThumbnails: {},

  // 相簿狀態
  albumPosts: [],
  albumPage: 1,
  albumHasMore: false,
  albumLoadedOnce: false,
  albumFilter: null, // { type: 'event'|'date'|'post', value: '...', label: '...' }

  // 編輯與燈箱暫存
  editingPost: null,
  lightboxOriginalUrl: '',
  confirmResolver: null,
};

// ============================================================================
// 初始化與 LIFF 登入流程
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

    await verifyMemberAndBoot();
  } catch (err) {
    console.error(err);
    showScreen('error', err.message || 'LIFF 初始化失敗，請確認 LIFF ID 與網路連線。');
  }
}

async function verifyMemberAndBoot() {
  showScreen('loading', '正在確認親友存取權限...');
  const res = await apiCall('getMe', {});

  if (!res.ok) {
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

  state.user = res.data.user;
  state.usersMap = res.data.usersMap || {};
  renderHeaderProfile();
  showScreen('app');

  // 解析網址參數（支援 LINE Bot 卡片帶入 ?tab=album&editPost=post_xxx）
  const params = new URLSearchParams(window.location.search);
  const initTab = params.get('tab') === 'album' ? 'album' : 'calendar';
  const editPostId = params.get('editPost');

  await switchTab(initTab);

  if (editPostId) {
    await openAlbumEditById(editPostId);
    // 清除網址參數避免重整時重複彈出
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
  }
}

// ============================================================================
// API 呼叫（以 text/plain 送 JSON 避開 GAS CORS 預檢）
// ============================================================================
async function apiCall(action, payload = {}) {
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
    showToast('LINE 登入已逾時，請重新整理頁面', 'error');
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
// 分頁 1：行事曆邏輯
// ============================================================================
async function loadCalendarMonth(year, month) {
  state.viewYear = year;
  state.viewMonth = month;
  document.getElementById('cal-month-label').textContent = `${year} 年 ${month} 月`;

  try {
    const res = await apiCall('getMonthEvents', { year, month });
    if (!res.ok) {
      showToast(res.message || '載入行程失敗', 'error');
      return;
    }
    state.monthEvents = res.data.events || [];
    state.photoDates = new Set(res.data.photoDates || []);
    state.dayThumbnails = res.data.dayThumbnails || {};

    renderCalendarGrid();
    renderSelectedDayPanel();
  } catch (err) {
    showToast('無法連線取得行程資料', 'error');
  }
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

    // 篩選當日行程並顯示最多 2 條色條
    const dayEvents = getEventsForDate(dateStr);
    if (dayEvents.length > 0) {
      const bars = document.createElement('div');
      bars.className = 'cal-bars';
      dayEvents.slice(0, 2).forEach((ev) => {
        const bar = document.createElement('div');
        bar.className = 'cal-bar';
        bar.style.backgroundColor = getTagColor(ev.tag);
        bar.textContent = ev.title;
        bars.appendChild(bar);
      });
      if (dayEvents.length > 2) {
        const more = document.createElement('div');
        more.className = 'cal-more';
        more.textContent = '+' + (dayEvents.length - 2);
        bars.appendChild(more);
      }
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
    return ev.start_date <= dateStr && end >= dateStr;
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
    empty.textContent = '這天還沒有安排行程';
    listEl.appendChild(empty);
  } else {
    dayEvents.forEach((ev) => {
      const color = getTagColor(ev.tag);
      const card = document.createElement('div');
      card.className = 'event-card';
      card.style.borderLeftColor = color;

      const top = document.createElement('div');
      top.className = 'event-card-top';

      const badges = document.createElement('div');
      badges.className = 'event-badges';

      const tagBadge = document.createElement('span');
      tagBadge.className = 'tag-badge';
      tagBadge.style.backgroundColor = color;
      tagBadge.textContent = ev.tag || '一般';
      badges.appendChild(tagBadge);

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
      title.textContent = ev.title;
      card.appendChild(title);

      if (ev.content) {
        const content = document.createElement('p');
        content.className = 'event-content';
        content.textContent = ev.content; // 搭配 CSS white-space: pre-wrap 安全呈現換行
        card.appendChild(content);
      }

      // 輕量關聯：若有綁定相簿照片/影片，顯示導向按鈕
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
            label: `行程相簿：${ev.title}`,
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
// 行程新增 / 編輯 / 刪除彈窗
// ============================================================================
function renderTagChips(selectedTag) {
  const wrap = document.getElementById('ev-tag-chips');
  const customInput = document.getElementById('ev-tag-custom');
  wrap.innerHTML = '';

  const isPreset = CONFIG.PRESET_TAGS.some((t) => t.name === selectedTag);
  customInput.value = isPreset ? '' : (selectedTag || '');

  CONFIG.PRESET_TAGS.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-chip' + (selectedTag === t.name ? ' active' : '');
    btn.textContent = t.name;
    if (selectedTag === t.name) {
      btn.style.backgroundColor = t.color;
    }
    btn.addEventListener('click', () => {
      customInput.value = '';
      renderTagChips(t.name);
    });
    wrap.appendChild(btn);
  });
}

function getSelectedTagValue() {
  const custom = document.getElementById('ev-tag-custom').value.trim();
  if (custom) return custom;
  const active = document.querySelector('#ev-tag-chips .tag-chip.active');
  return active ? active.textContent : '一般';
}

function openEventModal(ev = null) {
  const isEdit = Boolean(ev);
  document.getElementById('modal-event-title').textContent = isEdit ? '編輯行程' : '新增行程';
  document.getElementById('ev-id').value = isEdit ? ev.event_id : '';
  document.getElementById('ev-title').value = isEdit ? ev.title : '';
  document.getElementById('ev-start-date').value = isEdit ? ev.start_date : state.selectedDate;
  document.getElementById('ev-end-date').value = isEdit ? (ev.end_date || ev.start_date) : state.selectedDate;
  document.getElementById('ev-start-time').value = isEdit ? (ev.start_time || '') : '';
  document.getElementById('ev-content').value = isEdit ? (ev.content || '') : '';
  renderTagChips(isEdit ? ev.tag : '共同');

  const delBtn = document.getElementById('btn-delete-event');
  const metaEl = document.getElementById('ev-meta-info');
  if (isEdit) {
    delBtn.classList.remove('hidden');
    const updater = state.usersMap[ev.updated_by]?.display_name || '成員';
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
  const btn = document.getElementById('btn-save-event');
  const payload = {
    event_id: document.getElementById('ev-id').value,
    title: document.getElementById('ev-title').value.trim(),
    tag: getSelectedTagValue(),
    start_date: document.getElementById('ev-start-date').value,
    end_date: document.getElementById('ev-end-date').value || document.getElementById('ev-start-date').value,
    start_time: document.getElementById('ev-start-time').value,
    content: document.getElementById('ev-content').value,
  };

  if (payload.end_date < payload.start_date) {
    showToast('結束日期不可早於開始日期', 'error');
    return;
  }

  btn.disabled = true;
  try {
    const res = await apiCall('saveEvent', payload);
    if (!res.ok) {
      showToast(res.message || '儲存失敗', 'error');
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
      showToast(res.message || '刪除失敗', 'error');
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
// 分頁 2：生活相簿邏輯
// ============================================================================
async function jumpToAlbumFilter(filterObj) {
  state.albumFilter = filterObj;
  state.albumLoadedOnce = true;
  await switchTab('album');
  await loadAlbumPosts(1, false);
}

async function loadAlbumPosts(page = 1, append = false) {
  const listEl = document.getElementById('album-list');
  const loadMoreBtn = document.getElementById('btn-load-more');
  const filterBar = document.getElementById('album-filter-bar');

  if (state.albumFilter) {
    document.getElementById('album-filter-label').textContent = state.albumFilter.label;
    filterBar.classList.remove('hidden');
  } else {
    filterBar.classList.add('hidden');
  }

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

  try {
    const res = await apiCall('getAlbumPosts', payload);
    if (!res.ok) {
      showToast(res.message || '載入相簿失敗', 'error');
      return;
    }

    const posts = res.data.posts || [];
    state.albumPage = res.data.page || page;
    state.albumHasMore = Boolean(res.data.hasMore);
    state.albumLoadedOnce = true;

    if (append) {
      state.albumPosts = state.albumPosts.concat(posts);
    } else {
      state.albumPosts = posts;
    }

    renderAlbumList();
  } catch (err) {
    showToast('無法連線取得相簿資料', 'error');
  } finally {
    loadMoreBtn.disabled = false;
  }
}

function renderAlbumList() {
  const listEl = document.getElementById('album-list');
  const loadMoreWrap = document.getElementById('album-load-more-wrap');
  listEl.innerHTML = '';

  if (state.albumPosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = state.albumFilter
      ? '這個篩選條件下沒有相簿紀錄'
      : '目前還沒有照片或影片，直接在 LINE 傳給官方帳號就會出現在這裡！';
    listEl.appendChild(empty);
    loadMoreWrap.classList.add('hidden');
    return;
  }

  state.albumPosts.forEach((post) => {
    const card = document.createElement('article');
    card.className = 'post-card';

    // 卡片頂部（作者＋日期＋編輯按鈕）
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

    // 關聯行程標籤（點擊跳回行事曆對應日期）
    if (post.linked_event) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'post-event-pill';
      pill.innerHTML = '<i class="fa-regular fa-calendar-check"></i>';
      const label = document.createElement('span');
      label.textContent = `${post.linked_event.title}（${post.linked_event.start_date}）`;
      pill.appendChild(label);
      pill.addEventListener('click', async () => {
        const targetDate = post.linked_event.start_date;
        state.selectedDate = targetDate;
        const [y, m] = targetDate.split('-').map(Number);
        state.viewYear = y;
        state.viewMonth = m;
        await switchTab('calendar');
      });
      card.appendChild(pill);
    }

    // 換行文字說明
    if (post.caption) {
      const cap = document.createElement('p');
      cap.className = 'post-caption';
      cap.textContent = post.caption;
      card.appendChild(cap);
    }

    // 省流量媒體縮圖網格
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

/**
 * 產生省流量縮圖元素（圖片點開 w1200 燈箱，影片直接另開 Drive 原檔串流）
 */
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
// 相簿編輯彈窗（日期、說明、前後 14 天關聯行程、單檔／整篇刪除）
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

    // 若原本關聯的行程超出前後 14 天範圍，仍保留於選單避免誤清空
    if (currentLinkedId && !events.some((e) => e.event_id === currentLinkedId) && currentLinkedObj) {
      const opt = document.createElement('option');
      opt.value = currentLinkedObj.event_id;
      opt.textContent = `${currentLinkedObj.start_date}｜${currentLinkedObj.title}`;
      select.appendChild(opt);
    }

    events.forEach((ev) => {
      const opt = document.createElement('option');
      opt.value = ev.event_id;
      opt.textContent = `${ev.start_date}｜[${ev.tag || '一般'}] ${ev.title}`;
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
      showToast(res.message || '儲存失敗', 'error');
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
      showToast(res.message || '刪除失敗', 'error');
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
      showToast(res.message || '刪除失敗', 'error');
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
// 大圖燈箱與外部原檔開啟
// ============================================================================
function openLightbox(driveFileId, dateLabel) {
  state.lightboxOriginalUrl = getDriveViewUrl(driveFileId);
  document.getElementById('lightbox-info').textContent = dateLabel ? `${dateLabel} 照片預覽` : '照片預覽';

  const img = document.getElementById('lightbox-img');
  const spinner = document.getElementById('lightbox-spinner');
  img.classList.add('hidden');
  spinner.classList.remove('hidden');

  img.onload = () => {
    spinner.classList.add('hidden');
    img.classList.remove('hidden');
  };
  img.onerror = () => {
    spinner.classList.add('hidden');
    showToast('預覽載入失敗，請直接點擊下方開啟原檔', 'error');
  };
  img.src = getDriveThumbUrl(driveFileId, 1200);

  document.getElementById('modal-lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('modal-lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
}

function openExternalUrl(url) {
  if (typeof liff !== 'undefined' && liff.isInClient()) {
    liff.openWindow({ url, external: true });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// ============================================================================
// 暱稱編輯、自訂確認框、Toast 與通用工具
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
      showToast(res.message || '更新暱稱失敗', 'error');
      return;
    }
    state.user.display_name = name;
    if (state.usersMap[state.user.user_id]) {
      state.usersMap[state.user.user_id].display_name = name;
    }
    renderHeaderProfile();
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

function getDriveThumbUrl(fileId, width) {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`;
}

function getDriveViewUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

function getTagColor(tagName) {
  const found = CONFIG.PRESET_TAGS.find((t) => t.name === tagName);
  return found ? found.color : '#475569';
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
  // 重試與重整
  document.getElementById('btn-retry-auth').addEventListener('click', () => verifyMemberAndBoot());
  document.getElementById('btn-reload-app').addEventListener('click', () => window.location.reload());

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

  // 行程表單互動（變更開始日期時若結束日期較早則自動跟上）
  document.getElementById('ev-start-date').addEventListener('change', (e) => {
    const endInput = document.getElementById('ev-end-date');
    if (!endInput.value || endInput.value < e.target.value) {
      endInput.value = e.target.value;
    }
  });
  document.getElementById('ev-tag-custom').addEventListener('input', (e) => {
    if (e.target.value.trim()) {
      document.querySelectorAll('#ev-tag-chips .tag-chip').forEach((c) => {
        c.classList.remove('active');
        c.style.backgroundColor = '';
      });
    }
  });
  document.getElementById('form-event').addEventListener('submit', handleSaveEvent);
  document.getElementById('btn-delete-event').addEventListener('click', handleDeleteEvent);

  // 相簿操作
  document.getElementById('btn-clear-filter').addEventListener('click', () => {
    state.albumFilter = null;
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
