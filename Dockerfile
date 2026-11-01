FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Persistent storage for sqlite DB and audio recordings
VOLUME [ "/app/data" ]

EXPOSE 3000

CMD ["node", "server.js"]
