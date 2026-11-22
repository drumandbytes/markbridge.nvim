# Third-party code

Vendored under `vendor/`, fetched at pinned versions by `scripts/vendor.sh` and verified
against `vendor/SHA256SUMS` in CI. To update one: change its version in the script, run
it after deleting `vendor/SHA256SUMS`, review the diff.

| Library | Version | License |
| --- | --- | --- |
| markdown-it | 14.1.0 | MIT |
| markdown-it-emoji | 3.0.0 | MIT |
| KaTeX (incl. fonts) | 0.16.22 | MIT |
| highlight.js (+ GitHub themes) | 11.11.1 | BSD-3-Clause |
| Mermaid | 11.4.1 | MIT |
| github-markdown-css | 5.8.1 | MIT |

The test suite uses jsdom (BSD-2-Clause) as a dev dependency; it is not shipped.
