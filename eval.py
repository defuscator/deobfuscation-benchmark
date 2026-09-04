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
# itself a call. This over-counts on samples whose original code makes such calls (none here) and
# on debugProtection's self-call `_0x(0)`, which is why the engine's own finding is also shown.
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

print("%-26s %-22s %-13s %-12s %-8s %s" % ("case", "family", "hidden->found", "lookups b->a", "finding", "syntax"))
print("-" * 112)
for name, fam, hid, rec, lb, la, syn, finding in rows:
    resolved = "n/a" if lb == 0 else ("%d->%d" % (lb, la))
    flag = ""
    if hid and rec < hid:
        flag = "  <== MISSED %d" % (hid - rec)
    elif lb > 0 and la > 0:
        flag = "  <== lookups remain"
    elif finding not in ("-", "0"):
        flag = "  <== finding %s" % finding
    print("%-26s %-22s %-13s %-12s %-8s %s%s" % (
        name, fam[:22], ("%d->%d" % (hid, rec)) if hid else "none hidden",
        resolved, finding, (syn[:28] if syn else ""), flag))
