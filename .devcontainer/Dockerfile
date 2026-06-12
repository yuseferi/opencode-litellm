FROM node:22-slim

# Install minimal system deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

# Install pinned opencode CLI. The linux-arm64 optional dep resolves
# automatically because npm honours cpu/os fields.
RUN npm install -g opencode-ai@1.17.1 \
 && opencode --version

# Terminal settings needed for TUI rendering
ENV TERM=xterm-256color \
    COLORTERM=truecolor \
    OPENCODE_CONFIG_DIR=/root/.config/opencode \
    OPENCODE_DATA_DIR=/root/.local/share/opencode

WORKDIR /work

# Copy helper scripts so they are baked into the image
COPY entrypoint.sh /usr/local/bin/entrypoint
COPY smoke.sh      /usr/local/bin/smoke
RUN chmod +x /usr/local/bin/entrypoint /usr/local/bin/smoke

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["bash"]
