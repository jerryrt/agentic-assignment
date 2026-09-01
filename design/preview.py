#!/usr/bin/env python3
"""Generate the SVG palette previews and the WCAG contrast report from tokens.json.

The guides embed the SVGs this emits, so the swatches shown on GitHub and the hex
values in tokens.json cannot drift. Run after editing tokens.json:

    python3 design/preview.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SANS = "system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
CHIPS = ["primary", "ok", "warn", "err", "unknown", "border-strong", "text"]


def _linear(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hexstr):
    h = hexstr.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _linear(r) + 0.7152 * _linear(g) + 0.0722 * _linear(b)


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return round((hi + 0.05) / (lo + 0.05), 2)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, fill, size=12, weight=400, font=SANS, anchor="start"):
    return (f'<text x="{x}" y="{y}" fill="{fill}" font-family="{font}" '
            f'font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{esc(s)}</text>')


def rect(x, y, w, h, fill, rx=0, stroke=None, sw=1):
    s = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{s}/>'


def panel(ox, t, mode_label):
    """One themed panel: palette chips above a mockup of the eligibility card."""
    p = []
    W, H = 460, 476
    p.append(rect(ox, 0, W, H, t["bg"], rx=10, stroke=t["border"]))
    p.append(text(ox + 20, 30, mode_label, t["muted"], 11, 600))

    # palette chips
    cw, gap, y0 = 52, 8, 44
    for i, key in enumerate(CHIPS):
        x = ox + 20 + i * (cw + gap)
        p.append(rect(x, y0, cw, 34, t[key], rx=5, stroke=t["border"]))
        p.append(text(x + cw / 2, y0 + 48, t[key].upper(), t["muted"], 7, 400, MONO, "middle"))
        p.append(text(x + cw / 2, y0 + 58, key, t["muted"], 6.5, 400, SANS, "middle"))

    # mockup: the eligibility / rule-list card, the app's signature surface
    cx, cy, cw2, ch = ox + 20, 122, 420, 334
    p.append(rect(cx, cy, cw2, ch, t["surface"], rx=8, stroke=t["border"]))
    p.append(text(cx + 16, cy + 26, "You may qualify for", t["muted"], 11, 600))

    rows = [
        ("Operating Line of Credit", "ELIGIBLE", "ok",
         [("ok", "1,240 ac (needs 200)"), ("ok", "DSCR 1.41 (needs 1.25)")]),
        ("Equipment Loan", "NOT YET", "err",
         [("ok", "Max $250k - you asked $180k"), ("err", "LTV 88% (max 80%)")]),
        ("Livestock Term Loan", "MORE INFO", "unknown",
         [("unknown", "Enter herd details in step 2")]),
    ]
    y = cy + 42
    for title, badge, tone, checks in rows:
        p.append(rect(cx + 12, y, cw2 - 24, 26 + 18 * len(checks), t["raised"], rx=6, stroke=t["border"]))
        p.append(text(cx + 24, y + 18, title, t["text"], 11, 600))
        bw = 62
        p.append(rect(cx + cw2 - 24 - bw, y + 6, bw, 16, t[tone + "-subtle"], rx=8))
        p.append(text(cx + cw2 - 24 - bw / 2, y + 17, badge, t[tone], 7.5, 700, SANS, "middle"))
        yy = y + 34
        for ctone, label in checks:
            glyph = "+" if ctone == "ok" else ("x" if ctone == "err" else "?")
            p.append(text(cx + 26, yy, glyph, t[ctone], 10, 700, MONO))
            p.append(text(cx + 40, yy, label, t["muted"], 9.5))
            yy += 18
        y += 26 + 18 * len(checks) + 10

    # primary action + secondary, to show button contrast
    p.append(rect(cx + 12, cy + ch - 46, 118, 30, t["primary"], rx=6))
    p.append(text(cx + 71, cy + ch - 26, "Continue", t["on-primary"], 11, 600, SANS, "middle"))
    p.append(rect(cx + 140, cy + ch - 46, 104, 30, t["bg"], rx=6, stroke=t["border-strong"]))
    p.append(text(cx + 192, cy + ch - 26, "Save draft", t["text"], 11, 600, SANS, "middle"))
    return "".join(p)


def build(key, theme):
    W, H = 960, 512
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
           f'role="img" aria-label="{esc(theme["name"])} theme palette preview">']
    out.append(f'<g transform="translate(0,36)">{panel(0, theme["light"], "LIGHT")}</g>')
    out.append(f'<g transform="translate(500,36)">{panel(0, theme["dark"], "DARK")}</g>')
    # captions in a neutral gray that reads on both GitHub themes
    out.append(text(2, 16, theme["name"], "#8B949E", 15, 700))
    out.append(text(2, 30, theme["tagline"], "#8B949E", 10.5))
    out.append("</svg>")
    path = os.path.join(ROOT, "preview", f"{key}.svg")
    with open(path, "w") as fh:
        fh.write("".join(out))
    return path


def report(key, theme):
    """WCAG checks. Text pairs need 4.5:1; UI boundaries and glyphs need 3:1."""
    failures = []
    for mode in ("light", "dark"):
        t = theme[mode]
        pairs = [
            ("text on bg", t["text"], t["bg"], 4.5),
            ("text on surface", t["text"], t["surface"], 4.5),
            ("text on raised", t["text"], t["raised"], 4.5),
            ("muted on bg", t["muted"], t["bg"], 4.5),
            ("muted on surface", t["muted"], t["surface"], 4.5),
            ("primary on bg", t["primary"], t["bg"], 4.5),
            ("on-primary on primary", t["on-primary"], t["primary"], 4.5),
            ("border-strong on bg", t["border-strong"], t["bg"], 3.0),
        ]
        for tone in ("ok", "warn", "err", "unknown"):
            pairs.append((f"{tone} on bg", t[tone], t["bg"], 4.5))
            pairs.append((f"{tone} on surface", t[tone], t["surface"], 4.5))
            pairs.append((f"{tone} on {tone}-subtle", t[tone], t[tone + "-subtle"], 4.5))
        for label, fg, bg, need in pairs:
            got = contrast(fg, bg)
            if got < need:
                failures.append(f"  FAIL {key}/{mode:5s} {label:26s} {fg} on {bg} = {got} (need {need})")
    return failures


def main():
    data = json.load(open(os.path.join(ROOT, "tokens.json")))
    all_failures = []
    for key, theme in data["themes"].items():
        path = build(key, theme)
        all_failures += report(key, theme)
        print(f"wrote {os.path.relpath(path, os.path.dirname(ROOT))}")
    if all_failures:
        print("\ncontrast failures:")
        print("\n".join(all_failures))
        return 1
    print("\ncontrast: all pairs pass (text 4.5:1, UI 3:1) in both modes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
