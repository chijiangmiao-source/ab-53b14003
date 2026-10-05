# 静态站点镜像：构建期生成 dist，运行期仅零依赖 Node 静态服务
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
COPY test ./test
COPY verify ./verify

# 页面构建检查（构建产物必须就位）
RUN node scripts/build.mjs

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "server.js"]
