# Runs Scepter as an MCP server over stdio (used by MCP directories such as Glama).
FROM node:20-slim
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENTRYPOINT ["node", "dist/cli.js", "serve"]
