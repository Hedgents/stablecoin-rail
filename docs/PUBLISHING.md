# Publishing checklist

All seven public packages are published from GitHub Actions with npm provenance. They remain alpha and are intentionally installed through the `alpha` tag until an independent security review is complete.

## Tag policy

- Documentation must use `@alpha`; an untagged install is not supported during the alpha period.
- `alpha` points to the newest tested release of each package.
- Do not promote a version to `latest` while it contains a known confirmed defect or before the independent-review gate is closed.
- Deprecation text must state the proven routes, the unproven routes, and the review status accurately.

## Release procedure

1. Bump every changed package. If a plugin package changes, update its public manifest version too.
2. Keep intra-repository dependencies as compatible caret ranges.
3. Refresh the root lockfile with `npm install --package-lock-only`.
4. Update `examples/bridge-demo` to the newest already-published alpha versions and refresh its independent lockfile. The demo deliberately consumes registry artifacts rather than workspace links.
5. Run `npm run typecheck`, `npm test`, and `npm run pack:check`.
6. Run the demo's clean-room `npm ci`, `npm run typecheck`, and `npm run build`.
7. For CCTP settlement changes, run the read-only `npm run verify:cctp-proof` replay.
8. Push and wait for CI.
9. Dispatch the **Publish** workflow with tag `alpha`. It publishes only versions absent from the registry and attaches provenance.
10. Dispatch **Verify published** with tag `alpha`. It installs into a throwaway directory and exercises public artifacts against live endpoints.

## Promotion after review

After the independent review is public and every confirmed high-severity finding is resolved, promote the reviewed versions explicitly:

```bash
npm dist-tag add @hedgents/stablecoin-rail@REVIEWED_VERSION latest
npm dist-tag add @hedgents/stablecoin-rail-solana@REVIEWED_VERSION latest
npm dist-tag add @hedgents/stablecoin-rail-cctp@REVIEWED_VERSION latest
```

Repeat for the remaining reviewed packages. Promotion changes registry state and must be a deliberate release decision, not a side effect of publishing an alpha.
