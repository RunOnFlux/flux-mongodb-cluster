#!/bin/bash

set -e

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Flux-aware MongoDB controller..."

# Configuration from environment variables
APP_NAME="${APP_NAME:-mongo-cluster}"
MONGO_REPLICA_SET_NAME="${MONGO_REPLICA_SET_NAME:-rs0}"
MONGO_PORT="${MONGO_PORT:-27017}"

# Allow overriding the API URL for local testing
if [ ! -z "$FLUX_API_OVERRIDE" ]; then
    FLUX_API_URL="${FLUX_API_OVERRIDE}/apps/location/${APP_NAME}"
else
    FLUX_API_URL="https://api.runonflux.io/apps/location/${APP_NAME}"
fi

RECONCILE_INTERVAL="${RECONCILE_INTERVAL:-60}"
KEYFILE_PATH="/data/configdb/mongodb-keyfile"

# MongoDB authentication
MONGO_INITDB_ROOT_USERNAME="${MONGO_INITDB_ROOT_USERNAME}"
MONGO_INITDB_ROOT_PASSWORD="${MONGO_INITDB_ROOT_PASSWORD}"

# Function to log messages with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Function to get current container IP
get_current_ip() {
    hostname -I | awk '{print $1}'
}

# Function to fetch peer IPs from Flux API
fetch_peer_ips() {
    local response
    response=$(curl -s --connect-timeout 10 --max-time 30 "${FLUX_API_URL}" 2>/dev/null || echo "{}")

    if [ -z "$response" ] || [ "$response" = "{}" ]; then
        log "Warning: Failed to fetch data from Flux API"
        echo ""
        return 1
    fi

    # Parse IPs from API response, remove port numbers, sort uniquely
    echo "$response" | jq -r '.data[]?.ip // empty' 2>/dev/null | sed 's/:.*$//' | sort -u | tr '\n' ' '
}

# Function to wait for MongoDB to be ready
wait_for_mongo() {
    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if mongosh --quiet --eval "db.adminCommand('ping')" >/dev/null 2>&1; then
            log "MongoDB is ready"
            return 0
        fi

        attempt=$((attempt + 1))
        log "Waiting for MongoDB to start... ($attempt/$max_attempts)"
        sleep 2
    done

    log "Error: MongoDB failed to start within timeout"
    return 1
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
        # Priority order for keyfile generation:
        # 1. Use provided keyfile content directly
        # 2. Generate from passphrase (deterministic)
        # 3. Generate random keyfile (for backward compatibility)

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

# Function to check if replica set is initialized
is_replica_set_initialized() {
    local result
    # Try without auth first (during initialization), then with auth
    result=$(mongosh --quiet --eval "rs.status().ok" 2>/dev/null || echo "0")

    if [ "$result" != "1" ] && [ ! -z "$MONGO_INITDB_ROOT_USERNAME" ]; then
        result=$(mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "rs.status().ok" 2>/dev/null || echo "0")
    fi

    [ "$result" = "1" ]
}

# Function to build mongosh auth parameters
get_auth_params() {
    # Return auth params if credentials are provided
    if [ ! -z "$MONGO_INITDB_ROOT_USERNAME" ]; then
        echo "-u $MONGO_INITDB_ROOT_USERNAME -p $MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase admin"
    else
        echo ""
    fi
}

# Function to get current replica set members
get_current_members() {
    local auth_params=$(get_auth_params)
    mongosh --quiet $auth_params --eval "
        try {
            var config = rs.config();
            var members = config.members.map(function(m) {
                return m.host.split(':')[0];
            });
            print(members.join(' '));
        } catch(e) {
            print('');
        }
    " 2>/dev/null || echo ""
}

# Function to check if current node is primary
is_primary() {
    local result
    local auth_params=$(get_auth_params)
    result=$(mongosh --quiet $auth_params --eval "db.hello().isWritablePrimary" 2>/dev/null || echo "false")
    [ "$result" = "true" ]
}

# Function to wait for primary election and check if this node is primary
wait_for_primary_election() {
    local current_ip="$1"
    local max_wait="${2:-60}"
    local waited=0
    local interval=1
    local max_interval=5

    log "Waiting for primary election to complete (fast detection)..."

    while [ $waited -lt $max_wait ]; do
        # Get current primary from replica set status with efficient query
        local primary_host=$(mongosh --quiet --eval "
            try {
                var status = rs.status();
                if (status && status.members) {
                    for (var i = 0; i < status.members.length; i++) {
                        if (status.members[i].state === 1) {
                            print(status.members[i].name.split(':')[0]);
                            quit();
                        }
                    }
                }
                print('');
            } catch(e) {
                print('');
            }
        " 2>/dev/null)

        if [ ! -z "$primary_host" ]; then
            log "✓ Primary election completed. Primary is: $primary_host"
            if [ "$primary_host" = "$current_ip" ]; then
                log "✓ This node ($current_ip) is the PRIMARY"
                return 0
            else
                log "→ This node ($current_ip) is a SECONDARY"
                return 1
            fi
        fi

        # Progressive backoff: start with 1s, increase gradually up to max_interval
        sleep $interval
        waited=$((waited + interval))

        # Show progress every few seconds
        if [ $((waited % 5)) -eq 0 ]; then
            log "Waiting for primary election... ($waited/$max_wait seconds)"
        fi

        # Increase interval gradually for efficiency
        if [ $interval -lt $max_interval ]; then
            interval=$((interval + 1))
        fi
    done

    log "⚠ Warning: Primary election timeout after $max_wait seconds"
    return 1
}

# Function to initialize replica set
initialize_replica_set() {
    local current_ip="$1"
    shift
    local peer_ips="$@"

    log "Initializing replica set as leader node..."

    # Build members array for rs.initiate()
    local members="["
    local id=0

    # Add current node first
    members+="{_id: $id, host: '${current_ip}:${MONGO_PORT}'}"
    id=$((id + 1))

    # Add peer nodes
    for ip in $peer_ips; do
        if [ "$ip" != "$current_ip" ] && [ ! -z "$ip" ]; then
            members+=", {_id: $id, host: '${ip}:${MONGO_PORT}'}"
            id=$((id + 1))
        fi
    done
    members+="]"

    # Initialize replica set
    mongosh --eval "
        rs.initiate({
            _id: '${MONGO_REPLICA_SET_NAME}',
            members: $members
        })
    "

    if [ $? -eq 0 ]; then
        log "Replica set initialized successfully"

        # Wait for primary election to complete and determine if this node is primary
        if wait_for_primary_election "$current_ip" 60; then
            # This node is the primary - create root user
            if [ ! -z "$MONGO_INITDB_ROOT_USERNAME" ] && [ ! -z "$MONGO_INITDB_ROOT_PASSWORD" ]; then
                log "Creating root user as PRIMARY: ${MONGO_INITDB_ROOT_USERNAME}"
                mongosh admin --eval "
                    try {
                        db.createUser({
                            user: '${MONGO_INITDB_ROOT_USERNAME}',
                            pwd: '${MONGO_INITDB_ROOT_PASSWORD}',
                            roles: [{role: 'root', db: 'admin'}]
                        });
                        print('ROOT_USER_CREATED');
                    } catch(e) {
                        print('ROOT_USER_ERROR: ' + e.message);
                    }
                "

                if [ $? -eq 0 ]; then
                    log "Root user created successfully by PRIMARY"
                else
                    log "Failed to create root user"
                fi
            fi
        else
            log "This node is not PRIMARY - skipping user creation"
        fi
    else
        log "Error: Failed to initialize replica set, retrying in 30 seconds..."
        sleep 30
        return 1
    fi
}

# Function to add a member to replica set
add_member() {
    local ip="$1"
    local auth_params=$(get_auth_params)

    # Verify we're still primary before making changes
    if ! is_primary; then
        log "Warning: Lost primary status, cannot add member ${ip}"
        return 1
    fi

    log "Adding member ${ip}:${MONGO_PORT} to replica set..."
    mongosh $auth_params --eval "rs.add('${ip}:${MONGO_PORT}')" >/dev/null 2>&1

    if [ $? -eq 0 ]; then
        log "Successfully added ${ip} to replica set"
    else
        log "Warning: Failed to add ${ip} to replica set (may already be a member)"
    fi
}

# Function to remove a member from replica set
remove_member() {
    local ip="$1"
    local auth_params=$(get_auth_params)

    # Verify we're still primary before making changes
    if ! is_primary; then
        log "Warning: Lost primary status, cannot remove member ${ip}"
        return 1
    fi

    log "Removing member ${ip}:${MONGO_PORT} from replica set..."
    mongosh $auth_params --eval "rs.remove('${ip}:${MONGO_PORT}')" >/dev/null 2>&1

    if [ $? -eq 0 ]; then
        log "Successfully removed ${ip} from replica set"
    else
        log "Warning: Failed to remove ${ip} from replica set"
    fi
}

# Function to perform reconciliation
reconcile_cluster() {
    local desired_ips="$1"
    local current_members=$(get_current_members)

    if [ -z "$current_members" ]; then
        log "Warning: Unable to get current replica set members"
        return 1
    fi

    log "Desired state: $desired_ips"
    log "Current state: $current_members"

    # Convert to arrays for easier comparison
    IFS=' ' read -ra desired_array <<< "$desired_ips"
    IFS=' ' read -ra current_array <<< "$current_members"

    # Add new members
    for desired_ip in "${desired_array[@]}"; do
        if [ ! -z "$desired_ip" ]; then
            # Check if we're still primary before each operation
            if ! is_primary; then
                log "Primary status lost during reconciliation, stopping member additions"
                return 1
            fi

            found=false
            for current_ip in "${current_array[@]}"; do
                if [ "$desired_ip" = "$current_ip" ]; then
                    found=true
                    break
                fi
            done

            if [ "$found" = "false" ]; then
                add_member "$desired_ip"
                sleep 2
            fi
        fi
    done

    # Remove stale members (with safety check)
    local members_to_remove=0
    local total_members=${#current_array[@]}

    for current_ip in "${current_array[@]}"; do
        if [ ! -z "$current_ip" ]; then
            found=false
            for desired_ip in "${desired_array[@]}"; do
                if [ "$current_ip" = "$desired_ip" ]; then
                    found=true
                    break
                fi
            done

            if [ "$found" = "false" ]; then
                members_to_remove=$((members_to_remove + 1))
            fi
        fi
    done

    # Safety check: Don't remove if it would remove majority
    if [ $members_to_remove -gt 0 ] && [ $members_to_remove -lt $((total_members / 2)) ]; then
        for current_ip in "${current_array[@]}"; do
            if [ ! -z "$current_ip" ]; then
                # Check if we're still primary before each removal
                if ! is_primary; then
                    log "Primary status lost during reconciliation, stopping member removals"
                    return 1
                fi

                found=false
                for desired_ip in "${desired_array[@]}"; do
                    if [ "$current_ip" = "$desired_ip" ]; then
                        found=true
                        break
                    fi
                done

                if [ "$found" = "false" ]; then
                    remove_member "$current_ip"
                    sleep 2
                fi
            fi
        done
    elif [ $members_to_remove -ge $((total_members / 2)) ]; then
        log "Warning: Refusing to remove $members_to_remove members (would remove majority)"
    fi
}

# Trap signals for graceful shutdown
trap 'log "Received shutdown signal, stopping MongoDB..."; mongod --shutdown; exit 0' SIGTERM SIGINT

# Function to handle failures and restart
restart_on_failure() {
    local error_msg="$1"
    local wait_time="${2:-60}"

    log "CRITICAL ERROR: $error_msg"
    log "Restarting controller in $wait_time seconds..."

    # Clean up any running MongoDB processes
    pkill -f mongod || true

    sleep "$wait_time"
    exec "$0" "$@"
}

# Main execution with error handling
main() {
    log "APP_NAME: ${APP_NAME}"
    log "REPLICA_SET: ${MONGO_REPLICA_SET_NAME}"

    # Initial discovery to determine leader
    CURRENT_IP=$(get_current_ip)
    log "Current container IP: ${CURRENT_IP}"

    # Fetch initial peer list with retry
    PEER_IPS=""
    for attempt in $(seq 1 5); do
        PEER_IPS=$(fetch_peer_ips)
        if [ ! -z "$PEER_IPS" ]; then
            break
        fi
        log "Attempt $attempt: Failed to fetch peers, retrying in 10 seconds..."
        sleep 10
    done

    if [ -z "$PEER_IPS" ]; then
        log "Warning: No peers found from Flux API after 5 attempts, starting as standalone"
        PEER_IPS="$CURRENT_IP"
    fi

    log "Discovered peers: ${PEER_IPS}"

    # Determine if this node should be the leader (lowest IP)
    SORTED_IPS=$(echo "$PEER_IPS" | tr ' ' '\n' | sort | tr '\n' ' ')
    LEADER_IP=$(echo "$SORTED_IPS" | awk '{print $1}')

    # Setup keyfile for replica set authentication
    if ! setup_keyfile; then
        restart_on_failure "Failed to setup MongoDB keyfile" 30
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
        log "Error: MongoDB failed to start, restarting in 10 seconds..."
        sleep 10
        exec "$0" "$@"
    fi

    if [ "$CURRENT_IP" = "$LEADER_IP" ]; then
        # Check if replica set is already initialized
        if ! is_replica_set_initialized; then
            # Give other nodes time to start
            log "Waiting for other nodes to be ready..."
            sleep 10

            initialize_replica_set "$CURRENT_IP" $PEER_IPS
        else
            log "Replica set already initialized"

            # Wait for primary election and only create user if this node is primary
            if wait_for_primary_election "$CURRENT_IP" 60; then
                # This node is the primary - create root user if needed
                if [ ! -z "$MONGO_INITDB_ROOT_USERNAME" ] && [ ! -z "$MONGO_INITDB_ROOT_PASSWORD" ]; then
                    log "Creating root user using localhost exception as PRIMARY..."
                    mongosh admin --eval "
                        try {
                            // Check if any users exist
                            var users = db.getUsers();
                            if (users.length === 0) {
                                // Create root user using localhost exception
                                db.createUser({
                                    user: '${MONGO_INITDB_ROOT_USERNAME}',
                                    pwd: '${MONGO_INITDB_ROOT_PASSWORD}',
                                    roles: [{role: 'root', db: 'admin'}]
                                });
                                print('User created successfully by PRIMARY');
                            } else {
                                print('Users already exist');
                            }
                        } catch(e) {
                            print('Error: ' + e.message);
                        }
                    "

                    if [ $? -eq 0 ]; then
                        log "Root user creation completed by PRIMARY"
                    else
                        log "Failed to create root user"
                    fi
                fi
            else
                log "This node is not PRIMARY - skipping user creation"
            fi
        fi
    else
        log "This node is a follower, waiting for leader ($LEADER_IP) to initialize"

        # Wait for replica set to be initialized by leader
        max_wait=300
        waited=0
        while [ $waited -lt $max_wait ]; do
            if is_replica_set_initialized; then
                log "Replica set has been initialized"
                break
            fi
            sleep 5
            waited=$((waited + 5))
            log "Waiting for replica set initialization... ($waited/$max_wait seconds)"
        done
    fi

    # Main reconciliation loop with error handling and primary change detection
    log "Starting reconciliation loop (interval: ${RECONCILE_INTERVAL}s)..."

    local consecutive_failures=0
    local max_failures=5
    local was_primary=false
    local primary_change_detected=false

    while true; do
        sleep "${RECONCILE_INTERVAL}"

        # Check current primary status
        local is_currently_primary=false
        if is_primary; then
            is_currently_primary=true
        fi

        # Detect primary status changes
        if [ "$was_primary" != "$is_currently_primary" ]; then
            primary_change_detected=true
            if [ "$is_currently_primary" = "true" ]; then
                log "🔄 PRIMARY STATUS GAINED - This node is now the primary"
            else
                log "🔄 PRIMARY STATUS LOST - This node is no longer primary"
            fi
        fi

        # Update tracking variables
        was_primary=$is_currently_primary

        # Error handling for reconciliation
        if ! perform_reconciliation; then
            consecutive_failures=$((consecutive_failures + 1))
            log "Reconciliation failed (attempt $consecutive_failures/$max_failures)"

            if [ $consecutive_failures -ge $max_failures ]; then
                restart_on_failure "Too many consecutive reconciliation failures" 120
            fi
        else
            consecutive_failures=0
        fi
    done
}

# Function to perform single reconciliation cycle
perform_reconciliation() {
    # Check if we are primary at the start
    if ! is_primary; then
        log "Not primary, skipping reconciliation"
        return 0
    fi

    log "Performing reconciliation as primary..."

    # Fetch current desired state from Flux API
    DESIRED_IPS=$(fetch_peer_ips)

    if [ ! -z "$DESIRED_IPS" ]; then
        # Double-check we're still primary before making changes
        if ! is_primary; then
            log "Primary status lost during reconciliation, aborting"
            return 1
        fi

        reconcile_cluster "$DESIRED_IPS"
        return $?
    else
        log "Skipping reconciliation due to API failure"
        return 1
    fi
}

# Run main function
main "$@"