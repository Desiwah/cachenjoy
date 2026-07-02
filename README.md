# CacheNjoy

A self-hosted Stremio addon for Usenet. It searches your NZBHydra2 indexers,
downloads the release you pick with SABnzbd, then streams the finished file
straight from your own server. Once something is downloaded, replaying it is
instant.

Everything ships in one compose stack: the addon, NZBHydra2, SABnzbd, and a
small isolated cleanup worker that deletes old downloads on its own.

## How it works

1. You open a movie or episode in Stremio and CacheNjoy asks Hydra what's
   available on your indexers.
2. You pick a result. CacheNjoy hands the NZB to SABnzbd and waits for the
   download to finish (Stremio shows a loader meanwhile).
3. When it's done, playback starts from the file on your disk. Results that
   are already downloaded show a lightning icon and play immediately.

This is a single-operator setup. Everyone who installs your manifest URL
shares your Hydra, your SABnzbd and your Usenet account, so treat the install
link like a password. You need your own Usenet provider and indexers.

## Setup

All you need is Docker.

```
git clone https://github.com/YOURNAME/cachenjoy
cd cachenjoy
cp .env.example .env      # fill in a files token, see the comments in that file
docker compose up -d --build
```

Open `http://your-server-ip:4040/configure`, set an admin password, and
follow the two steps on the page - Hydra URL/key and SABnzbd URL/key are
mostly auto-detected since they run in the same stack. Pick your downloads
folder, save, and the page gives you the install link for Stremio. Nothing
is usable until that first admin password is set.

The Hydra and SABnzbd web UIs are reachable from the top bar of the same
page, behind the same admin login. No extra ports or subdomains needed.

If you want a real domain and HTTPS instead of a bare IP (recommended for
anything beyond quick testing), put a reverse proxy in front - Caddy, nginx,
whatever you already run - pointed at port 4040, and set `ADDON_BASE_URL`
in `.env` to your domain instead of the IP. If your reverse proxy is itself
a container, it's easier to join it to this stack's `web_network` and
target the `cachenjoy` container by name instead of the published port -
copy `compose.override.yaml.example` to `compose.override.yaml` for that.

## Auto-cleanup

Downloads pile up, so a separate container watches the downloads folder and
deletes anything that hasn't been played for N hours (playing something
resets its clock, and files currently being streamed are never touched).
It can also clear out leftovers from failed downloads if you point it at
SABnzbd's incomplete folder. All of it is optional and configured from the
same page, including a "clear cache now" button.

The cleanup worker is deliberately its own container: the internet-facing
addon has read-only access to your disk, and the only process with write
access has no network at all.

## Works with AIOStreams

The addon returns instantly on search, so it slots into AIOStreams or any
other aggregator without slowing it down. Install it there with the same
manifest URL.

## Notes

- Settings live in a named volume, encrypted API keys at rest, and survive
  rebuilds.
- The install token can be regenerated from the configure page at any time
  if the link ever leaks.
- If a download fails (dead NZB, missing repair blocks), Stremio plays a
  short "stream failed, try another source" clip instead of spinning
  forever, and the partial files get cleaned up automatically.
