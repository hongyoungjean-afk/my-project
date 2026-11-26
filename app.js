/* 작업일지 — 서버 없이 브라우저(IndexedDB)에만 저장하는 현장 작업일지 */
'use strict';

/* ==================== 설정 ==================== */
const DB_NAME = 'jakeopilji';
const DB_VERSION = 1;
const PHOTO_MAX = 1600;     // 사진 긴 변 최대 픽셀
const PHOTO_QUALITY = 0.8;  // JPEG 품질
const THUMB_MAX = 240;      // 목록용 작은 사진
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/* ==================== 저장소 (IndexedDB) ====================
 * entries : { id, date, location, content, workers, photoCount, thumb, createdAt, updatedAt }
 * photos  : { id (= entry id), images: [dataURL, ...] }
 * 사진은 무거워서 목록을 빨리 띄우려고 따로 보관한다.
 */
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('이 브라우저는 저장 기능(IndexedDB)을 지원하지 않습니다.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) {
          db.createObjectStore('entries', { keyPath: 'id' }).createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('다른 창에서 작업일지가 열려 있습니다. 다른 창을 닫고 다시 열어 주세요.'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

/** stores 에 대해 트랜잭션을 열고 fn(storeMap) 이 돌려준 요청의 결과를 반환 */
async function withStores(names, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = {};
    names.forEach((n) => { stores[n] = t.objectStore(n); });
    let result;
    const req = fn(stores);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장이 취소되었습니다.'));
  });
}

const store = {
  allEntries: () => withStores(['entries'], 'readonly', (s) => s.entries.getAll()),
  entry: (id) => withStores(['entries'], 'readonly', (s) => s.entries.get(id)),
  photos: async (id) => {
    const rec = await withStores(['photos'], 'readonly', (s) => s.photos.get(id));
    return rec ? rec.images : [];
  },
  save: (entry, images) => withStores(['entries', 'photos'], 'readwrite', (s) => {
    s.entries.put(entry);
    s.photos.put({ id: entry.id, images });
  }),
  remove: (id) => withStores(['entries', 'photos'], 'readwrite', (s) => {
    s.entries.delete(id);
    s.photos.delete(id);
  }),
  saveMany: (items) => withStores(['entries', 'photos'], 'readwrite', (s) => {
    items.forEach(({ entry, images }) => {
      s.entries.put(entry);
      s.photos.put({ id: entry.id, images });
    });
  }),
};

function sortEntries(list) {
  return list.sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* 브라우저가 공간이 부족할 때 기록을 지우지 않도록 요청 (지원하는 브라우저만) */
function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { /* 무시 */ }
}

/* ==================== 날짜 도우미 ==================== */
function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(s) {
  if (!s) return '';
  const d = parseDate(s);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}
function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}년 ${m}월`;
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonth = (s) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* ==================== 화면 도우미 ==================== */
/** 안전하게 요소 만들기: 글자는 항상 textContent 로 넣는다 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const app = document.getElementById('app');
function show(...nodes) {
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function setTab(name) {
  document.querySelectorAll('.tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === name);
  });
}

function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}

/* ==================== 사진 줄이기 ==================== */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('사진을 읽을 수 없습니다.'));
    img.src = src;
  });
}

/** 사진 파일 → 크기 줄인 JPEG dataURL (요즘 브라우저는 사진 방향(EXIF)을 자동으로 바로잡음) */
async function resizeToDataURL(source, max, quality) {
  const isFile = source instanceof Blob;
  const url = isFile ? URL.createObjectURL(source) : source;
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    if (isFile) URL.revokeObjectURL(url);
  }
}

/* ==================== 목록 화면 ==================== */
function entryItem(e) {
  const thumb = e.thumb
    ? el('img', { class: 'thumb', src: e.thumb, alt: '' })
    : el('div', { class: 'thumb none', 'aria-hidden': 'true' }, '📝');
  const firstLine = (e.content || '').split('\n').find((l) => l.trim()) || '(작업 내용 없음)';
  const meta = [];
  if (e.workers) meta.push(`인원 ${e.workers}명`);
  if (e.photoCount) meta.push(`사진 ${e.photoCount}장`);
  return el('a', { class: 'item', href: `#/view/${encodeURIComponent(e.id)}` },
    thumb,
    el('div', { class: 'body' },
      el('div', { class: 'loc', text: e.location || '(위치 없음)' }),
      el('div', { class: 'snip', text: firstLine }),
      meta.length ? el('div', { class: 'meta', text: meta.join(' · ') }) : null),
    el('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
}

/** 날짜별로 묶어서 보여주기 */
function groupedList(entries) {
  const frag = document.createDocumentFragment();
  let lastDate = null;
  for (const e of entries) {
    if (e.date !== lastDate) {
      frag.append(el('div', { class: 'day-head', text: fmtDate(e.date) }));
      lastDate = e.date;
    }
    frag.append(entryItem(e));
  }
  return frag;
}

async function viewList() {
  setTab('list');
  const entries = sortEntries(await store.allEntries());
  if (!entries.length) {
    show(el('div', { class: 'empty' },
      el('p', null, '아직 기록이 없습니다.'),
      el('p', null, '오늘 한 작업을 기록해 보세요.'),
      el('a', { class: 'btn primary', href: '#/new' }, '＋ 첫 기록 쓰기')));
    return;
  }
  show(
    el('h1', null, '작업 기록 ', el('span', { class: 'muted', text: `(${entries.length}건)` })),
    el('a', { class: 'btn primary block', href: '#/new', style: 'margin-bottom:18px' }, '＋ 새 작업 기록'),
    groupedList(entries));
}

/* ==================== 쓰기 / 고치기 화면 ==================== */
async function viewForm(id) {
  setTab(id ? '' : 'new');
  let entry = null;
  let images = [];
  if (id) {
    entry = await store.entry(id);
    if (!entry) { notFound(); return; }
    images = (await store.photos(id)).slice();
  }

  let busyCount = 0;
  let dirty = false;

  const dateIn = el('input', { type: 'date', id: 'f-date', required: true, value: entry ? entry.date : todayStr() });
  const locIn = el('input', {
    type: 'text', id: 'f-loc', value: entry ? entry.location : '',
    placeholder: '예) 남한산성 등산로 3구간', autocomplete: 'off', enterkeyhint: 'next',
  });
  const contentIn = el('textarea', {
    id: 'f-content', placeholder: '예)\n- 배수로 낙엽 제거\n- 계단 목재 2곳 교체\n- 안내판 청소',
  });
  contentIn.value = entry ? entry.content : '';
  const workersIn = el('input', {
    type: 'number', id: 'f-workers', inputmode: 'numeric', min: '0', max: '999', step: '1',
    placeholder: '예) 5', value: entry && entry.workers ? String(entry.workers) : '',
  });

  // 위치 자동완성 (예전에 쓴 위치)
  const all = await store.allEntries();
  const places = [...new Set(sortEntries(all).map((e) => e.location).filter(Boolean))].slice(0, 30);
  const dl = el('datalist', { id: 'places' }, places.map((p) => el('option', { value: p })));
  locIn.setAttribute('list', 'places');

  const grid = el('div', { class: 'photo-grid' });
  const busy = el('div', { class: 'busy', hidden: true });
  const saveBtn = el('button', { type: 'submit', class: 'btn primary' }, '저장');

  function renderPhotos() {
    grid.replaceChildren(...images.map((src, i) =>
      el('div', { class: 'ph' },
        el('img', { src, alt: `사진 ${i + 1}` }),
        el('button', {
          type: 'button', class: 'rm', 'aria-label': `사진 ${i + 1} 빼기`,
          onclick: () => {
            if (!confirm('이 사진을 뺄까요?')) return;
            images.splice(i, 1);
            dirty = true;
            renderPhotos();
          },
        }, '×'))));
  }
  function renderBusy() {
    busy.hidden = busyCount === 0;
    busy.textContent = busyCount ? `사진 정리 중… (${busyCount}장 남음)` : '';
    saveBtn.disabled = busyCount > 0;
  }

  async function addFiles(fileList) {
    const files = [...fileList];
    busyCount += files.length;
    renderBusy();
    for (const f of files) {
      try {
        images.push(await resizeToDataURL(f, PHOTO_MAX, PHOTO_QUALITY));
        dirty = true;
        renderPhotos();
      } catch (err) {
        toast(`사진 한 장을 넣지 못했습니다: ${f.name || ''}`);
      }
      busyCount--;
      renderBusy();
    }
  }

  const camIn = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });
  const galIn = el('input', { type: 'file', accept: 'image/*', multiple: true });
  [camIn, galIn].forEach((inp) => inp.addEventListener('change', () => {
    if (inp.files && inp.files.length) addFiles(inp.files);
    inp.value = '';
  }));

  const form = el('form', { novalidate: true },
    el('div', { class: 'field' }, el('label', { for: 'f-date' }, '날짜'), dateIn),
    el('div', { class: 'field' }, el('label', { for: 'f-loc' }, '위치 ', el('span', { class: 'hint' }, '(등산로 구간 이름)')), locIn, dl),
    el('div', { class: 'field' }, el('label', { for: 'f-content' }, '작업 내용'), contentIn),
    el('div', { class: 'field' }, el('label', { for: 'f-workers' }, '인원 ', el('span', { class: 'hint' }, '(선택, 명)')), workersIn),
    el('div', { class: 'field' },
      el('span', { class: 'label' }, '사진 ', el('span', { class: 'hint' }, '(여러 장 가능)')),
      el('div', { class: 'photo-buttons' },
        el('button', { type: 'button', class: 'btn', onclick: () => camIn.click() }, '📷 사진 찍기'),
        el('button', { type: 'button', class: 'btn', onclick: () => galIn.click() }, '🖼️ 앨범에서 고르기'),
        camIn, galIn),
      busy, grid),
    el('div', { class: 'btn-row' },
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          if (dirty && !confirm('저장하지 않은 내용이 있습니다. 그만 쓸까요?')) return;
          history.length > 1 ? history.back() : go('#/');
        },
      }, '취소'),
      saveBtn));

  form.addEventListener('input', () => { dirty = true; });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busyCount > 0) return;
    const date = dateIn.value;
    const loc = locIn.value.trim();
    const content = contentIn.value.replace(/\s+$/, '');
    const workersRaw = workersIn.value.trim();
    const workers = workersRaw === '' ? null : Number(workersRaw);
    if (!isDate(date)) { toast('날짜를 골라 주세요.'); dateIn.focus(); return; }
    if (!loc && !content.trim() && !images.length) {
      toast('위치나 작업 내용을 적어 주세요.'); locIn.focus(); return;
    }
    if (workers !== null && (!Number.isInteger(workers) || workers < 0)) {
      toast('인원은 0 이상의 숫자로 적어 주세요.'); workersIn.focus(); return;
    }
    saveBtn.disabled = true;
    try {
      const now = Date.now();
      const thumb = images.length ? await resizeToDataURL(images[0], THUMB_MAX, 0.7) : null;
      const record = {
        id: entry ? entry.id : newId(),
        date, location: loc, content, workers,
        photoCount: images.length,
        thumb,
        createdAt: entry ? entry.createdAt : now,
        updatedAt: now,
      };
      await store.save(record, images);
      requestPersist();
      dirty = false;
      toast('저장했습니다.');
      location_replace(`#/view/${encodeURIComponent(record.id)}`);
    } catch (err) {
      saveBtn.disabled = false;
      const full = err && (err.name === 'QuotaExceededError');
      alert(full
        ? '저장 공간이 부족합니다. 백업 후 오래된 기록이나 사진을 지워 주세요.'
        : '저장하지 못했습니다: ' + (err && err.message ? err.message : err));
    }
  });

  show(el('h1', null, entry ? '기록 고치기' : '새 작업 기록'), form);
  renderPhotos();
  renderBusy();
}

/** 저장 후 '뒤로' 눌렀을 때 쓰기 화면으로 돌아가지 않게 주소를 바꿔치기 */
function location_replace(hash) {
  history.replaceState(null, '', hash);
  route();
}

/* ==================== 자세히 보기 ==================== */
async function viewDetail(id) {
  setTab('');
  const entry = await store.entry(id);
  if (!entry) { notFound(); return; }
  const images = await store.photos(id);

  const info = el('dl', { class: 'kv' },
    el('dt', null, '인원'), el('dd', null, entry.workers ? `${entry.workers}명` : '-'),
    el('dt', null, '사진'), el('dd', null, images.length ? `${images.length}장` : '없음'));

  show(
    el('div', { class: 'card' },
      el('div', { class: 'detail-date', text: fmtDate(entry.date) }),
      el('div', { class: 'detail-loc', text: entry.location || '(위치 없음)' }),
      info),
    el('div', { class: 'card' },
      el('div', { class: 'muted', style: 'font-weight:600;margin-bottom:6px' }, '작업 내용'),
      el('div', { class: 'content-text', text: entry.content || '(작업 내용 없음)' })),
    images.length ? el('div', { class: 'photos-full' },
      images.map((src, i) => el('img', { src, alt: `사진 ${i + 1}`, loading: 'lazy' }))) : null,
    el('div', { class: 'btn-row' },
      el('a', { class: 'btn primary', href: `#/edit/${encodeURIComponent(entry.id)}` }, '✏️ 고치기'),
      el('a', { class: 'btn', href: `#/print/${entry.date}` }, '🖨️ 이 날 인쇄')),
    el('div', { class: 'btn-row' },
      el('a', { class: 'btn', href: `#/month/${entry.date.slice(0, 7)}` }, '📅 이 달 보기'),
      el('button', {
        type: 'button', class: 'btn danger',
        onclick: async () => {
          if (!confirm(`${fmtDate(entry.date)}\n「${entry.location || '위치 없음'}」 기록을 지울까요?\n\n지우면 되살릴 수 없습니다.`)) return;
          try {
            await store.remove(entry.id);
            toast('지웠습니다.');
            location_replace('#/');
          } catch (err) {
            alert('지우지 못했습니다: ' + err.message);
          }
        },
      }, '🗑️ 지우기')));
}

/* ==================== 월별 보기 ==================== */
async function viewMonth(ym) {
  setTab('month');
  if (!isMonth(ym)) ym = todayStr().slice(0, 7);
  const entries = sortEntries((await store.allEntries()).filter((e) => (e.date || '').startsWith(ym)));
  const days = new Set(entries.map((e) => e.date)).size;
  const people = entries.reduce((sum, e) => sum + (e.workers || 0), 0);

  const monthIn = el('input', { type: 'month', value: ym, 'aria-label': '달 고르기' });
  monthIn.addEventListener('change', () => { if (isMonth(monthIn.value)) go(`#/month/${monthIn.value}`); });

  show(
    el('h1', null, '월별 보기'),
    el('div', { class: 'month-nav' },
      el('a', { class: 'btn', href: `#/month/${shiftMonth(ym, -1)}`, 'aria-label': '이전 달' }, '◀'),
      monthIn,
      el('a', { class: 'btn', href: `#/month/${shiftMonth(ym, 1)}`, 'aria-label': '다음 달' }, '▶')),
    el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('b', null, String(entries.length)), el('span', null, '기록 수')),
      el('div', { class: 'stat' }, el('b', null, String(days)), el('span', null, '작업한 날')),
      el('div', { class: 'stat' }, el('b', null, String(people)), el('span', null, '연인원(명)'))),
    entries.length
      ? groupedList(entries)
      : el('p', { class: 'empty' }, `${fmtMonth(ym)}에는 기록이 없습니다.`));
}

/* ==================== 인쇄 화면 (하루치, A4) ==================== */
async function viewPrint(date) {
  setTab('');
  if (!isDate(date)) date = todayStr();
  const entries = sortEntries((await store.allEntries()).filter((e) => e.date === date)).reverse();
  const withPhotos = await Promise.all(entries.map(async (e) => ({ e, images: await store.photos(e.id) })));
  const people = entries.reduce((sum, e) => sum + (e.workers || 0), 0);

  const dateIn = el('input', { type: 'date', value: date, 'aria-label': '인쇄할 날짜' });
  dateIn.addEventListener('change', () => { if (isDate(dateIn.value)) go(`#/print/${dateIn.value}`); });

  const sheet = el('div', { class: 'sheet' },
    el('h1', null, '작업일지'),
    el('div', { class: 'sheet-date', text: `${fmtDate(date)}${people ? ` · 연인원 ${people}명` : ''}` }),
    el('div', { class: 'sign' },
      el('table', null,
        el('tr', null, el('th', null, '작성'), el('th', null, '확인')),
        el('tr', null, el('td'), el('td')))),
    withPhotos.length
      ? withPhotos.map(({ e, images }, i) => el('div', { class: 'entry' },
        el('table', { class: 'info' },
          el('tr', null, el('th', null, `위치${withPhotos.length > 1 ? ` ${i + 1}` : ''}`), el('td', { text: e.location || '-' })),
          el('tr', null, el('th', null, '인원'), el('td', { text: e.workers ? `${e.workers}명` : '-' })),
          el('tr', null, el('th', null, '작업 내용'), el('td', null, el('div', { class: 'content-text', text: e.content || '-' })))),
        images.length ? el('div', { class: 'pgrid' }, images.map((src) => el('img', { src, alt: '' }))) : null))
      : el('p', { style: 'text-align:center;padding:30px 0' }, '이 날의 기록이 없습니다.'));

  show(
    el('div', { class: 'print-toolbar' },
      el('h1', null, '인쇄하기'),
      el('div', { class: 'field' }, el('label', null, '날짜'), dateIn),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn primary', onclick: () => window.print(), disabled: !entries.length }, '🖨️ 인쇄 / PDF 저장'),
        el('button', { type: 'button', class: 'btn', onclick: () => (history.length > 1 ? history.back() : go('#/')) }, '돌아가기')),
      el('p', { class: 'muted', style: 'font-size:15px' },
        '휴대폰에서는 인쇄 화면에서 "PDF로 저장"을 고르면 파일로 보낼 수 있습니다.')),
    sheet);
}

/* ==================== 백업 / 불러오기 ==================== */
async function viewBackup() {
  setTab('backup');
  const entries = await store.allEntries();
  const photoTotal = entries.reduce((s, e) => s + (e.photoCount || 0), 0);

  const usage = el('p', { class: 'muted', style: 'font-size:15px' });
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(({ usage: u }) => {
      if (typeof u === 'number') usage.textContent = `이 휴대폰에서 쓰는 저장 공간: 약 ${(u / 1024 / 1024).toFixed(1)}MB`;
    }).catch(() => {});
  }

  const exportBtn = el('button', { type: 'button', class: 'btn primary block', disabled: !entries.length }, '⬇️ 백업 파일 내려받기');
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = '백업 파일 만드는 중…';
    try {
      await exportAll();
      toast('백업 파일을 내려받았습니다.');
    } catch (err) {
      alert('백업하지 못했습니다: ' + err.message);
    }
    exportBtn.disabled = false;
    exportBtn.textContent = '⬇️ 백업 파일 내려받기';
  });

  const fileIn = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const importBtn = el('button', { type: 'button', class: 'btn block', onclick: () => fileIn.click() }, '⬆️ 백업 파일 불러오기');
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    importBtn.disabled = true;
    importBtn.textContent = '불러오는 중…';
    try {
      const n = await importFile(f);
      if (n !== null) { toast(`${n}건을 불러왔습니다.`); viewBackup(); return; }
    } catch (err) {
      alert('불러오지 못했습니다: ' + err.message);
    }
    importBtn.disabled = false;
    importBtn.textContent = '⬆️ 백업 파일 불러오기';
  });

  show(
    el('h1', null, '백업'),
    el('div', { class: 'card' },
      el('p', { style: 'margin-top:0' }, `저장된 기록 ${entries.length}건 · 사진 ${photoTotal}장`),
      el('p', { class: 'muted', style: 'font-size:16px' },
        '기록은 이 휴대폰(이 브라우저) 안에만 저장됩니다. 휴대폰을 바꾸거나 브라우저 기록을 지우면 사라지니, ',
        el('b', null, '일주일에 한 번은 백업 파일을 내려받아'),
        ' 컴퓨터나 메신저(나에게 보내기)에 보관해 두세요.'),
      exportBtn,
      usage),
    el('div', { class: 'card' },
      el('p', { style: 'margin-top:0' }, '백업 파일(.json)을 다시 넣으면 기록이 돌아옵니다. 다른 휴대폰으로 옮길 때도 씁니다.'),
      el('p', { class: 'muted', style: 'font-size:16px' }, '이미 있는 같은 기록은 백업 파일 내용으로 바뀌고, 나머지 기록은 그대로 둡니다.'),
      importBtn, fileIn),
    el('div', { class: 'card' },
      el('p', { style: 'margin-top:0' }, '하루치 기록을 A4 한 장으로 인쇄하거나 PDF로 저장합니다.'),
      el('a', { class: 'btn block', href: `#/print/${todayStr()}` }, '🖨️ 오늘 기록 인쇄하기')));
}

async function exportAll() {
  const entries = sortEntries(await store.allEntries());
  const parts = [`{"app":"작업일지","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"entries":[\n`];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const images = await store.photos(e.id);
    parts.push((i ? ',\n' : '') + JSON.stringify({ ...e, photos: images }));
  }
  parts.push('\n]}\n');
  const blob = new Blob(parts, { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `작업일지-백업-${todayStr()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** 백업 파일 읽기. 불러온 개수, 사용자가 취소하면 null */
async function importFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('작업일지 백업 파일이 아닙니다.'); }
  const list = data && Array.isArray(data.entries) ? data.entries : null;
  if (!list) throw new Error('작업일지 백업 파일이 아닙니다.');

  const items = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !isDate(raw.date)) continue;
    const photos = Array.isArray(raw.photos)
      ? raw.photos.filter((p) => typeof p === 'string' && p.startsWith('data:image/'))
      : [];
    const workers = Number.isInteger(raw.workers) && raw.workers >= 0 ? raw.workers : null;
    let thumb = typeof raw.thumb === 'string' && raw.thumb.startsWith('data:image/') ? raw.thumb : null;
    if (!thumb && photos.length) {
      try { thumb = await resizeToDataURL(photos[0], THUMB_MAX, 0.7); } catch (e) { thumb = null; }
    }
    items.push({
      entry: {
        id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
        date: raw.date,
        location: typeof raw.location === 'string' ? raw.location : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        workers,
        photoCount: photos.length,
        thumb,
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
      },
      images: photos,
    });
  }
  if (!items.length) throw new Error('백업 파일에 기록이 없습니다.');
  if (!confirm(`백업 파일에서 기록 ${items.length}건을 불러올까요?`)) return null;
  await store.saveMany(items);
  requestPersist();
  return items.length;
}

/* ==================== 길 찾기 (주소 #/...) ==================== */
function notFound() {
  show(el('div', { class: 'empty' },
    el('p', null, '기록을 찾을 수 없습니다. 이미 지웠을 수 있습니다.'),
    el('a', { class: 'btn', href: '#/' }, '목록으로')));
}

async function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').map(decodeURIComponent);
  const [page, arg] = parts;
  try {
    switch (page) {
      case '': await viewList(); break;
      case 'new': await viewForm(null); break;
      case 'edit': await viewForm(arg); break;
      case 'view': await viewDetail(arg); break;
      case 'month': await viewMonth(arg); break;
      case 'print': await viewPrint(arg); break;
      case 'backup': await viewBackup(); break;
      default: await viewList();
    }
  } catch (err) {
    show(el('div', { class: 'empty' },
      el('p', null, '문제가 생겼습니다.'),
      el('p', { class: 'muted', text: err && err.message ? err.message : String(err) }),
      el('p', { class: 'muted', style: 'font-size:15px' },
        '사파리 "개인정보 보호 브라우징"에서는 저장이 안 될 수 있습니다. 일반 창에서 열어 주세요.')));
  }
}

window.addEventListener('hashchange', route);
route();
