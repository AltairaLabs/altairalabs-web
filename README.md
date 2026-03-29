# AltairaLabs Website

Marketing site for [AltairaLabs](https://www.altairalabs.ai) — open-core Kubernetes-native platform for deploying, governing, testing, and observing AI agents in production.

**Live at:** https://www.altairalabs.ai

## What's in here

- **Homepage** — product overview, mock screenshots, comparison table, platform logos
- **Blog** — 36 posts on AgentOps, platform engineering, and AI in production. Content collections with tag filtering, infinite scroll, auto-generated OG images
- **Solutions** — three pillars (Talk to Customers, Build Things, Make Sense of Things) with dedicated pages for customer support, sales, and onboarding
- **Why page** — founder story
- **SEO** — JSON-LD, Open Graph, Twitter Cards, sitemap, RSS, robots.txt, llms.txt, IndexNow, canonical URLs

## Tech stack

- [Astro](https://astro.build) — static site generator
- [Tailwind CSS](https://tailwindcss.com) — utilities (no preflight, coexists with custom CSS)
- [Satori](https://github.com/vercel/satori) + [resvg](https://github.com/nicolo-ribaudo/resvg-js) — auto-generated OG images
- GitHub Pages with custom domain

## Commands

| Command | Action |
|:--|:--|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Start dev server at `localhost:4321` |
| `pnpm build` | Build production site to `./dist/` |
| `pnpm preview` | Preview production build locally |
| `pnpm check:links` | Build and check all internal links |
| `pnpm check:a11y` | Run Lighthouse accessibility audit (needs dev server running) |

## Quality

- Link checker: 0 broken links across 3,006 links
- Lighthouse accessibility: 100%
- IndexNow: pings search engines on every build

## Related repos

- [AltairaLabs/charts](https://github.com/AltairaLabs/charts) — Helm chart repository at charts.altairalabs.ai
- [AltairaLabs/Omnia](https://github.com/AltairaLabs/Omnia) — the platform
- [AltairaLabs/PromptKit](https://github.com/AltairaLabs/PromptKit) — agent runtime
