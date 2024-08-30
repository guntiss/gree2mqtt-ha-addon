ARG BUILD_FROM=ghcr.io/hassio-addons/base:16.2.1
FROM ${BUILD_FROM}

ENV LANG C.UTF-8

RUN apk add --no-cache jq nodejs npm

WORKDIR /usr/src/app
COPY . .
RUN chmod +x run.sh
RUN npm install

CMD [ "./run.sh" ]
