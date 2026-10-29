"""CLI: prepare a YouTube Short and publish it as an Instagram Reel on a chosen day.

    python main.py prepare --publish-date YYYY-MM-DD [--video-id ID] [--ai-label on|off] [--skip-download]
    python main.py publish [--now]
    python main.py status
"""

import argparse
import base64
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import pytz

import config
from publisher import GraphClient, build_caption, build_comment, compute_publish_time, fmt_unix, publish_reel, to_unix
from cover import make_grid_cover
from youtube_client import YouTubeClient, download_short, find_full_video_url, use_uploaded_video

SKIP_COMMENT = "No author comment found, the commenting step will be skipped."


# ---------------------------------------------------------------- published ledger
# history/published.json lives in the repo, so it outlasts GitHub artifacts (max. 90 days):
# a Short that is in it is never scheduled or published again.
def load_history() -> list[dict]:
    if not config.HISTORY_FILE.is_file():
        return []
    return json.loads(config.HISTORY_FILE.read_text(encoding="utf-8"))


def find_in_history(video_id: str) -> dict | None:
    return next((h for h in load_history() if h.get("video_id") == video_id), None)


def add_to_history(entry: dict) -> None:
    history = [h for h in load_history() if h.get("video_id") != entry["video_id"]]
    history.append(entry)
    config.HISTORY_FILE.parent.mkdir(exist_ok=True)
    config.HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def cmd_prepare(args) -> int:
    publish_at = compute_publish_time(args.publish_date)
    publish_unix = to_unix(publish_at)
    if publish_unix < time.time() + 30 * 60:  # the publish cron starts 35 / 15 minutes ahead
        raise SystemExit(f"❌ {publish_at:%Y-%m-%d %H:%M} has passed or is too close, pick a later day.")

    yt = YouTubeClient(config.require("YOUTUBE_API_KEY"))
    print(f"🔎 Looking up the Short on channel {yt.channel_id}…")
    short = yt.fetch_latest(args.video_id)
    print(f"🎬 {short.title}\n   {short.url} (published {short.published_at}, {short.duration_seconds} s)")
    config.gh_output("video_id", short.video_id)

    done = find_in_history(short.video_id)
    if done:
        raise SystemExit(
            f"❌ This Short was already published on Instagram ({done.get('published_on', '?')}: "
            f"{done.get('permalink') or 'see history/published.json'}). Each Short is published only once."
        )

    if short.author_comment:
        print(f"💬 Author comment found: {short.author_comment[:120]!r}")
    elif config.COMMENT_MODE == "youtube":
        print(f"ℹ️  {SKIP_COMMENT}")
    full_video_url = find_full_video_url(short.description, short.video_id)
    comment = build_comment(short.author_comment, full_video_url, short.url,
                            f"https://www.youtube.com/channel/{yt.channel_id}", short.title)
    print(f"🔗 Full video: {full_video_url or '(no link in the description)'}")
    print(f"💬 Instagram comment ({config.COMMENT_MODE}): {comment!r}")

    caption = build_caption(short.title, short.description, short.tags)
    print(f"🕔 Publish at: {publish_at:%Y-%m-%d %H:%M:%S %Z} = {publish_unix} (UTC unix)")

    video = {}
    if args.video_file:
        print("📎 Using the video file attached in the panel (no YouTube download).")
        video = use_uploaded_video(Path(args.video_file))
        print(f"   {video['width']}x{video['height']}, {video['vcodec']} + {video['acodec']}, {video['size_mb']} MB")
    elif not args.skip_download:
        print("⬇️  Downloading the video with yt-dlp (H.264 + original AAC audio)…")
        video = download_short(short.video_id)
        print(f"   {video['width']}x{video['height']}, {video['vcodec']} + {video['acodec']}, {video['size_mb']} MB")
        if (video.get("height") or 0) < 1920:
            print("⚠️  The video is not full 1080x1920, check the source.")

    cover_file = None
    if config.COVER_MODE == "grid" and short.thumbnail_url:
        try:
            make_grid_cover(short.thumbnail_url, config.COVER_FILE)
            cover_file = config.COVER_FILE.name
            print("🖼️  Cover fitted to the profile grid: work/cover.jpg")
        except Exception as exc:  # noqa: BLE001 – fall back to the plain YouTube thumbnail
            print(f"⚠️  Could not build the grid cover ({exc}), the YouTube thumbnail will be used.")

    pending = {
        **short.to_dict(),
        "youtube_url": short.url,
        "full_video_url": full_video_url,
        "youtube_comment": short.author_comment,
        "author_comment": comment,  # what gets posted under the Reel (None = no comment)
        "caption": caption,
        # grid: cover_file is hosted at publish time; cover_url is the fallback
        "cover_url": short.thumbnail_url if config.COVER_MODE in ("youtube", "grid") else None,
        "cover_file": cover_file,
        "ai_generated": config.AI_LABEL if args.ai_label in (None, "") else args.ai_label == "on",
        "publish_at_local": publish_at.isoformat(),
        "scheduled_publish_time": publish_unix,
        "video": video,
        "prepared_at": int(time.time()),
    }
    config.WORK_DIR.mkdir(exist_ok=True)
    config.PENDING_FILE.write_text(json.dumps(pending, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✅ Prepared: {config.PENDING_FILE}")

    # The reel-YYYY-MM-DD artifact must survive on GitHub until publish day (+ margin).
    days_ahead = (publish_at.date() - datetime.now(publish_at.tzinfo).date()).days
    config.gh_output("publish_date", publish_at.strftime("%Y-%m-%d"))
    config.gh_output("retention_days", str(min(90, max(2, days_ahead + 2))))

    config.gh_summary(
        f"### 🎬 Ready to publish\n"
        f"- **Short:** [{short.title}]({short.url})\n"
        f"- **Publish at:** {publish_at:%Y-%m-%d %H:%M %Z}\n"
        f"- **Video:** {video.get('width')}x{video.get('height')} {video.get('vcodec')} / {video.get('acodec')}\n"
        f"- **Comment under the Reel:** {'see below' if comment else 'none, commenting will be skipped'}\n\n"
        f"```\n{caption}\n```"
        + (f"\n\n💬 Comment:\n```\n{comment}\n```" if comment else "")
    )
    return 0


def cover_url_for(pending: dict) -> str | None:
    """The grid-fitted cover needs a public URL for an hour (Graph API only takes cover_url)."""
    path = config.WORK_DIR / (pending.get("cover_file") or "")
    if pending.get("cover_file") and pending.get("cover_url"):
        try:  # rebuild with the current layout, so packages queued before a cover fix get it too
            make_grid_cover(pending["cover_url"], path)
        except Exception as exc:  # noqa: BLE001 – the cover from the package is still there
            print(f"⚠️  Could not rebuild the grid cover ({exc}), using the one from the package.")
    if pending.get("cover_file") and path.is_file():
        import media_host

        try:
            url = media_host.upload_temporary(path, "image/jpeg")
            print(f"🖼️  Grid-fitted cover hosted for 1 h: {url}")
            return url
        except Exception as exc:  # noqa: BLE001 – a cover must never block publishing
            print(f"⚠️  Could not host the grid cover ({exc}), using the YouTube thumbnail.")
    return pending.get("cover_url")


def cmd_publish(args) -> int:
    config.gh_output("published", "false")
    config.gh_output("has_comment", "false")
    if not config.PENDING_FILE.is_file() or not config.VIDEO_FILE.is_file():
        print("ℹ️  Nothing to publish (work/pending.json or work/video.mp4 is missing).")
        return 0

    pending = json.loads(config.PENDING_FILE.read_text(encoding="utf-8"))
    now = time.time()
    target = now if args.now else pending["scheduled_publish_time"]
    print(f"🎬 {pending['title']} → planned for {fmt_unix(target)}")

    planned_day = pending["publish_at_local"][:10]
    # The day of the upcoming publish slot (the run may start just before midnight).
    ahead = timedelta(minutes=0 if args.now else config.PREP_LEAD_MINUTES)
    today = (datetime.now(pytz.timezone(config.TIMEZONE)) + ahead).strftime("%Y-%m-%d")
    if planned_day != today:
        print(f"ℹ️  This package is planned for {planned_day}, today is {today}, not publishing.")
        return 0

    if now < target - config.PREP_LEAD_MINUTES * 60:
        print(f"ℹ️  Too early to publish (starts at most {config.PREP_LEAD_MINUTES} min ahead). Exiting.")
        return 0
    if now > target + config.LATE_GRACE_MINUTES * 60:
        print("ℹ️  The planned time is long past, the package is stale, not publishing.")
        return 0

    # Never publish the same Short twice: permanent ledger first, then the whole Instagram profile.
    done = find_in_history(pending["video_id"])
    if done:
        print(f"ℹ️  This Short was already published on {done.get('published_on', '?')} ({done.get('permalink')}). Not publishing again.")
        return 0
    client = GraphClient(config.require("GRAPH_API_ACCESS_TOKEN"), config.require("GRAPH_API_ACCOUNT_ID"))
    existing = client.find_published(pending["caption"])
    if existing:
        print(f"ℹ️  A post with the same caption is already on Instagram ({existing.get('permalink')}). Not publishing again.")
        add_to_history({
            "video_id": pending["video_id"], "title": pending["title"], "published_on": existing["timestamp"][:10],
            "media_id": existing["id"], "permalink": existing.get("permalink", ""), "note": "found on Instagram",
        })
        config.gh_output("video_id", pending["video_id"])
        config.gh_output("ledger_changed", "true")
        return 0

    ai = bool(pending.get("ai_generated"))
    print(f"🏷️  Instagram AI info label: {'on' if ai else 'off'}")
    media_id = publish_reel(client, config.VIDEO_FILE, pending["caption"], cover_url_for(pending), target, ai_generated=ai)
    published_at = time.time()
    permalink = client.permalink(media_id)
    print(f"🚀 Reel published {fmt_unix(published_at)}: {permalink} (media {media_id})")
    config.gh_summary(f"### 🚀 Reel published\n{permalink} · {fmt_unix(published_at)}")

    add_to_history({
        "video_id": pending["video_id"], "title": pending["title"], "published_on": planned_day,
        "published_at": int(published_at), "media_id": media_id, "permalink": permalink,
    })
    config.WORK_DIR.joinpath("published.json").write_text(
        json.dumps(
            {"media_id": media_id, "permalink": permalink, "published_at": int(published_at),
             "video_id": pending["video_id"], "title": pending["title"]},
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )

    comment = pending.get("author_comment")
    config.gh_output("published", "true")
    config.gh_output("ledger_changed", "true")
    config.gh_output("media_id", media_id)
    config.gh_output("video_id", pending["video_id"])
    config.gh_output("publish_date", planned_day)
    if comment:
        config.gh_output("has_comment", "true")
        config.gh_output("comment_b64", base64.b64encode(comment.encode("utf-8")).decode("ascii"))
        config.gh_output("comment_at", str(int(max(target, published_at)) + config.COMMENT_DELAY_SECONDS))
    else:
        print(f"ℹ️  {SKIP_COMMENT}")
    return 0


def cmd_status(_args) -> int:
    if not config.PENDING_FILE.is_file():
        print("No prepared package.")
        return 0
    p = json.loads(config.PENDING_FILE.read_text(encoding="utf-8"))
    print(f"Short:      {p['title']} ({p['youtube_url']})")
    print(f"Publishes:  {fmt_unix(p['scheduled_publish_time'])}")
    print(f"Comment:    {p.get('author_comment') or '(none, will be skipped)'}")
    print(f"Video:      {'OK' if config.VIDEO_FILE.is_file() else 'missing'}")
    print(f"\n--- Caption ---\n{p['caption']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="YouTube Shorts → Instagram Reels")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("prepare", help="Fetch a Short, download the video and prepare the package")
    p.add_argument("--video-id", help="YouTube video ID or URL instead of the latest Short")
    p.add_argument(
        "--publish-date", required=True, help="Day to publish at PUBLISH_TIME: 2026-10-30, 'today' or 'tomorrow'"
    )
    p.add_argument("--skip-download", action="store_true", help="Don't download the video (metadata test)")
    p.add_argument("--ai-label", choices=("on", "off"), help="Instagram 'AI info' label for this Reel (default: AI_LABEL)")
    p.add_argument("--video-file", help="Use this video file (attached in the panel) instead of downloading from YouTube")
    p.set_defaults(func=cmd_prepare)

    p = sub.add_parser("publish", help="Publish the prepared package at the planned time")
    p.add_argument("--now", action="store_true", help="Publish right away (test)")
    p.set_defaults(func=cmd_publish)

    sub.add_parser("status", help="Show the prepared package").set_defaults(func=cmd_status)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
