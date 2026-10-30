# Selector fixtures (PLAN §10)

Snapshot HTML fragments of real pages (post cards from each platform) live here for
offline selector regression. When extracting a new snapshot:

1. On the SECONDARY account only: save the outer HTML of one post card from the feed.
2. Commit as `linkedin.html`, `x.html`, `facebook.html`, `reddit.html` (fragment only —
   no session data, no cookies, redact personal text before committing).
3. Adapter selector changes must be exercised against the fixture manually
   (paste into a scratch page) before the real platform.

Fixtures intentionally start empty: filled in during Phase 4/5 bring-up on the
disposable/secondary accounts.
