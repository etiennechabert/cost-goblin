# Deliberately minimal: one dependency install, one file, no build step — what
# you read in export-focus.mjs is exactly what runs.
#
# An LTS line, and the one CI runs export-focus.test.mjs on (the root vitest
# suite, Node 24). Odd-numbered lines like 25 never become LTS and reach
# end-of-life within months; move to 26 once it enters LTS.
FROM node:24-slim

WORKDIR /app

# Copied first so a change to the script alone reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY export-focus.mjs ./

USER node
CMD ["node", "export-focus.mjs"]
