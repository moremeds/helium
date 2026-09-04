# Daily Market Report — Design Specification (user-supplied 2026-09-04)

Design 04 (Minimal White / Quant Research) is the primary template. Design 01
(Institutional Deep Navy) is the optional premium variant. Verbatim from the user.

## Overall Product Goal
Institutional research, not retail; modern quant research product, not a newspaper;
information-dense but visually calm; scannable in 10–20 s; suitable for daily reading;
premium without being decorative. Do NOT imitate Bloomberg yellow.
References: Morning Brew (hierarchy / snapshot density), Finimize (modular storytelling),
The Daily Upside (editorial credibility), modern quant dashboards (restrained colour).
The visual design must subordinate itself to the data.

## Global principles
1. Data first, decoration second. Every element establishes hierarchy, communicates market
   state, separates modules, or speeds scanning. No stock photos, illustrations, gradients
   everywhere, glassmorphism, oversized rounded cards, shadows, unnecessary icons.
2. Three scan levels. 5 s: direction, indices, VIX, yields, one-sentence summary.
   20 s: drivers, movers, regime, key chart, what matters tomorrow. Deep read: commentary
   AFTER the summary modules. Never force paragraphs before the numbers.
3. Fixed daily structure; only the data changes. Header → Market Snapshot → Today in One
   Sentence → Market Drivers → Movers → Chart of the Day → Signal / Regime Changes →
   Tomorrow Watchlist → Footer.
4. Colour is semantic. Green positive, red negative, one accent for emphasis, neutral for
   everything else. Never fill a whole card green/red; colour the number, not the box.
5. Minimise noise: whitespace, subtle separators, small cards, consistent alignment,
   typographic hierarchy. No thick borders, competing accents, shadows, mixed card styles.
6. ≤ 2 font families. UI/data: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial,
   sans-serif. Optional restrained serif for editorial headings. Tabular numerals.
7. Numbers dominate market modules: label small, price large, change medium and coloured.
8. Restrained cards: radius 6–10 px, 1 px border #E6E9EF or background contrast, shadow
   ≤ 0 1px 3px rgba(15,23,42,.04) or none.
9. Width 640 px (600–680 ok); mobile 100 % with 16 px padding; two-column stacks < ~560 px.

## Design 04 — Minimal White / Quant Research (PRIMARY)
Keywords: minimal, precise, modern, quantitative, clean, data-first, calm, engineering-driven.
Metaphor: a beautifully typeset research dashboard printed onto white paper. Closer to
Linear + Stripe docs + institutional research than a finance newsletter.

Tokens:
  --background #FFFFFF; --surface #FFFFFF;
  --text-primary #111318; --text-secondary #626A75; --text-muted #9198A2;
  --border #E8EBEF; --border-strong #D7DCE2;
  --accent #1769E0; --accent-soft #EFF6FF;
  --positive #168A54; --negative #D54141.
Blue is an accent, not the identity of every component.

Layout: no giant coloured header; white canvas; 640 px; 32 px desktop padding; whitespace
creates hierarchy.
Header: logo top-left, date top-right; title "Daily Market Report" 28–30 px / 650 /
letter-spacing -0.5 px; beneath it a 36 × 3 px #1769E0 bar (radius 2) — key identity
element; then a subtle full-width grey divider.
Section headers: 13 px / 650 / #20242A; no bars, no filled headers; sections separated by
32–40 px whitespace. Bilingual allowed.
Market Snapshot: five small outlined cells, white, 1 px border, 7 px radius, no shadow.
Label 10 px; value 17–19 px / 650; change 11 px / 600. Cells read like table cells, not
floating cards.
Key Points: compact bullet list with small blue outlined circle marker; 13 px; lh 1.55–1.65.
Movers: two equal panels, 1 px #E8EBEF border, 6 px radius; rows rank/ticker/company/move
with hairline separators; no row fills.
Chart: dominant through whitespace; line #1769E0; grid #EEF0F3; 180–220 px tall; no
gradient fill, no glow, no dark container. Metrics beside chart as plain text hierarchy.
Watchlist: three boxes, subtle outlines, accent-blue icon only.
Footer: 10 px grey, almost invisible.

## Design 01 — Institutional Deep Navy (optional premium variant)
Navy header 150–180 px (#071426 or 135° #071426→#0A1B33→#12345B, no purple/cyan),
wordmark, date top-right, title 27–31 px / 650–700 white, subtitle 12 px rgba(255,255,255,.68).
Canvas #F7F9FC, surface #FFFFFF, text #111827 / #5B6472 / #8B95A5, border #E4E9F0,
positive #159A5B, negative #D64545, warning #C58A22, blue #2563EB. Body stays white; the
header carries the brand.

## Component / data rules
Data separate from presentation; never encode pos/neg colour in data — derive from the
number. Email: table layouts, Outlook fallbacks, explicit image sizes, no essential info as
images only, dark-mode clients must not destroy contrast. Test Apple Mail, Gmail web/mobile,
Outlook, iOS Mail.

## Data visualisation rules
One question per chart; clear title, primary series, minimal axes, ≤ 1 comparison. No 3D,
no pies, no rainbow. Preferred: intraday line, indexed performance, vol curve, breadth,
yield movement, sector/factor performance, regime history.

## Content principles
Answer five questions: what happened, why, what moved most, has the regime changed, what to
watch next. Compress, do not reproduce all news.

## Final rule
When unsure whether to add an element, remove it. High information density + low visual
complexity. The reader should remember the market, not the email.
