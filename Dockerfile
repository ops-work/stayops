FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs index.html README.md ./
RUN mkdir -p /app/data
ENV PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.mjs"]
