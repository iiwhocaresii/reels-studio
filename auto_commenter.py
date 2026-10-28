"""Posts the author's comment under the freshly published Reel (by default 1 minute after publishing).

Usage:
    python auto_commenter.py                          # text and Reel are looked up from work/pending.json
    python auto_commenter.py --media-id 123 --text-b64 ... --at 1767283260
"""

import argparse
import base64
import json
import sys
import time
from datetime import datetime, timedelta

import pytz

import config
from publisher import GraphClient, GraphError, fmt_unix, sleep_until

SKIP_MESSAGE = "No author comment found, the commenting step will be skipped."


def find_fresh_reel(client: GraphClient, caption: str | None, within_hours: int = 3) -> str | None:
    if caption:
        found = client.find_published(caption, within_hours=within_hours)
        if found:
            return found["id"]
    cutoff = datetime.now(pytz.utc) - timedelta(hours=within_hours)
    for m in client.recent_media(10):
        ts = datetime.strptime(m["timestamp"], "%Y-%m-%dT%H:%M:%S%z")
        if m.get("media_product_type") == "REELS" and ts >= cutoff:
            return m["id"]
    return None


def post_comment(media_id: str | None, text: str | None, at: float | None, caption: str | None = None) -> int:
    if not text or not text.strip():
        print(f"ℹ️  {SKIP_MESSAGE}")
        return 0

    client = GraphClient(config.require("GRAPH_API_ACCESS_TOKEN"), config.require("GRAPH_API_ACCOUNT_ID"))
    if at:
        sleep_until(at, "posting the comment")

    media_id = media_id or find_fresh_reel(client, caption)
    if not media_id:
        print("❌ Could not find the freshly published Reel, comment not posted.")
        return 1

    try:
        if any(t.strip() == text.strip() for t in client.comment_texts(media_id)):
            print("ℹ️  The same comment is already under the Reel, nothing to do.")
            return 0
    except GraphError as exc:
        print(f"⚠️  Could not check existing comments ({exc}), continuing.")

    comment_id = client.comment(media_id, text.strip())
    print(f"💬 Comment posted ({fmt_unix(time.time())}), id {comment_id}, media {media_id}.")
    config.gh_summary(f"💬 Author comment posted under Reel `{media_id}`.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Posts the author's comment under the Reel.")
    parser.add_argument("--media-id", help="ID of the published Reel (looked up if omitted)")
    parser.add_argument("--text", help="Comment text")
    parser.add_argument("--text-b64", help="Comment text as base64 (from GitHub Actions)")
    parser.add_argument("--at", type=float, help="Unix time at which to post the comment")
    args = parser.parse_args()

    text, caption = args.text, None
    if args.text_b64:
        text = base64.b64decode(args.text_b64).decode("utf-8")
    if text is None and config.PENDING_FILE.is_file():
        pending = json.loads(config.PENDING_FILE.read_text(encoding="utf-8"))
        text, caption = pending.get("author_comment"), pending.get("caption")
    return post_comment(args.media_id, text, args.at, caption)


if __name__ == "__main__":
    sys.exit(main())
