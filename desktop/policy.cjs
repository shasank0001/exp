const path = require('node:path');
const fs = require('node:fs');
const ROOT_URL = 'mlcopilot://app';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
// Serve only presentation assets; never serve main/preload code or app records.
function resolveAsset(url, root) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'mlcopilot:' || parsed.hostname !== 'app' || parsed.port || parsed.username || parsed.password) return null;
    const relative = decodeURIComponent(parsed.pathname).slice(1);
    if (!/^(desktop|variants)\//.test(relative) || !/\.(html|css|js|woff2|png|svg)$/.test(relative)) return null;
    if (parsed.search || parsed.hash) return null;
    const candidate = fs.realpathSync(path.join(root, relative));
    const allowed = ['desktop', 'variants'].some(dir => {
      const base = fs.realpathSync(path.join(root, dir));
      const rel = path.relative(base, candidate);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    return allowed && fs.statSync(candidate).isFile() ? candidate : null;
  } catch { return null; }
}
module.exports = { ROOT_URL, CSP, resolveAsset };
