"""YouTube: find the latest Short, read its metadata and the author's comment, download the video."""

import html
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

import config

SHORTS_MAX_SECONDS = 180  # since 10/2024 Shorts can be up to 3 minutes long


@dataclass
class ShortInfo:
    video_id: str
    title: str
    description: str
    tags: list = field(default_factory=list)
    published_at: str = ""
    duration_seconds: int = 0
    thumbnail_url: str = ""
    author_comment: str | None = None

    @property
    def url(self) -> str:
        return f"https://www.youtube.com/shorts/{self.video_id}"

    def to_dict(self) -> dict:
        return asdict(self)


def _parse_iso_duration(value: str) -> int:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", value or "")
    if not m:
        return 0
    d, h, mi, s = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def extract_video_id(value: str) -> str:
    """Accepts a video ID or a URL (youtube.com/shorts/…, watch?v=…, youtu.be/…)."""
    m = re.search(r"(?:shorts/|v=|youtu\.be/|embed/)([\w-]{11})", value)
    return m.group(1) if m else value.strip()


YOUTUBE_LINK = re.compile(r"(?:youtube\.com/(?:watch\?(?:\S*?&)?v=|shorts/|live/)|youtu\.be/)([\w-]{11})")


def find_full_video_url(description: str, short_id: str) -> str | None:
    """The first YouTube video linked in the Short's description (other than the Short itself)."""
    for vid in YOUTUBE_LINK.findall(description or ""):
        if vid != short_id:
            return f"https://www.youtube.com/watch?v={vid}"
    return None


def _best_thumbnail(thumbnails: dict) -> str:
    for key in ("maxres", "standard", "high", "medium", "default"):
        if key in thumbnails:
            return thumbnails[key]["url"]
    return ""


class YouTubeClient:
    def __init__(self, api_key: str, channel: str = config.YOUTUBE_CHANNEL_ID):
        self.api = build("youtube", "v3", developerKey=api_key, cache_discovery=False)
        if not channel:
            raise SystemExit("❌ Missing YOUTUBE_CHANNEL_ID (channel ID, @handle or channel URL).")
        self.channel_id = self.resolve_channel_id(channel)

    def resolve_channel_id(self, value: str) -> str:
        """Accepts UC… ID, @handle or a channel URL and returns the UC… channel ID."""
        value = value.strip()
        m = re.search(r"(UC[\w-]{22})", value)
        if m:
            return m.group(1)
        m = re.search(r"@([\w.\-]+)", value)
        handle = m.group(1) if m else value.rstrip("/").rsplit("/", 1)[-1]
        resp = self.api.channels().list(part="id", forHandle=handle).execute()
        items = resp.get("items", [])
        if not items:
            raise SystemExit(f"❌ YouTube channel '{value}' not found.")
        return items[0]["id"]

    # ---------- finding the Short ----------
    def _playlist_video_ids(self, playlist_id: str, limit: int = 25) -> list[str]:
        resp = self.api.playlistItems().list(
            part="contentDetails", playlistId=playlist_id, maxResults=limit
        ).execute()
        return [it["contentDetails"]["videoId"] for it in resp.get("items", [])]

    def _videos(self, video_ids: list[str]) -> list[dict]:
        if not video_ids:
            return []
        resp = self.api.videos().list(
            part="snippet,contentDetails,status", id=",".join(video_ids)
        ).execute()
        return resp.get("items", [])

    def latest_short_id(self) -> str:
        """Returns the ID of the newest public Short on the channel."""
        suffix = self.channel_id[2:]
        # 1) The "UUSH…" playlist contains only Shorts (unofficial but reliable trick).
        try:
            ids = self._playlist_video_ids("UUSH" + suffix, limit=5)
            if ids:
                return ids[0]
        except HttpError as exc:
            print(f"ℹ️  Shorts playlist unavailable ({exc.status_code}), falling back to all uploads.")

        # 2) Fallback: all uploads, pick the first short video.
        ids = self._playlist_video_ids("UU" + suffix, limit=25)
        videos = sorted(self._videos(ids), key=lambda v: v["snippet"]["publishedAt"], reverse=True)
        for v in videos:
            if _parse_iso_duration(v["contentDetails"]["duration"]) <= SHORTS_MAX_SECONDS:
                return v["id"]
        raise RuntimeError("No Short found on the channel.")

    def get_short(self, video_id: str) -> ShortInfo:
        items = self._videos([video_id])
        if not items:
            raise RuntimeError(f"Video {video_id} not found (is it public?).")
        v = items[0]
        sn = v["snippet"]
        return ShortInfo(
            video_id=v["id"],
            title=sn.get("title", ""),
            description=sn.get("description", ""),
            tags=sn.get("tags", []),
            published_at=sn.get("publishedAt", ""),
            duration_seconds=_parse_iso_duration(v["contentDetails"]["duration"]),
            thumbnail_url=_best_thumbnail(sn.get("thumbnails", {})),
        )

    # ---------- author's comment ----------
    def find_author_comment(self, video_id: str, max_pages: int = 5) -> str | None:
        """Returns the text of the channel owner's comment, or None. Never raises."""
        try:
            page_token = None
            for _ in range(max_pages):
                resp = self.api.commentThreads().list(
                    part="snippet",
                    videoId=video_id,
                    maxResults=100,
                    order="relevance",  # a pinned comment usually comes first
                    textFormat="plainText",
                    pageToken=page_token,
                ).execute()
                for item in resp.get("items", []):
                    c = item["snippet"]["topLevelComment"]["snippet"]
                    if c.get("authorChannelId", {}).get("value") == self.channel_id:
                        text = c.get("textOriginal") or c.get("textDisplay") or ""
                        text = html.unescape(text).strip()
                        if text:
                            return text
                page_token = resp.get("nextPageToken")
                if not page_token:
                    break
        except HttpError as exc:
            reason = exc.error_details[0].get("reason") if exc.error_details else exc.status_code
            print(f"⚠️  Could not load comments ({reason}).")
        except Exception as exc:  # noqa: BLE001 – the comment must never break the run
            print(f"⚠️  Error while looking for the comment: {exc}")
        return None

    def fetch_latest(self, video_id: str | None = None) -> ShortInfo:
        short = self.get_short(extract_video_id(video_id) if video_id else self.latest_short_id())
        short.author_comment = self.find_author_comment(short.video_id)
        return short


# ---------- video download ----------
# H.264 (avc1) video up to 1920 px tall + the original AAC audio, merged into MP4 without re-encoding.
YTDLP_FORMAT = (
    "bv*[vcodec^=avc1][height<=1920][height>=1080]+ba[acodec^=mp4a]"
    "/bv*[vcodec^=avc1]+ba[acodec^=mp4a]"
    "/b[ext=mp4]"
)


def ffmpeg_path() -> str | None:
    """ffmpeg from PATH, else the static build bundled with the imageio-ffmpeg package."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


def ytdlp_options(output: Path | None = None) -> dict:
    opts = {
        "format": YTDLP_FORMAT,
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 5,
    }
    if output:
        opts["outtmpl"] = str(output.with_suffix("")) + ".%(ext)s"
        opts["overwrites"] = True
    if not shutil.which("ffmpeg") and (ffmpeg := ffmpeg_path()):
        opts["ffmpeg_location"] = ffmpeg
    if config.YTDLP_COOKIES_FILE and Path(config.YTDLP_COOKIES_FILE).is_file():
        opts["cookiefile"] = config.YTDLP_COOKIES_FILE
    if config.YTDLP_PROXY:
        opts["proxy"] = config.YTDLP_PROXY
    return opts


def probe_video(path: Path) -> dict:
    """Codec and resolution of a video file (parsed from `ffmpeg -i`, so no ffprobe is needed)."""
    out = subprocess.run([ffmpeg_path() or "ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    v = re.search(r"Video: (\w+).*?, (\d{2,5})x(\d{2,5})", out)
    a = re.search(r"Audio: (\w+)", out)
    return {
        "vcodec": v.group(1) if v else None,
        "width": int(v.group(2)) if v else None,
        "height": int(v.group(3)) if v else None,
        "acodec": a.group(1) if a else None,
    }


def use_uploaded_video(source: Path, output: Path = config.VIDEO_FILE) -> dict:
    """Takes a video uploaded via the panel instead of downloading it from YouTube.

    H.264/HEVC + AAC in MP4/MOV is used as is; anything else (e.g. ProRes) is converted
    to H.264 + AAC, which Instagram requires.
    """
    if not source.is_file() or source.stat().st_size == 0:
        raise RuntimeError(f"Uploaded video {source} is missing or empty")
    info = probe_video(source)
    print(f"   uploaded file: {info['width']}x{info['height']}, {info['vcodec']} + {info['acodec']}")
    output.parent.mkdir(parents=True, exist_ok=True)
    compatible = info["vcodec"] in ("h264", "hevc") and info["acodec"] in ("aac", None)
    if compatible and source.suffix.lower() in (".mp4", ".mov", ".m4v"):
        if source.resolve() != output.resolve():
            shutil.copyfile(source, output)
    else:
        print("   converting to H.264 + AAC for Instagram…")
        subprocess.run(
            [ffmpeg_path() or "ffmpeg", "-loglevel", "error", "-y", "-i", str(source),
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output)],
            check=True,
        )
        info = probe_video(output)
    return {**info, "format_id": "upload", "size_mb": round(output.stat().st_size / 1_048_576, 1)}


def download_short(video_id: str, output: Path = config.VIDEO_FILE) -> dict:
    """Downloads the Short as MP4 (H.264 + AAC). Returns info about the chosen format."""
    import yt_dlp

    output.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://www.youtube.com/shorts/{video_id}"
    try:
        with yt_dlp.YoutubeDL(ytdlp_options(output)) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        if "not a bot" in str(exc) or "Sign in" in str(exc):
            raise SystemExit(
                "❌ YouTube blocked the download from the cloud server (\"Sign in to confirm you're not a bot\").\n"
                "   Fix: attach the video file when scheduling in the panel (📎 Attach video file)."
            ) from exc
        raise

    if not output.is_file():
        raise RuntimeError(f"yt-dlp did not create {output}")
    return {
        "width": info.get("width"),
        "height": info.get("height"),
        "vcodec": info.get("vcodec"),
        "acodec": info.get("acodec"),
        "format_id": info.get("format_id"),
        "size_mb": round(output.stat().st_size / 1_048_576, 1),
    }
