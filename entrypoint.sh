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

    # Derive 256 bits directly, then encode as a MongoDB-compatible base64 key.
    # Node.js is already required by the controller. This avoids enc's optional
    # cipher, OpenSSL salt-format differences, and passing secrets in argv.
    if ! command -v node >/dev/null 2>&1; then
        log "ERROR: Node.js is required to derive the MongoDB keyfile"
        return 1
    fi

    MONGO_KEYFILE_PASSPHRASE="$passphrase" MONGO_KEYFILE_SALT="$salt" node -e '
        const { pbkdf2Sync } = require("node:crypto");
        const key = pbkdf2Sync(process.env.MONGO_KEYFILE_PASSPHRASE,
            process.env.MONGO_KEYFILE_SALT, 600000, 32, "sha256");
        if (key.every(byte => byte === key[0])) {
            throw new Error("Refusing a constant MongoDB keyfile");
        }
        process.stdout.write(key.toString("base64"));
    ' || return 1
}

validate_keyfile() {
    if ! command -v node >/dev/null 2>&1; then
        log "ERROR: Node.js is required to validate the MongoDB keyfile"
        return 1
    fi

    node - "$1" <<'NODE'
const fs = require('node:fs');
try {
    const key = fs.readFileSync(process.argv[2], 'utf8').replace(/\s/g, '');
    // Check each key, including quoted YAML sequences used for key rotation.
    // Also catches zero-filled keys encoded as base64 with padding.
    if (!key || /(?:^|[^A-Za-z0-9+/=])A{6,}={0,2}(?=$|[^A-Za-z0-9+/=])/.test(key)) {
        throw new Error('Empty or known insecure MongoDB keyfile; rotate the key on all members');
    }
} catch (error) {
    console.error('MongoDB keyfile validation failed: ' + error.message);
    process.exitCode = 1;
}
NODE
}

# Function to generate or use existing keyfile for replica set authentication
setup_keyfile() {
    if [ -f "$KEYFILE_PATH" ]; then
        validate_keyfile "$KEYFILE_PATH" || return 1
        log "Using existing MongoDB keyfile"
        return 0
    fi

    # Write atomically: a failed tool must not leave an empty/partial keyfile
    # that a subsequent startup could mistake for an existing key.
    local temporary_keyfile
    temporary_keyfile=$(mktemp "${KEYFILE_PATH}.tmp.XXXXXX") || return 1

    if [ -n "$MONGO_KEYFILE_CONTENT" ]; then
        log "Using provided MongoDB keyfile from environment..."
        if ! printf '%s\n' "$MONGO_KEYFILE_CONTENT" > "$temporary_keyfile"; then
            rm -f -- "$temporary_keyfile"
            return 1
        fi
    elif [ -n "$MONGO_KEYFILE_PASSPHRASE" ]; then
        log "Generating deterministic MongoDB keyfile from passphrase..."
        if ! generate_keyfile_from_passphrase "$MONGO_KEYFILE_PASSPHRASE" > "$temporary_keyfile"; then
            rm -f -- "$temporary_keyfile"
            return 1
        fi
    else
        log "WARNING: Generating random MongoDB keyfile (not suitable for multi-node production)..."
        if ! openssl rand -base64 756 > "$temporary_keyfile"; then
            rm -f -- "$temporary_keyfile"
            return 1
        fi
    fi

    # Explicitly check failures: main calls setup_keyfile in an if condition,
    # which disables Bash errexit throughout the function and its callees.
    if ! validate_keyfile "$temporary_keyfile" || \
       ! chmod 400 "$temporary_keyfile" || \
       ! chown mongodb:mongodb "$temporary_keyfile" || \
       ! mv -f -- "$temporary_keyfile" "$KEYFILE_PATH"; then
        rm -f -- "$temporary_keyfile"
        return 1
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
    # Display version
    if [ -f "/app/VERSION" ]; then
        VERSION=$(cat /app/VERSION)
        log "VERSION: ${VERSION}"
    fi

    log "REPLICA_SET: ${MONGO_REPLICA_SET_NAME}"

    # Setup keyfile for replica set authentication
    if ! setup_keyfile; then
        log "ERROR: Failed to setup MongoDB keyfile"
        exit 1
    fi

    # MongoDB needs to bind to all interfaces for replica set to work
    # In local testing: nodes communicate via Docker network IPs
    # In production: nodes behind NAT, public IP doesn't exist on container
    BIND_MODE="--bind_ip_all"

    if [ -n "$TEST_PUBLIC_IP" ]; then
        log "TEST MODE: MongoDB will bind to all interfaces (public IP ${TEST_PUBLIC_IP} is NAT'd)"
        PUBLIC_IP="$TEST_PUBLIC_IP"
    elif [ -n "$FLUX_API_OVERRIDE" ]; then
        log "Local testing mode: MongoDB will bind to all interfaces (Docker network)"
        # In local testing, use private IP for hostname mapping
        PRIVATE_IP=$(ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -n1)
        if [ -n "$PRIVATE_IP" ]; then
            PUBLIC_IP="$PRIVATE_IP"
            log "Using private IP for hostname mapping: $PUBLIC_IP"
        fi
    else
        log "Production mode: MongoDB will bind to all interfaces (behind NAT)"
        # Detect public IP for /etc/hosts mapping
        PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
    fi

    # Create a hostname from the IP for replica set configuration
    # Format: mongo-144-76-19-203.mongo-cluster (or mongo-172-30-0-2.mongo-cluster for local)
    # This hostname will resolve to localhost (production) or private IP (local testing)
    if [ -n "$PUBLIC_IP" ]; then
        PUBLIC_HOSTNAME="mongo-${PUBLIC_IP//./-}.mongo-cluster"

        # In local testing, map to private IP itself (MongoDB binds to all interfaces)
        # In production, map to 127.0.0.1 (for NAT hairpin workaround)
        if [ -n "$FLUX_API_OVERRIDE" ]; then
            HOSTNAME_IP="$PUBLIC_IP"
        else
            HOSTNAME_IP="127.0.0.1"
        fi

        # Add hostname to /etc/hosts
        if ! grep -q "$PUBLIC_HOSTNAME" /etc/hosts 2>/dev/null; then
            echo "$HOSTNAME_IP $PUBLIC_HOSTNAME" >> /etc/hosts
            log "Added $PUBLIC_HOSTNAME -> $HOSTNAME_IP in /etc/hosts for self-connection"
        fi

        # Ensure /etc/hosts takes priority over DNS
        if [ -f /etc/nsswitch.conf ]; then
            if grep -q "^hosts:.*dns.*files" /etc/nsswitch.conf; then
                log "Fixing /etc/nsswitch.conf to prioritize /etc/hosts over DNS"
                sed -i 's/^hosts:.*/hosts: files dns/' /etc/nsswitch.conf
            fi
        fi
    fi

    # Configure oplog size (default 2048MB for better rollback protection)
    OPLOG_SIZE="${MONGO_OPLOG_SIZE:-2048}"

    # Configure write concern (set MONGO_WRITE_CONCERN_MAJORITY=true to enable)
    WRITE_CONCERN_PARAMS=""
    if [ "${MONGO_WRITE_CONCERN_MAJORITY}" = "true" ]; then
        WRITE_CONCERN_PARAMS="--setParameter enableDefaultWriteConcernUpdatesForInitiate=true"
        log "Write concern majority enabled (may impact performance)"
    fi

    # Start MongoDB with keyfile authentication
    log "Starting MongoDB with keyfile authentication (oplog: ${OPLOG_SIZE}MB)..."
    mongod \
        --replSet "${MONGO_REPLICA_SET_NAME}" \
        ${BIND_MODE} \
        --port "${MONGO_PORT}" \
        --keyFile "${KEYFILE_PATH}" \
        --dbpath /data/db \
        --logpath /data/db/mongod.log \
        --logappend \
        --oplogSize ${OPLOG_SIZE} \
        --setParameter "skipShardingConfigurationChecks=true" \
        ${WRITE_CONCERN_PARAMS} \
        --fork

    # Wait for MongoDB to be ready
    if ! wait_for_mongo; then
        # Check if MongoDB crashed due to rollback failure
        if grep -q "Invariant failure.*commonPointOpTime" /data/db/mongod.log 2>/dev/null || \
           grep -q "aborting after invariant.*failure" /data/db/mongod.log 2>/dev/null; then
            log "ERROR: MongoDB crashed due to rollback failure"
            log "RECOVERY: Data corrupted beyond repair, performing automatic recovery..."

            # Backup corrupted data
            BACKUP_DIR="/data/db.corrupted.$(date +%s)"
            mv /data/db "$BACKUP_DIR" 2>/dev/null || true
            log "Corrupted data backed up to: $BACKUP_DIR"

            # Create fresh data directory
            mkdir -p /data/db
            chown -R mongodb:mongodb /data/db

            log "Starting MongoDB with fresh data - will resync from primary..."
            mongod \
                --replSet "${MONGO_REPLICA_SET_NAME}" \
                ${BIND_MODE} \
                --port "${MONGO_PORT}" \
                --keyFile "${KEYFILE_PATH}" \
                --dbpath /data/db \
                --logpath /data/db/mongod.log \
                --oplogSize ${OPLOG_SIZE} \
                --setParameter "skipShardingConfigurationChecks=true" \
                ${WRITE_CONCERN_PARAMS} \
                --fork

            # Wait again
            if ! wait_for_mongo; then
                log "ERROR: MongoDB failed to start even after recovery"
                exit 1
            fi
        else
            log "ERROR: MongoDB failed to start (unknown reason)"
            exit 1
        fi
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
