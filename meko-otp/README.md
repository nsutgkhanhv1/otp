# OTP IMAP API

API local nay doc OTP truc tiep tu mot inbox IMAP "mail goc", khong dung Cloudflare Worker nua.
Moi lan bat dau lay ma se tao mot `sessionId` rieng tren server de tranh phat cung 1 OTP cho nhieu client dang cho song song.

## Cau hinh

Tao file `.env` tu `.env.example` va dien thong tin inbox nguon:

```txt
OTP_SOURCE_HOST=imap.gmail.com
OTP_SOURCE_SECURE=true
OTP_SOURCE_USER=your-source-mail@gmail.com
OTP_SOURCE_PASS=your-app-password
OTP_SOURCE_MAILBOX=INBOX
OTP_LOOKBACK_MINUTES=15
OTP_FETCH_LIMIT=10
OTP_SINCE_GRACE_SECONDS=90
OTP_IMAP_CONNECTION_TIMEOUT_SECONDS=10
OTP_IMAP_GREETING_TIMEOUT_SECONDS=10
OTP_IMAP_SOCKET_TIMEOUT_SECONDS=300
OTP_IMAP_KEEPALIVE_SECONDS=60
OTP_REQUEST_TIMEOUT_SECONDS=25
PORT=8787
```

Ghi chu:

- Neu dung Gmail, thuong can App Password thay vi mat khau dang nhap thong thuong.
- API chi claim OTP khi mail cho thay ro nguoi nhan trung voi email da nhap tren UI.
- Backend uu tien cac recipient signal nhu `To`, `Delivered-To`, `X-Original-To`, `Envelope-To`, `Original-Recipient`, `X-Forwarded-To`.
- Neu mail khong co recipient signal ro rang thi backend se bo qua mail do, khong fallback mu de tranh phat nham OTP cho session khac.
- `OTP_SINCE_GRACE_SECONDS` them khoang dem de van bat duoc mail den sat thoi diem bam "Bat dau lay ma".
- Cac bien `OTP_IMAP_*_TIMEOUT_SECONDS` gioi han thoi gian cho IMAP. `OTP_IMAP_SOCKET_TIMEOUT_SECONDS` nen lon hon `OTP_REQUEST_TIMEOUT_SECONDS` de backend giu ket noi IMAP nong giua cac lan poll.
- `OTP_IMAP_KEEPALIVE_SECONDS` gui lenh IMAP `NOOP` dinh ky de giu ket noi nong va phat hien socket chet som.
- `OTP_REQUEST_TIMEOUT_SECONDS` gioi han thoi gian HTTP `/otp` cho mot lan poll. Neu IMAP van cham, request se tra JSON som va lan poll tiep theo se doc trang thai session hien tai.

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

1. Tao session moi:

```txt
POST /session
Content-Type: application/json

{
  "email": "test@example.com"
}
```

2. Poll OTP theo session:

```txt
GET /otp?sessionId=<session-id>
```

3. Huy session khi reset UI:

```txt
POST /clear
Content-Type: application/json

{
  "sessionId": "<session-id>"
}
```
