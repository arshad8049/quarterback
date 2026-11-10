# Homepage redesign, November 2026 (preview)

Brief: redesign the homepage using scale.com as the visual and interaction reference, with original Quarterback visuals, one real run, honest progress and the working signup. This extends the rev 3 plan: the signup, staging, privacy and deployment safeguards are unchanged. The work is a preview on branch `site-redesign-2026-11`. Nothing is merged or deployed to production.

## 1. Reference walkthrough (scale.com, inspected 2026-11-08)

Inspected in headless Chromium (Playwright 1.48.2) at 1440×900 and on an iPhone 13 profile, with a recording of a pointer sweep and a full scroll.

| | Observed on scale.com | Adapted for Quarterback (our proposal) |
|---|---|---|
| Hero | Full-width media in a rounded frame under the nav; large centred sans headline (64 px); a full-viewport canvas layer | Large serif headline at left; an original workflow illustration (Request → Approved requirements → Checks → Patch) at right, labelled as an illustration |
| Cursor | No pointer-driven change was observable in headless Chromium (no DOM transforms changed; the effect, if any, is inside the canvas). **Not confirmed.** | A subtle pointer-following light inside the hero only, plus a shallow parallax (≤ 10 px) on the illustration and orbit; text never moves |
| Scroll storytelling | A pinned stack of tilted panels stays on screen while short statements below it change; some headlines fill word by word | A sticky stage on desktop: the panel for the step in view comes forward, the others recede. No word-by-word fill (it delays reading) |
| Section handoffs | A green card slides up over the black section; floating image tiles around a centred line with a rotating word | Not adopted: a rotating word hides information, and image tiles would need imagery we don't have |
| Cards | A horizontal row of case-study cards with visible previous and next buttons | Three progress cards in a grid, so nothing is hidden off screen. No carousel |
| Mobile | Sections stack; no horizontal overflow | Same: steps and panels stack naturally; nothing is pinned |
| Reduced motion | One reduced-motion rule; videos don't play | Parallax, drift, the pointer light, the illustration pulse and the sticky stage are all off, at load and when the setting changes |

Nothing was copied: no source, illustrations, logos, customer claims or branding.

## 2. What changed

The homepage (`/`) now has six parts:
1. **Hero:** "Review AI-written code with evidence.", the "Early beta" label, the two buttons and the workflow illustration.
2. **One real run:** four steps, each with an excerpt from the same run.
3. **What the result tells you:** the same run's result with four annotations, plus a collapsible list of every result and outcome.
4. **Progress:** three dated cards.
5. **Try Quarterback:** brief compatibility details, the setup guide link and the working form.
6. **Footer.**

The old sections "What it does", "Example" and "Supported setup" are folded into these. `/developers` is unchanged except that it shares the new signup section. The page titles no longer contain em dashes.

**Files:**
- `landing_page/src/home-hero.html`, `home-run.html` (new), `home-result.html` (new), `home-progress.html`, `beta-cta.html`, `home-nav.html`;
- the `qbx-` styles at the end of `src/styles/main.css`;
- the hero pointer and run-stage code in `src/scripts/interactions.js`;
- `build.js`: page list, titles, and preloads for the two hero fonts.

**No new dependencies:** no animation library. Moving layers use only transforms and opacity, through one `requestAnimationFrame` loop.

## 3. Sources for every product visual and claim

| On the page | Source |
|---|---|
| The four run panels and the result card | Run `e01b3273-1737-4ca6-8f0a-5a172f4e74e6`, 2026-10-15, QB `3fc08fd`, outcome VERIFIED: `landing_page/evidence/2026-10-15-hero-run/`. The request and command come from `hero-run.log`; the requirements from `contract.json`; the checks, the project test (`npm test`, 136 ms), +2 −1 and 111 seconds from `hero-run.log` and `run/manifest.json`; the patch from `run/artifacts/0213…87ea.diff` (the comment line is shortened, and the page says so) |
| "A local model drafted this list; a person edited it" | `hero-run.log`, section "Where the contract came from"; `evidence/2026-10-15-hero-run/README.md` |
| The advisory 0 ms edge case was not checked | `contract.json` → `constraint_policy[2].advisory: true` |
| The earlier attempt that day was BLOCKED (run lock) | `hero-run.log`, section "First attempt" |
| Progress: "stops with a clear message…" (merged November 4 and 5) | PRs #19, #20 and #21 (2026-11-04, `d946ff3`) and #23 (2026-11-05, `eea8a5c`) |
| Progress: "Signing up emails you the setup guide" (live since November 8) | PR #30 (`784e721`), deployed as Worker version `4b842e11` |
| Progress: "Most automatic drafts are still rejected" | `/developers#progress`: the drafting measurements, with their dates and models |
| Progress: "walkthrough last passed on October 12" | `docs/support.md#validated-commits` (`54c2f24`) |
| Progress: "no measured advantage" | `research.html` (evaluation notes) |
| Workflow illustration | Original HTML and CSS. It's labelled "An illustration, not a live dashboard" and shows no results |
| Orbit, grid and logo | Existing Quarterback assets (`src/orbit.svg.html`, `logo.png`) |

The page shows no customer logos, user counts, time-saved figures or engineering test counts.

## 4. Verification (local preview, 2026-11-08)

| Check | Result |
|---|---|
| Layout at 375, 768 and 1280 px | No horizontal overflow; no console errors; no failed requests |
| axe-core 4.10.2 (WCAG 2 A/AA and best practices), `/` and `/developers` at all three widths | 0 violations |
| Keyboard | 22 tab stops in order, starting with the skip link; every stop has a visible focus style |
| Reduced motion at load | Motion-off class set; the sticky stage is off and the panels sit under their steps; no illustration animation; the orbit is paused; every reveal is visible |
| Reduced motion toggled mid-session | Motion switches off (stage, animation, orbit) and comes back when switched back |
| JavaScript disabled | No hidden content; the nav works; every panel is under its step |
| Touch device (iPhone 13 profile) | No pointer tracking; the light stays at opacity 0 |
| Pointer effect | The light follows the pointer; the headline moves 0 px; the effect layer ignores pointer events; the buttons stay clickable |
| Links | 49 checked across both pages, 0 broken (GitHub links can return 429 when checked too often) |
| Em dashes in visible text and titles | 0 on both pages |
| The preview signup goes to staging | The page served as `arshad8049.github.io/quarterback/` POSTed to `quarterback-staging.velorallc.workers.dev/api/beta-access`; it answered "saved in the test environment (preview): no email is sent" |
| Unit suite | 943 pass, 0 fail (Node 20) |

## 5. Performance (desktop 1280×800, 4× CPU throttling, median of 3 cold loads, same local server)

| | Before (`main` `784e721`) | After |
|---|---|---|
| Largest contentful paint | 227 ms | 226 ms |
| Cumulative layout shift | 0.023 | 0 |
| Total blocking time (long tasks over 50 ms) | 94 ms | 92 ms |
| Transferred | 173 KB | 197 KB |
| Requests | 9 | 9 |
| Scroll frame time, 95th percentile | 16.7 ms | 16.7 ms |
| Frames over 50 ms while scrolling | 0 | 0 |

The first "after" measurement had a layout shift of 0.035 and 168 ms of blocking time, caused by the web fonts swapping in. Preloading the two hero fonts fixed both.

## 6. Remaining gaps

- **Assets still needed from Arshad:** these are why the panels are typeset excerpts rather than screenshots:
  - a sanitized 30–60 second recording of a complete run;
  - four screenshots from that same run;
  - the logo as SVG.

  The excerpts are faithful to the run record and labelled as excerpts.
- **`og-image.png` still shows the previous headline.** It should be regenerated before release.
- **Unverified on real hardware:** the pointer light was checked in headless Chromium only, not on a real trackpad or in Safari.
- **Hero claim:** the hero says "checks the changes". The run shows that for one small task; the progress section states that time saved isn't established.

## 7. Revision 2 (2026-11-09): layout, type and hero (static preview for composition approval)

The owner's revised brief replaced the editorial look with a clean technical one, and cut the planned twelve generated images to one hero still. The video and the mobile still are optional, and none of them is generated yet.

**What changed:**
- **Shell and type:**
  - a warm-white shell (`#f5f5f2`) with a 72px sticky header;
  - a dark inset hero with a 16px radius and 24px gutters (16px on mobile);
  - Inter 5.3 variable, self-hosted (`src/fonts/inter/`, SIL OFL 1.1 in `OFL.txt`), replacing Instrument Serif and Plex Sans on the homepage; IBM Plex Mono stays for code only.
  - type scale as specified: H1 `clamp(44px,5.6vw,80px)`/500/1.04/−0.035em, H2 `clamp(32px,3.7vw,52px)`/500/1.1, body 18px (16px on mobile).
  - The homepage styles are in their own file, `src/styles/home.css`, loaded only on `index.html`. `/developers` is unchanged apart from the shared signup wording.
- **Navigation and hero copy:**
  - nav: Product, Progress, Developers, GitHub, and the button Try Quarterback;
  - hero: label "Guided early beta"; body "Approve the requirements. Quarterback runs Claude Code, checks the change, and gives you a patch to review."; buttons Try Quarterback and See a real run.
  - The four explanation cards were removed from the hero.
- **Hero art and logo:**
  - The hero art is a **stand-in**: the existing orbit SVG, until the generated still is approved.
  - The logo is `logo-mark.svg`, made from the supplied `favicon_svg.svg` with its background square removed.
- **Walkthrough:**
  - four steps, each about 70svh, beside one sticky evidence panel, at 900px and up;
  - the active step is the one at the viewport's centre, measured from real positions;
  - the step controls scroll to their step;
  - the stage is used only if it fits below the header; it is re-measured after fonts load and on resize.
  - Below 900px, under reduced motion and without JavaScript, the panels stack under their steps.
  - Every panel is labelled "Run excerpt" with a source link. The figures were re-checked against the evidence files on 2026-11-09.
- **Result, progress and signup:**
  - result: one compact annotated result on a solid dark surface; the outcome definitions moved to `/developers`;
  - progress: a light section with three dated cards and small SVG marks;
  - signup: a light section with a dark form card; the button now says what happens, "Send me the setup guide".
- **Motion:**
  - the hero art follows a fine pointer by at most 10px, 6px and 1°, with about 120ms of time-based damping;
  - a light follows the pointer inside the art only;
  - a visible **Pause animation** button;
  - reveals move 16px over 450ms, triggered at 85% of the viewport, with a 60ms stagger;
  - the story crossfade is 200ms; buttons respond in 140ms.
- About 390 words of homepage prose, excluding the evidence panels, the compatibility list and the form.

**Verification (local, Playwright 1.48.2 Chromium, 2026-11-09):**

| Check | Result |
|---|---|
| axe-core 4.10.2, `/` and `/developers` at 1440, 1280, 768 and 375 px | 0 violations |
| Layout at 1440, 1280, 768 and 375 px | No horizontal overflow; no console errors or failed requests |
| 200% zoom (640px-wide viewport) | No overflow, no clipped cards, stage off |
| Keyboard | 36 stops; every one has a visible focus outline; links in hidden story panels are unreachable |
| Reduced motion at load | Motion-off; no stage; orbit paused; Pause button hidden; every reveal visible; `scroll-behavior: auto` |
| Reduced motion toggled off, then on again | Stage, orbit and Pause button come back, then go again; panels return under their steps |
| JavaScript disabled | Every panel under its step; stage hidden; all text visible |
| Touch (iPhone 13 profile) | No pointer tracking; no stage; no overflow |
| Pointer | Largest movement 9.65px × 5.81px, 0.97°; headline moved 0px; art ignores input; light only over the art |
| Pause button | Movement and orbit stop; label changes to "Play animation" |
| Story | Deep link `#run-3` and a reload mid-story both open on step 3; a fast reverse scroll gives step 1; the "4 Patch" control gives step 4 |
| Short window (1280×480) | Stage not used, because it doesn't fit |
| Em dashes in visible text and the title | 0 |
| Unit tests on the form and privacy wording | 7 pass, 0 fail |

**Performance** (1280×800, 4× CPU throttle, median of 3 cold loads, same local server):

| | Before (`main` `784e721`) | Revision 1 | Revision 2 |
|---|---|---|---|
| Largest contentful paint | 227 ms | 226 ms | 138 ms |
| Cumulative layout shift | 0.023 | 0 | 0 |
| Total blocking time | 94 ms | 92 ms | 10 ms |
| Transferred | 173 KB | 197 KB | 196 KB |
| Requests | 9 | 9 | 9 |

**Not done yet:**
- **Waiting for approval:**
  - the hero still (prompt A in `landing_page/assets/higgsfield-prompts.md`, in the main checkout);
  - the optional video, which comes only after the still is approved.
- **Not tested:**
  - a slow network;
  - a failed video load, since there is no video yet;
  - Safari, and a real trackpad;
  - frame stability on ordinary hardware.
- **Still to do:** regenerate `og-image.png` from the approved still.

## 8. Revision 3 (2026-11-10): hero image

The stand-in orbit is replaced by the owner's hero still. The pause button is gone, because nothing in the hero moves on its own any more.

**Asset inventory:**

| File | Use | Dimensions | Size | Made from |
|---|---|---|---|---|
| Source PNG (not committed; `landing_page/assets/` in the main checkout, file name beginning "Look_ a dark, quiet, premium product-photography still.") | Master | 1600×896, RGBA, fully opaque | 364 KB | Owner-supplied, AI-generated. Licensing waived by the owner on 2026-11-10. 1600×896 is final. |
| `landing_page/media/hero-desktop.webp` | Hero at 900px and up | 1600×896 | 17 KB | Whole image, `cwebp -q 82 -m 6` |
| `landing_page/media/hero-mobile.webp` | Hero panel under 900px | 900×576 | 8 KB | Crop x 200 to 1600 (frame, ribbon, wall panel), resized to 900 wide, `cwebp -q 82 -m 6` |
| `landing_page/og-image.png` | Social card | 1200×630 | 212 KB | The source image behind the real logo (`logo-mark.svg`) and the headline in self-hosted Inter, rendered by Playwright |

The image is decoration. It carries no product claim and is never shown as evidence.

**What changed:**
- **Desktop and tablet (900px and up):**
  - the still fills the whole dark hero behind the copy as an `<img>` with width and height, `alt=""`, `fetchpriority="high"` and `decoding="async"`, under the copy and ignoring input;
  - the art box keeps the still's 1600:896 ratio at the hero's full height, anchored right. On wide screens the whole still shows and the hero's own near-black fills the left; on narrower ones the hero clips the left side, like `object-fit: cover; object-position: right center`;
  - the hero background is `#030303`, the still's own black, so there is no seam;
  - a left-to-right scrim keeps the copy on near-black; it is darker from 900 to 1199px, where the frame comes closer to the text;
  - the hero's minimum height is also capped at 66vw, so a tall, narrow desktop window doesn't push the frame behind the headline.
- **Under 900px:** copy first, then the still as a panel `clamp(260px, 70vw, 420px)` high, cropped toward the frame and ribbon (`object-position: 100% 56%`), with a short fade at its top edge. A `<picture>` `media` source means phones and tablets download only the 8 KB mobile file.
- **Removed:** the orbit (`{{ORBIT}}`) from the homepage hero, its `.qbh-art-move .qb-orbit` styles and JavaScript, and the Pause animation button with its styles and JavaScript. `/developers` keeps its orbit.
- **Pointer effect** (fine pointer, motion allowed):
  - the image wrapper moves at most 10px across and 6px down, with about 120ms of time-based damping and no rotation;
  - the wrapper overhangs by 12px and 8px and is scaled 1.03, so no edge ever shows;
  - the copper light follows the pointer only over the right half of the hero (the whole panel when stacked);
  - the headline does not move;
  - it is off on touch devices, under reduced motion (at load and when toggled), off screen and on hidden tabs.
- **Reduced-motion fix:** Chromium updates a media query's cached state whenever `.matches` is read. The old pointer loop read it on every frame, so turning reduced motion on while the pointer was moving could swallow the change event and leave motion on. The state is now read only at load and inside the change event.
- **Social card:** `og-image.png` is regenerated from the still. The meta tags are unchanged.

**Verification (local, Playwright 1.48.2 Chromium in Docker, 2026-11-10; script `verify4.js`):**

| Check | Result |
|---|---|
| axe-core 4.10.2, `/` and `/developers` at 1440, 1280, 768 and 375 px | 0 violations |
| Layout at 1440, 1280, 768 and 375 px (also looked at 1920×1080, 1024×768 and 900×1000) | No horizontal overflow; no console errors or failed requests |
| Image per width | 900px and up loads only `hero-desktop.webp`; 899px and below (and iPhone 13) loads only `hero-mobile.webp`; `fetchpriority="high"`; hero background `rgb(3, 3, 3)` |
| 200% zoom (640px-wide viewport) | No overflow, no clipped cards, stage off |
| Keyboard | 35 stops (the Pause button is gone); every one has a visible focus outline; links in hidden story panels are unreachable |
| Reduced motion at load | Motion-off; no stage; art transform `none`; light hidden; no tracking after the pointer moves; every reveal visible; `scroll-behavior: auto` |
| Reduced motion toggled off, then on again while the pointer moves | Tracking and stage come back, then stop; art transform back to `none`; panels return under their steps |
| JavaScript disabled | Every panel under its step; stage hidden; all text visible; hero image loaded |
| Touch (iPhone 13 profile) | No pointer tracking; no stage; no overflow; image panel below the copy (358×273) |
| Pointer at 1440 | Largest movement 9.72px × 5.81px; no rotation; image covered the hero in every sample; headline moved 0px; the primary button still receives clicks; art ignores input |
| Light | On over the object (right half); off over the copy and just left of centre |
| Damping (jump to the right edge) | 4.9, 7.0, 8.7 and 9.7px at about 60, 120, 240 and 600ms |
| Hidden tab, and scrolled off screen | Tracking stops and resets |
| Pause button | Not present |
| Story | Deep link `#run-3` and a reload mid-story both open on step 3; a fast reverse scroll gives step 1; the "4 Patch" control gives step 4 |
| Short window (1280×480) | Stage not used |
| Em dashes in visible text and the title | 0 (384 words of homepage prose) |
| Unit tests on the form and privacy wording | 7 pass, 0 fail |

**Performance** (1280×800, 4× CPU throttle, median of 3 cold loads, same local server):

| | Before (`main` `784e721`) | Revision 2 | Revision 3 |
|---|---|---|---|
| Largest contentful paint | 227 ms | 138 ms | 124 ms |
| Cumulative layout shift | 0.023 | 0 | 0 |
| Total blocking time | 94 ms | 10 ms | 11 ms |
| Transferred | 173 KB | 196 KB | 207 KB |
| Requests | 9 | 9 | 10 |

A separate single cold load recorded the hero image as the desktop LCP element at 231 ms; on the iPhone 13 profile the LCP element was the headline at 116 ms. These are local lab numbers, not field data.

**Remaining gaps:**
- The source has faint 8px blocking in its near-black areas (one 8-bit step). It is in the master, not added by WebP, and shows only on bright, high-gamma screens.
- At 1600px the desktop file is below 2× density on screens wider than about 900 CSS px of art. The owner has said 1600×896 is final.
- Not tested: a slow network, Safari, a real trackpad, and frame stability on ordinary hardware.

## 9. Revision 4 (2026-11-10): page-wide pointer light

**Owner decision, 2026-11-10:** the pointer light now works across the whole homepage, not only the hero. This deliberately changes the Nov 9 brief's "pointer effect in the hero only".

**What changed:**
- **One page-wide light** replaces the hero-only light: a soft copper disc 640px across (320px radius) that follows a fine pointer anywhere on the page.
- **Drawn under text, never over it.** A blend layer over the page was tried first and rejected: at full strength it brought `--orange-text` on paper down to 4.01:1. Instead, `interactions.js` adds:
  - one fixed disc behind the page's content (6% copper at the centre, eased to 0), which shows on the warm-white areas and is barely visible there;
  - one clipped disc inside each dark surface (14% copper at the centre): the hero (above the image, below the copy), the result section, the result card, every run panel and the signup form card.
  - The discs are `aria-hidden`, ignore input, and are created only on the homepage. `/developers` has none.
  - The homepage root is `isolation: isolate`, and the light sections and the signup section use the page's own paper instead of painting it again, so the fixed disc can show through.
- **Worst-case text contrast at the disc centre** (computed from the colour tokens):
  - light surfaces: text 16.6, text-2 8.4, muted 5.9, orange links 4.77:1;
  - dark surfaces: on-ink 14.8, on-ink-2 9.7, on-ink-muted 6.1 (on ink-2), mint links 9.1:1.
  - The lowest is 4.77:1, which still passes AA. Script: `glow-contrast2.js` in the session scratchpad.
- **Hero parallax unchanged:** at most 10px and 6px, no rotation, headline 0px.
- **One rAF loop** for the light and the parallax:
  - about 120ms of time-based damping;
  - writes only `transform`, `opacity` and the two parallax variables;
  - surface positions are read before any write in a frame, and only after a pointer move, scroll or resize;
  - passive listeners; stops when settled.
- **When it's off or fades:**
  - off on touch and coarse pointers, under reduced motion (at load and when toggled; the state is still read only at load and in the change event), and on hidden tabs;
  - fades out when the pointer leaves the window or the window loses focus.

**Verification (local, Playwright 1.48.2 Chromium in Docker, 2026-11-10; script `verify5.js`):**

| Check | Result |
|---|---|
| axe-core 4.10.2, `/` and `/developers` at 1440, 1280, 768 and 375 px | 0 violations |
| axe with the pointer resting on text, light lit at full strength: hero headline, run heading, step text, progress card (light); result heading, result card, form card (dark) | 0 violations at all 7 spots; light centred within 1px of the pointer; the text was the hit target at every spot |
| Light z-order | Page disc `z-index: -1` in the isolated homepage root; dark-surface discs `z-index: -1` inside their surface (hero: between the image and the copy) |
| Layout at 1440, 1280, 768 and 375 px | No horizontal overflow; no console errors or failed requests |
| Keyboard | 35 stops, all with a visible focus outline |
| Reduced motion at load | Light `display: none`; art transform `none`; motion-off; no stage |
| Reduced motion toggled off, then on again while the pointer moves | Light comes back (opacity 0.99 under the pointer), then is hidden again; parallax off; panels return under their steps |
| JavaScript disabled | No light elements; all content visible; hero image loads |
| Touch (iPhone 13) | Light stays at opacity 0; no parallax; no overflow |
| Hidden tab | Light opacity 0; parallax reset |
| Pointer leaves the window (`mouseout` with no related target) | Light fades to 0 |
| `/developers` | 0 light elements |
| Hero parallax | 9.72px × 5.81px at most, no rotation, image always covers, headline 0px; damping 4.2, 6.6, 8.7 and 9.7px at about 60, 120, 240 and 600ms |
| 200% zoom, short window, story deep links and controls | Unchanged: pass |
| Em dashes | 0 |
| Unit tests on the form and privacy wording | 7 pass, 0 fail |

**Performance** (1280×800, 4× CPU throttle, median of 3 cold loads, same local server; revision 3 served from `e6016c3` at the same time):

| | Revision 3 | Revision 4 |
|---|---|---|
| Largest contentful paint | 114 ms | 121 ms |
| Cumulative layout shift | 0 | 0 |
| Total blocking time | 1 ms | 5 ms |
| Transferred | 207 KB | 211 KB |
| Requests | 10 | 10 |
| Scroll frame p95, no pointer | 16.7 ms | 16.8 ms |
| Scroll frame p95, pointer moving while wheel-scrolling (`perfp.js`) | 16.8 ms | 16.7 ms |
| Frames over 50 ms during either scroll | 0 | 0 |
| CLS during the pointer scroll | 0 | 0 |

**Remaining gaps:**
- On warm-white surfaces the 6% gradient has faint 8-bit banding rings, which the eased stops reduce but don't remove.
- White cards (`.qbh-card`) and code blocks are not lit; the light passes under them.
- Not tested: Safari, Firefox, a real trackpad, a high-refresh display, and ordinary hardware. The pointer-leave check used a synthetic `mouseout`, not a real pointer leaving the window.
