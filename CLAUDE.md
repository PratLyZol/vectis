# Repo layout

| Path | What it is | Hub role | Check |
| --- | --- | --- | --- |
| `web/` | Next.js app (UI, API routes) | `frontend` | `cd web && pnpm typecheck && pnpm test` |
| `keeper/`, `scripts/` | Keeper service and Node scripts | `backend` | `cd keeper && pnpm typecheck && pnpm test` |
| `contracts/` | Foundry Solidity contracts, tests, deploy scripts | `native` | `cd contracts && forge test` |
| `demo/` | Demo script and trailer | `docs` | none |

Shared (needs a grant, see `.claude/hub/ownership.json`): root `README.md`, `.env*`, `.gitignore`,
package manifests and lockfiles, tsconfig and lint configs, `web/src/config/**` and
`keeper/addresses.json` (both written by the contracts tooling), `skills-lock.json`.
