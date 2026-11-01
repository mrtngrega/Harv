---
name: image-prompt
description: Turn a picture wish into a strong prompt before calling generate_image, and refine from the result. Use whenever the user wants a picture made: a photo, illustration, logo, icon, wallpaper, poster, sticker, mockup.
---

# Image prompt

A picture model draws what the prompt **describes**, not what the user meant. "A cool wallpaper with my car" gives a random car in a random style; a prompt that names the subject, style, framing, light and colours gives the picture they had in mind. Harv's `generate_image` runs Google's Gemini on its website: about 25 s a picture, a daily limit on the free account, and it won't edit existing pictures (it says so).

Say in a few words that you're using it ("using image-prompt").

## 1. Know the wish

Use what's already known before asking: the user's memory (their style picks, their car, their favourite colours, the project it's for) and the chat. Ask only when a missing answer would change the picture a lot (what it's for, the size or shape), at most two short questions. A vague wish with nothing to go on gets **2–3 short variants** in different directions instead of questions ("cosy watercolour", "clean flat vector", "moody photo"), and the user picks.

## 2. Write the prompt

In English, as plain descriptive sentences (Gemini follows prose better than keyword lists), in this order:

1. **Subject**: what's in it, concretely (which car, which colour, what it's doing). One main subject reads better than several.
2. **Medium and style**: photo, 3D render, watercolour, flat vector, pixel art, line drawing, film still; a style era or a technique ("risograph print", "isometric", "long exposure") rather than a living artist's name.
3. **Framing**: shot size and angle (close-up, wide, top-down, three-quarter view, eye level), lens feel for photos (35 mm, telephoto, macro), where the subject sits.
4. **Light and colour**: time of day, light source and direction, mood; a palette by name or hex ("teal and warm amber", "#A8C8E8 ice blue").
5. **Background and detail**: setting, depth (blurred, plain, busy), texture, level of detail.
6. **Shape**: the aspect ratio in words, from where it's used: wallpaper 16:9 (or the screen's own, e.g. 2560×1440), phone wallpaper 9:16, icon or logo or avatar square, poster 2:3.
7. **Text in the picture**, only when needed: the exact words in quotes, short (a few words), where they go and in what kind of lettering. Spelled-out text comes out best when it's short.

Describe what should be there; for things to keep out, name the alternative ("a plain white background", "an empty street") rather than listing what to avoid.

Kinds that need more:

- **Logo or icon**: flat, simple shapes, few colours, solid background, centred, readable small; ask for "a flat vector logo" and expect to redraw it as SVG for real use (a generated logo is a draft, not a vector file).
- **A real person, a brand or a trademark**: Gemini refuses or changes many of these: describe a look or a style instead, and say so.
- **A picture of the user's own thing** (their car, their room): describe it from their photo or memory in detail (model, colour, details); Gemini can't use their photo as a base on this account.

## 3. Make it, look at it, refine

Call `generate_image`, then **open the picture** and compare it with the wish: subject right, style right, framing, colours, text spelled right, odd hands or melted details. Name the full path in the reply so it shows in the chat. If it's off, change **one thing** in the prompt (the part that went wrong) and make it again, at most two retries before asking the user what to change. Tell them what you'd adjust when it's close but not quite.

When the user likes a style or says what they don't like, save it to memory (`remember`: "likes moody blue-hour photos for wallpapers"), so the next picture starts there.
