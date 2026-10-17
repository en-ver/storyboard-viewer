FROM node:24-bookworm-slim

WORKDIR /app
RUN mkdir -p /config /projects \
    && chown node:node /config /projects

COPY . .
RUN npm install --global pnpm@8.15.6 serve@14.2.4 \
    && pnpm install --frozen-lockfile \
    && pnpm build

ENV HOME=/home/node \
    SBD_CONFIG_DIR=/config \
    NO_UPDATE_CHECK=1
USER node

CMD ["serve", "--single", "/app/apps/web/dist", "--listen", "tcp://0.0.0.0:4400", "--no-clipboard", "--no-port-switching"]
