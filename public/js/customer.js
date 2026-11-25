/* Halaman customer */
const CUST = ['customer'];
const route$ = (re, roles, fn) => ROUTES.push([re, roles, fn]);
const page = h => { $('#page').innerHTML = h; };

/* ---------- kartu makanan ---------- */
function foodCard(p) {
  return `<article class="food ${p.available ? '' : 'off'}" onclick="location.hash='#/product/${p.id}'" tabindex="0" onkeydown="if(event.key==='Enter')location.hash='#/product/${p.id}'">
    ${art(p.image)}${p.popular ? '<span class="tag">Populer</span>' : ''}
    <button class="heart ${p.fav ? 'on' : ''}" aria-label="Favorit" onclick="event.stopPropagation();A.fav(${p.id},this)">${ic('heart')}</button>
    <div class="body"><h3>${esc(p.name)}</h3><div class="xs mute" style="margin:2px 0 10px">${esc(p.category || '')} · ${stars(p.rating)} · ${p.sold}+ terjual</div>
      <div class="row between"><div><div class="xs mute">${p.groups.some(g => g.name === 'Ukuran') ? 'Mulai dari' : ''}</div><div class="price">${rp(p.base_price)}</div></div>
      ${p.available ? `<button class="add" aria-label="Tambah ${esc(p.name)}" onclick="event.stopPropagation();location.hash='#/product/${p.id}'">${ic('plus')}</button>` : '<span class="badge x">Habis</span>'}</div></div></article>`;
}
A.fav = async (id, btn) => {
  const r = await act(() => api('/api/favorites/' + id, 'POST')); if (!r) return;
  btn.classList.toggle('on', r.fav); toast(r.fav ? 'Ditambahkan ke favorit' : 'Dihapus dari favorit', 'ok');
};

/* ---------- home ---------- */
route$(/^#\/home$/, CUST, async () => {
  page(`<div class="skel" style="height:230px;border-radius:26px"></div><div style="height:20px"></div>${skeleton(3)}`);
  const [m, menu] = await Promise.all([api('/api/merchants'), api('/api/menu'), loadCart()]);
  const shop = m.merchants[0]; let cat = 'Semua';
  const cats = ['Semua', ...m.categories.map(c => c.name)];
  const draw = () => {
    const list = menu.products.filter(p => cat === 'Semua' || p.category === cat);
    $('#menu').innerHTML = list.length ? list.map(foodCard).join('') : `<div class="empty" style="grid-column:1/-1"><div class="em">🍽️</div>Belum ada menu di kategori ini.</div>`;
    document.querySelectorAll('#cats .chip').forEach(c => c.classList.toggle('on', c.dataset.c === cat));
  };
  const slides = [['s1', 'Perut Lapar di Tengah Kuliah?', 'Pesan makanan dari kantin, langsung diantar ke kelasmu!', '🍱'], ['s2', 'Ayam Geprek Pedasnya Pas', 'Pilih sambal favoritmu, gratis ongkir dengan voucher.', '🍗'], ['s3', 'Gak Perlu Keluar Kelas', 'Kurir mahasiswa mengantar sampai lantai dan ruanganmu.', '🛵']];
  page(`<div class="banners" id="ban"><div class="slides" id="sl">${slides.map(([c, t, p, e]) => `<div class="slide ${c}"><h2>${t}</h2><p>${p}</p><div><a class="btn orange" href="#/search">Pesan Sekarang</a></div><span class="em" aria-hidden="true">${e}</span></div>`).join('')}</div>
      <div class="dots">${slides.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div></div>
    <div class="sec"><h2>Kategori</h2></div><div class="chips" id="cats">${cats.map(c => `<button class="chip" data-c="${esc(c)}" onclick="A.cat(this.dataset.c)">${esc(c)}</button>`).join('')}</div>
    <div class="sec"><h2>Kantin Terdekat</h2></div>
    ${m.merchants.map(s => `<div class="card shop"><div class="logo-lg">🍛</div><div style="flex:1;min-width:0"><div class="row gap-s wrap"><h3>${esc(s.name)}</h3><span class="badge ${s.open ? '' : 'r'}">${s.open ? 'Buka' : 'Tutup'}</span></div>
      <p class="sm mute">${esc(s.description)}</p><div class="xs mute" style="margin-top:6px">${stars(s.rating_avg)} (${s.rating_count}) · ${ic('clock').replace('class="ic ', 'class="ic xs ').replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')} ±${s.eta_min + 3} menit · ${esc(s.location || '')}</div></div></div>`).join('')}
    <div class="sec"><h2>Daftar Menu</h2><a class="sm b" href="#/favorites">Favoritku</a></div><div class="menu" id="menu"></div>`);
  A.cat = c => { cat = c; draw(); }; draw();
  let i = 0; const sl = $('#sl'), dots = document.querySelectorAll('.dots i');
  cur.timers.push(setInterval(() => { if (!sl.isConnected) return; i = (i + 1) % slides.length; sl.style.transform = `translateX(-${i * 100}%)`; dots.forEach((d, k) => d.classList.toggle('on', k === i)); }, 4500));
});

/* ---------- search ---------- */
route$(/^#\/search$/, CUST, async ({ query }) => {
  page(`<h1>Cari makanan</h1><div class="search" style="max-width:none;margin:14px 0">${ic('search')}<input id="sq" value="${esc(query.q || '')}" placeholder="Nama menu atau kategori (mis. ayam, mie)" autocomplete="off"></div>
    <div class="chips" id="sc"></div><div class="menu" id="sr"></div>`);
  const m = await api('/api/merchants'); let cat = 'Semua', timer;
  const run = async () => {
    const q = $('#sq').value.trim();
    const r = await api(`/api/menu?q=${encodeURIComponent(q)}&cat=${encodeURIComponent(cat)}`);
    $('#sr').innerHTML = r.products.length ? r.products.map(foodCard).join('') : `<div class="empty" style="grid-column:1/-1"><div class="em">🔎</div><p>Tidak ada menu untuk "${esc(q)}". Coba kata kunci lain.</p></div>`;
  };
  $('#sc').innerHTML = ['Semua', ...m.categories.map(c => c.name)].map(c => `<button class="chip ${c === cat ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  $('#sc').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; cat = b.dataset.c; document.querySelectorAll('#sc .chip').forEach(x => x.classList.toggle('on', x === b)); run(); };
  $('#sq').oninput = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  run(); $('#sq').focus();
});
route$(/^#\/favorites$/, CUST, async () => {
  const r = await api('/api/favorites');
  page(`<h1>Menu favorit</h1><div class="menu" style="margin-top:16px">${r.products.length ? r.products.map(foodCard).join('') : '<div class="empty" style="grid-column:1/-1"><div class="em">💚</div>Belum ada favorit. Ketuk ikon hati pada menu.</div>'}</div>`);
});

/* ---------- detail produk ---------- */
route$(/^#\/product\/(\d+)$/, CUST, async ({ params, query }) => {
  page(`<div class="skel" style="height:400px"></div>`);
  const { product: p, merchant } = await api('/api/products/' + params[0]);
  let editItem = null;
  if (query.edit) { const c = await api('/api/cart'); editItem = c.items.find(i => i.id == query.edit); }
  const sel = {}; let qty = editItem?.qty || 1;
  const visible = g => !g.show_if || sel[g.show_if.split('=')[0]] === g.show_if.split('=')[1];
  p.groups.forEach(g => { const pre = editItem?.options[g.name]; const d = g.items.find(i => i.is_default); if (pre) sel[g.name] = pre; else if (!editItem && d) sel[g.name] = d.label; });
  const calc = () => { let u = p.base_price; p.groups.forEach(g => { if (visible(g) && sel[g.name]) u += g.items.find(i => i.label === sel[g.name])?.price_delta || 0; }); return u; };
  const drawGroups = () => {
    $('#groups').innerHTML = p.groups.filter(visible).map(g => `<div class="grp" data-g="${esc(g.name)}"><div class="row between"><b class="gt">${esc(g.name)}</b><span class="badge ${g.required ? 'o' : 'x'}">${g.required ? 'Wajib dipilih' : 'Opsional'}</span></div>
      <div class="opt">${g.items.map(i => `<label><input type="radio" name="g_${esc(g.name)}" value="${esc(i.label)}" ${sel[g.name] === i.label ? 'checked' : ''}><span>${esc(i.label)}${i.price_delta ? ` <small class="mute">${i.price_delta > 0 ? '+' : ''}${rp(i.price_delta)}</small>` : ''}</span></label>`).join('')}</div></div>`).join('');
    document.querySelectorAll('#groups input').forEach(inp => inp.onchange = () => { sel[inp.name.slice(2)] = inp.value; document.querySelectorAll('.grp.bad').forEach(x => x.classList.remove('bad')); drawGroups(); upd(); });
  };
  const upd = () => { $('#pq').textContent = qty; $('#pp').textContent = rp(calc() * qty); };
  const check = () => {
    const miss = p.groups.filter(g => visible(g) && g.required && !sel[g.name]);
    document.querySelectorAll('.grp').forEach(el => el.classList.toggle('bad', miss.some(g => g.name === el.dataset.g)));
    if (miss.length) { toast(`Pilih ${miss.map(g => g.name).join(', ')} terlebih dahulu`, 'err'); document.querySelector('.grp.bad')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return false; }
    return true;
  };
  const payload = () => { const o = {}; p.groups.forEach(g => { if (visible(g) && sel[g.name]) o[g.name] = sel[g.name]; }); return { product_id: p.id, qty, options: o, note: $('#pn').value.trim() }; };
  page(`<a href="#/home" class="sm b">← Kembali</a><div class="pd" style="margin-top:12px">${art(p.image)}
    <div><div class="row between"><div><h1>${esc(p.name)}</h1><div class="sm mute">${esc(p.category || '')} · ${stars(p.rating)} · ${p.sold}+ terjual · ${esc(merchant.name)}</div></div>
      <button class="iconbtn heart2 ${p.fav ? 'on' : ''}" style="${p.fav ? 'color:var(--red)' : ''}" aria-label="Favorit" onclick="A.fav(${p.id},this);this.style.color=this.style.color?'':'var(--red)'">${ic('heart')}</button></div>
      <p class="mute" style="margin:10px 0 0">${esc(p.description || '')}</p>
      ${!merchant.open ? '<p class="badge r" style="margin-top:10px">Kantin sedang tutup</p>' : ''}${!p.available ? '<p class="badge r" style="margin-top:10px">Stok habis</p>' : p.stock <= 5 ? `<p class="badge o" style="margin-top:10px">Sisa ${p.stock} porsi</p>` : ''}
      <div id="groups"></div>
      <label class="f" style="margin-top:16px">Catatan untuk penjual<textarea id="pn" maxlength="200" placeholder="Contoh: sambalnya dipisah ya">${esc(editItem?.note || '')}</textarea></label>
      <div class="row between"><div class="qty"><button aria-label="Kurangi" onclick="A.pq(-1)">−</button><b id="pq">1</b><button aria-label="Tambah" onclick="A.pq(1)">+</button></div><div class="right"><div class="xs mute">Total</div><div class="b" style="font-size:1.3rem" id="pp"></div></div></div>
      <div class="sticky-bar">${editItem ? '<button class="btn block" id="b-save">Simpan Perubahan</button>' : `<button class="btn ghost block" id="b-add" ${p.available && merchant.open ? '' : 'disabled'}>${ic('cart')}Tambahkan ke Keranjang</button><button class="btn orange block" id="b-buy" ${p.available && merchant.open ? '' : 'disabled'}>Beli Sekarang</button>`}</div></div></div>`);
  A.pq = d => { qty = Math.min(20, Math.max(1, qty + d)); upd(); };
  drawGroups(); upd();
  const fly = el => {
    const to = $('#cdot')?.closest('a') || $('.bottom a[href="#/cart"]'); if (!to || !el) return;
    const a = el.getBoundingClientRect(), b = to.getBoundingClientRect(), f = document.createElement('div'); f.className = 'fly';
    f.style.left = a.left + a.width / 2 - 17 + 'px'; f.style.top = a.top + 'px'; document.body.appendChild(f);
    requestAnimationFrame(() => { f.style.left = b.left + b.width / 2 - 17 + 'px'; f.style.top = b.top + 'px'; f.style.transform = 'scale(.3)'; f.style.opacity = '.4'; });
    setTimeout(() => f.remove(), 700);
  };
  const add = async (go, btn) => {
    if (!check()) return;
    const r = await act(() => api('/api/cart/items', 'POST', payload()));
    if (!r) return; S.cart = r; updateCartDot();
    if (go) location.hash = '#/cart'; else { fly(btn); toast(`${p.name} masuk keranjang`, 'ok'); }
  };
  if (editItem) $('#b-save').onclick = async () => { if (!check()) return; const b = payload(); const r = await act(() => api('/api/cart/items/' + editItem.id, 'PATCH', { qty, options: b.options, note: b.note }), 'Pesanan diperbarui'); if (r) location.hash = '#/cart'; };
  else { $('#b-add').onclick = e => add(false, e.currentTarget); $('#b-buy').onclick = () => add(true); }
});

/* ---------- keranjang ---------- */
route$(/^#\/cart$/, CUST, async () => {
  const [fees] = await Promise.all([api('/api/fees')]);
  const draw = c => {
    S.cart = c; updateCartDot();
    if (!c.items.length) return page(`<h1>Keranjang</h1><div class="empty"><div class="em">🛒</div><p>Keranjangmu masih kosong.</p><a class="btn" href="#/home" style="margin-top:14px">Lihat menu</a></div>`);
    const fl = S.user.default_floor || 1, fee = fees.fees[fl], blocked = c.items.some(i => i.invalid) || !c.merchant?.open;
    page(`<h1>Keranjang</h1><div class="layout2" style="margin-top:16px"><div class="card"><div class="b" style="margin-bottom:4px">${esc(c.merchant.name)} ${c.merchant.open ? '' : '<span class="badge r">Tutup</span>'}</div>
      ${c.items.map(i => `<div class="li"><div class="thumb ${EMOJI[i.product.image] ? i.product.image : 'default'} art" style="height:74px;font-size:2.2rem">${i.product.image?.startsWith('data:') ? `<img src="${i.product.image}" alt="">` : EMOJI[i.product.image] || '🍽️'}</div>
        <div style="flex:1;min-width:0"><div class="row between"><b>${esc(i.product.name)}</b><b>${rp(i.total)}</b></div><div class="xs mute">${esc(i.text) || 'Tanpa variasi'}</div>${i.note ? `<div class="xs mute">Catatan: ${esc(i.note)}</div>` : ''}
        ${i.invalid ? `<div class="xs" style="color:var(--red)">${esc(i.invalid)}</div>` : ''}
        <div class="row between" style="margin-top:8px"><div class="qty"><button aria-label="Kurangi" onclick="A.cq(${i.id},${i.qty - 1})">−</button><b>${i.qty}</b><button aria-label="Tambah" onclick="A.cq(${i.id},${i.qty + 1})">+</button></div>
        <div class="row gap-s"><a class="btn sm ghost" href="#/product/${i.product.id}?edit=${i.id}">${ic('edit')}Edit</a><button class="btn sm ghost" aria-label="Hapus" onclick="A.cdel(${i.id})">${ic('trash')}</button></div></div></div></div>`).join('')}</div>
      <div class="card sum"><h3 style="margin-bottom:8px">Ringkasan</h3><div><span>Subtotal (${c.count} item)</span><b>${rp(c.subtotal)}</b></div><div><span>Ongkir (Lantai ${fl})</span><b>${rp(fee)}</b></div>
        <p class="xs mute">Ongkir final menyesuaikan lantai tujuan yang kamu pilih berikutnya (Rp${fees.fees[1].toLocaleString('id-ID')} - ${rp(fees.fees[9])}).</p><div class="tot"><span>Total</span><span>${rp(c.subtotal + fee)}</span></div>
        <a class="btn block ${blocked ? '' : ''}" style="margin-top:14px;${blocked ? 'opacity:.5;pointer-events:none' : ''}" href="#/checkout">Pilih Lantai & Ruang</a>
        ${blocked ? '<p class="xs" style="color:var(--red);margin-top:8px">Periksa item bermasalah atau kantin sedang tutup.</p>' : ''}</div></div>`);
  };
  A.cq = async (id, q) => { if (q < 1) return A.cdel(id); const r = await act(() => api('/api/cart/items/' + id, 'PATCH', { qty: q })); r && draw(r); };
  A.cdel = async id => { const r = await act(() => api('/api/cart/items/' + id, 'DELETE'), 'Item dihapus'); r && draw(r); };
  draw(await api('/api/cart'));
});

/* ---------- lantai & ruang + checkout ---------- */
route$(/^#\/checkout$/, CUST, async () => {
  const [cart, fees] = await Promise.all([api('/api/cart'), api('/api/fees')]);
  if (!cart.items.length) return (location.hash = '#/cart');
  const st = { floor: S.user.default_floor || 0, room: S.user.default_room || 0, voucher: S.voucher || '', discount: 0, vmsg: '' };
  const sum = () => {
    const fee = st.floor ? fees.fees[st.floor] : 0, tot = cart.subtotal + fee - st.discount;
    $('#sum').innerHTML = `<h3 style="margin-bottom:8px">Rincian pembayaran</h3><div><span>Subtotal</span><b>${rp(cart.subtotal)}</b></div>
      <div><span>Ongkir ${st.floor ? 'Lantai ' + st.floor : ''}</span><b>${st.floor ? rp(fee) : '-'}</b></div>${st.discount ? `<div><span style="color:var(--green-d)">Voucher ${esc(st.voucher)}</span><b style="color:var(--green-d)">−${rp(st.discount)}</b></div>` : ''}
      <div class="tot"><span>Total</span><span>${rp(tot)}</span></div>`;
  };
  const checkV = async quiet => {
    if (!st.voucher) { st.discount = 0; return sum(); }
    try { const r = await api('/api/vouchers/check', 'POST', { code: st.voucher, floor: st.floor || 1 }); st.discount = r.discount; st.voucher = r.voucher; $('#vm').style.color = 'var(--green-d)'; $('#vm').textContent = r.message; }
    catch (e) { st.discount = 0; $('#vm').style.color = 'var(--red)'; $('#vm').textContent = e.message; }
    sum();
  };
  page(`<a href="#/cart" class="sm b">← Keranjang</a><h1 style="margin:8px 0 16px">LANTAI & RUANG</h1><div class="layout2"><div class="card">
    <div class="b">Pilih lantai <span class="err" id="e-floor" style="color:var(--red)"></span></div><div class="floors" id="fl" style="margin:10px 0 18px">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(f => `<button class="${st.floor === f ? 'on' : ''}" data-f="${f}">${f}<small>${rp(fees.fees[f]).replace('Rp', 'Rp ')}</small></button>`).join('')}</div>
    <label class="f">Ruang<select id="room"><option value="">Pilih ruang...</option>${Array.from({ length: 20 }, (_, i) => 101 + i).map(r => `<option ${st.room === r ? 'selected' : ''}>${r}</option>`).join('')}</select><span class="err" id="e-room" style="color:var(--red)"></span></label>
    <label class="f">Nama Penerima<input id="rcp" maxlength="60" value="${esc(S.user.name)}" placeholder="Nama yang dipanggil kurir"><span class="err" id="e-rcp" style="color:var(--red)"></span></label>
    <label class="f">Catatan untuk Kurir (opsional)<textarea id="cn" maxlength="200" placeholder="Silakan tunggu di depan kelas."></textarea></label>
    <label class="f">Kode voucher (opsional)<div class="row"><input id="vc" value="${esc(st.voucher)}" placeholder="HEMAT2K" style="margin:0;text-transform:uppercase"><button class="btn ghost" id="va">Pakai</button></div><span class="xs" id="vm"></span></label></div>
    <div><div class="card sum" id="sum"></div><div class="card" style="margin-top:14px"><div class="row">${ic('pin')}<div class="sm"><b>Diantar ke</b><div class="mute" id="dest">Pilih lantai dan ruang</div></div></div>
      <button class="btn orange block" id="pay" style="margin-top:14px"><span class="qris" style="background:#fff;color:var(--red)">QRIS</span>Bayar dengan QRIS</button></div></div></div>`);
  const dest = () => { $('#dest').textContent = st.floor && st.room ? `Lantai ${st.floor} - Ruang ${st.room}` : 'Pilih lantai dan ruang'; };
  $('#fl').onclick = e => { const b = e.target.closest('button'); if (!b) return; st.floor = +b.dataset.f; document.querySelectorAll('#fl button').forEach(x => x.classList.toggle('on', x === b)); $('#e-floor').textContent = ''; dest(); st.voucher ? checkV() : sum(); };
  $('#room').onchange = e => { st.room = +e.target.value; $('#e-room').textContent = ''; dest(); };
  $('#va').onclick = () => { st.voucher = $('#vc').value.trim().toUpperCase(); S.voucher = st.voucher; checkV(); };
  $('#pay').onclick = async () => {
    let ok = true;
    if (!st.floor) { $('#e-floor').textContent = '- wajib dipilih'; ok = false; }
    if (!st.room) { $('#e-room').textContent = '- wajib dipilih'; ok = false; }
    if ($('#rcp').value.trim().length < 2) { $('#e-rcp').textContent = '- isi nama penerima'; ok = false; }
    if (!ok) return toast('Lengkapi lantai, ruang, dan nama penerima', 'err');
    $('#pay').disabled = true;
    const r = await act(() => api('/api/orders', 'POST', { floor: st.floor, room: st.room, recipient: $('#rcp').value.trim(), courier_note: $('#cn').value.trim(), voucher: st.discount ? st.voucher : '' }));
    $('#pay').disabled = false; if (!r) return;
    S.voucher = ''; S.cart = { items: [], count: 0 }; updateCartDot(); qrisModal(r.order);
  };
  dest(); sum(); if (st.voucher) checkV(true);
});

/* ---------- modal QRIS (simulasi) ---------- */
function fakeQR(seed) {
  let h = 2166136261; for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const n = 25, cells = []; const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  const finder = (x, y) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (finder(x, y)) continue; if (rnd() > .52) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
  }
  const fp = (x, y) => `<rect x="${x}" y="${y}" width="7" height="7"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
  return `<svg class="qr" viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges" role="img" aria-label="QRIS simulasi"><rect x="-1" y="-1" width="${n + 2}" height="${n + 2}" fill="#fff"/><g fill="#26302b">${cells.join('')}${fp(0, 0)}${fp(n - 7, 0)}${fp(0, n - 7)}</g></svg>`;
}
function qrisModal(order) {
  let left = Math.max(0, Math.round(((order.payment_expires_at || Date.now() + 300000) - Date.now()) / 1000)), busy = false;
  modal(`<div class="center"><span class="qris">QRIS</span><h2 style="margin-top:8px">CAMPUS EATS</h2><p class="xs mute">Merchant · No. transaksi ${esc(order.payment?.ref || order.code)}</p></div>
    <div style="margin:14px 0">${fakeQR(order.code)}</div>
    <div class="center"><div class="xs mute">Total pembayaran</div><div style="font-size:1.8rem;font-weight:800">${rp(order.total)}</div><div class="badge o" id="cd" style="margin-top:6px"></div>
    <p class="xs mute" style="margin:10px 0 0">Mode <b>SIMULASI</b>: QR ini hanya contoh dan tidak dapat menerima pembayaran sungguhan.</p></div>
    <div class="row" style="margin-top:16px;flex-wrap:wrap"><button class="btn ghost block" id="q-no" style="flex:1">Batalkan Pembayaran</button><button class="btn block" id="q-ok" style="flex:1">Saya Sudah Bayar</button></div>`, { onclose: Object.assign(() => { clearInterval(t); location.hash = '#/order/' + order.id; }, {}) });
  const t = setInterval(() => { left--; const el = $('#cd'); if (!el) return clearInterval(t); if (left <= 0) { clearInterval(t); closeModal(); toast('Waktu pembayaran habis. Pesanan dibatalkan.', 'err'); location.hash = '#/orders'; return; } el.textContent = `Bayar dalam ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; }, 1000);
  $('#cd').textContent = `Bayar dalam ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  $('#q-ok').onclick = async () => {
    if (busy) return; busy = true; $('#q-ok').textContent = 'Memproses...';
    const r = await act(() => api(`/api/orders/${order.id}/pay`, 'POST'));
    clearInterval(t); closeModal();
    if (r) { toast('Pembayaran berhasil (simulasi). Pesananmu diteruskan ke kantin & kurir.', 'ok'); location.hash = '#/order/' + order.id; }
  };
  $('#q-no').onclick = async () => {
    if (!await confirmBox('Batalkan pembayaran?', 'Pesanan akan dibatalkan dan stok dikembalikan.', 'Ya, batalkan', true)) return qrisModal.again?.();
    clearInterval(t); await act(() => api(`/api/orders/${order.id}/cancel`, 'POST', { reason: 'Pembayaran dibatalkan' }), 'Pembayaran dibatalkan'); location.hash = '#/orders';
  };
  qrisModal.again = () => qrisModal(order);
}

/* ---------- daftar pesanan ---------- */
route$(/^#\/orders$/, CUST, async ({ query }) => {
  const f = query.f || 'all';
  const tabs = [['all', 'Semua'], ['aktif', 'Aktif'], ['berhasil', 'Berhasil'], ['dibatalkan', 'Dibatalkan']];
  page(`<h1>Pesanan</h1><div class="chips" style="margin:14px 0">${tabs.map(([k, l]) => `<a class="chip ${f === k ? 'on' : ''}" href="#/orders?f=${k}">${l}</a>`).join('')}</div><div id="ol"></div>`);
  await live(() => api('/api/orders?filter=' + f), d => {
    $('#ol').innerHTML = d.orders.length ? d.orders.map(o => `<div class="card" style="margin-bottom:12px"><div class="row between wrap"><div><b>${esc(o.merchant.name)}</b> <span class="xs mute">${esc(o.code)} · ${dt(o.created_at)}</span></div>${stBadge(o.status)}</div>
      <div class="sm mute" style="margin:8px 0">${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</div>
      <div class="row between wrap"><b>${rp(o.total)}</b><div class="row gap-s"><button class="btn sm ghost" onclick="A.reorder(${o.id})">${ic('repeat')}Pesan Ulang</button><a class="btn sm" href="#/order/${o.id}">Detail</a></div></div></div>`).join('')
      : `<div class="empty"><div class="em">🧾</div><p>Belum ada pesanan di sini.</p><a class="btn" href="#/home" style="margin-top:12px">Pesan sekarang</a></div>`;
  }, 4000);
});
A.reorder = async id => { const r = await act(() => api(`/api/orders/${id}/reorder`, 'POST')); if (!r) return; await loadCart(); toast(r.skipped ? `${r.added} item ditambahkan, ${r.skipped} tidak tersedia` : 'Item ditambahkan ke keranjang', 'ok'); if (r.added) location.hash = '#/cart'; };

/* ---------- detail & tracking ---------- */
route$(/^#\/order\/(\d+)$/, null, async ({ params }) => {
  const id = params[0];
  page('<div class="skel" style="height:420px"></div>');
  const canCancel = o => !['SELESAI', 'DIBATALKAN'].includes(o.status) && (o.status === 'MENUNGGU_PEMBAYARAN' || (o.food_state < 2 && o.delivery_stage === 0));
  await live(() => api('/api/orders/' + id).then(r => r.order), o => {
    const idx = STEPS.findIndex(s => s[0] === o.status), cancelled = o.status === 'DIBATALKAN';
    const searching = o.status === 'MENCARI_KURIR' || (o.status === 'SEDANG_DISIAPKAN' && !o.courier_id);
    page(`<a href="#/orders" class="sm b">← Pesanan</a><div class="layout2" style="margin-top:10px"><div class="stack">
      <div class="card"><div class="row between wrap"><div><h1 style="font-size:1.3rem">${esc(o.code)}</h1><div class="sm mute">${esc(o.merchant.name)} · ${dt(o.created_at)}</div></div>${stBadge(o.status)}</div>
        ${cancelled ? `<div class="badge r" style="margin-top:14px;display:block;padding:12px;border-radius:14px">Pesanan dibatalkan: ${esc(o.cancel_reason || '-')}${o.paid_at ? `<br>Dana ${rp(o.total)} dikembalikan ke saldo refund.` : ''}</div>` : `
        <div class="track" style="margin:16px 0 6px"><i style="width:${Math.max(idx, 0) / 9 * 100}%"></i></div>
        <div class="xs mute">Estimasi tiba ± ${o.eta} menit setelah pembayaran</div>
        ${searching ? (o.courier_search === 'none' ? `<div class="card" style="background:var(--orange-l);box-shadow:none;margin-top:14px"><b>Belum ada kurir yang tersedia.</b><p class="sm">Semua kurir sedang offline atau sibuk. Kamu bisa menunggu, atau membatalkan pesanan dan dana dikembalikan.</p>
          <div class="row" style="margin-top:8px"><button class="btn sm" onclick="A.retry(${o.id})">Tunggu Kurir</button><button class="btn sm ghost" onclick="A.cancelOrder(${o.id})">Batalkan & Refund</button></div></div>`
          : `<div class="center" style="padding:10px"><div class="radar">🛵</div><b>Sedang Mencari Kurir...</b><p class="sm mute">Kurir terdekat sedang kami hubungi.</p></div>`) : ''}
        ${o.status === 'MENUNGGU_PEMBAYARAN' ? `<div class="row" style="margin-top:14px"><button class="btn orange" onclick='A.payNow(${o.id})'>Bayar Sekarang</button></div>` : ''}`}</div>
      ${cancelled ? '' : `<div class="card"><h3 style="margin-bottom:14px">Status pesanan</h3><div class="tl">${STEPS.map(([k, l], i) => `<div class="st ${i < idx || o.status === 'SELESAI' ? 'done' : i === idx ? 'now' : ''}"><i></i>${l}</div>`).join('')}</div></div>`}
      ${o.status === 'SELESAI' && !o.rated ? ratingCard(o) : ''}</div>
      <div class="stack"><div class="card sum"><h3>Pengantaran</h3><div><span class="mute">Lantai</span><b>${o.floor}</b></div><div><span class="mute">Ruangan</span><b>${o.room}</b></div><div><span class="mute">Penerima</span><b>${esc(o.recipient)}</b></div>${o.courier_note ? `<div><span class="mute">Catatan</span><span>${esc(o.courier_note)}</span></div>` : ''}</div>
      <div class="card"><h3 style="margin-bottom:10px">Kurir</h3>${o.courier ? `<div class="row"><div class="avatar lg o">${esc(initials(o.courier.name))}</div><div><b>${esc(o.courier.name)}</b><div class="xs mute">${o.courier.rating_count ? stars(o.courier.rating_avg) + ' (' + o.courier.rating_count + ')' : 'Kurir baru'}</div></div></div>` : '<p class="sm mute">Belum ada kurir.</p>'}</div>
      <div class="card sum"><h3 style="margin-bottom:6px">Detail makanan</h3>${o.items.map(i => `<div><span>${i.qty}× ${esc(i.name)}<div class="xs mute">${esc(i.options_text || '')}${i.note ? ' · ' + esc(i.note) : ''}</div></span><b>${rp(i.unit_price * i.qty)}</b></div>`).join('')}
        <div><span>Subtotal</span><span>${rp(o.subtotal)}</span></div><div><span>Ongkir</span><span>${rp(o.delivery_fee)}</span></div>${o.discount ? `<div><span>Voucher ${esc(o.voucher_code)}</span><span>−${rp(o.discount)}</span></div>` : ''}<div class="tot"><span>Total</span><span>${rp(o.total)}</span></div>
        <div class="xs mute">Pembayaran: ${esc(o.payment?.method || '')} (${esc(o.payment?.provider || '')}) · ${esc(o.payment?.status || '')}</div></div>
      <div class="row wrap">${canCancel(o) && !searching ? `<button class="btn ghost sm" onclick="A.cancelOrder(${o.id})">Batalkan pesanan</button>` : ''}${canCancel(o) && searching && o.courier_search !== 'none' ? `<button class="btn ghost sm" onclick="A.cancelOrder(${o.id})">Batalkan pesanan</button>` : ''}
        <button class="btn ghost sm" onclick="A.complain(${o.id})">${ic('flag')}Laporkan masalah</button>${o.status === 'SELESAI' ? `<button class="btn sm soft" onclick="A.reorder(${o.id})">Pesan Ulang</button>` : ''}</div></div></div>`);
  }, 3000);
});
function ratingCard(o) {
  window.__rt = { m: 0, c: 0 };
  const row = (k, label) => `<div style="margin:10px 0"><div class="sm b">${label}</div><div class="stars" data-k="${k}">${[1, 2, 3, 4, 5].map(n => `<button aria-label="${n} bintang" data-n="${n}" onclick="A.star('${k}',${n},this)">★</button>`).join('')}</div></div>`;
  return `<div class="card"><h3>Bagaimana pesananmu?</h3>${row('m', 'Rating kantin')}${row('c', 'Rating kurir')}<label class="f">Ulasan singkat<textarea id="rv" maxlength="300" placeholder="Ceritakan pengalamanmu"></textarea></label><button class="btn" onclick="A.rate(${o.id})">Kirim Ulasan</button></div>`;
}
A.star = (k, n, btn) => { window.__rt[k] = n; btn.parentElement.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i < n)); };
A.rate = async id => {
  if (!__rt.m || !__rt.c) return toast('Beri bintang untuk kantin dan kurir', 'err');
  const r = await act(() => api(`/api/orders/${id}/rate`, 'POST', { merchant_stars: __rt.m, courier_stars: __rt.c, review: $('#rv').value.trim() }), 'Terima kasih atas ulasanmu!'); if (r) route();
};
A.retry = async id => { await act(() => api(`/api/orders/${id}/retry-courier`, 'POST'), 'Mencari kurir lagi...'); };
A.cancelOrder = async id => {
  if (!await confirmBox('Batalkan pesanan?', 'Jika sudah dibayar, dana dikembalikan ke saldo refund. Pembatalan tidak bisa setelah kantin mulai menyiapkan makanan.', 'Ya, batalkan', true)) return;
  await act(() => api(`/api/orders/${id}/cancel`, 'POST', { reason: 'Dibatalkan oleh pembeli' }), 'Pesanan dibatalkan'); route();
};
A.payNow = async id => { const r = await act(() => api('/api/orders/' + id)); r && qrisModal(r.order); };
A.complain = id => {
  modal(`<h2>Laporkan masalah</h2><label class="f" style="margin-top:12px">Judul<input id="cs" maxlength="80" placeholder="Contoh: Pesanan kurang"></label><label class="f">Ceritakan masalahnya<textarea id="cm" maxlength="1000"></textarea></label>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" onclick="closeModal()">Batal</button><button class="btn" id="cgo">Kirim</button></div>`);
  $('#cgo').onclick = async () => { const r = await act(() => api('/api/complaints', 'POST', { order_id: id, subject: $('#cs').value, message: $('#cm').value }), 'Pengaduan terkirim ke admin'); if (r) closeModal(); };
};

/* ---------- promo ---------- */
route$(/^#\/promo$/, CUST, async () => {
  const f = await api('/api/fees');
  page(`<h1>Promo & Voucher</h1><div class="grid g3" style="margin-top:16px">${f.vouchers.map(v => `<div class="card" style="border-left:6px solid var(--orange)"><span class="badge o">${v.type === 'free_shipping' ? 'Gratis Ongkir' : v.product_name ? 'Menu Tertentu' : 'Diskon'}</span>
    <h3 style="margin:10px 0 2px">${esc(v.code)}</h3><p class="sm mute">${esc(v.description)}</p><p class="xs mute" style="margin:6px 0 12px">Syarat: ${v.min_subtotal ? 'min. belanja ' + rp(v.min_subtotal) : 'tanpa minimum'}${v.product_name ? ', berlaku untuk ' + esc(v.product_name) : ''}. Satu voucher per pesanan.</p>
    <button class="btn sm" onclick="S.voucher='${esc(v.code)}';toast('Voucher ${esc(v.code)} akan dipakai saat checkout','ok')">Pakai voucher</button></div>`).join('')}</div>`);
});

/* ---------- profil (semua role) ---------- */
route$(/^#\/profile$/, null, async () => {
  const u = (await api('/api/me')).user; S.user = u;
  const isC = u.role === 'customer';
  page(`<h1>Profil</h1><div class="grid g2" style="margin-top:16px"><div class="card"><div class="row" style="margin-bottom:16px"><div class="avatar lg">${esc(initials(u.name))}</div><div><b>${esc(u.name)}</b><div class="sm mute">@${esc(u.username)} · ${ROLE_LABEL[u.role]}</div></div></div>
    <label class="f">Nama<input id="pn" value="${esc(u.name)}" maxlength="60"></label><label class="f">No. HP<input id="pph" value="${esc(u.phone || '')}" inputmode="tel"></label>
    ${isC ? `<div class="grid g2"><label class="f">Lantai default<select id="pf"><option value="">-</option>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(f => `<option ${u.default_floor === f ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label class="f">Ruang default<select id="pr"><option value="">-</option>${Array.from({ length: 20 }, (_, i) => 101 + i).map(r => `<option ${u.default_room === r ? 'selected' : ''}>${r}</option>`).join('')}</select></label></div>` : ''}
    <button class="btn" id="psave">Simpan profil</button></div>
    <div class="stack">${isC ? `<div class="stat g"><div class="mute">Saldo refund</div><div class="n">${rp(u.refund_balance)}</div><div class="xs mute">Dari pembatalan pesanan yang sudah dibayar</div></div>
      <div class="card"><a class="btn ghost block" href="#/favorites" style="margin-bottom:8px">${ic('heart')}Menu favorit</a><a class="btn ghost block" href="#/help">${ic('help')}Bantuan</a></div>` : ''}
    <div class="card"><h3 style="margin-bottom:10px">Ganti password</h3><label class="f">Password lama<input id="cp" type="password" autocomplete="current-password"></label><label class="f">Password baru<input id="np" type="password" autocomplete="new-password"></label><button class="btn ghost" id="ppw">Ubah password</button></div>
    <button class="btn red block" onclick="A.logout()">${ic('logout')}Keluar</button></div></div>`);
  $('#psave').onclick = async () => { const r = await act(() => api('/api/profile', 'PUT', { name: $('#pn').value, phone: $('#pph').value, default_floor: $('#pf')?.value, default_room: $('#pr')?.value }), 'Profil disimpan'); if (r) { S.user = r.user; shell(); route(); } };
  $('#ppw').onclick = async () => { const r = await act(() => api('/api/profile/password', 'POST', { current: $('#cp').value, next: $('#np').value }), 'Password diubah'); if (r) { $('#cp').value = ''; $('#np').value = ''; } };
});

/* ---------- bantuan ---------- */
route$(/^#\/help$/, null, async () => {
  const faq = [
    ['Bagaimana cara memesan?', 'Pilih menu, atur variasi, tambahkan ke keranjang, pilih lantai & ruang, lalu bayar dengan QRIS. Kurir akan mencari dan mengantar pesananmu.'],
    ['Berapa ongkos kirimnya?', 'Ongkir mengikuti lantai tujuan: Rp2.000 untuk lantai 1-5, lalu naik sampai Rp4.000 di lantai 9.'],
    ['Kapan pesanan bisa dibatalkan?', 'Sebelum kantin mulai menyiapkan makanan dan sebelum kurir mengambil pesanan. Pesanan yang sudah dibayar dikembalikan ke saldo refund.'],
    ['Bagaimana cara menjadi kurir?', 'Daftar dengan memilih "Kurir" di halaman Daftar. Setelah masuk, aktifkan status Online agar menerima pesanan. Penghasilan berasal dari ongkir setiap pesanan selesai.'],
    ['Apakah pembayaran QRIS asli?', 'Tidak. Versi demo ini memakai simulasi QRIS dan tidak memproses uang sungguhan.'],
  ];
  page(`<h1>Bantuan</h1><div class="grid g2" style="margin-top:16px"><div class="card"><h3 style="margin-bottom:10px">FAQ & Panduan</h3>${faq.map(([q, a]) => `<details style="padding:10px 0;border-bottom:1px solid var(--line)"><summary class="b" style="cursor:pointer">${q}</summary><p class="sm mute" style="margin-top:6px">${a}</p></details>`).join('')}</div>
    <div class="card"><h3>Formulir pengaduan</h3><label class="f" style="margin-top:10px">Judul<input id="cs" maxlength="80"></label><label class="f">Pesan<textarea id="cm" maxlength="1000"></textarea></label><button class="btn" id="cgo">Kirim pengaduan</button></div></div>`);
  $('#cgo').onclick = async () => { const r = await act(() => api('/api/complaints', 'POST', { subject: $('#cs').value, message: $('#cm').value }), 'Pengaduan terkirim ke admin'); if (r) { $('#cs').value = ''; $('#cm').value = ''; } };
});
