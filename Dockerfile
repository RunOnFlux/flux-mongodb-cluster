# Use official MongoDB 7.0 as base image
FROM mongo:7.0

# Install dependencies for the controller script
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    netcat-openbsd \
    xxd \
    && rm -rf /var/lib/apt/lists/*

# Copy the controller script into the image
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