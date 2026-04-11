FROM node:20-alpine
WORKDIR /app
COPY server.js .
RUN apk add --no-cache curl
EXPOSE 3080
CMD ["node", "server.js"]
