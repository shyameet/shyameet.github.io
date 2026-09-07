---
title: "How this site works"
date: 2026-09-07T10:30:00+05:30
tags: [meta]
---

A note to my future self, because in four months I will have forgotten.

**To post from anywhere:** open `/admin/` on the phone, type, hit Publish. That writes a
markdown file into the repo, GitHub Actions rebuilds the site, and it is live in under a
minute. The draft saves itself to the phone as I type, so a dropped call or dead signal
costs nothing — publish again when the bars come back.

**To post from the desk:** drop a `.md` file into `content/posts/`. Same thing. The folder
is plain markdown, so Obsidian can open it as a vault if that is ever easier.

The only frontmatter that matters:

```
---
title: "Optional — leave it out for a quick note"
date: 2026-09-07T10:30:00+05:30
tags: [trading, idea]
draft: true      # keeps it off the site
---
```

Everything else — the feed, tag pages, the archive, search, the RSS feed — builds itself
from those files. There is no database and no account. If GitHub disappears tomorrow, the
posts are still a folder of markdown on my laptop.
