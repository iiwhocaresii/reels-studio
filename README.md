# Shorts → Reels

**Repost your YouTube Shorts to Instagram Reels automatically, on the days you choose.**

You pick a Short and a day in a point-and-click control panel. On that day, at your
publish time (e.g. 17:00 in your timezone), the Short goes live as an Instagram Reel with
the same title, description and tags as #hashtags. If you left your own comment under the
Short, the same comment is posted under the Reel a minute later.

Everything runs for free in **GitHub Actions**, so your computer doesn't have to be on.

Made by [PROOF OF DATA](https://www.youtube.com/@PROOFOFDATA) · works with any channel.

**📖 Illustrated step-by-step setup guide, every screen explained:** <https://proofofdata.pages.dev/reels>

---

## What you need

| | Cost | Where |
|---|---|---|
| A GitHub account | free | <https://github.com> |
| A YouTube Data API key | free | Google Cloud Console (step 3) |
| An Instagram **professional** account linked to a Facebook Page | free | Instagram settings |
| A Meta app + access token | free | Meta for Developers (step 4) |

No coding, no terminal. Setup takes about 20–30 minutes, mostly on the Meta side.

---

## Setup

### 1 · Open the control panel (Reels Studio)

Download this project (green **Code** button → **Download ZIP**), unzip it and
double-click **`panel/index.html`**. It opens in your browser (Chrome or Edge).

> Tip (Windows): right-click `panel/index.html` → *Send to → Desktop (create shortcut)*.

The panel walks you through the rest with a checklist.

**Desktop app (recommended on Windows/macOS with Python 3.10+):** run
`pip install -r requirements.txt` once, then start `python tools/studio.py`
(on Windows: a shortcut to `pythonw.exe tools\studio.py` hides the console). It opens the
same panel at <http://127.0.0.1:48765> and adds:
- **⬇️ Download my Shorts:** your newest Shorts go to `Downloads/Shorts`. New ones are also
  fetched automatically every time the app starts.
- **Automatic video attach:** select a Short in the Planner and its file is attached.
- **📂 Show in folder:** opens Explorer/Finder at the video.

It listens only on 127.0.0.1 and accepts actions only from its own page.

**Windows one-click install / another computer:** copy the project folder (without `.venv`
and `work`) and double-click **`Install Reels Studio.bat`**. It installs Python if needed,
the packages and a **Reels Studio** desktop shortcut. Everything else (keys, schedule, queue)
lives in your GitHub repository; on a new computer the panel only asks for your GitHub token
once.

### 2 · Create a private GitHub repository and a token

1. Create an **empty private** repository, e.g. `shorts-to-reels`
   (<https://github.com/new>; no README, no .gitignore, no license).
2. Create a **fine-grained personal access token**:
   <https://github.com/settings/personal-access-tokens/new>
   - *Repository access:* **Only select repositories** → your new repository
   - *Repository permissions:*
     - **Actions**: Read and write
     - **Contents**: Read and write
     - **Secrets**: Read and write
     - **Variables**: Read and write
     - **Workflows**: Read and write
3. Paste the repository name and token into the panel and press **Connect panel**.
4. In **Settings**, press **Upload / update project**. The panel copies all the files into
   your repository.

> The token stays in your browser on this computer only (you can turn remembering off),
> and it can access only this one repository.

### 3 · YouTube Data API key

1. Open <https://console.cloud.google.com/> and create a project (top bar → *New project*).
2. **APIs & Services → Library**: search **YouTube Data API v3** → **Enable**.
3. **APIs & Services → Credentials → + Create credentials → API key**.
4. **Edit API key → API restrictions → Restrict key → YouTube Data API v3** → Save.
   Leave *Application restrictions* on **None**: GitHub Actions has no fixed IP, and the
   panel runs from a local file.
5. Paste the key into the panel (**Settings → API keys**).

The free quota is 10,000 units per day; one scheduled Reel uses roughly 5–10.

### 4 · Instagram (Meta Graph API): token and account ID

**Before you start**
- Your Instagram account is **professional** (Creator or Business):
  *Settings → Account type and tools*.
- It's **linked to a Facebook Page**: *Meta Business Suite → Settings → Accounts → Instagram*.

**4a · Create a Meta app**
1. <https://developers.facebook.com/apps> → **Create app**.
2. Use case **Other**, type **Business**, connect it to your Business portfolio.
3. Add the product **Instagram → API setup with Facebook login**.
4. The app can stay in **development mode**. You publish to your own account, which has a
   role in the app, so no App Review is needed.

**4b · A token that never expires (System User)**
1. <https://business.facebook.com/settings> → **Users → System users → Add** (role *Admin*).
2. **Assign assets:** your Facebook Page, Instagram account and the app (full control).
3. **Generate new token**, choose your app, set expiry to **Never**, and select these permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `instagram_manage_comments`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management`
4. The token (starts with `EAA…`) is **`GRAPH_API_ACCESS_TOKEN`**.

> Alternative: the [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
> issues a user token. You'd have to exchange it for a long-lived (60-day) one and renew
> it, so the System User is easier.

**4c · Instagram account ID**

In the [Graph API Explorer](https://developers.facebook.com/tools/explorer/), paste your
token and run:

```
GET me/accounts?fields=name,instagram_business_account
```

`instagram_business_account.id` (a number like `17841…`) is **`GRAPH_API_ACCOUNT_ID`**.
With a System User token you can use `GET {page-id}?fields=instagram_business_account`.

Paste both values into the panel (**Settings → API keys**).

### 5 · Channel & schedule

In **Settings → Channel & schedule**:

1. Enter your channel as an **@handle**, a channel URL or a channel ID.
2. Pick your **timezone**; the panel pre-fills the one from your computer.
3. Pick a **publish time**; the default is 17:00.

The panel saves these and updates the publishing schedule in your repository.

### 6 · Access test

Press **Run access test** (Settings → Access test). It runs in the cloud, publishes nothing, and shows a ✅/❌ list
right in the panel.

### 7 · Optional: on-time publishing with cron-job.org

GitHub's own schedule is best-effort: runs can come hours late or be skipped on a busy day. A free
[cron-job.org](https://cron-job.org) job can start the publish workflow on time instead (GitHub's schedule
stays on as a backup; the never-publish-twice guards make extra runs harmless).

1. Create one more fine-grained token: only your repository, **Actions: Read and write**, nothing else.
2. On cron-job.org → **Create cronjob**:
   - **URL:** `https://api.github.com/repos/<owner>/<repo>/actions/workflows/publish.yml/dispatches`
   - **Schedule:** custom, every day at your publish time **minus 35 and minus 15 minutes**
     (17:00 → hours `16`, minutes `25` and `45`), **time zone** = your `TIMEZONE`.
   - **Advanced:** request method `POST`; headers `Accept: application/vnd.github+json`,
     `Authorization: Bearer <the token>`, `X-GitHub-Api-Version: 2022-11-28`; request body `{"ref":"main"}`
     (your default branch).
3. **Test run** → status **204** means it worked (Actions shows a new "2 · Publish scheduled Reel" run).

If you change the publish time in the panel, change the cron-job.org schedule too.

---

## Daily use

1. **Planner:** click a Short, then a day in the calendar, **📎 attach the video file**
   (the original export of your Short), then **Schedule**.
   > Why attach the file? YouTube blocks video downloads from GitHub's servers ("Sign in to
   > confirm you're not a bot"). Title, description, tags, comment and thumbnail still come
   > from YouTube automatically, only the video file comes from you. Without a file the tool
   > tries to download it from YouTube (works with cookies or a proxy, but unreliably).
   >
   > **Don't have the files at hand?** Run Reels Studio as a desktop app (below). It
   > downloads your Shorts from *your own* computer (only GitHub's servers are blocked)
   > and attaches the right file automatically. Or use YouTube Studio → Content → ⋮ → Download.
2. **Queue:** see what's coming up. You can **Cancel** a Reel or **Retry** one that failed.
3. **History:** what was published and when, with links.

**Publishing only happens on the days you choose:**
- Every Reel needs a day; nothing is ever published "at random".
- At most **one Reel per day**. A taken day can only be overwritten by ticking **Replace**.
- **A Short is never published twice.** Every published Short is recorded in
  `history/published.json` in your repository (permanently). A Short in it, or one already
  queued for another day, can't be scheduled, and right before publishing the whole
  Instagram profile is checked for the same caption. Posted a Short by hand? Select it in
  the Planner and click **Already on Instagram?**
- `#shorts` and similar YouTube-only hashtags are removed from the Instagram caption.
- You can schedule up to 88 days ahead.

---

## How it works

```
 [You] Planner → "Schedule"  (day + Short)
   │   runs workflow "1 · Schedule a Reel from a YouTube Short"
   ├─ YouTube Data API → title, description, tags → #hashtags, thumbnail (cover)
   ├─ YouTube Data API → your own comment under the Short (none → simply skipped)
   ├─ yt-dlp → 1080×1920 H.264 video + original AAC audio (no re-encoding)
   └─ stores the package as a GitHub artifact  reel-2026-10-28
                                  ⋮
 [Cron, 35 and 15 min before publish time]  workflow "2 · Publish scheduled Reel"
   ├─ takes ONLY the package dated today (none → exits in seconds)
   ├─ uploads the video straight to Meta (resumable upload) → waits for FINISHED
   ├─ at exactly the publish time → media_publish
   └─ job "comment" (only if you had a comment) → +1 min → POST /{media-id}/comments
```

> **Why not `scheduled_publish_time`?** The Instagram Graph API (unlike Facebook Pages)
> can't natively schedule Reels, and an uploaded container expires within 24 h. So the
> package stores the target time as a UTC unix timestamp and the workflow publishes it
> itself. The result is the same.

> **Why no temporary video hosting?** The Graph API supports *resumable upload*, which
> sends the video straight to Meta without a public URL. As a fallback there's
> `MEDIA_HOST=litterbox` (free anonymous hosting, deleted after 1 h) or `MEDIA_HOST=s3`
> (Cloudflare R2 / S3 with a presigned URL).

### Files

| File | Purpose |
|---|---|
| `panel/` | **Reels Studio** control panel (static HTML/CSS/JS, talks to the GitHub API) |
| `main.py` | CLI: `prepare`, `publish`, `status` |
| `youtube_client.py` | Latest Short, metadata, author comment, download via yt-dlp |
| `publisher.py` | Caption + hashtags, timing, Graph API, publishing |
| `auto_commenter.py` | Posts the comment under the Reel |
| `media_host.py` | Fallback temporary public hosting (litterbox / R2 / S3) |
| `config.py` | Configuration from `.env` / environment variables |
| `verify_setup.py` | Checks all credentials |
| `.github/workflows/prepare.yml` | **1 · Schedule a Reel**, manual / from the panel |
| `.github/workflows/publish.yml` | **2 · Publish scheduled Reel**, cron + comment |
| `.github/workflows/verify.yml` | **3 · Test connections** |

### Settings (GitHub → Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `YOUTUBE_API_KEY` | step 3 |
| `GRAPH_API_ACCESS_TOKEN` | step 4b |
| `GRAPH_API_ACCOUNT_ID` | step 4c |
| `YTDLP_COOKIES` | *optional*, see Troubleshooting |

| Variable | Default | |
|---|---|---|
| `YOUTUBE_CHANNEL_ID` | (required) | UC… ID, @handle or channel URL |
| `TIMEZONE` | `UTC` | IANA name, e.g. `Europe/Prague`, `America/New_York` |
| `PUBLISH_TIME` | `17:00` | 24-hour `HH:MM` |
| `COMMENT_DELAY_SECONDS` | `60` | delay of the comment after publishing |
| `COMMENT_MODE` | `youtube` | `youtube` = copy your comment from the Short, `template` = `COMMENT_TEMPLATE`, `off` |
| `COMMENT_TEMPLATE` | `▶️ Full video on YouTube: {full_video_url}`<br>`🔗 Link in bio` | `{full_video_url}` = first YouTube link in the Short's description (else your channel), also `{short_url}`, `{channel_url}`, `{title}` |
| `COVER_MODE` | `grid` | `grid` = YouTube thumbnail fitted into the area the profile grid shows (hosted ~1 h on Litterbox, Uguu or tmpfiles.org, falls back to `youtube`), `youtube` = thumbnail as is (grid crops it), `none` = Instagram picks a frame |
| `AI_LABEL` | `off` | default Instagram “AI info” label (`on`/`off`); changeable per Reel when scheduling |
| `MEDIA_HOST` | `resumable` | `litterbox` / `s3` fallbacks |
| `GRAPH_API_HOST` / `GRAPH_API_VERSION` | `graph.facebook.com` / `v24.0` | |

> The cron times in `publish.yml` must match `PUBLISH_TIME` and `TIMEZONE`. The panel
> rewrites them automatically. If you change the variables by hand, set the crons to
> 35 and 15 minutes before the publish time, in UTC, for both summer and winter offsets.

### Without the panel (command line)

```bash
python -m venv .venv && . .venv/bin/activate   # Windows: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt                # + ffmpeg and Deno (https://deno.com)
cp .env.example .env                           # fill in the keys
python verify_setup.py
python main.py prepare --publish-date 2026-10-30   # prepares, publishes nothing
python main.py status
python main.py publish --now                       # publishes RIGHT NOW (careful!)
```

---

## Troubleshooting

- **yt-dlp: "Sign in to confirm you're not a bot".** YouTube blocks downloads from GitHub's
  servers. The reliable fix is to **attach the video file** when scheduling. Alternatives: a paid
  residential proxy in the `YTDLP_PROXY` secret, or YouTube cookies, which work only sometimes.
  To give the workflow YouTube cookies: Export them this way, otherwise YouTube rotates
  them and they stop working within minutes:
  1. Install the Chrome extension **Get cookies.txt LOCALLY** and allow it in Incognito
     (`chrome://extensions` → Details).
  2. Open an **Incognito window**, go to youtube.com and sign in (ideally a secondary
     Google account).
  3. In the same window open a **new tab** with <https://www.youtube.com/robots.txt>, then
     **close the YouTube tab**, so robots.txt is the only tab.
  4. On the robots.txt tab click the extension → **Copy**, then close the Incognito window.
     Don't sign out.
  5. Paste the copied cookies into the panel (**API keys → YouTube cookies**) → **Save**.

  Cookies last weeks to months. When downloads start failing again, repeat the steps.
- **Cron runs late.** GitHub may delay scheduled workflows by tens of minutes, so they start
  35 and 15 minutes early. The video is uploaded in advance and published at exactly the
  publish time. Extra runs exit within seconds. On some days GitHub skips them entirely: set up
  [cron-job.org](#7--optional-on-time-publishing-with-cron-joborg). A missed Reel can still be published the
  same day (until 3 hours after the publish time): Actions → **2 · Publish scheduled Reel** → **Run workflow**
  with *Publish today's package right away* ticked.
- **GitHub Actions minutes.** Private repositories get 2,000 free minutes a month. A
  publishing day uses about 40 minutes; a day without a package uses about 4.
- **Cover.** The profile grid shows only the centre of a Reel cover (about 1012×1350 of
  1080×1920). With `COVER_MODE=grid` (default) the tool scales your whole YouTube thumbnail
  to the full height of that area (blurred fill only left and right), so nothing gets cut off
  and it fills the tile. The cover is rebuilt at publish time, so already queued Reels get
  layout fixes too.
- **Permission error (code 10 / 200).** The token is missing `instagram_content_publish`
  or `instagram_manage_comments`. Run the **access test** in the panel to see what's missing.

---

*Not affiliated with YouTube, Instagram or Meta. Respect the platforms' terms and repost
only content you own.*
