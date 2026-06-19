# 2026-06-19 Link Status Semantics

## Goal

Align `syncskill link` and `syncskill link ls` so they clearly represent different layers of state without misleading users:
- `link` / matrix editor = configured skill-to-agent intent
- `link ls` = realized on-disk link status

## Scope

1. Update wording in the interactive matrix and `link ls` output to distinguish configured vs realized state.
2. Adjust `link ls` status semantics so unconfigured cells are distinct from configured-but-missing cells.
3. Make `link ls` cover all managed local skills, not only configured `config.links` keys.
4. Update relevant unit/integration tests and user-facing docs/help text.

## Validation

- `npm run build`
- Targeted unit/integration tests for linker, config UI, and CLI help/output
