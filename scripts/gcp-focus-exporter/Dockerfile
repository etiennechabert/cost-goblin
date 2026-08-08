# Deliberately minimal: one dependency install, one file, no build step — what
# you read in export-focus.mjs is exactly what runs.
FROM node:25-slim

WORKDIR /app

# Copied first so a change to the script alone reuses the cached install layer.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY export-focus.mjs ./

USER node
CMD ["node", "export-focus.mjs"]
