(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const PAGE_SIZE = 48;
  const SESSION_KEY = 'zeroX.session.v1';
  const FAVORITES_PREFIX = 'zeroX.favorites.v1:';

  const TITLES = {
    live: { title: 'القنوات المباشرة', crumb: 'القنوات', subtitle: 'تابع قنواتك المفضلة مباشرةً.', categories: 'تصنيفات القنوات', action: 'get_live_categories', streams: 'get_live_streams', label: 'مباشر', path: 'live' },
    movies: { title: 'الأفلام', crumb: 'الأفلام', subtitle: 'اكتشف مكتبة الأفلام حسب التصنيف.', categories: 'تصنيفات الأفلام', action: 'get_vod_categories', streams: 'get_vod_streams', label: 'فيلم', path: 'movie' },
    series: { title: 'المسلسلات', crumb: 'المسلسلات', subtitle: 'تابع المسلسلات ومواسمها وحلقاتها.', categories: 'تصنيفات المسلسلات', action: 'get_series_categories', streams: 'get_series', label: 'مسلسل', path: 'series' },
    favorites: { title: 'المفضلة', crumb: 'المفضلة', subtitle: 'كل ما حفظته في مكان واحد.', categories: 'المحتوى المحفوظ', label: 'مفضل' }
  };

  const state = {
    server: '', username: '', password: '', userInfo: null,
    section: 'live', categories: { live: [], movies: [], series: [] },
    selectedCategory: { live: '', movies: '', series: '' },
    categoryCache: new Map(), allLoaded: { live: false, movies: false, series: false },
    items: [], visibleItems: [], shownCount: PAGE_SIZE, search: '', favorites: [],
    hls: null, currentPlayback: null, playbackTry: 0, currentSeries: null,
    toastTimer: null, loading: false
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }
  function safeUrl(value) {
    try { const url = new URL(String(value || ''), location.href); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
    catch { return ''; }
  }
  function normalizeServer(value) {
    let server = String(value || '').trim().replace(/\/+$/, '').replace(/\/player_api\.php$/i, '');
    if (!server) throw new Error('أدخل رابط السيرفر أولاً.');
    if (!/^https?:\/\//i.test(server)) server = `https://${server}`;
    let parsed;
    try { parsed = new URL(server); } catch { throw new Error('رابط السيرفر غير صحيح.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('استخدم رابطًا يبدأ بـ http أو https.');
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  }
  function keyFor(item, mediaType = item?.mediaType || state.section) {
    const id = item?.stream_id ?? item?.series_id ?? item?.id;
    return `${mediaType}:${id}`;
  }
  function itemId(item, type) { return type === 'series' ? item?.series_id : (item?.stream_id ?? item?.id); }
  function itemName(item) { return item?.name || item?.title || 'بدون اسم'; }
  function mediaImage(item, type) { return type === 'series' ? (item?.cover || item?.stream_icon) : (item?.stream_icon || item?.cover); }
  function formatCount(num) {
    const n = Number(num) || 0;
    return n.toLocaleString('en-US');
  }
  function showToast(message, kind = '') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast show ${kind}`.trim();
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = 'toast'; }, 4200);
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
  function showLoginError(message) {
    const box = $('#loginError'); box.hidden = false; box.textContent = message;
  }
  function setLoading(show, title = 'جارٍ الاتصال', text = 'نجهز مكتبتك الآن') {
    state.loading = show;
    $('#loadingOverlay').hidden = !show;
    $('#loadingOverlayTitle').textContent = title;
    $('#loadingOverlayText').textContent = text;
  }

  async function api(action, extra = {}) {
    const endpoint = new URL(`${state.server.replace(/\/$/, '')}/player_api.php`);
    endpoint.searchParams.set('username', state.username);
    endpoint.searchParams.set('password', state.password);
    if (action) endpoint.searchParams.set('action', action);
    for (const [key, value] of Object.entries(extra)) {
      if (value !== '' && value !== null && value !== undefined) endpoint.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch(endpoint.href, { method: 'GET', cache: 'no-store', signal: controller.signal, headers: { 'Accept': 'application/json' } });
      if (!response.ok) throw new Error(`السيرفر أعاد الخطأ HTTP ${response.status}.`);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('استجابة السيرفر ليست JSON صالحًا. تحقق من رابط Xtream.'); }
      if (data && !Array.isArray(data) && data.error && !data.user_info) throw new Error(String(data.error));
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('انتهت مهلة الاتصال. جرّب مجددًا أو تحقق من استجابة السيرفر.');
      if (error instanceof TypeError) {
        throw new Error('تعذر الوصول من المتصفح. قد يمنع السيرفر CORS أو يستخدم HTTP فقط. جرّب رابط HTTPS يدعم CORS؛ وإلا ستحتاج إلى وسيط Backend خاص بك.');
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function loadFavorites() {
    try {
      const raw = localStorage.getItem(`${FAVORITES_PREFIX}${state.server}|${state.username}`);
      state.favorites = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.favorites)) state.favorites = [];
    } catch { state.favorites = []; }
    updateFavoriteCount();
  }
  function saveFavorites() {
    try { localStorage.setItem(`${FAVORITES_PREFIX}${state.server}|${state.username}`, JSON.stringify(state.favorites)); }
    catch { showToast('تعذر حفظ المفضلة في هذا المتصفح.', 'error'); }
    updateFavoriteCount();
  }
  function updateFavoriteCount() { $('#favoritesCount').textContent = formatCount(state.favorites.length); }

  function categoriesFor(section = state.section) { return state.categories[section] || []; }
  function normalizeList(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    return [];
  }

  async function connect(server, username, password, restored = false) {
    state.server = normalizeServer(server);
    state.username = String(username || '').trim();
    state.password = String(password || '');
    if (!state.username || !state.password) throw new Error('أدخل اسم المستخدم وكلمة المرور.');
    setLoading(true, 'جارٍ التحقق من الحساب', 'نتصل بسيرفر Xtream Codes');
    try {
      const auth = await api(null);
      const userInfo = auth?.user_info;
      if (!userInfo || !(String(userInfo.auth) === '1' || String(userInfo.status || '').toLowerCase() === 'active')) {
        throw new Error(userInfo?.message || 'تعذر تسجيل الدخول. تحقق من السيرفر وبيانات الاشتراك.');
      }
      state.userInfo = userInfo;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ server: state.server, username: state.username, password: state.password }));
      loadFavorites();
      $('#authView').hidden = true;
      $('#appView').hidden = false;
      $('#connectionLabel').textContent = 'متصل';
      $('#providerHost').textContent = new URL(state.server).host;
      await loadAllCategories();
      setLoading(false);
      state.section = 'live';
      state.search = '';
      $('#searchInput').value = '';
      syncNav();
      renderSectionMeta();
      const firstCategory = state.categories.live[0];
      if (firstCategory) await selectCategory('live', String(firstCategory.category_id ?? firstCategory.id ?? ''));
      else await loadSectionItems('live', '');
      if (restored) showToast('تمت استعادة جلسة الاتصال.', 'success');
    } catch (error) {
      setLoading(false);
      if (!restored) {
        $('#authView').hidden = false;
        $('#appView').hidden = true;
      }
      throw error;
    }
  }

  async function loadAllCategories() {
    showStatus('جارٍ تحميل التصنيفات', 'نحمّل أسماء التصنيفات أولًا لتجنب تنزيل المكتبة كاملة.');
    const tasks = ['live', 'movies', 'series'].map(async section => {
      try {
        state.categories[section] = normalizeList(await api(TITLES[section].action));
      } catch (error) {
        state.categories[section] = [];
        console.warn(`Could not load ${section} categories`, error);
      }
    });
    await Promise.all(tasks);
    $('#liveCount').textContent = formatCount(state.categories.live.length);
    $('#moviesCount').textContent = formatCount(state.categories.movies.length);
    $('#seriesCount').textContent = formatCount(state.categories.series.length);
    hideStatus();
  }

  function syncNav() {
    $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.section === state.section));
  }
  function renderSectionMeta() {
    const meta = TITLES[state.section];
    $('#breadcrumb').innerHTML = `الرئيسية <span>／</span> ${escapeHtml(meta.crumb)}`;
    $('#pageTitle').textContent = meta.title;
    $('#pageSubtitle').textContent = meta.subtitle;
    $('#categoryHeading').textContent = meta.categories;
    $('#heroBanner').hidden = state.section === 'favorites';
    $('#categoryBar').hidden = state.section === 'favorites';
    $('#searchInput').value = state.search;
    renderCategories();
  }
  function renderCategories() {
    const bar = $('#categoryBar');
    if (state.section === 'favorites') { bar.innerHTML = ''; return; }
    const categories = categoriesFor();
    const selected = state.selectedCategory[state.section];
    const allLoaded = state.allLoaded[state.section];
    let html = `<button class="category-chip ${selected === '__all__' ? 'active' : ''}" data-category="__all__">كل التصنيفات</button>`;
    html += categories.map(cat => {
      const id = String(cat.category_id ?? cat.id ?? '');
      const name = cat.category_name || cat.name || 'تصنيف';
      return `<button class="category-chip ${id === selected ? 'active' : ''}" data-category="${escapeHtml(id)}">${escapeHtml(name)}</button>`;
    }).join('');
    if (!categories.length) html += `<button class="category-chip active" data-category="__all__">كل المحتوى</button>`;
    bar.innerHTML = html;
  }

  async function switchSection(section) {
    if (!TITLES[section]) return;
    state.section = section;
    state.search = '';
    $('#searchInput').value = '';
    state.shownCount = PAGE_SIZE;
    syncNav(); renderSectionMeta(); closeSidebar();
    if (section === 'favorites') {
      state.items = state.favorites.map(f => ({ ...f.item, mediaType: f.mediaType }));
      renderItems(); return;
    }
    const chosen = state.selectedCategory[section];
    if (chosen && chosen !== '__all__') await loadSectionItems(section, chosen);
    else if (state.categories[section][0]) await selectCategory(section, String(state.categories[section][0].category_id ?? state.categories[section][0].id ?? ''));
    else await loadSectionItems(section, '');
  }

  async function selectCategory(section, categoryId) {
    state.section = section;
    state.selectedCategory[section] = categoryId;
    state.shownCount = PAGE_SIZE;
    state.search = '';
    $('#searchInput').value = '';
    syncNav(); renderSectionMeta();
    await loadSectionItems(section, categoryId);
  }

  async function loadSectionItems(section, categoryId = '') {
    state.section = section;
    const cacheKey = `${section}:${categoryId || '__all__'}`;
    if (state.categoryCache.has(cacheKey)) {
      state.items = state.categoryCache.get(cacheKey);
      renderSectionMeta(); renderItems(); return;
    }
    showStatus('جارٍ تحميل المحتوى', categoryId && categoryId !== '__all__' ? 'نطلب عناصر هذا التصنيف فقط لتقليل الحمل.' : 'تحميل المكتبة كاملة قد يستغرق وقتًا في القوائم الكبيرة جدًا.');
    $('#retryButton').hidden = true;
    try {
      const action = TITLES[section].streams;
      const extra = categoryId && categoryId !== '__all__' ? { category_id: categoryId } : {};
      const list = normalizeList(await api(action, extra)).map(item => ({ ...item, mediaType: section }));
      state.categoryCache.set(cacheKey, list);
      state.items = list;
      if (!categoryId || categoryId === '__all__') state.allLoaded[section] = true;
      hideStatus();
      renderSectionMeta(); renderItems();
      if (list.length > 15000) showToast(`تم استلام ${formatCount(list.length)} عنصر. العرض مقسّم لتقليل الضغط على الواجهة.`, 'success');
    } catch (error) {
      hideStatus(); state.items = [];
      $('#contentGrid').innerHTML = '';
      $('#emptyState').hidden = false;
      $('#emptyTitle').textContent = 'تعذر تحميل هذا التصنيف';
      $('#emptyText').textContent = error.message;
      $('#retryButton').hidden = false;
      $('#resultCount').textContent = '';
    }
  }

  function isFavorite(item, mediaType) {
    const key = keyFor(item, mediaType);
    return state.favorites.some(f => keyFor(f.item, f.mediaType) === key);
  }
  function toggleFavorite(item, mediaType) {
    const key = keyFor(item, mediaType);
    const idx = state.favorites.findIndex(f => keyFor(f.item, f.mediaType) === key);
    if (idx >= 0) {
      state.favorites.splice(idx, 1); showToast('تمت الإزالة من المفضلة.');
    } else {
      state.favorites.unshift({ mediaType, item: { ...item, mediaType } }); showToast('أُضيف إلى المفضلة.', 'success');
    }
    saveFavorites();
    if (state.section === 'favorites') {
      state.items = state.favorites.map(f => ({ ...f.item, mediaType: f.mediaType }));
      renderItems();
    } else renderItems();
  }

  function renderItems() {
    hideStatus();
    const grid = $('#contentGrid');
    const empty = $('#emptyState');
    const q = state.search.trim().toLocaleLowerCase();
    const sourceItems = state.section === 'favorites' ? state.favorites.map(f => ({ ...f.item, mediaType: f.mediaType })) : state.items;
    const visible = !q ? sourceItems : sourceItems.filter(item => itemName(item).toLocaleLowerCase().includes(q));
    state.visibleItems = visible;
    const current = visible.slice(0, state.shownCount);
    $('#resultCount').textContent = `${formatCount(visible.length)} عنصر`;
    if (sourceItems.length === 0 || visible.length === 0) {
      grid.innerHTML = ''; empty.hidden = false;
      $('#emptyTitle').textContent = q ? 'لم نجد نتائج مطابقة' : (state.section === 'favorites' ? 'قائمة المفضلة فارغة' : 'لا يوجد محتوى لعرضه');
      $('#emptyText').textContent = q ? 'جرّب كلمة أخرى أو ابحث باسم مختلف.' : (state.section === 'favorites' ? 'اضغط على رمز القلب في أي عنصر لحفظه هنا.' : 'تحقق من تصنيفات مزود الخدمة أو اختر تصنيفًا آخر.');
      $('#retryButton').hidden = state.section === 'favorites';
      $('#loadMoreButton').hidden = true;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = current.map((item, index) => {
      const type = item.mediaType || state.section;
      const name = itemName(item);
      const img = safeUrl(mediaImage(item, type));
      const fav = isFavorite(item, type);
      const rating = item.rating ? `<span class="rating-badge">★ ${escapeHtml(item.rating)}</span>` : '';
      const sub = type === 'live' ? (item.epg_channel_id ? 'قناة مباشرة' : 'بث مباشر') : type === 'series' ? (item.genre || item.releaseDate || 'مسلسل') : (item.releaseDate || item.year || item.container_extension?.toUpperCase?.() || 'فيلم');
      const badge = type === 'live' ? 'LIVE' : type === 'series' ? 'SERIES' : 'MOVIE';
      const bottomLeft = type === 'live' ? '<span class="quality">LIVE</span>' : (item.container_extension ? `<span class="quality">${escapeHtml(String(item.container_extension).toUpperCase())}</span>` : '<span class="quality">HD</span>');
      return `<article class="media-card" style="animation-delay:${Math.min(index % PAGE_SIZE, 12) * 16}ms">
        <div class="poster-button" role="group" aria-label="${escapeHtml(name)}">
          <button class="poster-button-inner" data-play="${index}" aria-label="${type === 'series' ? 'تفاصيل ' : 'تشغيل '}${escapeHtml(name)}" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;padding:0;color:inherit">
            <span class="poster-placeholder">${escapeHtml(name.trim().slice(0,1).toUpperCase() || 'X')}</span>
            ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
            <span class="poster-shade"></span><span class="poster-top"><span class="type-badge">${badge}</span>${rating}</span><span class="poster-play">▶</span><span class="poster-bottom"><span>${escapeHtml(sub)}</span>${bottomLeft}</span>
          </button>
          <button class="favorite-button ${fav ? 'is-favorite' : ''}" data-favorite="${index}" aria-label="${fav ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}">${fav ? '♥' : '♡'}</button>
        </div>
        <div class="media-meta"><div class="media-title" title="${escapeHtml(name)}">${escapeHtml(name)}</div><div class="media-subtitle">${type === 'live' ? '<span class="channel-row"><i class="channel-dot"></i> بث مباشر</span>' : `<span>${escapeHtml(sub)}</span>`}<span>${type === 'series' ? 'مسلسل' : type === 'movies' ? 'فيلم' : type === 'movie' ? 'فيلم' : ''}</span></div></div>
      </article>`;
    }).join('');
    grid.querySelectorAll('.poster-button-inner img').forEach(img => img.addEventListener('error', () => img.style.display = 'none', { once: true }));
    $('#loadMoreButton').hidden = visible.length <= state.shownCount;
    $('#loadMoreButton').innerHTML = `تحميل المزيد <span>↓</span> <small>(${formatCount(visible.length - state.shownCount)} متبقٍ)</small>`;
  }

  function getStreamUrl(item, mediaType, tryIndex = 0) {
    const id = itemId(item, mediaType);
    if (id === undefined || id === null) throw new Error('لم يعثر المشغل على معرّف البث لهذا العنصر.');
    const u = encodeURIComponent(state.username), p = encodeURIComponent(state.password), encodedId = encodeURIComponent(String(id));
    let extension;
    if (mediaType === 'live') extension = tryIndex === 1 ? 'ts' : 'm3u8';
    else if (mediaType === 'series' && item.__episode) extension = item.container_extension || item.__episode.container_extension || 'mkv';
    else extension = item.container_extension || (tryIndex === 1 ? 'm3u8' : 'mp4');
    if (tryIndex === 1 && mediaType !== 'live' && !item.__episode) extension = 'm3u8';
    return `${state.server.replace(/\/$/, '')}/${TITLES[mediaType].path}/${u}/${p}/${encodedId}.${encodeURIComponent(extension)}`;
  }

  function destroyHls() {
    if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; }
  }
  function playerMessage(title, text, show = true) {
    $('#playerMessageTitle').textContent = title;
    $('#playerMessageText').textContent = text;
    $('#playerOverlayMessage').classList.toggle('is-hidden', !show);
  }
  async function openPlayer(item, mediaType, tryIndex = 0) {
    state.currentPlayback = { item, mediaType };
    state.playbackTry = tryIndex;
    $('#playerTitle').textContent = itemName(item);
    $('#playerTypeLabel').textContent = mediaType === 'live' ? 'بث مباشر' : mediaType === 'series' ? 'حلقة من مسلسل' : 'تشغيل فيلم';
    $('#playerBottomStatus').textContent = 'جارٍ الاتصال بالمصدر';
    $('#playerModal').hidden = false;
    document.body.style.overflow = 'hidden';
    playerMessage('جارٍ تجهيز البث', 'يتم تحميل المصدر من مزود الخدمة.');
    destroyHls();
    const video = $('#videoPlayer');
    video.pause(); video.removeAttribute('src'); video.load();
    let src;
    try { src = getStreamUrl(item, mediaType, tryIndex); }
    catch (error) { playerMessage('تعذر تجهيز الرابط', error.message); return; }
    const isHls = /\.m3u8(?:$|\?)/i.test(src);
    video.onerror = () => {
      $('#playerBottomStatus').textContent = 'تعذر تشغيل المصدر';
      playerMessage('تعذر تشغيل هذا المصدر', 'قد تكون الصيغة غير مدعومة أو أن السيرفر يمنع التشغيل عبر المتصفح. جرّب الصيغة البديلة أو تحقق من صلاحية البث.');
    };
    video.onplaying = () => { $('#playerBottomStatus').textContent = 'يعمل الآن'; playerMessage('', '', false); };
    video.onwaiting = () => { $('#playerBottomStatus').textContent = 'جارٍ تحميل البث…'; };
    video.oncanplay = () => { if (!video.paused) playerMessage('', '', false); };
    if (isHls && window.Hls && Hls.isSupported()) {
      state.hls = new Hls({ enableWorker: true, lowLatencyMode: mediaType === 'live', liveSyncDurationCount: 3, maxBufferLength: 30, backBufferLength: 30, capLevelToPlayerSize: true });
      state.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        $('#playerBottomStatus').textContent = 'هناك مشكلة في البث';
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) state.hls?.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) state.hls?.recoverMediaError();
        else playerMessage('تعذر تشغيل البث', 'تحقق من صلاحية الرابط أو جرّب صيغة بديلة.');
      });
      state.hls.loadSource(src);
      state.hls.attachMedia(video);
      state.hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => playerMessage('اضغط تشغيل', 'قد يمنع المتصفح التشغيل التلقائي. اضغط زر التشغيل داخل الفيديو.')); });
    } else {
      video.src = src;
      if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
        playerMessage('المتصفح لا يدعم HLS هنا', 'تحتاج إلى متصفح متوافق أو رابط MP4/صيغة مدعومة.');
        return;
      }
      video.load();
      video.play().catch(() => playerMessage('اضغط تشغيل', 'قد يمنع المتصفح التشغيل التلقائي. اضغط زر التشغيل داخل الفيديو.'));
    }
  }
  function closePlayer() {
    $('#playerModal').hidden = true;
    const video = $('#videoPlayer'); video.pause(); video.removeAttribute('src'); video.load();
    destroyHls();
    if ($('#seriesModal').hidden) document.body.style.overflow = '';
  }

  async function openSeries(item) {
    $('#seriesModal').hidden = false; document.body.style.overflow = 'hidden';
    $('#seriesModalTitle').textContent = itemName(item);
    $('#seriesDetails').innerHTML = '<div class="spinner"></div><p style="color:#8992a8;font-size:10px">جارٍ تحميل المواسم والحلقات...</p>';
    state.currentSeries = item;
    try {
      const details = await api('get_series_info', { series_id: item.series_id ?? item.id });
      const info = details?.info || {};
      const episodesObj = details?.episodes || {};
      const seasons = Object.keys(episodesObj).sort((a, b) => Number(a) - Number(b));
      let html = info.plot ? `<p class="series-plot">${escapeHtml(info.plot)}</p>` : '';
      if (!seasons.length) {
        html += '<p class="series-plot">لم يعرض السيرفر حلقات لهذا المسلسل.</p>';
      } else {
        seasons.forEach(season => {
          const episodes = Array.isArray(episodesObj[season]) ? episodesObj[season] : [];
          html += `<h3 class="season-title">الموسم ${escapeHtml(season)} <span style="color:#737d93;font-weight:400">— ${episodes.length} حلقة</span></h3><div class="episode-list">`;
          episodes.forEach((ep, i) => {
            const episodeName = ep.title || ep.name || `الحلقة ${i + 1}`;
            const episodeNo = ep.episode_num ?? (i + 1);
            html += `<button class="episode-button" data-episode="${escapeHtml(season)}:${i}"><span class="episode-play">▶</span><span class="episode-info"><b>${escapeHtml(episodeName)}</b><small>S${String(season).padStart(2, '0')} · E${String(episodeNo).padStart(2, '0')}</small></span></button>`;
          });
          html += '</div>';
        });
      }
      $('#seriesDetails').innerHTML = html;
      $('#seriesDetails').querySelectorAll('[data-episode]').forEach(button => button.addEventListener('click', () => {
        const [season, index] = button.dataset.episode.split(':');
        const ep = episodesObj[season]?.[Number(index)];
        if (!ep) return;
        const shaped = { ...ep, name: `${itemName(item)} — ${ep.title || ep.name || 'حلقة'}`, mediaType: 'series', __episode: ep };
        $('#seriesModal').hidden = true;
        openPlayer(shaped, 'series');
      }));
    } catch (error) {
      $('#seriesDetails').innerHTML = `<p class="series-plot">تعذر جلب حلقات المسلسل. ${escapeHtml(error.message)}</p>`;
    }
  }
  function closeSeries() {
    $('#seriesModal').hidden = true;
    if ($('#playerModal').hidden) document.body.style.overflow = '';
  }
  function closeSidebar() { $('#sidebar').classList.remove('open'); }

  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault(); $('#loginError').hidden = true; $('#connectButton').disabled = true;
    const server = $('#serverInput').value, username = $('#usernameInput').value, password = $('#passwordInput').value;
    try { await connect(server, username, password); }
    catch (error) { showLoginError(error.message || 'تعذر الاتصال. تحقق من البيانات وحاول مرة أخرى.'); }
    finally { $('#connectButton').disabled = false; }
  });
  $('#togglePassword').addEventListener('click', () => {
    const field = $('#passwordInput'); field.type = field.type === 'password' ? 'text' : 'password';
    $('#togglePassword').setAttribute('aria-label', field.type === 'password' ? 'إظهار كلمة المرور' : 'إخفاء كلمة المرور');
  });
  $$('.nav-item').forEach(button => button.addEventListener('click', () => switchSection(button.dataset.section)));
  $('#categoryBar').addEventListener('click', event => {
    const button = event.target.closest('[data-category]'); if (!button) return;
    const value = button.dataset.category;
    selectCategory(state.section, value === '__all__' ? '__all__' : value);
  });
  $('#searchInput').addEventListener('input', event => { state.search = event.target.value; state.shownCount = PAGE_SIZE; renderItems(); });
  $('#loadMoreButton').addEventListener('click', () => { state.shownCount += PAGE_SIZE; renderItems(); });
  $('#contentGrid').addEventListener('click', event => {
    const favButton = event.target.closest('[data-favorite]');
    if (favButton) {
      const item = state.visibleItems[Number(favButton.dataset.favorite)]; if (!item) return;
      toggleFavorite(item, item.mediaType || state.section); return;
    }
    const playButton = event.target.closest('[data-play]');
    if (playButton) {
      const item = state.visibleItems[Number(playButton.dataset.play)]; if (!item) return;
      const type = item.mediaType || state.section;
      if (type === 'series') openSeries(item); else openPlayer(item, type);
    }
  });
  $('#retryButton').addEventListener('click', () => {
    if (state.section === 'favorites') return;
    loadSectionItems(state.section, state.selectedCategory[state.section] || '');
  });
  $('#heroExploreButton').addEventListener('click', () => $('#categoryBar').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  $('#disconnectButton').addEventListener('click', () => {
    closePlayer(); closeSeries(); destroyHls();
    sessionStorage.removeItem(SESSION_KEY);
    state.server = state.username = state.password = ''; state.userInfo = null;
    state.categories = { live: [], movies: [], series: [] }; state.categoryCache.clear();
    $('#appView').hidden = true; $('#authView').hidden = false; $('#passwordInput').value = '';
    $('#loginError').hidden = true; $('#contentGrid').innerHTML = '';
  });
  $('#closePlayerButton').addEventListener('click', closePlayer);
  $('#closeSeriesButton').addEventListener('click', closeSeries);
  $('#playerModal').addEventListener('click', event => { if (event.target === $('#playerModal')) closePlayer(); });
  $('#seriesModal').addEventListener('click', event => { if (event.target === $('#seriesModal')) closeSeries(); });
  $('#fullscreenButton').addEventListener('click', async () => {
    const stage = $('#playerStage');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch { showToast('تعذر تفعيل ملء الشاشة في هذا المتصفح.', 'error'); }
  });
  $('#pipButton').addEventListener('click', async () => {
    const video = $('#videoPlayer');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled && video.readyState >= 1) await video.requestPictureInPicture();
      else showToast('ميزة صورة داخل صورة غير مدعومة في هذا المتصفح.', 'error');
    } catch { showToast('تعذر فتح صورة داخل صورة.', 'error'); }
  });
  $('#alternateSourceButton').addEventListener('click', () => {
    if (!state.currentPlayback) return;
    const nextTry = state.playbackTry === 0 ? 1 : 0;
    openPlayer(state.currentPlayback.item, state.currentPlayback.mediaType, nextTry);
  });
  $('#mobileMenuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!$('#playerModal').hidden) closePlayer();
      if (!$('#seriesModal').hidden) closeSeries();
      closeSidebar();
    }
  });
  document.addEventListener('click', event => {
    if (window.innerWidth <= 760 && $('#sidebar').classList.contains('open') && !event.target.closest('#sidebar') && !event.target.closest('#mobileMenuButton')) closeSidebar();
  });

  // Restore only this tab's session. Credentials are never placed in persistent localStorage.
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (saved?.server && saved?.username && saved?.password) {
      $('#serverInput').value = saved.server;
      $('#usernameInput').value = saved.username;
      $('#passwordInput').value = saved.password;
      connect(saved.server, saved.username, saved.password, true).catch(error => {
        sessionStorage.removeItem(SESSION_KEY); $('#authView').hidden = false; $('#appView').hidden = true;
        showLoginError(error.message || 'انتهت الجلسة؛ أدخل بياناتك من جديد.');
      });
    }
  } catch { sessionStorage.removeItem(SESSION_KEY); }
})();
