FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production --no-audit --no-fund
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
