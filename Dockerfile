FROM node:20-alpine

# native deps needed by better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Railway monta el volumen persistente en /data
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "scheduler.js"]
