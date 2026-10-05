FROM node:20-alpine

WORKDIR /app

# 零依赖：直接复制源码
COPY public ./public
COPY server.js verify.js package.json ./

RUN chmod +x verify.js

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

# 一次性验收服务：复核联合多数与配置阶段等业务场景，
# 完成代码测试、页面构建检查及 HTTP 冒烟后退出，并以退出码报告结果。
# 由 compose 的 verify 服务（restart: "no"）一次性运行。

CMD ["node", "server.js"]
