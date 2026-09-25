#!/bin/bash
# Double-click to deploy the receipts functions to the "receipts" Netlify alias.
# Same as running: netlify deploy --no-build --alias receipts  (from this folder)
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.npm-global/bin"
echo "Deploying receipts alias from $(pwd) ..."
netlify deploy --no-build --alias receipts
echo
echo "Done. You can close this window."
