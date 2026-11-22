#!/usr/bin/env bash
# Fetch the browser-side libraries at pinned versions into vendor/ and verify sha256
# (recorded in vendor/SHA256SUMS on first run; later runs must match).
set -euo pipefail
cd "$(dirname "$0")/../vendor"

MARKDOWN_IT=14.1.0
EMOJI=3.0.0
KATEX=0.16.22
HLJS=11.11.1
MERMAID=11.4.1
CDN=https://cdn.jsdelivr.net/npm

get() { curl -fsSL "$1" -o "$2"; }

mkdir -p katex/fonts highlight
get "$CDN/markdown-it@$MARKDOWN_IT/dist/markdown-it.min.js" markdown-it.min.js
get "$CDN/markdown-it-emoji@$EMOJI/dist/markdown-it-emoji.min.js" markdown-it-emoji.min.js
get "$CDN/katex@$KATEX/dist/katex.min.js" katex/katex.min.js
get "$CDN/katex@$KATEX/dist/katex.min.css" katex/katex.min.css
for f in $(grep -o 'fonts/[A-Za-z_0-9-]*\.woff2' katex/katex.min.css | sort -u); do
  get "$CDN/katex@$KATEX/dist/$f" "katex/$f"
done
get "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$HLJS/highlight.min.js" highlight/highlight.min.js
get "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$HLJS/styles/github.min.css" highlight/github.min.css
get "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$HLJS/styles/github-dark.min.css" highlight/github-dark.min.css
get "$CDN/mermaid@$MERMAID/dist/mermaid.min.js" mermaid.min.js
get "$CDN/github-markdown-css@5.8.1/github-markdown.css" github-markdown.css

if [ -f SHA256SUMS ]; then
  shasum -a 256 -c SHA256SUMS
else
  find . -type f ! -name SHA256SUMS | sort | xargs shasum -a 256 >SHA256SUMS
  echo "wrote vendor/SHA256SUMS"
fi
