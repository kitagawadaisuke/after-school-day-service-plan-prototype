FROM mcr.microsoft.com/playwright:v1.62.1-noble

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl fonts-noto-cjk \
  && mkdir -p /opt/michinote/certs \
  && curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    'https://truststore.pki.rds.amazonaws.com/ap-northeast-3/ap-northeast-3-bundle.pem' \
    --output /opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem \
  && echo 'a0eb6e614aec8920204c2a1d6b4fca8128780fc3535e23cd9a56ecf60c0ad1bd  /opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem' | sha256sum --check --strict \
  && chmod 0444 /opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY src ./src
COPY styles ./styles
COPY db ./db
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY scripts/provision-tenant.mjs ./scripts/provision-tenant.mjs
COPY saas.html index.html styles.css ./

RUN chown -R pwuser:pwuser /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8015 \
    DATABASE_CA_FILE=/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem \
    MIGRATION_DATABASE_CA_FILE=/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem \
    PROVISION_DATABASE_CA_FILE=/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER pwuser
EXPOSE 8015
CMD ["node", "server/start.js"]
