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

manifest = json.load(open(os.path.join(HERE, "samples", "manifest.json"), encoding="utf-8"))
markers = manifest["markers"]

# A call whose first argument is a bare index: hex, decimal, or the 'hexadecimal-numeric-string'
# form. Identifier-agnostic so mangled names count. parseInt() is excluded because its argument is
# itself a call.
#
# This is an APPROXIMATE signal, not ground truth. It matches any `identifier(number)`, so it also
# counts things that are not string-array lookups at all: a proxy object's arithmetic method
# `_0x1a.BOiqy(1200, 345)`, debugProtection's own self-call `_0x(0)`, an ordinary `slice(1)`. On a
# fully resolved sample these leave a non-zero "after" count that means nothing. The engine's own
# "Unresolved string-array lookups" finding is the authority, and the "lookups remain" flag below is
# driven by that finding, not by this regex. The b->a column is kept only as a rough visual cue and
# is labelled approximate.
LOOKUP = re.compile(r"\b(?!parseInt\b)[A-Za-z_$][\w$]*\s*\(\s*(?:-?0x[0-9a-f]+|-?\d+|'0x[0-9a-f]+')\s*[,)]")

rows = []
for case in manifest["cases"]:
    if "error" in case:
        continue
    name = case["name"]
    path = case["file"]
    src = open(path, encoding="utf-8").read()

    out = subprocess.run([CLI, path, "--json"], capture_output=True, text=True, errors="replace")
    if out.returncode not in (0, 1, 2) or not out.stdout.strip():
        rows.append((name, "CLI-FAIL", 0, 0, 0, 0, "", "?"))
        continue
    try:
        data = json.loads(out.stdout)
    except Exception:
        rows.append((name, "JSON-FAIL", 0, 0, 0, 0, "", "?"))
        continue

    decoded = data.get("decodedCode") or ""
    indicators = " ".join(data.get("indicators") or [])

    # Score recovery against the markers the generator marked recoverable-in-principle: string-data
    # markers the obfuscator hid. A renamed global identifier is not in this set - it cannot be
    # recovered by anyone, so counting it as a miss would measure the obfuscator, not us. Falls back
    # to the old behaviour for a manifest generated before hiddenRecoverable existed.
    if "hiddenRecoverable" in case:
        hidden = list(case["hiddenRecoverable"])
    else:
        hidden = [m for m in markers if m not in src]
    recovered = [m for m in hidden if m in decoded or m in indicators]

    lookups_before = len(LOOKUP.findall(src))
    lookups_after = len(LOOKUP.findall(decoded))

    finding = "-"
    for f in data.get("findings") or []:
        if (f.get("name") or f.get("Name")) == "Unresolved string-array lookups":
            finding = str(f.get("count", f.get("Count")))

    rows.append((
        name,
        data.get("obfuscatorFamily") or "-",
        len(hidden),
        len(recovered),
        lookups_before,
        lookups_after,
        data.get("syntaxValidation") or "",
        finding,
    ))

print("%-26s %-22s %-13s %-12s %-8s %s" % ("case", "family", "hidden->found", "lookups b->a~", "unresolved", "syntax"))
print("-" * 112)
for name, fam, hid, rec, lb, la, syn, finding in rows:
    resolved = "n/a" if lb == 0 else ("~%d->%d" % (lb, la))
    unresolved = finding not in ("-", "0")
    flag = ""
    if hid and rec < hid:
        flag = "  <== MISSED %d" % (hid - rec)
    elif unresolved:
        # The engine says string-array lookups actually survived - a real gap.
        flag = "  <== %s lookups unresolved" % finding
    print("%-26s %-22s %-13s %-12s %-8s %s%s" % (
        name, fam[:22], ("%d->%d" % (hid, rec)) if hid else "none hidden",
        resolved, finding, (syn[:28] if syn else ""), flag))
