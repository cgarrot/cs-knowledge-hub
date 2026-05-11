FROM node:20-slim

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for caching
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Prune devDependencies after build
RUN npm prune --omit=dev

# Data directory with categories and sources
ENV CATEGORY_INDEX_PATH=/app/data/full-index.json
ENV RAW_DIR=/app/data/sources
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV OLLAMA_API_KEY=1dc55bd37ae84d9aac74832720abc948.1u1UonyMr4aqiWc4_rPJaS0e
ENV OLLAMA_BASE_URL=https://ollama.com/v1
ENV OLLAMA_MODEL=glm-5.1

EXPOSE 3000

CMD ["npm", "start"]
