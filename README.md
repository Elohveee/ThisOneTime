# ThisOneTime

<img src="icons/icon-256.png" alt="ThisOneTime logo" width="128" height="128" align="left">

*This one time, at Bandcamp, I backed up my whole library.*

ThisOneTime is a Chrome extension that downloads the music you've purchased on Bandcamp, in your best available format, unzipped and ready to play.

**Note:** ThisOneTime relies on undocumented Bandcamp endpoints, so a site change may break it.

<br clear="left">

## Features

- **One-click backup** of your purchased library.
- **Format preference list:** rank your formats, and each release downloads once in the best one available.
- **Auto-unzip:** albums land in `<Artist>/<Title>/`, ready to play or sync to a remote backup.
- **Verified files:** every unzipped file is checked with CRC-32 while writing and again after saving.
- **Library controls:** search your releases, browse by page, ignore what you don't want, and redownload specific albums.
- **Resumable:** pause, close the tab, restart Chrome, and continue where you left off.
- **Private:** no analytics, no external servers, and no access to your password or cookies.
- **Readable:** a small, dependency-free codebase with detailed comments throughout.

## Install from source

You need Node.js 20 or newer, pnpm, and Chrome 122 or newer.

```bash
pnpm install
```

```bash
pnpm build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this project's `dist` folder.
3. Log in to Bandcamp in Chrome.
4. Click the ThisOneTime toolbar icon.

## Using it

1. Click **Choose backup folder** and pick a subfolder such as `Music/Bandcamp`.
2. Choose **Allow on every visit** when Chrome asks, so future runs need no extra click.
3. Adjust your format order if you like.
4. Click **Download library** and keep the ThisOneTime tab open.

Run it again later to pick up new purchases. Releases already backed up are skipped, even if you've since moved their files.

### Managing releases

- **Search** filters by artist or title.
- **Ignore** leaves a release out of backups without touching its files. **Stop ignoring** undoes it.
- **Redownload** queues a finished release using your current format order. Start it with the main button. If it fails, your existing files stay in place.

Pause a running backup before using row actions.

## Development

```bash
pnpm test
```

Read [How it works](docs/how-it-works.md) for a tour of the code, or the [mission brief](docs/mission.md) for design decisions and test results.

## Responsible use

ThisOneTime is for backing up music you bought, for your own personal use. It uses your normal logged-in browser session, limits its request rate, and never bypasses Bandcamp's security checks.

## Disclaimer

ThisOneTime is an independent project. It is not affiliated with or endorsed by Bandcamp, or by the makers of *American Pie*.

## License

[MIT](LICENSE)
