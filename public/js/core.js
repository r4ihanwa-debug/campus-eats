/* Campus Eats - inti frontend: util, router, shell, auth, notifikasi */
const S = { user: null, cart: null, cache: {} };
const ROUTES = [];            // [regex, roles|null, handler]
const cur = { poll: null, timers: [], last: '' };

const $ = s => document.querySelector(s);
const rp = n => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeDataImg = src => typeof src === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : '';
const dt = t => t ? new Date(t).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && S.user) { S.user = null; stopPolling(); location.hash = '#/login'; }
    const msg = (d && typeof d.error === 'object' ? d.error.message : d?.error) || 'Terjadi kesalahan';
    const err = new Error(msg);
    if (d && typeof d.error === 'object') {
      err.code = d.error.code;
      err.fields = d.error.fields || null;
    }
    throw err;
  }
  return d;
}

/* aksi dengan penanganan error + toast */
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

/* helper loading state tombol agar tidak double-submit */
async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return null;
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  }
}

const alertBox = (msg, kind = 'err') => `<div class="alert ${esc(kind)}" role="alert">${esc(msg)}</div>`;

/* ---------- ikon (SVG inline, gaya Lucide) ---------- */
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  tag: '<path d="M20 13 13 20a2 2 0 0 1-2.8 0L3 12.8V4h8.8L20 12.2a2 2 0 0 1 0 .8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 7H6"/>',
  bag: '<path d="M6 7h12l1 13H5z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  heart: '<path d="M20.8 5.6a5.2 5.2 0 0 0-7.4 0L12 7l-1.4-1.4a5.2 5.2 0 0 0-7.4 7.4L12 21.8l8.8-8.8a5.2 5.2 0 0 0 0-7.4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17v.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="14.5" r="1"/>',
  store: '<path d="M4 9 5.5 4h13L20 9M4 9h16v11H4z"/><path d="M4 9c0 2 3 2 4 0 1 2 3 2 4 0 1 2 3 2 4 0 1 2 4 2 4 0M10 20v-5h4v5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3"/>',
  bike: '<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M12 17 9 8h4M9 8H6M15 6h2l1.5 11M12 17l3-7"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  star: '<path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>', check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
};
const ic = (n, c = '') => `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
const LOGO = `<div class="logo"><i><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v16M6 4c0 4 3 5 3 0M6 4c0 4-3 5-3 0M17 4v16M17 4c3 2 4 6 0 9"/></svg></i>Campus Eats</div>`;

/* ---------- toast & modal ---------- */
function toast(msg, kind = '', title = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + esc(kind);
  t.setAttribute('role', 'status');
  t.innerHTML = (title ? `<b>${esc(title)}</b>` : '') + esc(msg);
  const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); };
  t.onclick = kill;
  $('#toasts').appendChild(t);
  setTimeout(kill, 4500);
}

function modal(html, { wide = false, onclose } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="ov"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  root.firstChild.onmousedown = e => { if (e.target === root.firstChild && !onclose?.lock) { closeModal(); onclose?.(); } };
  const f = root.querySelector('input,select,textarea');
  if (f && !matchMedia('(pointer:coarse)').matches) f.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function confirmBox(title, text, okLabel = 'Ya, lanjutkan', danger = false) {
  return new Promise(res => {
    modal(`<h2>${esc(title)}</h2><p class="mute" style="margin:8px 0 20px">${esc(text)}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" id="cb-no">Batal</button><button class="btn ${danger ? 'red' : ''}" id="cb-ok">${esc(okLabel)}</button></div>`, { onclose: () => res(false) });
    $('#cb-no').onclick = () => { closeModal(); res(false); };
    $('#cb-ok').onclick = () => { closeModal(); res(true); };
  });
}

function promptBox(title, label, ph = '') {
  return new Promise(res => {
    modal(`<h2>${esc(title)}</h2><label class="f" style="margin-top:14px">${esc(label)}<input id="pb-in" maxlength="120" placeholder="${esc(ph)}"></label>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" id="pb-no">Batal</button><button class="btn" id="pb-ok">Kirim</button></div>`, { onclose: () => res(null) });
    $('#pb-no').onclick = () => { closeModal(); res(null); };
    $('#pb-ok').onclick = () => { const v = $('#pb-in').value.trim(); if (v.length < 3) return toast('Isi alasan minimal 3 karakter', 'err'); closeModal(); res(v); };
  });
}

/* ---------- gambar makanan ---------- */
const EMOJI = { rice: '🍱', geprek: '🍗', bakar: '🍖', mie: '🍜', default: '🍽️' };
function art(img, cls = '') {
  const safe = safeDataImg(img);
  if (safe) return `<div class="art ${esc(cls)}"><img src="${safe}" alt="" loading="lazy"></div>`;
  const k = EMOJI[img] ? img : 'default';
  return `<div class="art ${k} ${esc(cls)}" role="img" aria-label="Ilustrasi makanan">${EMOJI[k]}</div>`;
}
const skeleton = (n = 3) => `<div class="grid g3">${Array.from({ length: n }, () => '<div class="skel" style="height:220px"></div>').join('')}</div>`;
const stars = n => `<span style="color:var(--orange)">★</span> ${Number(n || 0).toFixed(1)}`;

/* ---------- label status ---------- */
const STEPS = [
  ['MENUNGGU_PEMBAYARAN', 'Menunggu Pembayaran'], ['PEMBAYARAN_BERHASIL', 'Pembayaran Berhasil'], ['MENCARI_KURIR', 'Mencari Kurir'],
  ['KURIR_DITEMUKAN', 'Kurir Ditemukan'], ['MENUNGGU_DISIAPKAN', 'Menunggu Makanan Disiapkan'], ['SEDANG_DISIAPKAN', 'Makanan Sedang Disiapkan'],
  ['SIAP_DIAMBIL', 'Makanan Siap Diambil'], ['KURIR_MENGAMBIL', 'Kurir Mengambil Pesanan'], ['DALAM_PENGANTARAN', 'Dalam Pengantaran'], ['SELESAI', 'Pesanan Selesai'],
];
const STLABEL = Object.fromEntries(STEPS.concat([['DIBATALKAN', 'Dibatalkan']]));
const stBadge = s => `<span class="badge ${s === 'SELESAI' ? '' : s === 'DIBATALKAN' ? 'r' : 'o'}">${esc(STLABEL[s] || s)}</span>`;

/* ---------- navigasi per role ---------- */
const NAV = {
  customer: [['#/home', 'Home', 'home'], ['#/search', 'Cari', 'search'], ['#/promo', 'Promo', 'tag'], ['#/cart', 'Keranjang', 'cart'], ['#/orders', 'Pesanan', 'bag'], ['#/profile', 'Profil', 'user']],
  courier: [['#/c/dashboard', 'Dashboard', 'grid'], ['#/c/available', 'Tersedia', 'bell'], ['#/c/active', 'Aktif', 'bike'], ['#/c/earnings', 'Pendapatan', 'wallet'], ['#/c/history', 'Riwayat', 'list'], ['#/profile', 'Profil', 'user']],
  merchant: [['#/m/dashboard', 'Dashboard', 'grid'], ['#/m/orders', 'Pesanan', 'bag'], ['#/m/menu', 'Menu', 'list'], ['#/m/stock', 'Stok', 'box'], ['#/m/sales', 'Penjualan', 'chart'], ['#/m/earnings', 'Pendapatan', 'wallet'], ['#/m/store', 'Toko', 'store']],
  admin: [['#/a/overview', 'Overview', 'grid'], ['#/a/users', 'Pengguna', 'users'], ['#/a/couriers', 'Kurir', 'bike'], ['#/a/merchants', 'Kantin', 'store'], ['#/a/orders', 'Pesanan', 'bag'], ['#/a/transactions', 'Transaksi', 'receipt'], ['#/a/reports', 'Laporan', 'chart'], ['#/a/settings', 'Pengaturan', 'gear']],
};
const HOME = { customer: '#/home', courier: '#/c/dashboard', merchant: '#/m/dashboard', admin: '#/a/overview' };
const ROLE_LABEL = { customer: 'Pemesan', courier: 'Kurir', merchant: 'Mitra Kantin', admin: 'Admin' };

function shell() {
  const u = S.user, nav = NAV[u.role], hash = location.hash;
  const on = h => hash === h || (h !== '#/home' && hash.startsWith(h + '/')) ? 'on' : (h === '#/home' && (hash === '#/home' || hash.startsWith('#/product')) ? 'on' : '');
  const bottom = nav.length > 6 ? nav.slice(0, 5).concat([['#/profile', 'Akun', 'user']]) : nav;
  $('#app').innerHTML = `<div class="shell">
    <aside class="side">${LOGO}<nav class="nav" aria-label="Menu utama">${nav.map(([h, l, i]) => `<a href="${h}" class="${on(h)}">${ic(i)}${l}</a>`).join('')}
      ${u.role !== 'customer' && !nav.some(n => n[0] === '#/profile') ? `<a href="#/profile" class="${on('#/profile')}">${ic('user')}Profil</a>` : ''}</nav>
      <div class="role"><b>${ROLE_LABEL[u.role]}</b><div class="mute">@${esc(u.username)}</div></div>
      <button class="btn ghost sm" onclick="A.logout()">${ic('logout')}Keluar</button></aside>
    <div class="main"><header class="top">
      <span class="hello">${u.role === 'customer' ? 'Halo, ' + esc(u.name.split(' ')[0]) + ' 👋' : esc(u.name)}</span>
      ${u.role === 'customer' ? `<div class="search">${ic('search')}<input id="gsearch" placeholder="Mau makan apa hari ini?" aria-label="Cari makanan" onkeydown="if(event.key==='Enter')location.hash='#/search?q='+encodeURIComponent(this.value)"></div>` : ''}
      <span class="grow"></span>
      <button class="iconbtn" onclick="A.notifPanel()" aria-label="Notifikasi">${ic('bell')}<span class="dot" id="ndot" style="display:none">0</span></button>
      ${u.role === 'customer' ? `<a class="iconbtn" href="#/cart" aria-label="Keranjang">${ic('cart')}<span class="dot" id="cdot" style="display:none">0</span></a>` : ''}
      <a href="#/profile" class="avatar" aria-label="Profil">${esc(initials(u.name))}</a></header>
      <main id="page" class="page"></main></div>
    <nav class="bottom" aria-label="Navigasi bawah">${bottom.map(([h, l, i]) => `<a href="${h}" class="${on(h)}">${ic(i)}<span>${l}</span>${h === '#/cart' ? '<b class="dot" id="cdot2" style="display:none;top:0;right:14px">0</b>' : ''}</a>`).join('')}</nav></div>`;
  updateCartDot();
}
function setActiveNav() {
  const h = location.hash.split('?')[0];
  document.querySelectorAll('.nav a,.bottom a').forEach(a => {
    const t = a.getAttribute('href');
    a.classList.toggle('on', h === t || (t === '#/home' && h.startsWith('#/product')) || (t === '#/orders' && h.startsWith('#/order/')));
  });
}
function updateCartDot() {
  const n = S.cart?.count || 0;
  ['cdot', 'cdot2'].forEach(id => { const d = $('#' + id); if (d) { d.style.display = n ? 'grid' : 'none'; d.textContent = n; } });
}
async function loadCart() { if (S.user?.role === 'customer') { try { S.cart = await api('/api/cart'); updateCartDot(); } catch { } } return S.cart; }

/* ---------- router ---------- */
function stopPolling() { cur.poll = null; cur.timers.forEach(clearInterval); cur.timers = []; }
async function route() {
  stopPolling(); closeModal(); $('#notifp')?.remove();
  const full = location.hash || '#/';
  const [path, qs] = full.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  if (!S.user) {
    try { S.user = (await api('/api/me')).user; } catch { }
    if (S.user) { startPolling(); }
  }
  if (!S.user) {
    if (path !== '#/login' && path !== '#/signup') return (location.hash = '#/login');
    return renderAuth(path === '#/signup');
  }
  if (path === '#/' || path === '#/login' || path === '#/signup' || path === '') return (location.hash = HOME[S.user.role]);
  if (!$('#page')) shell(); else setActiveNav();
  for (const [re, roles, fn] of ROUTES) {
    const m = re.exec(path);
    if (!m) continue;
    if (roles && !roles.includes(S.user.role)) { toast('Halaman ini bukan untuk akunmu', 'err'); return (location.hash = HOME[S.user.role]); }
    const page = $('#page'); page.style.animation = 'none'; void page.offsetWidth; page.style.animation = '';
    scrollTo(0, 0);
    try { await fn({ params: m.slice(1), query }); } catch (e) { page.innerHTML = `<div class="empty"><div class="em">⚠️</div><p>${esc(e.message)}</p></div>`; }
    return;
  }
  $('#page').innerHTML = '<div class="empty"><div class="em">🧭</div><p>Halaman tidak ditemukan.</p><a class="btn" href="' + HOME[S.user.role] + '" style="margin-top:14px">Ke beranda</a></div>';
}

/* tampilan yang diperbarui otomatis (polling) tanpa berkedip */
async function live(loader, draw, ms = 5000) {
  let last = '';
  const run = async first => {
    const d = await loader();
    const s = JSON.stringify(d);
    if (first || s !== last) {
      last = s;
      if (!document.activeElement || !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) draw(d);
    }
  };
  await run(true);
  cur.poll = () => run(false).catch(() => { });
  cur.pollMs = ms;
}

function startPolling() {
  if (window.__pollTimer) return;
  let lastNotif = Number(sessionStorage.getItem('ce_last_notif') || 0), first = true;
  window.__pollTimer = setInterval(async () => {
    if (!S.user || document.hidden) return;
    cur.poll && cur.poll();
    try {
      const n = await api('/api/notifications');
      const dot = $('#ndot');
      if (dot) { dot.style.display = n.unread ? 'grid' : 'none'; dot.textContent = n.unread; }
      const fresh = n.items.filter(i => i.id > lastNotif);
      if (fresh.length) {
        if (!first) fresh.reverse().forEach(i => toast(i.body || '', '', i.title));
        lastNotif = Math.max(...n.items.map(i => i.id));
        sessionStorage.setItem('ce_last_notif', lastNotif);
      } else if (first && n.items.length) {
        lastNotif = Math.max(lastNotif, n.items[0].id);
        sessionStorage.setItem('ce_last_notif', lastNotif);
      }
      first = false;
      if (S.user.role === 'courier') checkOffer();
    } catch { }
  }, 5000);
}

/* ---------- auth ---------- */
function renderAuth(signup) {
  $('#app').innerHTML = `<div class="auth"><section class="auth-hero">${LOGO}<div><h1>Lapar di tengah kuliah?</h1><p>Pesan dari kantin kampus, makanan diantar langsung ke lantai dan ruang kelasmu.</p></div><span class="mute" style="opacity:.8">Campus Eats</span><div class="blob">🍱</div></section>
    <section class="auth-form"><div class="auth-card"><div style="margin-bottom:8px">${LOGO}</div>
      <div class="tabs"><button class="${signup ? '' : 'on'}" onclick="location.hash='#/login'">Masuk</button><button class="${signup ? 'on' : ''}" onclick="location.hash='#/signup'">Daftar</button></div>
      <form id="af" novalidate>${signup ? `
        <label class="f">Daftar sebagai<select name="role"><option value="customer">Pemesan (mahasiswa/dosen/staf)</option><option value="courier">Kurir</option><option value="merchant">Pemilik Kantin</option></select></label>
        <label class="f">Nama lengkap<input name="name" autocomplete="name" required></label>
        <label class="f" id="sn" style="display:none">Nama kantin<input name="store_name"></label>
        <label class="f">No. HP (opsional)<input name="phone" inputmode="tel" autocomplete="tel"></label>` : ''}
        <label class="f">Username<input name="username" autocomplete="username" autocapitalize="none" required></label>
        <label class="f">Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
        <p class="err" id="aerr" style="color:var(--red);min-height:22px;font-size:.86rem"></p>
        <button class="btn block" id="abtn">${signup ? 'Buat akun' : 'Masuk'}</button></form>
      ${signup ? '' : `<div class="demo"><b>Akun demo</b> — ketuk username untuk mengisi (password mengikuti konfigurasi server):<br>
        ${[['abyan', 'Pemesan'], ['agus', 'Kurir 1'], ['seno', 'Kurir 2'], ['kantinlore', 'Kantin'], ['admin', 'Admin']].map(([u, l]) => `<button type="button" data-u="${u}">${l} (@${u})</button>`).join('')}</div>`}
    </div></section></div>`;
  const f = $('#af');
  f.role && (f.role.onchange = () => { $('#sn').style.display = f.role.value === 'merchant' ? 'block' : 'none'; });
  document.querySelectorAll('.demo button').forEach(b => b.onclick = () => { f.username.value = b.dataset.u; f.password.focus(); });
  f.onsubmit = async e => {
    e.preventDefault();
    const b = $('#abtn');
    $('#aerr').textContent = '';
    const body = Object.fromEntries(new FormData(f));
    if (!body.username?.trim() || !body.password) { $('#aerr').textContent = 'Username dan password wajib diisi'; return; }
    await withBusy(b, async () => {
      try {
        const r = await api(signup ? '/api/auth/register' : '/api/auth/login', 'POST', body);
        S.user = r.user;
        $('#app').innerHTML = '';
        sessionStorage.removeItem('ce_last_notif');
        startPolling();
        location.hash = HOME[S.user.role];
        route();
      } catch (er) {
        $('#aerr').textContent = er.message;
      }
    });
  };
}

/* ---------- aksi global ---------- */
const A = {};
A.logout = async () => { await act(() => api('/api/auth/logout', 'POST')); S.user = null; S.cart = null; stopPolling(); $('#app').innerHTML = ''; location.hash = '#/login'; route(); };
A.notifPanel = async () => {
  if ($('#notifp')) return $('#notifp').remove();
  const n = await api('/api/notifications');
  const d = document.createElement('div'); d.id = 'notifp'; d.className = 'card notifp';
  d.innerHTML = `<div class="row between" style="padding:8px 10px"><h3>Notifikasi</h3><button class="btn sm soft" onclick="A.readAll()">Tandai dibaca</button></div>` +
    (n.items.length ? n.items.map(i => `<div class="nitem ${i.read ? '' : 'un'}" data-link="${esc(i.link || '')}"><b class="sm">${esc(i.title)}</b><div class="sm mute">${esc(i.body || '')}</div><div class="xs mute">${dt(i.created_at)}</div></div>`).join('') : '<div class="empty">Belum ada notifikasi</div>');
  d.onclick = e => {
    const item = e.target.closest('.nitem');
    if (item && item.dataset.link && item.dataset.link.startsWith('#/')) {
      location.hash = item.dataset.link;
      d.remove();
    }
  };
  document.body.appendChild(d);
  setTimeout(() => document.addEventListener('click', function h(e) { if (!d.contains(e.target) && !e.target.closest('.iconbtn')) { d.remove(); document.removeEventListener('click', h); } }), 0);
};
A.readAll = async () => { await api('/api/notifications/read', 'POST'); $('#notifp')?.remove(); const d = $('#ndot'); if (d) d.style.display = 'none'; };

/* popup pesanan baru untuk kurir */
let offerShown = null, offerTimer = null;
async function checkOffer() {
  const { offer } = await api('/api/courier/offer');
  if (!offer) { if (offerShown) { closeModal(); clearInterval(offerTimer); offerShown = null; } return; }
  if (offerShown === offer.id) return;
  offerShown = offer.id; let left = offer.remaining;
  modal(`<div class="center"><div class="radar" style="width:84px;height:84px;font-size:2rem">🛵</div><h2>Pesanan Baru!</h2>
    <p class="mute" style="margin:6px 0 14px">Ada pesanan baru! Apakah kamu ingin menerima pesanan ini?</p></div>
    <div class="card" style="background:#fff;box-shadow:none;border:1px solid var(--line)"><div class="sum"><div><span class="mute">Kantin</span><b>${esc(offer.merchant)}</b></div>
    <div><span class="mute">Tujuan</span><b>Lantai ${Number(offer.floor)} - Ruang ${Number(offer.room)}</b></div><div><span class="mute">Jumlah item</span><b>${Number(offer.items)}</b></div>
    <div><span class="mute">Estimasi ongkir</span><b style="color:var(--green-d)">${rp(offer.fee)}</b></div></div></div>
    <div class="track" style="margin:14px 0 4px"><i id="ot" style="width:100%"></i></div><p class="xs mute center" id="otxt">Sisa waktu ${left} detik</p>
    <div class="row" style="margin-top:12px"><button class="btn ghost block" id="o-no">Tolak</button><button class="btn block" id="o-ok">Terima Pesanan</button></div>`, { onclose: Object.assign(() => { }, { lock: true }) });
  const done = () => { clearInterval(offerTimer); closeModal(); };
  offerTimer = setInterval(() => { left--; const t = $('#ot'); if (!t) return clearInterval(offerTimer); t.style.width = Math.max(0, left / offer.total_seconds * 100) + '%'; $('#otxt').textContent = `Sisa waktu ${Math.max(left, 0)} detik`; if (left <= -1) { done(); offerShown = null; } }, 1000);
  $('#o-ok').onclick = e => withBusy(e.currentTarget, async () => { const r = await act(() => api(`/api/courier/offers/${offer.id}/accept`, 'POST'), 'Pesanan diterima. Menuju kantin!'); done(); offerShown = null; if (r) location.hash = '#/c/active'; });
  $('#o-no').onclick = e => withBusy(e.currentTarget, async () => { await act(() => api(`/api/courier/offers/${offer.id}/reject`, 'POST')); done(); offerShown = null; });
}

/* grafik: Chart.js bila ada, jika tidak batang sederhana */
function drawChart(id, labels, datasets, type = 'bar') {
  const el = document.getElementById(id); if (!el) return;
  if (window.Chart) {
    const c = el.getContext('2d'); Chart.getChart(el)?.destroy();
    new Chart(c, { type, data: { labels, datasets: datasets.map((d, i) => ({ label: d.label, data: d.data, backgroundColor: i ? '#ee8a2e' : '#1f8a5b', borderColor: i ? '#ee8a2e' : '#1f8a5b', borderRadius: 6, tension: .35 })) },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: datasets.length > 1 } }, scales: { y: { beginAtZero: true, ticks: { callback: v => 'Rp' + (v / 1000) + 'rb' } } } } });
  } else {
    const tot = labels.map((_, i) => datasets.reduce((s, d) => s + d.data[i], 0)), mx = Math.max(...tot, 1);
    el.outerHTML = `<div class="bars">${labels.map((l, i) => `<div title="${rp(tot[i])}"><i style="height:${tot[i] / mx * 100}%"></i><small>${esc(l)}</small></div>`).join('')}</div>`;
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => { route(); });
window.addEventListener('error', e => console.error('Error:', e.message));
