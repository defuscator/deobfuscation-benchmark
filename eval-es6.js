// Scores the engine on modern-JavaScript obfuscator.io output, and — unlike the marker-counting
// benches — checks that the decoded code still *behaves* the same as the original.
//
// A transform that reorders statements (the control-flow unflattener) or moves declarations out of
// a block can produce output that parses cleanly, keeps every string, and still computes the wrong
// answer. Only running it catches that. This is safe: the code under test is the generator's own
// source, not a hostile sample, and it runs in a vm context with no require and no I/O.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const HERE = __dirname;
// Path to the defuscator CLI. Override with the DEFUSCATOR_CLI environment variable; the default
// is the build output relative to this checkout, so the bench works from a clone without editing.
const CLI = process.env.DEFUSCATOR_CLI || path.join(
  __dirname, '..', '..', 'src', 'Defuscator.Cli', 'bin', 'Release', 'net8.0',
  process.platform === 'win32' ? 'defuscator.exe' : 'defuscator');

if (!fs.existsSync(CLI)) {
  console.error(`Could not find the deobfuscator CLI at:\n  ${CLI}\n`);
  console.error('This benchmark scores a tool; it does not ship one. Point it at a build:');
  console.error(`  DEFUSCATOR_CLI=/path/to/your-tool node ${path.basename(__filename)}\n`);
  process.exit(2);
}
const dir = path.join(HERE, 'samples-es6');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const markers = manifest.markers;

function runInSandbox(code) {
  const context = { globalThis: null, console: { log() {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 5000 });
  return context.__defuscatorResult;
}

const expectedByOriginal = new Map();
function expectedFor(originalFile) {
  if (!expectedByOriginal.has(originalFile)) {
    expectedByOriginal.set(originalFile, runInSandbox(fs.readFileSync(path.join(dir, originalFile), 'utf8')));
  }
  return expectedByOriginal.get(originalFile);
}

const failures = [];
console.log('%s %s %s %s', 'case'.padEnd(28), 'lookups'.padEnd(9), 'hidden'.padEnd(8), 'behaviour');
console.log('-'.repeat(78));

const LOOKUP = /\b(?!parseInt\b)[A-Za-z_$][\w$]*\s*\(\s*(?:-?0x[0-9a-f]+|-?\d+|'0x[0-9a-f]+')\s*[,)]/g;

for (const entry of manifest.cases) {
  if (entry.unavailable) {
    console.log('%s %s %s %s', entry.name.padEnd(28), '-'.padEnd(9), '-'.padEnd(8),
      'not produced by this obfuscator version');
    continue;
  }

  if (entry.error) {
    failures.push(`${entry.name}: generation error ${entry.error}`);
    continue;
  }

  const source = fs.readFileSync(entry.file, 'utf8');
  // The CLI signals risk level through its exit code, so a non-zero status is expected; what
  // matters is whether it produced JSON on stdout.
  let stdout;
  try {
    stdout = execFileSync(CLI, [entry.file, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    stdout = e.stdout || '';
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch (e) {
    failures.push(`${entry.name}: CLI produced no JSON`);
    continue;
  }

  const decoded = data.decodedCode || '';
  const hidden = markers.filter((m) => !source.includes(m));
  const found = hidden.filter((m) => decoded.includes(m));
  const before = (source.match(LOOKUP) || []).length;
  const after = (decoded.match(LOOKUP) || []).length;

  // The reference for a deobfuscator is the *obfuscated* input, not the original source: some
  // obfuscator.io options are not themselves behaviour-preserving (renameProperties rewrites
  // member names, which changes JSON.stringify output), and it would be wrong to score the
  // decoder against a difference the obfuscator introduced.
  let obfuscatedResult;
  let obfuscatedRan = true;
  try {
    obfuscatedResult = runInSandbox(source);
  } catch (e) {
    obfuscatedRan = false;
  }

  const expected = expectedFor(entry.original || manifest.original);
  const faithful = obfuscatedRan && obfuscatedResult === expected ? '' : ' [obfuscator changed behaviour]';

  let behaviour;
  if (/parse error/.test(data.syntaxValidation || '')) {
    behaviour = 'PARSE ERROR';
    failures.push(`${entry.name}: decoded output does not parse`);
  } else {
    try {
      const actual = runInSandbox(decoded);
      if (!obfuscatedRan) {
        behaviour = 'obfuscated sample would not run';
      } else if (actual === obfuscatedResult) {
        behaviour = 'same result' + faithful;
      } else {
        behaviour = 'DIFFERENT RESULT';
        failures.push(`${entry.name}: decoded output does not match the obfuscated input`);
      }
    } catch (e) {
      behaviour = 'THREW: ' + String(e.message).slice(0, 40);
      failures.push(`${entry.name}: decoded output threw (${String(e.message).slice(0, 80)})`);
    }
  }

  if (hidden.length && found.length < hidden.length) {
    failures.push(`${entry.name}: recovered ${found.length} of ${hidden.length} hidden markers`);
  }

  console.log('%s %s %s %s',
    entry.name.padEnd(28),
    `${before}->${after}`.padEnd(9),
    (hidden.length ? `${hidden.length}->${found.length}` : 'none').padEnd(8),
    behaviour);
}

console.log();
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('All ES6 samples decode to behaviourally identical code.');
