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
# Cloud Run will inject PORT (default 8080). Our app reads process.env.PORT.
EXPOSE 8080
CMD ["node", "index.js"]
