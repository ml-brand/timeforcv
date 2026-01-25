# Repository Guidelines

## Project Structure & Module Organization
- `scripts/`: Python utilities for Telegram session creation and scheduled fetches.
- `.github/workflows/sync.yml`: GitHub Actions workflow that runs the sync on a schedule.
- `docs/`: GitHub Pages site.
  - `index.html`, `style.css`, `app.js`: client UI and logic.
  - `data/`: generated JSON (`posts.json`, `meta.json`) written by the sync script.
  - `assets/media/`: downloaded media files when enabled.
- `requirements.txt`: Python dependencies for the scripts.

## Build, Test, and Development Commands
- `python -m venv .venv` and `source .venv/bin/activate`: create and activate a local virtualenv.
- `pip install -r requirements.txt`: install script dependencies.
- `python scripts/create_session.py`: generate a `TG_SESSION` string for Telegram auth.
- `python scripts/fetch_telegram.py`: fetch posts into `docs/data` using env vars.
- `python -m http.server --directory docs 8000`: serve the static site locally.

## Coding Style & Naming Conventions
- Python uses 4-space indentation, `snake_case` for functions/vars, and `PascalCase` for classes.
- Prefer small, single-purpose functions and type hints where they improve clarity.
- Avoid manual edits to `docs/data/*.json`; regenerate via the fetch script.
- No formatter or linter is configured; keep diffs minimal and readable.

## Testing Guidelines
- No automated tests are configured.
- Validate changes by running `python scripts/fetch_telegram.py` and loading the site locally.
- If you add tests, place them under `tests/` and document how to run them.

## Commit & Pull Request Guidelines
- Existing history uses simple messages; use short, imperative subjects (e.g., "Add media size limit").
- PRs should include a brief summary, verification steps, and screenshots for UI changes in `docs/`.
- Call out any updates to required env vars or workflow settings.

## Security & Configuration Tips
- Never commit secrets: `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`, `TG_CHANNEL`.
- Store secrets in GitHub Actions or local env vars; review `.github/workflows/sync.yml` before changes.
- Media downloads can grow the repo; consider `DOWNLOAD_MEDIA=false` for large channels.
