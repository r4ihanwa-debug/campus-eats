/* Halaman kurir, mitra kantin, dan admin */
const COUR = ['courier'], MERCH_R = ['merchant'], ADM = ['admin'];
const statBox = (label, val, cls = '', sub = '') => `<div class="stat ${cls}"><div class="mute sm">${label}</div><div class="n">${val}</div>${sub ? `<div class="xs mute">${sub}</div>` : ''}</div>`;
const walletTable = tx => `<div class="scroll"><table class="tbl"><thead><tr><th>Waktu</th><th>Keterangan</th><th>Jenis</th><th style="text-align:right">Jumlah</th></tr></thead><tbody>${tx.length ? tx.map(t => `<tr><td>${dt(t.created_at)}</td><td>${esc(t.description)}</td><td><span class="badge x">${esc(t.type)}</span></td><td style="text-align:right;font-weight:700;color:${t.amount < 0 ? 'var(--red)' : 'var(--green-d)'}">${t.amount < 0 ? '−' : '+'}${rp(Math.abs(t.amount))}</td></tr>`).join('') : '<tr><td colspan="4" class="mute center">Belum ada riwayat</td></tr>'}</tbody></table></div>`;
const toggle = (on, fn) => `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" onclick="${fn}"></button>`;

/* =============== KURIR =============== */
route$(/^#\/c\/dashboard$/, COUR, async () => {
  await live(() => api('/api/courier/dashboard'), d => {
    page(`<h1>Dashboard Kurir</h1><div class="card row between" style="margin:16px 0;${d.online ? 'background:var(--green);color:#fff' : ''}"><div><h2>${d.online ? 'Kamu ONLINE' : 'Kamu OFFLINE'}</h2><div class="sm" style="opacity:.85">${d.online ? 'Pesanan baru akan muncul sebagai popup.' : 'Aktifkan status online untuk mulai menerima pesanan.'}</div></div>${toggle(d.online, `A.online(${!d.online})`)}</div>
      <div class="grid g4">${statBox('Pesanan hari ini', d.today_done)}${statBox('Estimasi pendapatan hari ini', rp(d.estimate_today), 'g', `Sudah masuk ${rp(d.earned_today)}`)}${statBox('Rating', stars(d.rating_avg), '', d.rating_count + ' ulasan')}${statBox('Total pengantaran', d.total_done, '', d.active + ' sedang aktif')}</div>
      <div class="sec"><h2>Saldo wallet</h2></div><div class="card row between"><div class="n b" style="font-size:1.6rem">${rp(d.balance)}</div><a class="btn soft" href="#/c/earnings">Lihat pendapatan</a></div>`);
  });
});
A.online = async on => { const r = await act(() => api('/api/courier/online', 'POST', { online: on }), on ? 'Kamu sekarang ONLINE' : 'Kamu sekarang OFFLINE'); if (r) { S.user.online = on; cur.poll && cur.poll(); } };

route$(/^#\/c\/available$/, COUR, async () => {
  await live(async () => ({ offer: (await api('/api/courier/offer')).offer, d: await api('/api/courier/dashboard') }), ({ offer, d }) => {
    page(`<h1>Pesanan Tersedia</h1>${!d.online ? `<div class="card" style="margin-top:16px;background:var(--orange-l)"><b>Kamu sedang offline.</b><p class="sm">Aktifkan Online agar bisa menerima pesanan.</p><button class="btn sm" onclick="A.online(true)">Aktifkan Online</button></div>` : ''}
      ${offer ? `<div class="card" style="margin-top:16px"><span class="badge o">Pesanan baru · sisa ${offer.remaining} detik</span><div class="sum" style="margin-top:8px"><div><span>Kantin</span><b>${esc(offer.merchant)}</b></div><div><span>Tujuan</span><b>Lantai ${offer.floor} - Ruang ${offer.room}</b></div><div><span>Ongkir</span><b>${rp(offer.fee)}</b></div></div>
        <div class="row" style="margin-top:10px"><button class="btn ghost" onclick="A.offer(${offer.id},'reject')">Tolak</button><button class="btn" onclick="A.offer(${offer.id},'accept')">Terima</button></div></div>`
        : `<div class="empty"><div class="em">📭</div><p>Belum ada pesanan masuk. Tetap online, kami akan memberi tahu!</p></div>`}`);
  }, 2000);
});
A.offer = async (id, what) => { const r = await act(() => api(`/api/courier/offers/${id}/${what}`, 'POST'), what === 'accept' ? 'Pesanan diterima' : ''); if (r) { offerShown = null; if (what === 'accept') location.hash = '#/c/active'; else cur.poll && cur.poll(); } };

const courierCard = (o, hist) => `<div class="card" style="margin-bottom:14px"><div class="row between wrap"><b>${esc(o.code)}</b>${stBadge(o.status)}</div>
  <div class="grid g2" style="margin:12px 0"><div><div class="xs mute">Ambil di</div><b>${esc(o.merchant.name)}</b><div class="xs mute">${esc(o.merchant.location || '')}</div></div><div><div class="xs mute">Antar ke</div><b>Lantai ${o.floor} · Ruang ${o.room}</b><div class="xs">Penerima: ${esc(o.recipient)}</div></div></div>
  ${o.courier_note ? `<div class="sm" style="background:var(--orange-l);padding:8px 12px;border-radius:12px;margin-bottom:8px">Catatan: ${esc(o.courier_note)}</div>` : ''}
  <div class="sm mute">${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</div><div class="row between wrap" style="margin-top:12px"><b style="color:var(--green-d)">Ongkir ${rp(o.delivery_fee)}</b>
  ${hist ? `<span class="xs mute">${dt(o.completed_at || o.created_at)}</span>` : o.status === 'DALAM_PENGANTARAN' ? `<button class="btn" onclick="A.cstep(${o.id},'complete')">Pesanan Selesai</button>`
    : o.delivery_stage === 0 ? `<button class="btn" onclick="A.cstep(${o.id},'arrived')">Saya di Kantin</button>` : `<button class="btn" ${o.food_state < 3 ? 'disabled' : ''} onclick="A.cstep(${o.id},'pickup')">Makanan Sudah Diambil</button>`}</div>
  ${!hist && o.delivery_stage < 2 ? `<div class="xs mute" style="margin-top:6px">Makanan: ${o.food_state === 3 ? '✅ siap diambil' : o.food_state === 2 ? '🍳 sedang disiapkan' : o.food_state === 1 ? 'diterima kantin' : 'menunggu kantin'}</div>` : ''}</div>`;
route$(/^#\/c\/active$/, COUR, async () => {
  await live(() => api('/api/courier/orders'), d => page(`<h1>Pesanan Aktif</h1><div style="margin-top:16px">${d.orders.length ? d.orders.map(o => courierCard(o)).join('') : '<div class="empty"><div class="em">🛵</div><p>Tidak ada pesanan aktif.</p><a class="btn" href="#/c/available" style="margin-top:12px">Lihat pesanan tersedia</a></div>'}</div>`), 2500);
});
A.cstep = async (id, step) => {
  if (step === 'complete' && !await confirmBox('Pesanan sudah diterima pembeli?', 'Pendapatan ongkir akan masuk ke walletmu.', 'Ya, selesai')) return;
  const r = await act(() => api(`/api/courier/orders/${id}/${step}`, 'POST'), step === 'complete' ? 'Pesanan selesai. Ongkir masuk wallet!' : 'Status diperbarui'); r && cur.poll && cur.poll();
};
route$(/^#\/c\/earnings$/, COUR, async () => {
  const w = await api('/api/wallet');
  page(`<h1>Pendapatan</h1><div class="grid g3" style="margin:16px 0">${statBox('Saldo wallet', rp(w.balance), 'g')}${statBox('Hari ini', rp(w.today))}${statBox('Bulan ini', rp(w.month))}</div><div class="card"><h3 style="margin-bottom:8px">Riwayat pemasukan</h3>${walletTable(w.transactions)}</div>`);
});
route$(/^#\/c\/history$/, COUR, async () => {
  const d = await api('/api/courier/orders?history=1');
  page(`<h1>Riwayat Pengantaran</h1><div style="margin-top:16px">${d.orders.length ? d.orders.map(o => courierCard(o, true)).join('') : '<div class="empty"><div class="em">🗂️</div>Belum ada riwayat.</div>'}</div>`);
});

/* =============== MITRA KANTIN =============== */
route$(/^#\/m\/dashboard$/, MERCH_R, async () => {
  await live(() => api('/api/m/dashboard'), d => {
    page(`<div class="row between wrap"><div><h1>${esc(d.merchant.name)}</h1><div class="sm mute">${stars(d.merchant.rating_avg)} (${d.merchant.rating_count} ulasan)</div></div><div class="row"><span class="b sm">${d.merchant.open ? 'Buka' : 'Tutup'}</span>${toggle(d.merchant.open, 'A.storeOpen()')}</div></div>
      <div class="grid g4" style="margin:16px 0">${statBox('Pesanan masuk (baru)', d.pending, d.pending ? 'g' : '', 'perlu diterima')}${statBox('Sedang diproses', d.processing)}${statBox('Penjualan hari ini', rp(d.today_sales), '', d.today_orders + ' pesanan selesai')}${statBox('Saldo wallet', rp(d.wallet.balance), '', 'Bulan ini ' + rp(d.wallet.month))}</div>
      <div class="grid g2"><div class="card"><h3 style="margin-bottom:10px">Penjualan 14 hari</h3><div style="height:220px"><canvas id="ch"></canvas></div></div><div class="card"><h3 style="margin-bottom:10px">Stok menipis</h3>${d.low_stock.length ? d.low_stock.map(p => `<div class="row between" style="padding:6px 0"><span>${esc(p.name)}</span><span class="badge ${p.stock ? 'o' : 'r'}">${p.stock ? 'sisa ' + p.stock : 'habis'}</span></div>`).join('') : '<p class="mute">Semua stok aman 👍</p>'}<a class="btn soft sm" href="#/m/stock" style="margin-top:10px">Atur stok</a></div></div>`);
    drawChart('ch', d.chart.labels, [{ label: 'Online', data: d.chart.online }, { label: 'Offline', data: d.chart.offline }]);
  }, 5000);
});
A.storeOpen = async () => {
  const s = (await api('/api/m/store')).merchant;
  await act(() => api('/api/m/store', 'PUT', { ...s, open: !s.open }), s.open ? 'Kantin ditutup' : 'Kantin dibuka'); cur.poll && cur.poll();
};

route$(/^#\/m\/orders$/, MERCH_R, async ({ query }) => {
  const tab = query.t || 'baru';
  const act_ = o => o.type === 'online' && !['SELESAI', 'DIBATALKAN'].includes(o.status);
  const tabs = { baru: o => act_(o) && o.food_state === 0, proses: o => act_(o) && o.food_state > 0, selesai: o => !act_(o) };
  await live(() => api('/api/m/orders'), d => {
    const n = k => d.orders.filter(tabs[k]).length;
    const list = d.orders.filter(tabs[tab]);
    page(`<div class="row between wrap"><h1>Pesanan</h1><button class="btn orange" onclick="A.offlineForm()">${ic('plus')}Pesanan Offline</button></div>
      <div class="chips" style="margin:14px 0">${[['baru', 'Baru'], ['proses', 'Diproses'], ['selesai', 'Selesai / Batal']].map(([k, l]) => `<a class="chip ${tab === k ? 'on' : ''}" href="#/m/orders?t=${k}">${l} (${n(k)})</a>`).join('')}</div>
      ${list.length ? list.map(o => `<div class="card" style="margin-bottom:12px"><div class="row between wrap"><div><b>${esc(o.code)}</b> <span class="badge ${o.type === 'offline' ? 'x' : ''}">${o.type === 'offline' ? 'Offline' : 'Online'}</span> <span class="xs mute">${dt(o.created_at)}</span></div>${stBadge(o.status)}</div>
        <div style="margin:10px 0">${o.items.map(i => `<div class="row between"><span>${i.qty}× <b>${esc(i.name)}</b><div class="xs mute">${esc(i.options_text || '')}${i.note ? ' · Catatan: ' + esc(i.note) : ''}</div></span><span>${rp(i.unit_price * i.qty)}</span></div>`).join('')}</div>
        <div class="row between wrap"><div class="sm mute">${o.type === 'online' ? `Antar: Lt ${o.floor} R ${o.room} · ${o.courier ? 'Kurir: ' + esc(o.courier.name) : 'Belum ada kurir'}` : 'Dibayar di tempat'}${o.status === 'DIBATALKAN' ? ' · ' + esc(o.cancel_reason || '') : ''}</div><b>${rp(o.subtotal)}</b></div>
        ${act_(o) ? `<div class="row wrap" style="margin-top:10px">${o.food_state === 0 ? `<button class="btn sm" onclick="A.mact(${o.id},'accept')">Terima Pesanan</button><button class="btn sm ghost" onclick="A.mreject(${o.id})">Tolak</button>` : ''}
          ${o.food_state === 1 ? `<button class="btn sm" onclick="A.mact(${o.id},'prepare')">Sedang Disiapkan</button><button class="btn sm ghost" onclick="A.mreject(${o.id})">Tolak</button>` : ''}${o.food_state === 2 ? `<button class="btn sm orange" onclick="A.mact(${o.id},'ready')">Siap Diambil</button>` : ''}${o.food_state === 3 ? '<span class="badge">Menunggu kurir mengambil</span>' : ''}</div>` : ''}</div>`).join('') : '<div class="empty"><div class="em">🧾</div>Tidak ada pesanan di tab ini.</div>'}`);
  }, 3000);
});
A.mact = async (id, what) => { const r = await act(() => api(`/api/m/orders/${id}/${what}`, 'POST'), 'Status pesanan diperbarui'); r && cur.poll && cur.poll(); };
A.mreject = async id => { const why = await promptBox('Tolak pesanan', 'Alasan penolakan', 'Contoh: bahan habis'); if (!why) return; const r = await act(() => api(`/api/m/orders/${id}/reject`, 'POST', { reason: why }), 'Pesanan ditolak, dana dikembalikan ke pembeli'); r && cur.poll && cur.poll(); };
A.offlineForm = async () => {
  const { products } = await api('/api/m/products'); const items = products.filter(p => p.active && p.stock > 0);
  modal(`<h2>Pesanan Offline</h2><p class="sm mute" style="margin:4px 0 12px">Pembeli langsung di kantin. Stok berkurang otomatis dan tidak butuh kurir (opsi memakai pilihan bawaan menu).</p>
    ${items.map(p => `<div class="row between" style="padding:6px 0"><div><b>${esc(p.name)}</b><div class="xs mute">${rp(p.base_price)} · stok ${p.stock}</div></div><input type="number" min="0" max="${p.stock}" value="0" data-p="${p.id}" style="width:74px;margin:0"></div>`).join('') || '<p class="mute">Tidak ada menu tersedia.</p>'}
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" onclick="closeModal()">Batal</button><button class="btn" id="offgo">Simpan Pesanan</button></div>`);
  $('#offgo').onclick = async () => {
    const lines = [...document.querySelectorAll('[data-p]')].map(i => ({ product_id: +i.dataset.p, qty: +i.value })).filter(l => l.qty > 0);
    if (!lines.length) return toast('Isi jumlah minimal satu menu', 'err');
    const r = await act(() => api('/api/m/offline', 'POST', { items: lines }), 'Pesanan offline tercatat, stok diperbarui'); if (r) { closeModal(); route(); }
  };
};

/* ---- menu ---- */
const IMGS = [['rice', 'Rice box'], ['geprek', 'Ayam geprek'], ['bakar', 'Ayam bakar'], ['mie', 'Mie'], ['default', 'Umum']];
route$(/^#\/m\/menu$/, MERCH_R, async () => {
  const draw = async () => {
    const d = await api('/api/m/products'); S.cache.mp = d;
    page(`<div class="row between wrap"><h1>Menu</h1><button class="btn" onclick="A.productForm()">${ic('plus')}Tambah Menu</button></div><div class="menu" style="margin-top:16px">${d.products.length ? d.products.map(p => `<div class="food" style="cursor:default">${art(p.image)}${p.popular ? '<span class="tag">Populer</span>' : ''}<div class="body"><div class="row between"><h3>${esc(p.name)}</h3>${toggle(p.active, `A.mactive(${p.id},${!p.active})`)}</div>
      <div class="xs mute">${esc(p.category)} · stok ${p.stock} · ${p.groups.length} grup variasi</div><div class="price" style="margin:6px 0 10px">${rp(p.base_price)}</div><div class="row"><button class="btn sm ghost" onclick="A.productForm(${p.id})">${ic('edit')}Edit</button><button class="btn sm ghost" onclick="A.pdel(${p.id})">${ic('trash')}Hapus</button></div></div></div>`).join('') : '<div class="empty" style="grid-column:1/-1">Belum ada menu.</div>'}</div>`);
  };
  A.reloadMenu = draw; await draw();
});
A.mactive = async (id, on) => { await act(() => api(`/api/m/products/${id}/active`, 'PATCH', { active: on }), on ? 'Menu diaktifkan' : 'Menu dinonaktifkan'); A.reloadMenu(); };
A.pdel = async id => { if (!await confirmBox('Hapus menu?', 'Menu akan hilang dari daftar. Riwayat pesanan lama tetap tersimpan.', 'Hapus', true)) return; await act(() => api('/api/m/products/' + id, 'DELETE'), 'Menu dihapus'); A.reloadMenu(); };
A.vrow = (v = {}) => `<div class="vrow"><input placeholder="Grup (mis. Saus)" value="${esc(v.group_name || '')}" data-k="group_name"><input placeholder="Pilihan" value="${esc(v.label || '')}" data-k="label"><input type="number" placeholder="+Harga" value="${v.price_delta || 0}" data-k="price_delta">
  <label><input type="checkbox" data-k="required" ${v.required !== 0 ? 'checked' : ''}>wajib</label><label><input type="checkbox" data-k="is_default" ${v.is_default ? 'checked' : ''}>default</label><input placeholder="Tampil jika (Ukuran=Large)" value="${esc(v.show_if || '')}" data-k="show_if"><button class="btn sm ghost" type="button" onclick="this.parentElement.remove()" aria-label="Hapus">${ic('x')}</button></div>`;
A.productForm = id => {
  const d = S.cache.mp, p = id ? d.products.find(x => x.id === id) : { name: '', description: '', base_price: 15000, stock: 20, active: true, popular: false, image: 'default', category: 'Ayam', groups: [] };
  const rows = []; (p.groups || []).forEach(g => g.items.forEach(i => rows.push({ group_name: g.name, label: i.label, price_delta: i.price_delta, required: g.required ? 1 : 0, is_default: i.is_default ? 1 : 0, show_if: g.show_if })));
  window.__img = p.image;
  modal(`<h2>${id ? 'Edit' : 'Tambah'} Menu</h2><div style="margin-top:12px"><label class="f">Nama menu<input id="f-name" value="${esc(p.name)}" maxlength="60"></label>
    <div class="grid g2"><label class="f">Harga dasar (Rp)<input id="f-price" type="number" min="500" value="${p.base_price}"></label><label class="f">Stok<input id="f-stock" type="number" min="0" value="${p.stock}"></label></div>
    <div class="grid g2"><label class="f">Kategori<input id="f-cat" list="cats" value="${esc(p.category || '')}"><datalist id="cats">${d.categories.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist></label><label class="f">Ilustrasi bawaan<select id="f-ill">${IMGS.map(([k, l]) => `<option value="${k}" ${p.image === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <label class="f">Unggah foto makanan (maks. ±1,8 MB)<input id="f-file" type="file" accept="image/png,image/jpeg,image/webp"></label>
    <label class="f">Deskripsi<textarea id="f-desc" maxlength="300">${esc(p.description)}</textarea></label>
    <div class="row" style="margin-bottom:12px"><label class="row gap-s"><input type="checkbox" id="f-act" ${p.active ? 'checked' : ''}>Aktif</label><label class="row gap-s"><input type="checkbox" id="f-pop" ${p.popular ? 'checked' : ''}>Tandai populer</label></div>
    <div class="b">Variasi menu</div><p class="xs mute" style="margin-bottom:8px">Setiap baris = satu pilihan. Pilihan dengan nama grup sama membentuk satu kelompok. "Tampil jika" contoh <code>Ukuran=Large</code>.</p>
    <div id="vrows">${rows.map(A.vrow).join('')}</div><button class="btn sm ghost" type="button" id="addv">${ic('plus')}Tambah pilihan</button></div>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" onclick="closeModal()">Batal</button><button class="btn" id="f-save">Simpan</button></div>`, { wide: true });
  $('#addv').onclick = () => $('#vrows').insertAdjacentHTML('beforeend', A.vrow());
  $('#f-file').onchange = e => { const f = e.target.files[0]; if (!f) return; if (f.size > 1.8e6) { e.target.value = ''; return toast('Ukuran foto terlalu besar (maks 1,8 MB)', 'err'); } const r = new FileReader(); r.onload = () => { window.__img = r.result; toast('Foto siap disimpan', 'ok'); }; r.readAsDataURL(f); };
  $('#f-ill').onchange = e => { if (!String(window.__img).startsWith('data:')) window.__img = e.target.value; };
  $('#f-save').onclick = async () => {
    const variants = [...document.querySelectorAll('.vrow')].map(r => { const o = {}; r.querySelectorAll('[data-k]').forEach(i => { o[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; }); return o; }).filter(v => v.group_name.trim() && v.label.trim());
    const body = { name: $('#f-name').value, base_price: +$('#f-price').value, stock: +$('#f-stock').value, category: $('#f-cat').value || 'Lainnya', description: $('#f-desc').value, active: $('#f-act').checked, popular: $('#f-pop').checked, image: String(window.__img).startsWith('data:') ? window.__img : $('#f-ill').value, variants };
    const r = await act(() => id ? api('/api/m/products/' + id, 'PUT', body) : api('/api/m/products', 'POST', body), 'Menu disimpan'); if (r) { closeModal(); A.reloadMenu(); }
  };
};
route$(/^#\/m\/stock$/, MERCH_R, async () => {
  const d = await api('/api/m/products');
  page(`<h1>Stok</h1><p class="sm mute" style="margin:6px 0 16px">Stok dipakai bersama oleh pesanan online dan offline.</p><div class="card scroll"><table class="tbl"><thead><tr><th>Menu</th><th>Status</th><th>Stok</th><th></th></tr></thead><tbody>${d.products.map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${p.active ? (p.stock ? '<span class="badge">Tersedia</span>' : '<span class="badge r">Habis</span>') : '<span class="badge x">Nonaktif</span>'}</td>
    <td><input type="number" min="0" value="${p.stock}" id="s${p.id}" style="width:100px;margin:0"></td><td><button class="btn sm" onclick="A.stock(${p.id})">Simpan</button></td></tr>`).join('')}</tbody></table></div>`);
});
A.stock = async id => { await act(() => api(`/api/m/products/${id}/stock`, 'PATCH', { stock: +$('#s' + id).value }), 'Stok diperbarui'); };
route$(/^#\/m\/sales$/, MERCH_R, async ({ query }) => {
  const mode = query.mode === 'monthly' ? 'monthly' : 'daily', r = await api('/api/m/report?mode=' + mode);
  page(`<div class="row between wrap"><h1>Laporan Penjualan</h1><div class="chips"><a class="chip ${mode === 'daily' ? 'on' : ''}" href="#/m/sales?mode=daily">Harian</a><a class="chip ${mode === 'monthly' ? 'on' : ''}" href="#/m/sales?mode=monthly">Bulanan</a></div></div>
    <div class="grid g3" style="margin:16px 0">${statBox('Total penjualan', rp(r.total), 'g')}${statBox('Online', rp(r.online.reduce((a, b) => a + b, 0)))}${statBox('Offline', rp(r.offline.reduce((a, b) => a + b, 0)))}</div>
    <div class="card"><div style="height:260px"><canvas id="ch"></canvas></div></div><div class="card scroll" style="margin-top:16px"><table class="tbl"><thead><tr><th>${mode === 'daily' ? 'Tanggal' : 'Bulan'}</th><th>Pesanan</th><th>Online</th><th>Offline</th></tr></thead><tbody>${r.labels.map((l, i) => `<tr><td>${esc(l)}</td><td>${r.orders[i]}</td><td>${rp(r.online[i])}</td><td>${rp(r.offline[i])}</td></tr>`).reverse().join('')}</tbody></table></div>`);
  drawChart('ch', r.labels, [{ label: 'Online', data: r.online }, { label: 'Offline', data: r.offline }]);
});
route$(/^#\/m\/earnings$/, MERCH_R, async () => {
  const w = await api('/api/wallet');
  page(`<h1>Pendapatan</h1><p class="sm mute">Dana pesanan online masuk ke wallet saat pesanan selesai.</p><div class="grid g3" style="margin:16px 0">${statBox('Saldo wallet', rp(w.balance), 'g')}${statBox('Hari ini', rp(w.today))}${statBox('Bulan ini', rp(w.month))}</div><div class="card"><h3 style="margin-bottom:8px">Riwayat transaksi</h3>${walletTable(w.transactions)}</div>`);
});
route$(/^#\/m\/store$/, MERCH_R, async () => {
  const { merchant: m } = await api('/api/m/store');
  page(`<h1>Pengaturan Toko</h1><div class="card" style="margin-top:16px;max-width:560px"><label class="f">Nama kantin<input id="s-n" value="${esc(m.name)}" maxlength="50"></label><label class="f">Deskripsi<textarea id="s-d" maxlength="300">${esc(m.description || '')}</textarea></label>
    <label class="f">Lokasi pengambilan<input id="s-l" value="${esc(m.location || '')}" maxlength="100"></label><label class="f">Estimasi penyiapan (menit)<input id="s-e" type="number" min="3" max="60" value="${m.eta_min}"></label>
    <label class="row f"><input type="checkbox" id="s-o" ${m.open ? 'checked' : ''}> Kantin buka (menerima pesanan online)</label><button class="btn" id="s-save">Simpan</button></div>`);
  $('#s-save').onclick = async () => { await act(() => api('/api/m/store', 'PUT', { name: $('#s-n').value, description: $('#s-d').value, location: $('#s-l').value, eta_min: +$('#s-e').value, open: $('#s-o').checked }), 'Pengaturan toko disimpan'); };
});

/* =============== ADMIN =============== */
route$(/^#\/a\/overview$/, ADM, async () => {
  await live(() => api('/api/admin/overview'), d => {
    page(`<h1>Overview Platform</h1><div class="grid g4" style="margin:16px 0">${statBox('Pembeli', d.customers)}${statBox('Kurir', d.couriers, '', d.couriers_online + ' online')}${statBox('Kantin', d.merchants)}${statBox('Pesanan aktif', d.orders_active, d.orders_active ? 'g' : '')}
      ${statBox('Total pesanan', d.orders)}${statBox('Transaksi', d.transactions)}${statBox('Nilai transaksi selesai', rp(d.gross))}${statBox('Pendapatan platform', rp(d.platform_balance), '', d.complaints_open + ' pengaduan baru')}</div>
      <div class="card"><h3 style="margin-bottom:10px">Penjualan 14 hari terakhir</h3><div style="height:240px"><canvas id="ch"></canvas></div></div>`);
    drawChart('ch', d.chart.labels, [{ label: 'Online', data: d.chart.online }, { label: 'Offline', data: d.chart.offline }]);
  }, 5000);
});
function usersView(role, title) {
  route$(new RegExp(`^#/a/${title.path}$`), ADM, async () => {
    page(`<h1>${title.label}</h1><div class="toolbar" style="margin-top:14px"><input id="uq" placeholder="Cari nama / username"><select id="us"><option value="">Semua status</option><option value="active">Aktif</option><option value="inactive">Nonaktif</option></select></div><div class="card scroll" id="ut"></div>`);
    let timer; const load = async () => {
      const r = await api(`/api/admin/users?${role ? 'role=' + role + '&' : ''}q=${encodeURIComponent($('#uq').value)}&status=${$('#us').value}`);
      $('#ut').innerHTML = `<table class="tbl"><thead><tr><th>Nama</th><th>Username</th><th>Peran</th><th>Info</th><th>Status</th><th>Bergabung</th><th></th></tr></thead><tbody>${r.users.map(u => `<tr><td><b>${esc(u.name)}</b><div class="xs mute">${esc(u.phone || '')}</div></td><td>@${esc(u.username)}</td><td>${ROLE_LABEL[u.role]}</td>
        <td class="xs">${u.role === 'courier' ? (u.online ? '🟢 online' : '⚪ offline') + ' · ' + stars(u.rating) : u.role === 'merchant' ? esc(u.store || '') : ''} · ${u.orders} pesanan</td><td><span class="badge ${u.active ? '' : 'r'}">${u.active ? 'Aktif' : 'Nonaktif'}</span></td><td class="xs">${dt(u.created_at)}</td>
        <td style="white-space:nowrap">${u.role === 'admin' ? '' : `<button class="btn sm ghost" onclick="A.uactive(${u.id},${!u.active},'${esc(u.name).replace(/'/g, '')}')">${u.active ? 'Nonaktifkan' : 'Aktifkan'}</button> ${['courier', 'merchant'].includes(u.role) ? `<button class="btn sm red" onclick="A.udel(${u.id},'${esc(u.name).replace(/'/g, '')}')">Hapus</button>` : ''}`}</td></tr>`).join('') || '<tr><td colspan="7" class="center mute">Tidak ada data</td></tr>'}</tbody></table>`;
    };
    A.reloadUsers = load; $('#uq').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); }; $('#us').onchange = load; await load();
  });
}
usersView('', { path: 'users', label: 'Semua Pengguna' }); usersView('courier', { path: 'couriers', label: 'Kurir' }); usersView('merchant', { path: 'merchants', label: 'Kantin' });
A.uactive = async (id, on, name) => {
  if (!on && !await confirmBox('Nonaktifkan akun?', `${name} tidak akan bisa masuk sampai diaktifkan kembali.`, 'Nonaktifkan', true)) return;
  await act(() => api(`/api/admin/users/${id}/active`, 'POST', { active: on }), on ? 'Akun diaktifkan' : 'Akun dinonaktifkan'); A.reloadUsers();
};
A.udel = async (id, name) => {
  if (!await confirmBox('Hapus akun?', `Akun ${name} akan dihapus permanen dari daftar dan tidak bisa masuk lagi. Riwayat transaksi tetap tersimpan.`, 'Hapus akun', true)) return;
  await act(() => api('/api/admin/users/' + id, 'DELETE'), 'Akun dihapus'); A.reloadUsers();
};
route$(/^#\/a\/orders$/, ADM, async () => {
  page(`<h1>Semua Pesanan</h1><div class="toolbar" style="margin-top:14px"><input id="oq" placeholder="Cari kode pesanan"><select id="os"><option value="">Semua status</option>${STEPS.concat([['DIBATALKAN', 'Dibatalkan']]).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div><div class="card scroll" id="ot2"></div>`);
  let timer; const load = async () => {
    const r = await api(`/api/admin/orders?q=${encodeURIComponent($('#oq').value)}&status=${$('#os').value}`);
    $('#ot2').innerHTML = `<table class="tbl"><thead><tr><th>Kode</th><th>Jenis</th><th>Kantin</th><th>Pembeli</th><th>Kurir</th><th>Total</th><th>Status</th><th>Waktu</th></tr></thead><tbody>${r.orders.map(o => `<tr><td><b>${esc(o.code)}</b></td><td>${o.type}</td><td>${esc(o.merchant_name)}</td><td>${esc(o.customer_name || '-')}</td><td>${esc(o.courier_name || '-')}</td><td>${rp(o.total)}</td><td>${stBadge(o.status)}</td><td class="xs">${dt(o.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="center mute">Tidak ada data</td></tr>'}</tbody></table>`;
  };
  $('#oq').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); }; $('#os').onchange = load; await load();
  cur.poll = load;
});
route$(/^#\/a\/transactions$/, ADM, async () => {
  const r = await api('/api/admin/transactions');
  page(`<h1>Transaksi</h1><div class="card scroll" style="margin:16px 0"><h3 style="margin-bottom:8px">Pembayaran</h3><table class="tbl"><thead><tr><th>Waktu</th><th>Pesanan</th><th>Metode</th><th>Jumlah</th><th>Status</th></tr></thead><tbody>${r.payments.map(p => `<tr><td>${dt(p.created_at)}</td><td>${esc(p.code)}</td><td>${esc(p.method)} (${esc(p.provider)})</td><td>${rp(p.amount)}</td><td><span class="badge ${p.status === 'PAID' ? '' : p.status === 'PENDING' ? 'o' : 'x'}">${p.status}</span></td></tr>`).join('') || '<tr><td colspan="5" class="mute center">Belum ada</td></tr>'}</tbody></table></div>
    <div class="card scroll"><h3 style="margin-bottom:8px">Penyelesaian dana (wallet)</h3><table class="tbl"><thead><tr><th>Waktu</th><th>Penerima</th><th>Keterangan</th><th style="text-align:right">Jumlah</th></tr></thead><tbody>${r.wallet.map(t => `<tr><td>${dt(t.created_at)}</td><td>${esc(t.user_name)} <span class="badge x">${ROLE_LABEL[t.role]}</span></td><td>${esc(t.description)}</td><td style="text-align:right;font-weight:700">${rp(t.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="mute center">Belum ada</td></tr>'}</tbody></table></div>`);
});
route$(/^#\/a\/reports$/, ADM, async ({ query }) => {
  const mode = query.mode === 'monthly' ? 'monthly' : 'daily', r = await api('/api/admin/report?mode=' + mode);
  page(`<div class="row between wrap"><h1>Laporan</h1><div class="chips"><a class="chip ${mode === 'daily' ? 'on' : ''}" href="#/a/reports?mode=daily">Harian</a><a class="chip ${mode === 'monthly' ? 'on' : ''}" href="#/a/reports?mode=monthly">Bulanan</a></div></div>
    <div class="grid g3" style="margin:16px 0">${statBox('Penjualan makanan', rp(r.total), 'g')}${statBox('Pesanan selesai', r.count)}${statBox('Ongkir terkumpul', rp(r.fees.reduce((a, b) => a + b, 0)))}</div>
    <div class="card"><div style="height:250px"><canvas id="ch"></canvas></div></div>
    <div class="card scroll" style="margin-top:16px"><h3 style="margin-bottom:8px">Laporan masalah & pengaduan</h3><table class="tbl"><thead><tr><th>Waktu</th><th>Pengirim</th><th>Pesanan</th><th>Judul</th><th>Pesan</th><th>Status</th><th></th></tr></thead><tbody>${r.complaints.map(c => `<tr><td class="xs">${dt(c.created_at)}</td><td>${esc(c.user_name)}<div class="xs mute">${ROLE_LABEL[c.role]}</div></td><td>${esc(c.code || '-')}</td><td><b>${esc(c.subject)}</b></td><td style="max-width:260px">${esc(c.message)}</td><td><span class="badge ${c.status === 'baru' ? 'o' : ''}">${c.status}</span></td><td>${c.status === 'baru' ? `<button class="btn sm soft" onclick="A.cres(${c.id})">Selesai</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="mute center">Belum ada pengaduan</td></tr>'}</tbody></table></div>`);
  drawChart('ch', r.labels, [{ label: 'Online', data: r.online }, { label: 'Offline', data: r.offline }]);
});
A.cres = async id => { await act(() => api(`/api/admin/complaints/${id}/resolve`, 'POST'), 'Pengaduan ditandai selesai'); route(); };
route$(/^#\/a\/settings$/, ADM, async () => {
  const s = await api('/api/admin/settings');
  page(`<h1>Pengaturan Platform</h1><div class="grid g2" style="margin-top:16px"><div class="card"><h3 style="margin-bottom:10px">Biaya pengantaran per lantai</h3><div class="grid g3">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(f => `<label class="f">Lantai ${f}<input type="number" min="0" id="fee${f}" value="${s.fees[f]}"></label>`).join('')}</div>
    <div class="grid g3"><label class="f">Komisi platform (%)<input type="number" min="0" max="50" id="cm" value="${s.commission_pct}"></label><label class="f">Batas respon kurir (dtk)<input type="number" id="ot" min="10" max="120" value="${s.offer_timeout_sec}"></label><label class="f">Batas bayar (dtk)<input type="number" id="pt" min="60" max="1800" value="${s.payment_timeout_sec}"></label></div><button class="btn" id="set-save">Simpan pengaturan</button></div>
    <div class="card"><h3 style="margin-bottom:10px">Voucher</h3>${s.vouchers.map(v => `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><div><b>${esc(v.code)}</b> <span class="badge ${v.active ? '' : 'x'}">${v.active ? 'aktif' : 'nonaktif'}</span><div class="xs mute">${esc(v.description)}</div></div><button class="btn sm ghost" onclick="A.vtoggle('${esc(v.code)}')">${v.active ? 'Matikan' : 'Aktifkan'}</button></div>`).join('')}
      <h4 style="margin:14px 0 6px">Tambah voucher</h4><div class="grid g2"><label class="f">Kode<input id="vcode" maxlength="20"></label><label class="f">Tipe<select id="vtype"><option value="fixed">Diskon Rp</option><option value="percent">Diskon %</option><option value="free_shipping">Gratis ongkir</option></select></label><label class="f">Nilai<input type="number" id="vval" value="2000"></label><label class="f">Min. belanja<input type="number" id="vmin" value="0"></label></div><label class="f">Deskripsi<input id="vdesc" maxlength="120"></label><button class="btn ghost" id="vadd">Tambah voucher</button></div></div>`);
  $('#set-save').onclick = async () => { const fees = {}; for (let f = 1; f <= 9; f++) fees[f] = +$('#fee' + f).value; await act(() => api('/api/admin/settings', 'PUT', { fees, commission_pct: +$('#cm').value, offer_timeout_sec: +$('#ot').value, payment_timeout_sec: +$('#pt').value }), 'Pengaturan disimpan'); };
  $('#vadd').onclick = async () => { const r = await act(() => api('/api/admin/vouchers', 'POST', { code: $('#vcode').value, type: $('#vtype').value, value: +$('#vval').value, min_subtotal: +$('#vmin').value, description: $('#vdesc').value }), 'Voucher ditambahkan'); r && route(); };
});
A.vtoggle = async code => { await act(() => api(`/api/admin/vouchers/${code}/toggle`, 'POST')); route(); };
