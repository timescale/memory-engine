ARG BASE_IMG=claude-code
FROM docker/sandbox-templates:${BASE_IMG}

USER root

# Install Bun runtime (pinned version)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.10"

ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    vim \
    wget \
    curl \
    tree \
    jq \
    ripgrep \
    gh \
    sqlite3 \
    lua5.4 \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH="$(dpkg --print-architecture)" && \
    wget "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}" -O /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq

# Install ghostty terminfo so TERM=xterm-ghostty works in the container
COPY docker/ghostty.terminfo /tmp/ghostty.terminfo
RUN tic -x /tmp/ghostty.terminfo && rm /tmp/ghostty.terminfo

RUN curl https://install.duckdb.org | sh

RUN mkdir -p /home/agent/.bun /home/agent/.duckdb && \
    cp -r /root/.bun/* /home/agent/.bun/ && \
    cp -r /root/.duckdb/* /home/agent/.duckdb/ && \
    chown -R agent:agent /home/agent/.bun /home/agent/.duckdb

USER agent

ENV BUN_INSTALL="/home/agent/.bun"
ENV DUCKDB_INSTALL="/home/agent/.duckdb"
ENV PATH="$BUN_INSTALL/bin:$DUCKDB_INSTALL:$PATH"
