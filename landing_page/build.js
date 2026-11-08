// Run: node build.js
// Assembles the section files in src/ into two pages:
//   index.html      — the homepage, written for a non-technical visitor
//   developers.html — the technical page (served at /developers)
// {{ORBIT}} in a section is replaced by src/orbit.svg.html (the decorative hero orbit).
const fs = require('fs');

const SITE = 'https://quarterback.velorallc.workers.dev';
const ORBIT = fs.readFileSync('src/orbit.svg.html', 'utf8').trim();

const PAGES = [
  {
    file: 'index.html',
    path: '/',
    title: 'Quarterback — AI writes the code. Quarterback shows you the evidence.',
    description: 'Quarterback runs Claude Code against a requirements list you approve, checks the change with your tests and the agreed checks, and gives you the evidence and the change to review. Early, supervised testing.',
    sections: ['home-nav', 'home-hero', 'home-what', 'home-example', 'home-supported', 'beta-cta', 'home-progress', 'footer'],
  },
  {
    file: 'developers.html',
    path: '/developers',
    title: 'Quarterback for developers — check AI-written code against requirements you approve',
    description: 'Claude Code in an isolated sandbox, your tests and executable contract checks on the captured change, evidence and a reviewable patch. Supported setup, a real run, dated progress and evidence with its limits.',
    sections: ['nav', 'hero', 'example', 'steps', 'supported', 'progress', 'evidence', 'beta-cta', 'footer'],
  },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function build(page) {
  let body = '';
  page.sections.forEach((s, i) => {
    const content = fs.readFileSync(`src/${s}.html`, 'utf8').trim().replace('{{ORBIT}}', ORBIT);
    body += `\n\n  <!-- ============================================================ -->\n`;
    body += `  <!-- SECTION: ${s.toUpperCase()} → edit: src/${s}.html -->\n`;
    body += `  <!-- ============================================================ -->\n`;
    if (i === 1) body += '  <main id="main" tabindex="-1">\n';
    if (s === 'footer') body += '  </main>\n';
    // Every line is indented, so <pre> blocks are written on one line with &#10; for breaks
    body += '  ' + content.split('\n').join('\n  ') + '\n';
  });
  const url = SITE + page.path;
  const t = esc(page.title), d = esc(page.description);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t}</title>
  <meta name="description" content="${d}">
  <link rel="canonical" href="${url}">

  <link rel="icon" type="image/png" href="./favicon.png">
  <link rel="apple-touch-icon" href="./apple-touch-icon.png">

  <meta property="og:type"         content="website">
  <meta property="og:site_name"    content="Quarterback">
  <meta property="og:url"          content="${url}">
  <meta property="og:title"        content="${t}">
  <meta property="og:description"  content="${d}">
  <meta property="og:image"        content="${SITE}/og-image.png">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt"    content="Quarterback: AI writes the code, Quarterback shows you the evidence. Early, supervised testing.">
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${t}">
  <meta name="twitter:description" content="${d}">
  <meta name="twitter:image"       content="${SITE}/og-image.png">
  <meta name="referrer" content="strict-origin-when-cross-origin">

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Quarterback",
    "description": "${d}",
    "url": "${url}",
    "applicationCategory": "DeveloperApplication",
    "operatingSystem": "Linux",
    "author": { "@type": "Organization", "name": "Velora", "url": "https://velorallc.netlify.app/" }
  }
  </script>

  <link rel="stylesheet" href="./src/styles/fonts.css">
  <link rel="stylesheet" href="./src/styles/main.css">
</head>
<body>
<a class="qb-skip" href="#main">Skip to content</a>
<div style="width: 100%; background: #0D100F; color: #F4F1EA; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; -webkit-font-smoothing: antialiased;">${body}
</div>

<script src="./src/scripts/interactions.js" defer></script>
</body>
</html>
`;
}

for (const page of PAGES) {
  const html = build(page);
  fs.writeFileSync(page.file, html);
  console.log(`Built ${page.file} (${html.length} chars)`);
}
