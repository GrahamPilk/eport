---
title: "Putting a website on a fleet of NFC cards"
description: "Notes on NDEF records, short URLs and making the first tap feel instant."
date: 2026-11-20
tags: ["nfc", "hardware", "performance"]
---

A tap on an NFC card opens a URL on a cold phone, on mobile data, usually while someone is watching you. That changes the priorities.

1. **First paint under a second.** No web fonts block rendering, CSS is inlined, the page is static HTML.
2. **Short URLs.** NTAG213 chips hold about 137 bytes. `https://` is compressed to a single byte by the NDEF URI prefix, so `grahampilkington.com/?c=07` fits easily.
3. **One card, one id.** The `?c=` parameter lets the site greet each card differently.

> Placeholder post. Replace with your own notes.
