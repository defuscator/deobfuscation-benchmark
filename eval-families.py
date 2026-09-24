"""Scores the engine against the obfuscator families other than obfuscator.io.

Run gen-families.js first. Two things are measured per sample:

  family   -- what the report names it. Misidentifying a textbook format is a defect on its own,
              because the family is the first thing an analyst reads.
  hidden   -- markers that do not appear verbatim in the obfuscated source, and how many were
              recovered. Only meaningful where we claim to decode; for JJEncode/AAEncode we
              deliberately do not (see Compare.aspx), so a 0 there is expected, not a failure.
  payload  -- for cases that encode something other than the shared skimmer source (the JSFuck
              ones), the exact payload the case encoded must appear in the decoded output. Counting
              markers would say nothing there, because those payloads contain none of them.

The expectations below are asserted, so this exits non-zero if a claim regresses.
"""

import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Path to the defuscator CLI. Override with the DEFUSCATOR_CLI environment variable; the default
# is the build output relative to this checkout, so the bench works from a clone without editing.
CLI = os.environ.get(
    "DEFUSCATOR_CLI",
    os.path.join(HERE, "..", "..", "src", "Defuscator.Cli", "bin", "Release", "net8.0",
                 "defuscator.exe" if os.name == "nt" else "defuscator"))

if not os.path.exists(CLI):
    sys.exit(
        "Could not find the deobfuscator CLI at:\n  %s\n\n"
        "This benchmark scores a tool; it does not ship one. Point it at a build:\n"
        "  DEFUSCATOR_CLI=/path/to/your-tool python3 %s\n" % (CLI, os.path.basename(__file__)))

# family, and whether we claim to actually decode the payload
EXPECTED = {
    "packer-base62":         ("Dean Edwards P.A.C.K.E.R.", True),
    "packer-nested-eval":    ("Dean Edwards P.A.C.K.E.R.", True),
    "jsfuck-small":          ("JSFuck", True),
    "jsfuck-eval":           ("JSFuck", True),
    "jjencode-dollar":       ("AAEncode / JJEncode", False),
    "jjencode-underscore":   ("AAEncode / JJEncode", False),
    "aaencode":              ("AAEncode / JJEncode", False),
    "jjencode-dollar-small": ("AAEncode / JJEncode", False),
    "aaencode-small":        ("AAEncode / JJEncode", False),
}

# The exact text each of these cases encodes (see gen-families.js). A decoder that claims the family
# must hand it back; jsfuck-small encodes a string that is never run, so it comes back as a literal.
EXPECTED_PAYLOAD = {
    "jsfuck-small": 'alert(1)',
    "jsfuck-eval":  'document.querySelector("#cvv")',
}

manifest = json.load(open(os.path.join(HERE, "samples-families", "manifest.json"), encoding="utf-8"))
markers = manifest["markers"]

failures = []
print("%-24s %-28s %-14s %s" % ("case", "family", "hidden->found", "syntax"))
print("-" * 100)

for case in manifest["cases"]:
    if "error" in case:
        failures.append("%s: generation error %s" % (case["name"], case["error"]))
        continue

    name, path = case["name"], case["file"]

    # Endpoint protection quarantines some of these after they are written -- the JJEncode header
    # `$=~[];$={` is a long-standing malware signature, so the `$` variants disappear from disk
    # within seconds while the `_` ones survive. That is the scanner doing its job on a real
    # obfuscation sample, not a defect here, so report it and carry on rather than crashing.
    if not os.path.exists(path):
        print("%-24s %s" % (name, "sample missing from disk (quarantined by endpoint protection?)"))
        continue

    src = open(path, encoding="utf-8").read()
    out = subprocess.run([CLI, path, "--json"], capture_output=True, text=True, errors="replace")
    try:
        data = json.loads(out.stdout)
    except Exception:
        failures.append("%s: CLI produced no JSON" % name)
        continue

    decoded = data.get("decodedCode") or ""
    family = data.get("obfuscatorFamily") or "None detected"
    hidden = [m for m in markers if m not in src]
    found = [m for m in hidden if m in decoded]
    syntax = data.get("syntaxValidation") or ""

    flag = ""
    if name in EXPECTED:
        want_family, want_decode = EXPECTED[name]
        if family != want_family:
            flag = "  <== FAMILY expected %r" % want_family
            failures.append("%s: family %r, expected %r" % (name, family, want_family))
        elif want_decode and name in EXPECTED_PAYLOAD:
            if EXPECTED_PAYLOAD[name] not in decoded:
                flag = "  <== PAYLOAD not recovered"
                failures.append("%s: decoded output does not contain %r" % (name, EXPECTED_PAYLOAD[name]))
            else:
                flag = "  payload recovered"
        elif want_decode and hidden and len(found) < len(hidden):
            flag = "  <== MISSED %d" % (len(hidden) - len(found))
            failures.append("%s: recovered %d of %d hidden markers" % (name, len(found), len(hidden)))

    if "parse error" in syntax:
        failures.append("%s: decoded output does not parse" % name)

    print("%-24s %-28s %-14s %s%s" % (
        name, family[:28],
        ("%d->%d" % (len(hidden), len(found))) if hidden else "none hidden",
        syntax[:34], flag))

print()
if failures:
    print("FAILURES:")
    for f in failures:
        print("  -", f)
    sys.exit(1)

print("All family expectations hold.")
