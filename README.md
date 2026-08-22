# Café Hồng Hoa — Bản public thật (Node.js + PostgreSQL)

Bản này dùng **PostgreSQL** thay vì SQLite, để có thể public thật lên internet miễn phí bằng **Neon** (database) + **Render** (chạy server) — hai dịch vụ đều có gói miễn phí vĩnh viễn cho quy mô một quán nhỏ.

Đã cập nhật menu và logo thật của quán (33 món, 5 danh mục, 12 topping, theo đúng bảng giá bạn gửi).

## 1. Chạy thử trên máy tính của bạn

Cần có Node.js 18+ và một database PostgreSQL (có thể cài local, hoặc tạo miễn phí trên Neon luôn — xem bước 2).

```bash
cd hh-server
npm install
DATABASE_URL="postgresql://user:password@host:5432/dbname" node server.js
```

Mở `http://localhost:3000`.

- Trang quản trị: bấm icon bánh răng ở header.
- Tài khoản: `admin` / Mật khẩu: `HongHoa@2026` — **đổi ngay sau khi đăng nhập lần đầu** (tab "User").

Lần chạy đầu tiên, server tự tạo bảng và nạp toàn bộ menu thật vào database.

## 2. Tạo database miễn phí trên Neon (5 phút)

1. Vào [neon.tech](https://neon.tech) → đăng ký tài khoản miễn phí.
2. Tạo project mới (chọn region gần Việt Nam, ví dụ Singapore).
3. Vào project → **Connection string** → copy chuỗi dạng:
   `postgresql://<user>:<password>@<host>/<db>?sslmode=require`
4. Giữ lại chuỗi này — sẽ dùng làm biến môi trường `DATABASE_URL` ở bước 3.

Gói miễn phí của Neon đủ dùng cho một quán cà phê nhỏ (dữ liệu menu + đơn hàng rất nhẹ).

## 3. Deploy server lên Render (miễn phí)

1. Đưa code lên GitHub: tạo repo mới, push toàn bộ thư mục `hh-server` lên đó.
2. Vào [render.com](https://render.com) → đăng ký → **New → Web Service** → chọn repo vừa tạo.
3. Cấu hình:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
4. Vào tab **Environment**, thêm biến:
   - `DATABASE_URL` = chuỗi kết nối Neon ở bước 2
   - `NODE_ENV` = `production`
5. Bấm **Deploy**. Sau vài phút, Render cho một địa chỉ dạng `https://hong-hoa.onrender.com` — đây là link công khai, ai cũng vào đặt hàng được, không cần ở cùng wifi quán.

**Lưu ý về gói miễn phí của Render:** service sẽ "ngủ" sau ~15 phút không có ai truy cập, và mất khoảng 30-50 giây để "thức dậy" ở lượt truy cập tiếp theo. Với quán nhỏ mới bắt đầu thì chấp nhận được; khi lượng khách tăng, có thể nâng lên gói trả phí thấp nhất (~7 USD/tháng) để server luôn chạy sẵn (không bị "ngủ").

## 4. Gắn tên miền riêng (tuỳ chọn)

Nếu bạn có tên miền riêng (ví dụ `honghoacoffee.vn`), vào Render → Settings → **Custom Domain** để trỏ tên miền về, thay cho link `onrender.com` mặc định.

## 5. Sao lưu dữ liệu

- Neon tự động sao lưu dữ liệu định kỳ (theo chính sách gói bạn dùng).
- Ngoài ra endpoint `GET /api/admin/export` (khi đã đăng nhập quản trị) trả về toàn bộ menu + đơn hàng dạng JSON để bạn tự tải về backup thêm.

## 6. Cấu trúc dự án

```
hh-server/
  server.js     # API + phục vụ giao diện web
  db.js         # Kết nối PostgreSQL, tạo bảng, nạp menu thật lần đầu
  auth.js       # Đăng nhập, mã hoá mật khẩu (scrypt), session cookie
  public/
    index.html  # Giao diện (khách hàng + quản trị)
    app.js      # Logic frontend, gọi API bằng fetch()
    assets/
      logo-icon.png  # Logo Hồng Hoa (icon vuông, dùng cho header + favicon)
      logo-full.png  # Logo đầy đủ kèm chữ (dùng khi cần, ví dụ in hoá đơn sau này)
```

## 7. Phân quyền tài khoản

- **admin**: toàn quyền, không thể bị xoá.
- **moderator**: toàn quyền trừ xoá tài khoản admin.
- **staff**: chỉ xem/đổi trạng thái đơn hàng.

## 8. Về menu đã nạp sẵn

Menu được nạp đúng theo bảng giá quán cung cấp: 5 danh mục (Cà phê, Latte, Sữa dừa, Trà các loại, Trà sữa), mỗi món 1 mức giá chuẩn (không chia Nhỏ/Vừa/Lớn vì bảng giá gốc chỉ có 1 giá/món). 12 topping (bao gồm cả nhóm "Sốt & kem dẻo") đã được gán:
- Các món pha chế thông thường: được chọn 8 topping/thạch/trân châu cơ bản.
- Riêng **Cà phê kem dẻo Buôn Mê** và nhóm **Latte** (Matcha latte, Matcha latte xoài, Cacao latte, Khoai môn latte): có thêm 4 loại sốt (sốt khoai môn, sốt kem cheese, sốt kem dẻo Buôn Mê, sốt kem phô mai mặn) vì đây là những món hợp lý sẽ dùng sốt.

Đây là cách gán hợp lý theo mình suy đoán từ tên món — bạn có thể vào tab "Món" trong trang quản trị để **bật/tắt topping cho từng món** theo đúng ý quán bất cứ lúc nào, không cần sửa code.
