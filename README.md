# Telegram → GitHub Pages Mirror (fully automated)

This repository:
- pulls posts from a Telegram channel every hour via GitHub Actions,
- stores them in `docs/data/posts.json` (+ meta in `docs/data/meta.json`),
- optionally downloads media into `docs/assets/media/`,
- renders everything as a static site on GitHub Pages.

## What you get

- Static page `docs/index.html` with search and paginated load-more.
- Auto-sync on a cron schedule (hourly; subject to GitHub timing jitter).
- No separate server required.

---

## 1) One-time setup

### 1.1. Create Telegram API ID / API Hash
Do this at https://my.telegram.org (API Development Tools).

You need:
- `TG_API_ID` (integer)
- `TG_API_HASH` (string)

### 1.2. Create `TG_SESSION` (StringSession)
Locally:

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python scripts/create_session.py
```

The script will ask you to log in to Telegram (phone, code, 2FA if enabled) and print a session string.
Copy it fully — that is your `TG_SESSION`.

Tip: use a dedicated Telegram account if you don’t want to expose your personal one.

---

## 2) Configure the GitHub repo

### 2.1. Push the project to GitHub
Create a repo and push the contents.

### 2.2. Add Secrets
Repository → Settings → Secrets and variables → Actions → **Secrets**:

- `TG_API_ID`
- `TG_API_HASH`
- `TG_SESSION`
- `TG_CHANNEL`

`TG_CHANNEL` is the channel username without `@`, e.g. `mychannel`.
`@mychannel` or `https://t.me/mychannel` also work.

If Actions can’t push commits (permission denied), check:
Settings → Actions → General → **Workflow permissions** → choose **Read and write permissions**.

Important: the account behind `TG_SESSION` must access the channel:
- public channel — being a subscriber is enough,
- private channel — must be a member (with history access).

---

## 3) Enable GitHub Pages

Repository → Settings → Pages:
- Source: **Deploy from a branch**
- Branch: `main`
- Folder: `/docs`

Your site will be available at:
`https://<username>.github.io/<repo>/`

---

## 4) Run the sync

- Manual: Actions → “Sync Telegram channel to GitHub Pages” → Run workflow.
- Automatic: hourly on schedule.

---

## Sync settings (optional)

Key parameters live in `.github/workflows/sync.yml` (env section of **Fetch Telegram posts** step).

- `DOWNLOAD_MEDIA`: `true/false` — download media into the repo.
- `MEDIA_MAX_MB`: max file size to download (default 200 MB).
- `MEDIA_DOWNLOAD_SCOPE`: how many media download attempts per run (default 200).
- `INITIAL_FETCH_LIMIT`:
  - `0` = import full history (can take time on large channels),
  - `2000` = import only the latest 2000 posts (faster).
- `REFRESH_LAST_N`: re-fetch last N messages every run to catch edits (default 500).
- Timestamps are stored in UTC in JSON/feeds and rendered in the browser’s local timezone.

---

## Where data lives

- `docs/data/posts.json` — list of posts (newest first).
- `docs/data/meta.json` — channel info and sync stats.
- `docs/assets/media/` — downloaded files (if enabled).
- `docs/feed.xml` (RSS) and `docs/atom.xml` (Atom) — last 50 posts, generated automatically.
- `docs/sitemap.xml` — sitemap for search engines.
- `docs/assets/channel_avatar.jpg` — channel avatar (if available).

## Schema versioning

- `meta.json` includes `meta_schema_version` and `posts_schema_version` (current `1.0.0`). Update these when changing data shape (e.g., adding tags/lang/embedding ids). See `CHANGELOG.md` for notes.

## RSS/Atom

- After each `scripts/fetch_telegram.py` run, `feed.xml` (RSS 2.0) and `atom.xml` (Atom 1.0) appear in `docs` based on `posts.json`.
- To point feed/sitemap links to your published site, set `FEED_SITE_URL` (or `SITE_URL`) — e.g. `https://username.github.io/repo/`. Otherwise links point to the original Telegram post.

## Sitemap

- `sitemap.xml` is generated with the feeds and includes the home page, feeds, and post links (default cap: 1000 latest posts).

## Robots.txt

- `robots.txt` is generated automatically and allows indexing; it contains links to sitemap and feeds. To point to your domain, set `FEED_SITE_URL`/`SITE_URL`.

---

## Caveats and notes

1) **“Hourly” accuracy**  
GitHub may shift scheduled workflow start times. Usually it’s minutes, but not guaranteed.

2) **Repository size**  
Downloading lots of media (especially video) will grow the repo quickly. For heavy channels consider:
- `DOWNLOAD_MEDIA=false` (text + Telegram link only), or
- raising limits/moving media elsewhere.

3) **Private channels**  
GitHub Pages is public if the repo is public.  
If the data is private, do not publish it in a public repo.

---

## Local run (for testing)

```bash
export TG_API_ID=...
export TG_API_HASH=...
export TG_SESSION=...
export TG_CHANNEL=mychannel

python scripts/fetch_telegram.py
python -m http.server --directory docs 8000
# open http://localhost:8000
# CLI overrides examples:
# python scripts/fetch_telegram.py --dry-run --refresh-last-n 100 --initial-limit 2000 --site-url https://username.github.io/repo/
```

---

## License
CPAL-1.0 — see `LICENSE` for full terms (requires attribution).
