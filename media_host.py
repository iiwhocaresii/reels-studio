"""Fallback temporary public video hosting (only when MEDIA_HOST != resumable).

The Graph API downloads the video from a public URL (the video_url parameter).
The default "resumable" mode doesn't need that URL: the video is uploaded straight to Meta.
"""

from pathlib import Path

import requests

import config

LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php"
UGUU_API = "https://uguu.se/upload"  # files kept ~3 h
TMPFILES_API = "https://tmpfiles.org/api/v1/upload"  # files kept 60 min
UA = {"User-Agent": "Mozilla/5.0 (compatible; ReelsStudio/1.0)"}


def upload_litterbox(path: Path, expire: str = "1h", mimetype: str = "video/mp4") -> str:
    """Free anonymous hosting; the file deletes itself after 1/12/24/72 h."""
    with path.open("rb") as fh:
        resp = requests.post(
            LITTERBOX_API,
            data={"reqtype": "fileupload", "time": expire},
            files={"fileToUpload": (path.name, fh, mimetype)},
            headers=UA,
            timeout=600,
        )
    resp.raise_for_status()
    url = resp.text.strip()
    if not url.startswith("https://"):
        raise RuntimeError(f"Litterbox returned an unexpected response: {url[:200]}")
    return url


def upload_uguu(path: Path, mimetype: str) -> str:
    with path.open("rb") as fh:
        resp = requests.post(UGUU_API, files={"files[]": (path.name, fh, mimetype)}, headers=UA, timeout=600)
    resp.raise_for_status()
    url = resp.json()["files"][0]["url"]
    if not url.startswith("https://"):
        raise RuntimeError(f"Uguu returned an unexpected response: {url[:200]}")
    return url


def upload_tmpfiles(path: Path, mimetype: str) -> str:
    with path.open("rb") as fh:
        resp = requests.post(TMPFILES_API, files={"file": (path.name, fh, mimetype)}, headers=UA, timeout=600)
    resp.raise_for_status()
    url = resp.json()["data"]["url"].replace("http://", "https://")
    # The returned link is an HTML page; /dl/ is the file itself.
    return url.replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/", 1)


def upload_temporary(path: Path, mimetype: str) -> str:
    """Public URL for about an hour, trying several free hosts (one may block GitHub's servers)."""
    errors = []
    for name, upload in (
        ("Litterbox", lambda: upload_litterbox(path, "1h", mimetype)),
        ("Uguu", lambda: upload_uguu(path, mimetype)),
        ("tmpfiles.org", lambda: upload_tmpfiles(path, mimetype)),
    ):
        try:
            url = upload()
            verify_public_url(url)
            return url
        except Exception as exc:  # noqa: BLE001 – try the next host
            errors.append(f"{name}: {exc}")
    raise RuntimeError("; ".join(errors))


def upload_s3(path: Path, expires_seconds: int = 3600) -> str:
    """Cloudflare R2 / AWS S3: uploads the file and returns a presigned URL valid for 1 h."""
    try:
        import boto3
    except ImportError as exc:
        raise SystemExit("❌ MEDIA_HOST=s3 needs boto3 (pip install boto3).") from exc

    bucket = config.require("S3_BUCKET")
    key = f"reels/{path.name}"
    s3 = boto3.client(
        "s3",
        endpoint_url=config.env("S3_ENDPOINT_URL") or None,  # R2: https://<account>.r2.cloudflarestorage.com
        aws_access_key_id=config.require("S3_ACCESS_KEY_ID"),
        aws_secret_access_key=config.require("S3_SECRET_ACCESS_KEY"),
        region_name=config.env("S3_REGION", "auto"),
    )
    s3.upload_file(str(path), bucket, key, ExtraArgs={"ContentType": "video/mp4"})
    return s3.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expires_seconds
    )


def verify_public_url(url: str) -> None:
    """Checks that the URL really is publicly reachable (the way Meta will see it)."""
    resp = requests.get(url, stream=True, timeout=60, headers={"Range": "bytes=0-1023", **UA})
    resp.close()
    if resp.status_code not in (200, 206):
        raise RuntimeError(f"Temporary URL is not reachable (HTTP {resp.status_code}): {url}")


def upload_public(path: Path) -> str:
    if config.MEDIA_HOST == "litterbox":
        url = upload_litterbox(path)
    elif config.MEDIA_HOST == "s3":
        url = upload_s3(path)
    else:
        raise ValueError(f"Unknown MEDIA_HOST: {config.MEDIA_HOST}")
    verify_public_url(url)
    return url
