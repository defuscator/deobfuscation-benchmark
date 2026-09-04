# Deobfuscation benchmark

A reproducible benchmark for JavaScript deobfuscators. Samples come from the **real obfuscators**,
generated on your machine rather than committed here, and correctness is checked by **running the
decoded code** and comparing what it computes.

It scores [Defuscator](https://defuscator.com) because that is what we built it for, but nothing in
it is specific to us. If you maintain a deobfuscator, point `DEFUSCATOR_CLI` at your own and it will
score that instead. We would rather be measured against a shared method than trade adjectives.

## Why this exists

Our engine's landing page promised that it applied the string array's rotation count and inlined
every lookup back to its string. Both sentences were written from a correct understanding of how
javascript-obfuscator worked, and neither was true of what the tool actually emits today. We found
out by finally testing against the real thing:

```
baseline-stringarray  ... none hidden   22->22   <== lookups remain
encoding-base64       ... 4->0          21->21   <== MISSED 4
encoding-rc4          ... 4->0          19->19   <== MISSED 4
kitchen-sink          ... 4->0          36->36   <== MISSED 4
self-defending        ... Decoded output has a parse error
```

Zero lookups resolved, in every sample — while the report read like a success. The unit tests
passed the whole time, because their samples had been hand-written to look like obfuscator.io
output rather than produced by it.

That is the first reason to generate samples instead of committing them. A fixture checked into a
repository could have been written to pass.

## Why counting strings is not enough

The obvious test is to obfuscate a script with distinctive markers and check they come back. On its
own it is close to useless:

- **Most markers were never hidden.** A string array holds its entries in plain text, so grepping
  the obfuscated file already finds them. Only markers that do *not* appear verbatim in the
  obfuscated source prove anything, and only those are counted here.
- **Wrong output is indistinguishable from right output.** A string-array table settled a few
  positions out of alignment resolves every call site to a real string from the wrong entry.

The second one is not hypothetical. We shipped it: 177 of 179 call sites correct, the other two off
by exactly 25 places, producing `globalThis.__defuscatGvrciRBJnR` where the source said
`__defuscatorResult`. The output parsed, contained every expected marker, and reported zero
unresolved lookups. Only executing it found the bug. The sample is pinned in `samples-regression/`.

## What is scored

| Measure | Meaning |
| --- | --- |
| **family** | What the report calls the sample. Misnaming a textbook format is a defect on its own — it is the first line an analyst reads. |
| **lookups** | Call sites into a string-array decoder, before and after. |
| **hidden markers** | Recovery of strings that are absent from the obfuscated source. |
| **behaviour** | Decoded output executed and compared against the obfuscated input. |

Two rules keep the comparison honest:

- The reference is the **obfuscated input, not the original source**. Some obfuscator options are
  not behaviour-preserving in themselves — `renameProperties` rewrites the keys `JSON.stringify`
  emits — and scoring against the pristine original blames the deobfuscator for the obfuscator's
  own change. An early version of this harness made exactly that mistake.
- Generation **asserts that a sample exhibits the feature under test**. One control-flow-flattening
  case turned out to contain no dispatcher at all, because obfuscator.io does not flatten class
  methods. It had been passing while testing nothing.

## Running it

Requires Node 18+, Python 3.8+, and a built CLI.

```bash
npm install
npm run generate      # writes samples/, samples-es6/, samples-families/
npm run score         # family, lookups, markers, behaviour, obfuscation
```

Point it at any deobfuscator that accepts a file and emits JSON:

```bash
DEFUSCATOR_CLI=/path/to/your-tool npm run score
```

Scripts individually:

| Script | Covers |
| --- | --- |
| `gen.js` / `eval.py` | 31 obfuscator.io samples across the option matrix |
| `gen-es6.js` / `eval-es6.js` | 10 samples from ES2015+ source, behaviour-checked |
| `gen-families.js` / `eval-families.py` | P.A.C.K.E.R., JSFuck, JJEncode, AAEncode |
| `eval-behaviour.js` | Behaviour check over the main matrix |
| `eval-obfuscation.js` | The obfuscation direction: 28 programs, behaviour + round-trip |

`eval-families.py` and `eval-es6.js` exit non-zero when an expectation regresses, so they work in CI.

## Sample sources

Nothing here is hand-written to resemble obfuscator output.

- **obfuscator.io** — the `javascript-obfuscator` npm package.
- **Dean Edwards P.A.C.K.E.R.** — implemented in `gen-families.js`, because the published package
  needs native bindings. Every packed sample is round-tripped through the unpacking half of its own
  payload before it is accepted; a generator that lies would make the whole exercise worthless.
- **JSFuck** — the `jsfuck` npm package.
- **JJEncode / AAEncode** — the authors' own single-file encoders, fetched at first run and cached.
  Not vendored: it is someone else's code.

Some endpoint protection quarantines the JJEncode `$` samples within seconds of them being written —
`$=~[];$={` is a long-standing malware signature. The harness reports that and carries on.

## Current results

Defuscator, against javascript-obfuscator 5.6:

| | |
| --- | --- |
| Named as obfuscator.io | 30 of 31 — the exception was generated with `stringArray` disabled |
| Unresolved string-array lookups | **0 across all 31** |
| Decoded output parses | 31 of 31 |
| Behaviourally identical to input | **29 of 31 compared** (2 self-defending, below) |
| Modern-JavaScript matrix | **10 of 10** behaviourally identical |
| Dean Edwards P.A.C.K.E.R. | Unpacked; original source recovered |
| JSFuck / JJEncode / AAEncode | Identified, **not decoded** |
| Obfuscation direction | **28 of 28** preserve behaviour, parse, and round-trip |

### The two skipped samples

Decoded output from a `selfDefending` sample hangs when executed, though the obfuscated original
runs instantly. That is the option working as designed, not a decoding defect. The guard ends in a
search against `(((.+)+)+)+$` applied to the guard function's own source, and that pattern's
backtracking cost explodes with length — measured at **0 ms over 23 characters of compact text and
2561 ms over the 31-character beautified equivalent**. Reformatting is precisely what it punishes.

Those samples are exempt only when the report actually flagged the guard, which the harness asserts,
so the exemption cannot quietly become a blind spot.

## The obfuscation direction

`eval-obfuscation.js` scores the other direction, which is the riskier one: a deobfuscator that
errs writes a bad report about someone else's code, while an obfuscator that errs corrupts code the
user pasted in and is about to ship. 28 self-contained programs are executed before and after
obfuscation, then the result is fed back through the deobfuscator and executed again.

Cases target where an AST rewrite is most likely to go wrong — `"use strict"` as a directive rather
than data, object-literal keys, class members and `super`, private class fields (`this.#v` is a
private name, not a property), tagged templates, regex literals, surrogate pairs, control
characters, `__proto__` keys, and an input that already declares the identifier the obfuscator
wants for its own array.

Round-trip is **not** scored by counting recovered strings, which is the obvious measure and a bad
one. Given `var o = { class: 1 }; o.class`, a good analyzer folds the read to `1` and drops the
dead object, so the string is legitimately absent. What is required is that no machinery survives —
no array declaration, no lookups into one — with behavioural equality proving the fold was sound.

## Known limits

- Obfuscation **strength** is not measured, only correctness and reversibility.
- One source program per matrix. Broader corpora would test more of a real engine.
- The behaviour check needs a deterministic entry point, so samples are written for that.
- `renameGlobals` renames a function the original source defined; no decoder can recover the name,
  and the harness records that as a known miss rather than a failure.

## Contributing

Adding an option combination, a family, or another tool to score is all welcome. The one rule: a
sample must come from a real obfuscator, or from a generator that verifies its own output before
emitting it.

MIT licensed.
