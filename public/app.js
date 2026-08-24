/* ================= state ================= */
const ALL_CAT = "__all__";
/* Thông tin quán (tên, logo, địa chỉ, giờ mở cửa, SĐT) được tải từ server (tab "Thông tin quán"
   trong trang quản trị), không còn hard-code cứng trong code như trước. */
let STORE_INFO = null;
function isStoreOpenNow() {
  if (!STORE_INFO) return true;
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
/* Quét mã QR chấm công sẽ mở link dạng /?checkin=1 — nếu chưa đăng nhập thì tự mở màn hình
   đăng nhập, đăng nhập xong nhảy thẳng vào tab "Chấm công của tôi" thay vì tab Món mặc định. */
const CHECKIN_INTENT = new URLSearchParams(location.search).get("checkin") === "1";
let myAttendanceToday_ = null;
let myOpenPrevious_ = [];

async function boot() {
  const root = document.getElementById("root");
  root.innerHTML = `<div style="padding:60px;text-align:center;color:var(--muted)">Đang tải…</div>`;
  try {
    const [menuRes, meRes, shopRes] = await Promise.all([api("GET", "/api/menu"), api("GET", "/api/auth/me"), api("GET", "/api/shop-settings")]);
    menu = menuRes; me = meRes;
    applyShopSettings(shopRes);
    activeCategory = ALL_CAT;
    if (CHECKIN_INTENT && me) { view = "admin"; adminTab_ = "mytime"; }
    render();
    if (CHECKIN_INTENT && !me) openLogin();
    if (me) checkAttendanceReminders();
  } catch (e) {
    root.innerHTML = `<div style="padding:60px;text-align:center;color:#b3261e">Không kết nối được tới máy chủ. Vui lòng kiểm tra server đang chạy.</div>`;
  }
}
/** Ánh xạ dữ liệu từ /api/shop-settings (snake_case) sang STORE_INFO, đồng thời cập nhật tiêu đề tab & favicon. */
function applyShopSettings(s) {
  const pad2 = (n) => String(n).padStart(2, "0");
  STORE_INFO = {
    name: s.name || "Café Hồng Hoa",
    tagline: s.tagline || "",
    logo: s.logo || "/assets/logo-icon.png",
    address: s.address || "",
    phoneDisplay: s.phone_display || "",
    phoneTel: s.phone_tel || "",
    openHour: s.open_hour, openMinute: s.open_minute, closeHour: s.close_hour, closeMinute: s.close_minute,
    hoursText: `${pad2(s.open_hour)}:${pad2(s.open_minute)} - ${pad2(s.close_hour)}:${pad2(s.close_minute)}`,
  };
  document.title = STORE_INFO.name + " — Đặt món trực tuyến";
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon && STORE_INFO.logo) favicon.href = STORE_INFO.logo;
  const loginLogo = document.getElementById("loginLogo");
  if (loginLogo) { loginLogo.src = STORE_INFO.logo; loginLogo.alt = STORE_INFO.name; }
  const loginSub = document.getElementById("loginSub");
  if (loginSub) loginSub.textContent = STORE_INFO.name + " · Khu vực dành cho nhân viên";
}
async function refreshShopSettings() { applyShopSettings(await api("GET", "/api/shop-settings")); }
/** Nhắc nhở thụ động: hiện toast khi nhân viên/quản lý mở app mà quên chấm vào/ra, không cần hạ tầng push notification. */
async function checkAttendanceReminders() {
  if (!me || !["admin", "moderator", "staff"].includes(me.role)) return;
  try {
    const data = await api("GET", "/api/attendance/me");
    myAttendanceToday_ = data.today;
    myOpenPrevious_ = data.openPrevious;
    if (myOpenPrevious_.length) {
      toast(`⚠️ Bạn có ${myOpenPrevious_.length} ca làm trước đó quên chấm ra — báo quản lý để chỉnh lại giờ.`, "error");
    }
    if (isStoreOpenNow()) {
      if (!myAttendanceToday_) {
        toast("🔔 Bạn chưa chấm công vào ca hôm nay — quét QR ở quầy để chấm vào nhé!", "info");
      } else if (myAttendanceToday_.check_in && !myAttendanceToday_.check_out) {
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const close = STORE_INFO.closeHour * 60 + STORE_INFO.closeMinute;
        if (close - mins <= 60 && close - mins >= 0) {
          toast("🔔 Sắp đến giờ đóng quán — đừng quên chấm ra trước khi về nhé!", "info");
        }
      }
    }
  } catch (e) { /* không làm phiền người dùng nếu lỗi mạng nhỏ khi kiểm tra nhắc nhở */ }
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
    <div class="brand"><img src="${esc(STORE_INFO.logo)}" alt="${esc(STORE_INFO.name)}"><span class="brand-text">${esc(STORE_INFO.name)}${STORE_INFO.tagline ? `<small>${esc(STORE_INFO.tagline)}</small>` : ""}</span></div>
    <button class="btn-icon" title="Trang quản trị" onclick="openLogin()"><svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button class="btn orange" onclick="openCart()" style="display:flex;align-items:center;gap:6px"><svg class="icon" viewBox="0 0 24 24"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 2H2"/><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="20" r="1.4" fill="currentColor" stroke="none"/></svg> ${cartCount}</button>
  </header>
  <div class="hero">
    <h1>${esc(STORE_INFO.name)}</h1>
    <p class="hero-tag">Chọn món · Tùy chỉnh đường, đá và topping theo ý bạn</p>
    <div class="hero-info">
      <div class="hero-info-row"><strong>Trạng thái:</strong> <span class="${isStoreOpenNow() ? "status-open" : "status-closed"}">${isStoreOpenNow() ? "Đang mở cửa" : "Đang đóng cửa"}</span></div>
      ${TABLE_FROM_URL ? `<div class="hero-info-row"><strong>Bàn của bạn:</strong> Bàn ${esc(TABLE_FROM_URL)}</div>` : ""}
      ${STORE_INFO.address ? `<div class="hero-info-row"><strong>Địa chỉ:</strong> ${esc(STORE_INFO.address)}</div>` : ""}
      <div class="hero-info-row"><strong>Giờ mở cửa:</strong> ${esc(STORE_INFO.hoursText)}</div>
      ${STORE_INFO.phoneDisplay ? `<div class="hero-info-row"><strong>SĐT:</strong> <a href="tel:${esc(STORE_INFO.phoneTel)}">${esc(STORE_INFO.phoneDisplay)}</a></div>` : ""}
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
    closeLogin(); view = "admin"; adminTab_ = CHECKIN_INTENT ? "mytime" : "products"; render();
    checkAttendanceReminders();
  } catch (e) { document.getElementById("loginError").textContent = e.message; }
}
async function logoutAdmin() { await api("POST", "/api/auth/logout"); me = null; view = "customer"; render(); toast("Đã đăng xuất Admin.", "success"); }

/* ================= ADMIN VIEW ================= */
function renderAdmin() {
  const root = document.getElementById("root");
  if (!me) { view = "customer"; return render(); }
  root.innerHTML = `
  <div class="admin-header">
    <div class="brand"><img src="${esc(STORE_INFO.logo)}" alt="${esc(STORE_INFO.name)}"><span class="brand-text">Quản trị<small>${esc(STORE_INFO.name)}</small></span></div>
    <div style="display:flex;align-items:center;gap:10px;color:#ddd;font-size:13px">${esc(me.username)} (${esc(me.role)}) <button class="btn light" onclick="logoutAdmin()">Thoát</button></div>
  </div>
  <div class="admin">
    <div class="tabs">
      ${[["products","Món"],["bulkimg","Ảnh menu hàng loạt"],["toppings","Topping"],["sizes","Size"],["levels","Đường / Đá"],["categories","Danh mục"],["users","User"],["orders","Đơn hàng"],["mytime","Chấm công của tôi"],["debts","Công nợ"],["cashbook","Sổ quỹ"],["attendance","Chấm công"],["qrcode","Mã QR chấm công"],["reports","Báo cáo lãi lỗ"],["shopinfo","Thông tin quán"]].map(([k,l])=>`<button class="${adminTab_===k?'active':''}" onclick="setAdminTab('${k}')">${l}</button>`).join("")}
    </div>
    <div id="adminBody"></div>
  </div>`;
  paintAdminBody();
}
function setAdminTab(t) { adminTab_ = t; renderAdmin(); }
async function paintAdminBody() {
  const el = document.getElementById("adminBody");
  if (adminTab_ === "products") return paintAdminProducts(el);
  if (adminTab_ === "bulkimg") return paintBulkImages(el);
  if (adminTab_ === "toppings") return paintAdminToppings(el);
  if (adminTab_ === "sizes") return paintAdminSizes(el);
  if (adminTab_ === "levels") return paintAdminLevels(el);
  if (adminTab_ === "categories") return paintAdminCategories(el);
  if (adminTab_ === "users") return paintAdminUsers(el);
  if (adminTab_ === "orders") return paintAdminOrders(el);
  if (adminTab_ === "mytime") return paintMyAttendance(el);
  if (adminTab_ === "debts") return paintAdminDebts(el);
  if (adminTab_ === "cashbook") return paintAdminCashbook(el);
  if (adminTab_ === "attendance") return paintAdminAttendance(el);
  if (adminTab_ === "qrcode") return paintAttendanceQr(el);
  if (adminTab_ === "reports") return paintAdminReports(el);
  if (adminTab_ === "shopinfo") return paintShopInfo(el);
}
/** Chỉ admin/moderator được xem các tab tài chính/nhân sự nhạy cảm. */
function requireFinanceAccess(el) {
  if (!["admin", "moderator"].includes(me.role)) { el.innerHTML = `<p class="empty">Không có quyền xem mục này.</p>`; return false; }
  return true;
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

/* ================= ADMIN: SỔ QUỸ THU / CHI ================= */
function defaultMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  return { from, to };
}
const CASHBOOK_CATEGORIES_CHI = ["Nguyên liệu", "Lương nhân viên", "Mặt bằng/Điện nước", "Marketing", "Sửa chữa/Bảo trì", "Khác"];
const CASHBOOK_CATEGORIES_THU = ["Thu khác (ngoài đơn hàng)", "Hoàn tiền", "Khác"];
let cbFilter_ = { ...defaultMonthRange(), type: "" };
let lastCashbookRows_ = [];
async function paintAdminCashbook(el) {
  if (!requireFinanceAccess(el)) return;
  const qs = new URLSearchParams({ from: cbFilter_.from, to: cbFilter_.to, ...(cbFilter_.type ? { type: cbFilter_.type } : {}) });
  const rows = await api("GET", "/api/admin/cashbook?" + qs.toString());
  lastCashbookRows_ = rows;
  const totalThu = rows.filter((r) => r.type === "thu").reduce((s, r) => s + r.amount, 0);
  const totalChi = rows.filter((r) => r.type === "chi").reduce((s, r) => s + r.amount, 0);
  el.innerHTML = `
  <div class="panel">
    <h3 style="margin-top:0">Bộ lọc</h3>
    <div class="row2c" style="grid-template-columns:1fr 1fr 1fr 1fr">
      <div><label style="font-size:11.5px;color:var(--muted)">Từ ngày</label><input id="cbFrom" type="date" value="${cbFilter_.from}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Đến ngày</label><input id="cbTo" type="date" value="${cbFilter_.to}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Loại</label><select id="cbType"><option value="">Tất cả</option><option value="thu" ${cbFilter_.type === "thu" ? "selected" : ""}>Thu</option><option value="chi" ${cbFilter_.type === "chi" ? "selected" : ""}>Chi</option></select></div>
      <div style="align-self:end"><button class="btn orange" style="width:100%" onclick="applyCashbookFilter()">Lọc</button></div>
    </div>
  </div>
  <div class="panel" style="display:flex;gap:24px;flex-wrap:wrap">
    <div><div style="font-size:11.5px;color:var(--muted)">Tổng thu</div><strong style="color:#4b5c2e;font-size:17px">${money(totalThu)}</strong></div>
    <div><div style="font-size:11.5px;color:var(--muted)">Tổng chi</div><strong style="color:#b3261e;font-size:17px">${money(totalChi)}</strong></div>
    <div><div style="font-size:11.5px;color:var(--muted)">Số dư</div><strong style="font-size:17px">${money(totalThu - totalChi)}</strong></div>
  </div>
  <div class="panel">
    <div class="admin-toolbar" style="margin-bottom:10px"><h3 style="margin:0">Ghi sổ (${rows.length})</h3>
      <button class="btn-mini btn-mini-solid" onclick="exportCashbookExcel()">Xuất Excel</button>
    </div>
    ${!rows.length ? `<p class="empty">Chưa có khoản thu/chi nào trong khoảng này.</p>` : `<table class="table">
      <tr><th>Ngày</th><th>Loại</th><th>Danh mục</th><th>Số tiền</th><th>Ghi chú</th><th>Người ghi</th><th></th></tr>
      ${rows.map((r) => `<tr>
        <td>${new Date(r.occurred_at).toLocaleDateString("vi-VN")}</td>
        <td><span class="badge ${r.type === "thu" ? "s2" : "s0"}">${r.type === "thu" ? "Thu" : "Chi"}</span></td>
        <td>${esc(r.category)}</td>
        <td>${money(r.amount)}</td>
        <td>${esc(r.note || "—")}</td>
        <td>${esc(r.created_by || "—")}</td>
        <td><button class="btn light" onclick="deleteCashbookEntry('${r.id}')">Xoá</button></td>
      </tr>`).join("")}
    </table>`}
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Thêm khoản thu/chi</h3>
    <div class="row2c" style="grid-template-columns:100px 1fr 140px 1fr">
      <select id="cbNewType" onchange="paintCashbookCategoryOptions()">
        <option value="chi">Chi</option><option value="thu">Thu</option>
      </select>
      <select id="cbNewCategory"></select>
      <input id="cbNewAmount" type="number" min="1" placeholder="Số tiền">
      <input id="cbNewDate" type="date" value="${new Date().toISOString().slice(0, 10)}">
    </div>
    <div style="margin-top:10px"><input id="cbNewNote" placeholder="Ghi chú (không bắt buộc)" style="width:100%"></div>
    <div style="margin-top:10px"><button class="btn orange" onclick="addCashbookEntry()">+ Ghi sổ</button></div>
  </div>`;
  paintCashbookCategoryOptions();
}
function paintCashbookCategoryOptions() {
  const typeSel = document.getElementById("cbNewType");
  const catSel = document.getElementById("cbNewCategory");
  if (!typeSel || !catSel) return;
  const list = typeSel.value === "thu" ? CASHBOOK_CATEGORIES_THU : CASHBOOK_CATEGORIES_CHI;
  catSel.innerHTML = list.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
}
function applyCashbookFilter() {
  cbFilter_ = {
    from: document.getElementById("cbFrom").value || defaultMonthRange().from,
    to: document.getElementById("cbTo").value || defaultMonthRange().to,
    type: document.getElementById("cbType").value,
  };
  paintAdminBody();
}
async function addCashbookEntry() {
  const type = document.getElementById("cbNewType").value;
  const category = document.getElementById("cbNewCategory").value;
  const amount = document.getElementById("cbNewAmount").value;
  const occurredAt = document.getElementById("cbNewDate").value;
  const note = document.getElementById("cbNewNote").value;
  if (!amount || Number(amount) <= 0) return toast("Vui lòng nhập số tiền hợp lệ.", "error");
  try {
    await api("POST", "/api/admin/cashbook", { type, category, amount, note, occurredAt });
    paintAdminBody();
    toast("Đã ghi sổ.", "success");
  } catch (e) { toast(e.message, "error"); }
}
async function deleteCashbookEntry(id) {
  if (!(await showConfirm("Xoá khoản thu/chi này?", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/cashbook/" + id); paintAdminBody(); toast("Đã xoá.", "success"); } catch (e) { toast(e.message, "error"); }
}
function exportCashbookExcel() {
  if (!lastCashbookRows_.length) return toast("Chưa có dữ liệu để xuất.", "error");
  const rows = lastCashbookRows_.map((r) => ({
    "Ngày": new Date(r.occurred_at).toLocaleDateString("vi-VN"),
    "Loại": r.type === "thu" ? "Thu" : "Chi",
    "Danh mục": r.category,
    "Số tiền": r.amount,
    "Ghi chú": r.note,
    "Người ghi": r.created_by,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 22 }, { wch: 14 }, { wch: 30 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "So quy");
  XLSX.writeFile(wb, `so-quy-hong-hoa-${cbFilter_.from}_${cbFilter_.to}.xlsx`);
}

/* ================= ADMIN: CÔNG NỢ ================= */
let debtFilter_ = "";
async function paintAdminDebts(el) {
  if (!requireFinanceAccess(el)) return;
  const debts = await api("GET", "/api/admin/debts");
  const filtered = debtFilter_ ? debts.filter((d) => d.type === debtFilter_) : debts;
  const totalReceivable = debts.filter((d) => d.type === "receivable" && d.status === "open").reduce((s, d) => s + d.remaining, 0);
  const totalPayable = debts.filter((d) => d.type === "payable" && d.status === "open").reduce((s, d) => s + d.remaining, 0);
  el.innerHTML = `
  <div class="panel" style="display:flex;gap:24px;flex-wrap:wrap">
    <div><div style="font-size:11.5px;color:var(--muted)">Tổng phải thu (còn nợ)</div><strong style="color:#4b5c2e;font-size:17px">${money(totalReceivable)}</strong></div>
    <div><div style="font-size:11.5px;color:var(--muted)">Tổng phải trả (còn nợ)</div><strong style="color:#b3261e;font-size:17px">${money(totalPayable)}</strong></div>
  </div>
  <div class="panel">
    <div class="admin-toolbar" style="margin-bottom:10px">
      <h3 style="margin:0">Công nợ (${filtered.length})</h3>
      <div class="tabs" style="margin:0"><button class="${debtFilter_ === "" ? "active" : ""}" onclick="setDebtFilter('')">Tất cả</button><button class="${debtFilter_ === "receivable" ? "active" : ""}" onclick="setDebtFilter('receivable')">Phải thu</button><button class="${debtFilter_ === "payable" ? "active" : ""}" onclick="setDebtFilter('payable')">Phải trả</button></div>
    </div>
    ${!filtered.length ? `<p class="empty">Chưa có khoản công nợ nào.</p>` : filtered.map((d) => `
      <div class="order-card" style="padding:12px 14px">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
          <div>
            <strong>${esc(d.partner_name)}</strong>
            <span class="badge ${d.type === "receivable" ? "s2" : "s0"}">${d.type === "receivable" ? "Phải thu" : "Phải trả"}</span>
            <span class="badge ${d.status === "closed" ? "s3" : "s1"}">${d.status === "closed" ? "Đã tất toán" : "Còn nợ"}</span>
          </div>
          <div style="font-size:11.5px;color:var(--muted)">${esc(d.phone || "")}</div>
        </div>
        <div style="font-size:12.5px;margin-top:6px;display:flex;gap:18px;flex-wrap:wrap">
          <span>Tổng nợ: <b>${money(d.amount)}</b></span>
          <span>Đã ${d.type === "receivable" ? "thu" : "trả"}: <b>${money(d.paid)}</b></span>
          <span>Còn lại: <b>${money(d.remaining)}</b></span>
        </div>
        ${d.note ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">Ghi chú: ${esc(d.note)}</div>` : ""}
        ${d.payments.length ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">Lịch sử thanh toán (${d.payments.length})</summary>
          ${d.payments.map((p) => `<div style="font-size:12px;display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--line)"><span>${new Date(p.paid_at).toLocaleDateString("vi-VN")}${p.note ? " · " + esc(p.note) : ""}</span><b>${money(p.amount)}</b></div>`).join("")}
        </details>` : ""}
        <div class="status-row" style="margin-top:10px">
          ${d.status !== "closed" ? `<button class="status-pill" onclick="addDebtPayment('${d.id}','${d.type}')">Ghi nhận ${d.type === "receivable" ? "thu tiền" : "trả tiền"}</button>` : ""}
          <button class="status-pill" style="border-color:#b3261e;color:#b3261e" onclick="deleteDebt('${d.id}')">Xoá</button>
        </div>
      </div>`).join("")}
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Thêm khoản công nợ</h3>
    <div class="row2c" style="grid-template-columns:140px 1fr 1fr">
      <select id="dNewType"><option value="receivable">Phải thu (khách nợ)</option><option value="payable">Phải trả (nợ NCC)</option></select>
      <input id="dNewPartner" placeholder="Tên khách hàng / nhà cung cấp">
      <input id="dNewPhone" placeholder="SĐT (không bắt buộc)">
    </div>
    <div class="row2c" style="grid-template-columns:1fr 2fr;margin-top:10px">
      <input id="dNewAmount" type="number" min="1" placeholder="Số tiền">
      <input id="dNewNote" placeholder="Ghi chú (không bắt buộc)">
    </div>
    <div style="margin-top:10px"><button class="btn orange" onclick="addDebt()">+ Thêm công nợ</button></div>
  </div>`;
}
function setDebtFilter(t) { debtFilter_ = t; paintAdminBody(); }
async function addDebt() {
  const type = document.getElementById("dNewType").value;
  const partnerName = document.getElementById("dNewPartner").value.trim();
  const phone = document.getElementById("dNewPhone").value.trim();
  const amount = document.getElementById("dNewAmount").value;
  const note = document.getElementById("dNewNote").value.trim();
  if (!partnerName) return toast("Vui lòng nhập tên khách hàng/nhà cung cấp.", "error");
  if (!amount || Number(amount) <= 0) return toast("Vui lòng nhập số tiền hợp lệ.", "error");
  try {
    await api("POST", "/api/admin/debts", { type, partnerName, phone, amount, note });
    paintAdminBody();
    toast("Đã thêm khoản công nợ.", "success");
  } catch (e) { toast(e.message, "error"); }
}
async function addDebtPayment(debtId, type) {
  const amountStr = await showPrompt(type === "receivable" ? "Số tiền khách vừa trả:" : "Số tiền vừa trả cho nhà cung cấp:", {
    title: "Ghi nhận thanh toán", type: "number", placeholder: "Số tiền",
  });
  if (!amountStr) return;
  const amount = Number(amountStr);
  if (!amount || amount <= 0) return toast("Số tiền không hợp lệ.", "error");
  try {
    await api("POST", `/api/admin/debts/${debtId}/payments`, { amount });
    paintAdminBody();
    toast("Đã ghi nhận thanh toán.", "success");
  } catch (e) { toast(e.message, "error"); }
}
async function deleteDebt(id) {
  if (!(await showConfirm("Xoá khoản công nợ này? Toàn bộ lịch sử thanh toán liên quan cũng sẽ bị xoá.", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/debts/" + id); paintAdminBody(); toast("Đã xoá.", "success"); } catch (e) { toast(e.message, "error"); }
}

/* ================= ADMIN: CHẤM CÔNG NHÂN VIÊN ================= */
let attFilter_ = defaultMonthRange();
async function paintAdminAttendance(el) {
  if (!requireFinanceAccess(el)) return;
  const [rows, users] = await Promise.all([
    api("GET", `/api/admin/attendance?from=${attFilter_.from}&to=${attFilter_.to}`),
    api("GET", "/api/admin/users"),
  ]);
  const totalHours = rows.reduce((s, r) => s + Number(r.hours || 0), 0);
  el.innerHTML = `
  <div class="panel">
    <h3 style="margin-top:0">Bộ lọc</h3>
    <div class="row2c" style="grid-template-columns:1fr 1fr 140px">
      <div><label style="font-size:11.5px;color:var(--muted)">Từ ngày</label><input id="attFrom" type="date" value="${attFilter_.from}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Đến ngày</label><input id="attTo" type="date" value="${attFilter_.to}"></div>
      <div style="align-self:end"><button class="btn orange" style="width:100%" onclick="applyAttendanceFilter()">Lọc</button></div>
    </div>
  </div>
  <div class="panel">
    <div class="admin-toolbar" style="margin-bottom:10px"><h3 style="margin:0">Bảng công (${rows.length}) — Tổng ${totalHours.toFixed(2)} giờ</h3></div>
    ${!rows.length ? `<p class="empty">Chưa có bản ghi chấm công trong khoảng này.</p>` : `<table class="table">
      <tr><th>Nhân viên</th><th>Ngày</th><th>Giờ vào</th><th>Giờ ra</th><th>Số giờ</th><th>Ghi chú</th><th></th></tr>
      ${rows.map((r) => `<tr>
        <td>${esc(r.username)}</td>
        <td>${new Date(r.work_date).toLocaleDateString("vi-VN")}</td>
        <td>${r.check_in ? new Date(r.check_in).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
        <td>${r.check_out ? new Date(r.check_out).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "—"}</td>
        <td>${Number(r.hours || 0).toFixed(2)}</td>
        <td>${esc(r.note || "—")}</td>
        <td><button class="btn light" onclick="editAttendance('${r.id}','${esc(r.check_in || "")}','${esc(r.check_out || "")}')">Sửa</button> <button class="btn light" onclick="deleteAttendance('${r.id}')">Xoá</button></td>
      </tr>`).join("")}
    </table>`}
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Thêm bản ghi chấm công</h3>
    <div class="row2c" style="grid-template-columns:1fr 140px">
      <select id="attNewUser">${users.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join("")}</select>
      <input id="attNewDate" type="date" value="${new Date().toISOString().slice(0, 10)}">
    </div>
    <div class="row2c" style="grid-template-columns:1fr 1fr;margin-top:10px">
      <div><label style="font-size:11.5px;color:var(--muted)">Giờ vào</label><input id="attNewIn" type="time"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Giờ ra</label><input id="attNewOut" type="time"></div>
    </div>
    <div style="margin-top:10px"><input id="attNewNote" placeholder="Ghi chú (không bắt buộc)" style="width:100%"></div>
    <div style="margin-top:10px"><button class="btn orange" onclick="addAttendance()">+ Thêm</button></div>
  </div>`;
}
function applyAttendanceFilter() {
  attFilter_ = {
    from: document.getElementById("attFrom").value || defaultMonthRange().from,
    to: document.getElementById("attTo").value || defaultMonthRange().to,
  };
  paintAdminBody();
}
function combineDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}
async function addAttendance() {
  const userId = document.getElementById("attNewUser").value;
  const workDate = document.getElementById("attNewDate").value;
  const inTime = document.getElementById("attNewIn").value;
  const outTime = document.getElementById("attNewOut").value;
  const note = document.getElementById("attNewNote").value;
  if (!userId || !workDate) return toast("Vui lòng chọn nhân viên và ngày công.", "error");
  try {
    await api("POST", "/api/admin/attendance", {
      userId, workDate, checkIn: combineDateTime(workDate, inTime), checkOut: combineDateTime(workDate, outTime), note,
    });
    paintAdminBody();
    toast("Đã thêm chấm công.", "success");
  } catch (e) { toast(e.message, "error"); }
}
async function editAttendance(id, currentIn, currentOut) {
  const inTime = currentIn ? new Date(currentIn).toTimeString().slice(0, 5) : "";
  const outTime = currentOut ? new Date(currentOut).toTimeString().slice(0, 5) : "";
  const newIn = await showPrompt("Giờ vào (HH:MM, để trống nếu không có):", { title: "Sửa giờ vào", placeholder: inTime || "08:00" });
  if (newIn === null) return;
  const newOut = await showPrompt("Giờ ra (HH:MM, để trống nếu không có):", { title: "Sửa giờ ra", placeholder: outTime || "17:00" });
  if (newOut === null) return;
  const dateStr = new Date(currentIn || currentOut || Date.now()).toISOString().slice(0, 10);
  try {
    await api("PUT", "/api/admin/attendance/" + id, {
      checkIn: newIn ? combineDateTime(dateStr, newIn) : null,
      checkOut: newOut ? combineDateTime(dateStr, newOut) : null,
    });
    paintAdminBody();
    toast("Đã cập nhật.", "success");
  } catch (e) { toast(e.message, "error"); }
}
async function deleteAttendance(id) {
  if (!(await showConfirm("Xoá bản ghi chấm công này?", { danger: true }))) return;
  try { await api("DELETE", "/api/admin/attendance/" + id); paintAdminBody(); toast("Đã xoá.", "success"); } catch (e) { toast(e.message, "error"); }
}

/* ================= ADMIN: BÁO CÁO LÃI LỖ CHI TIẾT ================= */
let reportFilter_ = defaultMonthRange();
let lastReport_ = null;
async function paintAdminReports(el) {
  if (!requireFinanceAccess(el)) return;
  const report = await api("GET", `/api/admin/reports/profit-loss?from=${reportFilter_.from}&to=${reportFilter_.to}`);
  lastReport_ = report;
  const profitColor = report.profit >= 0 ? "#4b5c2e" : "#b3261e";
  el.innerHTML = `
  <div class="panel">
    <h3 style="margin-top:0">Khoảng thời gian</h3>
    <div class="row2c" style="grid-template-columns:1fr 1fr 140px">
      <div><label style="font-size:11.5px;color:var(--muted)">Từ ngày</label><input id="repFrom" type="date" value="${reportFilter_.from}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Đến ngày</label><input id="repTo" type="date" value="${reportFilter_.to}"></div>
      <div style="align-self:end"><button class="btn orange" style="width:100%" onclick="applyReportFilter()">Xem báo cáo</button></div>
    </div>
  </div>
  <div class="panel" style="display:flex;gap:24px;flex-wrap:wrap">
    <div><div style="font-size:11.5px;color:var(--muted)">Doanh thu bán hàng (${report.orderCount} đơn)</div><strong style="font-size:17px">${money(report.revenue)}</strong></div>
    <div><div style="font-size:11.5px;color:var(--muted)">Thu khác</div><strong style="font-size:17px">${money(report.otherIncome)}</strong></div>
    <div><div style="font-size:11.5px;color:var(--muted)">Tổng chi phí</div><strong style="color:#b3261e;font-size:17px">${money(report.expense)}</strong></div>
    <div><div style="font-size:11.5px;color:var(--muted)">Lợi nhuận</div><strong style="color:${profitColor};font-size:19px">${money(report.profit)}</strong></div>
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Chi phí theo danh mục</h3>
    ${!report.expenseByCategory.length ? `<p class="empty">Không có chi phí nào trong khoảng này.</p>` : `<table class="table">
      <tr><th>Danh mục</th><th>Số tiền</th><th>Tỷ trọng</th></tr>
      ${report.expenseByCategory.map((c) => `<tr><td>${esc(c.category)}</td><td>${money(c.total)}</td><td>${report.expense ? ((c.total / report.expense) * 100).toFixed(1) : 0}%</td></tr>`).join("")}
    </table>`}
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Doanh thu &amp; chi phí theo ngày</h3>
    ${!report.daily.length ? `<p class="empty">Chưa có dữ liệu.</p>` : `<table class="table">
      <tr><th>Ngày</th><th>Doanh thu</th><th>Chi phí</th><th>Chênh lệch</th></tr>
      ${report.daily.map((d) => `<tr><td>${new Date(d.date).toLocaleDateString("vi-VN")}</td><td>${money(d.revenue)}</td><td>${money(d.expense)}</td><td>${money(d.revenue - d.expense)}</td></tr>`).join("")}
    </table>`}
    <div style="margin-top:12px"><button class="btn-mini btn-mini-solid" onclick="exportReportExcel()">Xuất Excel báo cáo</button></div>
  </div>`;
}
function applyReportFilter() {
  reportFilter_ = {
    from: document.getElementById("repFrom").value || defaultMonthRange().from,
    to: document.getElementById("repTo").value || defaultMonthRange().to,
  };
  paintAdminBody();
}
function exportReportExcel() {
  if (!lastReport_) return;
  const wb = XLSX.utils.book_new();
  const summary = [
    { "Chỉ tiêu": "Doanh thu bán hàng", "Giá trị": lastReport_.revenue },
    { "Chỉ tiêu": "Thu khác", "Giá trị": lastReport_.otherIncome },
    { "Chỉ tiêu": "Tổng chi phí", "Giá trị": lastReport_.expense },
    { "Chỉ tiêu": "Lợi nhuận", "Giá trị": lastReport_.profit },
    { "Chỉ tiêu": "Số đơn hàng", "Giá trị": lastReport_.orderCount },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Tong quan");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lastReport_.expenseByCategory.map((c) => ({ "Danh mục": c.category, "Số tiền": c.total }))), "Chi phi theo danh muc");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lastReport_.daily.map((d) => ({ "Ngày": d.date, "Doanh thu": d.revenue, "Chi phí": d.expense, "Chênh lệch": d.revenue - d.expense }))), "Theo ngay");
  XLSX.writeFile(wb, `bao-cao-lai-lo-hong-hoa-${reportFilter_.from}_${reportFilter_.to}.xlsx`);
}

/* ================= CHẤM CÔNG CỦA TÔI (tự phục vụ, mọi role) ================= */
let geoBusy_ = false;
async function paintMyAttendance(el) {
  el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">Đang tải…</div>`;
  let data;
  try { data = await api("GET", "/api/attendance/me"); } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  myAttendanceToday_ = data.today;
  myOpenPrevious_ = data.openPrevious;
  const t = myAttendanceToday_;
  let statusHtml, actionHtml;
  if (!t) {
    statusHtml = `<div style="font-size:15px;color:var(--muted)">Bạn chưa chấm công hôm nay.</div>`;
    actionHtml = `<button class="btn orange" style="width:100%;padding:16px;font-size:16px;margin-top:16px" onclick="doSelfCheckin()">📍 CHẤM VÀO</button>`;
  } else if (t.check_in && !t.check_out) {
    statusHtml = `<div style="font-size:15px">Đã chấm vào lúc <b>${new Date(t.check_in).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</b></div>`;
    actionHtml = `<button class="btn orange" style="width:100%;padding:16px;font-size:16px;margin-top:16px" onclick="doSelfCheckout()">📍 CHẤM RA</button>`;
  } else {
    statusHtml = `<div style="font-size:15px;color:#4b5c2e">Đã hoàn tất chấm công hôm nay.<br>Vào: <b>${new Date(t.check_in).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</b> · Ra: <b>${new Date(t.check_out).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</b> · Tổng <b>${Number(t.hours).toFixed(2)} giờ</b></div>`;
    actionHtml = "";
  }
  el.innerHTML = `
  <div class="panel" style="text-align:center;padding:28px 20px">
    <div style="font-size:13px;color:var(--muted);margin-bottom:6px">${new Date().toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })}</div>
    ${statusHtml}
    ${actionHtml}
    <div id="geoStatus" style="font-size:11.5px;color:var(--muted);margin-top:10px"></div>
    <div style="font-size:11px;color:var(--muted);margin-top:14px">Chỉ chấm công được khi bạn đang ở tại quán — hệ thống kiểm tra vị trí GPS điện thoại, chấm từ nhà sẽ bị từ chối.</div>
  </div>
  ${myOpenPrevious_.length ? `<div class="panel" style="border-color:#b3261e">
    <h3 style="margin-top:0;color:#b3261e">⚠️ Ca làm chưa chấm ra</h3>
    ${myOpenPrevious_.map((p) => `<div style="font-size:13px;padding:4px 0">${new Date(p.work_date).toLocaleDateString("vi-VN")} — chấm vào lúc ${new Date(p.check_in).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}</div>`).join("")}
    <div style="font-size:12px;color:var(--muted);margin-top:6px">Báo quản lý sửa lại giờ ra ở tab "Chấm công" — bạn không tự chấm ra cho ngày cũ được.</div>
  </div>` : ""}`;
}
function getGeoPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Trình duyệt không hỗ trợ định vị."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const msgs = {
          1: "Bạn chưa cho phép truy cập vị trí. Vào cài đặt trình duyệt bật quyền định vị rồi thử lại.",
          2: "Không xác định được vị trí. Hãy ra chỗ thoáng hoặc bật GPS rồi thử lại.",
          3: "Định vị quá thời gian chờ, thử lại nhé.",
        };
        reject(new Error(msgs[err.code] || "Không lấy được vị trí."));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}
async function doSelfCheckin() { runSelfAttendance("checkin"); }
async function doSelfCheckout() { runSelfAttendance("checkout"); }
async function runSelfAttendance(kind) {
  if (geoBusy_) return;
  geoBusy_ = true;
  const statusEl = document.getElementById("geoStatus");
  if (statusEl) statusEl.textContent = "Đang xác định vị trí…";
  try {
    const { lat, lng } = await getGeoPosition();
    if (statusEl) statusEl.textContent = "Đang gửi...";
    await api("POST", `/api/attendance/self/${kind}`, { lat, lng });
    toast(kind === "checkin" ? "Đã chấm vào thành công!" : "Đã chấm ra thành công!", "success");
    paintAdminBody();
  } catch (e) {
    toast(e.message, "error");
    if (statusEl) statusEl.textContent = "";
  } finally {
    geoBusy_ = false;
  }
}

/* ================= MÃ QR CHẤM CÔNG + CẤU HÌNH VỊ TRÍ QUÁN (admin/moderator) ================= */
async function paintAttendanceQr(el) {
  if (!requireFinanceAccess(el)) return;
  const settings = await api("GET", "/api/attendance/settings");
  const checkinUrl = location.origin + "/?checkin=1";
  el.innerHTML = `
  <div class="panel" style="text-align:center">
    <h3 style="margin-top:0">Mã QR chấm công</h3>
    <p style="font-size:12.5px;color:var(--muted)">In mã này dán tại quầy để nhân viên quét cho nhanh. Nhưng mã QR chỉ là lối vào — thứ THỰC SỰ chặn chấm công từ xa là vị trí GPS bên dưới: dù chụp ảnh mã này mang về nhà, hệ thống vẫn từ chối vì điện thoại không ở gần quán.</p>
    <div id="qrHolder" style="display:flex;justify-content:center;margin:16px 0"></div>
    <div style="font-size:11.5px;color:var(--muted);word-break:break-all">${esc(checkinUrl)}</div>
    <button class="btn-mini btn-mini-solid" style="margin-top:12px" onclick="printQr()">In mã QR</button>
  </div>
  <div class="panel">
    <h3 style="margin-top:0">Vị trí quán (để chặn chấm công từ xa)</h3>
    <div class="row2c" style="grid-template-columns:1fr 1fr 120px">
      <div><label style="font-size:11.5px;color:var(--muted)">Vĩ độ (latitude)</label><input id="geoLat" type="text" value="${settings.latitude ?? ""}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Kinh độ (longitude)</label><input id="geoLng" type="text" value="${settings.longitude ?? ""}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Bán kính (m)</label><input id="geoRadius" type="number" min="10" max="2000" value="${settings.radius_meters}"></div>
    </div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn light" onclick="useMyLocationForShop()">📍 Lấy vị trí hiện tại (đứng trong quán rồi bấm)</button>
      <button class="btn orange" onclick="saveAttendanceSettings()">Lưu vị trí</button>
    </div>
    <p style="font-size:11.5px;color:var(--muted);margin-top:10px">Toạ độ mặc định được tra theo địa chỉ quán, có thể lệch vài chục mét. Để chính xác nhất: đứng ngay quầy pha chế, bấm "Lấy vị trí hiện tại" rồi Lưu.</p>
  </div>`;
  renderQrCanvas(checkinUrl);
}
function renderQrCanvas(text) {
  const holder = document.getElementById("qrHolder");
  if (!holder || typeof QRCode === "undefined") { if (holder) holder.textContent = "Không tải được thư viện tạo mã QR."; return; }
  holder.innerHTML = "";
  new QRCode(holder, { text, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
}
function printQr() {
  const holder = document.getElementById("qrHolder");
  const imgEl = holder && holder.querySelector("img, canvas");
  const src = imgEl ? (imgEl.tagName === "IMG" ? imgEl.src : imgEl.toDataURL()) : "";
  const w = window.open("", "_blank");
  w.document.write(`<!DOCTYPE html><html><head><title>In mã QR chấm công</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:30px}img{width:280px;height:280px}</style></head><body><h2>Chấm công — ${esc(STORE_INFO.name)}</h2><img src="${src}"><p>Quét mã để chấm công (chỉ dùng được khi ở tại quán)</p><script>window.onload=function(){setTimeout(function(){window.print();},300)}</script></body></html>`);
  w.document.close();
}
async function useMyLocationForShop() {
  try {
    toast("Đang lấy vị trí hiện tại…", "info");
    const { lat, lng } = await getGeoPosition();
    document.getElementById("geoLat").value = lat;
    document.getElementById("geoLng").value = lng;
    toast("Đã lấy vị trí — nhớ bấm Lưu vị trí.", "success");
  } catch (e) { toast(e.message, "error"); }
}
async function saveAttendanceSettings() {
  const latitude = document.getElementById("geoLat").value;
  const longitude = document.getElementById("geoLng").value;
  const radiusMeters = document.getElementById("geoRadius").value;
  try {
    await api("PUT", "/api/attendance/settings", { latitude, longitude, radiusMeters });
    toast("Đã lưu vị trí quán.", "success");
  } catch (e) { toast(e.message, "error"); }
}

/* ================= THÔNG TIN QUÁN (tên, logo, địa chỉ, giờ mở cửa, SĐT) ================= */
function paintShopInfo(el) {
  if (!requireFinanceAccess(el)) return;
  const s = STORE_INFO;
  const hourOptions = (selected) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === selected ? "selected" : ""}>${String(h).padStart(2, "0")}h</option>`).join("");
  const minuteOptions = (selected) => [0, 15, 30, 45].map((m) => `<option value="${m}" ${m === selected ? "selected" : ""}>${String(m).padStart(2, "0")}</option>`).join("");
  el.innerHTML = `
  <div class="panel">
    <h3 style="margin-top:0">Thông tin quán</h3>
    <p style="font-size:12.5px;color:var(--muted);margin-top:-6px">Thông tin này hiển thị ở trang đặt món, hoá đơn in cho khách, và tem pha chế.</p>
    <div class="row2c" style="grid-template-columns:1fr 1fr">
      <div><label style="font-size:11.5px;color:var(--muted)">Tên quán</label><input id="siName" value="${esc(s.name)}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">Tagline (dòng phụ nhỏ)</label><input id="siTagline" value="${esc(s.tagline)}"></div>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:11.5px;color:var(--muted)">Logo quán</label><br>
      <input id="siLogoFile" type="file" accept="image/*" onchange="previewShopLogo(event)">
      <br><img id="siLogoPreview" src="${esc(s.logo)}" style="width:80px;height:80px;object-fit:cover;border-radius:12px;margin-top:8px;${s.logo ? "" : "display:none"}">
    </div>
    <div style="margin-top:10px"><label style="font-size:11.5px;color:var(--muted)">Địa chỉ</label><input id="siAddress" style="width:100%" value="${esc(s.address)}"></div>
    <div class="row2c" style="grid-template-columns:1fr 1fr;margin-top:10px">
      <div><label style="font-size:11.5px;color:var(--muted)">SĐT hiển thị (VD: 0909.777.621)</label><input id="siPhoneDisplay" value="${esc(s.phoneDisplay)}"></div>
      <div><label style="font-size:11.5px;color:var(--muted)">SĐT để bấm gọi (chỉ số, VD: 0909777621)</label><input id="siPhoneTel" value="${esc(s.phoneTel)}"></div>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:11.5px;color:var(--muted)">Giờ mở cửa</label>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px">
        <select id="siOpenHour">${hourOptions(s.openHour)}</select>:<select id="siOpenMinute">${minuteOptions(s.openMinute)}</select>
        <span style="color:var(--muted)">đến</span>
        <select id="siCloseHour">${hourOptions(s.closeHour)}</select>:<select id="siCloseMinute">${minuteOptions(s.closeMinute)}</select>
      </div>
    </div>
    <div style="margin-top:16px"><button class="btn orange" onclick="saveShopInfo()">Lưu thông tin quán</button></div>
  </div>`;
}
function previewShopLogo(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    document.getElementById("siLogoFile").dataset.data = r.result;
    const img = document.getElementById("siLogoPreview");
    img.src = r.result; img.style.display = "block";
  };
  r.readAsDataURL(f);
}
async function saveShopInfo() {
  const name = document.getElementById("siName").value.trim();
  if (!name) return toast("Vui lòng nhập tên quán.", "error");
  const logoData = document.getElementById("siLogoFile").dataset.data;
  const payload = {
    name,
    tagline: document.getElementById("siTagline").value.trim(),
    logo: logoData !== undefined ? logoData : STORE_INFO.logo,
    address: document.getElementById("siAddress").value.trim(),
    phoneDisplay: document.getElementById("siPhoneDisplay").value.trim(),
    phoneTel: document.getElementById("siPhoneTel").value.trim(),
    openHour: document.getElementById("siOpenHour").value,
    openMinute: document.getElementById("siOpenMinute").value,
    closeHour: document.getElementById("siCloseHour").value,
    closeMinute: document.getElementById("siCloseMinute").value,
  };
  try {
    await api("PUT", "/api/shop-settings", payload);
    await refreshShopSettings();
    toast("Đã lưu thông tin quán.", "success");
    renderAdmin();
  } catch (e) { toast(e.message, "error"); }
}

/* ================= ẢNH MENU HÀNG LOẠT (dán link ảnh, không cần tải về máy) ================= */
async function paintBulkImages(el) {
  if (!requireFinanceAccess(el)) return;
  el.innerHTML = `
  <div class="panel">
    <h3 style="margin-top:0">Ảnh menu hàng loạt</h3>
    <p style="font-size:12.5px;color:var(--muted)">Dán link ảnh (URL) cho từng món rồi bấm "Lưu", không cần tải ảnh về máy. Mẹo: chuột phải vào ảnh ưng ý trên mạng → "Sao chép địa chỉ hình ảnh" (Copy image address) → dán vào ô bên dưới. Nhớ chỉ dùng ảnh có quyền sử dụng thương mại (Pexels, Unsplash, Pixabay, hoặc ảnh tự chụp).</p>
  </div>
  ${menu.categories.map((c) => {
    const prods = menu.products.filter((p) => p.categoryId === c.id);
    if (!prods.length) return "";
    return `<div class="panel">
      <h3 style="margin-top:0">${esc(c.name)}</h3>
      ${prods.map((p) => `
        <div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px dashed var(--line)">
          <img id="bimg_prev_${p.id}" src="${esc(p.image || "")}" style="width:48px;height:48px;object-fit:cover;border-radius:8px;background:#f3ece7;flex-shrink:0;${p.image ? "" : "display:none"}">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13px">${esc(p.name)}</div>
            <input id="bimg_url_${p.id}" placeholder="Dán link ảnh (URL)..." value="${p.image && p.image.startsWith("http") ? esc(p.image) : ""}" style="width:100%;margin-top:4px" oninput="previewBulkImageUrl('${p.id}')">
          </div>
          <button class="btn light" onclick="saveBulkImage('${p.id}')">Lưu</button>
        </div>`).join("")}
    </div>`;
  }).join("")}
  <div class="panel" style="text-align:center">
    <button class="btn orange" onclick="saveAllBulkImages()">Lưu tất cả ảnh đã dán</button>
  </div>`;
}
function previewBulkImageUrl(id) {
  const input = document.getElementById("bimg_url_" + id);
  const img = document.getElementById("bimg_prev_" + id);
  if (!input || !img) return;
  const v = input.value.trim();
  if (v) { img.src = v; img.style.display = "block"; } else { img.style.display = "none"; }
}
async function saveBulkImage(id) {
  const input = document.getElementById("bimg_url_" + id);
  const url = input.value.trim();
  try {
    await api("PATCH", `/api/admin/products/${id}/image`, { image: url });
    await refreshMenu();
    toast("Đã lưu ảnh.", "success");
  } catch (e) { toast(e.message, "error"); }
}
async function saveAllBulkImages() {
  const inputs = [...document.querySelectorAll('[id^="bimg_url_"]')].filter((i) => i.value.trim());
  if (!inputs.length) return toast("Chưa dán link ảnh nào.", "error");
  let okCount = 0, failCount = 0;
  for (const input of inputs) {
    const id = input.id.replace("bimg_url_", "");
    try { await api("PATCH", `/api/admin/products/${id}/image`, { image: input.value.trim() }); okCount++; } catch (e) { failCount++; }
  }
  await refreshMenu();
  toast(`Đã lưu ${okCount} ảnh${failCount ? `, ${failCount} lỗi` : ""}.`, failCount ? "error" : "success");
  paintAdminBody();
}

boot();
