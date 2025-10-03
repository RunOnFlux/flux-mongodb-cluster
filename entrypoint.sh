#!/bin/bash

set -e

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting MongoDB and Node.js controller..."

# Configuration from environment variables
MONGO_REPLICA_SET_NAME="${MONGO_REPLICA_SET_NAME:-rs0}"
MONGO_PORT="${MONGO_PORT:-27017}"
KEYFILE_PATH="/data/configdb/mongodb-keyfile"

# MongoDB authentication
MONGO_INITDB_ROOT_USERNAME="${MONGO_INITDB_ROOT_USERNAME}"
MONGO_INITDB_ROOT_PASSWORD="${MONGO_INITDB_ROOT_PASSWORD}"

# Function to log messages with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Function to wait for MongoDB to be ready
wait_for_mongo() {
    local max_attempts=30
    local attempt=0

    log "Waiting for MongoDB to start..."

    while [ $attempt -lt $max_attempts ]; do
        if mongosh --port "${MONGO_PORT}" --quiet --eval "db.adminCommand('ping')" >/dev/null 2>&1; then
            log "MongoDB is ready"
            return 0
        fi

        attempt=$((attempt + 1))
        sleep 2
    done

    log "Error: MongoDB failed to start within timeout"
    return 1
}

# Function to create root user using localhost exception
create_root_user() {
    if [ -z "$MONGO_INITDB_ROOT_USERNAME" ] || [ -z "$MONGO_INITDB_ROOT_PASSWORD" ]; then
        log "No MongoDB credentials provided, skipping user creation"
        return 0
    fi

    log "Creating root user '${MONGO_INITDB_ROOT_USERNAME}' using localhost exception..."

    # Try to create user directly - if it already exists, mongosh will return an error which we can ignore
    local result=$(mongosh --port "${MONGO_PORT}" admin --quiet --eval "
        try {
            db.createUser({
                user: '${MONGO_INITDB_ROOT_USERNAME}',
                pwd: '${MONGO_INITDB_ROOT_PASSWORD}',
                roles: [{role: 'root', db: 'admin'}]
            });
            print('USER_CREATED');
        } catch(e) {
            if (e.code === 51003) {
                print('USER_EXISTS');
            } else {
                print('ERROR: ' + e.message);
            }
        }
    " 2>&1)

    if echo "$result" | grep -q "USER_CREATED"; then
        log "Root user created successfully"
        return 0
    elif echo "$result" | grep -q "USER_EXISTS"; then
        log "Root user already exists"
        return 0
    else
        log "User creation result: $result"
        # Don't fail - continue anyway as user might exist
        return 0
    fi
}

# Function to generate deterministic keyfile from passphrase
generate_keyfile_from_passphrase() {
    local passphrase="$1"
    local salt="${MONGO_KEYFILE_SALT:-mongodb-flux-cluster-salt}"

    # Use PBKDF2 with SHA-256 to derive a deterministic key from the passphrase
    # This ensures all nodes with the same passphrase generate the same keyfile
    openssl enc -pbkdf2 -pass pass:"${passphrase}" -S "$(echo -n "$salt" | xxd -p)" \
        -md sha256 -iter 10000 -a -A 2>/dev/null < /dev/zero | head -c 756
}

# Function to generate or use existing keyfile for replica set authentication
setup_keyfile() {
    if [ ! -f "$KEYFILE_PATH" ]; then
        if [ ! -z "$MONGO_KEYFILE_CONTENT" ]; then
            log "Using provided MongoDB keyfile from environment..."
            echo "$MONGO_KEYFILE_CONTENT" > "$KEYFILE_PATH"
        elif [ ! -z "$MONGO_KEYFILE_PASSPHRASE" ]; then
            log "Generating deterministic MongoDB keyfile from passphrase..."
            generate_keyfile_from_passphrase "$MONGO_KEYFILE_PASSPHRASE" > "$KEYFILE_PATH"
            log "Keyfile generated successfully from passphrase"
        else
            log "WARNING: Generating random MongoDB keyfile (not suitable for multi-node production)..."
            openssl rand -base64 756 > "$KEYFILE_PATH"
        fi

        chmod 400 "$KEYFILE_PATH"
        chown mongodb:mongodb "$KEYFILE_PATH"
    else
        log "Using existing MongoDB keyfile"
    fi
}

# Trap signals for graceful shutdown
trap_shutdown() {
    log "Received shutdown signal, stopping services..."
    pkill -TERM node
    mongod --shutdown
    exit 0
}

trap trap_shutdown SIGTERM SIGINT

# Main execution
main() {
    log "REPLICA_SET: ${MONGO_REPLICA_SET_NAME}"

    # Setup keyfile for replica set authentication
    if ! setup_keyfile; then
        log "ERROR: Failed to setup MongoDB keyfile"
        exit 1
    fi

    # Start MongoDB with keyfile authentication
    log "Starting MongoDB with keyfile authentication..."
    mongod \
        --replSet "${MONGO_REPLICA_SET_NAME}" \
        --bind_ip_all \
        --port "${MONGO_PORT}" \
        --keyFile "${KEYFILE_PATH}" \
        --dbpath /data/db \
        --logpath /data/db/mongod.log \
        --logappend \
        --fork

    # Wait for MongoDB to be ready
    if ! wait_for_mongo; then
        log "ERROR: MongoDB failed to start"
        exit 1
    fi

    # Note: User creation will be handled by Node.js after replica set initialization
    # Attempting to create user here fails with "not primary" error because
    # MongoDB is running standalone (before rs.initiate)

    # Start Node.js controller and API server
    log "Starting Node.js controller and API server..."
    cd /app
    exec node index.js
}

# Run main function
main "$@"