FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "server.js"]
