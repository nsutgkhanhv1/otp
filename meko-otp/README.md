# OTP IMAP API

API local nay doc OTP truc tiep tu mot inbox IMAP "mail goc", khong dung Cloudflare Worker nua.

## Cau hinh

Tao file `.env` tu `.env.example` va dien thong tin inbox nguon:

```txt
OTP_SOURCE_HOST=imap.gmail.com
OTP_SOURCE_SECURE=true
OTP_SOURCE_USER=your-source-mail@gmail.com
OTP_SOURCE_PASS=your-app-password
OTP_SOURCE_MAILBOX=INBOX
OTP_LOOKBACK_MINUTES=15
OTP_FETCH_LIMIT=30
OTP_SINCE_GRACE_SECONDS=90
PORT=8787
```

Ghi chu:

- Neu dung Gmail, thuong can App Password thay vi mat khau dang nhap thong thuong.
- API se uu tien tim email co chua dia chi email duoc nhap tren UI.
- Neu khong tim thay email khop, API se fallback sang OTP moi nhat trong inbox nguon.
- `OTP_SINCE_GRACE_SECONDS` them khoang dem de van bat duoc mail den sat thoi diem bam "Bat dau lay ma".

## Chay local

```txt
npm install
npm run dev
```

## Build

```txt
npm run build
npm run start
```

## API

- `GET /otp?email=test@example.com&since=1710000000000`
- `POST /clear`
