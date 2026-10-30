"""Cover image that survives Instagram's profile grid crop.

The profile grid shows only the centre of a Reel cover: 1080x1440 px of a 1080x1920 cover
(a 3:4 crop of the full width, measured on real posts, Oct 2026). YouTube stores a Short's custom
thumbnail as a 16:9 image with the vertical design in the middle, so we cut that design out, scale
it to the full height of the grid-visible box (blurred fill shows only left and right of it in the
grid) and fill the rest of the 9:16 cover with a blurred copy.
"""

import subprocess
from pathlib import Path

import requests

from youtube_client import ffmpeg_path

COVER_W, COVER_H = 1080, 1920
GRID_BOX_H = 1440  # grid-visible area: 1080x1440, vertically centred
GRID_BOX_TOP = (COVER_H - GRID_BOX_H) // 2


def make_grid_cover(thumbnail_url: str, output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    source = output.with_name("thumbnail-source.jpg")
    resp = requests.get(thumbnail_url, timeout=60)
    resp.raise_for_status()
    source.write_bytes(resp.content)

    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found (pip install imageio-ffmpeg)")
    # Landscape thumbnail → take its centre 9:16 (the Short's own design); portrait → use as is.
    design = "crop='if(gt(iw/ih,9/16),ih*9/16,iw)':'if(gt(iw/ih,9/16),ih,iw*16/9)'"
    graph = (
        f"[0]{design},split[a][b];"
        f"[a]scale={COVER_W}:{COVER_H},boxblur=30:3,eq=brightness=-0.12[bg];"
        f"[b]scale=-2:{GRID_BOX_H}:flags=lanczos[fg];"
        f"[bg][fg]overlay=(W-w)/2:{GRID_BOX_TOP},setsar=1"
    )
    subprocess.run(
        [ffmpeg, "-loglevel", "error", "-y", "-i", str(source), "-filter_complex", graph, "-q:v", "2", str(output)],
        check=True,
    )
    source.unlink(missing_ok=True)
    return output
