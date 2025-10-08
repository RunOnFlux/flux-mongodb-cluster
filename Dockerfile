# Use official MongoDB 7.0 as base image
FROM mongo:7.0

# Install Node.js 18.x, iproute2, and other required packages
RUN apt-get update && \
    apt-get install -y curl ca-certificates gnupg iproute2 && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy version file
COPY VERSION /app/VERSION

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application files
COPY index.js ./
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# Ensure the script is executable
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create directory for MongoDB keyfile
RUN mkdir -p /data/configdb && \
    chown -R mongodb:mongodb /data/configdb

# Set the entrypoint to our controller script
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default command passed to entrypoint
CMD ["mongod", "--bind_ip_all"]