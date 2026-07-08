# crypto-bot — Project Instructions

## Documentation maintenance

Whenever a feature is added or a bug is fixed, update the corresponding architecture
diagram(s) as part of that change — not as a separate follow-up:

- **System-wide/cross-app changes** (new external integration, new service, changed
  data flow between `apps/bot` and `apps/dashboard`) → the Mermaid diagram in the root
  [`README.md`](README.md)'s "Architecture" section.
- **`apps/bot` internal changes** (new/removed/renamed module, changed responsibility
  of an existing one, new periodic job, new route) → the Mermaid diagram in
  [`apps/bot/README.md`](apps/bot/README.md).
- **`apps/dashboard` internal changes** (new/removed component, changed data-flow
  between components and the API/WebSocket layer) → the Mermaid diagram in
  [`apps/dashboard/README.md`](apps/dashboard/README.md).

If a change doesn't affect the shape of these diagrams (e.g. a pure bugfix inside one
function, a copy change), no diagram update is needed — use judgment. When in doubt,
check whether the diagram would still accurately answer "what talks to what" after the
change; if not, update it.
