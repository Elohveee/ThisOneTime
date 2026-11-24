# How ThisOneTime Works

This is a plain-language tour of the code. Every source file also opens with a comment explaining its purpose.

## The big picture

ThisOneTime is one extension page. Clicking the toolbar icon opens it in a tab, and that tab does all the work using your normal Bandcamp login.

```text
Find you → Scan your purchases → Pick a format → Download → Unzip → Verify → Remember
```

## 1. Find you

`bandcamp.ts` loads the Bandcamp homepage and reads your fan ID from its page data. Your browser sends its usual login session, so the extension never sees your password or reads your cookies.

## 2. Scan your purchases

`bandcamp.ts` pages through your collection. `bandcamp-data.ts` validates each item and copies only the fields ThisOneTime needs. Bandcamp's data also contains payment and gift details, which are deliberately left behind.

`library.ts` merges each scan with your saved progress, so finished releases stay finished and new purchases join the queue.

## 3. Pick a format

`formats.ts` walks your preference list and picks the first enabled format Bandcamp offers for that release. Each release downloads in exactly one format.

## 4. Download

`queue.ts` runs three workers. Each claims the next pending release, and `bandcamp.ts` spaces out all requests so Bandcamp is not overloaded.

If Bandcamp asks us to slow down, shows a security check, or logs you out, the queue pauses and tells you what to do. It never tries to get around a security check.

## 5. Save and unzip

`files.ts` streams each download into the folder you chose. Chrome only finalizes a file when its stream closes successfully, so an interrupted transfer never looks complete.

For albums, `zip.ts` reads the ZIP's table of contents and refuses anything unsafe, such as a path trying to escape its folder.

## 6. Verify

Every unzipped file is checked twice with a CRC-32 checksum: once while it is written and again by reading it back from disk. The temporary ZIP is deleted only after every file passes.

| Problem | What happens |
| :--- | :--- |
| Damaged download | Partial files are removed and the download is retried |
| Unsupported or suspicious ZIP | The original ZIP is kept and flagged |
| Expired link | The release is flagged with a link for you to confirm it |
| No enabled format available | The release is flagged and nothing is downloaded |

## 7. Remember

`storage.ts` saves your settings, progress, and chosen folder in this Chrome profile using IndexedDB. If the tab closes, `library.ts` returns unfinished releases to the queue the next time it opens.

## Managing individual releases

`release-actions.ts` holds the rules for ignoring and redownloading. `view-releases.ts` applies the filter, search, and page, in that order, using `pagination.ts`. `list-controls.ts` connects those controls to the page.

- **Ignore** stores the release's key on the library, so the choice survives rescans. Files are never touched.
- **Redownload** puts a finished release back in the queue while remembering its earlier result, so **Cancel** can restore it.
- **File safety:** when an attempt fails, `files.ts` removes only files that attempt created. Files that already existed stay.

## Keeping long backups alive

- `timer-worker.ts` keeps request pacing working while the tab is in the background.
- `tab.ts` allows only one ThisOneTime tab to run the queue, and asks Chrome not to discard it.

## Where to start reading

1. `types.ts` for the vocabulary.
2. `formats.ts` and `library.ts` for simple, pure rules.
3. `queue.ts` for the main loop.
4. `bandcamp.ts`, `files.ts`, and `zip.ts` for the detailed work.
5. `app.ts` and `view.ts` for the interface.
