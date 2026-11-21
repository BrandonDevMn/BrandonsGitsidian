# Working agreements

- Push to `origin` often. Brandon follows along on GitHub from his phone: commit and push after each meaningful step (a spec, a feature, a fix), not just at the end.
- Spec-driven: behaviour lives in `specs/*.feature`. Change the spec first, then the code.
- Small commits with clear messages.
- iOS-first: follow `specs/12-ios-platform.feature` (no Node/Electron, `requestUrl` only, no regex lookbehind).
