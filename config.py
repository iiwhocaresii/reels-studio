"""Shared project configuration, loaded from environment variables / the .env file."""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
WORK_DIR = BASE_DIR / "work"
PENDING_FILE = WORK_DIR / "pending.json"
VIDEO_FILE = WORK_DIR / "video.mp4"
COVER_FILE = WORK_DIR / "cover.jpg"
# Permanent record of every published Short (committed to the repo by the publish workflow).
HISTORY_FILE = BASE_DIR / "history" / "published.json"

load_dotenv(BASE_DIR / ".env")

# Windows consoles often aren't UTF-8; emoji in log output would crash otherwise.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


def env(name: str, default: str = "") -> str:
    value = os.getenv(name, "")
    return value.strip() if value and value.strip() else default


def require(name: str) -> str:
    value = env(name)
    if not value:
        raise SystemExit(f"❌ Missing environment variable {name} (see .env.example / GitHub Secrets & Variables).")
    return value


# --- YouTube ---
# Channel ID (UC…), @handle or channel URL. Required.
YOUTUBE_CHANNEL_ID = env("YOUTUBE_CHANNEL_ID")
YTDLP_COOKIES_FILE = env("YTDLP_COOKIES_FILE")  # optional, path to cookies.txt
# Optional (paid) residential proxy for YouTube downloads, e.g. http://user:pass@host:port.
# Not needed when you attach the video file in the panel.
YTDLP_PROXY = env("YTDLP_PROXY")

# --- Graph API (Instagram) ---
GRAPH_API_HOST = env("GRAPH_API_HOST", "graph.facebook.com")
GRAPH_API_VERSION = env("GRAPH_API_VERSION", "v24.0")

# --- Timing ---
TIMEZONE = env("TIMEZONE", env("PUBLISH_TIMEZONE", "UTC"))  # IANA name, e.g. Europe/Prague
PUBLISH_TIME = env("PUBLISH_TIME", "17:00")
COMMENT_DELAY_SECONDS = int(env("COMMENT_DELAY_SECONDS", "60"))
# How long before the target time the publish job may start (upload the video and wait).
PREP_LEAD_MINUTES = int(env("PREP_LEAD_MINUTES", "40"))
# How long after the target time we still publish (delayed cron / re-run).
LATE_GRACE_MINUTES = int(env("LATE_GRACE_MINUTES", "180"))

# --- How the video reaches the Graph API ---
# resumable = direct upload to Meta (recommended, no public URL needed)
# litterbox = temporary public hosting on litterbox.catbox.moe (1 h), then video_url
# s3        = Cloudflare R2 / S3 + presigned URL, then video_url
MEDIA_HOST = env("MEDIA_HOST", "resumable").lower()

# Comment posted under the Reel a minute after publishing:
# youtube  = copy your own comment from under the Short (skipped if there is none)
# template = COMMENT_TEMPLATE, e.g. a link to the full video ({full_video_url} is found in the description)
# off      = no comment
COMMENT_MODE = env("COMMENT_MODE", "youtube").lower()
COMMENT_TEMPLATE = env("COMMENT_TEMPLATE", "▶️ Full video on YouTube: {full_video_url}\n🔗 Link in bio").replace("\\n", "\n")

# Instagram's "AI info" label (is_ai_generated) by default; can be changed per Reel when scheduling.
# It can only be set when publishing, not added afterwards.
AI_LABEL = env("AI_LABEL", "off").lower() in ("on", "true", "yes", "1")

# grid    = the Short's design at full height on a landscape cover with a blurred fill on the sides,
#           hosted for about 1 h because the API needs a public image URL
# youtube = YouTube thumbnail as is (the profile grid crops its edges)
# none    = Instagram picks a frame from the video
COVER_MODE = env("COVER_MODE", "grid").lower()

# --- Instagram caption limits ---
CAPTION_MAX_CHARS = 2200
CAPTION_MAX_HASHTAGS = 30


# --- GitHub Actions outputs (no-op when running locally) ---
def gh_output(key: str, value: str) -> None:
    path = os.getenv("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{key}={value}\n")


def gh_summary(markdown: str) -> None:
    path = os.getenv("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(markdown + "\n")
