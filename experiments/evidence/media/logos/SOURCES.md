# Logo strip sources (homepage, revision 5)

Owner decision, 2026-11-10: the strip shows exactly these items.
- **"Works with"** shows compatibility (tools Quarterback integrates with), not endorsement.
- **"Research collaborations":** the owner stated on 2026-11-10 that George Mason University and Harvard University have authorized use of their logos. We hold no written approval in the repo.

The four files here are byte-for-byte copies of the official files, not recoloured, cropped or edited, so each SHA-256 matches its download. The originals and the full kits are in the owner's `landing_page/assets/logos/` folder in the main checkout, which git ignores.

All files fetched on 2026-11-10.

| File | Organization | Official source | Original file | SHA-256 | Usage rules |
|---|---|---|---|---|---|
| `claude-code.svg` (7,000 B) | Anthropic (Claude Code) | Anthropic press kit, https://www.anthropic.com/press-kit (served as https://www-cdn.anthropic.com/ae59ca4ca194dac9c9dc3bc78c5829468cb0e8af.zip) | `Anthropic media resources/Anthropic logos/Claude logos/2 Claude Code logo/SVG/Claude Code logo - Slate.svg` | `d8a00c51cd1a31e85f8ca264f89617894d4c2ed9c72e71ccdc00f84bcca7a6a3` | The kit has no usage-guideline document. The press-kit page is the reference. The full-colour "Slate" version (for light backgrounds) is used unaltered. |
| `nodejs.svg` (5,844 B) | OpenJS Foundation (Node.js) | https://nodejs.org/en/about/branding, file https://nodejs.org/static/logos/nodejsDark.svg | `nodejsDark.svg` (horizontal logo, dark text, for light backgrounds) | `69fe820a6dfdb829a0767eb2450b42a7d376257b4c15de72d4361e4d888459b3` | https://trademark-policy.openjsf.org/ (linked from the branding page) |
| `docker.svg` (2,473 B) | Docker, Inc. | https://www.docker.com/company/newsroom/media-resources/, kit https://www.docker.com/static/Docker-Logos-1.zip | `docker-logos/SVG/docker-logo-ocean-blue.svg` (primary logo, primary colour) | `db969db2ea1ef7e29938b3924f6d8afce6e0bdf047b94e76bb3bc6c89d36c630` | Logo rules on the media-resources page (clear space; don't flip, tilt, stretch, decolorize, crop or use the wordmark alone); https://www.docker.com/legal/trademark-guidelines/ |
| `github.svg` (3,946 B) | GitHub, Inc. | https://github.com/logos (redirects to https://brand.github.com/foundations/logo), kit https://brand.github.com/GitHub_Logos.zip | `GitHub Logos/SVG/GitHub_Lockup_Black.svg` | `802172fd58f2956be454f45e07c351d5c3d6830554632796b8f16fcecc7d273b` | https://brand.github.com/foundations/logo (don't rearrange, add effects, mix colours or place on busy backgrounds) |
| *(text wordmark)* | George Mason University | https://brand.gmu.edu/brand-guide/university-logos-and-marks | Not downloaded. The logo files are on https://gmu.bynder.com/web/58af76befae0efca/george-mason-university-logos/, which the brand page marks "login required". | n/a | George Mason University Policy 1130 (per the brand page). Shown as plain text until the owner supplies the official file. |
| *(text wordmark)* | Harvard University | https://trademark.harvard.edu/ | Not downloaded. The trademark site returned HTTP 403 to our requests, and no public logo download was found on harvard.edu. | n/a | Harvard Trademark Program. Shown as plain text until the owner supplies the official file. |

Kit hashes (SHA-256), for the originals kept in `landing_page/assets/logos/`:
- `Anthropic-press-kit.zip`: `c68ac92df86c825f95177e24016fcc9a8863a3fd4ca344fe6f0700b2c1e07151`
- `Docker-Logos-1.zip`: `590790ecdaaa577e55ce3dcad3a6c67a04ca7f8cc53a4a2fa21ac69d6767d476`
- `GitHub_Logos.zip`: `e2a67d6cc51d990a52c46c1cf6bcab688db4830982174bca50e0be7a5c2f3194`

## Revision 6 (2026-11-19, owner): coding agents, planned adapters

| File | Owner | Source | Item used | sha256 | Rules |
| --- | --- | --- | --- | --- | --- |
| `cursor.svg` (2523 B) | Anysphere, Inc. (Cursor) | https://cursor.com/brand, kit https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip (kit sha256 97488a7751914e60f9ff532bc33810cdeaebdddc017548abe6ca2bc29bbc3928) | `General Logos/Lockup Horizontal/SVG/LOCKUP_HORIZONTAL_2D_LIGHT.svg`, unmodified | `f7a384d3d6e1875196aa770d2c8df58ceb79b1219e97b86e522dee83d3d9c6ac` | "Refer to us as Cursor." No other rules stated on the page. |

**Not used, and why** (checked 2026-11-19; shown as text until resolved):
- **GitHub Copilot.** https://brand.github.com/brand-identity/copilot says Copilot no longer has a standalone logo, and https://brand.github.com/foundations/logo forbids use "without the express written permission of GitHub, Inc." and implying affiliation.
- **OpenAI Codex.** https://openai.com/brand returned 403 to an automated fetch; no official file was obtained.
- **Gemini.** Google's brand resources for Gemini require a Partner Marketing Hub account (sign-in wall).

Every planned item says "planned" and links to the support matrix. None of these companies endorses Quarterback.

**Owner-supplied files (2026-11-19).** The owner downloaded these in a browser and provided them; their source pages were not recorded by the junior.
- `openai.svg`: the OpenAI mark, an unmodified copy of the owner's `openai_codex.svg`, sha256 `af4fb01bc6a90a2bf8eae8ef2f377ae8ed8a2bf9b269660eff0f61609768b6ad`. Shown with the text "Codex".
- `gemini.png`: the Gemini sparkle. The owner's `Google_Gemini_icon_2025.svg` is actually a 960x960 WebP image; it was converted to PNG and scaled to 96 px. sha256 `a9d047a26ef65c72f9d881f04fda88f7d441b2f79061c4f7a05853d6d498d7ce`. Shown with the text "Gemini".
- **Not used:** the owner's `Copilot-Logo.png` is the **Microsoft Copilot** app logo, not GitHub Copilot, so "GitHub Copilot" stays as text.

**Currently supported group (2026-11-19).**
- `linux-tux.svg`: Tux, the Linux mascot, by Larry Ewing (lewing@isc.tamu.edu), made with The GIMP; SVG from https://upload.wikimedia.org/wikipedia/commons/3/35/Tux.svg, unmodified. sha256 `cd503ad510e16ff2869f959cf57b892bb2175a6874ff696b495bd94fd7db9743`. Terms: "Permission to use and/or modify this image is granted provided you acknowledge me lewing@isc.tamu.edu and The GIMP if someone asks." Shown with the text "Linux".
- `nodejs-icon.svg`: the Node.js hexagon icon from the OpenJS Foundation's Node.js site, https://nodejs.org/static/logos/jsIconGreen.svg (see https://nodejs.org/en/about/branding), unmodified. sha256 `3c88b1a2261132b11d242fe8831525be051450e1149c965d5a5f1ded63e9b50d`. Shown with the text "node:test" (Node.js's built-in test runner has no logo of its own).
- **Owner rule:** every item in the strip is a logo or a mark-and-name lockup.
