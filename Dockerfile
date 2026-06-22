# TaskMate Bot - GCE PM2-based Dockerfile
# Optimized for Compute Engine VM deployment

# ================================
# Stage 1: Dependencies
# ================================
FROM node:20-alpine AS dependencies

# Install required system packages
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Copy package manager files
COPY package.json pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install --prod=false

# ================================
# Stage 2: Build
# ================================
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

RUN npm install -g pnpm

# Copy from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=dependencies /app/pnpm-lock.yaml ./pnpm-lock.yaml

# Copy app source code
COPY . .

# Optional: Build app (if needed)
# RUN pnpm run build

# ================================
# Stage 3: Runtime with PM2
# ================================
FROM node:20-alpine AS runtime

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S taskmate -u 1001 -G nodejs

WORKDIR /app

# Install global tools
RUN npm install -g pnpm pm2 && \
    chown -R taskmate:nodejs /usr/local

# Copy package manager files and install production deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod=true && \
    pnpm store prune && \
    npm cache clean --force

# Copy app code from builder stage
COPY --from=builder --chown=taskmate:nodejs /app .

# Copy PM2 ecosystem config
COPY --chown=taskmate:nodejs ecosystem.config.cjs ./ecosystem.config.cjs

# Create writable directories
RUN mkdir -p /app/logs /app/tmp && \
    chown -R taskmate:nodejs /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_OPTIONS="--max-old-space-size=512"

# Expose application port for Compute Engine
EXPOSE 8080

# Run app using PM2 in production mode
USER taskmate
CMD ["pm2-runtime", "ecosystem.config.cjs", "--env", "production"]
