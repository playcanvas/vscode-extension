FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnss3 \
        libsecret-1-0 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxkbfile1 \
        libxrandr2 \
        libxshmfence1 \
        libxss1 \
        xauth \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

COPY package.json package-lock.json ./
COPY plugin ./plugin
RUN npm ci

COPY . .

CMD ["bash", "-lc", "xvfb-run -a --server-args=\"-screen 0 1024x768x24\" npm test"]
