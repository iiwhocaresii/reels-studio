"""Downloads your channel's Shorts to Downloads/Shorts, ready to attach in Reels Studio.

YouTube blocks downloads from GitHub's servers, but not from your own computer.
Reels Studio (tools/studio.py) calls this from its "Download my Shorts" button; it also works
on its own:  python tools/download_shorts.py [@handle | channel link | UC… id]
Only Shorts that aren't in the folder yet are downloaded. The file names contain [videoId].
"""

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:  # trust the Windows/macOS certificate store (antivirus HTTPS scanning, company proxies)
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

import yt_dlp  # noqa: E402

from youtube_client import ytdlp_options  # noqa: E402

SETTINGS = Path(__file__).with_name("download_shorts.json")
OUT_DIR = Path.home() / "Downloads" / "Shorts"
HOW_MANY = 15  # newest Shorts to check
VIDEO_EXT = (".mp4", ".mov", ".m4v")


def shorts_url(channel: str) -> str:
    channel = channel.strip()
    if re.fullmatch(r"UC[\w-]{22}", channel):
        return f"https://www.youtube.com/channel/{channel}/shorts"
    if channel.startswith("http"):
        return channel.rstrip("/").removesuffix("/shorts") + "/shorts"
    return f"https://www.youtube.com/{channel if channel.startswith('@') else '@' + channel}/shorts"


def local_files() -> dict[str, Path]:
    """videoId → file for everything already in the Shorts folder."""
    out = {}
    if OUT_DIR.is_dir():
        for p in OUT_DIR.iterdir():
            m = re.search(r"\[([\w-]{11})\]", p.name)
            if m and p.suffix.lower() in VIDEO_EXT:
                out[m.group(1)] = p
    return out


def download_new(channel: str, log=print) -> list[str]:
    """Downloads the channel's newest Shorts that aren't in OUT_DIR yet. Returns their IDs."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    url = shorts_url(channel)
    log(f"🔎 Looking for Shorts on {url}…")
    with yt_dlp.YoutubeDL({"extract_flat": True, "playlistend": HOW_MANY, "quiet": True, "no_warnings": True}) as ydl:
        entries = ydl.extract_info(url, download=False).get("entries") or []
    have = local_files()
    todo = [e for e in entries if e.get("id") and e["id"] not in have]
    log(f"   {len(entries)} newest Shorts, {len(todo)} not downloaded yet.")

    opts = ytdlp_options()
    opts.update({"outtmpl": str(OUT_DIR / "%(upload_date>%Y-%m-%d)s %(title).80B [%(id)s].%(ext)s"), "overwrites": False})
    done = []
    with yt_dlp.YoutubeDL(opts) as ydl:
        for i, e in enumerate(todo, 1):
            log(f"⬇️  {i}/{len(todo)}  {e.get('title') or e['id']}")
            try:
                ydl.download([f"https://www.youtube.com/shorts/{e['id']}"])
                done.append(e["id"])
            except Exception as exc:  # noqa: BLE001 – keep going with the others
                log(f"   ⚠️  failed: {exc}")
    log(f"✅ Done. Your Shorts are in {OUT_DIR}")
    return done


def main() -> None:
    saved = json.loads(SETTINGS.read_text(encoding="utf-8")) if SETTINGS.is_file() else {}
    channel = sys.argv[1] if len(sys.argv) > 1 else saved.get("channel")
    if not channel:
        channel = input("Your YouTube channel (@handle or link): ").strip()
    SETTINGS.write_text(json.dumps({"channel": channel}), encoding="utf-8")
    download_new(channel)
    if os.name == "nt":
        os.startfile(OUT_DIR)  # noqa: S606 – open the folder in Explorer


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"\n❌ {exc}")
    try:
        input("\nPress Enter to close…")  # keeps the window open after a double-click
    except EOFError:
        pass
