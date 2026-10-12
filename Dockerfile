FROM node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0 AS builder

WORKDIR /src
# npm registry integrity for pnpm 8.15.6. Do not depend on mutable Corepack keys.
RUN curl -fsSL https://registry.npmjs.org/pnpm/-/pnpm-8.15.6.tgz -o /tmp/pnpm.tgz \
    && echo 'd7iem+d6Kwatj0A6Gcrl4il29hAj+YrTI9XDAZSVjrwC7gpq5dE+5FT2E05OjK8poF8LGg4dKxe8prah8RWfhg== /tmp/pnpm.tgz' | node -e \
    "const fs = require('node:fs'), crypto = require('node:crypto'); const [expected, file] = fs.readFileSync(0, 'utf8').trim().split(' '); if (crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64') !== expected) throw new Error('pnpm integrity mismatch');" \
    && mkdir /opt/pnpm \
    && tar -xzf /tmp/pnpm.tgz --strip-components=1 -C /opt/pnpm \
    && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && rm /tmp/pnpm.tgz \
    && test "$(pnpm --version)" = 8.15.6

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY packages/ ./packages/
COPY apps/web/ ./apps/web/
COPY scripts/check-image-package.mjs ./scripts/check-image-package.mjs
RUN sha256sum pnpm-lock.yaml > /tmp/source-lock.sha256 \
    && pnpm install --frozen-lockfile \
    && node scripts/check-image-package.mjs --browser-notices /src
# Frozen installs do not populate the registry metadata that pnpm 8 deploy needs
# for injected workspace packages (including its resolution of web dev dependencies).
# Warm that cache in a disposable directory; verify the actual production graph below.
RUN pnpm --filter @storyboard-viewer/cli... list --depth 0 --json > /tmp/workspace-deps.json \
    && node scripts/check-image-package.mjs --metadata /tmp/metadata /tmp/workspace-deps.json \
    && pnpm --dir /tmp/metadata install --lockfile-only --ignore-scripts
RUN SBD_IMAGE_LICENSES=1 pnpm build \
    && pnpm --filter @storyboard-viewer/cli list --prod --depth Infinity --json > /tmp/source-deps.json \
    && pnpm --filter @storyboard-viewer/cli --prod --offline deploy /out/cli \
    && sha256sum --check /tmp/source-lock.sha256 \
    && node scripts/check-image-package.mjs /src /out/cli /tmp/source-deps.json

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production SBD_CONFIG_DIR=/config
WORKDIR /app
COPY --from=builder /out/cli/ ./
# Only state directories are writable. Never change ownership of host bind mounts.
RUN chmod -R a-w /app \
    && mkdir /config /storyboard.sbd \
    && chown node:node /config /storyboard.sbd
USER node
EXPOSE 4400
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "/storyboard.sbd", "--host", "0.0.0.0", "--port", "4400"]
