// Behavioural verification for the main obfuscator.io bench (samples/), the one that until now
// only counted markers and lookups and checked that the output parsed.
//
// That is not enough. A rotation settled one position off, or a case body reordered wrongly,
// produces output that parses, keeps every string, and reports zero unresolved lookups — while
// computing the wrong answer. Exactly that shipped once: the resolver rewrote decoder calls inside
// the rotation IIFE's own checksum, a later pass re-settled against the mangled checksum, and two
// call sites resolved against a table shifted by 25 places. Only running the code found it.
//
// The samples call document.querySelector and fetch, so the sandbox stubs both and records what
// the script tried to send. The comparison is decoded-vs-obfuscated: the obfuscated sample is the
// input we must preserve, not the pristine original (some obfuscator options are not themselves
// behaviour-preserving).
//
// Safe to run: the code under test is this bench's own source, in a vm context with no require,
// no I/O, and no timers that outlive the call.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// Path to the defuscator CLI. Override with the DEFUSCATOR_CLI environment variable; the default
// is the build output relative to this checkout, so the bench works from a clone without editing.
const CLI = process.env.DEFUSCATOR_CLI || path.join(
  __dirname, '..', '..', 'src', 'Defuscator.Cli', 'bin', 'Release', 'net8.0',
  process.platform === 'win32' ? 'defuscator.exe' : 'defuscator');
const dir = path.join(__dirname, 'samples');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

// Runs a script, then calls the payment function it defines and returns a canonical description of
// what happened: the return value plus every request the script attempted.
function observe(code) {
  const sent = [];
  const context = {
    globalThis: null,
    console: { log() {}, warn() {}, error() {}, info() {}, table() {}, trace() {}, clear() {}, exception() {} },
    document: {
      querySelector(sel) { return { value: sel === '#card-number' ? '4242' : sel === '#cvv' ? '123' : '' }; },
      querySelectorAll() { return []; },
    },
    fetch(url, init) { sent.push({ url: String(url), init: init ? JSON.parse(JSON.stringify(init)) : null }); },
    setInterval() { return 0; },
    setTimeout() { return 0; },
    clearInterval() {},
    window: null,
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 5000 });

  // The entry point is normally `collectPayment`; renameGlobals rewrites it, so fall back to the
  // single user-defined function that takes one argument.
  let entry = context.collectPayment;
  if (typeof entry !== 'function') {
    const candidates = Object.keys(context)
      .filter((k) => typeof context[k] === 'function' && context[k].length === 1
        && !['fetch', 'setInterval', 'setTimeout', 'clearInterval'].includes(k));
    if (candidates.length !== 1) {
      return null; // cannot identify the entry point; not a comparison we can trust
    }
    entry = context[candidates[0]];
  }

  const returned = entry({});
  return JSON.stringify({ returned, sent });
}

function analyze(file) {
  let stdout;
  try {
    stdout = execFileSync(CLI, [file, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    stdout = e.stdout || '';
  }
  try {
    return JSON.parse(stdout);
  } catch (e) {
    return null;
  }
}

// selfDefending's guard ends in `.search("(((.+)+)+)+$")`, a regex whose backtracking cost explodes
// with the length of the text it is applied to — it is applied to the guard function's own source.
// Compact source finishes instantly; reformatted source does not. Measured directly: 0 ms over 23
// characters of compact text, 2561 ms over 31 characters of the beautified equivalent.
//
// So a decoded self-defending sample hanging when executed is the option working exactly as
// designed, not a decoding defect — the decoded text is still correct to read, which is what a
// deobfuscator produces. We flag the guard rather than strip it, so the requirement here is that
// the report actually said so.
const SELF_DEFENDING_GUARD = '(((.+)+)+)+$';

function hasSelfDefendingFinding(data) {
  return (data.findings || []).some((f) => (f.Name || f.name) === 'Self-defending anti-tamper guard');
}

const failures = [];
let compared = 0;
let skipped = 0;

console.log('%s %s %s', 'case'.padEnd(28), 'comparable'.padEnd(11), 'behaviour');
console.log('-'.repeat(74));

for (const entry of manifest.cases) {
  if (entry.error) continue;

  const source = fs.readFileSync(entry.file, 'utf8');

  let before;
  try {
    before = observe(source);
  } catch (e) {
    before = null;
  }

  if (before === null) {
    // Anti-analysis samples deliberately fight execution; not being able to run one is a property
    // of the sample, not a decoder defect, so it is reported and skipped rather than failed.
    console.log('%s %s %s', entry.name.padEnd(28), 'no'.padEnd(11), 'obfuscated sample not runnable here');
    skipped++;
    continue;
  }

  const data = analyze(entry.file);
  if (data === null) {
    failures.push(`${entry.name}: CLI produced no JSON`);
    continue;
  }

  const decoded = data.decodedCode || '';

  let after;
  let note = '';
  try {
    after = observe(decoded);
  } catch (e) {
    after = null;
    note = 'THREW: ' + String(e.message).slice(0, 50);
  }

  compared++;
  if (after === null && decoded.includes(SELF_DEFENDING_GUARD)) {
    // Expected: the guard punishes reformatting. What must hold is that we told the user it is
    // there, since we deliberately leave it in place rather than stripping it.
    if (hasSelfDefendingFinding(data)) {
      console.log('%s %s %s', entry.name.padEnd(28), 'yes'.padEnd(11),
        'self-defending guard trips on reformatted source (expected, and reported)');
    } else {
      failures.push(`${entry.name}: self-defending guard survives into the output but was not reported`);
      console.log('%s %s %s', entry.name.padEnd(28), 'yes'.padEnd(11), 'GUARD PRESENT BUT NOT REPORTED');
    }
    compared--;
    skipped++;
  } else if (after === null) {
    failures.push(`${entry.name}: decoded output did not run (${note || 'no entry point'})`);
    console.log('%s %s %s', entry.name.padEnd(28), 'yes'.padEnd(11), note || 'no entry point');
  } else if (after === before) {
    console.log('%s %s %s', entry.name.padEnd(28), 'yes'.padEnd(11), 'same behaviour');
  } else {
    failures.push(`${entry.name}: decoded output behaves differently`);
    console.log('%s %s %s', entry.name.padEnd(28), 'yes'.padEnd(11), 'DIFFERENT BEHAVIOUR');
    console.log('    obfuscated:', String(before).slice(0, 160));
    console.log('    decoded   :', String(after).slice(0, 160));
  }
}

console.log();
console.log(`compared ${compared}, skipped ${skipped}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('Every runnable sample decodes to behaviourally identical code.');
