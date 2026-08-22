const crypto = require("crypto");
const { get, run, uid, hashPassword } = require("./db");

const SESSION_COOKIE = "hh_session";
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 ngày

function verifyPassword(plain, salt, expectedHash) {
  const { hash } = hashPassword(plain, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createSession(username, role) {
  const token = crypto.randomBytes(32).toString("hex");
  await run("INSERT INTO sessions(token,username,role,created_at) VALUES (?,?,?,now())", [token, username, role]);
  return token;
}
async function destroySession(token) {
  if (token) await run("DELETE FROM sessions WHERE token=?", [token]);
}
async function getSessionUser(token) {
  if (!token) return null;
  const row = await get("SELECT * FROM sessions WHERE token=?", [token]);
  if (!row) return null;
  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > SESSION_MAX_AGE_MS) {
    await destroySession(token);
    return null;
  }
  const user = await get("SELECT id,username,role,active FROM users WHERE username=?", [row.username]);
  if (!user || !user.active) return null;
  return user;
}

/** Express middleware: gắn req.user nếu cookie session hợp lệ. */
async function attachUser(req, res, next) {
  try {
    req.user = await getSessionUser(req.cookies[SESSION_COOKIE]);
  } catch (e) {
    req.user = null;
  }
  next();
}

/** Middleware factory: trả 401/403 nếu req.user không có role phù hợp. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Chưa đăng nhập." });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Không có quyền thực hiện thao tác này." });
    }
    next();
  };
}

module.exports = {
  SESSION_COOKIE,
  verifyPassword,
  createSession,
  destroySession,
  getSessionUser,
  attachUser,
  requireRole,
};
