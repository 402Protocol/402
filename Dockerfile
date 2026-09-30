FROM node:24-slim

WORKDIR /app

# Install dependencies first (layer cache).
COPY package.json package-lock.json* ./
RUN npm install

# Copy the protocol source.
COPY src ./src
COPY test ./test
COPY tsconfig.json ./

# The facilitator runs directly on tsx; no build step.
EXPOSE 4022

# LOUNGE_DB_PATH should point at a mounted volume so posts survive restarts.
CMD ["npx", "tsx", "src/cli/facilitator.ts"]
