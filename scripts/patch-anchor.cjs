const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', '@coral-xyz', 'anchor', 'dist', 'cjs', 'index.js');

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');
  const brokenPattern = 'Object.defineProperty(exports, "BN", { enumerable: true, get: function () { return __importDefault(bn_js_1).default; } });';
  const fixedPattern = 'var bn_default = __importDefault(bn_js_1);\nObject.defineProperty(exports, "BN", { enumerable: true, get: function () { return bn_default.default; } });';

  if (content.includes(brokenPattern)) {
    content = content.replace(brokenPattern, fixedPattern);
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('[patch-anchor] Successfully patched @coral-xyz/anchor for Node.js ESM named export compatibility.');
  }
}
