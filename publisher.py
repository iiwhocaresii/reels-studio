"""Instagram Graph API: caption, timing (PUBLISH_TIME in TIMEZONE) and publishing the Reel."""

import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import pytz
import requests

import config

TRANSIENT_CODES = {1, 2, 4, 17, 32, 613}


# ---------------------------------------------------------------- timing
def parse_date(value: str, today: date | None = None) -> date:
    """Accepts 2026-10-28, 28.10.2026, or "today" / "tomorrow"."""
    value = value.strip().replace(" ", "")
    today = today or datetime.now(pytz.timezone(config.TIMEZONE)).date()
    relative = {"today": 0, "tomorrow": 1}
    if value.lower() in relative:
        return today + timedelta(days=relative[value.lower()])
    for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    raise SystemExit(f"❌ Invalid date '{value}', use YYYY-MM-DD (e.g. 2026-10-28).")


def compute_publish_time(publish_date: str | None = None, now: datetime | None = None) -> datetime:
    """Returns the local datetime of PUBLISH_TIME tomorrow, or on the given day.

    pytz.localize picks the correct UTC offset for that date (e.g. CET vs. CEST).
    """
    tz = pytz.timezone(config.TIMEZONE)
    now_local = (now or datetime.now(pytz.utc)).astimezone(tz)
    day = parse_date(publish_date, now_local.date()) if publish_date else now_local.date() + timedelta(days=1)
    hour, minute = (int(x) for x in config.PUBLISH_TIME.split(":"))
    return tz.localize(datetime(day.year, day.month, day.day, hour, minute, 0))


def to_unix(dt: datetime) -> int:
    return int(dt.astimezone(pytz.utc).timestamp())


def fmt_unix(ts: float) -> str:
    tz = pytz.timezone(config.TIMEZONE)
    return datetime.fromtimestamp(ts, tz).strftime("%Y-%m-%d %H:%M:%S %Z")


def sleep_until(ts: float, label: str) -> None:
    remaining = ts - time.time()
    if remaining <= 0:
        return
    print(f"⏳ Waiting {int(remaining)} s until {fmt_unix(ts)} ({label})…", flush=True)
    while (remaining := ts - time.time()) > 0:
        time.sleep(min(remaining, 300))
        if ts - time.time() > 1:
            print(f"   …{int(ts - time.time())} s left", flush=True)


# ---------------------------------------------------------------- caption
# YouTube-only hashtags that mean nothing on Instagram.
YT_ONLY_TAGS = {"shorts", "short", "ytshorts", "youtubeshorts", "shortsvideo", "youtubeshort"}
_YT_ONLY_RE = re.compile(r"(?<![\w#])#(?:" + "|".join(sorted(YT_ONLY_TAGS, key=len, reverse=True)) + r")\b", re.IGNORECASE)


def strip_youtube_only_tags(text: str) -> str:
    text = _YT_ONLY_RE.sub("", text or "")
    lines = [re.sub(r"[ \t]{2,}", " ", line).strip() for line in text.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def build_comment(youtube_comment: str | None, full_video_url: str | None, short_url: str, channel_url: str, title: str) -> str | None:
    """Text of the comment posted under the Reel, according to COMMENT_MODE."""
    if config.COMMENT_MODE == "off":
        return None
    if config.COMMENT_MODE == "template":
        values = {"full_video_url": full_video_url or channel_url, "short_url": short_url,
                  "channel_url": channel_url, "title": strip_youtube_only_tags(title)}
        text = re.sub(r"\{(\w+)\}", lambda m: values.get(m.group(1), m.group(0)), config.COMMENT_TEMPLATE)
        return text.strip() or None
    return youtube_comment


def tags_to_hashtags(tags: list[str]) -> list[str]:
    seen, result = set(), []
    for tag in tags:
        if re.sub(r"\W+", "", tag).lower() in YT_ONLY_TAGS:
            continue
        # "on chain data" → OnChainData; \w also matches accented letters
        words = [w for w in re.split(r"[^\w]+", tag) if w]
        clean = "".join(w[:1].upper() + w[1:] for w in words) if len(words) > 1 else "".join(words)
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            result.append(clean)
    return result


def build_caption(title: str, description: str, tags: list[str]) -> str:
    """Title + description + tags as #hashtags, within Instagram's limits (without #shorts & co.)."""
    title, description = strip_youtube_only_tags(title), strip_youtube_only_tags(description)
    parts = [title.strip()]
    if description.strip() and not description.strip().startswith(title.strip()):
        parts.append(description.strip())
    elif description.strip():
        parts = [description.strip()]
    body = "\n\n".join(p for p in parts if p)

    existing = {h.lower() for h in re.findall(r"#(\w+)", body)}
    free_slots = max(0, config.CAPTION_MAX_HASHTAGS - len(existing))
    if len(existing) > config.CAPTION_MAX_HASHTAGS:
        print(f"⚠️  The description already has {len(existing)} hashtags, Instagram allows max. 30.")
    hashtags = [h for h in tags_to_hashtags(tags) if h.lower() not in existing][:free_slots]
    tag_line = " ".join(f"#{h}" for h in hashtags)

    caption = f"{body}\n\n{tag_line}".strip() if tag_line else body
    if len(caption) > config.CAPTION_MAX_CHARS:
        room = config.CAPTION_MAX_CHARS - len(tag_line) - 3
        body = body[: max(0, room)].rstrip() + "…"
        caption = f"{body}\n\n{tag_line}".strip()[: config.CAPTION_MAX_CHARS]
        print("⚠️  Caption trimmed to 2200 characters (Instagram limit).")
    return caption


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:300]


# ---------------------------------------------------------------- Graph API
class GraphError(RuntimeError):
    def __init__(self, payload: dict, status: int):
        err = payload.get("error", payload)
        self.code = err.get("code")
        self.subcode = err.get("error_subcode")
        self.transient = bool(err.get("is_transient")) or self.code in TRANSIENT_CODES or status >= 500
        msg = err.get("error_user_msg") or err.get("message") or str(payload)
        super().__init__(f"Graph API {status} (code {self.code}/{self.subcode}): {msg}")


class GraphClient:
    def __init__(self, token: str, account_id: str):
        self.token = token
        self.account_id = account_id
        self.base = f"https://{config.GRAPH_API_HOST}/{config.GRAPH_API_VERSION}"

    def request(self, method: str, path: str, retries: int = 3, **params) -> dict:
        params["access_token"] = self.token
        url = f"{self.base}/{path.lstrip('/')}"
        for attempt in range(retries + 1):
            try:
                if method == "GET":
                    resp = requests.get(url, params=params, timeout=60)
                else:
                    resp = requests.post(url, data=params, timeout=120)
                payload = resp.json() if resp.content else {}
                if resp.ok and "error" not in payload:
                    return payload
                error = GraphError(payload, resp.status_code)
            except (requests.ConnectionError, requests.Timeout, ValueError) as exc:
                error = GraphError({"message": str(exc), "is_transient": True}, 0)
            if not error.transient or attempt == retries:
                raise error
            wait = 10 * (attempt + 1)
            print(f"   ↻ transient error, retrying in {wait} s: {error}")
            time.sleep(wait)
        raise AssertionError("unreachable")

    # --- account info ---
    def account_info(self) -> dict:
        return self.request("GET", self.account_id, fields="id,username,name,media_count")

    def publishing_limit(self) -> dict:
        return self.request(
            "GET", f"{self.account_id}/content_publishing_limit", fields="config,quota_usage"
        )

    def recent_media(self, limit: int = 10) -> list[dict]:
        resp = self.request(
            "GET",
            f"{self.account_id}/media",
            fields="id,caption,media_type,media_product_type,timestamp,permalink",
            limit=limit,
        )
        return resp.get("data", [])

    def all_media(self, max_items: int = 500):
        """Yields the account's posts, newest first (paginated)."""
        params = {"fields": "id,caption,media_type,media_product_type,timestamp,permalink", "limit": 100}
        seen = 0
        while True:
            resp = self.request("GET", f"{self.account_id}/media", **params)
            for m in resp.get("data", []):
                yield m
                seen += 1
                if seen >= max_items:
                    return
            after = resp.get("paging", {}).get("cursors", {}).get("after")
            if not after or "next" not in resp.get("paging", {}):
                return
            params["after"] = after

    def find_published(self, caption: str, within_hours: int | None = None) -> dict | None:
        """Double-publish guard: looks for a post with the same caption (whole profile by default)."""
        cutoff = datetime.now(pytz.utc) - timedelta(hours=within_hours) if within_hours else None
        for m in self.all_media(15 if within_hours else 500):
            ts = datetime.strptime(m["timestamp"], "%Y-%m-%dT%H:%M:%S%z")
            if cutoff and ts < cutoff:
                break
            if _normalize(m.get("caption", "")) == _normalize(caption):
                return m
        return None

    def permalink(self, media_id: str) -> str:
        return self.request("GET", media_id, fields="permalink").get("permalink", "")

    # --- publishing ---
    def create_reel_container(
        self, caption: str, cover_url: str | None, video_url: str | None = None, ai_generated: bool = False
    ) -> dict:
        params = {"media_type": "REELS", "caption": caption, "share_to_feed": "true"}
        if ai_generated:
            params["is_ai_generated"] = "true"  # Instagram's "AI info" label, only settable here
        if cover_url:
            params["cover_url"] = cover_url
        if video_url:
            params["video_url"] = video_url
        else:
            params["upload_type"] = "resumable"
        return self.request("POST", f"{self.account_id}/media", retries=1, **params)

    def upload_resumable(self, container: dict, path: Path) -> None:
        upload_url = container.get("uri") or (
            f"https://rupload.facebook.com/ig-api-upload/{config.GRAPH_API_VERSION}/{container['id']}"
        )
        size = path.stat().st_size
        headers = {"Authorization": f"OAuth {self.token}", "offset": "0", "file_size": str(size)}
        with path.open("rb") as fh:
            resp = requests.post(upload_url, headers=headers, data=fh, timeout=900)
        if not resp.ok or not resp.json().get("success", False):
            raise RuntimeError(f"Resumable upload failed (HTTP {resp.status_code}): {resp.text[:500]}")

    def container_status(self, container_id: str) -> dict:
        return self.request("GET", container_id, fields="status_code,status")

    def wait_until_finished(self, container_id: str, timeout: int = 900, interval: int = 20) -> None:
        deadline = time.time() + timeout
        while True:
            st = self.container_status(container_id)
            code = st.get("status_code")
            print(f"   container status: {code}", flush=True)
            if code == "FINISHED":
                return
            if code in ("ERROR", "EXPIRED"):
                raise RuntimeError(f"Instagram failed to process the video: {st.get('status')}")
            if time.time() > deadline:
                raise TimeoutError("Instagram did not process the video within 15 minutes.")
            time.sleep(interval)

    def publish_container(self, container_id: str) -> str:
        return self.request("POST", f"{self.account_id}/media_publish", retries=0, creation_id=container_id)["id"]

    def comment(self, media_id: str, message: str) -> str:
        return self.request("POST", f"{media_id}/comments", retries=2, message=message)["id"]

    def comment_texts(self, media_id: str) -> list[str]:
        resp = self.request("GET", f"{media_id}/comments", fields="text", limit=50)
        return [c.get("text", "") for c in resp.get("data", [])]


# ---------------------------------------------------------------- full flow
def publish_reel(
    client: GraphClient,
    video_path: Path,
    caption: str,
    cover_url: str | None,
    publish_at: float,
    ai_generated: bool = False,
) -> str:
    """Uploads the video, waits for FINISHED, waits until publish_at and publishes. Returns media_id."""
    if config.MEDIA_HOST == "resumable":
        print("📤 Creating REELS container (resumable upload)…")
        container = client.create_reel_container(caption, cover_url, ai_generated=ai_generated)
        print(f"📤 Uploading {video_path.stat().st_size / 1_048_576:.1f} MB straight to Meta…")
        client.upload_resumable(container, video_path)
    else:
        import media_host

        print(f"📤 Uploading the video to temporary hosting ({config.MEDIA_HOST})…")
        video_url = media_host.upload_public(video_path)
        print("📤 Creating REELS container (video_url)…")
        container = client.create_reel_container(caption, cover_url, video_url=video_url, ai_generated=ai_generated)

    container_id = container["id"]
    print(f"   container {container_id}, waiting for status FINISHED…")
    client.wait_until_finished(container_id)
    print("✅ Video processed and ready.")

    sleep_until(publish_at, "publishing the Reel")
    try:
        media_id = client.publish_container(container_id)
    except GraphError:
        # If publishing actually succeeded (dropped connection), don't publish twice.
        if client.container_status(container_id).get("status_code") == "PUBLISHED":
            found = client.find_published(caption, within_hours=1)
            if found:
                return found["id"]
        raise
    return media_id
