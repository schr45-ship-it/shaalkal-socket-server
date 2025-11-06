# Lightweight Node image
FROM node:20-alpine

WORKDIR /app

# Install only server deps
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy server source
COPY . ./

# Runtime
ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000
CMD ["node", "index.js"]
