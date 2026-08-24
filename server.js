const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const { get, all, run, uid, hashPassword, initDb } = require("./db");
const { SESSION_COOKIE, verifyPassword, createSession, destroySession, attachUser, requireRole } = require("./auth");

const app = express();
app.use(express.json({ limit: "12mb" })); // ảnh món gửi dạng base64 nên cần giới hạn lớn hơn mặc định
app.use(cookieParser());
app.use(attachUser);
app.use(express.static(path.join(__dirname, "public")));

const isProd = process.env.NODE_ENV === "production";
const cookieOpts = { httpOnly: true, sameSite: "lax", secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 7 };

/** bọc route async để lỗi tự rơi vào error handler thay vì làm crash tiến trình */
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);
/** tạo danh sách "?,?,?" cho mệnh đề IN(...) */
const inClause = (arr) => arr.map(() => "?").join(",");

/* ================= AUTH ================= */
app.post("/api/auth/login", h(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await get("SELECT * FROM users WHERE username=?", [String(username || "").trim()]);
  if (!user || !user.active || !verifyPassword(password || "", user.salt, user.password_hash)) {
    return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu." });
  }
  const token = await createSession(user.username, user.role);
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  res.json({ username: user.username, role: user.role });
}));

app.post("/api/auth/logout", h(async (req, res) => {
  await destroySession(req.cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
}));

app.get("/api/auth/me", (req, res) => {
  res.json(req.user ? { username: req.user.username, role: req.user.role } : null);
});

/* ================= MENU (đọc công khai) ================= */
async function fullMenu() {
  const [categories, rawProducts, allSizes, allProdToppings, toppings, sugarLevels, iceLevels, sizeCatalog] = await Promise.all([
    all("SELECT id,name FROM categories ORDER BY sort_order"),
    all("SELECT * FROM products ORDER BY sort_order"),
    all("SELECT id,product_id,size_name as name,price,size_id as catalog_id FROM product_sizes ORDER BY price"),
    all("SELECT product_id,topping_id FROM product_toppings"),
    all("SELECT id,name,price,active FROM toppings ORDER BY name"),
    all("SELECT id,name FROM sugar_levels ORDER BY sort_order"),
    all("SELECT id,name FROM ice_levels ORDER BY sort_order"),
    all("SELECT id,name FROM sizes ORDER BY sort_order"),
  ]);
  const sizesByProduct = {};
  for (const s of allSizes) (sizesByProduct[s.product_id] ||= []).push({ id: s.id, name: s.name, price: s.price, catalogId: s.catalog_id });
  const toppingIdsByProduct = {};
  for (const t of allProdToppings) (toppingIdsByProduct[t.product_id] ||= []).push(t.topping_id);

  const products = rawProducts.map((p) => ({
    id: p.id, categoryId: p.category_id, name: p.name, description: p.description,
    image: p.image, status: p.status,
    sizes: sizesByProduct[p.id] || [], toppingIds: toppingIdsByProduct[p.id] || [],
  }));
  return { categories, products, toppings, sugarLevels, iceLevels, sizeCatalog };
}
app.get("/api/menu", h(async (req, res) => res.json(await fullMenu())));

/* ================= THÔNG TIN QUÁN (tên, logo, địa chỉ, giờ mở cửa, SĐT) =================
   Đọc công khai vì trang khách hàng cần hiển thị header/giờ mở cửa mà không cần đăng nhập. */
async function getShopSettings() {
  let row = await get("SELECT * FROM shop_settings WHERE id='default'");
  if (!row) {
    await run("INSERT INTO shop_settings(id,updated_at) VALUES ('default',now())");
    row = await get("SELECT * FROM shop_settings WHERE id='default'");
  }
  return row;
}
app.get("/api/shop-settings", h(async (req, res) => res.json(await getShopSettings())));
app.put("/api/shop-settings", requireRole("admin", "moderator"), h(async (req, res) => {
  const { name, tagline, logo, address, phoneDisplay, phoneTel, openHour, openMinute, closeHour, closeMinute } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Vui lòng nhập tên quán." });
  const oh = parseInt(openHour), om = parseInt(openMinute), ch = parseInt(closeHour), cm = parseInt(closeMinute);
  if (![oh, om, ch, cm].every(Number.isFinite) || oh < 0 || oh > 23 || ch < 0 || ch > 23 || om < 0 || om > 59 || cm < 0 || cm > 59) {
    return res.status(400).json({ error: "Giờ mở/đóng cửa không hợp lệ." });
  }
  const current = await getShopSettings();
  await run(
    "UPDATE shop_settings SET name=?,tagline=?,logo=?,address=?,phone_display=?,phone_tel=?,open_hour=?,open_minute=?,close_hour=?,close_minute=?,updated_at=now(),updated_by=? WHERE id='default'",
    [String(name).trim(), (tagline || "").trim(), logo !== undefined ? logo : current.logo, (address || "").trim(), (phoneDisplay || "").trim(), (phoneTel || "").trim(), oh, om, ch, cm, req.user.username]
  );
  res.json(await getShopSettings());
}));

/* ================= ORDERS ================= */
app.post("/api/orders", h(async (req, res) => {
  const { customerName, phone, receiveType, tableOrAddress, note, items } = req.body || {};
  if (!customerName || !String(customerName).trim()) return res.status(400).json({ error: "Vui lòng nhập tên khách hàng." });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Giỏ hàng đang trống." });

  const productIds = [...new Set(items.map((i) => i.productId).filter(Boolean))];
  const sizeIds = [...new Set(items.map((i) => i.sizeId).filter(Boolean))];
  const toppingIds = [...new Set(items.flatMap((i) => (Array.isArray(i.toppingIds) ? i.toppingIds : [])))];

  const [products, sizes, toppingRows, allowedRows] = await Promise.all([
    productIds.length ? all(`SELECT * FROM products WHERE id IN (${inClause(productIds)})`, productIds) : [],
    sizeIds.length ? all(`SELECT id,size_name as name,price,product_id FROM product_sizes WHERE id IN (${inClause(sizeIds)})`, sizeIds) : [],
    toppingIds.length ? all(`SELECT * FROM toppings WHERE id IN (${inClause(toppingIds)}) AND active=true`, toppingIds) : [],
    productIds.length ? all(`SELECT product_id, topping_id FROM product_toppings WHERE product_id IN (${inClause(productIds)})`, productIds) : [],
  ]);
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const sizeById = Object.fromEntries(sizes.map((s) => [s.id, s]));
  const toppingById = Object.fromEntries(toppingRows.map((t) => [t.id, t]));
  const allowedByProduct = {};
  for (const r of allowedRows) (allowedByProduct[r.product_id] ||= new Set()).add(r.topping_id);

  const orderItems = [];
  let total = 0;
  for (const it of items) {
    const product = productById[it.productId];
    if (!product || product.status !== "active") return res.status(400).json({ error: `Món "${it.productId}" hiện không có sẵn.` });
    const size = sizeById[it.sizeId];
    if (!size || size.product_id !== it.productId) return res.status(400).json({ error: `Size không hợp lệ cho món "${product.name}".` });
    const allowed = allowedByProduct[it.productId] || new Set();
    const chosenToppingIds = Array.isArray(it.toppingIds) ? it.toppingIds.filter((id) => allowed.has(id) && toppingById[id]) : [];
    const toppings = chosenToppingIds.map((id) => toppingById[id]);
    const qty = Math.max(1, parseInt(it.quantity) || 1);
    const toppingTotal = toppings.reduce((s, t) => s + t.price, 0);
    const subtotal = (size.price + toppingTotal) * qty;
    total += subtotal;
    orderItems.push({
      id: uid("oi_"), productName: product.name, sizeName: size.name, sizePrice: size.price,
      sugar: it.sugar || "", ice: it.ice || "", quantity: qty, note: (it.note || "").trim(),
      subtotal, toppings: toppings.map((t) => ({ name: t.name, price: t.price })),
    });
  }

  const orderId = uid("od_");
  const code = "HH" + Date.now().toString().slice(-6);
  await run(
    "INSERT INTO orders(id,code,customer_name,phone,receive_type,table_or_address,note,total,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,now())",
    [orderId, code, String(customerName).trim(), (phone || "").trim(), receiveType || "Tại quán", (tableOrAddress || "").trim(), (note || "").trim(), total, "Mới"]
  );

  const itemRows = orderItems.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
  const itemParams = orderItems.flatMap((oi) => [oi.id, orderId, oi.productName, oi.sizeName, oi.sizePrice, oi.sugar, oi.ice, oi.quantity, oi.note, oi.subtotal]);
  await run(`INSERT INTO order_items(id,order_id,product_name,size_name,size_price,sugar,ice,quantity,note,subtotal) VALUES ${itemRows}`, itemParams);

  const toppingFlat = orderItems.flatMap((oi) => oi.toppings.map((t) => [oi.id, t.name, t.price]));
  if (toppingFlat.length) {
    const topRows = toppingFlat.map(() => "(?,?,?)").join(",");
    await run(`INSERT INTO order_item_toppings(order_item_id,topping_name,topping_price) VALUES ${topRows}`, toppingFlat.flat());
  }

  res.status(201).json({ id: orderId, code, total, status: "Mới" });
}));

async function loadOrders() {
  const [orders, allItems, allToppings] = await Promise.all([
    all("SELECT * FROM orders ORDER BY created_at DESC"),
    all("SELECT * FROM order_items"),
    all("SELECT order_item_id, topping_name as name, topping_price as price FROM order_item_toppings"),
  ]);
  const toppingsByItem = {};
  for (const t of allToppings) (toppingsByItem[t.order_item_id] ||= []).push({ name: t.name, price: t.price });
  const itemsByOrder = {};
  for (const it of allItems) (itemsByOrder[it.order_id] ||= []).push({ ...it, toppings: toppingsByItem[it.id] || [] });
  return orders.map((o) => ({ ...o, items: itemsByOrder[o.id] || [] }));
}
app.get("/api/orders", requireRole("admin", "moderator", "staff"), h(async (req, res) => res.json(await loadOrders())));

app.patch("/api/orders/:id/status", requireRole("admin", "moderator", "staff"), h(async (req, res) => {
  const { status } = req.body || {};
  const allowed = ["Mới", "Đang pha chế", "Hoàn tất", "Đã giao"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Trạng thái không hợp lệ." });
  const result = await run("UPDATE orders SET status=? WHERE id=?", [status, req.params.id]);
  if (!result.changes) return res.status(404).json({ error: "Không tìm thấy đơn." });
  res.json({ ok: true });
}));

app.delete("/api/orders/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  await run("UPDATE orders SET status='Đã xóa', deleted_at=now(), deleted_by=? WHERE id=?", [req.user.username, req.params.id]);
  res.json({ ok: true });
}));

/** Xoá vĩnh viễn TOÀN BỘ đơn hàng — dùng để dọn dữ liệu test trước khi vận hành thật. Chỉ admin. */
app.delete("/api/orders", requireRole("admin"), h(async (req, res) => {
  const result = await run("DELETE FROM orders");
  res.json({ ok: true, deleted: result.changes });
}));

/* ================= ADMIN: DANH MỤC ================= */
app.post("/api/admin/categories", requireRole("admin", "moderator"), h(async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Tên danh mục không được để trống." });
  if (await get("SELECT 1 FROM categories WHERE name=?", [name])) return res.status(409).json({ error: "Danh mục đã tồn tại." });
  const maxRow = await get("SELECT COALESCE(MAX(sort_order),-1) m FROM categories");
  const id = uid("cat_");
  await run("INSERT INTO categories(id,name,sort_order) VALUES (?,?,?)", [id, name, maxRow.m + 1]);
  res.status(201).json({ id, name });
}));
app.delete("/api/admin/categories/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  if (await get("SELECT 1 FROM products WHERE category_id=?", [req.params.id])) {
    return res.status(409).json({ error: "Không thể xoá danh mục đang có món." });
  }
  await run("DELETE FROM categories WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));
app.put("/api/admin/categories/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const id = req.params.id;
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Tên danh mục không được để trống." });
  const current = await get("SELECT id FROM categories WHERE id=?", [id]);
  if (!current) return res.status(404).json({ error: "Không tìm thấy danh mục." });
  const duplicate = await get("SELECT id FROM categories WHERE name=? AND id<>?", [name, id]);
  if (duplicate) return res.status(409).json({ error: "Danh mục này đã tồn tại." });
  await run("UPDATE categories SET name=? WHERE id=?", [name, id]);
  res.json({ id, name });
}));

/** Kiểm tra + tra tên cho danh sách size gửi lên (mỗi dòng phải chọn 1 size có sẵn trong danh mục, không gõ tay). */
async function resolveProductSizes(sizesInput) {
  if (!Array.isArray(sizesInput) || !sizesInput.length) return { error: "Phải có ít nhất 1 size." };
  const sizeIds = sizesInput.map((s) => s && s.sizeId).filter(Boolean);
  if (sizeIds.length !== sizesInput.length) return { error: "Vui lòng chọn size cho từng dòng." };
  if (new Set(sizeIds).size !== sizeIds.length) return { error: "Mỗi size chỉ được chọn 1 lần cho 1 món." };
  const catalogRows = await all(`SELECT id,name FROM sizes WHERE id IN (${inClause(sizeIds)})`, sizeIds);
  if (catalogRows.length !== new Set(sizeIds).size) return { error: "Có size không hợp lệ — vui lòng chọn lại." };
  const nameById = Object.fromEntries(catalogRows.map((r) => [r.id, r.name]));
  return {
    sizes: sizesInput.map((s) => ({ id: s.id, sizeId: s.sizeId, name: nameById[s.sizeId], price: Number(s.price) || 0 })),
  };
}

/* ================= ADMIN: MÓN ================= */
app.post("/api/admin/products", requireRole("admin", "moderator"), h(async (req, res) => {
  const p = req.body || {};
  if (!p.name || !String(p.name).trim()) return res.status(400).json({ error: "Vui lòng nhập tên món." });
  const resolved = await resolveProductSizes(p.sizes);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const id = uid("sp_");
  const maxRow = await get("SELECT COALESCE(MAX(sort_order),-1) m FROM products");
  await run("INSERT INTO products(id,category_id,name,description,image,status,sort_order) VALUES (?,?,?,?,?,?,?)", [
    id, p.categoryId, String(p.name).trim(), p.description || "", p.image || "", p.status || "active", maxRow.m + 1,
  ]);
  for (const s of resolved.sizes) await run("INSERT INTO product_sizes(id,product_id,size_id,size_name,price) VALUES (?,?,?,?,?)", [uid("sz_"), id, s.sizeId, s.name, s.price]);
  for (const tid of p.toppingIds || []) await run("INSERT INTO product_toppings(product_id,topping_id) VALUES (?,?)", [id, tid]);
  res.status(201).json({ id });
}));

app.put("/api/admin/products/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const p = req.body || {};
  const existing = await get("SELECT 1 FROM products WHERE id=?", [req.params.id]);
  if (!existing) return res.status(404).json({ error: "Không tìm thấy món." });
  if (!p.name || !String(p.name).trim()) return res.status(400).json({ error: "Vui lòng nhập tên món." });
  const resolved = await resolveProductSizes(p.sizes);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  await run("UPDATE products SET category_id=?,name=?,description=?,image=?,status=? WHERE id=?", [
    p.categoryId, String(p.name).trim(), p.description || "", p.image || "", p.status || "active", req.params.id,
  ]);
  await run("DELETE FROM product_sizes WHERE product_id=?", [req.params.id]);
  for (const s of resolved.sizes) {
    await run("INSERT INTO product_sizes(id,product_id,size_id,size_name,price) VALUES (?,?,?,?,?)", [
      s.id && String(s.id).length < 40 ? s.id : uid("sz_"), req.params.id, s.sizeId, s.name, s.price,
    ]);
  }
  await run("DELETE FROM product_toppings WHERE product_id=?", [req.params.id]);
  for (const tid of p.toppingIds || []) await run("INSERT INTO product_toppings(product_id,topping_id) VALUES (?,?)", [req.params.id, tid]);
  res.json({ ok: true });
}));

app.delete("/api/admin/products/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  await run("DELETE FROM products WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));
/** Chỉ cập nhật ảnh — dùng cho công cụ "Ảnh menu hàng loạt", không đụng tới size/topping/giá của món. */
app.patch("/api/admin/products/:id/image", requireRole("admin", "moderator"), h(async (req, res) => {
  const image = (req.body && req.body.image) || "";
  const r = await run("UPDATE products SET image=? WHERE id=?", [image, req.params.id]);
  if (!r.changes) return res.status(404).json({ error: "Không tìm thấy món." });
  res.json({ ok: true });
}));

/* ================= ADMIN: TOPPING ================= */
app.post("/api/admin/toppings", requireRole("admin", "moderator"), h(async (req, res) => {
  const { name, price } = req.body || {};
  if (!name || !price) return res.status(400).json({ error: "Nhập tên và giá." });
  const id = uid("tp_");
  await run("INSERT INTO toppings(id,name,price,active) VALUES (?,?,?,true)", [id, String(name).trim(), Number(price)]);
  res.status(201).json({ id });
}));
app.put("/api/admin/toppings/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const { name, price, active } = req.body || {};
  await run("UPDATE toppings SET name=?,price=?,active=? WHERE id=?", [name, Number(price), !!active, req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/toppings/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  await run("DELETE FROM toppings WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

/* ================= ADMIN: DANH MỤC SIZE ================= */
app.post("/api/admin/sizes", requireRole("admin", "moderator"), h(async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Tên size không được để trống." });
  if (await get("SELECT 1 FROM sizes WHERE name=?", [name])) return res.status(409).json({ error: "Size này đã tồn tại." });
  const maxRow = await get("SELECT COALESCE(MAX(sort_order),-1) m FROM sizes");
  const id = uid("szc_");
  await run("INSERT INTO sizes(id,name,sort_order) VALUES (?,?,?)", [id, name, maxRow.m + 1]);
  res.status(201).json({ id, name });
}));
app.put("/api/admin/sizes/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const id = req.params.id;
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Tên size không được để trống." });

  const current = await get("SELECT id,name FROM sizes WHERE id=?", [id]);
  if (!current) return res.status(404).json({ error: "Không tìm thấy size." });

  const duplicate = await get("SELECT id FROM sizes WHERE name=? AND id<>?", [name, id]);
  if (duplicate) return res.status(409).json({ error: "Size này đã tồn tại." });

  await run("UPDATE sizes SET name=? WHERE id=?", [name, id]);

  // Đồng bộ tên size đã lưu trong từng món để giao diện khách hàng hiển thị tên mới.
  await run("UPDATE product_sizes SET size_name=? WHERE size_id=?", [name, id]);

  res.json({ id, name });
}));

app.delete("/api/admin/sizes/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  if (await get("SELECT 1 FROM product_sizes WHERE size_id=?", [req.params.id])) {
    return res.status(409).json({ error: "Không thể xoá — size này đang được dùng cho món. Hãy đổi size của các món đó trước." });
  }
  const countRow = await get("SELECT COUNT(*)::int c FROM sizes");
  if (countRow.c <= 1) return res.status(409).json({ error: "Phải giữ ít nhất 1 size." });
  await run("DELETE FROM sizes WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

/* ================= ADMIN: MỨC ĐƯỜNG / ĐÁ ================= */
function levelRoutes(table) {
  app.post(`/api/admin/levels/${table}`, requireRole("admin", "moderator"), h(async (req, res) => {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Không được để trống." });
    if (await get(`SELECT 1 FROM ${table}_levels WHERE name=?`, [name])) return res.status(409).json({ error: "Mức này đã tồn tại." });
    const maxRow = await get(`SELECT COALESCE(MAX(sort_order),-1) m FROM ${table}_levels`);
    const id = uid("lv_");
    await run(`INSERT INTO ${table}_levels(id,name,sort_order) VALUES (?,?,?)`, [id, name, maxRow.m + 1]);
    res.status(201).json({ id, name });
  }));
  app.delete(`/api/admin/levels/${table}/:id`, requireRole("admin", "moderator"), h(async (req, res) => {
    const countRow = await get(`SELECT COUNT(*)::int c FROM ${table}_levels`);
    if (countRow.c <= 1) return res.status(409).json({ error: "Phải giữ ít nhất 1 mức." });
    await run(`DELETE FROM ${table}_levels WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  }));
  app.put(`/api/admin/levels/${table}/:id`, requireRole("admin", "moderator"), h(async (req, res) => {
    const id = req.params.id;
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Không được để trống." });
    const current = await get(`SELECT id FROM ${table}_levels WHERE id=?`, [id]);
    if (!current) return res.status(404).json({ error: "Không tìm thấy mức này." });
    const duplicate = await get(`SELECT id FROM ${table}_levels WHERE name=? AND id<>?`, [name, id]);
    if (duplicate) return res.status(409).json({ error: "Mức này đã tồn tại." });
    await run(`UPDATE ${table}_levels SET name=? WHERE id=?`, [name, id]);
    res.json({ id, name });
  }));
}
levelRoutes("sugar");
levelRoutes("ice");

/* ================= ADMIN: TÀI KHOẢN ================= */
app.get("/api/admin/users", requireRole("admin", "moderator"), h(async (req, res) => {
  res.json(await all("SELECT id,username,role,active FROM users ORDER BY username"));
}));
app.post("/api/admin/users", requireRole("admin", "moderator"), h(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Nhập đầy đủ user và password." });
  if (password.length < 4) return res.status(400).json({ error: "Mật khẩu nên có ít nhất 4 ký tự." });
  if (await get("SELECT 1 FROM users WHERE username=?", [username])) return res.status(409).json({ error: "User đã tồn tại." });
  const { hash, salt } = hashPassword(password);
  await run("INSERT INTO users(id,username,password_hash,salt,role,active) VALUES (?,?,?,?,?,true)", [
    uid("us_"), String(username).trim(), hash, salt, role || "staff",
  ]);
  res.status(201).json({ ok: true });
}));
app.put("/api/admin/users/:id/password", requireRole("admin", "moderator"), h(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: "Mật khẩu nên có ít nhất 4 ký tự." });
  const { hash, salt } = hashPassword(password);
  const r = await run("UPDATE users SET password_hash=?,salt=? WHERE id=?", [hash, salt, req.params.id]);
  if (!r.changes) return res.status(404).json({ error: "Không tìm thấy user." });
  res.json({ ok: true });
}));
app.delete("/api/admin/users/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const target = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
  if (!target) return res.status(404).json({ error: "Không tìm thấy user." });
  if (target.role === "admin") return res.status(409).json({ error: "Không được xoá user admin." });
  await run("DELETE FROM users WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

/* ================= ADMIN: SỔ QUỸ THU / CHI ================= */
app.get("/api/admin/cashbook", requireRole("admin", "moderator"), h(async (req, res) => {
  const { from, to, type } = req.query || {};
  const conds = [];
  const params = [];
  if (from) { conds.push("occurred_at >= ?"); params.push(from); }
  if (to) { conds.push("occurred_at <= ?"); params.push(to + " 23:59:59"); }
  if (type === "thu" || type === "chi") { conds.push("type = ?"); params.push(type); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = await all(`SELECT * FROM cashbook ${where} ORDER BY occurred_at DESC`, params);
  res.json(rows);
}));
app.post("/api/admin/cashbook", requireRole("admin", "moderator"), h(async (req, res) => {
  const { type, category, amount, note, occurredAt } = req.body || {};
  if (!["thu", "chi"].includes(type)) return res.status(400).json({ error: "Loại phải là 'thu' hoặc 'chi'." });
  const amt = parseInt(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "Số tiền không hợp lệ." });
  const id = uid("cb_");
  await run(
    "INSERT INTO cashbook(id,type,category,amount,note,occurred_at,created_by) VALUES (?,?,?,?,?,?,?)",
    [id, type, (category || "Khác").trim(), amt, (note || "").trim(), occurredAt || new Date().toISOString(), req.user.username]
  );
  res.status(201).json({ id });
}));
app.put("/api/admin/cashbook/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const { type, category, amount, note, occurredAt } = req.body || {};
  if (!["thu", "chi"].includes(type)) return res.status(400).json({ error: "Loại phải là 'thu' hoặc 'chi'." });
  const amt = parseInt(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "Số tiền không hợp lệ." });
  const r = await run(
    "UPDATE cashbook SET type=?,category=?,amount=?,note=?,occurred_at=? WHERE id=?",
    [type, (category || "Khác").trim(), amt, (note || "").trim(), occurredAt || new Date().toISOString(), req.params.id]
  );
  if (!r.changes) return res.status(404).json({ error: "Không tìm thấy khoản thu/chi này." });
  res.json({ ok: true });
}));
app.delete("/api/admin/cashbook/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  await run("DELETE FROM cashbook WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

/* ================= ADMIN: CÔNG NỢ ================= */
async function loadDebts() {
  const [debts, payments] = await Promise.all([
    all("SELECT * FROM debts ORDER BY created_at DESC"),
    all("SELECT * FROM debt_payments ORDER BY paid_at ASC"),
  ]);
  const paymentsByDebt = {};
  for (const p of payments) (paymentsByDebt[p.debt_id] ||= []).push(p);
  return debts.map((d) => {
    const paid = (paymentsByDebt[d.id] || []).reduce((s, p) => s + p.amount, 0);
    return { ...d, payments: paymentsByDebt[d.id] || [], paid, remaining: d.amount - paid };
  });
}
app.get("/api/admin/debts", requireRole("admin", "moderator"), h(async (req, res) => res.json(await loadDebts())));
app.post("/api/admin/debts", requireRole("admin", "moderator"), h(async (req, res) => {
  const { type, partnerName, phone, amount, note } = req.body || {};
  if (!["receivable", "payable"].includes(type)) return res.status(400).json({ error: "Loại công nợ không hợp lệ." });
  if (!partnerName || !String(partnerName).trim()) return res.status(400).json({ error: "Vui lòng nhập tên đối tác/khách hàng." });
  const amt = parseInt(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "Số tiền không hợp lệ." });
  const id = uid("dbt_");
  await run(
    "INSERT INTO debts(id,type,partner_name,phone,amount,note,status,created_at,created_by) VALUES (?,?,?,?,?,?,'open',now(),?)",
    [id, type, String(partnerName).trim(), (phone || "").trim(), amt, (note || "").trim(), req.user.username]
  );
  res.status(201).json({ id });
}));
app.put("/api/admin/debts/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const { partnerName, phone, amount, note } = req.body || {};
  if (!partnerName || !String(partnerName).trim()) return res.status(400).json({ error: "Vui lòng nhập tên đối tác/khách hàng." });
  const amt = parseInt(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "Số tiền không hợp lệ." });
  const r = await run("UPDATE debts SET partner_name=?,phone=?,amount=?,note=? WHERE id=?", [
    String(partnerName).trim(), (phone || "").trim(), amt, (note || "").trim(), req.params.id,
  ]);
  if (!r.changes) return res.status(404).json({ error: "Không tìm thấy khoản nợ này." });
  res.json({ ok: true });
}));
app.delete("/api/admin/debts/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  await run("DELETE FROM debts WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));
app.post("/api/admin/debts/:id/payments", requireRole("admin", "moderator"), h(async (req, res) => {
  const debt = await get("SELECT * FROM debts WHERE id=?", [req.params.id]);
  if (!debt) return res.status(404).json({ error: "Không tìm thấy khoản nợ này." });
  const amt = parseInt(req.body?.amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "Số tiền không hợp lệ." });
  const id = uid("dp_");
  await run("INSERT INTO debt_payments(id,debt_id,amount,note,paid_at,created_by) VALUES (?,?,?,?,now(),?)", [
    id, debt.id, amt, (req.body?.note || "").trim(), req.user.username,
  ]);
  const paidRow = await get("SELECT COALESCE(SUM(amount),0)::int s FROM debt_payments WHERE debt_id=?", [debt.id]);
  if (paidRow.s >= debt.amount) await run("UPDATE debts SET status='closed' WHERE id=?", [debt.id]);
  res.status(201).json({ id });
}));
app.delete("/api/admin/debts/:id/payments/:paymentId", requireRole("admin", "moderator"), h(async (req, res) => {
  await run("DELETE FROM debt_payments WHERE id=? AND debt_id=?", [req.params.paymentId, req.params.id]);
  await run("UPDATE debts SET status='open' WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

/* ================= ADMIN: CHẤM CÔNG NHÂN VIÊN ================= */
function computeHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  if (!(ms > 0)) return 0;
  return Math.round((ms / 3600000) * 100) / 100;
}
app.get("/api/admin/attendance", requireRole("admin", "moderator"), h(async (req, res) => {
  const { from, to, userId } = req.query || {};
  const conds = [];
  const params = [];
  if (from) { conds.push("a.work_date >= ?"); params.push(from); }
  if (to) { conds.push("a.work_date <= ?"); params.push(to); }
  if (userId) { conds.push("a.user_id = ?"); params.push(userId); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = await all(
    `SELECT a.*, u.username FROM attendance a JOIN users u ON u.id=a.user_id ${where} ORDER BY a.work_date DESC, u.username`,
    params
  );
  res.json(rows);
}));
app.post("/api/admin/attendance", requireRole("admin", "moderator"), h(async (req, res) => {
  const { userId, workDate, checkIn, checkOut, note } = req.body || {};
  if (!userId || !workDate) return res.status(400).json({ error: "Vui lòng chọn nhân viên và ngày công." });
  const user = await get("SELECT id FROM users WHERE id=?", [userId]);
  if (!user) return res.status(400).json({ error: "Không tìm thấy nhân viên." });
  const existing = await get("SELECT id FROM attendance WHERE user_id=? AND work_date=?", [userId, workDate]);
  if (existing) return res.status(409).json({ error: "Nhân viên này đã có bản ghi chấm công cho ngày này." });
  const hours = computeHours(checkIn, checkOut);
  const id = uid("att_");
  await run(
    "INSERT INTO attendance(id,user_id,work_date,check_in,check_out,hours,note,created_by) VALUES (?,?,?,?,?,?,?,?)",
    [id, userId, workDate, checkIn || null, checkOut || null, hours, (note || "").trim(), req.user.username]
  );
  res.status(201).json({ id });
}));
app.put("/api/admin/attendance/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const { checkIn, checkOut, note } = req.body || {};
  const hours = computeHours(checkIn, checkOut);
  const r = await run("UPDATE attendance SET check_in=?,check_out=?,hours=?,note=? WHERE id=?", [
    checkIn || null, checkOut || null, hours, (note || "").trim(), req.params.id,
  ]);
  if (!r.changes) return res.status(404).json({ error: "Không tìm thấy bản ghi chấm công." });
  res.json({ ok: true });
}));
app.delete("/api/admin/attendance/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  await run("DELETE FROM attendance WHERE id=?", [req.params.id]);
  res.json({ ok: true });
}));

/* ================= CHẤM CÔNG TỰ PHỤC VỤ (QR + định vị GPS) =================
   Nguyên tắc: mã QR chỉ là lối vào nhanh (link), thứ THỰC SỰ chặn chấm công từ xa là so khoảng
   cách GPS của điện thoại lúc bấm nút với toạ độ quán lưu ở attendance_settings. Nếu vượt bán
   kính cho phép thì từ chối, dù có link hay không. */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function getAttendanceSettings() {
  let row = await get("SELECT * FROM attendance_settings WHERE id='default'");
  if (!row) {
    await run("INSERT INTO attendance_settings(id,radius_meters,updated_at) VALUES ('default',100,now())");
    row = await get("SELECT * FROM attendance_settings WHERE id='default'");
  }
  return row;
}
app.get("/api/attendance/settings", requireRole("admin", "moderator"), h(async (req, res) => {
  res.json(await getAttendanceSettings());
}));
app.put("/api/attendance/settings", requireRole("admin", "moderator"), h(async (req, res) => {
  const { latitude, longitude, radiusMeters } = req.body || {};
  const lat = parseFloat(latitude), lng = parseFloat(longitude), rad = parseInt(radiusMeters);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "Toạ độ không hợp lệ." });
  if (!rad || rad < 10 || rad > 2000) return res.status(400).json({ error: "Bán kính nên trong khoảng 10 - 2000 mét." });
  await run(
    "INSERT INTO attendance_settings(id,latitude,longitude,radius_meters,updated_at,updated_by) VALUES ('default',?,?,?,now(),?) ON CONFLICT (id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,radius_meters=EXCLUDED.radius_meters,updated_at=now(),updated_by=EXCLUDED.updated_by",
    [lat, lng, rad, req.user.username]
  );
  res.json({ ok: true });
}));

/** Trả về trạng thái chấm công hôm nay + các ca chấm vào nhưng chưa chấm ra ở những ngày trước (để nhắc nhở/cảnh báo). */
app.get("/api/attendance/me", requireRole("admin", "moderator", "staff"), h(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [todayRow, openPrevious] = await Promise.all([
    get("SELECT * FROM attendance WHERE user_id=? AND work_date=?", [req.user.id, today]),
    all("SELECT * FROM attendance WHERE user_id=? AND work_date<? AND check_in IS NOT NULL AND check_out IS NULL ORDER BY work_date DESC", [req.user.id, today]),
  ]);
  res.json({ today: todayRow, openPrevious });
}));

app.post("/api/attendance/self/checkin", requireRole("admin", "moderator", "staff"), h(async (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "Thiếu vị trí định vị. Vui lòng bật định vị (GPS) trên điện thoại rồi thử lại." });
  }
  const settings = await getAttendanceSettings();
  if (settings.latitude == null || settings.longitude == null) {
    return res.status(400).json({ error: "Quán chưa cấu hình vị trí chấm công. Vui lòng báo quản lý." });
  }
  const dist = distanceMeters(lat, lng, settings.latitude, settings.longitude);
  if (dist > settings.radius_meters) {
    return res.status(403).json({ error: `Bạn đang cách quán khoảng ${Math.round(dist)}m — chỉ chấm công được khi ở tại quán (trong bán kính ${settings.radius_meters}m).` });
  }
  const today = new Date().toISOString().slice(0, 10);
  const existing = await get("SELECT * FROM attendance WHERE user_id=? AND work_date=?", [req.user.id, today]);
  if (existing) return res.status(409).json({ error: existing.check_out ? "Bạn đã hoàn tất chấm công hôm nay rồi." : "Bạn đã chấm vào hôm nay rồi." });
  const id = uid("att_");
  await run("INSERT INTO attendance(id,user_id,work_date,check_in,note,created_by) VALUES (?,?,?,now(),?,?)", [
    id, req.user.id, today, "Tự chấm công (QR)", req.user.username,
  ]);
  const row = await get("SELECT * FROM attendance WHERE id=?", [id]);
  res.status(201).json(row);
}));

app.post("/api/attendance/self/checkout", requireRole("admin", "moderator", "staff"), h(async (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "Thiếu vị trí định vị. Vui lòng bật định vị (GPS) trên điện thoại rồi thử lại." });
  }
  const settings = await getAttendanceSettings();
  if (settings.latitude == null || settings.longitude == null) {
    return res.status(400).json({ error: "Quán chưa cấu hình vị trí chấm công. Vui lòng báo quản lý." });
  }
  const dist = distanceMeters(lat, lng, settings.latitude, settings.longitude);
  if (dist > settings.radius_meters) {
    return res.status(403).json({ error: `Bạn đang cách quán khoảng ${Math.round(dist)}m — chỉ chấm công được khi ở tại quán (trong bán kính ${settings.radius_meters}m).` });
  }
  const today = new Date().toISOString().slice(0, 10);
  const existing = await get("SELECT * FROM attendance WHERE user_id=? AND work_date=?", [req.user.id, today]);
  if (!existing || !existing.check_in) return res.status(409).json({ error: "Bạn chưa chấm vào hôm nay, không thể chấm ra." });
  if (existing.check_out) return res.status(409).json({ error: "Bạn đã chấm ra hôm nay rồi." });
  const hours = computeHours(existing.check_in, new Date().toISOString());
  await run("UPDATE attendance SET check_out=now(), hours=? WHERE id=?", [hours, existing.id]);
  const row = await get("SELECT * FROM attendance WHERE id=?", [existing.id]);
  res.json(row);
}));

/* ================= ADMIN: BÁO CÁO LÃI LỖ CHI TIẾT ================= */
app.get("/api/admin/reports/profit-loss", requireRole("admin", "moderator"), h(async (req, res) => {
  let { from, to } = req.query || {};
  if (!from || !to) {
    const now = new Date();
    from = from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    to = to || now.toISOString().slice(0, 10);
  }
  const [revenueByDay, expenseByDay, expenseByCategory, incomeByCategory, totals] = await Promise.all([
    all(
      "SELECT to_char(created_at,'YYYY-MM-DD') d, COALESCE(SUM(total),0)::int total FROM orders WHERE status<>'Đã xóa' AND created_at::date BETWEEN ? AND ? GROUP BY d ORDER BY d",
      [from, to]
    ),
    all(
      "SELECT to_char(occurred_at,'YYYY-MM-DD') d, COALESCE(SUM(amount),0)::int total FROM cashbook WHERE type='chi' AND occurred_at::date BETWEEN ? AND ? GROUP BY d ORDER BY d",
      [from, to]
    ),
    all(
      "SELECT category, COALESCE(SUM(amount),0)::int total FROM cashbook WHERE type='chi' AND occurred_at::date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC",
      [from, to]
    ),
    all(
      "SELECT category, COALESCE(SUM(amount),0)::int total FROM cashbook WHERE type='thu' AND occurred_at::date BETWEEN ? AND ? GROUP BY category ORDER BY total DESC",
      [from, to]
    ),
    (async () => {
      const revRow = await get("SELECT COALESCE(SUM(total),0)::int s FROM orders WHERE status<>'Đã xóa' AND created_at::date BETWEEN ? AND ?", [from, to]);
      const expRow = await get("SELECT COALESCE(SUM(amount),0)::int s FROM cashbook WHERE type='chi' AND occurred_at::date BETWEEN ? AND ?", [from, to]);
      const otherIncomeRow = await get("SELECT COALESCE(SUM(amount),0)::int s FROM cashbook WHERE type='thu' AND occurred_at::date BETWEEN ? AND ?", [from, to]);
      const orderCountRow = await get("SELECT COUNT(*)::int c FROM orders WHERE status<>'Đã xóa' AND created_at::date BETWEEN ? AND ?", [from, to]);
      return { revenue: revRow.s, expense: expRow.s, otherIncome: otherIncomeRow.s, orderCount: orderCountRow.c };
    })(),
  ]);
  const revenue = totals.revenue, expense = totals.expense, otherIncome = totals.otherIncome;
  const profit = revenue + otherIncome - expense;
  const dayMap = {};
  for (const r of revenueByDay) dayMap[r.d] = { date: r.d, revenue: r.total, expense: 0 };
  for (const r of expenseByDay) { (dayMap[r.d] ||= { date: r.d, revenue: 0, expense: 0 }).expense = r.total; }
  const daily = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
  res.json({
    from, to, revenue, otherIncome, expense, profit, orderCount: totals.orderCount,
    expenseByCategory, incomeByCategory, daily,
  });
}));

/* ================= IN BILL / IN TEM (trang in riêng, dùng cho iPhone) =================
   Lý do có route riêng: trên iOS (Safari/Chrome), lệnh in thường chụp/in theo đúng trang
   web đang mở ở tầng trên cùng — nó KHÔNG tôn trọng nội dung được JS bơm/ẩn-hiện ngay trên
   trang admin (kể cả khi dùng iframe ẩn). Cách chắc ăn là điều hướng thật sang một trang
   độc lập chỉ chứa nội dung bill/tem rồi tự in trang đó. */
const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => Number(n || 0).toLocaleString("vi-VN") + "đ";
const PRINT_CSS = `
  *{box-sizing:border-box}
  body{margin:0;padding:14px;color:#000;font-family:Arial,sans-serif}
  .toolbar{display:flex;gap:8px;justify-content:center;margin-bottom:16px}
  .toolbar button{border:1.5px solid #ccc;background:#fff;border-radius:8px;padding:9px 18px;font-size:14px}
  @media print{ .toolbar{display:none} }
  .bill{width:280px;margin:0 auto;font-family:'Courier New',monospace;color:#000}
  .bill h2{text-align:center;margin:0 0 2px;font-size:16px}
  .bill .bill-sub{text-align:center;font-size:10.5px;margin:0 0 8px}
  .bill hr{border:none;border-top:1px dashed #000;margin:6px 0}
  .bill-row{display:flex;justify-content:space-between;font-size:11.5px;margin:2px 0}
  .bill-table{width:100%;border-collapse:collapse;margin:6px 0;font-size:11px}
  .bill-table td{padding:3px 0;vertical-align:top}
  .bill-table td.qty{text-align:center;width:24px}
  .bill-table td.amt{text-align:right;white-space:nowrap}
  .bill-item-opts{font-size:10px;color:#333}
  .bill-total-row{display:flex;justify-content:space-between;font-size:15px;font-weight:900;margin-top:6px}
  .bill-thanks{text-align:center;margin-top:14px;font-size:11.5px}
  .labels-wrap{display:flex;flex-wrap:wrap;gap:3mm}
  .label{width:6.2cm;min-height:4cm;border:1px dashed #999;padding:7px 8px;box-sizing:border-box;font-family:Arial,sans-serif;page-break-inside:avoid}
  .label-code{font-weight:900;font-size:11px;letter-spacing:.5px}
  .label-name{font-weight:800;font-size:15px;margin:3px 0 2px;line-height:1.15}
  .label-size{font-size:12px;font-weight:700}
  .label-opts{font-size:11px;color:#333;margin-top:2px}
  .label-top{font-size:10.5px;color:#333}
  .label-note{font-size:10.5px;font-style:italic;margin-top:3px}
  @page{margin:8mm}
`;
function printPage(bodyHtml) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>In</title><style>${PRINT_CSS}</style></head><body>
  <div class="toolbar"><button onclick="window.print()">In lại</button><button onclick="window.close()">Đóng</button></div>
  ${bodyHtml}
  <script>window.addEventListener("load",function(){ setTimeout(function(){ window.print(); }, 250); });</script>
  </body></html>`;
}
async function loadOrderItemsWithToppings(orderId) {
  const items = await all("SELECT * FROM order_items WHERE order_id=?", [orderId]);
  if (!items.length) return items.map((it) => ({ ...it, toppings: [] }));
  const toppingRows = await all(
    `SELECT order_item_id, topping_name as name, topping_price as price FROM order_item_toppings WHERE order_item_id IN (${inClause(items.map((i) => i.id))})`,
    items.map((i) => i.id)
  );
  const byItem = {};
  for (const t of toppingRows) (byItem[t.order_item_id] ||= []).push(t);
  return items.map((it) => ({ ...it, toppings: byItem[it.id] || [] }));
}

app.get("/print/bill/:id", requireRole("admin", "moderator", "staff"), h(async (req, res) => {
  const order = await get("SELECT * FROM orders WHERE id=?", [req.params.id]);
  if (!order) return res.status(404).send("Không tìm thấy đơn.");
  const items = await loadOrderItemsWithToppings(order.id);
  const shop = await getShopSettings();
  const html = `<div class="bill">
    <h2>${escHtml(shop.name)}</h2>
    <p class="bill-sub">${escHtml(shop.address)}${shop.address && shop.phone_display ? "<br>" : ""}${shop.phone_display ? "ĐT: " + escHtml(shop.phone_display) : ""}</p>
    <hr>
    <div class="bill-row"><span>Mã đơn</span><strong>${escHtml(order.code)}</strong></div>
    <div class="bill-row"><span>Thời gian</span><span>${new Date(order.created_at).toLocaleString("vi-VN")}</span></div>
    <div class="bill-row"><span>Khách hàng</span><span>${escHtml(order.customer_name)}</span></div>
    <div class="bill-row"><span>Hình thức</span><span>${escHtml(order.receive_type)}${order.table_or_address ? " · " + escHtml(order.table_or_address) : ""}</span></div>
    <hr>
    <table class="bill-table">
      <tr><td><b>Món</b></td><td class="qty"><b>SL</b></td><td class="amt"><b>T.Tiền</b></td></tr>
      ${items.map((it) => `<tr>
        <td>${escHtml(it.product_name)} (${escHtml(it.size_name)})${it.toppings.length ? `<div class="bill-item-opts">+ ${it.toppings.map((t) => escHtml(t.name)).join(", ")}</div>` : ""}${it.sugar || it.ice ? `<div class="bill-item-opts">${escHtml(it.sugar)} · ${escHtml(it.ice)}</div>` : ""}</td>
        <td class="qty">${it.quantity}</td>
        <td class="amt">${money(it.subtotal)}</td>
      </tr>`).join("")}
    </table>
    <hr>
    <div class="bill-total-row"><span>Tổng cộng</span><span>${money(order.total)}</span></div>
    <p class="bill-thanks">Cảm ơn quý khách — hẹn gặp lại!</p>
  </div>`;
  res.send(printPage(html));
}));

app.get("/print/labels/:id", requireRole("admin", "moderator", "staff"), h(async (req, res) => {
  const order = await get("SELECT * FROM orders WHERE id=?", [req.params.id]);
  if (!order) return res.status(404).send("Không tìm thấy đơn.");
  const items = await loadOrderItemsWithToppings(order.id);
  const labels = [];
  for (const it of items) {
    for (let i = 0; i < it.quantity; i++) {
      labels.push(`<div class="label">
        <div class="label-code">${escHtml(order.code)} · ${escHtml(order.receive_type)}${order.table_or_address ? " " + escHtml(order.table_or_address) : ""}</div>
        <div class="label-name">${escHtml(it.product_name)}</div>
        <div class="label-size">Size ${escHtml(it.size_name)}</div>
        <div class="label-opts">${escHtml(it.sugar)} · ${escHtml(it.ice)}</div>
        ${it.toppings.length ? `<div class="label-top">+ ${it.toppings.map((t) => escHtml(t.name)).join(", ")}</div>` : ""}
        ${it.note ? `<div class="label-note">Ghi chú: ${escHtml(it.note)}</div>` : ""}
      </div>`);
    }
  }
  res.send(printPage(`<div class="labels-wrap">${labels.join("")}</div>`));
}));

/* ================= SAO LƯU DỮ LIỆU ================= */
app.get("/api/admin/export", requireRole("admin", "moderator"), h(async (req, res) => {
  res.json({ menu: await fullMenu(), orders: await loadOrders(), exportedAt: new Date().toISOString() });
}));

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Đã có lỗi ở máy chủ. Vui lòng thử lại." });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Café Hồng Hoa server đang chạy tại http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("Không thể khởi tạo database:", err);
    process.exit(1);
  });
