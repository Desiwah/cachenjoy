<h1 align="center">CacheNjoy</h1>

<p align="center"><b>CacheNjoy</b> is a self-hosted Stremio addon for Usenet. It searches your NZBHydra2 indexers, downloads the result you pick with SABnzbd, and streams the finished file straight from your own server. Once something is downloaded, replaying it is instant.</p>

&nbsp;

# **Overview**

⚡ **Instant replays**
Anything already downloaded shows a lightning icon and plays immediately from your own disk.

🔍 **Your own indexers**
All searches go through your NZBHydra2, so you stay in full control of your sources and your Usenet account.

📦 **One compose stack**
The addon, NZBHydra2, SABnzbd and a small isolated cleanup worker all ship together. No extra ports or subdomains needed - the Hydra and SABnzbd web UIs are reachable from the addon's own page, behind the same admin login.

🧹 **Auto-cleanup**
A separate container keeps your disk from filling up by deleting content that hasn't been used for a while. Optional and fully configurable.

🔒 **Single-operator by design**
Everyone who installs your manifest URL shares your Hydra, your SABnzbd and your Usenet account, so treat the install link like a password.

🧩 **Works with AIOStreams**
The addon returns instantly on search, so it slots into AIOStreams or any other aggregator without slowing it down. Install it there with the same manifest URL.

&nbsp;

# **How it works**

1. You open any content in Stremio and **CacheNjoy** asks Hydra what's available on your indexers.
2. You pick a result. **CacheNjoy** hands the NZB to SABnzbd and waits for the download to finish (Stremio shows a loader meanwhile).
3. When it's done, playback starts from the file on your disk. Results that are already downloaded show a lightning icon and play immediately.

&nbsp;

# **Installation**

All you need is Docker.

```
git clone https://github.com/Desiwah/cachenjoy
cd cachenjoy
cp .env.example .env      # fill in a files token, see the comments in that file
docker compose up -d --build
```

1. **Setup:** Open `http://your-server-ip:4040/configure` and set an admin password. Nothing is usable until that first password is set.
2. **Connect:** Follow the two steps on the page - Hydra URL/key and SABnzbd URL/key are mostly auto-detected since they run in the same stack.
3. **Done:** Pick your downloads folder, save, and the page gives you the install link for Stremio.

You need your own Usenet provider and indexers.

&nbsp;

> [!TIP]
> For anything beyond quick testing, put a reverse proxy with HTTPS in front - Caddy, nginx, whatever you already run - pointed at port 4040, and set `ADDON_BASE_URL` in `.env` to your domain instead of the IP. If your reverse proxy is itself a container, it's easier to join it to this stack's `web_network` and target the `cachenjoy` container by name instead of the published port - copy `compose.override.yaml.example` to `compose.override.yaml` for that.

&nbsp;

# **Auto-cleanup**

Downloads pile up, so a separate container watches the downloads folder and deletes anything that hasn't been used for N hours (using something resets its clock, and files currently being streamed are never touched). It can also clear out leftovers from failed downloads if you point it at SABnzbd's incomplete folder. All of it is optional and configured from the same page, including a "clear cache now" button.

The cleanup worker is deliberately its own container: the internet-facing addon has read-only access to your disk, and the only process with write access has no network at all.

&nbsp;

# **Notes**

* Settings live in a named volume, encrypted API keys at rest, and survive rebuilds.
* The install token can be regenerated from the configure page at any time if the link ever leaks.
* If a download fails (dead NZB, missing repair blocks), Stremio plays a short "stream failed, try another source" clip instead of spinning forever, and the partial files get cleaned up automatically.

&nbsp;

# **Support**

**CacheNjoy** is free and always will be. If it's made your life easier and you'd like to help keep it running and support my work, you can do so here:

[![Buy Me A Coffee](https://img.shields.io/badge/Support_the_Project-%23539764?style=for-the-badge&logo=buymeacoffee&logoColor=white)](https://donation.8520456.xyz)

Thank you! ❤️
