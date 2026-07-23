# Product

## Register

product

## Users

A single person (the app's own developer), using it as their personal daily finance journal. Two contexts:
- **In-the-moment logging**: on their phone, installed as a PWA, right after paying for something — needs to be fast enough that logging never feels like a chore.
- **Periodic review**: checking balances and spending patterns on desktop or phone, a few times a week.

Most transactions now arrive automatically (parsed from bank email alerts), so manual entry is increasingly the exception rather than the default path — but it still needs to stay effortless for the cases automation can't cover.

## Product Purpose

A hyper-minimal personal finance journal: a quick-add expense/income log backed by real double-entry accounting across one bank account and two credit cards, plus lightweight monthly insights. No multi-user features, no budgying gamification, no social layer — it exists purely to make one person's own spending visible and trustworthy with the least possible effort.

Success = the user never dreads opening it, trusts the balances are accurate, and can glance at "where did my money go this month" without work.

## Brand Personality

Simple, clean, easy to use. Not fussy, not corporate, not trying to impress — a quiet personal tool, not a product being sold. If it looks "designed" at all, it should read as restraint, not decoration.

## Anti-references

- Loud, chunky, multi-color dashboards (explicitly rejected early on — no pie charts, no busy bar charts)
- Anything that adds a tap or a decision to the core logging flow
- Generic SaaS/fintech visual clichés (hero stat cards, gradient accents, badge-heavy UI) — this is a personal tool, not a startup landing page

## Design Principles

- Logging speed is the product. Any visual change is judged first by whether it costs the user time or taps.
- Calm over clever. Motion and color should clarify state, not perform.
- Mobile is the primary surface (installed PWA); desktop is secondary.
- Numbers are the content. Typography and spacing carry the design; decoration doesn't.
- Trust through clarity, not chart-craft — plain numbers and thin progress indicators over illustrative data viz.

## Accessibility & Inclusion

Standard good practice for a single-user personal tool: sufficient contrast, visible focus states, and respect for `prefers-reduced-motion`. No specific additional accommodation needed.
