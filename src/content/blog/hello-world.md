---
title: "Hello, world (in two colours)"
description: "Why this site is strictly black and white, and how the dithering works."
date: 2026-11-24
tags: ["meta", "design"]
---

This site has exactly two colours. Everything that looks like a shade of grey is really a pattern of black and white pixels, arranged with an **ordered dither**: an 8×8 Bayer matrix decides which pixels switch on at each brightness level.

## Why

Constraints make things look intentional. One bit per pixel forces real hierarchy: size, weight, spacing and rhythm do the work that colour usually does.

## How

Each cell compares its brightness against a threshold from the matrix:

```js
const on = brightness > BAYER[y & 7][x & 7] / 64;
```

That's it. The intro animation, the sphere on the home page and the section rules all use the same rule.

> Placeholder post. Replace it, or publish over it with the publish API.
