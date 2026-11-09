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
