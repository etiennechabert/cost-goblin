# Deliberately minimal: one dependency install, one file, no build step — what
# you read in export-focus.mjs is exactly what runs.
#
# Node 26: supported until 2029-04 (LTS from 2026-10-28). CI's
# test-exporter-node26 job runs export-focus.test.mjs on this same line, and
# workflow-policy.test.mjs fails if the two majors drift apart. Odd-numbered
# lines like 25 never become LTS and reach end-of-life within months.
FROM node:26-slim

WORKDIR /app

# Copied first so a change to the script alone reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY export-focus.mjs ./

USER node
CMD ["node", "export-focus.mjs"]
