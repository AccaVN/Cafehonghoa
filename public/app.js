/* ================= state ================= */
const ALL_CAT = "__all__";
const STORE_INFO = {
  address: "Nhà thuốc tây Hồng Hoa (cũ) 139/A quốc lộ 57B, khu phố 1, Xã Bình Đại, Tỉnh Vĩnh Long (Bến Tre cũ)",
  hoursText: "07:00 - 21:00",
  openHour: 7, openMinute: 0, closeHour: 21, closeMinute: 0,
  phoneDisplay: "0909.777.621", phoneTel: "0909777621",
};
function isStoreOpenNow() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const open = STORE_INFO.openHour * 60 + STORE_INFO.openMinute;
  const close = STORE_INFO.closeHour * 60 + STORE_INFO.closeMinute;
  return mins >= open && mins < close;
}
let menu = null;      // {categories, products, toppings, sugarLevels, iceLevels}
let cart = [];         // local cart, not persisted server-side until checkout
let me = null;         // {username, role} | null
let activeCategory = null;
let view = "customer"; // customer | admin
let adminTab_ = "products";
// Số bàn lấy từ URL khi khách quét mã QR dán tại bàn, ví dụ: /?table=3
const TABLE_FROM_URL = new URLSearchParams(location.search).get("table");

const money = (n) => Number(n || 0).toLocaleString("vi-VN") + "đ";
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ================= tiny fetch helper ================= */
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || "Đã có lỗi xảy ra.");
  return data;
}

/* ================= toast / confirm / prompt (thay cho alert/confirm/prompt) ================= */
function toast(msg, type = "info") {
  const wrap = document.getElementById("toastWrap");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .25s"; setTimeout(() => el.remove(), 250); }, 2800);
}
function showConfirm(message, { title = "Xác nhận", okLabel = "Xác nhận", cancelLabel = "Huỷ", danger = false } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement("div"); ov.className = "confirm-overlay";
    ov.innerHTML = `<div class="confirm-box"><h3>${esc(title)}</h3><p>${esc(message)}</p><div class="confirm-actions"><button class="btn light" data-a="cancel">${esc(cancelLabel)}</button><button class="btn ${danger ? "danger" : "orange"}" data-a="ok">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => {
      if (e.target === ov) { ov.remove(); resolve(false); return; }
      const a = e.target.dataset.a;
      if (a) { ov.remove(); resolve(a === "ok"); }
    });
  });
}
function showPrompt(message, { title = "Nhập thông tin", placeholder = "", type = "text" } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement("div"); ov.className = "confirm-overlay";
    ov.innerHTML = `<div class="confirm-box"><h3>${esc(title)}</h3><p>${esc(message)}</p><input id="hhPromptInput" type="${type}" placeholder="${esc(placeholder)}" autocomplete="off"><div class="confirm-actions"><button class="btn light" data-a="cancel">Huỷ</button><button class="btn orange" data-a="ok">Xác nhận</button></div></div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector("#hhPromptInput"); input.focus();
    function finish(v) { ov.remove(); resolve(v); }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(input.value.trim() || null); if (e.key === "Escape") finish(null); });
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return finish(null);
      if (e.target.dataset.a === "cancel") finish(null);
      if (e.target.dataset.a === "ok") finish(input.value.trim() || null);
    });
  });
}
function showStatusPicker(current, statuses) {
  return new Promise((resolve) => {
    const ov = document.createElement("div"); ov.className = "confirm-overlay";
    ov.innerHTML = `<div class="confirm-box"><h3>Đổi trạng thái đơn</h3><div class="opts" style="justify-content:center;margin-bottom:16px">${statuses.map((s) => `<button type="button" class="opt ${s === current ? "selected" : ""}" data-s="${esc(s)}">${esc(s)}</button>`).join("")}</div><div class="confirm-actions"><button class="btn light" data-a="cancel">Huỷ</button></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => {
      if (e.target === ov) return (ov.remove(), resolve(null));
      if (e.target.dataset.s) { ov.remove(); resolve(e.target.dataset.s); return; }
      if (e.target.dataset.a === "cancel") { ov.remove(); resolve(null); }
    });
  });
}

/* ================= boot ================= */
async function boot() {
  const root = document.getElementById("root");
  root.innerHTML = `<div style="padding:60px;text-align:center;color:var(--muted)">Đang tải thực đơn Café Hồng Hoa…</div>`;
  try {
    [menu, me] = await Promise.all([api("GET", "/api/menu"), api("GET", "/api/auth/me")]);
    activeCategory = ALL_CAT;
    render();
  } catch (e) {
    root.innerHTML = `<div style="padding:60px;text-align:center;color:#b3261e">Không kết nối được tới máy chủ. Vui lòng kiểm tra server đang chạy.</div>`;
  }
}
async function refreshMenu() { menu = await api("GET", "/api/menu"); }

function render() { view === "customer" ? renderCustomer() : renderAdmin(); }

/* ================= CUSTOMER VIEW ================= */
function renderCustomer() {
  const root = document.getElementById("root");
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);
  const cartTotal = cart.reduce((s, i) => s + i.subtotal, 0);
  root.innerHTML = `
  <header>
    <div class="brand"><img src="/assets/logo-icon.png" alt="Hồng Hoa"><span class="brand-text">Hồng Hoa<small>coffee and tea</small></span></div>
    <button class="btn-icon" title="Trang quản trị" onclick="openLogin()"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button class="btn orange" onclick="openCart()" style="display:flex;align-items:center;gap:6px"><svg class="icon" viewBox="0 0 24 24"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 2H2"/><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="20" r="1.4" fill="currentColor" stroke="none"/></svg> ${cartCount}</button>
  </header>
  <div class="hero">
    <h1>Café Hồng Hoa</h1>
    <p class="hero-tag">Chọn món · Tùy chỉnh đường, đá và topping theo ý bạn</p>
    <div class="hero-info">
      <div class="hero-info-row"><strong>Trạng thái:</strong> <span class="${isStoreOpenNow() ? "status-open" : "status-closed"}">${isStoreOpenNow() ? "Đang mở cửa" : "Đang đóng cửa"}</span></div>
      ${TABLE_FROM_URL ? `<div class="hero-info-row"><strong>Bàn của bạn:</strong> Bàn ${esc(TABLE_FROM_URL)}</div>` : ""}
      <div class="hero-info-row"><strong>Địa chỉ:</strong> ${esc(STORE_INFO.address)}</div>
      <div class="hero-info-row"><strong>Giờ mở cửa:</strong> ${esc(STORE_INFO.hoursText)}</div>
      <div class="hero-info-row"><strong>SĐT:</strong> <a href="tel:${STORE_INFO.phoneTel}">${esc(STORE_INFO.phoneDisplay)}</a></div>
    </div>
  </div>
  <nav class="cats">
    <button class="cat ${activeCategory === ALL_CAT ? "active" : ""}" onclick="setCategory('${ALL_CAT}')">Tất cả</button>
    ${menu.categories.map((c) => `<button class="cat ${c.id === activeCategory ? "active" : ""}" onclick="setCategory('${c.id}')">${esc(c.name)}</button>`).join("")}
  </nav>
  <main id="grid"></main>
  ${cart.length ? `<button class="cart-bar" onclick="openCart()"><span>${cartCount} món</span><span>Xem giỏ hàng</span><strong>${money(cartTotal)}</strong></button>` : ""}
  `;
  renderGrid();
}
function setCategory(id) { activeCategory = id; renderCustomer(); }
function renderGrid() {
  const grid = document.getElementById("grid");
  function cardHtml(p) {
    const from = Math.min(...p.sizes.map((s) => s.price));
    const soldout = p.status === "soldout";
    return `<article class="card ${soldout ? "soldout" : ""}">
      <div class="pic">${p.image ? `<img src="${esc(p.image)}">` : "☕"}${soldout ? `<span class="tag">Hết món</span>` : `<button class="add" onclick="openProduct('${p.id}')"><svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`}</div>
      <div class="info">
        <div class="name">${esc(p.name)}</div>
        <div class="foot"><span class="price">${money(from)}</span></div>
      </div></article>`;
  }
  if (activeCategory === ALL_CAT) {
    const sections = menu.categories
      .map((c) => ({ c, items: menu.products.filter((p) => p.categoryId === c.id && p.status !== "hidden") }))
      .filter((s) => s.items.length);
    if (!sections.length) { grid.innerHTML = `<p class="empty">Chưa có món nào.</p>`; return; }
    grid.innerHTML = sections
      .map((s) => `<section class="cat-section"><h2 class="cat-section-title">${esc(s.c.name)}</h2><div class="grid">${s.items.map(cardHtml).join("")}</div></section>`)
      .join("");
    return;
  }
  const items = menu.products.filter((p) => p.categoryId === activeCategory && p.status !== "hidden");
  if (!items.length) { grid.innerHTML = `<p class="empty">Danh mục này chưa có món.</p>`; return; }
  grid.innerHTML = `<div class="grid">${items.map(cardHtml).join("")}</div>`;
}

/* ---- product customization sheet ---- */
function openProduct(productId, editCartId = null) {
  const p = menu.products.find((x) => x.id === productId);
  const tops = menu.toppings.filter((t) => t.active && p.toppingIds.includes(t.id));
  const existing = editCartId ? cart.find((i) => i.cartId === editCartId) : null;
  const state = {
    sizeId: existing?.sizeId || p.sizes[0]?.id,
    // Mặc định: "Ngọt vừa" cho đường, "Đá bình thường" cho đá — nếu vì lý do gì đó
    // 2 mức này không còn tồn tại trong danh mục (bị xoá/đổi tên), sẽ rơi về mức đầu tiên.
    sugar: existing?.sugar || menu.sugarLevels.find((s) => s.name === "Ngọt vừa")?.name || menu.sugarLevels[0]?.name,
    ice: existing?.ice || menu.iceLevels.find((s) => s.name === "Đá bình thường")?.name || menu.iceLevels[0]?.name,
    toppingIds: existing ? [...existing.toppingIds] : [],
    qty: existing?.quantity || 1,
    note: existing?.note || ""
  };

  const ov = document.createElement("div"); ov.className = "overlay"; ov.id = "productOverlay";
  function calcTotal() {
    const size = p.sizes.find((s) => s.id === state.sizeId);
    const topTotal = state.toppingIds.reduce((s, id) => s + (tops.find((t) => t.id === id)?.price || 0), 0);
    return { unit: (size?.price || 0) + topTotal, total: ((size?.price || 0) + topTotal) * state.qty };
  }
  function paint() {
    const oldSheet = ov.querySelector(".sheet");
    const oldScrollTop = oldSheet ? oldSheet.scrollTop : 0;
    const { unit, total } = calcTotal();
    ov.innerHTML = `<div class="sheet">
      <button class="x" onclick="document.getElementById('productOverlay').remove()"><svg class="icon" viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>
      <h2>${esc(p.name)}</h2>
      ${p.description ? `<p class="desc-full">${esc(p.description)}</p>` : ""}
      <fieldset class="field-group" style="border:0;padding:0"><legend>Chọn size</legend>
        <div class="opts">${p.sizes.map((s) => `<button type="button" class="opt ${s.id === state.sizeId ? "selected" : ""}" data-act="size" data-id="${s.id}">${esc(s.name)} · ${money(s.price)}</button>`).join("")}</div>
      </fieldset>
      <fieldset class="field-group" style="border:0;padding:0"><legend>Mức đường <span class="hint">(không cộng tiền)</span></legend>
        <div class="opts">${menu.sugarLevels.map((s) => `<button type="button" class="opt ${s.name === state.sugar ? "selected" : ""}" data-act="sugar" data-id="${esc(s.name)}">${esc(s.name)}</button>`).join("")}</div>
      </fieldset>
      <fieldset class="field-group" style="border:0;padding:0"><legend>Mức đá <span class="hint">(không cộng tiền)</span></legend>
        <div class="opts">${menu.iceLevels.map((s) => `<button type="button" class="opt ${s.name === state.ice ? "selected" : ""}" data-act="ice" data-id="${esc(s.name)}">${esc(s.name)}</button>`).join("")}</div>
      </fieldset>
      ${tops.length ? `<fieldset class="field-group" style="border:0;padding:0"><legend>Topping <span class="hint">(có thể chọn nhiều)</span></legend>
        ${tops.map((t) => `<label class="check-row ${state.toppingIds.includes(t.id) ? "selected" : ""}" data-act="topping" data-id="${t.id}"><input type="checkbox" style="pointer-events:none" ${state.toppingIds.includes(t.id) ? "checked" : ""}><span>${esc(t.name)}</span><em>+${money(t.price)}</em></label>`).join("")}
      </fieldset>` : ""}
      <fieldset class="field-group" style="border:0;padding:0"><legend>Ghi chú</legend>
        <textarea class="note" rows="2" placeholder="Ví dụ: không lấy ống hút" id="productNote">${esc(state.note)}</textarea>
      </fieldset>
      <div class="sheet-foot">
        <div class="qty"><button data-act="qtyminus">−</button><span>${state.qty}</span><button data-act="qtyplus">+</button></div>
        <button class="btn orange" data-act="add"><span>Thêm vào giỏ</span><strong>${money(total)}</strong></button>
      </div>
    </div>`;
    ov.querySelector("#productNote").addEventListener("input", (e) => (state.note = e.target.value));
    const newSheet = ov.querySelector(".sheet");
    if (newSheet && oldSheet) {
      requestAnimationFrame(() => { newSheet.scrollTop = oldScrollTop; });
    }
  }
  ov.addEventListener("click", (e) => {
    if (e.target === ov) return ov.remove();
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "size") state.sizeId = t.dataset.id;
    else if (act === "sugar") state.sugar = t.dataset.id;
    else if (act === "ice") state.ice = t.dataset.id;
    else if (act === "topping") { const id = t.dataset.id; state.toppingIds = state.toppingIds.includes(id) ? state.toppingIds.filter((x) => x !== id) : [...state.toppingIds, id]; }
    else if (act === "qtyminus") state.qty = Math.max(1, state.qty - 1);
    else if (act === "qtyplus") state.qty += 1;
    else if (act === "add") {
      const size = p.sizes.find((s) => s.id === state.sizeId);
      const chosen = tops.filter((x) => state.toppingIds.includes(x.id));
      const { unit, total } = calcTotal();
      const nextItem = {
        cartId: editCartId || ("ci_" + Math.random().toString(36).slice(2)),
        productId: p.id, sizeId: size.id, productName: p.name, sizeName: size.name, sizePrice: size.price,
        sugar: state.sugar, ice: state.ice, toppingIds: [...state.toppingIds], toppings: chosen,
        quantity: state.qty, note: state.note.trim(), unitPrice: unit, subtotal: total
      };
      if (editCartId) {
        const idx = cart.findIndex((i) => i.cartId === editCartId);
        if (idx >= 0) cart[idx] = nextItem;
        ov.remove();
        const cartOverlay = document.getElementById("cartOverlay");
        if (cartOverlay) { cartOverlay.remove(); openCart(); } else { renderCustomer(); }
        toast("Đã cập nhật món.", "success");
      } else {
        cart.push(nextItem);
        ov.remove(); renderCustomer(); toast("Đã thêm vào giỏ hàng.", "success");
      }
      return;
    }
    paint();
  });
  document.body.appendChild(ov);
  paint();
}

/* ---- cart / checkout ---- */
function openCart() {
  const ov = document.createElement("div"); ov.className = "overlay"; ov.id = "cartOverlay";
  let step = "cart";
  let submitting = false;
  const form = { name: "", phone: "", receiveType: "Tại quán", tableOrAddress: TABLE_FROM_URL ? "Bàn " + TABLE_FROM_URL : "", note: "" };
  let placed = null;

  function total() { return cart.reduce((s, i) => s + i.subtotal, 0); }
  function paintCart() {
    ov.innerHTML = `<div class="sheet">
      <button class="x" onclick="document.getElementById('cartOverlay').remove();renderCustomer()"><svg class="icon" viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>
      <h2>Giỏ hàng</h2>
      ${!cart.length ? `<p class="empty" style="padding:20px 0">Giỏ hàng đang trống.</p>` : cart.map((it) => `
        <div class="cart-item">
          <div class="row1"><span>${esc(it.productName)}</span><button class="x" style="width:26px;height:26px" data-remove="${it.cartId}"><svg class="icon" viewBox="0 0 24 24" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button></div>
          <div class="meta">Size ${esc(it.sizeName)} · ${esc(it.sugar)} · ${esc(it.ice)}${it.toppings.length ? " · " + it.toppings.map((t) => esc(t.name)).join(", ") : ""}</div>
          ${it.note ? `<div class="meta" style="color:#b9871f">Ghi chú: ${esc(it.note)}</div>` : ""}
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px">
            <button class="btn light" style="padding:6px 10px;font-size:12px" data-edit="${it.cartId}">Chỉnh sửa</button>
            <div class="row2" style="margin-top:0;flex:1"><div class="qty" style="padding:3px 8px;gap:8px"><button data-qty="-1" data-id="${it.cartId}">−</button><span>${it.quantity}</span><button data-qty="1" data-id="${it.cartId}">+</button></div><strong>${money(it.subtotal)}</strong></div>
          </div>
        </div>`).join("")}
      ${cart.length ? `<div class="total-row"><span>Tạm tính</span><span>${money(total())}</span></div><button class="btn orange" style="width:100%" data-act="checkout">Đặt hàng</button>` : ""}
    </div>`;
  }
  function paintCheckout(errors = {}) {
    ov.innerHTML = `<div class="sheet">
      <button class="x" onclick="document.getElementById('cartOverlay').remove();renderCustomer()"><svg class="icon" viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>
      <h2>Thông tin đặt hàng</h2>
      <div class="input-field"><svg class="icon" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><input id="ckName" placeholder="Họ tên" value="${esc(form.name)}"></div>
      ${errors.name ? `<div class="error-text">${errors.name}</div>` : ""}
      <div class="input-field"><svg class="icon" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg><input id="ckPhone" placeholder="Số điện thoại" value="${esc(form.phone)}"></div>
      ${errors.phone ? `<div class="error-text">${errors.phone}</div>` : ""}
      <fieldset class="field-group" style="border:0;padding:0"><legend>Hình thức nhận</legend>
        <div class="opts">${["Tại quán", "Mang đi", "Giao hàng"].map((r) => `<button type="button" class="opt ${form.receiveType === r ? "selected" : ""}" data-recv="${r}">${r}</button>`).join("")}</div>
      </fieldset>
      <div class="input-field"><svg class="icon" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><input id="ckAddr" placeholder="${form.receiveType === "Tại quán" ? "Số bàn (không bắt buộc)" : form.receiveType === "Giao hàng" ? "Địa chỉ giao hàng" : "Ghi chú địa điểm (không bắt buộc)"}" value="${esc(form.tableOrAddress)}"></div>
      ${errors.addr ? `<div class="error-text">${errors.addr}</div>` : ""}
      <div class="input-field" style="align-items:flex-start"><svg class="icon" viewBox="0 0 24 24" style="margin-top:3px"><path d="M4 4h16v12H5.17L4 17.17V4z"/></svg><textarea class="note" id="ckNote" rows="2" placeholder="Ghi chú đơn hàng">${esc(form.note)}</textarea></div>
      <div class="total-row"><span>Tổng thanh toán</span><span>${money(total())}</span></div>
      <div class="sheet-foot"><button class="btn light" data-act="back" ${submitting ? "disabled" : ""}>Quay lại</button><button class="btn orange" data-act="submit" ${submitting ? "disabled" : ""}>${submitting ? "Đang đặt hàng…" : "Xác nhận đặt hàng"}</button></div>
    </div>`;
  }
  function paintDone() {
    ov.innerHTML = `<div class="sheet">
      <button class="x" onclick="document.getElementById('cartOverlay').remove();renderCustomer()"><svg class="icon" viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>
      <div class="confirm-page">
        <h2>Cảm ơn ${esc(placed.customerName || form.name)}!</h2>
        <p style="color:var(--muted)">Mã đơn của bạn là</p>
        <div class="confirm-code">${esc(placed.code)}</div>
        <p>Tổng thanh toán: <strong>${money(placed.total)}</strong></p>
        <button class="btn orange" style="width:100%" onclick="document.getElementById('cartOverlay').remove();renderCustomer()">Về trang thực đơn</button>
      </div></div>`;
  }
  function validVNPhone(p) { return /^(0|\+84)[0-9]{9,10}$/.test(p.replace(/\s/g, "")); }

  ov.addEventListener("click", async (e) => {
    if (e.target === ov) { ov.remove(); renderCustomer(); return; }
    if (step === "cart") {
      const rm = e.target.closest("[data-remove]");
      if (rm) { cart = cart.filter((i) => i.cartId !== rm.dataset.remove); paintCart(); return; }
      const editBtn = e.target.closest("[data-edit]");
      if (editBtn) {
        const item = cart.find((i) => i.cartId === editBtn.dataset.edit);
        if (item) openProduct(item.productId, item.cartId);
        return;
      }
      const qtyBtn = e.target.closest("[data-qty]");
      if (qtyBtn) {
        const item = cart.find((i) => i.cartId === qtyBtn.dataset.id);
        item.quantity = Math.max(1, item.quantity + Number(qtyBtn.dataset.qty));
        item.subtotal = item.unitPrice * item.quantity;
        paintCart(); return;
      }
      if (e.target.closest("[data-act='checkout']")) { step = "checkout"; paintCheckout(); return; }
    } else if (step === "checkout") {
      const recv = e.target.closest("[data-recv]");
      if (recv) { form.receiveType = recv.dataset.recv; form.tableOrAddress = document.getElementById("ckAddr").value; form.name = document.getElementById("ckName").value; form.phone = document.getElementById("ckPhone").value; form.note = document.getElementById("ckNote").value; paintCheckout(); return; }
      if (e.target.closest("[data-act='back']")) { step = "cart"; paintCart(); return; }
      if (e.target.closest("[data-act='submit']")) {
        if (submitting) return;
        form.name = document.getElementById("ckName").value.trim();
        form.phone = document.getElementById("ckPhone").value.trim();
        form.tableOrAddress = document.getElementById("ckAddr").value.trim();
        form.note = document.getElementById("ckNote").value.trim();
        const errors = {};
        if (!form.name) errors.name = "Vui lòng nhập họ tên";
        if (form.receiveType === "Giao hàng") {
          if (!form.phone) errors.phone = "Giao hàng bắt buộc nhập số điện thoại";
          else if (!validVNPhone(form.phone)) errors.phone = "Số điện thoại không hợp lệ";
          if (!form.tableOrAddress) errors.addr = "Vui lòng nhập địa chỉ giao hàng";
        } else if (form.phone && !validVNPhone(form.phone)) errors.phone = "Số điện thoại không hợp lệ";
        if (Object.keys(errors).length) { paintCheckout(errors); return; }
        submitting = true;
        paintCheckout();
        try {
          const payload = { customerName: form.name, phone: form.phone, receiveType: form.receiveType, tableOrAddress: form.tableOrAddress, note: form.note, items: cart.map((i) => ({ productId: i.productId, sizeId: i.sizeId, toppingIds: i.toppingIds, sugar: i.sugar, ice: i.ice, quantity: i.quantity, note: i.note })) };
          placed = await api("POST", "/api/orders", payload);
          cart = [];
          step = "done"; paintDone();
        } catch (err) {
          submitting = false;
          toast(err.message, "error");
          paintCheckout();
        }
      }
    }
  });
  document.body.appendChild(ov);
  paintCart();
}

/* ================= ADMIN LOGIN ================= */
function openLogin() { document.getElementById("loginBox").style.display = "flex"; document.getElementById("loginUser").focus(); }
function closeLogin() { document.getElementById("loginBox").style.display = "none"; document.getElementById("loginError").textContent = ""; }
async function loginAdmin() {
  const username = document.getElementById("loginUser").value.trim();
  const password = document.getElementById("loginPass").value;
  try {
    me = await api("POST", "/api/auth/login", { username, password });
    closeLogin(); view = "admin"; adminTab_ = "products"; render();
  } catch (e) { document.getElementById("loginError").textContent = e.message; }
}
async function logoutAdmin() { await api("POST", "/api/auth/logout"); me = null; view = "customer"; render(); toast("Đã đăng xuất Admin.", "success"); }

/* ================= ADMIN VIEW ================= */
function renderAdmin() {
  const root = document.getElementById("root");
  if (!me) { view = "customer"; return render(); }
  root.innerHTML = `
  <div class="admin-header">
    <div class="brand"><img src="/assets/logo-icon.png" alt="Hồng Hoa"><span class="brand-text">Quản trị<small>Café Hồng Hoa</small></span></div>
    <div style="display:flex;align-items:center;gap:10px;color:#ddd;font-size:13px">${esc(me.username)} (${esc(me.role)}) <button class="btn light" onclick="logoutAdmin()">Thoát</button></div>
  </div>
  <div class="admin">
    <div class="tabs">
      ${[["products","Món"],["toppings","Topping"],["sizes","Size"],["levels","Đường / Đá"],["categories","Danh mục"],["users","User"],["orders","Đơn hàng"]].map(([k,l])=>`<button class="${adminTab_===k?'active':''}" onclick="setAdminTab('${k}')">${l}</button>`).join("")}
    </div>
    <div id="adminBody"></div>
  </div>`;
  paintAdminBody();
}
function setAdminTab(t) { adminTab_ = t; renderAdmin(); }
async function paintAdminBody() {
  const el = document.getElementById("adminBody");
  if (adminTab_ === "products") return paintAdminProducts(el);
  if (adminTab_ === "toppings") return paintAdminToppings(el);
  if (adminTab_ === "sizes") return paintAdminSizes(el);
  if (adminTab_ === "levels") return paintAdminLevels(el);
  if (adminTab_ === "categories") return paintAdminCategories(el);
  if (adminTab_ === "users") return paintAdminUsers(el);
  if (adminTab_ === "orders") return paintAdminOrders(el);
}

/* ---- products ---- */
let editingProductId = null;
function paintAdminProducts(el, editing) {
  editingProductId = editing || null;
  const p = editingProductId ? menu.products.find((x) => x.id === editingProductId) : null;
  el.innerHTML = `
  <div class="panel">
    <h3 style="margin-top:0">${p ? "Sửa món: " + esc(p.name) : "Thêm món mới"}</h3>
    <div class="field"><label>Tên món</label><input id="pn" value="${p ? esc(p.name) : ""}"></div>
    <div class="row2c">
      <div class="field"><label>Danh mục</label><select id="pc">${menu.categories.map((c) => `<option value="${c.id}" ${p && p.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Trạng thái</label><select id="ps"><option value="active" ${!p || p.status === "active" ? "selected" : ""}>Đang bán</option><option value="soldout" ${p && p.status === "soldout" ? "selected" : ""}>Hết món</option><option value="hidden" ${p && p.status === "hidden" ? "selected" : ""}>Ẩn món</option></select></div>
    </div>
    <div class="field"><label>Mô tả</label><input id="pd" value="${p ? esc(p.description || "") : ""}"></div>
    <div class="field"><label>Hình ảnh món <span style="font-weight:400">(ảnh vuông, chụp thật món)</span></label>
      <input id="pimg" type="file" accept="image/*" onchange="previewProductImage(event)">
      <img id="imgPreview" src="${p && p.image ? esc(p.image) : ""}" style="width:120px;height:120px;object-fit:cover;border-radius:10px;margin-top:6px;${p && p.image ? "" : "display:none"}">
    </div>
    <div class="field"><label>Size &amp; giá</label><div id="sizeRows"></div><button type="button" class="btn light" onclick="addSizeRow()">+ Thêm size</button></div>
    <div class="field"><label>Topping áp dụng cho món này</label>
      ${menu.toppings.map((t) => `<label class="check-row ${p && p.toppingIds.includes(t.id) ? "selected" : ""}"><input type="checkbox" class="topCheck" value="${t.id}" ${p && p.toppingIds.includes(t.id) ? "checked" : ""} style="margin-right:4px">${esc(t.name)}<em>+${money(t.price)}</em></label>`).join("") || `<p style="color:var(--muted);font-size:12.5px">Chưa có topping nào — tạo ở tab Topping trước.</p>`}
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn orange" onclick="saveProduct()">${p ? "Lưu thay đổi" : "+ Thêm món"}</button>
      ${p ? `<button class="btn light" onclick="paintAdminProducts(document.getElementById('adminBody'))">Huỷ</button>` : ""}
    </div>
  </div>
  <div class="panel"><h3 style="margin-top:0">Danh sách món (${menu.products.length})</h3>
    <table class="table"><tr><th>Ảnh</th><th>Món</th><th>Danh mục</th><th>Size &amp; giá</th><th>Trạng thái</th><th></th></tr>
    ${menu.products.map((x) => `<tr>
      <td>${x.image ? `<img src="${esc(x.image)}" style="width:48px;height:48px;object-fit:cover;border-radius:8px">` : "—"}</td>
      <td><b>${esc(x.name)}</b></td><td>${esc(menu.categories.find((c) => c.id === x.categoryId)?.name || "")}</td>
      <td>${x.sizes.map((s) => `${esc(s.name)} ${money(s.price)}`).join(" · ")}</td>
      <td>${x.status === "active" ? "Đang bán" : x.status === "soldout" ? "Hết món" : "Ẩn"}</td>
      <td><button class="btn light" onclick="paintAdminProducts(document.getElementById('adminBody'),'${x.id}')">Sửa</button> <button class="btn light" onclick="deleteProduct('${x.id}')">Xoá</button></td>
    </tr>`).join("")}
    </table>
  </div>`;
  const rowsWrap = document.getElementById("sizeRows");
  const sizes = p
    ? p.sizes.map((s) => ({ id: s.id, catalogId: s.catalogId, price: s.price }))
    : (menu.sizeCatalog[0] ? [{ id: null, catalogId: menu.sizeCatalog[0].id, price: 0 }] : []);
  window.__sizeRows = sizes;
  paintSizeRows();
}
function paintSizeRows() {
  const wrap = document.getElementById("sizeRows");
  if (!menu.sizeCatalog.length) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:12.5px">Chưa có size nào — tạo ở tab "Size" trước.</p>`;
    return;
  }
  wrap.innerHTML = window.__sizeRows.map((s, i) => `
    <div class="row2c" style="grid-template-columns:1fr 1fr 32px;margin-bottom:6px">
      <select onchange="window.__sizeRows[${i}].catalogId=this.value">
        ${menu.sizeCatalog.map((c) => `<option value="${c.id}" ${c.id === s.catalogId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select>
      <input type="number" min="0" value="${s.price}" oninput="window.__sizeRows[${i}].price=this.value" placeholder="Giá">
      <button type="button" class="btn light" style="padding:0" onclick="removeSizeRow(${i})">✕</button>
    </div>`).join("");
}
function addSizeRow() {
  if (!menu.sizeCatalog.length) return toast("Chưa có size nào — tạo ở tab \"Size\" trước.", "error");
  const used = new Set(window.__sizeRows.map((s) => s.catalogId));
  const next = menu.sizeCatalog.find((c) => !used.has(c.id)) || menu.sizeCatalog[0];
  window.__sizeRows.push({ id: null, catalogId: next.id, price: 0 });
  paintSizeRows();
}
function removeSizeRow(i) { if (window.__sizeRows.length <= 1) return toast("Phải có ít nhất 1 size.", "error"); window.__sizeRows.splice(i, 1); paintSizeRows(); }
function previewProductImage(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { document.getElementById("pimg").dataset.data = r.result; const img = document.getElementById("imgPreview"); img.src = r.result; img.style.display = "block"; };
  r.readAsDataURL(f);
}
async function saveProduct() {
  const name = document.getElementById("pn").value.trim();
  if (!name) return toast("Vui lòng nhập tên món.", "error");
  const sizes = window.__sizeRows.filter((s) => s.catalogId).map((s) => ({ id: s.id, sizeId: s.catalogId, price: Number(s.price) || 0 }));
  if (!sizes.length) return toast("Phải có ít nhất 1 size hợp lệ — tạo size ở tab \"Size\" trước.", "error");
  if (sizes.some((s) => !s.price)) return toast("Mỗi size phải có giá lớn hơn 0.", "error");
  if (new Set(sizes.map((s) => s.sizeId)).size !== sizes.length) return toast("Mỗi size chỉ được chọn 1 lần cho 1 món.", "error");
  const toppingIds = [...document.querySelectorAll(".topCheck:checked")].map((x) => x.value);
  const imgData = document.getElementById("pimg").dataset.data;
  const payload = {
    name, categoryId: document.getElementById("pc").value, description: document.getElementById("pd").value.trim(),
    status: document.getElementById("ps").value, sizes, toppingIds,
    image: imgData !== undefined ? imgData : (editingProductId ? menu.products.find((x) => x.id === editingProductId).image : ""),
  };
  try {
    if (editingProductId) await api("PUT", "/api/admin/products/" + editingProductId, payload);
    else await api("POST", "/api/admin/products", payload);
    await refreshMenu(); toast("Đã lưu món.", "success"); editingProductId = null; renderAdmin();
  } catch (e) { toast(e.message, "error"); }
}
async function deleteProduct(id) {
  if (!(await showConfirm("Xoá món này? Không thể hoàn tác.", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/products/" + id); await refreshMenu(); toast("Đã xoá món.", "success"); renderAdmin(); } catch (e) { toast(e.message, "error"); }
}

/* ---- toppings ---- */
function paintAdminToppings(el) {
  el.innerHTML = `<div class="panel">
    <h3 style="margin-top:0">Quản lý Topping (${menu.toppings.length})</h3>
    <div class="row2c" style="grid-template-columns:1fr 1fr 100px;margin-bottom:14px">
      <input id="tn" placeholder="Tên topping"><input id="tv" type="number" min="0" placeholder="Giá">
      <button class="btn orange" onclick="addTopping()">+ Thêm</button>
    </div>
    ${menu.toppings.map((t) => `
      <div class="row2c" style="grid-template-columns:1fr 100px 70px 32px;align-items:center;margin-bottom:6px">
        <input value="${esc(t.name)}" onchange="updateTopping('${t.id}',{name:this.value})">
        <input type="number" value="${t.price}" onchange="updateTopping('${t.id}',{price:this.value})">
        <label style="display:flex;align-items:center;gap:4px;font-size:12px"><input type="checkbox" ${t.active ? "checked" : ""} onchange="updateTopping('${t.id}',{active:this.checked})">Bán</label>
        <button class="btn light" style="padding:0" onclick="deleteTopping('${t.id}')">✕</button>
      </div>`).join("")}
    <p style="color:var(--muted);font-size:12px;margin-top:14px">Topping khai báo 1 lần, rồi gán vào từng món ở tab "Món" — không cần khai báo lại.</p>
  </div>`;
}
async function addTopping() {
  const name = document.getElementById("tn").value.trim(), price = Number(document.getElementById("tv").value);
  if (!name || !price) return toast("Nhập tên và giá.", "error");
  try { await api("POST", "/api/admin/toppings", { name, price }); await refreshMenu(); renderAdmin(); toast("Đã thêm topping.", "success"); } catch (e) { toast(e.message, "error"); }
}
async function updateTopping(id, patch) {
  const t = menu.toppings.find((x) => x.id === id);
  const body = { name: t.name, price: t.price, active: t.active, ...patch };
  try { await api("PUT", "/api/admin/toppings/" + id, body); await refreshMenu(); renderAdmin(); } catch (e) { toast(e.message, "error"); }
}
async function deleteTopping(id) {
  if (!(await showConfirm("Xoá topping này?", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/toppings/" + id); await refreshMenu(); renderAdmin(); toast("Đã xoá topping.", "success"); } catch (e) { toast(e.message, "error"); }
}

/* ---- size (danh mục size dùng chung, chọn khi thêm món thay vì gõ tay) ---- */
function paintAdminSizes(el) {
  el.innerHTML = `<div class="panel">
    <h3 style="margin-top:0">Quản lý Size (${menu.sizeCatalog.length})</h3>
    <p style="color:var(--muted);font-size:12.5px;margin-top:0">Khai báo các loại size (VD: Nhỏ, Vừa, Lớn) một lần, rồi chọn ở tab "Món" khi thêm size cho từng món — không cần gõ lại tên size.</p>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${menu.sizeCatalog.map((s) => `<span class="opt selected" style="display:flex;align-items:center;gap:8px">${esc(s.name)}<button data-id="${s.id}" data-name="${esc(s.name)}" onclick="editSize(this.dataset.id, this.dataset.name)" title="Sửa tên size" style="border:0;background:none;cursor:pointer;font-weight:900">✎</button><button onclick="removeSize('${s.id}')" title="Xoá size" style="border:0;background:none;cursor:pointer;font-weight:900">✕</button></span>`).join("") || `<p class="empty" style="padding:0">Chưa có size nào.</p>`}</div>
    <div style="display:flex;gap:8px"><input id="newSize" placeholder="Tên size mới (VD: Lớn)"><button class="btn orange" onclick="addSize()">+ Thêm</button></div>
  </div>`;
}
async function addSize() {
  const input = document.getElementById("newSize"); const name = input.value.trim(); if (!name) return;
  try { await api("POST", "/api/admin/sizes", { name }); await refreshMenu(); renderAdmin(); toast("Đã thêm size.", "success"); } catch (e) { toast(e.message, "error"); }
}
async function editSize(id, currentName) {
  const name = await showPrompt("Nhập tên mới cho size.", {
    title: "Sửa tên size",
    placeholder: currentName
  });
  if (!name || name === currentName) return;
  try {
    await api("PUT", "/api/admin/sizes/" + id, { name });
    await refreshMenu();
    renderAdmin();
    toast("Đã cập nhật tên size.", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}
async function removeSize(id) {
  if (!(await showConfirm("Xoá size này?", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/sizes/" + id); await refreshMenu(); renderAdmin(); toast("Đã xoá size.", "success"); } catch (e) { toast(e.message, "error"); }
}

/* ---- sugar / ice levels ---- */
function paintAdminLevels(el) {
  el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Mức đường</h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${menu.sugarLevels.map((s) => `<span class="opt selected" style="display:flex;align-items:center;gap:8px">${esc(s.name)}<button data-id="${s.id}" data-name="${esc(s.name)}" onclick="editLevel('sugar', this.dataset.id, this.dataset.name)" title="Sửa tên" style="border:0;background:none;cursor:pointer;font-weight:900">✎</button><button onclick="removeLevel('sugar','${s.id}')" title="Xoá" style="border:0;background:none;cursor:pointer;font-weight:900">✕</button></span>`).join("")}</div>
    <div style="display:flex;gap:8px"><input id="newSugar" placeholder="Mức đường mới"><button class="btn light" onclick="addLevel('sugar')">+ Thêm</button></div>
  </div>
  <div class="panel"><h3 style="margin-top:0">Mức đá</h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">${menu.iceLevels.map((s) => `<span class="opt selected" style="display:flex;align-items:center;gap:8px">${esc(s.name)}<button data-id="${s.id}" data-name="${esc(s.name)}" onclick="editLevel('ice', this.dataset.id, this.dataset.name)" title="Sửa tên" style="border:0;background:none;cursor:pointer;font-weight:900">✎</button><button onclick="removeLevel('ice','${s.id}')" title="Xoá" style="border:0;background:none;cursor:pointer;font-weight:900">✕</button></span>`).join("")}</div>
    <div style="display:flex;gap:8px"><input id="newIce" placeholder="Mức đá mới"><button class="btn light" onclick="addLevel('ice')">+ Thêm</button></div>
  </div>`;
}
async function addLevel(kind) {
  const input = document.getElementById(kind === "sugar" ? "newSugar" : "newIce");
  const name = input.value.trim(); if (!name) return;
  try { await api("POST", `/api/admin/levels/${kind}`, { name }); await refreshMenu(); renderAdmin(); } catch (e) { toast(e.message, "error"); }
}
async function editLevel(kind, id, currentName) {
  const name = await showPrompt("Nhập tên mới cho mức " + (kind === "sugar" ? "đường" : "đá") + ".", {
    title: "Sửa mức " + (kind === "sugar" ? "đường" : "đá"),
    placeholder: currentName
  });
  if (!name || name === currentName) return;
  try {
    await api("PUT", `/api/admin/levels/${kind}/${id}`, { name });
    await refreshMenu();
    renderAdmin();
    toast("Đã cập nhật.", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}
async function removeLevel(kind, id) {
  if (!(await showConfirm("Xoá mức này?", { danger: true }))) return;
  try { await api("DELETE", `/api/admin/levels/${kind}/${id}`); await refreshMenu(); renderAdmin(); } catch (e) { toast(e.message, "error"); }
}

/* ---- categories ---- */
function paintAdminCategories(el) {
  el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Danh mục (${menu.categories.length})</h3>
    ${menu.categories.map((c) => `<div class="row2c" style="grid-template-columns:1fr 90px 90px;align-items:center;margin-bottom:6px"><span>${esc(c.name)}</span><button class="btn light" data-id="${c.id}" data-name="${esc(c.name)}" onclick="editCategory(this.dataset.id, this.dataset.name)">Sửa</button><button class="btn light" onclick="deleteCategory('${c.id}')">Xoá</button></div>`).join("")}
    <div style="display:flex;gap:8px;margin-top:12px"><input id="newCat" placeholder="Tên danh mục mới"><button class="btn orange" onclick="addCategory()">+ Thêm</button></div>
  </div>`;
}
async function addCategory() {
  const input = document.getElementById("newCat"); const name = input.value.trim(); if (!name) return;
  try { await api("POST", "/api/admin/categories", { name }); await refreshMenu(); renderAdmin(); toast("Đã thêm danh mục.", "success"); } catch (e) { toast(e.message, "error"); }
}
async function editCategory(id, currentName) {
  const name = await showPrompt("Nhập tên mới cho danh mục.", {
    title: "Sửa danh mục",
    placeholder: currentName
  });
  if (!name || name === currentName) return;
  try {
    await api("PUT", "/api/admin/categories/" + id, { name });
    await refreshMenu();
    renderAdmin();
    toast("Đã cập nhật danh mục.", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}
async function deleteCategory(id) {
  if (!(await showConfirm("Xoá danh mục này?", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/categories/" + id); await refreshMenu(); renderAdmin(); toast("Đã xoá danh mục.", "success"); } catch (e) { toast(e.message, "error"); }
}

/* ---- users ---- */
async function paintAdminUsers(el) {
  if (!["admin", "moderator"].includes(me.role)) { el.innerHTML = `<p class="empty">Không có quyền quản lý user.</p>`; return; }
  const users = await api("GET", "/api/admin/users");
  el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Tài khoản (${users.length})</h3>
    <table class="table"><tr><th>User</th><th>Vai trò</th><th>Trạng thái</th><th></th></tr>
    ${users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${u.active ? "Hoạt động" : "Khoá"}</td>
      <td><button class="btn light" onclick="changePassword('${u.id}','${esc(u.username)}')">Đổi mật khẩu</button> ${u.role !== "admin" ? `<button class="btn light" onclick="deleteUser('${u.id}')">Xoá</button>` : ""}</td></tr>`).join("")}
    </table>
    <h4>Thêm tài khoản</h4>
    <div class="row2c" style="grid-template-columns:1fr 1fr 120px 90px">
      <input id="un" placeholder="Tài khoản"><input id="up" type="password" placeholder="Mật khẩu">
      <select id="ur"><option value="staff">Nhân viên</option><option value="moderator">Moderator</option></select>
      <button class="btn orange" onclick="addUser()">+ Thêm</button>
    </div>
  </div>`;
}
async function addUser() {
  const username = document.getElementById("un").value.trim(), password = document.getElementById("up").value, role = document.getElementById("ur").value;
  try { await api("POST", "/api/admin/users", { username, password, role }); renderAdmin(); toast("Đã thêm user.", "success"); } catch (e) { toast(e.message, "error"); }
}
async function changePassword(id, username) {
  const p = await showPrompt("Nhập mật khẩu mới cho " + username, { title: "Đổi mật khẩu", type: "password", placeholder: "Mật khẩu mới" });
  if (!p) return;
  try { await api("PUT", `/api/admin/users/${id}/password`, { password: p }); toast("Đã đổi mật khẩu.", "success"); } catch (e) { toast(e.message, "error"); }
}
async function deleteUser(id) {
  if (!(await showConfirm("Xoá user này?", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/users/" + id); renderAdmin(); toast("Đã xoá user.", "success"); } catch (e) { toast(e.message, "error"); }
}

/* ---- orders ---- */
let collapsedOrderIds = new Set(); // đơn nào có mặt trong này thì đang thu gọn — mặc định (không có mặt) là mở chi tiết
let lastLoadedOrders = [];
async function paintAdminOrders(el) {
  const orders = await api("GET", "/api/orders");
  lastLoadedOrders = orders;
  const badgeClass = (s) => ({ "Mới": "s0", "Đang pha chế": "s1", "Hoàn tất": "s2", "Đã giao": "s3" }[s] || "sx");
  el.innerHTML = `
  <div class="admin-toolbar" style="margin-bottom:14px">
    <h3 style="margin:0">Đơn hàng (${orders.length})</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-mini btn-mini-solid" onclick="exportOrdersExcel()">Xuất Excel chi tiết</button>
      ${me.role === "admin" ? `<button class="btn-mini" style="border-color:#b3261e;color:#b3261e" onclick="deleteAllOrders()">Xoá tất cả đơn hàng</button>` : ""}
    </div>
  </div>
  ${!orders.length ? `<p class="empty">Chưa có đơn hàng nào.</p>` : orders.map((o) => {
    const collapsed = collapsedOrderIds.has(o.id);
    return `
    <div class="order-card">
      <button class="order-summary" onclick="toggleOrder('${o.id}')">
        <div><strong>${esc(o.code)}</strong><span style="font-size:11px;color:var(--muted)">${new Date(o.created_at).toLocaleString("vi-VN")} · ${esc(o.customer_name)} · ${o.items.length} món</span></div>
        <span class="badge ${badgeClass(o.status)}">${esc(o.status)}</span>
        <strong>${money(o.total)}</strong>
      </button>
      ${!collapsed ? `<div class="order-detail">
        ${o.items.map((it) => `<div style="padding:10px 0;border-bottom:1px dashed var(--line)">
          <div style="font-weight:700">${esc(it.product_name)} — Size ${esc(it.size_name)}</div>
          <div style="font-size:11.5px;color:var(--muted)">${esc(it.sugar)} · ${esc(it.ice)}${it.toppings.length ? " · " + it.toppings.map((t) => esc(t.name)).join(", ") : ""}${it.note ? " · Ghi chú: " + esc(it.note) : ""}</div>
          <div style="display:flex;justify-content:space-between;margin-top:4px"><span>SL: ${it.quantity}</span><strong>${money(it.subtotal)}</strong></div>
        </div>`).join("")}
        <div style="font-size:11.5px;color:var(--muted);margin:10px 0;display:flex;flex-direction:column;gap:3px">
          <span>${esc(o.phone || "—")}</span><span>${esc(o.receive_type)}${o.table_or_address ? " · " + esc(o.table_or_address) : ""}</span>${o.note ? `<span>Ghi chú: ${esc(o.note)}</span>` : ""}
        </div>
        <div class="total-row"><span>Tổng</span><span>${money(o.total)}</span></div>
        <div class="status-row">
          ${["Mới", "Đang pha chế", "Hoàn tất", "Đã giao"].map((s) => `<button class="status-pill ${o.status === s ? "active" : ""}" onclick="changeOrderStatus('${o.id}','${s}','${o.status}')">${s}</button>`).join("")}
        </div>
        <div class="status-row">
          <button class="status-pill" onclick="printBill('${o.id}')">In bill</button>
          <button class="status-pill" onclick="printLabels('${o.id}')">In tem pha chế</button>
          ${["admin", "moderator"].includes(me.role) && o.status !== "Đã xóa" ? `<button class="status-pill" style="border-color:#b3261e;color:#b3261e" onclick="deleteOrder('${o.id}')">Xoá đơn</button>` : ""}
        </div>
      </div>` : ""}
    </div>`;
  }).join("")}`;
}
function toggleOrder(id) {
  if (collapsedOrderIds.has(id)) collapsedOrderIds.delete(id); else collapsedOrderIds.add(id);
  paintAdminBody();
}
async function changeOrderStatus(id, next, current) {
  if (next === current) return;
  if (!(await showConfirm(`Đổi đơn sang "${next}"?`))) return;
  try { await api("PATCH", `/api/orders/${id}/status`, { status: next }); paintAdminBody(); toast("Đã cập nhật trạng thái đơn.", "success"); } catch (e) { toast(e.message, "error"); }
}
async function deleteOrder(id) {
  if (!(await showConfirm("Đơn sẽ được giữ lại và chuyển trạng thái \"Đã xóa\".", { title: "Xoá đơn?", danger: true }))) return;
  try { await api("DELETE", "/api/orders/" + id); paintAdminBody(); toast("Đã xoá đơn.", "success"); } catch (e) { toast(e.message, "error"); }
}
async function deleteAllOrders() {
  if (!(await showConfirm("Toàn bộ đơn hàng (kể cả đơn test) sẽ bị xoá VĨNH VIỄN, không thể khôi phục.", { title: "Xoá tất cả đơn hàng?", okLabel: "Xoá vĩnh viễn", danger: true }))) return;
  try {
    await api("DELETE", "/api/orders");
    collapsedOrderIds = new Set();
    paintAdminBody();
    toast("Đã xoá toàn bộ đơn hàng.", "success");
  } catch (e) { toast(e.message, "error"); }
}

/* ---- Xuất Excel chi tiết ---- */
function exportOrdersExcel() {
  const orders = lastLoadedOrders;
  if (!orders.length) return toast("Chưa có đơn hàng để xuất.", "error");
  const rows = [];
  for (const o of orders) {
    if (!o.items.length) {
      rows.push({ "Mã đơn": o.code, "Thời gian": new Date(o.created_at).toLocaleString("vi-VN"), "Khách hàng": o.customer_name, "SĐT": o.phone, "Hình thức": o.receive_type, "Bàn/Địa chỉ": o.table_or_address, "Món": "", "Size": "", "Đường": "", "Đá": "", "Topping": "", "SL": "", "Thành tiền món": "", "Ghi chú món": "", "Trạng thái đơn": o.status, "Tổng đơn": o.total });
      continue;
    }
    o.items.forEach((it, idx) => {
      rows.push({
        "Mã đơn": idx === 0 ? o.code : "",
        "Thời gian": idx === 0 ? new Date(o.created_at).toLocaleString("vi-VN") : "",
        "Khách hàng": idx === 0 ? o.customer_name : "",
        "SĐT": idx === 0 ? o.phone : "",
        "Hình thức": idx === 0 ? o.receive_type : "",
        "Bàn/Địa chỉ": idx === 0 ? o.table_or_address : "",
        "Món": it.product_name, "Size": it.size_name, "Đường": it.sugar, "Đá": it.ice,
        "Topping": it.toppings.map((t) => t.name).join(", "), "SL": it.quantity, "Thành tiền món": it.subtotal,
        "Ghi chú món": it.note,
        "Trạng thái đơn": idx === 0 ? o.status : "",
        "Tổng đơn": idx === 0 ? o.total : "",
      });
    });
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 10 }, { wch: 17 }, { wch: 16 }, { wch: 13 }, { wch: 10 }, { wch: 22 }, { wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 22 }, { wch: 5 }, { wch: 13 }, { wch: 18 }, { wch: 12 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Đơn hàng");
  XLSX.writeFile(wb, `don-hang-hong-hoa-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ---- In bill / in tem ----
   Mở TRANG THẬT riêng (do server render ở /print/bill/:id, /print/labels/:id) trong tab mới,
   thay vì thao túng DOM/iframe ngay trên trang admin đang mở.
   Lý do: trên iPhone, lệnh in của hệ điều hành in đúng theo trang web đang ở TẦNG TRÊN CÙNG —
   iframe ẩn hay vùng nội dung ẩn/hiện bằng CSS trên cùng 1 trang đều không ăn thua, nó vẫn
   in nhầm trang quản lý đơn. Mở tab mới = trang mới thật sự là "top window" nên in đúng nội dung.
   window.open() phải gọi ngay, đồng bộ, trong lúc xử lý cú bấm (không qua await) để không bị chặn popup. */
function printBill(id) {
  window.open("/print/bill/" + encodeURIComponent(id), "_blank");
}
function printLabels(id) {
  window.open("/print/labels/" + encodeURIComponent(id), "_blank");
}

boot();
