FROM node:20-alpine

# Zainstaluj docker CLI (żeby móc zarządzać kontenerami)
RUN apk add --no-cache docker-cli bash curl

WORKDIR /app
COPY server.js .

EXPOSE 3080
ENV PORT=3080
ENV MESH_TOKEN=holon-mesh-executor-2026
ENV NODE_ENV=production

CMD ["node", "server.js"]
