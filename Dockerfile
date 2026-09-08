# ==========================================
# STAGE 1: Builder (Heavy, gets thrown away)
# ==========================================
FROM node:20-slim AS builder

# Install heavy build tools needed for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency list and compile packages
COPY package*.json ./
RUN npm install


# ==========================================
# STAGE 2: Runtime (Lightweight, final image)
# ==========================================
FROM node:20-slim

WORKDIR /app

# Copy ONLY the compiled node_modules from the builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy the rest of your raw application files
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
