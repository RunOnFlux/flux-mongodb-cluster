# Production Deployment Guide

## Keyfile Distribution for Real-World Deployments

When deploying on Flux infrastructure where each container runs on different servers, you cannot use shared volumes. Here are the recommended approaches:

### Method 1: Deterministic Key Generation from Passphrase (RECOMMENDED)

This is the simplest and most secure method. All nodes generate the same keyfile from a shared passphrase using PBKDF2 key derivation.

**Deploy all nodes with the same passphrase:**
```bash
docker run -d \
  -e APP_NAME="production-mongo-cluster" \
  -e MONGO_REPLICA_SET_NAME="rs0" \
  -e MONGO_KEYFILE_PASSPHRASE="your-secret-passphrase-here" \
  -e MONGO_INITDB_ROOT_USERNAME="admin" \
  -e MONGO_INITDB_ROOT_PASSWORD="your-secure-password" \
  -v /data/mongo:/data/db \
  --name mongo-node \
  flux-mongodb:latest
```

**Advantages:**
- No need to generate or distribute keyfile content
- Same passphrase always generates same keyfile (deterministic)
- Easier to manage in configuration files
- Can use existing secret management for the passphrase

**Optional: Custom Salt**
```bash
# Use a custom salt for additional uniqueness
docker run -d \
  -e MONGO_KEYFILE_PASSPHRASE="your-secret-passphrase" \
  -e MONGO_KEYFILE_SALT="your-custom-salt" \
  ...
```

### Method 2: Pre-Shared Key via Environment Variable

**Step 1: Generate a keyfile content once:**
```bash
# Generate keyfile content
KEYFILE_CONTENT=$(openssl rand -base64 756)
echo "Save this keyfile content securely: $KEYFILE_CONTENT"
```

**Step 2: Deploy all nodes with the same keyfile:**
```bash
docker run -d \
  -e APP_NAME="production-mongo-cluster" \
  -e MONGO_REPLICA_SET_NAME="rs0" \
  -e MONGO_INITDB_ROOT_USERNAME="admin" \
  -e MONGO_INITDB_ROOT_PASSWORD="your-secure-password" \
  -e MONGO_KEYFILE_CONTENT="<paste-your-keyfile-content-here>" \
  -v /data/mongo:/data/db \
  --name mongo-node \
  flux-mongodb:latest
```

### Method 2: External Secret Management

For better security, integrate with a secret management system:

#### Using HashiCorp Vault:
```bash
# Store keyfile in Vault
vault kv put secret/mongodb/keyfile content="$(openssl rand -base64 756)"

# In entrypoint.sh, fetch from Vault
MONGO_KEYFILE_CONTENT=$(vault kv get -field=content secret/mongodb/keyfile)
```

#### Using AWS Secrets Manager:
```bash
# Store keyfile
aws secretsmanager create-secret \
  --name mongodb-keyfile \
  --secret-string "$(openssl rand -base64 756)"

# In entrypoint.sh, fetch from AWS
MONGO_KEYFILE_CONTENT=$(aws secretsmanager get-secret-value \
  --secret-id mongodb-keyfile \
  --query SecretString --output text)
```

### Method 3: Initial Bootstrap Without Auth

For environments where pre-sharing keys is difficult:

1. **Modified entrypoint.sh approach:**
```bash
# Start MongoDB without auth initially
mongod --replSet rs0 --bind_ip_all --port 27017 --dbpath /data/db

# After replica set is initialized, enable auth
# This requires a coordinated restart of all nodes
```

2. **Two-phase deployment:**
- Phase 1: Deploy without authentication, form cluster
- Phase 2: Enable authentication with shared keyfile

### Method 4: Configuration Management Tools

Use configuration management for key distribution:

#### Ansible Example:
```yaml
- name: Generate MongoDB keyfile
  shell: openssl rand -base64 756
  register: keyfile_content
  run_once: true

- name: Deploy MongoDB nodes
  docker_container:
    name: mongo-node
    image: flux-mongodb:latest
    env:
      APP_NAME: "production-mongo"
      MONGO_KEYFILE_CONTENT: "{{ keyfile_content.stdout }}"
```

#### Terraform Example:
```hcl
resource "random_password" "mongo_keyfile" {
  length  = 1024
  special = true
  base64  = true
}

resource "docker_container" "mongo_nodes" {
  count = 3
  name  = "mongo-node-${count.index}"
  image = "flux-mongodb:latest"

  env = [
    "APP_NAME=production-mongo",
    "MONGO_KEYFILE_CONTENT=${random_password.mongo_keyfile.result}"
  ]
}
```

## Security Best Practices

### 1. Never Hardcode Keys
- Don't commit keyfile content to repositories
- Use environment-specific secret management

### 2. Rotate Keys Periodically
```bash
# Generate new keyfile
NEW_KEYFILE=$(openssl rand -base64 756)

# Rolling update process:
# 1. Update secondary nodes one by one
# 2. Step down primary
# 3. Update former primary
```

### 3. Use TLS in Production
```bash
docker run -d \
  -e MONGO_TLS_ENABLED="true" \
  -e MONGO_TLS_CERT="/certs/mongodb.pem" \
  -e MONGO_TLS_KEY="/certs/mongodb-key.pem" \
  -e MONGO_TLS_CA="/certs/ca.pem" \
  -v /path/to/certs:/certs:ro \
  flux-mongodb:latest
```

### 4. Limit Network Access
- Use firewall rules to restrict port 27017
- Implement VPN or private networking
- Use MongoDB's built-in IP whitelisting

## Flux-Specific Deployment

For Flux blockchain infrastructure:

### 1. Using Flux Environment Variables
```yaml
# In your Flux app specification
env:
  - name: MONGO_KEYFILE_CONTENT
    value: "your-base64-keyfile-content"
  - name: APP_NAME
    value: "flux-mongo-cluster"
```

### 2. Multi-Region Deployment
```bash
# Deploy across regions with same keyfile
flux-cli app deploy \
  --name mongo-cluster \
  --image flux-mongodb:latest \
  --env MONGO_KEYFILE_CONTENT="$KEYFILE" \
  --regions us-east,eu-west,asia-pacific
```

### 3. Monitoring Integration
```yaml
# Add to docker-compose or deployment
environment:
  - ENABLE_METRICS=true
  - METRICS_PORT=9216
  - FLUX_NODE_ID=${FLUX_NODE_ID}
```

## Verification Steps

After deployment, verify the cluster:

```bash
# Check replica set status from any node
docker exec mongo-node mongosh \
  -u admin -p yourpassword \
  --authenticationDatabase admin \
  --eval "rs.status()"

# Verify all members are authenticated
docker exec mongo-node mongosh \
  -u admin -p yourpassword \
  --authenticationDatabase admin \
  --eval "rs.conf()"

# Test failover
docker stop <primary-node>
# Wait 10 seconds
docker exec <secondary-node> mongosh \
  -u admin -p yourpassword \
  --authenticationDatabase admin \
  --eval "rs.status()"
```

## Troubleshooting

### Authentication Failures
```bash
# Check keyfile permissions
docker exec mongo-node ls -la /data/configdb/mongodb-keyfile

# Verify keyfile content matches across nodes
docker exec mongo-node1 md5sum /data/configdb/mongodb-keyfile
docker exec mongo-node2 md5sum /data/configdb/mongodb-keyfile
```

### Connection Issues
```bash
# Test connectivity between nodes
docker exec mongo-node1 mongosh \
  --host mongo-node2:27017 \
  --eval "db.adminCommand('ping')"
```

### Recovery from Split Brain
```bash
# Force reconfiguration
docker exec <accessible-node> mongosh \
  -u admin -p yourpassword \
  --eval "rs.reconfig(rs.conf(), {force: true})"
```