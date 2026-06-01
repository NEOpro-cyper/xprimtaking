FROM node:20-slim

WORKDIR /app

# Install build dependencies for argon2 native module
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV PORT=3000
ENV WORKERS=4

EXPOSE 3000

CMD ["node", "src/server.js"]
