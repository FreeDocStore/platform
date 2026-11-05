# Knowledge-base feature roadmap

FreeDocStore owns free public publishing, AI-first editing and reader tools.
ProDocStore owns premium organisation services and private knowledge bases.
Existing FreeDocStore custom-domain support stays free.

This is a development roadmap, not a claim that every feature is deployed.

| Capability | Product | Status |
| --- | --- | --- |
| Public Zensical publishing, source metadata and GitHub proposals | FreeDocStore | Available foundation; expand diagnostics and workflows |
| Contextual ask/edit chat, selection, diffs and task board | Both | Available foundation; improve navigation and draft continuity |
| Individual provider keys and provider selection | Both | Available foundation; expand provider support |
| Published-page local-voice narration | Both | Implemented and browser-tested in FreeDocStore; ProDocStore adaptation pending |
| Reader rate, voice, seeking, resume, highlighting and continuation | Both | FreeDocStore reader implemented; Chromium playback, resume and continuation validated |
| Extension narration and page/panel playback coordination | Both | Implemented and tested with the installed FreeDocStore extension; ProDocStore adaptation pending |
| Browser-based AI audio generation and publishing | Both | FreeDocStore worker generation, preview and reviewed publication implemented; real Chromium inference validated; ProDocStore pending |
| Audio freshness checks and source-version metadata | Both | FreeDocStore producer, commit conflict checks, installer integrity checks and stale-reader fallback implemented |
| Setup, connection verification and deployment diagnostics | Both | FreeDocStore connection and GitHub build diagnostics implemented; ProDocStore native workflows pending |
| Repo files, PRs and build-run console | FreeDocStore | Implemented with explicit partial-failure reporting |
| Search, navigation, TOC, code blocks and references | Both | Available publishing foundation; validate complete user flows |
| Printable proposal templates | Both | FreeDocStore printable review with rationale and current/proposed source implemented and browser-tested; ProDocStore pending |
| Agent-readable metadata and MCP read/propose workflows | Both | Available foundation; expand tools and org scoping |
| Shared organisation provider keys | ProDocStore | Pending |
| Organisation usage dashboard | ProDocStore | Pending |
| Platform-funded inference, budgets and quotas | ProDocStore | Pending; FreeDocStore retains individual BYOK |
| Managed hosting and organisation operations | ProDocStore | Native publish API, immutable versions and pointer rollback exist; console and custom domains pending |
| Private KB access, email and domain allowlists | ProDocStore | Native API foundation exists; validate all access surfaces |
| Organisation roles, seats and administration | ProDocStore | RBAC foundation exists; console integration pending |
| Audit trail and scoped agent credentials | ProDocStore | Safety foundation exists; org-scoped integration pending |
| SSO/SAML and enterprise controls | ProDocStore | Planned |
| Subscription and billing integration | ProDocStore | Pending |

## Delivery sequence

1. Deliver public reader and extension workflows — implementation and Chromium validation complete.
2. Deliver public setup/build diagnostics, audio publishing and printable reviews — implementation complete; real browser-worker inference validated.
3. Integrate ProDocStore organisation services, private reader, native review,
   scoped MCP, metered inference and usage reporting.
4. Deliver managed hosting, billing and enterprise controls.

ProDocStore integration is tracked in
[#13](https://github.com/ProDocStore-online/platform/issues/13).

FreeDocStore keeps GitHub as its source of truth and manual editing surface.
ProDocStore uses its existing D1/R2 architecture and native proposal approval.
Both retain the prompt → proposal → review flow.

Each product keeps independent OAuth apps, storage, deployments and branding.
Private access must cover server reads, search, assets and MCP. Validate actual
user flows before marking a capability complete.

## Public delivery

Tracked in [FreeDocStore #7](https://github.com/FreeDocStore/platform/issues/7).
See [Reading, narration and proposal reviews](READER-AND-PUBLISHING.md) for the
workflow, recording limits, metadata contract and validation commands.
Existing KBs need the current reader installer in their build workflow.
Physical-phone and non-Chromium validation remain separate follow-up work.
