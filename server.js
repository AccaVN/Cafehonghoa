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
  const [categories, rawProducts, allSizes, allProdToppings, toppings, sugarLevels, iceLevels] = await Promise.all([
    all("SELECT id,name FROM categories ORDER BY sort_order"),
    all("SELECT * FROM products ORDER BY sort_order"),
    all("SELECT id,product_id,size_name as name,price FROM product_sizes ORDER BY price"),
    all("SELECT product_id,topping_id FROM product_toppings"),
    all("SELECT id,name,price,active FROM toppings ORDER BY name"),
    all("SELECT id,name FROM sugar_levels ORDER BY sort_order"),
    all("SELECT id,name FROM ice_levels ORDER BY sort_order"),
  ]);
  const sizesByProduct = {};
  for (const s of allSizes) (sizesByProduct[s.product_id] ||= []).push({ id: s.id, name: s.name, price: s.price });
  const toppingIdsByProduct = {};
  for (const t of allProdToppings) (toppingIdsByProduct[t.product_id] ||= []).push(t.topping_id);

  const products = rawProducts.map((p) => ({
    id: p.id, categoryId: p.category_id, name: p.name, description: p.description,
    image: p.image, status: p.status,
    sizes: sizesByProduct[p.id] || [], toppingIds: toppingIdsByProduct[p.id] || [],
  }));
  return { categories, products, toppings, sugarLevels, iceLevels };
}
app.get("/api/menu", h(async (req, res) => res.json(await fullMenu())));

/* ================= ORDERS ================= */
app.post("/api/orders", h(async (req, res) => {
  const { customerName, phone, receiveType, tableOrAddress, note, items } = req.body || {};
  if (!customerName || !String(customerName).trim()) return res.status(400).json({ error: "Vui lòng nhập tên khách hàng." });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Giỏ hàng đang trống." });

  const orderItems = [];
  let total = 0;
  for (const it of items) {
    const product = await get("SELECT * FROM products WHERE id=?", [it.productId]);
    if (!product || product.status !== "active") return res.status(400).json({ error: `Món "${it.productId}" hiện không có sẵn.` });
    const size = await get("SELECT id, size_name as name, price FROM product_sizes WHERE id=? AND product_id=?", [it.sizeId, it.productId]);
    if (!size) return res.status(400).json({ error: `Size không hợp lệ cho món "${product.name}".` });
    const allowedRows = await all("SELECT topping_id FROM product_toppings WHERE product_id=?", [it.productId]);
    const allowedToppingIds = allowedRows.map((r) => r.topping_id);
    const chosenToppingIds = Array.isArray(it.toppingIds) ? it.toppingIds.filter((id) => allowedToppingIds.includes(id)) : [];
    const toppings = [];
    for (const tid of chosenToppingIds) {
      const t = await get("SELECT * FROM toppings WHERE id=? AND active=true", [tid]);
      if (t) toppings.push(t);
    }
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
  for (const oi of orderItems) {
    await run(
      "INSERT INTO order_items(id,order_id,product_name,size_name,size_price,sugar,ice,quantity,note,subtotal) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [oi.id, orderId, oi.productName, oi.sizeName, oi.sizePrice, oi.sugar, oi.ice, oi.quantity, oi.note, oi.subtotal]
    );
    for (const t of oi.toppings) {
      await run("INSERT INTO order_item_toppings(order_item_id,topping_name,topping_price) VALUES (?,?,?)", [oi.id, t.name, t.price]);
    }
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

/* ================= ADMIN: MÓN ================= */
app.post("/api/admin/products", requireRole("admin", "moderator"), h(async (req, res) => {
  const p = req.body || {};
  if (!p.name || !String(p.name).trim()) return res.status(400).json({ error: "Vui lòng nhập tên món." });
  if (!Array.isArray(p.sizes) || !p.sizes.length) return res.status(400).json({ error: "Phải có ít nhất 1 size." });
  const id = uid("sp_");
  const maxRow = await get("SELECT COALESCE(MAX(sort_order),-1) m FROM products");
  await run("INSERT INTO products(id,category_id,name,description,image,status,sort_order) VALUES (?,?,?,?,?,?,?)", [
    id, p.categoryId, String(p.name).trim(), p.description || "", p.image || "", p.status || "active", maxRow.m + 1,
  ]);
  for (const s of p.sizes) await run("INSERT INTO product_sizes(id,product_id,size_name,price) VALUES (?,?,?,?)", [uid("sz_"), id, s.name, Number(s.price) || 0]);
  for (const tid of p.toppingIds || []) await run("INSERT INTO product_toppings(product_id,topping_id) VALUES (?,?)", [id, tid]);
  res.status(201).json({ id });
}));

app.put("/api/admin/products/:id", requireRole("admin", "moderator"), h(async (req, res) => {
  const p = req.body || {};
  const existing = await get("SELECT 1 FROM products WHERE id=?", [req.params.id]);
  if (!existing) return res.status(404).json({ error: "Không tìm thấy món." });
  if (!p.name || !String(p.name).trim()) return res.status(400).json({ error: "Vui lòng nhập tên món." });
  if (!Array.isArray(p.sizes) || !p.sizes.length) return res.status(400).json({ error: "Phải có ít nhất 1 size." });
  await run("UPDATE products SET category_id=?,name=?,description=?,image=?,status=? WHERE id=?", [
    p.categoryId, String(p.name).trim(), p.description || "", p.image || "", p.status || "active", req.params.id,
  ]);
  await run("DELETE FROM product_sizes WHERE product_id=?", [req.params.id]);
  for (const s of p.sizes) {
    await run("INSERT INTO product_sizes(id,product_id,size_name,price) VALUES (?,?,?,?)", [
      s.id && String(s.id).length < 40 ? s.id : uid("sz_"), req.params.id, s.name, Number(s.price) || 0,
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
