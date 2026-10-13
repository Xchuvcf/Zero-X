(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const PAGE_SIZE = 48;
  const PLAYLISTS_KEY = 'zeroX.playlists.m3u.v1';
  const FAVORITES_PREFIX = 'zeroX.m3u.favorites.v1:';
  const GROUPS_INITIAL = 100;
  const TITLES = {
    live: { title: 'القنوات المباشرة', crumb: 'القنوات', subtitle: 'تصفّح القنوات الموجودة في قائمة التشغيل.', categories: 'مجموعات القنوات', label: 'مباشر' },
    movies: { title: 'الأفلام', crumb: 'الأفلام', subtitle: 'الأفلام التي تعرّف عليها اسم المجموعة أو صيغة الرابط.', categories: 'مجموعات الأفلام', label: 'فيلم' },
    series: { title: 'المسلسلات والحلقات', crumb: 'المسلسلات', subtitle: 'المسلسلات والحلقات الموجودة في القائمة.', categories: 'مجموعات المسلسلات', label: 'مسلسل' },
    favorites: { title: 'المفضلة', crumb: 'المفضلة', subtitle: 'العناصر التي حفظتها من قائمة التشغيل الحالية.', categories: 'المحتوى المحفوظ', label: 'مفضل' }
  };

  const state = {
    playlists: [], activePlaylist: null, allItems: [], items: [], visibleItems: [],
    section: 'live', group: '__all__', groupShownCount: GROUPS_INITIAL,
    search: '', shownCount: PAGE_SIZE, favorites: [], hls: null,
    currentPlayback: null, toastTimer: null, isLoading: false
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }
  function safeHttpUrl(value, base = location.href) {
    try {
      const url = new URL(String(value || ''), base);
      return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  function hostOf(value) {
    try { return new URL(value).host; } catch { return 'رابط قائمة'; }
  }
  function formatCount(num) { return (Number(num) || 0).toLocaleString('en-US'); }
  function showToast(message, kind = '') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast show ${kind}`.trim();
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 5000);
  }
  function showLoginError(message) {
    const box = $('#loginError'); box.hidden = false; box.textContent = message;
  }
  function clearLoginError() { $('#loginError').hidden = true; $('#loginError').textContent = ''; }
  function setLoading(show, title = 'جارٍ تحميل القائمة', text = 'نقرأ عناصر القائمة دون إنشاء نسخة نصية إضافية كبيرة.') {
    state.isLoading = show;
    $('#loadingOverlay').hidden = !show;
    $('#loadingOverlayTitle').textContent = title;
    $('#loadingOverlayText').textContent = text;
  }
  function showStatus(title, text) {
    $('#statusPanel').hidden = false;
    $('#statusTitle').textContent = title;
    $('#statusText').textContent = text;
    $('#contentGrid').innerHTML = '';
    $('#emptyState').hidden = true;
    $('#loadMoreButton').hidden = true;
  }
  function hideStatus() { $('#statusPanel').hidden = true; }

  function loadSavedPlaylists() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || '[]');
      state.playlists = Array.isArray(parsed) ? parsed.filter(p => p && typeof p.url === 'string' && p.id) : [];
    } catch { state.playlists = []; }
    renderSavedPlaylists();
  }
  function saveSavedPlaylists() {
    try {
      localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(state.playlists));
      renderSavedPlaylists();
    } catch {
      showToast('تعذّر حفظ القائمة في مساحة المتصفح. قد تكون مساحة التخزين ممتلئة.', 'error');
    }
  }
  function renderSavedPlaylists() {
    const host = $('#savedPlaylistList');
    const empty = $('#savedPlaylistEmpty');
    $('#savedPlaylistCount').textContent = formatCount(state.playlists.length);
    empty.hidden = state.playlists.length > 0;
    host.innerHTML = state.playlists.map(playlist => {
      const active = state.activePlaylist?.id === playlist.id;
      const name = playlist.name || hostOf(playlist.url);
      const lastUsed = playlist.lastUsed ? `آخر فتح: ${new Date(playlist.lastUsed).toLocaleDateString()}` : 'محفوظة على هذا الجهاز';
      return `<article class="saved-playlist ${active ? 'is-active' : ''}">
        <button type="button" class="saved-playlist-open" data-use-playlist="${escapeHtml(playlist.id)}" aria-label="فتح القائمة ${escapeHtml(name)}">
          <span class="saved-playlist-icon">${active ? '✓' : '▤'}</span>
          <span class="saved-playlist-copy"><b>${escapeHtml(name)}</b><small>${escapeHtml(hostOf(playlist.url))} · ${escapeHtml(lastUsed)}</small></span>
          <span class="saved-playlist-arrow">←</span>
        </button>
        <div class="saved-playlist-actions"><button type="button" data-open-playlist="${escapeHtml(playlist.id)}" aria-label="فتح رابط القائمة للتنزيل">فتح</button><button type="button" data-rename-playlist="${escapeHtml(playlist.id)}" aria-label="إعادة تسمية القائمة">تسمية</button><button type="button" data-remove-playlist="${escapeHtml(playlist.id)}" aria-label="حذف القائمة">حذف</button></div>
      </article>`;
    }).join('');
  }
  function addOrUpdatePlaylist(url, name = '') {
    const normalized = String(url || '').trim();
    let parsed;
    try { parsed = new URL(normalized); } catch { throw new Error('رابط القائمة غير صحيح. الصق الرابط الكامل الذي يبدأ بـ http:// أو https://.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('يجب أن يبدأ الرابط بـ http:// أو https://.');
    if (!/(\.m3u8?(?:$|\?)|get\.php(?:$|\?)|type=m3u)/i.test(parsed.href)) {
      // Non-standard paths are valid too; leave a hint rather than rejecting a provider-specific URL.
    }
    let playlist = state.playlists.find(p => p.url === parsed.href);
    if (playlist) {
      if (name.trim()) playlist.name = name.trim();
      playlist.lastUsed = new Date().toISOString();
    } else {
      playlist = { id: makeId(), name: name.trim() || inferPlaylistName(parsed.href), url: parsed.href, addedAt: new Date().toISOString(), lastUsed: new Date().toISOString() };
      state.playlists.unshift(playlist);
    }
    saveSavedPlaylists();
    return playlist;
  }
  function makeId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  function inferPlaylistName(url) {
    try {
      const parsed = new URL(url);
      const custom = parsed.searchParams.get('name') || parsed.searchParams.get('playlist');
      return custom ? custom : `قائمة ${parsed.hostname}`;
    } catch { return 'قائمة M3U جديدة'; }
  }

  function classifyItem(name, group, url) {
    const hint = `${group || ''} ${name || ''}`.toLocaleLowerCase();
    if (/(?:^|\b)(series|serial|season|episode|episodes|tvshows)(?:\b|$)|\bs\d{1,2}\s*e\d{1,2}\b|الحلقة|الموسم|مسلسل|مسلسلات|حلقات|دراما/.test(hint)) return 'series';
    if (/(?:^|\b)(movie|movies|film|films|cinema|vod)(?:\b|$)|أفلام|افلام|فيلم|سينما/.test(hint)) return 'movies';
    if (/\.(mp4|mkv|avi|mov|m4v)(?:$|\?)/i.test(url)) return 'movies';
    return 'live';
  }
  function parseExtinf(line) {
    let comma = -1, quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ',' && !quoted) { comma = i; break; }
    }
    const attrs = comma >= 0 ? line.slice(0, comma) : line;
    const title = comma >= 0 ? line.slice(comma + 1).trim() : '';
    const readAttr = (key) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = attrs.match(new RegExp(`${escaped}="([^"]*)"`, 'i')) || attrs.match(new RegExp(`${escaped}=([^\\s,]+)`, 'i'));
      return match ? match[1].trim() : '';
    };
    return {
      name: title || readAttr('tvg-name') || 'بدون اسم',
      group: readAttr('group-title') || 'غير مصنّف',
      logo: readAttr('tvg-logo') || '',
      tvgId: readAttr('tvg-id') || ''
    };
  }
  function parseM3UText(text, baseUrl = location.href) {
    const items = [];
    let meta = null;
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (/^#EXTINF:/i.test(line)) { meta = parseExtinf(line); continue; }
      if (line.startsWith('#')) continue;
      const url = safeHttpUrl(line, baseUrl);
      if (!url || !meta) { meta = null; continue; }
      const item = { ...meta, url, id: `${items.length}-${url}`, mediaType: classifyItem(meta.name, meta.group, url) };
      if (item.logo) item.logo = safeHttpUrl(item.logo, baseUrl);
      items.push(item);
      meta = null;
    }
    return items;
  }
  async function parseM3UResponse(response, onProgress = () => {}) {
    // Stream line by line so a large playlist isn't duplicated as one giant text string.
    if (!response.body?.getReader) {
      const text = await response.text();
      return parseM3UText(text, response.url || location.href);
    }
    const reader = response.body.getReader();
    const baseUrl = response.url || location.href;
    const decoder = new TextDecoder('utf-8');
    const items = [];
    let pending = '', meta = null, bytes = 0, linesRead = 0;
    const handleLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      if (/^#EXTINF:/i.test(line)) { meta = parseExtinf(line); return; }
      if (line.startsWith('#')) return;
      const url = safeHttpUrl(line, baseUrl);
      if (!url || !meta) { meta = null; return; }
      const logo = meta.logo ? safeHttpUrl(meta.logo, baseUrl) : '';
      items.push({ ...meta, logo, url, id: `${items.length}-${url}`, mediaType: classifyItem(meta.name, meta.group, url) });
      meta = null;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        handleLine(line); linesRead++;
      }
      if (linesRead % 4000 < 10) onProgress(items.length, bytes);
    }
    pending += decoder.decode();
    if (pending.trim()) handleLine(pending);
    onProgress(items.length, bytes, true);
    return items;
  }

  async function loadPlaylistById(id) {
    const playlist = state.playlists.find(p => p.id === id);
    if (!playlist) { showToast('لم يتم العثور على القائمة المحفوظة.', 'error'); return; }
    await loadPlaylist(playlist);
  }
  async function loadPlaylist(playlist) {
    clearLoginError();
    $('#connectButton').disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const sourceUrl = new URL(playlist.url);
      if (location.protocol === 'https:' && sourceUrl.protocol === 'http:') {
        throw new Error('هذا الرابط يعمل عبر HTTP بينما Zero X يعمل عبر HTTPS. المتصفح قد يمنع قراءته كليًا. جرّب رابط HTTPS من المزود، أو افتح الرابط للتنزيل ثم استورد ملف M3U.');
      }
      setLoading(true, 'جارٍ تحميل القائمة', `نتصل بـ ${sourceUrl.host} ونقرأ عناصر القائمة تدريجيًا.`);
      const response = await fetch(sourceUrl.href, { method: 'GET', cache: 'no-store', mode: 'cors', credentials: 'omit', signal: controller.signal, headers: { 'Accept': 'application/x-mpegURL, audio/x-mpegurl, text/plain, */*' } });
      if (!response.ok) throw new Error(`تعذّر تحميل القائمة: HTTP ${response.status}. تحقق من الرابط وصلاحية الاشتراك.`);
      let firstProgress = 0;
      const items = await parseM3UResponse(response, (count, bytes, done) => {
        if (count !== firstProgress || done) {
          firstProgress = count;
          $('#loadingOverlayText').textContent = `${formatCount(count)} عنصر · ${formatCount(Math.round(bytes / 1024))} KB مقروءة`;
        }
      });
      if (!items.length) throw new Error('لم نعثر على عناصر في الرابط. قد لا يكون رابط قائمة M3U، أو ربما أعاد صفحة خطأ بدل القائمة.');
      playlist.lastUsed = new Date().toISOString();
      playlist.itemCount = items.length;
      state.activePlaylist = playlist;
      state.allItems = items;
      state.section = 'live'; state.group = '__all__'; state.groupShownCount = GROUPS_INITIAL;
      state.search = ''; state.shownCount = PAGE_SIZE;
      $('#searchInput').value = '';
      loadFavorites();
      saveSavedPlaylists();
      $('#authView').hidden = true;
      $('#appView').hidden = false;
      $('#connectionLabel').textContent = 'قائمة محمّلة';
      $('#providerName').textContent = playlist.name || 'قائمة M3U';
      $('#providerHost').textContent = hostOf(playlist.url);
      updateNavCounts();
      syncNav(); renderSectionMeta(); renderCategories(); renderItems();
      setLoading(false);
      showToast(`تم تحميل ${formatCount(items.length)} عنصر من القائمة.`, 'success');
      $('#contentGrid').focus?.();
    } catch (error) {
      setLoading(false);
      if (error.name === 'AbortError') showLoginError('استغرق تحميل القائمة وقتًا طويلًا. قد تكون ضخمة جدًا أو أن السيرفر بطيء. حاول مرة أخرى.');
      else if (error instanceof TypeError) showLoginError('تعذّر قراءة القائمة من المتصفح. غالبًا يمنع السيرفر CORS أو يتطلب إعدادات خاصة. جرّب رابط HTTPS يسمح بالوصول من المتصفح، أو افتح الرابط للتنزيل ثم استورد ملف M3U.');
      else showLoginError(error.message || 'تعذّر تحميل القائمة. تحقق من الرابط وحاول مرة أخرى.');
      showToast('تعذّر تحميل القائمة', 'error');
    } finally {
      clearTimeout(timeout);
      $('#connectButton').disabled = false;
    }
  }

  function loadFavorites() {
    if (!state.activePlaylist) { state.favorites = []; return; }
    try {
      const raw = localStorage.getItem(`${FAVORITES_PREFIX}${state.activePlaylist.id}`);
      state.favorites = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.favorites)) state.favorites = [];
    } catch { state.favorites = []; }
    updateFavoriteCount();
  }
  function saveFavorites() {
    if (!state.activePlaylist) return;
    try { localStorage.setItem(`${FAVORITES_PREFIX}${state.activePlaylist.id}`, JSON.stringify(state.favorites)); }
    catch { showToast('تعذّر حفظ المفضلة في المتصفح.', 'error'); }
    updateFavoriteCount();
  }
  function updateFavoriteCount() { $('#favoritesCount').textContent = formatCount(state.favorites.length); }
  function isFavorite(item) { return state.favorites.some(f => f.url === item.url); }
  function toggleFavorite(item) {
    const index = state.favorites.findIndex(f => f.url === item.url);
    if (index >= 0) { state.favorites.splice(index, 1); showToast('تمت الإزالة من المفضلة.'); }
    else { state.favorites.unshift({ ...item }); showToast('أُضيف إلى المفضلة.', 'success'); }
    saveFavorites();
    renderItems();
  }
  function sectionItems(section = state.section) {
    if (section === 'favorites') return state.favorites;
    return state.allItems.filter(item => item.mediaType === section);
  }
  function uniqueGroups(items) {
    const result = [], seen = new Set();
    for (const item of items) {
      const name = item.group || 'غير مصنّف';
      if (!seen.has(name)) { seen.add(name); result.push(name); }
    }
    return result;
  }
  function updateNavCounts() {
    $('#liveCount').textContent = formatCount(state.allItems.filter(x => x.mediaType === 'live').length);
    $('#moviesCount').textContent = formatCount(state.allItems.filter(x => x.mediaType === 'movies').length);
    $('#seriesCount').textContent = formatCount(state.allItems.filter(x => x.mediaType === 'series').length);
    updateFavoriteCount();
  }
  function syncNav() { $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.section === state.section)); }
  function renderSectionMeta() {
    const meta = TITLES[state.section];
    $('#breadcrumb').innerHTML = `الرئيسية <span>／</span> ${escapeHtml(meta.crumb)}`;
    $('#pageTitle').textContent = meta.title;
    $('#pageSubtitle').textContent = meta.subtitle;
    $('#categoryHeading').textContent = meta.categories;
    $('#heroBanner').hidden = state.section === 'favorites';
    $('#categoryBar').hidden = state.section === 'favorites';
    $('#searchInput').value = state.search;
  }
  function renderCategories() {
    const bar = $('#categoryBar');
    if (state.section === 'favorites') { bar.innerHTML = ''; return; }
    const groups = uniqueGroups(sectionItems());
    const groupChoices = groups.slice(0, state.groupShownCount);
    let html = `<button class="category-chip ${state.group === '__all__' ? 'active' : ''}" data-category="__all__">كل المجموعات <small>${formatCount(sectionItems().length)}</small></button>`;
    html += groupChoices.map(group => `<button class="category-chip ${state.group === group ? 'active' : ''}" data-category="${escapeHtml(group)}">${escapeHtml(group)}</button>`).join('');
    if (groups.length > state.groupShownCount) html += `<button class="category-chip group-more" data-show-groups="1">مجموعات إضافية (${formatCount(groups.length - state.groupShownCount)}) ↓</button>`;
    bar.innerHTML = html;
  }
  function switchSection(section) {
    if (!TITLES[section]) return;
    state.section = section; state.group = '__all__'; state.groupShownCount = GROUPS_INITIAL;
    state.search = ''; state.shownCount = PAGE_SIZE;
    syncNav(); renderSectionMeta(); renderCategories(); renderItems(); closeSidebar();
  }

  function renderItems() {
    hideStatus();
    const grid = $('#contentGrid'), empty = $('#emptyState');
    let sourceItems = sectionItems();
    if (state.section !== 'favorites' && state.group !== '__all__') sourceItems = sourceItems.filter(item => (item.group || 'غير مصنّف') === state.group);
    const q = state.search.trim().toLocaleLowerCase();
    const visible = !q ? sourceItems : sourceItems.filter(item => `${item.name} ${item.group} ${item.tvgId}`.toLocaleLowerCase().includes(q));
    state.visibleItems = visible;
    const current = visible.slice(0, state.shownCount);
    $('#resultCount').textContent = `${formatCount(visible.length)} عنصر`;
    if (sourceItems.length === 0 || visible.length === 0) {
      grid.innerHTML = ''; empty.hidden = false;
      $('#emptyTitle').textContent = q ? 'لم نجد نتائج مطابقة' : (state.section === 'favorites' ? 'قائمة المفضلة فارغة' : 'لا يوجد محتوى لعرضه');
      $('#emptyText').textContent = q ? 'جرّب كلمة أخرى أو ابحث باسم المجموعة.' : (state.section === 'favorites' ? 'اضغط على رمز القلب في أي عنصر لحفظه هنا.' : 'قد لا تحتوي القائمة على هذا النوع من المحتوى، أو صنّف مزودها العناصر بطريقة مختلفة.');
      $('#retryButton').hidden = true;
      $('#loadMoreButton').hidden = true;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = current.map((item, index) => {
      const name = item.name || 'بدون اسم';
      const img = safeHttpUrl(item.logo);
      const fav = isFavorite(item);
      const type = item.mediaType || 'live';
      const badge = type === 'live' ? 'LIVE' : type === 'series' ? 'SERIES' : 'MOVIE';
      const sub = item.group && item.group !== 'غير مصنّف' ? item.group : (type === 'live' ? 'قناة مباشرة' : type === 'series' ? 'مسلسل / حلقة' : 'فيلم');
      const path = (() => { try { return new URL(item.url).pathname; } catch { return item.url; } })();
      const quality = /\.m3u8?$/i.test(path) ? 'HLS' : /\.mp4$/i.test(path) ? 'MP4' : /\.mkv$/i.test(path) ? 'MKV' : (type === 'live' ? 'LIVE' : 'PLAY');
      return `<article class="media-card" style="animation-delay:${Math.min(index % PAGE_SIZE, 12) * 12}ms">
        <div class="poster-button" role="group" aria-label="${escapeHtml(name)}">
          <button class="poster-button-inner" data-play="${index}" aria-label="تشغيل ${escapeHtml(name)}" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;padding:0;color:inherit">
            <span class="poster-placeholder">${escapeHtml(name.trim().slice(0, 1).toUpperCase() || 'X')}</span>
            ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
            <span class="poster-shade"></span><span class="poster-top"><span class="type-badge">${badge}</span></span><span class="poster-play">▶</span><span class="poster-bottom"><span>${escapeHtml(sub)}</span><span class="quality">${quality}</span></span>
          </button>
          <button class="favorite-button ${fav ? 'is-favorite' : ''}" data-favorite="${index}" aria-label="${fav ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}">${fav ? '♥' : '♡'}</button>
        </div>
        <div class="media-meta"><div class="media-title" title="${escapeHtml(name)}">${escapeHtml(name)}</div><div class="media-subtitle">${type === 'live' ? '<span class="channel-row"><i class="channel-dot"></i> بث مباشر</span>' : `<span>${escapeHtml(sub)}</span>`}<span>${type === 'series' ? 'حلقة' : type === 'movies' ? 'فيلم' : ''}</span></div></div>
      </article>`;
    }).join('');
    grid.querySelectorAll('.poster-button-inner img').forEach(img => img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true }));
    $('#loadMoreButton').hidden = visible.length <= state.shownCount;
    $('#loadMoreButton').innerHTML = `تحميل المزيد <span>↓</span> <small>(${formatCount(visible.length - state.shownCount)} متبقٍ)</small>`;
  }

  function destroyHls() { if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; } }
  function playerMessage(title, text, show = true) {
    $('#playerMessageTitle').textContent = title;
    $('#playerMessageText').textContent = text;
    $('#playerOverlayMessage').classList.toggle('is-hidden', !show);
  }
  async function openPlayer(item) {
    state.currentPlayback = item;
    $('#playerTitle').textContent = item.name || 'تشغيل الآن';
    $('#playerTypeLabel').textContent = item.mediaType === 'live' ? 'بث مباشر' : item.mediaType === 'series' ? 'حلقة من قائمة التشغيل' : 'تشغيل فيديو';
    $('#playerBottomStatus').textContent = 'جارٍ الاتصال بالمصدر';
    $('#playerModal').hidden = false; document.body.style.overflow = 'hidden';
    playerMessage('جارٍ تجهيز البث', 'يعتمد التشغيل على صيغة الرابط ودعم المتصفح.');
    destroyHls();
    const video = $('#videoPlayer');
    video.pause(); video.removeAttribute('src'); video.load();
    const src = safeHttpUrl(item.url);
    if (!src) { playerMessage('رابط غير صالح', 'لم نتمكن من قراءة عنوان تشغيل صالح لهذا العنصر.'); return; }
    const isHls = /\.m3u8(?:$|\?)/i.test(src);
    video.onerror = () => {
      $('#playerBottomStatus').textContent = 'تعذر تشغيل المصدر';
      playerMessage('تعذر تشغيل هذا المصدر', 'تحقق من صلاحية الرابط. بعض الصيغ أو سيرفرات البث لا تعمل في متصفح التلفاز، وقد تتطلب HLS عبر HTTPS مع CORS.');
    };
    video.onplaying = () => { $('#playerBottomStatus').textContent = 'يعمل الآن'; playerMessage('', '', false); };
    video.onwaiting = () => { $('#playerBottomStatus').textContent = 'جارٍ تحميل البث…'; };
    video.oncanplay = () => { if (!video.paused) playerMessage('', '', false); };
    if (location.protocol === 'https:' && new URL(src).protocol === 'http:') {
      playerMessage('المصدر يستخدم HTTP', 'قد يمنع المتصفح هذا البث لأن الموقع يعمل عبر HTTPS. يلزم رابط HTTPS متوافق أو وسيط آمن تملكه.');
    }
    if (isHls && window.Hls && Hls.isSupported()) {
      state.hls = new Hls({ enableWorker: true, lowLatencyMode: item.mediaType === 'live', liveSyncDurationCount: 3, maxBufferLength: 30, backBufferLength: 30, capLevelToPlayerSize: true });
      state.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        $('#playerBottomStatus').textContent = 'هناك مشكلة في البث';
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) state.hls?.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) state.hls?.recoverMediaError();
        else playerMessage('تعذر تشغيل البث', 'تحقق من الرابط أو دعم صيغة HLS وسياسة CORS لدى السيرفر.');
      });
      state.hls.loadSource(src); state.hls.attachMedia(video);
      state.hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => playerMessage('اضغط تشغيل', 'قد يمنع المتصفح التشغيل التلقائي. اضغط زر التشغيل داخل الفيديو.')));
    } else {
      video.src = src;
      if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
        playerMessage('المتصفح لا يدعم HLS هنا', 'تحتاج إلى متصفح متوافق أو رابط MP4/صيغة مدعومة.');
        return;
      }
      video.load(); video.play().catch(() => playerMessage('اضغط تشغيل', 'اضغط زر التشغيل داخل الفيديو إذا لم يبدأ تلقائيًا.'));
    }
  }
  function closePlayer() {
    $('#playerModal').hidden = true;
    const video = $('#videoPlayer'); video.pause(); video.removeAttribute('src'); video.load();
    destroyHls();
    document.body.style.overflow = '';
  }
  function closeSidebar() { $('#sidebar').classList.remove('open'); }

  // URL list handling: URLs and their credentials are stored only in this browser's localStorage.
  // Save-only action: this must work even if the provider blocks CORS or the playlist is offline.
  $('#savePlaylistOnlyButton').addEventListener('click', () => {
    clearLoginError();
    try {
      const playlist = addOrUpdatePlaylist($('#playlistUrlInput').value, $('#playlistNameInput').value);
      renderSavedPlaylists();
      showToast(`تم حفظ «${playlist.name || hostOf(playlist.url)}» على هذا الجهاز. يمكنك فتحها لاحقًا من القوائم المحفوظة.`, 'success');
      $('#playlistUrlInput').value = '';
      $('#playlistNameInput').value = '';
    } catch (error) {
      showLoginError(error.message || 'تعذّر حفظ الرابط. تحقق من الرابط وحاول مرة أخرى.');
    }
  });

  $('#playlistForm').addEventListener('submit', async event => {
    event.preventDefault(); clearLoginError();
    try {
      const playlist = addOrUpdatePlaylist($('#playlistUrlInput').value, $('#playlistNameInput').value);
      renderSavedPlaylists();
      showToast('تم حفظ الرابط. جارٍ محاولة تحميل محتوى القائمة…');
      await loadPlaylist(playlist);
    } catch (error) { showLoginError(error.message || 'تحقق من رابط القائمة.'); }
  });
  $('#savedPlaylistList').addEventListener('click', async event => {
    const use = event.target.closest('[data-use-playlist]');
    const open = event.target.closest('[data-open-playlist]');
    const remove = event.target.closest('[data-remove-playlist]');
    const rename = event.target.closest('[data-rename-playlist]');
    if (use) { await loadPlaylistById(use.dataset.usePlaylist); return; }
    if (open) {
      const playlist = state.playlists.find(p => p.id === open.dataset.openPlaylist);
      if (playlist) window.open(playlist.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (remove) {
      const playlist = state.playlists.find(p => p.id === remove.dataset.removePlaylist);
      if (!playlist) return;
      if (!confirm(`حذف القائمة المحفوظة «${playlist.name || hostOf(playlist.url)}» من هذا الجهاز؟`)) return;
      state.playlists = state.playlists.filter(p => p.id !== playlist.id);
      saveSavedPlaylists();
      if (state.activePlaylist?.id === playlist.id) { state.activePlaylist = null; state.allItems = []; state.favorites = []; $('#appView').hidden = true; $('#authView').hidden = false; }
      showToast('تم حذف القائمة المحفوظة.'); return;
    }
    if (rename) {
      const playlist = state.playlists.find(p => p.id === rename.dataset.renamePlaylist);
      if (!playlist) return;
      const nextName = prompt('اكتب اسمًا جديدًا للقائمة:', playlist.name || '');
      if (nextName === null) return;
      if (nextName.trim()) playlist.name = nextName.trim();
      saveSavedPlaylists();
      if (state.activePlaylist?.id === playlist.id) { $('#providerName').textContent = playlist.name; }
    }
  });

  $('#playlistFileInput').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    clearLoginError(); setLoading(true, 'جارٍ استيراد الملف', `نقرأ ${file.name}`);
    try {
      const items = parseM3UText(await file.text(), location.href);
      if (!items.length) throw new Error('لم نعثر على أي عناصر قابلة للتشغيل داخل الملف.');
      state.activePlaylist = { id: `local-${makeId()}`, name: file.name, url: location.href, localFile: true, itemCount: items.length };
      state.allItems = items; state.section = 'live'; state.group = '__all__'; state.groupShownCount = GROUPS_INITIAL; state.search = ''; state.shownCount = PAGE_SIZE;
      $('#searchInput').value = ''; loadFavorites(); // local-file favourites are session-only because this file has no persistent URL.
      $('#authView').hidden = true; $('#appView').hidden = false;
      $('#connectionLabel').textContent = 'ملف محلي'; $('#providerName').textContent = file.name; $('#providerHost').textContent = 'مستورد من الجهاز';
      updateNavCounts(); syncNav(); renderSectionMeta(); renderCategories(); renderItems();
      setLoading(false); showToast(`تم استيراد ${formatCount(items.length)} عنصر من الملف.`, 'success');
    } catch (error) { setLoading(false); showLoginError(error.message || 'تعذّر استيراد الملف.'); }
    finally { event.target.value = ''; }
  });
  $('#openPlaylistUrlButton').addEventListener('click', () => {
    const raw = $('#playlistUrlInput').value.trim();
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      window.open(url.href, '_blank', 'noopener,noreferrer');
    } catch { showLoginError('الصق رابط القائمة أولًا ثم افتحه للتنزيل.'); }
  });

  $$('.nav-item').forEach(button => button.addEventListener('click', () => switchSection(button.dataset.section)));
  $('#categoryBar').addEventListener('click', event => {
    const more = event.target.closest('[data-show-groups]');
    if (more) { state.groupShownCount += GROUPS_INITIAL; renderCategories(); return; }
    const button = event.target.closest('[data-category]'); if (!button) return;
    state.group = button.dataset.category; state.shownCount = PAGE_SIZE;
    renderCategories(); renderItems();
  });
  $('#searchInput').addEventListener('input', event => { state.search = event.target.value; state.shownCount = PAGE_SIZE; renderItems(); });
  $('#loadMoreButton').addEventListener('click', () => { state.shownCount += PAGE_SIZE; renderItems(); });
  $('#contentGrid').addEventListener('click', event => {
    const favButton = event.target.closest('[data-favorite]');
    if (favButton) { const item = state.visibleItems[Number(favButton.dataset.favorite)]; if (item) toggleFavorite(item); return; }
    const playButton = event.target.closest('[data-play]');
    if (playButton) { const item = state.visibleItems[Number(playButton.dataset.play)]; if (item) openPlayer(item); }
  });
  $('#heroExploreButton').addEventListener('click', () => $('#categoryBar').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  $('#disconnectButton').addEventListener('click', () => {
    closePlayer(); state.activePlaylist = null; state.allItems = []; state.favorites = [];
    $('#appView').hidden = true; $('#authView').hidden = false;
    $('#playlistUrlInput').value = ''; $('#playlistNameInput').value = ''; clearLoginError();
    renderSavedPlaylists();
  });
  $('#closePlayerButton').addEventListener('click', closePlayer);
  $('#playerModal').addEventListener('click', event => { if (event.target === $('#playerModal')) closePlayer(); });
  $('#fullscreenButton').addEventListener('click', async () => {
    const stage = $('#playerStage');
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.requestFullscreen(); }
    catch { showToast('تعذر تفعيل ملء الشاشة في هذا المتصفح.', 'error'); }
  });
  $('#pipButton').addEventListener('click', async () => {
    const video = $('#videoPlayer');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled && video.readyState >= 1) await video.requestPictureInPicture();
      else showToast('ميزة صورة داخل صورة غير مدعومة في هذا المتصفح.', 'error');
    } catch { showToast('تعذر فتح صورة داخل صورة.', 'error'); }
  });
  $('#alternateSourceButton').addEventListener('click', () => { if (state.currentPlayback) openPlayer(state.currentPlayback); });
  $('#pageFullscreenButton').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else { showToast('ملء الشاشة غير مدعوم في هذا المتصفح.', 'error'); return; }
    } catch { showToast('تعذر تفعيل ملء الشاشة. افتح الموقع مباشرةً من المتصفح.', 'error'); }
  });
  document.addEventListener('fullscreenchange', () => {
    const button = $('#pageFullscreenButton');
    const active = Boolean(document.fullscreenElement);
    button.innerHTML = active ? '⛶ <span>إنهاء ملء الشاشة</span>' : '⛶ <span>ملء الشاشة</span>';
    button.setAttribute('aria-label', active ? 'إنهاء ملء الشاشة' : 'ملء شاشة الموقع');
    button.title = active ? 'إنهاء ملء الشاشة' : 'ملء شاشة الموقع';
  });
  $('#mobileMenuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (!$('#playerModal').hidden) closePlayer(); closeSidebar(); }
  });
  document.addEventListener('click', event => {
    if (window.innerWidth <= 760 && $('#sidebar').classList.contains('open') && !event.target.closest('#sidebar') && !event.target.closest('#mobileMenuButton')) closeSidebar();
  });

  loadSavedPlaylists();
  $('#playlistUrlInput').focus({ preventScroll: true });
})();
