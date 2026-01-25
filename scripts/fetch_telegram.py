#!/usr/bin/env python3
"""Fetch Telegram channel posts and store them into docs/data/posts.json.

Designed to be run in GitHub Actions on a schedule.

Environment variables (recommended via GitHub Secrets):
  TG_API_ID        int
  TG_API_HASH      str
  TG_SESSION       Telethon StringSession (output of scripts/create_session.py)
  TG_CHANNEL       Channel username (e.g. "mychannel" or "@mychannel") or numeric ID

Optional:
  DOWNLOAD_MEDIA          "1"/"true" to download photos/videos/docs into docs/assets/media (default: true)
  MEDIA_MAX_MB            Max file size for downloads (default: 200)
  INITIAL_FETCH_LIMIT     If no local posts exist: how many latest messages to import (0 = all, default: 0)
  REFRESH_LAST_N          Re-fetch last N newest messages to capture edits (default: 500)
  FEED_SITE_URL / SITE_URL Base URL for generated feeds/sitemap (e.g. https://user.github.io/repo/)
"""

import asyncio
import json
import os
import re
import argparse
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import Message
from telethon.extensions import html as telethon_html
from telethon.errors import FloodWaitError, RPCError

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA_DIR = DOCS / "data"
ASSETS_DIR = DOCS / "assets" / "media"

POSTS_PATH = DATA_DIR / "posts.json"
META_PATH = DATA_DIR / "meta.json"
RSS_PATH = DOCS / "feed.xml"
ATOM_PATH = DOCS / "atom.xml"
FEED_ITEMS_LIMIT = 50
SITEMAP_PATH = DOCS / "sitemap.xml"
SITEMAP_ITEMS_LIMIT = 1000
ROBOTS_PATH = DOCS / "robots.txt"
AVATAR_PATH = DOCS / "assets" / "channel_avatar.jpg"
LOGGER = logging.getLogger("telegram_mirror")

def setup_logging() -> None:
    level_str = (os.getenv("LOG_LEVEL") or "INFO").upper()
    level = getattr(logging, level_str, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

def env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "y", "on"}

def env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    if v is None or v == "":
        return default
    try:
        return int(v)
    except ValueError:
        return default

def require(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise SystemExit(f"Missing required env var: {name}")
    return v

def normalize_site_url(raw: str) -> str:
    if not raw:
        return ""
    return raw if raw.endswith("/") else raw + "/"

@dataclass
class TelegramConfig:
    api_id: int
    api_hash: str
    session: str
    channel: str

@dataclass
class SyncConfig:
    download_media: bool
    media_max_mb: int
    initial_limit: int
    refresh_last_n: int
    media_download_scope: int
    site_url: str = ""
    max_retries: int = 3
    backoff_seconds: float = 2.0

def load_config() -> Tuple[TelegramConfig, SyncConfig]:
    telegram = TelegramConfig(
        api_id=int(require("TG_API_ID")),
        api_hash=require("TG_API_HASH"),
        session=require("TG_SESSION"),
        channel=clean_channel(require("TG_CHANNEL")),
    )
    site_env = (os.getenv("FEED_SITE_URL") or os.getenv("SITE_URL") or "").strip()
    sync = SyncConfig(
        download_media=env_bool("DOWNLOAD_MEDIA", True),
        media_max_mb=env_int("MEDIA_MAX_MB", 200),
        initial_limit=env_int("INITIAL_FETCH_LIMIT", 0),
        refresh_last_n=env_int("REFRESH_LAST_N", 500),
        media_download_scope=env_int("MEDIA_DOWNLOAD_SCOPE", 200),
        site_url=normalize_site_url(site_env),
        max_retries=env_int("MAX_RETRIES", 3),
        backoff_seconds=float(env_int("BACKOFF_SECONDS", 2)),
    )
    return telegram, sync

def merge_overrides(sync: SyncConfig, args: argparse.Namespace) -> SyncConfig:
    return SyncConfig(
        download_media=sync.download_media if args.download_media is None else args.download_media,
        media_max_mb=sync.media_max_mb if args.media_max_mb is None else args.media_max_mb,
        initial_limit=sync.initial_limit if args.initial_limit is None else args.initial_limit,
        refresh_last_n=sync.refresh_last_n if args.refresh_last_n is None else args.refresh_last_n,
        media_download_scope=sync.media_download_scope,
        site_url=sync.site_url if args.site_url is None else normalize_site_url(args.site_url),
    )
def clean_channel(s: str) -> str:
    s = s.strip()
    if s.startswith("https://t.me/"):
        s = s.replace("https://t.me/", "")
    if s.startswith("@"):
        s = s[1:]
    return s

def safe_filename(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]", "_", s)
    return s[:120] if len(s) > 120 else s

def iso_to_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        # support trailing Z
        v = value.replace("Z", "+00:00") if isinstance(value, str) else value
        return datetime.fromisoformat(v)
    except Exception:
        return None

def fmt_lastmod(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    try:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    except Exception:
        return None

def site_base_url(meta: Dict[str, Any], channel: str, site_url: str = "") -> str:
    if site_url:
        return normalize_site_url(site_url)
    username = meta.get("username") or channel
    return f"https://t.me/{username}/"

def sanitize_feed_html(value: Optional[str]) -> str:
    if not value:
        return ""
    # Strip Telegram-specific tg-emoji tags while keeping inner text/emoji
    return re.sub(r"</?tg-emoji[^>]*>", "", value)

def post_title(post: Dict[str, Any]) -> str:
    text = (post.get("text") or "").strip()
    if text:
        line = text.splitlines()[0].strip()
        return line[:120] if len(line) > 120 else line
    return f"Post #{post.get('id')}"

def post_link(post: Dict[str, Any], base_url: str) -> str:
    if post.get("link"):
        return str(post["link"])
    return urljoin(base_url, f"post.html?id={post.get('id')}")

def feed_items(posts_by_id: Dict[int, Dict[str, Any]]) -> List[Dict[str, Any]]:
    posts = list(posts_by_id.values())
    posts.sort(key=lambda p: iso_to_dt(p.get("date")) or datetime.fromtimestamp(0, tz=timezone.utc), reverse=True)
    return posts[:FEED_ITEMS_LIMIT]

def write_rss(meta: Dict[str, Any], posts_by_id: Dict[int, Dict[str, Any]], channel: str, site_url: str = "") -> None:
    base_url = site_base_url(meta, channel, site_url)
    items = feed_items(posts_by_id)
    if not items:
        return

    from xml.etree import ElementTree as ET
    ET.register_namespace("atom", "http://www.w3.org/2005/Atom")

    rss = ET.Element("rss", version="2.0")
    channel_el = ET.SubElement(rss, "channel")
    ET.SubElement(channel_el, "title").text = meta.get("title") or f"Telegram — {channel}"
    ET.SubElement(channel_el, "link").text = base_url
    ET.SubElement(channel_el, "description").text = f"Зеркало Telegram-канала {channel}"
    ET.SubElement(channel_el, "{http://www.w3.org/2005/Atom}link", attrib={
        "href": urljoin(base_url, "feed.xml"),
        "rel": "self",
        "type": "application/rss+xml",
    })
    if meta.get("last_sync_utc"):
        dt = iso_to_dt(meta["last_sync_utc"])
        if dt:
            ET.SubElement(channel_el, "lastBuildDate").text = format_datetime(dt)

    for p in items:
        item = ET.SubElement(channel_el, "item")
        ET.SubElement(item, "title").text = post_title(p)
        link = post_link(p, base_url)
        ET.SubElement(item, "link").text = link
        ET.SubElement(item, "guid").text = link
        pub_dt = iso_to_dt(p.get("date")) or datetime.now(timezone.utc)
        ET.SubElement(item, "pubDate").text = format_datetime(pub_dt)
        desc = sanitize_feed_html(p.get("html") or p.get("text") or "")
        ET.SubElement(item, "description").text = desc

    RSS_PATH.write_bytes(ET.tostring(rss, encoding="utf-8", xml_declaration=True))

def write_atom(meta: Dict[str, Any], posts_by_id: Dict[int, Dict[str, Any]], channel: str, site_url: str = "") -> None:
    base_url = site_base_url(meta, channel, site_url)
    items = feed_items(posts_by_id)
    if not items:
        return

    from xml.etree import ElementTree as ET

    feed = ET.Element("feed", xmlns="http://www.w3.org/2005/Atom")
    ET.SubElement(feed, "title").text = meta.get("title") or f"Telegram — {channel}"
    ET.SubElement(feed, "link", href=base_url, rel="alternate")
    ET.SubElement(feed, "link", href=urljoin(base_url, "atom.xml"), rel="self", type="application/atom+xml")
    ET.SubElement(feed, "id").text = base_url
    updated_dt = iso_to_dt(meta.get("last_sync_utc")) or iso_to_dt(items[0].get("date")) or datetime.now(timezone.utc)
    ET.SubElement(feed, "updated").text = updated_dt.isoformat()

    for p in items:
        entry = ET.SubElement(feed, "entry")
        ET.SubElement(entry, "title").text = post_title(p)
        link = post_link(p, base_url)
        ET.SubElement(entry, "link", href=link)
        ET.SubElement(entry, "id").text = link
        author = ET.SubElement(entry, "author")
        ET.SubElement(author, "name").text = meta.get("title") or channel or "Telegram channel"
        published = iso_to_dt(p.get("date"))
        if published:
            ET.SubElement(entry, "updated").text = published.isoformat()
            ET.SubElement(entry, "published").text = published.isoformat()
        content = sanitize_feed_html(p.get("html") or p.get("text") or "")
        c_el = ET.SubElement(entry, "content", type="html")
        c_el.text = content

    ATOM_PATH.write_bytes(feed_to_bytes(feed))

def feed_to_bytes(element: Any) -> bytes:
    from xml.etree import ElementTree as ET
    return ET.tostring(element, encoding="utf-8", xml_declaration=True)

def write_feeds(meta: Dict[str, Any], posts_by_id: Dict[int, Dict[str, Any]], channel: str, site_url: str = "") -> None:
    try:
        write_rss(meta, posts_by_id, channel, site_url)
        write_atom(meta, posts_by_id, channel, site_url)
    except Exception as e:
        LOGGER.warning("Failed to generate feeds: %s", e)

def write_sitemap(meta: Dict[str, Any], posts_by_id: Dict[int, Dict[str, Any]], channel: str, site_url: str = "") -> None:
    base_url = site_base_url(meta, channel, site_url)
    items = list(posts_by_id.values())
    items.sort(key=lambda p: iso_to_dt(p.get("date")) or datetime.fromtimestamp(0, tz=timezone.utc), reverse=True)
    if SITEMAP_ITEMS_LIMIT and len(items) > SITEMAP_ITEMS_LIMIT:
        items = items[:SITEMAP_ITEMS_LIMIT]

    from xml.etree import ElementTree as ET

    urlset = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")

    def add_url(loc: str, lastmod_value: Optional[str]) -> None:
        if not loc:
            return
        url_el = ET.SubElement(urlset, "url")
        ET.SubElement(url_el, "loc").text = loc
        if lastmod_value:
            ET.SubElement(url_el, "lastmod").text = lastmod_value

    last_sync_dt = iso_to_dt(meta.get("last_sync_utc"))
    last_sync = fmt_lastmod(last_sync_dt)
    add_url(base_url, last_sync)
    add_url(urljoin(base_url, "feed.xml"), last_sync)
    add_url(urljoin(base_url, "atom.xml"), last_sync)

    for p in items:
        loc = urljoin(base_url, f"post.html?id={p.get('id')}")
        lm = fmt_lastmod(iso_to_dt(p.get("edited") or p.get("date")))
        add_url(loc, lm)

    SITEMAP_PATH.write_bytes(ET.tostring(urlset, encoding="utf-8", xml_declaration=True))

def write_robots(meta: Dict[str, Any], channel: str, site_url: str = "") -> None:
    base_url = site_base_url(meta, channel, site_url)
    lines = [
        "# Robots file is auto-generated; set FEED_SITE_URL to your deployed site for correct absolute links.",
        "User-agent: *",
        "Allow: /",
        "",
        f"Sitemap: {urljoin(base_url, 'sitemap.xml')}",
        f"Sitemap: {urljoin(base_url, 'feed.xml')}",
        f"Sitemap: {urljoin(base_url, 'atom.xml')}",
        "",
    ]
    ROBOTS_PATH.write_text("\n".join(lines), encoding="utf-8")

async def download_avatar(client: TelegramClient, entity: Any) -> Optional[str]:
    AVATAR_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        path = await with_retries(
            lambda: client.download_profile_photo(entity, file=str(AVATAR_PATH)),
            retries=2,
            backoff=1.5,
        )
        if path:
            return AVATAR_PATH.relative_to(DOCS).as_posix()
    except Exception as e:
        LOGGER.warning("Could not download avatar: %s", e)
    return None

async def with_retries(coro_factory, *, retries: int, backoff: float):
    attempt = 0
    delay = backoff
    while True:
        try:
            return await coro_factory()
        except FloodWaitError as fw:
            wait = int(getattr(fw, "seconds", 0)) or int(getattr(fw, "x", 0)) or 0
            wait = max(wait, 1)
            LOGGER.warning("FloodWaitError: sleeping %s seconds", wait)
            await asyncio.sleep(wait)
        except (RPCError, asyncio.TimeoutError, OSError) as e:
            attempt += 1
            if attempt > retries:
                raise
            LOGGER.warning("Retrying after error (%s/%s): %s", attempt, retries, e)
            await asyncio.sleep(delay)
            delay *= 2

@dataclass
class MediaItem:
    kind: str  # photo|video|audio|document
    path: str  # relative to docs/
    size: Optional[int] = None
    mime: Optional[str] = None
    name: Optional[str] = None

@dataclass
class ReactionInfo:
    total: int
    details: Optional[List[Dict[str, Any]]] = None

@dataclass
class Post:
    id: int
    date: str
    edited: Optional[str]
    text: str
    html: str
    link: Optional[str]
    type: str
    views: Optional[int]
    forwards: Optional[int]
    grouped_id: Optional[int]
    media: List[MediaItem]
    reactions: Optional[ReactionInfo]

def load_posts() -> Dict[int, Dict[str, Any]]:
    if not POSTS_PATH.exists():
        return {}
    try:
        data = json.loads(POSTS_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return {}
        return {int(p.get("id")): p for p in data if isinstance(p, dict) and "id" in p}
    except Exception:
        return {}

def write_posts(posts_by_id: Dict[int, Dict[str, Any]]) -> None:
    # newest first
    posts = sorted(posts_by_id.values(), key=lambda p: int(p.get("id", 0)), reverse=True)
    POSTS_PATH.write_text(json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def write_meta(meta: Dict[str, Any]) -> None:
    meta.setdefault("meta_schema_version", "1.0.0")
    meta.setdefault("posts_schema_version", "1.0.0")
    META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def message_type(m: Message) -> str:
    if getattr(m, "poll", None):
        return "poll"
    if getattr(m, "photo", None):
        return "photo"
    if getattr(m, "video", None):
        return "video"
    if getattr(m, "audio", None):
        return "audio"
    if getattr(m, "document", None):
        # Could still be a sticker, gif, etc.
        mime = getattr(getattr(m, "file", None), "mime_type", None) or ""
        if "image/" in mime:
            return "image"
        if "video/" in mime:
            return "video"
        if "audio/" in mime:
            return "audio"
        if "application/x-tgsticker" in mime:
            return "sticker"
        return "document"
    if m.message:
        return "text"
    return "other"

def reactions_info(m: Message) -> Optional[ReactionInfo]:
    r = getattr(m, "reactions", None)
    if not r:
        return None
    # Telethon gives reactions.results with count + reaction emoji/custom
    total = 0
    details: List[Dict[str, Any]] = []
    try:
        for it in getattr(r, "results", []) or []:
            cnt = int(getattr(it, "count", 0) or 0)
            total += cnt
            reaction = getattr(it, "reaction", None)
            emoji = getattr(reaction, "emoticon", None)
            details.append({"count": cnt, "emoji": emoji})
    except Exception:
        return None
    return ReactionInfo(total=total, details=details)

async def maybe_download_media(client: TelegramClient, m: Message, max_bytes: int) -> List[MediaItem]:
    if not m.media:
        return []

    file = getattr(m, "file", None)
    if not file:
        return []

    size = getattr(file, "size", None)
    if size is not None and size > max_bytes:
        return []

    kind = message_type(m)
    # ensure folder exists
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    ext = getattr(file, "ext", None) or ""
    if ext and not ext.startswith("."):
        ext = "." + ext

    name = getattr(file, "name", None)
    if name:
        name = safe_filename(name)

    # deterministic filename
    base_name = f"{m.id}"
    if name and ext:
        out_name = f"{base_name}_{name}"
        if not out_name.endswith(ext):
            out_name += ext
    elif ext:
        out_name = f"{base_name}{ext}"
    else:
        out_name = f"{base_name}"

    out_path = ASSETS_DIR / out_name

    # If file already exists, do not redownload
    if not out_path.exists():
        try:
            await with_retries(
                lambda: client.download_media(m, file=str(out_path)),
                retries=3,
                backoff=1.5,
            )
        except Exception as e:
            LOGGER.warning("Download media failed for %s: %s", m.id, e)
            return []

    rel = out_path.relative_to(DOCS).as_posix()
    return [MediaItem(
        kind=kind if kind in {"photo", "video", "audio"} else "document",
        path=rel,
        size=size,
        mime=getattr(file, "mime_type", None),
        name=name
    )]

def to_post_dict(m: Message, channel_username: Optional[str]) -> Dict[str, Any]:
    text = m.message or ""
    entities = m.entities or []
    try:
        html_text = telethon_html.unparse(text, entities)
        html_text = html_text.replace('\n', '<br>')
    except Exception:
        html_text = ""  # fallback to plain text in UI

    link = None
    if channel_username:
        link = f"https://t.me/{channel_username}/{m.id}"

    p = Post(
        id=int(m.id),
        date=m.date.astimezone(timezone.utc).isoformat() if m.date else datetime.now(timezone.utc).isoformat(),
        edited=m.edit_date.astimezone(timezone.utc).isoformat() if getattr(m, "edit_date", None) else None,
        text=text,
        html=html_text,
        link=link,
        type=message_type(m),
        views=getattr(m, "views", None),
        forwards=getattr(m, "forwards", None),
        grouped_id=int(getattr(m, "grouped_id", 0)) if getattr(m, "grouped_id", None) else None,
        media=[],
        reactions=reactions_info(m),
    )
    d = asdict(p)
    # remove None to reduce json size a bit
    # keep nulls for stability? We'll drop some heavy nulls.
    return d

def merge_albums(posts_by_id: Dict[int, Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    """Coalesce album messages (grouped_id) into a single post with combined media."""
    grouped: Dict[int, List[Dict[str, Any]]] = {}
    standalone: Dict[int, Dict[str, Any]] = {}

    for pid, post in posts_by_id.items():
        gid = post.get("grouped_id")
        if gid:
            grouped.setdefault(int(gid), []).append(post)
        else:
            standalone[pid] = post

    merged: Dict[int, Dict[str, Any]] = {}
    merged.update(standalone)

    for gid, items in grouped.items():
        if not items:
            continue
        # Choose the message with the smallest id as the canonical post.
        items_sorted = sorted(items, key=lambda p: int(p.get("id", 0)))
        base = dict(items_sorted[0])

        # Combine media from all parts (keep order by message id).
        combined_media: List[Any] = []
        for it in items_sorted:
            if it.get("media"):
                combined_media.extend(it["media"])

        # Prefer first non-empty text/html across the group.
        text = base.get("text") or ""
        html = base.get("html") or ""
        if not text or not html:
            for it in items_sorted:
                if not text and it.get("text"):
                    text = it["text"]
                if not html and it.get("html"):
                    html = it["html"]
                if text and html:
                    break

        base["media"] = combined_media
        base["text"] = text
        base["html"] = html
        base["grouped_id"] = gid

        merged[int(base["id"])] = base

    return merged

async def run(telegram_cfg: TelegramConfig, sync_cfg: SyncConfig, dry_run: bool = False) -> None:
    max_bytes = max(1, sync_cfg.media_max_mb) * 1024 * 1024

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    posts_by_id = load_posts()
    is_initial = (not POSTS_PATH.exists()) or (not posts_by_id)
    last_id = max(posts_by_id.keys()) if posts_by_id else 0

    async with TelegramClient(StringSession(telegram_cfg.session), telegram_cfg.api_id, telegram_cfg.api_hash) as client:
        entity = await client.get_entity(telegram_cfg.channel)
        channel_username = getattr(entity, "username", None)
        channel_title = getattr(entity, "title", None) or getattr(entity, "first_name", None) or str(telegram_cfg.channel)
        avatar_rel = await download_avatar(client, entity)

        new_count = 0
        updated_count = 0
        downloaded = 0

        # Initial full import (determined before refresh step)
        if is_initial:
            LOGGER.info("No existing posts. Running initial import…")
            if sync_cfg.initial_limit and sync_cfg.initial_limit > 0:
                buf: List[Message] = []
                async for m in client.iter_messages(entity, limit=sync_cfg.initial_limit):
                    if isinstance(m, Message) and getattr(m, "id", None):
                        buf.append(m)
                for m in reversed(buf):
                    d = to_post_dict(m, channel_username)
                    posts_by_id[int(d["id"])] = d
                new_count = len(buf)
            else:
                async for m in client.iter_messages(entity, reverse=True):
                    if isinstance(m, Message) and getattr(m, "id", None):
                        d = to_post_dict(m, channel_username)
                        posts_by_id[int(d["id"])] = d
                        new_count += 1
        else:
            # 1) Fetch new messages after last_id
            if last_id > 0:
                try:
                    async for m in client.iter_messages(entity, min_id=last_id, reverse=True):
                        if not isinstance(m, Message) or not getattr(m, "id", None):
                            continue
                        d = to_post_dict(m, channel_username)
                        mid = int(d["id"])
                        if mid not in posts_by_id:
                            new_count += 1
                        posts_by_id[mid] = d
                except Exception as e:
                    LOGGER.error("Fetch new messages failed: %s", e)
                    raise

            # 2) Refresh last N messages (edits / pin changes etc.)
            if sync_cfg.refresh_last_n > 0:
                try:
                    async for m in client.iter_messages(entity, limit=sync_cfg.refresh_last_n):
                        if not isinstance(m, Message) or not getattr(m, "id", None):
                            continue
                        d = to_post_dict(m, channel_username)
                        mid = int(d["id"])
                        if mid in posts_by_id:
                            # Update if changed
                            if posts_by_id[mid].get("date") != d.get("date") or posts_by_id[mid].get("html") != d.get("html") or posts_by_id[mid].get("edited") != d.get("edited") or posts_by_id[mid].get("views") != d.get("views") or posts_by_id[mid].get("reactions") != d.get("reactions"):
                                if posts_by_id[mid].get("media") and not d.get("media"):
                                    d["media"] = posts_by_id[mid]["media"]
                                posts_by_id[mid] = d
                                updated_count += 1
                        else:
                            posts_by_id[mid] = d
                            new_count += 1
                except Exception as e:
                    LOGGER.warning("refresh_last_n failed: %s", e)

        # 4) Download media (only for posts that have no downloaded media yet)
        if sync_cfg.download_media:
            # Media downloads can be heavy. We limit the number of download attempts per run.
            # Tune via MEDIA_DOWNLOAD_SCOPE env var.
            scope = max(0, sync_cfg.media_download_scope)
            # Attempt media downloads for up to N candidates per run (newest first).
            ids_sorted = sorted(posts_by_id.keys(), reverse=True)
            checked = 0
            for mid in ids_sorted:
                if checked >= scope:
                    break

                p = posts_by_id[mid]
                if p.get("media"):
                    continue  # already have downloaded media
                # quick check: if type suggests media
                if p.get("type") in {"photo", "video", "audio", "document", "image", "sticker"}:
                    checked += 1
                    try:
                        m = await with_retries(
                            lambda: client.get_messages(entity, ids=mid),
                            retries=sync_cfg.max_retries,
                            backoff=sync_cfg.backoff_seconds,
                        )
                        if not isinstance(m, Message):
                            continue
                        items = await maybe_download_media(client, m, max_bytes=max_bytes)
                        if items:
                            p["media"] = [asdict(it) for it in items]
                            posts_by_id[mid] = p
                            downloaded += len(items)
                    except Exception as e:
                        LOGGER.warning("Media download failed for %s: %s", mid, e)

        # 5) Merge album messages so that multiple media stay in one post
        posts_by_id = merge_albums(posts_by_id)

        write_posts(posts_by_id)

        meta = {
            "title": channel_title,
            "username": channel_username,
            "channel": telegram_cfg.channel,
            "last_sync_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "posts_count": len(posts_by_id),
            "stats": {
                "new": new_count,
                "updated": updated_count,
                "media_downloaded": downloaded,
            }
        }
        if avatar_rel:
            meta["avatar"] = avatar_rel
        if dry_run:
            LOGGER.info(
                "DRY RUN — skipping writes. Posts: %s | new: %s | updated: %s | media downloaded: %s",
                len(posts_by_id), new_count, updated_count, downloaded
            )
        else:
            write_meta(meta)
            write_feeds(meta, posts_by_id, telegram_cfg.channel, sync_cfg.site_url)
            write_sitemap(meta, posts_by_id, telegram_cfg.channel, sync_cfg.site_url)
            write_robots(meta, telegram_cfg.channel, sync_cfg.site_url)

        LOGGER.info("Done. Posts: %s | new: %s | updated: %s | media downloaded: %s", len(posts_by_id), new_count, updated_count, downloaded)

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch Telegram channel posts into static site data.")
    parser.add_argument("--download-media", dest="download_media", action=argparse.BooleanOptionalAction, help="Download media files (overrides DOWNLOAD_MEDIA env).")
    parser.add_argument("--media-max-mb", type=int, dest="media_max_mb", help="Max media file size in MB (overrides MEDIA_MAX_MB).")
    parser.add_argument("--initial-limit", type=int, dest="initial_limit", help="Initial import limit (0=all).")
    parser.add_argument("--refresh-last-n", type=int, dest="refresh_last_n", help="Refresh last N messages.")
    parser.add_argument("--site-url", dest="site_url", help="Base site URL for feeds/sitemap (e.g. https://user.github.io/repo/).")
    parser.add_argument("--dry-run", action="store_true", help="Do not write files or commit; fetch and report only.")
    return parser.parse_args()

async def main() -> None:
    setup_logging()
    load_dotenv()  # allow local .env
    args = parse_args()
    telegram_cfg, sync_cfg = load_config()
    sync_cfg = merge_overrides(sync_cfg, args)
    await run(telegram_cfg, sync_cfg, dry_run=args.dry_run)

if __name__ == "__main__":
    asyncio.run(main())
