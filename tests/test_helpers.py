import datetime

import pytest

from scripts.fetch_telegram import (
    clean_channel,
    safe_filename,
    iso_to_dt,
    fmt_lastmod,
    site_base_url,
    merge_albums,
)


def test_clean_channel_strips_prefixes():
    assert clean_channel("https://t.me/mychannel") == "mychannel"
    assert clean_channel("@mychannel") == "mychannel"
    assert clean_channel(" mychannel ") == "mychannel"


def test_safe_filename_keeps_safe_chars_and_limits_length():
    assert safe_filename("abc_123.txt") == "abc_123.txt"
    assert safe_filename("a*b?c") == "a_b_c"
    long = "a" * 200
    assert len(safe_filename(long)) == 120


def test_iso_to_dt_and_fmt_lastmod_handle_valid_and_invalid():
    iso = "2024-01-02T03:04:05+00:00"
    dt = iso_to_dt(iso)
    assert dt is not None
    assert dt.year == 2024
    assert fmt_lastmod(dt).startswith("2024-01-02T03:04:05")
    assert iso_to_dt("invalid") is None
    assert fmt_lastmod(None) is None


def test_site_base_url_env_and_fallback():
    meta = {"username": "name"}
    assert site_base_url(meta, "fallback", "https://example.com/") == "https://example.com/"
    assert site_base_url(meta, "fallback", "") == "https://t.me/name/"
    assert site_base_url({}, "channelname", "") == "https://t.me/channelname/"


def test_merge_albums_combines_grouped_media():
    posts = {
        1: {"id": 1, "grouped_id": 10, "media": [{"path": "a.jpg"}], "text": "", "html": ""},
        2: {"id": 2, "grouped_id": 10, "media": [{"path": "b.jpg"}], "text": "t", "html": ""},
        3: {"id": 3, "media": [], "text": "solo", "html": ""},
    }
    merged = merge_albums(posts)
    # group should pick smallest id as base
    assert 1 in merged and 2 not in merged
    assert len(merged[1]["media"]) == 2
    assert merged[1]["text"] == "t"  # picked non-empty text
    assert "grouped_id" in merged[1]
    assert 3 in merged and merged[3]["text"] == "solo"
