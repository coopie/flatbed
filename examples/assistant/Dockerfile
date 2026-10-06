# The assistant example as one image for Cloud Run. Build it from the repo root, since the app
# depends on the workspace packages in ts/:
#
#   docker build -f examples/assistant/Dockerfile -t assistant .
#
# flatbed's packages run as TypeScript source on Node 24, so the image keeps the workspace as it is.
FROM node:24-slim
RUN corepack enable
WORKDIR /repo
COPY ts/ ts/
COPY examples/assistant/ examples/assistant/
RUN cd ts && pnpm install --frozen-lockfile
RUN cd examples/assistant && pnpm run build
WORKDIR /repo/examples/assistant
ENV NODE_ENV=production PORT=8080 NODE_NO_WARNINGS=1
EXPOSE 8080
CMD ["node", "build"]
