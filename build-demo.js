// Builds dist/magetsi-demo.html: one self-contained file that runs in demo mode with no server.
const fs = require('node:fs');
const path = require('node:path');
const pub = (f) => fs.readFileSync(path.join(__dirname, 'public', f), 'utf8');

const icon = 'data:image/svg+xml,' + encodeURIComponent(pub('icon.svg').trim());

// The built file always runs in demo mode, also when hosted (for example on GitHub Pages),
// so it never waits for a server that isn't there.
const demoCheck = "if (location.protocol === 'file:') return useDemo();";
const app = pub('app.js');
if (!app.includes(demoCheck)) throw new Error('build-demo: demo check not found in public/app.js');

let html = pub('index.html')
  .replace('<link rel="manifest" href="manifest.webmanifest">', '')
  .replace('href="icon.svg"', `href="${icon}"`)
  .replace('<script src="core.js"></script>', () => `<script>\n${pub('core.js')}\n</script>`)
  .replace('<script src="app.js"></script>', () => `<script>\n${app.replace(demoCheck, 'return useDemo();').replace("icon: 'icon.svg', badge: 'icon.svg'", `icon: '${icon}'`)}\n</script>`);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'magetsi-demo.html'), html);
console.log('Wrote dist/magetsi-demo.html', Math.round(html.length / 1024), 'KB');
