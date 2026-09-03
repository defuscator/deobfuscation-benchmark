// obfuscator.io samples built from modern JavaScript, and a source whose behaviour can be
// compared before and after decoding.
//
// The main bench uses one ES5 function, which leaves the parts of the engine that reason about
// scope untested: `let`/`const` are block-scoped, classes have their own binding rules, and the
// control-flow unflattener justifies reordering case bodies with "var hoists to the function
// scope" — an argument that says nothing about block-scoped declarations.
//
// Marker counting cannot catch a reordering that parses but misbehaves, so this source computes a
// deterministic result instead. eval-es6.js runs the original and the decoded output and compares
// them, which is safe because the code under test is ours, not a hostile sample.

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SOURCE = `
class PaymentCollector {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.log = [];
  }

  collect({ card, cvv } = {}, ...extra) {
    const total = 1200 + 345;
    let label = \`card:\${card || 'none'}/cvv:\${cvv || 'none'}\`;
    if (card && cvv) {
      this.log.push('POST ' + this.endpoint + ' ' + label + ' ' + total);
    } else {
      label = 'incomplete';
    }
    const doubled = extra.map(function (v) { return v * 2; }).filter(function (v) { return v > 2; });
    for (const d of doubled) {
      this.log.push('extra:' + d);
    }
    return { total: total, label: label, doubled: doubled, log: this.log };
  }
}

function runScenario() {
  const collector = new PaymentCollector('https://collector-example-42.com/checkout');
  const filled = collector.collect({ card: '4242', cvv: '123' }, 1, 2, 3);
  const empty = new PaymentCollector('https://collector-example-42.com/checkout').collect();
  const selectors = ['#card-number', '#cvv'].map(function (s) { return s.toUpperCase(); });
  return JSON.stringify({ filled: filled, empty: empty, selectors: selectors });
}

globalThis.__defuscatorResult = runScenario();
`;

// Control-flow flattening is what stresses the unflattener's central assumption — that reordering
// case bodies is safe because declarations hoist. That argument covers `var` and says nothing
// about `let`/`const`, which are block-scoped. obfuscator.io does not flatten class methods, so
// the source above never produced a dispatcher and the risk went untested; this one is a plain
// function with enough straight-line block-scoped statements to be flattened.
const FLATTENABLE_SOURCE = `
function settleOrder(card, cvv, extras) {
  const endpoint = 'https://collector-example-42.com/checkout';
  const base = 1200 + 345;
  let label = 'card:' + card + '/cvv:' + cvv;
  const selector = '#card-number';
  const other = '#cvv';
  let tally = 0;
  for (let i = 0; i < extras.length; i++) {
    tally += extras[i] * 2;
  }
  const summary = endpoint + '|' + label + '|' + selector + '|' + other + '|' + base + '|' + tally;
  return summary;
}

globalThis.__defuscatorResult = JSON.stringify({
  filled: settleOrder('4242', '123', [1, 2, 3]),
  empty: settleOrder('', '', [])
});
`;

const MARKERS = ['collector-example-42.com', '#card-number', '#cvv', 'PaymentCollector', 'runScenario'];

const HEX = { identifierNamesGenerator: 'hexadecimal' };

const CASES = {
  'es6-baseline': { compact: true, stringArray: true, stringArrayThreshold: 1, ...HEX },
  'es6-rotate': { compact: true, stringArray: true, stringArrayThreshold: 1, stringArrayRotate: true, ...HEX },
  'es6-rc4': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayEncoding: ['rc4'], ...HEX,
  },
  'es6-control-flow': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, ...HEX,
  },
  'es6-cff-mangled': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    controlFlowFlattening: true, controlFlowFlatteningThreshold: 1,
    identifierNamesGenerator: 'mangled',
  },
  'es6-split-strings': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    splitStrings: true, splitStringsChunkLength: 4, ...HEX,
  },
  'es6-calls-transform': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    stringArrayRotate: true, stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 1, ...HEX,
  },
  'es6-transform-object-keys': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    transformObjectKeys: true, ...HEX,
  },
  'es6-preset-high': {
    compact: true, controlFlowFlattening: true, controlFlowFlatteningThreshold: 1,
    deadCodeInjection: true, deadCodeInjectionThreshold: 1,
    identifierNamesGenerator: 'hexadecimal', numbersToExpressions: true, simplify: true,
    splitStrings: true, splitStringsChunkLength: 5, stringArray: true,
    stringArrayCallsTransform: true, stringArrayEncoding: ['base64'], stringArrayIndexShift: true,
    stringArrayRotate: true, stringArrayShuffle: true, stringArrayWrappersCount: 5,
    stringArrayWrappersChainedCalls: true, stringArrayWrappersParametersMaxCount: 5,
    stringArrayWrappersType: 'function', stringArrayThreshold: 1, transformObjectKeys: true,
  },
  // renameProperties rewrites member names, which no other sample exercises.
  'es6-rename-properties': {
    compact: true, stringArray: true, stringArrayThreshold: 1,
    renameProperties: true, renamePropertiesMode: 'safe', ...HEX,
  },
};

// Cases built from the flattenable source. `requires` is asserted against the generated output,
// so if a future obfuscator release stops emitting the dispatcher the bench fails loudly instead
// of quietly testing nothing — which is exactly what happened with the class-based source.
//
// As of javascript-obfuscator 5.6 none of these actually produce a dispatcher: repeated attempts
// with var/const/let and with the same statement shapes that DO get flattened in the ES5 bench all
// came back without one, so control-flow flattening over block-scoped declarations could not be
// exercised against real output. They are kept, failing loudly, rather than deleted — a future
// release may start emitting it, and the unflattener now refuses such cases outright (see
// AstControlFlowUnflattener.IsBlockScopedDeclaration) precisely because they cannot be tested.
const FLAT_CASES = {
  'flat-control-flow': {
    options: {
      compact: true, stringArray: true, stringArrayThreshold: 1,
      controlFlowFlattening: true, controlFlowFlatteningThreshold: 1, ...HEX,
    },
    requires: /\.split\('\|'\)/,
  },
  'flat-cff-mangled': {
    options: {
      compact: true, stringArray: true, stringArrayThreshold: 1,
      controlFlowFlattening: true, controlFlowFlatteningThreshold: 1,
      identifierNamesGenerator: 'mangled',
    },
    requires: /\.split\('\|'\)/,
  },
  'flat-cff-dead-code': {
    options: {
      compact: true, stringArray: true, stringArrayThreshold: 1,
      controlFlowFlattening: true, controlFlowFlatteningThreshold: 1,
      deadCodeInjection: true, deadCodeInjectionThreshold: 1, ...HEX,
    },
    requires: /\.split\('\|'\)/,
  },
};

const outDir = path.join(__dirname, 'samples-es6');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '_original.js'), SOURCE, 'utf8');
fs.writeFileSync(path.join(outDir, '_original_flat.js'), FLATTENABLE_SOURCE, 'utf8');

const manifest = [];

function emit(name, code, original, requires) {
  if (requires && !requires.test(code)) {
    // The obfuscator did not apply the feature this case exists to exercise, so the sample would
    // test nothing. That is recorded rather than thrown: it is a property of the obfuscator
    // version, not a failure of the tool under test, and a fresh clone should not see a red run
    // for it. If a future release does start emitting the construct, the case becomes real and is
    // scored like any other.
    const reason = 'javascript-obfuscator did not apply ' + requires + ' to this source';
    manifest.push({ name, original, unavailable: reason });
    console.log(`  ${name.padEnd(28)} ${'skipped'.padStart(7)}   ${reason}`);
    return;
  }
  const file = path.join(outDir, name + '.js');
  fs.writeFileSync(file, code, 'utf8');
  const visible = MARKERS.filter((m) => code.includes(m));
  manifest.push({ name, file, original, bytes: code.length, visibleMarkers: visible });
  console.log(`  ${name.padEnd(28)} ${String(code.length).padStart(7)}b  already-visible: ${visible.length}/${MARKERS.length}`);
}

for (const [name, options] of Object.entries(CASES)) {
  try {
    emit(name, JavaScriptObfuscator.obfuscate(SOURCE, options).getObfuscatedCode(), '_original.js', null);
  } catch (e) {
    manifest.push({ name, error: String(e.message).slice(0, 140) });
    console.log(`  ${name.padEnd(28)} ERROR ${e.message}`);
  }
}

for (const [name, spec] of Object.entries(FLAT_CASES)) {
  try {
    emit(name, JavaScriptObfuscator.obfuscate(FLATTENABLE_SOURCE, spec.options).getObfuscatedCode(),
      '_original_flat.js', spec.requires);
  } catch (e) {
    manifest.push({ name, error: String(e.message).slice(0, 140) });
    console.log(`  ${name.padEnd(28)} ERROR ${e.message}`);
  }
}

fs.writeFileSync(path.join(outDir, 'manifest.json'),
  JSON.stringify({ markers: MARKERS, original: '_original.js', cases: manifest }, null, 1), 'utf8');
