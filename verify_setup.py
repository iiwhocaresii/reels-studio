"""Quick check of all credentials and access before deploying to GitHub.

    python verify_setup.py                 # everything except the test upload
    python verify_setup.py --skip-ytdlp    # skip the YouTube download check
    python verify_setup.py --test-upload   # also test temporary hosting (MEDIA_HOST != resumable)
    python verify_setup.py --only youtube  # just one area: youtube | download | instagram

Publishes nothing and comments nothing.
"""

import argparse
import importlib
import os
import shutil
import sys
from datetime import datetime, timezone

for _stream in (sys.stdout, sys.stderr):  # emoji in the Windows console (before importing config)
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

results: list[tuple[str, bool, str]] = []
IN_ACTIONS = os.getenv("GITHUB_ACTIONS") == "true"


def annotate(level: str, title: str, message: str) -> None:
    """Creates a GitHub Actions annotation; the control panel reads test results from these."""
    if IN_ACTIONS:
        esc = lambda s: s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")  # noqa: E731
        print(f"::{level} title={esc(title).replace(',', '%2C').replace(':', '%3A')}::{esc(message or title)}")


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(f"{'✅' if ok else '❌'} {name}" + (f" · {detail}" if detail else ""), flush=True)
    if not ok:
        annotate("error", name, detail)
    return ok


def warn(name: str, detail: str) -> None:
    print(f"⚠️  {name} · {detail}", flush=True)
    annotate("warning", name, detail)


def check_environment() -> bool:
    check("Python ≥ 3.10", sys.version_info >= (3, 10), sys.version.split()[0])
    missing = []
    for module in ("googleapiclient", "yt_dlp", "requests", "dotenv", "pytz"):
        try:
            importlib.import_module(module)
        except ImportError:
            missing.append(module)
    ok = check("Python packages", not missing, f"missing: {', '.join(missing)} → pip install -r requirements.txt" if missing else "")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        try:
            import imageio_ffmpeg  # static build shipped as a pip package

            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:  # noqa: BLE001
            pass
    check("ffmpeg (merging video + audio)", bool(ffmpeg), ffmpeg or "not found (pip install imageio-ffmpeg)")
    if not (shutil.which("deno") or shutil.which("node")):
        warn("JS runtime for yt-dlp", "Deno not found, 1080p may be unavailable without it (https://deno.com)")
    return ok


def check_env_vars(config, names=("YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID", "GRAPH_API_ACCESS_TOKEN", "GRAPH_API_ACCOUNT_ID")) -> None:
    for name in names:
        value = config.env(name)
        shown = value if name == "YOUTUBE_CHANNEL_ID" else f"{value[:6]}…"
        check(f"Variable {name}", bool(value), shown if value else "not set")


def check_time(config) -> None:
    from publisher import compute_publish_time, to_unix

    target = compute_publish_time()
    check(
        "Publish time calculation",
        target.hour == int(config.PUBLISH_TIME.split(":")[0]),
        f"{target:%Y-%m-%d %H:%M %Z} ({config.TIMEZONE}) = "
        f"{datetime.fromtimestamp(to_unix(target), timezone.utc):%H:%M} UTC (unix {to_unix(target)})",
    )


def check_youtube(config, skip_ytdlp: bool, metadata: bool = True) -> None:
    from youtube_client import YouTubeClient, ytdlp_options

    if not (config.env("YOUTUBE_API_KEY") and config.YOUTUBE_CHANNEL_ID):
        if not metadata:  # otherwise check_env_vars already reported it
            check("YouTube Data API", False, "YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID not set")
        return
    if metadata:
        short = _check_youtube_metadata(config)
    else:  # download check only: just find the latest Short quietly
        try:
            yt = YouTubeClient(config.env("YOUTUBE_API_KEY"))
            short = yt.get_short(yt.latest_short_id())
        except BaseException as exc:  # noqa: BLE001 – SystemExit from channel resolution too
            short = None
            check("YouTube Data API", False, str(exc)[:300])
    if short and not skip_ytdlp:
        _check_download(short, ytdlp_options)


def _check_youtube_metadata(config):
    from youtube_client import YouTubeClient

    try:
        yt = YouTubeClient(config.env("YOUTUBE_API_KEY"))
        ch = yt.api.channels().list(part="snippet", id=yt.channel_id).execute()
        title = ch["items"][0]["snippet"]["title"] if ch.get("items") else None
        if not check("YouTube Data API key", bool(title), f"channel: {title}" if title else "channel not found"):
            return None
        short = yt.get_short(yt.latest_short_id())
        check("Latest Short", True, f"\"{short.title}\" ({short.url}), {len(short.tags)} tags")
        check("Thumbnail (cover_url)", bool(short.thumbnail_url), short.thumbnail_url)
        comment = yt.find_author_comment(short.video_id)
        if comment:
            check("Author comment", True, comment[:80])
        else:
            print("ℹ️  Author comment · not found (the commenting step will be skipped, that's fine)")
        annotate("notice", "YouTube OK", f"Channel {title}, latest Short \"{short.title}\"")
        return short
    except BaseException as exc:  # noqa: BLE001 – SystemExit from channel resolution too
        check("YouTube Data API", False, str(exc)[:300])
        return None


def _check_download(short, ytdlp_options) -> None:
    try:
        import yt_dlp

        with yt_dlp.YoutubeDL({**ytdlp_options(), "skip_download": True}) as ydl:
            info = ydl.extract_info(short.url, download=False)
        fmts = info.get("requested_formats") or [info]
        desc = " + ".join(f"{f.get('format_id')} {f.get('width') or ''}x{f.get('height') or ''} {f.get('vcodec')}/{f.get('acodec')}" for f in fmts)
        full_hd = (info.get("height") or 0) >= 1920
        check("yt-dlp: format available", True, desc)
        if not full_hd:
            warn("yt-dlp", f"chosen format is {info.get('height')} px tall, not 1920 (Deno / cookies?)")
    except Exception as exc:  # noqa: BLE001
        check("yt-dlp: download from YouTube", False, str(exc)[:300])


def check_graph(config) -> None:
    from publisher import GraphClient

    if not (config.env("GRAPH_API_ACCESS_TOKEN") and config.env("GRAPH_API_ACCOUNT_ID")):
        return
    client = GraphClient(config.env("GRAPH_API_ACCESS_TOKEN"), config.env("GRAPH_API_ACCOUNT_ID"))
    try:
        info = client.account_info()
        check("Graph API: account", True, f"@{info.get('username')} ({info.get('media_count')} posts)")
        annotate("notice", "Instagram OK", f"Account @{info.get('username')}")
    except Exception as exc:  # noqa: BLE001
        check("Graph API: account", False, str(exc)[:300])
        return
    try:
        limit = client.publishing_limit()
        usage = (limit.get("data") or [{}])[0]
        quota = usage.get("config", {}).get("quota_total", "?")
        check("Graph API: publishing permission", True, f"used {usage.get('quota_usage', 0)}/{quota} in 24 h")
    except Exception as exc:  # noqa: BLE001
        check("Graph API: publishing permission", False, f"{str(exc)[:200]} (missing instagram_content_publish?)")
    try:
        media = client.recent_media(1)
        if media:
            client.comment_texts(media[0]["id"])
        check("Graph API: read media and comments", True)
    except Exception as exc:  # noqa: BLE001
        check("Graph API: read media and comments", False, f"{str(exc)[:200]} (missing instagram_manage_comments?)")

    if config.AI_LABEL:
        # A container that is never uploaded to nor published (it expires within 24 h):
        # proves Instagram accepts the "AI info" label before a real Reel depends on it.
        try:
            c = client.create_reel_container("Reels Studio access test (never published)", None, ai_generated=True)
            check("Graph API: AI info label accepted", bool(c.get("id")), f"test container {c.get('id')} (not published)")
        except Exception as exc:  # noqa: BLE001
            check("Graph API: AI info label accepted", False, str(exc)[:300])

    if config.GRAPH_API_HOST == "graph.facebook.com":
        try:
            perms = client.request("GET", "me/permissions").get("data", [])
            granted = {p["permission"] for p in perms if p.get("status") == "granted"}
            needed = {"instagram_basic", "instagram_content_publish", "instagram_manage_comments"}
            missing = needed - granted
            check("Token permissions", not missing, f"missing: {', '.join(sorted(missing))}" if missing else ", ".join(sorted(needed)))
        except Exception:  # noqa: BLE001 – may not work for System User / Page tokens
            pass


def check_upload(config) -> None:
    import tempfile
    from pathlib import Path

    import media_host

    if config.MEDIA_HOST == "resumable":
        print("ℹ️  MEDIA_HOST=resumable, no temporary hosting needed.")
        return
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "verify_setup_test.mp4"
        path.write_bytes(b"\x00" * 2048)
        try:
            url = media_host.upload_public(path)
            check(f"Temporary hosting ({config.MEDIA_HOST})", True, url)
        except Exception as exc:  # noqa: BLE001
            check(f"Temporary hosting ({config.MEDIA_HOST})", False, str(exc)[:300])


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the project setup")
    parser.add_argument("--skip-ytdlp", action="store_true")
    parser.add_argument("--test-upload", action="store_true")
    # The cloud test runs each area as its own step, so the panel can show ✅/❌ per area.
    parser.add_argument("--only", choices=("youtube", "download", "instagram"))
    args = parser.parse_args()
    only = args.only

    if only in (None, "download"):
        print("=== Environment ===")
        if not check_environment():
            return 1
    import config

    print("\n=== Configuration ===")
    if only in (None, "youtube"):
        check_env_vars(config, ("YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID"))
        check_time(config)
    if only in (None, "instagram"):
        check_env_vars(config, ("GRAPH_API_ACCESS_TOKEN", "GRAPH_API_ACCOUNT_ID"))
    if only in (None, "youtube", "download"):
        print("\n=== YouTube ===")
        check_youtube(config, skip_ytdlp=args.skip_ytdlp or only == "youtube", metadata=only != "download")
    if only in (None, "instagram"):
        print("\n=== Instagram Graph API ===")
        check_graph(config)
    if args.test_upload:
        print("\n=== Temporary hosting ===")
        check_upload(config)

    failed = [r for r in results if not r[1]]
    if not failed and only is None:
        annotate("notice", "All good", f"{len(results)} checks passed")
    print(f"\n{'🎉 All good, ready to deploy.' if not failed else f'❌ {len(failed)} check(s) failed, see above.'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
