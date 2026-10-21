# Badge Printer

A mobile-friendly web app for making conference name badges and printing them on a thermal label printer. You open it in a browser; there's nothing to install. The layout, event details and logo are all configurable through a YAML file.

**Live app:** `https://jlabounty.github.io/badge-printer-2026/` (after GitHub Pages is enabled)

---

## Features

- **4×3″ landscape badge, 250 dpi by default.** It exports a 1000×750 PNG. Size, DPI and rotation are all configurable.
- **Contents:** the conference logo, then the full name and affiliation centred beneath it, plus an optional profile URL rendered as a QR code in the bottom corner. Pronouns are optional and, when filled in, print in italics between the name and affiliation.
- **Optional banner strip:** Speaker, Sponsor, Staff, Volunteer or Organizer, or type your own.
- **Pronoun picker:**
  - Select several common options, plus fill-in-the-blank entries.
  - Sets that share a form are merged and deduplicated: `he/they` + `she/they` + `they/them` gives **he/she/they/them**.
  - Unrelated sets stay separate: `she/they · fae/faer`.
  - Each form can be reordered (‹ ›), e.g. `he/they` to `they/he`.
  - The final text on the badge can also be edited directly.
- **Colour modes:** greyscale (default), black & white (threshold, with optional dithering for logos), or colour.
- **Batch mode:**
  - Import a CSV, then step through the queue with **Share & next**. Each badge is marked ✓ once it's sent.
  - **Share all** sends every badge in one share (if the printer app accepts multiple images).
  - **Download all** saves every badge as one `.zip` of PNGs.
  - Rows can be edited or removed. The queue survives a reload.
- **Settings menu (⚙):**
  - Every setting is editable there: printer, event text and logo, form fields and pronoun list.
  - It includes a raw **Layout YAML** editor with import/export and reset.
  - Everything is saved in this browser's local storage.
- **Keeps working if Wi-Fi drops.** A service worker caches the app after the first load.

---

## Printing with Jadens LabelPrint (Android)

1. Fill in the badge, then tap **Share to printer**.
2. Pick **Jadens LabelPrint** from the Android share sheet.
3. In the Jadens app, choose the 4×3 label size and print.

If sharing isn't available (for example in desktop browsers), use **Download PNG** and open the image from the Jadens app.

**Tips:**
- If the print comes out sideways, set **Settings → Printer → Rotate exported PNG**.
- If text near the edge gets clipped, increase **Safe inset**.
- If grey areas print blotchy, switch to **Black & white**.

---

## Batch / kiosk use

- **Single mode** is for walk-ups. "Clear / next attendee" resets the form. "Remember my info" is off by default, so a kiosk doesn't keep the previous person's details.
- **Batch mode** imports attendees from:
  - an Excel `.xlsx` file, such as a Whova attendee export
  - a `.csv` file
  - cells pasted from Excel or Google Sheets

  A **column mapping** step then shows which column feeds each badge field:
  - **Sheet and header row:** it picks the sheet and header row automatically, skipping any title rows above the header.
  - **Column guesses:** it guesses each column from the header text. "Affiliation" goes to company, a column containing "pronoun" to pronouns, "LinkedIn" to the QR URL, and "Ticket Type" or "Category" to the banner. Separate First and Last name columns are joined.
  - **Banner values:** it turns each ticket or category value into a banner. "Keynote Speaker" becomes Speaker and "Exhibitor – Gold" becomes Sponsor. "General Admission" gets no banner, or you can keep the original text.
  - **Row filter (optional):** e.g. *Check-in Status is "Checked in"*.
  - **Preview:** shows the first rows before you import, and whether they'll replace or be added to the current queue.

  Your choices are remembered by column name, so the next export from the same source maps itself. Multiple pronoun sets in one cell (comma, semicolon or `·` separated) are merged the same way as in the picker. URLs without `https://` get it added. Old binary `.xls` files aren't supported; save them as `.xlsx` or `.csv`. See [`sample.csv`](sample.csv):

  ```csv
  name,pronouns,company,url,role
  Ada Lovelace,she/her,Analytical Engines Ltd.,https://www.linkedin.com/in/example-ada,Speaker
  Jordan Kim,"she/they, he/they",Bletchley Labs,https://example.com/jordan,Sponsor
  ```

---

## Layout YAML reference

The shipped default is [`badge.yaml`](badge.yaml). Edits made in the app are stored on that device; use **Export .yaml** to save them and commit them back here.

All positions and sizes are in **inches from the top-left** of the badge. A value can also be a percentage string like `"50%"`, which is relative to the badge width (x, w) or height (y, h).

| Section | Keys |
|---|---|
| `canvas` | `width_in`, `height_in`, `dpi`, `rotate_output` (0/90/180/270), `bleed_in` (shrinks the layout inward) |
| `output` | `color_mode` (`greyscale`/`bw`/`color`), `bw_threshold` (0–255), `bw_dither`, `filename` (template) |
| `fonts` | `family` (CSS font stack) |
| `vars` | Free text values usable as `{key}` in text elements (e.g. `event`, `event_sub`) |
| `fields` | Form fields: `key`, `label`, `type` (`text`/`url`/`pronouns`/`select`/`textarea`), `required`, `placeholder`, `hint`, `hidden`; for `select`: `options`, `allow_custom` |
| `pronoun_options` | Chips shown in the pronoun picker |
| `pronoun_joiner` | Separator between unrelated pronoun sets/phrases (default `" · "`) |
| `elements` | Drawn in order (see below) |

**Element types** (all take `x`, `y`, and most take `w`, `h`):

- `text`: either `field: <key>` or `text: "literal {var}"`.
  - Font: `size` (start size, inches), `min_size`, `max_lines`, `line_height`.
  - Style: `weight`, `style: italic`, `color`, `transform: uppercase`, `letter_spacing` (em).
  - Position: `align` (left/center/right), `valign` (top/middle/bottom).
  - `prefix`/`suffix` add text around the value.
  - Text shrinks to fit the box, wraps (breaking after hyphens if needed), and then ends with "…".
- `image`: `src` (a site path, a CORS-enabled URL, or `upload:logo` for a logo uploaded in Settings).
  - `fit` (`contain`/`cover`/`fill`), `align`, `valign`.
  - Give it `id: logo` so the Settings → Event tab can edit it.
- `qr`: `field` or `text`, `size`, `quiet_zone` (modules, default 4), `ec_level` (L/M/Q/H), `align`/`valign` (default bottom-right of its box). Modules snap to whole pixels so the code stays crisp.
- `line`: `w` (horizontal) or `h` (vertical), `thickness`, `color`.
- `rect`: `w`, `h`, `fill`, `stroke`, `stroke_width`, `radius`.

**Conditions** (any element):

- `if: <field>` draws the element only when that field has a value.
- `unless: <field>` draws it only when the field is empty.
- `when: { <field>: { y: 1.9, h: 0.6 } }` overrides keys when the field has a value. The default layout uses this to make room for the banner.

### Logo

- Put the official logo (SVG or a high-contrast PNG works best) in `assets/` and point the `logo` element's `src` at it.
- Or upload it on a device through **Settings → Event → Upload logo**.
- Remote URLs only work if their server sends CORS headers. Otherwise the logo is left off and the app shows a warning.

---

## Local development

There's no build step. Serve the folder over HTTP: the app fetches `badge.yaml`, so opening it from `file://` won't work.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

The Web Share API needs HTTPS (or localhost) and a mobile browser. Test the share-to-printer flow on a phone against the GitHub Pages URL.

## GitHub Pages deployment

1. Push `main` to GitHub.
2. **Settings → Pages → Deploy from a branch**, choose `main` and `/ (root)`.

## Project structure

```
badge-printer-2026/
├── index.html        markup
├── style.css         mobile-first styles
├── badge.yaml        default badge layout/config
├── sample.csv        example batch import
├── sw.js             offline cache (network-first)
├── assets/           event logo, favicon
├── vendor/           js-yaml 4.1.0, qrcode-generator 1.4.4 (vendored so no CDN is needed at the venue)
└── js/
    ├── config.js     YAML load/validate, localStorage
    ├── pronouns.js   pronoun merge/order + picker widget
    ├── render.js     canvas layout engine, QR, colour modes, PNG export
    ├── share.js      Web Share API + downloads
    ├── zip.js        tiny zip writer for Download all
    ├── batch.js      CSV parsing + print queue
    ├── xlsx.js       minimal .xlsx reader (no library)
    ├── importer.js   column-mapping import dialog
    ├── settings.js   settings drawer
    └── app.js        form + wiring
```
