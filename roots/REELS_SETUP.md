# Reels setup (Cloudinary version, card nahi chahiye)

## 1. Files GitHub pe daalo
| Jagah | Files |
|---|---|
| **Root** (bahar) | `server.js` (replace), `reels-api.js`, `reels-store.js`, `cloudinary.js`, `reels-schema.sql` |
| **public** folder | `reels.js`, `reels.css`, `index.html` (replace), `script.js` (replace) |

`r2.js` ab nahi chahiye. Agar pehle upload kar di thi to delete kar do.

## 2. Supabase
SQL Editor > New query > `reels-schema.sql` paste > Run.

## 3. Cloudinary
1. cloudinary.com > Sign up for free (email ya Google se).
2. Login ke baad Dashboard par **Go to API Keys** (ya Settings > API Keys) kholo.
3. Ye 3 cheezein copy karo: **Cloud name**, **API Key**, **API Secret** (Reveal dabao).
4. Settings > Security mein **"Strict transformations"** ko off rakho (default off hota hai).

## 4. Render > Environment
| Key | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | service_role key |
| `CLOUDINARY_CLOUD_NAME` | Cloud name |
| `CLOUDINARY_API_KEY` | API Key |
| `CLOUDINARY_API_SECRET` | API Secret |
| `ADMIN_EMAILS` | tumhara Gmail |

Secrets sirf Render mein, GitHub mein kabhi nahi.

## 5. Reel upload
Site > Reels > like dabao > Gmail se sign in (ADMIN_EMAILS wala) > upar right **+** > video chuno > Upload.
Upload ke baad "taiyar ho rahi hai" ka message aayega (kuch second), phir reel feed mein sabse upar dikhegi.
Video: MP4 (H.264), 15-30 sec. Limit 80 MB / 120 sec.
Cloudinary khud video ko 720p MP4 mein badal deta hai, isliye phone par halka chalega.
