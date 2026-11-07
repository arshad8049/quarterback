// Run: node build.js
// Assembles all section files in src/ into a single index.html
const fs = require('fs');

const sections = [
  'nav',
  'hero',
  'example',
  'steps',
  'supported',
  'progress',
  'evidence',
  'beta-cta',
  'footer',
];

let body = '';
for (const s of sections) {
  const content = fs.readFileSync(`src/${s}.html`, 'utf8').trim();
  body += `\n\n  <!-- ============================================================ -->\n`;
  body += `  <!-- SECTION: ${s.toUpperCase()} → edit: src/${s}.html -->\n`;
  body += `  <!-- ============================================================ -->\n`;
  if (s === 'hero') body += '  <main id="main" tabindex="-1">\n';
  body += '  ' + content.split('\n').join('\n  ') + '\n';
  if (s === 'beta-cta') body += '  </main>\n';
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quarterback — Check AI-written code against your requirements</title>
  <meta name="description" content="Quarterback turns a coding request into requirements you approve, runs Claude Code in an isolated workspace, and checks the resulting changes. You get a proposed patch, test results and a record of what remains unresolved. Pre-release, in supervised evaluation.">

  <!-- Canonical -->
  <link rel="canonical" href="https://quarterback.velorallc.workers.dev/">

  <!-- Favicon -->
  <link rel="icon" type="image/png" href="./favicon.png">
  <link rel="apple-touch-icon" href="./favicon.png">

  <!-- Open Graph -->
  <meta property="og:type"        content="website">
  <meta property="og:site_name"   content="Quarterback">
  <meta property="og:url"         content="https://quarterback.velorallc.workers.dev/">
  <meta property="og:title"       content="Quarterback — Check AI-written code against your requirements">
  <meta property="og:description" content="Quarterback turns a coding request into requirements you approve, runs Claude Code in an isolated workspace, and checks the resulting changes. You get a proposed patch, test results and a record of what remains unresolved. Pre-release, in supervised evaluation.">
  <meta property="og:image"       content="https://quarterback.velorallc.workers.dev/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt"   content="Quarterback">

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="Quarterback — Check AI-written code against your requirements">
  <meta name="twitter:description" content="Quarterback turns a coding request into requirements you approve, runs Claude Code in an isolated workspace, and checks the resulting changes. You get a proposed patch, test results and a record of what remains unresolved. Pre-release, in supervised evaluation.">
  <meta name="twitter:image"       content="https://quarterback.velorallc.workers.dev/og-image.png">

  <!-- Security -->
  <meta http-equiv="X-Content-Type-Options" content="nosniff">
  <meta http-equiv="X-Frame-Options" content="DENY">
  <meta name="referrer" content="strict-origin-when-cross-origin">

  <!-- JSON-LD structured data -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Quarterback",
    "description": "Quarterback turns a coding request into requirements you approve, runs Claude Code in an isolated workspace, and checks the resulting changes. You get a proposed patch, test results and a record of what remains unresolved. Pre-release, in supervised evaluation.",
    "url": "https://quarterback.velorallc.workers.dev/",
    "applicationCategory": "DeveloperApplication",
    "operatingSystem": "Linux",
    "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    "author": { "@type": "Organization", "name": "Velora", "url": "https://velorallc.netlify.app/" }
  }
  </script>

  <!-- Fonts → edit: src/styles/fonts.css -->
  <link rel="stylesheet" href="./src/styles/fonts.css">

  <!-- Styles → edit: src/styles/main.css -->
  <link rel="stylesheet" href="./src/styles/main.css">

  <!-- Scripts (order matters) -->
  <script src="./src/scripts/react.js"></script>
  <script src="./src/scripts/react-dom.js"></script>
  <script src="./src/scripts/dc-runtime.js"></script>
</head>
<body>
<a class="qb-skip" href="#main">Skip to content</a>
<div style="width: 100%; background: #0D100F; color: #F4F1EA; font-family: 'IBM Plex Sans', 'Helvetica Neue', sans-serif; -webkit-font-smoothing: antialiased;">${body}
</div>

<!-- Interactions → edit: src/scripts/interactions.js -->
<script src="./src/scripts/interactions.js" defer></script>
</body>
</html>
`;

fs.writeFileSync('index.html', html);
console.log(`Built index.html (${html.length} chars)`);
