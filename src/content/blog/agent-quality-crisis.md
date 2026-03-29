---
title: "The Agent Quality Crisis: Why AI-Generated Code Has 1.7x More Issues Than Human Code"
description: "AI-generated pull requests contain 1.7x more issues than human-written code, with 2.74x more XSS vulnerabilities. Speed was the 2025 story. Quality will be the 2026 reckoning."
date: 2026-01-12
tags: ["testing", "production", "measurement"]
author: "AltairaLabs"
draft: false
---

The AI coding revolution has a quality problem. While the industry celebrates adoption metrics -- 41% of new GitHub code is now AI-assisted -- a growing body of evidence suggests we have been measuring the wrong thing. Speed was the 2025 story. Quality will be the 2026 reckoning.

---

## The Data We Have Been Ignoring

In December 2025, [CodeRabbit](https://coderabbit.ai/) published the most rigorous public analysis of AI-generated code quality to date, analyzing 470 pull requests from production repositories:

| Metric | Human-Written PRs | AI-Generated PRs | Multiplier |
|--------|-------------------|-------------------|------------|
| Total issues per PR | 6.45 | 10.83 | 1.68x |
| Logic/correctness errors | Baseline | 1.75x higher | 1.75x |
| Security findings | Baseline | 1.57x higher | 1.57x |

The security breakdown is alarming: **2.74x more XSS vulnerabilities**, 1.91x more insecure direct object references, 1.88x more improper password handling.

## The Productivity Paradox

[METR](https://metr.org/) (Model Evaluation and Threat Research) conducted a randomized controlled trial with experienced open-source developers:

- **Expected speedup**: 24% faster
- **Actual measured impact**: 19% slower

Developers believed they were faster. They were not. The hidden costs -- reviewing generated code, debugging subtle errors, correcting "almost right" outputs -- exceeded the time saved.

This finding is consistent across the literature. **66% of developers report spending more time fixing AI-generated code than they saved generating it.**

## The 41% Problem

If AI-assisted code has 1.7x more issues per PR, and 41% of new code is AI-assisted, the aggregate quality impact is significant. A rough calculation: the expected defect rate increases by approximately 29%.

Compounding the problem, [GitClear's analysis](https://www.gitclear.com/) shows code churn -- lines reverted or modified shortly after being written -- has increased 39% since widespread AI tool adoption. Developers write less test code, fewer comments, and less documentation when using AI assistants.

## Why AI-Generated Code Has More Issues

**Pattern Matching Without Understanding**: Models predict the most likely next token. They don't understand business logic, security context, or operational constraints.

**The Context Window Problem**: AI tools don't see your ADRs, security policies, performance SLAs, or lessons from the last three production incidents.

**Training Data Bias**: LLMs are trained on public code including tutorials and hobby projects that prioritize clarity over security and skip error handling for brevity.

**The "Almost Right" Trap**: Code that is 95% correct is harder to fix than obviously broken code because it looks like it works.

## What the Industry Needs

**Evaluation at the speed of generation**: If your team generates code 3x faster, evaluation processes must scale correspondingly.

**Guardrails, not gates**: Automated systems that constrain generation rather than reviewing output -- context injection, output validation, pattern enforcement, dependency governance.

**Measurement as a first-class concern**: Attribution (which code was AI-generated), quality metrics by source, trend tracking, and cost of quality.

The pattern is familiar from CI/CD: the first phase was speed (deploy faster), the second was quality (deploy safely). AI-assisted development is in its "deploy faster" phase. The quality infrastructure is still nascent.

---

## Sources

- [CodeRabbit, "AI-Generated Code Quality Analysis," December 2025](https://coderabbit.ai/)
- [METR, "Measuring the Impact of Early AI Assistance on Open-Source Development," 2025](https://metr.org/)
- [GitClear, "Coding on Copilot: 2024 Data Suggests Downward Pressure on Code Quality"](https://www.gitclear.com/)

---

## Related Reading

- [The METR Paradox: When AI Tools Make Experienced Developers 19% Slower](/blog/metr-paradox-ai-slower/)
- [Arena Fleet: Why AI Agents Need Unified Testing Infrastructure](/blog/arena-unified-testing-for-ai-agents/)
- [The Measurement Paradox: Why AI Teams Can't Prove Their Own Value](/blog/the-measurement-paradox/)
