// The obfuscation direction: does obfuscating a program change what it computes, and can the
// deobfuscator wind it back?
//
// The asymmetry matters. A deobfuscator that gets something wrong produces a bad report about
// somebody else's code. An obfuscator that gets something wrong silently corrupts code the user
// pasted in and is about to ship. So the primary measure here is not "does it look obfuscated":
// it is whether the output still computes what the input computed.
//
// Three properties are checked per case:
//
//   parses      the output is valid JavaScript
//   behaviour   obfuscated output computes the same value as the input
//   round-trip  the page claims "output is designed to round-trip: the analyzer can statically
//               unwind what this produces", so the decoded output must behave identically too,
//               and the strings the obfuscator hid must come back
//
// Every input sets globalThis.__r to a deterministic value. Running them is safe: they are this
// file's own programs, in a vm context with no require and no I/O.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// A tool that both obfuscates (--obfuscate) and analyses (--json). Override with DEFUSCATOR_CLI.
const EXE = process.platform === 'win32' ? 'defuscator.exe' : 'defuscator';
const CLI = process.env.DEFUSCATOR_CLI || ['Release', 'Debug']
  .map((cfg) => path.join(__dirname, '..', '..', 'src', 'Defuscator.Cli', 'bin', cfg, 'net8.0', EXE))
  .find((p) => fs.existsSync(p))
  || path.join(__dirname, '..', '..', 'src', 'Defuscator.Cli', 'bin', 'Release', 'net8.0', EXE);

if (!fs.existsSync(CLI)) {
  console.error(`Could not find the CLI at:\n  ${CLI}\n`);
  console.error('This benchmark scores a tool; it does not ship one. Point it at a build:');
  console.error(`  DEFUSCATOR_CLI=/path/to/your-tool node ${path.basename(__filename)}\n`);
  process.exit(2);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'obf-bench-'));

// Each case is a complete program assigning a deterministic value to globalThis.__r. They lean
// deliberately on the constructs an AST-splicing obfuscator is most likely to mishandle: places
// where a string is syntax rather than data, and characters that a hex escaper can truncate.
const CASES = {
  'es5-basic': `
    function add(a, b) { return a + b; }
    var greeting = "hello";
    globalThis.__r = greeting + " " + add(2, 3);`,

  'use-strict-directive': `
    function f() { "use strict"; try { undeclared = 1; return "assigned"; } catch (e) { return e.name; } }
    globalThis.__r = f();`,

  'object-literal-keys': `
    var o = { "alpha": 1, beta: 2, 3: "three" };
    globalThis.__r = JSON.stringify([o.alpha, o.beta, o[3], Object.keys(o)]);`,

  'class-members': `
    class C {
      constructor() { this.v = "init"; }
      greet() { return "hi " + this.v; }
      get doubled() { return this.v + this.v; }
      static make() { return new C(); }
    }
    globalThis.__r = JSON.stringify([C.make().greet(), new C().doubled]);`,

  'template-literals': `
    var name = "world";
    var t = \`hello \${name} and \${1 + 2}\`;
    globalThis.__r = t + "|" + \`raw \\n not newline\`.length;`,

  'regex-literals': `
    var re = /"quoted"|\\/slash\\//g;
    globalThis.__r = JSON.stringify([re.source, re.flags, 'a"quoted"b'.replace(re, "X")]);`,

  'string-escapes': `
    var s = "quote:\\" backslash:\\\\ tab:\\t newline:\\n";
    globalThis.__r = JSON.stringify([s.length, s]);`,

  'unicode-and-emoji': `
    var s = "caf\\u00e9 \\u4e2d\\u6587 \\ud83d\\ude00 end";
    globalThis.__r = JSON.stringify([s, s.length, [...s].length]);`,

  'control-characters': `
    var s = "a\\u0000b\\u007fc\\u2028d";
    globalThis.__r = JSON.stringify([s.length, s.charCodeAt(1), s.charCodeAt(3), s.charCodeAt(5)]);`,

  'numeric-forms': `
    var values = [0, -0, 0.5, 1e21, 255, 0xff, 1_000, 9007199254740993];
    globalThis.__r = JSON.stringify(values.map(String));`,

  'reserved-word-properties': `
    var o = { class: 1, default: 2, new: 3, function: 4, in: 5 };
    globalThis.__r = JSON.stringify([o.class, o.default, o.new, o.function, o.in]);`,

  'property-shorthand': `
    var a = 1, b = 2;
    var o = { a, b, ['comp' + 'uted']: 3 };
    globalThis.__r = JSON.stringify([o.a, o.b, o.computed, Object.keys(o)]);`,

  'destructuring': `
    function f({ x, y = 5 } = {}, ...rest) { return [x, y, rest.length]; }
    var [p, q] = [1, 2];
    globalThis.__r = JSON.stringify([f({ x: 1 }, 9, 9), f(), p, q]);`,

  'getters-setters': `
    var o = { _v: 1, get v() { return this._v; }, set v(n) { this._v = n * 2; } };
    o.v = 4;
    globalThis.__r = JSON.stringify([o.v, o._v]);`,

  'optional-chaining': `
    var o = { a: { b: null } };
    globalThis.__r = JSON.stringify([o?.a?.b?.c ?? "fallback", o.missing?.deep]);`,

  'labels-and-loops': `
    var seen = [];
    outer: for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) { if (j === 1) continue outer; seen.push(i + ":" + j); } }
    globalThis.__r = JSON.stringify(seen);`,

  'try-catch-throw': `
    function f() { try { throw new TypeError("boom"); } catch (e) { return e.name + ":" + e.message; } finally { globalThis.__fin = "ran"; } }
    globalThis.__r = f() + "|" + globalThis.__fin;`,

  'arrow-and-closures': `
    var mul = (a) => (b) => a * b;
    var xs = [1, 2, 3].map(function (n) { return mul(2)(n); });
    globalThis.__r = JSON.stringify(xs);`,

  'for-in-and-of': `
    var o = { a: 1, b: 2 };
    var keys = []; for (var k in o) { keys.push(k); }
    var vals = []; for (const v of [10, 20]) { vals.push(v); }
    globalThis.__r = JSON.stringify([keys, vals]);`,

  'already-bracketed': `
    var o = { x: 1 };
    globalThis.__r = JSON.stringify([o['x'], o["x"], o.x]);`,

  'json-and-property-order': `
    var o = {}; o.zed = 1; o.alpha = 2; o[2] = 3; o[1] = 4;
    globalThis.__r = JSON.stringify(o) + "|" + Object.keys(o).join(",");`,

  // A private name is not a property name: rewriting this.#v as this['#v'] would be a syntax
  // error, and `#v in o` is a distinct form again.
  'private-class-fields': `
    class C { #secret = "hidden"; reveal() { return this.#secret; } static has(o) { return #secret in o; } }
    globalThis.__r = new C().reveal() + "|" + C.has(new C());`,

  // The obfuscator introduces a lookup array; if the input already binds that name, a naive
  // implementation shadows the user's own variable.
  'array-name-collision': `
    var _0xa = ["keep-me"];
    globalThis.__r = _0xa[0] + "|" + "other";`,

  // The tag function receives the literal's cooked and raw parts; they must survive intact.
  'tagged-template': `
    function tag(strings, ...vals) { return JSON.stringify([strings.raw, strings.slice(), vals]); }
    globalThis.__r = tag\`a\${1}b\\tc\`;`,

  // __proto__ as a literal key sets the prototype; as a computed key it is an ordinary property.
  'proto-key': `
    var a = { __proto__: { inherited: 1 } };
    var b = { ["__proto__"]: 2 };
    globalThis.__r = JSON.stringify([a.inherited, Object.keys(a), b.__proto__, Object.keys(b)]);`,

  // Numeric and string keys are interchangeable at the language level but not textually.
  'numeric-and-quoted-keys': `
    var o = { 1: "one", "2": "two", 0.5: "half" };
    globalThis.__r = JSON.stringify([o[1], o["1"], o[2], o[0.5], Object.keys(o)]);`,

  // super.method() is bound to the home object, not to a computed lookup on this.
  'class-super': `
    class A { name() { return "A"; } }
    class B extends A { name() { return "B>" + super.name(); } }
    globalThis.__r = new B().name();`,

  'switch-with-strings': `
    function f(v) { switch (v) { case "one": return 1; case "two": return 2; default: return 0; } }
    globalThis.__r = JSON.stringify([f("one"), f("two"), f("x")]);`,
};

// The values the obfuscator actually hid, read from the string array it emitted rather than
// guessed at from the input. An earlier version of this check scanned the *source* for quoted
// text, which reported false failures: source written as "caf\u00e9" is the six characters of an
// escape sequence, while the decoded output holds the one character it denotes, so a plain
// substring test never matched. Reading the obfuscator's own table removes that mismatch.
function hiddenValues(obfuscated) {
  const decl = obfuscated.match(/var\s+_0x[0-9a-f]+\s*=\s*\[([\s\S]*?)\];/i);
  if (!decl) return [];

  const values = [];
  const re = /'((?:\\.|[^'])*)'/g;
  let m;
  while ((m = re.exec(decl[1]))) {
    const raw = m[1]
      .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    values.push(raw);
  }

  // Control characters and quotes are deliberately re-escaped in decoded output rather than
  // emitted raw, so a substring test on them compares different representations. Those are not
  // evidence either way and are excluded instead of counted as misses.
  return values.filter((v) => v.length > 0 && !/[\u0000-\u001f\u007f\u2028\u2029'"\\]/.test(v));
}

function run(code) {
  const context = { globalThis: null, console: { log() {} }, JSON, Object, Math, String, Number, Array, TypeError, Error };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context, { timeout: 5000 });
  return context.__r;
}

function cli(args) {
  try {
    return execFileSync(CLI, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || '';
  }
}

const failures = [];
let ok = 0;

console.log('%s %s %s %s', 'case'.padEnd(26), 'parses'.padEnd(7), 'behaviour'.padEnd(11), 'round-trip');
console.log('-'.repeat(72));

for (const [name, source] of Object.entries(CASES)) {
  const file = path.join(WORK, name + '.js');
  fs.writeFileSync(file, source, 'utf8');

  let expected;
  try {
    expected = run(source);
  } catch (e) {
    failures.push(`${name}: the INPUT itself does not run (${e.message.slice(0, 70)}) — fix the case, not the tool`);
    continue;
  }

  const obfuscated = cli([file, '--obfuscate']);
  if (!obfuscated.trim()) {
    failures.push(`${name}: obfuscator produced no output`);
    continue;
  }

  // 1. parses
  let parses = true;
  try {
    new vm.Script(obfuscated);
  } catch (e) {
    parses = false;
    failures.push(`${name}: obfuscated output does not parse (${e.message.slice(0, 70)})`);
  }

  // 2. behaviour preserved
  let behaviour = 'n/a';
  if (parses) {
    try {
      const actual = run(obfuscated);
      if (actual === expected) {
        behaviour = 'same';
      } else {
        behaviour = 'DIFFERENT';
        failures.push(`${name}: obfuscated output computes a different value\n      input:      ${String(expected).slice(0, 150)}\n      obfuscated: ${String(actual).slice(0, 150)}`);
      }
    } catch (e) {
      behaviour = 'THREW';
      failures.push(`${name}: obfuscated output threw (${e.message.slice(0, 70)})`);
    }
  }

  // 3. round-trip: the product claims the analyzer statically unwinds what this produces
  let roundTrip = 'n/a';
  if (parses && behaviour === 'same') {
    const obfFile = path.join(WORK, name + '.obf.js');
    fs.writeFileSync(obfFile, obfuscated, 'utf8');
    let decoded = '';
    try {
      decoded = JSON.parse(cli([obfFile, '--json'])).decodedCode || '';
    } catch (e) {
      decoded = '';
    }

    if (!decoded) {
      roundTrip = 'NO OUTPUT';
      failures.push(`${name}: analyzer produced no decoded output for our own obfuscation`);
    } else {
      try {
        const back = run(decoded);
        if (back !== expected) {
          roundTrip = 'DIFFERENT';
          failures.push(`${name}: round-trip changed behaviour\n      input:   ${String(expected).slice(0, 150)}\n      decoded: ${String(back).slice(0, 150)}`);
        } else {
          // The real requirement is that no obfuscation machinery survives: no string-array
          // declaration and no lookups into one. Counting recovered strings looks like the
          // obvious measure and is a bad one, because the analyzer legitimately does *better*
          // than substitution on some inputs - given `var o = {class: 1}; o.class`, it folds the
          // read to `1` and drops the dead object, so the string is absent from the output for
          // the right reason. Behaviour equality above is what proves the fold was sound.
          const residue = /var\s+_0x[0-9a-f]+\s*=\s*\[/i.test(decoded) || /_0x[0-9a-f]+\s*\[/i.test(decoded);
          const hidden = hiddenValues(obfuscated);
          const recovered = hidden.filter((s) => decoded.includes(s));
          if (residue) {
            roundTrip = 'ARRAY LEFT';
            failures.push(`${name}: string-array machinery survives our own round-trip`);
          } else {
            // Reported for information; a value can be legitimately absent because it was folded.
            roundTrip = `clean (${recovered.length}/${hidden.length} inlined)`;
          }
        }
      } catch (e) {
        roundTrip = 'THREW';
        failures.push(`${name}: decoded output threw (${e.message.slice(0, 70)})`);
      }
    }
  }

  if (parses && behaviour === 'same' && String(roundTrip).startsWith('clean')) ok++;
  console.log('%s %s %s %s', name.padEnd(26), (parses ? 'yes' : 'NO').padEnd(7), behaviour.padEnd(11), roundTrip);
}

fs.rmSync(WORK, { recursive: true, force: true });

console.log();
console.log(`${ok} of ${Object.keys(CASES).length} cases fully clean`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('Obfuscation preserves behaviour and round-trips on every case.');
