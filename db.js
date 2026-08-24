const { Pool } = require("pg");
const crypto = require("crypto");

if (!process.env.DATABASE_URL) {
  console.warn(
    "[hh-server] Chưa có biến môi trường DATABASE_URL. Đặt DATABASE_URL trỏ tới database PostgreSQL (ví dụ từ Neon/Supabase) trước khi chạy."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

/** Chuyển các dấu `?` tuần tự thành $1,$2,... để giữ cách gọi quen thuộc kiểu sqlite. */
async function query(text, params = []) {
  let i = 0;
  const converted = text.replace(/\?/g, () => `$${++i}`);
  return pool.query(converted, params);
}
async function get(text, params = []) {
  const res = await query(text, params);
  return res.rows[0] || null;
}
async function all(text, params = []) {
  const res = await query(text, params);
  return res.rows;
}
async function run(text, params = []) {
  const res = await query(text, params);
  return { changes: res.rowCount };
}

function uid(prefix = "") {
  return prefix + crypto.randomBytes(6).toString("hex");
}
function hashPassword(plain, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(plain, salt, 64).toString("hex");
  return { hash, salt };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  image TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sizes(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS product_sizes(
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_name TEXT NOT NULL,
  price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS toppings(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS product_toppings(
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  topping_id TEXT NOT NULL REFERENCES toppings(id) ON DELETE CASCADE,
  PRIMARY KEY(product_id, topping_id)
);
CREATE TABLE IF NOT EXISTS sugar_levels(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ice_levels(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  receive_type TEXT NOT NULL,
  table_or_address TEXT DEFAULT '',
  note TEXT DEFAULT '',
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Mới',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS order_items(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  size_name TEXT,
  size_price INTEGER NOT NULL DEFAULT 0,
  sugar TEXT,
  ice TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',
  subtotal INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS order_item_toppings(
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  topping_name TEXT NOT NULL,
  topping_price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Sổ quỹ thu/chi: mọi khoản thu (ngoài đơn hàng) và chi phí vận hành quán.
CREATE TABLE IF NOT EXISTS cashbook(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- 'thu' | 'chi'
  category TEXT NOT NULL DEFAULT 'Khác',
  amount INTEGER NOT NULL,
  note TEXT DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
-- Công nợ: phải thu (khách hàng nợ quán) hoặc phải trả (quán nợ nhà cung cấp).
CREATE TABLE IF NOT EXISTS debts(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- 'receivable' (phải thu) | 'payable' (phải trả)
  partner_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS debt_payments(
  id TEXT PRIMARY KEY,
  debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  note TEXT DEFAULT '',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
-- Chấm công nhân viên theo ngày.
CREATE TABLE IF NOT EXISTS attendance(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  check_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  hours NUMERIC(6,2) NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_by TEXT,
  UNIQUE(user_id, work_date)
);
-- Cấu hình vị trí quán (dùng để chặn nhân viên chấm công từ xa). Chỉ 1 dòng duy nhất, id cố định 'default'.
CREATE TABLE IF NOT EXISTS attendance_settings(
  id TEXT PRIMARY KEY DEFAULT 'default',
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  radius_meters INTEGER NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
`;

/** Menu thật của Café Hồng Hoa (theo bảng giá quán cung cấp). Mỗi món 1 mức giá chuẩn (không chia size Nhỏ/Vừa/Lớn). */
const REAL_MENU = {
  categories: [
    ["cat_cafe", "Cà phê"],
    ["cat_latte", "Latte"],
    ["cat_suadua", "Sữa dừa"],
    ["cat_tra", "Trà các loại"],
    ["cat_trasua", "Trà sữa"],
  ],
  toppings: [
    ["tp_thachsuongsao", "Thạch sương sáo", 5000],
    ["tp_thachraucaudua", "Thạch rau câu dừa", 5000],
    ["tp_thachdao", "Thạch đào", 5000],
    ["tp_tranchaudentop", "Trân châu đen", 5000],
    ["tp_tranchautrang", "Trân châu trắng", 5000],
    ["tp_tranchauhoangkim", "Trân châu hoàng kim", 5000],
    ["tp_daomieng", "Đào miếng", 6000],
    ["tp_phomaituoi", "Phô mai tươi", 6000],
    ["tp_sotkhoaimon", "Sốt khoai môn", 6000],
    ["tp_sotkemcheese", "Sốt kem cheese", 6000],
    ["tp_sotkemdeobuonme", "Sốt kem dẻo Buôn Mê", 6000],
    ["tp_sotkemphomaiman", "Sốt kem phô mai mặn", 6000],
  ],
  // topping mặc định cho phần lớn món pha chế (trân châu / thạch / đào / phô mai)
  toppingSetChung: ["tp_thachsuongsao", "tp_thachraucaudua", "tp_thachdao", "tp_tranchaudentop", "tp_tranchautrang", "tp_tranchauhoangkim", "tp_daomieng", "tp_phomaituoi"],
  toppingSetSot: ["tp_sotkhoaimon", "tp_sotkemcheese", "tp_sotkemdeobuonme", "tp_sotkemphomaiman"],
  products: [
    // CAFE
    { id: "sp_caphephamay", cat: "cat_cafe", name: "Cà phê pha máy", price: 15000, tops: "chung" },
    { id: "sp_caphephin", cat: "cat_cafe", name: "Cà phê phin", price: 13000, tops: "chung" },
    { id: "sp_caphesua", cat: "cat_cafe", name: "Cà phê sữa", price: 18000, tops: "chung" },
    { id: "sp_caphemuoi", cat: "cat_cafe", name: "Cà phê muối", price: 20000, tops: "chung" },
    { id: "sp_bacxiu", cat: "cat_cafe", name: "Bạc xỉu", price: 20000, tops: "chung" },
    { id: "sp_bacxiumuoi", cat: "cat_cafe", name: "Bạc xỉu muối", price: 28000, tops: "chung" },
    { id: "sp_phindihanhnhan", cat: "cat_cafe", name: "Phindi hạnh nhân", price: 25000, tops: "chung" },
    { id: "sp_caphekemdeobuonme", cat: "cat_cafe", name: "Cà phê kem dẻo Buôn Mê", price: 28000, tops: "chung+sot" },
    // LATTE
    { id: "sp_matchalatte", cat: "cat_latte", name: "Matcha latte", price: 25000, tops: "chung+sot" },
    { id: "sp_matchalattexoai", cat: "cat_latte", name: "Matcha latte xoài", price: 28000, tops: "chung+sot" },
    { id: "sp_cacaolatte", cat: "cat_latte", name: "Cacao latte", price: 25000, tops: "chung+sot" },
    { id: "sp_khoaimonlatte", cat: "cat_latte", name: "Khoai môn latte", price: 25000, tops: "chung+sot" },
    // SỮA DỪA
    { id: "sp_suaduanguyenvi", cat: "cat_suadua", name: "Sữa dừa nguyên vị", price: 17000, tops: "chung" },
    { id: "sp_suaduasuongsao", cat: "cat_suadua", name: "Sữa dừa sương sáo", price: 20000, tops: "chung" },
    { id: "sp_suaduakhoaimon", cat: "cat_suadua", name: "Sữa dừa khoai môn", price: 20000, tops: "chung" },
    { id: "sp_suaduamatcha", cat: "cat_suadua", name: "Sữa dừa matcha", price: 25000, tops: "chung" },
    { id: "sp_suaduasuongsaocafe", cat: "cat_suadua", name: "Sữa dừa sương sáo cafe", price: 25000, tops: "chung" },
    // TRÀ CÁC LOẠI
    { id: "sp_hongtra", cat: "cat_tra", name: "Hồng trà", price: 10000, tops: "chung" },
    { id: "sp_hongtraquyt", cat: "cat_tra", name: "Hồng trà quýt", price: 25000, tops: "chung" },
    { id: "sp_tradao", cat: "cat_tra", name: "Trà đào", price: 20000, tops: "chung" },
    { id: "sp_tranhaensenlanep", cat: "cat_tra", name: "Trà nhãn sen lá nếp", price: 20000, tops: "chung" },
    { id: "sp_traxanhdaudo", cat: "cat_tra", name: "Trà xanh đậu đỏ", price: 25000, tops: "chung" },
    { id: "sp_trasenvang", cat: "cat_tra", name: "Trà sen vàng", price: 20000, tops: "chung" },
    { id: "sp_trachanhvannam", cat: "cat_tra", name: "Trà chanh Vân Nam", price: 20000, tops: "chung" },
    { id: "sp_travaila", cat: "cat_tra", name: "Trà vải lài", price: 20000, tops: "chung" },
    // TRÀ SỮA
    { id: "sp_hongtrasua", cat: "cat_trasua", name: "Hồng trà sữa", price: 15000, tops: "chung" },
    { id: "sp_olongnhaisua", cat: "cat_trasua", name: "Olong nhài sữa", price: 25000, tops: "chung" },
    { id: "sp_trasuakhoaimondeo", cat: "cat_trasua", name: "Trà sữa khoai môn dẻo", price: 25000, tops: "chung" },
    { id: "sp_trasuaphomaimankemcheese", cat: "cat_trasua", name: "Trà sữa phô mai mặn & kem cheese", price: 25000, tops: "chung" },
    { id: "sp_trasuahanhnhanphomai", cat: "cat_trasua", name: "Trà sữa hạnh nhân phô mai", price: 27000, tops: "chung" },
    { id: "sp_luctrasuaxoaihoangkim", cat: "cat_trasua", name: "Lục trà sữa xoài hoàng kim", price: 25000, tops: "chung" },
    { id: "sp_suatuoitranchaukhoaimondeo", cat: "cat_trasua", name: "Sữa tươi trân châu khoai môn dẻo", price: 25000, tops: "chung" },
    { id: "sp_suatuoitranchaduongden", cat: "cat_trasua", name: "Sữa tươi trân châu đường đen", price: 20000, tops: "chung" },
  ],
  sugarLevels: ["Không đường", "Ít đường", "Ngọt vừa"],
  iceLevels: ["Đá riêng", "Không đá", "Ít đá", "Đá bình thường"],
};

async function initDb() {
  await pool.query(SCHEMA);
  // Nâng cấp cho database đã tồn tại từ trước khi có bảng "sizes": thêm cột tham chiếu.
  await pool.query("ALTER TABLE product_sizes ADD COLUMN IF NOT EXISTS size_id TEXT REFERENCES sizes(id)");

  const { rows: userCountRows } = await pool.query("SELECT COUNT(*)::int c FROM users");
  if (!userCountRows[0].c) {
    const { hash, salt } = hashPassword("HongHoa@2026");
    await run("INSERT INTO users(id,username,password_hash,salt,role,active) VALUES (?,?,?,?,?,true)", [
      uid("us_"), "admin", hash, salt, "admin",
    ]);
    console.log('Seeded default admin user -> username: "admin"  password: "HongHoa@2026"');
  }

  const { rows: catCountRows } = await pool.query("SELECT COUNT(*)::int c FROM categories");
  if (!catCountRows[0].c) {
    for (let i = 0; i < REAL_MENU.categories.length; i++) {
      const [id, name] = REAL_MENU.categories[i];
      await run("INSERT INTO categories(id,name,sort_order) VALUES (?,?,?)", [id, name, i]);
    }
    for (const [id, name, price] of REAL_MENU.toppings) {
      await run("INSERT INTO toppings(id,name,price,active) VALUES (?,?,?,true)", [id, name, price]);
    }
    const defaultSizeId = uid("szc_");
    await run("INSERT INTO sizes(id,name,sort_order) VALUES (?,?,0)", [defaultSizeId, "Size chuẩn"]);
    for (let i = 0; i < REAL_MENU.products.length; i++) {
      const p = REAL_MENU.products[i];
      await run("INSERT INTO products(id,category_id,name,description,status,sort_order) VALUES (?,?,?,?,'active',?)", [
        p.id, p.cat, p.name, "", i,
      ]);
      await run("INSERT INTO product_sizes(id,product_id,size_id,size_name,price) VALUES (?,?,?,?,?)", [
        uid("sz_"), p.id, defaultSizeId, "Size chuẩn", p.price,
      ]);
      let tops = [];
      if (p.tops === "chung") tops = REAL_MENU.toppingSetChung;
      else if (p.tops === "chung+sot") tops = [...REAL_MENU.toppingSetChung, ...REAL_MENU.toppingSetSot];
      for (const tid of tops) await run("INSERT INTO product_toppings(product_id,topping_id) VALUES (?,?)", [p.id, tid]);
    }
    for (let i = 0; i < REAL_MENU.sugarLevels.length; i++) {
      await run("INSERT INTO sugar_levels(id,name,sort_order) VALUES (?,?,?)", [uid("sg_"), REAL_MENU.sugarLevels[i], i]);
    }
    for (let i = 0; i < REAL_MENU.iceLevels.length; i++) {
      await run("INSERT INTO ice_levels(id,name,sort_order) VALUES (?,?,?)", [uid("ic_"), REAL_MENU.iceLevels[i], i]);
    }
    console.log("Seeded Café Hồng Hoa menu thật (categories, products, toppings, sugar/ice levels).");
  }

  // Di chuyển dữ liệu size cũ (nâng cấp từ bản trước khi có danh mục "sizes"): mỗi size_name
  // của product_sizes chưa gắn size_id sẽ được tự động gắn vào (hoặc tạo mới) 1 mục trong danh mục size,
  // giữ nguyên tên size đang dùng để không ảnh hưởng dữ liệu/đơn hàng hiện có.
  const orphanRows = await all("SELECT DISTINCT size_name FROM product_sizes WHERE size_id IS NULL");
  for (const row of orphanRows) {
    let cat = await get("SELECT id FROM sizes WHERE name=?", [row.size_name]);
    if (!cat) {
      const maxRow = await get("SELECT COALESCE(MAX(sort_order),-1) m FROM sizes");
      cat = { id: uid("szc_") };
      await run("INSERT INTO sizes(id,name,sort_order) VALUES (?,?,?)", [cat.id, row.size_name, maxRow.m + 1]);
    }
    await run("UPDATE product_sizes SET size_id=? WHERE size_id IS NULL AND size_name=?", [cat.id, row.size_name]);
  }
  const sizeCountRow = await get("SELECT COUNT(*)::int c FROM sizes");
  if (!sizeCountRow.c) {
    await run("INSERT INTO sizes(id,name,sort_order) VALUES (?,?,0)", [uid("szc_"), "Vừa"]);
  }

  // Toạ độ mặc định tra theo địa chỉ quán — CHỦ QUÁN NÊN vào tab "Mã QR chấm công" và bấm
  // "Lấy vị trí hiện tại" khi đang đứng thật trong quán để lấy toạ độ chính xác hơn.
  const settingsRow = await get("SELECT id FROM attendance_settings WHERE id='default'");
  if (!settingsRow) {
    await run("INSERT INTO attendance_settings(id,latitude,longitude,radius_meters,updated_at) VALUES ('default',?,?,?,now())", [
      10.1857238, 106.6941122, 100,
    ]);
  }
}

module.exports = { pool, query, get, all, run, uid, hashPassword, initDb };
