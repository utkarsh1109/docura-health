# Docura Health — Claims Copilot

A read-only browser extension that sits on top of Northstar (or any claims
portal) purely through its rendered pages — no API, no source access needed.
It automatically tells you which open claims still have outstanding
requirements, right on the claims list itself, without opening each one.

It never clicks or submits anything in Northstar. It only reads the page.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open a claim page in Northstar, then click the Docura Health icon in the
   toolbar to inject the sidebar (a tab appears on the right edge of the page).

## One-time setup

The very first time you use it on a given claims system, the sidebar walks
you through two quick clicks — because there's no API or documentation to
read, the only way the extension can learn where things are is if a person
points at them once:

1. **Show it the Requirements table.** Open any one claim, click its
   Requirements tab, then follow the on-screen prompt: click one example
   status cell (e.g. "Open") and one example description cell.
2. **Show it the claims list.** On the main claims list page, click one claim
   number link, then click that same row's Current Status cell.

That's it — this never needs to be repeated unless Northstar's screen layout
changes.

## What happens after setup

- The moment you open the sidebar on the claims list, it automatically loads
  every visible claim in the background (a hidden, invisible copy of each
  page — not an API call), clicks into its Requirements tab exactly like a
  person would, and reads what's still open. No further clicking required.
- Every claim number on the list gets a small badge right there on
  Northstar's own page: **red "N pending"**, **green "clear"**, **amber "no
  requirements listed"** (still Open, but nothing's been entered yet — worth
  a second look), or **grey "not checked yet"** while a check is still in
  progress.
- Click any badge at any time to force an immediate re-check and see a popup
  with the specific outstanding items for that claim.
- The sidebar itself shows a **Claims overview** — the same information
  grouped into Pending / Clear / Not checked yet, each claim clickable.
- The toolbar tab shows a red badge with a live outstanding count even while
  the panel is collapsed.

This only covers claims visible on the current page of the list (pagination
isn't crawled automatically).

## Why this doesn't need Northstar's API or server internals

Everything above is done the same way a person would use the site: loading a
page and clicking a tab. The hidden background checks are real page loads in
an invisible frame, not calls to any undocumented API — so there's nothing
about Northstar's server behavior to reverse-engineer or keep in sync with.

## Sharing setup with a team

Settings → **Export config (.json)** to save your setup, and **Import config
(.json)** on a teammate's machine to load it, so the whole team doesn't have
to repeat the two-click setup individually.

## Limitations (v0.2)

- Read-only by design: it does not fill in or submit anything back into
  Northstar. Someone still clicks "adjust" / "settle" / "close" themselves.
- Works on whatever tab is active when you click the extension icon — it
  doesn't auto-inject on page load (no host permissions are requested).
- Only checks claims on the currently visible page of the list; doesn't
  paginate through the rest automatically.
- If Northstar only renders the Requirements tab's data after a real click
  (rather than including it in the page's initial HTML), the automatic
  background check still works, because it actually performs that click in
  the hidden frame — but it does add a short delay per claim while it waits
  for that to render.
